/**
 * The one table of all background job kinds and how each one runs.
 * The job runner and the processor registrations are built from it.
 * A kind missing here, or without a processor, fails at startup.
 */
export interface JobKindTraits {
    /** Runs a full ZK proof. All heavy kinds share one limit on how many run at once. */
    heavy: boolean;
    /** Runs other jobs as its steps. It has no txHash of its own, its state follows from the steps. */
    workflowParent: boolean;
    /** `txHash` holds the ledger transaction identifier, which only the indexer can look up, not the crawler. */
    identifierKeyed: boolean;
    /** One job at a time. The work queues on the worker thread anyway, so parallel runs only delay the first result. */
    serial?: boolean;
    /** Its result is an in-memory wallet that is lost on restart. Open jobs end at restart and are never re-run. */
    sessionBound?: boolean;
}

/** Which executor runs a kind. `wallet` kinds are registered by the wallet session module. */
export type JobExecutor = 'wallet' | 'contract' | 'mintShieldedTestToken' | 'mintFactoryToken' | 'sponsorFinalized' | 'sponsorUnbound' | 'reindexDisclosures';

/** Bookkeeping that runs once a job whose outcome was unclear is confirmed on-chain. */
export type JobFinalizer = 'contractProjection' | 'sponsoredSubmission' | 'factoryMint';

export interface JobKindDefinition {
    traits: JobKindTraits;
    executor: JobExecutor;
    /** The stored `command.op` this kind accepts. Absent when the executor checks the command itself. */
    op?: string;
    finalizer?: JobFinalizer;
}

export const LIGHT_KIND: JobKindTraits = { heavy: false, workflowParent: false, identifierKeyed: false };
export const HEAVY_KIND: JobKindTraits = { heavy: true, workflowParent: false, identifierKeyed: false };
/** A workflow that proves through its steps. It holds a heavy slot while the steps run. */
export const WORKFLOW_PARENT_KIND: JobKindTraits = { heavy: true, workflowParent: true, identifierKeyed: false };

const contract = (op: string, traits: JobKindTraits = HEAVY_KIND, finalizer?: JobFinalizer): JobKindDefinition =>
    ({ traits, executor: 'contract', op, ...(finalizer ? { finalizer } : {}) });

export const JOB_KINDS: Readonly<Record<string, JobKindDefinition>> = {
    // Wallet jobs, see srv/sessions/wallet-session-lifecycle.ts.
    connectWalletForSigning: { traits: { ...LIGHT_KIND, serial: true, sessionBound: true }, executor: 'wallet', op: 'prewarm' },
    registerForDustGeneration: { traits: HEAVY_KIND, executor: 'wallet', op: 'registerDust' },
    deregisterFromDustGeneration: { traits: HEAVY_KIND, executor: 'wallet', op: 'deregisterDust' },
    sendNight: { traits: HEAVY_KIND, executor: 'wallet', op: 'sendNight' },

    // Contract jobs, see srv/submission/actions/.
    deployContract: contract('deploy'),
    submitContractCall: contract('call'),
    submitContractCallBatch: contract('callBatch', HEAVY_KIND, 'contractProjection'),
    mintShieldedTestToken: { traits: HEAVY_KIND, executor: 'mintShieldedTestToken', op: 'call' },
    mintFactoryToken: { traits: HEAVY_KIND, executor: 'mintFactoryToken', op: 'call', finalizer: 'factoryMint' },
    anchorDocument: contract('anchorDocument', HEAVY_KIND, 'contractProjection'),
    grantDisclosure: contract('grantDisclosure', HEAVY_KIND, 'contractProjection'),
    revokeDisclosure: contract('revokeDisclosure', HEAVY_KIND, 'contractProjection'),
    registerPassport: contract('registerPassport', HEAVY_KIND, 'contractProjection'),
    retract: contract('retract', HEAVY_KIND, 'contractProjection'),
    // Retries a failed table update after a submit. Sends nothing to the chain.
    reindexDisclosures: { traits: LIGHT_KIND, executor: 'reindexDisclosures', op: 'reindexDisclosures' },

    // Proof workflows and their steps.
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

    // Paying fees for transactions built elsewhere. An unbound sponsor job proves its own dust spend.
    buildSponsorableTx: contract('buildSponsorable'),
    sponsorFinalizedTransaction: {
        traits: { heavy: false, workflowParent: false, identifierKeyed: true }, executor: 'sponsorFinalized', finalizer: 'sponsoredSubmission'
    },
    // Runs in parallel. The worker proves and submits these outside the per-wallet lock,
    // so several jobs can run at once, each on its own dust source.
    sponsorUnboundTransaction: {
        traits: { heavy: true, workflowParent: false, identifierKeyed: true }, executor: 'sponsorUnbound', finalizer: 'sponsoredSubmission'
    },
    // Takes two swap halves instead of one transaction. After merging them it runs like the job above.
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

/** The stored operation `kind` accepts. Undefined for an unknown kind or one that checks the command itself. */
export function jobKindOp(kind: string): string | undefined {
    return Object.prototype.hasOwnProperty.call(JOB_KINDS, kind) ? JOB_KINDS[kind].op : undefined;
}

/** The table entry for `kind`; throws for an undeclared kind. */
export function declaredJobKindTraits(kind: string): JobKindTraits {
    const traits = Object.prototype.hasOwnProperty.call(JOB_KIND_TRAITS, kind) ? JOB_KIND_TRAITS[kind] : undefined;
    if (!traits) throw new Error(`job kind '${kind}' is not declared in srv/submission/job-kinds.ts`);
    return traits;
}
