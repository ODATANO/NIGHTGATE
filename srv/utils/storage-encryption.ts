/**
 * The same encryption format the Midnight SDK uses for its LevelDB private state, so data can move between both.
 * Layout, base64 encoded: version byte, 32-byte salt, 12-byte IV, 16-byte tag, then AES-256-GCM ciphertext.
 * The key is PBKDF2-SHA256 over the password and salt with 600,000 rounds.
 */

import crypto from 'crypto';

export const ALGORITHM                  = 'aes-256-gcm';
export const KEY_LENGTH                 = 32;
export const IV_LENGTH                  = 12;
export const AUTH_TAG_LENGTH            = 16;
export const SALT_LENGTH                = 32;
export const PBKDF2_ITERATIONS_V2       = 600_000;
export const ENCRYPTION_VERSION_V2      = 2;
export const CURRENT_ENCRYPTION_VERSION = ENCRYPTION_VERSION_V2;

const VERSION_PREFIX_LENGTH = 1;
const HEADER_LENGTH         = VERSION_PREFIX_LENGTH + SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH;

/** Same behaviour as the SDK's StorageEncryption. One instance per password and salt. */
export class StorageEncryption {
    readonly salt: Buffer;
    private readonly encryptionKey: Buffer;
    private cleared = false;

    constructor(password: string, existingSalt?: Buffer, precomputedKey?: Buffer) {
        this.salt          = existingSalt ?? crypto.randomBytes(SALT_LENGTH);
        this.encryptionKey = precomputedKey ?? deriveKey(password, this.salt);
    }

    /** Wipes the key from memory. Encrypt and decrypt throw afterwards. */
    clear(): void {
        this.encryptionKey.fill(0);
        this.cleared = true;
    }

    private assertUsable(): void {
        if (this.cleared) throw new Error('StorageEncryption: key has been cleared');
    }

    /** Creates an instance without blocking the event loop while the key is derived. */
    static async createAsync(password: string, salt: Buffer): Promise<StorageEncryption> {
        const key = await deriveKeyAsync(password, salt);
        return new StorageEncryption(password, salt, key);
    }

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

    /** Decrypts data in the SDK format. Its salt must match this instance's salt. */
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

/** Same as `deriveKey`, but does not block the event loop. */
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

/** Decrypts data in the SDK format, using the salt stored inside it. Derives the key on the calling thread. */
export function decryptWithPassword(encryptedData: string, password: string): string {
    const parts = checkedComponents(encryptedData);
    return decryptComponents(parts, deriveKey(password, parts.salt));
}

/** Same as `decryptWithPassword`, but derives the key without blocking the event loop. */
export async function decryptWithPasswordAsync(encryptedData: string, password: string): Promise<string> {
    const parts = checkedComponents(encryptedData);
    return decryptComponents(parts, await deriveKeyAsync(password, parts.salt));
}

function checkedComponents(encryptedData: string): EncryptedComponents {
    const parts = extractEncryptedComponents(Buffer.from(encryptedData, 'base64'));
    if (parts.version !== CURRENT_ENCRYPTION_VERSION) {
        throw new Error(`Unsupported encryption version: ${parts.version}`);
    }
    return parts;
}

function decryptComponents({ iv, authTag, encrypted }: EncryptedComponents, key: Buffer): string {
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf-8');
}
