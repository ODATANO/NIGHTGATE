import cds from '@sap/cds';

import { registerWalletSessionHandlers, startSessionCleanup } from './sessions/wallet-sessions';
import { attachAgentGrantEnforcement, registerAgentGrantHandlers, awaitAgentPrincipal } from './sessions/agent-grants';
import { ensureNightgateModelLoaded } from './utils/cds-model';
import { attachRuntimeGate } from './utils/runtime-gate';
import { registerSubmissionHandlers } from './submission/handlers';
import { registerDocumentProofHandlers } from './submission/document-proof';
import { receiptForJob } from './submission/receipts';
import { getJobById, runWithoutAmbientTx } from './submission/background-jobs';
import { LONG_POLL_MAX_MS, holdUntil, waiterPool } from './utils/long-poll';
import { contractStateAt, IndexerBudgetExhausted, IndexerBehind, type ContractStateFetcher, type FetchedContractState } from './crawler/contract-state';
import { fetchContractState } from './crawler/indexer-supplement';
import { normalizeIdentifier } from './crawler/transaction-identifiers';
import { getNightgatePluginConfig, resolveNightgateRuntimeConfig } from './utils/nightgate-config';
import { RateLimiter } from './utils/rate-limiter';
import { configNumber } from './utils/config';
import { rejectRateLimited } from './utils/rate-classes';

// One limit for all callers of this server: the public indexer blocks the host's IP when it gets too many requests.
let stateAtLimiter: RateLimiter | null = null;
const stateAtIndexerLimiter = (): RateLimiter =>
    (stateAtLimiter ??= new RateLimiter({ windowMs: 1000, maxRequests: configNumber('NIGHTGATE_STATE_AT_INDEXER_RATE') }));

// Equal requests share one indexer read. A state at a fixed height is kept briefly; the newest state never is.
const STATE_AT_CACHE_MS = 5_000;
const stateAtInFlight = new Map<string, Promise<FetchedContractState | null>>();
const stateAtCache = new Map<string, { at: number; value: FetchedContractState }>();

/** What byIdentifier reads across the identifier row, its transaction and that transaction's block. */
interface TransactionLocation {
    ID: string;
    hash: string;
    ledgerTxHash?: string | null;
    blockHeight: number | string;
    blockHash: string;
}

const JOB_SETTLED = new Set(['succeeded', 'failed', 'reconciliation_required']);
const jobWaiters = waiterPool(100);

// Each read runs outside the request's transaction, so a waiting call holds no database connection.
const readJob = (jobId: string): Promise<BackgroundJob | null> => runWithoutAmbientTx(() => getJobById(jobId));

/** The indexed transaction that carries a ledger identifier, newest block first. */
async function locateByIdentifier(db: cds.DatabaseService, identifier: string): Promise<TransactionLocation | undefined> {
    return db.run(
        cds.ql.SELECT.one.from(TransactionIdentifiers)
            .columns('transaction.ID as ID', 'transaction.hash as hash', 'transaction.ledgerTxHash as ledgerTxHash',
                'transaction.block.height as blockHeight', 'transaction.block.hash as blockHash')
            .where({ identifier })
            .orderBy('transaction.block.height desc')
    );
}

/** The hash explorers show for a job's `txHash`: found by identifier, or the value itself when a row stored that hash. */
async function explorerHashOf(db: cds.DatabaseService, txHash: string | null | undefined): Promise<string | null> {
    const value = normalizeIdentifier(String(txHash ?? ''));
    if (!value || !/^[0-9a-f]+$/.test(value)) return null;
    const located = await locateByIdentifier(db, value);
    if (located?.ledgerTxHash) return located.ledgerTxHash;
    const stored: Pick<IndexedTransaction, 'ledgerTxHash'> | undefined = await db.run(
        cds.ql.SELECT.one.from(Transactions).columns('ledgerTxHash').where({ ledgerTxHash: value })
    );
    return stored?.ledgerTxHash ?? null;
}

function fetchContractStateFromIndexers(): ContractStateFetcher {
    const { crawlerConfig, submissionEndpoints } = resolveNightgateRuntimeConfig(getNightgatePluginConfig());
    const urls = [...new Set([String(crawlerConfig.indexerUrl || ''), submissionEndpoints.indexerHttpUrl].filter(Boolean))];
    const read = async (address: string, height: number | null): Promise<FetchedContractState | null> => {
        let lastError: unknown;
        for (const url of urls) {
            try {
                return await fetchContractState(url, address, height);
            } catch (err) {
                lastError = err;
            }
        }
        throw lastError ?? new Error('no indexer configured');
    };
    return async (address, height) => {
        const key = `${address}:${height ?? 'newest'}`;
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
                if (stateAtCache.size >= 500) stateAtCache.clear();
                stateAtCache.set(key, { at: Date.now(), value });
            }
            return value;
        } finally {
            stateAtInFlight.delete(key);
        }
    };
}

import { Blocks, Transactions, TransactionIdentifiers, TransactionResults, TransactionSegments, ContractActions, UnshieldedUtxos, NightBalances, WalletSessions, type WalletSession, type TransactionResult, type TransactionSegment, type Transaction as IndexedTransaction, type BackgroundJob } from '#cds-models/midnight';
import { normalizeHttpError } from './utils/http-errors';
import { getJobStatus } from '#cds-models/NightgateService';
import { Block, ContractAction, ContractState, NightBalance, Transaction, UnshieldedUtxo } from '#cds-models/NightgateService';


export default class NightgateService extends cds.ApplicationService {
    private db!: cds.DatabaseService;
    private _cleanupTimer?: ReturnType<typeof setInterval>;

    async init(): Promise<void> {
        this.on('error', normalizeHttpError);
        await ensureNightgateModelLoaded();
        this.db = await cds.connect.to('db');

        // The agent-token check must be the first before-hook.
        attachAgentGrantEnforcement(this, this.db);

        attachRuntimeGate(this);

        this.on('READ', 'Blocks', async (req) => {
            return await this.db.run(req.query) || [];
        });

        this.on('latest', 'Blocks', async () => {
            return this.db.run(
                cds.ql.SELECT.one.from(Blocks).orderBy('height desc')
            );
        });

        this.on(Block.actions.byHeight, 'Blocks', async (req) => {
            const { height } = req.data;
            if (height == null) return req.reject(400, 'height is required');
            return this.db.run(
                cds.ql.SELECT.one.from(Blocks).where({ height })
            );
        });

        this.on(Block.actions.range, 'Blocks', async (req) => {
            const { startHeight, endHeight, limit } = req.data;

            if (startHeight == null || endHeight == null) {
                return req.reject(400, 'startHeight and endHeight are required');
            }

            if (!Number.isInteger(startHeight) || !Number.isInteger(endHeight) || startHeight < 0 || endHeight < 0) {
                return req.reject(400, 'startHeight and endHeight must be non-negative integers');
            }

            if (endHeight < startHeight) {
                return req.reject(400, 'endHeight must be greater than or equal to startHeight');
            }

            const effectiveLimit = Math.min(Math.max(limit || 100, 1), 5000);
            // A tagged template, because '>=' and '<=' on one column in an object silently lose a condition.
            return this.db.run(
                cds.ql.SELECT.from(Blocks)
                    .where`height >= ${startHeight} and height <= ${endHeight}`
                    .orderBy('height asc')
                    .limit(effectiveLimit)
            );
        });

        this.on('READ', 'Transactions', async (req) => {
            return await this.db.run(req.query) || [];
        });

        this.on(Transaction.actions.byHash, 'Transactions', async (req) => {
            const { hash } = req.data;
            if (!hash) return req.reject(400, 'hash is required');
            return this.db.run(cds.ql.SELECT.from(Transactions).where({ hash }));
        });

        this.on(Transaction.actions.byIdentifier, 'Transactions', async (req) => {
            const identifier = normalizeIdentifier(String(req.data.identifier ?? ''));
            if (!identifier) return req.reject(400, 'identifier is required');
            if (!/^[0-9a-f]+$/.test(identifier)) return req.reject(400, 'identifier must be hex');
            const found = await locateByIdentifier(this.db, identifier);
            if (!found) return req.reject(404, `no indexed transaction carries identifier ${identifier}`);
            const result: Pick<TransactionResult, 'ID' | 'status'> | undefined = await this.db.run(
                cds.ql.SELECT.one.from(TransactionResults).columns('ID', 'status').where({ transaction_ID: found.ID })
            );
            const failed: Pick<TransactionSegment, 'segmentId'>[] = result ? await this.db.run(
                cds.ql.SELECT.from(TransactionSegments).columns('segmentId').where({ transactionResult_ID: result.ID, success: false })
            ) : [];
            return {
                identifier,
                hash: found.hash,
                ledgerTxHash: found.ledgerTxHash ?? null,
                blockHeight: Number(found.blockHeight),
                blockHash: found.blockHash,
                status: result?.status ?? null,
                failedSegments: failed.map(s => Number(s.segmentId))
            };
        });

        this.on(Transaction.actions.byType, 'Transactions', async (req) => {
            const { txType, limit } = req.data;
            if (!txType) return req.reject(400, 'txType is required');

            const effectiveLimit = Math.min(Math.max(limit || 100, 1), 2000);
            return this.db.run(
                cds.ql.SELECT.from(Transactions)
                    .where({ txType })
                    .orderBy('createdAt desc')
                    .limit(effectiveLimit)
            );
        });

        this.on('READ', 'ContractActions', async (req) => {
            return await this.db.run(req.query) || [];
        });

        this.on(ContractAction.actions.byAddress, 'ContractActions', async (req) => {
            const { address } = req.data;
            if (!address) return req.reject(400, 'address is required');
            return this.db.run(
                cds.ql.SELECT.from(ContractActions).where({ address })
            );
        });

        this.on(ContractAction.actions.history, 'ContractActions', async (req) => {
            const { address } = req.data;
            if (!address) return req.reject(400, 'address is required');
            return this.db.run(
                cds.ql.SELECT.from(ContractActions)
                    .where({ address })
                    .orderBy('createdAt desc')
                    .limit(100)
            );
        });

        this.on('READ', 'ContractStates', async (req) => {
            return await this.db.run(req.query) || [];
        });

        this.on(ContractState.actions.stateAt, 'ContractStates', async (req) => {
            const { address, height } = req.data;
            if (!address || !/^(0x)?[0-9a-fA-F]+$/.test(address)) return req.reject(400, 'address (hex) is required');
            if (height != null && (!Number.isInteger(Number(height)) || Number(height) < 0)) {
                return req.reject(400, 'height must be a non-negative integer');
            }
            try {
                const snapshot = await contractStateAt(
                    this.db, address, height == null ? null : Number(height), fetchContractStateFromIndexers()
                );
                if (!snapshot) return req.reject(404, `no state known for contract ${address}`);
                return snapshot;
            } catch (err) {
                if (err instanceof IndexerBudgetExhausted) {
                    const limiter = stateAtIndexerLimiter();
                    return rejectRateLimited(req, {
                        name: 'indexer-budget', limit: limiter.maxRequests,
                        windowSeconds: limiter.windowMs / 1000, retryAfterMs: err.retryAfterMs
                    });
                }
                if (err instanceof IndexerBehind) {
                    // The cached answer predates the newest action. A retry must ask the indexer again.
                    stateAtCache.delete(`${err.address}:${err.height}`);
                    return req.reject(503, err.message);
                }
                return req.reject(502, `indexer could not serve the contract state: ${(err as Error).message}`);
            }
        });

        this.on('READ', 'UnshieldedUtxos', async (req) => {
            return await this.db.run(req.query) || [];
        });

        this.on(UnshieldedUtxo.actions.byOwner, 'UnshieldedUtxos', async (req) => {
            const { owner } = req.data;
            if (!owner) return req.reject(400, 'owner is required');
            return this.db.run(cds.ql.SELECT.from(UnshieldedUtxos).where({ owner }));
        });

        this.on('unspent', 'UnshieldedUtxos', async () => {
            return this.db.run(
                cds.ql.SELECT.from(UnshieldedUtxos).where({ spentAtTransaction_ID: null })
            );
        });

        this.on(NightBalance.actions.getBalance, 'NightBalances', async (req) => {
            const { address } = req.data;
            if (!address) return req.reject(400, 'address is required');
            return this.db.run(
                cds.ql.SELECT.one.from(NightBalances).where({ address })
            );
        });

        this.on(NightBalance.actions.getTopHolders, 'NightBalances', async (req) => {
            const { limit } = req.data;
            const effectiveLimit = Math.min(Math.max(limit || 10, 1), 1000);
            return this.db.run(
                cds.ql.SELECT.from(NightBalances)
                    .orderBy('balance desc')
                    .limit(effectiveLimit)
            );
        });

        registerWalletSessionHandlers(this, this.db);

        this.before('READ', 'WalletSessions', async (req) => {
            await awaitAgentPrincipal(req);
            const user = req.user;
            if (user?.is?.('admin')) return;
            const userId = user?.id;
            if (!userId) return req.reject(401, 'authentication required');
            (req.query as any).where({ userId });
        });

        registerAgentGrantHandlers(this, this.db);

        this.before('READ', 'AgentGrants', async (req) => {
            await awaitAgentPrincipal(req);
            const user = req.user;
            if (user?.is?.('admin')) return;
            const userId = user?.id;
            if (!userId) return req.reject(401, 'authentication required');
            (req.query as any).where({ userId });
        });

        for (const entity of ['Documents', 'GranteeIdentities'] as const) {
            this.before('READ', entity, async (req) => {
                await awaitAgentPrincipal(req);
                const user = req.user;
                if (user?.is?.('admin')) return;
                const userId = user?.id;
                if (!userId) return req.reject(401, 'authentication required');
                (req.query as any).where({ userId });
            });
        }

        this.on('READ', 'PendingSubmissions', async (req) => {
            const user = req.user;
            if (!user?.is?.('admin')) {
                const userId = user?.id;
                if (!userId) return req.reject(401, 'authentication required');
                const sessions: WalletSession[] = await this.db.run(
                    cds.ql.SELECT.from(WalletSessions).columns('sessionId').where({ userId })
                ) || [];
                const sessionIds = sessions.map(s => s.sessionId).filter(Boolean);
                if (sessionIds.length === 0) return [];
                (req.query as any).where({ sessionId: { in: sessionIds } });
            }
            return await this.db.run(req.query) || [];
        });

        registerSubmissionHandlers(this, this.db);
        registerDocumentProofHandlers(this);

        this.on(getJobStatus, async (req) => {
            const { jobId, sessionId, waitMs } = req.data;
            if (!jobId) return req.reject(400, 'jobId is required');
            if (!sessionId) return req.reject(400, 'sessionId is required');
            if (waitMs != null && !(Number.isInteger(waitMs) && waitMs >= 0 && waitMs <= LONG_POLL_MAX_MS)) {
                return req.reject(400, `waitMs must be an integer from 0 to ${LONG_POLL_MAX_MS}`);
            }

            let job = await readJob(jobId);
            if (!job || job.sessionId !== sessionId) {
                return req.reject(404, 'Job not found');
            }

            // 404 rather than 403, so callers cannot probe for other users' jobs.
            const user = req.user;
            if (!user?.is?.('admin')) {
                const requesterId = user?.id;
                if (job.requestedBy) {
                    if (!requesterId || job.requestedBy !== requesterId) {
                        return req.reject(404, 'Job not found');
                    }
                } else {
                    const sess: WalletSession | undefined = await cds.tx({}, (tx) =>
                        tx.run(cds.ql.SELECT.one.from(WalletSessions).columns('userId').where({ sessionId }))
                    );
                    if (!sess?.userId || !requesterId || sess.userId !== requesterId) {
                        return req.reject(404, 'Job not found');
                    }
                }
            }

            if (waitMs) {
                const found = job;
                job = await holdUntil(req, waitMs, jobWaiters, found, async () => (await readJob(jobId)) ?? found, j => JOB_SETTLED.has(String(j.status)));
            }
            const transactionHash = await explorerHashOf(this.db, job.txHash);

            return {
                jobId: job.ID,
                kind: job.kind,
                status: job.status,
                result: job.result,
                errorCode: job.errorCode,
                errorMessage: job.errorMessage,
                attempt: job.attempt,
                maxAttempts: job.maxAttempts,
                submissionId: job.submissionId,
                txHash: job.txHash,
                transactionId: job.txHash ?? null,
                transactionHash,
                chainStatus: job.chainStatus,
                chainFinalizedAt: job.chainFinalizedAt,
                chainBlockHeight: job.chainBlockHeight ?? null,
                chainBlockHash: job.chainBlockHash ?? null,
                chainSegments: job.chainSegments ?? null,
                queuedAt: job.queuedAt ?? job.createdAt,
                externalExecutionAt: job.externalExecutionAt,
                submittedAt: job.submittedAt,
                startedAt: job.startedAt,
                finishedAt: job.finishedAt,
                receipt: receiptForJob(job, transactionHash, String(resolveNightgateRuntimeConfig(getNightgatePluginConfig()).network))
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
