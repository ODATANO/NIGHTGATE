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
     * Job queue in one call: counts per status plus the error codes that are
     * piling up, over the last `windowHours` (default 24, max 720).
     *
     * The cheap read for a dashboard that wants the shape of the queue without
     * paging the whole BackgroundJobs entity. `topErrors` is what turns "many
     * jobs failed" into a diagnosis, e.g. a run of `1010/188` meaning batched
     * calls are crossing the guaranteed/fallible boundary.
     */
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
