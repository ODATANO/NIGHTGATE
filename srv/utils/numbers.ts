// SPDX-License-Identifier: Apache-2.0

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
