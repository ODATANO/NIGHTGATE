/**
 * Receipts: the instance signs what a landed sponsored swap or transfer did.
 * The key comes from the environment or is derived from the encryption key; the payload is canonical JSON.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { canonicalJson, receiptForJob, receiptPublicKey, signReceipt, verifyReceipt } from '../../srv/submission/receipts';

const SEED = '11'.repeat(32);

describe('receipts', () => {
    beforeEach(() => { process.env.NIGHTGATE_RECEIPT_SIGNING_KEY = SEED; });
    afterEach(() => { delete process.env.NIGHTGATE_RECEIPT_SIGNING_KEY; });

    it('canonicalJson sorts keys at every level and drops undefined', () => {
        expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: undefined }], c: 'x' } })).toBe('{"a":{"c":"x","d":[2,{"z":1}]},"b":1}');
    });

    it('signs with the configured seed and verifies against the published key', () => {
        const key = receiptPublicKey();
        expect(key).toEqual({ publicKey: expect.stringMatching(/^[0-9a-f]{64}$/), algorithm: 'ed25519' });
        const receipt = signReceipt({ kind: 'swap', txHash: 'ab' });
        expect(receipt.publicKey).toBe(key.publicKey);
        expect(receipt.payload).toBe('{"kind":"swap","txHash":"ab"}');
        expect(verifyReceipt(receipt)).toBe(true);
        expect(verifyReceipt({ ...receipt, payload: '{"kind":"swap","txHash":"ac"}' })).toBe(false);
        expect(verifyReceipt(receipt, '22'.repeat(32))).toBe(false);
        expect(verifyReceipt({ ...receipt, algorithm: 'rsa' })).toBe(false);
        // the same facts always give the same signature
        expect(signReceipt({ txHash: 'ab', kind: 'swap' })).toEqual(receipt);
    });

    it('a malformed seed is refused; without one the key derives from the encryption key', () => {
        process.env.NIGHTGATE_RECEIPT_SIGNING_KEY = 'nope';
        expect(() => receiptPublicKey()).toThrow(/NIGHTGATE_RECEIPT_SIGNING_KEY must be 64 hex/);
        delete process.env.NIGHTGATE_RECEIPT_SIGNING_KEY;
        const derived = receiptPublicKey().publicKey;
        expect(derived).toMatch(/^[0-9a-f]{64}$/);
        expect(derived).toBe(receiptPublicKey().publicKey);
    });

    it('receiptForJob covers only a landed sponsored swap or transfer and repeats its terms', () => {
        const job = (over: Record<string, unknown>) => ({
            ID: 'job-1', kind: 'sponsorSwap', chainStatus: 'success', txHash: 'ab'.repeat(32), chainBlockHeight: 42, chainBlockHash: 'cd'.repeat(32),
            chainFinalizedAt: '2026-10-28T20:00:00.000Z',
            result: JSON.stringify({ swap: { gives: { tokenType: 'a1', amount: '5' }, wants: { tokenType: 'b2', amount: '7' } } }),
            ...over
        }) as any;
        const receipt = receiptForJob(job({}), 'ef'.repeat(32), 'preprod');
        expect(receipt).not.toBeNull();
        expect(JSON.parse(receipt!.payload)).toEqual({
            v: 1, kind: 'swap', jobId: 'job-1', network: 'preprod', txHash: 'ab'.repeat(32), transactionHash: 'ef'.repeat(32),
            blockHeight: 42, blockHash: 'cd'.repeat(32), finalizedAt: '2026-10-28T20:00:00.000Z',
            swap: { gives: { tokenType: 'a1', amount: '5' }, wants: { tokenType: 'b2', amount: '7' } }
        });
        expect(verifyReceipt(receipt!)).toBe(true);
        const transfer = receiptForJob(job({ kind: 'sponsorTransfer', result: JSON.stringify({ transfer: { tokenType: 'a1', amount: '5' } }) }), null, 'preprod');
        expect(JSON.parse(transfer!.payload)).toMatchObject({ kind: 'transfer', declared: true, transfer: { tokenType: 'a1', amount: '5' }, transactionHash: null });
        expect(receiptForJob(job({ chainStatus: 'pending' }), null, 'preprod')).toBeNull();
        expect(receiptForJob(job({ kind: 'sponsorUnboundTransaction' }), null, 'preprod')).toBeNull();
        expect(receiptForJob(job({ result: '{}' }), null, 'preprod')).toBeNull();
        expect(receiptForJob(job({ result: 'not json' }), null, 'preprod')).toBeNull();
    });
});
