import { describe, expect, it, vi } from 'vitest';
import { landedOnChain } from '../../srv/submission/actions/common';

const H = 'dec5e7acaa8c9c088481c6d3a15a4701ac4761f3068536173d34175e557b2784';

function fakeDb(tx: unknown, result: unknown) {
    const queries: unknown[] = [];
    const run = vi.fn(async (q: unknown) => { queries.push(q); return queries.length === 1 ? tx : result; });
    return { db: { run }, queries };
}

describe('landedOnChain', () => {
    it('finds the transaction by the ledger hash or the extrinsic hash, in the stored spelling', async () => {
        const { db, queries } = fakeDb({ ID: 't1' }, { status: 'SUCCESS', outcomeSource: 'substrate-system-events' });
        expect(await landedOnChain(db, '0x' + H.toUpperCase())).toBe(true);
        const where = JSON.stringify((queries[0] as { SELECT: { where: unknown } }).SELECT.where);
        expect(where).toContain('"txHash"');
        expect(where).toContain('"extrinsicHash"');
        expect(where).toContain(`"${H}"`);
        expect(where).not.toContain('0x');
    });

    it('finds the transaction by one of its identifiers when no hash matches', async () => {
        const answers: unknown[] = [undefined, { transaction_ID: 't7' }, { status: 'SUCCESS', outcomeSource: 'substrate-system-events' }];
        const queries: Array<{ SELECT: { from: { ref: string[] }; where: unknown } }> = [];
        const db = { run: vi.fn(async (q: unknown) => { queries.push(q as typeof queries[number]); return answers[queries.length - 1]; }) };
        expect(await landedOnChain(db, H)).toBe(true);
        expect(queries[1].SELECT.from.ref[0]).toMatch(/TransactionIdentifiers$/);
        expect(JSON.stringify(queries[1].SELECT.where)).toContain(`"${H}"`);
        expect(JSON.stringify(queries[2].SELECT.where)).toContain('"t7"');
    });

    it('is false without a hash, without a row, or without a success from system events', async () => {
        expect(await landedOnChain(fakeDb(undefined, undefined).db, null)).toBe(false);
        expect(await landedOnChain(fakeDb(undefined, undefined).db, H)).toBe(false);
        expect(await landedOnChain(fakeDb({ ID: 't1' }, { status: 'FAILURE', outcomeSource: 'substrate-system-events' }).db, H)).toBe(false);
        expect(await landedOnChain(fakeDb({ ID: 't1' }, { status: 'SUCCESS', outcomeSource: null }).db, H)).toBe(false);
    });
});
