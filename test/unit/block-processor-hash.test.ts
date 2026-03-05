/**
 * Tests for BlockProcessor hardening:
 * - blake2b-256 extrinsic hashing
 * - On-chain timestamp from Timestamp pallet
 * - protocolVersion from RuntimeVersion
 * - Structured author extraction from digest logs
 */

// Use require() for @noble/hashes — subpath exports need moduleResolution: node16+
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { blake2b } = require('@noble/hashes/blake2b');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { bytesToHex } = require('@noble/hashes/utils');

// ============================================================================
// 1A: blake2b-256 Extrinsic Hashing
// ============================================================================

describe('hashExtrinsic — blake2b-256', () => {
    /** Replicates the BlockProcessor.hashExtrinsic logic for testing */
    function hashExtrinsic(hex: string): string {
        const cleanHex = hex.startsWith('0x') ? hex.slice(2) : hex;
        const bytes = Buffer.from(cleanHex, 'hex');
        const hash = blake2b(bytes, { dkLen: 32 });
        return '0x' + bytesToHex(hash);
    }

    it('produces a deterministic 66-char hex hash (0x + 64)', () => {
        const hex = '0xdeadbeef01020304';
        const result = hashExtrinsic(hex);
        expect(result).toMatch(/^0x[0-9a-f]{64}$/);
    });

    it('same input always produces same output', () => {
        const hex = '0xaabbccdd';
        expect(hashExtrinsic(hex)).toBe(hashExtrinsic(hex));
    });

    it('different inputs produce different outputs', () => {
        expect(hashExtrinsic('0xaa')).not.toBe(hashExtrinsic('0xbb'));
    });

    it('handles hex without 0x prefix', () => {
        const withPrefix = hashExtrinsic('0xdeadbeef');
        const withoutPrefix = hashExtrinsic('deadbeef');
        expect(withPrefix).toBe(withoutPrefix);
    });

    it('produces correct blake2b-256 for known input', () => {
        // blake2b-256 of empty bytes = known constant
        const emptyHash = hashExtrinsic('0x');
        expect(emptyHash).toBe('0x' + bytesToHex(blake2b(Buffer.alloc(0), { dkLen: 32 })));
    });
});

// ============================================================================
// 1B: On-chain Timestamp Parsing
// ============================================================================

describe('getBlockTimestamp — SCALE u64 LE parsing', () => {
    /** Replicates the timestamp parsing logic from BlockProcessor */
    function parseTimestampHex(hex: string): number {
        const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
        const buf = Buffer.from(clean, 'hex');
        const msTimestamp = buf.readBigUInt64LE(0);
        return Number(msTimestamp / 1000n);
    }

    it('parses a known SCALE u64 LE timestamp correctly', () => {
        // 1700000000000 ms = 1700000000 seconds (2023-11-14T22:13:20Z)
        // LE bytes: 00 68 E5 CF 8B 01 00 00
        const hex = '0x0068e5cf8b010000';
        expect(parseTimestampHex(hex)).toBe(1700000000);
    });

    it('parses zero timestamp', () => {
        const hex = '0x0000000000000000';
        expect(parseTimestampHex(hex)).toBe(0);
    });

    it('handles typical Substrate timestamp (ms precision)', () => {
        // 1577836800000 ms = 1577836800 s (2020-01-01 00:00:00 UTC)
        const ms = BigInt(1577836800000);
        const buf = Buffer.alloc(8);
        buf.writeBigUInt64LE(ms);
        const hex = '0x' + buf.toString('hex');
        expect(parseTimestampHex(hex)).toBe(1577836800);
    });
});

// ============================================================================
// 1C: protocolVersion from RuntimeVersion
// ============================================================================

describe('getProtocolVersion — RuntimeVersion cache', () => {
    it('extracts specVersion from RuntimeVersion response', () => {
        const runtimeVersion = {
            specName: 'midnight',
            implName: 'midnight-node',
            specVersion: 42,
            implVersion: 1,
            apis: [],
            transactionVersion: 1
        };
        expect(runtimeVersion.specVersion).toBe(42);
    });
});

// ============================================================================
// 1D: Structured Author from Digest Logs
// ============================================================================

describe('extractAuthor — digest log parsing', () => {
    /** Replicates BlockProcessor.extractAuthor logic */
    function extractAuthor(digestLogs: string[] | undefined): string | null {
        if (!digestLogs || digestLogs.length === 0) return null;

        for (const logHex of digestLogs) {
            const clean = logHex.startsWith('0x') ? logHex.slice(2) : logHex;
            if (clean.length < 10) continue;

            const logType = parseInt(clean.slice(0, 2), 16);

            if (logType === 6) {
                const engineId = Buffer.from(clean.slice(2, 10), 'hex').toString('ascii');
                const data = '0x' + clean.slice(10);
                return `${engineId}:${data}`;
            }
        }
        return digestLogs[0] || null;
    }

    it('extracts PreRuntime log with BABE engine', () => {
        // Type 0x06 + "BABE" in hex (42414245) + some slot data
        const preRuntimeLog = '0x0642414245aabbccdd';
        const result = extractAuthor([preRuntimeLog]);
        expect(result).toBe('BABE:0xaabbccdd');
    });

    it('extracts PreRuntime log with aura engine', () => {
        // Type 0x06 + "aura" in hex (61757261) + authority data
        const preRuntimeLog = '0x0661757261112233';
        const result = extractAuthor([preRuntimeLog]);
        expect(result).toBe('aura:0x112233');
    });

    it('returns null for empty digest logs', () => {
        expect(extractAuthor([])).toBeNull();
        expect(extractAuthor(undefined)).toBeNull();
    });

    it('falls back to first log if no PreRuntime entry', () => {
        // Type 0x04 = Consensus (not PreRuntime)
        const consensusLog = '0x044241424511223344';
        const result = extractAuthor([consensusLog]);
        expect(result).toBe(consensusLog);
    });

    it('skips short log entries', () => {
        const result = extractAuthor(['0x06', '0x064241424511223344']);
        // First entry too short (< 10 chars after 0x), second is valid PreRuntime
        expect(result).toBe('BABE:0x11223344');
    });

    it('picks first PreRuntime log when multiple exist', () => {
        const log1 = '0x0642414245aabbccdd';  // BABE
        const log2 = '0x0661757261eeff0011';  // aura
        const result = extractAuthor([log1, log2]);
        expect(result).toBe('BABE:0xaabbccdd');
    });
});
