/**
 * Crawler-free claim reader over the live contract state. Claim keys and the
 * ledger read live in `@odatano/contract-kit`; this module adds the provider
 * wiring and the per-kind key selection.
 */
import {
    CLAIM_TAG,
    readPredicateResult,
    computeRecordKey,
    computeFieldPredicateClaimKey,
    computeFieldEqualityClaimKey,
    computeFieldMembershipClaimKey,
    computeDocumentIntegrityClaimKey,
    computeDocumentDiffClaimKey,
    expandAllowedMask,
    anchorOf,
    anchoredRootOf,
    type PredicateLedger,
    type PredicateResultKind,
    type ReadPredicateResultDeps
} from '@odatano/contract-kit';
import { importArtifactByPath } from './contract-registry';

export {
    CLAIM_TAG,
    readPredicateResult,
    computeRecordKey,
    computeFieldPredicateClaimKey,
    computeFieldEqualityClaimKey,
    computeFieldMembershipClaimKey,
    computeDocumentIntegrityClaimKey,
    computeDocumentDiffClaimKey,
    expandAllowedMask,
    anchorOf,
    anchoredRootOf
};
export type { PredicateLedger, PredicateResultKind, ReadPredicateResultDeps };

export interface ReadPredicateStateForContractArgs {
    contractAddress: string;
    /** The attester whose record of `payloadHash` carries the claim. */
    attesterId: string;
    payloadHash: string;
    /** Numeric predicates only. */
    threshold?: bigint;
    op?: number;
    /** Required for the numeric and bytes kinds. */
    fieldKey?: string;
    expectedDigest?: string;
    setRoot?: string;
    /** Cross-root claims: document B. */
    payloadHashB?: string;
    /** Defaults to `attesterId`. */
    attesterIdB?: string;
    /** Integrity claim (with payloadHashB). */
    allowedMask?: number;
    /** Diff claim (with payloadHashB). */
    k?: number;
    /** Default 16; only the integrity claim key depends on it. */
    slotWidth?: number;
    artifactPath: string;
    contractProvidersConfig: import('../midnight/providers').ContractProvidersConfig;
    computeFieldClaimKey?: typeof computeFieldPredicateClaimKey;
    nowSeconds?: number;
}

/**
 * Recompute the claim key from the record's current anchor(s) and read it. A
 * claim made under a former anchor misses the map by construction.
 */
export async function readPredicateStateForContract(
    args: ReadPredicateStateForContractArgs
): Promise<boolean | null> {
    const { buildContractProviders } = await import('../midnight/providers.js');
    const bundle = await buildContractProviders(args.contractProvidersConfig);
    const artifact: any = await importArtifactByPath(args.artifactPath);

    const state = await bundle.publicDataProvider.queryContractState(args.contractAddress.toLowerCase());
    if (!state) return null;
    const led = artifact.ledger(state.data ?? state) as PredicateLedger;

    const recordKeyA = await computeRecordKey(args.attesterId, args.payloadHash);
    const anchorA = anchorOf(led, recordKeyA);
    if (anchorA === null) return false;

    const kind: PredicateResultKind = args.payloadHashB
        ? (args.allowedMask !== undefined ? 'integrity' : 'diff')
        : args.expectedDigest ? 'equality'
        : args.setRoot ? 'membership'
        : 'field';
    let claimKey: string;
    if (kind === 'integrity' || kind === 'diff') {
        const recordKeyB = await computeRecordKey(args.attesterIdB ?? args.attesterId, args.payloadHashB!);
        const anchorB = anchorOf(led, recordKeyB);
        if (anchorB === null) return false;
        // A comparison holds only under one shared schema.
        if (anchorA.schema !== anchorB.schema) return false;
        if (kind === 'integrity') {
            claimKey = await computeDocumentIntegrityClaimKey(recordKeyA, anchorA.root, recordKeyB, anchorB.root, anchorA.schema, args.allowedMask!, args.slotWidth ?? 16);
        } else {
            if (args.k === undefined) throw new Error('k is required for a document-diff claim');
            claimKey = await computeDocumentDiffClaimKey(recordKeyA, anchorA.root, recordKeyB, anchorB.root, anchorA.schema, args.k);
        }
    } else if (kind === 'equality') {
        if (!args.fieldKey) throw new Error('fieldKey is required for a bytes-equality claim');
        claimKey = await computeFieldEqualityClaimKey(recordKeyA, anchorA.root, anchorA.schema, args.fieldKey, args.expectedDigest!);
    } else if (kind === 'membership') {
        if (!args.fieldKey) throw new Error('fieldKey is required for a set-membership claim');
        claimKey = await computeFieldMembershipClaimKey(recordKeyA, anchorA.root, anchorA.schema, args.fieldKey, args.setRoot!);
    } else {
        if (args.threshold === undefined || args.op === undefined) {
            throw new Error('threshold and op are required for a numeric predicate claim');
        }
        if (!args.fieldKey) throw new Error('fieldKey is required for a numeric predicate claim');
        claimKey = await (args.computeFieldClaimKey ?? computeFieldPredicateClaimKey)(
            recordKeyA, anchorA.root, anchorA.schema, args.fieldKey, args.threshold, args.op);
    }

    return readPredicateResult({
        contractAddress: args.contractAddress,
        claimKey,
        kind,
        ledger: artifact.ledger,
        queryContractState: async () => state,
        nowSeconds: args.nowSeconds
    });
}
