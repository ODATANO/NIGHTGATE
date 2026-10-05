/**
 * Turns a stored wallet session into the keys and providers a job needs.
 * The account id and storage passwords are derived from the viewing key, so a
 * reconnect finds the same encrypted state.
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
import type { DbRunner } from '../utils/db-types';
import { NightgateError } from '../utils/errors';

// ---- Errors ---------------------------------------------------------------

export class SessionNotFoundError extends NightgateError {
    constructor(sessionId: string) {
        super('SESSION_NOT_FOUND', `Session '${sessionId}' not found, expired, or inactive`);
    }
}

/** Thrown when a session that holds only a viewing key is asked to sign. */
export class WalletSigningNotAvailable extends NightgateError {
    constructor(method: string) {
        super('WALLET_SIGNING_NOT_AVAILABLE',
            `Wallet signing surface not available for ${method}: session carries a viewing key only. ` +
            `Signing requires the encryptedSeedKey field on WalletSessions to be populated.`
        );
    }
}

// Not thrown here. Exported so the handlers can map it to 501.
export class WalletMaterialUnavailable extends NightgateError {
    constructor(reason: string) {
        super('WALLET_MATERIAL_UNAVAILABLE', `Wallet material unavailable: ${reason}.`);
    }
}

// ---- Public API -----------------------------------------------------------

export interface BuildWalletMaterialOptions {
    sessionId: string;
    /** The user who owns the session. Another user gets SessionNotFound. */
    expectedUserId?: string;
    privateStateBackend?: PrivateStateBackend;
    /** For tests. Defaults to cds.connect.to('db'). */
    db?: DbRunner;
    /** For tests. Defaults to the process key from srv/utils/crypto.ts. */
    encryptionKey?: Buffer;
    /** For a session with a seed, lets the worker build the wallet. Without it only the public keys are real. */
    facadeConfig?: Omit<WalletFacadeBuildArgs, 'seedHex'>;
}

const ACCOUNT_ID_LABEL = 'nightgate-account-id-v1';
const PRIVATE_STATE_PASSWORD_LABEL = 'nightgate-private-state-password-v1';

/** Loads a session as `WalletMaterial`. What the wallet adapter can do depends on whether the session has a seed. */
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
    // The per-account data key is created here when first needed. Data still encrypted
    // with an older password is read with that password and re-encrypted under the data key.
    const ring = encKey instanceof KeyRing ? encKey : Buffer.isBuffer(encKey) ? KeyRing.fromKek(encKey) : getEncryptionKey();
    const storagePassword = deriveStoragePassword(viewingKey);
    const dek = await resolveAccountDek({ db, ring, accountId, storagePassword });
    if (!dek) throw new SessionNotFoundError(opts.sessionId);
    const password = privateStatePasswordFromDek(dek, accountId);
    const legacyPasswords = privateStatePasswordCandidates(ring, viewingKey).map(c => c.password);
    // The sync-state store finds the data key itself from this password.
    const syncStatePassphrase = storagePassword;
    // Taken from the session row, never from the caller, so it matches the viewing key's account.
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
            // Build the wallet on first use if it was never started or was dropped from memory.
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

/** Storage id derived from the viewing key with HMAC-SHA256. */
export function deriveAccountId(viewingKey: string): string {
    return crypto.createHmac('sha256', ACCOUNT_ID_LABEL).update(viewingKey).digest('hex');
}

/** Storage password derived from the viewing key. It uses its own label, so it never equals the account id. */
export function deriveStoragePassword(viewingKey: string): string {
    return crypto.createHmac('sha256', PRIVATE_STATE_PASSWORD_LABEL).update(viewingKey).digest('hex');
}

const PRIVATE_STATE_INFO = 'nightgate/private-state/v2';

/** Older private-state password under master key `keyId`. Only used for reading. */
export function derivePrivateStatePassword(ring: KeyRing, keyId: string, viewingKey: string): string {
    return deriveBoundSecret(ring, keyId, deriveStoragePassword(viewingKey), PRIVATE_STATE_INFO).toString('hex');
}

/**
 * All older private-state passwords to try when reading, the active master key first.
 * Also used by the re-encryption tool.
 */
export function privateStatePasswordCandidates(ring: KeyRing, viewingKey: string): Array<{ keyId: string | null; password: string; legacy: boolean }> {
    const out = [ring.activeId, ...ring.ids().filter(i => i !== ring.activeId)].map(id => ({
        keyId: id as string | null, password: derivePrivateStatePassword(ring, id, viewingKey), legacy: false
    }));
    out.push({ keyId: null, password: deriveStoragePassword(viewingKey), legacy: true });
    return out;
}

// ---- Wallet adapter -------------------------------------------------------

/** Wallet adapter for a session with only a viewing key. Every method throws. */
function createReadOnlyWalletAdapter(): any {
    return {
        getCoinPublicKey(): never        { throw new WalletSigningNotAvailable('getCoinPublicKey()'); },
        getEncryptionPublicKey(): never  { throw new WalletSigningNotAvailable('getEncryptionPublicKey()'); },
        async balanceTx(_tx: any, _ttl?: any): Promise<any> { throw new WalletSigningNotAvailable('balanceTx()'); },
        async submitTx(_tx: any): Promise<any>             { throw new WalletSigningNotAvailable('submitTx()'); }
    };
}

/** Provides the real public keys. Balancing and submitting run in the worker thread. */
async function createFacadeBackedWalletAdapter(
    accountId: string,
    seedHex: string,
    facadeConfig: Omit<WalletFacadeBuildArgs, 'seedHex'>
): Promise<any> {
    if (!/^[0-9a-fA-F]{128}$/.test(seedHex)) {
        throw new Error('Invalid seed: must be 128 hex characters (64-byte BIP39 seed)');
    }

    // Derive the keys now, because the key getters are synchronous.
    // They come from the Zswap HD role, not from the raw seed.
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

/** Wallet adapter for a seed session without worker config. Public keys are real, signing throws. */
async function createSigningCapableWalletAdapter(seedHex: string, accountIndex: number = 0): Promise<any> {
    if (!/^[0-9a-fA-F]{128}$/.test(seedHex)) {
        throw new Error('Invalid seed: must be 128 hex characters (64-byte BIP39 seed)');
    }

    const bip39Seed = new Uint8Array(Buffer.from(seedHex, 'hex'));
    const roleSeeds = await deriveRoleSeeds(bip39Seed, accountIndex);
    const ledger = await loadLedgerV8();

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

export interface SessionSeedOptions {
    sessionId: string;
    db?: DbRunner;
    expectedUserId?: string;
    encryptionKey?: Buffer | KeyRing;
}
export type AttesterIdForSessionOptions = SessionSeedOptions;

/** Runs `fn` with the session's HD role seeds and wipes them afterwards. The session must hold a seed. */
export async function withSessionRoleSeeds<T>(opts: SessionSeedOptions, fn: (roleSeeds: RoleSeeds) => T | Promise<T>): Promise<T> {
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
        return await fn(roleSeeds);
    } finally {
        seed.fill(0);
        roleSeeds?.zswap.fill(0);
    }
}

/** The session's attester id in the vault contract, as `caller_id()` returns it. Cached per session. */
export async function attesterIdForSession(opts: AttesterIdForSessionOptions): Promise<string> {
    const cached = attesterIdCache.get(opts.sessionId);
    if (cached) return cached;
    const attesterId = await withSessionRoleSeeds(opts, roleSeeds => deriveAttesterId(roleSeeds.zswap));
    attesterIdCache.set(opts.sessionId, attesterId);
    return attesterId;
}

export function __resetAttesterIdCacheForTests(): void {
    attesterIdCache.clear();
}
