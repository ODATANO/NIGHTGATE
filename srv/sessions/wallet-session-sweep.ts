/**
 * SPDX-License-Identifier: Apache-2.0
 */
import cds from '@sap/cds';
import { WalletSessions, type WalletSession } from '#cds-models/midnight';
import { getNightgatePluginConfig, type NightgatePluginConfig } from '../utils/nightgate-config';
import { getConfiguredFeeSponsorSessions } from '../submission/fee-sponsor';
import type { DbRunner, Row } from '../utils/db-types';
import { evictFacadeUnlessShared } from './wallet-session-lifecycle';
import { errorMessage } from '../utils/errors';

const { SELECT, UPDATE } = cds.ql;

/** Rows per UPDATE, small enough for the database driver's parameter limit. */
const SESSION_CLOSE_CHUNK = 200;

const DEFAULT_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/** At startup closes the previous process's view-only sessions and returns their ids. Assumes one server instance. Fee sponsors and key-holding sessions stay open. */
export async function closeSessionsFromPreviousProcess(db: DbRunner, config?: NightgatePluginConfig): Promise<string[]> {
    const exempt = new Set(getConfiguredFeeSponsorSessions(config));
    const active: Row<WalletSession, 'sessionId'>[] = (await db.run(
        SELECT.from(WalletSessions).columns('sessionId', 'encryptedSeedKey', 'expiresAt').where({ isActive: true })
    )) || [];
    const keyedRows = active.filter(r => r?.sessionId && r.encryptedSeedKey && !exempt.has(r.sessionId));
    const keyed = keyedRows.map(r => r.sessionId);
    if (keyed.length) {
        cds.log('nightgate').info(`Boot sweep keeps ${keyed.length} session(s) holding a signing key. Each loses its key when it expires: ${keyedRows.map(r => `${r.sessionId?.slice(0, 8)} at ${r.expiresAt}`).join(', ')}`);
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

// A sponsor's expiry moves with every run, so a sponsor taken out of the pool keeps its keys for one session lifetime.
async function extendSponsorSessions(db: DbRunner, sponsors: readonly string[], config: NightgatePluginConfig): Promise<void> {
    if (sponsors.length === 0) return;
    const expiresAt = new Date(Date.now() + (config.sessionTtlMs || DEFAULT_SESSION_TTL_MS)).toISOString();
    await db.run(UPDATE.entity(WalletSessions).set({ expiresAt }).where({ sessionId: { in: [...sponsors] } }));
}

export function startSessionCleanup(db: DbRunner): ReturnType<typeof setInterval> {
    const SESSION_CLEANUP_INTERVAL = 15 * 60 * 1000;
    const firstConfig = getNightgatePluginConfig();
    extendSponsorSessions(db, getConfiguredFeeSponsorSessions(firstConfig), firstConfig)
        .catch(err => cds.log('nightgate').warn(`Sponsor session expiry not extended: ${errorMessage(err)}`));
    const timer = setInterval(async () => {
        try {
            const now = new Date().toISOString();
            // Platform fee sponsors never expire, so they are never closed or wiped.
            const config = getNightgatePluginConfig();
            const sponsors = getConfiguredFeeSponsorSessions(config);
            await extendSponsorSessions(db, sponsors, config);
            const platformSponsors = new Set(sponsors);
            const expiring: Row<WalletSession, 'sessionId'>[] = ((await db.run(
                SELECT.from(WalletSessions)
                    .columns('sessionId', 'viewingKeyHash', 'encryptedViewingKey', 'encryptedSeedKey', 'userId')
                    .where({ isActive: true, expiresAt: { '<': now } })
            )) || []).filter((s: Row<WalletSession, 'sessionId'>) => !platformSponsors.has(s.sessionId));
            if (expiring.length === 0) return;
            const withKey = expiring.filter(s => s.encryptedSeedKey).map(s => String(s.sessionId).slice(0, 8));
            if (withKey.length) cds.log('nightgate').warn(`Session cleanup removes the signing key of expired session(s) ${withKey.join(', ')}. Using such a wallet again needs its mnemonic.`);
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
        } catch (err) {
            // The next run retries.
            cds.log('nightgate').warn(`Session cleanup failed: ${errorMessage(err)}`);
        }
    }, SESSION_CLEANUP_INTERVAL);

    // Tests replace setInterval with a plain object that has no unref().
    if (typeof timer.unref === 'function') {
        timer.unref();
    }

    return timer;
}
