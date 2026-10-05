/**
 * CAP returns a `LargeBinary` as a Buffer, a base64 string or a byte stream, depending on the driver.
 * A stream that is not drained looks like a plain object instead of failing.
 */
import type { Readable } from 'node:stream';

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

/** CAP writes a base64 string into a `LargeBinary`; cds-typer types the column as a stream only. */
export function capBinaryInput(base64: string): Readable {
    return base64 as unknown as Readable;
}
