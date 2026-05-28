/**
 * Tests for srv/utils/storage-encryption.ts.
 *
 * Verifies round-trip and the byte-level wire format. SDK cross-compat is
 * also exercised: an export blob produced by our class must be decryptable
 * by re-deriving the key from the embedded salt + password (i.e. the same
 * way the SDK's LevelDB provider does it).
 */

import {
    StorageEncryption,
    decryptWithPassword,
    extractEncryptedComponents,
    deriveKey,
    SALT_LENGTH,
    IV_LENGTH,
    AUTH_TAG_LENGTH,
    CURRENT_ENCRYPTION_VERSION
} from '../../srv/utils/storage-encryption';

const PASSWORD = 'a-test-passphrase-of-sufficient-length';
const PLAINTEXT = JSON.stringify({ version: 1, stateCount: 1, states: { 'demo': { counter: 42 } } });

describe('StorageEncryption', () => {
    test('round-trips arbitrary UTF-8 strings', () => {
        const enc = new StorageEncryption(PASSWORD);
        const blob = enc.encrypt(PLAINTEXT);
        expect(enc.decrypt(blob)).toBe(PLAINTEXT);
    });

    test('produces SDK-format header: [v][salt][iv][authTag][ciphertext]', () => {
        const enc = new StorageEncryption(PASSWORD);
        const blob = enc.encrypt(PLAINTEXT);

        const components = extractEncryptedComponents(Buffer.from(blob, 'base64'));
        expect(components.version).toBe(CURRENT_ENCRYPTION_VERSION);
        expect(components.salt.length).toBe(SALT_LENGTH);
        expect(components.iv.length).toBe(IV_LENGTH);
        expect(components.authTag.length).toBe(AUTH_TAG_LENGTH);
        expect(components.encrypted.length).toBeGreaterThan(0);
        expect(components.salt.equals(enc.salt)).toBe(true);
    });

    test('decrypt rejects payloads encrypted with a different password (salt mismatch)', () => {
        const writer = new StorageEncryption(PASSWORD);
        const blob = writer.encrypt(PLAINTEXT);

        // Reader has DIFFERENT salt, so this is a "different password/salt instance".
        const reader = new StorageEncryption('different-pass-of-sufficient-length');
        expect(() => reader.decrypt(blob)).toThrow(/Salt mismatch/);
    });

    test('decryptWithPassword re-derives the key from the salt embedded in the payload', () => {
        const enc = new StorageEncryption(PASSWORD);
        const blob = enc.encrypt(PLAINTEXT);

        // A fresh decrypt without the original encrypter, same path the SDK
        // uses when importing an exported blob.
        expect(decryptWithPassword(blob, PASSWORD)).toBe(PLAINTEXT);
    });

    test('decryptWithPassword fails with wrong password', () => {
        const enc = new StorageEncryption(PASSWORD);
        const blob = enc.encrypt(PLAINTEXT);

        // Wrong password → wrong key → GCM auth tag check fails.
        expect(() => decryptWithPassword(blob, 'wrong-pass-of-sufficient-length')).toThrow();
    });

    test('two encrypts of the same plaintext produce different blobs (IV is fresh)', () => {
        const enc = new StorageEncryption(PASSWORD);
        const a = enc.encrypt(PLAINTEXT);
        const b = enc.encrypt(PLAINTEXT);
        expect(a).not.toBe(b);
        // But they decrypt to the same value:
        expect(enc.decrypt(a)).toBe(enc.decrypt(b));
    });

    test('deriveKey is deterministic for (password, salt)', () => {
        const salt = Buffer.alloc(SALT_LENGTH, 0xAB);
        const k1 = deriveKey(PASSWORD, salt);
        const k2 = deriveKey(PASSWORD, salt);
        expect(k1.equals(k2)).toBe(true);
        expect(k1.length).toBe(32);
    });

    test('extractEncryptedComponents rejects payloads shorter than the header', () => {
        const tooShort = Buffer.alloc(8, 0x02);
        expect(() => extractEncryptedComponents(tooShort)).toThrow(/too short/);
    });

    test('extractEncryptedComponents rejects an unsupported version byte', () => {
        // Build a header-shaped buffer whose version byte is not CURRENT_ENCRYPTION_VERSION.
        const HEADER = 1 + SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH;
        const buf = Buffer.alloc(HEADER + 4, 0);
        buf[0] = 99;
        expect(() => extractEncryptedComponents(buf)).toThrow(/Unsupported encryption version: 99/);
    });

    test('decryptWithPassword rejects an unsupported version byte', () => {
        const enc = new StorageEncryption(PASSWORD);
        const goodBlob = Buffer.from(enc.encrypt(PLAINTEXT), 'base64');
        // Patch the version byte to something we don't recognise. extractEncryptedComponents
        // catches it first, but the line in decryptWithPassword after the destructure is
        // defensive against future versions, so we keep both paths covered via extract.
        goodBlob[0] = 99;
        expect(() => decryptWithPassword(goodBlob.toString('base64'), PASSWORD)).toThrow(/Unsupported encryption version: 99/);
    });
});

describe('cross-compat: our blob decryptable by SDK-equivalent path', () => {
    // The SDK's import path uses decryptWithPassword-style logic. We verify
    // an end-to-end round-trip in that exact mode without touching the SDK
    // (the SDK is ESM-only and not loadable from this Jest runtime). The
    // integration script scripts/integration-test-providers.mjs additionally
    // exercises the live SDK.
    test('encrypt then decryptWithPassword round-trip', () => {
        const enc = new StorageEncryption(PASSWORD);
        const blob = enc.encrypt(PLAINTEXT);
        expect(decryptWithPassword(blob, PASSWORD)).toBe(PLAINTEXT);
    });
});
