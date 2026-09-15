/**
 * Byte-exact wire format of the Midnight SDK's LevelDB private-state encryption, for cross-import:
 * base64(version 2 | salt 32 | iv 12 | tag 16 | AES-256-GCM ciphertext), key = PBKDF2-SHA256(password, salt, 600k).
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

/** Mirrors the SDK's StorageEncryption; one instance per (password, salt). */
export class StorageEncryption {
    readonly salt: Buffer;
    private readonly encryptionKey: Buffer;
    private cleared = false;

    constructor(password: string, existingSalt?: Buffer, precomputedKey?: Buffer) {
        this.salt          = existingSalt ?? crypto.randomBytes(SALT_LENGTH);
        this.encryptionKey = precomputedKey ?? deriveKey(password, this.salt);
    }

    /** Zero the derived key; encrypt/decrypt throw afterwards instead of emitting garbage. */
    clear(): void {
        this.encryptionKey.fill(0);
        this.cleared = true;
    }

    private assertUsable(): void {
        if (this.cleared) throw new Error('StorageEncryption: key has been cleared');
    }

    /** Construct with PBKDF2 on the libuv threadpool instead of the event loop. */
    static async createAsync(password: string, salt: Buffer): Promise<StorageEncryption> {
        const key = await deriveKeyAsync(password, salt);
        return new StorageEncryption(password, salt, key);
    }

    /** Encrypts `data` (UTF-8 string) and returns base64-encoded SDK wire format. */
    encrypt(data: string): string {
        this.assertUsable();
        const plaintext = Buffer.from(data, 'utf-8');
        const iv        = crypto.randomBytes(IV_LENGTH);
        const cipher    = crypto.createCipheriv(ALGORITHM, this.encryptionKey, iv);
        const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
        const authTag   = cipher.getAuthTag();
        const version   = Buffer.from([CURRENT_ENCRYPTION_VERSION]);
        return Buffer.concat([version, this.salt, iv, authTag, encrypted]).toString('base64');
    }

    /** Decrypt an SDK-format payload; its salt must match this instance's. */
    decrypt(encryptedData: string): string {
        this.assertUsable();
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

/** Same derivation as `deriveKey`, on the libuv threadpool (non-blocking). */
export function deriveKeyAsync(password: string, salt: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        crypto.pbkdf2(password, salt, PBKDF2_ITERATIONS_V2, KEY_LENGTH, 'sha256',
            (err, key) => (err ? reject(err) : resolve(key)));
    });
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

/** Decrypt an SDK-format payload, deriving the key from its embedded salt. */
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
