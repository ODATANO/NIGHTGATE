/**
 * Shared context of the submission handlers: collaborators plus the helpers the actions and executors use.
 * SPDX-License-Identifier: Apache-2.0
 */
import cds from '@sap/cds';
import { TransactionSubmitter, type TransactionSubmitterDeps } from '../TransactionSubmitter';
import { resolveContract, type ResolvedContract } from '../contract-registry';
import { buildWalletMaterialForSession, attesterIdForSession, SessionNotFoundError } from '../wallet-material-factory';
import { resolveFeeSponsor, type ResolvedFeeSponsor } from '../fee-sponsor';
import { loadCircuitArgTypes } from '../arg-coercion';
import { resolveNightgateRuntimeConfig, type NightgateNetwork, VALID_NIGHTGATE_NETWORKS, getConfiguredPrivateStateBackend, getNightgatePluginConfig } from '../../utils/nightgate-config';
import { type ContractProvidersConfig } from '../../midnight/providers';
import { startJob, type BackgroundJobRow } from '../background-jobs';
import { reindexDisclosuresForContract } from '../disclosure-indexer';
import { readAttestationStateForContract } from '../attestation-state';
import { DEFAULT_ATTESTATION_VAULT_REF, vaultDims, contractProvidersConfigFromEnv, contractProvidersConfigForNetwork } from '../verify-state';
import { readPredicateStateForContract } from '../predicate-state';
import { loadPureCircuitsFromRegistry } from '../document-proof';
import { DisclosureGrants } from '#cds-models/midnight';
import { configMs } from '../../utils/config';
import type { DbRunner } from '../../utils/db-types';
import type { NightgateRequest } from '../../utils/request-types';

const { UPDATE } = cds.ql;

/** Collaborators of the submission handlers; tests override them. */
export interface SubmissionDeps {
    srv: cds.ApplicationService;
    db: DbRunner;
    walletFactory: typeof buildWalletMaterialForSession;
    attesterIdResolver: typeof attesterIdForSession;
    contractResolver: typeof resolveContract;
    submitterFactory: (deps: TransactionSubmitterDeps) => TransactionSubmitter;
    argTypesLoader: typeof loadCircuitArgTypes;
    disclosureReindexer: typeof reindexDisclosuresForContract;
    attestationStateReader: typeof readAttestationStateForContract;
    predicateStateReader: typeof readPredicateStateForContract;
    pureCircuitsLoader: typeof loadPureCircuitsFromRegistry;
}

/** Crawler-free checks of recorded evidence against live contract state. */
export function createStateVerifiers(deps: Pick<SubmissionDeps, 'contractResolver' | 'attestationStateReader' | 'predicateStateReader'>) {
    const { contractResolver, attestationStateReader, predicateStateReader } = deps;

    /**
     * Crawler-free evidence for verifyDocument: the attester's record of the
     * sha256 in live state. Any error is a clean false, never a 5xx.
     */
    async function verifyDocumentViaState(
        contractAddress: string,
        attesterId: string,
        payloadHash: string,
        compiledArtifactRef?: string,
        networkOverride?: NightgateNetwork,
        recordedArtifactDigest?: string | null
    ): Promise<boolean> {
        try {
            const compiledRef = compiledArtifactRef && compiledArtifactRef.length > 0
                ? compiledArtifactRef
                : DEFAULT_ATTESTATION_VAULT_REF;
            // Atomic digest check: a re-pointed alias or overwritten asset throws
            // and yields false, never a false "verified".
            const resolved = await contractResolver(compiledRef, recordedArtifactDigest ?? undefined);
            const state = await attestationStateReader({
                contractAddress,
                attesterId,
                payloadHash,
                artifactPath: resolved.artifactPath,
                contractProvidersConfig: contractProvidersConfigForNetwork(resolved.zkConfigPath, networkOverride)
            });
            return Boolean(state?.attested);
        } catch {
            return false;
        }
    }

    /**
     * Crawler-free evidence for verifyPredicateAttestation: the row's recomputed
     * claim key holds true on-chain. Any error is a clean false, never a 5xx.
     */
    async function verifyPredicateViaState(row: any): Promise<boolean> {
        try {
            // The artifact, digest and network recorded at proving time, so a
            // redeploy or re-pointed alias cannot change what a stored claim verifies.
            const rowRef = row.compiledArtifactRef || DEFAULT_ATTESTATION_VAULT_REF;
            const resolved = await contractResolver(rowRef, row.artifactDigest ?? undefined);
            const recordedNetwork = row.network && (VALID_NIGHTGATE_NETWORKS as readonly string[]).includes(row.network)
                ? row.network as NightgateNetwork
                : undefined;
            const bytesKind = row.predicate === 'bytesEquality' || row.predicate === 'setMembership';
            const docKind = row.predicate === 'documentIntegrity' || row.predicate === 'documentDiff';
            if (!row.attesterId) return false;
            const proven = await predicateStateReader({
                contractAddress: row.contractAddress,
                attesterId: row.attesterId,
                payloadHash: row.payloadHash,
                threshold: (bytesKind || docKind) ? undefined : BigInt(row.threshold),
                op: (bytesKind || docKind) ? undefined : Number(row.op),
                fieldKey: row.fieldKey || undefined,
                expectedDigest: row.predicate === 'bytesEquality' ? (row.expectedDigest || undefined) : undefined,
                setRoot: row.predicate === 'setMembership' ? (row.setRoot || undefined) : undefined,
                payloadHashB: docKind ? (row.payloadHashB || undefined) : undefined,
                attesterIdB: docKind ? (row.attesterIdB || undefined) : undefined,
                allowedMask: row.predicate === 'documentIntegrity' ? Number(row.allowedMask) : undefined,
                k: row.predicate === 'documentDiff' ? Number(row.threshold) : undefined,
                slotWidth: vaultDims(rowRef).width,
                artifactPath: resolved.artifactPath,
                contractProvidersConfig: contractProvidersConfigForNetwork(resolved.zkConfigPath, recordedNetwork)
            });
            return proven === true;
        } catch {
            return false;
        }
    }

    return { verifyDocumentViaState, verifyPredicateViaState };
}

export type StateVerifiers = ReturnType<typeof createStateVerifiers>;

/** The disclosure projection: confirmed levels, height stamps and the reindex after a submit. */
export function createDisclosureProjection(deps: Pick<SubmissionDeps, 'db' | 'contractResolver' | 'disclosureReindexer'>) {
    const { db, contractResolver, disclosureReindexer } = deps;

    /**
     * Grant columns once the chain took the level. `active` is left to the
     * disclosure indexer, which re-materialises it from ledger state right after.
     */
    function confirmedDisclosureLevel(level: number, txHash: string, changedAt: string, landedHeight: number | null): Record<string, unknown> {
        return { level, pendingLevel: null, grantedTxHash: txHash, revokedTxHash: null, modifiedAt: changedAt, ...heightStamp(landedHeight) };
    }

    /** The row's `changedAtHeight` column value for a change that landed at `height` (nothing when unknown). */
    function heightStamp(height: number | null): Record<string, unknown> {
        return Number.isInteger(height) && (height as number) >= 0 ? { changedAtHeight: height } : {};
    }

    /**
     * A confirmation that landed at `height` only writes rows nothing ordered has
     * touched since: unstamped rows, or rows stamped strictly below it. Same-block
     * and unknown-height writes defer to the reindex, which reads the ledger.
     */
    function notNewerThan(query: any, height: number | null): any {
        return Number.isInteger(height) && (height as number) >= 0
            ? query.and('(changedAtHeight is null or changedAtHeight <', height, ')')
            : query.and('changedAtHeight is null');
    }

    /**
     * Drop the pending marker of a level request the chain did not take; matching
     * on `pendingLevel` leaves a newer request untouched.
     */
    async function clearPendingDisclosureLevel(disclosureGrantId: string, level: number): Promise<void> {
        try {
            await db.run(UPDATE.entity(DisclosureGrants)
                .set({ pendingLevel: null, modifiedAt: new Date().toISOString() })
                .where({ ID: disclosureGrantId, pendingLevel: level }));
        } catch {
            /* best-effort; the marker is never read by the ACL */
        }
    }

    /**
     * Best-effort reindex as of the landed height (the snapshot cannot predate the
     * change); a failure never fails the submission, a later reindex reconciles.
     */
    function runDisclosureReindex(contractAddress: string, resolved: ResolvedContract, atHeight: number | null): Promise<unknown> {
        return disclosureReindexer({
            db,
            contractAddress,
            artifactPath: resolved.artifactPath,
            contractProvidersConfig: contractProvidersConfigFromEnv(resolved.zkConfigPath),
            atHeight
        });
    }

    /**
     * Projection catch-up after a landed grant, revoke or retract. The
     * confirmation write is already in; a failed reindex is retried by a durable
     * `reindexDisclosures` job under the originating job's session.
     */
    async function reindexAfterSubmit(contractAddress: string, resolved: ResolvedContract, atHeight: number | null, origin: BackgroundJobRow, compiledArtifactRef: string): Promise<void> {
        try {
            await runDisclosureReindex(contractAddress, resolved, atHeight);
            return;
        } catch (err) {
            cds.log('nightgate').warn(`disclosure reindex of ${contractAddress.slice(0, 16)} after job ${origin.ID} failed, queuing a retry job: ${String((err as Error)?.message ?? err).slice(0, 200)}`);
        }
        try {
            await startJob({
                kind: 'reindexDisclosures',
                sessionId: origin.sessionId!,
                idempotencyKey: `reindex:${contractAddress.toLowerCase()}:${atHeight ?? 'tip'}:${origin.ID}`,
                request: { contractAddress, atHeight, afterJob: origin.ID },
                requestedBy: origin.requestedBy ?? undefined,
                commandVersion: 1,
                encryptCommand: false,
                command: { op: 'reindexDisclosures', contractAddress, compiledArtifactRef, atHeight }
            });
        } catch (err) {
            cds.log('nightgate').error(`could not queue the reindexDisclosures retry for ${contractAddress.slice(0, 16)}; run reindexDisclosures by hand: ${String((err as Error)?.message ?? err).slice(0, 200)}`);
        }
    }

    /** Retries the reindex with backoff until it lands or the retry window closes. */
    async function executeReindexDisclosures(raw: unknown, job: BackgroundJobRow): Promise<unknown> {
        const command = raw as { op: string; contractAddress: string; compiledArtifactRef: string; atHeight: number | null; artifactDigest?: string };
        if (!command || command.op !== 'reindexDisclosures') throw new Error(`Persisted command operation '${(command as any)?.op}' is incompatible with ${job.kind}`);
        const resolved = await contractResolver(command.compiledArtifactRef, command.artifactDigest);
        const windowMs = configMs('NIGHTGATE_DISCLOSURE_REINDEX_RETRY_MS');
        const startedAt = Date.now();
        let lastError: unknown;
        for (let attempt = 1; ; attempt++) {
            try {
                const result: any = await runDisclosureReindex(command.contractAddress, resolved, command.atHeight);
                return { reindexed: true, attempts: attempt, indexed: result?.indexed ?? 0, deactivated: result?.deactivated ?? 0, snapshotHeight: result?.snapshotHeight ?? null };
            } catch (err) {
                lastError = err;
            }
            const elapsed = Date.now() - startedAt;
            const backoff = Math.min(15_000 * 2 ** (attempt - 1), 300_000, Math.max(1, windowMs / 4));
            if (elapsed + backoff > windowMs) break;
            await new Promise(resolve => setTimeout(resolve, backoff));
        }
        const err: any = new Error(`disclosure reindex of ${command.contractAddress.slice(0, 16)} still failing after ${Math.round((Date.now() - startedAt) / 1000)} s; run reindexDisclosures once the indexer answers: ${String((lastError as Error)?.message ?? lastError).slice(0, 200)}`);
        err.code = 'DISCLOSURE_REINDEX_FAILED'; err.retryable = false;
        throw err;
    }

    return { confirmedDisclosureLevel, heightStamp, notNewerThan, clearPendingDisclosureLevel, runDisclosureReindex, reindexAfterSubmit, executeReindexDisclosures };
}

export type DisclosureProjection = ReturnType<typeof createDisclosureProjection>;

/** What admission needs besides the collaborators: the attester, submitter deps and the fee sponsor. */
export function createSubmissionSupport(deps: Pick<SubmissionDeps, 'db' | 'attesterIdResolver'>) {
    const { db, attesterIdResolver } = deps;

    /**
     * The attester an issue action proves against: the session's own unless named.
     * A content root anchors only under the own record (the circuit keys by caller).
     */
    async function resolveAttester(req: NightgateRequest, sessionId: string | undefined, requested: string | undefined, anchorsRoot: boolean): Promise<string | null> {
        let own: string;
        try {
            own = await attesterIdResolver({ sessionId: sessionId!, db, expectedUserId: req.user?.id });
        } catch (err) {
            if (err instanceof SessionNotFoundError) { req.reject(401, err.message); return null; }
            throw err;
        }
        const attesterId = requested ? requested.toLowerCase() : own;
        if (anchorsRoot && attesterId !== own) {
            req.reject(400, "a content root can only be anchored under the session's own attester id; omit attesterId or drop contentRoot");
            return null;
        }
        return attesterId;
    }

    function buildSubmitterDeps(
        db: DbRunner,
        resolved: ResolvedContract,
        wallet: import('../../midnight/providers').WalletMaterial,
        sponsorAccountId?: string
    ): TransactionSubmitterDeps {
        const nightgateConfig = getNightgatePluginConfig();
        const { network, submissionEndpoints } = resolveNightgateRuntimeConfig(nightgateConfig);
        const privateStateBackend = getConfiguredPrivateStateBackend(nightgateConfig);

        const contractProvidersConfig: ContractProvidersConfig = {
            indexerHttpUrl: submissionEndpoints.indexerHttpUrl,
            indexerWsUrl: submissionEndpoints.indexerWsUrl,
            proofServerUrl: submissionEndpoints.proofServerUrl,
            zkConfigPath: resolved.zkConfigPath
        };

        return {
            contractProvidersConfig,
            walletMaterial: { ...wallet, privateStateBackend: wallet.privateStateBackend ?? privateStateBackend },
            db,
            network: network as NightgateNetwork,
            sponsorAccountId
        };
    }

    /** The optional per-tx fee sponsor; null when none was requested. */
    async function resolveSponsorForRequest(
        req: NightgateRequest,
        sponsorSessionId: string | undefined
    ): Promise<ResolvedFeeSponsor | null> {
        if (!sponsorSessionId) return null;
        return resolveFeeSponsor({
            db,
            sponsorSessionId,
            requestingUserId: req.user?.id,
            config: getNightgatePluginConfig()
        });
    }

    return { resolveAttester, buildSubmitterDeps, resolveSponsorForRequest };
}

export type SubmissionSupport = ReturnType<typeof createSubmissionSupport>;

export type SubmissionContext = SubmissionDeps & StateVerifiers & DisclosureProjection & SubmissionSupport;
