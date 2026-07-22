/**
 * NightgateAdminService: wallet-session management + role grants.
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
import { decrypt, getEncryptionKey } from './utils/crypto';
import { deriveAccountId } from './submission/wallet-material-factory';
import { evictWalletFacade } from './submission/wallet-facade-builder';

import { WalletSessions, DisclosureRoles } from '#cds-models/midnight';

/**
 * Drop the in-memory WalletFacade (live secret keys) cached for a session, so a
 * forced invalidation removes secrets from RAM, not just the DB.
 * Best-effort: eviction failures never block the invalidation.
 */
async function evictSessionFacade(session: { encryptedViewingKey?: string | null }): Promise<void> {
    try {
        if (session.encryptedViewingKey) {
            const vk = decrypt(session.encryptedViewingKey, getEncryptionKey());
            await evictWalletFacade(deriveAccountId(vk));
        }
    } catch { /* best-effort */ }
}

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
                SELECT.one.from(WalletSessions).where({ sessionId })
            );

            if (!session) {
                return req.reject(404, `Session ${sessionId} not found`);
            }

            if (!session.isActive) {
                return req.reject(409, `Session ${sessionId} is already inactive`);
            }

            await evictSessionFacade(session);
            await this.db.run(
                UPDATE.entity(WalletSessions).set({
                    isActive: false,
                    disconnectedAt: new Date().toISOString(),
                    encryptedViewingKey: null,
                    encryptedSeedKey: null  // Clear BOTH secrets, not just the viewing key
                }).where({ sessionId })
            );
        });

        this.on('invalidateAllSessions', async () => {
            // Evict cached facades before nulling keys so live signing keys are
            // dropped from RAM too.
            const active: any[] = (await this.db.run(
                SELECT.from(WalletSessions).columns('encryptedViewingKey').where({ isActive: true })
            )) || [];
            for (const s of active) await evictSessionFacade(s);

            const result = await this.db.run(
                UPDATE.entity(WalletSessions).set({
                    isActive: false,
                    disconnectedAt: new Date().toISOString(),
                    encryptedViewingKey: null,
                    encryptedSeedKey: null  // Clear BOTH secrets for every session
                }).where({ isActive: true })
            );
            return result;
        });

        // @requires:'admin' gates CAP auth; additionally require the caller to
        // hold the 'authority' disclosure tier so a sysadmin who is not a
        // regulator cannot grant data-tier access.
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
            await this.db.run(INSERT.into(DisclosureRoles).entries({
                userId,
                role,
                scope: scope && scope.length > 0 ? scope : null,
                grantedBy,
                validFrom: now,
                validUntil: validUntil && validUntil.length > 0 ? validUntil : null
            }));
        });

        await super.init();
    }
}
