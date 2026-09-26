/**
 * Traits of every durable background-job kind, declared once so the runner's
 * lists cannot drift: a kind without traits, or without a processor, fails at boot.
 */
export interface JobKindTraits {
    /** Runs a full ZK proof: all heavy kinds share one concurrency cap (one proof server saturates at four). */
    heavy: boolean;
    /** Drives child commands; the parent row has no txHash and reconciles from its children. */
    workflowParent: boolean;
    /** `txHash` is the ledger identifier, which only the indexer resolves (never the crawler). */
    identifierKeyed: boolean;
    /** One job at a time: its work serializes on the worker thread anyway, parallel runs only delay the first result. */
    serial?: boolean;
    /** Its product dies with the process (warm facade): pending/running rows end at restart, never re-queue. */
    sessionBound?: boolean;
}

export const LIGHT_KIND: JobKindTraits = { heavy: false, workflowParent: false, identifierKeyed: false };
export const HEAVY_KIND: JobKindTraits = { heavy: true, workflowParent: false, identifierKeyed: false };
/** A proving workflow parent: its own executor proves nothing, but it holds a heavy slot while its children run. */
export const WORKFLOW_PARENT_KIND: JobKindTraits = { heavy: true, workflowParent: true, identifierKeyed: false };

export const JOB_KIND_TRAITS: Readonly<Record<string, JobKindTraits>> = {
    // wallet lifecycle (srv/sessions/wallet-sessions.ts)
    connectWalletForSigning: { ...LIGHT_KIND, serial: true, sessionBound: true },
    registerForDustGeneration: HEAVY_KIND,
    deregisterFromDustGeneration: HEAVY_KIND,
    sendNight: HEAVY_KIND,

    // contracts (srv/submission/handlers.ts)
    deployContract: HEAVY_KIND,
    submitContractCall: HEAVY_KIND,
    submitContractCallBatch: HEAVY_KIND,
    mintShieldedTestToken: HEAVY_KIND,
    anchorDocument: HEAVY_KIND,
    grantDisclosure: HEAVY_KIND,
    revokeDisclosure: HEAVY_KIND,
    registerPassport: HEAVY_KIND,
    retract: HEAVY_KIND,
    // projection catch-up after a post-submit reindex failed; no chain effect
    reindexDisclosures: LIGHT_KIND,

    // proving workflows and their child steps
    issueFieldPredicateAttestation: WORKFLOW_PARENT_KIND,
    issueFieldPredicateAttestationBatch: WORKFLOW_PARENT_KIND,
    issueFieldEqualityAttestation: WORKFLOW_PARENT_KIND,
    issueFieldMembershipAttestation: WORKFLOW_PARENT_KIND,
    issueDocumentIntegrityAttestation: WORKFLOW_PARENT_KIND,
    issueDocumentDiffAttestation: WORKFLOW_PARENT_KIND,
    fieldAnchorRoot: HEAVY_KIND,
    fieldPredicateProof: HEAVY_KIND,
    fieldPredicateBatchProof: HEAVY_KIND,
    fieldEqualityProof: HEAVY_KIND,
    fieldMembershipProof: HEAVY_KIND,
    documentIntegrityProof: HEAVY_KIND,
    documentDiffProof: HEAVY_KIND,

    // cross-server sponsoring; the unbound sponsor proves its dust spend per job
    buildSponsorableTx: HEAVY_KIND,
    sponsorFinalizedTransaction: { heavy: false, workflowParent: false, identifierKeyed: true },
    sponsorUnboundTransaction: { heavy: true, workflowParent: false, identifierKeyed: true }
};

/** The table entry for `kind`; throws for an undeclared kind. */
export function declaredJobKindTraits(kind: string): JobKindTraits {
    const traits = Object.prototype.hasOwnProperty.call(JOB_KIND_TRAITS, kind) ? JOB_KIND_TRAITS[kind] : undefined;
    if (!traits) throw new Error(`job kind '${kind}' is not declared in srv/submission/job-kinds.ts`);
    return traits;
}
