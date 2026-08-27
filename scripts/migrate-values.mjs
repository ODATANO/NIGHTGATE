// Value conversion for nightgate-db-migrate (SQLite row -> CAP insert).
// Integers are read with better-sqlite3's safeIntegers, so they arrive as
// BigInt: exact for Integer64, converted for the small types.
//
// Decimal: CAP's SQLite column is `DECIMAL` (NUMERIC affinity; `REAL_DECIMAL`
// only with `decimal_affinity: real`). SQLite keeps an integral value as a
// 64-bit INTEGER (exact, arrives as BigInt) and anything else as an IEEE-754
// REAL (15-17 significant digits, arrives as a number). A REAL whose
// magnitude is 2^53 or more was rounded when SQLite stored it; nothing can
// recover the digits, so the run aborts instead of copying a wrong number.
// Double keeps SQLite's representation. A large value never goes through
// Number().
//
// SPDX-License-Identifier: Apache-2.0
const SMALL_INTS = new Set(['cds.Integer', 'cds.Int32', 'cds.Int16', 'cds.UInt8']);
const BIG_INTS = new Set(['cds.Integer64', 'cds.Int64']);
const MAX_EXACT_REAL = 2 ** 53;

export function convertValue(el, v, column = '?') {
    if (v === null || v === undefined) return null;
    const type = el?.type;
    if (type === 'cds.Boolean') return v === 1n || v === 1 || v === true || v === '1' || v === 'true';
    if (SMALL_INTS.has(type)) {
        const n = typeof v === 'bigint' ? Number(v) : typeof v === 'string' && v !== '' ? Number(v) : v;
        if (typeof n === 'number' && !Number.isSafeInteger(n)) throw new Error(`${column}: ${String(v)} is not a safe integer for ${type}`);
        return n;
    }
    if (BIG_INTS.has(type)) {
        if (typeof v === 'number' && !Number.isSafeInteger(v)) throw new Error(`${column}: ${v} lost precision before conversion (${type}); read the source with safeIntegers`);
        return typeof v === 'bigint' || typeof v === 'number' ? String(v) : v;
    }
    if (type === 'cds.Decimal') {
        if (typeof v === 'bigint') return String(v);
        if (typeof v === 'number' && (!Number.isFinite(v) || Math.abs(v) >= MAX_EXACT_REAL)) {
            throw new Error(`${column}: SQLite holds ${v} as a REAL beyond 2^53; the digits were rounded at write time and cannot be migrated exactly (${type})`);
        }
        return v;
    }
    if (type === 'cds.Double') return typeof v === 'bigint' ? Number(v) : v;
    if (typeof v === 'bigint') return String(v);
    return v;
}

export function convertRow(def, row) {
    const out = {};
    for (const [k, v] of Object.entries(row)) {
        const el = def.elements?.[k];
        if (!el) continue; // column unknown to the model (dropped since) is not migrated
        out[k] = convertValue(el, v, `${def.name}.${k}`);
    }
    return out;
}
