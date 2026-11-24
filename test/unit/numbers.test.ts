import { describe, expect, it } from 'vitest';
import { toBigInt, toInt, int64ResultAsText, attachInt64Results } from '../../srv/utils/numbers';

describe('toInt', () => {
    it('coerces numbers and numeric strings, everything else to 0', () => {
        expect(toInt(7.9)).toBe(7);
        expect(toInt('42')).toBe(42);
        expect(toInt('1,234')).toBe(1234);
        expect(toInt('  ')).toBe(0);
        expect(toInt('abc')).toBe(0);
        expect(toInt(undefined)).toBe(0);
        expect(toInt(Infinity)).toBe(0);
        expect(toInt('9'.repeat(30))).toBe(0);
    });
});

describe('toBigInt', () => {
    it('coerces bigints, numbers and decimal strings, everything else to 0n', () => {
        expect(toBigInt(5n)).toBe(5n);
        expect(toBigInt(7.9)).toBe(7n);
        expect(toBigInt('12')).toBe(12n);
        expect(toBigInt('-3')).toBe(-3n);
        expect(toBigInt('1_000_000')).toBe(1_000_000n);
        expect(toBigInt('nope')).toBe(0n);
        expect(toBigInt('')).toBe(0n);
        expect(toBigInt(undefined)).toBe(0n);
    });
});

describe('int64ResultAsText', () => {
    const int64 = { type: 'cds.Integer64' };
    const answer = {
        elements: {
            height: int64, attempt: { type: 'cds.Integer' }, hash: { type: 'cds.String' },
            block: { elements: { height: int64, note: { type: 'cds.String' } } },
            rows: { items: { elements: { index: int64 } } },
            heights: { items: int64 }
        }
    };

    it('writes a 64-bit integer as text, in structures and lists, and leaves everything else', () => {
        const result = {
            height: 7, attempt: 2, hash: 'ab', block: { height: 2 ** 40, note: '12' }, rows: [{ index: 1 }, { index: 2n }], heights: [3, '4', null], extra: 9
        };
        expect(int64ResultAsText(result, answer)).toBe(result);
        expect(result).toEqual({
            height: '7', attempt: 2, hash: 'ab', block: { height: '1099511627776', note: '12' }, rows: [{ index: '1' }, { index: '2' }], heights: ['3', '4', null], extra: 9
        });
    });

    it('keeps text, null and a value that is no integer as they are', () => {
        expect(int64ResultAsText({ height: '7' }, answer)).toEqual({ height: '7' });
        expect(int64ResultAsText({ height: null }, answer)).toEqual({ height: null });
        expect(int64ResultAsText({ height: NaN }, answer)).toEqual({ height: NaN });
        expect(int64ResultAsText(5, int64)).toBe('5');
        expect(int64ResultAsText(5, undefined)).toBe(5);
        expect(int64ResultAsText([{ height: 1 }], answer)).toEqual([{ height: '1' }]);
    });
});

describe('attachInt64Results', () => {
    it('answers a function that returns a bare Integer64 with text', async () => {
        let after: ((result: unknown, req: { event: string; results?: unknown }) => void) | undefined;
        const srv = { after: (_: string, fn: typeof after) => { after = fn; }, actions: { getHeight: { returns: { type: 'cds.Integer64' } } } };
        attachInt64Results(srv as never);
        const req: { event: string; results?: unknown } = { event: 'getHeight', results: 9007199254740993n };
        after!(req.results, req);
        expect(req.results).toBe('9007199254740993');
    });
});
