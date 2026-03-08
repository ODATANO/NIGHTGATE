using { midnight } from '../db/schema';

/**
 * Admin Service for system management
 */
@path: '/api/v1/admin'
@requires: 'admin'
service NightgateAdminService {

    entity WalletSessions as projection on midnight.WalletSessions excluding {
        encryptedViewingKey     // Encrypted key — never exposed via admin API
    };

    // Admin actions
    action invalidateSession(sessionId: UUID);
    action invalidateAllSessions();
}
