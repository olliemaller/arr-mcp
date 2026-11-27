import type { ConfigByService, ServiceId } from '../config/schema.ts';
import { apiKeyHeader } from '../core/auth.ts';
import { ServiceError } from '../core/errors.ts';
import { fenceText } from '../core/fence.ts';
import { ServiceHttp } from '../core/http.ts';
import type { IndexInput } from '../core/resolver.ts';
import { diagnoseConnection, type ConnectionDiagnosis, type LibraryCapable, type ServiceAdapter } from './types.ts';

type Raw = Record<string, unknown>;
const obj = (v: unknown): Raw => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Raw) : {});
const list = (v: unknown): Raw[] => (Array.isArray(v) ? v.filter((r): r is Raw => typeof r === 'object' && r !== null) : []);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** Items per page of a library read. */
const PAGE_SIZE = 200;
/** The most pages one library read follows: 20,000 items, then it fails by name rather than loop. */
const MAX_PAGES = 100;

const REMEDY_KEY = 'Audiobookshelf refused the API key. Create one under Settings → API Keys, acting as a user that can see your audiobook libraries.';

/**
 * Audiobookshelf, through its documented REST API (api.audiobookshelf.org),
 * with an API key sent as a Bearer token.
 *
 * Its audiobooks join `get_library` as `book` rows, beside Grimmory's: the
 * library the books the stack downloads land in, so a finished download can be
 * looked for there. Read only, and single instance, as Grimmory is.
 */
export class AudiobookshelfAdapter implements ServiceAdapter, LibraryCapable {
    readonly type: ServiceId = 'audiobookshelf';
    readonly id = 'audiobookshelf';
    readonly #http: ServiceHttp;

    constructor(config: ConfigByService['audiobookshelf'], fetchImpl: typeof fetch = fetch) {
        this.#http = new ServiceHttp(this.id, config, { ...apiKeyHeader('Authorization', `Bearer ${config.api_key}`), remedy: REMEDY_KEY }, fetchImpl);
    }

    /** `/status` answers without a key, which is why the connection test also reads the libraries. */
    async getVersion(): Promise<string> {
        const body = obj(await this.#http.get<unknown>('/status'));
        if (body.app !== 'audiobookshelf') throw new ServiceError('UpstreamError', this.id, 'the server at this URL is not Audiobookshelf');
        const version = str(body.serverVersion);
        if (version === undefined) throw new ServiceError('UpstreamError', this.id, '/status returned no serverVersion');
        return version;
    }

    async testConnection(): Promise<ConnectionDiagnosis> {
        return diagnoseConnection(this.id, this.type, async () => {
            const version = await this.getVersion();
            await this.#bookLibraries();
            return version;
        });
    }

    /** Book libraries only: a podcast library holds episodes, which no part of the stack downloads as books. */
    async #bookLibraries(): Promise<{ id: string; name: string }[]> {
        return list(obj(await this.#http.get<unknown>('/api/libraries')).libraries).flatMap(lib => {
            const id = str(lib.id);
            return id === undefined || lib.mediaType !== 'book' ? [] : [{ id, name: str(lib.name) ?? id }];
        });
    }

    async listLibrary(): Promise<IndexInput[]> {
        const out: IndexInput[] = [];
        for (const library of await this.#bookLibraries()) {
            const label = fenceText(library.name, { service: this.id, field: 'library_name' });
            for (const item of await this.#items(library.id)) {
                const id = str(item.id);
                if (id === undefined) continue;
                const media = obj(item.media);
                const metadata = obj(media.metadata);
                const title = str(metadata.title) ?? 'untitled';
                const author = str(metadata.authorName);
                const year = Number(str(metadata.publishedYear));
                const size = num(item.size) ?? num(media.size);
                const added = num(item.addedAt);
                const hasMedia = (num(media.numAudioFiles) ?? num(media.numTracks) ?? 0) > 0 || str(media.ebookFormat) !== undefined;
                out.push({
                    kind: 'book',
                    title: fenceText(author === undefined ? title : `${title} by ${author}`, { service: this.id, field: 'title' }),
                    ...(Number.isInteger(year) && year > 0 ? { year } : {}),
                    library: label,
                    ids: {},
                    acquisition: {
                        service: this.id,
                        id,
                        monitored: false,
                        // Missing: Audiobookshelf's last scan found the folder gone.
                        hasFile: item.isMissing !== true && hasMedia,
                        ...(size === undefined ? {} : { sizeBytes: size }),
                        ...(added === undefined ? {} : { addedAt: new Date(added).toISOString() })
                    }
                });
            }
        }
        return out;
    }

    /** Every page of one library, minified: the full form carries every chapter and file of every book. */
    async #items(libraryId: string): Promise<Raw[]> {
        const out: Raw[] = [];
        for (let page = 0; ; page += 1) {
            if (page >= MAX_PAGES) {
                throw new ServiceError('UpstreamError', this.id, `a library did not end within ${MAX_PAGES} pages of ${PAGE_SIZE} items`);
            }
            const params = new URLSearchParams({ limit: String(PAGE_SIZE), page: String(page), minified: '1' });
            const body = obj(await this.#http.get<unknown>(`/api/libraries/${encodeURIComponent(libraryId)}/items?${params.toString()}`));
            const rows = list(body.results);
            out.push(...rows);
            const total = num(body.total);
            if (rows.length < PAGE_SIZE || (total !== undefined && out.length >= total)) return out;
        }
    }
}
