/** Wallet session handlers: connect, disconnect, wallet jobs, cleanup. */

import cds, { Request } from '@sap/cds';
const { SELECT, INSERT, UPDATE } = cds.ql;
import { WalletSessions } from '#cds-models/midnight';
import { getEncryptionKey, encrypt, decrypt, hashViewingKey } from '../utils/crypto';
import { walletSessionViewingKeyBinding, walletSessionSeedBinding } from '../utils/envelope-bindings';
import { validateViewingKey } from '../utils/validation';
import { RateLimiter } from '../utils/rate-limiter';
import { evictWalletFacade } from '../submission/wallet-facade-builder';
import { withKeyedLock } from '../utils/keyed-lock';
import { deriveAccountId, deriveStoragePassword } from '../submission/wallet-material-factory';
import { resolveAccountDek } from '../submission/account-keys';
import { registerNightUtxosForDust, deregisterNightUtxosFromDust } from '../submission/dust-registration';
const log = cds.log('nightgate:sessions');
import {
    sendNight,
    getWalletBalance,
    estimateSendNightFee
} from '../submission/token-ops';
import { ensureNetworkId } from '../midnight/providers';
import { getOrBuildWalletFacade, hasWalletFacade, getFacadeOrigin } from '../submission/wallet-facade-builder';
import { walletWaitForSyncedState, walletGetSyncProgress } from '../midnight/wallet-worker-client';
import {
    resolveNightgateRuntimeConfig, getNightgatePluginConfig, mainnetSubmissionBlockReason,
    getConfiguredNightgateNetwork, normalizeNightgateNetwork
} from '../utils/nightgate-config';
import { startJob, registerBackgroundJobProcessor, runWithoutAmbientTx, supersedeQueuedJobs, findLatestJob, JobAdmissionBusyError, type BackgroundJobRow } from '../submission/background-jobs';
import { declaredJobKindTraits } from '../submission/job-kinds';
import { reportExternalExecution, reportBroadcastOn, reportSubmissionRejectedOn } from '../submission/job-execution-context';
import { isPreInclusionReject } from '../submission/sponsor-pool';
import { mnemonicToBip39SeedHex } from '../utils/wallet-hd';
import { deriveWalletInfo, resolveBip39SeedHex, deriveViewingKeyForAccount } from '../utils/wallet-info';
import { resolveFeeSponsor, ensureFeeSponsorFacade, FeeSponsorError, getConfiguredFeeSponsorSessions } from '../submission/fee-sponsor';
import { isSessionExpired } from '../utils/session-expiry';
import { principalRateKey } from '../utils/rate-limiter';
import { configMs, configNumber } from '../utils/config';
import { syncGateReading } from '../submission/sponsor-sync-gate';

// Absolute ceiling for the prewarm wait; the primary bound is lack of progress.
const PREWARM_SYNC_TIMEOUT_MS = configMs('NIGHTGATE_PREWARM_SYNC_TIMEOUT_MS');
const PREWARM_STALL_MS = configMs('NIGHTGATE_PREWARM_STALL_MS');

const SYNC_PROGRESS_STALE_S = configNumber('NIGHTGATE_SYNC_PROGRESS_STALE_S');

// Facade-backed reads answer 503 WALLET_SYNCING instead of parking while the
// facade catches up. <= 0 waits indefinitely.
const WALLET_READ_SYNC_TIMEOUT_MS = configMs('NIGHTGATE_WALLET_READ_SYNC_TIMEOUT_MS');
const readSyncTimeoutMs = (): number | undefined =>
    WALLET_READ_SYNC_TIMEOUT_MS > 0 ? WALLET_READ_SYNC_TIMEOUT_MS : undefined;

/** `startJob` that turns a busy admission into a retryable 503 with `Retry-After`. */
async function startJobOrRetryAfter(req: Request, input: Parameters<typeof startJob>[0]): Promise<Awaited<ReturnType<typeof startJob>>> {
    try {
        return await startJob(input);
    } catch (err) {
        if (err instanceof JobAdmissionBusyError) {
            try { (req as any).http?.res?.set?.('Retry-After', String(err.retryAfterSeconds)); } catch { /* courtesy header */ }
            return req.reject({ status: err.httpStatus, code: err.code, message: err.message, $sanitize: false } as any);
        }
        throw err;
    }
}

function rejectWorkerReadError(req: Request, action: string, err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/sync timeout/i.test(msg)) {
        // `$sanitize: false`: CAP strips 5xx messages in production; this one is retry advice.
        try { (req as any).http?.res?.set?.('Retry-After', '15'); } catch { /* courtesy header */ }
        return req.reject({
            code: 'WALLET_SYNCING',
            status: 503,
            message: `${action}: wallet is still syncing to the indexer tip; retry shortly`,
            $sanitize: false
        } as any);
    }
    return req.reject(500, `${action} failed: ${msg}`);
}

const walletRateLimiter = new RateLimiter({
    windowMs: 60 * 1000,
    maxRequests: 10
});

const signingKeyRateLimiter = new RateLimiter({
    // Shared with deriveWalletInfo; tight, since a signing key is added once per session.
    windowMs: 60 * 60 * 1000,
    maxRequests: configNumber('NIGHTGATE_SIGNING_KEY_RATE_LIMIT')
});

const dustRegRateLimiter = new RateLimiter({
    windowMs: 60 * 60 * 1000,
    maxRequests: 10
});

const sendRateLimiter = new RateLimiter({
    windowMs: 60 * 1000,
    maxRequests: 10
});

const diagnosticsRateLimiter = new RateLimiter({
    windowMs: 60 * 1000,
    maxRequests: 60
});

/** Forget every rate-limit window (tests: one principal serves every case). */
export function __resetWalletRateLimitersForTests(): void {
    for (const l of [walletRateLimiter, signingKeyRateLimiter, dustRegRateLimiter, sendRateLimiter, diagnosticsRateLimiter]) l.reset();
}

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
    if (isSessionExpired(job.sessionId, session.expiresAt)) throw new Error('Session expired');
    if (!session.encryptedViewingKey || !session.encryptedSeedKey) throw new Error('Session no longer has signing material');

    const encKey = getEncryptionKey();
    const viewingKey = decrypt(session.encryptedViewingKey, encKey, walletSessionViewingKeyBinding(session.sessionId));
    const seedHex = decrypt(session.encryptedSeedKey, encKey, walletSessionSeedBinding(session.sessionId));
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
        await walletWaitForSyncedState(accountId, PREWARM_SYNC_TIMEOUT_MS, PREWARM_STALL_MS);
        return { ready: true };
    }
    // Record each announced identifier on the job before broadcast; a pre-inclusion
    // reject takes it off again, so the job's txHash is the one that may be on chain.
    let announced: string | null = null;
    const onSubmitIntent = async (txHash: string) => { await reportBroadcastOn(db, { txHash, firstBoundary: false }); announced = txHash; };
    const withRejectBookkeeping = async <T>(work: () => Promise<T>): Promise<T> => {
        try {
            return await work();
        } catch (err) {
            const rejected = announced;
            if (rejected && isPreInclusionReject(err)) {
                try {
                    await reportSubmissionRejectedOn(db, { txHash: rejected });
                    announced = null;
                } catch (e) {
                    cds.log('nightgate').warn(`rejected identifier ${rejected.slice(0, 16)} could not be taken off job ${job.ID}; it stays for reconciliation: ${String((e as Error)?.message ?? e)}`);
                }
            }
            throw err;
        }
    };
    if (command.op === 'registerDust') {
        await reportExternalExecution({});
        const result = await withRejectBookkeeping(() => registerNightUtxosForDust({
            cacheKey: accountId, seedHex, facadeConfig,
            dustReceiverAddress: command.dustReceiverAddress || undefined,
            onSubmitIntent
        }));
        return { ...result, txId: result.txId ?? '' };
    }
    if (command.op === 'deregisterDust') {
        const sponsor = command.sponsorSessionId
            ? await resolveFeeSponsor({ db, sponsorSessionId: command.sponsorSessionId, requestingUserId: job.requestedBy, config: getNightgatePluginConfig() })
            : null;
        if (sponsor) await ensureFeeSponsorFacade(sponsor, facadeConfig);
        await reportExternalExecution({});
        const result = await withRejectBookkeeping(() => deregisterNightUtxosFromDust({ cacheKey: accountId, sponsorCacheKey: sponsor?.accountId, onSubmitIntent }));
        return { txId: result.txId ?? '', deregisteredCount: result.deregisteredCount, totalNightUtxos: result.totalNightUtxos, ...(sponsor ? { feeSponsor: sponsor.sponsorSessionId } : {}) };
    }
    if (command.op === 'sendNight') {
        await reportExternalExecution({});
        const result = await withRejectBookkeeping(() => sendNight({ cacheKey: accountId, receiverAddress: command.receiverAddress, amount: command.amount, ttlIso: command.ttlIso, tokenTypeHex: command.tokenTypeHex, onSubmitIntent }));
        return { txId: result.txId, toLedger: result.toLedger, amount: result.amount, receiverAddress: result.receiverAddress };
    }
    throw new Error(`Unsupported wallet command operation: ${(command as any).op}`);
}

/** Mainnet submission gate for on-chain actions; read-only diagnostics are exempt. */
function rejectIfMainnetBlocked(req: Request): boolean {
    const reason = mainnetSubmissionBlockReason(getNightgatePluginConfig());
    if (reason) {
        req.reject?.(403, reason);
        return true;
    }
    return false;
}

/** Parse and bound an atom amount; `msg` is user-facing. */
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

function validateOptionalTtl(ttlIso: string | undefined): string | null {
    if (!ttlIso) return null;
    const t = new Date(ttlIso);
    if (Number.isNaN(t.getTime())) return 'ttlIso must be a valid ISO-8601 timestamp';
    if (t.getTime() <= Date.now()) return 'ttlIso must be in the future';
    return null;
}

/**
 * Principal id, or 401 + undefined. Every session-scoped action must bail on
 * undefined: a leaked sessionId alone must not grant another principal access.
 */
function requireUserId(req: Request): string | undefined {
    const uid = (req as any).user?.id;
    if (!uid) { req.reject?.(401, 'authentication required'); return undefined; }
    return uid as string;
}

/**
 * Active signing session -> accountId, owner-scoped (foreign reads as 404). Read
 * outside the request tx: callers then await the worker, and an open tx would pin
 * a pool connection. No read-your-own-write.
 */
async function loadSigningSessionAccountId(
    db: any,
    sessionId: string,
    /** `undefined` drops the owner constraint: ONLY for a configured platform sponsor, never a request's id. */
    userId: string | undefined,
    /** ONLY for a configured platform sponsor, which does not expire. */
    ignoreExpiry = false
): Promise<{ ok: true; accountId: string } | { ok: false; status: number; msg: string }> {
    const where: Record<string, unknown> = { sessionId, isActive: true };
    if (userId !== undefined) where.userId = userId;
    const session: any = await runWithoutAmbientTx(() => db.run(
        SELECT.one.from(WalletSessions).where(where)
    ));
    if (!session) return { ok: false, status: 404, msg: 'Session not found or inactive' };
    if (!session.encryptedViewingKey) return { ok: false, status: 404, msg: 'Session has no viewing key' };
    if (!session.encryptedSeedKey) return { ok: false, status: 412, msg: 'Session has no signing key. Call connectWalletForSigning first.' };
    if (!ignoreExpiry && isSessionExpired(sessionId, session.expiresAt)) {
        return { ok: false, status: 410, msg: 'Session expired' };
    }
    let viewingKey: string;
    try {
        viewingKey = decrypt(session.encryptedViewingKey, getEncryptionKey(), walletSessionViewingKeyBinding(session.sessionId));
    } catch {
        return { ok: false, status: 500, msg: 'Failed to decrypt session keys (ENCRYPTION_KEY mismatch?)' };
    }
    return { ok: true, accountId: deriveAccountId(viewingKey) };
}

/**
 * Any live session of this user on this wallet. Callers MUST deactivate their
 * own rows first, so "any live row" means another live session.
 */
async function hasLiveSessionForWallet(
    db: any,
    viewingKeyHash: string | null | undefined,
    userId: string | null | undefined
): Promise<boolean> {
    if (!viewingKeyHash || !userId) return false;
    // Expiry decided in JS, not SQL: SQL does not know that platform sponsors never expire.
    // Same user only: another user's session must not keep the owner's keys warm.
    const rows: any = await runWithoutAmbientTx(() => db.run(
        SELECT.from(WalletSessions)
            .columns('sessionId', 'expiresAt')
            .where({ viewingKeyHash, userId, isActive: true })
    ));
    if (!Array.isArray(rows)) return false;
    return rows.some((r: any) => !isSessionExpired(r.sessionId, r.expiresAt));
}

/**
 * Evict the account's facade unless a sibling session still uses it. Call AFTER
 * deactivating the own rows (else two concurrent disconnects both skip); the
 * account lock guards against a concurrent rebuild. Never throws.
 */
async function evictFacadeUnlessShared(
    db: any,
    session: { sessionId: string; encryptedViewingKey?: string | null; viewingKeyHash?: string | null; userId?: string | null },
    context: string
): Promise<void> {
    try {
        if (!session.encryptedViewingKey) return;
        const viewingKey = decrypt(session.encryptedViewingKey, getEncryptionKey(), walletSessionViewingKeyBinding(session.sessionId));
        const accountId = deriveAccountId(viewingKey);
        await withKeyedLock(accountId, async () => {
            if (session.viewingKeyHash && await hasLiveSessionForWallet(db, session.viewingKeyHash, session.userId)) {
                log.info(`${context}: keeping facade ${accountId.slice(0, 16)} (another active session of this user uses this wallet)`);
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
        registerBackgroundJobProcessor(kind, 1, declaredJobKindTraits(kind), (command, row) => executeWalletCommand(command, row, db));
    }
    srv.on('connectWallet', async (req: Request) => {
        const clientKey = principalRateKey(req, 'wallet');
        const rateResult = walletRateLimiter.check(clientKey);
        if (!rateResult.allowed) {
            return req.reject(429, `Rate limited. Retry after ${Math.ceil(rateResult.retryAfterMs / 1000)}s`);
        }

        const userId = requireUserId(req);
        if (!userId) return;

        const { viewingKey, label } = req.data as { viewingKey: string; label?: string };

        const validationError = validateViewingKey(viewingKey);
        if (validationError) {
            return req.reject(400, validationError);
        }
        // Bounded so the label cannot serve as a storage field.
        if (label !== undefined && label !== null && String(label).length > 100) {
            return req.reject(400, 'label must be at most 100 characters');
        }

        const encKey = getEncryptionKey();
        const vkHash = hashViewingKey(viewingKey);
        const sessionId = cds.utils.uuid();
        const encryptedVk = encrypt(viewingKey, encKey, walletSessionViewingKeyBinding(sessionId));

        const nightgateConfig = getNightgatePluginConfig();
        const sessionTtlMs = nightgateConfig.sessionTtlMs || 24 * 60 * 60 * 1000;
        const expiresAt = new Date(Date.now() + sessionTtlMs).toISOString();

        const session = {
            ID: cds.utils.uuid(),
            userId,
            sessionId,
            viewingKeyHash: vkHash,
            encryptedViewingKey: encryptedVk,
            label: label ? String(label) : null,
            connectedAt: new Date().toISOString(),
            expiresAt,
            isActive: true
        };

        await db.run(INSERT.into(WalletSessions).entries(session));
        // Create the account data key now, so a ring rotation can rewrap it
        // without this wallet connected. Idempotent.
        try {
            await resolveAccountDek({ db, ring: encKey, accountId: deriveAccountId(viewingKey), storagePassword: deriveStoragePassword(viewingKey) });
        } catch (err) {
            log.warn(`connectWallet: account key not created now (${String((err as Error)?.message ?? err)}); it is created on first use`);
        }

        return {
            ID: session.ID,
            sessionId: session.sessionId,
            label: session.label,
            connectedAt: session.connectedAt,
            expiresAt: session.expiresAt,
            isActive: true
        };
    });

    srv.on('deriveWalletInfo', async (req: Request) => {
        const clientKey = principalRateKey(req, 'wallet');
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
            // Generic message: never reflect secret material to caller or logs.
            cds.log('nightgate').error('deriveWalletInfo failed:', e?.message ?? 'unknown');
            return req.reject(500, 'wallet derivation failed');
        }
    });

    srv.on('connectWalletForSigning', async (req: Request) => {
        const clientKey = principalRateKey(req, 'wallet');
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

        // Detached read: the derivation below is slow and must not pin a pool
        // connection. UPDATE + startJob stay in the ambient tx, committing together.
        const session: any = await runWithoutAmbientTx(() => db.run(
            SELECT.one.from(WalletSessions).where({ sessionId, isActive: true, userId })
        ));
        if (!session) return req.reject(404, 'Session not found or inactive');
        if (isSessionExpired(sessionId, session.expiresAt)) {
            return req.reject(410, 'Session expired');
        }

        const encKey = getEncryptionKey();

        // The seed must derive the session's viewing key at this accountIndex, or
        // it would sign as an unfunded identity nobody reported.
        let sessionViewingKey: string;
        try {
            sessionViewingKey = decrypt(session.encryptedViewingKey, encKey, walletSessionViewingKeyBinding(session.sessionId));
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

        const encryptedSeedKey = encrypt(bip39SeedHex, encKey, walletSessionSeedBinding(session.sessionId));

        await db.run(
            UPDATE.entity(WalletSessions)
                .set({ encryptedSeedKey, accountIndex: account })
                .where({ sessionId, userId })
        );

        if (prewarm === false) {
            return { sessionId, signingEnabled: true, prewarmJobId: null, prewarmStatus: null };
        }

        try {
            const accountId = deriveAccountId(sessionViewingKey);

            const job = await startJob({
                kind: 'connectWalletForSigning',
                sessionId,
                idempotencyKey,
                // Request snapshots must never carry secrets.
                request: { sessionId, accountIdPrefix: accountId.slice(0, 16) },
                requestedBy: userId,
                commandVersion: 1,
                // A DB writer must not be able to redirect a replay.
                encryptCommand: true,
                command: { op: 'prewarm' }
            });
            log.info('facade pre-warm job', job.jobId.slice(0, 8), 'started for', accountId.slice(0, 16));

            // Supersede older prewarms of the session. Runs in the ambient tx: a
            // detached write would deadlock at pool.max=1. Best-effort is safe
            // because the sweep savepoints its UPDATE.
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

        // All DB work detached: the evict awaits the worker's final state save,
        // which must not pin a pool connection.
        const session: any = await runWithoutAmbientTx(() => db.run(
            SELECT.one.from(WalletSessions).where({ sessionId, userId })
        ));

        if (!session) {
            return req.reject(404, 'Session not found');
        }

        if (isSessionExpired(sessionId, session.expiresAt)) {
            await runWithoutAmbientTx(() => db.run(
                UPDATE.entity(WalletSessions)
                    .set({ isActive: false, encryptedViewingKey: null, encryptedSeedKey: null })
                    .where({ sessionId, userId })
            ));
            // The sweep only sees active rows, so evict here or the keys stay cached.
            await evictFacadeUnlessShared(db, session, 'disconnectWallet(expired)');
            return req.reject(410, 'Session expired');
        }

        // Deactivate FIRST (evictFacadeUnlessShared contract).
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

        await evictFacadeUnlessShared(db, session, 'disconnectWallet');
    });

    srv.on('registerForDustGeneration', async (req: Request) => {
        if (rejectIfMainnetBlocked(req)) return;
        const userId = requireUserId(req);
        if (!userId) return;
        const clientKey = principalRateKey(req, 'wallet');
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
        if (isSessionExpired(sessionId, session.expiresAt)) {
            return req.reject(410, 'Session expired');
        }

        return startJobOrRetryAfter(req, {
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
        const clientKey = principalRateKey(req, 'wallet');
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
        if (isSessionExpired(sessionId, session.expiresAt)) {
            return req.reject(410, 'Session expired');
        }

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

        return startJobOrRetryAfter(req, {
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
        const clientKey = principalRateKey(req, 'wallet');
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
        // The SDK matches token types by exact string; canonical raw types are lowercase.
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
        if (isSessionExpired(sessionId, session.expiresAt)) {
            return req.reject(410, 'Session expired');
        }

        return startJobOrRetryAfter(req, {
            kind: 'sendNight',
            sessionId,
            idempotencyKey,
            request: { sessionId, receiverAddress, amount, ttlIso: ttlIso || null, tokenTypeHex: tokenType || null },
            requestedBy: userId,
            commandVersion: 1,
            encryptCommand: true,
            command: { op: 'sendNight', receiverAddress, amount, ttlIso, tokenTypeHex: tokenType }
        });
    });

    srv.on('getWalletBalance', async (req: Request) => {
        const userId = requireUserId(req);
        if (!userId) return;
        const clientKey = principalRateKey(req, 'wallet');
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

    /**
     * Sponsor pool health for every authenticated caller (all may use the pool).
     * Amounts only for admins and session owners.
     */
    srv.on('getSponsorPoolStatus', async (req: Request) => {
        const userId = requireUserId(req);
        if (!userId) return;
        const clientKey = principalRateKey(req, 'wallet');
        const rate = diagnosticsRateLimiter.check(clientKey);
        if (!rate.allowed) {
            return req.reject(429, `Rate limited. Retry after ${Math.ceil(rate.retryAfterMs / 1000)}s`);
        }

        const sponsorIds = getConfiguredFeeSponsorSessions(getNightgatePluginConfig());
        if (sponsorIds.length === 0) return [];

        const isAdmin = Boolean((req.user as any)?.is?.('admin'));

        // The sync gate does not bound a cold facade build, so each per-sponsor
        // read gets its own cap.
        const perSponsorTimeoutMs = configMs('NIGHTGATE_SPONSOR_STATUS_TIMEOUT_MS');
        const withCap = async <T>(work: Promise<T>, what: string): Promise<T> => {
            let timer: NodeJS.Timeout | undefined;
            try {
                return await Promise.race([
                    work,
                    new Promise<never>((_, reject) => {
                        timer = setTimeout(
                            () => reject(new Error(`${what} did not answer within ${perSponsorTimeoutMs}ms (facade still warming up?)`)),
                            perSponsorTimeoutMs
                        );
                    })
                ]);
            } finally {
                if (timer) clearTimeout(timer);
            }
        };

        // A busy worker (a snapshot restore holds it for minutes) must not read as an empty
        // pool: the last pushed dust figures stand in, marked stale, never usable.
        const resolved = new Map<string, { accountId: string; maySeeAmounts: boolean }>();
        const lastKnown = (sessionId: string, lastError: string) => {
            const r = resolved.get(sessionId);
            const progress = r ? walletGetSyncProgress(r.accountId) : null;
            const d = progress?.dust;
            if (!r || !d) return null;
            return {
                sessionId,
                configured: true,
                usable: false,
                dustBalance: r.maySeeAmounts ? d.balance : null,
                unshieldedNight: null,
                totalNightUtxoCount: d.totalNightUtxos,
                registeredNightUtxos: d.registeredNightUtxos,
                dustNotes: d.availableNotes,
                pendingDustNotes: d.pendingNotes,
                dustRestoreCount: d.restoreCount,
                caughtUp: syncGateReading(progress).caughtUp,
                stale: true,
                asOf: d.at,
                lastError
            };
        };

        const readSponsor = async (sessionId: string) => {
            const unusable = (lastError: string) => ({
                sessionId,
                configured: true,
                usable: false,
                dustBalance: null,
                unshieldedNight: null,
                totalNightUtxoCount: 0,
                registeredNightUtxos: 0,
                dustNotes: 0,
                pendingDustNotes: 0,
                dustRestoreCount: 0,
                caughtUp: false,
                stale: false,
                asOf: null,
                lastError
            });

            const session: any = await runWithoutAmbientTx(() => db.run(
                SELECT.one.from(WalletSessions).where({ sessionId, isActive: true })
            ));
            if (!session) return unusable('configured sponsor session is missing or inactive');
            if (!session.encryptedSeedKey) {
                return unusable('sponsor session has no signing key; call connectWalletForSigning for it');
            }

            const maySeeAmounts = isAdmin || session.userId === userId;

            // Platform sponsors: no owner constraint, no expiry (as resolveFeeSponsor).
            const sess = await loadSigningSessionAccountId(db, sessionId, undefined, true);
            if (!sess.ok) return unusable(sess.msg);
            resolved.set(sessionId, { accountId: sess.accountId, maySeeAmounts });

            const progress = walletGetSyncProgress(sess.accountId);
            // Must not create work: getWalletBalance would build an absent facade
            // past the cap. Both checks needed: a fresh facade has no progress yet.
            if (!progress && !hasWalletFacade(sess.accountId)) {
                return {
                    ...unusable('sponsor facade is not warm yet; ask again once it has synced'),
                    caughtUp: false
                };
            }
            try {
                const balance: any = await getWalletBalance({
                    cacheKey: sess.accountId,
                    syncTimeoutMs: readSyncTimeoutMs(),
                    // The cap reaches the worker RPC too, or abandoned RPCs pile up.
                    rpcTimeoutMs: perSponsorTimeoutMs
                });
                // Parallelism = free dust notes, not own registrations (generation
                // can be delegated from foreign NIGHT).
                const ownRegistered = Number(balance?.registeredNightUtxoCount ?? 0);
                const pendingNotes = Number(balance?.dustPendingCount ?? 0);
                const dustNotes = balance?.dustAvailableCount !== undefined
                    ? Number(balance.dustAvailableCount)
                    : Math.max(0, Number(balance?.dustUtxoCount ?? 0) - pendingNotes);
                // The sponsored-job sync gate, read after the balance call (fresher).
                const gate = syncGateReading(walletGetSyncProgress(sess.accountId));
                return {
                    sessionId,
                    configured: true,
                    // Can pay NOW; own registrations deliberately do not gate this.
                    usable: gate.caughtUp && dustNotes > 0 && BigInt(String(balance?.dustBalance ?? '0')) > 0n,
                    dustBalance: maySeeAmounts ? String(balance?.dustBalance ?? '0') : null,
                    unshieldedNight: maySeeAmounts ? String(balance?.unshieldedNight ?? '0') : null,
                    totalNightUtxoCount: Number(balance?.totalNightUtxoCount ?? 0),
                    registeredNightUtxos: ownRegistered,
                    dustNotes,
                    pendingDustNotes: pendingNotes,
                    dustRestoreCount: Number(balance?.dustRestoreCount ?? 0),
                    caughtUp: gate.caughtUp,
                    stale: false,
                    asOf: new Date().toISOString(),
                    lastError: gate.reason
                };
            } catch (err) {
                // One unreadable sponsor must not hide the rest of the pool.
                const msg = err instanceof Error ? err.message : String(err);
                return lastKnown(sessionId, msg) ?? {
                    ...unusable(msg),
                    caughtUp: syncGateReading(walletGetSyncProgress(sess.accountId)).caughtUp
                };
            }
        };

        // Bounded concurrency: timeouts must not add up, nor all facades build at once.
        const rows: unknown[] = new Array(sponsorIds.length);
        let next = 0;
        await Promise.all(Array.from({ length: Math.min(3, sponsorIds.length) }, async () => {
            for (;;) {
                const index = next++;
                const id = sponsorIds[index];
                if (id === undefined) return;
                try {
                    rows[index] = await withCap(readSponsor(id), 'sponsor status read');
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    rows[index] = lastKnown(id, msg) ?? {
                        sessionId: id,
                        configured: true,
                        usable: false,
                        dustBalance: null,
                        unshieldedNight: null,
                        totalNightUtxoCount: 0,
                        registeredNightUtxos: 0,
                        dustNotes: 0,
                        pendingDustNotes: 0,
                        dustRestoreCount: 0,
                        caughtUp: false,
                        stale: false,
                        asOf: null,
                        lastError: msg
                    };
                }
            }
        }));
        return rows;
    });

    srv.on('getWalletSyncProgress', async (req: Request) => {
        const userId = requireUserId(req);
        if (!userId) return;
        const clientKey = principalRateKey(req, 'wallet');
        const rate = diagnosticsRateLimiter.check(clientKey);
        if (!rate.allowed) {
            return req.reject(429, `Rate limited. Retry after ${Math.ceil(rate.retryAfterMs / 1000)}s`);
        }

        const { sessionId } = req.data as { sessionId: string };
        if (!sessionId) return req.reject(400, 'sessionId is required');

        const sess = await loadSigningSessionAccountId(db, sessionId, userId);
        if (!sess.ok) return req.reject(sess.status, sess.msg);

        // Main-thread cache: a saturated worker cannot hide its own progress.
        const p = walletGetSyncProgress(sess.accountId);
        const prewarmJob = await findLatestJob('connectWalletForSigning', sessionId);
        const origin = getFacadeOrigin(sess.accountId);
        const originFields = {
            restoredFromSnapshot: origin ? origin.restoredFromSnapshot : null,
            snapshotSavedAt: origin?.snapshotSavedAt ?? null,
            facadeBuildStartedAt: origin?.buildStartedAt ?? null,
            facadeBuiltAt: origin?.builtAt ?? null
        };
        if (!p) {
            return {
                known: false, caughtUp: false,
                appliedIndex: null, streamTip: null, behindEvents: null,
                eventsPerSecond: null, etaSeconds: null, blockHeight: null,
                isConnected: false, indexerFresh: false,
                elapsedMs: null, phase: null, updatedAt: null,
                lastProgressAt: null, staleSeconds: null, stale: false,
                jobId: prewarmJob?.ID ?? null, jobStatus: prewarmJob?.status ?? null,
                ...originFields
            };
        }
        const updatedAtMs = Date.parse(p.updatedAt);
        const staleSeconds = Number.isFinite(updatedAtMs) ? Math.max(0, Math.round((Date.now() - updatedAtMs) / 1000)) : null;
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
            updatedAt: p.updatedAt,
            lastProgressAt: p.lastProgressAt ?? null,
            staleSeconds,
            stale: staleSeconds != null && staleSeconds > SYNC_PROGRESS_STALE_S,
            jobId: prewarmJob?.ID ?? null,
            jobStatus: prewarmJob?.status ?? null,
            ...originFields
        };
    });

    srv.on('estimateSendNightFee', async (req: Request) => {
        const userId = requireUserId(req);
        if (!userId) return;
        const clientKey = principalRateKey(req, 'wallet');
        const rate = diagnosticsRateLimiter.check(clientKey);
        if (!rate.allowed) {
            return req.reject(429, `Rate limited. Retry after ${Math.ceil(rate.retryAfterMs / 1000)}s`);
        }

        const { sessionId, receiverAddress, amount, ttlIso, tokenTypeHex } = req.data as {
            sessionId: string;
            receiverAddress: string;
            amount: string;
            ttlIso?: string;
            tokenTypeHex?: string;
        };

        if (!sessionId) return req.reject(400, 'sessionId is required');
        if (!receiverAddress) return req.reject(400, 'receiverAddress is required');
        if (tokenTypeHex !== undefined && tokenTypeHex !== null && tokenTypeHex !== '' && !/^[0-9a-fA-F]{64}$/.test(String(tokenTypeHex))) {
            return req.reject(400, 'tokenTypeHex must be 64 hex characters');
        }
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

/** Rows per UPDATE, within the driver's parameter limit. */
const SESSION_CLOSE_CHUNK = 200;

/**
 * At init, close viewing-only sessions of the previous process; returns their ids
 * so their queued jobs can be dropped. Assumes one replica. Platform sponsors and
 * sessions holding a signing key are kept (closing revokes the key for good).
 */
export async function closeSessionsFromPreviousProcess(db: any, config?: Record<string, any>): Promise<string[]> {
    const exempt = new Set(getConfiguredFeeSponsorSessions(config));
    const active: any[] = (await db.run(
        SELECT.from(WalletSessions).columns('sessionId', 'encryptedSeedKey').where({ isActive: true })
    )) || [];
    const keyed = active.filter(r => r?.sessionId && r.encryptedSeedKey && !exempt.has(r.sessionId)).map(r => r.sessionId as string);
    if (keyed.length) {
        cds.log('nightgate').info(`Boot sweep keeps ${keyed.length} session(s) holding a signing key: ${keyed.map(id => id.slice(0, 8)).join(', ')}`);
    }
    const stale = active.map(r => r?.sessionId).filter((id: string) => id && !exempt.has(id) && !keyed.includes(id));
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

/** Periodic cleanup of expired wallet sessions; returns the timer handle. */
export function startSessionCleanup(db: any): ReturnType<typeof setInterval> {
    const SESSION_CLEANUP_INTERVAL = 15 * 60 * 1000;
    const timer = setInterval(async () => {
        try {
            const now = new Date().toISOString();
            // Platform sponsors never expire; never deactivate or wipe them.
            const platformSponsors = new Set(getConfiguredFeeSponsorSessions(getNightgatePluginConfig()));
            const expiring: any[] = ((await db.run(
                SELECT.from(WalletSessions)
                    .columns('sessionId', 'viewingKeyHash', 'encryptedViewingKey', 'userId')
                    .where({ isActive: true, expiresAt: { '<': now } })
            )) || []).filter((s: any) => !platformSponsors.has(String(s.sessionId)));
            if (expiring.length === 0) return;
            // Deactivate FIRST and only the selected rows: a row expiring in between
            // would otherwise never get its eviction decision.
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

    // Tests mock setInterval with a bare object.
    if (typeof timer.unref === 'function') {
        timer.unref();
    }

    return timer;
}
