import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { readCapBinary, capBinaryInput } from '../../srv/crawler/cap-binary';

describe('cap-binary: one shape for a LargeBinary on every driver', () => {
    const bytes = Buffer.from('midnight:contract-state[v6]:payload');

    it('capBinaryInput hands the driver the decoded bytes, never the base64 text', () => {
        const value = capBinaryInput(bytes.toString('base64')) as unknown;
        expect(Buffer.isBuffer(value)).toBe(true);
        expect((value as Buffer).equals(bytes)).toBe(true);
    });

    it('readCapBinary takes a Buffer, a base64 string and a stream of chunks', async () => {
        expect((await readCapBinary(bytes))?.equals(bytes)).toBe(true);
        expect((await readCapBinary(bytes.toString('base64')))?.equals(bytes)).toBe(true);
        expect((await readCapBinary(Readable.from([bytes.subarray(0, 10), bytes.subarray(10)])))?.equals(bytes)).toBe(true);
        expect(await readCapBinary(null)).toBeNull();
    });
});
