/**
 * NightgateAdminService, System Administration
 *
 * Provides session management for wallet connections.
 * Entity projections (WalletSessions) are handled by CDS automatically.
 */

import cds, { Request } from '@sap/cds';
const { SELECT, UPDATE, INSERT } = cds.ql;

import { ensureNightgateModelLoaded } from './utils/cds-model';
import {
    attachDisclosureRole,
    isAuthority,
    isValidDisclosureRoleValue,
    DISCLOSURE_ROLE_VALUES
} from './middleware/disclosure-role';

export default class NightgateAdminService extends cds.ApplicationService {
    private db!: cds.DatabaseService;

    async init(): Promise<void> {
        await ensureNightgateModelLoaded();
        this.db = await cds.connect.to('db');

        this.on('invalidateSession', async (req: Request) => {
            const { sessionId } = req.data as { sessionId: string };

            if (!sessionId) {
                return req.reject(400, 'sessionId is required');
            }

            const session = await this.db.run(
                SELECT.one.from('midnight.WalletSessions').where({ sessionId })
            );

            if (!session) {
                return req.reject(404, `Session ${sessionId} not found`);
            }

            if (!session.isActive) {
                return req.reject(409, `Session ${sessionId} is already inactive`);
            }

            await this.db.run(
                UPDATE.entity('midnight.WalletSessions').set({
                    isActive: false,
                    disconnectedAt: new Date().toISOString(),
                    encryptedViewingKey: null  // Clear encrypted key
                }).where({ sessionId })
            );
        });

        this.on('invalidateAllSessions', async () => {
            const result = await this.db.run(
                UPDATE.entity('midnight.WalletSessions').set({
                    isActive: false,
                    disconnectedAt: new Date().toISOString(),
                    encryptedViewingKey: null  // Clear all encrypted keys
                }).where({ isActive: true })
            );
            return result;
        });

        // T14 — grantRole. Service-level @requires: 'admin' has already gated
        // the CAP auth side. Belt-and-suspenders: additionally require the
        // caller to hold the 'authority' disclosure tier, so a sysadmin who
        // is not also a regulator cannot grant data-tier access.
        this.on('grantRole', async (req: Request) => {
            const { userId, role, scope, validUntil } = req.data as {
                userId?: string;
                role?: string;
                scope?: string;
                validUntil?: string;
            };

            if (!userId) return req.reject(400, 'userId is required');
            if (!role) return req.reject(400, 'role is required');
            if (!isValidDisclosureRoleValue(role)) {
                return req.reject(400, `role must be one of: ${DISCLOSURE_ROLE_VALUES.join(', ')}`);
            }

            const callerRole = await attachDisclosureRole(req, this.db);
            if (!isAuthority(callerRole)) {
                return req.reject(403, 'caller must hold the authority disclosure role to grant roles');
            }

            const grantedBy = (req as any).user?.id || 'unknown';
            const now = new Date().toISOString();
            await this.db.run(INSERT.into('midnight.DisclosureRoles').entries({
                userId,
                role,
                scope:      scope && scope.length > 0 ? scope : null,
                grantedBy,
                validFrom:  now,
                validUntil: validUntil && validUntil.length > 0 ? validUntil : null
            }));
        });

        await super.init();
    }
}
