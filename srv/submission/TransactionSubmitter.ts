/**
 * Runs contract deploys and calls on the wallet worker thread.
 * The PendingSubmissions row is written before the worker starts, so a crash leaves a trace.
 * Only rejects that a fresh build can fix are retried here. Other retries are up to the caller.
 */

import cds from '@sap/cds';
import { classificationHaystack } from '../utils/format-error';
import { findNightgateError, errorMessage } from '../utils/errors';
import { DUST_RACE_LEDGER_CODES, dustRaceLedgerCode } from './dust-race';
import { classifySubmitFailure } from '../midnight/submit-error-classification';
import { carriedSubmitFailure, type BatchCallStageInfo } from '../midnight/wallet-worker-protocol';
import { reportExternalExecution, reportExternalSubmission, reportBroadcastOn, reportSubmissionRejectedOn, SponsorAttemptBookkeepingPendingError } from './job-execution-context';
import { withLockContentionRetry } from './db-write-retry';
import { isPreInclusionReject } from './sponsor-pool';
import type { SubmitIntentHook } from '../midnight/wallet-worker-client';
const { INSERT, UPDATE } = cds.ql;
import { PendingSubmissions, type PendingSubmission } from '#cds-models/midnight';
import { ensureNightgateModelLoaded } from '../utils/cds-model';
const log = cds.log('nightgate:submit');
import {
    type ContractProvidersConfig,
    type WalletMaterial
} from '../midnight/providers';
import { type NightgateNetwork } from '../utils/nightgate-config';
import { CapDbPrivateStateProvider } from '../midnight/CapDbPrivateStateProvider';
import type { MerkleProofBundle } from './contract-witnesses';
import {
    walletDeployContract,
    walletSubmitContractCall,
    walletBuildSponsorableTx,
    walletSubmitContractCallBatch,
    registerPrivateStateProvider,
    unregisterPrivateStateProvider,
    type WalletDeployContractArgs,
    type WalletSubmitContractCallArgs,
    type WalletSubmitContractCallBatchArgs
} from '../midnight/wallet-worker-client';
import { configNumber, configMs } from '../utils/config';
import type { DbRunner, TxCapableDb } from '../utils/db-types';
import type { SubmitIntentCoordinates } from './submit-intent';

// ---- Types ----------------------------------------------------------------

export type ActionType = 'DEPLOY' | 'CALL' | 'UPDATE';
export type SubmissionStatus = PendingSubmission['status'];

/** Registration data for the worker. The compiled contract cannot be copied to another thread. */
export interface ContractRegistrationMeta {
    artifactPath:   string;
    /** Digest of the contract build. The worker caches modules by it. */
    artifactDigest?: string;
    privateStateId: string;
    zkConfigPath:   string;
    slotWidth?:     number;
}

export interface DeployArgs<PS = unknown> {
    contractName: string;
    registration: ContractRegistrationMeta;
    initialPrivateState: PS;
    sessionId: string;
    /** Vault contracts only: recovery identity (64 hex) passed to the constructor. */
    recoveryId?: string;
}

export interface CallArgs {
    contractAddress: string;
    circuit: string;
    args: unknown[];
    contractName: string;
    registration: ContractRegistrationMeta;
    sessionId: string;
    /** Private input for the field proof circuits. Never passed as a circuit argument. */
    merkleProof?: MerkleProofBundle;
    /** Used when the wallet has no private state for this contract yet. Defaults to `{}`. */
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
    blockHeight?: number | null;
}

export interface CallBatchArgs {
    contractAddress: string;
    /** Calls in one transaction, in order. A per-call `merkleProof` replaces the batch-level one. */
    calls: Array<{ circuit: string; args: unknown[]; merkleProof?: MerkleProofBundle }>;
    contractName: string;
    registration: ContractRegistrationMeta;
    sessionId: string;
    merkleProof?: MerkleProofBundle;
    initialPrivateState?: unknown;
    /**
     * The calls after `orderedPrefix` do not depend on each other. The ledger runs cheap calls in an
     * earlier stage than expensive ones, so these may be reordered to match before proving.
     */
    independentCalls?: boolean;
    orderedPrefix?: number;
}

export interface CallBatchResult extends CallResult {
    circuits: string[];
}

export interface SubmissionErrorClassification {
    code: string;
    retryable: boolean;
    knownIssueRef?: string;
    message: string;
    /** The dust spend was built on an outdated dust state. Nothing was sent and no fee spent, so a rebuild can succeed. */
    transient?: 'dust-race';
    /** For `BatchCausalityViolation`: the position and stage of every call. */
    calls?: BatchCallStageInfo[];
}

export { DUST_RACE_LEDGER_CODES, dustRaceLedgerCode };

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
    contractProvidersConfig: ContractProvidersConfig;
    walletMaterial: WalletMaterial;
    db?: TxCapableDb;
    /** Test seams for the worker RPCs. */
    walletDeployContractImpl?: typeof walletDeployContract;
    walletSubmitContractCallImpl?: typeof walletSubmitContractCall;
    walletSubmitContractCallBatchImpl?: typeof walletSubmitContractCallBatch;
    walletBuildSponsorableTxImpl?: typeof walletBuildSponsorableTx;
    network: NightgateNetwork;
    /** Worker wallet key of the dust fee sponsor. The handler has already checked access. */
    sponsorAccountId?: string;
}

interface BoundAttemptLedger {
    onSubmitIntent: SubmitIntentHook;
    rejectAnnouncedAttempt: (why: string) => Promise<void>;
    current: () => { rowId: string | null; txHash: string | null };
}

export class TransactionSubmitter {
    private db: TxCapableDb | undefined;

    constructor(private readonly deps: TransactionSubmitterDeps) {
        if (deps.db) this.db = deps.db;
    }

    /**
     * Rebuilds after rejects that happen before the transaction reaches the node's pool and that a fresh
     * build fixes: a dust race (1010/170, 1010/196) or an outdated contract state (1010/104).
     * Each kind has its own retry budget.
     */
    private async withRebuildRetry<T>(what: string, ledger: BoundAttemptLedger, attempt: () => Promise<T>): Promise<T> {
        const dustRetries = configNumber('NIGHTGATE_DUST_RACE_RETRIES');
        const dustBackoffMs = configMs('NIGHTGATE_DUST_RACE_BACKOFF_MS');
        const staleRetries = configNumber('NIGHTGATE_STALE_TRANSCRIPT_RETRIES');
        const staleBackoffMs = configMs('NIGHTGATE_STALE_TRANSCRIPT_BACKOFF_MS');
        let dustRebuilds = 0;
        let staleRebuilds = 0;
        for (;;) {
            try {
                return await attempt();
            } catch (err) {
                const info = classifySubmitFailure(err);
                const dustCode = info.code === 'dust-race' && info.ledgerCode?.startsWith('1010/') ? info.ledgerCode : null;
                const stale = info.code === 'pre-mempool-reject' && info.ledgerCode === STALE_TRANSCRIPT_CODE;
                const label = (ledger.current().rowId ?? '').slice(0, 8);
                let reason: string;
                let backoffMs: number;
                if (dustCode != null && dustRebuilds < dustRetries) {
                    dustRebuilds++;
                    reason = `transient dust race (${dustCode})`;
                    backoffMs = dustBackoffMs;
                    log.warn(`${what} ${label}: ${reason}, rebuild-retry ${dustRebuilds}/${dustRetries} after ${backoffMs}ms`);
                } else if (stale && staleRebuilds < staleRetries) {
                    staleRebuilds++;
                    reason = `transcript refused against the current contract state (${STALE_TRANSCRIPT_CODE})`;
                    backoffMs = staleBackoffMs;
                    log.warn(`${what} ${label}: ${reason}, rebuild-retry ${staleRebuilds}/${staleRetries} after ${backoffMs}ms`);
                } else {
                    throw err;
                }
                // Remove the rejected hash from the job before the rebuild records a new one.
                // If that write fails, this throws and no rebuild happens.
                await ledger.rejectAnnouncedAttempt(`${reason}; rebuilt`);
                await new Promise(resolve => setTimeout(resolve, backoffMs));
            }
        }
    }

    /**
     * Tracks the send attempts of one submission. Each send and each reject updates row and job
     * in one transaction. So the job's txHash is the only hash that can be on chain,
     * and no txHash means nothing was sent.
     */
    private boundAttemptLedger(firstRowId: string, shape: { actionType: ActionType; contractAddress: string | null; circuitName: string | null; sessionId: string }): BoundAttemptLedger {
        let rowId: string | null = firstRowId;
        let txHash: string | null = null;
        const onSubmitIntent: SubmitIntentHook = async (hash, intent) => {
            const db = await this.getDb();
            const coordinates = {
                channel: 'bound', circuits: intent?.circuits ?? [],
                contractAddress: intent?.contractAddress ?? shape.contractAddress,
                ...(intent?.note ? { note: intent.note } : {}),
                ...(intent?.ttl ? { ttl: intent.ttl } : {}),
                ...(intent?.segments?.length ? { segments: intent.segments } : {})
            } satisfies SubmitIntentCoordinates;
            const targetRow = rowId ?? cds.utils.uuid();
            const reuse = rowId !== null;
            await withLockContentionRetry(`boundAttempt(${targetRow.slice(0, 8)})`, () => this.runInOneTransaction(db, async (tx) => {
                if (reuse) {
                    await tx.run(UPDATE.entity(PendingSubmissions).set({ txHash: hash, submitIntentData: JSON.stringify(coordinates) }).where({ ID: targetRow }));
                } else {
                    await tx.run(INSERT.into(PendingSubmissions).entries({
                        ID: targetRow, txHash: hash, contractAddress: shape.contractAddress, circuitName: shape.circuitName,
                        actionType: shape.actionType, submittedAt: new Date().toISOString(), status: 'pending', sessionId: shape.sessionId,
                        submitIntentData: JSON.stringify(coordinates)
                    }));
                }
                await reportBroadcastOn(tx, { submissionId: targetRow, txHash: hash, firstBoundary: false });
            }), msg => log.warn(msg));
            rowId = targetRow; txHash = hash;
        };
        const rejectAnnouncedAttempt = async (why: string): Promise<void> => {
            if (!txHash || !rowId) return; // nothing was sent, the next attempt reuses the row
            const db = await this.getDb();
            const closing = rowId;
            const hash = txHash;
            try {
                await withLockContentionRetry(`rejectAttempt(${closing.slice(0, 8)})`, () => this.runInOneTransaction(db, async (tx) => {
                    await tx.run(UPDATE.entity(PendingSubmissions).set({ status: 'failed', errorCode: 'REJECTED', errorMessage: why.slice(0, 500) }).where({ ID: closing }));
                    await reportSubmissionRejectedOn(tx, { submissionId: closing, txHash: hash });
                }), msg => log.warn(msg));
            } catch (e) {
                // The job is parked. The reconciler repeats this cleanup later.
                throw new SponsorAttemptBookkeepingPendingError(
                    `broadcast attempt ${closing} was rejected before inclusion but its bookkeeping (row, hash) could not be committed: ${errorMessage(e)}. Settled by the reconciler. Original failure: ${why.slice(0, 200)}`,
                    { submissionId: closing, txHash: hash, refund: 0 });
            }
            rowId = null; txHash = null;
        };
        return { onSubmitIntent, rejectAnnouncedAttempt, current: () => ({ rowId, txHash }) };
    }

    /** Runs `fn` in one transaction. A test double without `tx` runs it directly. */
    private runInOneTransaction<T>(db: TxCapableDb, fn: (tx: DbRunner) => Promise<T>): Promise<T> {
        if (typeof db?.tx === 'function') return db.tx(fn);
        return fn(db);
    }

    /** Returns the row id the SubmissionError should name. */
    private async settleFailedAttempt(ledger: BoundAttemptLedger, fallbackRowId: string, err: unknown, classification: SubmissionErrorClassification): Promise<string> {
        const { rowId, txHash } = ledger.current();
        const named = rowId ?? fallbackRowId;
        if (txHash && rowId && isPreInclusionReject(err)) {
            await ledger.rejectAnnouncedAttempt(classification.message);
        } else if (txHash && rowId) {
            // The transaction may still land. Keep the row `pending` so the reconciler
            // can finish it later. A `failed` row is never finished.
            await this.noteAmbiguousFailure(named, classification);
        } else {
            await this.markFailed(named, classification);
        }
        return named;
    }

    private async noteAmbiguousFailure(submissionId: string, classification: SubmissionErrorClassification): Promise<void> {
        try {
            const db = await this.getDb();
            await db.run(UPDATE.entity(PendingSubmissions).set({
                errorCode: classification.code,
                errorMessage: `outcome unknown after broadcast: ${classification.message}`.slice(0, 500)
            }).where({ ID: submissionId, status: 'pending' }));
        } catch (err) {
            log.warn(`noteAmbiguousFailure persist failed for ${submissionId}: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    async deploy<PS = unknown>(args: DeployArgs<PS>): Promise<DeployResult> {
        const submissionId = await this.insertPending('DEPLOY', null, null, args.sessionId);

        const deployFn = this.deps.walletDeployContractImpl ?? walletDeployContract;
        const ledger = this.boundAttemptLedger(submissionId, { actionType: 'DEPLOY', contractAddress: null, circuitName: null, sessionId: args.sessionId });
        let release: (() => void) | null = null;
        let workerResult: { txHash: string; contractAddress: string; onChainStatus: string };
        try {
            const proxy = await this.registerPrivateStateProxy();
            release = proxy.release;
            await reportExternalExecution({ submissionId });
            workerResult = await this.withRebuildRetry('deploy', ledger, () => deployFn(this.makeDeployRpcArgs(args, proxy.proxyId), ledger.onSubmitIntent));
        } catch (err) {
            release?.();
            if (err instanceof SponsorAttemptBookkeepingPendingError) throw err;
            const classification = classifySubmissionError(err, this.deps.network);
            const named = await this.settleFailedAttempt(ledger, submissionId, err, classification);
            throw new SubmissionError(named, classification, err);
        }
        release?.();
        const rowId = ledger.current().rowId ?? submissionId;

        const { txHash, contractAddress, onChainStatus } = workerResult;
        if (!txHash || !contractAddress) {
            const classification: SubmissionErrorClassification = {
                code: 'MalformedResult',
                retryable: false,
                message: 'Worker deployContract returned without txHash/contractAddress'
            };
            await this.markFailed(rowId, classification);
            throw new SubmissionError(rowId, classification);
        }
        await reportExternalSubmission({ submissionId: rowId, txHash });

        const newStatus: SubmissionStatus = onChainStatus === 'SucceedEntirely' ? 'included' : 'failed';
        await this.updateAfterSdk(rowId, {
            txHash,
            contractAddress,
            status: newStatus,
            errorCode:    newStatus === 'failed' ? `OnChainStatus:${onChainStatus}` : undefined,
            errorMessage: newStatus === 'failed' ? `On-chain status was ${onChainStatus}, expected SucceedEntirely` : undefined
        });

        if (newStatus === 'failed') {
            throw new SubmissionError(rowId, {
                code: `OnChainStatus:${onChainStatus}`,
                retryable: false,
                message: `Deploy on-chain status ${onChainStatus}`
            });
        }

        return { submissionId: rowId, txHash, contractAddress, status: newStatus };
    }

    async call(args: CallArgs): Promise<CallResult> {
        const submissionId = await this.insertPending('CALL', args.contractAddress, args.circuit, args.sessionId);

        const callFn = this.deps.walletSubmitContractCallImpl ?? walletSubmitContractCall;
        const ledger = this.boundAttemptLedger(submissionId, { actionType: 'CALL', contractAddress: args.contractAddress, circuitName: args.circuit, sessionId: args.sessionId });
        let release: (() => void) | null = null;
        let workerResult: { txHash: string; onChainStatus: string; blockHeight?: number | null };
        try {
            const proxy = await this.registerPrivateStateProxy();
            release = proxy.release;
            await reportExternalExecution({ submissionId });
            workerResult = await this.withRebuildRetry(`call ${args.circuit}`, ledger, () => callFn(this.makeCallRpcArgs(args, proxy.proxyId), ledger.onSubmitIntent));
        } catch (err) {
            release?.();
            if (err instanceof SponsorAttemptBookkeepingPendingError) throw err;
            const classification = classifySubmissionError(err, this.deps.network);
            const named = await this.settleFailedAttempt(ledger, submissionId, err, classification);
            throw new SubmissionError(named, classification, err);
        }
        release?.();
        const rowId = ledger.current().rowId ?? submissionId;

        const { txHash, onChainStatus } = workerResult;
        if (!txHash) {
            const classification: SubmissionErrorClassification = {
                code: 'MalformedResult',
                retryable: false,
                message: 'Worker submitContractCall returned without txHash'
            };
            await this.markFailed(rowId, classification);
            throw new SubmissionError(rowId, classification);
        }
        await reportExternalSubmission({ submissionId: rowId, txHash });

        const newStatus: SubmissionStatus = onChainStatus === 'SucceedEntirely' ? 'included' : 'failed';
        await this.updateAfterSdk(rowId, {
            txHash,
            contractAddress: args.contractAddress,
            status: newStatus,
            errorCode:    newStatus === 'failed' ? `OnChainStatus:${onChainStatus}` : undefined,
            errorMessage: newStatus === 'failed' ? `On-chain status was ${onChainStatus}, expected SucceedEntirely` : undefined
        });

        if (newStatus === 'failed') {
            throw new SubmissionError(rowId, {
                code: `OnChainStatus:${onChainStatus}`,
                retryable: false,
                message: `Call on-chain status ${onChainStatus}`
            });
        }

        return { submissionId: rowId, txHash, contractAddress: args.contractAddress, status: newStatus, blockHeight: workerResult.blockHeight ?? null };
    }

    /**
     * Several calls on one contract in one transaction with one row. If only some calls
     * applied on chain, the row fails and the caller must check the contract state.
     */
    async callBatch(args: CallBatchArgs): Promise<CallBatchResult> {
        const circuits = args.calls.map(c => c.circuit);
        // The circuitName column holds 100 characters.
        const circuitLabel = circuits.join('+').slice(0, 100);
        const submissionId = await this.insertPending('CALL', args.contractAddress, circuitLabel, args.sessionId);

        const batchFn = this.deps.walletSubmitContractCallBatchImpl ?? walletSubmitContractCallBatch;
        const ledger = this.boundAttemptLedger(submissionId, { actionType: 'CALL', contractAddress: args.contractAddress, circuitName: circuitLabel, sessionId: args.sessionId });
        let release: (() => void) | null = null;
        let workerResult: { txHash: string; onChainStatus: string; circuits: string[]; blockHeight?: number | null };
        try {
            const proxy = await this.registerPrivateStateProxy();
            release = proxy.release;
            await reportExternalExecution({ submissionId });
            workerResult = await this.withRebuildRetry(`batch ${circuitLabel}`, ledger, () => batchFn(this.makeCallBatchRpcArgs(args, proxy.proxyId), ledger.onSubmitIntent));
        } catch (err) {
            release?.();
            if (err instanceof SponsorAttemptBookkeepingPendingError) throw err;
            const classification = classifySubmissionError(err, this.deps.network);
            const named = await this.settleFailedAttempt(ledger, submissionId, err, classification);
            throw new SubmissionError(named, classification, err);
        }
        release?.();
        const rowId = ledger.current().rowId ?? submissionId;

        const { txHash, onChainStatus } = workerResult;
        if (!txHash) {
            const classification: SubmissionErrorClassification = {
                code: 'MalformedResult',
                retryable: false,
                message: 'Worker submitContractCallBatch returned without txHash'
            };
            await this.markFailed(rowId, classification);
            throw new SubmissionError(rowId, classification);
        }
        await reportExternalSubmission({ submissionId: rowId, txHash });

        const newStatus: SubmissionStatus = onChainStatus === 'SucceedEntirely' ? 'included' : 'failed';
        await this.updateAfterSdk(rowId, {
            txHash,
            contractAddress: args.contractAddress,
            status: newStatus,
            errorCode:    newStatus === 'failed' ? `OnChainStatus:${onChainStatus}` : undefined,
            errorMessage: newStatus === 'failed' ? `On-chain status was ${onChainStatus}, expected SucceedEntirely` : undefined
        });

        if (newStatus === 'failed') {
            throw new SubmissionError(rowId, {
                code: `OnChainStatus:${onChainStatus}`,
                retryable: false,
                message: `Batched call on-chain status ${onChainStatus}`
            });
        }

        return { submissionId: rowId, txHash, contractAddress: args.contractAddress, status: newStatus, circuits, blockHeight: workerResult.blockHeight ?? null };
    }

    // -- Internals -----------------------------------------------------------

    /**
     * Registers a private state store on the main thread that the worker calls into.
     * Only 'cap-db' works, because the LevelDB store cannot be shared across threads.
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
            privateStoragePasswordFallbacks: this.deps.walletMaterial.privateStoragePasswordFallbacks,
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

    /** The worker looks up wallets by accountId, not by the OData session id. */
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
            sponsorSessionId: this.deps.sponsorAccountId,
            ...(args.recoveryId ? { recoveryId: args.recoveryId } : {})
        };
    }

    /** Builds and signs a transaction without paying the fee or sending it. Returns base64 and writes no row. */
    async buildSponsorable(args: CallArgs): Promise<{ finalizedTxB64: string; serializedBytes: number }> {
        const buildFn = this.deps.walletBuildSponsorableTxImpl ?? walletBuildSponsorableTx;
        const proxy = await this.registerPrivateStateProxy();
        try {
            return await buildFn(this.makeCallRpcArgs(args, proxy.proxyId));
        } finally {
            proxy.release();
        }
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
            merkleProof:     args.merkleProof,
            initialPrivateState: args.initialPrivateState,
            sponsorSessionId: this.deps.sponsorAccountId,
            independentCalls: args.independentCalls,
            orderedPrefix: args.orderedPrefix
        };
    }

    private async getDb(): Promise<TxCapableDb> {
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
        // Best effort. A failure here must not hide the error the caller is about to throw.
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

export function classifySubmissionError(err: unknown, network: NightgateNetwork): SubmissionErrorClassification {
    // Keep an existing classification as is. The wrapper text lacks the node's
    // "Custom error: N", so classifying again would turn `1010/188` into `1010`.
    const prior = (err as SubmissionError | undefined)?.classification;
    if (prior && typeof prior.code === 'string' && typeof prior.retryable === 'boolean'
        && typeof prior.message === 'string') {
        return prior;
    }

    const message = err instanceof Error ? err.message : String(err);
    const name = err instanceof Error ? err.name : 'Error';

    const carried = carriedSubmitFailure(err);
    if (carried) return classificationFromSubmitFailure(carried, message, network);

    // Match on text for errors that did not come through the worker.
    if (name === 'TxFailedError' || message.includes('TxFailedError')) {
        return { code: 'TxFailed', retryable: false, message };
    }

    // Our own batch order check, matched by message because midnight-js drops the error name.
    // It must run before the 1010 checks, because its text mentions 1010/188.
    if (/violates the ledger's causality constraint/.test(message)) {
        return { code: 'BatchCausalityViolation', retryable: false, message };
    }

    // Node rejects are wrapped by the SDK, so search the whole inspected error. 1010 means an invalid
    // transaction and its `Custom error: N` becomes `1010/N`. 1014 is a pool reject.
    // Stack traces are left out, so a position like `x.js:1010:27` cannot match.
    const haystack = `${message} ${classificationHaystack(err)}`;
    // Checked first, so the priority numbers in its text are not read as a 1010 code.
    if (/priority is too low/i.test(haystack)) {
        return { code: '1014', retryable: false, message: `Pool priority reject (Substrate 1014, priority too low): ${message}` };
    }
    if (/\b1010\s*:|invalid transaction/i.test(haystack)) {
        const dustRace = dustRaceLedgerCode(err);
        if (dustRace) {
            return {
                code: dustRace,
                retryable: true,
                transient: 'dust-race',
                message: `Transient dust race (Substrate 1010, ledger error ${dustRace.slice(5)}): the dust spend was built against a dust state the node has already moved past; nothing entered the pool and no fee was spent, rebuild and resubmit: ${message}`
            };
        }
        const custom = /custom error:?\s*(\d+)/i.exec(haystack);
        if (custom?.[1] === '104') return { code: STALE_TRANSCRIPT_CODE, retryable: false, message: staleTranscriptMessage(message) };
        if (custom?.[1] === '103') return { code: ZSWAP_INVALID_CODE, retryable: false, message: zswapInvalidMessage(message) };
        return {
            code: custom ? `1010/${custom[1]}` : '1010',
            retryable: false,
            message: `Invalid transaction (Substrate 1010${custom ? `, ledger error ${custom[1]}` : ''}): ${message}`
        };
    }
    if (/\b1014\s*:/.test(haystack)) {
        return { code: '1014', retryable: false, message: `Pool reject (Substrate 1014): ${message}` };
    }
    if (/\b1016\s*:|Immediately\s*Dropped/i.test(haystack)) {
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

    if (/ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|socket hang up|timeout|disconnected from|Normal Closure|Abnormal Closure|WebSocket is not connected/i.test(haystack)) {
        return { code: 'NetworkOrTimeout', retryable: true, message };
    }

    if (/ContractTypeError|IncompleteCallTxPrivateStateConfig|IncompleteFindContractPrivateStateConfig/.test(name)) {
        return { code: name, retryable: false, message };
    }

    if (name === 'WalletSigningNotAvailable' || /WalletSigningNotAvailable/.test(message)) {
        return {
            code: 'WalletSigningNotAvailable',
            retryable: false,
            message: `${message} (session needs encryptedSeedKey to sign/balance transactions)`
        };
    }

    // These error codes are documented job codes. Every other error keeps its name.
    const coded = findNightgateError(err);
    if (coded && JOB_CODES_FROM_ERRORS.has(coded.code)) return { code: coded.code, retryable: coded.retryable, message };

    // Unknown errors are not retried, to avoid hammering the node.
    return { code: name || 'UnknownError', retryable: false, message };
}

const JOB_CODES_FROM_ERRORS: ReadonlySet<string> = new Set(['AGENT_GRANT_REVOKED', 'SPONSOR_POLICY_UNAVAILABLE', 'SPONSOR_POLICY_EMPTY']);

const ZSWAP_INVALID_CODE = '1010/103';
const zswapInvalidMessage = (message: string): string =>
    `Shielded offer refused (Substrate 1010, ledger error 103: a coin the transaction spends is already spent, or its proof refers to a coin tree state the node no longer accepts); nothing entered the pool and no fee was spent; a swap offer ends here once another fill of it landed, or when a half is too old: build a new half against the current state: ${message}`;

const STALE_TRANSCRIPT_CODE = '1010/104';
const staleTranscriptMessage = (message: string): string =>
    `Transaction refused against the current contract state (Substrate 1010, ledger error 104: the call's transcript no longer fits, typically its gas budget after another transaction on the same contract grew a map); nothing entered the pool and no fee was spent; build the call again against the current state and submit the new bytes: ${message}`;

function classificationFromSubmitFailure(
    info: { code: string; ledgerCode?: string; retryable: boolean; calls?: BatchCallStageInfo[] },
    message: string,
    network: NightgateNetwork
): SubmissionErrorClassification {
    switch (info.code) {
        case 'dust-race':
            if (info.ledgerCode === 'pool-invalid') {
                return { code: 'PoolInvalid', retryable: true, transient: 'dust-race', message: `Pool status Invalid (a competing transaction consumed a note first, or the transaction is invalid); rebuild and resubmit: ${message}` };
            }
            return {
                code: info.ledgerCode ?? '1010',
                retryable: true,
                transient: 'dust-race',
                message: `Transient dust race (Substrate 1010, ledger error ${(info.ledgerCode ?? '').slice(5)}): the dust spend was built against a dust state the node has already moved past; nothing entered the pool and no fee was spent, rebuild and resubmit: ${message}`
            };
        case 'pre-mempool-reject': {
            const ledger = info.ledgerCode ?? '1010';
            if (ledger === 'intent-rejected') return { code: 'SubmitIntentRejected', retryable: false, message };
            if (ledger === 'intent-timeout') return { code: 'SubmitIntentTimeout', retryable: false, message: `The announced transaction was not recorded in time; nothing was broadcast, a new idempotencyKey may retry: ${message}` };
            if (ledger === '1014') return { code: '1014', retryable: false, message: `Pool priority reject (Substrate 1014, priority too low): ${message}` };
            if (ledger === '1016') {
                if (network === 'mainnet') {
                    return { code: '1016', retryable: false, knownIssueRef: KNOWN_ISSUE_1016_MAINNET, message: `Mainnet deterministic rejection (1016 Immediately Dropped). Known issue; see ${KNOWN_ISSUE_1016_MAINNET}` };
                }
                return { code: '1016', retryable: true, message: `Transaction pool full or immediately dropped: ${message}` };
            }
            if (ledger === STALE_TRANSCRIPT_CODE) return { code: ledger, retryable: false, message: staleTranscriptMessage(message) };
            if (ledger === ZSWAP_INVALID_CODE) return { code: ledger, retryable: false, message: zswapInvalidMessage(message) };
            const custom = ledger.startsWith('1010/') ? ledger.slice(5) : null;
            return { code: ledger, retryable: false, message: `Invalid transaction (Substrate 1010${custom ? `, ledger error ${custom}` : ''}): ${message}` };
        }
        case 'transport':
            return { code: 'NetworkOrTimeout', retryable: true, message };
        case 'ambiguous':
            // Never rebuilt, because the sent transaction may still land.
            return { code: 'SubmitAmbiguous', retryable: false, message };
        case 'landed-not-applied':
            return { code: 'TxFailed', retryable: false, message };
        case 'policy':
            return { code: 'SponsorPolicyRefused', retryable: false, message };
        case 'causality':
            return { code: 'BatchCausalityViolation', retryable: false, message, ...(info.calls?.length ? { calls: info.calls } : {}) };
        default:
            return { code: 'UnknownError', retryable: false, message };
    }
}

