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

export default class NightgateService extends cds.ApplicationService {
    private db!: any;
    private _cleanupTimer?: ReturnType<typeof setInterval>;

    async init(): Promise<void> {
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
        // Governance Handlers
        // ====================================================================

        this.on('READ', 'SystemParameters', async (req: Request) => {
            return await this.db.run(req.query) || [];
        });

        this.on('current', 'SystemParameters', async () => {
            return this.db.run(
                cds.ql.SELECT.one.from('midnight.SystemParameters')
                    .orderBy('validFrom desc')
            );
        });

        this.on('READ', 'DParameterHistory', async (req: Request) => {
            return this.db.run(req.query) || [];
        });

        this.on('READ', 'TermsAndConditionsHistory', async (req: Request) => {
            return this.db.run(req.query) || [];
        });

        // ====================================================================
        // DUST Generation Handlers
        // ====================================================================

        this.on('READ', 'DustGenerationStatus', async (req: Request) => {
            return await this.db.run(req.query) || [];
        });

        this.on('byCardanoAddress', 'DustGenerationStatus', async (req: Request) => {
            const { address } = req.data as { address: string };
            if (!address) return req.reject(400, 'address is required');
            return this.db.run(
                cds.ql.SELECT.one.from('midnight.DustGenerationStatus')
                    .where({ cardanoRewardAddress: address })
            );
        });

        this.on('byCardanoAddresses', 'DustGenerationStatus', async (req: Request) => {
            const { addresses } = req.data as { addresses: string[] };
            if (!addresses?.length) return [];
            return this.db.run(
                cds.ql.SELECT.from('midnight.DustGenerationStatus')
                    .where({ cardanoRewardAddress: { in: addresses } })
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

        this.on('byCardanoStakeKey', 'DustRegistrations', async (req: Request) => {
            const { stakeKey } = req.data as { stakeKey: string };
            if (!stakeKey) return req.reject(400, 'stakeKey is required');
            return this.db.run(
                cds.ql.SELECT.one.from('midnight.DustRegistrations')
                    .where({ cardanoStakeKey: stakeKey })
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
            'ZswapLedgerEvents', 'DustLedgerEvents', 'SystemParameters',
            'DParameterHistory', 'TermsAndConditionsHistory', 'DustGenerationStatus'
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
