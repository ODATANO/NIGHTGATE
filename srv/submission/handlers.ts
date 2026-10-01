/**
 * Submission action handlers: validation, rate limits, artifact/session/sponsor
 * resolution and job admission. The SDK call itself lives in TransactionSubmitter.
 */

import cds from '@sap/cds';
import { TransactionSubmitter, type TransactionSubmitterDeps } from './TransactionSubmitter';
import { resolveContract } from './contract-registry';
import { buildWalletMaterialForSession, attesterIdForSession } from './wallet-material-factory';
import { loadCircuitArgTypes } from './arg-coercion';
import { deriveRawTokenType, SHIELDED_TEST_TOKEN_AMOUNT } from './token-type';
import { registerBackgroundJobProcessor, registerBackgroundJobReconciliationFinalizer } from './background-jobs';
import type { BackgroundJobProcessor, BackgroundJobReconciliationFinalizer } from './background-jobs';
import { JOB_KINDS, type JobExecutor, type JobFinalizer } from './job-kinds';
import { reindexDisclosuresForContract } from './disclosure-indexer';
import { readAttestationStateForContract } from './attestation-state';
import { registerVerifyStateHandlers } from './verify-state';
import { readPredicateStateForContract } from './predicate-state';
import { loadPureCircuitsFromRegistry } from './document-proof';
import { tokenFactoryOps, type TokenFactoryOps } from './token-factory';
import { recordPlatformMint } from './platform-mints';
import type { DbRunner } from '../utils/db-types';
import { ContractCommandV1 } from './actions/common';
import { createStateVerifiers, createDisclosureProjection, createSubmissionSupport, type SubmissionContext, type SubmissionDeps } from './actions/context';
import { registerContractActions } from './actions/contracts';
import { registerTokenActions } from './actions/tokens';
import { registerSponsoringActions } from './actions/sponsoring';
import { registerDocumentActions } from './actions/documents';
import { registerPredicateActions } from './actions/predicates';
import { registerDisclosureActions } from './actions/disclosure';
import { registerSwapOfferActions } from './actions/swap-offers';
import { registerHolderDisclosureActions } from './actions/holder-disclosure';
import { createContractCommandExecutor } from './executors/contract-command';
import { createSponsorExecutors } from './executors/sponsor';
import { createReconciliationFinalizers } from './finalizers/reconciliation';

export { recordProven } from './actions/common';

/** Dependency overrides for tests. */
export interface SubmissionHandlersOptions {
    walletMaterialFactory?: typeof buildWalletMaterialForSession;
    attesterIdResolver?: typeof attesterIdForSession;
    resolveContractImpl?: typeof resolveContract;
    submitterFactory?: (deps: TransactionSubmitterDeps) => TransactionSubmitter;
    circuitArgTypesLoader?: typeof loadCircuitArgTypes;
    disclosureReindexer?: typeof reindexDisclosuresForContract;
    attestationStateReader?: typeof readAttestationStateForContract;
    predicateStateReader?: typeof readPredicateStateForContract;
    pureCircuitsLoader?: typeof loadPureCircuitsFromRegistry;
    tokenFactory?: TokenFactoryOps;
}

export function registerSubmissionHandlers(
    srv: cds.ApplicationService,
    db: DbRunner,
    options: SubmissionHandlersOptions = {}
): void {
    const walletFactory = options.walletMaterialFactory ?? buildWalletMaterialForSession;
    const attesterIdResolver = options.attesterIdResolver ?? attesterIdForSession;
    const contractResolver = options.resolveContractImpl ?? resolveContract;
    const submitterFactory = options.submitterFactory ?? ((deps: TransactionSubmitterDeps) => new TransactionSubmitter(deps));
    const argTypesLoader = options.circuitArgTypesLoader ?? loadCircuitArgTypes;
    const disclosureReindexer = options.disclosureReindexer ?? reindexDisclosuresForContract;
    const attestationStateReader = options.attestationStateReader ?? readAttestationStateForContract;
    const predicateStateReader = options.predicateStateReader ?? readPredicateStateForContract;
    const pureCircuitsLoader = options.pureCircuitsLoader ?? loadPureCircuitsFromRegistry;
    const tokenFactory = options.tokenFactory ?? tokenFactoryOps;

    const deps: SubmissionDeps = {
        srv, db, walletFactory, attesterIdResolver, contractResolver, submitterFactory, argTypesLoader,
        disclosureReindexer, attestationStateReader, predicateStateReader, pureCircuitsLoader, tokenFactory
    };
    const projection = createDisclosureProjection(deps);
    const ctx: SubmissionContext = { ...deps, ...createStateVerifiers(deps), ...projection, ...createSubmissionSupport(deps) };
    const executeContractCommand = createContractCommandExecutor(ctx);
    const { executeSponsorFinalized, executeSponsorUnbound } = createSponsorExecutors(ctx);
    const { finalizeSponsoredSubmission, finalizeContractProjection, finalizeFactoryMint } = createReconciliationFinalizers(ctx);

    const executors: Record<Exclude<JobExecutor, 'wallet'>, BackgroundJobProcessor> = {
        contract: executeContractCommand,
        // The result adds the token type, without which the minted coin cannot be spent.
        mintShieldedTestToken: async (raw, job) => {
            const result = await executeContractCommand(raw, job) as Record<string, unknown> | undefined;
            // The executor already rejected any op but 'call' for this kind.
            const command = raw as Extract<ContractCommandV1, { op: 'call' }>;
            const token = await deriveRawTokenType(String(command?.contractAddress ?? ''));
            return { ...(result ?? {}), tokenTypeHex: token.tokenTypeHex, amount: SHIELDED_TEST_TOKEN_AMOUNT.toString() };
        },
        // A landed factory mint is a platform mint: its type is learned, and the
        // minting grant may have offers in it sponsored.
        mintFactoryToken: async (raw, job) => {
            const result = await executeContractCommand(raw, job) as Record<string, unknown> | undefined;
            const command = raw as Extract<ContractCommandV1, { op: 'call' }>;
            const tokenType = command?.mintedTokenType;
            if (tokenType) {
                const txHash = typeof result?.txHash === 'string' ? result.txHash : null;
                await recordPlatformMint(db, [tokenType], { grantId: job.grantId ?? null, sponsorSessionId: command.sponsorSessionId ?? null, txHash });
            }
            return { ...(result ?? {}), ...(tokenType ? { tokenType } : {}) };
        },
        sponsorFinalized: executeSponsorFinalized,
        sponsorUnbound: executeSponsorUnbound,
        reindexDisclosures: projection.executeReindexDisclosures
    };
    const finalizers: Record<JobFinalizer, BackgroundJobReconciliationFinalizer> = {
        contractProjection: finalizeContractProjection,
        sponsoredSubmission: finalizeSponsoredSubmission,
        factoryMint: finalizeFactoryMint
    };
    for (const [kind, def] of Object.entries(JOB_KINDS)) {
        if (def.executor !== 'wallet') registerBackgroundJobProcessor(kind, 1, def.traits, executors[def.executor]);
        if (def.finalizer) registerBackgroundJobReconciliationFinalizer(kind, 1, finalizers[def.finalizer]);
    }

    registerContractActions(ctx);
    registerTokenActions(ctx);
    registerSponsoringActions(ctx);
    registerDocumentActions(ctx);
    registerPredicateActions(ctx);
    registerDisclosureActions(ctx);
    registerSwapOfferActions(ctx);
    registerHolderDisclosureActions(ctx);
    registerVerifyStateHandlers(srv, { contractResolver, attestationStateReader, predicateStateReader });
}
