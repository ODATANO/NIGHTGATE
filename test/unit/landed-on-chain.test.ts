import { describe, expect, it, vi } from 'vitest';
import { landedOnChain } from '../../srv/submission/actions/common';

const H = 'dec5e7acaa8c9c088481c6d3a15a4701ac4761f3068536173d34175e557b2784';

function fakeDb(tx: unknown, result: unknown) {
    const queries: unknown[] = [];
    const run = vi.fn(async (q: unknown) => { queries.push(q); return queries.length === 1 ? tx : result; });
    return { db: { run }, queries };
}

describe('landedOnChain', () => {
    it('finds the transaction by the ledger hash or the 0x extrinsic hash', async () => {
        const { db, queries } = fakeDb({ ID: 't1' }, { status: 'SUCCESS', outcomeSource: 'substrate-system-events' });
        expect(await landedOnChain(db, '0x' + H.toUpperCase())).toBe(true);
        const where = JSON.stringify((queries[0] as { SELECT: { where: unknown } }).SELECT.where);
        expect(where).toContain('"ledgerTxHash"');
        expect(where).toContain(`"${H}"`);
        expect(where).toContain(`"0x${H}"`);
    });

    it('is false without a hash, without a row, or without a success from system events', async () => {
        expect(await landedOnChain(fakeDb(undefined, undefined).db, null)).toBe(false);
        expect(await landedOnChain(fakeDb(undefined, undefined).db, H)).toBe(false);
        expect(await landedOnChain(fakeDb({ ID: 't1' }, { status: 'FAILURE', outcomeSource: 'substrate-system-events' }).db, H)).toBe(false);
        expect(await landedOnChain(fakeDb({ ID: 't1' }, { status: 'SUCCESS', outcomeSource: null }).db, H)).toBe(false);
    });
});
