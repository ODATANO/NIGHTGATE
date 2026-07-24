/**
 * TransactionSubmitter, server-side orchestrator for the Midnight contract path
 * (deploy + call). The SDK invocation runs in a `worker_threads` worker (see
 * `srv/midnight/wallet-worker.ts`) so the SDK's Effect.ts microtask saturation
 * stays off the main thread.
 *
 *   1. Insert a `pending` PendingSubmissions row BEFORE invoking the worker
 *      (crash-recovery hook); txHash + contractAddress fill in on return.
 *   2. Build a CapDbPrivateStateProvider on the main thread (where the CAP DB
 *      lives) and register it under an ephemeral `proxyId`; the worker's proxy
 *      round-trips PS CRUD back via `private-state-rpc` messages.
 *   3. Invoke the worker, which owns the SDK, the cached artifact, and the wallet
 *      facade, and returns only primitives (no SDK object crosses the boundary).
 *   4. On success → UPDATE row; the crawler's BlockProcessor later flips it to
 *      'finalized'.
 *   5. On failure → mark 'failed' with a classified error (see
 *      classifySubmissionError).
 *
 * The submitter never retries; the OData callers decide retry policy from the
 * returned classification.
 */

import cds from '@sap/cds';
import { reportExternalExecution, reportExternalSubmission } from './job-execution-context';
const { INSERT, UPDATE } = cds.ql;
import { PendingSubmissions } from '#cds-models/midnight';
import { ensureNightgateModelLoaded } from '../utils/cds-model';
const log = cds.log('nightgate:submit');
import {
    type ContractProvidersConfig,
    type WalletMaterial
} from '../midnight/providers';
import { type NightgateNetwork } from '../utils/nightgate-config';
import { CapDbPrivateStateProvider } from '../midnight/CapDbPrivateStateProvider';
import {
    walletDeployContract,
    walletSubmitContractCall,
    walletSubmitContractCallBatch,
    registerPrivateStateProvider,
    unregisterPrivateStateProvider,
    type WalletDeployContractArgs,
    type WalletSubmitContractCallArgs,
    type WalletSubmitContractCallBatchArgs
} from '../midnight/wallet-worker-client';

// ---- Types ----------------------------------------------------------------

export type ActionType = 'DEPLOY' | 'CALL' | 'UPDATE';
export type SubmissionStatus = 'pending' | 'included' | 'finalized' | 'failed';

export interface PendingSubmissionRow {
    ID: string;
    txHash: string | null;
    contractAddress: string | null;
    circuitName: string | null;
    actionType: ActionType;
    submittedAt: string;
    status: SubmissionStatus;
    errorCode?: string;
    errorMessage?: string;
    sessionId?: string;
}

/**
 * Registration meta carried across the thread boundary. The compiled contract
 * object itself does not survive structured-clone, so the worker re-imports
 * the artifact at `artifactPath` and caches the compiled handle by name.
 */
export interface ContractRegistrationMeta {
    artifactPath:   string;
    privateStateId: string;
    zkConfigPath:   string;
}

export interface DeployArgs<PS = unknown> {
    contractName: string;
    registration: ContractRegistrationMeta;
    initialPrivateState: PS;
    /**
     * Required for worker-routed submissions: the wallet facade is keyed on
     * sessionId inside the worker. Audit-trail role from earlier revisions
     * is unchanged.
     */
    sessionId: string;
}

export interface CallArgs {
    contractAddress: string;
    circuit: string;
    args: unknown[];
    contractName: string;
    registration: ContractRegistrationMeta;
    sessionId: string;
    /**
     * Per-call ZK-predicate witnesses (`commitValue`/`provePredicate`): the
     * hidden value (decimal string) + commitment opening (64-hex salt). Passed
     * to the worker's witness factory; never sent as a circuit arg. Omit for
     * circuits that declare no per-call witnesses.
     */
    witnessValues?: { attestedValue: string; valueSalt: string };
    /**
     * Per-call Merkle inclusion proof for the field-bound predicate circuit
     * (`proveFieldPredicate`): the scaled field value + its DEPTH=4 inclusion
     * path. Passed to the worker's witness factory; never sent as a circuit arg.
     * Omit for every other circuit.
     */
    merkleProof?: { fieldValue: string; siblings: string[]; dirs: boolean[] };
    /**
     * Private state to seed when the CALLING wallet has none for this contract
     * yet (it did not deploy it). Defaults to `{}` in the worker. Enables the
     * multi-caller case: several wallets acting on one shared contract.
     */
    initialPrivateState?: unknown;
}

export interface DeployResult {
    submissionId: string;
    txHash: string;
    contractAddress: string;
    status: SubmissionStatus;
}

export interface CallResult {
    submissionId: string;
    txHash: string;
    contractAddress: string;
    status: SubmissionStatus;
}

export interface CallBatchArgs {
    contractAddress: string;
    /** Ordered circuit calls; all execute inside ONE transaction. */
    calls: Array<{ circuit: string; args: unknown[] }>;
    contractName: string;
    registration: ContractRegistrationMeta;
    sessionId: string;
    /** Batch-level witnesses, bound once to the shared compiled contract
     *  instance (same semantics as the single-call fields on CallArgs). */
    witnessValues?: { attestedValue: string; valueSalt: string };
    merkleProof?: { fieldValue: string; siblings: string[]; dirs: boolean[] };
    initialPrivateState?: unknown;
}

export interface CallBatchResult extends CallResult {
    /** Circuits included in the one submitted transaction, in call order. */
    circuits: string[];
}

export interface SubmissionErrorClassification {
    code: string;
    retryable: boolean;
    knownIssueRef?: string;
    message: string;
}

export class SubmissionError extends Error {
    constructor(
        public readonly submissionId: string,
        public readonly classification: SubmissionErrorClassification,
        cause?: unknown
    ) {
        super(classification.message);
        this.name = 'SubmissionError';
        if (cause instanceof Error && cause.stack) this.stack = `${this.stack}\nCaused by: ${cause.stack}`;
    }
}

// ---- Submitter ------------------------------------------------------------

export interface TransactionSubmitterDeps {
    /** Provider config: indexer URLs + proof server. Forwarded to the worker. */
    contractProvidersConfig: ContractProvidersConfig;
    /** Wallet material (accountId, password provider, privateStateBackend). */
    walletMaterial: WalletMaterial;
    /** Optional DB handle; defaults to cds.connect.to('db'). Useful for tests. */
    db?: any;
    /**
     * Inject the worker RPC for testing; defaults to the real
     * `walletDeployContract` from wallet-worker-client.
     */
    walletDeployContractImpl?: typeof walletDeployContract;
    /** Same idea for `walletSubmitContractCall`. */
    walletSubmitContractCallImpl?: typeof walletSubmitContractCall;
    /** Same idea for `walletSubmitContractCallBatch`. */
    walletSubmitContractCallBatchImpl?: typeof walletSubmitContractCallBatch;
    /** Network, used by classifySubmissionError to decide if 1016 is fail-fast. */
    network: NightgateNetwork;
    /**
     * Optional fee sponsor: the ACCOUNT ID (worker facade key) of a second
     * wallet session that pays the dust fee. The worker then splits balancing
     * into two phases (caller: shielded/unshielded; sponsor: dust only) and
     * the sponsor submits. Resolved and authorised by the OData handler
     * (see srv/submission/fee-sponsor.ts) before it reaches this class.
     */
    sponsorAccountId?: string;
}

export class TransactionSubmitter {
    private db: cds.DatabaseService | undefined;

    constructor(private readonly deps: TransactionSubmitterDeps) {
        if (deps.db) this.db = deps.db;
    }

    async deploy<PS = unknown>(args: DeployArgs<PS>): Promise<DeployResult> {
        const submissionId = await this.insertPending('DEPLOY', null, null, args.sessionId);

        const deployFn = this.deps.walletDeployContractImpl ?? walletDeployContract;
        let release: (() => void) | null = null;
        let workerResult: { txHash: string; contractAddress: string; onChainStatus: string };
        try {
            const proxy = await this.registerPrivateStateProxy();
            release = proxy.release;
            await reportExternalExecution({ submissionId });
            workerResult = await deployFn(this.makeDeployRpcArgs(args, proxy.proxyId));
        } catch (err) {
            release?.();
            const classification = classifySubmissionError(err, this.deps.network);
            await this.markFailed(submissionId, classification);
            throw new SubmissionError(submissionId, classification, err);
        }
        release?.();

        const { txHash, contractAddress, onChainStatus } = workerResult;
        if (!txHash || !contractAddress) {
            const classification: SubmissionErrorClassification = {
                code: 'MalformedResult',
                retryable: false,
                message: 'Worker deployContract returned without txHash/contractAddress'
            };
            await this.markFailed(submissionId, classification);
            throw new SubmissionError(submissionId, classification);
        }
        await reportExternalSubmission({ submissionId, txHash });

        const newStatus: SubmissionStatus = onChainStatus === 'SucceedEntirely' ? 'included' : 'failed';
        await this.updateAfterSdk(submissionId, {
            txHash,
            contractAddress,
            status: newStatus,
            errorCode:    newStatus === 'failed' ? `OnChainStatus:${onChainStatus}` : undefined,
            errorMessage: newStatus === 'failed' ? `On-chain status was ${onChainStatus}, expected SucceedEntirely` : undefined
        });

        if (newStatus === 'failed') {
            throw new SubmissionError(submissionId, {
                code: `OnChainStatus:${onChainStatus}`,
                retryable: false,
                message: `Deploy on-chain status ${onChainStatus}`
            });
        }

        return { submissionId, txHash, contractAddress, status: newStatus };
    }

    async call(args: CallArgs): Promise<CallResult> {
        const submissionId = await this.insertPending('CALL', args.contractAddress, args.circuit, args.sessionId);

        const callFn = this.deps.walletSubmitContractCallImpl ?? walletSubmitContractCall;
        let release: (() => void) | null = null;
        let workerResult: { txHash: string; onChainStatus: string };
        try {
            const proxy = await this.registerPrivateStateProxy();
            release = proxy.release;
            await reportExternalExecution({ submissionId });
            workerResult = await callFn(this.makeCallRpcArgs(args, proxy.proxyId));
        } catch (err) {
            release?.();
            const classification = classifySubmissionError(err, this.deps.network);
            await this.markFailed(submissionId, classification);
            throw new SubmissionError(submissionId, classification, err);
        }
        release?.();

        const { txHash, onChainStatus } = workerResult;
        if (!txHash) {
            const classification: SubmissionErrorClassification = {
                code: 'MalformedResult',
                retryable: false,
                message: 'Worker submitContractCall returned without txHash'
            };
            await this.markFailed(submissionId, classification);
            throw new SubmissionError(submissionId, classification);
        }
        await reportExternalSubmission({ submissionId, txHash });

        const newStatus: SubmissionStatus = onChainStatus === 'SucceedEntirely' ? 'included' : 'failed';
        await this.updateAfterSdk(submissionId, {
            txHash,
            contractAddress: args.contractAddress,
            status: newStatus,
            errorCode:    newStatus === 'failed' ? `OnChainStatus:${onChainStatus}` : undefined,
            errorMessage: newStatus === 'failed' ? `On-chain status was ${onChainStatus}, expected SucceedEntirely` : undefined
        });

        if (newStatus === 'failed') {
            throw new SubmissionError(submissionId, {
                code: `OnChainStatus:${onChainStatus}`,
                retryable: false,
                message: `Call on-chain status ${onChainStatus}`
            });
        }

        return { submissionId, txHash, contractAddress: args.contractAddress, status: newStatus };
    }

    /**
     * Submit SEVERAL circuit calls against one contract as a SINGLE
     * transaction (worker: withContractScopedTransaction). One
     * PendingSubmissions row tracks the whole batch; its circuitName is the
     * ordered `+`-joined circuit list. A pre-submission failure discards the
     * scope (nothing submitted); post-submission the ledger's fallible phase
     * can still finalize the tx as PARTIAL_SUCCESS (on chain, subset applied),
     * which fails the row with OnChainStatus:... and the caller must verify
     * effect state.
     */
    async callBatch(args: CallBatchArgs): Promise<CallBatchResult> {
        const circuits = args.calls.map(c => c.circuit);
        // circuitName is String(100); the join is informational, so truncate.
        const circuitLabel = circuits.join('+').slice(0, 100);
        const submissionId = await this.insertPending('CALL', args.contractAddress, circuitLabel, args.sessionId);

        const batchFn = this.deps.walletSubmitContractCallBatchImpl ?? walletSubmitContractCallBatch;
        let release: (() => void) | null = null;
        let workerResult: { txHash: string; onChainStatus: string; circuits: string[] };
        try {
            const proxy = await this.registerPrivateStateProxy();
            release = proxy.release;
            await reportExternalExecution({ submissionId });
            workerResult = await batchFn(this.makeCallBatchRpcArgs(args, proxy.proxyId));
        } catch (err) {
            release?.();
            const classification = classifySubmissionError(err, this.deps.network);
            await this.markFailed(submissionId, classification);
            throw new SubmissionError(submissionId, classification, err);
        }
        release?.();

        const { txHash, onChainStatus } = workerResult;
        if (!txHash) {
            const classification: SubmissionErrorClassification = {
                code: 'MalformedResult',
                retryable: false,
                message: 'Worker submitContractCallBatch returned without txHash'
            };
            await this.markFailed(submissionId, classification);
            throw new SubmissionError(submissionId, classification);
        }
        await reportExternalSubmission({ submissionId, txHash });

        const newStatus: SubmissionStatus = onChainStatus === 'SucceedEntirely' ? 'included' : 'failed';
        await this.updateAfterSdk(submissionId, {
            txHash,
            contractAddress: args.contractAddress,
            status: newStatus,
            errorCode:    newStatus === 'failed' ? `OnChainStatus:${onChainStatus}` : undefined,
            errorMessage: newStatus === 'failed' ? `On-chain status was ${onChainStatus}, expected SucceedEntirely` : undefined
        });

        if (newStatus === 'failed') {
            throw new SubmissionError(submissionId, {
                code: `OnChainStatus:${onChainStatus}`,
                retryable: false,
                message: `Batched call on-chain status ${onChainStatus}`
            });
        }

        return { submissionId, txHash, contractAddress: args.contractAddress, status: newStatus, circuits };
    }

    // -- Internals -----------------------------------------------------------

    /**
     * Build a CapDbPrivateStateProvider for this submission and register it under
     * a fresh `proxyId`; the worker's PS proxy round-trips CRUD back to it.
     * `release()` unregisters it (call once after the worker RPC settles).
     *
     * Throws for any backend other than 'cap-db': the legacy LevelDB provider
     * doesn't survive a thread boundary and its on-disk format is dev-only.
     */
    private async registerPrivateStateProxy(): Promise<{ proxyId: string; release: () => void }> {
        const backend = this.deps.walletMaterial.privateStateBackend ?? 'cap-db';
        if (backend !== 'cap-db') {
            throw new Error(
                `privateStateBackend='${backend}' is not supported on the worker-routed submission path; ` +
                `use 'cap-db' (default).`
            );
        }
        const db = await this.getDb();
        const provider = new CapDbPrivateStateProvider({
            accountId: this.deps.walletMaterial.accountId,
            privateStoragePasswordProvider: this.deps.walletMaterial.privateStoragePasswordProvider,
            db
        });
        const proxyId = cds.utils.uuid();
        registerPrivateStateProvider(proxyId, provider);
        let released = false;
        return {
            proxyId,
            release: () => {
                if (released) return;
                released = true;
                unregisterPrivateStateProvider(proxyId);
            }
        };
    }

    /**
     * The worker keys facades on `accountId` (deterministic per viewing key, set
     * by the connectWalletForSigning pre-warm), so deploy/call must look up by
     * accountId, not the OData session UUID. `args.sessionId` stays on the
     * PendingSubmissions row for audit.
     */
    private makeDeployRpcArgs<PS>(args: DeployArgs<PS>, proxyId: string): WalletDeployContractArgs {
        return {
            sessionId:    this.deps.walletMaterial.accountId,
            proxyId,
            contractName: args.contractName,
            registration: args.registration,
            indexerHttpUrl: this.deps.contractProvidersConfig.indexerHttpUrl,
            indexerWsUrl:   this.deps.contractProvidersConfig.indexerWsUrl,
            proofServerUrl: this.deps.contractProvidersConfig.proofServerUrl,
            networkId:      this.deps.network,
            initialPrivateState: args.initialPrivateState,
            sponsorSessionId: this.deps.sponsorAccountId
        };
    }

    private makeCallRpcArgs(args: CallArgs, proxyId: string): WalletSubmitContractCallArgs {
        return {
            sessionId:    this.deps.walletMaterial.accountId,
            proxyId,
            contractName: args.contractName,
            registration: args.registration,
            contractAddress: args.contractAddress,
            circuit:         args.circuit,
            args:            args.args,
            indexerHttpUrl:  this.deps.contractProvidersConfig.indexerHttpUrl,
            indexerWsUrl:    this.deps.contractProvidersConfig.indexerWsUrl,
            proofServerUrl:  this.deps.contractProvidersConfig.proofServerUrl,
            networkId:       this.deps.network,
            witnessValues:   args.witnessValues,
            merkleProof:     args.merkleProof,
            initialPrivateState: args.initialPrivateState,
            sponsorSessionId: this.deps.sponsorAccountId
        };
    }

    private makeCallBatchRpcArgs(args: CallBatchArgs, proxyId: string): WalletSubmitContractCallBatchArgs {
        return {
            sessionId:    this.deps.walletMaterial.accountId,
            proxyId,
            contractName: args.contractName,
            registration: args.registration,
            contractAddress: args.contractAddress,
            calls:           args.calls,
            indexerHttpUrl:  this.deps.contractProvidersConfig.indexerHttpUrl,
            indexerWsUrl:    this.deps.contractProvidersConfig.indexerWsUrl,
            proofServerUrl:  this.deps.contractProvidersConfig.proofServerUrl,
            networkId:       this.deps.network,
            witnessValues:   args.witnessValues,
            merkleProof:     args.merkleProof,
            initialPrivateState: args.initialPrivateState,
            sponsorSessionId: this.deps.sponsorAccountId
        };
    }

    private async getDb(): Promise<cds.DatabaseService> {
        if (this.db) return this.db;
        await ensureNightgateModelLoaded();
        this.db = await cds.connect.to('db');
        return this.db;
    }

    private async insertPending(
        actionType: ActionType,
        contractAddress: string | null,
        circuitName: string | null,
        sessionId: string
    ): Promise<string> {
        const db = await this.getDb();
        const submissionId = cds.utils.uuid();
        await db.run(INSERT.into(PendingSubmissions).entries({
            ID: submissionId,
            txHash: null,
            contractAddress,
            circuitName,
            actionType,
            submittedAt: new Date().toISOString(),
            status: 'pending',
            sessionId
        }));
        return submissionId;
    }

    private async updateAfterSdk(submissionId: string, patch: Record<string, unknown>): Promise<void> {
        const db = await this.getDb();
        await db.run(
            UPDATE.entity(PendingSubmissions).set(patch).where({ ID: submissionId })
        );
    }

    private async markFailed(submissionId: string, classification: SubmissionErrorClassification): Promise<void> {
        // Best-effort: runs in the error path before the caller throws the
        // classified SubmissionError, so a write failure here must NOT propagate
        // and mask the real classification. Swallow and log.
        try {
            const db = await this.getDb();
            await db.run(
                UPDATE.entity(PendingSubmissions).set({
                    status: 'failed',
                    errorCode: classification.code,
                    errorMessage: classification.message.slice(0, 500)
                }).where({ ID: submissionId })
            );
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log.warn(`markFailed persist failed for ${submissionId}: ${msg}`);
        }
    }
}

// ---- Error classification --------------------------------------------------

const KNOWN_ISSUE_1016_MAINNET =
    'https://forum.midnight.network/t/1190 (mainnet 1016 Immediately Dropped: deterministic rejection, early May 2026)';

/**
 * Classifies a thrown error into a stable code + retryability decision.
 * Used by the OData callers and internally to populate
 * PendingSubmissions.errorCode/errorMessage.
 */
export function classifySubmissionError(err: unknown, network: NightgateNetwork): SubmissionErrorClassification {
    const message = err instanceof Error ? err.message : String(err);
    const name = err instanceof Error ? err.name : 'Error';

    // SDK TxFailedError, on-chain status was not success
    if (name === 'TxFailedError' || message.includes('TxFailedError')) {
        return { code: 'TxFailed', retryable: false, message };
    }

    // Substrate pool errors
    if (/\b1014\b|invalid transaction/i.test(message)) {
        return { code: '1014', retryable: false, message: `Invalid transaction (Substrate 1014): ${message}` };
    }
    if (/\b1016\b|Immediately\s*Dropped/i.test(message)) {
        if (network === 'mainnet') {
            return {
                code: '1016',
                retryable: false,
                knownIssueRef: KNOWN_ISSUE_1016_MAINNET,
                message: `Mainnet deterministic rejection (1016 Immediately Dropped). Known issue; see ${KNOWN_ISSUE_1016_MAINNET}`
            };
        }
        return { code: '1016', retryable: true, message: `Transaction pool full or immediately dropped: ${message}` };
    }

    // Network / timeout patterns
    if (/ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|socket hang up|timeout/i.test(message)) {
        return { code: 'NetworkOrTimeout', retryable: true, message };
    }

    // SDK contract-type / config errors are not retryable
    if (/ContractTypeError|IncompleteCallTxPrivateStateConfig|IncompleteFindContractPrivateStateConfig/.test(name)) {
        return { code: name, retryable: false, message };
    }

    // Session lacks signing material; stable code so consumers can recognize it.
    if (name === 'WalletSigningNotAvailable' || /WalletSigningNotAvailable/.test(message)) {
        return {
            code: 'WalletSigningNotAvailable',
            retryable: false,
            message: `${message} (session needs encryptedSeedKey to sign/balance transactions)`
        };
    }

    // Default: unknown but assume non-retryable to avoid hammering
    return { code: name || 'UnknownError', retryable: false, message };
}

// ---- Reconciliation helper (called by crawler's BlockProcessor) ------------

/**
 * Called by BlockProcessor when a transaction is persisted. Marks a matching
 * PendingSubmissions row 'finalized' with a JSON snapshot of the indexed tx.
 * No-op if none matches (most txs are not ours).
 */
export async function reconcilePendingSubmission(
    db: any,
    txHash: string,
    indexedTxSnapshot: Record<string, unknown>
): Promise<void> {
    if (!txHash) return;
    await db.run(
        UPDATE.entity(PendingSubmissions).set({
            status: 'finalized',
            finalizedAt: new Date().toISOString(),
            finalizedTxData: JSON.stringify(indexedTxSnapshot)
        }).where({ txHash, status: { in: ['pending', 'included'] } })
    );
}

