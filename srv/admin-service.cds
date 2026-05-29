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

    // Admin actions
    action invalidateSession(sessionId: UUID);
    action invalidateAllSessions();

    // T14 — grant a disclosure tier to a user. Service-level @requires: 'admin'
    // gates CAP-auth-side; handler additionally requires the caller's own
    // disclosureRole = 'authority' (defense in depth).
    action grantRole(
        userId:     String,
        role:       String,
        scope:      String,
        validUntil: Timestamp
    );
}
