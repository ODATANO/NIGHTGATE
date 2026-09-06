using { midnight } from '../db/schema';

/**
 * Analytics Service for aggregated blockchain data
 */
@path: '/api/v1/analytics'
@requires: 'authenticated-user'
service NightgateAnalyticsService {

    /**
     * Block statistics view
     */
    @readonly
    entity BlockStatistics as select from midnight.Blocks {
        key ID,
        height,
        timestamp,
        count(transactions.ID) as transactionCount : Integer
    } group by ID, height, timestamp;

    /**
     * Contract action counts per action type. Addresses are not decoded from
     * the ledger payload yet, so the statistics are per type, not per contract.
     */
    @readonly
    entity ContractStatistics as select from midnight.ContractActions {
        key actionType,
        count(ID) as actionCount : Integer
    } group by actionType;

    // Aggregation functions
    function getBlockCount() returns Integer;
    function getTransactionCount() returns Integer;
    function getContractCount() returns Integer;
    function getAverageTransactionsPerBlock() returns Decimal;
}
