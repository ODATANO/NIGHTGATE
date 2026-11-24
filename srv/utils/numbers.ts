// SPDX-License-Identifier: Apache-2.0
import type cds from '@sap/cds';

/** The largest amount a token can have on chain. */
export const UINT128_MAX = 2n ** 128n - 1n;

/** An integer from a bigint, number or digit string; 0n for anything else. Separators from `toHuman()` are ignored. */
export function toBigInt(value: unknown): bigint {
    if (typeof value === 'bigint') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? BigInt(Math.trunc(value)) : 0n;
    const text = String(value ?? '').replace(/[,_\s]/g, '');
    return /^-?\d+$/.test(text) ? BigInt(text) : 0n;
}

/** Like `toBigInt` as a number; 0 when the value is outside the safe integer range. */
export function toInt(value: unknown): number {
    const big = toBigInt(value);
    return big <= BigInt(Number.MAX_SAFE_INTEGER) && big >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(big) : 0;
}

/** An Integer64 value as CAP stores it. cds-typer types it as number, but a decimal string keeps 64-bit precision. */
export function int64Value(value: string | number | null | undefined): number | null {
    return (value ?? null) as unknown as number | null;
}

/** The parts of a linked model definition the result walk reads. */
interface ResultField { type?: string; elements?: Record<string, ResultField>; items?: ResultField }
interface ResultOperation { returns?: ResultField }

/** `value` with every 64-bit integer as decimal text. Objects and lists change in place. */
export function int64ResultAsText(value: unknown, field: ResultField | undefined): unknown {
    if (!field || value === null || value === undefined) return value;
    if (Array.isArray(value)) {
        const items = field.items ?? field;
        value.forEach((entry, i) => { value[i] = int64ResultAsText(entry, items); });
        return value;
    }
    if (typeof value === 'object') {
        for (const [name, element] of Object.entries(field.elements ?? {})) {
            const row = value as Record<string, unknown>;
            if (row[name] !== undefined && row[name] !== null) row[name] = int64ResultAsText(row[name], element);
        }
        return value;
    }
    const integer = typeof value === 'bigint' || (typeof value === 'number' && Number.isFinite(value));
    return field.type === 'cds.Integer64' && integer ? String(value) : value;
}

/** Makes the actions and functions of a service answer 64-bit integers as text. An entity read gets that form from the database layer. */
export function attachInt64Results(srv: cds.ApplicationService): void {
    srv.after('*', (result, req) => {
        const bound = (req.target as { actions?: Record<string, ResultOperation> } | undefined)?.actions;
        const operation = (bound ?? srv.actions as unknown as Record<string, ResultOperation> | undefined)?.[req.event];
        // A bare number has no object to change in place, so the converted value replaces the answer.
        if (operation?.returns) req.results = int64ResultAsText(result, operation.returns) as typeof req.results;
    });
}
