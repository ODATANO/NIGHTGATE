/**
 * Resolves a WalletSessions row into WalletMaterial. accountId and storage passwords are
 * deterministic per viewing key, so reconnects find the same encrypted state.
 */

import cds from '@sap/cds';
const { SELECT } = cds.ql;
import { WalletSessions } from '#cds-models/midnight';
import crypto from 'crypto';
import { decrypt, getEncryptionKey, deriveBoundSecret, KeyRing } from '../utils/crypto';
import { walletSessionViewingKeyBinding, walletSessionSeedBinding } from '../utils/envelope-bindings';
import { resolveAccountDek, privateStatePasswordFromDek } from './account-keys';
import { loadLedgerV8 } from '../midnight/sdk-loader';
import { deriveRoleSeeds, type RoleSeeds } from '../utils/wallet-hd';
import { deriveAttesterId } from '../utils/wallet-info';
import { isSessionExpired } from '../utils/session-expiry';
import { getOrBuildWalletFacade, type WalletFacadeBuildArgs } from './wallet-facade-builder';
import type { WalletMaterial, PrivateStateBackend } from '../midnight/providers';

// ---- Errors ---------------------------------------------------------------

export class SessionNotFoundError extends Error {
    constructor(sessionId: string) {
        super(`Session '${sessionId}' not found, expired, or inactive`);
        this.name = 'SessionNotFoundError';
    }
}

/** Thrown by the adapter's signing methods (not by the factory) for a viewing-key-only session. */
export class WalletSigningNotAvailable extends Error {
    constructor(method: string) {
        super(
            `Wallet signing surface not available for ${method}: session carries a viewing key only. ` +
            `Signing requires the encryptedSeedKey field on WalletSessions to be populated.`
        );
        this.name = 'WalletSigningNotAvailable';
    }
}

// Not thrown by the factory; exported for the handlers' 501 mapping.
export class WalletMaterialUnavailable extends Error {
    constructor(reason: string) {
        super(`Wallet material unavailable: ${reason}.`);
        this.name = 'WalletMaterialUnavailable';
    }
}

// ---- Public API -----------------------------------------------------------

export interface BuildWalletMaterialOptions {
    sessionId: string;
    /** Owning principal; scopes the session load, a mismatch reads as SessionNotFound. */
    expectedUserId?: string;
    privateStateBackend?: PrivateStateBackend;
    /** Test seam; defaults to cds.connect.to('db'). */
    db?: any;
    /** Test seam; defaults to the process-scoped key from srv/utils/crypto.ts. */
    encryptionKey?: Buffer;
    /** With a seed session: makes the worker facade buildable. Without it only public keys are real. */
    facadeConfig?: Omit<WalletFacadeBuildArgs, 'seedHex'>;
}

const ACCOUNT_ID_LABEL = 'nightgate-account-id-v1';
const PRIVATE_STATE_PASSWORD_LABEL = 'nightgate-private-state-password-v1';

/** Resolves a session into a `WalletMaterial` (adapter shape depends on whether the session carries a seed). */
export async function buildWalletMaterialForSession(opts: BuildWalletMaterialOptions): Promise<WalletMaterial> {
    const db = opts.db ?? await cds.connect.to('db');
    const where: Record<string, unknown> = { sessionId: opts.sessionId, isActive: true };
    if (opts.expectedUserId) where.userId = opts.expectedUserId;
    const session = await db.run(
        SELECT.one.from(WalletSessions).where(where)
    );
    if (!session) throw new SessionNotFoundError(opts.sessionId);
    if (isSessionExpired(opts.sessionId, session.expiresAt)) {
        throw new SessionNotFoundError(opts.sessionId);
    }
    if (!session.encryptedViewingKey) {
        throw new SessionNotFoundError(opts.sessionId);
    }

    const encKey = opts.encryptionKey ?? getEncryptionKey();
    let viewingKey: string;
    try {
        viewingKey = decrypt(session.encryptedViewingKey, encKey, walletSessionViewingKeyBinding(session.sessionId));
    } catch (err) {
        throw new SessionNotFoundError(opts.sessionId);
    }

    const accountId = deriveAccountId(viewingKey);
    // The DEK is created here on first need; pre-DEK rows are read through the legacy
    // passwords and rewritten under the DEK by the provider.
    const ring = encKey instanceof KeyRing ? encKey : Buffer.isBuffer(encKey) ? KeyRing.fromKek(encKey) : getEncryptionKey();
    const storagePassword = deriveStoragePassword(viewingKey);
    const dek = await resolveAccountDek({ db, ring, accountId, storagePassword });
    if (!dek) throw new SessionNotFoundError(opts.sessionId);
    const password = privateStatePasswordFromDek(dek, accountId);
    const legacyPasswords = privateStatePasswordCandidates(ring, viewingKey).map(c => c.password);
    // The sync-state store resolves the DEK itself, from the viewing-key form.
    const syncStatePassphrase = storagePassword;
    // From the session row, never caller input: must match the viewing key's account.
    const accountIndex = session.accountIndex ?? 0;

    let walletAndMidnightProvider: any;
    let ensureFacade: (() => Promise<void>) | undefined;
    if (session.encryptedSeedKey) {
        let seedHex: string;
        try {
            seedHex = decrypt(session.encryptedSeedKey, encKey, walletSessionSeedBinding(session.sessionId));
        } catch {
            throw new SessionNotFoundError(opts.sessionId);
        }
        if (opts.facadeConfig) {
            walletAndMidnightProvider = await createFacadeBackedWalletAdapter(
                accountId,
                seedHex,
                { ...opts.facadeConfig, syncStatePassphrase, accountIndex }
            );
            // A never-prewarmed or evicted session builds its facade on demand.
            const facadeArgs = { ...opts.facadeConfig, seedHex, syncStatePassphrase, accountIndex };
            ensureFacade = async () => { await getOrBuildWalletFacade(accountId, facadeArgs); };
        } else {
            walletAndMidnightProvider = await createSigningCapableWalletAdapter(seedHex, accountIndex);
        }
    } else {
        walletAndMidnightProvider = createReadOnlyWalletAdapter();
    }

    return {
        accountId,
        privateStoragePasswordProvider: () => password,
        privateStoragePasswordFallbacks: () => legacyPasswords,
        walletAndMidnightProvider,
        privateStateBackend: opts.privateStateBackend,
        ensureFacade
    };
}

// ---- Determinism helpers --------------------------------------------------

/** Opaque storage scope, deterministic per viewing key (HMAC-SHA256, domain-separated). */
export function deriveAccountId(viewingKey: string): string {
    return crypto.createHmac('sha256', ACCOUNT_ID_LABEL).update(viewingKey).digest('hex');
}

/** Viewing-key-derived storage password; its own label, so it never equals the accountId. */
export function deriveStoragePassword(viewingKey: string): string {
    return crypto.createHmac('sha256', PRIVATE_STATE_PASSWORD_LABEL).update(viewingKey).digest('hex');
}

const PRIVATE_STATE_INFO = 'nightgate/private-state/v2';

/** Legacy (pre-DEK, read-only) private-state password under ring key `keyId`. */
export function derivePrivateStatePassword(ring: KeyRing, keyId: string, viewingKey: string): string {
    return deriveBoundSecret(ring, keyId, deriveStoragePassword(viewingKey), PRIVATE_STATE_INFO).toString('hex');
}

/** Read-only legacy private-state passwords (ring keys, active first, then pre-ring); shared with the rewrap tool. */
export function privateStatePasswordCandidates(ring: KeyRing, viewingKey: string): Array<{ keyId: string | null; password: string; legacy: boolean }> {
    const out = [ring.activeId, ...ring.ids().filter(i => i !== ring.activeId)].map(id => ({
        keyId: id as string | null, password: derivePrivateStatePassword(ring, id, viewingKey), legacy: false
    }));
    out.push({ keyId: null, password: deriveStoragePassword(viewingKey), legacy: true });
    return out;
}

// ---- Wallet adapter -------------------------------------------------------

/** Adapter for viewing-key-only sessions: every method throws. */
function createReadOnlyWalletAdapter(): any {
    return {
        getCoinPublicKey(): never        { throw new WalletSigningNotAvailable('getCoinPublicKey()'); },
        getEncryptionPublicKey(): never  { throw new WalletSigningNotAvailable('getEncryptionPublicKey()'); },
        async balanceTx(_tx: any, _ttl?: any): Promise<any> { throw new WalletSigningNotAvailable('balanceTx()'); },
        async submitTx(_tx: any): Promise<any>             { throw new WalletSigningNotAvailable('submitTx()'); }
    };
}

/** Carries the real public keys into the provider bundle; balancing and submission run in the worker. */
async function createFacadeBackedWalletAdapter(
    accountId: string,
    seedHex: string,
    facadeConfig: Omit<WalletFacadeBuildArgs, 'seedHex'>
): Promise<any> {
    if (!/^[0-9a-fA-F]{128}$/.test(seedHex)) {
        throw new Error('Invalid seed: must be 128 hex characters (64-byte BIP39 seed)');
    }

    // Eager: the WalletProvider key getters are synchronous. Keys come from the Zswap HD role, not the raw seed.
    const bip39Seed = new Uint8Array(Buffer.from(seedHex, 'hex'));
    const roleSeeds = await deriveRoleSeeds(bip39Seed, facadeConfig.accountIndex ?? 0);
    const ledger = await loadLedgerV8();
    const zswapKeys = ledger.ZswapSecretKeys.fromSeed(roleSeeds.zswap);
    const coinPublicKey       = zswapKeys.coinPublicKey;
    const encryptionPublicKey = zswapKeys.encryptionPublicKey;

    return {
        getCoinPublicKey(): string         { return coinPublicKey; },
        getEncryptionPublicKey(): string   { return encryptionPublicKey; },
        async balanceTx(): Promise<never> {
            throw new Error('balanceTx is not available on the main thread; transactions are balanced in the wallet worker');
        },
        async submitTx(): Promise<never> {
            throw new Error('submitTx is not available on the main thread; transactions are submitted in the wallet worker');
        },
        _internal: { zswapKeys, cacheKey: accountId }
    };
}

/** Adapter for a seed session without a facade config: real public keys, signing throws. */
async function createSigningCapableWalletAdapter(seedHex: string, accountIndex: number = 0): Promise<any> {
    if (!/^[0-9a-fA-F]{128}$/.test(seedHex)) {
        throw new Error('Invalid seed: must be 128 hex characters (64-byte BIP39 seed)');
    }

    const bip39Seed = new Uint8Array(Buffer.from(seedHex, 'hex'));
    const roleSeeds = await deriveRoleSeeds(bip39Seed, accountIndex);
    const ledger = await loadLedgerV8();

    // Each key type from its own HD role (wallet-hd.ts).
    const zswapKeys = ledger.ZswapSecretKeys.fromSeed(roleSeeds.zswap);
    const dustKey   = ledger.DustSecretKey.fromSeed(roleSeeds.dust);

    const coinPublicKey       = zswapKeys.coinPublicKey;
    const encryptionPublicKey = zswapKeys.encryptionPublicKey;

    return {
        getCoinPublicKey(): string         { return coinPublicKey; },
        getEncryptionPublicKey(): string   { return encryptionPublicKey; },
        async balanceTx(_tx: any, _ttl?: any): Promise<any> {
            throw new WalletSigningNotAvailable(
                'balanceTx(): secret keys derived but no WalletFacade configured for this session'
            );
        },
        async submitTx(_tx: any): Promise<any> {
            throw new WalletSigningNotAvailable(
                'submitTx(): secret keys derived but no WalletFacade configured for this session'
            );
        },
        _internal: { zswapKeys, dustKey }
    };
}

// ---- Attester identity ----------------------------------------------------

const attesterIdCache = new Map<string, string>();

export interface AttesterIdForSessionOptions {
    sessionId: string;
    db?: any;
    expectedUserId?: string;
    encryptionKey?: Buffer | KeyRing;
}

/** The vault attester id (`caller_id()`) of the session's seed; cached per session, the seed is fixed. */
export async function attesterIdForSession(opts: AttesterIdForSessionOptions): Promise<string> {
    const cached = attesterIdCache.get(opts.sessionId);
    if (cached) return cached;
    const db = opts.db ?? await cds.connect.to('db');
    const where: Record<string, unknown> = { sessionId: opts.sessionId, isActive: true };
    if (opts.expectedUserId) where.userId = opts.expectedUserId;
    const session = await db.run(SELECT.one.from(WalletSessions).where(where));
    if (!session || isSessionExpired(opts.sessionId, session.expiresAt) || !session.encryptedSeedKey) {
        throw new SessionNotFoundError(opts.sessionId);
    }
    const encKey = opts.encryptionKey ?? getEncryptionKey();
    let seedHex: string;
    try {
        seedHex = decrypt(session.encryptedSeedKey, encKey, walletSessionSeedBinding(session.sessionId));
    } catch {
        throw new SessionNotFoundError(opts.sessionId);
    }
    const seed = Buffer.from(seedHex, 'hex');
    let roleSeeds: RoleSeeds | undefined;
    try {
        roleSeeds = await deriveRoleSeeds(seed, session.accountIndex ?? 0);
        const attesterId = deriveAttesterId(roleSeeds.zswap);
        attesterIdCache.set(opts.sessionId, attesterId);
        return attesterId;
    } finally {
        seed.fill(0);
        roleSeeds?.zswap.fill(0);
    }
}

export function __resetAttesterIdCacheForTests(): void {
    attesterIdCache.clear();
}
