/**
 * At-rest encryption for wallet material and persisted job commands.
 *
 * Key ring: `ENCRYPTION_KEYS="id=secret,id=secret"` plus
 * `ENCRYPTION_KEY_ACTIVE=<id>`; the legacy single `ENCRYPTION_KEY` joins the
 * ring as id `1` (active when it is the only key). Every secret is stretched
 * with HKDF-SHA256 into a 32-byte key-encryption key (KEK).
 *
 * Envelope format (written for every new ciphertext):
 *
 *   v2:<keyId>:<wrappedDek>:<iv>:<tag>:<data>
 *
 * A random 32-byte data key (DEK) encrypts the payload with AES-256-GCM; the
 * DEK is wrapped with the KEK (AES-256-GCM, `wrappedDek` = iv || tag ||
 * ciphertext). The key id is the AAD of both layers, so a ciphertext cannot
 * be re-labelled to another key. Legacy v1 ciphertexts (`iv:tag:data`, key =
 * SHA-256 fold of the secret) stay readable under id `1` only; the rewrap
 * tool (`nightgate-rewrap-keys`) rewrites them.
 *
 * A raw 32-byte Buffer is accepted wherever a ring is: it acts as a
 * single-key ring with id `1` whose KEK (and v1 key) is the buffer itself.
 */

import crypto from 'crypto';
import cds from '@sap/cds';

const log = cds.log('nightgate:crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;        // 96 bits, recommended for GCM
const AUTH_TAG_LENGTH = 16;  // 128 bits
const DEK_LENGTH = 32;
const KEK_LENGTH = 32;
const WRAPPED_DEK_LENGTH = IV_LENGTH + AUTH_TAG_LENGTH + DEK_LENGTH;

export const ENVELOPE_VERSION = 'v2';
export const LEGACY_KEY_ID = '1';
export const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,16}$/;
const KEK_INFO = 'nightgate/kek/v2';

/** Thrown when a ciphertext names a key id the ring does not hold. */
export class UnknownEncryptionKeyError extends Error {
    readonly keyId: string;
    constructor(keyId: string) {
        super(`ciphertext is encrypted under key id '${keyId}', which is not in the encryption key ring (ENCRYPTION_KEYS); add the key or run nightgate-rewrap-keys before removing it`);
        this.name = 'UnknownEncryptionKeyError';
        this.keyId = keyId;
    }
}

/** Serializable ring definition (secrets included): env parse result and worker transport. */
export interface KeyRingSpec {
    activeId: string;
    keys: Array<{ id: string; secret: string }>;
}

/** Derive the KEK for one ring member. */
export function deriveKek(id: string, secret: string): Buffer {
    return Buffer.from(crypto.hkdfSync('sha256', secret, id, KEK_INFO, KEK_LENGTH));
}

/** The pre-0.23 key: SHA-256 fold of the secret, no stretching. Reads v1 ciphertexts only. */
export function legacyFold(secret: string): Buffer {
    return crypto.createHash('sha256').update(secret).digest();
}

export class KeyRing {
    readonly activeId: string;
    private readonly keks = new Map<string, Buffer>();
    private readonly legacyKeys = new Map<string, Buffer>();
    private readonly spec: KeyRingSpec | undefined;

    constructor(spec: KeyRingSpec) {
        if (!spec.keys.length) throw new Error('encryption key ring is empty');
        for (const { id, secret } of spec.keys) {
            if (!KEY_ID_PATTERN.test(id)) throw new Error(`invalid encryption key id '${id}' (allowed: [A-Za-z0-9_-]{1,16})`);
            if (!secret) throw new Error(`encryption key '${id}' has an empty secret`);
            if (this.keks.has(id)) throw new Error(`duplicate encryption key id '${id}'`);
            this.keks.set(id, deriveKek(id, secret));
            if (id === LEGACY_KEY_ID) this.legacyKeys.set(id, legacyFold(secret));
        }
        if (!this.keks.has(spec.activeId)) throw new Error(`ENCRYPTION_KEY_ACTIVE='${spec.activeId}' is not in the encryption key ring`);
        this.activeId = spec.activeId;
        this.spec = { activeId: spec.activeId, keys: spec.keys.map(k => ({ ...k })) };
    }

    /** A ring made of one raw KEK under id `1` (tests, callers holding a Buffer). */
    static fromKek(kek: Buffer): KeyRing {
        if (kek.length !== KEK_LENGTH) throw new Error(`encryption key must be ${KEK_LENGTH} bytes, got ${kek.length}`);
        const ring = Object.create(KeyRing.prototype) as KeyRing;
        (ring as any).keks = new Map([[LEGACY_KEY_ID, kek]]);
        (ring as any).legacyKeys = new Map([[LEGACY_KEY_ID, kek]]);
        (ring as any).activeId = LEGACY_KEY_ID;
        (ring as any).spec = undefined;
        return ring;
    }

    ids(): string[] { return [...this.keks.keys()]; }
    has(id: string): boolean { return this.keks.has(id); }

    kek(id: string): Buffer {
        const k = this.keks.get(id);
        if (!k) throw new UnknownEncryptionKeyError(id);
        return k;
    }

    /** The v1 key for `id`; only id `1` has one. */
    legacyKey(id: string): Buffer | undefined { return this.legacyKeys.get(id); }

    /** Ring definition for transport into the worker thread (`workerData`); undefined for a raw-KEK ring. */
    toSpec(): KeyRingSpec | undefined {
        return this.spec ? { activeId: this.spec.activeId, keys: this.spec.keys.map(k => ({ ...k })) } : undefined;
    }
}

export type EncryptionKey = Buffer | KeyRing;

function asRing(key: EncryptionKey): KeyRing {
    return Buffer.isBuffer(key) ? KeyRing.fromKek(key) : key;
}

// ---- Ring resolution ---------------------------------------------------------

/**
 * Parse the ring from the environment. `ENCRYPTION_KEYS` entries are
 * `id=secret`; the legacy `ENCRYPTION_KEY` is id `1`. With a single member
 * `ENCRYPTION_KEY_ACTIVE` is optional. Returns undefined when nothing is set.
 */
export function parseKeyRingSpec(env: NodeJS.ProcessEnv = process.env): KeyRingSpec | undefined {
    const keys: Array<{ id: string; secret: string }> = [];
    const list = String(env.ENCRYPTION_KEYS ?? '').trim();
    if (list) {
        for (const raw of list.split(',')) {
            const entry = raw.trim();
            if (!entry) continue;
            const eq = entry.indexOf('=');
            if (eq <= 0) throw new Error(`ENCRYPTION_KEYS entry '${entry.slice(0, 8)}…' is not id=secret`);
            keys.push({ id: entry.slice(0, eq).trim(), secret: entry.slice(eq + 1).trim() });
        }
    }
    const legacy = String(env.ENCRYPTION_KEY ?? '');
    if (legacy) {
        const existing = keys.find(k => k.id === LEGACY_KEY_ID);
        if (existing && existing.secret !== legacy) throw new Error(`ENCRYPTION_KEY and ENCRYPTION_KEYS both define key id '${LEGACY_KEY_ID}' with different secrets`);
        if (!existing) keys.push({ id: LEGACY_KEY_ID, secret: legacy });
    }
    if (!keys.length) return undefined;
    const active = String(env.ENCRYPTION_KEY_ACTIVE ?? '').trim();
    if (!active && keys.length > 1) throw new Error('ENCRYPTION_KEY_ACTIVE is required when the encryption key ring holds more than one key');
    return { activeId: active || keys[0].id, keys };
}

function isProduction(): boolean {
    if (process.env.NODE_ENV === 'production') return true;
    try { return (cds as any)?.env?.production === true; } catch { return false; }
}

let pinnedRing: KeyRing | undefined;
let cachedRing: { snapshot: string; ring: KeyRing } | undefined;
let devFallback: KeyRing | undefined;

/**
 * Pin the ring explicitly (worker thread: the main thread hands the resolved
 * ring over in `workerData`, the worker never parses the environment).
 */
export function setKeyRing(spec: KeyRingSpec | undefined): void {
    pinnedRing = spec ? new KeyRing(spec) : undefined;
}

/**
 * Resolve the process key ring: pinned ring, else environment, else (never
 * in production) a random per-process dev key that no restart can reproduce.
 */
export function getEncryptionKey(): KeyRing {
    if (pinnedRing) return pinnedRing;
    // Resolve the profile first: touching cds.env loads the project's .env
    // into process.env, which the snapshot below must already see.
    const production = isProduction();
    const snapshot = `${process.env.ENCRYPTION_KEYS ?? ''}\u0000${process.env.ENCRYPTION_KEY_ACTIVE ?? ''}\u0000${process.env.ENCRYPTION_KEY ?? ''}`;
    if (cachedRing && cachedRing.snapshot === snapshot) return cachedRing.ring;
    const spec = parseKeyRingSpec();
    if (spec) {
        for (const k of spec.keys) {
            if (k.secret.length < 32) log.warn(`encryption key '${k.id}' is shorter than 32 characters; use a high-entropy 32+ byte secret (hex or base64)`);
        }
        cachedRing = { snapshot, ring: new KeyRing(spec) };
        return cachedRing.ring;
    }
    if (production) {
        throw new Error('ENCRYPTION_KEY must be set in production. Refusing to start with fallback key.');
    }
    if (!devFallback) {
        log.warn('ENCRYPTION_KEY not set. Using a random per-process dev key: encrypted rows do not survive a restart. Set ENCRYPTION_KEY for anything but local development.');
        devFallback = new KeyRing({ activeId: 'dev', keys: [{ id: 'dev', secret: crypto.randomBytes(32).toString('hex') }] });
    }
    return devFallback;
}

/** Test-only: drop the memoized rings. */
export function __resetKeyRingForTests(): void {
    pinnedRing = undefined;
    cachedRing = undefined;
    devFallback = undefined;
}

// ---- Envelope ----------------------------------------------------------------

function aad(keyId: string): Buffer {
    return Buffer.from(`${ENVELOPE_VERSION}:${keyId}`, 'utf8');
}

function gcmEncrypt(key: Buffer, plaintext: Buffer, associated: Buffer): { iv: Buffer; tag: Buffer; data: Buffer } {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
    cipher.setAAD(associated);
    const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return { iv, tag: cipher.getAuthTag(), data };
}

function gcmDecrypt(key: Buffer, iv: Buffer, tag: Buffer, data: Buffer, associated?: Buffer): Buffer {
    if (iv.length !== IV_LENGTH) throw new Error(`Invalid IV length: expected ${IV_LENGTH} bytes, got ${iv.length}`);
    if (tag.length !== AUTH_TAG_LENGTH) throw new Error(`Invalid auth tag length: expected ${AUTH_TAG_LENGTH} bytes, got ${tag.length}`);
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
    if (associated) decipher.setAAD(associated);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]);
}

/** Encrypt under the ring's ACTIVE key: `v2:<keyId>:<wrappedDek>:<iv>:<tag>:<data>`. */
export function encrypt(plaintext: string, key: EncryptionKey): string {
    const ring = asRing(key);
    const keyId = ring.activeId;
    const associated = aad(keyId);
    const dek = crypto.randomBytes(DEK_LENGTH);
    try {
        const payload = gcmEncrypt(dek, Buffer.from(plaintext, 'utf8'), associated);
        const wrap = gcmEncrypt(ring.kek(keyId), dek, associated);
        const wrappedDek = Buffer.concat([wrap.iv, wrap.tag, wrap.data]);
        return [ENVELOPE_VERSION, keyId, wrappedDek.toString('base64'), payload.iv.toString('base64'), payload.tag.toString('base64'), payload.data.toString('base64')].join(':');
    } finally {
        dek.fill(0);
    }
}

/** Version and key id of a stored ciphertext without decrypting it. */
export function inspectCiphertext(combined: string): { version: 1 | 2; keyId: string } {
    const parts = combined.split(':');
    if (parts.length === 3) return { version: 1, keyId: LEGACY_KEY_ID };
    if (parts.length === 6 && parts[0] === ENVELOPE_VERSION) {
        if (!KEY_ID_PATTERN.test(parts[1])) throw new Error(`Invalid encrypted format: bad key id '${parts[1]}'`);
        return { version: 2, keyId: parts[1] };
    }
    throw new Error('Invalid encrypted format: expected v2:keyId:wrappedDek:iv:authTag:ciphertext or iv:authTag:ciphertext');
}

/**
 * Decrypt a v2 envelope or a legacy v1 ciphertext. Throws on authentication
 * failure (tampered ciphertext or wrong key) and `UnknownEncryptionKeyError`
 * when the ring lacks the ciphertext's key id.
 */
export function decrypt(combined: string, key: EncryptionKey): string {
    const ring = asRing(key);
    const { version, keyId } = inspectCiphertext(combined);
    const parts = combined.split(':');
    if (version === 1) {
        const legacy = ring.legacyKey(keyId);
        if (!legacy) throw new UnknownEncryptionKeyError(keyId);
        const [ivB64, tagB64, dataB64] = parts;
        return gcmDecrypt(legacy, Buffer.from(ivB64, 'base64'), Buffer.from(tagB64, 'base64'), Buffer.from(dataB64, 'base64')).toString('utf8');
    }
    const [, , wrappedB64, ivB64, tagB64, dataB64] = parts;
    const wrapped = Buffer.from(wrappedB64, 'base64');
    if (wrapped.length !== WRAPPED_DEK_LENGTH) throw new Error(`Invalid wrapped key length: expected ${WRAPPED_DEK_LENGTH} bytes, got ${wrapped.length}`);
    const associated = aad(keyId);
    const dek = gcmDecrypt(
        ring.kek(keyId),
        wrapped.subarray(0, IV_LENGTH),
        wrapped.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH),
        wrapped.subarray(IV_LENGTH + AUTH_TAG_LENGTH),
        associated
    );
    try {
        return gcmDecrypt(dek, Buffer.from(ivB64, 'base64'), Buffer.from(tagB64, 'base64'), Buffer.from(dataB64, 'base64'), associated).toString('utf8');
    } finally {
        dek.fill(0);
    }
}

/**
 * Derive a per-purpose secret from the ring's key `keyId` and caller
 * material (HKDF-SHA256, `info` is the purpose label). Used for the wallet
 * sync-state passphrase so a viewing key alone opens nothing.
 */
export function deriveBoundSecret(ring: KeyRing, keyId: string, material: string, info: string): Buffer {
    const ikm = Buffer.concat([ring.kek(keyId), Buffer.from(material, 'utf8')]);
    return Buffer.from(crypto.hkdfSync('sha256', ikm, keyId, info, 32));
}

/**
 * SHA-256 hash of a viewing key for lookup/dedup purposes.
 * Returns 64-character hex string.
 */
export function hashViewingKey(viewingKey: string): string {
    return crypto.createHash('sha256').update(viewingKey).digest('hex');
}
