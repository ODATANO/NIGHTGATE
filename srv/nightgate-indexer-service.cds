using {midnight} from '../db/schema';

/**
 * Indexer sync state, health, probes and reorg history.
 *
 * Auth layout: the SERVICE is `@requires: 'any'` and every element carries its
 * own requirement. CAP authorizes the service before the operation
 * (`authorize` in @sap/cds lib/srv/protocols/http.js): a service without a
 * service-level `@requires` is implicitly `authenticated-user` under
 * NODE_ENV=production, so an anonymous caller got the 401 challenge before
 * getLiveness() was ever looked at (seen live on 0.24.1 behind ODATANO ACCESS:
 * the gateway's credential-free probe answered 401 and had to fall back to
 * operator auth). Opening the service and restricting each element keeps
 * every other operation exactly as guarded as before; the read-only probes
 * (getLiveness, getReadiness, getMetrics, getSyncStatus, getHealth) are public, the
 * way the model always intended them for K8s and Prometheus, the same layout as
 * NightgateVerifyService.
 */
@path    : '/api/v1/indexer'
@requires: 'any'
service NightgateIndexerService {

    @readonly
    @requires: 'authenticated-user'
    entity SyncState as projection on midnight.SyncState;

    @readonly
    @requires: 'authenticated-user'
    entity ReorgLog  as projection on midnight.ReorgLog;

    // Read-only probe, public on purpose (K8s, Prometheus, the ACCESS gateway):
    // no secrets, no per-session data. Behind api.nightgate.dev the gateway still
    // wants a key for /api/v1/indexer/*; direct exposure is the box network only.
    @requires: 'any'
    function getSyncStatus()                      returns SyncState;

    // Read-only probe, public on purpose (K8s, Prometheus, the ACCESS gateway):
    // no secrets, no per-session data. Behind api.nightgate.dev the gateway still
    // wants a key for /api/v1/indexer/*; direct exposure is the box network only.
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

    // Liveness: 200 while the process is alive. Anonymous on purpose: a probe
    // carries no credentials (Docker HEALTHCHECK, ODATANO ACCESS upstream
    // health). Process facts only, no DB, no secrets; readiness stays guarded.
    @requires: 'any'
    function getLiveness()                        returns {
        status     : String;
        timestamp  : Timestamp;
        uptime     : Integer;
        instanceId : String;
    };

    // Readiness: 200 only when all subsystems are ready. Public like the other probes.
    @requires: 'any'
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

    // Prometheus text format. Public like the other probes.
    @requires: 'any'
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
