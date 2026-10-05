using { midnight } from '../db/schema';

@path: '/api/v1/admin'
@requires: 'admin'
service NightgateAdminService {

    /** Read-only. Change sessions through the actions, which also drop the wallet from memory. */
    @readonly
    entity WalletSessions as projection on midnight.WalletSessions excluding {
        encryptedViewingKey,
        encryptedSeedKey
    };

    /** Read-only. Roles change through grantRole and revokeRole. A role ends at `validUntil`. */
    @readonly
    entity DisclosureRoles as projection on midnight.DisclosureRoles;

    /**
     * Background jobs without their payloads.
     * This is a database view. An existing database gets it only after `cds deploy` or `nightgate-schema-delta`.
     */
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

    action invalidateSession(sessionId: UUID);
    action invalidateAllSessions();

    /**
     * Exports the key that may upgrade a contract, taken from the session that deployed it.
     * The export is encrypted with `password`, at least 16 characters. Restore it with `importSigningKeys`.
     * Whoever holds this key can change how the contract verifies proofs.
     */
    action exportContractSigningKey(sessionId: UUID, contractAddress: String, password: String) returns {
        format          : String;
        encryptedPayload: LargeString;
        salt            : String;
        contractAddress : String;
        accountId       : String;
    };

    /**
     * Lists the contracts from the config and those registered at runtime.
     * `artifactDigest` identifies the exact build. Saved jobs only run on that build.
     * When `hasProverKeys` is false, this server can deploy and verify but not create proofs.
     */
    function listContracts() returns array of {
        name           : String;
        source         : String; // 'config' or 'runtime'
        artifactPath   : String;
        zkConfigPath   : String;
        privateStateId : String;
        slotWidth      : Integer;
        artifactDigest : String;
        hasProverKeys  : Boolean;
    };

    /**
     * Registers a compiled contract at runtime. It is checked first, saved, and loaded again on every start.
     * Both paths must lie inside `NIGHTGATE_CONTRACTS_DIR`. A name from the config answers 409.
     * Registering a new build under an existing name makes saved jobs for the old build fail.
     */
    action registerContract(name: String,
                            artifactPath: String,
                            zkConfigPath: String,
                            privateStateId: String,
                            slotWidth: Integer // optional; default 16; 16 or 32 document fields
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

    /** Removes a runtime registration. A name from the config answers 409. */
    action unregisterContract(name: String) returns {
        removed : Boolean;
    };

    /**
     * Records a CPU profile of a running thread and summarizes where the time went.
     * `seconds` is 1 to 120, default 20. `thread` is 'worker', the default, or 'main'.
     * The .cpuprofile file goes to `nightgate-profiles/` in the OS temp folder, or to the subfolder `dir`.
     */
    action profileWorker(seconds: Integer, dir: String, thread: String) returns {
        thread        : String;
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
        gc            : { count: Integer; totalMs: Integer; byKind: String }; // byKind is JSON: count and ms per GC kind
    };

    /**
     * Shows what the fee sponsor may pay for. `floor` holds the platform lists.
     * With `grantId`, `effective` holds what the grant may use. `effectiveError` says why it may use nothing.
     */
    function getSponsorPolicy(grantId: UUID) returns {
        source         : String; // 'file' or 'env'
        path           : String;
        loadedAt       : Timestamp; // null = no policy file
        ignoredEnv     : array of String; // environment settings the policy file overrides
        floorError     : String;
        floor          : {
            allowedContracts   : array of String; // empty = any
            allowedCircuits    : array of String; // empty = any
            allowedTokenTypes  : array of String; // empty = none
            allowDeploy        : Boolean;
            allowContractMints : Boolean;
            allowSwaps         : Boolean;
        };
        grant          : {
            grantId           : UUID;
            active            : Boolean;
            allowedContracts  : array of String;
            allowedCircuits   : array of String;
            allowedTokenTypes : array of String;
            deployedContracts : array of String;
            mintedTokenTypes  : array of String;
            allowDeploy       : Boolean;
            allowSwaps        : Boolean;
            maxDeploys        : Integer;
            deploysUsed       : Integer;
        };
        effective      : {
            allowedContracts   : array of String;
            allowedCircuits    : array of String;
            allowedTokenTypes  : array of String;
            ownContracts       : array of String;
            ownTokenTypes      : array of String;
            allowDeploy        : Boolean;
            allowContractMints : Boolean;
            allowSwaps         : Boolean;
        };
        effectiveError : String;
    };

    /** Job counts per status and the most frequent error codes. `windowHours` defaults to 24, max 720. */
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

    /**
     * Finds NightBalances rows that do not match the indexed UTXOs. Changes nothing.
     * Checks one `address`, or up to `limit` addresses after `after`. `limit` is at most 500.
     */
    function reconcileNightBalances(address: String, after: String, limit: Integer) returns {
        checked : Integer;
        next    : String; // null = done; pass as `after` for the next page
        drifted : array of {
            address  : String;
            field    : String; // column name, or 'row'
            stored   : String;
            computed : String;
        };
    };

    /**
     * Decodes the stored transactions again from `height` up and rewrites the fields taken from them.
     * The decoder never moves forward this way. `changed` is false when it already stood below `height`.
     */
    action redecodeFromHeight(height: Integer64) returns {
        fromHeight            : Integer64;
        previousDecodedHeight : Integer64;
        blocks                : Integer64;
        changed               : Boolean;
    };

    // Grants a disclosure role. The caller also needs the disclosure role 'authority'.
    action grantRole(
        userId:     String,
        role:       String,
        scope:      String,
        validUntil: Timestamp
    );

    // Ends the matching roles now and returns how many ended. The rows are kept.
    action revokeRole(
        userId: String,
        role:   String,
        scope:  String
    ) returns Integer;
}
