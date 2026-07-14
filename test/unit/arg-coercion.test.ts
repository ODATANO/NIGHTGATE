/**
 * Edge and error branches of srv/submission/arg-coercion.ts.
 *
 * The happy paths (tagged values, introspected Bytes/Uint coercion through the
 * submitContractCall handler) are covered in submission-handlers.test.ts; this
 * file pins down every CoercionError branch and the contract-info.json
 * introspection fallbacks directly against the pure functions.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    coerceCircuitArgs,
    loadCircuitArgTypes,
    clearArgTypeCache,
    CoercionError,
    type CircuitArgType
} from '../../srv/submission/arg-coercion';

const BYTES32: CircuitArgType = { name: 'b', kind: 'Bytes', length: 32 };
const UINT8: CircuitArgType = { name: 'u', kind: 'Uint', maxval: 255 };
const UINT64: CircuitArgType = { name: 'u64', kind: 'Uint', maxval: Number.MAX_SAFE_INTEGER * 4 };
const BOOL: CircuitArgType = { name: 'f', kind: 'Boolean' };
const OTHER: CircuitArgType = { name: 'o', kind: 'other' };

function coerceErr(raw: unknown, argType?: CircuitArgType): CoercionError {
    try {
        coerceCircuitArgs([raw], argType ? [argType] : undefined);
    } catch (e) {
        expect(e).toBeInstanceOf(CoercionError);
        return e as CoercionError;
    }
    throw new Error('expected CoercionError');
}

describe('Bytes coercion errors', () => {
    it('rejects hex with an odd number of characters', () => {
        expect(coerceErr('0xabc', BYTES32).message).toMatch(/even number of characters/);
    });

    it('rejects non-hex characters', () => {
        expect(coerceErr('zz'.repeat(32), BYTES32).message).toMatch(/non-hex characters/);
    });

    it('rejects hex of the wrong byte length for Bytes<32>', () => {
        expect(coerceErr('ab'.repeat(16), BYTES32).message).toMatch(/expected 32 bytes \(Bytes<32>\), got 16/);
    });

    it('rejects byte-array elements outside [0, 255]', () => {
        expect(coerceErr([1, 2, 256], BYTES32).message).toMatch(/integers in \[0, 255\]/);
        expect(coerceErr([1, -1], BYTES32).message).toMatch(/integers in \[0, 255\]/);
        expect(coerceErr([1, 2.5], BYTES32).message).toMatch(/integers in \[0, 255\]/);
    });

    it('rejects a byte array of the wrong length', () => {
        expect(coerceErr([1, 2, 3], BYTES32).message).toMatch(/expected 32 bytes/);
    });

    it('passes a correctly sized Uint8Array through unchanged', () => {
        const u8 = new Uint8Array(32).fill(7);
        expect(coerceCircuitArgs([u8], [BYTES32])[0]).toBe(u8);
    });

    it('rejects a Uint8Array of the wrong length', () => {
        expect(coerceErr(new Uint8Array(16), BYTES32).message).toMatch(/expected 32 bytes \(Bytes<32>\), got 16/);
    });

    it('rejects values that are neither hex string nor byte array', () => {
        expect(coerceErr(42, BYTES32).message).toMatch(/expected hex string or byte array/);
    });

    it('accepts 0x-prefixed hex of the right length', () => {
        const out = coerceCircuitArgs(['0x' + 'ab'.repeat(32)], [BYTES32])[0] as Uint8Array;
        expect(out).toBeInstanceOf(Uint8Array);
        expect(out.length).toBe(32);
        expect(out[0]).toBe(0xab);
    });
});

describe('Uint coercion errors', () => {
    it('rejects non-integer numbers', () => {
        expect(coerceErr(1.5, UINT8).message).toMatch(/must be an integer/);
    });

    it('rejects non-decimal strings', () => {
        expect(coerceErr('0xff', UINT8).message).toMatch(/decimal integer string/);
    });

    it('rejects non-coercible types', () => {
        expect(coerceErr(true, UINT8).message).toMatch(/cannot coerce boolean to Uint/);
    });

    it('rejects negative values', () => {
        expect(coerceErr(-1, UINT8).message).toMatch(/non-negative/);
        expect(coerceErr('-5', UINT8).message).toMatch(/non-negative/);
    });

    it('enforces maxval when it is within safe-integer range', () => {
        expect(coerceErr(300, UINT8).message).toMatch(/exceeds maximum 255/);
    });

    it('skips the upper bound for maxvals beyond safe-integer range (u64)', () => {
        const big = (2n ** 63n).toString();
        expect(coerceCircuitArgs([big], [UINT64])[0]).toBe(2n ** 63n);
    });

    it('accepts bigint, integer number and decimal string inputs', () => {
        expect(coerceCircuitArgs([5n, 7, ' 9 '], [UINT8, UINT8, UINT8])).toEqual([5n, 7n, 9n]);
    });
});

describe('Boolean and passthrough coercion', () => {
    it('rejects non-boolean values for Boolean parameters', () => {
        expect(coerceErr('true', BOOL).message).toMatch(/expected boolean, got string/);
    });

    it('passes booleans and "other"-kind values through unchanged', () => {
        const opaque = { deep: ['structure'] };
        expect(coerceCircuitArgs([true, opaque], [BOOL, OTHER])).toEqual([true, opaque]);
    });
});

describe('tagged values', () => {
    it('rejects $bytes tags whose value is not a string', () => {
        expect(coerceErr({ $bytes: 123 }).message).toMatch(/\$bytes must be a hex string/);
    });

    it('honours $bytes without circuit metadata', () => {
        const out = coerceCircuitArgs([{ $bytes: 'aabb' }])[0] as Uint8Array;
        expect([...out]).toEqual([0xaa, 0xbb]);
    });

    it('checks $bytes length against the declared Bytes<N>', () => {
        expect(coerceErr({ $bytes: 'aabb' }, BYTES32).message).toMatch(/expected 32 bytes/);
    });

    it('honours $uint (with the declared maxval when present)', () => {
        expect(coerceCircuitArgs([{ $uint: '42' }])[0]).toBe(42n);
        expect(coerceErr({ $uint: 300 }, UINT8).message).toMatch(/exceeds maximum 255/);
    });

    it('rejects untyped, untagged arguments with an actionable message', () => {
        const err = coerceErr({ some: 'object' });
        expect(err.message).toMatch(/could not determine the circuit parameter type/);
        expect(err.message).toMatch(/\{"\$bytes":"<hex>"\}/);
    });

    it('prefixes every error with the argument index', () => {
        try {
            coerceCircuitArgs(['00', 'zz'], [{ name: 'a', kind: 'Bytes', length: 1 }, { name: 'b', kind: 'Bytes', length: 1 }]);
            throw new Error('expected CoercionError');
        } catch (e: any) {
            expect(e.message).toMatch(/^args\[1\]:/);
        }
    });
});

describe('contract-info.json introspection', () => {
    let dir: string;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightgate-arginfo-'));
        clearArgTypeCache();
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
        clearArgTypeCache();
    });

    function writeInfo(json: unknown): void {
        fs.mkdirSync(path.join(dir, 'compiler'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'compiler', 'contract-info.json'), JSON.stringify(json));
    }

    it('maps Bytes / Uint / Boolean / unknown type-names', () => {
        writeInfo({
            circuits: [{
                name: 'c1',
                arguments: [
                    { name: 'b', type: { 'type-name': 'Bytes', length: 32 } },
                    { name: 'u', type: { 'type-name': 'Uint', maxval: 255 } },
                    { name: 'f', type: { 'type-name': 'Boolean' } },
                    { name: 'o', type: { 'type-name': 'Opaque' } },
                    { type: { 'type-name': 'Bytes', length: 4 } }
                ]
            }]
        });
        const types = loadCircuitArgTypes(dir, 'c1')!;
        expect(types).toEqual([
            { name: 'b', kind: 'Bytes', length: 32 },
            { name: 'u', kind: 'Uint', maxval: 255 },
            { name: 'f', kind: 'Boolean' },
            { name: 'o', kind: 'other' },
            { name: '', kind: 'Bytes', length: 4 }
        ]);
    });

    it('skips circuits without a name and returns undefined for unknown circuits', () => {
        writeInfo({ circuits: [{ arguments: [] }, { name: 'real', arguments: [] }] });
        expect(loadCircuitArgTypes(dir, 'real')).toEqual([]);
        expect(loadCircuitArgTypes(dir, 'ghost')).toBeUndefined();
    });

    it('returns undefined (not a throw) when contract-info.json is missing or unreadable', () => {
        expect(loadCircuitArgTypes(dir, 'any')).toBeUndefined();
        writeInfo('not json {{{');
        clearArgTypeCache();
        fs.writeFileSync(path.join(dir, 'compiler', 'contract-info.json'), 'not json {{{');
        expect(loadCircuitArgTypes(dir, 'any')).toBeUndefined();
    });

    it('caches per zkConfigPath (file is read once)', () => {
        writeInfo({ circuits: [{ name: 'c1', arguments: [] }] });
        const readSpy = vi.spyOn(fs, 'readFileSync');
        try {
            loadCircuitArgTypes(dir, 'c1');
            loadCircuitArgTypes(dir, 'c1');
            const reads = readSpy.mock.calls.filter(([p]) => String(p).includes('contract-info.json'));
            expect(reads.length).toBe(1);
        } finally {
            readSpy.mockRestore();
        }
    });
});
