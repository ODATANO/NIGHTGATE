/**
 * Traits of every durable background-job kind, declared ONCE next to the
 * kind. The job runner derives its concurrency class, the workflow-parent
 * reconciliation set and the identifier-keyed confirmer set from the
 * registrations, so a kind cannot be forgotten in one list and present in
 * another: `registerBackgroundJobProcessor` refuses a kind without traits,
 * and the runner refuses to start while a kind in this table has no
 * processor.
 */
export interface JobKindTraits {
    /**
     * Each job runs a full ZK proof (proof server, or the in-process wasm
     * prover, where proofs additionally serialize on the worker thread). Four
     * concurrent saturate one proof-server instance; wider only queues inside
     * it. Light kinds are sync-bound and wait on `waitForSyncedState`.
     */
    heavy: boolean;
    /**
     * The executor drives child commands (`runChildCommand`). The parent row
     * carries no txHash of its own; its reconciliation reads the children.
     */
    workflowParent: boolean;
    /**
     * The row's `txHash` is the LEDGER TRANSACTION IDENTIFIER the wallet
     * SDK's submit returns, which only the indexer answers; the crawler keys
     * on Substrate extrinsic hashes and never finds it. The job row and the
     * attempt row are finalized together from the indexer outcome.
     */
    identifierKeyed: boolean;
    /**
     * At most ONE concurrent job: the work it waits on serializes further out
     * (SDK catch-up on the single worker thread), so N in parallel each run
     * at 1/N speed and the first usable result arrives N times later.
     */
    serial?: boolean;
    /**
     * Its product dies with the process (a warm wallet facade): a pending or
     * running row is terminal after a restart instead of re-queued.
     */
    sessionBound?: boolean;
}

export const LIGHT_KIND: JobKindTraits = { heavy: false, workflowParent: false, identifierKeyed: false };
export const HEAVY_KIND: JobKindTraits = { heavy: true, workflowParent: false, identifierKeyed: false };
/** A proving workflow parent: its own executor proves nothing, but it holds a heavy slot while its children run. */
export const WORKFLOW_PARENT_KIND: JobKindTraits = { heavy: true, workflowParent: true, identifierKeyed: false };

/**
 * Every kind the server registers, with its traits. Handlers register the
 * processor with the entry of this table; a kind added here without a
 * registration, or registered without an entry, fails at boot.
 */
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
    commitDocumentAnchor: HEAVY_KIND,
    anchorDocumentGuarded: WORKFLOW_PARENT_KIND,
    anchorCommit: HEAVY_KIND,
    anchorReveal: HEAVY_KIND,
    grantDisclosure: HEAVY_KIND,
    revokeDisclosure: HEAVY_KIND,
    registerPassport: HEAVY_KIND,

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

    // cross-server sponsoring: caller-side build (a full circuit proof), the
    // two-phase probe, and the two sponsor phases (identifier-keyed; the
    // unbound one proves the sponsor's dust spend per job)
    buildSponsorableTx: HEAVY_KIND,
    sponsorFinalizedTransaction: { heavy: false, workflowParent: false, identifierKeyed: true },
    sponsorUnboundTransaction: { heavy: true, workflowParent: false, identifierKeyed: true }
};

/** The table entry for `kind`; throws so a registration site cannot register an undeclared kind. */
export function declaredJobKindTraits(kind: string): JobKindTraits {
    const traits = Object.prototype.hasOwnProperty.call(JOB_KIND_TRAITS, kind) ? JOB_KIND_TRAITS[kind] : undefined;
    if (!traits) throw new Error(`job kind '${kind}' is not declared in srv/submission/job-kinds.ts`);
    return traits;
}
