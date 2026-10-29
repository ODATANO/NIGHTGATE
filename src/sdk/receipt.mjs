// Checks the receipts a NIGHTGATE instance signs for landed sponsored swaps and transfers.
// SPDX-License-Identifier: Apache-2.0

import crypto from 'node:crypto';

const RECEIPT_ALGORITHM = 'ed25519';
// SubjectPublicKeyInfo header of a raw Ed25519 public key.
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** True when the signature covers the payload under `publicKeyHex`; pass the key from getReceiptKey(), the receipt's own key only proves consistency. */
export function verifyReceipt(receipt, publicKeyHex = receipt?.publicKey) {
    if (!receipt || receipt.algorithm !== RECEIPT_ALGORITHM) return false;
    if (typeof publicKeyHex !== 'string' || !/^[0-9a-f]{64}$/.test(publicKeyHex)) return false;
    if (typeof receipt.payload !== 'string' || typeof receipt.signature !== 'string' || !/^[0-9a-f]{128}$/.test(receipt.signature)) return false;
    try {
        const key = crypto.createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(publicKeyHex, 'hex')]), format: 'der', type: 'spki' });
        return crypto.verify(null, Buffer.from(receipt.payload, 'utf8'), key, Buffer.from(receipt.signature, 'hex'));
    } catch {
        return false;
    }
}
