/**
 * Tests for the parallel catch-up FETCH pipeline of srv/crawler/BlockProcessor.ts:
 * fetchBlockData / fetchBlockBatch (batched RPC, DB dedupe, response
 * de-interleaving, per-batch protocol version) plus the small parsing helpers
 * (parseTimestampHex, toInt, toBigInt). The persist side is covered by
 * block-processor-persistence.test.ts; this file only exercises the read path,
 * against the real in-memory CAP DB (the batch dedupe is a real bulk SELECT).
 */

import cds from '@sap/cds';
import { BlockProcessor, type PreparedBlockFetched } from '../../srv/crawler/BlockProcessor';

/** Narrow the PreparedBlock union to the fetched variant (assert + type). */
function asFetched(b: { alreadyIndexed: boolean }): PreparedBlockFetched {
    expect(b.alreadyIndexed).toBe(false);
    return b as PreparedBlockFetched;
}

// Boot the in-memory CAP server for a real `db` connection.
cds.test(__dirname + '/../..');

const BLOCKS = 'midnight.Blocks';

/** Little-endian u64 hex as substrate's timestamp storage returns it (ms). */
function timestampHex(ms: bigint): string {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64LE(ms);
    return '0x' + buf.toString('hex');
}

function fakeProvider() {
    return {
        getBlockHash: vi.fn(),
        getBlock: vi.fn(),
        getStorage: vi.fn(),
        getRuntimeVersion: vi.fn(async () => ({ specVersion: 7 })),
        rpcBatch: vi.fn()
    };
}

let db: any;

beforeAll(async () => {
    db = await cds.connect.to('db');
});

async function seedBlock(height: number, hash: string): Promise<void> {
    await db.run(cds.ql.INSERT.into(BLOCKS).entries({
        ID: cds.utils.uuid(),
        hash,
        height,
        protocolVersion: 1,
        timestamp: 1700000000 + height,
        ledgerParameters: '0xabcd'
    }));
}

async function makeProcessor(provider: any): Promise<BlockProcessor> {
    const p = new BlockProcessor(provider);
    await p.init();
    return p;
}

beforeEach(async () => {
    await db.run(cds.ql.DELETE.from(BLOCKS));
});

describe('fetchBlockData', () => {
    it('throws when the node has no block at the height', async () => {
        const provider = fakeProvider();
        provider.getBlockHash.mockResolvedValue(null);
        const p = await makeProcessor(provider);
        await expect(p.fetchBlockData(123)).rejects.toThrow('No block at height 123');
    });

    it('short-circuits with alreadyIndexed for a hash that is already persisted', async () => {
        const provider = fakeProvider();
        provider.getBlockHash.mockResolvedValue('0xseen');
        await seedBlock(5, '0xseen');
        const p = await makeProcessor(provider);

        const prep = await p.fetchBlockData(5);
        expect(prep).toMatchObject({ blockHash: '0xseen', height: 5, alreadyIndexed: true });
        expect(provider.getBlock).not.toHaveBeenCalled();
    });

    it('fetches block, timestamp and protocol version for a new hash', async () => {
        const provider = fakeProvider();
        const signed = { block: { header: { number: '0x6' } } };
        provider.getBlockHash.mockResolvedValue('0xnew');
        provider.getBlock.mockResolvedValue(signed);
        provider.getStorage.mockResolvedValue(timestampHex(1_700_000_042_000n));
        const p = await makeProcessor(provider);

        const prep = asFetched(await p.fetchBlockData(6));
        expect(prep.signedBlock).toBe(signed);
        expect(prep.protocolVersion).toBe(7);
        expect(prep.timestamp).toBe(1_700_000_042);
    });
});

describe('fetchBlockBatch', () => {
    it('returns [] for an empty height list without any RPC', async () => {
        const provider = fakeProvider();
        const p = await makeProcessor(provider);
        expect(await p.fetchBlockBatch([])).toEqual([]);
        expect(provider.rpcBatch).not.toHaveBeenCalled();
    });

    it('dedupes against the DB and de-interleaves [block, ts] pairs in height order', async () => {
        const provider = fakeProvider();
        await seedBlock(11, '0xh11'); // height 11 already indexed
        const blockA = { block: { marker: 'A' } };
        const blockB = { block: { marker: 'B' } };
        provider.rpcBatch
            // Round 1: heights → hashes
            .mockResolvedValueOnce(['0xh10', '0xh11', '0xh12'])
            // Round 2: interleaved [block10, ts10, block12, ts12]
            .mockResolvedValueOnce([
                blockA, timestampHex(1_700_000_010_000n),
                blockB, timestampHex(1_700_000_012_000n)
            ]);
        const p = await makeProcessor(provider);

        const out = await p.fetchBlockBatch([10, 11, 12]);

        // Round 2 must only request the two NEW hashes, block+timestamp interleaved.
        const round2 = provider.rpcBatch.mock.calls[1][0];
        expect(round2.map((r: any) => r.method)).toEqual([
            'chain_getBlock', 'state_getStorage', 'chain_getBlock', 'state_getStorage'
        ]);
        expect(round2[0].params).toEqual(['0xh10']);
        expect(round2[2].params).toEqual(['0xh12']);

        expect(out[0]).toMatchObject({
            height: 10, blockHash: '0xh10', alreadyIndexed: false,
            timestamp: 1_700_000_010, protocolVersion: 7
        });
        expect(asFetched(out[0]).signedBlock).toBe(blockA);
        expect(out[1]).toMatchObject({ height: 11, blockHash: '0xh11', alreadyIndexed: true });
        expect((out[1] as any).signedBlock).toBeUndefined();
        expect(out[2]).toMatchObject({
            height: 12, blockHash: '0xh12', alreadyIndexed: false, timestamp: 1_700_000_012
        });
        expect(asFetched(out[2]).signedBlock).toBe(blockB);
    });

    it('skips round 2 entirely when every hash is already indexed', async () => {
        const provider = fakeProvider();
        await seedBlock(20, '0xh20');
        await seedBlock(21, '0xh21');
        provider.rpcBatch.mockResolvedValueOnce(['0xh20', '0xh21']);
        const p = await makeProcessor(provider);

        const out = await p.fetchBlockBatch([20, 21]);
        expect(out.every(b => b.alreadyIndexed)).toBe(true);
        expect(provider.rpcBatch).toHaveBeenCalledTimes(1);
    });

    it('throws when the node returns no hash for one of the heights', async () => {
        const provider = fakeProvider();
        provider.rpcBatch
            .mockResolvedValueOnce(['0xok', null])
            .mockResolvedValueOnce([{ block: {} }, timestampHex(1_700_000_000_000n)]);
        const p = await makeProcessor(provider);
        await expect(p.fetchBlockBatch([30, 31])).rejects.toThrow('No block at height 31');
    });

    it('queries the protocol version once per batch and falls back to the cached one on failure', async () => {
        const provider = fakeProvider();
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            provider.getRuntimeVersion
                .mockResolvedValueOnce({ specVersion: 9 })
                .mockRejectedValueOnce(new Error('rpc down'));
            provider.rpcBatch
                .mockResolvedValueOnce(['0xb1'])
                .mockResolvedValueOnce([{ block: { n: 1 } }, timestampHex(1_700_000_000_000n)])
                .mockResolvedValueOnce(['0xb2'])
                .mockResolvedValueOnce([{ block: { n: 2 } }, timestampHex(1_700_000_001_000n)]);
            const p = await makeProcessor(provider);

            const first = await p.fetchBlockBatch([40]);
            expect(asFetched(first[0]).protocolVersion).toBe(9);
            expect(provider.getRuntimeVersion).toHaveBeenCalledTimes(1);

            // Second batch: runtime-version RPC fails → cached specVersion 9 sticks.
            const second = await p.fetchBlockBatch([41]);
            expect(asFetched(second[0]).protocolVersion).toBe(9);
            expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/Failed to get runtime version/));
        } finally {
            warnSpy.mockRestore();
        }
    });
});

describe('parsing helpers', () => {
    it('parseTimestampHex decodes a little-endian u64 in ms to unix seconds', async () => {
        const p = await makeProcessor(fakeProvider());
        expect((p as any).parseTimestampHex(timestampHex(1_700_000_042_000n))).toBe(1_700_000_042);
        // without 0x prefix
        expect((p as any).parseTimestampHex(timestampHex(1_700_000_042_000n).slice(2))).toBe(1_700_000_042);
    });

    it('parseTimestampHex falls back to wall-clock time for null/undefined/undecodable input', async () => {
        const p = await makeProcessor(fakeProvider());
        const nowSec = Math.floor(Date.now() / 1000);
        for (const bad of [null, undefined, '0x00']) {
            const parsed = (p as any).parseTimestampHex(bad);
            expect(Math.abs(parsed - nowSec)).toBeLessThanOrEqual(2);
        }
    });

    it('toInt coerces numbers and numeric strings, everything else to 0', async () => {
        const p: any = await makeProcessor(fakeProvider());
        expect(p.toInt(7.9)).toBe(7);
        expect(p.toInt('42')).toBe(42);
        expect(p.toInt('  ')).toBe(0);
        expect(p.toInt('abc')).toBe(0);
        expect(p.toInt(undefined)).toBe(0);
        expect(p.toInt(Infinity)).toBe(0);
    });

    it('toBigInt coerces bigints, numbers and decimal strings, everything else to 0n', async () => {
        const p: any = await makeProcessor(fakeProvider());
        expect(p.toBigInt(5n)).toBe(5n);
        expect(p.toBigInt(7.9)).toBe(7n);
        expect(p.toBigInt('12')).toBe(12n);
        expect(p.toBigInt('nope')).toBe(0n);
        expect(p.toBigInt('')).toBe(0n);
        expect(p.toBigInt(undefined)).toBe(0n);
    });
});
