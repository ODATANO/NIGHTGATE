/**
 * SPDX-License-Identifier: Apache-2.0
 */
import cds from '@sap/cds';
import { WalletSessions, type WalletSession } from '#cds-models/midnight';
import { getNightgateConfig, type NightgateConfig } from '../utils/nightgate-config';
import { configMs } from '../utils/config';
import { getConfiguredFeeSponsorSessions } from '../submission/fee-sponsor';
import type { DbRunner, DbService, Row } from '../utils/db-types';
import { evictFacadeUnlessShared } from './wallet-session-lifecycle';
import { errorMessage } from '../utils/errors';
import { decrypt, encrypt, getEncryptionKey, hashViewingKey } from '../utils/crypto';
import { walletSessionViewingKeyBinding } from '../utils/envelope-bindings';
import { bareHex } from '../utils/hex-patterns';
import { moveAccountOfSpelling, sessionsHolding, forgetAccountKeys } from '../submission/wallet-material-factory';

const { SELECT, UPDATE } = cds.ql;

/** Rows per UPDATE, small enough for the database driver's parameter limit. */
const SESSION_CLOSE_CHUNK = 200;


/** At startup rewrites every stored viewing key to lowercase and moves its account there, each key in one transaction.
 *  A key that fails keeps its spelling and its account. Returns how many spellings were rewritten. */
export async function adoptStoredSpellings(db: DbService): Promise<number> {
    const log = cds.log('nightgate:sessions');
    const ring = getEncryptionKey();
    const rows: Array<Pick<WalletSession, 'sessionId' | 'encryptedViewingKey'>> = (await db.run(
        SELECT.from(WalletSessions).columns('sessionId', 'encryptedViewingKey').where({ encryptedViewingKey: { '!=': null } }))) || [];
    const seen = new Set<string>();
    let adopted = 0;
    for (const row of rows) {
        let spelling: string;
        try {
            spelling = decrypt(String(row.encryptedViewingKey), ring, walletSessionViewingKeyBinding(String(row.sessionId)));
        } catch { continue; }
        const canonical = bareHex(spelling);
        if (spelling === canonical || seen.has(hashViewingKey(spelling))) continue;
        seen.add(hashViewingKey(spelling));
        try {
            const moved = await db.tx(async tx => {
                const rowsMoved = await moveAccountOfSpelling(tx, ring, spelling);
                for (const sessionId of await sessionsHolding(tx, spelling)) {
                    await tx.run(UPDATE.entity(WalletSessions).set({
                        encryptedViewingKey: encrypt(canonical, ring, walletSessionViewingKeyBinding(sessionId)),
                        viewingKeyHash: hashViewingKey(canonical)
                    }).where({ sessionId }));
                }
                return rowsMoved;
            });
            adopted++;
            log.info(`Session ${String(row.sessionId).slice(0, 8)}: viewing key stored in lowercase now, ${moved?.moved ?? 0} row(s) moved to its account, ${moved?.left ?? 0} left under the former spelling`);
        } catch (err) {
            await forgetAccountKeys(canonical);
            log.error(`Session ${String(row.sessionId).slice(0, 8)}: the account of its viewing key was not moved to the lowercase spelling, the session keeps its account: ${errorMessage(err)}`);
        }
    }
    return adopted;
}

/** At startup closes the previous process's view-only sessions and returns their ids. Assumes one server instance. Fee sponsors and key-holding sessions stay open. */
export async function closeSessionsFromPreviousProcess(db: DbRunner, config?: NightgateConfig): Promise<string[]> {
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
async function extendSponsorSessions(db: DbRunner, sponsors: readonly string[]): Promise<void> {
    if (sponsors.length === 0) return;
    const expiresAt = new Date(Date.now() + configMs('NIGHTGATE_SESSION_TTL_MS')).toISOString();
    await db.run(UPDATE.entity(WalletSessions).set({ expiresAt }).where({ sessionId: { in: [...sponsors] } }));
}

export function startSessionCleanup(db: DbRunner): ReturnType<typeof setInterval> {
    const SESSION_CLEANUP_INTERVAL = 15 * 60 * 1000;
    const firstConfig = getNightgateConfig();
    extendSponsorSessions(db, getConfiguredFeeSponsorSessions(firstConfig))
        .catch(err => cds.log('nightgate').warn(`Sponsor session expiry not extended: ${errorMessage(err)}`));
    const timer = setInterval(async () => {
        try {
            const now = new Date().toISOString();
            // Platform fee sponsors never expire, so they are never closed or wiped.
            const config = getNightgateConfig();
            const sponsors = getConfiguredFeeSponsorSessions(config);
            await extendSponsorSessions(db, sponsors);
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
