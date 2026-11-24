// Contract deploy, call, batch and build-only actions.
// SPDX-License-Identifier: Apache-2.0
import { coerceCircuitArgs } from '../arg-coercion';
import { startJob } from '../background-jobs';
import { UINT64_MAX, vaultDims } from '../verify-state';
import { SET_DEPTH } from '../set-root';
import { MerkleProofBundle, inclusionPathOrThrow, readArgsJson, type InclusionPath, validateSchemaSlots, validateOpening, facadeConfigFromEnv, rejectIfMainnetBlocked, runSubmission, readUnsignedArg, VALUE_EXCEEDS, readHash32 } from './common';
import type { SubmissionContext } from './context';
import { buildSponsorable, deployContract, submitContractCall, submitContractCallBatch } from '#cds-models/NightgateService';
import { checkRateClass } from '../../utils/rate-classes';

// One entry of the `calls` JSON before validation.
type CallEntryInput = {
    circuit?: unknown;
    args?: unknown;
    merkleProof?: {
        docPair?: { schema?: unknown; openingA?: unknown; openingB?: unknown } | null;
        fieldValue?: unknown;
        fieldDigest?: unknown;
        fieldSalt?: unknown;
        siblings?: unknown;
        dirs?: unknown;
        setProof?: { siblings?: unknown; dirs?: unknown } | null;
    } | null;
} | null;

export function registerContractActions(ctx: Pick<SubmissionContext, 'srv' | 'db' | 'walletFactory' | 'contractResolver' | 'argTypesLoader' | 'resolveSponsorForRequest'>): void {
    const { srv, db, walletFactory, contractResolver, argTypesLoader, resolveSponsorForRequest } = ctx;

    srv.on(deployContract, async (req) => {
        const { contractName, sessionId, initialPrivateState, idempotencyKey, sponsorSessionId } = req.data;
        const recoveryId = req.data.recoveryId ? req.data.recoveryId.toLowerCase() : undefined;

        if (!contractName) return req.reject(400, 'contractName is required');
        if (!sessionId) return req.reject(400, 'sessionId is required');

        if (rejectIfMainnetBlocked(req)) return;
        if (!checkRateClass('deploy', sessionId, req)) return;

        if (Array.isArray(initialPrivateState)) return req.reject(400, 'initialPrivateState must be a JSON object');
        const parsedInitialState: unknown = initialPrivateState ?? {};

        return runSubmission(req, async () => {
            const facadeCfg = facadeConfigFromEnv();
            await contractResolver(contractName);
            await walletFactory({ sessionId, db, facadeConfig: facadeCfg, expectedUserId: req.user?.id });
            const sponsor = await resolveSponsorForRequest(req, sponsorSessionId);

            return startJob({
                kind: 'deployContract',
                sessionId,
                idempotencyKey,
                request: { contractName, sessionId, hasInitialState: !!initialPrivateState, feeSponsor: sponsor?.sponsorSessionId ?? null, ...(recoveryId ? { recoveryId } : {}) },
                idempotencyPayload: {
                    contractName, sessionId, initialPrivateState: parsedInitialState,
                    feeSponsor: sponsor?.sponsorSessionId ?? null, ...(recoveryId ? { recoveryId } : {})
                },
                requestedBy: req.user?.id,
                grantId: req.agentGrant?.ID,
                commandVersion: 1,
                encryptCommand: true,
                command: { op: 'deploy', contractName, initialPrivateState: parsedInitialState, sponsorSessionId: sponsor?.sponsorSessionId, ...(recoveryId ? { recoveryId } : {}) }
            });
        });
    });

    srv.on(submitContractCall, async (req) => {
        const { contractAddress, circuit, contractName, sessionId, args, idempotencyKey, initialPrivateState, sponsorSessionId } = req.data;

        if (!contractAddress) return req.reject(400, 'contractAddress is required');
        if (!circuit) return req.reject(400, 'circuit is required');
        if (!contractName) return req.reject(400, 'contractName is required');
        if (!sessionId) return req.reject(400, 'sessionId is required');

        if (rejectIfMainnetBlocked(req)) return;
        if (!checkRateClass('prove', sessionId, req)) return;

        const parsedArgs = readArgsJson(args);
        if (typeof parsedArgs === 'string') return req.reject(400, parsedArgs);

        // Used only when the wallet has no private state for this contract yet.
        if (Array.isArray(initialPrivateState)) return req.reject(400, 'initialPrivateState must be a JSON object');
        const parsedInitialPrivateState: unknown = initialPrivateState ?? undefined;

        return runSubmission(req, async () => {
            const facadeCfg = facadeConfigFromEnv();
            const resolved = await contractResolver(contractName);

            const argTypes = argTypesLoader(resolved.zkConfigPath, circuit);
            const coercedArgs = coerceCircuitArgs(parsedArgs, argTypes);

            await walletFactory({ sessionId, db, facadeConfig: facadeCfg, expectedUserId: req.user?.id });
            const sponsor = await resolveSponsorForRequest(req, sponsorSessionId);

            return startJob({
                kind: 'submitContractCall',
                sessionId,
                idempotencyKey,
                request: { contractAddress, circuit, contractName, sessionId, argCount: coercedArgs.length, feeSponsor: sponsor?.sponsorSessionId ?? null },
                idempotencyPayload: {
                    contractAddress, circuit, contractName, sessionId,
                    args: parsedArgs, initialPrivateState: parsedInitialPrivateState,
                    feeSponsor: sponsor?.sponsorSessionId ?? null
                },
                requestedBy: req.user?.id,
                grantId: req.agentGrant?.ID,
                commandVersion: 1,
                encryptCommand: true,
                command: { op: 'call', contractAddress, circuit, contractName, args: parsedArgs, initialPrivateState: parsedInitialPrivateState, sponsorSessionId: sponsor?.sponsorSessionId }
            });
        });
    });

    // Builds and signs the transaction with the caller's wallet but pays no fee.
    // A sponsor pays the fee later through sponsorFinalized.
    srv.on(buildSponsorable, async (req) => {
        const { contractAddress, circuit, contractName, sessionId, args } = req.data;
        if (!contractAddress) return req.reject(400, 'contractAddress is required');
        if (!circuit) return req.reject(400, 'circuit is required');
        if (!contractName) return req.reject(400, 'contractName is required');
        if (!sessionId) return req.reject(400, 'sessionId is required');
        if (rejectIfMainnetBlocked(req)) return;
        if (!checkRateClass('prove', sessionId, req)) return;
        const parsedArgs = readArgsJson(args);
        if (typeof parsedArgs === 'string') return req.reject(400, parsedArgs);

        return runSubmission(req, async () => {
            const facadeCfg = facadeConfigFromEnv();
            const resolved = await contractResolver(contractName);
            const argTypes = argTypesLoader(resolved.zkConfigPath, circuit);
            coerceCircuitArgs(parsedArgs, argTypes); // validate now -> 400
            await walletFactory({ sessionId, db, facadeConfig: facadeCfg, expectedUserId: req.user?.id });
            return startJob({
                kind: 'buildSponsorable', sessionId,
                request: { contractAddress, circuit, contractName, sessionId },
                requestedBy: req.user?.id,
                grantId: req.agentGrant?.ID, commandVersion: 1, encryptCommand: true,
                command: { op: 'buildSponsorable', contractAddress, circuit, contractName, args: parsedArgs }
            });
        });
    });

    srv.on(submitContractCallBatch, async (req) => {
        const { contractAddress, calls, contractName, sessionId, idempotencyKey, initialPrivateState, sponsorSessionId, independentCalls } = req.data;

        if (!contractAddress) return req.reject(400, 'contractAddress is required');
        if (!contractName) return req.reject(400, 'contractName is required');
        if (!sessionId) return req.reject(400, 'sessionId is required');
        if (!calls) return req.reject(400, 'calls is required');

        if (rejectIfMainnetBlocked(req)) return;
        if (!checkRateClass('prove', sessionId, req)) return;

        // The batch size is limited: each call carries a proof,
        // and one rejected call fails the whole batch.
        const { depth: rawBatchDepth, width: rawBatchWidth } = vaultDims(contractName);
        let parsedCalls: Array<{ circuit: string; args: unknown[]; merkleProof?: MerkleProofBundle }>;
        try {
            const v = JSON.parse(calls);
            if (!Array.isArray(v) || v.length === 0) return req.reject(400, 'calls must be a non-empty JSON array');
            if (v.length > 8) return req.reject(400, 'calls supports at most 8 entries per batch');
            parsedCalls = v.map((entry: CallEntryInput, i: number) => {
                if (!entry || typeof entry.circuit !== 'string' || !entry.circuit) {
                    throw new Error(`calls[${i}].circuit is required`);
                }
                if (entry.args !== undefined && !Array.isArray(entry.args)) {
                    throw new Error(`calls[${i}].args must be an array`);
                }
                // Validated here so a malformed proof is a 400, not a failed job.
                let merkleProof: MerkleProofBundle | undefined;
                if (entry.merkleProof !== undefined && entry.merkleProof?.docPair !== undefined) {
                    // A comparison of two documents carries no inclusion path.
                    const dp = entry.merkleProof.docPair;
                    if (!dp || typeof dp !== 'object') throw new Error(`calls[${i}].merkleProof.docPair must be an object`);
                    merkleProof = {
                        docPair: {
                            schema: validateSchemaSlots(dp.schema, `calls[${i}].merkleProof.docPair.schema`, rawBatchWidth),
                            openingA: validateOpening(dp.openingA, `calls[${i}].merkleProof.docPair.openingA`, rawBatchWidth),
                            openingB: validateOpening(dp.openingB, `calls[${i}].merkleProof.docPair.openingB`, rawBatchWidth)
                        }
                    };
                } else if (entry.merkleProof !== undefined) {
                    const mp = entry.merkleProof;
                    if (!mp || typeof mp !== 'object') throw new Error(`calls[${i}].merkleProof must be an object`);
                    let fieldValueStr: string | undefined;
                    if (mp.fieldValue !== undefined) {
                        const fieldValueBig = readUnsignedArg(mp.fieldValue, `calls[${i}].merkleProof.fieldValue`, UINT64_MAX, VALUE_EXCEEDS);
                        if (typeof fieldValueBig === 'string') throw new Error(fieldValueBig);
                        fieldValueStr = fieldValueBig.toString();
                    }
                    let fieldDigest: string | undefined;
                    if (mp.fieldDigest !== undefined) {
                        fieldDigest = readHash32(mp.fieldDigest);
                        if (!fieldDigest) throw new Error(`calls[${i}].merkleProof.fieldDigest must be 64 hex chars (32 bytes)`);
                    }
                    let fieldSalt: string | undefined;
                    if (mp.fieldSalt !== undefined) {
                        fieldSalt = readHash32(mp.fieldSalt);
                        if (!fieldSalt) throw new Error(`calls[${i}].merkleProof.fieldSalt must be 64 hex chars (32 bytes)`);
                    }
                    const path = inclusionPathOrThrow(mp.siblings, mp.dirs, rawBatchDepth,
                        { siblings: `calls[${i}].merkleProof.siblings`, dirs: `calls[${i}].merkleProof.dirs` });
                    let setProof: InclusionPath | undefined;
                    if (mp.setProof !== undefined) {
                        const sp = mp.setProof;
                        if (!sp || typeof sp !== 'object') throw new Error(`calls[${i}].merkleProof.setProof must be an object`);
                        setProof = inclusionPathOrThrow(sp.siblings, sp.dirs, SET_DEPTH,
                            { siblings: `calls[${i}].merkleProof.setProof.siblings`, dirs: `calls[${i}].merkleProof.setProof.dirs` });
                    }
                    merkleProof = {
                        ...(fieldValueStr !== undefined ? { fieldValue: fieldValueStr } : {}),
                        ...(fieldDigest !== undefined ? { fieldDigest } : {}),
                        ...(fieldSalt !== undefined ? { fieldSalt } : {}),
                        siblings: path.siblings,
                        dirs: path.dirs,
                        ...(setProof ? { setProof } : {})
                    };
                }
                return { circuit: entry.circuit, args: entry.args ?? [], ...(merkleProof ? { merkleProof } : {}) };
            });
        } catch (e: unknown) {
            return req.reject(400, e instanceof Error && /^calls\[/.test(e.message) ? e.message : 'calls must be valid JSON');
        }

        if (Array.isArray(initialPrivateState)) return req.reject(400, 'initialPrivateState must be a JSON object');
        const parsedInitialPrivateState: unknown = initialPrivateState ?? undefined;

        return runSubmission(req, async () => {
            const facadeCfg = facadeConfigFromEnv();
            const resolved = await contractResolver(contractName);

            // Check every call now, so a bad argument is a 400 and not a failed job.
            // The raw args are saved. The executor converts them again.
            for (const c of parsedCalls) {
                const argTypes = argTypesLoader(resolved.zkConfigPath, c.circuit);
                coerceCircuitArgs(c.args, argTypes);
            }

            await walletFactory({ sessionId, db, facadeConfig: facadeCfg, expectedUserId: req.user?.id });
            const sponsor = await resolveSponsorForRequest(req, sponsorSessionId);

            const circuits = parsedCalls.map(c => c.circuit);
            return startJob({
                kind: 'submitContractCallBatch',
                sessionId,
                idempotencyKey,
                request: { contractAddress, circuits, contractName, sessionId, callCount: parsedCalls.length, feeSponsor: sponsor?.sponsorSessionId ?? null },
                idempotencyPayload: {
                    contractAddress, circuits, contractName, sessionId,
                    calls: parsedCalls, initialPrivateState: parsedInitialPrivateState, independentCalls: independentCalls === true,
                    feeSponsor: sponsor?.sponsorSessionId ?? null
                },
                requestedBy: req.user?.id,
                grantId: req.agentGrant?.ID,
                commandVersion: 1,
                encryptCommand: true,
                command: { op: 'callBatch', contractAddress, calls: parsedCalls, contractName, initialPrivateState: parsedInitialPrivateState, sponsorSessionId: sponsor?.sponsorSessionId, ...(independentCalls === true ? { independentCalls: true } : {}) }
            });
        });
    });
}
