/**
 * Proof inputs that reach the server as JSON text carry their hashes in the
 * same spellings as a typed parameter: with or without `0x`, in either case.
 */
import { describe, expect, it } from 'vitest';
import { readHash32, readInclusionPath, validateOpening, validateSchemaSlots } from '../../srv/submission/actions/common';

const bare = (c: string) => c.repeat(32);
const loud = (c: string) => `0x${c.repeat(32).toUpperCase()}`;

describe('readHash32', () => {
    it('answers bare lowercase hex for every spelling of 32 bytes', () => {
        expect(readHash32(bare('ab'))).toBe(bare('ab'));
        expect(readHash32(loud('ab'))).toBe(bare('ab'));
        expect(readHash32(` 0X${bare('ab')} `)).toBe(bare('ab'));
    });

    it('answers undefined for anything else', () => {
        for (const value of ['', 'ab', bare('ab') + 'cd', `0x${'ab'.repeat(31)}`, 'zz'.repeat(32), 7, null, undefined, [bare('ab')]]) {
            expect(readHash32(value)).toBeUndefined();
        }
    });
});

describe('proof inputs with 0x and capitals', () => {
    const names = { siblings: 'siblings', dirs: 'dirs' };

    it('a Merkle path comes back as bare lowercase hashes', () => {
        const path = readInclusionPath([loud('a1'), bare('b2')], [true, false], 2, names);
        expect(path).toEqual({ siblings: [bare('a1'), bare('b2')], dirs: [true, false] });
        expect(readInclusionPath([loud('a1'), 'short'], [true, false], 2, names)).toBe('siblings entries must be 64 hex chars (32 bytes)');
    });

    it('a schema keeps its field keys as bare lowercase hex', () => {
        const schema = validateSchemaSlots([{ fieldKey: loud('c3'), kind: 0, scale: '2' }, { fieldKey: bare('d4'), kind: 2 }], 'schema', 2);
        expect(schema).toEqual([{ fieldKey: bare('c3'), kind: 0, scale: '2' }, { fieldKey: bare('d4'), kind: 2, scale: '0' }]);
        expect(() => validateSchemaSlots([{ fieldKey: '0xzz', kind: 0 }], 'schema', 1)).toThrow(/schema\[0\]\.fieldKey must be 64 hex/);
    });

    it('an opening keeps its salt seed and value digests as bare lowercase hex', () => {
        const opening = validateOpening({ saltSeed: loud('e5'), slots: [{ present: true, valueDigest: loud('f6') }, { present: false }] }, 'openingA', 2);
        expect(opening).toEqual({ saltSeed: bare('e5'), slots: [{ present: true, valueDigest: bare('f6') }, { present: false }] });
        expect(() => validateOpening({ saltSeed: 'nope', slots: [] }, 'openingA', 0)).toThrow(/openingA\.saltSeed must be 64 hex/);
        expect(() => validateOpening({ saltSeed: bare('e5'), slots: [{ present: true, valueDigest: '0x12' }] }, 'openingA', 1)).toThrow(/slots\[0\]\.valueDigest must be 64 hex/);
    });
});
