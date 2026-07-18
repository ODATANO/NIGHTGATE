/**
 * TransactionSubmitter, server-side submission orchestrator for the
 * Midnight contract path (deploy + call).
 *
 * The SDK invocation runs in a `worker_threads` worker (see
 * `srv/midnight/wallet-worker.ts`) so the SDK's Effect.ts microtask saturation
 * stays off the main thread. This class is an orchestrator:
 *
 *   1. Insert a `pending` row into PendingSubmissions BEFORE invoking the
 *      worker. The row carries our internal UUID; txHash + contractAddress
 *      are filled in once the worker returns. This is the recovery hook for
 *      the "process crashed mid-submission" case.
 *
 *   2. Build a CapDbPrivateStateProvider on the main thread (where the CAP DB
 *      lives) and register it under an ephemeral `proxyId` with the worker
 *      client. The worker creates a thin proxy that round-trips PS CRUD back
 *      to this provider via `private-state-rpc` messages.
 *
 *   3. Invoke the worker (`walletDeployContract` / `walletSubmitContractCall`).
 *      The worker owns the SDK, the compiled contract artifact (cached by
 *      name), and the wallet facade. It returns only primitives
 *      (`txHash`, `contractAddress`, `onChainStatus`); no SDK object crosses
 *      the thread boundary.
 *
 *   4. On success → UPDATE row with `{ txHash, contractAddress, status }`.
 *      The crawler's BlockProcessor flips it to 'finalized' once the tx hash
 *      appears in a block.
 *
 *   5. On failure → UPDATE row with `{ status='failed', errorCode, errorMessage }`.
 *      Errors are classified (see classifySubmissionError):
 *        - 1014  permanent (invalid tx), no retry
 *        - 1016  on mainnet: deterministic per forum thread 1190;
 *                fail fast with a known-issue reference. On preprod: retryable.
 *        - TIMEOUT/NETWORK transient, caller may retry
 *        - TxFailedError from SDK, the on-chain status was not SucceedEntirely
 *
 * The submitter does not retry on its own. The OData action callers decide
 * retry policy based on the returned error classification.
 */

import cds from '@sap/cds';
const { INSERT, UPDATE } = cds.ql;
import { PendingSubmissions } from '#cds-models/midnight';
import { ensureNightgateModelLoaded } from '../utils/cds-model';
import {
    type ContractProvidersConfig,
    type WalletMaterial
} from '../midnight/providers';
import { type NightgateNetwork } from '../utils/nightgate-config';
import { CapDbPrivateStateProvider } from '../midnight/CapDbPrivateStateProvider';
import {
    walletDeployContract,
    walletSubmitContractCall,
    registerPrivateStateProvider,
    unregisterPrivateStateProvider,
    type WalletDeployContractArgs,
    type WalletSubmitContractCallArgs
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

    // -- Internals -----------------------------------------------------------

    /**
     * Build a CapDbPrivateStateProvider for this submission and register it
     * under a fresh `proxyId`. The worker's PS proxy will round-trip CRUD
     * calls back to the matching main-side instance. `release()` unregisters
     * the provider; it's safe to call exactly once after the worker RPC
     * resolves or rejects.
     *
     * Throws if the configured private-state backend is anything other than
     * 'cap-db': the legacy LevelDB path is incompatible with worker-routed
     * submissions (the SDK's LevelDB provider doesn't survive a thread
     * boundary, and its on-disk format is dev-only per the SDK docs).
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
     * The worker stores facades keyed on `accountId` (deterministic per
     * viewing key), set by the pre-warm in connectWalletForSigning. We must
     * use the same key when looking up the facade for deploy/call; the OData
     * user-session UUID would miss. `args.sessionId` is preserved on the
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
        const db = await this.getDb();
        await db.run(
            UPDATE.entity(PendingSubmissions).set({
                status: 'failed',
                errorCode: classification.code,
                errorMessage: classification.message.slice(0, 500)
            }).where({ ID: submissionId })
        );
    }
}

// ---- Error classification --------------------------------------------------

const KNOWN_ISSUE_1016_MAINNET =
    'https://forum.midnight.network/t/.../1190 (mainnet 1016 Immediately Dropped deterministic rejection, early May 2026)';

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
 * Called by BlockProcessor when a transaction is persisted. If a
 * PendingSubmissions row exists with the same txHash, mark it 'finalized'
 * and attach a JSON snapshot of the indexed tx.
 *
 * No-op if no pending row matches (most txs are not ours).
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

