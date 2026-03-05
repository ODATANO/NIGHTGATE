/**
 * Minimal SCALE codec helpers for Substrate extrinsic parsing.
 *
 * Only implements what's needed to extract pallet_index + call_index
 * from hex-encoded extrinsics. No external dependencies.
 */

/**
 * Decode a SCALE compact-encoded unsigned integer.
 * Returns [value, bytesConsumed] or null if buffer too short.
 *
 * Compact encoding modes (2 LSBs of first byte):
 *   0b00 → single-byte mode:  value = byte >> 2          (0..63)
 *   0b01 → two-byte mode:     value = u16 >> 2           (64..16383)
 *   0b10 → four-byte mode:    value = u32 >> 2           (16384..2^30-1)
 *   0b11 → big-integer mode:  upper 6 bits = extra bytes (not supported here)
 */
export function decodeCompact(buf: Buffer, offset: number): [number, number] | null {
    if (offset >= buf.length) return null;

    const mode = buf[offset] & 0x03;

    switch (mode) {
        case 0b00:
            return [buf[offset] >> 2, 1];

        case 0b01:
            if (offset + 1 >= buf.length) return null;
            return [buf.readUInt16LE(offset) >> 2, 2];

        case 0b10:
            if (offset + 3 >= buf.length) return null;
            return [buf.readUInt32LE(offset) >> 2, 4];

        case 0b11:
            // Big-integer mode: (byte >> 2) + 4 = number of following bytes
            // We don't need to decode the actual value, just skip it
            const extraBytes = (buf[offset] >> 2) + 4;
            if (offset + extraBytes >= buf.length) return null;
            return [0, 1 + extraBytes]; // value=0 (we only need to skip)

        default:
            return null;
    }
}

/**
 * Parse a hex-encoded Substrate extrinsic to extract pallet_index and call_index.
 *
 * Extrinsic structure:
 *   [compact_length][version_byte][...payload...]
 *
 * Version byte:
 *   bit 7 = signed flag (0x84 = signed v4, 0x04 = unsigned v4)
 *
 * Unsigned payload:
 *   [pallet_index: u8][call_index: u8][args...]
 *
 * Signed payload:
 *   [address_type: u8][account_id: 32B][sig_type: u8][signature: 64B]
 *   [era: 1-2B][nonce: compact][tip: compact]
 *   [pallet_index: u8][call_index: u8][args...]
 *
 * Returns null on parse failure (safe fallback to existing heuristics).
 */
export function parseExtrinsicCallIndices(hex: string): { palletIndex: number; callIndex: number } | null {
    if (!hex || hex.length < 8) return null;

    // Remove 0x prefix if present
    const cleanHex = hex.startsWith('0x') ? hex.slice(2) : hex;
    if (cleanHex.length < 8) return null;

    let buf: Buffer;
    try {
        buf = Buffer.from(cleanHex, 'hex');
    } catch {
        return null;
    }

    if (buf.length < 4) return null;

    // 1. Skip compact-encoded length prefix
    const lenResult = decodeCompact(buf, 0);
    if (!lenResult) return null;
    let offset = lenResult[1];

    // 2. Read version byte
    if (offset >= buf.length) return null;
    const version = buf[offset];
    offset++;

    const isSigned = (version & 0x80) !== 0;

    if (!isSigned) {
        // Unsigned extrinsic: next 2 bytes are pallet_index + call_index
        if (offset + 1 >= buf.length) return null;
        return { palletIndex: buf[offset], callIndex: buf[offset + 1] };
    }

    // Signed extrinsic: skip signature fields to reach call data

    // Skip address (MultiAddress::Id = 0x00 + 32 bytes AccountId)
    if (offset >= buf.length) return null;
    const addrType = buf[offset];
    offset++;
    if (addrType === 0x00) {
        offset += 32; // AccountId32
    } else if (addrType === 0xff) {
        offset += 32; // Also 32-byte address in some runtimes
    } else {
        // Unknown address type — can't reliably skip
        return null;
    }

    // Skip signature (MultiSignature: type byte + 64 bytes)
    if (offset >= buf.length) return null;
    const sigType = buf[offset];
    offset++;
    if (sigType === 0x00 || sigType === 0x01 || sigType === 0x02) {
        offset += 64; // Ed25519, Sr25519, or Ecdsa (all 64 bytes)
    } else {
        return null;
    }

    // Skip era (Immortal = 1 byte 0x00, Mortal = 2 bytes)
    if (offset >= buf.length) return null;
    if (buf[offset] === 0x00) {
        offset += 1; // Immortal
    } else {
        offset += 2; // Mortal era (2 bytes)
    }

    // Skip nonce (compact-encoded)
    const nonceResult = decodeCompact(buf, offset);
    if (!nonceResult) return null;
    offset += nonceResult[1];

    // Skip tip (compact-encoded)
    const tipResult = decodeCompact(buf, offset);
    if (!tipResult) return null;
    offset += tipResult[1];

    // Now we should be at pallet_index + call_index
    if (offset + 1 >= buf.length) return null;
    return { palletIndex: buf[offset], callIndex: buf[offset + 1] };
}
