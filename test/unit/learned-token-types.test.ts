/**
 * Platform-wide learned token types: the table behind `shareMintedTokenTypes`,
 * read through a cache that the policy resolution consults synchronously.
 */
const dbRun = vi.hoisted(() => vi.fn());
const selectChain = vi.hoisted(() => {
    const chain: any = {};
    chain.columns = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    return chain;
});
const insertEntries = vi.hoisted(() => vi.fn((rows: unknown) => ({ rows })));
const logs = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));

vi.mock('@sap/cds', () => {
    const cds: any = {
        db: null,
        ql: {
            SELECT: { from: vi.fn(() => selectChain) },
            INSERT: { into: vi.fn(() => ({ entries: insertEntries })) }
        },
        log: vi.fn(() => logs)
    };
    cds.default = cds;
    return cds;
});
vi.mock('../../srv/submission/background-jobs', () => ({
    runWithoutAmbientTx: (fn: () => Promise<unknown>) => fn()
}));

import cds from '@sap/cds';
import {
    normalizeTokenTypes, recordLearnedTokenTypes, refreshLearnedTokenTypes, sharedLearnedTokenTypes, __resetLearnedTokenTypesForTests
} from '../../srv/submission/learned-token-types';

const T1 = 'ab'.repeat(32);
const T2 = 'cd'.repeat(32);
const db = { run: dbRun };

beforeEach(() => {
    __resetLearnedTokenTypesForTests();
    dbRun.mockReset();
    insertEntries.mockClear();
    selectChain.where.mockClear();
    (cds as any).db = null;
});

describe('normalizeTokenTypes', () => {
    it('keeps raw 64-hex types, lower-cased and de-duplicated', () => {
        expect(normalizeTokenTypes([T1, ' ' + T1.toUpperCase(), 'nope', '', null, T2])).toEqual([T1, T2]);
    });
});

describe('recordLearnedTokenTypes', () => {
    it('inserts only the types the platform has not seen, with their origin', async () => {
        dbRun.mockResolvedValueOnce([{ tokenType: T1 }]).mockResolvedValueOnce(undefined);
        const added = await recordLearnedTokenTypes(db, [T1, T2], { grantId: 'g1', sponsorSessionId: 's1', txHash: 'h1' });
        expect(added).toEqual([T2]);
        expect(selectChain.where).toHaveBeenCalledWith({ tokenType: [T1, T2] });
        expect(insertEntries).toHaveBeenCalledWith([{ tokenType: T2, grantId: 'g1', sponsorSessionId: 's1', txHash: 'h1' }]);
    });

    it('writes nothing for known or malformed types and never throws', async () => {
        dbRun.mockResolvedValueOnce([{ tokenType: T1 }]);
        expect(await recordLearnedTokenTypes(db, [T1, 'bad'])).toEqual([]);
        expect(insertEntries).not.toHaveBeenCalled();
        expect(await recordLearnedTokenTypes(db, [])).toEqual([]);
        dbRun.mockRejectedValueOnce(new Error('db gone'));
        expect(await recordLearnedTokenTypes(db, [T2])).toEqual([]);
        expect(logs.error).toHaveBeenCalled();
    });

    it('extends a loaded cache at once', async () => {
        __resetLearnedTokenTypesForTests([T1]);
        dbRun.mockResolvedValueOnce([]).mockResolvedValueOnce(undefined);
        await recordLearnedTokenTypes(db, [T2]);
        expect(sharedLearnedTokenTypes()).toEqual([T1, T2]);
    });
});

describe('sharedLearnedTokenTypes', () => {
    it('is empty before the first refresh and reads the table on refresh', async () => {
        expect(sharedLearnedTokenTypes()).toEqual([]);
        dbRun.mockResolvedValueOnce([{ tokenType: T2 }, { tokenType: 'junk' }, { tokenType: T1 }]);
        expect(await refreshLearnedTokenTypes(db)).toEqual([T2, T1]);
        expect(sharedLearnedTokenTypes()).toEqual([T2, T1]);
    });

    it('refreshes a stale cache in the background through cds.db and keeps answering meanwhile', async () => {
        vi.useFakeTimers();
        try {
            __resetLearnedTokenTypesForTests([T1]);
            (cds as any).db = db;
            vi.advanceTimersByTime(31_000);
            dbRun.mockResolvedValueOnce([{ tokenType: T1 }, { tokenType: T2 }]);
            expect(sharedLearnedTokenTypes()).toEqual([T1]);
            expect(dbRun).toHaveBeenCalledTimes(1);
            await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
            expect(sharedLearnedTokenTypes()).toEqual([T1, T2]);
            // fresh again: no second read
            expect(dbRun).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it('a failed background refresh is logged and the old answer stays', async () => {
        vi.useFakeTimers();
        try {
            __resetLearnedTokenTypesForTests([T1]);
            (cds as any).db = db;
            vi.advanceTimersByTime(31_000);
            dbRun.mockRejectedValueOnce(new Error('pool exhausted'));
            expect(sharedLearnedTokenTypes()).toEqual([T1]);
            await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
            expect(sharedLearnedTokenTypes()).toEqual([T1]);
            expect(logs.warn).toHaveBeenCalledWith(expect.stringMatching(/pool exhausted/));
        } finally {
            vi.useRealTimers();
        }
    });
});
