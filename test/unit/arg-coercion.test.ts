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
    __clearArgTypeCacheForTests,
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

describe('a number JSON has rounded', () => {
    it('is refused, because the value the caller sent is gone', () => {
        // 9007199254740993 arrives as 9007199254740992 after JSON.parse.
        const [rounded] = JSON.parse('[9007199254740993]') as number[];
        expect(coerceErr(rounded, UINT64).message).toMatch(/above 2\^53 must be a decimal string/);
    });

    it('the same value as text and the largest exact number pass', () => {
        expect(coerceCircuitArgs(['9007199254740993'], [UINT64])).toEqual([9007199254740993n]);
        expect(coerceCircuitArgs([Number.MAX_SAFE_INTEGER], [UINT64])).toEqual([9007199254740991n]);
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

describe('the argument list as a whole', () => {
    const BYTES2: CircuitArgType = { name: 'b', kind: 'Bytes', length: 2 };
    const UINT: CircuitArgType = { name: 'u', kind: 'Uint', maxval: 255 };

    it('refuses too few and too many arguments when the types are known', () => {
        expect(() => coerceCircuitArgs(['aabb'], [BYTES2, UINT])).toThrow(/^the circuit takes 2 argument\(s\), got 1$/);
        expect(() => coerceCircuitArgs(['aabb', 1, { $uint: 2 }], [BYTES2, UINT])).toThrow(/takes 2 argument\(s\), got 3/);
        expect(() => coerceCircuitArgs([], [])).not.toThrow();
        // Without type info the count is unknown, so tagged values pass in any number.
        expect(coerceCircuitArgs([{ $uint: 1 }, { $uint: 2 }])).toEqual([1n, 2n]);
    });

    it('refuses a tag that contradicts the declared type, and takes it where the type is not known', () => {
        expect(() => coerceCircuitArgs([{ $bytes: 'aabb' }], [UINT])).toThrow(/args\[0\]: \$bytes given, but the circuit takes Uint here/);
        expect(() => coerceCircuitArgs([{ $uint: 1 }], [BYTES2])).toThrow(/args\[0\]: \$uint given, but the circuit takes Bytes here/);
        expect(() => coerceCircuitArgs([{ $uint: 1 }], [{ name: 'f', kind: 'Boolean' }])).toThrow(/takes Boolean here/);
        expect(coerceCircuitArgs([{ $bytes: 'aabb' }, { $uint: 7 }], [BYTES2, UINT])).toEqual([Uint8Array.from([0xaa, 0xbb]), 7n]);
        expect(coerceCircuitArgs([{ $uint: 7 }], [{ name: 'o', kind: 'other' }])).toEqual([7n]);
    });
});

describe('contract-info.json introspection', () => {
    let dir: string;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightgate-arginfo-'));
        __clearArgTypeCacheForTests();
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
        __clearArgTypeCacheForTests();
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

    it('skips circuits without a name and refuses a circuit the info does not list, naming the ones it has', () => {
        writeInfo({ circuits: [{ arguments: [] }, { name: 'real', arguments: [] }, { name: 'other', arguments: [] }] });
        expect(loadCircuitArgTypes(dir, 'real')).toEqual([]);
        expect(() => loadCircuitArgTypes(dir, 'ghost')).toThrow(/"ghost" is not a circuit of this contract; it has: real, other/);
        expect(() => loadCircuitArgTypes(dir, 'ghost')).toThrow(CoercionError);
    });

    it('an info file without a circuit list counts as no type info', () => {
        writeInfo({ 'compiler-version': '0.0.0' });
        expect(loadCircuitArgTypes(dir, 'any')).toBeUndefined();
    });

    it('maps a Field like a Uint without a limit, and a Vector with its entry type', () => {
        writeInfo({
            circuits: [{
                name: 'c2',
                arguments: [
                    { name: 'f', type: { 'type-name': 'Field' } },
                    { name: 'mask', type: { 'type-name': 'Vector', length: 3, type: { 'type-name': 'Boolean' } } },
                    { name: 'keys', type: { 'type-name': 'Vector', length: 2, type: { 'type-name': 'Bytes', length: 2 } } }
                ]
            }]
        });
        const types = loadCircuitArgTypes(dir, 'c2')!;
        expect(types).toEqual([
            { name: 'f', kind: 'Uint' },
            { name: 'mask', kind: 'Vector', length: 3, element: { name: 'mask', kind: 'Boolean' } },
            { name: 'keys', kind: 'Vector', length: 2, element: { name: 'keys', kind: 'Bytes', length: 2 } }
        ]);
        expect(coerceCircuitArgs(['12', [true, false, true], ['aabb', [1, 2]]], types))
            .toEqual([12n, [true, false, true], [Uint8Array.from([0xaa, 0xbb]), Uint8Array.from([1, 2])]]);
        expect(() => coerceCircuitArgs([1, [true, false], ['aabb', 'ccdd']], types)).toThrow(/args\[1\]: expected 3 entries \(Vector<3>\), got 2/);
        expect(() => coerceCircuitArgs([1, [true, 1, true], ['aabb', 'ccdd']], types)).toThrow(/args\[1\]: expected boolean, got number/);
        expect(() => coerceCircuitArgs([1, 'nope', ['aabb', 'ccdd']], types)).toThrow(/args\[1\]: expected an array for Vector<3>, got string/);
    });

    it('returns undefined (not a throw) when contract-info.json is missing or unreadable', () => {
        expect(loadCircuitArgTypes(dir, 'any')).toBeUndefined();
        writeInfo('not json {{{');
        __clearArgTypeCacheForTests();
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

describe('Struct coercion (e.g. ShieldedCoinInfo for receiveShielded)', () => {
    const COIN: CircuitArgType = {
        name: 'coin', kind: 'Struct', elements: [
            { name: 'nonce', kind: 'Bytes', length: 32 },
            { name: 'color', kind: 'Bytes', length: 32 },
            { name: 'value', kind: 'Uint' }
        ]
    };
    const HEX32 = 'ab'.repeat(32);

    it('coerces every declared field with its own type (tagged and untagged)', () => {
        const [coin] = coerceCircuitArgs(
            [{ nonce: { $bytes: HEX32 }, color: HEX32, value: { $uint: '100000000' } }], [COIN]
        ) as [Record<string, unknown>];
        expect(coin.nonce).toBeInstanceOf(Uint8Array);
        expect((coin.nonce as Uint8Array).length).toBe(32);
        expect(coin.color).toBeInstanceOf(Uint8Array);
        expect(coin.value).toBe(100000000n);
        expect(Object.keys(coin)).toEqual(['nonce', 'color', 'value']);
    });

    it('rejects a non-object and a missing field with the argument index', () => {
        expect(coerceErr('not-an-object', COIN).message).toMatch(/args\[0\]: expected an object for struct coin/);
        expect(coerceErr({ nonce: { $bytes: HEX32 }, value: 1 }, COIN).message).toMatch(/struct field "color" is missing/);
    });

    it('surfaces a field-level error (wrong Bytes length)', () => {
        expect(coerceErr({ nonce: 'abcd', color: HEX32, value: 1 }, COIN).message).toMatch(/expected 32 bytes/);
    });

    it('is mapped from contract-info.json with its elements', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightgate-arginfo-struct-'));
        __clearArgTypeCacheForTests();
        try {
            fs.mkdirSync(path.join(dir, 'compiler'), { recursive: true });
            fs.writeFileSync(path.join(dir, 'compiler', 'contract-info.json'), JSON.stringify({
                circuits: [{
                    name: 'burn',
                    arguments: [
                        { name: 'coin', type: { 'type-name': 'Struct', name: 'ShieldedCoinInfo', elements: [
                            { name: 'nonce', type: { 'type-name': 'Bytes', length: 32 } },
                            { name: 'color', type: { 'type-name': 'Bytes', length: 32 } },
                            { name: 'value', type: { 'type-name': 'Uint', maxval: 255 } }
                        ] } },
                        { name: 'zcashRecipient', type: { 'type-name': 'Bytes', length: 43 } }
                    ]
                }]
            }));
            expect(loadCircuitArgTypes(dir, 'burn')).toEqual([
                { name: 'coin', kind: 'Struct', elements: [
                    { name: 'nonce', kind: 'Bytes', length: 32 },
                    { name: 'color', kind: 'Bytes', length: 32 },
                    { name: 'value', kind: 'Uint', maxval: 255 }
                ] },
                { name: 'zcashRecipient', kind: 'Bytes', length: 43 }
            ]);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
            __clearArgTypeCacheForTests();
        }
    });
});
