/**
 * Audiobookshelf scrubbing for `capture-fixtures.ts`, split out so it can be
 * unit tested: `capture-fixtures.ts` runs `loadConfig()` on import.
 *
 * Titles, authors and library names are kept, as film titles are. Folder and
 * file paths are replaced (they name the server's disk layout), and so are the
 * free-text description and any URL. The adapter reads none of them.
 */
import { isRow, type Row } from './redact.ts';

const PATH_KEYS = new Set(['path', 'relPath', 'fullPath', 'coverPath', 'metadataPath']);
const TEXT_KEYS = new Set(['description', 'descriptionPlain']);
const URL_KEY = /url$/i;

export function anonymiseAudiobookshelf(value: unknown): unknown {
    if (Array.isArray(value)) return (value as unknown[]).map(anonymiseAudiobookshelf);
    if (!isRow(value)) return value;
    const out: Row = {};
    for (const [key, v] of Object.entries(value)) {
        if (PATH_KEYS.has(key) && typeof v === 'string') out[key] = v === '' ? '' : '/audiobooks/example';
        else if (TEXT_KEYS.has(key) && typeof v === 'string') out[key] = v === '' ? '' : 'Example description.';
        else if (URL_KEY.test(key) && typeof v === 'string' && v !== '') out[key] = 'https://image.example/';
        else out[key] = anonymiseAudiobookshelf(v);
    }
    return out;
}
