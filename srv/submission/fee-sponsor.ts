/**
 * Resolves and guards the fee-sponsor session (main thread). Cross-user
 * sponsoring only for platform-listed sessions: otherwise a guessed or leaked
 * session id could drain a foreign wallet's dust.
 */

import cds from '@sap/cds';
const { SELECT } = cds.ql;
import { WalletSessions } from '#cds-models/midnight';
import { decrypt, getEncryptionKey } from '../utils/crypto';
import { walletSessionViewingKeyBinding, walletSessionSeedBinding } from '../utils/envelope-bindings';
import { deriveAccountId, deriveStoragePassword } from './wallet-material-factory';
import { getOrBuildWalletFacade, type WalletFacadeBuildArgs } from './wallet-facade-builder';
import { walletWaitForSyncedState } from '../midnight/wallet-worker-client';

/**
 * Per-sponsor sync-to-tip wait during prewarm (0 = build only). Sequential,
 * because all facades share one worker thread and parallel catch-up starves each.
 */
export function prewarmSyncBudgetMs(env: NodeJS.ProcessEnv = process.env): number {
    return configNumberFrom('NIGHTGATE_SPONSOR_PREWARM_SYNC_MS', env);
}

/** Carries the OData status the handlers reject with. */
export class FeeSponsorError extends Error {
    constructor(public readonly httpStatus: number, message: string) {
        super(message);
        this.name = 'FeeSponsorError';
    }
}

export interface ResolvedFeeSponsor {
    /** The OData session id the caller passed (audit surface). */
    sponsorSessionId: string;
    /** Worker facade key derived from the sponsor's viewing key. */
    accountId: string;
    /** Decrypted BIP39 seed hex; needed to (re)initialise the facade. */
    seedHex: string;
    /** Sync-state passphrase derived from the sponsor's viewing key. */
    syncStatePassphrase: string;
    /** BIP32 account level the sponsor seed signs with (WalletSessions.accountIndex). */
    accountIndex: number;
}

/** Re-export; lives in session-expiry.ts so modules below this one can use it. */
export { getConfiguredFeeSponsorSessions } from '../utils/session-expiry';
import { getConfiguredFeeSponsorSessions, isSessionExpired } from '../utils/session-expiry';
import { configNumberFrom } from '../utils/config';
import { noteSponsorAccount } from './sponsor-sync-gate';

export interface ResolveFeeSponsorOptions {
    db: any;
    sponsorSessionId: string;
    /** Required unless the sponsor id is platform-listed. */
    requestingUserId?: string;
    config?: Record<string, any>;
    /** Test seam; defaults to the process-scoped key from srv/utils/crypto.ts. */
    encryptionKey?: Buffer;
}

/** Loads, authorises and decrypts the sponsor session; never leaks whether a foreign id exists. */
export async function resolveFeeSponsor(opts: ResolveFeeSponsorOptions): Promise<ResolvedFeeSponsor> {
    const platformSponsors = getConfiguredFeeSponsorSessions(opts.config);
    const isPlatformSponsor = platformSponsors.includes(opts.sponsorSessionId);

    const where: Record<string, unknown> = { sessionId: opts.sponsorSessionId, isActive: true };
    if (!isPlatformSponsor) {
        // Scoped to the caller, so a foreign id reads back as not-found.
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

/** Idempotent: builds the sponsor's worker facade before a sponsored submission. */
export async function ensureFeeSponsorFacade(
    sponsor: ResolvedFeeSponsor,
    facadeConfig: Omit<WalletFacadeBuildArgs, 'seedHex' | 'syncStatePassphrase'>
): Promise<void> {
    // accountIndex AFTER the spread: facadeConfig may carry the CALLING
    // session's account; the sponsor facade must derive the sponsor's own.
    await getOrBuildWalletFacade(sponsor.accountId, {
        ...facadeConfig,
        seedHex: sponsor.seedHex,
        syncStatePassphrase: sponsor.syncStatePassphrase,
        accountIndex: sponsor.accountIndex
    });
}

/**
 * Warm the platform sponsor pool after boot, one facade at a time (one worker
 * thread). A failing sponsor is logged and skipped; pool failover covers it.
 */
export async function prewarmFeeSponsorPool(opts: {
    db: any;
    config?: Record<string, any>;
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
