import cds from '@sap/cds';

import { registerWalletSessionHandlers, startSessionCleanup } from './sessions/wallet-sessions';
import { attachAgentGrantEnforcement, registerAgentGrantHandlers, awaitAgentPrincipal } from './sessions/agent-grants';
import { attachRuntimeGate, attachReadLimits } from './utils/runtime-gate';
import { attachIndexedReads } from './utils/indexed-reads';
import { attachHexInput } from './utils/hex-input';
import { attachInt64Results } from './utils/numbers';
import { registerSubmissionHandlers } from './submission/handlers';
import { registerDocumentProofHandlers } from './submission/document-proof';
import { receiptForJob } from './submission/receipts';
import { getJobById, runWithoutAmbientTx } from './submission/background-jobs';
import { jobResultObject } from './submission/job-store';
import { storedChainSegments } from './submission/job-reconciliation';
import { LONG_POLL_MAX_MS, holdUntil, waiterPool } from './utils/long-poll';
import { contractStateAt, ledgerParametersAt, IndexerBudgetExhausted, IndexerBehind, IndexerUnavailable, type ContractStateFetcher, type FetchedContractState, type LedgerParametersFetcher } from './crawler/contract-state';
import { fetchContractState, fetchLedgerParameters } from './crawler/indexer-supplement';
import { normalizeIdentifier } from './crawler/transaction-identifiers';
import { parseJsonStringList } from './utils/json-list';
import { readCapBinary } from './crawler/cap-binary';
import { extractLedgerPayload } from './crawler/ledger-payload';
import { parseExtrinsicCall } from './utils/scale';
import { getNightgateConfig, resolveNightgateRuntimeConfig } from './utils/nightgate-config';
import { RateLimiter } from './utils/rate-limiter';
import { configNumber } from './utils/config';
import { bareHex } from './utils/hex-patterns';
import { rejectRateLimited } from './utils/rate-classes';
import { Blocks, Transactions, TransactionIdentifiers, TransactionResults, TransactionSegments, type TransactionResult, type TransactionSegment, type Transaction as IndexedTransaction, type BackgroundJob } from '#cds-models/midnight';
import { normalizeHttpError } from './utils/http-errors';
import { messageWithoutUrls } from './utils/errors';
import { getJobStatus, Block, ContractState, Transaction, Transactions as ServedTransactions } from '#cds-models/NightgateService';
import { narrowRead } from './utils/request-types';

// One limit for all callers of this server, because an indexer may block the host's IP after too many requests.
let stateAtLimiter: RateLimiter | null = null;
const stateAtIndexerLimiter = (): RateLimiter =>
    (stateAtLimiter ??= new RateLimiter({ windowMs: 1000, maxRequests: configNumber('NIGHTGATE_STATE_AT_INDEXER_RATE') }));

// Equal requests share one indexer read. A state at a fixed height is kept briefly; the newest state never is.
const STATE_AT_CACHE_MS = 5_000;
/** Limit and skip of a list function. The model checks their ranges, at most 5000 rows per call. */
function listPage(data: { limit?: number | null; skip?: number | null }, defaultLimit: number): { limit: number; skip: number } {
    return { limit: data.limit ?? defaultLimit, skip: data.skip ?? 0 };
}
const stateAtInFlight = new Map<string, Promise<FetchedContractState | null>>();
const stateAtCache = new Map<string, { at: number; value: FetchedContractState }>();

// A state at the block of its action never changes once the index holds that block, because the index holds finalized blocks only.
// The map keeps insertion order: its first key is the one used longest ago.
const finalStates = new Map<string, { bytes: number; value: FetchedContractState }>();
let finalStateBytes = 0;

function keepFinalState(key: string, value: FetchedContractState): void {
    const budget = configNumber('NIGHTGATE_STATE_AT_CACHE_MB') * 1024 * 1024;
    const bytes = (value.state?.length ?? 0) + (value.zswapState?.length ?? 0) + (value.ledgerParameters?.length ?? 0);
    forgetFinalState(key);
    if (bytes > budget) return;
    finalStates.set(key, { bytes, value });
    finalStateBytes += bytes;
    for (const [oldest, entry] of finalStates) {
        if (finalStateBytes <= budget) break;
        finalStates.delete(oldest);
        finalStateBytes -= entry.bytes;
    }
}

function forgetFinalState(key: string): void {
    const old = finalStates.get(key);
    if (!old) return;
    finalStates.delete(key);
    finalStateBytes -= old.bytes;
}

function finalStateOf(key: string): FetchedContractState | undefined {
    const kept = finalStates.get(key);
    if (!kept) return undefined;
    finalStates.delete(key);
    finalStates.set(key, kept);
    return kept.value;
}

/** True when the answer is the state at the asked block and the index holds that block under the same hash. */
async function isFinalAnswer(db: cds.DatabaseService, height: number, value: FetchedContractState): Promise<boolean> {
    if (value.height !== height || !value.blockHash) return false;
    const block: Pick<Block, 'hash'> | undefined = await db.run(cds.ql.SELECT.one.from(Blocks).columns('hash').where({ height }));
    return !!block?.hash && bareHex(block.hash) === bareHex(value.blockHash);
}

/** What byTxId reads across the identifier row, its transaction and that transaction's block. */
interface TransactionLocation {
    ID: string;
    extrinsicHash: string;
    txHash?: string | null;
    blockHeight: number | string;
    blockHash: string;
}

const JOB_SETTLED = new Set(['succeeded', 'failed', 'reconciliation_required']);
const jobWaiters = waiterPool(100);

// Each read runs outside the request's transaction, so a waiting call holds no database connection.
const readJob = (jobId: string): Promise<BackgroundJob | null> => runWithoutAmbientTx(() => getJobById(jobId));

/** The indexed transaction that carries a ledger identifier, newest block first. */
async function locateByTxId(db: cds.DatabaseService, txId: string): Promise<TransactionLocation | undefined> {
    return db.run(
        cds.ql.SELECT.one.from(TransactionIdentifiers)
            .columns('transaction.ID as ID', 'transaction.extrinsicHash as extrinsicHash', 'transaction.txHash as txHash',
                'transaction.blockHeight as blockHeight', 'transaction.block.hash as blockHash')
            .where({ txId })
            .orderBy('transaction.blockHeight desc')
    );
}

/** The identifier of a job stored with its ledger hash alone: the last one the indexed transaction lists. Null when the index does not have it. */
async function indexedTxIdOf(db: cds.DatabaseService, txHash: string | null | undefined): Promise<string | null> {
    if (!txHash) return null;
    const row: Pick<IndexedTransaction, 'identifiers'> | undefined = await db.run(
        cds.ql.SELECT.one.from(Transactions).columns('identifiers').where({ txHash })
    );
    return parseJsonStringList(row?.identifiers).at(-1) ?? null;
}

/** The ledger hash of a job stored with its identifier alone, from the local index. Null when the index does not have the transaction. */
async function indexedHashOf(db: cds.DatabaseService, txId: string | null | undefined): Promise<string | null> {
    const value = normalizeIdentifier(String(txId ?? ''));
    if (!value || !/^[0-9a-f]+$/.test(value)) return null;
    return (await locateByTxId(db, value))?.txHash ?? null;
}

function indexerUrls(): string[] {
    const { crawlerConfig, submissionEndpoints } = resolveNightgateRuntimeConfig(getNightgateConfig());
    return [...new Set([String(crawlerConfig.indexerUrl || ''), submissionEndpoints.indexerHttpUrl].filter(Boolean))];
}

// Parameters change rarely, and a build on outdated ones is refused without a fee. So a short cache spares the indexer budget.
const PARAMETERS_CACHE_MS = 30_000;
const parametersCache = new Map<string, { at: number; value: string }>();

/** Counts against the same budget as a state read. Only a database without stored parameters asks. */
function fetchLedgerParametersFromIndexers(): LedgerParametersFetcher {
    return async (height) => {
        const key = String(height ?? 'tip');
        const hit = parametersCache.get(key);
        if (hit && Date.now() - hit.at < PARAMETERS_CACHE_MS) return hit.value;
        const budget = stateAtIndexerLimiter().check('indexer');
        if (!budget.allowed) throw new IndexerBudgetExhausted(budget.retryAfterMs);
        let lastError: unknown;
        for (const url of indexerUrls()) {
            try {
                const value = await fetchLedgerParameters(url, height);
                if (value) {
                    if (parametersCache.size >= 500) parametersCache.clear();
                    parametersCache.set(key, { at: Date.now(), value });
                }
                return value;
            } catch (err) {
                lastError = err;
            }
        }
        throw new IndexerUnavailable(lastError ?? new Error('no indexer configured'));
    };
}

function fetchContractStateFromIndexers(db: cds.DatabaseService): ContractStateFetcher {
    const urls = indexerUrls();
    const read = async (address: string, height: number | null): Promise<FetchedContractState | null> => {
        let lastError: unknown;
        for (const url of urls) {
            try {
                return await fetchContractState(url, address, height);
            } catch (err) {
                lastError = err;
            }
        }
        throw new IndexerUnavailable(lastError ?? new Error('no indexer configured'));
    };
    return async (address, height) => {
        const key = `${address}:${height ?? 'newest'}`;
        const final = height == null ? undefined : finalStateOf(key);
        if (final) return final;
        const hit = height == null ? undefined : stateAtCache.get(key);
        if (hit && Date.now() - hit.at < STATE_AT_CACHE_MS) return hit.value;
        const pending = stateAtInFlight.get(key);
        if (pending) return pending;
        const budget = stateAtIndexerLimiter().check('indexer');
        if (!budget.allowed) throw new IndexerBudgetExhausted(budget.retryAfterMs);
        const started = read(address, height);
        stateAtInFlight.set(key, started);
        try {
            const value = await started;
            if (value && height != null) {
                if (await isFinalAnswer(db, height, value)) keepFinalState(key, value);
                else {
                    if (stateAtCache.size >= 500) stateAtCache.clear();
                    stateAtCache.set(key, { at: Date.now(), value });
                }
            }
            return value;
        } finally {
            stateAtInFlight.delete(key);
        }
    };
}

/** Answers a used-up indexer budget with 429 and a failed indexer with 502. Any other error is rethrown. */
function rejectIndexerFailure(req: cds.Request, err: unknown, what: string) {
    if (err instanceof IndexerBudgetExhausted) {
        const limiter = stateAtIndexerLimiter();
        return rejectRateLimited(req, {
            name: 'indexer-budget', limit: limiter.maxRequests,
            windowSeconds: limiter.windowMs / 1000, retryAfterMs: err.retryAfterMs
        });
    }
    if (!(err instanceof IndexerUnavailable)) throw err;
    // CAP hides 5xx messages in production. The indexer's error stays visible, with URLs removed because they can carry keys.
    const cause = messageWithoutUrls(err, '<indexer>');
    const upstream = { status: 502, code: 'BAD_GATEWAY', message: `indexer could not serve ${what}: ${cause}`, $sanitize: false };
    return req.reject(upstream);
}

export default class NightgateService extends cds.ApplicationService {
    private db!: cds.DatabaseService;
    private _cleanupTimer?: ReturnType<typeof setInterval>;

    async init(): Promise<void> {
        this.on('error', normalizeHttpError);
        this.db = await cds.connect.to('db');

        // The agent-token check must be the first before-hook.
        attachAgentGrantEnforcement(this, this.db);

        attachRuntimeGate(this);
        attachReadLimits(this, ['byHash', 'byTxId', 'ledgerTransaction', 'stateAt', 'ledgerParametersAt'], ['getJobStatus']);
        attachHexInput(this);
        attachIndexedReads(this, ['Blocks', 'Transactions', 'TransactionResults', 'TransactionFees', 'ContractActions', 'DustLedgerEvents']);
        attachInt64Results(this);

        this.on('READ', 'Blocks', async (req) => {
            return await this.db.run(req.query) || [];
        });

        this.on('READ', 'Transactions', async (req) => {
            return await this.db.run(req.query) || [];
        });

        this.on(Transaction.actions.byHash, 'Transactions', async (req) => {
            const { hash } = req.data;
            if (!hash) return req.reject(400, 'hash is required');
            const page = listPage(req.data, 100);
            return this.db.run(
                cds.ql.SELECT.from(ServedTransactions).where`extrinsicHash = ${hash} or txHash = ${hash}`
                    .orderBy('blockHeight desc', 'indexInBlock desc').limit(page.limit, page.skip)
            );
        });

        this.on(Transaction.actions.byTxId, 'Transactions', async (req) => {
            const { txId } = req.data;
            if (!txId) return req.reject(400, 'txId is required');
            const found = await locateByTxId(this.db, txId);
            if (!found) return req.reject(404, `no indexed transaction carries identifier ${txId}`);
            const result: Pick<TransactionResult, 'ID' | 'status'> | undefined = await this.db.run(
                cds.ql.SELECT.one.from(TransactionResults).columns('ID', 'status').where({ transaction_ID: found.ID })
            );
            const failed: Pick<TransactionSegment, 'segmentId'>[] = result ? await this.db.run(
                cds.ql.SELECT.from(TransactionSegments).columns('segmentId').where({ transactionResult_ID: result.ID, success: false })
            ) : [];
            return {
                txId,
                extrinsicHash: found.extrinsicHash,
                txHash: found.txHash ?? null,
                blockHeight: Number(found.blockHeight),
                blockHash: found.blockHash,
                status: result?.status ?? null,
                failedSegments: failed.map(s => Number(s.segmentId))
            };
        });

        this.on(Transaction.actions.ledgerTransaction, 'Transactions', async (req) => {
            const { hash } = req.data;
            if (!hash) return req.reject(400, 'hash is required');
            const row: Pick<IndexedTransaction, 'raw' | 'extrinsicHash'> | undefined = await this.db.run(
                cds.ql.SELECT.one.from(Transactions).columns('raw', 'extrinsicHash').where`extrinsicHash = ${hash} or txHash = ${hash}`.orderBy('blockHeight desc', 'indexInBlock desc')
            );
            const raw = row ? await readCapBinary(row.raw) : null;
            const call = raw ? parseExtrinsicCall('0x' + raw.toString('hex')) : null;
            const payload = call ? extractLedgerPayload(call.buf, call.argsOffset) : null;
            if (!payload) return req.reject(404, `no indexed ledger transaction for ${hash}`);
            return { extrinsicHash: row?.extrinsicHash ?? null, ledgerTransaction: Buffer.from(payload).toString('base64') };
        });

        this.on('READ', 'ContractActions', async (req) => {
            return await this.db.run(req.query) || [];
        });

        this.on('READ', 'ContractStates', async (req) => {
            return await this.db.run(req.query) || [];
        });

        this.on(ContractState.actions.stateAt, 'ContractStates', async (req) => {
            const { contractAddress, height } = req.data;
            if (!contractAddress) return req.reject(400, 'contractAddress is required');
            if (height != null && (!Number.isInteger(Number(height)) || Number(height) < 0)) {
                return req.reject(400, 'height must be a non-negative integer');
            }
            try {
                const snapshot = await contractStateAt(
                    this.db, contractAddress, height == null ? null : Number(height), fetchContractStateFromIndexers(this.db), fetchLedgerParametersFromIndexers()
                );
                if (!snapshot) return req.reject(404, `no state known for contract ${contractAddress}`);
                return snapshot;
            } catch (err) {
                if (err instanceof IndexerBehind) {
                    // The cached answer predates the newest action. A retry must ask the indexer again.
                    stateAtCache.delete(`${err.address}:${err.height}`);
                    forgetFinalState(`${err.address}:${err.height}`);
                    const behind = { status: 503, code: 'UNAVAILABLE', message: err.message, $sanitize: false };
                    return req.reject(behind);
                }
                return rejectIndexerFailure(req, err, `the contract state at ${height == null ? 'its newest state' : `height ${height}`}`);
            }
        });

        this.on(Block.actions.ledgerParametersAt, 'Blocks', async (req) => {
            const { height } = req.data;
            if (height != null && (!Number.isInteger(Number(height)) || Number(height) < 0)) {
                return req.reject(400, 'height must be a non-negative integer');
            }
            const at = height == null ? null : Number(height);
            try {
                const snapshot = await ledgerParametersAt(this.db, at, fetchLedgerParametersFromIndexers());
                if (!snapshot) return req.reject(404, `no ledger parameters known at ${at == null ? 'the chain tip' : `height ${at}`}`);
                return snapshot;
            } catch (err) {
                return rejectIndexerFailure(req, err, `the ledger parameters at ${at == null ? 'the chain tip' : `height ${at}`}`);
            }
        });

        this.on('READ', 'UnshieldedUtxos', async (req) => {
            return await this.db.run(req.query) || [];
        });

        // A caller reads only its own rows. An admin reads all of them.
        const ownRowsOnly = async (req: cds.Request) => {
            await awaitAgentPrincipal(req);
            if (req.user?.is?.('admin')) return;
            const userId = req.user?.id;
            if (!userId) return req.reject(401, 'authentication required');
            narrowRead(req, { userId });
        };

        registerWalletSessionHandlers(this, this.db);
        this.before('READ', 'WalletSessions', ownRowsOnly);
        registerAgentGrantHandlers(this, this.db);
        this.before('READ', 'AgentGrants', ownRowsOnly);
        for (const entity of ['Documents', 'GranteeIdentities', 'PredicateAttestations', 'DisclosureGrants'] as const) this.before('READ', entity, ownRowsOnly);

        registerSubmissionHandlers(this, this.db);
        registerDocumentProofHandlers(this);

        this.on(getJobStatus, async (req) => {
            const { jobId, sessionId, waitMs, untilChain } = req.data;
            if (!jobId) return req.reject(400, 'jobId is required');
            if (waitMs != null && !(Number.isInteger(waitMs) && waitMs >= 0 && waitMs <= LONG_POLL_MAX_MS)) {
                return req.reject(400, `waitMs must be an integer from 0 to ${LONG_POLL_MAX_MS}`);
            }

            let job = await readJob(jobId);
            if (!job || (sessionId && job.sessionId !== sessionId)) {
                return req.reject(404, 'Job not found');
            }

            // 404 rather than 403, so callers cannot probe for other users' jobs.
            const user = req.user;
            if (!user?.is?.('admin')) {
                const requesterId = user?.id;
                // A token reads only the jobs its own grant started. Grants of one user share the sponsor pool.
                if (req.agentGrant && job.grantId !== req.agentGrant.ID) {
                    return req.reject(404, 'Job not found');
                }
                if (!requesterId || job.requestedBy !== requesterId) {
                    return req.reject(404, 'Job not found');
                }
            }

            if (waitMs) {
                const found = job;
                const settled = (j: BackgroundJob) => JOB_SETTLED.has(String(j.status))
                    && !(untilChain === true && j.status === 'succeeded' && j.chainStatus === 'pending');
                job = await holdUntil(req, waitMs, jobWaiters, found, async () => (await readJob(jobId)) ?? found, settled);
            }
            const txHash = job.txHash ?? await indexedHashOf(this.db, job.txId);

            return {
                jobId: job.ID,
                kind: job.kind,
                status: job.status,
                result: jobResultObject(job.result),
                errorCode: job.errorCode,
                errorMessage: job.errorMessage,
                attempt: job.attempt,
                maxAttempts: job.maxAttempts,
                submissionId: job.submissionId,
                txId: job.txId ?? await indexedTxIdOf(this.db, txHash),
                txHash,
                chainStatus: job.chainStatus,
                chainFinalizedAt: job.chainFinalizedAt,
                blockHeight: job.blockHeight ?? null,
                blockHash: job.blockHash ?? null,
                chainSegments: storedChainSegments(job.chainSegments) ?? [],
                queuedAt: job.queuedAt ?? job.createdAt,
                externalExecutionAt: job.externalExecutionAt,
                submittedAt: job.submittedAt,
                startedAt: job.startedAt,
                finishedAt: job.finishedAt,
                receipt: receiptForJob(job, txHash, String(resolveNightgateRuntimeConfig(getNightgateConfig()).network))
            };
        });

        this._cleanupTimer = startSessionCleanup(this.db);
        cds.on('shutdown', () => {
            if (this._cleanupTimer) {
                clearInterval(this._cleanupTimer);
                this._cleanupTimer = undefined;
            }
        });

        await super.init();
    }
}
