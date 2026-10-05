/**
 * Encryption of secrets stored in the database.
 * Each value gets its own random data key, which is itself encrypted with a master key from the key ring.
 * Several master keys can exist at once, so they can be rotated. `ENCRYPTION_KEY` is the key with id `1`.
 * New values use format v3, which also binds the value to its column and row.
 * Older v1 and v2 values can still be read and are converted by `nightgate-rewrap-keys`.
 */

import crypto from 'crypto';
import { NightgateError } from './errors';
import cds from '@sap/cds';
import { configFlag } from './config';

const log = cds.log('nightgate:crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const DEK_LENGTH = 32;
const KEK_LENGTH = 32;
const WRAPPED_DEK_LENGTH = IV_LENGTH + AUTH_TAG_LENGTH + DEK_LENGTH;

export const ENVELOPE_VERSION = 'v2';
export const BOUND_ENVELOPE_VERSION = 'v3';
export const LEGACY_KEY_ID = '1';
/** Secrets shorter than this are refused in production and warned about elsewhere. */
export const MIN_SECRET_LENGTH = 32;

/** What a v3 value belongs to. A value copied to another column or row will not decrypt. */
export interface EnvelopeBinding {
    purpose: string;
    subject: string;
}
export const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,16}$/;
const KEK_INFO = 'nightgate/kek/v2';

export class UnknownEncryptionKeyError extends NightgateError {
    readonly keyId: string;
    constructor(keyId: string) {
        super('ENCRYPTION_KEY_UNKNOWN', `ciphertext is encrypted under key id '${keyId}', which is not in the encryption key ring (ENCRYPTION_KEYS); add the key or run nightgate-rewrap-keys before removing it`);
        this.keyId = keyId;
    }
}

/** The key ring as plain data, secrets included. Used to pass it to the worker thread. */
export interface KeyRingSpec {
    activeId: string;
    keys: Array<{ id: string; secret: string }>;
}

export function deriveKek(id: string, secret: string): Buffer {
    return Buffer.from(crypto.hkdfSync('sha256', secret, id, KEK_INFO, KEK_LENGTH));
}

/** The key of the old v1 format. Only used to read v1 values. */
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

    /** A ring with a single ready-made key under id `1`. */
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

    legacyKey(id: string): Buffer | undefined { return this.legacyKeys.get(id); }

    /** The ring as plain data for the worker thread. Undefined for a ring built by `fromKek`. */
    toSpec(): KeyRingSpec | undefined {
        return this.spec ? { activeId: this.spec.activeId, keys: this.spec.keys.map(k => ({ ...k })) } : undefined;
    }
}

export type EncryptionKey = Buffer | KeyRing;

function asRing(key: EncryptionKey): KeyRing {
    return Buffer.isBuffer(key) ? KeyRing.fromKek(key) : key;
}

/** Reads the key ring from the environment. Undefined when no key is set. */
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

/** Sets the key ring directly. The worker thread gets it this way from the main thread. */
export function setKeyRing(spec: KeyRingSpec | undefined): void {
    pinnedRing = spec ? new KeyRing(spec) : undefined;
}

/**
 * Returns the key ring: the one set by `setKeyRing`, else the one from the environment.
 * Outside production, without any key, a random key is used. Its data is unreadable after a restart.
 */
export function getEncryptionKey(): KeyRing {
    if (pinnedRing) return pinnedRing;
    // Must run first: reading cds.env loads the project's .env file into process.env.
    const production = isProduction();
    const snapshot = `${process.env.ENCRYPTION_KEYS ?? ''}\u0000${process.env.ENCRYPTION_KEY_ACTIVE ?? ''}\u0000${process.env.ENCRYPTION_KEY ?? ''}`;
    if (cachedRing && cachedRing.snapshot === snapshot) return cachedRing.ring;
    const spec = parseKeyRingSpec();
    if (spec) {
        for (const k of spec.keys) {
            if (k.secret.length >= MIN_SECRET_LENGTH) continue;
            if (production) {
                throw new Error(`encryption key '${k.id}' is shorter than ${MIN_SECRET_LENGTH} characters; production requires a high-entropy secret of at least ${MIN_SECRET_LENGTH} characters (hex or base64) in ENCRYPTION_KEY / ENCRYPTION_KEYS`);
            }
            log.warn(`encryption key '${k.id}' is shorter than ${MIN_SECRET_LENGTH} characters; use a high-entropy ${MIN_SECRET_LENGTH}+ byte secret (hex or base64), production refuses to start with it`);
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

export function __resetKeyRingForTests(): void {
    pinnedRing = undefined;
    cachedRing = undefined;
    devFallback = undefined;
}

function aad(keyId: string): Buffer {
    return Buffer.from(`${ENVELOPE_VERSION}:${keyId}`, 'utf8');
}

// Fields are separated by NUL, so one field cannot spill into the next.

function boundAad(keyId: string, binding: EnvelopeBinding): Buffer {
    return Buffer.from([BOUND_ENVELOPE_VERSION, keyId, binding.purpose, binding.subject].join('\u0000'), 'utf8');
}

function assertBinding(binding: EnvelopeBinding): void {
    if (!binding || typeof binding.purpose !== 'string' || !binding.purpose || typeof binding.subject !== 'string' || !binding.subject) {
        throw new Error('envelope binding needs a non-empty purpose and subject');
    }
    if (binding.purpose.includes('\u0000') || binding.subject.includes('\u0000')) {
        throw new Error('envelope binding fields must not contain NUL');
    }
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

/** Encrypts with the active key. Always pass a binding for values stored in the database. */
export function encrypt(plaintext: string, key: EncryptionKey, binding?: EnvelopeBinding): string {
    const ring = asRing(key);
    const keyId = ring.activeId;
    let version = ENVELOPE_VERSION;
    let associated = aad(keyId);
    if (binding) {
        assertBinding(binding);
        version = BOUND_ENVELOPE_VERSION;
        associated = boundAad(keyId, binding);
    }
    const dek = crypto.randomBytes(DEK_LENGTH);
    try {
        const payload = gcmEncrypt(dek, Buffer.from(plaintext, 'utf8'), associated);
        const wrap = gcmEncrypt(ring.kek(keyId), dek, associated);
        const wrappedDek = Buffer.concat([wrap.iv, wrap.tag, wrap.data]);
        return [version, keyId, wrappedDek.toString('base64'), payload.iv.toString('base64'), payload.tag.toString('base64'), payload.data.toString('base64')].join(':');
    } finally {
        dek.fill(0);
    }
}

/** Version and key id of a stored ciphertext without decrypting it. */
export function inspectCiphertext(combined: string): { version: 1 | 2 | 3; keyId: string } {
    const parts = combined.split(':');
    if (parts.length === 3) return { version: 1, keyId: LEGACY_KEY_ID };
    if (parts.length === 6 && (parts[0] === ENVELOPE_VERSION || parts[0] === BOUND_ENVELOPE_VERSION)) {
        if (!KEY_ID_PATTERN.test(parts[1])) throw new Error(`Invalid encrypted format: bad key id '${parts[1]}'`);
        return { version: parts[0] === BOUND_ENVELOPE_VERSION ? 3 : 2, keyId: parts[1] };
    }
    throw new Error('Invalid encrypted format: expected v3|v2:keyId:wrappedDek:iv:authTag:ciphertext or iv:authTag:ciphertext');
}

/** An old unbound value where a bound one is expected. Accepting it would let a value copied from another row pass. */
export class UnboundEnvelopeError extends Error {
    constructor(purpose: string) {
        super(`ciphertext for '${purpose}' is an unbound v1/v2 envelope; run nightgate-rewrap-keys (or set NIGHTGATE_ACCEPT_UNBOUND_ENVELOPES=true until it ran)`);
        this.name = 'UnboundEnvelopeError';
    }
}

/**
 * Decrypts any format. When a binding is given, old unbound values are refused,
 * unless `allowUnbound` or NIGHTGATE_ACCEPT_UNBOUND_ENVELOPES allows them.
 */
export function decrypt(combined: string, key: EncryptionKey, binding?: EnvelopeBinding, opts: { allowUnbound?: boolean } = {}): string {
    const ring = asRing(key);
    const { version, keyId } = inspectCiphertext(combined);
    if (binding && version < 3 && !opts.allowUnbound && !configFlag('NIGHTGATE_ACCEPT_UNBOUND_ENVELOPES')) {
        throw new UnboundEnvelopeError(binding.purpose);
    }
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
    let associated = aad(keyId);
    if (version === 3) {
        if (!binding) throw new Error('ciphertext is bound to a purpose and a subject; decrypt it with the binding it was written under');
        assertBinding(binding);
        associated = boundAad(keyId, binding);
    }
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

/** Derives a secret from a ring key and the given material. The material alone is not enough to get it. */
export function deriveBoundSecret(ring: KeyRing, keyId: string, material: string, info: string): Buffer {
    const ikm = Buffer.concat([ring.kek(keyId), Buffer.from(material, 'utf8')]);
    return Buffer.from(crypto.hkdfSync('sha256', ikm, keyId, info, 32));
}

export function hashViewingKey(viewingKey: string): string {
    return crypto.createHash('sha256').update(viewingKey).digest('hex');
}
