import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ConfigByService } from '../src/config/schema.ts';
import { NavidromeAdapter } from '../src/services/navidrome.ts';
import { hasMusicLibrary } from '../src/services/types.ts';

const config: ConfigByService['navidrome'] = {
    url: 'http://192.0.2.40:4533',
    username: 'arr-mcp',
    password: 'pa55word',
    timeout_ms: 10_000,
    permissions: { safe_write: false, destructive: false }
};

const fixture = (name: string): unknown => JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/navidrome', `${name}.json`), 'utf8'));

/** The live 0.64.2 server's answer to a ping with no login (test/fixtures/discovery), for the error cases. */
const unauthenticated = JSON.parse(
    (JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/discovery/navidrome-ping.json'), 'utf8')) as { body: string }).body
) as { 'subsonic-response': Record<string, unknown> };

const withResponse = (over: Record<string, unknown>) => ({ 'subsonic-response': { ...unauthenticated['subsonic-response'], ...over } });

function server(body: unknown) {
    const sent: URL[] = [];
    const impl = (async (input: string | URL | Request) => {
        sent.push(new URL(input instanceof Request ? input.url : String(input)));
        return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    return { adapter: new NavidromeAdapter(config, impl), sent };
}

describe('navidrome', () => {
    it('signs every call with a salted token, never the password', async () => {
        const { adapter, sent } = server(withResponse({ status: 'ok', error: undefined }));
        await adapter.testConnection();
        const url = sent[0] as URL;
        expect(url.pathname).toBe('/rest/ping');
        const salt = url.searchParams.get('s') ?? '';
        expect(salt).toMatch(/^[0-9a-f]{16}$/);
        expect(url.searchParams.get('t')).toBe(createHash('md5').update(`pa55word${salt}`).digest('hex'));
        expect(url.searchParams.get('u')).toBe('arr-mcp');
        expect(url.searchParams.get('f')).toBe('json');
        expect(url.toString()).not.toContain('pa55word');
    });

    it('reads the release from serverVersion on a signed-in ping', async () => {
        const { adapter } = server(fixture('ping'));
        expect(await adapter.testConnection()).toMatchObject({ ok: true, version: '0.64.2' });
    });

    it('reads every artist across the index, as artist rows keyed by the player id', async () => {
        const { adapter, sent } = server(fixture('artists'));
        const rows = await adapter.listMusicLibrary();
        expect(sent[0]?.pathname).toBe('/rest/getArtists');
        expect(rows).toHaveLength(12);
        for (const row of rows) {
            expect(row.kind).toBe('artist');
            expect(row.title).toMatch(/^<<untrusted:navidrome\.name>>.+<<\/>>$/);
            expect(row.playback?.itemId).toMatch(/^\w+$/);
        }
    });

    it('leaves the MusicBrainz id out when Navidrome sends an empty one, as this library does for every artist', async () => {
        const rows = await server(fixture('artists')).adapter.listMusicLibrary();
        expect(rows.every(r => r.ids.mbid === undefined)).toBe(true);
    });

    it("reads an artist's album titles raw", async () => {
        const { adapter, sent } = server(fixture('artist'));
        const titles = await adapter.listArtistAlbumTitles('4NxVR0mOPN6KeIt2HyVgYS');
        expect(sent[0]?.searchParams.get('id')).toBe('4NxVR0mOPN6KeIt2HyVgYS');
        expect(titles).toHaveLength(1);
        expect(titles[0]).not.toContain('<<untrusted');
    });

    it('reports a Subsonic error answered with HTTP 200 as a failure', async () => {
        const { adapter } = server(unauthenticated);
        expect(await adapter.testConnection()).toMatchObject({ ok: false, error: { kind: 'UpstreamError', detail: 'Subsonic error 10' } });
    });

    it('reports a wrong login as AuthFailed with a remedy', async () => {
        const { adapter } = server(withResponse({ error: { code: 40, message: 'Wrong username or password' } }));
        const d = await adapter.testConnection();
        expect(d).toMatchObject({ ok: false, error: { kind: 'AuthFailed' } });
        expect(d.error?.remedy).toContain('no admin rights');
    });

    it('refuses a Subsonic server that is not Navidrome', async () => {
        const { adapter } = server(withResponse({ status: 'ok', error: undefined, type: 'gonic' }));
        expect(await adapter.testConnection()).toMatchObject({ ok: false, error: { kind: 'UpstreamError', detail: expect.stringContaining('gonic') } });
    });

    it('is a music library, and not a media server', () => {
        const { adapter } = server({});
        expect(hasMusicLibrary(adapter)).toBe(true);
        expect('listUserLibrary' in adapter).toBe(false);
    });
});
