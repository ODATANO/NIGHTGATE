/**
 * Tests for BlockProcessor hardening:
 * - blake2b-256 extrinsic hashing
 * - On-chain timestamp from Timestamp pallet
 * - protocolVersion from RuntimeVersion
 * - Structured author extraction from digest logs
 */

const selectColumnsWhereSpy = jest.fn();

jest.mock('@sap/cds', () => {
    const cds: any = {
        env: {
            requires: {
                nightgate: {
                    palletMap: {
                        15: { name: 'Zswap', txType: 'shielded_transfer', isShielded: true }
                    }
                }
            }
        },
        ql: {
            SELECT: {
                one: {
                    from: jest.fn().mockReturnValue({
                        columns: jest.fn().mockReturnValue({
                            where: selectColumnsWhereSpy
                        })
                    })
                }
            },
            INSERT: {
                into: jest.fn().mockReturnValue({
                    entries: jest.fn()
                })
            },
            UPDATE: {
                entity: jest.fn().mockReturnValue({
                    set: jest.fn().mockReturnValue({
                        where: jest.fn()
                    })
                })
            }
        },
        connect: {
            to: jest.fn()
        },
        utils: {
            uuid: jest.fn(() => 'uuid-1')
        }
    };
    cds.default = cds;
    return cds;
});

import { blake2b } from '@noble/hashes/blake2b';
import { bytesToHex } from '@noble/hashes/utils';
import { BlockProcessor } from '../../srv/crawler/BlockProcessor';

function buildUnsignedExtrinsic(palletIndex: number, callIndex: number): string {
    return '0x' + Buffer.from([0x0c, 0x04, palletIndex, callIndex]).toString('hex');
}

// ============================================================================
// 1A: blake2b-256 Extrinsic Hashing
// ============================================================================

describe('hashExtrinsic — blake2b-256', () => {
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
        expect((processor as any).classifyExtrinsic('0x12')).toEqual({
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
        expect((processor as any).classifyExtrinsic(buildUnsignedExtrinsic(15, 0))).toEqual({
            txType: 'shielded_transfer',
            isShielded: true,
            isSystem: false
        });
    });

    it('returns unknown for unmapped pallet indices', () => {
        expect((processor as any).mapPalletCall(99, 0)).toEqual({
            txType: 'unknown',
            isShielded: false,
            isSystem: false
        });
    });
});

// ============================================================================
// 1B: On-chain Timestamp Parsing
// ============================================================================

describe('getBlockTimestamp — SCALE u64 LE parsing', () => {
    const provider = {
        getStorage: jest.fn()
    } as any;
    const processor = new BlockProcessor(provider);

    beforeEach(() => {
        jest.clearAllMocks();
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

    it('falls back to wall clock time when storage lookup fails', async () => {
        const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
        provider.getStorage.mockRejectedValueOnce(new Error('storage unavailable'));

        try {
            await expect((processor as any).getBlockTimestamp('0xblock')).resolves.toBe(1_700_000_000);
            expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to read on-chain timestamp'));
        } finally {
            nowSpy.mockRestore();
            warnSpy.mockRestore();
        }
    });
});

// ============================================================================
// 1C: protocolVersion from RuntimeVersion
// ============================================================================

describe('getProtocolVersion — RuntimeVersion cache', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('extracts and caches specVersion from RuntimeVersion responses', async () => {
        const provider = {
            getRuntimeVersion: jest.fn()
        } as any;
        const processor = new BlockProcessor(provider);

        provider.getRuntimeVersion.mockResolvedValueOnce({ specVersion: 42 });

        await expect((processor as any).getProtocolVersion('0xabc')).resolves.toBe(42);
        await expect((processor as any).getProtocolVersion('0xabc')).resolves.toBe(42);
        expect(provider.getRuntimeVersion).toHaveBeenCalledTimes(1);
    });

    it('falls back to the cached specVersion on runtime version errors', async () => {
        const provider = {
            getRuntimeVersion: jest.fn()
        } as any;
        const processor = new BlockProcessor(provider);
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
        provider.getRuntimeVersion
            .mockResolvedValueOnce({ specVersion: 42 })
            .mockRejectedValueOnce(new Error('runtime unavailable'));

        try {
            await expect((processor as any).getProtocolVersion('0xabc')).resolves.toBe(42);
            await expect((processor as any).getProtocolVersion('0xdef')).resolves.toBe(42);
            expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to get runtime version'));
        } finally {
            warnSpy.mockRestore();
        }
    });
});

// ============================================================================
// 1D: Structured Author from Digest Logs
// ============================================================================

describe('extractAuthor — digest log parsing', () => {
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
    it('delegates processBlockByHeight to processBlockByHash', async () => {
        const provider = {
            getBlockHash: jest.fn().mockResolvedValue('0xblockhash')
        } as any;
        const processor = new BlockProcessor(provider);
        const processBlockByHashSpy = jest.spyOn(processor, 'processBlockByHash').mockResolvedValue({
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
        expect(processBlockByHashSpy).toHaveBeenCalledWith('0xblockhash');
    });

    it('throws when no block exists at the requested height', async () => {
        const provider = {
            getBlockHash: jest.fn().mockResolvedValue(null)
        } as any;
        const processor = new BlockProcessor(provider);

        await expect(processor.processBlockByHeight(9)).rejects.toThrow('No block at height 9');
    });

    it('checks block existence from the local DB', async () => {
        const processor = new BlockProcessor({} as any);
        (processor as any).db = {
            run: jest.fn()
                .mockResolvedValueOnce({ ID: 'block-1' })
                .mockResolvedValueOnce(null)
        };

        await expect(processor.blockExists('0xpresent')).resolves.toBe(true);
        await expect(processor.blockExists('0xmissing')).resolves.toBe(false);
        expect(selectColumnsWhereSpy).toHaveBeenCalledWith({ hash: '0xpresent' });
        expect(selectColumnsWhereSpy).toHaveBeenCalledWith({ hash: '0xmissing' });
    });
});
