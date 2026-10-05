import cds from '@sap/cds';

import { registerWalletSessionHandlers, startSessionCleanup } from './sessions/wallet-sessions';
import { attachAgentGrantEnforcement, registerAgentGrantHandlers, awaitAgentPrincipal } from './sessions/agent-grants';
import { ensureNightgateModelLoaded } from './utils/cds-model';
import { attachRuntimeGate } from './utils/runtime-gate';
import { registerSubmissionHandlers } from './submission/handlers';
import { registerDocumentProofHandlers } from './submission/document-proof';
import { getJobById } from './submission/background-jobs';
import { contractStateAt, type ContractStateFetcher } from './crawler/contract-state';
import { fetchContractState } from './crawler/indexer-supplement';
import { getNightgatePluginConfig, resolveNightgateRuntimeConfig } from './utils/nightgate-config';
import { RateLimiter } from './utils/rate-limiter';

// One limit for all callers: the public indexer blocks the host's IP when it gets too many requests.
const stateAtIndexerLimiter = new RateLimiter({ windowMs: 1000, maxRequests: 2 });

class IndexerBudgetExhausted extends Error {
    constructor(readonly retryAfterMs: number) { super('indexer request budget exhausted'); }
}

function fetchContractStateFromIndexers(): ContractStateFetcher {
    const { crawlerConfig, submissionEndpoints } = resolveNightgateRuntimeConfig(getNightgatePluginConfig());
    const urls = [...new Set([String(crawlerConfig.indexerUrl || ''), submissionEndpoints.indexerHttpUrl].filter(Boolean))];
    return async (address, height) => {
        const budget = stateAtIndexerLimiter.check('indexer');
        if (!budget.allowed) throw new IndexerBudgetExhausted(budget.retryAfterMs);
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
}

import { Blocks, Transactions, ContractActions, UnshieldedUtxos, NightBalances, WalletSessions, type WalletSession } from '#cds-models/midnight';
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
                    const seconds = Math.max(1, Math.ceil(err.retryAfterMs / 1000));
                    try { req.http?.res?.set?.('Retry-After', String(seconds)); } catch { /* header is a courtesy */ }
                    return req.reject(429, `Rate limited. Retry after ${seconds}s`);
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
            const { jobId, sessionId } = req.data;
            if (!jobId) return req.reject(400, 'jobId is required');
            if (!sessionId) return req.reject(400, 'sessionId is required');

            const job = await getJobById(jobId);
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
                    const sess: WalletSession | undefined = await this.db.run(
                        cds.ql.SELECT.one.from(WalletSessions).columns('userId').where({ sessionId })
                    );
                    if (!sess?.userId || !requesterId || sess.userId !== requesterId) {
                        return req.reject(404, 'Job not found');
                    }
                }
            }

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
                chainStatus: job.chainStatus,
                chainFinalizedAt: job.chainFinalizedAt,
                chainBlockHeight: job.chainBlockHeight ?? null,
                chainBlockHash: job.chainBlockHash ?? null,
                chainSegments: job.chainSegments ?? null,
                queuedAt: job.queuedAt ?? job.createdAt,
                externalExecutionAt: job.externalExecutionAt,
                submittedAt: job.submittedAt,
                startedAt: job.startedAt,
                finishedAt: job.finishedAt
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
