/**
 * NightgateAdminService: wallet-session management + role grants.
 */

import cds from '@sap/cds';
const { SELECT, UPDATE, INSERT } = cds.ql;

import { ensureNightgateModelLoaded } from './utils/cds-model';
import {
    attachDisclosureRole,
    isAuthority,
    isValidDisclosureRoleValue,
    DISCLOSURE_ROLE_VALUES
} from './middleware/disclosure-role';
import { decrypt, getEncryptionKey } from './utils/crypto';
import { walletSessionViewingKeyBinding } from './utils/envelope-bindings';
import { exportContractSigningKeyForSession, SigningKeyExportError } from './submission/signing-key-export';
import { deriveAccountId } from './submission/wallet-material-factory';
import { evictWalletFacade } from './submission/wallet-facade-builder';
import { withKeyedLock } from './utils/keyed-lock';

import { WalletSessions, DisclosureRoles, BackgroundJobs, type WalletSession } from '#cds-models/midnight';
import { listContracts, registerContractAtRuntime, unregisterContractAtRuntime, ContractRegistrationError } from './submission/contract-registrations';
import { walletCpuProfile } from './midnight/wallet-worker-client';
import { PROFILE_ROOT, profileCurrentThread, resolveProfileDir } from './midnight/cpu-profile';
import { getConfiguredNightgateNetwork } from './utils/nightgate-config';
import { reconcileNightBalances } from './crawler/night-balance-reconcile';
import { redecodeFromHeight, RedecodeError } from './crawler/redecode';
import { describeSponsorPolicy } from './sessions/agent-grants';
import { formatErr } from './utils/format-error';
import { NightgateError } from './utils/errors';
import type { NightgateRequest } from './utils/request-types';
import type { Row } from './utils/db-types';
import { normalizeHttpError } from './utils/http-errors';

/**
 * Drop the in-memory WalletFacade (live secret keys) cached for a session, so a
 * forced invalidation removes secrets from RAM, not just the DB.
 * Best-effort: eviction failures never block the invalidation.
 */
async function evictSessionFacade(session: { sessionId: string; encryptedViewingKey?: string | null }): Promise<void> {
    try {
        if (session.encryptedViewingKey) {
            const vk = decrypt(session.encryptedViewingKey, getEncryptionKey(), walletSessionViewingKeyBinding(session.sessionId));
            const accountId = deriveAccountId(vk);
            // Deliberately account-wide (operator tool: forced invalidation
            // must drop secrets even if other sessions share the wallet).
            cds.log('nightgate:admin').info('force-evicting facade', accountId.slice(0, 16));
            // The build lock: an evict that lands mid-build would find nothing and the build re-insert it.
            await withKeyedLock(accountId, () => evictWalletFacade(accountId));
        }
    } catch { /* best-effort */ }
}

export default class NightgateAdminService extends cds.ApplicationService {
    private db!: cds.DatabaseService;

    async init(): Promise<void> {
        this.on('error', normalizeHttpError);
        await ensureNightgateModelLoaded();
        this.db = await cds.connect.to('db');

        this.on('reconcileNightBalances', async (req: NightgateRequest) => {
            const { address, after, limit } = req.data as { address?: string | null; after?: string | null; limit?: number | null };
            if (limit !== undefined && limit !== null && (!Number.isInteger(limit) || limit < 1)) {
                return req.reject(400, 'limit must be a positive integer');
            }
            return reconcileNightBalances(this.db, { address, after, limit });
        });

        this.on('redecodeFromHeight', async (req: NightgateRequest) => {
            const { height } = req.data as { height?: unknown };
            try {
                return await redecodeFromHeight(this.db, height);
            } catch (err) {
                if (err instanceof RedecodeError) return req.reject(400, err.message);
                throw err;
            }
        });

        this.on('getSponsorPolicy', async (req: NightgateRequest) => {
            const { grantId } = req.data as { grantId?: string | null };
            const described = await describeSponsorPolicy(this.db, grantId ?? null);
            if (!described) return req.reject(404, 'Grant not found');
            return described;
        });

        this.on('getJobStats', async (req: NightgateRequest) => {
            const { windowHours } = req.data as { windowHours?: number };
            const hours = Math.min(Math.max(Number(windowHours) || 24, 1), 720);
            const since = new Date(Date.now() - hours * 3600_000).toISOString();

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

        // Worker CPU profile: bounded sampling window, runs while the worker
        // keeps serving; the caller waits for the result (up to seconds + 60 s).
        this.on('profileWorker', async (req: NightgateRequest) => {
            const data = req.data as { seconds?: number | null; dir?: string | null; thread?: string | null };
            const seconds = Number(data.seconds ?? 20);
            if (!Number.isFinite(seconds) || seconds < 1 || seconds > 120) {
                return req.reject(400, 'seconds must be between 1 and 120');
            }
            const thread = (data.thread ?? 'worker').toString().trim().toLowerCase();
            if (thread !== 'worker' && thread !== 'main') return req.reject(400, "thread must be 'worker' (default) or 'main'");
            const dir = resolveProfileDir(typeof data.dir === 'string' ? data.dir : null);
            if (!dir) return req.reject(400, `dir must name a folder inside ${PROFILE_ROOT}`);
            try {
                if (thread === 'main') {
                    const p = await profileCurrentThread(seconds, { dir, filePrefix: 'main' });
                    return { thread: 'main', facadeCount: null, ...p, gc: { ...p.gc, byKind: JSON.stringify(p.gc.byKind) } };
                }
                return await walletCpuProfile(seconds, dir);
            } catch (e: unknown) {
                return req.reject(new NightgateError('UNAVAILABLE', `${thread} profile failed: ${formatErr(e)}`, { exposeMessage: true }));
            }
        });

        this.on('registerContract', async (req: NightgateRequest) => {
            const data = req.data as { name?: string; artifactPath?: string; zkConfigPath?: string; privateStateId?: string; slotWidth?: number | null };
            for (const field of ['name', 'artifactPath', 'zkConfigPath', 'privateStateId'] as const) {
                if (typeof data[field] !== 'string' || !data[field]!.trim()) return req.reject(400, `${field} is required`);
            }
            try {
                return await registerContractAtRuntime(this.db, {
                    name: data.name!, artifactPath: data.artifactPath!, zkConfigPath: data.zkConfigPath!,
                    privateStateId: data.privateStateId!, slotWidth: data.slotWidth ?? null
                }, {
                    registeredBy: req.user?.id,
                    // The resolved plugin network (env, then cds.requires.nightgate.network), not the env alone.
                    networkId: getConfiguredNightgateNetwork((cds as any).env?.requires?.nightgate) ?? undefined
                });
            } catch (err) {
                if (err instanceof ContractRegistrationError) return req.reject(err.httpStatus, err.message);
                throw err;
            }
        });

        this.on('unregisterContract', async (req: NightgateRequest) => {
            const { name } = req.data as { name?: string };
            if (typeof name !== 'string' || !name.trim()) return req.reject(400, 'name is required');
            try {
                return await unregisterContractAtRuntime(this.db, name.trim());
            } catch (err) {
                if (err instanceof ContractRegistrationError) return req.reject(err.httpStatus, err.message);
                throw err;
            }
        });

        this.on('invalidateSession', async (req: NightgateRequest) => {
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

            // Deactivate first: a job still running for the session must not rebuild after the evict.
            await this.db.run(
                UPDATE.entity(WalletSessions).set({
                    isActive: false,
                    disconnectedAt: new Date().toISOString(),
                    encryptedViewingKey: null,
                    encryptedSeedKey: null  // Clear BOTH secrets, not just the viewing key
                }).where({ sessionId })
            );
            await evictSessionFacade(session);
        });

        this.on('exportContractSigningKey', async (req: NightgateRequest) => {
            const { sessionId, contractAddress, password } = req.data as { sessionId?: string; contractAddress?: string; password?: string };
            try {
                const out = await exportContractSigningKeyForSession(this.db, getEncryptionKey(), String(sessionId ?? ''), String(contractAddress ?? ''), String(password ?? ''));
                cds.log('nightgate:admin').info('signing key exported', out.contractAddress.slice(0, 16), 'account', out.accountId.slice(0, 16), 'by', req.user?.id);
                return out;
            } catch (err) {
                if (err instanceof SigningKeyExportError) return req.reject(err.status, err.message);
                throw err;
            }
        });

        this.on('invalidateAllSessions', async () => {
            // Viewing keys read before they are nulled, facades evicted after the deactivation.
            const active: Row<WalletSession, 'sessionId'>[] = (await this.db.run(
                SELECT.from(WalletSessions).columns('sessionId', 'encryptedViewingKey').where({ isActive: true })
            )) || [];

            const result = await this.db.run(
                UPDATE.entity(WalletSessions).set({
                    isActive: false,
                    disconnectedAt: new Date().toISOString(),
                    encryptedViewingKey: null,
                    encryptedSeedKey: null  // Clear BOTH secrets for every session
                }).where({ isActive: true })
            );
            for (const s of active) await evictSessionFacade(s);
            return result;
        });

        // @requires:'admin' gates CAP auth; additionally require the caller to
        // hold the 'authority' disclosure tier so a sysadmin who is not a
        // regulator cannot grant data-tier access.
        this.on('grantRole', async (req: NightgateRequest) => {
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

            const now = new Date().toISOString();
            if (validUntil) {
                const until = Date.parse(validUntil);
                if (Number.isNaN(until)) return req.reject(400, 'validUntil must be an ISO timestamp');
                if (until <= Date.parse(now)) return req.reject(400, 'validUntil must be in the future');
            }

            const callerRole = await attachDisclosureRole(req, this.db);
            if (!isAuthority(callerRole)) {
                return req.reject(403, 'caller must hold the authority disclosure role to grant roles');
            }

            const grantedBy = req.user?.id || 'unknown';
            await this.db.run(INSERT.into(DisclosureRoles).entries({
                userId,
                role,
                scope: scope && scope.length > 0 ? scope : null,
                grantedBy,
                validFrom: now,
                validUntil: validUntil && validUntil.length > 0 ? validUntil : null
            }));
        });

        // Ends matching grants by setting validUntil, so the grant history stays readable.
        this.on('revokeRole', async (req: NightgateRequest) => {
            const { userId, role, scope } = req.data as { userId?: string; role?: string; scope?: string };

            if (!userId) return req.reject(400, 'userId is required');
            if (!role) return req.reject(400, 'role is required');
            if (!isValidDisclosureRoleValue(role)) {
                return req.reject(400, `role must be one of: ${DISCLOSURE_ROLE_VALUES.join(', ')}`);
            }

            const callerRole = await attachDisclosureRole(req, this.db);
            if (!isAuthority(callerRole)) {
                return req.reject(403, 'caller must hold the authority disclosure role to revoke roles');
            }

            const wantedScope = scope && scope.length > 0 ? scope : null;
            const now = new Date().toISOString();
            const rows: Array<{ ID: string; scope?: string | null; validUntil?: string | null }> =
                (await this.db.run(SELECT.from(DisclosureRoles).where({ userId, role }))) || [];
            const ids = rows
                .filter(r => (r.scope == null || r.scope === '' ? null : r.scope) === wantedScope)
                .filter(r => !r.validUntil || Date.parse(r.validUntil) > Date.parse(now))
                .map(r => r.ID);
            if (ids.length === 0) return 0;

            await this.db.run(UPDATE.entity(DisclosureRoles).set({ validUntil: now }).where({ ID: { in: ids } }));
            return ids.length;
        });

        await super.init();
    }
}
