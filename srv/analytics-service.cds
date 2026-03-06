using { midnight } from '../db/schema';

/**
 * Analytics Service for aggregated blockchain data
 */
@path: '/api/v1/analytics'
// @requires: 'authenticated-user'  // Uncomment for production
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
     * Contract deployment statistics
     */
    @readonly
    entity ContractStatistics as select from midnight.ContractActions {
        key address,
        actionType,
        count(ID) as actionCount : Integer
    } where actionType = 'DEPLOY' group by address, actionType;

    // Aggregation functions
    function getBlockCount() returns Integer;
    function getTransactionCount() returns Integer;
    function getContractCount() returns Integer;
    function getAverageTransactionsPerBlock() returns Decimal;
}
