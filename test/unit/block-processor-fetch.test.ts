/**
 * Tests for the parallel catch-up FETCH pipeline of srv/crawler/BlockProcessor.ts:
 * fetchBlockBatch (batched RPC, DB dedupe, response
 * de-interleaving, protocol version per LastRuntimeUpgrade value) plus the small parsing helpers
 * (parseTimestampHex, toInt, toBigInt). The persist side is covered by
 * block-processor-persistence.test.ts; this file only exercises the read path,
 * against the real in-memory CAP DB (the batch dedupe is a real bulk SELECT).
 */

import cds from '@sap/cds';
import { BlockProcessor, type PreparedBlockFetched } from '../../srv/crawler/BlockProcessor';
import { isTransientError } from '../../srv/utils/retry';

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

/** twox128("System") + twox128("LastRuntimeUpgrade"), the key the frame must ask for. */
const LAST_RUNTIME_UPGRADE_KEY = '0x26aa394eea5630e07c48ae0c9558cef7f9cce9c888469bb1a0dceaa129672ef8';

/** SCALE Compact<u32> (single-byte, two-byte and four-byte modes). */
function compactU32(v: number): Buffer {
    if (v < 1 << 6) return Buffer.from([v << 2]);
    if (v < 1 << 14) { const b = Buffer.alloc(2); b.writeUInt16LE((v << 2) | 1); return b; }
    const b = Buffer.alloc(4); b.writeUInt32LE(((v << 2) | 2) >>> 0); return b;
}

/** System.LastRuntimeUpgrade as the node returns it: `{ spec_version: Compact<u32>, spec_name: Vec<u8> }`. */
function upgradeHex(specVersion: number, specName = 'midnight'): string {
    const name = Buffer.from(specName, 'utf8');
    return '0x' + Buffer.concat([compactU32(specVersion), compactU32(name.length), name]).toString('hex');
}

/**
 * The node answers `state_getRuntimeVersion` per block hash from `versions`
 * (7 for a hash not listed): the processor asks it once per distinct
 * LastRuntimeUpgrade value, never per block, which the tests count.
 */
function fakeProvider() {
    const versions: Record<string, number> = {};
    return {
        versions,
        getBlockHash: vi.fn(),
        getBlock: vi.fn(),
        getStorage: vi.fn(),
        getMetadata: vi.fn().mockRejectedValue(new Error('metadata unavailable in fetch fixture')),
        getRuntimeVersion: vi.fn(async (hash: string) => ({ specVersion: versions[hash] ?? 7 })),
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
        stateRoot: '0xabcd'
    }));
}

/**
 * The fixture provider has no metadata, and a missing registry is a block
 * fetch FAILURE (fail-closed), so the registry lookup is stubbed out here;
 * the fail-closed path has its own tests below.
 */
async function makeProcessor(provider: any, opts: { realRegistry?: boolean } = {}): Promise<BlockProcessor> {
    const p = new BlockProcessor(provider);
    await p.init();
    if (!opts.realRegistry) vi.spyOn(p as any, 'getEventRegistry').mockResolvedValue(undefined);
    return p;
}

beforeEach(async () => {
    await db.run(cds.ql.DELETE.from(BLOCKS));
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
            // Round 2: interleaved [block10, ts10, events10, upgrade10, block12, ts12, events12, upgrade12]
            .mockResolvedValueOnce([
                blockA, timestampHex(1_700_000_010_000n), null, upgradeHex(7),
                blockB, timestampHex(1_700_000_012_000n), null, upgradeHex(7)
            ]);
        const p = await makeProcessor(provider);

        const out = await p.fetchBlockBatch([10, 11, 12]);

        // Round 2 must only request the two NEW hashes: block, timestamp, events
        // and LastRuntimeUpgrade interleaved. Never state_getRuntimeVersion: at a
        // historical hash that call costs the node a runtime compile.
        const round2 = provider.rpcBatch.mock.calls[1][0];
        expect(round2.map((r: any) => r.method)).toEqual([
            'chain_getBlock', 'state_getStorage', 'state_getStorage', 'state_getStorage',
            'chain_getBlock', 'state_getStorage', 'state_getStorage', 'state_getStorage'
        ]);
        expect(round2[0].params).toEqual(['0xh10']);
        expect(round2[3].params).toEqual([LAST_RUNTIME_UPGRADE_KEY, '0xh10']);
        expect(round2[4].params).toEqual(['0xh12']);
        expect(round2[7].params).toEqual([LAST_RUNTIME_UPGRADE_KEY, '0xh12']);

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
            .mockResolvedValueOnce([{ block: {} }, timestampHex(1_700_000_000_000n), null, upgradeHex(7)]);
        const p = await makeProcessor(provider);
        await expect(p.fetchBlockBatch([30, 31])).rejects.toThrow('No block at height 31');
    });

    it('takes the runtime version PER BLOCK from its LastRuntimeUpgrade value (an upgrade inside a batch lands on its first block)', async () => {
        const provider = fakeProvider();
        provider.versions['0xb1'] = 9;
        provider.versions['0xb2'] = 10;
        provider.rpcBatch
            .mockResolvedValueOnce(['0xb1', '0xb2'])
            .mockResolvedValueOnce([
                { block: { n: 1 } }, timestampHex(1_700_000_000_000n), null, upgradeHex(9),
                { block: { n: 2 } }, timestampHex(1_700_000_001_000n), null, upgradeHex(10)
            ]);
        const p = await makeProcessor(provider);
        const out = await p.fetchBlockBatch([40, 41]);
        expect(asFetched(out[0]).protocolVersion).toBe(9);
        expect(asFetched(out[1]).protocolVersion).toBe(10);
        // One node round-trip per runtime, at the first block seen under it.
        expect(provider.getRuntimeVersion.mock.calls.map(c => c[0])).toEqual(['0xb1', '0xb2']);
    });

    it('asks the node for the runtime version ONCE per LastRuntimeUpgrade value, not per block or per batch', async () => {
        const provider = fakeProvider();
        provider.versions['0xr1'] = 9;
        for (const [a, b] of [['0xr1', '0xr2'], ['0xr3', '0xr4'], ['0xr5', '0xr6']]) {
            provider.rpcBatch
                .mockResolvedValueOnce([a, b])
                .mockResolvedValueOnce([
                    { block: { n: a } }, timestampHex(1_700_000_000_000n), null, upgradeHex(9),
                    { block: { n: b } }, timestampHex(1_700_000_001_000n), null, upgradeHex(9)
                ]);
        }
        const p = await makeProcessor(provider);
        const out = [
            ...await p.fetchBlockBatch([70, 71]),
            ...await p.fetchBlockBatch([72, 73]),
            ...await p.fetchBlockBatch([74, 75])
        ];
        expect(out.map(b => asFetched(b).protocolVersion)).toEqual([9, 9, 9, 9, 9, 9]);
        expect(provider.getRuntimeVersion).toHaveBeenCalledTimes(1);
        expect(provider.getRuntimeVersion).toHaveBeenCalledWith('0xr1');
    });

    it('does not cache a failed runtime-version lookup: the next block under that value asks again', async () => {
        const provider = fakeProvider();
        provider.versions['0xf2'] = 9;
        provider.getRuntimeVersion.mockRejectedValueOnce(new Error('connection closed'));
        provider.rpcBatch
            .mockResolvedValueOnce(['0xf1'])
            .mockResolvedValueOnce([{ block: { n: 1 } }, timestampHex(1_700_000_000_000n), null, upgradeHex(9)])
            .mockResolvedValueOnce(['0xf2'])
            .mockResolvedValueOnce([{ block: { n: 2 } }, timestampHex(1_700_000_001_000n), null, upgradeHex(9)]);
        const p = await makeProcessor(provider);
        const err = await p.fetchBlockBatch([80]).then(() => null, (e: Error) => e);
        expect(err?.message).toMatch(/No runtime version for height 80: connection closed/);
        expect(isTransientError(err!)).toBe(true);
        expect(asFetched((await p.fetchBlockBatch([81]))[0]).protocolVersion).toBe(9);
        expect(provider.getRuntimeVersion).toHaveBeenCalledTimes(2);
    });

    it('a node answer that disagrees with the LastRuntimeUpgrade value is used for that block only: the next block under the value asks again', async () => {
        const provider = fakeProvider();
        provider.versions['0xd1'] = 10; // the block that carries the upgrade: storage still says 9, the node already 10
        provider.versions['0xd2'] = 9;  // an older block under the same value, read afterwards (reindex, replica)
        provider.versions['0xd3'] = 9;
        provider.rpcBatch
            .mockResolvedValueOnce(['0xd1'])
            .mockResolvedValueOnce([{ block: { n: 1 } }, timestampHex(1_700_000_000_000n), null, upgradeHex(9)])
            .mockResolvedValueOnce(['0xd2'])
            .mockResolvedValueOnce([{ block: { n: 2 } }, timestampHex(1_700_000_001_000n), null, upgradeHex(9)])
            .mockResolvedValueOnce(['0xd3'])
            .mockResolvedValueOnce([{ block: { n: 3 } }, timestampHex(1_700_000_002_000n), null, upgradeHex(9)]);
        const p = await makeProcessor(provider);
        const warnSpy = vi.spyOn(cds.log('nightgate:crawler'), 'warn').mockImplementation(() => {});
        try {
            expect(asFetched((await p.fetchBlockBatch([95]))[0]).protocolVersion).toBe(10);
            expect(asFetched((await p.fetchBlockBatch([96]))[0]).protocolVersion).toBe(9);
            expect(asFetched((await p.fetchBlockBatch([97]))[0]).protocolVersion).toBe(9);
        } finally {
            warnSpy.mockRestore();
        }
        // The disagreeing answer was not cached; the agreeing one is.
        expect(provider.getRuntimeVersion.mock.calls.map(c => c[0])).toEqual(['0xd1', '0xd2']);
    });

    it('the node is the authority: a LastRuntimeUpgrade value that decodes differently is logged, the node answer used', async () => {
        const provider = fakeProvider();
        provider.versions['0xw1'] = 11;
        provider.rpcBatch
            .mockResolvedValueOnce(['0xw1'])
            .mockResolvedValueOnce([{ block: { n: 1 } }, timestampHex(1_700_000_000_000n), null, upgradeHex(9)]);
        const p = await makeProcessor(provider);
        const warnSpy = vi.spyOn(cds.log('nightgate:crawler'), 'warn').mockImplementation(() => {});
        try {
            expect(asFetched((await p.fetchBlockBatch([90]))[0]).protocolVersion).toBe(11);
            expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/decodes to specVersion 9, node reports 11/));
        } finally {
            warnSpy.mockRestore();
        }
    });

    it('refuses the block when the runtime metadata cannot be loaded (nothing is decoded under a stale pallet map)', async () => {
        const provider = fakeProvider();
        provider.getMetadata.mockRejectedValue(new Error('metadata unavailable: connection closed'));
        provider.rpcBatch
            .mockResolvedValueOnce(['0xm1'])
            .mockResolvedValueOnce([{ block: { n: 1 } }, timestampHex(1_700_000_000_000n), null, upgradeHex(7)]);
        const p = await makeProcessor(provider, { realRegistry: true });
        await expect(p.fetchBlockBatch([60])).rejects.toThrow(/Runtime metadata unavailable for block 0xm1 \(specVersion 7\): metadata unavailable: connection closed/);
        // Not cached: the next block asks the node again.
        provider.rpcBatch
            .mockResolvedValueOnce(['0xm2'])
            .mockResolvedValueOnce([{ block: { n: 2 } }, timestampHex(1_700_000_001_000n), null, upgradeHex(7)]);
        await expect(p.fetchBlockBatch([61])).rejects.toThrow(/Runtime metadata unavailable/);
        expect(provider.getMetadata).toHaveBeenCalledTimes(2);
    });

    it('treats an empty metadata answer as a transient node problem and a non-decodable one as a permanent error', async () => {
        const provider = fakeProvider();
        provider.getMetadata.mockResolvedValueOnce(null).mockResolvedValueOnce('0x00');
        provider.rpcBatch
            .mockResolvedValueOnce(['0xm3'])
            .mockResolvedValueOnce([{ block: { n: 3 } }, timestampHex(1_700_000_000_000n), null, upgradeHex(7)])
            .mockResolvedValueOnce(['0xm4'])
            .mockResolvedValueOnce([{ block: { n: 4 } }, timestampHex(1_700_000_001_000n), null, upgradeHex(7)]);
        const p = await makeProcessor(provider, { realRegistry: true });
        const empty = await p.fetchBlockBatch([62]).then(() => null, (e: Error) => e);
        expect(empty?.message).toMatch(/No runtime metadata for block 0xm3/);
        expect(isTransientError(empty!)).toBe(true);
        const broken = await p.fetchBlockBatch([63]).then(() => null, (e: Error) => e);
        expect(broken?.message).toMatch(/Runtime metadata for block 0xm4 \(specVersion 7\) does not decode/);
        expect(isTransientError(broken!)).toBe(false);
    });

    it('a frame without a LastRuntimeUpgrade value asks the node per block; when that fails too the block is refused (transient; never a previous version)', async () => {
        const provider = fakeProvider();
        provider.versions['0xc1'] = 9;
        provider.versions['0xc3'] = 9;
        provider.versions['0xc4'] = 9;
        provider.rpcBatch
            .mockResolvedValueOnce(['0xc1'])
            .mockResolvedValueOnce([{ block: { n: 1 } }, timestampHex(1_700_000_000_000n), null, upgradeHex(9)]);
        const p = await makeProcessor(provider);
        expect(asFetched((await p.fetchBlockBatch([51]))[0]).protocolVersion).toBe(9);
        // Pruned or racing node: no storage value, and the version call fails as well.
        provider.getRuntimeVersion.mockRejectedValueOnce(new Error('state unavailable'));
        provider.rpcBatch
            .mockResolvedValueOnce(['0xc3'])
            .mockResolvedValueOnce([{ block: { n: 3 } }, timestampHex(1_700_000_002_000n), null, null]);
        const err = await p.fetchBlockBatch([52]).then(() => null, (e: Error) => e);
        expect(err?.message).toMatch(/No runtime version for height 52: state unavailable/);
        expect(isTransientError(err!)).toBe(true);
        expect(await db.run(cds.ql.SELECT.from(BLOCKS))).toHaveLength(0);
        // No storage value but the node answers: the block goes through, asked per block (not cached under a value).
        provider.rpcBatch
            .mockResolvedValueOnce(['0xc4'])
            .mockResolvedValueOnce([{ block: { n: 4 } }, timestampHex(1_700_000_003_000n), null, null]);
        expect(asFetched((await p.fetchBlockBatch([53]))[0]).protocolVersion).toBe(9);
        expect(provider.getRuntimeVersion.mock.calls.map(c => c[0])).toEqual(['0xc1', '0xc3', '0xc4']);
    });

    it('processBlockByHash refuses a block whose runtime version cannot be fetched', async () => {
        const provider = fakeProvider();
        provider.getBlock.mockResolvedValue({ block: { header: { parentHash: '0x0', number: '0x5', digest: { logs: [] } }, extrinsics: [] } });
        provider.getStorage.mockResolvedValue(timestampHex(1_700_000_000_000n));
        provider.getRuntimeVersion.mockRejectedValueOnce(new Error('connection closed'));
        const p = await makeProcessor(provider);
        await expect(p.processBlockByHash('0xnover')).rejects.toThrow(/No runtime version for block 0xnover: connection closed/);
        expect(await db.run(cds.ql.SELECT.from(BLOCKS))).toHaveLength(0);
    });
});

describe('parsing helpers', () => {
    it('asks the node for the well-known storage keys, twox128(pallet) + twox128(item)', () => {
        // Computed with @polkadot/util-crypto xxhashAsHex(name, 128).
        expect((BlockProcessor as any).TIMESTAMP_STORAGE_KEY).toBe('0xf0c365c3cf59d671eb72da0e7a4113c49f1f0515f462cdcf84e0f1d6045dfcbb');
        expect((BlockProcessor as any).SYSTEM_EVENTS_STORAGE_KEY).toBe('0x26aa394eea5630e07c48ae0c9558cef780d41e5e16056765bc8461851072c9d7');
        expect((BlockProcessor as any).LAST_RUNTIME_UPGRADE_STORAGE_KEY).toBe(LAST_RUNTIME_UPGRADE_KEY);
    });

    it('decodeLastRuntimeUpgrade reads the Compact<u32> spec_version (the three values Midnight preprod has had)', () => {
        // As returned by state_getStorage(System.LastRuntimeUpgrade) on preprod, spec_name "midnight".
        expect(BlockProcessor.decodeLastRuntimeUpgrade('0xc2570100206d69646e69676874')).toBe(22000);
        expect(BlockProcessor.decodeLastRuntimeUpgrade('0x02093d00206d69646e69676874')).toBe(1000000);
        expect(BlockProcessor.decodeLastRuntimeUpgrade('0xb20d3d00206d69646e69676874')).toBe(1000300);
        // The fixture encoder round-trips through all three compact modes.
        for (const v of [0, 7, 63, 64, 16383, 16384, 22000, 1000300, 1073741823]) {
            expect(BlockProcessor.decodeLastRuntimeUpgrade(upgradeHex(v))).toBe(v);
        }
        expect(BlockProcessor.decodeLastRuntimeUpgrade(upgradeHex(7).slice(2))).toBe(7); // without 0x
    });

    it('decodeLastRuntimeUpgrade yields null for empty, truncated or big-integer-mode input', () => {
        expect(BlockProcessor.decodeLastRuntimeUpgrade('0x')).toBeNull();
        expect(BlockProcessor.decodeLastRuntimeUpgrade('0x01')).toBeNull();   // two-byte mode, one byte
        expect(BlockProcessor.decodeLastRuntimeUpgrade('0x0209')).toBeNull(); // four-byte mode, two bytes
        expect(BlockProcessor.decodeLastRuntimeUpgrade('0x03ffffffff')).toBeNull(); // big-integer mode
    });

    it('parseTimestampHex decodes a little-endian u64 in ms to unix seconds', async () => {
        const p = await makeProcessor(fakeProvider());
        expect((p as any).parseTimestampHex(timestampHex(1_700_000_042_000n))).toBe(1_700_000_042);
        // without 0x prefix
        expect((p as any).parseTimestampHex(timestampHex(1_700_000_042_000n).slice(2))).toBe(1_700_000_042);
    });

    it('parseTimestampHex yields null (never the wall clock) for null/undefined/undecodable input', async () => {
        const p = await makeProcessor(fakeProvider());
        for (const bad of [null, undefined, '0x00']) {
            expect((p as any).parseTimestampHex(bad)).toBeNull();
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

// ---- The pallet map travels with the block -------------------------------
//
// Every PreparedBlock carries the map of ITS runtime version. A batch that
// straddles a runtime upgrade, or two batches in flight at once, must classify
// each block with the map of the version the block was produced under, never
// with whatever version was loaded last.
describe('pallet map per block', () => {
    const TRANSACTIONS = 'midnight.Transactions';
    const unsigned = (pallet: number, call: number) => '0x' + Buffer.from([0x0c, 0x04, pallet, call]).toString('hex');
    const header = (parentHash: string, height: number) => ({ parentHash, number: '0x' + height.toString(16), stateRoot: '0xs', digest: { logs: [] } });
    const contractCallAt = (index: number) => new Map([[index, { name: 'Midnight', txType: 'contract_call' }]]);

    /** A processor whose runtime cache is seeded per specVersion (no metadata RPC in the fixture). */
    async function processorWithRuntimes(provider: any, maps: Record<number, Map<number, any>>): Promise<BlockProcessor> {
        const p = await makeProcessor(provider);
        for (const [spec, palletMap] of Object.entries(maps)) (p as any).runtimes.set(Number(spec), { registry: undefined, palletMap });
        return p;
    }

    beforeEach(async () => {
        await db.run(cds.ql.DELETE.from(TRANSACTIONS));
    });

    it('a batch straddling a runtime upgrade classifies the older block with the older map', async () => {
        await seedBlock(41, '0xp41');
        const provider = fakeProvider();
        provider.rpcBatch
            .mockResolvedValueOnce(['0xv1', '0xv2'])
            .mockResolvedValueOnce([
                { block: { header: header('0xp41', 42), extrinsics: [unsigned(5, 0)] } }, timestampHex(1_700_000_000_000n), null, upgradeHex(9),
                { block: { header: header('0xv1', 43), extrinsics: [unsigned(5, 0)] } }, timestampHex(1_700_000_001_000n), null, upgradeHex(10)
            ]);
        provider.versions['0xv1'] = 9;
        provider.versions['0xv2'] = 10;
        // Version 9 has the ledger pallet at index 5; version 10 moved it to 7.
        const p = await processorWithRuntimes(provider, { 9: contractCallAt(5), 10: contractCallAt(7) });
        const out = await p.fetchBlockBatch([42, 43]);
        expect(asFetched(out[0]).palletMap.get(5)?.txType).toBe('contract_call');
        expect(asFetched(out[1]).palletMap.get(5)).toBeUndefined();
        for (const prep of out) await p.persistPreparedBlock(prep);
        const txs = await db.run(cds.ql.SELECT.from(TRANSACTIONS).columns('txType', 'block_ID'));
        expect(txs.map((t: any) => t.txType).sort()).toEqual(['contract_call', 'unknown']);
    });

    it('two batches in flight keep their own maps', async () => {
        await seedBlock(41, '0xp41');
        const provider = fakeProvider();
        // Answers keyed by what is asked, so the two batches may interleave
        // their rounds in any order: height 42 is a version-9 block, 43 a
        // version-10 block.
        const blocks: Record<string, any> = {
            '0xa': [{ block: { header: header('0xp41', 42), extrinsics: [unsigned(5, 0)] } }, timestampHex(1_700_000_000_000n), null, upgradeHex(9)],
            '0xb': [{ block: { header: header('0xa', 43), extrinsics: [unsigned(5, 0)] } }, timestampHex(1_700_000_001_000n), null, upgradeHex(10)]
        };
        provider.versions['0xa'] = 9;
        provider.versions['0xb'] = 10;
        provider.rpcBatch.mockImplementation(async (reqs: any[]) =>
            reqs[0].method === 'chain_getBlockHash' ? [reqs[0].params[0] === 42 ? '0xa' : '0xb'] : blocks[reqs[0].params[0]]);
        const p = await processorWithRuntimes(provider, { 9: contractCallAt(5), 10: contractCallAt(7) });
        const [first, second] = await Promise.all([p.fetchBlockBatch([42]), p.fetchBlockBatch([43])]);
        expect(asFetched(first[0]).protocolVersion).toBe(9);
        expect(asFetched(second[0]).protocolVersion).toBe(10);
        expect(asFetched(first[0]).palletMap).not.toBe(asFetched(second[0]).palletMap);
        await p.persistPreparedBlock(first[0]);
        await p.persistPreparedBlock(second[0]);
        const txs = await db.run(cds.ql.SELECT.from(TRANSACTIONS).columns('txType'));
        expect(txs.map((t: any) => t.txType).sort()).toEqual(['contract_call', 'unknown']);
    });

    it('a cached runtime version re-activates its own map for a later block', async () => {
        await seedBlock(41, '0xp41');
        const provider = fakeProvider();
        provider.rpcBatch
            .mockResolvedValueOnce(['0xn1'])
            .mockResolvedValueOnce([{ block: { header: header('0xp41', 42), extrinsics: [unsigned(7, 0)] } }, timestampHex(1_700_000_000_000n), null, upgradeHex(10)])
            .mockResolvedValueOnce(['0xn2'])
            .mockResolvedValueOnce([{ block: { header: header('0xn1', 43), extrinsics: [unsigned(5, 0)] } }, timestampHex(1_700_000_001_000n), null, upgradeHex(9)]);
        const p = await processorWithRuntimes(provider, { 9: contractCallAt(5), 10: contractCallAt(7) });
        provider.versions['0xn1'] = 10;
        provider.versions['0xn2'] = 9;
        const newer = await p.fetchBlockBatch([42]);
        const older = await p.fetchBlockBatch([43]); // an older runtime seen AFTER the newer one (reindex, replica)
        await p.persistPreparedBlock(newer[0]);
        await p.persistPreparedBlock(older[0]);
        const txs = await db.run(cds.ql.SELECT.from(TRANSACTIONS).columns('txType'));
        expect(txs.map((t: any) => t.txType)).toEqual(['contract_call', 'contract_call']);
    });
});
