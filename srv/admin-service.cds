using { midnight } from '../db/schema';

@path: '/api/v1/admin'
@requires: 'admin'
service NightgateAdminService {

    /** Writes only through actions (a generic PATCH/DELETE would skip facade eviction). */
    @readonly
    entity WalletSessions as projection on midnight.WalletSessions excluding {
        encryptedViewingKey,
        encryptedSeedKey
    };

    /** Read-only: roles change only through grantRole / revokeRole (authority-gated). */
    @readonly
    entity DisclosureRoles as projection on midnight.DisclosureRoles;

    /**
     * Job workflow metadata without payloads. A SQL view: on an existing
     * database it appears only after `cds deploy` or `nightgate-schema-delta`.
     */
    @readonly
    entity BackgroundJobs  as
        projection on midnight.BackgroundJobs
        excluding {
            command, // encrypted at rest
            request,
            result
        };

    action invalidateSession(sessionId: UUID);
    action invalidateAllSessions();

    /**
     * Export a contract's maintenance signing key from its deploying session,
     * sealed under `password` (16+ chars); restore with `importSigningKeys`.
     * Whoever holds it can replace the contract's verifier keys.
     */
    action exportContractSigningKey(sessionId: UUID, contractAddress: String, password: String) returns {
        format          : String;
        encryptedPayload: LargeString;
        salt            : String;
        contractAddress : String;
        accountId       : String;
    };

    /**
     * Config and runtime-registered contracts. `artifactDigest` pins persisted
     * jobs; `hasProverKeys` false = deploy/verify only, no proving here.
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
     * Register a contract artifact at runtime; paths must lie inside
     * `NIGHTGATE_CONTRACTS_DIR`. Validated first, persisted, reloaded at boot.
     * Config names: 409. A new artifact under the same name is a new
     * generation; jobs pinned to the old one refuse.
     */
    action registerContract(name: String,
                            artifactPath: String,
                            zkConfigPath: String,
                            privateStateId: String,
                            slotWidth: Integer // optional; 16 | 32, default 16
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
     * CPU-profile a live thread for `seconds` (1..120, default 20) and summarize
     * where time went. The .cpuprofile is written under `dir` (default OS temp
     * `nightgate-profiles/`); `file` names it.
     */
    action profileWorker(seconds: Integer, dir: String, thread: String) returns {
        thread        : String; // 'worker' (default) | 'main'
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

    /** Job counts per status and top error codes over `windowHours` (default 24, max 720). */
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

    // Grant a disclosure tier; the caller also needs disclosureRole 'authority'.
    action grantRole(
        userId:     String,
        role:       String,
        scope:      String,
        validUntil: Timestamp
    );
}
