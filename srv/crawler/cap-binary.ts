/**
 * Reading a `LargeBinary` back from CAP.
 *
 * The value arrives as a Buffer, a base64 string or a Readable of bytes
 * depending on the driver and the query, and a stream that is not drained
 * reads as an object rather than failing, which is the trap.
 */

export async function readCapBinary(value: unknown): Promise<Buffer | null> {
    if (value == null) return null;
    if (Buffer.isBuffer(value)) return value;
    if (value instanceof Uint8Array) return Buffer.from(value);
    if (typeof value === 'string') return Buffer.from(value, 'base64');
    if (typeof (value as any)[Symbol.asyncIterator] === 'function') {
        const chunks: Buffer[] = [];
        for await (const chunk of value as AsyncIterable<Buffer | string>) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        return Buffer.concat(chunks);
    }
    return null;
}
