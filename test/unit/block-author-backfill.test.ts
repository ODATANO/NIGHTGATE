/**
 * Tests for srv/crawler/BlockAuthorBackfill.ts: a REAL in-memory CAP DB via
 * cds.test(), the node replaced by the headers of test/fixtures/aura-headers.json.
 */

import cds from '@sap/cds';
import { TypeRegistry } from '@polkadot/types/create';
import fixture from '../fixtures/aura-headers.json';
import { BlockAuthorBackfill } from '../../srv/crawler/BlockAuthorBackfill';

cds.test(__dirname + '/../..');

const BLOCKS = 'midnight.Blocks';
const SYNC_STATE = 'midnight.SyncState';
const [plain, change, afterChange] = fixture.blocks;
const CONFIG = { batchSize: 2, intervalMs: 1, retryMs: 1 };

let db: any;

/** The value the crawler stored before it resolved validators: the engine id and the slot bytes. */
function slotAsAuthor(slot: number): string {
    const bytes = Buffer.alloc(8);
    bytes.writeBigUInt64LE(BigInt(slot));
    return `aura:0x20${bytes.toString('hex')}`;
}

async function seedBlock(block: { hash: string; height: number }, fields: Record<string, unknown>): Promise<void> {
    await db.run(cds.ql.INSERT.into(BLOCKS).entries({
        ID: cds.utils.uuid(), hash: block.hash, height: block.height, protocolVersion: 1, timestamp: 1_700_000_000, ...fields
    }));
}

async function setSync(fields: Record<string, unknown> = {}): Promise<void> {
    await db.run(cds.ql.DELETE.from(SYNC_STATE));
    await db.run(cds.ql.INSERT.into(SYNC_STATE).entries({ ID: 'SINGLETON', syncStatus: 'syncing', ...fields }));
}

const readSync = (): Promise<any> => db.run(cds.ql.SELECT.one.from(SYNC_STATE).where({ ID: 'SINGLETON' }));

async function readBlock(hash: string): Promise<{ author: string | null; slot: number | null }> {
    const row = await db.run(cds.ql.SELECT.one.from(BLOCKS).columns('author', 'slot').where({ hash }));
    return { author: row.author, slot: row.slot == null ? null : Number(row.slot) };
}

/** A node that serves the fixture's headers and authority lists. */
function fixtureNode() {
    const headers = new Map(fixture.blocks.map(b => [b.hash, b.header]));
    const lists = new Map(fixture.blocks.map(b => [
        b.header.parentHash, new TypeRegistry().createType('Vec<H256>', b.parentAuthorities).toHex()
    ]));
    return {
        rpcBatch: vi.fn(async (requests: Array<{ method: string; params?: unknown[] }>) =>
            requests.map(r => headers.get(String(r.params?.[0])) ?? null)),
        getStorage: vi.fn(async (_key: string, at?: string) => lists.get(at ?? '') ?? null)
    };
}

async function backfillWith(node: ReturnType<typeof fixtureNode>): Promise<BlockAuthorBackfill> {
    const backfill = new BlockAuthorBackfill(node, CONFIG);
    await backfill.init(db);
    return backfill;
}

beforeAll(async () => {
    db = await cds.connect.to('db');
});

beforeEach(async () => {
    await db.run(cds.ql.DELETE.from(BLOCKS));
});

describe('BlockAuthorBackfill', () => {
    it('rewrites blocks that hold the slot in author, batch by batch, then marks the end', async () => {
        await setSync();
        for (const block of fixture.blocks) await seedBlock(block, { author: slotAsAuthor(block.slot) });
        const node = fixtureNode();
        const backfill = await backfillWith(node);

        expect(await backfill.runOnce()).toBe(2);
        expect(await readBlock(plain.hash)).toEqual({ author: plain.author, slot: plain.slot });
        expect(await readBlock(change.hash)).toEqual({ author: change.author, slot: change.slot });
        expect((await readBlock(afterChange.hash)).slot).toBeNull();
        expect(Number((await readSync()).authorBackfillHeight)).toBe(change.height);
        expect((await readSync()).authorsBackfilledAt).toBeNull();

        expect(await backfill.runOnce()).toBe(1);
        expect(await readBlock(afterChange.hash)).toEqual({ author: afterChange.author, slot: afterChange.slot });
        // The list for this block came from the header of the block before it.
        expect(node.getStorage).toHaveBeenCalledTimes(2);

        expect(await backfill.runOnce()).toBe('done');
        expect((await readSync()).authorsBackfilledAt).toBeTruthy();
        expect(await backfill.runOnce()).toBe('done');
        expect(node.rpcBatch).toHaveBeenCalledTimes(2);
    });

    it('resumes above the cursor and reads the authority list again', async () => {
        await setSync({ authorBackfillHeight: change.height });
        await seedBlock(change, { author: slotAsAuthor(change.slot) });
        await seedBlock(afterChange, { author: slotAsAuthor(afterChange.slot) });
        const node = fixtureNode();
        const backfill = await backfillWith(node);

        expect(await backfill.runOnce()).toBe(1);
        expect(await readBlock(afterChange.hash)).toEqual({ author: afterChange.author, slot: afterChange.slot });
        expect((await readBlock(change.hash)).author).toBe(slotAsAuthor(change.slot));
        expect(node.getStorage).toHaveBeenCalledExactlyOnceWith(expect.any(String), afterChange.header.parentHash);
    });

    it('passes over blocks that already carry their slot without asking the node', async () => {
        await setSync();
        await seedBlock(plain, { author: plain.author, slot: plain.slot });
        const node = fixtureNode();
        const backfill = await backfillWith(node);

        expect(await backfill.runOnce()).toBe(0);
        expect(node.rpcBatch).not.toHaveBeenCalled();
        expect(Number((await readSync()).authorBackfillHeight)).toBe(plain.height);
    });

    it('is done at once on a database without blocks', async () => {
        await setSync();
        const backfill = await backfillWith(fixtureNode());
        expect(await backfill.runOnce()).toBe('done');
        expect((await readSync()).authorsBackfilledAt).toBeTruthy();
    });

    it('leaves the batch and the cursor untouched when a header is missing', async () => {
        await setSync();
        await seedBlock(plain, { author: slotAsAuthor(plain.slot) });
        await seedBlock({ hash: '0xunknown', height: plain.height + 1 }, { author: slotAsAuthor(1) });
        const backfill = await backfillWith(fixtureNode());

        await expect(backfill.runOnce()).rejects.toThrow(/No header for block 0xunknown/);
        expect((await readBlock(plain.hash)).author).toBe(slotAsAuthor(plain.slot));
        expect((await readSync()).authorBackfillHeight).toBeNull();
    });

    it('the loop runs to the end, keeps going after a failed pass and stops itself', async () => {
        await setSync();
        for (const block of fixture.blocks) await seedBlock(block, { author: slotAsAuthor(block.slot) });
        const node = fixtureNode();
        node.rpcBatch.mockRejectedValueOnce(new Error('Not connected to Midnight Node'));
        const warn = vi.spyOn(cds.log('nightgate:crawler'), 'warn').mockImplementation(() => {});
        try {
            const backfill = await backfillWith(node);
            backfill.start();
            await vi.waitFor(async () => expect((await readSync()).authorsBackfilledAt).toBeTruthy(), { timeout: 5000 });
            await backfill.stop();
            expect(warn).toHaveBeenCalledWith(expect.stringContaining('block author backfill pass failed: Not connected'));
            expect(await readBlock(afterChange.hash)).toEqual({ author: afterChange.author, slot: afterChange.slot });
        } finally {
            warn.mockRestore();
        }
    });
});
