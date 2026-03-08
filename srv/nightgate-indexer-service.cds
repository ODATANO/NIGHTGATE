using {midnight} from '../db/schema';

/**
 * Nightgate Indexer Status & Health Service
 *
 * Exposes sync state, health metrics, and reorg history for the indexer.
 */
@path: '/api/v1/indexer'
service NightgateIndexerService {

    @readonly
    entity SyncState as projection on midnight.SyncState;

    @readonly
    entity ReorgLog  as projection on midnight.ReorgLog;

    // Get current sync status (singleton)
    function getSyncStatus()                      returns SyncState;

    // Get indexer health metrics
    function getHealth()                          returns {
        status          : String;
        chainHeight     : Integer64;
        indexedHeight   : Integer64;
        finalizedHeight : Integer64;
        lag             : Integer64;
        finalizedLag    : Integer64;
        blocksPerSecond : Decimal(10, 2);
        syncStatus      : String;
    };

    // Get reorg history
    function getReorgHistory(limit: Integer)      returns array of ReorgLog;

    // K8s liveness probe — returns 200 if process is alive
    function getLiveness()                        returns {
        status    : String;
        timestamp : Timestamp;
        uptime    : Integer;
    };

    // K8s readiness probe — returns 200 only if subsystems are ready
    function getReadiness()                       returns {
        ready  : Boolean;
        checks : {
            database : Boolean;
            crawler  : Boolean;
            node     : Boolean;
        };
    };

    // Prometheus-compatible metrics endpoint
    function getMetrics()                         returns String;

    // Pause crawler execution without stopping the service process
    action   pauseCrawler()                       returns {
        status  : String;
        running : Boolean;
        message : String;
    };

    // Resume crawler execution using configured node/crawler settings
    action   resumeCrawler()                      returns {
        status  : String;
        running : Boolean;
        message : String;
    };

    // Roll back indexed data from a specific height and optionally resume crawling
    action   reindexFromHeight(height: Integer64) returns {
        status                 : String;
        message                : String;
        requestedHeight        : Integer64;
        effectiveStartHeight   : Integer64;
        blocksRolledBack       : Integer;
        transactionsRolledBack : Integer;
        crawlerResumed         : Boolean;
    };
}

// ============================================================================
// Service-Level Annotations
// ============================================================================

annotate NightgateIndexerService.SyncState with @(Capabilities: {
    InsertRestrictions: {Insertable: false},
    DeleteRestrictions: {Deletable: false}
}) {
    syncStatus        @title: 'Sync Status';
    lastIndexedHeight @title: 'Last Indexed Height';
};
