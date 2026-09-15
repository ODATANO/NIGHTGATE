using { midnight } from '../db/schema';

@path: '/api/v1/analytics'
@requires: 'authenticated-user'
service NightgateAnalyticsService {

    @readonly
    entity BlockStatistics as select from midnight.Blocks {
        key ID,
        height,
        timestamp,
        count(transactions.ID) as transactionCount : Integer
    } group by ID, height, timestamp;

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
