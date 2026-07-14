/**
 * Production-path tests for the crawler-free state readers:
 *
 *  - computePredicateClaimKey / computeFieldPredicateClaimKey against the REAL
 *    @midnight-ntwrk/compact-runtime (vitest can import the ESM SDK, jest never
 *    could). The expected hex fixtures pin the persistentHash encoding —
 *    byte-exactness against a LIVE vault was proven in
 *    scripts/spike-state-verification.mjs; these tests keep the encoding from
 *    drifting (refactors, compact-runtime upgrades) without a chain.
 *
 *  - readAttestationStateForContract / readPredicateStateForContract, the
 *    previously untested production wrappers: provider bundle mocked at the
 *    module seam, the artifact loaded through the real
 *    `import(pathToFileURL(...))` path from test/fixtures/fake-vault-artifact.mjs.
 */
import path from 'node:path';

const queryContractState = vi.hoisted(() => (vi.fn()));
const buildContractProviders = vi.hoisted(() => (vi.fn(async () => ({
    publicDataProvider: { queryContractState },
    zkConfigProvider: {},
    proofProvider: {}
}))));

vi.mock('../../srv/midnight/providers', () => ({
    buildContractProviders
}));

import {
    computePredicateClaimKey,
    computeFieldPredicateClaimKey,
    readPredicateStateForContract
} from '../../srv/submission/predicate-state';
import { readAttestationStateForContract } from '../../srv/submission/attestation-state';

const ARTIFACT = path.resolve(__dirname, '../fixtures/fake-vault-artifact.mjs');
const CFG = {
    indexerHttpUrl: 'http://idx',
    indexerWsUrl: 'ws://idx',
    proofServerUrl: 'http://proof',
    zkConfigPath: '/tmp/zk'
};

const PAYLOAD = 'a1'.repeat(32);
const FIELD_KEY = 'b2'.repeat(32);

// Pinned against the encoding live-verified in spike-state-verification.mjs
// (PredicateClaim: Bytes<32> ++ Uint<64> ++ Uint<8>; Field variant adds the
// field key). Regenerate ONLY if the on-chain claim struct itself changes.
const KEY_LE_42000 = '6e20691b65c4d12ea5ec5453461fd9c41b29834423a4b02e54b2d24e03c695c7';
const KEY_GE_42000 = '938f8244f76dc86b191dccda73b934a452c07193075c76f13d72d80ef9f1d483';
const FIELD_KEY_GE_18000 = '56116c3993ae2f0523e5797f0e9304866ab4290e99cc204b3f84e52362f705ae';

beforeEach(() => {
    queryContractState.mockReset();
    buildContractProviders.mockClear();
});

describe('claim-key recomputation (real compact-runtime)', () => {
    it('computePredicateClaimKey reproduces the pinned lessOrEqual key', async () => {
        await expect(computePredicateClaimKey(PAYLOAD, 42000n, 0)).resolves.toBe(KEY_LE_42000);
    });

    it('computePredicateClaimKey reproduces the pinned greaterOrEqual key', async () => {
        await expect(computePredicateClaimKey(PAYLOAD, 42000n, 1)).resolves.toBe(KEY_GE_42000);
    });

    it('computeFieldPredicateClaimKey reproduces the pinned field-bound key', async () => {
        await expect(computeFieldPredicateClaimKey(PAYLOAD, FIELD_KEY, 18000n, 1)).resolves.toBe(FIELD_KEY_GE_18000);
    });

    it('is sensitive to every coordinate (payload, threshold, op, fieldKey)', async () => {
        const base = await computePredicateClaimKey(PAYLOAD, 42000n, 0);
        expect(base).toMatch(/^[0-9a-f]{64}$/);
        await expect(computePredicateClaimKey('ff'.repeat(32), 42000n, 0)).resolves.not.toBe(base);
        await expect(computePredicateClaimKey(PAYLOAD, 42001n, 0)).resolves.not.toBe(base);
        await expect(computePredicateClaimKey(PAYLOAD, 42000n, 1)).resolves.not.toBe(base);

        const field = await computeFieldPredicateClaimKey(PAYLOAD, FIELD_KEY, 42000n, 0);
        expect(field).not.toBe(base);
        await expect(computeFieldPredicateClaimKey(PAYLOAD, 'cc'.repeat(32), 42000n, 0)).resolves.not.toBe(field);
    });
});

describe('readAttestationStateForContract (production wrapper)', () => {
    it('returns null when the contract has no on-chain state', async () => {
        queryContractState.mockResolvedValue(null);
        const result = await readAttestationStateForContract({
            contractAddress: '0xVault', payloadHash: PAYLOAD, artifactPath: ARTIFACT, contractProvidersConfig: CFG
        });
        expect(result).toBeNull();
        expect(buildContractProviders).toHaveBeenCalledWith(CFG);
        // Address is normalized to lowercase before the indexer query.
        expect(queryContractState).toHaveBeenCalledWith('0xvault');
    });

    it('reads attestation + owner + content root out of live state via the artifact ledger', async () => {
        queryContractState.mockResolvedValue({
            data: {
                public_attestations: { [PAYLOAD]: Uint8Array.from([1]) },
                attestation_owners: { [PAYLOAD]: Uint8Array.from([0xbe, 0xef]) },
                content_roots: { [PAYLOAD]: Buffer.from('d4'.repeat(32), 'hex') }
            }
        });
        const result = await readAttestationStateForContract({
            contractAddress: '0xvault',
            payloadHash: PAYLOAD,
            contentRoot: 'D4'.repeat(32), // case-insensitive compare
            artifactPath: ARTIFACT,
            contractProvidersConfig: CFG
        });
        expect(result).toEqual({ attested: true, contentRootOk: true, attesterId: 'beef' });
    });

    it('reports contentRootOk=false for a mismatching anchored root', async () => {
        queryContractState.mockResolvedValue({
            data: {
                public_attestations: { [PAYLOAD]: Uint8Array.from([1]) },
                attestation_owners: {},
                content_roots: { [PAYLOAD]: Buffer.from('d4'.repeat(32), 'hex') }
            }
        });
        const result = await readAttestationStateForContract({
            contractAddress: '0xvault', payloadHash: PAYLOAD, contentRoot: 'e5'.repeat(32),
            artifactPath: ARTIFACT, contractProvidersConfig: CFG
        });
        expect(result).toEqual({ attested: true, contentRootOk: false, attesterId: '' });
    });

    it('accepts a bare StateValue (no .data wrapper)', async () => {
        queryContractState.mockResolvedValue({
            public_attestations: {},
            attestation_owners: {},
            content_roots: {}
        });
        const result = await readAttestationStateForContract({
            contractAddress: '0xvault', payloadHash: PAYLOAD, artifactPath: ARTIFACT, contractProvidersConfig: CFG
        });
        expect(result).toEqual({ attested: false, contentRootOk: false, attesterId: '' });
    });
});

describe('readPredicateStateForContract (production wrapper)', () => {
    it('returns null when the contract has no on-chain state', async () => {
        queryContractState.mockResolvedValue(null);
        const result = await readPredicateStateForContract({
            contractAddress: '0xvault', payloadHash: PAYLOAD, threshold: 42000n, op: 0,
            artifactPath: ARTIFACT, contractProvidersConfig: CFG
        });
        expect(result).toBeNull();
    });

    it('confirms a plain proof via the REAL recomputed claim key in predicate_results', async () => {
        queryContractState.mockResolvedValue({
            data: { predicate_results: { [KEY_LE_42000]: true } }
        });
        const result = await readPredicateStateForContract({
            contractAddress: '0xvault', payloadHash: PAYLOAD, threshold: 42000n, op: 0,
            artifactPath: ARTIFACT, contractProvidersConfig: CFG
        });
        expect(result).toBe(true);
    });

    it('confirms a field-bound proof via field_predicate_results (real field claim key)', async () => {
        queryContractState.mockResolvedValue({
            data: { field_predicate_results: { [FIELD_KEY_GE_18000]: true } }
        });
        const result = await readPredicateStateForContract({
            contractAddress: '0xvault', payloadHash: PAYLOAD, fieldKey: FIELD_KEY, threshold: 18000n, op: 1,
            artifactPath: ARTIFACT, contractProvidersConfig: CFG
        });
        expect(result).toBe(true);
    });

    it('reads as not proven when the claim key is absent or recorded false', async () => {
        queryContractState.mockResolvedValue({
            data: { predicate_results: { [KEY_GE_42000]: false } }
        });
        // absent (different op → different key)
        await expect(readPredicateStateForContract({
            contractAddress: '0xvault', payloadHash: PAYLOAD, threshold: 42000n, op: 0,
            artifactPath: ARTIFACT, contractProvidersConfig: CFG
        })).resolves.toBe(false);
        // present but false
        await expect(readPredicateStateForContract({
            contractAddress: '0xvault', payloadHash: PAYLOAD, threshold: 42000n, op: 1,
            artifactPath: ARTIFACT, contractProvidersConfig: CFG
        })).resolves.toBe(false);
    });

    it('honours injected claim-key computers (the DI seam the handlers use)', async () => {
        const computeClaimKey = vi.fn(async () => 'ab'.repeat(32));
        queryContractState.mockResolvedValue({
            data: { predicate_results: { ['ab'.repeat(32)]: true } }
        });
        const result = await readPredicateStateForContract({
            contractAddress: '0xvault', payloadHash: PAYLOAD, threshold: 5n, op: 1,
            artifactPath: ARTIFACT, contractProvidersConfig: CFG,
            computeClaimKey
        });
        expect(result).toBe(true);
        expect(computeClaimKey).toHaveBeenCalledWith(PAYLOAD, 5n, 1);
    });
});
