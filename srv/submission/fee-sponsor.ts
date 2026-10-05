/**
 * Loads and checks the wallet session that pays fees for other users.
 * Only sessions listed in the platform config may pay for other users.
 * Otherwise a guessed or leaked session id could spend someone else's dust.
 */

import type { NightgatePluginConfig } from '../utils/nightgate-config';
import cds from '@sap/cds';
const { SELECT } = cds.ql;
import { WalletSessions } from '#cds-models/midnight';
import { decrypt, getEncryptionKey } from '../utils/crypto';
import { walletSessionViewingKeyBinding, walletSessionSeedBinding } from '../utils/envelope-bindings';
import { deriveAccountId, deriveStoragePassword } from './wallet-material-factory';
import { getOrBuildWalletFacade, type WalletFacadeBuildArgs } from './wallet-facade-builder';
import { walletWaitForSyncedState } from '../midnight/wallet-worker-client';
import { NightgateError } from '../utils/errors';

/**
 * How long startup waits for each sponsor wallet to sync to the chain tip. 0 means build only.
 * Sponsors sync one after another, because all wallets share one worker thread.
 */
export function prewarmSyncBudgetMs(env: NodeJS.ProcessEnv = process.env): number {
    return configNumberFrom('NIGHTGATE_SPONSOR_PREWARM_SYNC_MS', env);
}

export class FeeSponsorError extends NightgateError {
    constructor(status: number, message: string) {
        super('FEE_SPONSOR_UNUSABLE', message, { status });
    }
    /** @deprecated use `status`. */
    get httpStatus(): number { return this.status; }
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
import { configNumberFrom } from '../utils/config';
import { noteSponsorAccount } from './sponsor-sync-gate';
import type { DbRunner } from '../utils/db-types';

export interface ResolveFeeSponsorOptions {
    db: DbRunner;
    sponsorSessionId: string;
    /** Required unless the sponsor is listed in the platform config. */
    requestingUserId?: string;
    config?: NightgatePluginConfig;
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
            'Use one of your own sessions, or a session listed in NIGHTGATE_FEE_SPONSOR_SESSION.');
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
        throw new FeeSponsorError(500, 'Failed to decrypt sponsor session keys (ENCRYPTION_KEY mismatch?)');
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
    // Set accountIndex after the spread. facadeConfig may hold the caller's account,
    // but the sponsor wallet must use the sponsor's own.
    await getOrBuildWalletFacade(sponsor.accountId, {
        ...facadeConfig,
        seedHex: sponsor.seedHex,
        syncStatePassphrase: sponsor.syncStatePassphrase,
        accountIndex: sponsor.accountIndex
    });
}

/**
 * Starts the platform sponsor wallets after boot, one at a time.
 * A failing sponsor is logged and skipped. The pool then uses the other sponsors.
 */
export async function prewarmFeeSponsorPool(opts: {
    db: DbRunner;
    config?: NightgatePluginConfig;
    facadeConfig: Omit<WalletFacadeBuildArgs, 'seedHex' | 'syncStatePassphrase'>;
    log?: { info: (m: string) => void; warn: (m: string) => void };
    encryptionKey?: Buffer;
    /** Defaults to `prewarmSyncBudgetMs()`. */
    syncBudgetMs?: number;
}): Promise<{ warmed: string[]; failed: string[] }> {
    const pool = getConfiguredFeeSponsorSessions(opts.config);
    const warmed: string[] = [];
    const failed: string[] = [];
    for (const sponsorSessionId of pool) {
        const started = Date.now();
        try {
            const sponsor = await resolveFeeSponsor({ db: opts.db, sponsorSessionId, config: opts.config, encryptionKey: opts.encryptionKey });
            await ensureFeeSponsorFacade(sponsor, opts.facadeConfig);
            warmed.push(sponsorSessionId);
            opts.log?.info(`sponsor pool prewarm: ${sponsorSessionId.slice(0, 8)} facade ready in ${Math.round((Date.now() - started) / 1000)}s`);
            const syncBudget = opts.syncBudgetMs ?? prewarmSyncBudgetMs();
            if (syncBudget > 0) {
                try {
                    await walletWaitForSyncedState(sponsor.accountId, syncBudget);
                    opts.log?.info(`sponsor pool prewarm: ${sponsorSessionId.slice(0, 8)} at tip after ${Math.round((Date.now() - started) / 1000)}s; next sponsor`);
                } catch (err) {
                    opts.log?.warn(`sponsor pool prewarm: ${sponsorSessionId.slice(0, 8)} not at tip within ${Math.round(syncBudget / 1000)}s (${err instanceof Error ? err.message : String(err)}); it keeps catching up, the pool fails over to a synced member`);
                }
            }
        } catch (err) {
            failed.push(sponsorSessionId);
            opts.log?.warn(`sponsor pool prewarm: ${sponsorSessionId.slice(0, 8)} failed (${err instanceof Error ? err.message : String(err)}); the pool fails over at use time`);
        }
    }
    return { warmed, failed };
}
