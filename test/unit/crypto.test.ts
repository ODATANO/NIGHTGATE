/**
 * Tests for srv/utils/crypto.ts
 * - AES-256-GCM encrypt/decrypt round-trip
 * - Tamper detection (GCM authentication)
 * - SHA-256 viewing key hashing
 */

import crypto from 'crypto';
import { encrypt, decrypt, hashViewingKey, getEncryptionKey } from '../../srv/utils/crypto';

describe('AES-256-GCM encrypt/decrypt', () => {
    const testKey = crypto.createHash('sha256').update('test-key').digest();

    it('round-trip: decrypt(encrypt(plaintext)) === plaintext', () => {
        const plaintext = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
        const encrypted = encrypt(plaintext, testKey);
        const decrypted = decrypt(encrypted, testKey);
        expect(decrypted).toBe(plaintext);
    });

    it('produces different ciphertexts for same plaintext (random IV)', () => {
        const plaintext = 'deadbeef';
        const e1 = encrypt(plaintext, testKey);
        const e2 = encrypt(plaintext, testKey);
        expect(e1).not.toBe(e2);
    });

    it('produces different ciphertexts for different plaintexts', () => {
        const e1 = encrypt('aabb', testKey);
        const e2 = encrypt('ccdd', testKey);
        expect(e1).not.toBe(e2);
    });

    it('encrypted format is iv:authTag:ciphertext (3 base64 segments)', () => {
        const encrypted = encrypt('test', testKey);
        const parts = encrypted.split(':');
        expect(parts).toHaveLength(3);
        // Each part should be valid base64
        for (const part of parts) {
            expect(() => Buffer.from(part, 'base64')).not.toThrow();
        }
    });

    it('throws on decryption with wrong key', () => {
        const encrypted = encrypt('secret', testKey);
        const wrongKey = crypto.createHash('sha256').update('wrong-key').digest();
        expect(() => decrypt(encrypted, wrongKey)).toThrow();
    });

    it('throws on tampered ciphertext (GCM authentication)', () => {
        const encrypted = encrypt('secret', testKey);
        const parts = encrypted.split(':');
        // Tamper with ciphertext
        const tamperedData = Buffer.from(parts[2], 'base64');
        tamperedData[0] ^= 0xff;
        parts[2] = tamperedData.toString('base64');
        const tampered = parts.join(':');
        expect(() => decrypt(tampered, testKey)).toThrow();
    });

    it('throws on tampered auth tag', () => {
        const encrypted = encrypt('secret', testKey);
        const parts = encrypted.split(':');
        // Tamper with auth tag
        const tamperedTag = Buffer.from(parts[1], 'base64');
        tamperedTag[0] ^= 0xff;
        parts[1] = tamperedTag.toString('base64');
        const tampered = parts.join(':');
        expect(() => decrypt(tampered, testKey)).toThrow();
    });

    it('throws on invalid format (missing parts)', () => {
        expect(() => decrypt('just-one-part', testKey)).toThrow('Invalid encrypted format');
    });

    it('throws on invalid IV length', () => {
        const encrypted = encrypt('secret', testKey);
        const parts = encrypted.split(':');
        parts[0] = Buffer.alloc(8).toString('base64');
        expect(() => decrypt(parts.join(':'), testKey)).toThrow('Invalid IV length');
    });

    it('throws on invalid auth tag length', () => {
        const encrypted = encrypt('secret', testKey);
        const parts = encrypted.split(':');
        parts[1] = Buffer.alloc(8).toString('base64');
        expect(() => decrypt(parts.join(':'), testKey)).toThrow('Invalid auth tag length');
    });

    it('handles empty string plaintext', () => {
        const encrypted = encrypt('', testKey);
        const decrypted = decrypt(encrypted, testKey);
        expect(decrypted).toBe('');
    });

    it('handles long plaintext', () => {
        const plaintext = 'a'.repeat(10000);
        const encrypted = encrypt(plaintext, testKey);
        const decrypted = decrypt(encrypted, testKey);
        expect(decrypted).toBe(plaintext);
    });
});

describe('hashViewingKey — SHA-256', () => {
    it('produces consistent 64-char hex output', () => {
        const hash = hashViewingKey('a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6');
        expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('same input produces same hash', () => {
        const input = 'deadbeef';
        expect(hashViewingKey(input)).toBe(hashViewingKey(input));
    });

    it('different inputs produce different hashes', () => {
        expect(hashViewingKey('aabb')).not.toBe(hashViewingKey('ccdd'));
    });

    it('matches Node.js crypto SHA-256', () => {
        const input = 'test-viewing-key';
        const expected = crypto.createHash('sha256').update(input).digest('hex');
        expect(hashViewingKey(input)).toBe(expected);
    });
});

describe('getEncryptionKey', () => {
    it('returns a 32-byte Buffer', () => {
        const key = getEncryptionKey();
        expect(key).toBeInstanceOf(Buffer);
        expect(key.length).toBe(32);
    });

    it('returns consistent key within same process', () => {
        const key1 = getEncryptionKey();
        const key2 = getEncryptionKey();
        expect(key1.equals(key2)).toBe(true);
    });

    it('uses ENCRYPTION_KEY env var when set', () => {
        const original = process.env.ENCRYPTION_KEY;
        try {
            process.env.ENCRYPTION_KEY = 'my-secret-key';
            const key = getEncryptionKey();
            const expected = crypto.createHash('sha256').update('my-secret-key').digest();
            expect(key.equals(expected)).toBe(true);
        } finally {
            if (original !== undefined) {
                process.env.ENCRYPTION_KEY = original;
            } else {
                delete process.env.ENCRYPTION_KEY;
            }
        }
    });
});
