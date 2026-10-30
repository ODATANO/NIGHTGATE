import { describe, expect, it } from 'vitest';
import { toBigInt, toInt } from '../../srv/utils/numbers';

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
