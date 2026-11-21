// Converts JSON circuit arguments into the byte arrays and bigints that Compact circuits expect.
// A `$bytes` or `$uint` tag decides first, then the types in contract-info.json. Untagged arguments without type info are rejected.

import fs from 'fs';
import path from 'path';
import { NightgateError } from '../utils/errors';

/** A single circuit parameter's type, distilled from contract-info.json. */
export interface CircuitArgType {
    name: string;
    kind: 'Bytes' | 'Uint' | 'Boolean' | 'Struct' | 'Vector' | 'other';
    /** Struct fields in declaration order. */
    elements?: CircuitArgType[];
    /** Type of a Vector's entries. */
    element?: CircuitArgType;
    length?: number;
    maxval?: number;
}

/** `index` is the position in `args`, or -1 for a fault of the argument list as a whole. */
export class CoercionError extends NightgateError {
    constructor(public readonly index: number, reason: string) {
        super('ARG_COERCION_FAILED', index < 0 ? reason : `args[${index}]: ${reason}`);
    }
}

const HEX_RE = /^[0-9a-fA-F]*$/;

function decodeHex(hex: string, index: number, expectedLen?: number): Uint8Array {
    const clean = hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex;
    if (clean.length % 2 !== 0) {
        throw new CoercionError(index, `hex string must have an even number of characters (got ${clean.length})`);
    }
    if (!HEX_RE.test(clean)) {
        throw new CoercionError(index, 'value contains non-hex characters');
    }
    const out = new Uint8Array(clean.length / 2);
    for (let i = 0; i < out.length; i++) {
        out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    }
    if (expectedLen !== undefined && out.length !== expectedLen) {
        throw new CoercionError(index, `expected ${expectedLen} bytes (Bytes<${expectedLen}>), got ${out.length}`);
    }
    return out;
}

function numberArrayToBytes(arr: number[], index: number, expectedLen?: number): Uint8Array {
    for (const n of arr) {
        if (!Number.isInteger(n) || n < 0 || n > 255) {
            throw new CoercionError(index, 'byte array elements must be integers in [0, 255]');
        }
    }
    if (expectedLen !== undefined && arr.length !== expectedLen) {
        throw new CoercionError(index, `expected ${expectedLen} bytes (Bytes<${expectedLen}>), got ${arr.length}`);
    }
    return Uint8Array.from(arr);
}

function toBigInt(value: unknown, index: number, maxval?: number): bigint {
    let v: bigint;
    if (typeof value === 'bigint') {
        v = value;
    } else if (typeof value === 'number') {
        if (!Number.isInteger(value)) {
            throw new CoercionError(index, `Uint value must be an integer (got ${value})`);
        }
        v = BigInt(value);
    } else if (typeof value === 'string') {
        if (!/^-?\d+$/.test(value.trim())) {
            throw new CoercionError(index, `Uint value must be a decimal integer string (got "${value}")`);
        }
        v = BigInt(value.trim());
    } else {
        throw new CoercionError(index, `cannot coerce ${typeof value} to Uint`);
    }
    if (v < 0n) {
        throw new CoercionError(index, `Uint value must be non-negative (got ${v})`);
    }
    // Larger limits lose precision in JSON.parse. The circuit checks the exact limit.
    if (maxval !== undefined && maxval <= Number.MAX_SAFE_INTEGER && v > BigInt(maxval)) {
        throw new CoercionError(index, `Uint value ${v} exceeds maximum ${maxval}`);
    }
    return v;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Uint8Array);
}

/** A tag names the value's type. It must not contradict a declared type; an undeclared one is left to the tag. */
function refuseTagAgainstType(tag: '$bytes' | '$uint', kind: 'Bytes' | 'Uint', argType: CircuitArgType | undefined, index: number): void {
    if (!argType || argType.kind === kind || argType.kind === 'other') return;
    throw new CoercionError(index, `${tag} given, but the circuit takes ${argType.kind} here`);
}

function coerceOne(raw: unknown, argType: CircuitArgType | undefined, index: number): unknown {
    if (isPlainObject(raw)) {
        if (Object.prototype.hasOwnProperty.call(raw, '$bytes')) {
            refuseTagAgainstType('$bytes', 'Bytes', argType, index);
            const hex = raw['$bytes'];
            if (typeof hex !== 'string') throw new CoercionError(index, '$bytes must be a hex string');
            return decodeHex(hex, index, argType?.kind === 'Bytes' ? argType.length : undefined);
        }
        if (Object.prototype.hasOwnProperty.call(raw, '$uint')) {
            refuseTagAgainstType('$uint', 'Uint', argType, index);
            return toBigInt(raw['$uint'], index, argType?.kind === 'Uint' ? argType.maxval : undefined);
        }
    }

    if (argType) {
        switch (argType.kind) {
            case 'Bytes':
                if (raw instanceof Uint8Array) {
                    if (argType.length !== undefined && raw.length !== argType.length) {
                        throw new CoercionError(index, `expected ${argType.length} bytes (Bytes<${argType.length}>), got ${raw.length}`);
                    }
                    return raw;
                }
                if (typeof raw === 'string') return decodeHex(raw, index, argType.length);
                if (Array.isArray(raw)) return numberArrayToBytes(raw as number[], index, argType.length);
                throw new CoercionError(index, `expected hex string or byte array for Bytes<${argType.length ?? '?'}>, got ${typeof raw}`);
            case 'Uint':
                return toBigInt(raw, index, argType.maxval);
            case 'Boolean':
                if (typeof raw === 'boolean') return raw;
                throw new CoercionError(index, `expected boolean, got ${typeof raw}`);
            case 'Struct': {
                if (!isPlainObject(raw)) {
                    throw new CoercionError(index, `expected an object for struct ${argType.name}, got ${typeof raw}`);
                }
                const out: Record<string, unknown> = {};
                for (const el of argType.elements ?? []) {
                    if (!Object.prototype.hasOwnProperty.call(raw, el.name)) {
                        throw new CoercionError(index, `struct field "${el.name}" is missing`);
                    }
                    out[el.name] = coerceOne(raw[el.name], el, index);
                }
                return out;
            }
            case 'Vector': {
                if (!Array.isArray(raw)) {
                    throw new CoercionError(index, `expected an array for Vector<${argType.length ?? '?'}>, got ${typeof raw}`);
                }
                if (argType.length !== undefined && raw.length !== argType.length) {
                    throw new CoercionError(index, `expected ${argType.length} entries (Vector<${argType.length}>), got ${raw.length}`);
                }
                const element = argType.element;
                return element ? raw.map(entry => coerceOne(entry, element, index)) : raw;
            }
            default:
                return raw;
        }
    }

    throw new CoercionError(
        index,
        'could not determine the circuit parameter type (the contract\'s ' +
        'contract-info.json was not found - check the registered artifact path). ' +
        'Pass a tagged value instead: {"$bytes":"<hex>"} or {"$uint":<n>}.'
    );
}

export function coerceCircuitArgs(rawArgs: unknown[], argTypes?: CircuitArgType[]): unknown[] {
    if (argTypes && rawArgs.length !== argTypes.length) {
        throw new CoercionError(-1, `the circuit takes ${argTypes.length} argument(s), got ${rawArgs.length}`);
    }
    return rawArgs.map((raw, i) => coerceOne(raw, argTypes?.[i], i));
}

// ---- contract-info.json introspection -------------------------------------

interface RawArgTypeNode {
    'type-name'?: string;
    name?: string;
    length?: number;
    maxval?: number;
    elements?: Array<{ name?: string; type?: RawArgTypeNode }>;
    /** Entry type of a Vector. */
    type?: RawArgTypeNode;
}
interface RawCircuit {
    name?: string;
    arguments?: Array<{ name?: string; type?: RawArgTypeNode }>;
}

function mapArgType(node: RawArgTypeNode | undefined, name: string): CircuitArgType {
    const tn = node?.['type-name'];
    if (tn === 'Bytes') return { name, kind: 'Bytes', length: node?.length };
    if (tn === 'Uint') return { name, kind: 'Uint', maxval: node?.maxval };
    // A Field is a non-negative integer like a Uint. Its upper limit is checked by the circuit.
    if (tn === 'Field') return { name, kind: 'Uint' };
    if (tn === 'Boolean') return { name, kind: 'Boolean' };
    if (tn === 'Vector') return { name, kind: 'Vector', length: node?.length, element: node?.type ? mapArgType(node.type, name) : undefined };
    if (tn === 'Struct') {
        return { name, kind: 'Struct', elements: (node?.elements ?? []).map((e) => mapArgType(e.type, e.name ?? '')) };
    }
    return { name, kind: 'other' };
}

// The cache key includes file stats, so a recompiled contract at the same path is read again.
const argTypeCache = new Map<string, Map<string, CircuitArgType[]> | null>();

function contractInfoKey(infoPath: string): string {
    try {
        const st = fs.statSync(infoPath);
        return `${infoPath}|${st.size}|${st.mtimeMs}|${st.ino}`;
    } catch {
        return `${infoPath}|missing`;
    }
}

function loadContractInfo(zkConfigPath: string): Map<string, CircuitArgType[]> | null {
    const infoPath = path.join(zkConfigPath, 'compiler', 'contract-info.json');
    const key = contractInfoKey(infoPath);
    if (argTypeCache.has(key)) return argTypeCache.get(key)!;
    let parsed: { circuits?: RawCircuit[] };
    try {
        parsed = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
    } catch {
        argTypeCache.set(key, null);
        return null;
    }
    // A file without a circuit list says nothing about the circuits, like a missing file.
    if (!Array.isArray(parsed?.circuits)) {
        argTypeCache.set(key, null);
        return null;
    }
    const byCircuit = new Map<string, CircuitArgType[]>();
    for (const c of parsed.circuits) {
        if (!c.name) continue;
        byCircuit.set(c.name, (c.arguments ?? []).map((a) => mapArgType(a.type, a.name ?? '')));
    }
    for (const k of [...argTypeCache.keys()]) if (k.startsWith(infoPath + '|') && k !== key) argTypeCache.delete(k);
    argTypeCache.set(key, byCircuit);
    return byCircuit;
}

/** Undefined when the contract has no type info. Then only tagged values are accepted. Throws when the info does not list the circuit. */
export function loadCircuitArgTypes(zkConfigPath: string, circuit: string): CircuitArgType[] | undefined {
    const byCircuit = loadContractInfo(zkConfigPath);
    if (!byCircuit) return undefined;
    const argTypes = byCircuit.get(circuit);
    if (!argTypes) throw new CoercionError(-1, `"${circuit}" is not a circuit of this contract; it has: ${[...byCircuit.keys()].join(', ')}`);
    return argTypes;
}

export function __clearArgTypeCacheForTests(): void {
    argTypeCache.clear();
}
