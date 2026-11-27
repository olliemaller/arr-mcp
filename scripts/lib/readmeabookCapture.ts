/**
 * ReadMeABook scrubbing for `capture-fixtures.ts`, split out so it can be unit
 * tested: `capture-fixtures.ts` runs `loadConfig()` on import.
 *
 * Titles, authors and narrators are catalogue data and stay. What names a
 * person (the account behind a request or the token) gets a stand-in, contact
 * details and avatars are dropped, and a path on disk keeps only its first
 * segment. Download links are dropped outright: a stored one can carry an
 * indexer's key.
 */
import { isRow, type Row } from './redact.ts';

/** Never kept: contact details, avatars and links that can carry a key. */
const DROPPED_KEYS = new Set(['email', 'avatarUrl', 'avatar', 'plexEmail', 'plexAvatar', 'thumb', 'magnetLink', 'torrentUrl', 'downloadUrl', 'infoUrl', 'guid']);

/** Who an account is: the same stand-in at any depth. */
const STAND_INS: Record<string, string> = {
    username: 'example-user',
    plexUsername: 'example-user',
    requestedByUsername: 'example-user',
    plexId: 'example-plex-id',
    displayName: 'Example User'
};

/** A path keeps at most its first segment: `/downloads` names a mount, not a person's folders. */
const rootOf = (path: string): string => {
    const first = path.split('/').filter(part => part !== '')[0];
    return first === undefined ? '' : `/${first}`;
};

const isPathKey = (key: string): boolean => key === 'path' || key.endsWith('Path') || key.endsWith('Dir');

function scrub(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(scrub);
    if (!isRow(value)) return value;
    const out: Row = {};
    for (const [key, v] of Object.entries(value)) {
        if (DROPPED_KEYS.has(key)) continue;
        if (typeof v === 'string' && key in STAND_INS) out[key] = STAND_INS[key] ?? v;
        else if (typeof v === 'string' && isPathKey(key)) out[key] = rootOf(v);
        else out[key] = scrub(v);
    }
    return out;
}

export const anonymiseReadMeABook = (body: unknown): unknown => scrub(body);
