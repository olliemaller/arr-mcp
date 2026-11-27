import type { ConfigByService, ServiceId } from '../config/schema.ts';
import { apiKeyHeader } from '../core/auth.ts';
import { ServiceError } from '../core/errors.ts';
import { fenceText } from '../core/fence.ts';
import { ServiceHttp } from '../core/http.ts';
import {
    diagnoseConnection,
    type ConnectionDiagnosis,
    type HealthCheck,
    type HealthCheckCapable,
    type SearchCapable,
    type SearchHit,
    type SearchSource,
    type ServiceAdapter
} from './types.ts';

const HEALTH_PATH = '/api/health';
const VERSION_PATH = '/api/version';
const ME_PATH = '/api/auth/me';
const METRICS_PATH = '/api/admin/metrics';
const SEARCH_PATH = '/api/audiobooks/search';

const REMEDY_401 = 'ReadMeABook refused the API token. Create one under Profile, API Tokens and set it as api_key.';
const REMEDY_ADMIN = "This token belongs to a user who is not an admin, and the health checks read admin routes. Create the token from an admin's profile.";
const REMEDY_403 = 'ReadMeABook refused this route for an API token. Its tokens reach only the routes listed on its /api-docs page.';

type RawVersion = { version?: unknown };
type RawMe = { user?: { role?: unknown } };
type RawMetrics = { failedLast30Days?: unknown; systemHealth?: { issues?: unknown } };
type RawBook = { asin?: unknown; title?: unknown; author?: unknown; releaseDate?: unknown; isAvailable?: unknown };

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

/**
 * ReadMeABook's API, written against its token allowlist at tag v1.3.0 and
 * captured live from a community-scripts install of the latest release on
 * 2026-11-25 (v1.3.0 then), which reports `vDEV`. Its tokens are `rmab_` keys
 * sent as a Bearer header, and they reach a fixed list of nine routes only; an
 * admin's token is needed for the health checks. Read-only: the request and
 * cancel routes are on that list, but nothing here calls them.
 */
export class ReadMeABookAdapter implements ServiceAdapter, HealthCheckCapable, SearchCapable {
    readonly type: ServiceId = 'readmeabook';
    // Single only: one ReadMeABook holds one set of audiobook requests.
    readonly id = 'readmeabook';
    /** Audiobooks, so a `kind` filter for films or series leaves it out. */
    readonly queueKind = 'book';
    readonly #http: ServiceHttp;

    constructor(config: ConfigByService['readmeabook'], fetchImpl: typeof fetch = fetch) {
        this.#http = new ServiceHttp(this.id, config, apiKeyHeader('Authorization', `Bearer ${config.api_key}`), fetchImpl);
    }

    async getVersion(): Promise<string> {
        const version = await this.#readVersion();
        if (version === undefined) throw new ServiceError('UpstreamError', this.id, 'a build without APP_VERSION reports vDEV, which is no version');
        return version;
    }

    /** `/api/health` and `/api/version` answer anyone, so `/api/auth/me` is what checks the token. */
    async testConnection(): Promise<ConnectionDiagnosis> {
        return diagnoseConnection(this.id, this.type, async () => {
            const me = await this.#guarded(() => this.#http.get<RawMe>(ME_PATH));
            if (me.user?.role !== 'admin') throw new ServiceError('AuthFailed', this.id, 'the token is not an admin token', { remedy: REMEDY_ADMIN });
            return this.#readVersion();
        });
    }

    async getFailedHealthChecks(): Promise<HealthCheck[]> {
        const check = (source: string, type: string, message: string): HealthCheck => ({ service: this.id, source, type, message });
        // A lost database answers 503 here, and every admin route would fail on it too.
        if (!(await this.#databaseUp())) return [check('database', 'error', 'ReadMeABook is up but cannot reach its database')];
        const metrics = await this.#guarded(() => this.#http.get<RawMetrics>(METRICS_PATH));
        const out: HealthCheck[] = [];
        const issues = Array.isArray(metrics.systemHealth?.issues) ? (metrics.systemHealth.issues as unknown[]) : [];
        for (const issue of issues) {
            if (typeof issue === 'string' && issue !== '') out.push(check('system', 'warning', fenceText(issue, { service: this.id, field: 'issue' })));
        }
        const failed = metrics.failedLast30Days;
        if (typeof failed === 'number' && failed > 0) out.push(check('requests', 'warning', `${failed} request(s) failed in the last 30 days`));
        return out;
    }

    /** Audible's catalogue, so `discover` only: a library search answers none. `hasFile` is ReadMeABook's own "in the library". */
    async search(query: string, source: SearchSource): Promise<SearchHit[]> {
        if (source !== 'discover') return [];
        const body = await this.#guarded(() => this.#http.get<{ results?: RawBook[] }>(`${SEARCH_PATH}?${new URLSearchParams({ q: query }).toString()}`));
        return (body.results ?? []).flatMap(book => {
            const asin = str(book.asin);
            if (asin === undefined) return [];
            const title = str(book.title) ?? 'untitled';
            const author = str(book.author);
            const year = typeof book.releaseDate === 'string' ? Number.parseInt(book.releaseDate.slice(0, 4), 10) : Number.NaN;
            const hit: SearchHit = {
                service: this.id,
                source,
                kind: 'book',
                id: asin,
                title: fenceText(author === undefined ? title : `${title} by ${author}`, { service: this.id, field: 'title' }),
                ids: {},
                ...(Number.isNaN(year) ? {} : { year }),
                ...(typeof book.isAvailable === 'boolean' ? { hasFile: book.isAvailable } : {})
            };
            return [hit];
        });
    }

    /** Undefined for `vDEV`: a build from source, which sets no version. */
    async #readVersion(): Promise<string | undefined> {
        const version = str((await this.#http.get<RawVersion>(VERSION_PATH)).version);
        return version === undefined || version === 'vDEV' ? undefined : version.replace(/^v/, '');
    }

    async #databaseUp(): Promise<boolean> {
        try {
            await this.#http.get<unknown>(HEALTH_PATH);
            return true;
        } catch (err) {
            if (err instanceof ServiceError && err.status === 503) return false;
            throw err;
        }
    }

    /** ReadMeABook's 401 is a bad token and its 403 a route a token may not call, or an admin route for a user's token. */
    async #guarded<T>(read: () => Promise<T>): Promise<T> {
        try {
            return await read();
        } catch (err) {
            if (err instanceof ServiceError && err.status === 401) throw new ServiceError('AuthFailed', this.id, err.detail, { remedy: REMEDY_401, status: 401 });
            if (err instanceof ServiceError && err.status === 403) throw new ServiceError('AuthFailed', this.id, err.detail, { remedy: `${REMEDY_403} ${REMEDY_ADMIN}`, status: 403 });
            throw err;
        }
    }
}
