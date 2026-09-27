using { midnight } from '../db/schema';

@path: '/api/v1/analytics'
@requires: 'authenticated-user'
service NightgateAnalyticsService {

    /** One row per block; the transaction count is a subquery per returned row, so read by page. */
    @readonly
    @cds.query.limit: { default: 100, max: 1000 }
    entity BlockStatistics as select from midnight.Blocks as b {
        key b.ID,
        b.height,
        b.timestamp,
        (select count(*) from midnight.Transactions as t where t.block.ID = b.ID) as transactionCount : Integer
    };

    /** Contract action counts per action type (not per contract). */
    @readonly
    entity ContractStatistics as select from midnight.ContractActions {
        key actionType,
        count(ID) as actionCount : Integer
    } group by actionType;

    function getBlockCount() returns Integer;
    function getTransactionCount() returns Integer;
    function getContractCount() returns Integer;
    function getAverageTransactionsPerBlock() returns Decimal;
}
