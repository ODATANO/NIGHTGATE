import cds from '@sap/cds';
import { WalletSessions, type WalletSession } from '#cds-models/midnight';
import { getEncryptionKey, encrypt, decrypt, hashViewingKey } from '../utils/crypto';
import { walletSessionViewingKeyBinding, walletSessionSeedBinding } from '../utils/envelope-bindings';
import { validateViewingKey } from '../utils/validation';
import { RateLimiter } from '../utils/rate-limiter';
import { deriveAccountId, deriveStoragePassword } from '../submission/wallet-material-factory';
import { resolveAccountDek } from '../submission/account-keys';
import { getWalletBalance, estimateSendNightFee } from '../submission/token-ops';
import { hasWalletFacade, getFacadeOrigin } from '../submission/wallet-facade-builder';
import { walletGetSyncProgress } from '../midnight/wallet-worker-client';
import { getNightgatePluginConfig, mainnetSubmissionBlockReason, getConfiguredNightgateNetwork, normalizeNightgateNetwork } from '../utils/nightgate-config';
import { startJob, registerBackgroundJobProcessor, runWithoutAmbientTx, supersedeQueuedJobs, findLatestJob, JobAdmissionBusyError } from '../submission/background-jobs';
import { declaredJobKindTraits } from '../submission/job-kinds';
import { mnemonicToBip39SeedHex } from '../utils/wallet-hd';
import { deriveWalletInfo, resolveBip39SeedHex, deriveViewingKeyForAccount } from '../utils/wallet-info';
import { resolveFeeSponsor, FeeSponsorError, getConfiguredFeeSponsorSessions } from '../submission/fee-sponsor';
import { isSessionExpired } from '../utils/session-expiry';
import { principalRateKey } from '../utils/rate-limiter';
import { configMs, configNumber } from '../utils/config';
import { syncGateReading } from '../submission/sponsor-sync-gate';
import { formatErr } from '../utils/format-error';
import type { DbRunner, Row } from '../utils/db-types';
import { WALLET_COMMAND_KINDS, executeWalletCommand, loadSigningSessionAccountId, evictFacadeUnlessShared } from './wallet-session-lifecycle';
import { errorMessage } from '../utils/errors';
import { connectWallet, connectWalletForSigning, deregisterFromDustGeneration, disconnectWallet, getSponsorPoolStatus, getWalletSyncProgress, registerForDustGeneration, sendNight, deriveWalletInfo as deriveWalletInfoAction, getWalletBalance as getWalletBalanceAction, estimateSendNightFee as estimateSendNightFeeAction } from '#cds-models/NightgateService';
import type { Request } from '@sap/cds';

export { closeSessionsFromPreviousProcess, startSessionCleanup } from './wallet-session-sweep';

const { SELECT, INSERT, UPDATE } = cds.ql;

const log = cds.log('nightgate:sessions');

const SYNC_PROGRESS_STALE_S = configNumber('NIGHTGATE_SYNC_PROGRESS_STALE_S');

// Wallet reads answer 503 WALLET_SYNCING after this time instead of waiting for the
// wallet to finish syncing. A value <= 0 waits forever.
const WALLET_READ_SYNC_TIMEOUT_MS = configMs('NIGHTGATE_WALLET_READ_SYNC_TIMEOUT_MS');

const readSyncTimeoutMs = (): number | undefined =>
    WALLET_READ_SYNC_TIMEOUT_MS > 0 ? WALLET_READ_SYNC_TIMEOUT_MS : undefined;

async function startJobOrRetryAfter(req: Request, input: Parameters<typeof startJob>[0]): Promise<Awaited<ReturnType<typeof startJob>>> {
    try {
        return await startJob(input);
    } catch (err) {
        if (err instanceof JobAdmissionBusyError) {
            try { req.http?.res?.set?.('Retry-After', String(err.retryAfterSeconds)); } catch { /* courtesy header */ }
            return req.reject({ status: err.httpStatus, code: err.code, message: err.message, $sanitize: false } as any);
        }
        throw err;
    }
}

function rejectWorkerReadError(req: Request, action: string, err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/sync timeout/i.test(msg)) {
        // CAP hides 5xx messages in production. `$sanitize: false` keeps this one, because it tells the client to retry.
        try { req.http?.res?.set?.('Retry-After', '15'); } catch { /* courtesy header */ }
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
    // Also used by deriveWalletInfo. The limit is low because a signing key is added once per session.
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

export function __resetWalletRateLimitersForTests(): void {
    for (const l of [walletRateLimiter, signingKeyRateLimiter, dustRegRateLimiter, sendRateLimiter, diagnosticsRateLimiter]) l.reset();
}

const MAX_NIGHT_AMOUNT_ATOMS = 10n ** 18n;

// Custom token amounts are 128-bit integers on chain. The NIGHT supply limit does not apply to them.
const MAX_CUSTOM_TOKEN_ATOMS = 2n ** 128n - 1n;

function rejectIfMainnetBlocked(req: Request): boolean {
    const reason = mainnetSubmissionBlockReason(getNightgatePluginConfig());
    if (reason) {
        req.reject?.(403, reason);
        return true;
    }
    return false;
}

function parseNightAmount(raw: string | null | undefined, customToken = false): { ok: true; value: bigint } | { ok: false; msg: string } {
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

function validateOptionalTtl(ttlIso: string | null | undefined): string | null {
    if (!ttlIso) return null;
    const t = new Date(ttlIso);
    if (Number.isNaN(t.getTime())) return 'ttlIso must be a valid ISO-8601 timestamp';
    if (t.getTime() <= Date.now()) return 'ttlIso must be in the future';
    return null;
}

/**
 * Returns the caller's user id, or rejects with 401 and returns undefined.
 * Session actions must stop on undefined, so a leaked sessionId alone gives no access.
 */
function requireUserId(req: Request): string | undefined {
    const uid = req.user?.id;
    if (!uid) { req.reject?.(401, 'authentication required'); return undefined; }
    return uid as string;
}

const BIP39_SEED_HEX_LENGTH = 128; // 64-byte BIP39 seed

export function registerWalletSessionHandlers(srv: cds.ApplicationService, db: DbRunner): void {
    for (const kind of WALLET_COMMAND_KINDS) {
        registerBackgroundJobProcessor(kind, 1, declaredJobKindTraits(kind), (command, row) => executeWalletCommand(command, row, db));
    }
    srv.on(connectWallet, async (req) => {
        const clientKey = principalRateKey(req, 'wallet');
        const rateResult = walletRateLimiter.check(clientKey);
        if (!rateResult.allowed) {
            return req.reject(429, `Rate limited. Retry after ${Math.ceil(rateResult.retryAfterMs / 1000)}s`);
        }

        const userId = requireUserId(req);
        if (!userId) return;

        const { viewingKey, label } = req.data;

        const validationError = validateViewingKey(viewingKey);
        if (validationError || !viewingKey) {
            return req.reject(400, validationError ?? 'viewingKey is required');
        }
        // Length limit, so the label cannot be misused to store data.
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
        // Create the account's encryption key now. Then a later rotation of the master key
        // can re-encrypt it even when this wallet is not connected. Safe to repeat.
        try {
            await resolveAccountDek({ db, ring: encKey, accountId: deriveAccountId(viewingKey), storagePassword: deriveStoragePassword(viewingKey) });
        } catch (err) {
            log.warn(`connectWallet: account key not created now (${errorMessage(err)}); it is created on first use`);
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

    srv.on(deriveWalletInfoAction, async (req) => {
        const clientKey = principalRateKey(req, 'wallet');
        const rateResult = signingKeyRateLimiter.check(clientKey);
        if (!rateResult.allowed) {
            return req.reject(429, `Rate limited. Retry after ${Math.ceil(rateResult.retryAfterMs / 1000)}s`);
        }

        const userId = requireUserId(req);
        if (!userId) return;

        const { mnemonic, seedHex, accountIndex } = req.data;

        try {
            resolveBip39SeedHex({ mnemonic, seedHex });
        } catch (e: unknown) {
            return req.reject(400, (e instanceof Error && e.message) || 'invalid wallet secret');
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
        } catch (e: unknown) {
            // Generic message, so no secret ends up in the response or the logs.
            cds.log('nightgate').error('deriveWalletInfo failed:', e instanceof Error ? e.message : 'unknown');
            return req.reject(500, 'wallet derivation failed');
        }
    });

    srv.on(connectWalletForSigning, async (req) => {
        const clientKey = principalRateKey(req, 'wallet');
        const rateResult = signingKeyRateLimiter.check(clientKey);
        if (!rateResult.allowed) {
            return req.reject(429, `Rate limited. Retry after ${Math.ceil(rateResult.retryAfterMs / 1000)}s`);
        }

        const userId = requireUserId(req);
        if (!userId) return;

        const { sessionId, mnemonic, seedHex, accountIndex, idempotencyKey, prewarm } = req.data;
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

        // Read outside the request transaction, because the key derivation below is slow
        // and must not hold a database connection. The UPDATE and startJob below commit together.
        const session: Row<WalletSession, 'sessionId'> | undefined = await runWithoutAmbientTx(() => db.run(
            SELECT.one.from(WalletSessions).where({ sessionId, isActive: true, userId })
        ));
        if (!session) return req.reject(404, 'Session not found or inactive');
        if (isSessionExpired(sessionId, session.expiresAt)) {
            return req.reject(410, 'Session expired');
        }

        const encKey = getEncryptionKey();

        // The seed must produce this session's viewing key at this accountIndex.
        // Otherwise it would sign as a different, unfunded wallet.
        let sessionViewingKey: string;
        try {
            sessionViewingKey = decrypt(session.encryptedViewingKey ?? '', encKey, walletSessionViewingKeyBinding(session.sessionId));
        } catch {
            return req.reject(500, 'Failed to decrypt session viewing key (ENCRYPTION_KEY mismatch?)');
        }
        let derivedViewingKey: string;
        try {
            derivedViewingKey = await deriveViewingKeyForAccount(bip39SeedHex, account);
        } catch (e: unknown) {
            log.error('viewing-key derivation failed:', e instanceof Error ? e.message : 'unknown');
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
                // The stored request copy must never contain secrets.
                request: { sessionId, accountIdPrefix: accountId.slice(0, 16) },
                requestedBy: userId,
                commandVersion: 1,
                // Encrypted so that someone with database write access cannot change a replayed job.
                encryptCommand: true,
                command: { op: 'prewarm' }
            });
            log.info('facade pre-warm job', job.jobId.slice(0, 8), 'started for', accountId.slice(0, 16));

            // Cancel older queued prewarms of this session. This runs in the request transaction,
            // because a separate write would deadlock with a pool of one connection.
            // A failure is harmless, because the UPDATE runs inside its own savepoint.
            try {
                await supersedeQueuedJobs('connectWalletForSigning', sessionId, job.jobId);
            } catch (err: unknown) {
                log.warn('prewarm supersede sweep failed:', formatErr(err));
            }

            return {
                sessionId,
                signingEnabled: true,
                prewarmJobId: job.jobId,
                prewarmStatus: job.status
            };
        } catch (err: unknown) {
            log.warn('pre-warm scheduling failed:', formatErr(err));
            return { sessionId, signingEnabled: true, prewarmJobId: null, prewarmStatus: null };
        }
    });

    srv.on(disconnectWallet, async (req) => {
        const userId = requireUserId(req);
        if (!userId) return;

        const { sessionId } = req.data;
        if (!sessionId) return req.reject(400, 'sessionId is required');

        // All database work runs outside the request transaction. Eviction waits for the
        // worker to save the wallet state, and that wait must not hold a database connection.
        const session: Row<WalletSession, 'sessionId'> | undefined = await runWithoutAmbientTx(() => db.run(
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
            // The cleanup timer only looks at active rows. Evict here, or the keys stay in memory.
            await evictFacadeUnlessShared(db, session, 'disconnectWallet(expired)');
            return req.reject(410, 'Session expired');
        }

        // Deactivate first, as evictFacadeUnlessShared requires.
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

    srv.on(registerForDustGeneration, async (req) => {
        if (rejectIfMainnetBlocked(req)) return;
        const userId = requireUserId(req);
        if (!userId) return;
        const clientKey = principalRateKey(req, 'wallet');
        const rate = dustRegRateLimiter.check(clientKey);
        if (!rate.allowed) {
            return req.reject(429, `Rate limited. Retry after ${Math.ceil(rate.retryAfterMs / 1000)}s`);
        }

        const { sessionId, dustReceiverAddress, idempotencyKey } = req.data;
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

    srv.on(deregisterFromDustGeneration, async (req) => {
        if (rejectIfMainnetBlocked(req)) return;
        const userId = requireUserId(req);
        if (!userId) return;
        const clientKey = principalRateKey(req, 'wallet');
        const rate = dustRegRateLimiter.check(clientKey);
        if (!rate.allowed) {
            return req.reject(429, `Rate limited. Retry after ${Math.ceil(rate.retryAfterMs / 1000)}s`);
        }

        const { sessionId, idempotencyKey, sponsorSessionId } = req.data;
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

    srv.on(sendNight, async (req) => {
        if (rejectIfMainnetBlocked(req)) return;
        const userId = requireUserId(req);
        if (!userId) return;
        const clientKey = principalRateKey(req, 'wallet');
        const rate = sendRateLimiter.check(clientKey);
        if (!rate.allowed) {
            return req.reject(429, `Rate limited. Retry after ${Math.ceil(rate.retryAfterMs / 1000)}s`);
        }

        const { sessionId, receiverAddress, amount, ttlIso, idempotencyKey, tokenTypeHex } = req.data;

        if (!sessionId) return req.reject(400, 'sessionId is required');
        if (!receiverAddress) return req.reject(400, 'receiverAddress is required');
        if (!amount) return req.reject(400, 'amount is required');
        // The SDK compares token types as exact strings, and raw token types are lowercase.
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

    srv.on(getWalletBalanceAction, async (req) => {
        const userId = requireUserId(req);
        if (!userId) return;
        const clientKey = principalRateKey(req, 'wallet');
        const rate = diagnosticsRateLimiter.check(clientKey);
        if (!rate.allowed) {
            return req.reject(429, `Rate limited. Retry after ${Math.ceil(rate.retryAfterMs / 1000)}s`);
        }

        const { sessionId } = req.data;
        if (!sessionId) return req.reject(400, 'sessionId is required');

        const sess = await loadSigningSessionAccountId(db, sessionId, userId);
        if (!sess.ok) return req.reject(sess.status, sess.msg);

        try {
            return await getWalletBalance({ cacheKey: sess.accountId, syncTimeoutMs: readSyncTimeoutMs() });
        } catch (err) {
            return rejectWorkerReadError(req, 'getWalletBalance', err);
        }
    });

    srv.on(getSponsorPoolStatus, async (req) => {
        const userId = requireUserId(req);
        if (!userId) return;
        const clientKey = principalRateKey(req, 'wallet');
        const rate = diagnosticsRateLimiter.check(clientKey);
        if (!rate.allowed) {
            return req.reject(429, `Rate limited. Retry after ${Math.ceil(rate.retryAfterMs / 1000)}s`);
        }

        const sponsorIds = getConfiguredFeeSponsorSessions(getNightgatePluginConfig());
        if (sponsorIds.length === 0) return [];

        const isAdmin = Boolean(req.user?.is?.('admin'));

        // Loading a wallet that is not in memory yet can take long and has no other limit.
        // So each sponsor read gets its own timeout.
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

        // A busy worker must not make the pool look empty. In that case the last known dust
        // figures are returned instead, marked stale and not usable.
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

            const session: WalletSession | undefined = await runWithoutAmbientTx(() => db.run(
                SELECT.one.from(WalletSessions).where({ sessionId, isActive: true })
            ));
            if (!session) return unusable('configured sponsor session is missing or inactive');
            if (!session.encryptedSeedKey) {
                return unusable('sponsor session has no signing key; call connectWalletForSigning for it');
            }

            const maySeeAmounts = isAdmin || session.userId === userId;

            // Platform fee sponsors have no owner check and no expiry, same as in resolveFeeSponsor.
            const sess = await loadSigningSessionAccountId(db, sessionId, undefined, true);
            if (!sess.ok) return unusable(sess.msg);
            resolved.set(sessionId, { accountId: sess.accountId, maySeeAmounts });

            const progress = walletGetSyncProgress(sess.accountId);
            // A status read must not load the wallet, which getWalletBalance would do.
            // Both checks are needed, because a just-loaded wallet has no progress yet.
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
                    // Pass the timeout to the worker call too, or abandoned calls pile up.
                    rpcTimeoutMs: perSponsorTimeoutMs
                });
                // How many transactions a sponsor can pay at once depends on its free dust notes.
                // Its own registrations do not matter, because another wallet's NIGHT can generate its dust.
                const ownRegistered = Number(balance?.registeredNightUtxoCount ?? 0);
                const pendingNotes = Number(balance?.dustPendingCount ?? 0);
                const dustNotes = balance?.dustAvailableCount !== undefined
                    ? Number(balance.dustAvailableCount)
                    : Math.max(0, Number(balance?.dustUtxoCount ?? 0) - pendingNotes);
                const gate = syncGateReading(walletGetSyncProgress(sess.accountId));
                return {
                    sessionId,
                    configured: true,
                    // Own registrations are deliberately not required.
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
                const msg = err instanceof Error ? err.message : String(err);
                return lastKnown(sessionId, msg) ?? {
                    ...unusable(msg),
                    caughtUp: syncGateReading(walletGetSyncProgress(sess.accountId)).caughtUp
                };
            }
        };

        // Read at most three sponsors at once, so timeouts do not add up and not all wallets load together.
        const rows: NonNullable<Awaited<ReturnType<typeof getSponsorPoolStatus>>> = new Array(sponsorIds.length);
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

    srv.on(getWalletSyncProgress, async (req) => {
        const userId = requireUserId(req);
        if (!userId) return;
        const clientKey = principalRateKey(req, 'wallet');
        const rate = diagnosticsRateLimiter.check(clientKey);
        if (!rate.allowed) {
            return req.reject(429, `Rate limited. Retry after ${Math.ceil(rate.retryAfterMs / 1000)}s`);
        }

        const { sessionId } = req.data;
        if (!sessionId) return req.reject(400, 'sessionId is required');

        const sess = await loadSigningSessionAccountId(db, sessionId, userId);
        if (!sess.ok) return req.reject(sess.status, sess.msg);

        // Read from a cache on the main thread, so a busy worker cannot hide its progress.
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
                isConnected: false, indexerFresh: false, indexerTipAgeSeconds: null, indexerError: null,
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
            indexerTipAgeSeconds: p.indexerTipAgeMs != null ? Math.round(p.indexerTipAgeMs / 1000) : null,
            indexerError: p.indexerError ?? null,
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

    srv.on(estimateSendNightFeeAction, async (req) => {
        const userId = requireUserId(req);
        if (!userId) return;
        const clientKey = principalRateKey(req, 'wallet');
        const rate = diagnosticsRateLimiter.check(clientKey);
        if (!rate.allowed) {
            return req.reject(429, `Rate limited. Retry after ${Math.ceil(rate.retryAfterMs / 1000)}s`);
        }

        const { sessionId, receiverAddress, amount, ttlIso } = req.data;

        if (!sessionId) return req.reject(400, 'sessionId is required');
        if (!receiverAddress) return req.reject(400, 'receiverAddress is required');
        const hrpOK = receiverAddress.startsWith('mn_shield-addr_') || receiverAddress.startsWith('mn_addr_');
        if (!hrpOK) {
            return req.reject(400,
                `receiverAddress must start with 'mn_shield-addr_' (shielded) or 'mn_addr_' (unshielded), got '${receiverAddress.slice(0, 24)}...'`);
        }
        if (!amount) return req.reject(400, 'amount is required');
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
                ttlIso: ttlIso ?? undefined,
                syncTimeoutMs: readSyncTimeoutMs()
            });
        } catch (err) {
            return rejectWorkerReadError(req, 'estimateSendNightFee', err);
        }
    });

}
