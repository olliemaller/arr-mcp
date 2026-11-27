import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fenceText } from '../src/core/fence.ts';
import { ReadMeABookAdapter } from '../src/services/readmeabook.ts';
import { anonymiseReadMeABook } from '../scripts/lib/readmeabookCapture.ts';

const config = { url: 'http://readmeabook:3030', api_key: 'rmab_secret', timeout_ms: 5000, permissions: { safe_write: false, destructive: false } };

const captured = (name: string): unknown => JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'readmeabook', `${name}.json`), 'utf8'));

/** Answers by path; a number answers with that status. `seen` records every request. */
function stub(routes: Record<string, unknown>, seen: string[] = []): typeof fetch {
    return (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        seen.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`);
        if (!(url.pathname in routes)) return new Response('not found', { status: 404 });
        const body = routes[url.pathname];
        if (typeof body === 'number') return new Response('{"error":"no"}', { status: body });
        return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof fetch;
}

/** The live capture, from an install reporting `vDEV`, with nothing requested yet. */
const routes = (over: Record<string, unknown> = {}) => ({
    '/api/health': captured('health'),
    '/api/version': captured('version'),
    '/api/auth/me': captured('auth-me'),
    '/api/admin/metrics': captured('metrics'),
    '/api/audiobooks/search': captured('search'),
    ...over
});

const RELEASED = { version: 'v1.3.0', fullVersion: '1.3.0', commit: 'abc', buildDate: '2026-11-10' };

describe('ReadMeABookAdapter connection', () => {
    it('connects against the live capture, with no version for vDEV', async () => {
        const result = await new ReadMeABookAdapter(config, stub(routes())).testConnection();
        expect(result.ok).toBe(true);
        expect(result.version).toBeUndefined();
    });

    it('reads a released version without its v', async () => {
        const adapter = new ReadMeABookAdapter(config, stub(routes({ '/api/version': RELEASED })));
        expect(await adapter.getVersion()).toBe('1.3.0');
        expect((await adapter.testConnection()).version).toBe('1.3.0');
    });

    it('getVersion refuses vDEV rather than reporting it', async () => {
        await expect(new ReadMeABookAdapter(config, stub(routes())).getVersion()).rejects.toThrow(/vDEV/);
    });

    it('refuses a release below the floor', async () => {
        const result = await new ReadMeABookAdapter(config, stub(routes({ '/api/version': { ...RELEASED, version: 'v1.1.0' } }))).testConnection();
        expect(result.ok).toBe(false);
        expect(result.error?.kind).toBe('VersionUnsupported');
    });

    it('sends the token as a Bearer header', async () => {
        let header: string | null = null;
        const adapter = new ReadMeABookAdapter(config, (async (_input: string, init?: RequestInit) => {
            header = new Headers(init?.headers).get('Authorization');
            return new Response(JSON.stringify(captured('auth-me')), { status: 200 });
        }) as unknown as typeof fetch);
        await adapter.testConnection();
        expect(header).toBe('Bearer rmab_secret');
    });

    it('checks the token on /api/auth/me, since health and version answer anyone', async () => {
        const seen: string[] = [];
        await new ReadMeABookAdapter(config, stub(routes(), seen)).testConnection();
        expect(seen).toContain('GET /api/auth/me');
    });

    it('a 401 says the token was refused', async () => {
        const result = await new ReadMeABookAdapter(config, stub(routes({ '/api/auth/me': 401 }))).testConnection();
        expect(result.ok).toBe(false);
        expect(result.error?.kind).toBe('AuthFailed');
        expect(result.error?.remedy).toMatch(/API Tokens/);
    });

    it("a user's token fails with a remedy naming an admin", async () => {
        const user = { user: { ...(captured('auth-me') as { user: object }).user, role: 'user' } };
        const result = await new ReadMeABookAdapter(config, stub(routes({ '/api/auth/me': user }))).testConnection();
        expect(result.ok).toBe(false);
        expect(result.error?.kind).toBe('AuthFailed');
        expect(result.error?.remedy).toMatch(/admin/);
    });
});

describe('ReadMeABookAdapter health findings', () => {
    it('has none on the live capture', async () => {
        expect(await new ReadMeABookAdapter(config, stub(routes())).getFailedHealthChecks()).toEqual([]);
    });

    it('names each system issue and the failed requests', async () => {
        const metrics = { ...(captured('metrics') as object), failedLast30Days: 2, systemHealth: { status: 'degraded', issues: ['3 stale downloads (>24h)'] } };
        expect(await new ReadMeABookAdapter(config, stub(routes({ '/api/admin/metrics': metrics }))).getFailedHealthChecks()).toEqual([
            { service: 'readmeabook', source: 'system', type: 'warning', message: fenceText('3 stale downloads (>24h)', { service: 'readmeabook', field: 'issue' }) },
            { service: 'readmeabook', source: 'requests', type: 'warning', message: '2 request(s) failed in the last 30 days' }
        ]);
    });

    it('a 503 from /api/health is a lost database, and the admin route is not asked', async () => {
        const seen: string[] = [];
        const checks = await new ReadMeABookAdapter(config, stub(routes({ '/api/health': 503 }), seen)).getFailedHealthChecks();
        expect(checks).toEqual([{ service: 'readmeabook', source: 'database', type: 'error', message: 'ReadMeABook is up but cannot reach its database' }]);
        expect(seen.some(s => s.startsWith('GET /api/admin/metrics'))).toBe(false);
    });

    it("a 403 on the admin route says the token needs an admin's role", async () => {
        await expect(new ReadMeABookAdapter(config, stub(routes({ '/api/admin/metrics': 403 }))).getFailedHealthChecks()).rejects.toMatchObject({ kind: 'AuthFailed', remedy: expect.stringMatching(/admin/) });
    });
});

describe('ReadMeABookAdapter search', () => {
    it('reads the live capture as books keyed by ASIN, fenced as title by author', async () => {
        const seen: string[] = [];
        const hits = await new ReadMeABookAdapter(config, stub(routes(), seen)).search('project hail mary', 'discover');
        expect(seen).toContain('GET /api/audiobooks/search?q=project+hail+mary');
        expect(hits.length).toBe((captured('search') as { results: unknown[] }).results.length);
        expect(hits[0]).toEqual({
            service: 'readmeabook',
            source: 'discover',
            kind: 'book',
            id: 'B08GB646KR',
            title: fenceText('Project Hail Mary by Andy Weir', { service: 'readmeabook', field: 'title' }),
            ids: {},
            year: 2021,
            hasFile: false
        });
    });

    it('answers a library or indexer search with nothing, and asks nothing', async () => {
        const seen: string[] = [];
        const adapter = new ReadMeABookAdapter(config, stub(routes(), seen));
        expect(await adapter.search('x', 'library')).toEqual([]);
        expect(await adapter.search('x', 'indexers')).toEqual([]);
        expect(seen).toEqual([]);
    });

    it('skips a row with no ASIN and leaves out a year it cannot read', async () => {
        const body = { results: [{ title: 'No id' }, { asin: 'B1', title: 'Undated', releaseDate: null, isAvailable: true }] };
        const hits = await new ReadMeABookAdapter(config, stub(routes({ '/api/audiobooks/search': body }))).search('x', 'discover');
        expect(hits).toEqual([{ service: 'readmeabook', source: 'discover', kind: 'book', id: 'B1', title: fenceText('Undated', { service: 'readmeabook', field: 'title' }), ids: {}, hasFile: true }]);
    });
});

describe('anonymiseReadMeABook', () => {
    it('replaces account names, drops contact details and links, and keeps a path to its mount', () => {
        const out = anonymiseReadMeABook({
            user: { username: 'oliver', email: 'o@example.com', plexId: '123', avatarUrl: 'https://plex.tv/a.png', role: 'admin' },
            requests: [{ requestedByUsername: 'oliver', downloadPath: '/downloads/oliver/book', magnetLink: 'magnet:?xt=urn:btih:abc&tr=https://t/announce?passkey=k', title: 'Dune' }]
        });
        expect(out).toEqual({
            user: { username: 'example-user', plexId: 'example-plex-id', role: 'admin' },
            requests: [{ requestedByUsername: 'example-user', downloadPath: '/downloads', title: 'Dune' }]
        });
    });

    it('leaves the committed fixtures as it found them', () => {
        for (const name of ['auth-me', 'metrics', 'search']) expect(anonymiseReadMeABook(captured(name))).toEqual(captured(name));
    });
});
