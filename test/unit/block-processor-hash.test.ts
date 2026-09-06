/**
 * Tests for BlockProcessor hardening:
 * - blake2b-256 extrinsic hashing
 * - On-chain timestamp from Timestamp pallet
 * - protocolVersion from RuntimeVersion
 * - Structured author extraction from digest logs
 */

const selectColumnsWhereSpy = vi.hoisted(() => (vi.fn()));

vi.mock('@sap/cds', () => {
    const cds: any = {
        log: (() => {
            const _c: Record<string, any> = {};
            return (name: string) => (_c[name] ??= {
                info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn()
            });
        })(),
        env: {
            requires: {
                nightgate: {
                    palletMap: {
                        10: { name: 'Contracts', txType: 'contract_call' },
                        15: { name: 'Zswap', txType: 'shielded_transfer', isShielded: true }
                    }
                }
            }
        },
        ql: {
            SELECT: {
                one: {
                    from: vi.fn().mockReturnValue({
                        columns: vi.fn().mockReturnValue({
                            where: selectColumnsWhereSpy
                        })
                    })
                }
            },
            INSERT: {
                into: vi.fn().mockReturnValue({
                    entries: vi.fn()
                })
            },
            UPDATE: {
                entity: vi.fn().mockReturnValue({
                    set: vi.fn().mockReturnValue({
                        where: vi.fn()
                    })
                })
            }
        },
        connect: {
            to: vi.fn()
        },
        utils: {
            uuid: vi.fn(() => 'uuid-1')
        }
    };
    cds.default = cds;
    return cds;
});

import cds from '@sap/cds';
import { blake2b } from '@noble/hashes/blake2b';
import { bytesToHex } from '@noble/hashes/utils';
import { BlockProcessor } from '../../srv/crawler/BlockProcessor';
import { isTransientError } from '../../srv/utils/retry';

function buildUnsignedExtrinsic(palletIndex: number, callIndex: number): string {
    return '0x' + Buffer.from([0x0c, 0x04, palletIndex, callIndex]).toString('hex');
}

// ============================================================================
// 1A: blake2b-256 Extrinsic Hashing
// ============================================================================

describe('hashExtrinsic: blake2b-256', () => {
    const processor = new BlockProcessor({} as any);

    it('produces a deterministic 66-char hex hash (0x + 64)', () => {
        const hex = '0xdeadbeef01020304';
        const result = (processor as any).hashExtrinsic(hex);
        expect(result).toMatch(/^0x[0-9a-f]{64}$/);
    });

    it('same input always produces same output', () => {
        const hex = '0xaabbccdd';
        expect((processor as any).hashExtrinsic(hex)).toBe((processor as any).hashExtrinsic(hex));
    });

    it('different inputs produce different outputs', () => {
        expect((processor as any).hashExtrinsic('0xaa')).not.toBe((processor as any).hashExtrinsic('0xbb'));
    });

    it('handles hex without 0x prefix', () => {
        const withPrefix = (processor as any).hashExtrinsic('0xdeadbeef');
        const withoutPrefix = (processor as any).hashExtrinsic('deadbeef');
        expect(withPrefix).toBe(withoutPrefix);
    });

    it('produces correct blake2b-256 for known input', () => {
        // blake2b-256 of empty bytes = known constant
        const emptyHash = (processor as any).hashExtrinsic('0x');
        expect(emptyHash).toBe('0x' + bytesToHex(blake2b(Buffer.alloc(0), { dkLen: 32 })));
    });
});

describe('classifyExtrinsic and mapPalletCall', () => {
    const processor = new BlockProcessor({} as any);

    it('classifies too-short extrinsics as system', () => {
        expect((processor as any).classifyExtrinsic('0x12')).toMatchObject({
            txType: 'system',
            isShielded: false,
            isSystem: true
        });
    });

    it('maps Contracts calls to specific tx types', () => {
        expect((processor as any).classifyExtrinsic(buildUnsignedExtrinsic(10, 0)).txType).toBe('contract_call');
        expect((processor as any).classifyExtrinsic(buildUnsignedExtrinsic(10, 1)).txType).toBe('contract_deploy');
        expect((processor as any).classifyExtrinsic(buildUnsignedExtrinsic(10, 2)).txType).toBe('contract_update');
    });

    it('uses pallet overrides from config for classification', () => {
        expect((processor as any).classifyExtrinsic(buildUnsignedExtrinsic(15, 0))).toMatchObject({
            txType: 'shielded_transfer',
            isShielded: true,
            isSystem: false,
            palletIndex: 15,
            callIndex: 0
        });
    });

    it('returns unknown for unmapped pallet indices', () => {
        expect((processor as any).mapPalletCall(99, 0)).toEqual({
            txType: 'unknown',
            isShielded: false,
            isSystem: false
        });
    });

    it('derives deterministic metadata helpers for contract transactions', () => {
        expect((processor as any).toContractActionType('contract_call')).toBe('CALL');
        expect((processor as any).toContractActionType('night_transfer')).toBeNull();
        expect((processor as any).extrinsicSize('0x0c040a02')).toBe(4);
        expect((processor as any).buildCircuitName({ palletIndex: 10, callIndex: 2 })).toBe('10:2');
    });
});

// ============================================================================
// 1B: On-chain Timestamp Parsing
// ============================================================================

describe('System.Events outcome decoding', () => {
    test('maps canonical success/failure events by applyExtrinsic index and leaves missing outcomes unknown', () => {
        const processor = new BlockProcessor({} as any);
        const record = (index: number, method: string, section = 'system') => ({
            phase: { isApplyExtrinsic: true, asApplyExtrinsic: { toNumber: () => index } },
            event: { section, method }
        });
        const registry = {
            createType: vi.fn(() => [
                record(0, 'ExtrinsicSuccess'),
                record(1, 'SomethingElse', 'midnight'),
                record(2, 'ExtrinsicSuccess'),
                record(2, 'ExtrinsicFailed')
            ])
        };

        const outcomes = (processor as any).decodeExtrinsicOutcomes('0xevents', registry);
        expect([...outcomes.entries()]).toEqual([[0, 'SUCCESS'], [2, 'FAILURE']]);
        expect(outcomes.has(1)).toBe(false);
    });

    test('returns no outcomes when storage or metadata decoding is unavailable', () => {
        const processor = new BlockProcessor({} as any);
        expect((processor as any).decodeExtrinsicOutcomes(null, {})).toEqual(new Map());
        const broken = { createType: () => { throw new Error('bad metadata'); } };
        expect((processor as any).decodeExtrinsicOutcomes('0xbad', broken)).toEqual(new Map());
    });
});

describe('getBlockTimestamp: SCALE u64 LE parsing', () => {
    const provider = {
        getStorage: vi.fn()
    } as any;
    const processor = new BlockProcessor(provider);

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('parses a known SCALE u64 LE timestamp correctly', async () => {
        // 1700000000000 ms = 1700000000 seconds (2023-11-14T22:13:20Z)
        // LE bytes: 00 68 E5 CF 8B 01 00 00
        const hex = '0x0068e5cf8b010000';
        provider.getStorage.mockResolvedValueOnce(hex);
        await expect((processor as any).getBlockTimestamp('0xblock')).resolves.toBe(1700000000);
    });

    it('parses zero timestamp', async () => {
        const hex = '0x0000000000000000';
        provider.getStorage.mockResolvedValueOnce(hex);
        await expect((processor as any).getBlockTimestamp('0xblock')).resolves.toBe(0);
    });

    it('handles typical Substrate timestamp (ms precision)', async () => {
        // 1577836800000 ms = 1577836800 s (2020-01-01 00:00:00 UTC)
        const ms = BigInt(1577836800000);
        const buf = Buffer.alloc(8);
        buf.writeBigUInt64LE(ms);
        const hex = '0x' + buf.toString('hex');
        provider.getStorage.mockResolvedValueOnce(hex);
        await expect((processor as any).getBlockTimestamp('0xblock')).resolves.toBe(1577836800);
    });

    it('returns null (never the wall clock) when the storage lookup fails', async () => {
        const warnSpy = vi.spyOn(cds.log('nightgate:crawler'), 'warn').mockImplementation(() => {});
        provider.getStorage.mockRejectedValueOnce(new Error('storage unavailable'));

        try {
            await expect((processor as any).getBlockTimestamp('0xblock')).resolves.toBeNull();
            expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to read on-chain timestamp'));
        } finally {
            warnSpy.mockRestore();
        }
    });

    it('resolveTimestamp takes the Timestamp.set inherent when the storage is gone, and refuses without either', () => {
        // extrinsic 0 = Timestamp.set(Compact<u64> ms): unsigned v4 extrinsic
        // [compact len][0x04][pallet 1][call 0][compact ms]
        const ms = 1_700_000_000_000n;
        // compact encoding of a u64 > 2^30: big-integer mode, 6 bytes needed
        const bytes: number[] = [];
        let v = ms; const payload: number[] = [];
        while (v > 0n) { payload.push(Number(v & 0xffn)); v >>= 8n; }
        bytes.push(((payload.length - 4) << 2) | 0b11, ...payload);
        const body = [0x04, 0x01, 0x00, ...bytes];
        const len = body.length; // < 64: single-byte compact
        const hex = '0x' + Buffer.from([len << 2, ...body]).toString('hex');
        expect((processor as any).resolveTimestamp(null, [hex], 'height 9')).toBe(1_700_000_000);
        expect(() => (processor as any).resolveTimestamp(null, ['0x' + 'aa'.repeat(20)], 'height 9')).toThrow(/No timestamp for height 9/);
        expect(() => (processor as any).resolveTimestamp(null, [], 'height 9')).toThrow(/No timestamp/);
    });

    it('resolves the pallet map from runtime metadata by NAME (renumbered pallets cannot become unknown silently)', () => {
        const warnSpy = vi.spyOn(cds.log('nightgate:crawler'), 'warn').mockImplementation(() => {});
        try {
            const fakeRegistry = { metadata: { pallets: [
                { name: 'System', index: 0 },
                { name: 'Timestamp', index: 1 },
                { name: 'Midnight', index: 7 },        // moved from 5
                { name: 'BrandNewPallet', index: 5 }   // took the old ledger index
            ] } };
            const map = (processor as any).palletMapFromMetadata(fakeRegistry, 4242);
            expect((processor as any).mapPalletCall(7, 0, map)).toMatchObject({ txType: 'contract_call' });
            expect((processor as any).mapPalletCall(5, 0, map)).toMatchObject({ txType: 'unknown' });
            expect((processor as any).mapPalletCall(1, 0, map)).toMatchObject({ isSystem: true });
            // The processor's default map is untouched: the metadata map belongs to its runtime version only.
            expect((processor as any).mapPalletCall(5, 0)).toMatchObject({ txType: 'contract_call' });
            expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/moved from the default indices: Midnight@7/));
            expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/BrandNewPallet@5/));
        } finally {
            warnSpy.mockRestore();
        }
    });

    it('specVersionFromBatch: 0 is a version, null / empty / false are not (they would alias runtime 0)', () => {
        expect((processor as any).specVersionFromBatch({ specVersion: 0 }, 'h')).toBe(0);
        expect((processor as any).specVersionFromBatch({ specVersion: '12' }, 'h')).toBe(12);
        for (const bad of [null, '', false, undefined, -1, 1.5, 'abc']) {
            expect(() => (processor as any).specVersionFromBatch({ specVersion: bad }, 'height 9'), String(bad)).toThrow(/No runtime version/);
        }
        expect(() => (processor as any).specVersionFromBatch(null, 'height 9')).toThrow(/No runtime version/);
    });

    it('refuses a metadata without a readable pallet list instead of guessing the default indices', () => {
        expect(() => (processor as any).palletMapFromMetadata({ metadata: { pallets: [] } }, 4243)).toThrow(/lists no pallets/);
        expect(() => (processor as any).palletMapFromMetadata({ metadata: {} }, 4244)).toThrow(/lists no pallets/);
        const throwing = { get metadata() { throw new Error('unsupported v16 layout'); } };
        expect(() => (processor as any).palletMapFromMetadata(throwing, 4245)).toThrow(/unsupported metadata representation/);
    });
});

// ============================================================================
// 1C: protocolVersion from RuntimeVersion
// ============================================================================

describe('getProtocolVersion: RuntimeVersion per-block query with error fallback', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('queries the runtime version per block hash (no skip-cache)', async () => {
        const provider = {
            getRuntimeVersion: vi.fn()
        } as any;
        const processor = new BlockProcessor(provider);

        provider.getRuntimeVersion.mockResolvedValue({ specVersion: 42 });

        await expect((processor as any).getProtocolVersion('0xabc')).resolves.toBe(42);
        await expect((processor as any).getProtocolVersion('0xdef')).resolves.toBe(42);
        expect(provider.getRuntimeVersion).toHaveBeenCalledTimes(2);
    });

    it('reflects runtime upgrades on later blocks instead of serving a stale cache', async () => {
        const provider = {
            getRuntimeVersion: vi.fn()
        } as any;
        const processor = new BlockProcessor(provider);
        provider.getRuntimeVersion
            .mockResolvedValueOnce({ specVersion: 5 })
            .mockResolvedValueOnce({ specVersion: 6 });

        await expect((processor as any).getProtocolVersion('0xpre-upgrade')).resolves.toBe(5);
        await expect((processor as any).getProtocolVersion('0xpost-upgrade')).resolves.toBe(6);
    });

    it('never falls back to a previously fetched version: a failed or empty answer refuses the block (transient)', async () => {
        const provider = {
            getRuntimeVersion: vi.fn()
        } as any;
        const processor = new BlockProcessor(provider);
        provider.getRuntimeVersion
            .mockResolvedValueOnce({ specVersion: 42 })
            .mockRejectedValueOnce(new Error('runtime unavailable'))
            .mockResolvedValueOnce(null);
        await expect((processor as any).getProtocolVersion('0xabc')).resolves.toBe(42);
        const failed = await (processor as any).getProtocolVersion('0xdef').then(() => null, (e: Error) => e);
        expect(failed?.message).toMatch(/No runtime version for block 0xdef: runtime unavailable/);
        expect(isTransientError(failed!)).toBe(true);
        await expect((processor as any).getProtocolVersion('0xnull')).rejects.toThrow(/No runtime version for block 0xnull/);
    });
});

// ============================================================================
// 1D: Structured Author from Digest Logs
// ============================================================================

describe('extractAuthor: digest log parsing', () => {
    const processor = new BlockProcessor({} as any);

    it('extracts PreRuntime log with BABE engine', () => {
        // Type 0x06 + "BABE" in hex (42414245) + some slot data
        const preRuntimeLog = '0x0642414245aabbccdd';
        const result = (processor as any).extractAuthor([preRuntimeLog]);
        expect(result).toBe('BABE:0xaabbccdd');
    });

    it('extracts PreRuntime log with aura engine', () => {
        // Type 0x06 + "aura" in hex (61757261) + authority data
        const preRuntimeLog = '0x0661757261112233';
        const result = (processor as any).extractAuthor([preRuntimeLog]);
        expect(result).toBe('aura:0x112233');
    });

    it('returns null for empty digest logs', () => {
        expect((processor as any).extractAuthor([])).toBeNull();
        expect((processor as any).extractAuthor(undefined)).toBeNull();
    });

    it('falls back to first log if no PreRuntime entry', () => {
        // Type 0x04 = Consensus (not PreRuntime)
        const consensusLog = '0x044241424511223344';
        const result = (processor as any).extractAuthor([consensusLog]);
        expect(result).toBe(consensusLog);
    });

    it('skips short log entries', () => {
        const result = (processor as any).extractAuthor(['0x06', '0x064241424511223344']);
        // First entry too short (< 10 chars after 0x), second is valid PreRuntime
        expect(result).toBe('BABE:0x11223344');
    });

    it('picks first PreRuntime log when multiple exist', () => {
        const log1 = '0x0642414245aabbccdd';  // BABE
        const log2 = '0x0661757261eeff0011';  // aura
        const result = (processor as any).extractAuthor([log1, log2]);
        expect(result).toBe('BABE:0xaabbccdd');
    });
});

describe('BlockProcessor public helpers', () => {
    it('resolves the hash and processes the block with parent enforcement (height path)', async () => {
        const provider = {
            getBlockHash: vi.fn().mockResolvedValue('0xblockhash')
        } as any;
        const processor = new BlockProcessor(provider);
        const processFromNodeSpy = vi.spyOn(processor as any, 'processFromNode').mockResolvedValue({
            blockHeight: 7,
            blockHash: '0xblockhash',
            transactionCount: 0,
            contractActionCount: 0,
            processingTimeMs: 1
        });

        await expect(processor.processBlockByHeight(7)).resolves.toEqual(expect.objectContaining({
            blockHeight: 7,
            blockHash: '0xblockhash'
        }));
        expect(provider.getBlockHash).toHaveBeenCalledWith(7);
        // Height-sequenced path: a missing parent is an index gap → strict.
        expect(processFromNodeSpy).toHaveBeenCalledWith('0xblockhash', expect.any(Number), { requireParent: true });
    });

    it('processes hash-addressed blocks without parent enforcement (on-demand path)', async () => {
        const processor = new BlockProcessor({} as any);
        const processFromNodeSpy = vi.spyOn(processor as any, 'processFromNode').mockResolvedValue({
            blockHeight: 7,
            blockHash: '0xblockhash',
            transactionCount: 0,
            contractActionCount: 0,
            processingTimeMs: 1
        });

        await processor.processBlockByHash('0xblockhash');
        expect(processFromNodeSpy).toHaveBeenCalledWith('0xblockhash', expect.any(Number), { requireParent: false });
    });

    it('throws when no block exists at the requested height', async () => {
        const provider = {
            getBlockHash: vi.fn().mockResolvedValue(null)
        } as any;
        const processor = new BlockProcessor(provider);

        await expect(processor.processBlockByHeight(9)).rejects.toThrow('No block at height 9');
    });

    it('checks block existence from the local DB', async () => {
        const processor = new BlockProcessor({} as any);
        (processor as any).db = {
            run: vi.fn()
                .mockResolvedValueOnce({ ID: 'block-1' })
                .mockResolvedValueOnce(null)
        };

        await expect(processor.blockExists('0xpresent')).resolves.toBe(true);
        await expect(processor.blockExists('0xmissing')).resolves.toBe(false);
        expect(selectColumnsWhereSpy).toHaveBeenCalledWith({ hash: '0xpresent' });
        expect(selectColumnsWhereSpy).toHaveBeenCalledWith({ hash: '0xmissing' });
    });
});
