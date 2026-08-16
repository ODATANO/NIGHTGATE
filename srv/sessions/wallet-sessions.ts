/**
 * Wallet session management: connect, disconnect, cleanup. Extracted from
 * NightgateService to keep session concerns off the OData read handlers.
 */

import cds, { Request } from '@sap/cds';
const { SELECT, INSERT, UPDATE } = cds.ql;
import { WalletSessions } from '#cds-models/midnight';
import { getEncryptionKey, encrypt, decrypt, hashViewingKey } from '../utils/crypto';
import { validateViewingKey } from '../utils/validation';
import { RateLimiter } from '../utils/rate-limiter';
import { evictWalletFacade } from '../submission/wallet-facade-builder';
import { withKeyedLock } from '../utils/keyed-lock';
import { deriveAccountId, deriveStoragePassword } from '../submission/wallet-material-factory';
import { registerNightUtxosForDust, deregisterNightUtxosFromDust } from '../submission/dust-registration';
const log = cds.log('nightgate:sessions');
import {
    sendNight,
    getWalletBalance,
    estimateSendNightFee
} from '../submission/token-ops';
import { ensureNetworkId } from '../midnight/providers';
import { getOrBuildWalletFacade } from '../submission/wallet-facade-builder';
import { walletWaitForSyncedState, walletGetSyncProgress } from '../midnight/wallet-worker-client';
import {
    resolveNightgateRuntimeConfig, getNightgatePluginConfig, mainnetSubmissionBlockReason,
    getConfiguredNightgateNetwork, normalizeNightgateNetwork
} from '../utils/nightgate-config';
import { startJob, registerBackgroundJobProcessor, runWithoutAmbientTx, supersedeQueuedJobs, type BackgroundJobRow } from '../submission/background-jobs';
import { reportExternalExecution } from '../submission/job-execution-context';
import { mnemonicToBip39SeedHex } from '../utils/wallet-hd';
import { deriveWalletInfo, resolveBip39SeedHex, deriveViewingKeyForAccount } from '../utils/wallet-info';
import { resolveFeeSponsor, ensureFeeSponsorFacade, FeeSponsorError, getConfiguredFeeSponsorSessions } from '../submission/fee-sponsor';

// Upper bound for the prewarm sync-to-tip wait
const PREWARM_SYNC_TIMEOUT_MS = Number(
    process.env.NIGHTGATE_PREWARM_SYNC_TIMEOUT_MS || 3 * 60 * 60 * 1000
);

// Bounded sync gate for facade-backed READ actions (getWalletBalance and the
// fee estimates): a facade still catching up must not park the request for
// minutes; the caller gets 503 WALLET_SYNCING and polls again. <= 0 disables
// the gate (wait indefinitely, the pre-0.10.2 behavior).
const WALLET_READ_SYNC_TIMEOUT_MS = Number(
    process.env.NIGHTGATE_WALLET_READ_SYNC_TIMEOUT_MS ?? 10_000
);
const readSyncTimeoutMs = (): number | undefined =>
    WALLET_READ_SYNC_TIMEOUT_MS > 0 ? WALLET_READ_SYNC_TIMEOUT_MS : undefined;

/**
 * Map a wallet-worker read failure onto the OData response: a sync-gate
 * timeout is a retryable 503 with a stable code (`WALLET_SYNCING`), everything
 * else stays a 500 with the worker's message.
 */
function rejectWorkerReadError(req: Request, action: string, err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/sync timeout/i.test(msg)) {
        return req.reject({
            code: 'WALLET_SYNCING',
            status: 503,
            message: `${action}: wallet is still syncing to the indexer tip; retry shortly`
        } as any);
    }
    return req.reject(500, `${action} failed: ${msg}`);
}

const walletRateLimiter = new RateLimiter({
    windowMs: 60 * 1000,
    maxRequests: 10
});

const signingKeyRateLimiter = new RateLimiter({
    // Adding a signing key is a one-time-per-session operation, so the bound
    // stays tight. 10/h leaves room for multi-wallet consumers that prewarm
    // several server wallets at login (shared with deriveWalletInfo).
    // Override via env when a deployment needs a different budget.
    windowMs: 60 * 60 * 1000,
    maxRequests: Number(process.env.NIGHTGATE_SIGNING_KEY_RATE_LIMIT || 10)
});

const dustRegRateLimiter = new RateLimiter({
    // Registration is per-NIGHT-UTXO; once registered, repeat calls are no-ops.
    // Tight bound so accidental polling doesn't hammer the chain.
    windowMs: 60 * 60 * 1000,
    maxRequests: 10
});

const sendRateLimiter = new RateLimiter({
    // Common operation; tighter than read-only but generous enough for
    // legitimate retry-on-flaky-network scenarios.
    windowMs: 60 * 1000,
    maxRequests: 10
});

const diagnosticsRateLimiter = new RateLimiter({
    // Read-only ops; generous limit since these inform UI and should be
    // pollable. Still bounded to prevent abuse.
    windowMs: 60 * 1000,
    maxRequests: 60
});

const MAX_NIGHT_AMOUNT_ATOMS = 10n ** 18n;
// Custom tokens are Uint<128> on-chain; the NIGHT supply bound does not apply.
const MAX_CUSTOM_TOKEN_ATOMS = 2n ** 128n - 1n;

type WalletCommand =
    | { op: 'prewarm' }
    | { op: 'registerDust'; dustReceiverAddress?: string }
    | { op: 'deregisterDust'; sponsorSessionId?: string }
    | { op: 'sendNight'; receiverAddress: string; amount: string; ttlIso?: string; tokenTypeHex?: string };

const WALLET_COMMAND_KINDS = [
    'connectWalletForSigning', 'registerForDustGeneration', 'deregisterFromDustGeneration',
    'sendNight'
] as const;
const EXPECTED_WALLET_OP: Record<string, WalletCommand['op']> = {
    connectWalletForSigning: 'prewarm',
    registerForDustGeneration: 'registerDust',
    deregisterFromDustGeneration: 'deregisterDust',
    sendNight: 'sendNight'
};

async function executeWalletCommand(raw: unknown, job: BackgroundJobRow, db: any): Promise<unknown> {
    const command = raw as WalletCommand;
    if (!command || typeof command.op !== 'string' || !job.sessionId || !job.requestedBy) {
        throw new Error(`Invalid persisted wallet command for job ${job.ID}`);
    }
    if (job.commandVersion !== 1 || EXPECTED_WALLET_OP[job.kind] !== command.op) {
        throw new Error(`Persisted command ${job.kind} v${job.commandVersion} has incompatible operation '${command.op}'`);
    }
    const session = await db.run(
        SELECT.one.from(WalletSessions).where({ sessionId: job.sessionId, isActive: true, userId: job.requestedBy })
    );
    if (!session) throw new Error('Session not found, inactive, or no longer owned by the requesting principal');
    if (session.expiresAt && new Date(session.expiresAt) < new Date()) throw new Error('Session expired');
    if (!session.encryptedViewingKey || !session.encryptedSeedKey) throw new Error('Session no longer has signing material');

    const encKey = getEncryptionKey();
    const viewingKey = decrypt(session.encryptedViewingKey, encKey);
    const seedHex = decrypt(session.encryptedSeedKey, encKey);
    const accountId = deriveAccountId(viewingKey);
    const syncPass = deriveStoragePassword(viewingKey);
    const { network, nodeUrl, submissionEndpoints } = resolveNightgateRuntimeConfig(getNightgatePluginConfig());
    const facadeConfig = {
        networkId: network,
        indexerHttpUrl: submissionEndpoints.indexerHttpUrl,
        indexerWsUrl: submissionEndpoints.indexerWsUrl,
        proofServerUrl: submissionEndpoints.proofServerUrl,
        relayUrl: nodeUrl,
        syncStatePassphrase: syncPass,
        accountIndex: session.accountIndex ?? 0
    };
    await ensureNetworkId(network);
    await getOrBuildWalletFacade(accountId, { seedHex, ...facadeConfig });

    if (command.op === 'prewarm') {
        await walletWaitForSyncedState(accountId, PREWARM_SYNC_TIMEOUT_MS);
        return { ready: true };
    }
    if (command.op === 'registerDust') {
        await reportExternalExecution({});
        const result = await registerNightUtxosForDust({
            cacheKey: accountId, seedHex, facadeConfig,
            dustReceiverAddress: command.dustReceiverAddress || undefined
        });
        return { txId: result.txId ?? '', registeredCount: result.registeredCount, totalNightUtxos: result.totalNightUtxos, dustReceiverAddress: result.dustReceiverAddress };
    }
    if (command.op === 'deregisterDust') {
        const sponsor = command.sponsorSessionId
            ? await resolveFeeSponsor({ db, sponsorSessionId: command.sponsorSessionId, requestingUserId: job.requestedBy, config: getNightgatePluginConfig() })
            : null;
        if (sponsor) await ensureFeeSponsorFacade(sponsor, facadeConfig);
        await reportExternalExecution({});
        const result = await deregisterNightUtxosFromDust({ cacheKey: accountId, sponsorCacheKey: sponsor?.accountId });
        return { txId: result.txId ?? '', deregisteredCount: result.deregisteredCount, totalNightUtxos: result.totalNightUtxos, ...(sponsor ? { feeSponsor: sponsor.sponsorSessionId } : {}) };
    }
    if (command.op === 'sendNight') {
        await reportExternalExecution({});
        const result = await sendNight({ cacheKey: accountId, receiverAddress: command.receiverAddress, amount: command.amount, ttlIso: command.ttlIso, tokenTypeHex: command.tokenTypeHex });
        return { txId: result.txId, toLedger: result.toLedger, amount: result.amount, receiverAddress: result.receiverAddress };
    }
    throw new Error(`Unsupported wallet command operation: ${(command as any).op}`);
}

/**
 * Mainnet submission gate. Rejects with 403 when network is mainnet and allowMainnetSubmission is not enabled.
 * Applied to the on-chain token/dust actions; read-only diagnostics are exempt.
 */
function rejectIfMainnetBlocked(req: Request): boolean {
    const reason = mainnetSubmissionBlockReason(getNightgatePluginConfig());
    if (reason) {
        req.reject?.(403, reason);
        return true;
    }
    return false;
}

/**
 * Parse a NIGHT-atom decimal string into a bigint, returning a discriminator
 * either `{ ok: true, value }` for the parsed value or `{ ok: false, msg }`
 * with a user-facing error message. Encapsulates the validation rules
 * for the sendNight handler.
 */
function parseNightAmount(raw: string | undefined, customToken = false): { ok: true; value: bigint } | { ok: false; msg: string } {
    if (!raw) return { ok: false, msg: 'amount is required' };
    let value: bigint;
    try { value = BigInt(raw); }
    catch { return { ok: false, msg: `amount must be a decimal integer (NIGHT atoms), got '${raw}'` }; }
    if (value <= 0n) return { ok: false, msg: 'amount must be > 0' };
    const bound = customToken ? MAX_CUSTOM_TOKEN_ATOMS : MAX_NIGHT_AMOUNT_ATOMS;
    if (value > bound) {
        return { ok: false, msg: customToken ? 'amount exceeds Uint<128> bound' : 'amount exceeds sanity bound of 10^18 atoms' };
    }
    return { ok: true, value };
}

/**
 * Validate an optional ISO-8601 TTL string. Returns null on success or a user-facing error message.
 */
function validateOptionalTtl(ttlIso: string | undefined): string | null {
    if (!ttlIso) return null;
    const t = new Date(ttlIso);
    if (Number.isNaN(t.getTime())) return 'ttlIso must be a valid ISO-8601 timestamp';
    if (t.getTime() <= Date.now()) return 'ttlIso must be in the future';
    return null;
}

/**
 * The authenticated principal id, or reject 401 and return undefined. Every
 * session-scoped action must call this and bail on undefined: sessions are
 * owned by the principal that created them, and a leaked sessionId alone must
 * not grant any other principal access. The NightgateService is
 * `@requires: 'authenticated-user'`, so a genuine caller always has an id.
 */
function requireUserId(req: Request): string | undefined {
    const uid = (req as any).user?.id;
    if (!uid) { req.reject?.(401, 'authentication required'); return undefined; }
    return uid as string;
}

/**
 * Look up an active signing-capable session and derive its accountId, or return
 * a `{ ok: false, status, msg }` failure. Scoped to `userId` so one principal
 * cannot act on another's session (a foreign session reads back as 404, non-leaking).
 *
 * The SELECT runs OUTSIDE the ambient request tx (autocommit) on purpose: the
 * callers await the wallet worker right after this lookup, and an open request
 * tx would pin one pool connection for the whole worker wait (observed live as
 * `idle in transaction` pool starvation on PostgreSQL). Callers must therefore
 * not rely on read-your-own-write semantics for this lookup.
 */
async function loadSigningSessionAccountId(
    db: any,
    sessionId: string,
    userId: string
): Promise<{ ok: true; accountId: string } | { ok: false; status: number; msg: string }> {
    const session: any = await runWithoutAmbientTx(() => db.run(
        SELECT.one.from(WalletSessions).where({ sessionId, isActive: true, userId })
    ));
    if (!session) return { ok: false, status: 404, msg: 'Session not found or inactive' };
    if (!session.encryptedViewingKey) return { ok: false, status: 404, msg: 'Session has no viewing key' };
    if (!session.encryptedSeedKey) return { ok: false, status: 412, msg: 'Session has no signing key. Call connectWalletForSigning first.' };
    if (session.expiresAt && new Date(session.expiresAt) < new Date()) {
        return { ok: false, status: 410, msg: 'Session expired' };
    }
    let viewingKey: string;
    try {
        viewingKey = decrypt(session.encryptedViewingKey, getEncryptionKey());
    } catch {
        return { ok: false, status: 500, msg: 'Failed to decrypt session keys (ENCRYPTION_KEY mismatch?)' };
    }
    return { ok: true, accountId: deriveAccountId(viewingKey) };
}

/**
 * True when any active, non-expired session row references the wallet with
 * this viewingKeyHash. Uses the persisted hash, so no decryption is needed;
 * reads detached so no request tx is held across the lookup. Callers MUST
 * deactivate their own row(s) first, so "any live row" means "any OTHER
 * live owner".
 */
async function hasLiveSessionForWallet(
    db: any,
    viewingKeyHash: string | null | undefined
): Promise<boolean> {
    if (!viewingKeyHash) return false;
    const now = new Date().toISOString();
    const rows: any = await runWithoutAmbientTx(() => db.run(
        SELECT.from(WalletSessions)
            .columns('sessionId')
            .where({ viewingKeyHash, isActive: true, expiresAt: { '>': now } })
    ));
    return Array.isArray(rows) && rows.length > 0;
}

/**
 * Shared-session-aware facade eviction (session-sweep-evicts-live-facade FR):
 * the facade cache is keyed by accountId while sessions are per-connect rows
 * with a TTL, so expiry or disconnect of ONE row must not evict a facade a
 * sibling session still uses (live incident 2026-07-26: the 15-min sweep
 * silently killed the demo's sponsor facades whenever a day-old leftover row
 * expired).
 *
 * Contract: call AFTER the owning row(s) have been deactivated. Checking
 * before deactivation is a TOCTOU race: two concurrent disconnects of the
 * same wallet would each see the other still active and both skip. With
 * deactivate-first, every caller re-checks after its own deactivation
 * committed, so at least one observes zero live references and evicts.
 * The per-account lock serializes the check+evict against a concurrent
 * facade (re)build (`getOrBuildWalletFacade` takes the same lock), so a
 * freshly built facade cannot be torn down by a stale decision.
 * Best-effort: never throws. Legacy rows without a viewingKeyHash always
 * evict (secure default).
 */
async function evictFacadeUnlessShared(
    db: any,
    session: { encryptedViewingKey?: string | null; viewingKeyHash?: string | null },
    context: string
): Promise<void> {
    try {
        if (!session.encryptedViewingKey) return;
        const viewingKey = decrypt(session.encryptedViewingKey, getEncryptionKey());
        const accountId = deriveAccountId(viewingKey);
        await withKeyedLock(accountId, async () => {
            if (session.viewingKeyHash && await hasLiveSessionForWallet(db, session.viewingKeyHash)) {
                log.info(`${context}: keeping facade ${accountId.slice(0, 16)} (another active session uses this wallet)`);
                return;
            }
            log.info(`${context}: evicting facade ${accountId.slice(0, 16)}`);
            await evictWalletFacade(accountId);
        });
    } catch { /* best-effort eviction */ }
}

const BIP39_SEED_HEX_LENGTH = 128; // 64-byte BIP39 seed; HD-derived per role in srv/utils/wallet-hd.ts

export function registerWalletSessionHandlers(srv: cds.ApplicationService, db: any): void {
    for (const kind of WALLET_COMMAND_KINDS) {
        registerBackgroundJobProcessor(kind, 1, (command, row) => executeWalletCommand(command, row, db));
    }
    srv.on('connectWallet', async (req: Request) => {
        const clientKey = (req as any)?._.req?.ip || 'global';
        const rateResult = walletRateLimiter.check(clientKey);
        if (!rateResult.allowed) {
            return req.reject(429, `Rate limited. Retry after ${Math.ceil(rateResult.retryAfterMs / 1000)}s`);
        }

        const userId = requireUserId(req);
        if (!userId) return;

        const { viewingKey } = req.data as { viewingKey: string };

        const validationError = validateViewingKey(viewingKey);
        if (validationError) {
            return req.reject(400, validationError);
        }

        const encKey = getEncryptionKey();
        const vkHash = hashViewingKey(viewingKey);
        const encryptedVk = encrypt(viewingKey, encKey);

        const nightgateConfig = getNightgatePluginConfig();
        const sessionTtlMs = nightgateConfig.sessionTtlMs || 24 * 60 * 60 * 1000;
        const expiresAt = new Date(Date.now() + sessionTtlMs).toISOString();

        const session = {
            ID: cds.utils.uuid(),
            userId,
            sessionId: cds.utils.uuid(),
            viewingKeyHash: vkHash,
            encryptedViewingKey: encryptedVk,
            connectedAt: new Date().toISOString(),
            expiresAt,
            isActive: true
        };

        await db.run(INSERT.into(WalletSessions).entries(session));

        return {
            ID: session.ID,
            sessionId: session.sessionId,
            connectedAt: session.connectedAt,
            expiresAt: session.expiresAt,
            isActive: true
        };
    });

    // Pure derivation
    srv.on('deriveWalletInfo', async (req: Request) => {
        const clientKey = (req as any)?._.req?.ip || 'global';
        const rateResult = signingKeyRateLimiter.check(clientKey);
        if (!rateResult.allowed) {
            return req.reject(429, `Rate limited. Retry after ${Math.ceil(rateResult.retryAfterMs / 1000)}s`);
        }

        const userId = requireUserId(req);
        if (!userId) return;

        const { mnemonic, seedHex, accountIndex } = req.data as {
            mnemonic?: string;
            seedHex?: string;
            accountIndex?: number;
        };

        // Input validation up front so bad requests are clean 400s (the same
        // checks run again inside deriveWalletInfo, defense in depth).
        try {
            resolveBip39SeedHex({ mnemonic, seedHex });
        } catch (e: any) {
            return req.reject(400, e?.message || 'invalid wallet secret');
        }
        const account = accountIndex ?? 0;
        if (!Number.isInteger(account) || account < 0) {
            return req.reject(400, 'accountIndex must be a non-negative integer');
        }

        const { network } = normalizeNightgateNetwork(
            getConfiguredNightgateNetwork(getNightgatePluginConfig())
        );
        try {
            return await deriveWalletInfo({ mnemonic, seedHex, accountIndex: account, network });
        } catch (e: any) {
            // SDK/derivation failure. Generic message on purpose: never let an
            // error path reflect secret material back to the caller or logs.
            cds.log('nightgate').error('deriveWalletInfo failed:', e?.message ?? 'unknown');
            return req.reject(500, 'wallet derivation failed');
        }
    });

    srv.on('connectWalletForSigning', async (req: Request) => {
        const clientKey = (req as any)?._.req?.ip || 'global';
        const rateResult = signingKeyRateLimiter.check(clientKey);
        if (!rateResult.allowed) {
            return req.reject(429, `Rate limited. Retry after ${Math.ceil(rateResult.retryAfterMs / 1000)}s`);
        }

        const userId = requireUserId(req);
        if (!userId) return;

        const { sessionId, mnemonic, seedHex, accountIndex, idempotencyKey, prewarm } = req.data as {
            sessionId: string;
            mnemonic?: string;
            seedHex?: string;
            accountIndex?: number;
            idempotencyKey?: string;
            prewarm?: boolean;
        };
        if (!sessionId) return req.reject(400, 'sessionId is required');
        const account = accountIndex ?? 0;
        if (!Number.isInteger(account) || account < 0) {
            return req.reject(400, 'accountIndex must be a non-negative integer');
        }

        let bip39SeedHex: string;
        if (mnemonic) {
            try {
                bip39SeedHex = mnemonicToBip39SeedHex(mnemonic);
            } catch {
                return req.reject(400, 'mnemonic is not a valid BIP39 phrase');
            }
        } else if (seedHex) {
            if (!/^[0-9a-fA-F]+$/.test(seedHex) || seedHex.length !== BIP39_SEED_HEX_LENGTH) {
                return req.reject(400, `seedHex must be ${BIP39_SEED_HEX_LENGTH} hex characters (64-byte BIP39 seed)`);
            }
            bip39SeedHex = seedHex.toLowerCase();
        } else {
            return req.reject(400, 'either mnemonic or seedHex (64-byte BIP39 seed, 128 hex chars) is required');
        }

        // Detached read: the viewing-key derivation below loads the ESM SDK
        // (slow on first use), and the request tx should not sit open (pinning
        // a pool connection) while that runs. The UPDATE + startJob further
        // down still use the ambient tx so job insert and key write commit
        // together.
        const session: any = await runWithoutAmbientTx(() => db.run(
            SELECT.one.from(WalletSessions).where({ sessionId, isActive: true, userId })
        ));
        if (!session) return req.reject(404, 'Session not found or inactive');
        if (session.expiresAt && new Date(session.expiresAt) < new Date()) {
            return req.reject(410, 'Session expired');
        }

        const encKey = getEncryptionKey();

        // Fail-closed seed/session consistency check: the seed at this
        // accountIndex must derive the session's viewing key. Without it a
        // wrong account (or wrong mnemonic) silently signs with keys that
        // belong to nobody the session knows: unfunded signer, and an on-chain
        // caller_id that never matches the attesterId deriveWalletInfo
        // reported for the connected account.
        let sessionViewingKey: string;
        try {
            sessionViewingKey = decrypt(session.encryptedViewingKey, encKey);
        } catch {
            return req.reject(500, 'Failed to decrypt session viewing key (ENCRYPTION_KEY mismatch?)');
        }
        let derivedViewingKey: string;
        try {
            derivedViewingKey = await deriveViewingKeyForAccount(bip39SeedHex, account);
        } catch (e: any) {
            log.error('viewing-key derivation failed:', e?.message ?? 'unknown');
            return req.reject(500, 'wallet derivation failed');
        }
        if (derivedViewingKey.toLowerCase() !== sessionViewingKey.toLowerCase()) {
            return req.reject(400,
                `Seed does not derive this session's viewing key at accountIndex ${account}. ` +
                `Connect the session with the viewingKey deriveWalletInfo returns for the same secret and accountIndex.`);
        }

        const encryptedSeedKey = encrypt(bip39SeedHex, encKey);

        await db.run(
            UPDATE.entity(WalletSessions)
                .set({ encryptedSeedKey, accountIndex: account })
                .where({ sessionId, userId })
        );

        // skips scheduling the sync-to-tip job entirely
        if (prewarm === false) {
            return { sessionId, signingEnabled: true, prewarmJobId: null, prewarmStatus: null };
        }

        // Pre-warm the WalletFacade as a tracked background job, pollable via
        // getJobStatus(prewarmJobId, sessionId).
        try {
            const accountId = deriveAccountId(sessionViewingKey);

            const job = await startJob({
                kind: 'connectWalletForSigning',
                sessionId,
                idempotencyKey,
                // Strip the seed; request snapshots must never carry secrets.
                request: { sessionId, accountIdPrefix: accountId.slice(0, 16) },
                requestedBy: userId,
                commandVersion: 1,
                // Tamper protection at rest (AES-GCM), same as contract-call
                // commands: a DB writer must not be able to redirect a replay.
                encryptCommand: true,
                command: { op: 'prewarm' }
            });
            log.info('facade pre-warm job', job.jobId.slice(0, 8), 'started for', accountId.slice(0, 16));

            // Boot hygiene (worker-calls-outside-request-tx FR item 4): this
            // prewarm supersedes every older queued/running prewarm of the
            // session - queued orphans never start, one already mid-run keeps
            // its current worker wait but stays terminally SUPERSEDED. The
            // sweep joins THIS handler's ambient tx (atomic with the job
            // insert above; a detached write here would request a second pool
            // connection while the request tx pins one - deadlock at
            // pool.max=1). Best-effort: a failed sweep must not fail the
            // connect - safe because the sweep savepoints its UPDATE, so a
            // failure cannot leave the PostgreSQL tx aborted.
            try {
                await supersedeQueuedJobs('connectWalletForSigning', sessionId, job.jobId);
            } catch (err: any) {
                log.warn('prewarm supersede sweep failed:', err?.message || err);
            }

            return {
                sessionId,
                signingEnabled: true,
                prewarmJobId: job.jobId,
                prewarmStatus: job.status
            };
        } catch (err: any) {
            log.warn('pre-warm scheduling failed:', err?.message || err);
            return { sessionId, signingEnabled: true, prewarmJobId: null, prewarmStatus: null };
        }
    });

    srv.on('disconnectWallet', async (req: Request) => {
        const userId = requireUserId(req);
        if (!userId) return;

        const { sessionId } = req.data as { sessionId: string };
        if (!sessionId) return req.reject(400, 'sessionId is required');

        // All DB work in this handler runs detached (autocommit): the facade
        // evict below awaits the worker's final multi-MB state save, and an
        // open request tx would pin a pool connection for that whole wait.
        const session: any = await runWithoutAmbientTx(() => db.run(
            SELECT.one.from(WalletSessions).where({ sessionId, userId })
        ));

        if (!session) {
            return req.reject(404, 'Session not found');
        }

        if (session.expiresAt && new Date(session.expiresAt) < new Date()) {
            await runWithoutAmbientTx(() => db.run(
                UPDATE.entity(WalletSessions)
                    .set({ isActive: false, encryptedViewingKey: null, encryptedSeedKey: null })
                    .where({ sessionId, userId })
            ));
            // Same shared-session-aware eviction as a live disconnect: the
            // sweep only selects ACTIVE rows, so skipping this here would
            // leave a sole session's in-memory keys cached forever. The
            // in-memory `session` still carries the key material the row
            // just lost.
            await evictFacadeUnlessShared(db, session, 'disconnectWallet(expired)');
            return req.reject(410, 'Session expired');
        }

        // Deactivate FIRST, then decide about the facade (see the
        // evictFacadeUnlessShared contract: check-before-deactivate is a
        // TOCTOU race between two concurrent disconnects of the same wallet).
        await runWithoutAmbientTx(() => db.run(
            UPDATE.entity(WalletSessions)
                .set({
                    disconnectedAt: new Date().toISOString(),
                    isActive: false,
                    encryptedViewingKey: null,
                    encryptedSeedKey: null
                })
                .where({ sessionId, userId })
        ));

        // Evict the cached WalletFacade so in-memory secret keys are dropped,
        // unless another active session still uses this wallet (that session
        // legitimately needs the facade and its keys).
        await evictFacadeUnlessShared(db, session, 'disconnectWallet');
    });

    srv.on('registerForDustGeneration', async (req: Request) => {
        if (rejectIfMainnetBlocked(req)) return;
        const userId = requireUserId(req);
        if (!userId) return;
        const clientKey = (req as any)?._.req?.ip || 'global';
        const rate = dustRegRateLimiter.check(clientKey);
        if (!rate.allowed) {
            return req.reject(429, `Rate limited. Retry after ${Math.ceil(rate.retryAfterMs / 1000)}s`);
        }

        const { sessionId, dustReceiverAddress, idempotencyKey } = req.data as {
            sessionId: string;
            dustReceiverAddress?: string;
            idempotencyKey?: string;
        };
        if (!sessionId) return req.reject(400, 'sessionId is required');

        const session = await db.run(
            SELECT.one.from(WalletSessions).where({ sessionId, isActive: true, userId })
        );
        if (!session) return req.reject(404, 'Session not found or inactive');
        if (!session.encryptedViewingKey) return req.reject(404, 'Session has no viewing key');
        if (!session.encryptedSeedKey) return req.reject(412, 'Session has no signing key. Call connectWalletForSigning first.');
        if (session.expiresAt && new Date(session.expiresAt) < new Date()) {
            return req.reject(410, 'Session expired');
        }

        // Detach the worker round-trip so the client polls job status instead of
        // waiting for the whole registration.
        return startJob({
            kind: 'registerForDustGeneration',
            sessionId,
            idempotencyKey,
            request: { sessionId, dustReceiverAddress: dustReceiverAddress || null },
            requestedBy: userId,
            commandVersion: 1,
            encryptCommand: true,
            command: { op: 'registerDust', dustReceiverAddress: dustReceiverAddress || undefined }
        });
    });

    srv.on('deregisterFromDustGeneration', async (req: Request) => {
        if (rejectIfMainnetBlocked(req)) return;
        const userId = requireUserId(req);
        if (!userId) return;
        const clientKey = (req as any)?._.req?.ip || 'global';
        const rate = dustRegRateLimiter.check(clientKey);
        if (!rate.allowed) {
            return req.reject(429, `Rate limited. Retry after ${Math.ceil(rate.retryAfterMs / 1000)}s`);
        }

        const { sessionId, idempotencyKey, sponsorSessionId } = req.data as {
            sessionId: string;
            idempotencyKey?: string;
            sponsorSessionId?: string;
        };
        if (!sessionId) return req.reject(400, 'sessionId is required');

        const session = await db.run(
            SELECT.one.from(WalletSessions).where({ sessionId, isActive: true, userId })
        );
        if (!session) return req.reject(404, 'Session not found or inactive');
        if (!session.encryptedViewingKey) return req.reject(404, 'Session has no viewing key');
        if (!session.encryptedSeedKey) return req.reject(412, 'Session has no signing key. Call connectWalletForSigning first.');
        if (session.expiresAt && new Date(session.expiresAt) < new Date()) {
            return req.reject(410, 'Session expired');
        }

        // optional per-tx fee sponsor
        let sponsor: Awaited<ReturnType<typeof resolveFeeSponsor>> | null = null;
        if (sponsorSessionId) {
            try {
                sponsor = await resolveFeeSponsor({
                    db,
                    sponsorSessionId,
                    requestingUserId: userId,
                    config: getNightgatePluginConfig()
                });
            } catch (err) {
                if (err instanceof FeeSponsorError) return req.reject(err.httpStatus, err.message);
                throw err;
            }
        }

        return startJob({
            kind: 'deregisterFromDustGeneration',
            sessionId,
            idempotencyKey,
            request: { sessionId, feeSponsor: sponsor?.sponsorSessionId ?? null },
            requestedBy: userId,
            commandVersion: 1,
            encryptCommand: true,
            command: { op: 'deregisterDust', sponsorSessionId: sponsor?.sponsorSessionId }
        });
    });

    srv.on('sendNight', async (req: Request) => {
        if (rejectIfMainnetBlocked(req)) return;
        const userId = requireUserId(req);
        if (!userId) return;
        const clientKey = (req as any)?._.req?.ip || 'global';
        const rate = sendRateLimiter.check(clientKey);
        if (!rate.allowed) {
            return req.reject(429, `Rate limited. Retry after ${Math.ceil(rate.retryAfterMs / 1000)}s`);
        }

        const { sessionId, receiverAddress, amount, ttlIso, idempotencyKey, tokenTypeHex } = req.data as {
            sessionId: string;
            receiverAddress: string;
            amount: string;
            ttlIso?: string;
            idempotencyKey?: string;
            tokenTypeHex?: string;
        };

        if (!sessionId) return req.reject(400, 'sessionId is required');
        if (!receiverAddress) return req.reject(400, 'receiverAddress is required');
        if (!amount) return req.reject(400, 'amount is required');
        if (tokenTypeHex && !/^[0-9a-fA-F]{64}$/.test(tokenTypeHex)) {
            return req.reject(400, 'tokenTypeHex must be 64 hex chars (a raw token type)');
        }
        // The SDK matches token types by exact string; canonical raw types are
        // lowercase, so normalize before the value reaches worker or job store.
        const tokenType = tokenTypeHex ? tokenTypeHex.toLowerCase() : undefined;

        const hrpOK = receiverAddress.startsWith('mn_shield-addr_') || receiverAddress.startsWith('mn_addr_');
        if (!hrpOK) {
            return req.reject(400,
                `receiverAddress must start with 'mn_shield-addr_' (shielded) or 'mn_addr_' (unshielded), got '${receiverAddress.slice(0, 24)}...'`);
        }
        if (receiverAddress.length < 50) {
            return req.reject(400, `receiverAddress too short (${receiverAddress.length} chars; expected Bech32m of >= 50)`);
        }

        const amountCheck = parseNightAmount(amount, !!tokenType);
        if (!amountCheck.ok) return req.reject(400, amountCheck.msg);

        const ttlErr = validateOptionalTtl(ttlIso);
        if (ttlErr) return req.reject(400, ttlErr);

        const session = await db.run(
            SELECT.one.from(WalletSessions).where({ sessionId, isActive: true, userId })
        );
        if (!session) return req.reject(404, 'Session not found or inactive');
        if (!session.encryptedViewingKey) return req.reject(404, 'Session has no viewing key');
        if (!session.encryptedSeedKey) return req.reject(412, 'Session has no signing key. Call connectWalletForSigning first.');
        if (session.expiresAt && new Date(session.expiresAt) < new Date()) {
            return req.reject(410, 'Session expired');
        }

        return startJob({
            kind: 'sendNight',
            sessionId,
            idempotencyKey,
            request: { sessionId, receiverAddress, amount, ttlIso: ttlIso || null, tokenTypeHex: tokenType || null },
            requestedBy: userId,
            commandVersion: 1,
            // Funds-moving command: encrypt at rest like contract-call commands
            // (AES-GCM confidentiality + tamper detection for the replay path).
            encryptCommand: true,
            command: { op: 'sendNight', receiverAddress, amount, ttlIso, tokenTypeHex: tokenType }
        });
    });

    srv.on('getWalletBalance', async (req: Request) => {
        const userId = requireUserId(req);
        if (!userId) return;
        const clientKey = (req as any)?._.req?.ip || 'global';
        const rate = diagnosticsRateLimiter.check(clientKey);
        if (!rate.allowed) {
            return req.reject(429, `Rate limited. Retry after ${Math.ceil(rate.retryAfterMs / 1000)}s`);
        }

        const { sessionId } = req.data as { sessionId: string };
        if (!sessionId) return req.reject(400, 'sessionId is required');

        const sess = await loadSigningSessionAccountId(db, sessionId, userId);
        if (!sess.ok) return req.reject(sess.status, sess.msg);

        try {
            return await getWalletBalance({ cacheKey: sess.accountId, syncTimeoutMs: readSyncTimeoutMs() });
        } catch (err) {
            return rejectWorkerReadError(req, 'getWalletBalance', err);
        }
    });

    srv.on('getWalletSyncProgress', async (req: Request) => {
        const userId = requireUserId(req);
        if (!userId) return;
        const clientKey = (req as any)?._.req?.ip || 'global';
        const rate = diagnosticsRateLimiter.check(clientKey);
        if (!rate.allowed) {
            return req.reject(429, `Rate limited. Retry after ${Math.ceil(rate.retryAfterMs / 1000)}s`);
        }

        const { sessionId } = req.data as { sessionId: string };
        if (!sessionId) return req.reject(400, 'sessionId is required');

        const sess = await loadSigningSessionAccountId(db, sessionId, userId);
        if (!sess.ok) return req.reject(sess.status, sess.msg);

        // Main-thread cache read: no worker round trip, so a saturated worker
        // cannot make its own progress unreadable.
        const p = walletGetSyncProgress(sess.accountId);
        if (!p) {
            return {
                known: false, caughtUp: false,
                appliedIndex: null, streamTip: null, behindEvents: null,
                eventsPerSecond: null, etaSeconds: null, blockHeight: null,
                isConnected: false, indexerFresh: false,
                elapsedMs: null, phase: null, updatedAt: null
            };
        }
        return {
            known: true,
            caughtUp: p.caughtUp,
            appliedIndex: p.appliedIndex,
            streamTip: p.streamTip,
            behindEvents: p.behindEvents,
            eventsPerSecond: p.eventsPerSecond,
            etaSeconds: p.etaSeconds,
            blockHeight: p.blockHeight,
            isConnected: p.isConnected,
            indexerFresh: p.indexerFresh,
            elapsedMs: p.elapsedMs,
            phase: p.label,
            updatedAt: p.updatedAt
        };
    });

    srv.on('estimateSendNightFee', async (req: Request) => {
        const userId = requireUserId(req);
        if (!userId) return;
        const clientKey = (req as any)?._.req?.ip || 'global';
        const rate = diagnosticsRateLimiter.check(clientKey);
        if (!rate.allowed) {
            return req.reject(429, `Rate limited. Retry after ${Math.ceil(rate.retryAfterMs / 1000)}s`);
        }

        const { sessionId, receiverAddress, amount, ttlIso } = req.data as {
            sessionId: string;
            receiverAddress: string;
            amount: string;
            ttlIso?: string;
        };

        if (!sessionId) return req.reject(400, 'sessionId is required');
        if (!receiverAddress) return req.reject(400, 'receiverAddress is required');
        const hrpOK = receiverAddress.startsWith('mn_shield-addr_') || receiverAddress.startsWith('mn_addr_');
        if (!hrpOK) {
            return req.reject(400,
                `receiverAddress must start with 'mn_shield-addr_' (shielded) or 'mn_addr_' (unshielded), got '${receiverAddress.slice(0, 24)}...'`);
        }
        const amountCheck = parseNightAmount(amount);
        if (!amountCheck.ok) return req.reject(400, amountCheck.msg);
        const ttlErr = validateOptionalTtl(ttlIso);
        if (ttlErr) return req.reject(400, ttlErr);

        const sess = await loadSigningSessionAccountId(db, sessionId, userId);
        if (!sess.ok) return req.reject(sess.status, sess.msg);

        try {
            return await estimateSendNightFee({
                cacheKey: sess.accountId,
                receiverAddress,
                amount,
                ttlIso,
                syncTimeoutMs: readSyncTimeoutMs()
            });
        } catch (err) {
            return rejectWorkerReadError(req, 'estimateSendNightFee', err);
        }
    });

}

/** Rows per UPDATE, so a database with thousands of leftovers stays within
 *  the driver's parameter limit. */
const SESSION_CLOSE_CHUNK = 200;

/**
 * Close the wallet sessions left behind by the PREVIOUS process. Called once at
 * plugin init, before any request can arrive. Returns the closed session ids so
 * the caller can also drop the queued jobs that signed with them
 * (`dropPendingJobsForClosedSessions`); a replay of those jobs would only die
 * later in `executeWalletCommand` with a misleading "Session not found".
 *
 * A session is a per-connect handle owned by a caller in a specific process, not
 * a property of the wallet: `connectWallet` inserts a row per call and only
 * `disconnectWallet` closes one, so every ungraceful stop leaks its handles for
 * the full 24h TTL. Live-observed: 12 simultaneously active rows for a single
 * wallet. The facade is unaffected either way (it is cached per accountId, one
 * per wallet, and a fresh process has none), so the leak costs two things: the
 * shared-session guard in `evictFacadeUnlessShared` counts those dead rows as
 * live users and therefore keeps a wallet's in-memory keys after a legitimate
 * `disconnectWallet`, and each row keeps encrypted seed material at rest a day
 * past the death of the process that authorised it. Both are closed here.
 *
 * `runtimeMode` requires exactly one replica (`runtime-topology.ts`), so "left
 * over from a previous process" really does mean dead, not "belongs to a
 * sibling instance". Do NOT extend this to a multi-replica deployment without
 * an instance-scoped owner column.
 *
 * CONFIGURED FEE-SPONSOR SESSIONS ARE EXEMPT. Their ids are pinned in the
 * deployment config and usable by any authenticated caller
 * (`resolveFeeSponsor`), i.e. they are deliberately long-lived and process
 * independent. Closing them would break sponsored submissions after every
 * restart until an operator pinned a fresh id.
 *
 * No facade eviction here (a fresh process has no facades) and no key material
 * survives: the same columns `disconnectWallet` clears are cleared.
 */
export async function closeSessionsFromPreviousProcess(db: any, config?: Record<string, any>): Promise<string[]> {
    const exempt = new Set(getConfiguredFeeSponsorSessions(config));
    const active: any[] = (await db.run(
        SELECT.from(WalletSessions).columns('sessionId').where({ isActive: true })
    )) || [];
    const stale = active.map(r => r.sessionId).filter((id: string) => id && !exempt.has(id));
    if (stale.length === 0) return [];

    const now = new Date().toISOString();
    for (let i = 0; i < stale.length; i += SESSION_CLOSE_CHUNK) {
        await db.run(
            UPDATE.entity(WalletSessions)
                .set({
                    isActive: false,
                    disconnectedAt: now,
                    encryptedViewingKey: null,
                    encryptedSeedKey: null
                })
                .where({ sessionId: { in: stale.slice(i, i + SESSION_CLOSE_CHUNK) } })
        );
    }
    return stale;
}

/**
 * Start periodic cleanup of expired wallet sessions.
 * Returns the timer handle for cleanup on shutdown.
 */
export function startSessionCleanup(db: any): ReturnType<typeof setInterval> {
    const SESSION_CLEANUP_INTERVAL = 15 * 60 * 1000;
    const timer = setInterval(async () => {
        try {
            const now = new Date().toISOString();
            const expiring: any[] = (await db.run(
                SELECT.from(WalletSessions)
                    .columns('sessionId', 'viewingKeyHash', 'encryptedViewingKey')
                    .where({ isActive: true, expiresAt: { '<': now } })
            )) || [];
            if (expiring.length === 0) return;
            // Deactivate FIRST, scoped to the selected rows: a row expiring
            // between SELECT and UPDATE must not be deactivated unseen (its
            // facade decision would be skipped forever, since the sweep only
            // selects active rows). The eviction decision then runs per
            // wallet with the shared-session guard (see
            // evictFacadeUnlessShared: keyed with the facade cache's
            // accountId while sessions are per-connect rows).
            await db.run(
                UPDATE.entity(WalletSessions)
                    .set({ isActive: false, encryptedViewingKey: null, encryptedSeedKey: null })
                    .where({ sessionId: { in: expiring.map(s => s.sessionId) } })
            );
            const decidedHashes = new Set<string>();
            for (const s of expiring) {
                if (!s.encryptedViewingKey) continue;
                if (s.viewingKeyHash) {
                    // One decision per wallet, not per row.
                    if (decidedHashes.has(s.viewingKeyHash)) continue;
                    decidedHashes.add(s.viewingKeyHash);
                }
                await evictFacadeUnlessShared(
                    db, s, `session cleanup (expired session ${String(s.sessionId).slice(0, 8)})`
                );
            }
        } catch { /* ignore cleanup errors */ }
    }, SESSION_CLEANUP_INTERVAL);

    // Guard retained for tests that mock setInterval to return a bare object.
    // Production NodeJS.Timeout always has unref(); tests deliberately don't.
    if (typeof timer.unref === 'function') {
        timer.unref();
    }

    return timer;
}
