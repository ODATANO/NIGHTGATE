/**
 * Nightgate Service Implementation, OData V4 API
 *
 * Thin service layer: all data comes from local SQLite (populated by Crawler).
 * OData queries run against the local DB. Wallet sessions are handled separately.
 *
 * Data flow: Midnight Node -> Crawler -> SQLite -> Nightgate OData V4
 */

import cds, { Request } from '@sap/cds';

import { registerWalletSessionHandlers, startSessionCleanup } from './sessions/wallet-sessions';
import { ensureNightgateModelLoaded } from './utils/cds-model';
import { registerSubmissionHandlers } from './submission/handlers';
import { getJobById } from './submission/background-jobs';

import { Blocks, Transactions, ContractActions, UnshieldedUtxos, NightBalances, WalletSessions } from '#cds-models/midnight';


export default class NightgateService extends cds.ApplicationService {
    private db!: cds.DatabaseService;
    private _cleanupTimer?: ReturnType<typeof setInterval>;

    async init(): Promise<void> {
        await ensureNightgateModelLoaded();
        this.db = await cds.connect.to('db');

        // ====================================================================
        // Block Handlers
        // ====================================================================

        this.on('READ', 'Blocks', async (req: Request) => {
            return await this.db.run(req.query) || [];
        });

        this.on('latest', 'Blocks', async () => {
            return this.db.run(
                cds.ql.SELECT.one.from(Blocks).orderBy('height desc')
            );
        });

        this.on('byHeight', 'Blocks', async (req: Request) => {
            const { height } = req.data as { height: number };
            if (height == null) return req.reject(400, 'height is required');
            return this.db.run(
                cds.ql.SELECT.one.from(Blocks).where({ height })
            );
        });

        this.on('range', 'Blocks', async (req: Request) => {
            const { startHeight, endHeight, limit } = req.data as {
                startHeight?: number;
                endHeight?: number;
                limit?: number;
            };

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
            // Use a tagged-template predicate for the range window. The object form
            // `{ height: { '>=': s, '<=': e } }` (two operators on one field) produces
            // CQN without the connective and is silently dropped by @cap-js/sqlite,
            // so the window would not filter at all.
            return this.db.run(
                cds.ql.SELECT.from(Blocks)
                    .where`height >= ${startHeight} and height <= ${endHeight}`
                    .orderBy('height asc')
                    .limit(effectiveLimit)
            );
        });

        // ====================================================================
        // Transaction Handlers
        // ====================================================================

        this.on('READ', 'Transactions', async (req: Request) => {
            return await this.db.run(req.query) || [];
        });

        this.on('byHash', 'Transactions', async (req: Request) => {
            const { hash } = req.data as { hash: string };
            if (!hash) return req.reject(400, 'hash is required');
            return this.db.run(cds.ql.SELECT.from(Transactions).where({ hash }));
        });

        this.on('byType', 'Transactions', async (req: Request) => {
            const { txType, limit } = req.data as { txType?: string; limit?: number };
            if (!txType) return req.reject(400, 'txType is required');

            const effectiveLimit = Math.min(Math.max(limit || 100, 1), 2000);
            return this.db.run(
                cds.ql.SELECT.from(Transactions)
                    .where({ txType })
                    .orderBy('createdAt desc')
                    .limit(effectiveLimit)
            );
        });

        // ====================================================================
        // Contract Handlers
        // ====================================================================

        this.on('READ', 'ContractActions', async (req: Request) => {
            return await this.db.run(req.query) || [];
        });

        this.on('byAddress', 'ContractActions', async (req: Request) => {
            const { address } = req.data as { address: string };
            if (!address) return req.reject(400, 'address is required');
            return this.db.run(
                cds.ql.SELECT.from(ContractActions).where({ address })
            );
        });

        this.on('history', 'ContractActions', async (req: Request) => {
            const { address } = req.data as { address: string };
            if (!address) return req.reject(400, 'address is required');
            return this.db.run(
                cds.ql.SELECT.from(ContractActions)
                    .where({ address })
                    .orderBy('createdAt desc')
                    .limit(100)
            );
        });

        // ====================================================================
        // UTXO Handlers
        // ====================================================================

        this.on('READ', 'UnshieldedUtxos', async (req: Request) => {
            return await this.db.run(req.query) || [];
        });

        this.on('byOwner', 'UnshieldedUtxos', async (req: Request) => {
            const { owner } = req.data as { owner: string };
            if (!owner) return req.reject(400, 'owner is required');
            return this.db.run(cds.ql.SELECT.from(UnshieldedUtxos).where({ owner }));
        });

        this.on('unspent', 'UnshieldedUtxos', async () => {
            return this.db.run(
                cds.ql.SELECT.from(UnshieldedUtxos).where({ spentAtTransaction_ID: null })
            );
        });

        // ====================================================================
        // Balance & Token Tracking Handlers
        // ====================================================================

        this.on('getBalance', 'NightBalances', async (req: Request) => {
            const { address } = req.data as { address: string };
            if (!address) return req.reject(400, 'address is required');
            return this.db.run(
                cds.ql.SELECT.one.from(NightBalances).where({ address })
            );
        });

        this.on('getTopHolders', 'NightBalances', async (req: Request) => {
            const { limit } = req.data as { limit?: number };
            const effectiveLimit = Math.min(Math.max(limit || 10, 1), 1000);
            return this.db.run(
                cds.ql.SELECT.from(NightBalances)
                    .orderBy('balance desc')
                    .limit(effectiveLimit)
            );
        });

        // ====================================================================
        // Wallet Sessions (delegated)
        // ====================================================================

        registerWalletSessionHandlers(this, this.db);

        // Raw entity READ surface is owner-scoped: sessions belong to the
        // principal that created them (review_001 P1); admins see everything.
        // The projection already excludes the encrypted keys, but session
        // metadata (sessionId is a correlation token) must not leak across
        // users either.
        this.before('READ', 'WalletSessions', (req: Request) => {
            const user: any = (req as any).user;
            if (user?.is?.('admin')) return;
            const userId = user?.id;
            if (!userId) return req.reject(401, 'authentication required');
            (req.query as any).where({ userId });
        });

        // ====================================================================
        // Submission actions: deployContract, submitContractCall
        // ====================================================================

        // Owner-scoped like WalletSessions: submissions carry no userId, so
        // the caller's sessions are resolved first and the read is limited to
        // those sessionIds. Admins read unfiltered.
        this.on('READ', 'PendingSubmissions', async (req: Request) => {
            const user: any = (req as any).user;
            if (!user?.is?.('admin')) {
                const userId = user?.id;
                if (!userId) return req.reject(401, 'authentication required');
                const sessions: any[] = await this.db.run(
                    cds.ql.SELECT.from(WalletSessions).columns('sessionId').where({ userId })
                ) || [];
                const sessionIds = sessions.map(s => s.sessionId).filter(Boolean);
                if (sessionIds.length === 0) return [];
                (req.query as any).where({ sessionId: { in: sessionIds } });
            }
            return await this.db.run(req.query) || [];
        });

        registerSubmissionHandlers(this, this.db);

        // ====================================================================
        // Background Jobs (0.2.0 async submission lifecycle)
        // ====================================================================

        this.on('getJobStatus', async (req: Request) => {
            const { jobId, sessionId } = req.data as { jobId?: string; sessionId?: string };
            if (!jobId) return req.reject(400, 'jobId is required');
            if (!sessionId) return req.reject(400, 'sessionId is required');

            const job = await getJobById(jobId);
            // 404 on foreign sessionId — same shape as not-found so a probe
            // for someone else's jobId can't distinguish "unknown" from
            // "exists but not yours".
            if (!job || job.sessionId !== sessionId) {
                return req.reject(404, 'Job not found');
            }

            // Ownership: the session that owns this job must belong to the
            // caller. Sessions are user-bound (review_001 P1) and are never
            // hard-deleted (disconnect/expiry flip isActive but keep the row +
            // userId), so a persisted mismatch is authoritative. Same 404 shape
            // to avoid leaking existence.
            const sess: any = await this.db.run(
                cds.ql.SELECT.one.from(WalletSessions).columns('userId').where({ sessionId })
            );
            const requesterId = (req as any).user?.id;
            if (sess?.userId && sess.userId !== requesterId) {
                return req.reject(404, 'Job not found');
            }

            return {
                jobId: job.ID,
                kind: job.kind,
                status: job.status,
                result: job.result,
                errorCode: job.errorCode,
                errorMessage: job.errorMessage,
                submittedAt: job.createdAt,
                startedAt: job.startedAt,
                finishedAt: job.finishedAt
            };
        });

        // ====================================================================
        // Read-only Enforcement
        // ====================================================================

        this.before(['CREATE', 'UPDATE', 'DELETE'], [
            'Blocks', 'Transactions', 'ContractActions', 'UnshieldedUtxos',
            'ZswapLedgerEvents', 'DustLedgerEvents',
            'NightBalances', 'WalletSessions', 'PendingSubmissions'
        ], (req: Request) => {
            req.reject?.(405, 'Blockchain data is read-only');
        });

        // Session cleanup timer
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
