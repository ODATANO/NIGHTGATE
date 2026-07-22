/**
 * Wallet-session crypto: AES-256-GCM encryption for viewing keys at rest,
 * SHA-256 hashing for viewing-key lookup/dedup.
 */

import crypto from 'crypto';
import os from 'os';
import cds from '@sap/cds';

const log = cds.log('nightgate:crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;        // 96 bits, recommended for GCM
const AUTH_TAG_LENGTH = 16;  // 128 bits

/**
 * Derive the 32-byte encryption key from environment or fallback.
 *
 * Production: Set ENCRYPTION_KEY environment variable.
 * Development: Falls back to a process-scoped key (keys lost on restart, acceptable for dev).
 */
export function getEncryptionKey(): Buffer {
    const envKey = process.env.ENCRYPTION_KEY;
    if (envKey) {
        // The value is folded to 32 bytes with SHA-256, which provides no
        // stretching. A short human passphrase therefore has weak effective
        // entropy: warn so operators supply a high-entropy secret (hex/base64
        // of >= 32 bytes). Derivation itself is unchanged to keep existing
        // ciphertext decryptable.
        if (envKey.length < 32) {
            log.warn('ENCRYPTION_KEY is shorter than 32 characters. Use a high-entropy 32+ byte secret (hex or base64); the value is SHA-256-folded and short passphrases are not stretched.');
        }
        return crypto.createHash('sha256').update(envKey).digest();
    }
    if (process.env.NODE_ENV === 'production') {
        throw new Error('ENCRYPTION_KEY must be set in production. Refusing to start with fallback key.');
    }
    // Dev fallback: derive from stable-per-process value
    log.warn('ENCRYPTION_KEY not set. Using dev fallback key. Set ENCRYPTION_KEY for production.');
    const fallback = `odatano-night-${process.pid}-${os.hostname()}`;
    return crypto.createHash('sha256').update(fallback).digest();
}

/**
 * Encrypt plaintext using AES-256-GCM.
 * Returns combined format: base64(iv):base64(authTag):base64(ciphertext)
 */
export function encrypt(plaintext: string, key: Buffer): string {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return `${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted.toString('base64')}`;
}

/**
 * Decrypt a combined string back to plaintext.
 * Throws on authentication failure (tampered ciphertext or wrong key).
 */
export function decrypt(combined: string, key: Buffer): string {
    const parts = combined.split(':');
    if (parts.length !== 3) {
        throw new Error('Invalid encrypted format: expected iv:authTag:ciphertext');
    }
    const [ivB64, tagB64, dataB64] = parts;
    const iv = Buffer.from(ivB64, 'base64');
    const authTag = Buffer.from(tagB64, 'base64');
    const encrypted = Buffer.from(dataB64, 'base64');
    if (iv.length !== IV_LENGTH) {
        throw new Error(`Invalid IV length: expected ${IV_LENGTH} bytes, got ${iv.length}`);
    }
    if (authTag.length !== AUTH_TAG_LENGTH) {
        throw new Error(`Invalid auth tag length: expected ${AUTH_TAG_LENGTH} bytes, got ${authTag.length}`);
    }
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString('utf8');
}

/**
 * SHA-256 hash of a viewing key for lookup/dedup purposes.
 * Returns 64-character hex string.
 */
export function hashViewingKey(viewingKey: string): string {
    return crypto.createHash('sha256').update(viewingKey).digest('hex');
}
