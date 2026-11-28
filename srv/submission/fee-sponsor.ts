// Loads and checks the wallet session that pays fees for other users.
// Only sessions listed in the platform config may do that, so a guessed or leaked session id cannot spend someone else's dust.

import type { NightgateConfig } from '../utils/nightgate-config';
import cds from '@sap/cds';
const { SELECT } = cds.ql;
import { WalletSessions } from '#cds-models/midnight';
import { decrypt, getEncryptionKey } from '../utils/crypto';
import { walletSessionViewingKeyBinding, walletSessionSeedBinding } from '../utils/envelope-bindings';
import { deriveAccountId, deriveStoragePassword } from './wallet-material-factory';
import { getOrBuildWalletFacade, type WalletFacadeBuildArgs } from './wallet-facade-builder';
import { assignDedicatedWorker, onWorkerGone, walletWaitForSyncedState, walletWorkerPoolConfig, workerIdFor } from '../midnight/wallet-worker-client';
import { NightgateError, errorMessage, type ERROR_CODES } from '../utils/errors';
import { publishPrewarmState } from '../utils/runtime-state';

/**
 * How long startup waits for each sponsor wallet to sync to the chain tip; 0 means build only. Sponsors sync one at a time, because all wallets share one worker thread.
 */
export function prewarmSyncBudgetMs(env: NodeJS.ProcessEnv = process.env): number {
    return configNumberFrom('NIGHTGATE_SPONSOR_PREWARM_SYNC_MS', env);
}

/** The statuses the table lists for the code. A fault of the server itself is no refusal of the sponsor. */
type FeeSponsorStatus = (typeof ERROR_CODES)['FEE_SPONSOR_UNUSABLE']['statuses'][number];

export class FeeSponsorError extends NightgateError {
    constructor(status: FeeSponsorStatus, message: string) {
        super('FEE_SPONSOR_UNUSABLE', message, { status });
    }
}

export interface ResolvedFeeSponsor {
    sponsorSessionId: string;
    /** Key of the sponsor's wallet in the worker, derived from its viewing key. */
    accountId: string;
    /** Decrypted BIP39 seed in hex. Needed to build the wallet in the worker. */
    seedHex: string;
    /** Sync-state passphrase derived from the sponsor's viewing key. */
    syncStatePassphrase: string;
    /** BIP32 account index the sponsor seed signs with, from WalletSessions.accountIndex. */
    accountIndex: number;
}

/** Re-exported. It lives in session-expiry.ts so lower-level modules can import it too. */
export { getConfiguredFeeSponsorSessions } from '../utils/session-expiry';
import { getConfiguredFeeSponsorSessions, isSessionExpired } from '../utils/session-expiry';
import { configMs, configNumberFrom } from '../utils/config';
import { noteSponsorAccount, sponsorAccountOf } from './sponsor-sync-gate';
import type { DbRunner } from '../utils/db-types';

export interface ResolveFeeSponsorOptions {
    db: DbRunner;
    sponsorSessionId: string;
    /** Required unless the sponsor is listed in the platform config. */
    requestingUserId?: string;
    config?: NightgateConfig;
    /** For tests. Defaults to the process key from srv/utils/crypto.ts. */
    encryptionKey?: Buffer;
}

/** Loads, authorizes and decrypts the sponsor session. Never reveals whether another user's session id exists. */
export async function resolveFeeSponsor(opts: ResolveFeeSponsorOptions): Promise<ResolvedFeeSponsor> {
    const platformSponsors = getConfiguredFeeSponsorSessions(opts.config);
    const isPlatformSponsor = platformSponsors.includes(opts.sponsorSessionId);

    const where: Record<string, unknown> = { sessionId: opts.sponsorSessionId, isActive: true };
    if (!isPlatformSponsor) {
        // Only the caller's own sessions are found, so another user's id looks like not found.
        if (!opts.requestingUserId) {
            throw new FeeSponsorError(403, 'sponsorSessionId requires an authenticated caller');
        }
        where.userId = opts.requestingUserId;
    }

    const session = await opts.db.run(SELECT.one.from(WalletSessions).where(where));
    if (!session) {
        throw new FeeSponsorError(404,
            'Sponsor session not found, inactive, or not usable by this caller. ' +
            'Use one of your own sessions, or a session listed in NIGHTGATE_FEE_SPONSOR_SESSIONS.');
    }
    if (isSessionExpired(opts.sponsorSessionId, session.expiresAt, opts.config)) {
        throw new FeeSponsorError(410, 'Sponsor session expired');
    }
    if (!session.encryptedViewingKey) {
        throw new FeeSponsorError(404, 'Sponsor session has no viewing key');
    }
    if (!session.encryptedSeedKey) {
        throw new FeeSponsorError(412,
            'Sponsor session has no signing key. Call connectWalletForSigning for the sponsor session first.');
    }

    const encKey = opts.encryptionKey ?? getEncryptionKey();
    let viewingKey: string;
    let seedHex: string;
    try {
        viewingKey = decrypt(session.encryptedViewingKey, encKey, walletSessionViewingKeyBinding(session.sessionId));
        seedHex = decrypt(session.encryptedSeedKey, encKey, walletSessionSeedBinding(session.sessionId));
    } catch {
        throw new NightgateError('INTERNAL', 'Failed to decrypt sponsor session keys (ENCRYPTION_KEY mismatch?)');
    }

    const accountId = deriveAccountId(viewingKey);
    noteSponsorAccount(opts.sponsorSessionId, accountId);
    return {
        sponsorSessionId: opts.sponsorSessionId,
        accountId,
        seedHex,
        syncStatePassphrase: deriveStoragePassword(viewingKey),
        accountIndex: session.accountIndex ?? 0
    };
}

/** Builds the sponsor's wallet in the worker before a sponsored submission. Safe to call again. */
export async function ensureFeeSponsorFacade(
    sponsor: ResolvedFeeSponsor,
    facadeConfig: Omit<WalletFacadeBuildArgs, 'seedHex' | 'syncStatePassphrase'>
): Promise<void> {
    assignDedicatedWorker(sponsor.accountId);
    // Set accountIndex after the spread. facadeConfig may hold the caller's account,
    // but the sponsor wallet must use the sponsor's own.
    await getOrBuildWalletFacade(sponsor.accountId, {
        ...facadeConfig,
        seedHex: sponsor.seedHex,
        syncStatePassphrase: sponsor.syncStatePassphrase,
        accountIndex: sponsor.accountIndex
    });
}

interface PrewarmOptions {
    db: DbRunner;
    config?: NightgateConfig;
    facadeConfig: Omit<WalletFacadeBuildArgs, 'seedHex' | 'syncStatePassphrase'>;
    log?: { info: (m: string) => void; warn: (m: string) => void };
    encryptionKey?: Buffer;
    /** Defaults to `prewarmSyncBudgetMs()`. */
    syncBudgetMs?: number;
}

/** Loads one pool sponsor and waits for it to reach the tip. False when the wallet could not be loaded. */
async function warmFeeSponsor(sponsorSessionId: string, opts: PrewarmOptions, label: string): Promise<boolean> {
    const started = Date.now();
    try {
        const sponsor = await resolveFeeSponsor({ db: opts.db, sponsorSessionId, config: opts.config, encryptionKey: opts.encryptionKey });
        await ensureFeeSponsorFacade(sponsor, opts.facadeConfig);
        opts.log?.info(`${label}: ${sponsorSessionId.slice(0, 8)} facade ready in ${Math.round((Date.now() - started) / 1000)}s`);
        const syncBudget = opts.syncBudgetMs ?? prewarmSyncBudgetMs();
        if (syncBudget > 0) {
            try {
                await walletWaitForSyncedState(sponsor.accountId, syncBudget);
                opts.log?.info(`${label}: ${sponsorSessionId.slice(0, 8)} at tip after ${Math.round((Date.now() - started) / 1000)}s; next sponsor`);
            } catch (err) {
                opts.log?.warn(`${label}: ${sponsorSessionId.slice(0, 8)} not at tip within ${Math.round(syncBudget / 1000)}s (${errorMessage(err)}); it keeps catching up, the pool fails over to a synced member`);
            }
        }
        return true;
    } catch (err) {
        opts.log?.warn(`${label}: ${sponsorSessionId.slice(0, 8)} failed (${errorMessage(err)}); the pool fails over at use time`);
        return false;
    }
}

// Starts the platform sponsor wallets after boot. In a shared worker they start one at a time, because they would starve each other.
// With a worker per sponsor they start side by side. A failing sponsor is logged and skipped, and the pool uses the others.
export async function prewarmFeeSponsorPool(opts: PrewarmOptions): Promise<{ warmed: string[]; failed: string[] }> {
    const pool = getConfiguredFeeSponsorSessions(opts.config);
    const warmed: string[] = [];
    const failed: string[] = [];
    const startedAt = new Date().toISOString();
    const publish = (running: boolean) => publishPrewarmState({
        running, total: pool.length, warmed: warmed.length, failed: failed.length,
        startedAt, finishedAt: running ? null : new Date().toISOString()
    });
    publish(pool.length > 0);
    const warmOne = async (sponsorSessionId: string): Promise<void> => {
        (await warmFeeSponsor(sponsorSessionId, opts, 'sponsor pool prewarm') ? warmed : failed).push(sponsorSessionId);
        publish(true);
    };
    if (walletWorkerPoolConfig().sponsorWorkers === 'dedicated') {
        await Promise.all(pool.map(warmOne));
    } else {
        for (const sponsorSessionId of pool) await warmOne(sponsorSessionId);
    }
    publish(false);
    return { warmed, failed };
}

const REWARM_MAX_DELAY_MS = 10 * 60_000;

/** Loads the pool sponsors of a worker that exited again, so the next sponsored job finds them warm. Returns the stop function. */
export function rewarmSponsorsAfterWorkerExit(opts: PrewarmOptions & { delayMs?: number }): () => void {
    const delayMs = opts.delayMs ?? configMs('NIGHTGATE_SPONSOR_REWARM_DELAY_MS');
    const timers = new Set<NodeJS.Timeout>();
    const queued = new Set<string>();
    let stopped = false;
    const schedule = (ids: string[], waitMs: number): void => {
        const timer = setTimeout(() => {
            timers.delete(timer);
            void (async () => {
                const retry: string[] = [];
                for (const id of ids) {
                    if (stopped) return;
                    if (await warmFeeSponsor(id, opts, 'sponsor rewarm')) queued.delete(id);
                    else retry.push(id);
                }
                if (retry.length > 0 && !stopped) schedule(retry, Math.min(Math.max(waitMs, 1_000) * 2, REWARM_MAX_DELAY_MS));
            })();
        }, waitMs);
        timer.unref();
        timers.add(timer);
    };
    const off = onWorkerGone((reason, info) => {
        if (reason !== 'exit' || stopped) return;
        // A sponsor never loaded has no account yet. It was not in the worker, and a job loads it.
        const ids = getConfiguredFeeSponsorSessions(opts.config).filter(id => {
            const accountId = sponsorAccountOf(id);
            return !!accountId && workerIdFor(accountId) === info.workerId && !queued.has(id);
        });
        if (ids.length === 0) return;
        for (const id of ids) queued.add(id);
        opts.log?.warn(`worker ${info.workerId} exited; loading ${ids.length} pool sponsor(s) again in ${Math.round(delayMs / 1000)}s`);
        schedule(ids, delayMs);
    });
    return () => {
        stopped = true;
        off();
        for (const t of timers) clearTimeout(t);
        timers.clear();
    };
}
