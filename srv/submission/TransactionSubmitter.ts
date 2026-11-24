// Runs contract deploys and calls on the wallet worker thread. The PendingSubmissions row is written before the worker starts, so a crash leaves a trace.
// Only rejects that a fresh build can fix are retried here. Other retries are up to the caller.

import cds from '@sap/cds';
import { classificationHaystack, ledgerErrorCode } from '../utils/format-error';
import { findNightgateError, errorMessage, isJobErrorCode, isNodeRejectCode, type ErrorCode, type JobErrorCode, type NodeRejectCode } from '../utils/errors';
import { DUST_RACE_LEDGER_CODES, dustRaceLedgerCode } from './dust-race';
import { classifySubmitFailure } from '../midnight/submit-error-classification';
import { carriedSubmitFailure, type BatchCallStageInfo } from '../midnight/wallet-worker-protocol';
import { reportExternalExecution, reportExternalSubmission, reportBroadcastOn, reportSubmissionRejectedOn, SponsorAttemptBookkeepingPendingError } from './job-execution-context';
import { withLockContentionRetry } from './db-write-retry';
import { isPreInclusionReject } from './sponsor-pool';
import type { SubmitIntentHook } from '../midnight/wallet-worker-client';
import { setTimeout as sleep } from 'node:timers/promises';
const { INSERT, UPDATE } = cds.ql;
import { PendingSubmissions, type PendingSubmission } from '#cds-models/midnight';
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
    txId: string;
    txHash: string;
    contractAddress: string;
    status: SubmissionStatus;
}

export interface CallResult {
    submissionId: string;
    txId: string;
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
     * The calls after `orderedPrefix` do not depend on each other. The ledger runs cheap calls before expensive ones, so these may be reordered to match before proving.
     */
    independentCalls?: boolean;
    orderedPrefix?: number;
}

export interface CallBatchResult extends CallResult {
    circuits: string[];
}

export interface SubmissionErrorClassification {
    code: ErrorCode | JobErrorCode | NodeRejectCode;
    retryable: boolean;
    knownIssueRef?: string;
    message: string;
    /** The dust spend was built on an outdated dust state. Nothing was sent and no fee spent, so a rebuild can succeed. */
    transient?: 'dust-race';
    /** For `BATCH_CAUSALITY_VIOLATION`: the position and stage of every call. */
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
    current: () => { rowId: string | null; txId: string | null };
}

export class TransactionSubmitter {
    private db: TxCapableDb | undefined;

    constructor(private readonly deps: TransactionSubmitterDeps) {
        if (deps.db) this.db = deps.db;
    }

    /**
     * Rebuilds after rejects before the node's pool that a fresh build fixes, a dust race (1010/170, 1010/196) or an outdated contract state (1010/104). Each kind has its own retry budget.
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
                // Remove the rejected transaction from the job before the rebuild records a new one.
                // If that write fails, this throws and no rebuild happens.
                await ledger.rejectAnnouncedAttempt(`${reason}; rebuilt`);
                await sleep(backoffMs);
            }
        }
    }

    // Tracks the send attempts of one submission. Each send and each reject updates row and job in one transaction.
    // So the job's txId names the only transaction that can be on chain, and no txId means nothing was sent.
    private boundAttemptLedger(firstRowId: string, shape: { actionType: ActionType; contractAddress: string | null; circuit: string | null; sessionId: string }): BoundAttemptLedger {
        let rowId: string | null = firstRowId;
        let txId: string | null = null;
        const onSubmitIntent: SubmitIntentHook = async (intent) => {
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
                    await tx.run(UPDATE.entity(PendingSubmissions).set({ txId: intent.txId, txHash: intent.txHash, submitIntentData: JSON.stringify(coordinates) }).where({ ID: targetRow }));
                } else {
                    await tx.run(INSERT.into(PendingSubmissions).entries({
                        ID: targetRow, txId: intent.txId, txHash: intent.txHash, contractAddress: shape.contractAddress, circuit: shape.circuit,
                        actionType: shape.actionType, submittedAt: new Date().toISOString(), status: 'pending', sessionId: shape.sessionId,
                        submitIntentData: JSON.stringify(coordinates)
                    }));
                }
                await reportBroadcastOn(tx, { submissionId: targetRow, txId: intent.txId, txHash: intent.txHash, firstBoundary: false });
            }), msg => log.warn(msg));
            rowId = targetRow; txId = intent.txId;
        };
        const rejectAnnouncedAttempt = async (why: string): Promise<void> => {
            if (!txId || !rowId) return; // nothing was sent, the next attempt reuses the row
            const db = await this.getDb();
            const closing = rowId;
            const announced = txId;
            try {
                await withLockContentionRetry(`rejectAttempt(${closing.slice(0, 8)})`, () => this.runInOneTransaction(db, async (tx) => {
                    await tx.run(UPDATE.entity(PendingSubmissions).set({ status: 'failed', errorCode: 'REJECTED', errorMessage: why.slice(0, 500) }).where({ ID: closing }));
                    await reportSubmissionRejectedOn(tx, { submissionId: closing, txId: announced });
                }), msg => log.warn(msg));
            } catch (e) {
                // The job is parked. The reconciler repeats this cleanup later.
                throw new SponsorAttemptBookkeepingPendingError(
                    `broadcast attempt ${closing} was rejected before inclusion but its bookkeeping (row, hash) could not be committed: ${errorMessage(e)}. Settled by the reconciler. Original failure: ${why.slice(0, 200)}`,
                    { submissionId: closing, txId: announced, refund: 0 });
            }
            rowId = null; txId = null;
        };
        return { onSubmitIntent, rejectAnnouncedAttempt, current: () => ({ rowId, txId }) };
    }

    /** Runs `fn` in one transaction. A test double without `tx` runs it directly. */
    private runInOneTransaction<T>(db: TxCapableDb, fn: (tx: DbRunner) => Promise<T>): Promise<T> {
        if (typeof db?.tx === 'function') return db.tx(fn);
        return fn(db);
    }

    /** Returns the row id the SubmissionError should name. */
    private async settleFailedAttempt(ledger: BoundAttemptLedger, fallbackRowId: string, err: unknown, classification: SubmissionErrorClassification): Promise<string> {
        const { rowId, txId } = ledger.current();
        const named = rowId ?? fallbackRowId;
        if (txId && rowId && isPreInclusionReject(err)) {
            await ledger.rejectAnnouncedAttempt(classification.message);
        } else if (txId && rowId) {
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
            log.warn(`noteAmbiguousFailure persist failed for ${submissionId}: ${errorMessage(err)}`);
        }
    }

    async deploy<PS = unknown>(args: DeployArgs<PS>): Promise<DeployResult> {
        const deployFn = this.deps.walletDeployContractImpl ?? walletDeployContract;
        const { rowId, result, status } = await this.runSubmit({
            shape: { actionType: 'DEPLOY', contractAddress: null, circuit: null, sessionId: args.sessionId },
            label: 'deploy', worker: 'deployContract', what: 'Deploy',
            send: (proxyId, onSubmitIntent) => deployFn(this.makeDeployRpcArgs(args, proxyId), onSubmitIntent),
            contractAddressOf: r => r.contractAddress
        });
        return { submissionId: rowId, txId: result.txId, txHash: result.txHash, contractAddress: result.contractAddress, status };
    }

    async call(args: CallArgs): Promise<CallResult> {
        const callFn = this.deps.walletSubmitContractCallImpl ?? walletSubmitContractCall;
        const { rowId, result, status } = await this.runSubmit({
            shape: { actionType: 'CALL', contractAddress: args.contractAddress, circuit: args.circuit, sessionId: args.sessionId },
            label: `call ${args.circuit}`, worker: 'submitContractCall', what: 'Call',
            send: (proxyId, onSubmitIntent) => callFn(this.makeCallRpcArgs(args, proxyId), onSubmitIntent),
            contractAddressOf: () => args.contractAddress
        });
        return { submissionId: rowId, txId: result.txId, txHash: result.txHash, contractAddress: args.contractAddress, status, blockHeight: result.blockHeight ?? null };
    }

    /**
     * Several calls on one contract in one transaction with one row. If only some calls applied on chain, the row fails and the caller must check the contract state.
     */
    async callBatch(args: CallBatchArgs): Promise<CallBatchResult> {
        const circuits = args.calls.map(c => c.circuit);
        // The circuit column holds 100 characters.
        const circuitLabel = circuits.join('+').slice(0, 100);
        const batchFn = this.deps.walletSubmitContractCallBatchImpl ?? walletSubmitContractCallBatch;
        const { rowId, result, status } = await this.runSubmit({
            shape: { actionType: 'CALL', contractAddress: args.contractAddress, circuit: circuitLabel, sessionId: args.sessionId },
            label: `batch ${circuitLabel}`, worker: 'submitContractCallBatch', what: 'Batched call',
            send: (proxyId, onSubmitIntent) => batchFn(this.makeCallBatchRpcArgs(args, proxyId), onSubmitIntent),
            contractAddressOf: () => args.contractAddress
        });
        return { submissionId: rowId, txId: result.txId, txHash: result.txHash, contractAddress: args.contractAddress, status, circuits, blockHeight: result.blockHeight ?? null };
    }

    /**
     * One worker submit with its attempt row. Sends with rebuild retries, books a failure, checks the result and records the on-chain status. Throws a SubmissionError for every outcome but success.
     */
    private async runSubmit<R extends { txId: string; txHash: string; onChainStatus: string; blockHeight?: number | null }>(o: {
        shape: { actionType: ActionType; contractAddress: string | null; circuit: string | null; sessionId: string };
        /** Names the attempt in retry logs. */
        label: string;
        /** The worker method, for the malformed-result message. */
        worker: string;
        /** Starts the on-chain failure message. */
        what: string;
        send: (proxyId: string, onSubmitIntent: SubmitIntentHook) => Promise<R>;
        contractAddressOf: (result: R) => string | undefined;
    }): Promise<{ rowId: string; result: R; status: SubmissionStatus }> {
        const submissionId = await this.insertPending(o.shape.actionType, o.shape.contractAddress, o.shape.circuit, o.shape.sessionId);
        const ledger = this.boundAttemptLedger(submissionId, o.shape);
        let release: (() => void) | null = null;
        let result: R;
        try {
            const proxy = await this.registerPrivateStateProxy();
            release = proxy.release;
            await reportExternalExecution({ submissionId });
            result = await this.withRebuildRetry(o.label, ledger, () => o.send(proxy.proxyId, ledger.onSubmitIntent));
        } catch (err) {
            // A call that announced its tx cannot be cancelled. If this side gave up first, the worker may still land the tx
            // and then store the contract's private state and signing key through this proxy. So the proxy stays for a while.
            if (release && ledger.current().txId) setTimeout(release, configMs('NIGHTGATE_WORKER_RPC_TIMEOUT_MS')).unref?.();
            else release?.();
            if (err instanceof SponsorAttemptBookkeepingPendingError) throw err;
            const classification = classifySubmissionError(err, this.deps.network);
            const named = await this.settleFailedAttempt(ledger, submissionId, err, classification);
            throw new SubmissionError(named, classification, err);
        }
        release?.();
        const rowId = ledger.current().rowId ?? submissionId;

        const { txHash, onChainStatus } = result;
        const contractAddress = o.contractAddressOf(result);
        if (!txHash || !contractAddress) {
            const classification: SubmissionErrorClassification = {
                code: 'MALFORMED_RESULT',
                retryable: false,
                message: `Worker ${o.worker} returned without txHash${o.shape.actionType === 'DEPLOY' ? '/contractAddress' : ''}`
            };
            await this.markFailed(rowId, classification);
            throw new SubmissionError(rowId, classification);
        }
        await reportExternalSubmission({ submissionId: rowId, txHash });

        const status: SubmissionStatus = onChainStatus === 'SucceedEntirely' ? 'included' : 'failed';
        await this.updateAfterSdk(rowId, {
            txHash,
            contractAddress,
            status,
            errorCode:    status === 'failed' ? 'TX_FAILED' : undefined,
            errorMessage: status === 'failed' ? `On-chain status was ${onChainStatus}, expected SucceedEntirely` : undefined
        });
        if (status === 'failed') {
            throw new SubmissionError(rowId, {
                code: 'TX_FAILED',
                retryable: false,
                message: `${o.what} on-chain status ${onChainStatus}`
            });
        }
        return { rowId, result, status };
    }

    // -- Internals -----------------------------------------------------------

    /** Registers a private state store on the main thread for the worker. */
    private async registerPrivateStateProxy(): Promise<{ proxyId: string; release: () => void }> {
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
        this.db = await cds.connect.to('db');
        return this.db;
    }

    private async insertPending(
        actionType: ActionType,
        contractAddress: string | null,
        circuit: string | null,
        sessionId: string
    ): Promise<string> {
        const db = await this.getDb();
        const submissionId = cds.utils.uuid();
        await db.run(INSERT.into(PendingSubmissions).entries({
            ID: submissionId,
            txHash: null,
            contractAddress,
            circuit,
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
            const msg = errorMessage(err);
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

    const message = errorMessage(err);
    const name = err instanceof Error ? err.name : 'Error';

    const carried = carriedSubmitFailure(err);
    // The worker marks every failure it cannot name as `internal`; a coded error among the causes names it.
    const named = carried?.code === 'internal' ? findNightgateError(err) : undefined;
    if (named) return { code: named.code, retryable: isJobErrorCode(named.code) && named.retryable, message };
    if (carried) return classificationFromSubmitFailure(carried, message, network);

    // Match on text for errors that did not come through the worker.
    if (name === 'TxFailedError' || message.includes('TxFailedError')) {
        return { code: 'TX_FAILED', retryable: false, message };
    }

    // Our own batch order check, matched by message because midnight-js drops the error name.
    // It must run before the 1010 checks, because its text mentions 1010/188.
    if (/violates the ledger's causality constraint/.test(message)) {
        return { code: 'BATCH_CAUSALITY_VIOLATION', retryable: false, message };
    }
    if (/runs out of gas on the ledger/.test(message)) {
        return { code: 'BATCH_GAS_BUDGET_EXCEEDED', retryable: false, message };
    }

    // Node rejects are wrapped by the SDK, so search the whole inspected error. 1010 means an invalid
    // transaction and its `Custom error: N` becomes `1010/N`. 1014 is a pool reject.
    // Stack traces are left out, so a position like `x.js:1010:27` cannot match.
    const haystack = `${message} ${classificationHaystack(err)}`;
    // Checked first, so the priority numbers in its text are not read as a 1010 code.
    if (/priority is too low/i.test(haystack)) return priorityReject(message);
    if (/\b1010\s*:|invalid transaction/i.test(haystack)) {
        const raced = dustRaceLedgerCode(err);
        if (raced) return dustRace(nodeCode(raced), message);
        const custom = ledgerErrorCode(haystack);
        if (custom === '104') return { code: STALE_TRANSCRIPT_CODE, retryable: false, message: staleTranscriptMessage(message) };
        if (custom === '103') return { code: ZSWAP_INVALID_CODE, retryable: false, message: zswapInvalidMessage(message) };
        return invalidTransaction(nodeCode(custom ? `1010/${custom}` : '1010'), custom, message);
    }
    if (/\b1014\s*:/.test(haystack)) {
        return { code: '1014', retryable: false, message: `Pool reject (Substrate 1014): ${message}` };
    }
    if (/\b1016\s*:|Immediately\s*Dropped/i.test(haystack)) return poolDropped(network, message);

    if (/ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|socket hang up|timeout|disconnected from|Normal Closure|Abnormal Closure|WebSocket is not connected/i.test(haystack)) {
        return { code: 'NETWORK_OR_TIMEOUT', retryable: true, message };
    }

    if (/ContractTypeError|IncompleteCallTxPrivateStateConfig|IncompleteFindContractPrivateStateConfig/.test(name)) {
        return { code: 'CONTRACT_CONFIG_INVALID', retryable: false, message: `${name}: ${message}` };
    }

    if (name === 'WalletSigningNotAvailable' || /WalletSigningNotAvailable/.test(message)) {
        return {
            code: 'WALLET_SIGNING_NOT_AVAILABLE',
            retryable: false,
            message: `${message} (session needs encryptedSeedKey to sign/balance transactions)`
        };
    }

    // A failure that carries a code of the table keeps it. Only a code the table marks for jobs decides about a new attempt.
    const coded = findNightgateError(err);
    if (coded) return { code: coded.code, retryable: isJobErrorCode(coded.code) && coded.retryable, message };
    const own = (err as { code?: unknown; retryable?: unknown } | null)?.code;
    if (isJobErrorCode(own)) return { code: own, retryable: (err as { retryable?: unknown }).retryable === true, message };
    // The worker client names an error after the job code it stands for, such as WORKER_ROTATED.
    if (isJobErrorCode(name)) return { code: name, retryable: false, message };

    // Unknown errors are not retried, to avoid hammering the node. The name of the error goes into the message, never into the code.
    return { code: 'UNKNOWN_ERROR', retryable: false, message: name && name !== 'Error' ? `${name}: ${message}` : message };
}

const ZSWAP_INVALID_CODE = '1010/103';
const zswapInvalidMessage = (message: string): string =>
    `Shielded offer refused (Substrate 1010, ledger error 103: a coin the transaction spends is already spent, or its proof refers to a coin tree state the node no longer accepts); nothing entered the pool and no fee was spent; a swap offer ends here once another fill of it landed, or when a half is too old: build a new half against the current state: ${message}`;

const STALE_TRANSCRIPT_CODE = '1010/104';
const staleTranscriptMessage = (message: string): string =>
    `Transaction refused against the current contract state (Substrate 1010, ledger error 104: the call's transcript no longer fits, typically its gas budget after another transaction on the same contract grew a map); nothing entered the pool and no fee was spent; build the call again against the current state and submit the new bytes: ${message}`;

// The classifications both paths share: the text match and the worker's coded failure.
const priorityReject = (message: string): SubmissionErrorClassification =>
    ({ code: '1014', retryable: false, message: `Pool priority reject (Substrate 1014, priority too low): ${message}` });
const poolDropped = (network: NightgateNetwork, message: string): SubmissionErrorClassification => network === 'mainnet'
    ? { code: '1016', retryable: false, knownIssueRef: KNOWN_ISSUE_1016_MAINNET, message: `Mainnet deterministic rejection (1016 Immediately Dropped). Known issue; see ${KNOWN_ISSUE_1016_MAINNET}` }
    : { code: '1016', retryable: true, message: `Transaction pool full or immediately dropped: ${message}` };
/** A ledger code as the node's reject number. A text that is none counts as the plain 1010. */
const nodeCode = (code: string): NodeRejectCode => (isNodeRejectCode(code) ? code : '1010');
const invalidTransaction = (code: NodeRejectCode, ledgerError: string | null, message: string): SubmissionErrorClassification =>
    ({ code, retryable: false, message: `Invalid transaction (Substrate 1010${ledgerError ? `, ledger error ${ledgerError}` : ''}): ${message}` });
const dustRace = (code: NodeRejectCode, message: string): SubmissionErrorClassification => ({
    code, retryable: true, transient: 'dust-race',
    message: `Transient dust race (Substrate 1010, ledger error ${code.slice(5)}): the dust spend was built against a dust state the node has already moved past; nothing entered the pool and no fee was spent, rebuild and resubmit: ${message}`
});

function classificationFromSubmitFailure(
    info: { code: string; ledgerCode?: string; retryable: boolean; calls?: BatchCallStageInfo[] },
    message: string,
    network: NightgateNetwork
): SubmissionErrorClassification {
    switch (info.code) {
        case 'dust-race':
            if (info.ledgerCode === 'pool-invalid') {
                return { code: 'POOL_INVALID', retryable: true, transient: 'dust-race', message: `Pool status Invalid (a competing transaction consumed a note first, or the transaction is invalid); rebuild and resubmit: ${message}` };
            }
            return dustRace(nodeCode(info.ledgerCode ?? '1010'), message);
        case 'pre-mempool-reject': {
            const ledger = info.ledgerCode ?? '1010';
            if (ledger === 'intent-rejected') return { code: 'SUBMIT_INTENT_REJECTED', retryable: false, message };
            if (ledger === 'intent-timeout') return { code: 'SUBMIT_INTENT_TIMEOUT', retryable: false, message: `The announced transaction was not recorded in time; nothing was broadcast, a new idempotencyKey may retry: ${message}` };
            if (ledger === '1014') return priorityReject(message);
            if (ledger === '1016') return poolDropped(network, message);
            if (ledger === STALE_TRANSCRIPT_CODE) return { code: ledger, retryable: false, message: staleTranscriptMessage(message) };
            if (ledger === ZSWAP_INVALID_CODE) return { code: ledger, retryable: false, message: zswapInvalidMessage(message) };
            return invalidTransaction(nodeCode(ledger), ledger.startsWith('1010/') ? ledger.slice(5) : null, message);
        }
        case 'transport':
            return { code: 'NETWORK_OR_TIMEOUT', retryable: true, message };
        case 'ambiguous':
            // Never rebuilt, because the sent transaction may still land.
            return { code: 'SUBMIT_AMBIGUOUS', retryable: false, message };
        case 'landed-not-applied':
            return { code: 'TX_FAILED', retryable: false, message };
        case 'policy':
            return { code: 'SPONSOR_REFUSED', retryable: false, message };
        case 'causality':
            return { code: 'BATCH_CAUSALITY_VIOLATION', retryable: false, message, ...(info.calls?.length ? { calls: info.calls } : {}) };
        case 'gas-budget':
            return { code: 'BATCH_GAS_BUDGET_EXCEEDED', retryable: false, message };
        default:
            return { code: 'UNKNOWN_ERROR', retryable: false, message };
    }
}

