/**
 * SCALE Parser Tests
 *
 * Tests for decodeCompact() and parseExtrinsicCallIndices() from srv/utils/scale.ts.
 */

import { decodeCompact, parseExtrinsicCallIndices } from '../../srv/utils/scale';

describe('decodeCompact', () => {
    it('should decode single-byte mode (0b00)', () => {
        // Value 1: 0b00000100 = 4 → 4 >> 2 = 1
        const buf = Buffer.from([0x04]);
        expect(decodeCompact(buf, 0)).toEqual([1, 1]);
    });

    it('should decode single-byte mode value 0', () => {
        const buf = Buffer.from([0x00]);
        expect(decodeCompact(buf, 0)).toEqual([0, 1]);
    });

    it('should decode single-byte mode max value 63', () => {
        // 63 << 2 = 252 = 0xFC
        const buf = Buffer.from([0xfc]);
        expect(decodeCompact(buf, 0)).toEqual([63, 1]);
    });

    it('should decode two-byte mode (0b01)', () => {
        // Value 64: (64 << 2) | 0x01 = 257 → little-endian [0x01, 0x01]
        const buf = Buffer.alloc(2);
        buf.writeUInt16LE((64 << 2) | 0x01, 0);
        expect(decodeCompact(buf, 0)).toEqual([64, 2]);
    });

    it('should decode two-byte mode value 100', () => {
        const buf = Buffer.alloc(2);
        buf.writeUInt16LE((100 << 2) | 0x01, 0);
        expect(decodeCompact(buf, 0)).toEqual([100, 2]);
    });

    it('should decode four-byte mode (0b10)', () => {
        // Value 16384: (16384 << 2) | 0x02 = 65538
        const buf = Buffer.alloc(4);
        buf.writeUInt32LE((16384 << 2) | 0x02, 0);
        expect(decodeCompact(buf, 0)).toEqual([16384, 4]);
    });

    it('should handle big-integer mode (0b11) by skipping', () => {
        // Mode 0b11: upper 6 bits = extra bytes count
        // (0 << 2) | 0x03 = 0x03 → extra = 0 + 4 = 4 following bytes
        const buf = Buffer.from([0x03, 0x00, 0x00, 0x00, 0x00, 0xff]);
        const result = decodeCompact(buf, 0);
        expect(result).not.toBeNull();
        expect(result![1]).toBe(5); // 1 header byte + 4 extra bytes
    });

    it('should respect offset parameter', () => {
        const buf = Buffer.from([0xff, 0xff, 0x04]); // junk, junk, then compact(1)
        expect(decodeCompact(buf, 2)).toEqual([1, 1]);
    });

    it('should return null for empty buffer', () => {
        expect(decodeCompact(Buffer.alloc(0), 0)).toBeNull();
    });

    it('should return null for offset beyond buffer', () => {
        const buf = Buffer.from([0x04]);
        expect(decodeCompact(buf, 5)).toBeNull();
    });

    it('should return null for truncated two-byte mode', () => {
        // Two-byte mode flag but only 1 byte available
        const buf = Buffer.from([0x01]); // mode 0b01, but no second byte
        expect(decodeCompact(buf, 0)).toBeNull();
    });
});

describe('parseExtrinsicCallIndices', () => {
    /**
     * Build a minimal unsigned extrinsic hex:
     *   compact_length + version_byte(0x04) + pallet_index + call_index
     */
    function buildUnsignedExtrinsic(palletIndex: number, callIndex: number): string {
        // Payload: [0x04, palletIndex, callIndex] = 3 bytes
        // Compact length of 3: 3 << 2 = 12 = 0x0C
        const buf = Buffer.from([0x0c, 0x04, palletIndex, callIndex]);
        return buf.toString('hex');
    }

    /**
     * Build a minimal signed extrinsic hex:
     *   compact_length + version_byte(0x84) + address(33B) + sig(65B) + era(1B) + nonce(1B) + tip(1B) + pallet_index + call_index
     */
    function buildSignedExtrinsic(palletIndex: number, callIndex: number): string {
        // Payload = 1 (version) + 33 (addr) + 65 (sig) + 1 (era) + 1 (nonce) + 1 (tip) + 2 (call) = 104 bytes
        const payloadLen = 104;
        const buf = Buffer.alloc(1 + payloadLen); // compact_length (single-byte) + payload

        let offset = 0;
        // Compact length: 104 << 2 = 416 → needs 2-byte mode
        // Actually 104 > 63, so use two-byte mode: (104 << 2) | 0x01 = 417
        const lenBuf = Buffer.alloc(2 + payloadLen);
        lenBuf.writeUInt16LE((payloadLen << 2) | 0x01, 0);
        offset = 2;

        // Version byte (signed)
        lenBuf[offset++] = 0x84;

        // Address: type 0x00 + 32 bytes AccountId
        lenBuf[offset++] = 0x00;
        for (let i = 0; i < 32; i++) lenBuf[offset++] = 0xaa;

        // Signature: type 0x01 (Sr25519) + 64 bytes
        lenBuf[offset++] = 0x01;
        for (let i = 0; i < 64; i++) lenBuf[offset++] = 0xbb;

        // Era: Immortal (0x00)
        lenBuf[offset++] = 0x00;

        // Nonce: compact 0 = 0x00
        lenBuf[offset++] = 0x00;

        // Tip: compact 0 = 0x00
        lenBuf[offset++] = 0x00;

        // Call data
        lenBuf[offset++] = palletIndex;
        lenBuf[offset++] = callIndex;

        return lenBuf.slice(0, offset).toString('hex');
    }

    it('should parse unsigned extrinsic', () => {
        const hex = buildUnsignedExtrinsic(1, 0);
        const result = parseExtrinsicCallIndices(hex);
        expect(result).toEqual({ palletIndex: 1, callIndex: 0 });
    });

    it('should parse unsigned extrinsic with pallet 0 (System)', () => {
        const hex = buildUnsignedExtrinsic(0, 2);
        const result = parseExtrinsicCallIndices(hex);
        expect(result).toEqual({ palletIndex: 0, callIndex: 2 });
    });

    it('should parse unsigned extrinsic with high pallet index', () => {
        const hex = buildUnsignedExtrinsic(42, 7);
        const result = parseExtrinsicCallIndices(hex);
        expect(result).toEqual({ palletIndex: 42, callIndex: 7 });
    });

    it('should parse signed extrinsic', () => {
        const hex = buildSignedExtrinsic(4, 0);
        const result = parseExtrinsicCallIndices(hex);
        expect(result).toEqual({ palletIndex: 4, callIndex: 0 });
    });

    it('should parse signed extrinsic with Contracts pallet', () => {
        const hex = buildSignedExtrinsic(10, 1);
        const result = parseExtrinsicCallIndices(hex);
        expect(result).toEqual({ palletIndex: 10, callIndex: 1 });
    });

    it('should handle 0x prefix', () => {
        const hex = '0x' + buildUnsignedExtrinsic(1, 0);
        const result = parseExtrinsicCallIndices(hex);
        expect(result).toEqual({ palletIndex: 1, callIndex: 0 });
    });

    it('should return null for empty string', () => {
        expect(parseExtrinsicCallIndices('')).toBeNull();
    });

    it('should return null for too-short hex', () => {
        expect(parseExtrinsicCallIndices('0102')).toBeNull();
    });

    it('should return null for invalid hex', () => {
        expect(parseExtrinsicCallIndices('zzzzzzzzzzzzzz')).toBeNull();
    });

    it('should return null for truncated signed extrinsic', () => {
        // Version byte says signed but not enough data for address + sig
        const buf = Buffer.from([0x0c, 0x84, 0x00, 0xaa]);
        expect(parseExtrinsicCallIndices(buf.toString('hex'))).toBeNull();
    });

    it('should return null for unknown address type in signed extrinsic', () => {
        // Build a signed-looking extrinsic with unknown address type
        const buf = Buffer.alloc(200);
        buf.writeUInt16LE((198 << 2) | 0x01, 0); // compact length (two-byte mode)
        buf[2] = 0x84; // version: signed
        buf[3] = 0x05; // unknown address type
        expect(parseExtrinsicCallIndices(buf.toString('hex'))).toBeNull();
    });

    it('should return null for unknown signature type in signed extrinsic', () => {
        const buf = Buffer.alloc(200);
        buf.writeUInt16LE((198 << 2) | 0x01, 0);
        buf[2] = 0x84;
        buf[3] = 0x00; // AccountId32 address type
        // 32 bytes of address (offset 4-35)
        buf[36] = 0x05; // unknown sig type
        expect(parseExtrinsicCallIndices(buf.toString('hex'))).toBeNull();
    });
});
