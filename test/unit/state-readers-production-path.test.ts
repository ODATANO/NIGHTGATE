/**
 * Production-path tests for the crawler-free state readers:
 *
 *  - the claim-key recomputes against the REAL @midnight-ntwrk/compact-runtime.
 *    The expected hex fixtures pin the persistentHash encoding (type tag,
 *    payload, anchored root, coordinates); byte-exactness against the
 *    circuits is pinned in test/integration/attestation-vault.test.ts; these
 *    tests keep the encoding from drifting (refactors, compact-runtime
 *    upgrades) without a chain.
 *
 *  - readAttestationStateForContract / readPredicateStateForContract, the
 *    production wrappers: provider bundle mocked at the module seam, the
 *    artifact loaded through the real `import(pathToFileURL(...))` path from
 *    test/fixtures/fake-vault-artifact.mjs.
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
    computeDocumentIntegrityClaimKey,
    computeDocumentDiffClaimKey,
    computeRecordKey,
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
const ATTESTER = 'e0'.repeat(32);
// recordKey(ATTESTER, PAYLOAD): the ledger key the production wrappers read under.
let RK = '';
const ROOT = 'd4'.repeat(32);
const SCHEMA = 'e6'.repeat(32);
const FIELD_KEY = 'b2'.repeat(32);
const EXPECTED_DIGEST = 'c3'.repeat(32);
const SET_ROOT = 'd4'.repeat(32);
const NOW = 1_700_000_000;

// Pinned against the encoding verified in test/integration/attestation-vault.test.ts.
// Regenerate ONLY if an on-chain claim struct itself changes.
const FIELD_KEY_GE_18000 = '12d8f129ef1ad9f447c8297b548f1d1ce3a37b7a4b584712c1ccca59e1097952';
const EQUALITY_KEY = '2512125fe9c4c8027c2ff66109ad6678bd3d9d82254f27a4c285d51d0f388b72';
const MEMBERSHIP_KEY = '38ed70206b44916e6b82abe2893cce2980da8d792359430b5c984311ee34c29c';
const INTEGRITY_KEY = '1335f5cb10f87d31a0a8b6854196247311557b5854791de293c70a1cf114b060';
const DIFF_KEY = '94aaae938363dfc8c8fc7b35021f6e2cd7fa9f09ded9c8bfe2044a3750e1ddb9';
const RECORD_KEY = 'ed7d3f88cb898814c41f15a79bb24e55f725edeef8ae64b2d94d419fcc91ddbd';

beforeAll(async () => {
    RK = await computeRecordKey(ATTESTER, PAYLOAD);
});

beforeEach(() => {
    queryContractState.mockReset();
    buildContractProviders.mockClear();
});

describe('claim-key recomputation (real compact-runtime)', () => {
    it('computeFieldPredicateClaimKey reproduces the pinned field-bound key', async () => {
        await expect(computeFieldPredicateClaimKey(PAYLOAD, ROOT, SCHEMA, FIELD_KEY, 18000n, 1)).resolves.toBe(FIELD_KEY_GE_18000);
    });

    it('computeFieldEqualityClaimKey reproduces the pinned equality key', async () => {
        await expect(computeFieldEqualityClaimKey(PAYLOAD, ROOT, SCHEMA, FIELD_KEY, EXPECTED_DIGEST)).resolves.toBe(EQUALITY_KEY);
    });

    it('computeFieldMembershipClaimKey reproduces the pinned membership key', async () => {
        await expect(computeFieldMembershipClaimKey(PAYLOAD, ROOT, SCHEMA, FIELD_KEY, SET_ROOT)).resolves.toBe(MEMBERSHIP_KEY);
    });

    it('the cross-root keys reproduce their pins', async () => {
        await expect(computeDocumentIntegrityClaimKey(PAYLOAD, ROOT, 'a2'.repeat(32), 'd5'.repeat(32), SCHEMA, 0b101)).resolves.toBe(INTEGRITY_KEY);
        await expect(computeDocumentDiffClaimKey(PAYLOAD, ROOT, 'a2'.repeat(32), 'd5'.repeat(32), SCHEMA, 2)).resolves.toBe(DIFF_KEY);
    });

    it('the record key reproduces its pin and binds attester and payload', async () => {
        await expect(computeRecordKey(ATTESTER, PAYLOAD)).resolves.toBe(RECORD_KEY);
        await expect(computeRecordKey('e1'.repeat(32), PAYLOAD)).resolves.not.toBe(RECORD_KEY);
        await expect(computeRecordKey(ATTESTER, 'a2'.repeat(32))).resolves.not.toBe(RECORD_KEY);
        await expect(computeRecordKey(PAYLOAD, ATTESTER)).resolves.not.toBe(RECORD_KEY);
    });

    it('equality and membership keys differ for identical coordinates (type tags)', async () => {
        const eq = await computeFieldEqualityClaimKey(PAYLOAD, ROOT, SCHEMA, FIELD_KEY, 'e5'.repeat(32));
        const mem = await computeFieldMembershipClaimKey(PAYLOAD, ROOT, SCHEMA, FIELD_KEY, 'e5'.repeat(32));
        expect(eq).toMatch(/^[0-9a-f]{64}$/);
        expect(mem).not.toBe(eq);
    });

    it('is sensitive to every coordinate (record, root, schema, threshold, op, fieldKey)', async () => {
        const base = await computeFieldPredicateClaimKey(PAYLOAD, ROOT, SCHEMA, FIELD_KEY, 42000n, 0);
        expect(base).toMatch(/^[0-9a-f]{64}$/);
        await expect(computeFieldPredicateClaimKey('ff'.repeat(32), ROOT, SCHEMA, FIELD_KEY, 42000n, 0)).resolves.not.toBe(base);
        await expect(computeFieldPredicateClaimKey(PAYLOAD, 'ee'.repeat(32), SCHEMA, FIELD_KEY, 42000n, 0)).resolves.not.toBe(base);
        await expect(computeFieldPredicateClaimKey(PAYLOAD, ROOT, 'ed'.repeat(32), FIELD_KEY, 42000n, 0)).resolves.not.toBe(base);
        await expect(computeFieldPredicateClaimKey(PAYLOAD, ROOT, SCHEMA, FIELD_KEY, 42001n, 0)).resolves.not.toBe(base);
        await expect(computeFieldPredicateClaimKey(PAYLOAD, ROOT, SCHEMA, FIELD_KEY, 42000n, 1)).resolves.not.toBe(base);
        await expect(computeFieldPredicateClaimKey(PAYLOAD, ROOT, SCHEMA, 'cc'.repeat(32), 42000n, 0)).resolves.not.toBe(base);
    });
});

describe('readAttestationStateForContract (production wrapper)', () => {
    it('returns null when the contract has no on-chain state', async () => {
        queryContractState.mockResolvedValue(null);
        const result = await readAttestationStateForContract({
            contractAddress: '0xVault', attesterId: ATTESTER, payloadHash: PAYLOAD, artifactPath: ARTIFACT, contractProvidersConfig: CFG
        });
        expect(result).toBeNull();
        expect(buildContractProviders).toHaveBeenCalledWith(CFG);
        // Address is normalized to lowercase before the indexer query.
        expect(queryContractState).toHaveBeenCalledWith('0xvault');
    });

    it('reads attestation + owner + anchor out of live state via the artifact ledger', async () => {
        queryContractState.mockResolvedValue({
            data: {
                attestations: { [RK]: { payload_hash: Buffer.from(PAYLOAD, 'hex'), metadata_hash: new Uint8Array(32), owner: Buffer.from(ATTESTER, 'hex'), document_id: Uint8Array.from([0x77]) } },
                content_anchors: { [RK]: { root: Buffer.from(ROOT, 'hex'), schema: Buffer.from('d5'.repeat(32), 'hex') } }
            }
        });
        const result = await readAttestationStateForContract({
            contractAddress: '0xvault',
            attesterId: ATTESTER,
            payloadHash: PAYLOAD,
            contentRoot: 'D4'.repeat(32), // case-insensitive compare
            artifactPath: ARTIFACT,
            contractProvidersConfig: CFG
        });
        expect(result).toEqual({
            attested: true, contentRootOk: true, schemaOk: false, bindingRegistered: false, attesterId: ATTESTER, payloadHash: PAYLOAD, recordKey: RK,
            documentId: '77', contentRoot: ROOT, schemaId: 'd5'.repeat(32)
        });
    });

    it('reports contentRootOk=false for a mismatching anchored root', async () => {
        queryContractState.mockResolvedValue({
            data: {
                attestations: { [RK]: { payload_hash: Buffer.from(PAYLOAD, 'hex'), metadata_hash: new Uint8Array(32), owner: Buffer.from(ATTESTER, 'hex'), document_id: new Uint8Array(32) } },
                content_anchors: { [RK]: { root: Buffer.from(ROOT, 'hex'), schema: new Uint8Array(32) } }
            }
        });
        const result = await readAttestationStateForContract({
            contractAddress: '0xvault', attesterId: ATTESTER, payloadHash: PAYLOAD, contentRoot: 'e5'.repeat(32),
            artifactPath: ARTIFACT, contractProvidersConfig: CFG
        });
        expect(result).toMatchObject({ attested: true, contentRootOk: false, attesterId: ATTESTER, documentId: '' });
    });

    it('accepts a bare StateValue (no .data wrapper)', async () => {
        queryContractState.mockResolvedValue({ attestations: {}, content_anchors: {}, document_bindings: {} });
        const result = await readAttestationStateForContract({
            contractAddress: '0xvault', attesterId: ATTESTER, payloadHash: PAYLOAD, artifactPath: ARTIFACT, contractProvidersConfig: CFG
        });
        expect(result).toEqual({
            attested: false, contentRootOk: false, schemaOk: false, bindingRegistered: false, attesterId: '', payloadHash: '', recordKey: RK,
            documentId: '', contentRoot: '', schemaId: ''
        });
    });
});

describe('readPredicateStateForContract (production wrapper)', () => {
    const anchored = () => ({ content_anchors: { [RK]: { root: Buffer.from(ROOT, 'hex'), schema: Buffer.from(SCHEMA, 'hex') } } });
    const fieldKeyGe18000 = () => computeFieldPredicateClaimKey(RK, ROOT, SCHEMA, FIELD_KEY, 18000n, 1);

    it('returns null when the contract has no on-chain state', async () => {
        queryContractState.mockResolvedValue(null);
        const result = await readPredicateStateForContract({
            contractAddress: '0xvault', attesterId: ATTESTER, payloadHash: PAYLOAD, fieldKey: FIELD_KEY, threshold: 42000n, op: 0,
            artifactPath: ARTIFACT, contractProvidersConfig: CFG
        });
        expect(result).toBeNull();
    });

    it('rejects a numeric claim without a fieldKey (numeric claims are field-bound)', async () => {
        queryContractState.mockResolvedValue({ data: anchored() });
        await expect(readPredicateStateForContract({
            contractAddress: '0xvault', attesterId: ATTESTER, payloadHash: PAYLOAD, threshold: 42000n, op: 0,
            artifactPath: ARTIFACT, contractProvidersConfig: CFG
        })).rejects.toThrow(/fieldKey is required/);
    });

    it('reads as not proven when the payload has NO anchor (nothing to bind to)', async () => {
        queryContractState.mockResolvedValue({
            data: { claims: { [await fieldKeyGe18000()]: BigInt(NOW + 100) } }
        });
        await expect(readPredicateStateForContract({
            contractAddress: '0xvault', attesterId: ATTESTER, payloadHash: PAYLOAD, fieldKey: FIELD_KEY, threshold: 18000n, op: 1,
            artifactPath: ARTIFACT, contractProvidersConfig: CFG, nowSeconds: NOW
        })).resolves.toBe(false);
    });

    it('confirms a field-bound proof via the claims map (real field claim key, current anchor)', async () => {
        queryContractState.mockResolvedValue({
            data: { ...anchored(), claims: { [await fieldKeyGe18000()]: BigInt(NOW + 100) } }
        });
        const result = await readPredicateStateForContract({
            contractAddress: '0xvault', attesterId: ATTESTER, payloadHash: PAYLOAD, fieldKey: FIELD_KEY, threshold: 18000n, op: 1,
            artifactPath: ARTIFACT, contractProvidersConfig: CFG, nowSeconds: NOW
        });
        expect(result).toBe(true);
    });

    it('a claim recorded under a FORMER anchor does not verify (takeover and retract semantics)', async () => {
        queryContractState.mockResolvedValue({
            data: {
                content_anchors: { [RK]: { root: Buffer.from('ee'.repeat(32), 'hex'), schema: Buffer.from(SCHEMA, 'hex') } },
                claims: { [await fieldKeyGe18000()]: BigInt(NOW + 100) }
            }
        });
        await expect(readPredicateStateForContract({
            contractAddress: '0xvault', attesterId: ATTESTER, payloadHash: PAYLOAD, fieldKey: FIELD_KEY, threshold: 18000n, op: 1,
            artifactPath: ARTIFACT, contractProvidersConfig: CFG, nowSeconds: NOW
        })).resolves.toBe(false);
    });

    it('the same root re-anchored under another schema does not verify the old claim', async () => {
        queryContractState.mockResolvedValue({
            data: {
                content_anchors: { [RK]: { root: Buffer.from(ROOT, 'hex'), schema: Buffer.from('ed'.repeat(32), 'hex') } },
                claims: { [await fieldKeyGe18000()]: BigInt(NOW + 100) }
            }
        });
        await expect(readPredicateStateForContract({
            contractAddress: '0xvault', attesterId: ATTESTER, payloadHash: PAYLOAD, fieldKey: FIELD_KEY, threshold: 18000n, op: 1,
            artifactPath: ARTIFACT, contractProvidersConfig: CFG, nowSeconds: NOW
        })).resolves.toBe(false);
    });

    it('a comparison claim needs both anchors under ONE schema', async () => {
        const B = 'a2'.repeat(32);
        const RKB = await computeRecordKey(ATTESTER, B);
        const key = await computeDocumentDiffClaimKey(RK, ROOT, RKB, 'd5'.repeat(32), SCHEMA, 2);
        const anchorsSame = {
            [RK]: { root: Buffer.from(ROOT, 'hex'), schema: Buffer.from(SCHEMA, 'hex') },
            [RKB]: { root: Buffer.from('d5'.repeat(32), 'hex'), schema: Buffer.from(SCHEMA, 'hex') }
        };
        queryContractState.mockResolvedValue({ data: { content_anchors: anchorsSame, claims: { [key]: BigInt(NOW + 100) } } });
        await expect(readPredicateStateForContract({
            contractAddress: '0xvault', attesterId: ATTESTER, payloadHash: PAYLOAD, payloadHashB: B, k: 2,
            artifactPath: ARTIFACT, contractProvidersConfig: CFG, nowSeconds: NOW
        })).resolves.toBe(true);
        const anchorsDrifted = { ...anchorsSame, [RKB]: { root: Buffer.from('d5'.repeat(32), 'hex'), schema: Buffer.from('ed'.repeat(32), 'hex') } };
        queryContractState.mockResolvedValue({ data: { content_anchors: anchorsDrifted, claims: { [key]: BigInt(NOW + 100) } } });
        await expect(readPredicateStateForContract({
            contractAddress: '0xvault', attesterId: ATTESTER, payloadHash: PAYLOAD, payloadHashB: B, k: 2,
            artifactPath: ARTIFACT, contractProvidersConfig: CFG, nowSeconds: NOW
        })).resolves.toBe(false);
    });

    it('reads as not proven when the claim key is absent or expired', async () => {
        queryContractState.mockResolvedValue({
            data: { ...anchored(), claims: { [await fieldKeyGe18000()]: BigInt(NOW) } }
        });
        // absent (different op -> different key)
        await expect(readPredicateStateForContract({
            contractAddress: '0xvault', attesterId: ATTESTER, payloadHash: PAYLOAD, fieldKey: FIELD_KEY, threshold: 18000n, op: 0,
            artifactPath: ARTIFACT, contractProvidersConfig: CFG, nowSeconds: NOW
        })).resolves.toBe(false);
        // present but expired
        await expect(readPredicateStateForContract({
            contractAddress: '0xvault', attesterId: ATTESTER, payloadHash: PAYLOAD, fieldKey: FIELD_KEY, threshold: 18000n, op: 1,
            artifactPath: ARTIFACT, contractProvidersConfig: CFG, nowSeconds: NOW
        })).resolves.toBe(false);
    });

    it('honours injected claim-key computers (the DI seam the handlers use)', async () => {
        const computeFieldClaimKey = vi.fn(async () => 'ab'.repeat(32));
        queryContractState.mockResolvedValue({
            data: { ...anchored(), claims: { ['ab'.repeat(32)]: BigInt(NOW + 100) } }
        });
        const result = await readPredicateStateForContract({
            contractAddress: '0xvault', attesterId: ATTESTER, payloadHash: PAYLOAD, fieldKey: FIELD_KEY, threshold: 5n, op: 1,
            artifactPath: ARTIFACT, contractProvidersConfig: CFG, nowSeconds: NOW,
            computeFieldClaimKey
        });
        expect(result).toBe(true);
        expect(computeFieldClaimKey).toHaveBeenCalledWith(RK, ROOT, SCHEMA, FIELD_KEY, 5n, 1);
    });
});
