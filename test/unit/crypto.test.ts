/**
 * Tests for srv/utils/crypto.ts
 * - v2 envelope round trip, tamper detection, key-id binding
 * - legacy v1 ciphertexts stay readable under key id 1
 * - key ring parsing (ENCRYPTION_KEYS / ENCRYPTION_KEY_ACTIVE / ENCRYPTION_KEY)
 * - SHA-256 viewing key hashing
 */

import crypto from 'crypto';
import cds from '@sap/cds';
import {
    encrypt, decrypt, hashViewingKey, getEncryptionKey, inspectCiphertext, parseKeyRingSpec, KeyRing,
    UnknownEncryptionKeyError, legacyFold, deriveKek, deriveBoundSecret, setKeyRing, __resetKeyRingForTests, LEGACY_KEY_ID
} from '../../srv/utils/crypto';

const ENV_KEYS = ['ENCRYPTION_KEY', 'ENCRYPTION_KEYS', 'ENCRYPTION_KEY_ACTIVE', 'NODE_ENV'] as const;
let savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
    void cds.env; // loads the project's .env into process.env once, before the snapshot below
    savedEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
    __resetKeyRingForTests();
});
afterEach(() => {
    for (const k of ENV_KEYS) {
        if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
    }
    __resetKeyRingForTests();
});

/** Pre-0.23 ciphertext: iv:tag:data under the SHA-256 fold of the secret. */
function legacyEncrypt(plaintext: string, key: Buffer): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
    const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return `${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${data.toString('base64')}`;
}

describe('v2 envelope encrypt/decrypt', () => {
    const testKey = crypto.createHash('sha256').update('test-key').digest();

    it('round-trip: decrypt(encrypt(plaintext)) === plaintext', () => {
        const plaintext = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
        expect(decrypt(encrypt(plaintext, testKey), testKey)).toBe(plaintext);
    });

    it('produces different ciphertexts for the same plaintext (random DEK + IV)', () => {
        expect(encrypt('deadbeef', testKey)).not.toBe(encrypt('deadbeef', testKey));
    });

    it('format is v2:keyId:wrappedDek:iv:tag:data; a raw key is id 1', () => {
        const parts = encrypt('test', testKey).split(':');
        expect(parts).toHaveLength(6);
        expect(parts[0]).toBe('v2');
        expect(parts[1]).toBe(LEGACY_KEY_ID);
        expect(Buffer.from(parts[2], 'base64')).toHaveLength(12 + 16 + 32);
        expect(Buffer.from(parts[3], 'base64')).toHaveLength(12);
        expect(Buffer.from(parts[4], 'base64')).toHaveLength(16);
        expect(inspectCiphertext(parts.join(':'))).toEqual({ version: 2, keyId: '1' });
    });

    it('throws on decryption with the wrong key', () => {
        const wrongKey = crypto.createHash('sha256').update('wrong-key').digest();
        expect(() => decrypt(encrypt('secret', testKey), wrongKey)).toThrow();
    });

    it('throws on tampered payload, tampered tag and tampered wrapped key', () => {
        const flip = (b64: string) => { const b = Buffer.from(b64, 'base64'); b[0] ^= 0xff; return b.toString('base64'); };
        for (const idx of [2, 3, 4, 5]) {
            const parts = encrypt('secret', testKey).split(':');
            parts[idx] = flip(parts[idx]);
            expect(() => decrypt(parts.join(':'), testKey)).toThrow();
        }
    });

    it('rejects a re-labelled key id (the id is bound as AAD)', () => {
        const ring = new KeyRing({ activeId: 'a', keys: [{ id: 'a', secret: 'secret-a'.repeat(4) }, { id: 'b', secret: 'secret-b'.repeat(4) }] });
        const parts = encrypt('secret', ring).split(':');
        parts[1] = 'b';
        expect(() => decrypt(parts.join(':'), ring)).toThrow();
    });

    it('throws UnknownEncryptionKeyError when the ring lacks the key id', () => {
        const ringA = new KeyRing({ activeId: 'k2', keys: [{ id: 'k2', secret: 's'.repeat(32) }] });
        const ct = encrypt('secret', ringA);
        const ringB = new KeyRing({ activeId: 'k3', keys: [{ id: 'k3', secret: 't'.repeat(32) }] });
        let caught: unknown;
        try { decrypt(ct, ringB); } catch (e) { caught = e; }
        expect(caught).toBeInstanceOf(UnknownEncryptionKeyError);
        expect((caught as UnknownEncryptionKeyError).keyId).toBe('k2');
    });

    it('throws on invalid format and wrong component lengths', () => {
        expect(() => decrypt('just-one-part', testKey)).toThrow('Invalid encrypted format');
        const parts = encrypt('secret', testKey).split(':');
        const short = [...parts]; short[2] = Buffer.alloc(8).toString('base64');
        expect(() => decrypt(short.join(':'), testKey)).toThrow('Invalid wrapped key length');
        const iv = [...parts]; iv[3] = Buffer.alloc(8).toString('base64');
        expect(() => decrypt(iv.join(':'), testKey)).toThrow('Invalid IV length');
        const tag = [...parts]; tag[4] = Buffer.alloc(8).toString('base64');
        expect(() => decrypt(tag.join(':'), testKey)).toThrow('Invalid auth tag length');
    });

    it('handles empty and long plaintexts', () => {
        expect(decrypt(encrypt('', testKey), testKey)).toBe('');
        const long = 'a'.repeat(10000);
        expect(decrypt(encrypt(long, testKey), testKey)).toBe(long);
    });
});

describe('legacy v1 ciphertexts', () => {
    it('decrypt under key id 1 through the SHA-256 fold of the secret', () => {
        const ring = new KeyRing({ activeId: '1', keys: [{ id: '1', secret: 'my-secret-key-of-32-characters!!' }] });
        const ct = legacyEncrypt('seed-hex', legacyFold('my-secret-key-of-32-characters!!'));
        expect(inspectCiphertext(ct)).toEqual({ version: 1, keyId: '1' });
        expect(decrypt(ct, ring)).toBe('seed-hex');
    });

    it('a raw Buffer opens v1 ciphertexts made with that buffer', () => {
        const key = crypto.randomBytes(32);
        expect(decrypt(legacyEncrypt('x', key), key)).toBe('x');
    });

    it('are refused when the ring has no key id 1', () => {
        const ring = new KeyRing({ activeId: 'k2', keys: [{ id: 'k2', secret: 's'.repeat(32) }] });
        const ct = legacyEncrypt('seed-hex', legacyFold('old'));
        expect(() => decrypt(ct, ring)).toThrow(UnknownEncryptionKeyError);
    });

    it('a ring with the legacy key writes v2 and still reads v1', () => {
        process.env.ENCRYPTION_KEY = 'legacy-secret-of-at-least-32-chars';
        const ring = getEncryptionKey();
        const v1 = legacyEncrypt('vk', legacyFold('legacy-secret-of-at-least-32-chars'));
        expect(decrypt(v1, ring)).toBe('vk');
        expect(inspectCiphertext(encrypt('vk', ring))).toEqual({ version: 2, keyId: '1' });
    });
});

describe('key ring parsing', () => {
    it('ENCRYPTION_KEY alone is id 1, active', () => {
        expect(parseKeyRingSpec({ ENCRYPTION_KEY: 'abc' })).toEqual({ activeId: '1', keys: [{ id: '1', secret: 'abc' }] });
    });

    it('ENCRYPTION_KEYS with one member needs no active id', () => {
        expect(parseKeyRingSpec({ ENCRYPTION_KEYS: 'k7=sec' })).toEqual({ activeId: 'k7', keys: [{ id: 'k7', secret: 'sec' }] });
    });

    it('ENCRYPTION_KEYS with several members requires ENCRYPTION_KEY_ACTIVE', () => {
        expect(() => parseKeyRingSpec({ ENCRYPTION_KEYS: 'a=1,b=2' })).toThrow(/ENCRYPTION_KEY_ACTIVE is required/);
        expect(parseKeyRingSpec({ ENCRYPTION_KEYS: 'a=1, b=2', ENCRYPTION_KEY_ACTIVE: 'b' })).toEqual({ activeId: 'b', keys: [{ id: 'a', secret: '1' }, { id: 'b', secret: '2' }] });
    });

    it('the legacy key joins a ring as id 1 (rotation shape)', () => {
        const spec = parseKeyRingSpec({ ENCRYPTION_KEY: 'old', ENCRYPTION_KEYS: 'k2=new', ENCRYPTION_KEY_ACTIVE: 'k2' });
        expect(spec).toEqual({ activeId: 'k2', keys: [{ id: 'k2', secret: 'new' }, { id: '1', secret: 'old' }] });
        expect(() => parseKeyRingSpec({ ENCRYPTION_KEY: 'old', ENCRYPTION_KEYS: '1=other' })).toThrow(/different secrets/);
    });

    it('rejects malformed entries, bad ids and an unknown active id', () => {
        expect(() => parseKeyRingSpec({ ENCRYPTION_KEYS: 'nosecret' })).toThrow(/id=secret/);
        expect(() => new KeyRing({ activeId: 'x', keys: [{ id: 'bad id', secret: 's' }] })).toThrow(/invalid encryption key id/);
        expect(() => new KeyRing({ activeId: 'x', keys: [{ id: 'a', secret: 's' }, { id: 'a', secret: 't' }] })).toThrow(/duplicate/);
        expect(() => new KeyRing({ activeId: 'x', keys: [{ id: 'a', secret: 's' }] })).toThrow(/not in the encryption key ring/);
        expect(() => new KeyRing({ activeId: 'a', keys: [] })).toThrow(/empty/);
    });

    it('KEKs are HKDF-stretched per key id, not the SHA-256 fold', () => {
        const kek = deriveKek('1', 'secret');
        expect(kek).toHaveLength(32);
        expect(kek.equals(legacyFold('secret'))).toBe(false);
        expect(deriveKek('2', 'secret').equals(kek)).toBe(false);
        expect(deriveKek('1', 'secret').equals(kek)).toBe(true);
    });

    it('deriveBoundSecret mixes the ring key and caller material', () => {
        const ring = new KeyRing({ activeId: 'a', keys: [{ id: 'a', secret: 'sa'.repeat(16) }, { id: 'b', secret: 'sb'.repeat(16) }] });
        const s1 = deriveBoundSecret(ring, 'a', 'vk', 'nightgate/test');
        expect(s1).toHaveLength(32);
        expect(deriveBoundSecret(ring, 'a', 'vk', 'nightgate/test').equals(s1)).toBe(true);
        expect(deriveBoundSecret(ring, 'b', 'vk', 'nightgate/test').equals(s1)).toBe(false);
        expect(deriveBoundSecret(ring, 'a', 'vk2', 'nightgate/test').equals(s1)).toBe(false);
        expect(deriveBoundSecret(ring, 'a', 'vk', 'nightgate/other').equals(s1)).toBe(false);
    });
});

describe('getEncryptionKey', () => {
    it('returns the same dev ring within one process and a fresh one per process', () => {
        const ring1 = getEncryptionKey();
        const ring2 = getEncryptionKey();
        expect(ring1).toBe(ring2);
        expect(ring1.activeId).toBe('dev');
        const ct = encrypt('x', ring1);
        __resetKeyRingForTests();
        expect(() => decrypt(ct, getEncryptionKey())).toThrow();
    });

    it('resolves the ring from ENCRYPTION_KEYS / ENCRYPTION_KEY_ACTIVE and re-reads a changed environment', () => {
        process.env.ENCRYPTION_KEYS = 'k1=' + 'a'.repeat(32) + ',k2=' + 'b'.repeat(32);
        process.env.ENCRYPTION_KEY_ACTIVE = 'k1';
        const ct = encrypt('seed', getEncryptionKey());
        expect(inspectCiphertext(ct).keyId).toBe('k1');
        process.env.ENCRYPTION_KEY_ACTIVE = 'k2';
        const ring = getEncryptionKey();
        expect(ring.activeId).toBe('k2');
        expect(decrypt(ct, ring)).toBe('seed');
        expect(inspectCiphertext(encrypt('seed', ring)).keyId).toBe('k2');
    });

    it('a pinned ring (worker transport) wins over the environment', () => {
        process.env.ENCRYPTION_KEY = 'env-secret-of-at-least-32-chars!!';
        setKeyRing({ activeId: 'w', keys: [{ id: 'w', secret: 'worker-secret-of-32-characters!!' }] });
        expect(getEncryptionKey().activeId).toBe('w');
        expect(getEncryptionKey().toSpec()).toEqual({ activeId: 'w', keys: [{ id: 'w', secret: 'worker-secret-of-32-characters!!' }] });
        setKeyRing(undefined);
        expect(getEncryptionKey().activeId).toBe('1');
    });

    it('refuses the dev fallback when NODE_ENV=production', () => {
        process.env.NODE_ENV = 'production';
        expect(() => getEncryptionKey()).toThrow(/ENCRYPTION_KEY must be set in production/);
    });
});

describe('hashViewingKey: SHA-256', () => {
    it('produces consistent 64-char hex output', () => {
        expect(hashViewingKey('a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6')).toMatch(/^[0-9a-f]{64}$/);
    });

    it('same input produces same hash, different inputs differ', () => {
        expect(hashViewingKey('deadbeef')).toBe(hashViewingKey('deadbeef'));
        expect(hashViewingKey('aabb')).not.toBe(hashViewingKey('ccdd'));
    });

    it('matches Node.js crypto SHA-256', () => {
        expect(hashViewingKey('test-viewing-key')).toBe(crypto.createHash('sha256').update('test-viewing-key').digest('hex'));
    });
});
