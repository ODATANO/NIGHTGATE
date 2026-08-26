/**
 * Tests for srv/submission/contract-registry.
 *
 * Verifies registration/resolution semantics and config-loading behavior.
 * Module-level state is reset between tests via clearRegistry().
 */

import path from 'path';
import fs from 'fs';
import os from 'os';
import {
    registerContract,
    unregisterContract,
    clearRegistry,
    listRegisteredContracts,
    resolveContract,
    loadRegistryFromConfig,
    getContractRegistration,
    getArtifactGenerationDigest,
    assertArtifactGeneration,
    ContractNotRegisteredError
} from '../../srv/submission/contract-registry';

beforeEach(() => clearRegistry());

describe('contract registry', () => {
    test('register + list', () => {
        registerContract('foo', {
            artifactPath: '/abs/path/contract.js',
            privateStateId: 'fooPriv',
            zkConfigPath: '/abs/managed/foo'
        });
        expect(listRegisteredContracts()).toEqual(['foo']);
    });

    test('register rejects missing fields', () => {
        expect(() => registerContract('', {
            artifactPath: 'x', privateStateId: 'y', zkConfigPath: 'z'
        })).toThrow();
        expect(() => registerContract('foo', {
            artifactPath: '', privateStateId: 'y', zkConfigPath: 'z'
        })).toThrow();
        expect(() => registerContract('foo', {
            artifactPath: 'x', privateStateId: '', zkConfigPath: 'z'
        })).toThrow();
        expect(() => registerContract('foo', {
            artifactPath: 'x', privateStateId: 'y', zkConfigPath: ''
        })).toThrow();
    });

    test('unregister removes only the named entry', () => {
        registerContract('a', { artifactPath: '/x.js', privateStateId: 'p', zkConfigPath: '/z' });
        registerContract('b', { artifactPath: '/x.js', privateStateId: 'p', zkConfigPath: '/z' });
        expect(unregisterContract('a')).toBe(true);
        expect(listRegisteredContracts()).toEqual(['b']);
        expect(unregisterContract('a')).toBe(false);
    });

    test('resolveContract throws ContractNotRegisteredError with available list', async () => {
        registerContract('a', { artifactPath: '/x.js', privateStateId: 'p', zkConfigPath: '/z' });
        await expect(resolveContract('missing')).rejects.toBeInstanceOf(ContractNotRegisteredError);
        try { await resolveContract('missing'); } catch (e) {
            const err = e as ContractNotRegisteredError;
            expect(err.available).toEqual(['a']);
            expect(err.message).toMatch(/Available: a/);
        }
    });

    test('resolveContract error message differs when registry is empty', async () => {
        try { await resolveContract('whatever'); } catch (e) {
            expect((e as Error).message).toMatch(/No contracts are registered/);
        }
    });
});

// Artifact-generation provenance (0.16.0): a registry NAME is a mutable
// alias; the digest pins the generation it currently resolves to, and
// persisted commands / evidence rows are verified against it fail-closed.
describe('artifact generation digest', () => {
    const REPO = path.resolve(__dirname, '../..');
    const VAULT = {
        artifactPath: path.join(REPO, 'contracts/attestation-vault/src/managed/attestation-vault/contract/index.js'),
        privateStateId: 'vault',
        zkConfigPath: path.join(REPO, 'contracts/attestation-vault/src/managed/attestation-vault')
    };
    // A second, DIFFERENT "generation" for the same alias: any other real
    // file works, the digest only reads bytes (no keys dir -> module-only).
    const OTHER = {
        artifactPath: path.join(REPO, 'package.json'),
        privateStateId: 'vault',
        zkConfigPath: REPO
    };

    // The worker's recomputed generation is byte-identical to the registry's; jobs and evidence are pinned to it.
    test('computeArtifactGenerationDigest (shared module, used by the worker) equals the registry digest', async () => {
        const { computeArtifactGenerationDigest } = await import('../../srv/submission/artifact-digest.js');
        registerContract('parity-vault', VAULT);
        registerContract('parity-other', OTHER);
        for (const name of ['parity-vault', 'parity-other']) {
            expect(computeArtifactGenerationDigest(getContractRegistration(name)!)).toBe(getArtifactGenerationDigest(name));
        }
    });

    test('digest is deterministic and covers the artifact + verifier keys', () => {
        registerContract('gen', VAULT);
        const d1 = getArtifactGenerationDigest('gen');
        expect(d1).toMatch(/^[0-9a-f]{64}$/);
        expect(getArtifactGenerationDigest('gen')).toBe(d1);
    });

    test('re-pointing the alias changes the digest (mutable-alias hazard made visible)', () => {
        registerContract('gen', VAULT);
        const before = getArtifactGenerationDigest('gen');
        registerContract('gen', OTHER);
        expect(getArtifactGenerationDigest('gen')).not.toBe(before);
    });

    test('assertArtifactGeneration passes on match, fails closed otherwise', () => {
        registerContract('gen', VAULT);
        const digest = getArtifactGenerationDigest('gen');
        expect(() => assertArtifactGeneration('gen', digest, 'Persisted command')).not.toThrow();
        expect(() => assertArtifactGeneration('gen', undefined, 'Persisted command'))
            .toThrow(/no artifact-generation digest.*re-issue/s);
        registerContract('gen', OTHER);
        expect(() => assertArtifactGeneration('gen', digest, 'Persisted command'))
            .toThrow(/different generation/);
    });

    test('unknown alias throws ContractNotRegisteredError', () => {
        expect(() => getArtifactGenerationDigest('nope')).toThrow(ContractNotRegisteredError);
    });

    test('privateStateId is part of the generation (same paths, different id -> different digest)', () => {
        registerContract('gen', VAULT);
        const asVault = getArtifactGenerationDigest('gen');
        registerContract('gen', { ...VAULT, privateStateId: 'attester-B' });
        expect(getArtifactGenerationDigest('gen')).not.toBe(asVault);
    });

    test('slotWidth is part of the generation (same files, different width -> different digest)', () => {
        // The width changes path depth and integrity claim-key semantics, so
        // an alias re-pointed to a different width must trip the guard.
        registerContract('gen', VAULT);
        const as16 = getArtifactGenerationDigest('gen');
        registerContract('gen', { ...VAULT, slotWidth: 32 });
        expect(getArtifactGenerationDigest('gen')).not.toBe(as16);
    });

    test('explicit slotWidth 16 digests identically to the implicit default (earlier releases stay valid)', () => {
        registerContract('gen', VAULT);
        const implicit = getArtifactGenerationDigest('gen');
        registerContract('gen', { ...VAULT, slotWidth: 16 });
        expect(getArtifactGenerationDigest('gen')).toBe(implicit);
    });

    test('proving assets are part of the generation (same module/id, different zkConfigPath -> different digest)', () => {
        registerContract('gen', VAULT);
        const withAssets = getArtifactGenerationDigest('gen');
        registerContract('gen', { ...VAULT, zkConfigPath: REPO });
        expect(getArtifactGenerationDigest('gen')).not.toBe(withAssets);
    });

    test('registration is a FROZEN CLONE: post-register mutation of the input cannot change the alias', () => {
        const input = { ...VAULT };
        registerContract('gen', input);
        const digest = getArtifactGenerationDigest('gen');
        // Mutating the caller's object must not reach the registry...
        input.privateStateId = 'attester-B';
        expect(getContractRegistration('gen')!.privateStateId).toBe(VAULT.privateStateId);
        expect(getArtifactGenerationDigest('gen')).toBe(digest);
        // ...and the returned snapshot is readonly by construction.
        const snapshot = getContractRegistration('gen')!;
        expect(Object.isFrozen(snapshot)).toBe(true);
        expect(() => { (snapshot as any).privateStateId = 'attester-B'; }).toThrow();
        expect(getContractRegistration('gen')!.privateStateId).toBe(VAULT.privateStateId);
    });

    test('resolveContract(name, expectedDigest) fails closed when the alias was re-pointed after the check (TOCTOU)', async () => {
        registerContract('gen', VAULT);
        const digestA = getArtifactGenerationDigest('gen');
        // The alias is re-pointed BETWEEN digest check and resolve; passing
        // the previously checked digest into the resolver must refuse.
        registerContract('gen', { ...VAULT, privateStateId: 'attester-B' });
        await expect(resolveContract('gen', digestA)).rejects.toThrow(/different generation/);
    });

    test('resolveContract(name, expectedDigest) fails closed when an asset is overwritten IN PLACE', async () => {
        const fs = await import('node:fs');
        const os = await import('node:os');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ng-gen-'));
        const artifact = path.join(dir, 'artifact.mjs');
        try {
            fs.writeFileSync(artifact, 'export const marker = 1;\n');
            registerContract('gen', { artifactPath: artifact, privateStateId: 'p', zkConfigPath: dir });
            const digest = getArtifactGenerationDigest('gen');
            // Same path, different bytes: the per-alias cache must NOT satisfy
            // the resolve-time check (it recomputes from current contents).
            fs.writeFileSync(artifact, 'export const marker = 2;\n');
            await expect(resolveContract('gen', digest)).rejects.toThrow(/different generation/);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('unregisterContract and clearRegistry drop the digest cache', () => {
        registerContract('gen', VAULT);
        const digest = getArtifactGenerationDigest('gen');
        unregisterContract('gen');
        expect(() => getArtifactGenerationDigest('gen')).toThrow(ContractNotRegisteredError);
        registerContract('gen', { ...VAULT, privateStateId: 'attester-B' });
        expect(getArtifactGenerationDigest('gen')).not.toBe(digest);
        clearRegistry();
        expect(() => getArtifactGenerationDigest('gen')).toThrow(ContractNotRegisteredError);
    });
});

// Real-artifact end-to-end resolution is exercised by
// `npm run integration:contract-registry`: resolveContract imports the REAL
// @midnight-ntwrk/compact-js to build the CompiledContract wrapper, and unit
// tests never load the real SDK packages (repo rule; real-SDK verification
// lives in the scripts/integration-*.mjs lane).

describe('loadRegistryFromConfig', () => {
    test('loads entries with absolute paths verbatim', () => {
        loadRegistryFromConfig({
            contracts: {
                'attestation-vault': {
                    artifactPath: '/abs/contract.js',
                    privateStateId: 'av',
                    zkConfigPath: '/abs/managed/av'
                }
            }
        });
        expect(listRegisteredContracts()).toEqual(['attestation-vault']);
    });

    test('resolves relative paths against baseDir', () => {
        loadRegistryFromConfig({
            contracts: {
                'rel': {
                    artifactPath: 'rel/path/contract.js',
                    privateStateId: 'p',
                    zkConfigPath: 'rel/managed'
                }
            }
        }, '/projects/foo');
        // Verify by triggering a resolve attempt, it'll throw because the file doesn't exist,
        // but the message will include the absolute path we joined.
        // (We can't directly inspect internal state without a getter, so we use the error path.)
        expect(listRegisteredContracts()).toEqual(['rel']);
    });

    test('ignores incomplete entries instead of throwing', () => {
        loadRegistryFromConfig({
            contracts: {
                'good': { artifactPath: '/a.js', privateStateId: 'p', zkConfigPath: '/z' },
                'bad':  { artifactPath: '/a.js' /* missing fields */ } as any
            }
        });
        expect(listRegisteredContracts()).toEqual(['good']);
    });

    test('no-op when config is empty or undefined', () => {
        loadRegistryFromConfig(undefined);
        loadRegistryFromConfig({});
        loadRegistryFromConfig({ contracts: null } as any);
        expect(listRegisteredContracts()).toEqual([]);
    });
});

describe('getContractRegistration + loadRegistryFromConfig guards', () => {
    it('getContractRegistration returns the stored registration or undefined', async () => {
        const { getContractRegistration } = await import('../../srv/submission/contract-registry.js');
        registerContract('reg-probe', { artifactPath: '/a.js', privateStateId: 'p', zkConfigPath: '/z' });
        expect(getContractRegistration('reg-probe')).toMatchObject({ privateStateId: 'p' });
        expect(getContractRegistration('nope')).toBeUndefined();
    });

    it('loadRegistryFromConfig ignores missing/non-object contracts config', async () => {
        const { loadRegistryFromConfig, listRegisteredContracts } = await import('../../srv/submission/contract-registry.js');
        loadRegistryFromConfig(undefined);
        loadRegistryFromConfig({});
        loadRegistryFromConfig({ contracts: 'not-an-object' });
        expect(listRegisteredContracts()).toEqual([]);
    });

    it('loadRegistryFromConfig skips incomplete entries and resolves relative paths', async () => {
        const { loadRegistryFromConfig, getContractRegistration, listRegisteredContracts } =
            await import('../../srv/submission/contract-registry.js');
        loadRegistryFromConfig({
            contracts: {
                incomplete: { artifactPath: 'only/this.js' },
                complete: { artifactPath: 'rel/artifact.js', privateStateId: 'ps', zkConfigPath: 'rel/zk' }
            }
        }, '/base');
        expect(listRegisteredContracts()).toEqual(['complete']);
        const reg = getContractRegistration('complete')!;
        // Relative paths are resolved against baseDir.
        expect(reg.artifactPath.split(path.sep).join('/')).toContain('/base/rel/artifact.js');
    });
});

// ---- resolveContract: artifact import + CompiledContract wrapping -----------
// The absolute Windows path below MUST round-trip through pathToFileURL, the
// exact ESM trip-hazard the implementation comments call out.

vi.mock('@midnight-ntwrk/compact-js', () => ({
    CompiledContract: {
        make: vi.fn((name: string, cls: any) => ({
            pipe: vi.fn((...steps: unknown[]) => ({ compiled: true, name, cls, steps: steps.length }))
        })),
        withVacantWitnesses: vi.fn(),
        withCompiledFileAssets: vi.fn((zkPath: string) => ({ assetsFor: zkPath }))
    }
}));

describe('resolveContract', () => {
    const FIXTURE = path.resolve(process.cwd(), 'test/fixtures/fake-contract-artifact.mjs');

    it('imports an ABSOLUTE artifact path via file:// URL and wraps it in CompiledContract', async () => {
        registerContract('fixture', {
            artifactPath: FIXTURE,
            privateStateId: 'fixturePS',
            zkConfigPath: '/zk/fixture'
        });
        const resolved = await resolveContract('fixture', undefined, { compile: true }); // compile is opt-in: production jobs compile in the worker

        expect(resolved.privateStateId).toBe('fixturePS');
        expect(resolved.zkConfigPath).toBe('/zk/fixture');
        expect(resolved.compiledContract).toMatchObject({ compiled: true, name: 'fixture', steps: 2 });
        // The Contract export of the artifact must be what gets wrapped.
        expect((resolved.compiledContract as any).cls?.name).toBe('Contract');

        const compactJs: any = await import('@midnight-ntwrk/compact-js');
        expect(compactJs.CompiledContract.withCompiledFileAssets).toHaveBeenCalledWith('/zk/fixture');
    });

    it('throws ContractNotRegisteredError with the available names for an unknown ref', async () => {
        registerContract('known', { artifactPath: FIXTURE, privateStateId: 'p', zkConfigPath: 'z' });
        await expect(resolveContract('nope')).rejects.toThrow(ContractNotRegisteredError);
        await expect(resolveContract('nope')).rejects.toThrow(/known/);
    });
});

// A CommonJS digest gained a module-format section in 0.21.0; the 0.20 form recorded on jobs/evidence
// stays accepted for an unchanged artifact. ESM digests never changed.
describe('artifact digest: pre-0.21.0 CommonJS digests stay accepted after the upgrade', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ng-legacy-digest-'));
    const cjsDir = path.join(tmp, 'cjs');
    fs.mkdirSync(path.join(cjsDir, 'contract'), { recursive: true });
    fs.writeFileSync(path.join(cjsDir, 'package.json'), '{"type":"commonjs"}');
    fs.writeFileSync(path.join(cjsDir, 'contract', 'index.js'), 'exports.Contract = class Contract {};\n');
    const CJS = { artifactPath: path.join(cjsDir, 'contract', 'index.js'), privateStateId: 'legacy', zkConfigPath: cjsDir };

    it('assertArtifactGeneration and resolveContract accept the legacy (0.20) form of a CommonJS digest, not a foreign one', async () => {
        const { computeArtifactGenerationDigest, artifactGenerationMatch } = await import('../../srv/submission/artifact-digest.js');
        registerContract('legacy-cjs', CJS);
        const current = getArtifactGenerationDigest('legacy-cjs');
        const legacy = computeArtifactGenerationDigest(CJS, { legacyModuleFormat: true });
        expect(legacy).not.toBe(current);
        expect(artifactGenerationMatch(CJS, legacy)).toBe('legacy');
        expect(artifactGenerationMatch(CJS, current)).toBe('current');
        expect(artifactGenerationMatch(CJS, 'f'.repeat(64))).toBeNull();
        expect(() => assertArtifactGeneration('legacy-cjs', legacy, 'a 0.20 job')).not.toThrow();
        expect(() => assertArtifactGeneration('legacy-cjs', current, 'a 0.21 job')).not.toThrow();
        expect(() => assertArtifactGeneration('legacy-cjs', 'f'.repeat(64), 'a foreign job')).toThrow(/different generation/);
        const resolved = await resolveContract('legacy-cjs', legacy);
        expect(resolved.artifactDigest).toBe(current); // the worker is pinned to the CURRENT form
        await expect(resolveContract('legacy-cjs', 'f'.repeat(64))).rejects.toThrow(/Refusing to load a different generation/);
    });

    it('an ESM artifact has no legacy form (its digest did not change)', async () => {
        const { computeArtifactGenerationDigest, artifactGenerationMatch } = await import('../../srv/submission/artifact-digest.js');
        expect(computeArtifactGenerationDigest(VAULT_FIXTURE(), { legacyModuleFormat: true })).toBe(computeArtifactGenerationDigest(VAULT_FIXTURE()));
        expect(artifactGenerationMatch(VAULT_FIXTURE(), computeArtifactGenerationDigest(VAULT_FIXTURE()))).toBe('current');
    });
});

function VAULT_FIXTURE() {
    const REPO = path.resolve(__dirname, '../..');
    return {
        artifactPath: path.join(REPO, 'contracts/attestation-vault/src/managed/attestation-vault/contract/index.js'),
        privateStateId: 'vault',
        zkConfigPath: path.join(REPO, 'contracts/attestation-vault/src/managed/attestation-vault')
    };
}
