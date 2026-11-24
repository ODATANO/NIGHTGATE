/**
 * Tests for srv/utils/crypto.ts
 * - envelope round trip, tamper detection, key-id and row binding
 * - key ring parsing (ENCRYPTION_KEYS / ENCRYPTION_KEY_ACTIVE / ENCRYPTION_KEY)
 * - SHA-256 viewing key hashing
 */

import crypto from 'crypto';
import cds from '@sap/cds';
import {
    encrypt, decrypt, hashViewingKey, getEncryptionKey, inspectCiphertext, parseKeyRingSpec, KeyRing,
    UnknownEncryptionKeyError, deriveKek, deriveBoundSecret, setKeyRing, __resetKeyRingForTests, LEGACY_KEY_ID
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

/** Every value is bound to a column and a row; the tests use one fixed binding. */
const B = { purpose: 'test/value', subject: 'row-1' };

describe('envelope encrypt/decrypt', () => {
    const testKey = crypto.createHash('sha256').update('test-key').digest();

    it('round-trip: decrypt(encrypt(plaintext)) === plaintext', () => {
        const plaintext = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
        expect(decrypt(encrypt(plaintext, testKey, B), testKey, B)).toBe(plaintext);
    });

    it('produces different ciphertexts for the same plaintext (random DEK + IV)', () => {
        expect(encrypt('deadbeef', testKey, B)).not.toBe(encrypt('deadbeef', testKey, B));
    });

    it('format is v3:keyId:wrappedDek:iv:tag:data; a raw key is id 1', () => {
        const parts = encrypt('test', testKey, B).split(':');
        expect(parts).toHaveLength(6);
        expect(parts[0]).toBe('v3');
        expect(parts[1]).toBe(LEGACY_KEY_ID);
        expect(Buffer.from(parts[2], 'base64')).toHaveLength(12 + 16 + 32);
        expect(Buffer.from(parts[3], 'base64')).toHaveLength(12);
        expect(Buffer.from(parts[4], 'base64')).toHaveLength(16);
        expect(inspectCiphertext(parts.join(':'))).toEqual({ keyId: '1' });
    });

    it('throws on decryption with the wrong key', () => {
        const wrongKey = crypto.createHash('sha256').update('wrong-key').digest();
        expect(() => decrypt(encrypt('secret', testKey, B), wrongKey, B)).toThrow();
    });

    it('throws on tampered payload, tampered tag and tampered wrapped key', () => {
        const flip = (b64: string) => { const b = Buffer.from(b64, 'base64'); b[0] ^= 0xff; return b.toString('base64'); };
        for (const idx of [2, 3, 4, 5]) {
            const parts = encrypt('secret', testKey, B).split(':');
            parts[idx] = flip(parts[idx]);
            expect(() => decrypt(parts.join(':'), testKey, B)).toThrow();
        }
    });

    it('rejects a re-labelled key id (the id is bound as AAD)', () => {
        const ring = new KeyRing({ activeId: 'a', keys: [{ id: 'a', secret: 'secret-a'.repeat(4) }, { id: 'b', secret: 'secret-b'.repeat(4) }] });
        const parts = encrypt('secret', ring, B).split(':');
        parts[1] = 'b';
        expect(() => decrypt(parts.join(':'), ring, B)).toThrow();
    });

    it('throws UnknownEncryptionKeyError when the ring lacks the key id', () => {
        const ringA = new KeyRing({ activeId: 'k2', keys: [{ id: 'k2', secret: 's'.repeat(32) }] });
        const ct = encrypt('secret', ringA, B);
        const ringB = new KeyRing({ activeId: 'k3', keys: [{ id: 'k3', secret: 't'.repeat(32) }] });
        let caught: unknown;
        try { decrypt(ct, ringB, B); } catch (e) { caught = e; }
        expect(caught).toBeInstanceOf(UnknownEncryptionKeyError);
        expect((caught as UnknownEncryptionKeyError).keyId).toBe('k2');
    });

    it('throws on invalid format and wrong component lengths', () => {
        expect(() => decrypt('just-one-part', testKey, B)).toThrow('Invalid encrypted format');
        const parts = encrypt('secret', testKey, B).split(':');
        const short = [...parts]; short[2] = Buffer.alloc(8).toString('base64');
        expect(() => decrypt(short.join(':'), testKey, B)).toThrow('Invalid wrapped key length');
        const iv = [...parts]; iv[3] = Buffer.alloc(8).toString('base64');
        expect(() => decrypt(iv.join(':'), testKey, B)).toThrow('Invalid IV length');
        const tag = [...parts]; tag[4] = Buffer.alloc(8).toString('base64');
        expect(() => decrypt(tag.join(':'), testKey, B)).toThrow('Invalid auth tag length');
    });

    it('handles empty and long plaintexts', () => {
        expect(decrypt(encrypt('', testKey, B), testKey, B)).toBe('');
        const long = 'a'.repeat(10000);
        expect(decrypt(encrypt(long, testKey, B), testKey, B)).toBe(long);
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
        // Such an entry is most likely a bare secret: the message names its position and none of its characters.
        expect(() => parseKeyRingSpec({ ENCRYPTION_KEYS: 'a=1, supersecretvalue' })).toThrow('ENCRYPTION_KEYS entry 2 is not id=secret');
        expect(() => new KeyRing({ activeId: 'x', keys: [{ id: 'bad id', secret: 's' }] })).toThrow(/invalid encryption key id/);
        expect(() => new KeyRing({ activeId: 'x', keys: [{ id: 'a', secret: 's' }, { id: 'a', secret: 't' }] })).toThrow(/duplicate/);
        expect(() => new KeyRing({ activeId: 'x', keys: [{ id: 'a', secret: 's' }] })).toThrow(/not in the encryption key ring/);
        expect(() => new KeyRing({ activeId: 'a', keys: [] })).toThrow(/empty/);
    });

    it('KEKs are HKDF-stretched per key id', () => {
        const kek = deriveKek('1', 'secret');
        expect(kek).toHaveLength(32);
        expect(kek.equals(crypto.createHash('sha256').update('secret').digest())).toBe(false);
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
        const ct = encrypt('x', ring1, B);
        __resetKeyRingForTests();
        expect(() => decrypt(ct, getEncryptionKey(), B)).toThrow();
    });

    it('resolves the ring from ENCRYPTION_KEYS / ENCRYPTION_KEY_ACTIVE and re-reads a changed environment', () => {
        process.env.ENCRYPTION_KEYS = 'k1=' + 'a'.repeat(32) + ',k2=' + 'b'.repeat(32);
        process.env.ENCRYPTION_KEY_ACTIVE = 'k1';
        const ct = encrypt('seed', getEncryptionKey(), B);
        expect(inspectCiphertext(ct).keyId).toBe('k1');
        process.env.ENCRYPTION_KEY_ACTIVE = 'k2';
        const ring = getEncryptionKey();
        expect(ring.activeId).toBe('k2');
        expect(decrypt(ct, ring, B)).toBe('seed');
        expect(inspectCiphertext(encrypt('seed', ring, B)).keyId).toBe('k2');
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

    it('refuses a secret shorter than 32 characters in production and only warns elsewhere', () => {
        process.env.ENCRYPTION_KEY = 'x';
        process.env.NODE_ENV = 'production';
        expect(() => getEncryptionKey()).toThrow(/shorter than 32 characters; production requires/);
        __resetKeyRingForTests();
        process.env.NODE_ENV = 'test';
        const ring = getEncryptionKey();
        expect(decrypt(encrypt('seed', ring, B), ring, B)).toBe('seed');
        __resetKeyRingForTests();
        process.env.ENCRYPTION_KEY = 'a-secret-that-is-exactly-32-chars';
        process.env.NODE_ENV = 'production';
        expect(getEncryptionKey().activeId).toBe('1');
    });

    it('keeps whitespace around ENCRYPTION_KEY as part of the key and warns about it', () => {
        const secret = 'a-secret-that-is-exactly-32-chars';
        process.env.ENCRYPTION_KEY = secret;
        const plain = getEncryptionKey();
        const sealed = encrypt('seed', plain, B);
        const warn = vi.spyOn(cds.log('nightgate:crypto'), 'warn').mockImplementation(() => undefined);
        try {
            __resetKeyRingForTests();
            process.env.ENCRYPTION_KEY = `${secret}\n`;
            const padded = getEncryptionKey();
            expect(() => decrypt(sealed, padded, B)).toThrow();
            expect(warn).toHaveBeenCalledTimes(1);
            expect(warn.mock.calls[0][0]).toMatch(/^ENCRYPTION_KEY begins or ends with whitespace/);
            expect(String(warn.mock.calls[0][0])).not.toContain(secret);
            getEncryptionKey();
            expect(warn).toHaveBeenCalledTimes(1);
        } finally {
            warn.mockRestore();
        }
    });
});

describe('v3 bound envelopes', () => {
    const ring = new KeyRing({ activeId: 'k', keys: [{ id: 'k', secret: 'bound-secret-of-thirty-two-chars' }] });
    const rowA = { purpose: 'wallet-session/seed', subject: 'session-a' };
    const rowB = { purpose: 'wallet-session/seed', subject: 'session-b' };
    const otherPurpose = { purpose: 'wallet-session/viewing-key', subject: 'session-a' };

    it('round-trips under the binding it was written with and is a v3 envelope', () => {
        const ct = encrypt('seed-a', ring, rowA);
        expect(ct.startsWith('v3:k:')).toBe(true);
        expect(inspectCiphertext(ct)).toEqual({ keyId: 'k' });
        expect(decrypt(ct, ring, rowA)).toBe('seed-a');
    });

    it('does not open under another subject or another purpose', () => {
        const ct = encrypt('seed-a', ring, rowA);
        expect(() => decrypt(ct, ring, rowB)).toThrow();
        expect(() => decrypt(ct, ring, otherPurpose)).toThrow();
    });

    it('refuses a value in an older format', () => {
        expect(() => decrypt('iv:tag:data', ring, rowA)).toThrow('Invalid encrypted format');
        const v2 = encrypt('x', ring, rowA).replace(/^v3:/, 'v2:');
        expect(() => decrypt(v2, ring, rowA)).toThrow('Invalid encrypted format');
    });

    it('refuses an empty or NUL-bearing binding', () => {
        expect(() => encrypt('x', ring, { purpose: '', subject: 'a' })).toThrow(/non-empty purpose and subject/);
        expect(() => encrypt('x', ring, { purpose: 'p', subject: 'a\u0000b' })).toThrow(/NUL/);
    });
});

describe('hashViewingKey: SHA-256', () => {

    it('matches Node.js crypto SHA-256', () => {
        expect(hashViewingKey('test-viewing-key')).toBe(crypto.createHash('sha256').update('test-viewing-key').digest('hex'));
    });
});
