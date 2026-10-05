/**
 * Checks proven claims directly in the live contract state, without the crawler.
 * A claim key is the map key under which the contract stores one proven claim.
 * `@odatano/contract-kit` computes the keys. This module picks the right key for each claim type.
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
    /** The attester under whose entry for `payloadHash` the claim is stored. */
    attesterId: string;
    payloadHash: string;
    /** Numeric predicates only. */
    threshold?: bigint;
    op?: number;
    /** Required for the numeric and bytes kinds. */
    fieldKey?: string;
    expectedDigest?: string;
    setRoot?: string;
    /** Claims that compare two documents: the second document. */
    payloadHashB?: string;
    /** Defaults to `attesterId`. */
    attesterIdB?: string;
    /** Set for an integrity claim: the two documents differ only in these fields. */
    allowedMask?: number;
    /** Set for a difference claim: at least k fields differ between the two documents. */
    k?: number;
    /** Number of field slots, default 16. Only the integrity claim key uses it. */
    slotWidth?: number;
    artifactPath: string;
    contractProvidersConfig: import('../midnight/providers').ContractProvidersConfig;
    computeFieldClaimKey?: typeof computeFieldPredicateClaimKey;
    nowSeconds?: number;
}

/**
 * Recompute the claim key from the document root stored on chain right now, then look it up.
 * A claim made against an older root of the same document is therefore not found.
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
        // Two documents can only be compared if they use the same field layout.
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
