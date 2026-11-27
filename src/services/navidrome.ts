import type { ConfigByService, ServiceId } from '../config/schema.ts';
import { subsonicToken } from '../core/auth.ts';
import { ServiceError } from '../core/errors.ts';
import { fenceText } from '../core/fence.ts';
import { ServiceHttp } from '../core/http.ts';
import type { IndexInput } from '../core/resolver.ts';
import { diagnoseConnection, type ConnectionDiagnosis, type MusicLibraryCapable, type ServiceAdapter } from './types.ts';

type Raw = Record<string, unknown>;
const obj = (v: unknown): Raw => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Raw) : {});
const list = (v: unknown): Raw[] => (Array.isArray(v) ? v.filter((r): r is Raw => typeof r === 'object' && r !== null) : []);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

/** What the playback rows name as the user: the account is the operator's, so it is not repeated. */
const ACCOUNT_LABEL = 'navidrome account';

const REMEDY_LOGIN = 'Navidrome refused the username or password. Check them in config.yaml; the account needs no admin rights.';
const REMEDY_LDAP = 'Navidrome cannot check a token for this account (an external or reverse-proxy login). Create a local Navidrome user for arr-mcp.';

/**
 * Subsonic error codes (subsonic.org/pages/api.jsp, "Error handling"). The
 * API answers HTTP 200 for every one of them, so `ServiceHttp` sees success
 * and the classification happens here.
 */
function subsonicError(id: string, error: Raw): ServiceError {
    const code = typeof error.code === 'number' ? error.code : undefined;
    const detail = `Subsonic error ${code ?? 'without a code'}`;
    if (code === 40) return new ServiceError('AuthFailed', id, detail, { remedy: REMEDY_LOGIN });
    if (code === 41) return new ServiceError('AuthFailed', id, detail, { remedy: REMEDY_LDAP });
    if (code === 50) return new ServiceError('AuthFailed', id, detail, { remedy: 'The Navidrome account is not allowed to do this.' });
    if (code === 70) return new ServiceError('NotFound', id, detail);
    return new ServiceError('UpstreamError', id, detail);
}

/**
 * Navidrome, through the Subsonic API it serves on `/rest` (with the
 * OpenSubsonic additions, which carry the MusicBrainz ids). Not its native
 * `/api`, which Navidrome documents as internal to its web UI.
 *
 * Read only: no capability here writes, and nothing needs an admin account.
 * Single instance: one music player is the one counterparty music presence
 * is measured against.
 */
export class NavidromeAdapter implements ServiceAdapter, MusicLibraryCapable {
    readonly type: ServiceId = 'navidrome';
    readonly id = 'navidrome';
    readonly #http: ServiceHttp;

    constructor(config: ConfigByService['navidrome'], fetchImpl: typeof fetch = fetch) {
        this.#http = new ServiceHttp(this.id, config, subsonicToken(config), fetchImpl);
    }

    /** One Subsonic call, unwrapped. A `failed` status is thrown as the error it names. */
    async #call(method: string, params: Record<string, string> = {}): Promise<Raw> {
        const query = new URLSearchParams(params).toString();
        const body = obj(obj(await this.#http.get<unknown>(`/rest/${method}${query === '' ? '' : `?${query}`}`))['subsonic-response']);
        if (body.status === 'failed') throw subsonicError(this.id, obj(body.error));
        if (body.status !== 'ok') throw new ServiceError('UpstreamError', this.id, `${method} returned no Subsonic response`);
        return body;
    }

    async getVersion(): Promise<string> {
        return this.#versionOf(await this.#call('ping'));
    }

    /** `serverVersion` is `0.64.2 (10114574)`: the release, then the commit. */
    #versionOf(body: Raw): string {
        if (body.type !== 'navidrome') {
            throw new ServiceError('UpstreamError', this.id, `the server at this URL is ${str(body.type) ?? 'a Subsonic server'}, not Navidrome`, {
                remedy: 'Point services.navidrome.url at a Navidrome server.'
            });
        }
        const version = str(body.serverVersion)?.split(' ')[0];
        if (version === undefined) throw new ServiceError('UpstreamError', this.id, 'ping returned no serverVersion');
        return version;
    }

    /** `ping` needs the login, so it proves the credentials as well as the version. */
    async testConnection(): Promise<ConnectionDiagnosis> {
        return diagnoseConnection(this.id, this.type, () => this.getVersion());
    }

    async listMusicLibrary(): Promise<IndexInput[]> {
        const body = await this.#call('getArtists');
        return list(obj(body.artists).index)
            .flatMap(index => list(index.artist))
            .flatMap(artist => {
                const id = str(artist.id);
                if (id === undefined) return [];
                const mbid = str(artist.musicBrainzId);
                return [
                    {
                        kind: 'artist' as const,
                        title: fenceText(str(artist.name) ?? '', { service: this.id, field: 'name' }),
                        ids: mbid === undefined ? {} : { mbid },
                        playback: { user: ACCOUNT_LABEL, itemId: id }
                    }
                ];
            });
    }

    async listArtistAlbumTitles(artistId: string): Promise<string[]> {
        const body = await this.#call('getArtist', { id: artistId });
        return list(obj(body.artist).album).flatMap(album => str(album.name) ?? []);
    }
}
