/**
 * srv/submission/token-factory.ts: the inputs of a factory mint and the
 * session-derived issuer. The artifact's pure circuits are stubbed; the raw
 * token type comes from the real compact-runtime.
 */

const registryState = vi.hoisted(() => ({ registered: true, pure: null as any }));
vi.mock('../../srv/submission/contract-registry', () => ({
    getContractRegistration: (name: string) => (registryState.registered && name === 'token-factory' ? { artifactPath: 'x', privateStateId: 'p', zkConfigPath: 'z' } : undefined),
    importRegisteredArtifact: async () => ({ pureCircuits: registryState.pure })
}));
const seedState = vi.hoisted(() => ({ zswap: new Uint8Array(32).fill(5), calls: 0 }));
vi.mock('../../srv/submission/wallet-material-factory', () => ({
    withSessionRoleSeeds: async (_opts: unknown, fn: (rs: any) => unknown) => { seedState.calls++; return fn({ zswap: seedState.zswap }); }
}));

import {
    parseFactoryTokenName, parseFactoryMintAmount, describeFactoryToken, factoryIssuerKeyForSession,
    loadTokenFactoryPureCircuits, MAX_FACTORY_MINT_AMOUNT, __resetFactoryIssuerCacheForTests
} from '../../srv/submission/token-factory';
import { deriveTokenFactoryIssuerSecret } from '../../srv/submission/contract-witnesses';
import { HEX64_RE } from '../../srv/utils/hex-patterns';

const FACTORY = 'd96fcca18b3ca748af0c0934d88a47113bb52e586afe334f3d9f5e66e5aea02c';

/** A stand-in for the compiled pure circuits: deterministic, injective enough for the assertions. */
function fakePure() {
    const hash = (tag: number, ...parts: Uint8Array[]) => {
        const out = new Uint8Array(32);
        out[0] = tag;
        parts.forEach((p, i) => p.forEach((b, j) => { out[(1 + i * 7 + j) % 32] ^= b; }));
        return out;
    };
    return {
        issuerKey: vi.fn((secret: Uint8Array) => hash(1, secret)),
        domainOf: vi.fn((issuer: Uint8Array, name: Uint8Array) => hash(2, issuer, name))
    };
}

beforeEach(() => {
    registryState.registered = true;
    registryState.pure = fakePure();
    seedState.calls = 0;
    __resetFactoryIssuerCacheForTests();
});

describe('token-factory inputs', () => {
    test('a name is 1 to 32 UTF-8 bytes without NUL, padded to 32 bytes', () => {
        const ok = parseFactoryTokenName('CREDIT');
        expect(ok).toMatchObject({ ok: true, name: 'CREDIT', nameHex: Buffer.from('CREDIT').toString('hex').padEnd(64, '0') });
        expect(parseFactoryTokenName('ä'.repeat(16))).toMatchObject({ ok: true });
        expect(parseFactoryTokenName('ä'.repeat(17))).toMatchObject({ ok: false, message: expect.stringMatching(/32 bytes/) });
        expect(parseFactoryTokenName('')).toMatchObject({ ok: false });
        expect(parseFactoryTokenName(undefined)).toMatchObject({ ok: false });
        expect(parseFactoryTokenName('a\u0000b')).toMatchObject({ ok: false, message: expect.stringMatching(/NUL/) });
    });

    test('an amount is a positive integer up to Uint<64>, as number or decimal string', () => {
        expect(parseFactoryMintAmount('1000')).toEqual({ ok: true, amount: 1000n });
        expect(parseFactoryMintAmount(7)).toEqual({ ok: true, amount: 7n });
        expect(parseFactoryMintAmount(MAX_FACTORY_MINT_AMOUNT.toString())).toEqual({ ok: true, amount: MAX_FACTORY_MINT_AMOUNT });
        expect(parseFactoryMintAmount((MAX_FACTORY_MINT_AMOUNT + 1n).toString())).toMatchObject({ ok: false, message: expect.stringMatching(/Uint<64>/) });
        for (const bad of ['0', '-1', '1.5', '1e3', '', undefined, 'ten']) {
            expect(parseFactoryMintAmount(bad), String(bad)).toMatchObject({ ok: false });
        }
    });
});

describe('token-factory issuer and token', () => {
    test('the pure circuits come from the registered lineage; a missing or foreign artifact is TOKEN_FACTORY_UNAVAILABLE', async () => {
        expect(await loadTokenFactoryPureCircuits()).toBe(registryState.pure);
        registryState.registered = false;
        await expect(loadTokenFactoryPureCircuits()).rejects.toMatchObject({ code: 'TOKEN_FACTORY_UNAVAILABLE' });
        registryState.registered = true;
        registryState.pure = { leafHash: () => new Uint8Array(32) };
        await expect(loadTokenFactoryPureCircuits()).rejects.toMatchObject({ code: 'TOKEN_FACTORY_UNAVAILABLE' });
    });

    test('the issuer key is issuerKey(secret of the session seed), computed once per session', async () => {
        const key = await factoryIssuerKeyForSession({ sessionId: 's1' });
        const expectedSecret = deriveTokenFactoryIssuerSecret(seedState.zswap);
        const [calledWith] = registryState.pure.issuerKey.mock.calls[0];
        expect(Buffer.from(calledWith).equals(Buffer.from(expectedSecret))).toBe(true);
        expect(key).toMatch(HEX64_RE);
        expect(await factoryIssuerKeyForSession({ sessionId: 's1' })).toBe(key);
        expect(seedState.calls).toBe(1);
    });

    test('describeFactoryToken binds issuer, name and factory address into a raw token type', async () => {
        const issuerKey = '2c'.repeat(32);
        const a = await describeFactoryToken({ issuerKey, name: 'CREDIT', contractAddress: FACTORY });
        expect(a.issuerKey).toBe(issuerKey);
        expect(a.domain).toMatch(HEX64_RE);
        expect(a.tokenType).toMatch(HEX64_RE);
        const b = await describeFactoryToken({ issuerKey, name: 'GOLD', contractAddress: FACTORY });
        expect(b.domain).not.toBe(a.domain);
        expect(b.tokenType).not.toBe(a.tokenType);
        const c = await describeFactoryToken({ issuerKey, name: 'CREDIT', contractAddress: '11'.repeat(32) });
        expect(c.domain).toBe(a.domain);
        expect(c.tokenType).not.toBe(a.tokenType);
        await expect(describeFactoryToken({ issuerKey, name: 'CREDIT', contractAddress: 'nope' })).rejects.toMatchObject({ code: 'TOKEN_FACTORY_UNAVAILABLE' });
    });
});
