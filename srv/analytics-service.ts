/**
 * NightgateAnalyticsService — Aggregated Blockchain Statistics
 *
 * Provides count and average functions over indexed blockchain data.
 * Entity views (BlockStatistics, ContractStatistics) are handled by CDS automatically.
 */

import cds from '@sap/cds';
const { SELECT } = cds.ql;

export default class NightgateAnalyticsService extends cds.ApplicationService {
    private db!: any;

    async init(): Promise<void> {
        this.db = await cds.connect.to('db');

        this.on('getBlockCount', async () => {
            const result = await this.db.run(
                SELECT.one.from('midnight.Blocks').columns('count(*) as count')
            );
            return result?.count ?? 0;
        });

        this.on('getTransactionCount', async () => {
            const result = await this.db.run(
                SELECT.one.from('midnight.Transactions').columns('count(*) as count')
            );
            return result?.count ?? 0;
        });

        this.on('getContractCount', async () => {
            const result = await this.db.run(
                SELECT.one.from('midnight.ContractActions')
                    .columns('count(distinct address) as count')
            );
            return result?.count ?? 0;
        });

        this.on('getAverageTransactionsPerBlock', async () => {
            const blocks = await this.db.run(
                SELECT.one.from('midnight.Blocks').columns('count(*) as count')
            );
            const txs = await this.db.run(
                SELECT.one.from('midnight.Transactions').columns('count(*) as count')
            );

            const blockCount = blocks?.count ?? 0;
            if (blockCount === 0) return 0;
            return Math.round(((txs?.count ?? 0) / blockCount) * 100) / 100;
        });

        await super.init();
    }
}
