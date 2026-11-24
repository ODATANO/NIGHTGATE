using { midnight } from '../db/schema';
using {
    BackgroundJobStatus, ContractSource, Hex64List, HexEncoded, HexList, PolicySource, UnshieldedAddr, WorkerThread
} from '../db/types';

@path: '/odata/v4/midnight-admin'
@requires: 'admin'
service NightgateAdminService {

    /** Read-only. Change sessions through the actions, which also drop the wallet from memory. */
    @readonly
    entity WalletSessions as projection on midnight.WalletSessions excluding {
        encryptedViewingKey,
        encryptedSeedKey
    };

    /** Background jobs without their payloads.
     * This is a database view. An existing database gets it only after `cds deploy` or `scripts/apply-schema-delta.mjs`. */
    @readonly
    entity BackgroundJobs  as
        projection on midnight.BackgroundJobs
        excluding {
            command,
            request,
            result
        };

    /** Shielded token types minted by sponsored calls on this server. */
    @readonly
    entity LearnedTokenTypes as projection on midnight.LearnedTokenTypes;

    /** All swap offers, including who posted them. Public reads hide the poster. */
    @readonly
    entity SwapOffers as projection on midnight.SwapOffers;

    /** Every agent grant with its lists as JSON text, its budgets and its counters. */
    @readonly
    entity AgentGrants as projection on midnight.AgentGrants excluding {
        tokenHash
    };

    /** One row per transaction this server sent. `finalized` once the server has indexed its block. Callers follow a send with getJobStatus. */
    @readonly
    entity PendingSubmissions as projection on midnight.PendingSubmissions excluding {
        submitIntentData
    };

    /** The crawler's state with the markers of its background passes. */
    @readonly
    entity SyncState as projection on midnight.SyncState;

    action invalidateSession(sessionId: UUID) returns {
        sessionId : UUID;
        isActive  : Boolean;
    };

    action invalidateAllSessions() returns {
        invalidated : Integer; // sessions that were active
    };

    /** Exports the key that may upgrade a contract, taken from the session that deployed it.
     * The export is encrypted with `password`, at least 16 characters. No action restores it.
     * Whoever holds this key can change how the contract verifies proofs. */
    action exportContractSigningKey(sessionId: UUID, contractAddress: HexEncoded, password: String) returns {
        format          : String;
        encryptedPayload: LargeString;
        salt            : String;
        contractAddress : HexEncoded;
        accountId       : String;
    };

    /** Lists the contracts from the config and those registered at runtime.
     * `artifactDigest` identifies the exact build. Saved jobs only run on that build.
     * When `hasProverKeys` is false, this server can deploy and verify but not create proofs. */
    function listContracts() returns array of {
        name           : String;
        source         : ContractSource;
        artifactPath   : String;
        zkConfigPath   : String;
        privateStateId : String;
        slotWidth      : Integer;
        artifactDigest : String;
        hasProverKeys  : Boolean;
    };

    /** Registers a compiled contract at runtime. It is checked first, saved, and loaded again on every start.
     * Both paths must lie inside `NIGHTGATE_CONTRACTS_DIR`. A name from the config answers 409.
     * Registering a new build under an existing name makes saved jobs for the old build fail. */
    action registerContract(name: String,
                            artifactPath: String,
                            zkConfigPath: String,
                            privateStateId: String,
                            slotWidth: Integer // optional; default 16; 16 or 32 document fields
    ) returns {
        name           : String;
        source         : ContractSource;
        artifactPath   : String;
        zkConfigPath   : String;
        privateStateId : String;
        slotWidth      : Integer;
        artifactDigest : String;
        hasProverKeys  : Boolean;
    };

    /** Removes a runtime registration. A name from the config answers 409. */
    action unregisterContract(name: String) returns {
        removed : Boolean;
    };

    /** Records a CPU profile of a running thread and summarizes where the time went.
     * `seconds` is 1 to 120, default 20. `thread` is 'worker', the default, or 'main'.
     * The .cpuprofile file goes to `nightgate-profiles/` in the OS temp folder, or to the subfolder `dir`. */
    action profileWorker(seconds: Integer, dir: String, thread: WorkerThread) returns {
        thread        : WorkerThread;
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
        gc            : { count: Integer; totalMs: Integer; byKind: Map }; // byKind: count and ms per GC kind
    };

    /** The circuits sponsored on one contract instead of `allowedCircuits`. */
    type ContractCircuitRule {
        contract    : String;
        allCircuits : Boolean;          // true = every circuit of the contract
        circuits    : array of String;  // empty when allCircuits
    };

    /** Shows what the fee sponsor may pay for. `floor` holds the platform lists.
     * With `grantId`, `effective` holds what the grant may use. `effectiveError` says why it may use nothing. */
    function getSponsorPolicy(grantId: UUID) returns {
        source         : PolicySource;
        path           : String;
        loadedAt       : Timestamp; // null = no policy file
        ignoredEnv     : array of String; // environment settings the policy file overrides
        floorError     : String;
        floor          : {
            allowedContracts   : HexList; // empty = any
            allowedCircuits    : array of String; // empty = any
            contractCircuits   : array of ContractCircuitRule;
            allowedTokenTypes  : Hex64List; // empty = none
            allowContractMints : Boolean;
            allowSwaps         : Boolean;
            allowTransfers     : Boolean;
            allowUnshieldedOffers       : Boolean;
            allowedUnshieldedTokenTypes : Hex64List; // empty = NIGHT only
        };
        grant          : {
            grantId           : UUID;
            isActive          : Boolean;
            allowedContracts  : HexList;
            allowedCircuits   : array of String;
            allowedTokenTypes : Hex64List;
            deployedContracts : HexList;
            mintedTokenTypes  : Hex64List;
            allowDeploy       : Boolean;
            allowMaintenance  : Boolean;
            allowSwaps        : Boolean;
            allowTransfers    : Boolean;
            allowUnshieldedOffers       : Boolean;
            allowedUnshieldedTokenTypes : Hex64List;
            maxDeploys        : Integer;
            deploysUsed       : Integer;
            maxMaintenanceUpdates  : Integer;
            maintenanceUpdatesUsed : Integer;
        };
        effective      : {
            allowedContracts   : HexList;
            allowedCircuits    : array of String;
            contractCircuits   : array of ContractCircuitRule;
            allowedTokenTypes  : Hex64List;
            ownContracts       : HexList;
            ownTokenTypes      : Hex64List;
            allowDeploy        : Boolean;
            allowMaintenance   : Boolean;
            maintainableContracts : HexList;
            allowContractMints : Boolean;
            allowSwaps         : Boolean;
            allowTransfers     : Boolean;
            allowUnshieldedOffers       : Boolean;
            allowedUnshieldedTokenTypes : Hex64List;
        };
        effectiveError : String;
    };

    /** Job counts per status and the most frequent error codes. `windowHours` defaults to 24, max 720. */
    function getJobStats(windowHours: Integer) returns {
        windowHours         : Integer;
        since               : Timestamp;
        total               : Integer;
        byStatus            : array of {
            status : BackgroundJobStatus;
            count  : Integer;
        };
        topErrors           : array of {
            errorCode : String;
            count     : Integer;
        };
        oldestQueuedSeconds : Integer;
    };

    /** Finds NightBalances rows that do not match the indexed UTXOs. Changes nothing.
     * Checks one `address`, or up to `limit` addresses after `after`. `limit` is at most 500. */
    function reconcileNightBalances(address: UnshieldedAddr, after: UnshieldedAddr, @assert.range: [1, 500] limit: Integer) returns {
        checked : Integer;
        next    : UnshieldedAddr; // null = done; pass as `after` for the next page
        drifted : array of {
            address  : UnshieldedAddr;
            field    : String; // column name, or 'row'
            stored   : String;
            computed : String;
        };
    };

    /** Decodes the stored transactions again from `height` up and rewrites the fields taken from them.
     * The decoder never moves forward this way. `changed` is false when it already stood below `height`. */
    action redecodeFromHeight(height: Integer64) returns {
        fromHeight            : Integer64;
        previousDecodedHeight : Integer64;
        blocks                : Integer64;
        changed               : Boolean;
    };
}
