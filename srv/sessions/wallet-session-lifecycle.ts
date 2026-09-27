/**
 * Wallet session jobs (prewarm, dust registration, sends) and the shared-facade eviction rule.
 * SPDX-License-Identifier: Apache-2.0
 */
import cds from '@sap/cds';
import { JOB_KINDS, jobKindOp, jobKindsOf } from '../submission/job-kinds';
import { WalletSessions, type WalletSession } from '#cds-models/midnight';
import { getEncryptionKey, decrypt } from '../utils/crypto';
import { walletSessionViewingKeyBinding, walletSessionSeedBinding } from '../utils/envelope-bindings';
import { evictWalletFacade } from '../submission/wallet-facade-builder';
import { withKeyedLock } from '../utils/keyed-lock';
import { deriveAccountId, deriveStoragePassword } from '../submission/wallet-material-factory';
import { registerNightUtxosForDust, deregisterNightUtxosFromDust } from '../submission/dust-registration';
import { sendNight } from '../submission/token-ops';
import { ensureNetworkId } from '../midnight/providers';
import { getOrBuildWalletFacade } from '../submission/wallet-facade-builder';
import { walletWaitForSyncedState } from '../midnight/wallet-worker-client';
import { resolveNightgateRuntimeConfig, getNightgatePluginConfig } from '../utils/nightgate-config';
import { runWithoutAmbientTx, type BackgroundJobRow } from '../submission/background-jobs';
import { reportExternalExecution, reportBroadcastOn, reportSubmissionRejectedOn } from '../submission/job-execution-context';
import { isPreInclusionReject } from '../submission/sponsor-pool';
import { resolveFeeSponsor, ensureFeeSponsorFacade } from '../submission/fee-sponsor';
import { isSessionExpired } from '../utils/session-expiry';
import { configMs } from '../utils/config';
import type { DbRunner, Row } from '../utils/db-types';

const { SELECT } = cds.ql;
const log = cds.log('nightgate:sessions');

// Absolute ceiling for the prewarm wait; the primary bound is lack of progress.
const PREWARM_SYNC_TIMEOUT_MS = configMs('NIGHTGATE_PREWARM_SYNC_TIMEOUT_MS');

const PREWARM_STALL_MS = configMs('NIGHTGATE_PREWARM_STALL_MS');

type WalletCommand =
    | { op: 'prewarm' }
    | { op: 'registerDust'; dustReceiverAddress?: string }
    | { op: 'deregisterDust'; sponsorSessionId?: string }
    | { op: 'sendNight'; receiverAddress: string; amount: string; ttlIso?: string; tokenTypeHex?: string };

export const WALLET_COMMAND_KINDS: readonly string[] = jobKindsOf('wallet');

export async function executeWalletCommand(raw: unknown, job: BackgroundJobRow, db: DbRunner): Promise<unknown> {
    const command = raw as WalletCommand;
    if (!command || typeof command.op !== 'string' || !job.sessionId || !job.requestedBy) {
        throw new Error(`Invalid persisted wallet command for job ${job.ID}`);
    }
    if (job.commandVersion !== 1 || JOB_KINDS[job.kind]?.executor !== 'wallet' || jobKindOp(job.kind) !== command.op) {
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

/**
 * Active signing session -> accountId, owner-scoped (foreign reads as 404). Read
 * outside the request tx: callers then await the worker, and an open tx would pin
 * a pool connection. No read-your-own-write.
 */
export async function loadSigningSessionAccountId(
    db: DbRunner,
    sessionId: string,
    /** `undefined` drops the owner constraint: ONLY for a configured platform sponsor, never a request's id. */
    userId: string | undefined,
    /** ONLY for a configured platform sponsor, which does not expire. */
    ignoreExpiry = false
): Promise<{ ok: true; accountId: string } | { ok: false; status: number; msg: string }> {
    const where: Record<string, unknown> = { sessionId, isActive: true };
    if (userId !== undefined) where.userId = userId;
    const session: Row<WalletSession, 'sessionId'> | undefined = await runWithoutAmbientTx(() => db.run(
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
 * A live session that keeps this wallet's facade: one of this user's, or
 * another user's that holds the signing key. A viewing-only session of another
 * user never keeps the owner's keys warm. Callers MUST deactivate their own
 * rows first, so "any live row" means another live session.
 */
async function hasLiveSessionForWallet(
    db: DbRunner,
    viewingKeyHash: string | null | undefined,
    userId: string | null | undefined
): Promise<boolean> {
    if (!viewingKeyHash || !userId) return false;
    // Expiry decided in JS, not SQL: SQL does not know that platform sponsors never expire.
    const rows: WalletSession[] = await runWithoutAmbientTx(() => db.run(
        SELECT.from(WalletSessions)
            .columns('sessionId', 'expiresAt', 'userId', 'encryptedSeedKey')
            .where({ viewingKeyHash, isActive: true })
    ));
    if (!Array.isArray(rows)) return false;
    return rows.some((r: any) => (r.userId === userId || !!r.encryptedSeedKey) && !isSessionExpired(r.sessionId, r.expiresAt));
}

/**
 * Evict the account's facade unless a sibling session still uses it. Call AFTER
 * deactivating the own rows (else two concurrent disconnects both skip); the
 * account lock guards against a concurrent rebuild. Never throws.
 */
export async function evictFacadeUnlessShared(
    db: DbRunner,
    session: { sessionId: string; encryptedViewingKey?: string | null; viewingKeyHash?: string | null; userId?: string | null },
    context: string
): Promise<void> {
    try {
        if (!session.encryptedViewingKey) return;
        const viewingKey = decrypt(session.encryptedViewingKey, getEncryptionKey(), walletSessionViewingKeyBinding(session.sessionId));
        const accountId = deriveAccountId(viewingKey);
        await withKeyedLock(accountId, async () => {
            if (session.viewingKeyHash && await hasLiveSessionForWallet(db, session.viewingKeyHash, session.userId)) {
                log.info(`${context}: keeping facade ${accountId.slice(0, 16)} (another active session keeps this wallet)`);
                return;
            }
            log.info(`${context}: evicting facade ${accountId.slice(0, 16)}`);
            await evictWalletFacade(accountId);
        });
    } catch { /* best-effort eviction */ }
}
