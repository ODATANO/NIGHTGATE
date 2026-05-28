/**
 * SDK-compatible storage encryption for private state and signing key blobs.
 *
 * Implements the EXACT wire format used by the Midnight JS SDK's LevelDB
 * private-state provider so that exports produced by NIGHTGATE's CAP-DB
 * provider can be imported by the SDK's LevelDB provider, and vice versa.
 *
 * Wire format of an encrypted payload (base64-decoded):
 *
 *   [ 1 byte  version    = 2          ]
 *   [ 32 bytes salt      (PBKDF2)     ]
 *   [ 12 bytes IV        (GCM nonce)  ]
 *   [ 16 bytes authTag   (GCM tag)    ]
 *   [ N bytes  ciphertext (AES-256-GCM) ]
 *
 * Key derivation: PBKDF2-SHA256(password, salt, 600_000, 32 bytes).
 *
 * For internal CAP-DB storage we use a memoized per-account master key
 * (one PBKDF2 per session, not per row), the SDK's LevelDB provider does
 * the same. Export blobs always include their own salt and re-derive,
 * preserving cross-compat.
 */

import crypto from 'crypto';

export const ALGORITHM                  = 'aes-256-gcm';
export const KEY_LENGTH                 = 32;   // AES-256
export const IV_LENGTH                  = 12;   // GCM standard
export const AUTH_TAG_LENGTH            = 16;
export const SALT_LENGTH                = 32;
export const PBKDF2_ITERATIONS_V2       = 600_000;
export const ENCRYPTION_VERSION_V2      = 2;
export const CURRENT_ENCRYPTION_VERSION = ENCRYPTION_VERSION_V2;

const VERSION_PREFIX_LENGTH = 1;
const HEADER_LENGTH         = VERSION_PREFIX_LENGTH + SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH;

/**
 * Mirrors the SDK's StorageEncryption class for byte-compatibility.
 * One instance ↔ one (password, salt) pair.
 */
export class StorageEncryption {
    readonly salt: Buffer;
    private readonly encryptionKey: Buffer;

    constructor(password: string, existingSalt?: Buffer) {
        this.salt          = existingSalt ?? crypto.randomBytes(SALT_LENGTH);
        this.encryptionKey = deriveKey(password, this.salt);
    }

    /** Encrypts `data` (UTF-8 string) and returns base64-encoded SDK wire format. */
    encrypt(data: string): string {
        const plaintext = Buffer.from(data, 'utf-8');
        const iv        = crypto.randomBytes(IV_LENGTH);
        const cipher    = crypto.createCipheriv(ALGORITHM, this.encryptionKey, iv);
        const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
        const authTag   = cipher.getAuthTag();
        const version   = Buffer.from([CURRENT_ENCRYPTION_VERSION]);
        return Buffer.concat([version, this.salt, iv, authTag, encrypted]).toString('base64');
    }

    /**
     * Decrypts an SDK-format base64 payload. The salt in the payload must match
     * this instance's salt (i.e. the same password was used).
     */
    decrypt(encryptedData: string): string {
        const data = Buffer.from(encryptedData, 'base64');
        const { version, salt, iv, authTag, encrypted } = extractEncryptedComponents(data);
        if (version !== CURRENT_ENCRYPTION_VERSION) {
            throw new Error(`Unsupported encryption version: ${version}`);
        }
        if (!this.salt.equals(salt)) {
            throw new Error('Salt mismatch: data was encrypted with a different password/salt');
        }
        const decipher = crypto.createDecipheriv(ALGORITHM, this.encryptionKey, iv, { authTagLength: AUTH_TAG_LENGTH });
        decipher.setAuthTag(authTag);
        const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
        return decrypted.toString('utf-8');
    }
}

export function deriveKey(password: string, salt: Buffer): Buffer {
    return crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS_V2, KEY_LENGTH, 'sha256');
}

export interface EncryptedComponents {
    version: number;
    salt:    Buffer;
    iv:      Buffer;
    authTag: Buffer;
    encrypted: Buffer;
}

export function extractEncryptedComponents(data: Buffer): EncryptedComponents {
    if (data.length < HEADER_LENGTH) {
        throw new Error('Invalid encrypted data: too short');
    }
    const version = data[0];
    if (version !== CURRENT_ENCRYPTION_VERSION) {
        throw new Error(`Unsupported encryption version: ${version}`);
    }
    return {
        version,
        salt:      data.subarray(VERSION_PREFIX_LENGTH, VERSION_PREFIX_LENGTH + SALT_LENGTH),
        iv:        data.subarray(VERSION_PREFIX_LENGTH + SALT_LENGTH, VERSION_PREFIX_LENGTH + SALT_LENGTH + IV_LENGTH),
        authTag:   data.subarray(VERSION_PREFIX_LENGTH + SALT_LENGTH + IV_LENGTH, HEADER_LENGTH),
        encrypted: data.subarray(HEADER_LENGTH)
    };
}

/**
 * Decrypts an SDK-format base64 payload given a password. Re-derives the key
 * from the salt embedded in the payload. Used for import where we don't yet
 * know the salt.
 */
export function decryptWithPassword(encryptedData: string, password: string): string {
    const data = Buffer.from(encryptedData, 'base64');
    const { version, salt, iv, authTag, encrypted } = extractEncryptedComponents(data);
    if (version !== CURRENT_ENCRYPTION_VERSION) {
        throw new Error(`Unsupported encryption version: ${version}`);
    }
    const key      = deriveKey(password, salt);
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString('utf-8');
}
