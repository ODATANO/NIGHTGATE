using { midnight } from '../db/schema';

/**
 * Admin Service for system management
 */
@path: '/api/v1/admin'
@requires: 'admin'
service NightgateAdminService {

    entity WalletSessions as projection on midnight.WalletSessions excluding {
        encryptedViewingKey,    // Encrypted viewing key, never exposed via admin API
        encryptedSeedKey        // Encrypted signing seed, never exposed via admin API
    };

    entity DisclosureRoles as projection on midnight.DisclosureRoles;

    /**
     * Background jobs, read-only, for operators and monitoring.
     *
     * Until now the queue was only reachable through
     * `getJobStatus(jobId, sessionId)`, which needs an id the caller already
     * has, plus the aggregate gauges in `getMetrics()`. Neither answers the
     * question that actually matters when writes start failing: WHICH error is
     * piling up. A local deployment could read the SQLite file; a hosted one
     * could not.
     *
     * `command`, `request` and `result` are excluded: `command` is encrypted
     * at rest and the other two carry request and return payloads. Everything
     * left is workflow metadata plus the classified `errorCode` and the
     * user-facing `errorMessage`.
     *
     * DEPLOYMENT NOTE: CAP materialises a service projection as a SQL view, so
     * this entity does not exist on an already-deployed database until
     * `cds deploy` or `nightgate-schema-delta` has run. The API addition is
     * backwards compatible; the rollout is not code-only.
     */
    @readonly
    entity BackgroundJobs  as
        projection on midnight.BackgroundJobs
        excluding {
            command, // encrypted, replayable executable payload
            request, // inbound arguments
            result   // return payload
        };

    // Admin actions
    action invalidateSession(sessionId: UUID);
    action invalidateAllSessions();

    /**
     * Contracts known to this process (0.21.0): the config floor plus runtime
     * registrations. `artifactDigest` is the generation persisted commands are
     * pinned to; `hasProverKeys` false means the contract deploys and verifies
     * but cannot be proven here.
     */
    function listContracts() returns array of {
        name           : String;
        source         : String; // 'config' | 'runtime'
        artifactPath   : String;
        zkConfigPath   : String;
        privateStateId : String;
        slotWidth      : Integer;
        artifactDigest : String;
        hasProverKeys  : Boolean;
    };

    /**
     * Register a contract artifact at runtime (0.21.0). Paths must resolve
     * inside `NIGHTGATE_CONTRACTS_DIR`; the module must export a Compact
     * `Contract` class, the zk-config directory must hold verifier keys and
     * `zkir/`. Validated before anything changes, persisted in
     * `ContractRegistrations`, reloaded at boot. A config name is refused with
     * 409. Re-registering a runtime name under a new artifact is a new
     * generation; jobs recorded against the previous one refuse.
     */
    action registerContract(name: String,
                            artifactPath: String,
                            zkConfigPath: String,
                            privateStateId: String,
                            slotWidth: Integer // optional; 8 | 16 | 32, default 16
    ) returns {
        name           : String;
        source         : String;
        artifactPath   : String;
        zkConfigPath   : String;
        privateStateId : String;
        slotWidth      : Integer;
        artifactDigest : String;
        hasProverKeys  : Boolean;
    };

    /** Remove a runtime registration (memory + table). Config names refuse with 409. */
    action unregisterContract(name: String) returns {
        removed : Boolean;
    };

    /**
     * Job queue in one call: counts per status plus the error codes that are
     * piling up, over the last `windowHours` (default 24, max 720).
     *
     * The cheap read for a dashboard that wants the shape of the queue without
     * paging the whole BackgroundJobs entity. `topErrors` is what turns "many
     * jobs failed" into a diagnosis, e.g. a run of `1010/188` meaning batched
     * calls are crossing the guaranteed/fallible boundary.
     */
    /**
     * CPU profile of the wallet worker thread (0.21.4): samples the running
     * worker for `seconds` (1..120, default 20) with the in-thread V8 profiler
     * while it keeps serving, and returns where the time went (self time by
     * function and file, inclusive hot paths, idle/gc/wasm shares). The raw
     * .cpuprofile is written under `dir` (default: the OS temp dir,
     * `nightgate-profiles/`) for a DevTools deep dive; `file` names it.
     * Diagnostic for "the worker is busy and the log does not say why".
     */
    action profileWorker(seconds: Integer, dir: String, thread: String) returns {
        thread        : String; // 'worker' (default) or 'main' (the CAP process: requests, save pipeline, pollers)
        seconds       : Integer;
        file          : String;
        facadeCount   : Integer;
        sampledMs     : Integer;
        idlePercent   : Double;
        gcPercent     : Double;
        wasmPercent   : Double;
        topFunctions  : array of { label: String; percent: Double };
        topFiles      : array of { label: String; percent: Double };
        topInclusive  : array of { label: String; percent: Double };
        heapBefore    : { usedMb: Integer; totalMb: Integer; limitMb: Integer; externalMb: Integer; mallocedMb: Integer; rssMb: Integer; arrayBuffersMb: Integer };
        heapAfter     : { usedMb: Integer; totalMb: Integer; limitMb: Integer; externalMb: Integer; mallocedMb: Integer; rssMb: Integer; arrayBuffersMb: Integer };
        gc            : { count: Integer; totalMs: Integer; byKind: String }; // byKind: JSON { kind: { count, ms } }
    };

    function getJobStats(windowHours: Integer) returns {
        windowHours         : Integer;
        since               : Timestamp;
        total               : Integer;
        byStatus            : array of {
            status : String;
            count  : Integer;
        };
        topErrors           : array of {
            errorCode : String;
            count     : Integer;
        };
        oldestQueuedSeconds : Integer;
    };

    // Grant a disclosure tier to a user. Service-level @requires: 'admin'
    // gates the CAP-auth side; the handler additionally requires the caller's
    // own disclosureRole = 'authority' (defense in depth).
    action grantRole(
        userId:     String,
        role:       String,
        scope:      String,
        validUntil: Timestamp
    );
}
