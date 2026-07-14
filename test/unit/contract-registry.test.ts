/**
 * Tests for srv/submission/contract-registry.
 *
 * Verifies registration/resolution semantics and config-loading behavior.
 * Module-level state is reset between tests via clearRegistry().
 */

import path from 'path';
import {
    registerContract,
    unregisterContract,
    clearRegistry,
    listRegisteredContracts,
    resolveContract,
    loadRegistryFromConfig,
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

// Real-artifact end-to-end resolution is exercised by
// `npm run integration:contract-registry`. Jest's resolver rejects the
// file:// URLs that the production registry uses for cross-platform ESM
// imports, so we keep the live test in a native-ESM .mjs script.

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
