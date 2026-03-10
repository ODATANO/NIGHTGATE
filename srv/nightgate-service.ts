/**
 * Nightgate Service Implementation — OData V4 API
 *
 * Thin service layer: all data comes from local SQLite (populated by Crawler).
 * OData queries run against the local DB. Wallet sessions are handled separately.
 *
 * Data flow: Midnight Node -> Crawler -> SQLite -> Nightgate OData V4
 */

import cds, { Request } from '@sap/cds';

import { registerWalletSessionHandlers, startSessionCleanup } from './sessions/wallet-sessions';
import { ensureNightgateModelLoaded } from './utils/cds-model';

export default class NightgateService extends cds.ApplicationService {
    private db!: any;
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
                cds.ql.SELECT.one.from('midnight.Blocks').orderBy('height desc')
            );
        });

        this.on('byHeight', 'Blocks', async (req: Request) => {
            const { height } = req.data as { height: number };
            if (height == null) return req.reject(400, 'height is required');
            return this.db.run(
                cds.ql.SELECT.one.from('midnight.Blocks').where({ height })
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
            return this.db.run(
                cds.ql.SELECT.from('midnight.Blocks')
                    .where({ height: { '>=': startHeight, '<=': endHeight } })
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
            return this.db.run(cds.ql.SELECT.from('midnight.Transactions').where({ hash }));
        });

        this.on('byType', 'Transactions', async (req: Request) => {
            const { txType, limit } = req.data as { txType?: string; limit?: number };
            if (!txType) return req.reject(400, 'txType is required');

            const effectiveLimit = Math.min(Math.max(limit || 100, 1), 2000);
            return this.db.run(
                cds.ql.SELECT.from('midnight.Transactions')
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
                cds.ql.SELECT.from('midnight.ContractActions').where({ address })
            );
        });

        this.on('history', 'ContractActions', async (req: Request) => {
            const { address } = req.data as { address: string };
            if (!address) return req.reject(400, 'address is required');
            return this.db.run(
                cds.ql.SELECT.from('midnight.ContractActions')
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
            return this.db.run(cds.ql.SELECT.from('midnight.UnshieldedUtxos').where({ owner }));
        });

        this.on('unspent', 'UnshieldedUtxos', async () => {
            return this.db.run(
                cds.ql.SELECT.from('midnight.UnshieldedUtxos').where({ spentAtTransaction_ID: null })
            );
        });

        // ====================================================================
        // Balance & Token Tracking Handlers
        // ====================================================================

        this.on('getBalance', 'NightBalances', async (req: Request) => {
            const { address } = req.data as { address: string };
            if (!address) return req.reject(400, 'address is required');
            return this.db.run(
                cds.ql.SELECT.one.from('midnight.NightBalances').where({ address })
            );
        });

        this.on('getTopHolders', 'NightBalances', async (req: Request) => {
            const { limit } = req.data as { limit?: number };
            const effectiveLimit = Math.min(Math.max(limit || 10, 1), 1000);
            return this.db.run(
                cds.ql.SELECT.from('midnight.NightBalances')
                    .orderBy('balance desc')
                    .limit(effectiveLimit)
            );
        });

        // ====================================================================
        // Wallet Sessions (delegated)
        // ====================================================================

        registerWalletSessionHandlers(this, this.db);

        // ====================================================================
        // Read-only Enforcement
        // ====================================================================

        this.before(['CREATE', 'UPDATE', 'DELETE'], [
            'Blocks', 'Transactions', 'ContractActions', 'UnshieldedUtxos',
            'ZswapLedgerEvents', 'DustLedgerEvents',
            'NightBalances', 'WalletSessions'
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
