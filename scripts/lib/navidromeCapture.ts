/**
 * Navidrome scrubbing for `capture-fixtures.ts`, split out so it can be unit
 * tested: `capture-fixtures.ts` runs `loadConfig()` on import.
 *
 * Artist and album names are kept, as film titles are. Every URL is replaced:
 * Navidrome's `artistImageUrl` points back at the server with a signed token in
 * its path, and other image fields can name a Last.fm or Spotify host. The
 * account name a response can carry (`username` on some calls) is blanked.
 */
import { isRow, type Row } from './redact.ts';

const URL_KEY = /url$/i;
const BLANKED = new Set(['username', 'email']);

export function anonymiseNavidrome(value: unknown): unknown {
    if (Array.isArray(value)) return (value as unknown[]).map(anonymiseNavidrome);
    if (!isRow(value)) return value;
    const out: Row = {};
    for (const [key, v] of Object.entries(value)) {
        if (BLANKED.has(key) && typeof v === 'string') out[key] = '';
        else if (URL_KEY.test(key) && typeof v === 'string' && v !== '') out[key] = 'https://image.example/';
        else out[key] = anonymiseNavidrome(v);
    }
    return out;
}
