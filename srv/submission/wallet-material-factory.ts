/**
 * Wallet material factory. Resolves a WalletSessions row into the WalletMaterial
 * that TransactionSubmitter and the provider bundle consume:
 *   - decrypts the active session's viewing key
 *   - derives a deterministic accountId + private-state storage password from it
 *     (same key → same encrypted state across reconnects)
 *   - builds a wallet adapter sized to the session: signing-capable when an
 *     encryptedSeedKey is present, else read-only (signing methods throw).
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

// Back-compat with the handlers.ts 501 mapping. No longer thrown by the factory;
// the symbol stays exported so dependents don't break.
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

/** Resolves a session into a `WalletMaterial` (adapter shape depends on whether the session carries a seed). */
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
    // BIP32 account the seed signs with, persisted by connectWalletForSigning.
    // Sourced from the session row (not caller-supplied) so signing derivation
    // always matches the account the session's viewing key belongs to.
    const accountIndex = session.accountIndex ?? 0;

    let walletAndMidnightProvider: any;
    let ensureFacade: (() => Promise<void>) | undefined;
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
                { ...opts.facadeConfig, syncStatePassphrase: password, accountIndex }
            );
            // Worker-routed submissions look the facade up by accountId; make it
            // creatable on demand so a never-prewarmed (or evicted) session does
            // not die with "No facade for sessionId". Idempotent.
            const facadeArgs = { ...opts.facadeConfig, seedHex, syncStatePassphrase: password, accountIndex };
            ensureFacade = async () => { await getOrBuildWalletFacade(accountId, facadeArgs); };
        } else {
            // Seed present but no facade configured: pubkeys real, signing throws.
            walletAndMidnightProvider = await createSigningCapableWalletAdapter(seedHex, accountIndex);
        }
    } else {
        walletAndMidnightProvider = createReadOnlyWalletAdapter();
    }

    return {
        accountId,
        privateStoragePasswordProvider: () => password,
        walletAndMidnightProvider,
        privateStateBackend: opts.privateStateBackend,
        ensureFacade
    };
}

// ---- Determinism helpers --------------------------------------------------

/**
 * `accountId` is an opaque storage scope, deterministic per viewing key:
 * HMAC-SHA256 with a domain-separation label, hex-encoded (64 chars).
 */
export function deriveAccountId(viewingKey: string): string {
    return crypto.createHmac('sha256', ACCOUNT_ID_LABEL).update(viewingKey).digest('hex');
}

/**
 * Storage password for the CAP-DB private state provider. 64-char hex (256 bits).
 * Distinct domain-separation label from accountId so the two cannot collide.
 */
export function deriveStoragePassword(viewingKey: string): string {
    return crypto.createHmac('sha256', PRIVATE_STATE_PASSWORD_LABEL).update(viewingKey).digest('hex');
}

// ---- Wallet adapter -------------------------------------------------------

/**
 * Read-only adapter for viewing-key-only sessions: all four wallet methods throw
 * `WalletSigningNotAvailable`. Typed `any` to avoid pulling in the ESM-only
 * ledger-v8 types for an adapter that only throws.
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
 * balanceTx/submitTx routed through a WalletFacade. The facade is built lazily on
 * the first balanceTx/submitTx (that request pays the chain-sync cost) and cached
 * per accountId. Balance TTL defaults to 1 hour (SDK default).
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
    const roleSeeds = await deriveRoleSeeds(bip39Seed, facadeConfig.accountIndex ?? 0);
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
async function createSigningCapableWalletAdapter(seedHex: string, accountIndex: number = 0): Promise<any> {
    if (!/^[0-9a-fA-F]{128}$/.test(seedHex)) {
        // Defense in depth; connectWalletForSigning already validates this.
        throw new Error('Invalid seed: must be 128 hex characters (64-byte BIP39 seed)');
    }

    const bip39Seed = new Uint8Array(Buffer.from(seedHex, 'hex'));
    const roleSeeds = await deriveRoleSeeds(bip39Seed, accountIndex);
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
