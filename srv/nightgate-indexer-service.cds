using {midnight} from '../db/schema';

/** Sync state, health checks and reorg history of the block indexer. Each element sets its own access rule.
 * getLiveness, getReadiness, getMetrics, getSyncStatus, getHealth, getBoardStatus and getReceiptKey are public, so health checks need no credentials.
 * Everything else needs a signed-in user or an admin. */
@path    : '/odata/v4/midnight-indexer'
@requires: 'any'
service NightgateIndexerService {

    @readonly
    @requires: 'authenticated-user'
    entity SyncState as projection on midnight.SyncState;

    @readonly
    @requires: 'authenticated-user'
    entity ReorgLog  as projection on midnight.ReorgLog;

    // Public probe. Holds no secrets and no per-user data.
    @requires: 'any'
    function getSyncStatus()                      returns SyncState;

    // Public probe. Holds no secrets and no per-user data.
    @requires: 'any'
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

    @requires: 'authenticated-user'
    function getReorgHistory(limit: Integer)      returns array of ReorgLog;

    // Public probe. Answers 200 while the process runs. Does not touch the database.
    @requires: 'any'
    function getLiveness()                        returns {
        status     : String;
        timestamp  : Timestamp;
        uptime     : Integer;
        instanceId : String;
    };

    // Public probe. `ready` is true when every check passes, and while the server is still warming its sponsor wallets.
    @requires: 'any'
    function getReadiness()                       returns {
        ready              : Boolean;
        phase              : String; // starting | warming | catching-up | ready | degraded | failed
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

    // Public probe. Prometheus text format.
    @requires: 'any'
    function getMetrics()                         returns String;

    // Public. Counts for the swap offer board, without ids or amounts.
    // The figures are recomputed at most every 10 seconds.
    @requires: 'any'
    function getBoardStatus()                     returns {
        openOffers         : Integer;
        offersFilledToday  : Integer; // per UTC day
        swapsToday         : Integer; // per UTC day; sponsored swaps that succeeded on chain
        sponsorsConfigured : Integer;
        sponsorsReady      : Integer; // synced and holding DUST to pay a fee
        factoryContract    : String; // hex; the token factory mintFactoryToken uses without a contractAddress; null = none set
        version            : String; // the running NIGHTGATE version
        asOf               : Timestamp;
    };

    // Public. The key that signs job receipts, so a third party can check a receipt without reading the board.
    @requires: 'any'
    function getReceiptKey()                      returns {
        publicKey : String; // hex; Ed25519
        algorithm : String; // ed25519
    };


    @requires: 'authenticated-user'
    function getRuntimeInfo()                     returns {
        version      : String;
        apiVersion   : String;
        network      : String;
        provingMode  : String; // 'wasm' or 'server'
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
            package        : String;
            version        : String;
            slotWidth      : Integer;
            privateStateId : String;
        };
    };

    // Health of the thread that runs the wallets. For one session use getWalletSyncProgress.
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

    // Deletes indexed data from `height` up. Resumes the indexer if it was running, so it indexes those blocks again.
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
