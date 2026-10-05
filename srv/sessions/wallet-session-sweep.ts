/**
 * SPDX-License-Identifier: Apache-2.0
 */
import cds from '@sap/cds';
import { WalletSessions, type WalletSession } from '#cds-models/midnight';
import { getNightgatePluginConfig, type NightgatePluginConfig } from '../utils/nightgate-config';
import { getConfiguredFeeSponsorSessions } from '../submission/fee-sponsor';
import type { DbRunner, Row } from '../utils/db-types';
import { evictFacadeUnlessShared } from './wallet-session-lifecycle';

const { SELECT, UPDATE } = cds.ql;

/** Rows per UPDATE, small enough for the database driver's parameter limit. */
const SESSION_CLOSE_CHUNK = 200;

/**
 * At startup, closes the view-only sessions left by the previous process.
 * Returns their ids so their queued jobs can be dropped. Assumes a single server instance.
 * Platform fee sponsors and sessions with a signing key stay open, because closing deletes the key.
 */
export async function closeSessionsFromPreviousProcess(db: DbRunner, config?: NightgatePluginConfig): Promise<string[]> {
    const exempt = new Set(getConfiguredFeeSponsorSessions(config));
    const active: Row<WalletSession, 'sessionId'>[] = (await db.run(
        SELECT.from(WalletSessions).columns('sessionId', 'encryptedSeedKey').where({ isActive: true })
    )) || [];
    const keyed = active.filter(r => r?.sessionId && r.encryptedSeedKey && !exempt.has(r.sessionId)).map(r => r.sessionId);
    if (keyed.length) {
        cds.log('nightgate').info(`Boot sweep keeps ${keyed.length} session(s) holding a signing key: ${keyed.map(id => id.slice(0, 8)).join(', ')}`);
    }
    const stale = active.map(r => r.sessionId).filter(id => id && !exempt.has(id) && !keyed.includes(id));
    if (stale.length === 0) return [];

    const now = new Date().toISOString();
    for (let i = 0; i < stale.length; i += SESSION_CLOSE_CHUNK) {
        await db.run(
            UPDATE.entity(WalletSessions)
                .set({
                    isActive: false,
                    disconnectedAt: now,
                    encryptedViewingKey: null,
                    encryptedSeedKey: null
                })
                .where({ sessionId: { in: stale.slice(i, i + SESSION_CLOSE_CHUNK) } })
        );
    }
    return stale;
}

export function startSessionCleanup(db: DbRunner): ReturnType<typeof setInterval> {
    const SESSION_CLEANUP_INTERVAL = 15 * 60 * 1000;
    const timer = setInterval(async () => {
        try {
            const now = new Date().toISOString();
            // Platform fee sponsors never expire, so they are never closed or wiped.
            const platformSponsors = new Set(getConfiguredFeeSponsorSessions(getNightgatePluginConfig()));
            const expiring: Row<WalletSession, 'sessionId'>[] = ((await db.run(
                SELECT.from(WalletSessions)
                    .columns('sessionId', 'viewingKeyHash', 'encryptedViewingKey', 'userId')
                    .where({ isActive: true, expiresAt: { '<': now } })
            )) || []).filter((s: Row<WalletSession, 'sessionId'>) => !platformSponsors.has(s.sessionId));
            if (expiring.length === 0) return;
            // Deactivate exactly the selected rows first. A row that expires in the meantime
            // is left for the next run, so every closed row gets its eviction check.
            await db.run(
                UPDATE.entity(WalletSessions)
                    .set({ isActive: false, encryptedViewingKey: null, encryptedSeedKey: null })
                    .where({ sessionId: { in: expiring.map(s => s.sessionId) } })
            );
            const decidedHashes = new Set<string>();
            for (const s of expiring) {
                if (!s.encryptedViewingKey) continue;
                if (s.viewingKeyHash) {
                    if (decidedHashes.has(s.viewingKeyHash)) continue;
                    decidedHashes.add(s.viewingKeyHash);
                }
                await evictFacadeUnlessShared(
                    db, s, `session cleanup (expired session ${String(s.sessionId).slice(0, 8)})`
                );
            }
        } catch { /* ignore cleanup errors */ }
    }, SESSION_CLEANUP_INTERVAL);

    // Tests replace setInterval with a plain object that has no unref().
    if (typeof timer.unref === 'function') {
        timer.unref();
    }

    return timer;
}
