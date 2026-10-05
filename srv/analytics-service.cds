using { midnight } from '../db/schema';

@path: '/api/v1/analytics'
@requires: 'authenticated-user'
service NightgateAnalyticsService {

    /** One row per block with its transaction count. Each row costs a count query, so read page by page. */
    @readonly
    @cds.query.limit: { default: 100, max: 1000 }
    entity BlockStatistics as select from midnight.Blocks as b {
        key b.ID,
        b.height,
        b.timestamp,
        (select count(*) from midnight.Transactions as t where t.block.ID = b.ID) as transactionCount : Integer
    };

    /** Number of contract actions per action type, over all contracts. */
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
