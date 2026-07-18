/**
 * Per-transaction fee sponsoring (dust sponsorship), main-thread side.
 *
 * An optional `sponsorSessionId` on the submission actions lets a SECOND
 * wallet session pay the dust fee for a transaction the calling session
 * builds and signs. The wallet worker splits balancing into two phases:
 * the caller balances shielded/unshielded and signs, the sponsor balances
 * ONLY ['dust'] and submits (see buildSponsoredWalletProvider in
 * srv/midnight/wallet-worker.ts).
 *
 * This module resolves and GUARDS the sponsor session:
 *
 *   - A caller may always sponsor from a session that belongs to the SAME
 *     authenticated user (both sessions are theirs).
 *   - Cross-user sponsoring (the platform-sponsor model: one funded wallet
 *     pays for many tenants) must be explicitly enabled by the operator by
 *     listing the sponsor session id(s) in NIGHTGATE_FEE_SPONSOR_SESSION
 *     (comma separated) or cds config `feeSponsorSessions`. Without this
 *     guard any caller could drain an arbitrary wallet's dust by guessing
 *     or leaking its session id.
 *
 * The sponsor session must be signing-capable (encryptedSeedKey present):
 * paying dust requires the sponsor's dust secret key in the worker facade.
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
}

/**
 * Session ids that any authenticated caller may use as fee sponsor.
 * Env NIGHTGATE_FEE_SPONSOR_SESSION wins over cds config `feeSponsorSessions`
 * (string, comma separated, or array of strings).
 */
export function getConfiguredFeeSponsorSessions(config?: Record<string, any>): string[] {
    const fromEnv = process.env.NIGHTGATE_FEE_SPONSOR_SESSION?.trim();
    const fromConfig = Array.isArray(config?.feeSponsorSessions)
        ? config!.feeSponsorSessions.join(',')
        : config?.feeSponsorSessions;
    const raw = fromEnv || fromConfig;
    if (!raw || typeof raw !== 'string') return [];
    return raw.split(',').map(s => s.trim()).filter(Boolean);
}

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
    if (session.expiresAt && new Date(session.expiresAt) < new Date()) {
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
        syncStatePassphrase: deriveStoragePassword(viewingKey)
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
    await getOrBuildWalletFacade(sponsor.accountId, {
        ...facadeConfig,
        seedHex: sponsor.seedHex,
        syncStatePassphrase: sponsor.syncStatePassphrase
    });
}
