/**
 * Wallet material factory.
 *
 * Resolves a WalletSessions row into the WalletMaterial shape that
 * TransactionSubmitter and the provider bundle consume:
 *   - looks up the active session and decrypts its viewing key
 *   - derives a deterministic accountId + private-state storage password from
 *     the viewing key, so the same key maps to the same encrypted state across
 *     reconnects
 *   - builds a wallet adapter sized to what the session carries: a real
 *     signing-capable adapter when an encryptedSeedKey is present, otherwise a
 *     read-only adapter whose signing methods throw.
 */

import cds from '@sap/cds';
const { SELECT } = cds.ql;
import { WalletSessions } from '#cds-models/midnight';
import crypto from 'crypto';
import { decrypt, getEncryptionKey } from '../utils/crypto';
import { loadLedgerV8 } from '../midnight/sdk-loader';
import { deriveRoleSeeds } from '../utils/wallet-hd';
import { getOrBuildWalletFacade, type WalletFacadeBuildArgs } from './wallet-facade-builder';
import type { WalletMaterial, PrivateStateBackend } from '../midnight/providers';

// ---- Errors ---------------------------------------------------------------

export class SessionNotFoundError extends Error {
    constructor(sessionId: string) {
        super(`Session '${sessionId}' not found, expired, or inactive`);
        this.name = 'SessionNotFoundError';
    }
}

/**
 * Thrown by the wallet adapter's signing/balancing methods when the session
 * carries a viewing key only. Not thrown by `buildWalletMaterialForSession`
 * itself, which returns successfully and lets the SDK call surface the error
 * through TransactionSubmitter's classification.
 */
export class WalletSigningNotAvailable extends Error {
    constructor(method: string) {
        super(
            `Wallet signing surface not available for ${method}: session carries a viewing key only. ` +
            `Signing requires the encryptedSeedKey field on WalletSessions to be populated.`
        );
        this.name = 'WalletSigningNotAvailable';
    }
}

// Retained for back-compat with the handlers.ts 501 mapping. The factory no
// longer throws this; the symbol stays exported so dependents don't break.
export class WalletMaterialUnavailable extends Error {
    constructor(reason: string) {
        super(`Wallet material unavailable: ${reason}.`);
        this.name = 'WalletMaterialUnavailable';
    }
}

// ---- Public API -----------------------------------------------------------

export interface BuildWalletMaterialOptions {
    sessionId: string;
    /**
     * Owning principal (req.user.id). When provided, the session load is scoped
     * to it so one principal cannot build wallet material from another's session.
     * Callers in the submission handlers always pass
     * `req.user.id`; a mismatch reads back as SessionNotFound (non-leaking).
     */
    expectedUserId?: string;
    privateStateBackend?: PrivateStateBackend;
    /** Test seam; defaults to cds.connect.to('db'). */
    db?: any;
    /** Test seam; defaults to the process-scoped key from srv/utils/crypto.ts. */
    encryptionKey?: Buffer;
    /**
     * Optional facade-build configuration. When provided AND the session
     * carries an encryptedSeedKey, the wallet adapter wires through a real
     * WalletFacade and balanceTx/submitTx work. When omitted, the adapter
     * returns real pubkeys from the seed but balanceTx/submitTx throw.
     */
    facadeConfig?: Omit<WalletFacadeBuildArgs, 'seedHex'>;
}

const ACCOUNT_ID_LABEL = 'nightgate-account-id-v1';
const PRIVATE_STATE_PASSWORD_LABEL = 'nightgate-private-state-password-v1';

/**
 * Returns a fully-typed `WalletMaterial`. The wallet adapter's signing
 * methods throw `WalletSigningNotAvailable`; deterministic identifiers
 * (accountId) and the storage password work.
 */
export async function buildWalletMaterialForSession(opts: BuildWalletMaterialOptions): Promise<WalletMaterial> {
    const db = opts.db ?? await cds.connect.to('db');
    const where: Record<string, unknown> = { sessionId: opts.sessionId, isActive: true };
    if (opts.expectedUserId) where.userId = opts.expectedUserId;
    const session = await db.run(
        SELECT.one.from(WalletSessions).where(where)
    );
    if (!session) throw new SessionNotFoundError(opts.sessionId);
    if (session.expiresAt && new Date(session.expiresAt) < new Date()) {
        throw new SessionNotFoundError(opts.sessionId);
    }
    if (!session.encryptedViewingKey) {
        throw new SessionNotFoundError(opts.sessionId);
    }

    const encKey = opts.encryptionKey ?? getEncryptionKey();
    let viewingKey: string;
    try {
        viewingKey = decrypt(session.encryptedViewingKey, encKey);
    } catch (err) {
        // Wrong ENCRYPTION_KEY, tampered ciphertext, or rotated key.
        throw new SessionNotFoundError(opts.sessionId);
    }

    const accountId = deriveAccountId(viewingKey);
    const password  = deriveStoragePassword(viewingKey);

    let walletAndMidnightProvider: any;
    if (session.encryptedSeedKey) {
        // Real signing material is present.
        let seedHex: string;
        try {
            seedHex = decrypt(session.encryptedSeedKey, encKey);
        } catch {
            throw new SessionNotFoundError(opts.sessionId);
        }
        if (opts.facadeConfig) {
            // WalletFacade-backed adapter with working balanceTx and submitTx.
            walletAndMidnightProvider = await createFacadeBackedWalletAdapter(
                accountId,
                seedHex,
                { ...opts.facadeConfig, syncStatePassphrase: password }
            );
        } else {
            // Seed present but no facade configured: pubkeys real, signing throws.
            walletAndMidnightProvider = await createSigningCapableWalletAdapter(seedHex);
        }
    } else {
        walletAndMidnightProvider = createReadOnlyWalletAdapter();
    }

    return {
        accountId,
        privateStoragePasswordProvider: () => password,
        walletAndMidnightProvider,
        privateStateBackend: opts.privateStateBackend
    };
}

// ---- Determinism helpers --------------------------------------------------

/**
 * `accountId` is opaque storage scope; it just needs to be deterministic per
 * viewing key. We use HMAC-SHA256 with a domain-separation label and hex-encode.
 * 64 chars is well within the 200-char DB column.
 */
export function deriveAccountId(viewingKey: string): string {
    return crypto.createHmac('sha256', ACCOUNT_ID_LABEL).update(viewingKey).digest('hex');
}

/**
 * Storage password for the CAP-DB private state provider. 64-char hex
 * (= 256 bits of entropy), well over the 16-char minimum. Distinct
 * domain-separation label from the accountId so the two values cannot collide.
 */
export function deriveStoragePassword(viewingKey: string): string {
    return crypto.createHmac('sha256', PRIVATE_STATE_PASSWORD_LABEL).update(viewingKey).digest('hex');
}

// ---- Wallet adapter -------------------------------------------------------

/**
 * Read-only adapter for viewing-key-only sessions. All four wallet methods
 * throw `WalletSigningNotAvailable`.
 *
 * Typed `any` for the secret-key/transaction types: importing them would pull
 * in the ESM-only ledger-v8 package, which an adapter that only throws does
 * not need.
 */
function createReadOnlyWalletAdapter(): any {
    return {
        getCoinPublicKey(): never        { throw new WalletSigningNotAvailable('getCoinPublicKey()'); },
        getEncryptionPublicKey(): never  { throw new WalletSigningNotAvailable('getEncryptionPublicKey()'); },
        async balanceTx(_tx: any, _ttl?: any): Promise<any> { throw new WalletSigningNotAvailable('balanceTx()'); },
        async submitTx(_tx: any): Promise<any>             { throw new WalletSigningNotAvailable('submitTx()'); }
    };
}

/**
 * Full signing adapter: real pubkeys from the derived ZswapSecretKeys, with
 * balanceTx/submitTx routed through a WalletFacade.
 *
 * The facade is built lazily on the first balanceTx/submitTx call so that
 * request pays the chain-sync cost; it is then cached per accountId.
 * `balanceUnboundTransaction` yields a recipe that `finalizeRecipe` turns into
 * a transaction the SDK's deploy/call flow accepts. Balance TTL defaults to 1
 * hour, matching the SDK default.
 */
async function createFacadeBackedWalletAdapter(
    accountId: string,
    seedHex: string,
    facadeConfig: Omit<WalletFacadeBuildArgs, 'seedHex'>
): Promise<any> {
    if (!/^[0-9a-fA-F]{128}$/.test(seedHex)) {
        throw new Error('Invalid seed: must be 128 hex characters (64-byte BIP39 seed)');
    }

    // Derive pubkeys eagerly so getCoinPublicKey/getEncryptionPublicKey are
    // synchronous, satisfying the WalletProvider interface contract. seedHex is
    // the BIP39 seed; the shielded account comes from the Zswap HD role (see
    // srv/utils/wallet-hd.ts), not the raw seed.
    const bip39Seed = new Uint8Array(Buffer.from(seedHex, 'hex'));
    const roleSeeds = await deriveRoleSeeds(bip39Seed);
    const ledger = await loadLedgerV8();
    const zswapKeys = ledger.ZswapSecretKeys.fromSeed(roleSeeds.zswap);
    const coinPublicKey       = zswapKeys.coinPublicKey;
    const encryptionPublicKey = zswapKeys.encryptionPublicKey;

    let facadePromise: Promise<{ facade: any; zswapKeys: any; dustKey: any }> | undefined;
    const getFacade = () => {
        if (!facadePromise) {
            facadePromise = getOrBuildWalletFacade(accountId, { ...facadeConfig, seedHex });
        }
        return facadePromise;
    };

    return {
        getCoinPublicKey(): string         { return coinPublicKey; },
        getEncryptionPublicKey(): string   { return encryptionPublicKey; },
        async balanceTx(tx: any, ttl?: Date): Promise<any> {
            const { facade, zswapKeys, dustKey } = await getFacade();
            const effectiveTtl = ttl ?? new Date(Date.now() + 60 * 60 * 1000);
            const recipe = await facade.balanceUnboundTransaction(
                tx,
                { shieldedSecretKeys: zswapKeys, dustSecretKey: dustKey },
                { ttl: effectiveTtl }
            );
            return facade.finalizeRecipe(recipe);
        },
        async submitTx(tx: any): Promise<any> {
            const { facade } = await getFacade();
            return facade.submitTransaction(tx);
        },
        _internal: { zswapKeys, cacheKey: accountId }
    };
}

/**
 * Adapter for sessions that have seed material but no configured facade. Public
 * keys are derived from the seed; balanceTx/submitTx throw until a facade is
 * wired in.
 */
async function createSigningCapableWalletAdapter(seedHex: string): Promise<any> {
    if (!/^[0-9a-fA-F]{128}$/.test(seedHex)) {
        // Defense in depth; connectWalletForSigning already validates this.
        throw new Error('Invalid seed: must be 128 hex characters (64-byte BIP39 seed)');
    }

    const bip39Seed = new Uint8Array(Buffer.from(seedHex, 'hex'));
    const roleSeeds = await deriveRoleSeeds(bip39Seed);
    const ledger = await loadLedgerV8();

    // Each key type comes from its own HD role (Zswap/Dust), matching Lace;
    // see srv/utils/wallet-hd.ts.
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
        // Internal handles exposed so a facade-backed adapter can reuse them
        // without re-deriving.
        _internal: { zswapKeys, dustKey }
    };
}
