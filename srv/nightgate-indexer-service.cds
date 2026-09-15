using {midnight} from '../db/schema';

/** Indexer sync state, health, probes and reorg history. */
@path: '/api/v1/indexer'
service NightgateIndexerService {

    @readonly
    entity SyncState as projection on midnight.SyncState;

    @readonly
    entity ReorgLog  as projection on midnight.ReorgLog;

    function getSyncStatus()                      returns SyncState;

    function getHealth()                          returns {
        status          : String;
        chainHeight     : Integer64;
        indexedHeight   : Integer64;
        finalizedHeight : Integer64;
        lag             : Integer64;
        finalizedLag    : Integer64;
        blocksPerSecond : Decimal(10, 2);
        syncStatus      : String;
        instanceId      : String;
        runtimeMode     : String;
        replicaCount    : Integer;
        databaseKind    : String;
        topologyValid   : Boolean;
        runtimeWarnings : array of String;
    };

    function getReorgHistory(limit: Integer)      returns array of ReorgLog;

    // Liveness: 200 while the process is alive
    function getLiveness()                        returns {
        status     : String;
        timestamp  : Timestamp;
        uptime     : Integer;
        instanceId : String;
    };

    // Readiness: 200 only when all subsystems are ready
    function getReadiness()                       returns {
        ready              : Boolean;
        crawlerEnabled     : Boolean;
        checks             : {
            database       : Boolean;
            crawler        : Boolean;
            node           : Boolean;
            runtime        : Boolean;
            initialization : Boolean;
        };
        initializationMode : String;
        instanceId         : String;
        runtimeMode        : String;
        replicaCount       : Integer;
        databaseKind       : String;
        runtimeWarnings    : array of String;
    };

    // Prometheus text format
    function getMetrics()                         returns String;


    @requires: 'authenticated-user'
    function getRuntimeInfo()                     returns {
        version      : String;
        apiVersion   : String;
        network      : String;
        provingMode  : String; // wasm | server
        instanceId   : String;
        runtimeMode  : String;
        databaseKind : String;
        uptime       : Integer;
        contracts    : array of {
            name           : String;
            artifactDigest : String;
            currentDigest  : String;
            digestStale    : Boolean;
            digestError    : String;
            slotWidth      : Integer;
            privateStateId : String;
        };
    };

    // Process-level wallet worker health (per session: getWalletSyncProgress)
    @requires: 'authenticated-user'
    function getWorkerStatus()                    returns {
        started       : Boolean;
        running       : Boolean;
        inFlightRpcs  : Integer;
        exitCount     : Integer;
        rotationCount : Integer;
        lastExitCode  : Integer;
        lastExitAt    : Timestamp;
        rpcTimeoutMs  : Integer;
        facadeCount   : Integer;
        facades       : array of {
            sessionId : String;
            label     : String;
            caughtUp  : Boolean;
            updatedAt : Timestamp;
        };
    };

    @requires: 'admin'
    action   pauseCrawler()                       returns {
        status  : String;
        running : Boolean;
        message : String;
    };

    @requires: 'admin'
    action   resumeCrawler()                      returns {
        status  : String;
        running : Boolean;
        message : String;
    };

    // Roll back indexed data from `height`, then resume the crawler if it was running
    @requires: 'admin'
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

annotate NightgateIndexerService.SyncState with @(Capabilities: {
    InsertRestrictions: {Insertable: false},
    DeleteRestrictions: {Deletable: false}
}) {
    syncStatus        @title: 'Sync Status';
    lastIndexedHeight @title: 'Last Indexed Height';
};
