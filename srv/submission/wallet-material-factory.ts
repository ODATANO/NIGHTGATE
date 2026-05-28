/**
 * Wallet material factory (T7).
 *
 * Bridges WalletSessions rows to the WalletMaterial shape that
 * TransactionSubmitter / providers expect.
 *
 * What this DOES today (T7, viewing-key-only sessions):
 *   - Look up the active session row by sessionId.
 *   - Decrypt the stored viewing key via srv/utils/crypto.ts.
 *   - Derive a deterministic `accountId` from the viewing key
 *     (HMAC-SHA256, hex-encoded). Same viewing key → same accountId across
 *     reconnects, so the CAP-DB private-state provider (T29) can decrypt
 *     state stored in prior sessions.
 *   - Derive a deterministic `privateStoragePasswordProvider` similarly
 *     (different domain-separation label, 64-char hex, ≥16 char requirement
 *     trivially satisfied).
 *   - Build a `walletAndMidnightProvider` adapter satisfying the
 *     `WalletProvider & MidnightProvider` interface shape.
 *
 * What this does NOT do (gated on T7-extended):
 *   - Build a real signing-capable wallet. A viewing key is read-only by
 *     design; it cannot derive shielded/dust secret keys, cannot balance a
 *     transaction, cannot sign one. The four "active" wallet methods
 *     (getCoinPublicKey, getEncryptionPublicKey, balanceTx, submitTx) throw
 *     `WalletSigningNotAvailable` with a pointer to the schema change needed
 *     (encryptedSeedKey field, now present but unused).
 *
 * Consequence: deploy/call flows still fail at SDK invocation time, but the
 * failure path is now a proper SubmissionError with our message, not a 501.
 * The submission path can be exercised end-to-end through the wallet-material
 * factory; only the final SDK call requires seed material.
 */

import cds from '@sap/cds';
const { SELECT } = cds.ql;
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
 * does not carry seed material. NOT thrown by `buildWalletMaterialForSession`
 * itself; that returns successfully and lets the SDK call surface the error
 * with full context via TransactionSubmitter's error classification.
 */
export class WalletSigningNotAvailable extends Error {
    constructor(method: string) {
        super(
            `Wallet signing surface not available for ${method}: session carries a viewing key only. ` +
            `Production signing requires the encryptedSeedKey field on WalletSessions to be populated; ` +
            `tracked as T7-extended in db/enhancements.md.`
        );
        this.name = 'WalletSigningNotAvailable';
    }
}

// Retained for back-compat with handlers.ts error mapping (currently mapped to 501).
// After T7 the factory no longer throws this; handlers.ts can be cleaned up later
// once the 501 path is fully obsolete. We keep the symbol exported so other
// modules don't break.
export class WalletMaterialUnavailable extends Error {
    constructor(reason: string) {
        super(`Wallet material unavailable: ${reason}. See T7 in db/enhancements.md.`);
        this.name = 'WalletMaterialUnavailable';
    }
}

// ---- Public API -----------------------------------------------------------

export interface BuildWalletMaterialOptions {
    sessionId: string;
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
    const session = await db.run(
        SELECT.one.from('midnight.WalletSessions').where({ sessionId: opts.sessionId, isActive: true })
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
            // Full T7-extended.b: WalletFacade-backed adapter with working
            // balanceTx and submitTx.
            walletAndMidnightProvider = await createFacadeBackedWalletAdapter(
                accountId,
                seedHex,
                { ...opts.facadeConfig, syncStatePassphrase: password }
            );
        } else {
            // T7-extended.a: pubkeys real, signing methods throw.
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
 * Object satisfying the structural shape of WalletProvider & MidnightProvider.
 * Today all four methods throw. T7-extended replaces this with a real adapter
 * that uses an encryptedSeedKey from the session.
 *
 * We use `any` for the secret-key/transaction types because pulling them in
 * would force importing ledger-v8 here, which is ESM-only and unnecessary for
 * an adapter that only throws. Real construction (T7-extended) will dynamic-
 * import them.
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
 * Adapter for sessions that have seed material. ZswapSecretKeys + DustSecretKey
 * are derived once at construction time and held in closure. Public-key methods
 * return real values; balanceTx/submitTx still throw, with a more specific
 * message pointing at T7-extended.b (WalletFacade orchestration).
 */
/**
 * Full T7-extended.b adapter: real pubkeys from derived ZswapSecretKeys, and
 * balanceTx/submitTx routed through a cached WalletFacade.
 *
 * The facade is built lazily on first balanceTx/submitTx call so the request
 * that triggers it pays the chain-sync cost. Cached per accountId via
 * wallet-facade-builder.
 *
 * The facade's `balanceUnboundTransaction` returns an UnboundTransactionRecipe;
 * we then call `finalizeRecipe` to get a FinalizedTransaction that the SDK's
 * deployContract / callTx flow accepts.
 *
 * Default TTL of 1 hour for balance operations; matches the SDK default.
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

async function createSigningCapableWalletAdapter(seedHex: string): Promise<any> {
    if (!/^[0-9a-fA-F]{128}$/.test(seedHex)) {
        // Defense in depth; connectWalletForSigning already validates this.
        throw new Error('Invalid seed: must be 128 hex characters (64-byte BIP39 seed)');
    }

    const bip39Seed = new Uint8Array(Buffer.from(seedHex, 'hex'));
    const roleSeeds = await deriveRoleSeeds(bip39Seed);
    const ledger = await loadLedgerV8();

    // Each key type comes from its own HD role (Zswap/Dust), matching Lace —
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
                'balanceTx(): secret keys derived but WalletFacade orchestration pending (T7-extended.b)'
            );
        },
        async submitTx(_tx: any): Promise<any> {
            throw new WalletSigningNotAvailable(
                'submitTx(): secret keys derived but WalletFacade orchestration pending (T7-extended.b)'
            );
        },
        // Internal handles for the upcoming T7-extended.b, exposed so the
        // WalletFacade adapter can grab them without re-deriving.
        _internal: { zswapKeys, dustKey }
    };
}
