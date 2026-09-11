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
import { decrypt, getEncryptionKey, deriveBoundSecret, KeyRing } from '../utils/crypto';
import { walletSessionViewingKeyBinding, walletSessionSeedBinding } from '../utils/envelope-bindings';
import { resolveAccountDek, privateStatePasswordFromDek } from './account-keys';
import { loadLedgerV8 } from '../midnight/sdk-loader';
import { deriveRoleSeeds } from '../utils/wallet-hd';
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
    // Shared rule: a configured platform fee sponsor is infrastructure and
    // does not expire while it is configured (see srv/utils/session-expiry.ts).
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
        // Wrong ENCRYPTION_KEY, tampered ciphertext, or rotated key.
        throw new SessionNotFoundError(opts.sessionId);
    }

    const accountId = deriveAccountId(viewingKey);
    // Private-state password derived from the account DEK (account-keys.ts):
    // the DEK is opened through the ring or, after a rotation the ring no
    // longer covers, through the viewing key, and created here on first
    // need. Rows written before the DEK (the ring-bound and the pre-ring
    // derivations) are read through the legacy candidates and rewritten
    // under the DEK by the provider.
    const ring = encKey instanceof KeyRing ? encKey : Buffer.isBuffer(encKey) ? KeyRing.fromKek(encKey) : getEncryptionKey();
    const storagePassword = deriveStoragePassword(viewingKey);
    const dek = await resolveAccountDek({ db, ring, accountId, storagePassword });
    if (!dek) throw new SessionNotFoundError(opts.sessionId);
    const password = privateStatePasswordFromDek(dek, accountId);
    const legacyPasswords = privateStatePasswordCandidates(ring, viewingKey).map(c => c.password);
    // The sync-state store resolves the same DEK itself from this passphrase
    // (it is the viewing-key seal's password); hand it the viewing-key form.
    const syncStatePassphrase = storagePassword;
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
            seedHex = decrypt(session.encryptedSeedKey, encKey, walletSessionSeedBinding(session.sessionId));
        } catch {
            throw new SessionNotFoundError(opts.sessionId);
        }
        if (opts.facadeConfig) {
            // Adapter with real pubkeys; balanceTx/submitTx run in the worker,
            // not through this main-thread object (see adapter doc below).
            walletAndMidnightProvider = await createFacadeBackedWalletAdapter(
                accountId,
                seedHex,
                { ...opts.facadeConfig, syncStatePassphrase, accountIndex }
            );
            // Worker-routed submissions look the facade up by accountId; make it
            // creatable on demand so a never-prewarmed (or evicted) session does
            // not die with "No facade for sessionId". Idempotent.
            const facadeArgs = { ...opts.facadeConfig, seedHex, syncStatePassphrase, accountIndex };
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
        privateStoragePasswordFallbacks: () => legacyPasswords,
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

const PRIVATE_STATE_INFO = 'nightgate/private-state/v2';

/**
 * The pre-DEK private-state password under ring key `keyId`: HKDF over the
 * ring key and the viewing-key-derived password. Read-only since the account
 * DEK: rows under it are rewritten under the DEK when a session reads them.
 */
export function derivePrivateStatePassword(ring: KeyRing, keyId: string, viewingKey: string): string {
    return deriveBoundSecret(ring, keyId, deriveStoragePassword(viewingKey), PRIVATE_STATE_INFO).toString('hex');
}

/**
 * Every LEGACY password a private-state row of this wallet may have been
 * written under before the account DEK: the ring's keys (active first) and
 * the pre-ring form. Shared with the rewrap tool so both sides derive
 * identically; none of them is written any more.
 */
export function privateStatePasswordCandidates(ring: KeyRing, viewingKey: string): Array<{ keyId: string | null; password: string; legacy: boolean }> {
    const out = [ring.activeId, ...ring.ids().filter(i => i !== ring.activeId)].map(id => ({
        keyId: id as string | null, password: derivePrivateStatePassword(ring, id, viewingKey), legacy: false
    }));
    out.push({ keyId: null, password: deriveStoragePassword(viewingKey), legacy: true });
    return out;
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
 * Signing-capable adapter: real pubkeys from the derived ZswapSecretKeys.
 * balanceTx/submitTx on THIS object still hit the phase-2 stub and throw;
 * production balancing/submission runs inside the wallet worker
 * (buildWorkerContractProviders + the worker facade), which looks the facade
 * up by accountId. This adapter's job is to carry correct public keys into
 * the provider bundle.
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

    return {
        getCoinPublicKey(): string         { return coinPublicKey; },
        getEncryptionPublicKey(): string   { return encryptionPublicKey; },
        // Balancing and submission run inside the wallet worker; this adapter
        // only carries the public keys into a main-thread provider bundle.
        async balanceTx(): Promise<never> {
            throw new Error('balanceTx is not available on the main thread; transactions are balanced in the wallet worker');
        },
        async submitTx(): Promise<never> {
            throw new Error('submitTx is not available on the main thread; transactions are submitted in the wallet worker');
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
