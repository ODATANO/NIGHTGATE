/**
 * Typed argument coercion for the generic `submitContractCall` action.
 *
 * Problem: a
 * compiled Compact circuit guards a `Bytes<N>` parameter strictly as a real
 * `Uint8Array(N)` (`.buffer instanceof ArrayBuffer && BYTES_PER_ELEMENT === 1
 * && length === N`). The public `submitContractCall` takes `args` as a JSON
 * string, and JSON cannot carry a `Uint8Array` — so a hex string or a
 * `number[]` both fail the guard, and the only circuits callable generically
 * were the JSON-native ones (numbers/bools). The built-in actions
 * (`anchorDocument` etc.) dodged this by hex-decoding internally before the
 * submitter; that conversion was unreachable through the generic action.
 *
 * This module bridges the gap: between `JSON.parse(args)` in the handler and
 * the worker's `fn(...callArgs)`, each arg is coerced to the value shape the
 * circuit actually expects. Coerced `Uint8Array` / `BigInt` values survive the
 * worker's structured-clone boundary (postMessage, NOT JSON), so the submitter
 * and worker need no changes.
 *
 * Two encodings are supported, tag-wins-then-introspect:
 *   - Tagged (always honored, no metadata needed):
 *       { "$bytes": "<hex>" }  → Uint8Array
 *       { "$uint":  "<dec>" | 123 } → BigInt
 *   - Untagged + introspected: the circuit's declared param types are read from
 *     the compiled artifact's `contract-info.json`; a hex string / number[] is
 *     coerced to Bytes<N> (exact-length checked), a number / decimal-string to
 *     BigInt for Uint<N>. A param of an unhandled Compact type (Vector, struct,
 *     Field, …) passes through unchanged.
 *   - Untagged + no metadata for the argument: rejected with a clear 400. We
 *     do NOT silently pass it through — that would reproduce the deep
 *     circuit-type failure this layer exists to prevent. The caller fixes it by
 *     tagging the value or correcting the registered artifact path.
 */

import fs from 'fs';
import path from 'path';

/** A single circuit parameter's type, distilled from contract-info.json. */
export interface CircuitArgType {
    name: string;
    kind: 'Bytes' | 'Uint' | 'Boolean' | 'other';
    /** Byte length for Bytes<N>. */
    length?: number;
    /** Upper bound for Uint<N> (omitted when the compiler's value exceeds JS safe-integer range). */
    maxval?: number;
}

/**
 * Bad-input error for a single argument. Carries the arg index so the handler
 * can surface a clear 400 ("args[1]: …") rather than letting a value reach the
 * circuit and fail deep inside the compiled runtime's type guard.
 */
export class CoercionError extends Error {
    constructor(public readonly index: number, reason: string) {
        super(`args[${index}]: ${reason}`);
        this.name = 'CoercionError';
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
    // Only enforce the upper bound when the compiler's maxval is within JS
    // safe-integer range — for u64 etc. the value loses precision through
    // JSON.parse, so a check there would be unreliable. Lower bound is enough
    // to catch the common mistakes; the circuit enforces the true bound.
    if (maxval !== undefined && maxval <= Number.MAX_SAFE_INTEGER && v > BigInt(maxval)) {
        throw new CoercionError(index, `Uint value ${v} exceeds maximum ${maxval}`);
    }
    return v;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Uint8Array);
}

/** Coerce one argument. Tag wins; otherwise the declared circuit type drives it; with no type info, reject. */
function coerceOne(raw: unknown, argType: CircuitArgType | undefined, index: number): unknown {
    // 1. Tagged values — honored regardless of whether we have circuit metadata.
    if (isPlainObject(raw)) {
        if (Object.prototype.hasOwnProperty.call(raw, '$bytes')) {
            const hex = raw['$bytes'];
            if (typeof hex !== 'string') throw new CoercionError(index, '$bytes must be a hex string');
            return decodeHex(hex, index, argType?.kind === 'Bytes' ? argType.length : undefined);
        }
        if (Object.prototype.hasOwnProperty.call(raw, '$uint')) {
            return toBigInt(raw['$uint'], index, argType?.kind === 'Uint' ? argType.maxval : undefined);
        }
    }

    // 2. Introspected coercion from the circuit's declared parameter type.
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
            default:
                return raw;
        }
    }

    // 3. No declared type for this argument AND no tag. We can't validate it,
    // so rather than silently passing it through (which reproduces the very
    // deep-circuit-failure this layer exists to prevent), reject with an
    // actionable 400. The two escape hatches are listed in the message: tag the
    // value, or fix the registered contract so contract-info.json is found.
    // Empty arg lists never reach here (no elements to coerce).
    throw new CoercionError(
        index,
        'could not determine the circuit parameter type (the contract\'s ' +
        'contract-info.json was not found — check the registered artifact path). ' +
        'Pass a tagged value instead: {"$bytes":"<hex>"} or {"$uint":<n>}.'
    );
}

/**
 * Coerce a parsed `args` array against the circuit's declared parameter types.
 * `argTypes` may be undefined (no introspection) — tagged values still work and
 * everything else passes through unchanged.
 */
export function coerceCircuitArgs(rawArgs: unknown[], argTypes?: CircuitArgType[]): unknown[] {
    return rawArgs.map((raw, i) => coerceOne(raw, argTypes?.[i], i));
}

// ---- contract-info.json introspection -------------------------------------

interface RawArgTypeNode {
    'type-name'?: string;
    length?: number;
    maxval?: number;
}
interface RawCircuit {
    name?: string;
    arguments?: Array<{ name?: string; type?: RawArgTypeNode }>;
}

function mapArgType(node: RawArgTypeNode | undefined, name: string): CircuitArgType {
    const tn = node?.['type-name'];
    if (tn === 'Bytes') return { name, kind: 'Bytes', length: node?.length };
    if (tn === 'Uint') return { name, kind: 'Uint', maxval: node?.maxval };
    if (tn === 'Boolean') return { name, kind: 'Boolean' };
    return { name, kind: 'other' };
}

// Cache parsed circuit-arg maps per artifact directory — contract-info.json is
// immutable for a compiled artifact, so parse it once per zkConfigPath.
const argTypeCache = new Map<string, Map<string, CircuitArgType[]> | null>();

function loadContractInfo(zkConfigPath: string): Map<string, CircuitArgType[]> | null {
    if (argTypeCache.has(zkConfigPath)) return argTypeCache.get(zkConfigPath)!;
    const infoPath = path.join(zkConfigPath, 'compiler', 'contract-info.json');
    let parsed: { circuits?: RawCircuit[] };
    try {
        parsed = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
    } catch {
        // Missing/unreadable contract-info.json → no introspection available.
        // Tagged values still work; untagged args pass through (back-compat).
        argTypeCache.set(zkConfigPath, null);
        return null;
    }
    const byCircuit = new Map<string, CircuitArgType[]>();
    for (const c of parsed.circuits ?? []) {
        if (!c.name) continue;
        byCircuit.set(c.name, (c.arguments ?? []).map((a) => mapArgType(a.type, a.name ?? '')));
    }
    argTypeCache.set(zkConfigPath, byCircuit);
    return byCircuit;
}

/**
 * Resolve the declared parameter types for `circuit` from the compiled
 * artifact at `zkConfigPath` (reads `<zkConfigPath>/compiler/contract-info.json`).
 * Returns undefined when the metadata or the circuit entry is unavailable —
 * coercion then falls back to tagged-values-only / passthrough.
 */
export function loadCircuitArgTypes(zkConfigPath: string, circuit: string): CircuitArgType[] | undefined {
    const byCircuit = loadContractInfo(zkConfigPath);
    return byCircuit?.get(circuit);
}

/** Test-only: clear the contract-info parse cache. */
export function clearArgTypeCache(): void {
    argTypeCache.clear();
}
