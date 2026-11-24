/**
 * A chain that was started again under its name: the index is compared with the node's finalized chain,
 * and an adoption rolls it back to the last block both have and drops the saved wallet states.
 * Runs against the real in-memory database.
 */

import cds from '@sap/cds';
import { adoptNodeChain, __resetReindexForTests, type FinalizedChain } from '../../srv/crawler/reindex';

cds.test(__dirname + '/../..');

const BLOCKS = 'midnight.Blocks';
const SYNC_STATE = 'midnight.SyncState';
const WALLET_STATES = 'midnight.WalletSyncStates';

/** The hash of block `height` on the chain named by one hex letter. */
const hashOn = (chain: string, height: number): string => chain.repeat(48) + height.toString(16).padStart(16, '0');
/** A chain that equals chain `a` up to `fork` and is chain `b` above it. */
const forkedAt = (fork: number) => (height: number): string => hashOn(height <= fork ? 'a' : 'b', height);

describe('adopting the chain of the node', () => {
    let db: any;
    const { INSERT, SELECT, DELETE } = cds.ql;

    beforeAll(async () => { db = await cds.connect.to('db'); });

    beforeEach(async () => {
        __resetReindexForTests();
        for (const table of [BLOCKS, SYNC_STATE, WALLET_STATES]) await db.run(DELETE.from(table));
    });

    /** Stores blocks `from` to `to` of chain `a` and two wallet states. */
    async function seedIndex(from: number, to: number): Promise<void> {
        const rows = [];
        for (let height = from; height <= to; height++) {
            rows.push({ ID: cds.utils.uuid(), hash: hashOn('a', height), height, protocolVersion: 1, timestamp: 1_700_000_000 + height, stateRoot: 'abcd' });
        }
        await db.run(INSERT.into(BLOCKS).entries(rows));
        await db.run(INSERT.into(SYNC_STATE).entries({ ID: 'SINGLETON', syncStatus: 'error', lastIndexedHeight: to, lastIndexedHash: hashOn('a', to), lastError: 'another chain' }));
        const now = new Date().toISOString();
        await db.run(INSERT.into(WALLET_STATES).entries(['w1', 'w2'].map(accountId => ({ accountId, sdkVersion: 'wallet-sdk-facade@test', createdAt: now, updatedAt: now }))));
    }

    /** A node whose finalized head is `height`, with block hashes from `chain`. */
    function nodeOn(chain: (height: number) => string, height: number): FinalizedChain & { asked: number[] } {
        const asked: number[] = [];
        return {
            asked,
            head: async () => ({ height, hash: `0x${chain(height)}` }),
            hashAt: async (at: number) => { asked.push(at); return at <= height ? `0x${chain(at)}` : null; }
        };
    }
    const heights = async (): Promise<number[]> => (await db.run(SELECT.from(BLOCKS).columns('height').orderBy('height asc'))).map((b: { height: number }) => Number(b.height));
    const walletStates = async (): Promise<number> => (await db.run(SELECT.from(WALLET_STATES).columns('accountId'))).length;
    const syncState = async () => db.run(SELECT.one.from(SYNC_STATE).where({ ID: 'SINGLETON' }));
    const sameChain = (height: number) => hashOn('a', height);

    it.each([
        ['level with the index', 60, 'same'],
        ['ahead of the index', 90, 'same'],
        ['behind the index', 40, 'node-behind'],
        ['below the lowest stored block', 0, 'node-behind']
    ])('a node on the same chain, %s: nothing differs and nothing is touched', async (_name, nodeHeight, verdict) => {
        await seedIndex(1, 60);
        const report = await adoptNodeChain(db, nodeOn(sameChain, nodeHeight), { apply: true });

        expect(report).toMatchObject({ verdict, applied: false, blocksAbove: 0, indexedHeight: 60, nodeHeight });
        expect(await heights()).toHaveLength(60);
        expect(await walletStates()).toBe(2);
    });

    it('an empty index has nothing to compare', async () => {
        const report = await adoptNodeChain(db, nodeOn(sameChain, 10), { apply: true });
        expect(report).toMatchObject({ verdict: 'same', applied: false, indexedHeight: null });
    });

    it.each([
        ['a longer chain', 90],
        ['a shorter chain', 45]
    ])('a chain started again from block 29, %s: the preview names block 28 and changes nothing', async (_name, nodeHeight) => {
        await seedIndex(1, 60);
        const report = await adoptNodeChain(db, nodeOn(forkedAt(28), nodeHeight), { apply: false });

        expect(report).toEqual({ indexedHeight: 60, nodeHeight, lastCommonHeight: 28, blocksAbove: 32, walletStates: 2, verdict: 'other-chain', applied: false });
        expect(await heights()).toHaveLength(60);
        expect(await walletStates()).toBe(2);
        expect(Number((await syncState()).lastIndexedHeight)).toBe(60);
    });

    it('applied: the index ends at the last common block and the wallet states are gone', async () => {
        await seedIndex(1, 60);
        const report = await adoptNodeChain(db, nodeOn(forkedAt(28), 45), { apply: true, sliceBlocks: 10 });

        expect(report).toMatchObject({ verdict: 'other-chain', lastCommonHeight: 28, blocksAbove: 32, applied: true });
        expect(await heights()).toEqual(Array.from({ length: 28 }, (_, i) => i + 1));
        expect(await walletStates()).toBe(0);
        const state = await syncState();
        expect(Number(state.lastIndexedHeight)).toBe(28);
        expect(state.lastIndexedHash).toBe(hashOn('a', 28));
        expect(state).toMatchObject({ reindexTargetHeight: null, lastError: null, syncStatus: 'stopped' });
    });

    it('a second run after an adoption finds the same chain', async () => {
        await seedIndex(1, 60);
        await adoptNodeChain(db, nodeOn(forkedAt(28), 45), { apply: true });
        const again = await adoptNodeChain(db, nodeOn(forkedAt(28), 45), { apply: true });
        expect(again).toMatchObject({ verdict: 'same', applied: false, lastCommonHeight: 28, indexedHeight: 28 });
    });

    it('no stored block is on the node\'s chain: the whole index goes', async () => {
        await seedIndex(1, 20);
        const other = (height: number) => hashOn('c', height);
        const preview = await adoptNodeChain(db, nodeOn(other, 50), { apply: false });
        expect(preview).toMatchObject({ verdict: 'other-chain', lastCommonHeight: null, blocksAbove: 20, applied: false });

        const report = await adoptNodeChain(db, nodeOn(other, 50), { apply: true });
        expect(report.applied).toBe(true);
        expect(await heights()).toEqual([]);
        expect(await walletStates()).toBe(0);
    });

    it('an index that starts above block 1 is compared from its lowest block', async () => {
        await seedIndex(500, 560);
        const report = await adoptNodeChain(db, nodeOn(forkedAt(540), 900), { apply: true });
        expect(report).toMatchObject({ lastCommonHeight: 540, blocksAbove: 20, applied: true });
        expect((await heights()).at(-1)).toBe(540);
    });

    it('finds the fork with a handful of questions to the node', async () => {
        await seedIndex(1, 1000);
        const node = nodeOn(forkedAt(613), 2000);
        const report = await adoptNodeChain(db, node, { apply: false });

        expect(report).toMatchObject({ lastCommonHeight: 613, blocksAbove: 387 });
        expect(node.asked.length).toBeLessThanOrEqual(12);
        expect(Math.max(...node.asked)).toBeLessThanOrEqual(1000);
    });

    it('a block the node does not answer for stops the run before anything changes', async () => {
        await seedIndex(1, 60);
        const node = nodeOn(forkedAt(28), 90);
        const silent: FinalizedChain = { head: node.head, hashAt: async (at: number) => (at === 60 ? `0x${hashOn('b', 60)}` : null) };

        await expect(adoptNodeChain(db, silent, { apply: true })).rejects.toThrow(/block 1 cannot be compared: the node does not answer for it/);
        expect(await heights()).toHaveLength(60);
        expect(await walletStates()).toBe(2);
    });
});
