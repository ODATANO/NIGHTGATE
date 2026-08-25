/**
 * Per-transaction fee sponsoring (dust sponsorship), main-thread side.
 *
 * An optional `sponsorSessionId` lets a SECOND wallet session pay the dust fee
 * for a tx the calling session builds and signs. The worker splits balancing:
 * caller balances shielded/unshielded and signs, sponsor balances only ['dust']
 * and submits (see buildSponsoredWalletProvider in srv/midnight/wallet-worker.ts).
 *
 * This module resolves and GUARDS the sponsor session:
 *   - Same-user sponsoring is always allowed (both sessions are the caller's).
 *   - Cross-user sponsoring (one funded platform wallet paying for many tenants)
 *     must be explicitly enabled by listing the sponsor session id(s) in
 *     NIGHTGATE_FEE_SPONSOR_SESSION (comma separated) or cds config
 *     `feeSponsorSessions`. Without this guard any caller could drain an
 *     arbitrary wallet's dust with a guessed/leaked session id.
 *
 * The sponsor session must be signing-capable (encryptedSeedKey present): paying
 * dust needs the sponsor's dust secret key in the worker facade.
 */

import cds from '@sap/cds';
const { SELECT } = cds.ql;
import { WalletSessions } from '#cds-models/midnight';
import { decrypt, getEncryptionKey } from '../utils/crypto';
import { deriveAccountId, deriveStoragePassword } from './wallet-material-factory';
import { getOrBuildWalletFacade, type WalletFacadeBuildArgs } from './wallet-facade-builder';

/**
 * Typed error with the OData status the handlers should reject with.
 * Mapped in handlers.ts runSubmission and in the wallet-sessions handler.
 */
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

/**
 * Session ids that any authenticated caller may use as fee sponsor.
 *
 * Lives in srv/utils/session-expiry.ts, because the expiry rule that depends on
 * it has to be callable from modules below this one (wallet-material-factory,
 * which this module imports). Re-exported here so every existing caller keeps
 * its import.
 */
export { getConfiguredFeeSponsorSessions } from '../utils/session-expiry';
import { getConfiguredFeeSponsorSessions, isSessionExpired } from '../utils/session-expiry';

export interface ResolveFeeSponsorOptions {
    /** DB handle (tests inject a minimal `{ run }`). */
    db: any;
    sponsorSessionId: string;
    /** Authenticated caller (req.user.id). Required unless the sponsor id is platform-listed. */
    requestingUserId?: string;
    /** Plugin config for the platform-sponsor list. */
    config?: Record<string, any>;
    /** Test seam; defaults to the process-scoped key from srv/utils/crypto.ts. */
    encryptionKey?: Buffer;
}

/**
 * Loads, authorises, and decrypts the sponsor session. Throws FeeSponsorError
 * with a proper status; never leaks whether a foreign (non-platform) session
 * id exists.
 */
export async function resolveFeeSponsor(opts: ResolveFeeSponsorOptions): Promise<ResolvedFeeSponsor> {
    const platformSponsors = getConfiguredFeeSponsorSessions(opts.config);
    const isPlatformSponsor = platformSponsors.includes(opts.sponsorSessionId);

    const where: Record<string, unknown> = { sessionId: opts.sponsorSessionId, isActive: true };
    if (!isPlatformSponsor) {
        // Same-user constraint: scope the lookup to the caller so a foreign
        // session id reads back as not-found (non-leaking).
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
    // A CONFIGURED platform sponsor does not expire while it is configured:
    // it is infrastructure, not a caller's session. (The cleanup sweep skips
    // it for the same reason; otherwise the pool silently died 24 h after it
    // was set up and the sweep even wiped its key material: live 2026-08-19.)
    // The rule itself now lives in one place, so every other read of the same
    // session agrees with this one.
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
        viewingKey = decrypt(session.encryptedViewingKey, encKey);
        seedHex = decrypt(session.encryptedSeedKey, encKey);
    } catch {
        throw new FeeSponsorError(500, 'Failed to decrypt sponsor session keys (ENCRYPTION_KEY mismatch?)');
    }

    return {
        sponsorSessionId: opts.sponsorSessionId,
        accountId: deriveAccountId(viewingKey),
        seedHex,
        syncStatePassphrase: deriveStoragePassword(viewingKey),
        accountIndex: session.accountIndex ?? 0
    };
}

/**
 * Makes sure the sponsor's facade exists in the wallet worker before a
 * sponsored submission dispatches. Idempotent (worker-side cache hit when the
 * sponsor session was already prewarmed via connectWalletForSigning).
 */
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
 * Warm the configured platform sponsor pool right after boot, one facade at a
 * time (facade restores are CPU-bound on the single wallet worker thread, so
 * parallel warm-ups only slow each other down). Fire-and-forget from the
 * plugin's init: a sponsor that fails to warm is logged and skipped, the pool
 * failover covers it at use time. Without this, the first sponsored job after
 * a restart pays for the cold restore of a sponsor that may have been warm
 * for days (live: 6 min restore + catch-up on a pool member whose stored
 * state was 20 h old, with every other job queued behind it).
 */
export async function prewarmFeeSponsorPool(opts: {
    db: any;
    config?: Record<string, any>;
    facadeConfig: Omit<WalletFacadeBuildArgs, 'seedHex' | 'syncStatePassphrase'>;
    log?: { info: (m: string) => void; warn: (m: string) => void };
    /** Test seam; defaults to the process-scoped key. */
    encryptionKey?: Buffer;
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
        } catch (err) {
            failed.push(sponsorSessionId);
            opts.log?.warn(`sponsor pool prewarm: ${sponsorSessionId.slice(0, 8)} failed (${err instanceof Error ? err.message : String(err)}); the pool fails over at use time`);
        }
    }
    return { warmed, failed };
}
