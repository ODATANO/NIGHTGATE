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
        instanceId      : String;
        runtimeMode     : String;
        replicaCount    : Integer;
        databaseKind    : String;
        topologyValid   : Boolean;
        runtimeWarnings : array of String;
    };

    // Get reorg history
    function getReorgHistory(limit: Integer)      returns array of ReorgLog;

    // K8s liveness probe, returns 200 if process is alive
    function getLiveness()                        returns {
        status    : String;
        timestamp : Timestamp;
        uptime    : Integer;
        instanceId : String;
    };

    // K8s readiness probe, returns 200 only if subsystems are ready
    function getReadiness()                       returns {
        ready          : Boolean;
        // false = crawler deliberately disabled; its checks pass as
        // not-applicable and the deployment is submission/verification-only.
        crawlerEnabled : Boolean;
        checks : {
            database : Boolean;
            crawler  : Boolean;
            node     : Boolean;
            runtime  : Boolean;
            // 0.20.0: true only once initialize() has COMPLETED. The mode
            // alone is not enough: a successful crawler-less start publishes
            // 'idle', and so do the startup phase, SKIP_AUTO_INIT, a host that
            // never started the plugin, and the state after shutdown(). None
            // of those can serve. Without this check such a process still
            // answered ready whenever the crawler was disabled, because a
            // plain SELECT on the old SyncState table succeeded.
            initialization : Boolean;
        };
        // 'active' | 'idle' | 'offline' | 'unknown', so a not-ready answer
        // says why without anyone reading logs. The accompanying
        // runtimeWarnings entry is a stable, SANITISED reason: this payload
        // is reachable anonymously when an operator opts into public status
        // routes, and the raw startup error carries paths and SQL.
        initializationMode : String;
        instanceId      : String;
        runtimeMode     : String;
        replicaCount    : Integer;
        databaseKind    : String;
        runtimeWarnings : array of String;
    };

    // Prometheus-compatible metrics endpoint.
    //
    // NOTE: over OData this body arrives wrapped in `{"value": "..."}`, which
    // no scraper understands. The same text is served verbatim as text/plain
    // at `GET /nightgate/metrics`; use that one for Prometheus. Likewise
    // `GET /nightgate/health` and `/nightgate/ready` mirror
    // getHealth/getReadiness for probes that cannot spell an OData function
    // call.
    //
    // Those routes mount before CAP's auth middlewares, so they are NOT
    // covered by whatever protects this service, and they are fail-closed:
    // nothing is served until NIGHTGATE_STATUS_TOKEN (bearer) or an explicit
    // NIGHTGATE_STATUS_ROUTES=public is set. The prefix keeps them off the
    // host's generic paths and is configurable via
    // NIGHTGATE_STATUS_ROUTES_PREFIX; NIGHTGATE_STATUS_ROUTES=off disables.
    function getMetrics()                         returns String;

    /**
     * What this process IS: version, network, proving mode, and the artifact
     * generation digest of every registered contract.
     *
     * The digest is the point. `assertArtifactGeneration` refuses every
     * persisted command whose recorded digest no longer matches the loaded
     * artifact, so recompiling contract artifacts under a running server
     * blocks EVERY write job (including fresh deploys) until it restarts.
     * Reading this shows that mismatch instead of leaving it as an unexplained
     * wall of failing jobs. `artifactDigest` is null with `digestError` set
     * when a contract's artifact does not load at all.
     *
     * Authenticated: digests and topology are operator information, not
     * public, unlike the open health/readiness surface next to it.
     */
    @requires: 'authenticated-user'
    function getRuntimeInfo()                     returns {
        version       : String;
        network       : String;
        provingMode   : String; // wasm | server
        instanceId    : String;
        runtimeMode   : String;
        databaseKind  : String;
        uptime        : Integer;
        contracts     : array of {
            name           : String;
            // What this PROCESS loaded and stamped onto persisted commands.
            artifactDigest : String;
            // What the files on disk hash to RIGHT NOW, which is what
            // resolveContract compares against. Memoised behind a per-file
            // stat fingerprint plus a max age
            // (NIGHTGATE_ARTIFACT_DIGEST_MAX_AGE_MS), so it stays current
            // without re-hashing the artifacts on every request; only
            // resolveContract itself re-hashes with no cache in the way.
            currentDigest  : String;
            // true = the two disagree: artifacts were replaced under the
            // running process and every write job fails the generation guard
            // until it restarts. Reporting only the cached digest would hide
            // exactly the failure this function exists to explain.
            digestStale    : Boolean;
            digestError    : String;
            slotWidth      : Integer;
            privateStateId : String;
        };
    };

    /**
     * Wallet worker health at PROCESS level, as opposed to
     * `getWalletSyncProgress(sessionId)`, which answers per facade.
     *
     * Deliberately its own function and NOT a fifth entry in
     * `getReadiness().checks`: `ready` is an AND over those checks, so a
     * worker that is merely busy would take the process out of rotation.
     * Making a signal visible and making it load-bearing are two separate
     * decisions, and this is only the first one.
     *
     * `exitCount` climbing is the signal that the submission side is
     * crash-looping; `inFlightRpcs` that only grows is a stall.
     */
    @requires: 'authenticated-user'
    function getWorkerStatus()                    returns {
        started      : Boolean;
        running      : Boolean;
        inFlightRpcs : Integer;
        exitCount    : Integer;
        lastExitCode : Integer;
        lastExitAt   : Timestamp;
        rpcTimeoutMs : Integer;
        facadeCount  : Integer;
        // ADMIN ONLY, empty for everyone else. `sessionId` here is the wallet
        // cacheKey, an accountId derived from wallet material and stable
        // across sessions, so the list would tell any authenticated caller
        // which wallets this process holds, across tenants. The count carries
        // the operational signal without the identifiers.
        facades      : array of {
            sessionId : String;
            label     : String;
            caughtUp  : Boolean;
            updatedAt : Timestamp;
        };
    };

    // Pause crawler execution without stopping the service process.
    // Operational action: admin only (read-only status/health stays open
    // for K8s probes and Prometheus scraping).
    @requires: 'admin'
    action   pauseCrawler()                       returns {
        status  : String;
        running : Boolean;
        message : String;
    };

    // Resume crawler execution using configured node/crawler settings
    @requires: 'admin'
    action   resumeCrawler()                      returns {
        status  : String;
        running : Boolean;
        message : String;
    };

    // Roll back indexed data from a specific height and optionally resume crawling
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
