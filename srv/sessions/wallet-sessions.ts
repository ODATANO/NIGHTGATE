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
import { deriveAccountId, deriveStoragePassword } from '../submission/wallet-material-factory';
import { registerNightUtxosForDust, deregisterNightUtxosFromDust } from '../submission/dust-registration';
const log = cds.log('nightgate:sessions');
import {
    sendNight,
    unshieldFunds,
    shieldFunds,
    getWalletBalance,
    estimateSendNightFee,
    estimateUnshieldFee,
    estimateShieldFee
} from '../submission/token-ops';
import { ensureNetworkId } from '../midnight/providers';
import { getOrBuildWalletFacade } from '../submission/wallet-facade-builder';
import { walletWaitForSyncedState } from '../midnight/wallet-worker-client';
import {
    resolveNightgateRuntimeConfig, getNightgatePluginConfig, mainnetSubmissionBlockReason,
    getConfiguredNightgateNetwork, normalizeNightgateNetwork
} from '../utils/nightgate-config';
import { startJob, registerBackgroundJobProcessor, type BackgroundJobRow } from '../submission/background-jobs';
import { reportExternalExecution } from '../submission/job-execution-context';
import { mnemonicToBip39SeedHex } from '../utils/wallet-hd';
import { deriveWalletInfo, resolveBip39SeedHex, deriveViewingKeyForAccount } from '../utils/wallet-info';
import { resolveFeeSponsor, ensureFeeSponsorFacade, FeeSponsorError } from '../submission/fee-sponsor';

// Upper bound for the prewarm sync-to-tip wait
const PREWARM_SYNC_TIMEOUT_MS = Number(
    process.env.NIGHTGATE_PREWARM_SYNC_TIMEOUT_MS || 3 * 60 * 60 * 1000
);

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

const swapRateLimiter = new RateLimiter({
    // Cross-ledger shield/unshield is heavier (more ZK work) so a tighter
    // bound than ordinary transfers.
    windowMs: 5 * 60 * 1000,
    maxRequests: 5
});

const diagnosticsRateLimiter = new RateLimiter({
    // Read-only ops; generous limit since these inform UI and should be
    // pollable. Still bounded to prevent abuse.
    windowMs: 60 * 1000,
    maxRequests: 60
});

const MAX_NIGHT_AMOUNT_ATOMS = 10n ** 18n;

type WalletCommand =
    | { op: 'prewarm' }
    | { op: 'registerDust'; dustReceiverAddress?: string }
    | { op: 'deregisterDust'; sponsorSessionId?: string }
    | { op: 'sendNight'; receiverAddress: string; amount: string; ttlIso?: string }
    | { op: 'unshield'; amount: string; ttlIso?: string }
    | { op: 'shield'; amount: string; ttlIso?: string };

const WALLET_COMMAND_KINDS = [
    'connectWalletForSigning', 'registerForDustGeneration', 'deregisterFromDustGeneration',
    'sendNight', 'unshieldFunds', 'shieldFunds'
] as const;
const EXPECTED_WALLET_OP: Record<string, WalletCommand['op']> = {
    connectWalletForSigning: 'prewarm',
    registerForDustGeneration: 'registerDust',
    deregisterFromDustGeneration: 'deregisterDust',
    sendNight: 'sendNight',
    unshieldFunds: 'unshield',
    shieldFunds: 'shield'
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
        const result = await sendNight({ cacheKey: accountId, receiverAddress: command.receiverAddress, amount: command.amount, ttlIso: command.ttlIso });
        return { txId: result.txId, toLedger: result.toLedger, amount: result.amount, receiverAddress: result.receiverAddress };
    }
    if (command.op === 'unshield') {
        await reportExternalExecution({});
        const result = await unshieldFunds({ cacheKey: accountId, amount: command.amount, ttlIso: command.ttlIso });
        return { txId: result.txId, amount: result.amount, unshieldedReceiverAddress: result.unshieldedReceiverAddress };
    }
    if (command.op === 'shield') {
        await reportExternalExecution({});
        const result = await shieldFunds({ cacheKey: accountId, amount: command.amount, ttlIso: command.ttlIso });
        return { txId: result.txId, amount: result.amount, shieldedReceiverAddress: result.shieldedReceiverAddress };
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
 * shared between sendNight / shieldFunds / unshieldFunds handlers.
 */
function parseNightAmount(raw: string | undefined): { ok: true; value: bigint } | { ok: false; msg: string } {
    if (!raw) return { ok: false, msg: 'amount is required' };
    let value: bigint;
    try { value = BigInt(raw); }
    catch { return { ok: false, msg: `amount must be a decimal integer (NIGHT atoms), got '${raw}'` }; }
    if (value <= 0n) return { ok: false, msg: 'amount must be > 0' };
    if (value > MAX_NIGHT_AMOUNT_ATOMS) return { ok: false, msg: 'amount exceeds sanity bound of 10^18 atoms' };
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
 */
async function loadSigningSessionAccountId(
    db: any,
    sessionId: string,
    userId: string
): Promise<{ ok: true; accountId: string } | { ok: false; status: number; msg: string }> {
    const session = await db.run(
        SELECT.one.from(WalletSessions).where({ sessionId, isActive: true, userId })
    );
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

        const session = await db.run(
            SELECT.one.from(WalletSessions).where({ sessionId, isActive: true, userId })
        );
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
                command: { op: 'prewarm' }
            });
            log.info('facade pre-warm job', job.jobId.slice(0, 8), 'started for', accountId.slice(0, 16));

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

        const session = await db.run(
            SELECT.one.from(WalletSessions).where({ sessionId, userId })
        );

        if (!session) {
            return req.reject(404, 'Session not found');
        }

        if (session.expiresAt && new Date(session.expiresAt) < new Date()) {
            await db.run(
                UPDATE.entity(WalletSessions)
                    .set({ isActive: false, encryptedViewingKey: null, encryptedSeedKey: null })
                    .where({ sessionId, userId })
            );
            return req.reject(410, 'Session expired');
        }

        // Evict the cached WalletFacade so in-memory secret keys are dropped.
        try {
            if (session.encryptedViewingKey) {
                const viewingKey = decrypt(session.encryptedViewingKey, getEncryptionKey());
                const accountId = deriveAccountId(viewingKey);
                await evictWalletFacade(accountId);
            }
        } catch {
            // Best-effort eviction.
        }

        await db.run(
            UPDATE.entity(WalletSessions)
                .set({
                    disconnectedAt: new Date().toISOString(),
                    isActive: false,
                    encryptedViewingKey: null,
                    encryptedSeedKey: null
                })
                .where({ sessionId, userId })
        );
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

        const { sessionId, receiverAddress, amount, ttlIso, idempotencyKey } = req.data as {
            sessionId: string;
            receiverAddress: string;
            amount: string;
            ttlIso?: string;
            idempotencyKey?: string;
        };

        if (!sessionId) return req.reject(400, 'sessionId is required');
        if (!receiverAddress) return req.reject(400, 'receiverAddress is required');
        if (!amount) return req.reject(400, 'amount is required');

        const hrpOK = receiverAddress.startsWith('mn_shield-addr_') || receiverAddress.startsWith('mn_addr_');
        if (!hrpOK) {
            return req.reject(400,
                `receiverAddress must start with 'mn_shield-addr_' (shielded) or 'mn_addr_' (unshielded), got '${receiverAddress.slice(0, 24)}...'`);
        }
        if (receiverAddress.length < 50) {
            return req.reject(400, `receiverAddress too short (${receiverAddress.length} chars; expected Bech32m of >= 50)`);
        }

        const amountCheck = parseNightAmount(amount);
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
            request: { sessionId, receiverAddress, amount, ttlIso: ttlIso || null },
            requestedBy: userId,
            commandVersion: 1,
            command: { op: 'sendNight', receiverAddress, amount, ttlIso }
        });
    });

    srv.on('unshieldFunds', async (req: Request) => {
        if (rejectIfMainnetBlocked(req)) return;
        const userId = requireUserId(req);
        if (!userId) return;
        const clientKey = (req as any)?._.req?.ip || 'global';
        const rate = swapRateLimiter.check(clientKey);
        if (!rate.allowed) {
            return req.reject(429, `Rate limited. Retry after ${Math.ceil(rate.retryAfterMs / 1000)}s`);
        }

        const { sessionId, amount, ttlIso, idempotencyKey } = req.data as {
            sessionId: string;
            amount: string;
            ttlIso?: string;
            idempotencyKey?: string;
        };

        if (!sessionId) return req.reject(400, 'sessionId is required');
        const amountCheck = parseNightAmount(amount);
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
            kind: 'unshieldFunds',
            sessionId,
            idempotencyKey,
            request: { sessionId, amount, ttlIso: ttlIso || null },
            requestedBy: userId,
            commandVersion: 1,
            command: { op: 'unshield', amount, ttlIso }
        });
    });

    srv.on('shieldFunds', async (req: Request) => {
        if (rejectIfMainnetBlocked(req)) return;
        const userId = requireUserId(req);
        if (!userId) return;
        const clientKey = (req as any)?._.req?.ip || 'global';
        const rate = swapRateLimiter.check(clientKey);
        if (!rate.allowed) {
            return req.reject(429, `Rate limited. Retry after ${Math.ceil(rate.retryAfterMs / 1000)}s`);
        }

        const { sessionId, amount, ttlIso, idempotencyKey } = req.data as {
            sessionId: string;
            amount: string;
            ttlIso?: string;
            idempotencyKey?: string;
        };

        if (!sessionId) return req.reject(400, 'sessionId is required');
        const amountCheck = parseNightAmount(amount);
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
            kind: 'shieldFunds',
            sessionId,
            idempotencyKey,
            request: { sessionId, amount, ttlIso: ttlIso || null },
            requestedBy: userId,
            commandVersion: 1,
            command: { op: 'shield', amount, ttlIso }
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

        const session = await db.run(
            SELECT.one.from(WalletSessions).where({ sessionId, isActive: true, userId })
        );
        if (!session) return req.reject(404, 'Session not found or inactive');
        if (!session.encryptedViewingKey) return req.reject(404, 'Session has no viewing key');
        if (!session.encryptedSeedKey) return req.reject(412, 'Session has no signing key. Call connectWalletForSigning first.');
        if (session.expiresAt && new Date(session.expiresAt) < new Date()) {
            return req.reject(410, 'Session expired');
        }

        const encKey = getEncryptionKey();
        let viewingKey: string;
        try {
            viewingKey = decrypt(session.encryptedViewingKey, encKey);
        } catch {
            return req.reject(500, 'Failed to decrypt session keys (ENCRYPTION_KEY mismatch?)');
        }
        const accountId = deriveAccountId(viewingKey);

        try {
            return await getWalletBalance({ cacheKey: accountId });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return req.reject(500, `getWalletBalance failed: ${msg}`);
        }
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

        const session = await db.run(
            SELECT.one.from(WalletSessions).where({ sessionId, isActive: true, userId })
        );
        if (!session) return req.reject(404, 'Session not found or inactive');
        if (!session.encryptedViewingKey) return req.reject(404, 'Session has no viewing key');
        if (!session.encryptedSeedKey) return req.reject(412, 'Session has no signing key. Call connectWalletForSigning first.');
        if (session.expiresAt && new Date(session.expiresAt) < new Date()) {
            return req.reject(410, 'Session expired');
        }

        const encKey = getEncryptionKey();
        let viewingKey: string;
        try {
            viewingKey = decrypt(session.encryptedViewingKey, encKey);
        } catch {
            return req.reject(500, 'Failed to decrypt session keys (ENCRYPTION_KEY mismatch?)');
        }
        const accountId = deriveAccountId(viewingKey);

        try {
            return await estimateSendNightFee({
                cacheKey: accountId,
                receiverAddress,
                amount,
                ttlIso
            });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return req.reject(500, `estimateSendNightFee failed: ${msg}`);
        }
    });

    // ---- estimateUnshieldFee + estimateShieldFee (symmetric swap pre-flight)

    type SwapEstimateData = { sessionId: string; amount: string; ttlIso?: string };

    async function handleSwapEstimate(
        req: Request,
        direction: 'shield' | 'unshield',
        invoke: (args: { cacheKey: string; amount: string; ttlIso?: string }) => Promise<{ fee: string; direction: 'shield' | 'unshield' }>
    ) {
        const clientKey = (req as any)?._.req?.ip || 'global';
        const rate = diagnosticsRateLimiter.check(clientKey);
        if (!rate.allowed) {
            return req.reject(429, `Rate limited. Retry after ${Math.ceil(rate.retryAfterMs / 1000)}s`);
        }

        const userId = requireUserId(req);
        if (!userId) return;

        const { sessionId, amount, ttlIso } = req.data as SwapEstimateData;
        if (!sessionId) return req.reject(400, 'sessionId is required');
        const amountCheck = parseNightAmount(amount);
        if (!amountCheck.ok) return req.reject(400, amountCheck.msg);
        const ttlErr = validateOptionalTtl(ttlIso);
        if (ttlErr) return req.reject(400, ttlErr);

        const sess = await loadSigningSessionAccountId(db, sessionId, userId);
        if (!sess.ok) return req.reject(sess.status, sess.msg);

        try {
            return await invoke({ cacheKey: sess.accountId, amount, ttlIso });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return req.reject(500, `estimate${direction === 'shield' ? 'Shield' : 'Unshield'}Fee failed: ${msg}`);
        }
    }

    srv.on('estimateUnshieldFee', req => handleSwapEstimate(req, 'unshield', estimateUnshieldFee));
    srv.on('estimateShieldFee', req => handleSwapEstimate(req, 'shield', estimateShieldFee));
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
            const where = { isActive: true, expiresAt: { '<': now } };
            // Evict cached facades for the expiring sessions so in-memory secret
            // keys are dropped
            const expiring: any[] = (await db.run(
                SELECT.from(WalletSessions).columns('encryptedViewingKey').where(where)
            )) || [];
            for (const s of expiring) {
                try {
                    if (s.encryptedViewingKey) {
                        const vk = decrypt(s.encryptedViewingKey, getEncryptionKey());
                        await evictWalletFacade(deriveAccountId(vk));
                    }
                } catch { /* best-effort eviction */ }
            }
            await db.run(
                UPDATE.entity(WalletSessions)
                    .set({ isActive: false, encryptedViewingKey: null, encryptedSeedKey: null })
                    .where(where)
            );
        } catch { /* ignore cleanup errors */ }
    }, SESSION_CLEANUP_INTERVAL);

    // Guard retained for tests that mock setInterval to return a bare object.
    // Production NodeJS.Timeout always has unref(); tests deliberately don't.
    if (typeof timer.unref === 'function') {
        timer.unref();
    }

    return timer;
}
