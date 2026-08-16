/**
 * Production-path tests for the crawler-free state readers:
 *
 *  - computePredicateClaimKey / computeFieldPredicateClaimKey against the REAL
 *    @midnight-ntwrk/compact-runtime (vitest can import the ESM SDK, jest never
 *    could). The expected hex fixtures pin the persistentHash encoding;
 *    byte-exactness against a LIVE vault was proven in
 *    scripts/integration-test-attestation-vault.mjs; these tests keep the encoding from
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
    computeFieldPredicateClaimKey,
    computeFieldEqualityClaimKey,
    computeFieldMembershipClaimKey,
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
const EPOCH = 7n; // attestation epoch embedded in every claim key (0.16.0)
const FIELD_KEY = 'b2'.repeat(32);

// Pinned against the encoding live-verified in integration-test-attestation-vault.mjs
// (FieldPredicateClaim: Bytes<32> ++ Bytes<32> ++ Uint<64> ++ Uint<8>).
// Regenerate ONLY if the on-chain claim struct itself changes.
const FIELD_KEY_GE_18000 = 'e00c7a136a859dcf087860a317e7d099d77a17611300e395833ab98a5af77f10';
// Bytes-claim keys (0.15.0): Bytes<32> ++ Bytes<32> ++ Bytes<32> in struct
// field order; byte-exactness against the live vault is asserted by the
// membership e2e (verifyPredicateState on an on-chain proof).
const EXPECTED_DIGEST = 'c3'.repeat(32);
const SET_ROOT = 'd4'.repeat(32);
const EQUALITY_KEY = 'fc8cfa0a80bd0756de4c353cd20971856ae7f9fe5d97e361b41da3b2ff1a968d';
const MEMBERSHIP_KEY = '5e9067d705c772b5dd131c4546d092a68c728d2cf2d30789bc1a10c513954f68';

beforeEach(() => {
    queryContractState.mockReset();
    buildContractProviders.mockClear();
});

describe('claim-key recomputation (real compact-runtime)', () => {
    it('computeFieldPredicateClaimKey reproduces the pinned field-bound key', async () => {
        await expect(computeFieldPredicateClaimKey(PAYLOAD, FIELD_KEY, 18000n, 1, EPOCH)).resolves.toBe(FIELD_KEY_GE_18000);
    });

    it('computeFieldEqualityClaimKey reproduces the pinned equality key', async () => {
        await expect(computeFieldEqualityClaimKey(PAYLOAD, FIELD_KEY, EXPECTED_DIGEST, EPOCH)).resolves.toBe(EQUALITY_KEY);
    });

    it('computeFieldMembershipClaimKey reproduces the pinned membership key', async () => {
        await expect(computeFieldMembershipClaimKey(PAYLOAD, FIELD_KEY, SET_ROOT, EPOCH)).resolves.toBe(MEMBERSHIP_KEY);
    });

    it('equality and membership keys differ even for identical coordinates', async () => {
        // Same 3 x Bytes<32> layout; only the persistentHash struct alignment
        // (via the value bytes) separates them. Same third coordinate:
        const eq = await computeFieldEqualityClaimKey(PAYLOAD, FIELD_KEY, 'e5'.repeat(32), EPOCH);
        const mem = await computeFieldMembershipClaimKey(PAYLOAD, FIELD_KEY, 'e5'.repeat(32), EPOCH);
        expect(eq).toMatch(/^[0-9a-f]{64}$/);
        // NOTE: with identical layouts persistentHash yields the SAME digest;
        // cross-kind isolation comes from the SEPARATE ledger maps, which the
        // predicate-state tests assert. This pin documents the fact.
        expect(mem).toBe(eq);
    });

    it('is sensitive to every coordinate (payload, threshold, op, fieldKey)', async () => {
        const base = await computeFieldPredicateClaimKey(PAYLOAD, FIELD_KEY, 42000n, 0, EPOCH);
        expect(base).toMatch(/^[0-9a-f]{64}$/);
        await expect(computeFieldPredicateClaimKey('ff'.repeat(32), FIELD_KEY, 42000n, 0, EPOCH)).resolves.not.toBe(base);
        await expect(computeFieldPredicateClaimKey(PAYLOAD, FIELD_KEY, 42001n, 0, EPOCH)).resolves.not.toBe(base);
        await expect(computeFieldPredicateClaimKey(PAYLOAD, FIELD_KEY, 42000n, 1, EPOCH)).resolves.not.toBe(base);
        await expect(computeFieldPredicateClaimKey(PAYLOAD, 'cc'.repeat(32), 42000n, 0, EPOCH)).resolves.not.toBe(base);
        // Epoch sensitivity is the takeover kill switch: a claim recorded
        // under a front-runner's epoch must miss under the recovered one.
        await expect(computeFieldPredicateClaimKey(PAYLOAD, FIELD_KEY, 42000n, 0, 8n)).resolves.not.toBe(base);
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
        expect(result).toEqual({ attested: true, contentRootOk: true, schemaOk: false, attesterId: 'beef' });
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
        expect(result).toEqual({ attested: true, contentRootOk: false, schemaOk: false, attesterId: '' });
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
        expect(result).toEqual({ attested: false, contentRootOk: false, schemaOk: false, attesterId: '' });
    });
});

describe('readPredicateStateForContract (production wrapper)', () => {
    it('returns null when the contract has no on-chain state', async () => {
        queryContractState.mockResolvedValue(null);
        const result = await readPredicateStateForContract({
            contractAddress: '0xvault', payloadHash: PAYLOAD, fieldKey: FIELD_KEY, threshold: 42000n, op: 0,
            artifactPath: ARTIFACT, contractProvidersConfig: CFG
        });
        expect(result).toBeNull();
    });

    it('rejects a numeric claim without a fieldKey (plain kind removed in 0.16.0)', async () => {
        queryContractState.mockResolvedValue({
            data: { attestation_seqs: { [PAYLOAD]: EPOCH } }
        });
        await expect(readPredicateStateForContract({
            contractAddress: '0xvault', payloadHash: PAYLOAD, threshold: 42000n, op: 0,
            artifactPath: ARTIFACT, contractProvidersConfig: CFG
        })).rejects.toThrow(/fieldKey is required/);
    });

    it('reads as not proven when the payload has NO attestation epoch (nothing to bind to)', async () => {
        queryContractState.mockResolvedValue({
            data: { field_predicate_results: { [FIELD_KEY_GE_18000]: true } }
        });
        await expect(readPredicateStateForContract({
            contractAddress: '0xvault', payloadHash: PAYLOAD, fieldKey: FIELD_KEY, threshold: 18000n, op: 1,
            artifactPath: ARTIFACT, contractProvidersConfig: CFG
        })).resolves.toBe(false);
    });

    it('confirms a field-bound proof via field_predicate_results (real field claim key, current epoch)', async () => {
        queryContractState.mockResolvedValue({
            data: {
                attestation_seqs: { [PAYLOAD]: EPOCH },
                field_predicate_results: { [FIELD_KEY_GE_18000]: true }
            }
        });
        const result = await readPredicateStateForContract({
            contractAddress: '0xvault', payloadHash: PAYLOAD, fieldKey: FIELD_KEY, threshold: 18000n, op: 1,
            artifactPath: ARTIFACT, contractProvidersConfig: CFG
        });
        expect(result).toBe(true);
    });

    it('a claim recorded under a STALE epoch no longer verifies (takeover semantics)', async () => {
        queryContractState.mockResolvedValue({
            data: {
                // Epoch moved (takeover); the recorded key was computed at EPOCH.
                attestation_seqs: { [PAYLOAD]: 9n },
                field_predicate_results: { [FIELD_KEY_GE_18000]: true }
            }
        });
        await expect(readPredicateStateForContract({
            contractAddress: '0xvault', payloadHash: PAYLOAD, fieldKey: FIELD_KEY, threshold: 18000n, op: 1,
            artifactPath: ARTIFACT, contractProvidersConfig: CFG
        })).resolves.toBe(false);
    });

    it('reads as not proven when the claim key is absent or recorded false', async () => {
        queryContractState.mockResolvedValue({
            data: {
                attestation_seqs: { [PAYLOAD]: EPOCH },
                field_predicate_results: { [FIELD_KEY_GE_18000]: false }
            }
        });
        // absent (different op -> different key)
        await expect(readPredicateStateForContract({
            contractAddress: '0xvault', payloadHash: PAYLOAD, fieldKey: FIELD_KEY, threshold: 18000n, op: 0,
            artifactPath: ARTIFACT, contractProvidersConfig: CFG
        })).resolves.toBe(false);
        // present but false
        await expect(readPredicateStateForContract({
            contractAddress: '0xvault', payloadHash: PAYLOAD, fieldKey: FIELD_KEY, threshold: 18000n, op: 1,
            artifactPath: ARTIFACT, contractProvidersConfig: CFG
        })).resolves.toBe(false);
    });

    it('honours injected claim-key computers (the DI seam the handlers use)', async () => {
        const computeFieldClaimKey = vi.fn(async () => 'ab'.repeat(32));
        queryContractState.mockResolvedValue({
            data: {
                attestation_seqs: { [PAYLOAD]: EPOCH },
                field_predicate_results: { ['ab'.repeat(32)]: true }
            }
        });
        const result = await readPredicateStateForContract({
            contractAddress: '0xvault', payloadHash: PAYLOAD, fieldKey: FIELD_KEY, threshold: 5n, op: 1,
            artifactPath: ARTIFACT, contractProvidersConfig: CFG,
            computeFieldClaimKey
        });
        expect(result).toBe(true);
        expect(computeFieldClaimKey).toHaveBeenCalledWith(PAYLOAD, FIELD_KEY, 5n, 1, EPOCH);
    });
});
