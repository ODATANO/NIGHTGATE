/**
 * NightgateAnalyticsService: count/average aggregates over indexed data.
 */

import cds from '@sap/cds';
const { SELECT } = cds.ql;

import { Transactions, ContractActions, Blocks } from '#cds-models/midnight';

export default class NightgateAnalyticsService extends cds.ApplicationService {
    private db!: cds.DatabaseService;

    async init(): Promise<void> {
        this.db = await cds.connect.to('db');

        this.on('getBlockCount', async () => {
            const result = await this.db.run(
                SELECT.one.from(Blocks).columns('count(*) as count')
            );
            return result?.count ?? 0;
        });

        this.on('getTransactionCount', async () => {
            const result = await this.db.run(
                SELECT.one.from(Transactions).columns('count(*) as count')
            );
            return result?.count ?? 0;
        });

        this.on('getContractCount', async () => {
            const result = await this.db.run(
                SELECT.one.from(ContractActions)
                    .columns('count(distinct address) as count')
            );
            return result?.count ?? 0;
        });

        this.on('getAverageTransactionsPerBlock', async () => {
            const blocks = await this.db.run(
                SELECT.one.from(Blocks).columns('count(*) as count')
            );
            const txs = await this.db.run(
                SELECT.one.from(Transactions).columns('count(*) as count')
            );

            const blockCount = blocks?.count ?? 0;
            if (blockCount === 0) return 0;
            return Math.round(((txs?.count ?? 0) / blockCount) * 100) / 100;
        });

        await super.init();
    }
}
