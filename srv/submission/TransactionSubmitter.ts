/**
 * Main-thread orchestrator for contract deploy/call via the wallet worker. The
 * PendingSubmissions row is inserted BEFORE the worker runs (crash recovery).
 * Only pre-mempool rebuilds retry here; other retry policy is the caller's.
 */

import cds from '@sap/cds';
import { classificationHaystack } from '../utils/format-error';
import { DUST_RACE_LEDGER_CODES, dustRaceLedgerCode } from './dust-race';
import { classifySubmitFailure } from '../midnight/submit-error-classification';
import { carriedSubmitFailure, type BatchCallStageInfo } from '../midnight/wallet-worker-protocol';
import { reportExternalExecution, reportExternalSubmission, reportBroadcastOn, reportSubmissionRejectedOn, SponsorAttemptBookkeepingPendingError } from './job-execution-context';
import { withLockContentionRetry } from './db-write-retry';
import { isPreInclusionReject } from './sponsor-pool';
import type { SubmitIntentHook } from '../midnight/wallet-worker-client';
const { INSERT, UPDATE, SELECT } = cds.ql;
import { PendingSubmissions } from '#cds-models/midnight';
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

/** Registration meta for the worker; the compiled contract does not survive structured-clone. */
export interface ContractRegistrationMeta {
    artifactPath:   string;
    /** Generation digest of the artifact; keys the worker's module cache. */
    artifactDigest?: string;
    privateStateId: string;
    zkConfigPath:   string;
    /** Content-tree width of a vault-family artifact (default 16). */
    slotWidth?:     number;
}

export interface DeployArgs<PS = unknown> {
    contractName: string;
    registration: ContractRegistrationMeta;
    initialPrivateState: PS;
    sessionId: string;
    /** Vault family: recovery identity (64 hex) for the constructor; absent = none. */
    recoveryId?: string;
}

export interface CallArgs {
    contractAddress: string;
    circuit: string;
    args: unknown[];
    contractName: string;
    registration: ContractRegistrationMeta;
    sessionId: string;
    /** Witness input for the field-bound proof circuits; never a circuit arg. */
    merkleProof?: MerkleProofBundle;
    /** Seeded when the calling wallet has no private state for this contract (default `{}`). */
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
    /** Indexer block height of the inclusion, when the worker reported one. */
    blockHeight?: number | null;
}

export interface CallBatchArgs {
    contractAddress: string;
    /** Ordered calls in ONE transaction; a per-call `merkleProof` excludes the batch-level one. */
    calls: Array<{ circuit: string; args: unknown[]; merkleProof?: MerkleProofBundle }>;
    contractName: string;
    registration: ContractRegistrationMeta;
    sessionId: string;
    merkleProof?: MerkleProofBundle;
    initialPrivateState?: unknown;
    /** The calls past `orderedPrefix` share no state: grouped by execution stage before proving. */
    independentCalls?: boolean;
    orderedPrefix?: number;
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
    /** Dust spend built against a stale dust state: pre-mempool, fee unspent, rebuild. */
    transient?: 'dust-race';
    /** `BatchCausalityViolation`: every call's apply position and stages. */
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
    /** Defaults to cds.connect.to('db'). */
    db?: any;
    /** Test seams for the worker RPCs. */
    walletDeployContractImpl?: typeof walletDeployContract;
    walletSubmitContractCallImpl?: typeof walletSubmitContractCall;
    walletSubmitContractCallBatchImpl?: typeof walletSubmitContractCallBatch;
    walletBuildSponsorableTxImpl?: typeof walletBuildSponsorableTx;
    network: NightgateNetwork;
    /** Worker facade key of the dust-fee sponsor; already authorised by the handler. */
    sponsorAccountId?: string;
}

/** See TransactionSubmitter.boundAttemptLedger. */
interface BoundAttemptLedger {
    onSubmitIntent: SubmitIntentHook;
    rejectAnnouncedAttempt: (why: string) => Promise<void>;
    current: () => { rowId: string | null; txHash: string | null };
}

export class TransactionSubmitter {
    private db: cds.DatabaseService | undefined;

    constructor(private readonly deps: TransactionSubmitterDeps) {
        if (deps.db) this.db = deps.db;
    }

    /**
     * Rebuild on pre-mempool rejects a fresh build heals: a dust race (1010/170,
     * 1010/196) or a stale transcript (1010/104). Each kind has its own budget.
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
                // Take the rejected identifier off the job BEFORE the rebuild announces
                // a new one; throws (no rebuild) when that cannot commit.
                await ledger.rejectAnnouncedAttempt(`${reason}; rebuilt`);
                await new Promise(resolve => setTimeout(resolve, backoffMs));
            }
        }
    }

    /**
     * Bound-channel attempt bookkeeping: each announce and each reject commits row
     * and job in one transaction, so the job's txHash is the ONE identifier that
     * may be on chain and no txHash means nothing was broadcast.
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
                ...(intent?.ttl ? { ttl: intent.ttl } : {})
            };
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
            if (!txHash || !rowId) return; // nothing announced: the row is reused by the next intent
            const db = await this.getDb();
            const closing = rowId;
            const hash = txHash;
            try {
                await withLockContentionRetry(`rejectAttempt(${closing.slice(0, 8)})`, () => this.runInOneTransaction(db, async (tx) => {
                    await tx.run(UPDATE.entity(PendingSubmissions).set({ status: 'failed', errorCode: 'REJECTED', errorMessage: why.slice(0, 500) }).where({ ID: closing }));
                    await reportSubmissionRejectedOn(tx, { submissionId: closing, txHash: hash });
                }), msg => log.warn(msg));
            } catch (e) {
                // Parked; the reconciler re-runs close + hash removal.
                throw new SponsorAttemptBookkeepingPendingError(
                    `broadcast attempt ${closing} was rejected before inclusion but its bookkeeping (row, hash) could not be committed: ${String((e as Error)?.message ?? e)}. Settled by the reconciler. Original failure: ${why.slice(0, 200)}`,
                    { submissionId: closing, txHash: hash, refund: 0 });
            }
            rowId = null; txHash = null;
        };
        return { onSubmitIntent, rejectAnnouncedAttempt, current: () => ({ rowId, txHash }) };
    }

    /** Run `fn` in one transaction of `db` (a test double without `tx` runs it directly). */
    private runInOneTransaction<T>(db: any, fn: (tx: { run: (q: unknown) => Promise<unknown> }) => Promise<T>): Promise<T> {
        if (typeof db?.tx === 'function') return db.tx(fn);
        return fn(db);
    }

    /** Shared failure path; returns the row id the SubmissionError names. */
    private async settleFailedAttempt(ledger: BoundAttemptLedger, fallbackRowId: string, err: unknown, classification: SubmissionErrorClassification): Promise<string> {
        const { rowId, txHash } = ledger.current();
        const named = rowId ?? fallbackRowId;
        if (txHash && rowId && isPreInclusionReject(err)) {
            await ledger.rejectAnnouncedAttempt(classification.message);
        } else if (txHash && rowId) {
            // May still land: keep the row `pending` so reconciliation can finalize
            // it; a `failed` row never could.
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
     * Several calls on one contract in ONE transaction, one row. A partial success
     * is on chain with a subset applied: the row fails and the caller must verify state.
     */
    async callBatch(args: CallBatchArgs): Promise<CallBatchResult> {
        const circuits = args.calls.map(c => c.circuit);
        // circuitName is String(100).
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
     * Register a main-thread private-state provider the worker proxies to. Only
     * 'cap-db': the LevelDB provider does not survive a thread boundary.
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

    /** The worker keys facades on accountId, not the OData session id. */
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

    /** Build, sign and finalize without submitting (fee-unpaid, base64); no row, nothing on chain. */
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
        // Best-effort: must not mask the classification the caller is about to throw.
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

/** Stable code + retryability for a thrown submission error. */
export function classifySubmissionError(err: unknown, network: NightgateNetwork): SubmissionErrorClassification {
    // Keep a prior classification verbatim: the wrapper text lacks the node's
    // "Custom error: N", so re-deriving would degrade `1010/188` to `1010`.
    const prior = (err as SubmissionError | undefined)?.classification;
    if (prior && typeof prior.code === 'string' && typeof prior.retryable === 'boolean'
        && typeof prior.message === 'string') {
        return prior;
    }

    const message = err instanceof Error ? err.message : String(err);
    const name = err instanceof Error ? err.name : 'Error';

    const carried = carriedSubmitFailure(err);
    if (carried) return classificationFromSubmitFailure(carried, message, network);

    // Text fallback for errors that never crossed the worker RPC.
    if (name === 'TxFailedError' || message.includes('TxFailedError')) {
        return { code: 'TxFailed', retryable: false, message };
    }

    // Our pre-proving batch check, matched by message (midnight-js drops the name).
    // Before the 1010 patterns: its text mentions 1010/188.
    if (/violates the ledger's causality constraint/.test(message)) {
        return { code: 'BatchCausalityViolation', retryable: false, message };
    }

    // Node rejects hide under SDK wrappers, so match a deep inspection. 1010 is a
    // validity reject whose `Custom error: N` becomes `1010/N`; 1014 is a pool
    // reject. The haystack has no stack positions, so `x.js:1010:27` cannot match.
    const haystack = `${message} ${classificationHaystack(err)}`;
    // First: its "(X vs Y)" priority numbers must not read as a 1010 code.
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

    // Unknown: non-retryable, to avoid hammering.
    return { code: name || 'UnknownError', retryable: false, message };
}

/** Ledger error 104 (transcript refused): the call no longer fits the contract state it was built against. */
const STALE_TRANSCRIPT_CODE = '1010/104';
const staleTranscriptMessage = (message: string): string =>
    `Transaction refused against the current contract state (Substrate 1010, ledger error 104: the call's transcript no longer fits, typically its gas budget after another transaction on the same contract grew a map); nothing entered the pool and no fee was spent; build the call again against the current state and submit the new bytes: ${message}`;

/** The job-level classification of a worker-classified submit failure. */
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
            const custom = ledger.startsWith('1010/') ? ledger.slice(5) : null;
            return { code: ledger, retryable: false, message: `Invalid transaction (Substrate 1010${custom ? `, ledger error ${custom}` : ''}): ${message}` };
        }
        case 'transport':
            return { code: 'NetworkOrTimeout', retryable: true, message };
        case 'ambiguous':
            // Never rebuilt: the identifier may land.
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

