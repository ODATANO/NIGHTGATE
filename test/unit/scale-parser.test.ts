/**
 * SCALE Parser Tests
 *
 * Tests for decodeCompact() and parseExtrinsicCallIndices() from srv/utils/scale.ts.
 */

import {
    decodeCompact,
    decodeCompactBigInt,
    parseExtrinsicCallIndices,
    parseExtrinsicParticipantInfo
} from '../../srv/utils/scale';

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

    it('should return null for truncated four-byte mode', () => {
        const buf = Buffer.from([0x02, 0x00, 0x00]);
        expect(decodeCompact(buf, 0)).toBeNull();
    });

    it('should return null for truncated big-integer mode', () => {
        const buf = Buffer.from([0x03, 0x00, 0x00, 0x00]);
        expect(decodeCompact(buf, 0)).toBeNull();
    });
});

describe('decodeCompactBigInt', () => {
    it('should decode big-integer mode values', () => {
        // 2^40 = 0x010000000000 (6 LE bytes)
        // Mode byte for 6 bytes: ((6-4) << 2) | 0b11 = 0x0b
        const buf = Buffer.from([0x0b, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01]);
        expect(decodeCompactBigInt(buf, 0)).toEqual([1099511627776n, 7]);
    });

    it('should return null for truncated big-integer mode payloads', () => {
        const buf = Buffer.from([0x0b, 0x00, 0x00, 0x00]);
        expect(decodeCompactBigInt(buf, 0)).toBeNull();
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

    function buildCompactLength(length: number): Buffer {
        if (length <= 63) {
            return Buffer.from([length << 2]);
        }

        const buf = Buffer.alloc(2);
        buf.writeUInt16LE((length << 2) | 0x01, 0);
        return buf;
    }

    function buildSignedExtrinsicParts(options: {
        addressType?: number;
        signatureType?: number;
        eraBytes?: number[];
        nonceBytes?: number[];
        tipBytes?: number[];
        callBytes?: number[];
        truncateAddress?: boolean;
        truncateSignature?: boolean;
    } = {}): string {
        const bytes: number[] = [0x84];

        if (options.addressType !== undefined) {
            bytes.push(options.addressType);
            if (!options.truncateAddress) {
                for (let i = 0; i < 32; i++) bytes.push(0xaa);
            }
        }

        if (options.signatureType !== undefined) {
            bytes.push(options.signatureType);
            if (!options.truncateSignature) {
                for (let i = 0; i < 64; i++) bytes.push(0xbb);
            }
        }

        if (options.eraBytes) bytes.push(...options.eraBytes);
        if (options.nonceBytes) bytes.push(...options.nonceBytes);
        if (options.tipBytes) bytes.push(...options.tipBytes);
        if (options.callBytes) bytes.push(...options.callBytes);

        return Buffer.concat([buildCompactLength(bytes.length), Buffer.from(bytes)]).toString('hex');
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

    it('should return null when a 0x-prefixed payload is too short after stripping the prefix', () => {
        expect(parseExtrinsicCallIndices('0x0102')).toBeNull();
    });

    it('should return null for invalid hex', () => {
        expect(parseExtrinsicCallIndices('zzzzzzzzzzzzzz')).toBeNull();
    });

    it('should return null when hex decoding throws', () => {
        const fromSpy = jest.spyOn(Buffer, 'from').mockImplementationOnce(() => {
            throw new Error('hex decode failed');
        });

        try {
            expect(parseExtrinsicCallIndices('deadbeef')).toBeNull();
        } finally {
            fromSpy.mockRestore();
        }
    });

    it('should return null when the compact length prefix cannot be decoded', () => {
        const buf = Buffer.from([0x13, 0x00, 0x00, 0x00]);
        expect(parseExtrinsicCallIndices(buf.toString('hex'))).toBeNull();
    });

    it('should return null when the compact length consumes the whole buffer', () => {
        const buf = Buffer.alloc(4);
        buf.writeUInt32LE((16384 << 2) | 0x02, 0);
        expect(parseExtrinsicCallIndices(buf.toString('hex'))).toBeNull();
    });

    it('should return null for unsigned extrinsics without enough call data', () => {
        const buf = Buffer.from([0x01, 0x00, 0x04, 0x0a]);
        expect(parseExtrinsicCallIndices(buf.toString('hex'))).toBeNull();
    });

    it('should return null for truncated signed extrinsic', () => {
        // Version byte says signed but not enough data for address + sig
        const buf = Buffer.from([0x0c, 0x84, 0x00, 0xaa]);
        expect(parseExtrinsicCallIndices(buf.toString('hex'))).toBeNull();
    });

    it('should return null when a signed extrinsic stops before the address type byte', () => {
        const hex = Buffer.concat([buildCompactLength(1), Buffer.from([0x84])]).toString('hex');
        expect(parseExtrinsicCallIndices(hex)).toBeNull();
    });

    it('should return null for unknown address type in signed extrinsic', () => {
        const hex = buildSignedExtrinsicParts({ addressType: 0x05 });
        expect(parseExtrinsicCallIndices(hex)).toBeNull();
    });

    it('should parse signed extrinsics that use address type 0xff', () => {
        const hex = buildSignedExtrinsicParts({
            addressType: 0xff,
            signatureType: 0x02,
            eraBytes: [0x00],
            nonceBytes: [0x00],
            tipBytes: [0x00],
            callBytes: [0x0f, 0x03]
        });

        expect(parseExtrinsicCallIndices(hex)).toEqual({ palletIndex: 15, callIndex: 3 });
    });

    it('should return null for unknown signature type in signed extrinsic', () => {
        const hex = buildSignedExtrinsicParts({
            addressType: 0x00,
            signatureType: 0x05
        });
        expect(parseExtrinsicCallIndices(hex)).toBeNull();
    });

    it('should parse signed extrinsics with Ed25519 signatures and mortal era', () => {
        const hex = buildSignedExtrinsicParts({
            addressType: 0x00,
            signatureType: 0x00,
            eraBytes: [0x04, 0x00],
            nonceBytes: [0x00],
            tipBytes: [0x00],
            callBytes: [0x04, 0x02]
        });

        expect(parseExtrinsicCallIndices(hex)).toEqual({ palletIndex: 4, callIndex: 2 });
    });

    it('should return null when the signed extrinsic stops before the nonce', () => {
        const hex = buildSignedExtrinsicParts({
            addressType: 0x00,
            signatureType: 0x01,
            eraBytes: [0x00]
        });

        expect(parseExtrinsicCallIndices(hex)).toBeNull();
    });

    it('should return null when the signed extrinsic stops before the tip', () => {
        const hex = buildSignedExtrinsicParts({
            addressType: 0x00,
            signatureType: 0x01,
            eraBytes: [0x00],
            nonceBytes: [0x00]
        });

        expect(parseExtrinsicCallIndices(hex)).toBeNull();
    });

    it('should return null when the signed extrinsic stops before the era byte', () => {
        const hex = buildSignedExtrinsicParts({
            addressType: 0x00,
            signatureType: 0x01
        });

        expect(parseExtrinsicCallIndices(hex)).toBeNull();
    });

    it('should return null when the signed extrinsic stops before both call bytes', () => {
        const hex = buildSignedExtrinsicParts({
            addressType: 0x00,
            signatureType: 0x01,
            eraBytes: [0x00],
            nonceBytes: [0x00],
            tipBytes: [0x00],
            callBytes: [0x04]
        });

        expect(parseExtrinsicCallIndices(hex)).toBeNull();
    });

    it('should parse sender + receiver + amount from signed transfer-like calls', () => {
        const receiver = Array(32).fill(0x22);
        const amount100 = [0x91, 0x01]; // compact(100)

        const hex = buildSignedExtrinsicParts({
            addressType: 0x00,
            signatureType: 0x01,
            eraBytes: [0x00],
            nonceBytes: [0x00],
            tipBytes: [0x00],
            callBytes: [0x04, 0x00, 0x00, ...receiver, ...amount100]
        });

        expect(parseExtrinsicParticipantInfo(hex)).toEqual(expect.objectContaining({
            isSigned: true,
            palletIndex: 4,
            callIndex: 0,
            senderAddress: `0x${'aa'.repeat(32)}`,
            receiverAddress: `0x${'22'.repeat(32)}`,
            amount: '100'
        }));
    });

    it('should return sender metadata even when receiver/amount args are absent', () => {
        const hex = buildSignedExtrinsic(10, 1);
        expect(parseExtrinsicParticipantInfo(hex)).toEqual(expect.objectContaining({
            isSigned: true,
            palletIndex: 10,
            callIndex: 1,
            senderAddress: `0x${'aa'.repeat(32)}`
        }));
    });

    it('should parse unsigned call metadata without sender', () => {
        const hex = buildUnsignedExtrinsic(4, 0);
        expect(parseExtrinsicParticipantInfo(hex)).toEqual({
            isSigned: false,
            palletIndex: 4,
            callIndex: 0,
            senderAddress: undefined
        });
    });
});
