// Receipts: the instance signs what a landed sponsored swap or transfer did, for third parties that read neither the board nor this server.
// SPDX-License-Identifier: Apache-2.0
import crypto from 'node:crypto';
import { getEncryptionKey } from '../utils/crypto';
import { configString } from '../utils/config';
import type { BackgroundJob } from '#cds-models/midnight';

export const RECEIPT_ALGORITHM = 'ed25519';
const RECEIPT_VERSION = 1;
const DERIVE_INFO = 'nightgate/receipt-signing/v1';
const RECEIPT_KINDS: ReadonlySet<string> = new Set(['sponsorSwap', 'sponsorTransfer']);
// PKCS#8 header of a raw Ed25519 seed, so Node's key API takes it.
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export interface Receipt {
    payload: string;
    signature: string;
    publicKey: string;
    algorithm: string;
}

interface ReceiptKey { privateKey: crypto.KeyObject; publicKeyHex: string }

let cached: { seedHex: string; key: ReceiptKey } | undefined;

/** The seed from the environment, else one derived from the active encryption key. */
function seedHex(): string {
    const raw = String(configString('NIGHTGATE_RECEIPT_SIGNING_KEY') ?? '').trim().toLowerCase();
    if (raw) {
        if (!/^[0-9a-f]{64}$/.test(raw)) throw new Error('NIGHTGATE_RECEIPT_SIGNING_KEY must be 64 hex characters (a 32-byte Ed25519 seed)');
        return raw;
    }
    const ring = getEncryptionKey();
    return Buffer.from(crypto.hkdfSync('sha256', ring.kek(ring.activeId), 'receipt', DERIVE_INFO, 32)).toString('hex');
}

function receiptKey(): ReceiptKey {
    const seed = seedHex();
    if (cached?.seedHex === seed) return cached.key;
    const privateKey = crypto.createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(seed, 'hex')]), format: 'der', type: 'pkcs8' });
    const spki = crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' }) as Buffer;
    const key = { privateKey, publicKeyHex: spki.subarray(spki.length - 32).toString('hex') };
    cached = { seedHex: seed, key };
    return key;
}

/** The public half of the receipt key, as `getReceiptKey` shows it. */
export function receiptPublicKey(): { publicKey: string; algorithm: string } {
    return { publicKey: receiptKey().publicKeyHex, algorithm: RECEIPT_ALGORITHM };
}

/** JSON with every object's keys sorted, so the same facts always give the same bytes. */
export function canonicalJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (value && typeof value === 'object') {
        const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

/** Signs `payload` with the receipt key. */
export function signReceipt(payload: Record<string, unknown>): Receipt {
    const key = receiptKey();
    const canonical = canonicalJson(payload);
    const signature = crypto.sign(null, Buffer.from(canonical, 'utf8'), key.privateKey).toString('hex');
    return { payload: canonical, signature, publicKey: key.publicKeyHex, algorithm: RECEIPT_ALGORITHM };
}

/** Checks a receipt against a public key. Exported for the tests and the SDK's mirror. */
export function verifyReceipt(receipt: Receipt, publicKeyHex = receipt.publicKey): boolean {
    if (receipt.algorithm !== RECEIPT_ALGORITHM || !/^[0-9a-f]{64}$/.test(publicKeyHex)) return false;
    try {
        const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(publicKeyHex, 'hex')]);
        const key = crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' });
        return crypto.verify(null, Buffer.from(receipt.payload, 'utf8'), key, Buffer.from(receipt.signature, 'hex'));
    } catch {
        return false;
    }
}

/** The receipt of a job, or null: only a sponsored swap or transfer that succeeded on chain gets one. */
export function receiptForJob(job: BackgroundJob, transactionHash: string | null, network: string): Receipt | null {
    if (!RECEIPT_KINDS.has(String(job.kind)) || job.chainStatus !== 'success' || !job.txHash) return null;
    let result: Record<string, unknown> = {};
    try { result = job.result ? JSON.parse(job.result) as Record<string, unknown> : {}; } catch { return null; }
    const terms = job.kind === 'sponsorSwap' ? result.swap : result.transfer;
    if (!terms || typeof terms !== 'object') return null;
    return signReceipt({
        v: RECEIPT_VERSION,
        kind: job.kind === 'sponsorSwap' ? 'swap' : 'transfer',
        jobId: job.ID,
        network,
        txHash: job.txHash,
        transactionHash: transactionHash ?? null,
        blockHeight: job.chainBlockHeight ?? null,
        blockHash: job.chainBlockHash ?? null,
        finalizedAt: job.chainFinalizedAt ?? null,
        ...(job.kind === 'sponsorSwap' ? { swap: terms } : { transfer: terms, declared: true })
    });
}
