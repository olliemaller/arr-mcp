import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ConfigByService } from '../src/config/schema.ts';
import { AudiobookshelfAdapter } from '../src/services/audiobookshelf.ts';
import { LibraryLoader } from '../src/tools/library.ts';
import { anonymiseAudiobookshelf } from '../scripts/lib/audiobookshelfCapture.ts';

const config: ConfigByService['audiobookshelf'] = {
    url: 'http://192.0.2.41:13378',
    api_key: 'abs-key',
    timeout_ms: 10_000,
    permissions: { safe_write: false, destructive: false }
};

const fixture = (name: string): unknown => JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/audiobookshelf', `${name}.json`), 'utf8'));
/** The live 2.38.0 server's `/status`, captured with the key (it answers the same without one). */
const status = JSON.stringify(fixture('status'));

type Reply = { status?: number; body: unknown };

/**
 * Routes by path. `/status` is always the captured answer. The live library
 * was empty at capture, so tests that need items use constructed answers
 * (docs/writes.md): they test the paging and the filters, not Audiobookshelf's
 * field names on an item.
 */
function server(routes: Record<string, Reply | Reply[]>) {
    const sent: { path: string; auth: string | null }[] = [];
    const impl = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        const key = `${url.pathname}${url.search}`;
        sent.push({ path: key, auth: new Headers(init?.headers).get('authorization') });
        if (url.pathname === '/status') return new Response(status, { headers: { 'content-type': 'application/json' } });
        const route = routes[key] ?? routes[url.pathname];
        const reply = Array.isArray(route) ? route.shift() : route;
        if (reply === undefined) return new Response('{}', { status: 404 });
        return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    return { adapter: new AudiobookshelfAdapter(config, impl), sent };
}

const LIBRARIES = { body: { libraries: [{ id: 'lib-a', name: 'Audiobooks', mediaType: 'book' }, { id: 'lib-p', name: 'Podcasts', mediaType: 'podcast' }] } };
const page = (n: number) => `/api/libraries/lib-a/items?limit=200&page=${n}&minified=1`;
const book = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    addedAt: 1_790_000_000_000,
    isMissing: false,
    size: 1024,
    media: { numAudioFiles: 1, metadata: { title: `Book ${id}`, authorName: 'Some Author', publishedYear: '2019' } },
    ...over
});

describe('audiobookshelf', () => {
    it('sends the key as a Bearer token and reads the version from /status', async () => {
        const { adapter, sent } = server({ '/api/libraries': LIBRARIES });
        expect(await adapter.testConnection()).toMatchObject({ ok: true, version: '2.38.0' });
        expect(sent.find(s => s.path === '/api/libraries')?.auth).toBe('Bearer abs-key');
    });

    it('connects and reads the captured library list and its empty page', async () => {
        const libraries = fixture('libraries') as { libraries: { id: string }[] };
        const id = libraries.libraries[0]?.id ?? '';
        const { adapter, sent } = server({ '/api/libraries': { body: libraries }, [`/api/libraries/${id}/items`]: { body: fixture('library-items') } });
        expect(await adapter.testConnection()).toMatchObject({ ok: true, version: '2.38.0' });
        expect(await adapter.listLibrary()).toEqual([]);
        expect(sent.filter(s => s.path.includes('/items')).map(s => s.path)).toEqual([`/api/libraries/${id}/items?limit=200&page=0&minified=1`]);
    });

    it('fails the connection test on a refused key, though /status answered', async () => {
        const { adapter } = server({ '/api/libraries': { status: 401, body: {} } });
        const d = await adapter.testConnection();
        expect(d).toMatchObject({ ok: false, error: { kind: 'AuthFailed' } });
        expect(d.error?.remedy).toContain('API Keys');
    });

    it('reads every page of each book library and skips podcast libraries', async () => {
        const full = Array.from({ length: 200 }, (_, i) => book(`b${i}`));
        const { adapter, sent } = server({
            '/api/libraries': LIBRARIES,
            [page(0)]: { body: { results: full, total: 201 } },
            [page(1)]: { body: { results: [book('last', { isMissing: true })], total: 201 } }
        });
        const rows = await adapter.listLibrary();
        expect(rows).toHaveLength(201);
        expect(sent.some(s => s.path.includes('lib-p'))).toBe(false);
        expect(rows[0]).toMatchObject({
            kind: 'book',
            year: 2019,
            ids: {},
            library: '<<untrusted:audiobookshelf.library_name>>Audiobooks<</>>',
            acquisition: { service: 'audiobookshelf', id: 'b0', hasFile: true, sizeBytes: 1024, monitored: false }
        });
        expect(rows[0]?.title).toBe('<<untrusted:audiobookshelf.title>>Book b0 by Some Author<</>>');
        expect(rows.at(-1)?.acquisition?.hasFile).toBe(false);
    });

    it('joins get_library as book rows whose presence is unknown', async () => {
        const { adapter } = server({ '/api/libraries': LIBRARIES, [page(0)]: { body: { results: [book('x')], total: 1 } } });
        const loader = new LibraryLoader([adapter], undefined);
        const { index, counts } = await loader.load();
        expect(counts.audiobookshelf).toBe(1);
        expect(index.all()[0]).toMatchObject({ kind: 'book', presence: 'unknown' });
        expect(loader.bookSourceIds).toEqual(['audiobookshelf']);
    });
});

describe('anonymiseAudiobookshelf', () => {
    it('replaces paths, descriptions and URLs, keeping titles and ids', () => {
        const text = JSON.stringify(
            anonymiseAudiobookshelf({
                results: [{ id: 'li-1', path: '/mnt/user/books/Real Name/Book', relPath: 'Real Name/Book', media: { coverPath: '/mnt/c.jpg', metadata: { title: 'Dune', description: 'private note' } } }],
                libraries: [{ folders: [{ fullPath: '/mnt/user/books' }] }]
            })
        );
        expect(text).not.toContain('/mnt/');
        expect(text).not.toContain('Real Name');
        expect(text).not.toContain('private note');
        expect(text).toContain('Dune');
        expect(text).toContain('li-1');
    });
});
