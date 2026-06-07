/**
 * Tests for srv/submission/grantee-identity.ts (Phase 0 grantee binding).
 */
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { deriveGranteeId, resolveGranteeId } from '../../srv/submission/grantee-identity';

describe('deriveGranteeId', () => {
    test('custom: passes through a valid 64-hex (lower-cased)', () => {
        const hex = 'AB'.repeat(32);
        expect(deriveGranteeId('custom', hex)).toBe(hex.toLowerCase());
    });

    test('custom: rejects non-64-hex', () => {
        expect(() => deriveGranteeId('custom', 'nope')).toThrow(/64 hex/);
        expect(() => deriveGranteeId('custom', 'ab'.repeat(31))).toThrow(/64 hex/);
    });

    test('wallet: sha256 of the coin pubkey bytes, deterministic', () => {
        const pubkey = '11'.repeat(32);
        const expected = bytesToHex(sha256(Uint8Array.from(Buffer.from(pubkey, 'hex'))));
        expect(deriveGranteeId('wallet', pubkey)).toBe(expected);
        expect(deriveGranteeId('wallet', pubkey)).toBe(deriveGranteeId('wallet', pubkey));
        expect(deriveGranteeId('wallet', pubkey)).toMatch(/^[0-9a-f]{64}$/);
    });

    test('wallet: rejects non-hex input', () => {
        expect(() => deriveGranteeId('wallet', 'xyz')).toThrow(/hex/);
    });

    test('did: sha256 of the utf8 DID string, deterministic', () => {
        const did = 'did:web:recycler.example';
        const expected = bytesToHex(sha256(new TextEncoder().encode(did)));
        expect(deriveGranteeId('did', did)).toBe(expected);
        expect(deriveGranteeId('did', did)).toMatch(/^[0-9a-f]{64}$/);
    });

    test('different kinds/inputs yield different ids', () => {
        const a = deriveGranteeId('wallet', '22'.repeat(32));
        const b = deriveGranteeId('did', 'did:web:x');
        const c = deriveGranteeId('custom', '33'.repeat(32));
        expect(new Set([a, b, c]).size).toBe(3);
    });

    test('empty input throws', () => {
        expect(() => deriveGranteeId('did', '')).toThrow(/required/);
    });
});

describe('resolveGranteeId', () => {
    const ID_GLOBAL = 'a'.repeat(64);
    const ID_SCOPED = 'b'.repeat(64);
    const dbWith = (rows: any[]) => ({ run: jest.fn().mockResolvedValue(rows) });
    const reqFor = (id?: string) => ({ user: id ? { id } : undefined } as any);

    test('null for anonymous principal (no db hit)', async () => {
        const db = dbWith([]);
        expect(await resolveGranteeId(reqFor(undefined), db)).toBeNull();
        expect(db.run).not.toHaveBeenCalled();
    });

    test('null when the principal has no rows', async () => {
        expect(await resolveGranteeId(reqFor('u1'), dbWith([]))).toBeNull();
    });

    test('no scope requested → global row', async () => {
        const db = dbWith([{ granteeId: ID_GLOBAL, scope: null }]);
        expect(await resolveGranteeId(reqFor('u1'), db)).toBe(ID_GLOBAL);
    });

    test('no scope requested → null when only a scoped row exists', async () => {
        const db = dbWith([{ granteeId: ID_SCOPED, scope: '0xVAULT' }]);
        expect(await resolveGranteeId(reqFor('u1'), db)).toBeNull();
    });

    test('scoped row wins over global (precedence)', async () => {
        const db = dbWith([
            { granteeId: ID_GLOBAL, scope: null },
            { granteeId: ID_SCOPED, scope: '0xVAULT' }
        ]);
        expect(await resolveGranteeId(reqFor('u1'), db, { scope: '0xVAULT' })).toBe(ID_SCOPED);
    });

    test('falls back to global when scope requested has no exact row', async () => {
        const db = dbWith([{ granteeId: ID_GLOBAL, scope: null }]);
        expect(await resolveGranteeId(reqFor('u1'), db, { scope: '0xVAULT' })).toBe(ID_GLOBAL);
    });

    test('null when scope requested and neither scoped nor global match', async () => {
        const db = dbWith([{ granteeId: ID_SCOPED, scope: '0xOTHER' }]);
        expect(await resolveGranteeId(reqFor('u1'), db, { scope: '0xVAULT' })).toBeNull();
    });
});
