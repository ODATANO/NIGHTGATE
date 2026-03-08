/**
 * Minimal SCALE codec helpers for Substrate extrinsic parsing.
 *
 * Includes:
 * - compact integer decoding
 * - pallet/call extraction
 * - signed participant extraction (sender/receiver/amount for transfer-like calls)
 */

interface ParsedAddress {
    address: string;
    nextOffset: number;
}

interface ParsedExtrinsicCore {
    buf: Buffer;
    isSigned: boolean;
    palletIndex: number;
    callIndex: number;
    argsOffset: number;
    senderAddress?: string;
}

export interface ExtrinsicParticipantInfo {
    isSigned: boolean;
    palletIndex: number;
    callIndex: number;
    senderAddress?: string;
    receiverAddress?: string;
    amount?: string;
}

/**
 * Decode a SCALE compact-encoded unsigned integer as bigint.
 * Returns [value, bytesConsumed] or null if buffer too short.
 */
export function decodeCompactBigInt(buf: Buffer, offset: number): [bigint, number] | null {
    if (offset >= buf.length) return null;

    const mode = (buf[offset] & 0x03) as 0 | 1 | 2 | 3;

    switch (mode) {
        case 0b00:
            return [BigInt(buf[offset] >> 2), 1];

        case 0b01:
            if (offset + 1 >= buf.length) return null;
            return [BigInt(buf.readUInt16LE(offset) >> 2), 2];

        case 0b10:
            if (offset + 3 >= buf.length) return null;
            return [BigInt(buf.readUInt32LE(offset) >> 2), 4];

        case 0b11: {
            // Big-integer mode: (first_byte >> 2) + 4 bytes, little-endian
            const byteLength = (buf[offset] >> 2) + 4;
            if (offset + 1 + byteLength > buf.length) return null;

            let value = 0n;
            for (let i = 0; i < byteLength; i++) {
                value += BigInt(buf[offset + 1 + i]) << (8n * BigInt(i));
            }

            return [value, 1 + byteLength];
        }
    }
}

/**
 * Compatibility wrapper for existing callers that expect number values.
 * Values above Number.MAX_SAFE_INTEGER are returned as 0 while preserving bytesConsumed.
 */
export function decodeCompact(buf: Buffer, offset: number): [number, number] | null {
    const decoded = decodeCompactBigInt(buf, offset);
    if (!decoded) return null;

    const [value, consumed] = decoded;
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
        return [0, consumed];
    }

    return [Number(value), consumed];
}

function parseAddress(buf: Buffer, offset: number): ParsedAddress | null {
    if (offset >= buf.length) return null;

    const type = buf[offset];
    let cursor = offset + 1;

    // MultiAddress::Id and runtime-specific 0xff 32-byte address variant
    if (type === 0x00 || type === 0xff || type === 0x03) {
        if (cursor + 32 > buf.length) return null;
        const bytes = buf.slice(cursor, cursor + 32);
        return {
            address: `0x${bytes.toString('hex')}`,
            nextOffset: cursor + 32
        };
    }

    // MultiAddress::Address20
    if (type === 0x04) {
        if (cursor + 20 > buf.length) return null;
        const bytes = buf.slice(cursor, cursor + 20);
        return {
            address: `0x${bytes.toString('hex')}`,
            nextOffset: cursor + 20
        };
    }

    // MultiAddress::Index
    if (type === 0x01) {
        const index = decodeCompactBigInt(buf, cursor);
        if (!index) return null;

        return {
            address: `index:${index[0].toString()}`,
            nextOffset: cursor + index[1]
        };
    }

    // MultiAddress::Raw(Vec<u8>)
    if (type === 0x02) {
        const len = decodeCompactBigInt(buf, cursor);
        if (!len) return null;

        if (len[0] > BigInt(Number.MAX_SAFE_INTEGER)) return null;
        const byteLength = Number(len[0]);
        cursor += len[1];

        if (cursor + byteLength > buf.length) return null;
        const bytes = buf.slice(cursor, cursor + byteLength);
        return {
            address: `0x${bytes.toString('hex')}`,
            nextOffset: cursor + byteLength
        };
    }

    return null;
}

function parseExtrinsicCore(hex: string): ParsedExtrinsicCore | null {
    if (!hex || hex.length < 8) return null;

    const cleanHex = hex.startsWith('0x') ? hex.slice(2) : hex;
    if (cleanHex.length < 8) return null;

    let buf: Buffer;
    try {
        buf = Buffer.from(cleanHex, 'hex');
    } catch {
        return null;
    }

    if (buf.length < 4) return null;

    const lenResult = decodeCompact(buf, 0);
    if (!lenResult) return null;

    let offset = lenResult[1];

    if (offset >= buf.length) return null;
    const version = buf[offset];
    offset++;

    const isSigned = (version & 0x80) !== 0;
    let senderAddress: string | undefined;

    if (isSigned) {
        const signer = parseAddress(buf, offset);
        if (!signer) return null;
        senderAddress = signer.address;
        offset = signer.nextOffset;

        if (offset >= buf.length) return null;
        const sigType = buf[offset];
        offset++;
        if (sigType !== 0x00 && sigType !== 0x01 && sigType !== 0x02) return null;

        if (offset + 64 > buf.length) return null;
        offset += 64;

        if (offset >= buf.length) return null;
        if (buf[offset] === 0x00) {
            offset += 1;
        } else {
            if (offset + 1 >= buf.length) return null;
            offset += 2;
        }

        const nonce = decodeCompact(buf, offset);
        if (!nonce) return null;
        offset += nonce[1];

        const tip = decodeCompact(buf, offset);
        if (!tip) return null;
        offset += tip[1];
    }

    if (offset + 1 >= buf.length) return null;

    return {
        buf,
        isSigned,
        palletIndex: buf[offset],
        callIndex: buf[offset + 1],
        argsOffset: offset + 2,
        senderAddress
    };
}

/**
 * Parse a hex-encoded Substrate extrinsic to extract pallet_index and call_index.
 * Returns null on parse failure (safe fallback to existing heuristics).
 */
export function parseExtrinsicCallIndices(hex: string): { palletIndex: number; callIndex: number } | null {
    const core = parseExtrinsicCore(hex);
    if (!core) return null;
    return {
        palletIndex: core.palletIndex,
        callIndex: core.callIndex
    };
}

/**
 * Extract signed sender + first transfer-style destination/amount, if present.
 *
 * This parser is intentionally conservative: receiver/amount are set only when
 * the first call args decode as MultiAddress + Compact<Balance>.
 */
export function parseExtrinsicParticipantInfo(hex: string): ExtrinsicParticipantInfo | null {
    const core = parseExtrinsicCore(hex);
    if (!core) return null;

    const result: ExtrinsicParticipantInfo = {
        isSigned: core.isSigned,
        palletIndex: core.palletIndex,
        callIndex: core.callIndex,
        senderAddress: core.senderAddress
    };

    const destination = parseAddress(core.buf, core.argsOffset);
    if (!destination) {
        return result;
    }

    const amount = decodeCompactBigInt(core.buf, destination.nextOffset);
    if (!amount) {
        return result;
    }

    result.receiverAddress = destination.address;
    result.amount = amount[0].toString();
    return result;
}
