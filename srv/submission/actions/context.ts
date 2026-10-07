/**
 * Shared helpers and collaborators for the submission actions and job executors.
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
import { startJob } from '../background-jobs';
import { reindexDisclosuresForContract } from '../disclosure-indexer';
import { readAttestationStateForContract } from '../attestation-state';
import { DEFAULT_ATTESTATION_VAULT_REF, vaultDims, contractProvidersConfigFromEnv, contractProvidersConfigForNetwork } from '../verify-state';
import { readPredicateStateForContract } from '../predicate-state';
import { loadPureCircuitsFromRegistry } from '../document-proof';
import { DisclosureGrants, type BackgroundJob } from '#cds-models/midnight';
import { configMs } from '../../utils/config';
import type { DbRunner } from '../../utils/db-types';
import type { TokenFactoryOps } from '../token-factory';
import type { ActionRequest } from '@sap/cds';
import { errorMessage } from '../../utils/errors';

const { UPDATE } = cds.ql;

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
    tokenFactory: TokenFactoryOps;
}

/** Checks stored proofs against the live contract state, without the local block index. */
export function createStateVerifiers(deps: Pick<SubmissionDeps, 'contractResolver' | 'attestationStateReader' | 'predicateStateReader'>) {
    const { contractResolver, attestationStateReader, predicateStateReader } = deps;

    /**
     * True when the live contract holds the attester's entry for this document hash.
     * Any error returns false instead of a server error.
     */
    async function verifyDocumentViaState(
        contractAddress: string,
        attesterId: string,
        payloadHash: string,
        compiledArtifactRef?: string | null,
        networkOverride?: NightgateNetwork,
        recordedArtifactDigest?: string | null
    ): Promise<boolean> {
        try {
            const compiledRef = compiledArtifactRef && compiledArtifactRef.length > 0
                ? compiledArtifactRef
                : DEFAULT_ATTESTATION_VAULT_REF;
            // The resolver throws if the contract files no longer match the recorded digest.
            // That returns false, so a changed contract never reports a false match.
            const resolved = await contractResolver(compiledRef, recordedArtifactDigest ?? undefined);
            const state = await attestationStateReader({
                contractAddress,
                attesterId,
                payloadHash,
                artifactPath: resolved.artifactPath,
                artifactDigest: resolved.artifactDigest,
                contractProvidersConfig: contractProvidersConfigForNetwork(resolved.zkConfigPath, networkOverride)
            });
            return Boolean(state?.attested);
        } catch {
            return false;
        }
    }

    /**
     * True when the claim stored in this row is set on-chain.
     * Any error returns false instead of a server error.
     */
    async function verifyPredicateViaState(row: any): Promise<boolean> {
        try {
            // Use the contract and network recorded when the proof was made.
            // A later re-registration then cannot change the result.
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
                artifactDigest: resolved.artifactDigest,
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

/** Keeps the DisclosureGrants table in line with the chain after a grant or revoke lands. */
export function createDisclosureProjection(deps: Pick<SubmissionDeps, 'db' | 'contractResolver' | 'disclosureReindexer'>) {
    const { db, contractResolver, disclosureReindexer } = deps;

    /** `active` is not set here. The reindex reads it from the ledger right after. */
    function confirmedDisclosureLevel(level: number, txHash: string, changedAt: string, landedHeight: number | null): Record<string, unknown> {
        return { level, pendingLevel: null, grantedTxHash: txHash, revokedTxHash: null, modifiedAt: changedAt, ...heightStamp(landedHeight) };
    }

    function heightStamp(height: number | null): Record<string, unknown> {
        return Number.isInteger(height) && (height as number) >= 0 ? { changedAtHeight: height } : {};
    }

    /**
     * Limits an update to rows not changed at or after `height`, so an older
     * confirmation never overwrites a newer one. Without a height only unstamped rows match.
     */
    function notNewerThan(query: any, height: number | null): any {
        return Number.isInteger(height) && (height as number) >= 0
            ? query.and('(changedAtHeight is null or changedAtHeight <', height, ')')
            : query.and('changedAtHeight is null');
    }

    /**
     * Clears the pending level after the chain rejected it.
     * Matching on `pendingLevel` leaves a newer request untouched.
     */
    async function clearPendingDisclosureLevel(disclosureGrantId: string, level: number): Promise<void> {
        try {
            await db.run(UPDATE.entity(DisclosureGrants)
                .set({ pendingLevel: null, modifiedAt: new Date().toISOString() })
                .where({ ID: disclosureGrantId, pendingLevel: level }));
        } catch {
            /* Best effort. Access checks never read this marker. */
        }
    }

    function runDisclosureReindex(contractAddress: string, resolved: ResolvedContract, atHeight: number | null): Promise<unknown> {
        return disclosureReindexer({
            db,
            contractAddress,
            artifactPath: resolved.artifactPath,
            artifactDigest: resolved.artifactDigest,
            contractProvidersConfig: contractProvidersConfigFromEnv(resolved.zkConfigPath),
            atHeight
        });
    }

    /**
     * Runs the reindex after a landed grant or revoke.
     * If it fails, a `reindexDisclosures` job retries it under the same session.
     */
    async function reindexAfterSubmit(contractAddress: string, resolved: ResolvedContract, atHeight: number | null, origin: BackgroundJob, compiledArtifactRef: string): Promise<void> {
        try {
            await runDisclosureReindex(contractAddress, resolved, atHeight);
            return;
        } catch (err) {
            cds.log('nightgate').warn(`disclosure reindex of ${contractAddress.slice(0, 16)} after job ${origin.ID} failed, queuing a retry job: ${errorMessage(err).slice(0, 200)}`);
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
            cds.log('nightgate').error(`could not queue the reindexDisclosures retry for ${contractAddress.slice(0, 16)}; run reindexDisclosures by hand: ${errorMessage(err).slice(0, 200)}`);
        }
    }

    async function executeReindexDisclosures(raw: unknown, job: BackgroundJob): Promise<unknown> {
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
        throw Object.assign(new Error(`disclosure reindex of ${command.contractAddress.slice(0, 16)} still failing after ${Math.round((Date.now() - startedAt) / 1000)} s; run reindexDisclosures once the indexer answers: ${errorMessage(lastError).slice(0, 200)}`), { code: 'DISCLOSURE_REINDEX_FAILED', retryable: false });
    }

    return { confirmedDisclosureLevel, heightStamp, notNewerThan, clearPendingDisclosureLevel, runDisclosureReindex, reindexAfterSubmit, executeReindexDisclosures };
}

export type DisclosureProjection = ReturnType<typeof createDisclosureProjection>;

export function createSubmissionSupport(deps: Pick<SubmissionDeps, 'db' | 'attesterIdResolver'>) {
    const { db, attesterIdResolver } = deps;

    /**
     * The attester id an issue action uses: the session's own unless the caller names one.
     * A new content root can only be stored under the session's own id, since the contract keys it by caller.
     */
    async function resolveAttester(req: ActionRequest<unknown, unknown>, sessionId: string | null | undefined, requested: string | null | undefined, anchorsRoot: boolean): Promise<string | null> {
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

    async function resolveSponsorForRequest(
        req: ActionRequest<unknown, unknown>,
        sponsorSessionId: string | null | undefined
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
