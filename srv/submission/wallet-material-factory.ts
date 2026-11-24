// Turns a stored wallet session into the keys and providers a job needs.
// The account id and storage passwords derive from the viewing key, so a reconnect finds the same encrypted state.

import cds from '@sap/cds';
import { assertSeedHex, bareHex } from '../utils/hex-patterns';
const { SELECT } = cds.ql;
import { WalletSessions, type WalletSession } from '#cds-models/midnight';
import crypto from 'crypto';
import { decrypt, getEncryptionKey, hashViewingKey, KeyRing } from '../utils/crypto';
import { walletSessionViewingKeyBinding, walletSessionSeedBinding } from '../utils/envelope-bindings';
import { resolveAccountDek, privateStatePasswordFromDek, syncStatePassphraseFromDek, dropAccountDek, evictAccountDek } from './account-keys';
import { movePrivateRows } from '../midnight/CapDbPrivateStateProvider';
import { moveSyncState, evictEncryptionKey } from './wallet-sync-state-store';
import { loadLedger } from '../midnight/sdk-loader';
import { deriveRoleSeeds, type RoleSeeds } from '../utils/wallet-hd';
import { deriveAttesterId } from '../utils/wallet-info';
import { isSessionExpired } from '../utils/session-expiry';
import { getOrBuildWalletFacade, type WalletFacadeBuildArgs } from './wallet-facade-builder';
import type { WalletMaterial, WalletPublicKeys } from '../midnight/providers';
import type { DbRunner } from '../utils/db-types';
import type { DustSecretKey, ZswapSecretKeys } from '@midnightntwrk/ledger-v9';
import { NightgateError, SessionNotFoundError } from '../utils/errors';

// ---- Errors ---------------------------------------------------------------

export { SessionNotFoundError };

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
/** What a job needs to build a session's wallet material. Tests inject their own. */
export type WalletMaterialFactory = (opts: BuildWalletMaterialOptions) => Promise<WalletMaterial>;

/** Wallet material with the adapter this factory builds. */
export type SessionWalletMaterial = WalletMaterial & { walletAndMidnightProvider: MainThreadWalletAdapter };

export async function buildWalletMaterialForSession(opts: BuildWalletMaterialOptions): Promise<SessionWalletMaterial> {
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
    // The per-account data key is created here when first needed.
    const ring = encKey instanceof KeyRing ? encKey : Buffer.isBuffer(encKey) ? KeyRing.fromKek(encKey) : getEncryptionKey();
    const storagePassword = deriveStoragePassword(viewingKey);
    const dek = await resolveAccountDek({ db, ring, accountId, storagePassword });
    if (!dek) throw new SessionNotFoundError(opts.sessionId);
    const password = privateStatePasswordFromDek(dek, accountId);
    // The sync-state store finds the data key itself from this password.
    const syncStatePassphrase = storagePassword;
    // Taken from the session row, never from the caller, so it matches the viewing key's account.
    const accountIndex = session.accountIndex ?? 0;

    let walletAndMidnightProvider: MainThreadWalletAdapter;
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
        walletAndMidnightProvider,
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

// ---- One account per viewing key ------------------------------------------

const ACCOUNT_TABLES = ['midnight.AccountKeys', 'midnight.PrivateStates', 'midnight.ContractSigningKeys', 'midnight.WalletSyncStates'];

async function isAccountStored(db: DbRunner, accountId: string): Promise<boolean> {
    for (const table of ACCOUNT_TABLES) {
        if (await db.run(SELECT.one.from(table).columns('accountId').where({ accountId }))) return true;
    }
    return false;
}

/** Spellings of a viewing key that an account may still be stored under: the one the caller sent, and upper case. */
export function otherSpellings(viewingKey: string, sent?: string): string[] {
    const canonical = bareHex(viewingKey);
    const spellings = [sent?.replace(/^0x/i, ''), canonical.toUpperCase()];
    return [...new Set(spellings.filter((s): s is string => !!s && s !== canonical))];
}

/** The sessions whose stored viewing key has this spelling. */
export async function sessionsHolding(db: DbRunner, spelling: string): Promise<string[]> {
    const rows: Array<Pick<WalletSession, 'sessionId'>> = await db.run(SELECT.from(WalletSessions).columns('sessionId')
        .where({ viewingKeyHash: hashViewingKey(spelling), encryptedViewingKey: { '!=': null } })) ?? [];
    return rows.map(r => String(r.sessionId));
}

/** Moves what is stored under another spelling of a viewing key to the account of its lowercase spelling. Null when nothing is stored.
 *  Run it in one transaction. If that does not commit, call `forgetAccountKeys`. */
export async function moveAccountOfSpelling(db: DbRunner, ring: KeyRing, spelling: string): Promise<{ moved: number; left: number } | null> {
    const canonical = bareHex(spelling);
    const from = deriveAccountId(spelling);
    if (spelling === canonical || !await isAccountStored(db, from)) return null;
    const to = deriveAccountId(canonical);
    const fromPassword = deriveStoragePassword(spelling);
    const fromDek = await resolveAccountDek({ db, ring, accountId: from, storagePassword: fromPassword, create: false, readOnly: true });
    const toDek = await resolveAccountDek({ db, ring, accountId: to, storagePassword: deriveStoragePassword(canonical) });
    if (!toDek) throw new Error('the account key of the lowercase spelling could not be created');
    try {
        const rows = await movePrivateRows(db, {
            accountId: from,
            password: fromDek ? privateStatePasswordFromDek(fromDek, from) : undefined
        }, { accountId: to, password: privateStatePasswordFromDek(toDek, to) });
        await moveSyncState(db,
            { accountId: from, dekPassphrase: fromDek ? syncStatePassphraseFromDek(fromDek, from) : undefined },
            { accountId: to, dekPassphrase: syncStatePassphraseFromDek(toDek, to) });
        // Rows left behind are still encrypted with the old account's key.
        if (rows.left === 0) await dropAccountDek(db, from);
        return rows;
    } finally {
        fromDek?.fill(0);
        toDek.fill(0);
        evictAccountDek(from);
    }
}

/** Moves the accounts stored under other spellings of this key to its account. Refuses while an open session holds one of them. */
export async function adoptFormerSpellings(db: DbRunner, ring: KeyRing, viewingKey: string, sent?: string): Promise<{ moved: number; left: number } | null> {
    const found: Array<{ moved: number; left: number }> = [];
    for (const spelling of otherSpellings(viewingKey, sent)) {
        if ((await sessionsHolding(db, spelling)).length) {
            throw new NightgateError('ACCOUNT_MOVE_BLOCKED',
                'An open session holds this wallet under another spelling of its viewing key. Close that session, then connect again.');
        }
        const rows = await moveAccountOfSpelling(db, ring, spelling);
        if (rows) found.push(rows);
    }
    if (!found.length) return null;
    return { moved: found.reduce((n, r) => n + r.moved, 0), left: found.reduce((n, r) => n + r.left, 0) };
}

/** Drops the cached keys of a viewing key's account. Call it when the transaction that created or moved them did not commit. */
export async function forgetAccountKeys(viewingKey: string): Promise<void> {
    const accountId = deriveAccountId(bareHex(viewingKey));
    evictAccountDek(accountId);
    await evictEncryptionKey(accountId);
}

// ---- Wallet adapter -------------------------------------------------------

/** The wallet a job sees on the main thread. Balancing and submitting always run in the wallet worker. */
export interface MainThreadWalletAdapter extends WalletPublicKeys {
    balanceTx(tx?: unknown, ttl?: unknown): Promise<never>;
    submitTx(tx?: unknown): Promise<never>;
    _internal?: { zswapKeys: ZswapSecretKeys; cacheKey?: string; dustKey?: DustSecretKey };
}

/** Wallet adapter for a session with only a viewing key. Every method throws. */
function createReadOnlyWalletAdapter(): MainThreadWalletAdapter {
    return {
        getCoinPublicKey(): never        { throw new WalletSigningNotAvailable('getCoinPublicKey()'); },
        getEncryptionPublicKey(): never  { throw new WalletSigningNotAvailable('getEncryptionPublicKey()'); },
        async balanceTx(_tx?: unknown, _ttl?: unknown): Promise<never> { throw new WalletSigningNotAvailable('balanceTx()'); },
        async submitTx(_tx?: unknown): Promise<never>                  { throw new WalletSigningNotAvailable('submitTx()'); }
    };
}

/** Provides the real public keys. Balancing and submitting run in the worker thread. */
async function createFacadeBackedWalletAdapter(
    accountId: string,
    seedHex: string,
    facadeConfig: Omit<WalletFacadeBuildArgs, 'seedHex'>
): Promise<MainThreadWalletAdapter> {
    assertSeedHex(seedHex);

    // Derive the keys now, because the key getters are synchronous.
    // They come from the Zswap HD role, not from the raw seed.
    const bip39Seed = new Uint8Array(Buffer.from(seedHex, 'hex'));
    const roleSeeds = await deriveRoleSeeds(bip39Seed, facadeConfig.accountIndex ?? 0);
    const ledger = await loadLedger();
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
async function createSigningCapableWalletAdapter(seedHex: string, accountIndex: number = 0): Promise<MainThreadWalletAdapter> {
    assertSeedHex(seedHex);

    const bip39Seed = new Uint8Array(Buffer.from(seedHex, 'hex'));
    const roleSeeds = await deriveRoleSeeds(bip39Seed, accountIndex);
    const ledger = await loadLedger();

    const zswapKeys = ledger.ZswapSecretKeys.fromSeed(roleSeeds.zswap);
    const dustKey   = ledger.DustSecretKey.fromSeed(roleSeeds.dust);

    const coinPublicKey       = zswapKeys.coinPublicKey;
    const encryptionPublicKey = zswapKeys.encryptionPublicKey;

    return {
        getCoinPublicKey(): string         { return coinPublicKey; },
        getEncryptionPublicKey(): string   { return encryptionPublicKey; },
        async balanceTx(_tx?: unknown, _ttl?: unknown): Promise<never> {
            throw new WalletSigningNotAvailable(
                'balanceTx(): secret keys derived but no WalletFacade configured for this session'
            );
        },
        async submitTx(_tx?: unknown): Promise<never> {
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
