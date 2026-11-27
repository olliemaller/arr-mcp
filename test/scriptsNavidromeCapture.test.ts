import { describe, expect, it } from 'vitest';
import { anonymiseNavidrome } from '../scripts/lib/navidromeCapture.ts';

describe('anonymiseNavidrome', () => {
    it('replaces every URL and blanks the account, keeping names and ids', () => {
        const signed = 'http://192.0.2.40:4533/share/img/eyJhbGciOiJIUzI1NiJ9.secret?size=300';
        const out = anonymiseNavidrome({
            'subsonic-response': {
                artists: {
                    index: [{ name: 'D', artist: [{ id: 'ar-1', name: 'Daft Punk', artistImageUrl: signed, musicBrainzId: 'm', album: [{ coverArtUrl: signed }] }] }]
                },
                user: { username: 'arr-mcp', email: 'someone@example.org' }
            }
        });
        const text = JSON.stringify(out);
        expect(text).not.toContain('eyJ');
        expect(text).not.toContain('192.0.2.40');
        expect(text).not.toContain('arr-mcp');
        expect(text).not.toContain('someone@');
        expect(text).toContain('Daft Punk');
        expect(text).toContain('"ar-1"');
    });
});
