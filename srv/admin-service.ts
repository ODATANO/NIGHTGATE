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

import { WalletSessions, DisclosureRoles, BackgroundJobs } from '#cds-models/midnight';
import { listContracts, registerContractAtRuntime, unregisterContractAtRuntime, ContractRegistrationError } from './submission/contract-registrations';

/**
 * Drop the in-memory WalletFacade (live secret keys) cached for a session, so a
 * forced invalidation removes secrets from RAM, not just the DB.
 * Best-effort: eviction failures never block the invalidation.
 */
async function evictSessionFacade(session: { encryptedViewingKey?: string | null }): Promise<void> {
    try {
        if (session.encryptedViewingKey) {
            const vk = decrypt(session.encryptedViewingKey, getEncryptionKey());
            const accountId = deriveAccountId(vk);
            // Deliberately account-wide (operator tool: forced invalidation
            // must drop secrets even if other sessions share the wallet).
            cds.log('nightgate:admin').info('force-evicting facade', accountId.slice(0, 16));
            await evictWalletFacade(accountId);
        }
    } catch { /* best-effort */ }
}

export default class NightgateAdminService extends cds.ApplicationService {
    private db!: cds.DatabaseService;

    async init(): Promise<void> {
        await ensureNightgateModelLoaded();
        this.db = await cds.connect.to('db');

        this.on('getJobStats', async (req: Request) => {
            const { windowHours } = req.data as { windowHours?: number };
            const hours = Math.min(Math.max(Number(windowHours) || 24, 1), 720);
            const since = new Date(Date.now() - hours * 3600_000).toISOString();

            // Aggregate in the DATABASE, not here. The window bounds time, not
            // row count: at a high job rate "the last 720 hours" is millions of
            // rows, and pulling them into the process on every dashboard poll
            // would cost memory and query time for numbers SQL can fold itself.
            const [statusRows, errorRows, oldestRows] = await Promise.all([
                this.db.run(
                    SELECT.from(BackgroundJobs)
                        .columns('status', 'count(*) as count')
                        .where({ createdAt: { '>=': since } })
                        .groupBy('status')
                ),
                this.db.run(
                    SELECT.from(BackgroundJobs)
                        .columns('errorCode', 'count(*) as count')
                        .where({ createdAt: { '>=': since }, and: { errorCode: { '!=': null } } })
                        .groupBy('errorCode')
                ),
                this.db.run(
                    SELECT.from(BackgroundJobs)
                        .columns('min(createdAt) as oldest')
                        .where({ createdAt: { '>=': since }, and: { status: 'pending' } })
                )
            ]);

            const byStatus = ((statusRows as Array<{ status?: string; count?: number }>) || [])
                .map(row => ({ status: row.status || 'unknown', count: Number(row.count ?? 0) }))
                .sort((a, b) => b.count - a.count);

            const topErrors = ((errorRows as Array<{ errorCode?: string; count?: number }>) || [])
                .filter(row => row.errorCode)
                .map(row => ({ errorCode: String(row.errorCode), count: Number(row.count ?? 0) }))
                .sort((a, b) => b.count - a.count)
                .slice(0, 10);

            const oldest = (oldestRows as Array<{ oldest?: string | null }> | undefined)?.[0]?.oldest;
            const oldestMs = oldest ? new Date(oldest).getTime() : NaN;

            return {
                windowHours: hours,
                since,
                total: byStatus.reduce((sum, row) => sum + row.count, 0),
                byStatus,
                topErrors,
                oldestQueuedSeconds: Number.isFinite(oldestMs)
                    ? Math.max(0, Math.round((Date.now() - oldestMs) / 1000))
                    : 0
            };
        });

        // Runtime contract registration on top of the config floor; the
        // service-level @requires 'admin' gates the caller.
        this.on('listContracts', async () => listContracts());

        this.on('registerContract', async (req: Request) => {
            const data = req.data as { name?: string; artifactPath?: string; zkConfigPath?: string; privateStateId?: string; slotWidth?: number | null };
            for (const field of ['name', 'artifactPath', 'zkConfigPath', 'privateStateId'] as const) {
                if (typeof data[field] !== 'string' || !data[field]!.trim()) return req.reject(400, `${field} is required`);
            }
            try {
                return await registerContractAtRuntime(this.db, {
                    name: data.name!, artifactPath: data.artifactPath!, zkConfigPath: data.zkConfigPath!,
                    privateStateId: data.privateStateId!, slotWidth: data.slotWidth ?? null
                }, {
                    registeredBy: (req as any).user?.id,
                    networkId: process.env.NIGHTGATE_NETWORK ?? undefined
                });
            } catch (err) {
                if (err instanceof ContractRegistrationError) return req.reject(err.httpStatus, err.message);
                throw err;
            }
        });

        this.on('unregisterContract', async (req: Request) => {
            const { name } = req.data as { name?: string };
            if (typeof name !== 'string' || !name.trim()) return req.reject(400, 'name is required');
            try {
                return await unregisterContractAtRuntime(this.db, name.trim());
            } catch (err) {
                if (err instanceof ContractRegistrationError) return req.reject(err.httpStatus, err.message);
                throw err;
            }
        });

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
