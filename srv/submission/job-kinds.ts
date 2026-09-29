/**
 * Every durable background-job kind, defined once: its traits, the persisted command
 * operation its executor accepts, the executor and the reconciliation finalizer. The
 * runner's lists and the processor registrations derive from this table, so they
 * cannot drift: a kind without traits, or without a processor, fails at boot.
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

/** Which executor runs a kind; `wallet` kinds are registered by the wallet-session module. */
export type JobExecutor = 'wallet' | 'contract' | 'mintShieldedTestToken' | 'sponsorFinalized' | 'sponsorUnbound' | 'reindexDisclosures';

/** Reconciliation finalizer run once a parked job's inclusion is proven. */
export type JobFinalizer = 'contractProjection' | 'sponsoredSubmission';

export interface JobKindDefinition {
    traits: JobKindTraits;
    executor: JobExecutor;
    /** The one persisted `command.op` the executor accepts; absent where the executor checks its own shape. */
    op?: string;
    finalizer?: JobFinalizer;
}

export const LIGHT_KIND: JobKindTraits = { heavy: false, workflowParent: false, identifierKeyed: false };
export const HEAVY_KIND: JobKindTraits = { heavy: true, workflowParent: false, identifierKeyed: false };
/** A proving workflow parent: its own executor proves nothing, but it holds a heavy slot while its children run. */
export const WORKFLOW_PARENT_KIND: JobKindTraits = { heavy: true, workflowParent: true, identifierKeyed: false };

const contract = (op: string, traits: JobKindTraits = HEAVY_KIND, finalizer?: JobFinalizer): JobKindDefinition =>
    ({ traits, executor: 'contract', op, ...(finalizer ? { finalizer } : {}) });

export const JOB_KINDS: Readonly<Record<string, JobKindDefinition>> = {
    // wallet lifecycle (srv/sessions/wallet-session-lifecycle.ts)
    connectWalletForSigning: { traits: { ...LIGHT_KIND, serial: true, sessionBound: true }, executor: 'wallet', op: 'prewarm' },
    registerForDustGeneration: { traits: HEAVY_KIND, executor: 'wallet', op: 'registerDust' },
    deregisterFromDustGeneration: { traits: HEAVY_KIND, executor: 'wallet', op: 'deregisterDust' },
    sendNight: { traits: HEAVY_KIND, executor: 'wallet', op: 'sendNight' },

    // contracts (srv/submission/actions/)
    deployContract: contract('deploy'),
    submitContractCall: contract('call'),
    submitContractCallBatch: contract('callBatch', HEAVY_KIND, 'contractProjection'),
    mintShieldedTestToken: { traits: HEAVY_KIND, executor: 'mintShieldedTestToken', op: 'call' },
    anchorDocument: contract('anchorDocument', HEAVY_KIND, 'contractProjection'),
    grantDisclosure: contract('grantDisclosure', HEAVY_KIND, 'contractProjection'),
    revokeDisclosure: contract('revokeDisclosure', HEAVY_KIND, 'contractProjection'),
    registerPassport: contract('registerPassport', HEAVY_KIND, 'contractProjection'),
    retract: contract('retract', HEAVY_KIND, 'contractProjection'),
    // projection catch-up after a post-submit reindex failed; no chain effect
    reindexDisclosures: { traits: LIGHT_KIND, executor: 'reindexDisclosures', op: 'reindexDisclosures' },

    // proving workflows and their child steps
    issueFieldPredicateAttestation: contract('fieldPredicateWorkflow', WORKFLOW_PARENT_KIND),
    issueFieldPredicateAttestationBatch: contract('fieldPredicateBatchWorkflow', WORKFLOW_PARENT_KIND),
    issueFieldEqualityAttestation: contract('fieldEqualityWorkflow', WORKFLOW_PARENT_KIND),
    issueFieldMembershipAttestation: contract('fieldMembershipWorkflow', WORKFLOW_PARENT_KIND),
    issueDocumentIntegrityAttestation: contract('documentIntegrityWorkflow', WORKFLOW_PARENT_KIND),
    issueDocumentDiffAttestation: contract('documentDiffWorkflow', WORKFLOW_PARENT_KIND),
    fieldAnchorRoot: contract('call'),
    fieldPredicateProof: contract('call'),
    fieldPredicateBatchProof: contract('callBatch', HEAVY_KIND, 'contractProjection'),
    fieldEqualityProof: contract('call'),
    fieldMembershipProof: contract('call'),
    documentIntegrityProof: contract('call'),
    documentDiffProof: contract('call'),

    // cross-server sponsoring; the unbound sponsor proves its dust spend per job
    buildSponsorableTx: contract('buildSponsorable'),
    sponsorFinalizedTransaction: {
        traits: { heavy: false, workflowParent: false, identifierKeyed: true }, executor: 'sponsorFinalized', finalizer: 'sponsoredSubmission'
    },
    // Runs in parallel: the worker proves and submits unbound jobs outside the per-facade
    // submit lock, so N jobs overlap on N dust backings.
    sponsorUnboundTransaction: {
        traits: { heavy: true, workflowParent: false, identifierKeyed: true }, executor: 'sponsorUnbound', finalizer: 'sponsoredSubmission'
    },
    // Two swap halves instead of one caller transaction; the same channel from the merge on.
    sponsorSwap: {
        traits: { heavy: true, workflowParent: false, identifierKeyed: true }, executor: 'sponsorUnbound', finalizer: 'sponsoredSubmission'
    }
};

export const JOB_KIND_TRAITS: Readonly<Record<string, JobKindTraits>> =
    Object.fromEntries(Object.entries(JOB_KINDS).map(([kind, def]) => [kind, def.traits]));

/** Kinds run by `executor`, in table order. */
export function jobKindsOf(executor: JobExecutor): string[] {
    return Object.entries(JOB_KINDS).filter(([, def]) => def.executor === executor).map(([kind]) => kind);
}

/** The persisted operation `kind` accepts; undefined for an unknown kind or one that checks its own shape. */
export function jobKindOp(kind: string): string | undefined {
    return Object.prototype.hasOwnProperty.call(JOB_KINDS, kind) ? JOB_KINDS[kind].op : undefined;
}

/** The table entry for `kind`; throws for an undeclared kind. */
export function declaredJobKindTraits(kind: string): JobKindTraits {
    const traits = Object.prototype.hasOwnProperty.call(JOB_KIND_TRAITS, kind) ? JOB_KIND_TRAITS[kind] : undefined;
    if (!traits) throw new Error(`job kind '${kind}' is not declared in srv/submission/job-kinds.ts`);
    return traits;
}
