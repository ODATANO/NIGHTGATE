/**
 * Contract deploy, call, batch and build-only actions.
 * SPDX-License-Identifier: Apache-2.0
 */
import { coerceCircuitArgs } from '../arg-coercion';
import { ensureNetworkId } from '../../midnight/providers';
import { startJob } from '../background-jobs';
import { SHA256_HEX_RE, vaultDims } from '../verify-state';
import { SET_DEPTH } from '../set-root';
import type { NightgateRequest } from '../../utils/request-types';
import { deployRateLimiter, callRateLimiter, buildRateLimiter, MerkleProofBundle, validateSchemaSlots, validateOpening, facadeConfigFromEnv, rejectIfMainnetBlocked, checkRate, runSubmission } from './common';
import type { SubmissionContext } from './context';

export function registerContractActions(ctx: Pick<SubmissionContext, 'srv' | 'db' | 'walletFactory' | 'contractResolver' | 'argTypesLoader' | 'resolveSponsorForRequest'>): void {
    const { srv, db, walletFactory, contractResolver, argTypesLoader, resolveSponsorForRequest } = ctx;

    srv.on('deployContract', async (req: NightgateRequest) => {
        const { compiledArtifactRef, sessionId, initialPrivateState, idempotencyKey, sponsorSessionId } = req.data as {
            compiledArtifactRef?: string;
            sessionId?: string;
            initialPrivateState?: string;
            idempotencyKey?: string;
            sponsorSessionId?: string;
        };
        const recoveryId = typeof (req.data as any).recoveryId === 'string' && (req.data as any).recoveryId.length > 0
            ? String((req.data as any).recoveryId).toLowerCase()
            : undefined;

        if (!compiledArtifactRef) return req.reject(400, 'compiledArtifactRef is required');
        if (!sessionId) return req.reject(400, 'sessionId is required');
        if (recoveryId !== undefined && !SHA256_HEX_RE.test(recoveryId)) return req.reject(400, 'recoveryId must be 64 hex chars (32 bytes)');

        if (rejectIfMainnetBlocked(req)) return;
        if (!checkRate(deployRateLimiter, sessionId, req)) return;

        let parsedInitialState: unknown = {};
        if (initialPrivateState) {
            try { parsedInitialState = JSON.parse(initialPrivateState); }
            catch { return req.reject(400, 'initialPrivateState must be valid JSON'); }
        }

        return runSubmission(req, async () => {
            const facadeCfg = facadeConfigFromEnv();
            await ensureNetworkId(facadeCfg.networkId);
            await contractResolver(compiledArtifactRef);
            await walletFactory({ sessionId, db, facadeConfig: facadeCfg, expectedUserId: req.user?.id });
            const sponsor = await resolveSponsorForRequest(req, sponsorSessionId);

            return startJob({
                kind: 'deployContract',
                sessionId,
                idempotencyKey,
                request: { compiledArtifactRef, sessionId, hasInitialState: !!initialPrivateState, feeSponsor: sponsor?.sponsorSessionId ?? null, ...(recoveryId ? { recoveryId } : {}) },
                idempotencyPayload: {
                    compiledArtifactRef, sessionId, initialPrivateState: parsedInitialState,
                    feeSponsor: sponsor?.sponsorSessionId ?? null, ...(recoveryId ? { recoveryId } : {})
                },
                requestedBy: req.user?.id,
                grantId: req.agentGrant?.ID,
                commandVersion: 1,
                encryptCommand: true,
                command: { op: 'deploy', compiledArtifactRef, initialPrivateState: parsedInitialState, sponsorSessionId: sponsor?.sponsorSessionId, ...(recoveryId ? { recoveryId } : {}) }
            });
        });
    });

    srv.on('submitContractCall', async (req: NightgateRequest) => {
        const { contractAddress, circuit, compiledArtifactRef, sessionId, args, idempotencyKey, initialPrivateState, sponsorSessionId } = req.data as {
            contractAddress?: string;
            circuit?: string;
            compiledArtifactRef?: string;
            sessionId?: string;
            args?: string;
            idempotencyKey?: string;
            initialPrivateState?: string;
            sponsorSessionId?: string;
        };

        if (!contractAddress) return req.reject(400, 'contractAddress is required');
        if (!circuit) return req.reject(400, 'circuit is required');
        if (!compiledArtifactRef) return req.reject(400, 'compiledArtifactRef is required');
        if (!sessionId) return req.reject(400, 'sessionId is required');

        if (rejectIfMainnetBlocked(req)) return;
        if (!checkRate(callRateLimiter, sessionId, req)) return;

        let parsedArgs: unknown[] = [];
        if (args) {
            try {
                const v = JSON.parse(args);
                if (!Array.isArray(v)) return req.reject(400, 'args must be a JSON array');
                parsedArgs = v;
            } catch {
                return req.reject(400, 'args must be valid JSON');
            }
        }

        // Used only when the wallet has no private state for this contract yet.
        let parsedInitialPrivateState: unknown;
        if (initialPrivateState) {
            try { parsedInitialPrivateState = JSON.parse(initialPrivateState); }
            catch { return req.reject(400, 'initialPrivateState must be valid JSON'); }
        }

        return runSubmission(req, async () => {
            const facadeCfg = facadeConfigFromEnv();
            await ensureNetworkId(facadeCfg.networkId);
            const resolved = await contractResolver(compiledArtifactRef);

            const argTypes = argTypesLoader(resolved.zkConfigPath, circuit);
            const coercedArgs = coerceCircuitArgs(parsedArgs, argTypes);

            await walletFactory({ sessionId, db, facadeConfig: facadeCfg, expectedUserId: req.user?.id });
            const sponsor = await resolveSponsorForRequest(req, sponsorSessionId);

            return startJob({
                kind: 'submitContractCall',
                sessionId,
                idempotencyKey,
                request: { contractAddress, circuit, compiledArtifactRef, sessionId, argCount: coercedArgs.length, feeSponsor: sponsor?.sponsorSessionId ?? null },
                idempotencyPayload: {
                    contractAddress, circuit, compiledArtifactRef, sessionId,
                    args: parsedArgs, initialPrivateState: parsedInitialPrivateState,
                    feeSponsor: sponsor?.sponsorSessionId ?? null
                },
                requestedBy: req.user?.id,
                grantId: req.agentGrant?.ID,
                commandVersion: 1,
                encryptCommand: true,
                command: { op: 'call', contractAddress, circuit, compiledArtifactRef, args: parsedArgs, initialPrivateState: parsedInitialPrivateState, sponsorSessionId: sponsor?.sponsorSessionId }
            });
        });
    });

    // Sponsoring phase 1, server-side: build, sign and finalize under the
    // caller's identity; the job result is the fee-unpaid tx.
    srv.on('buildSponsorable', async (req: NightgateRequest) => {
        const { contractAddress, circuit, compiledArtifactRef, sessionId, args } = req.data as {
            contractAddress?: string; circuit?: string; compiledArtifactRef?: string; sessionId?: string; args?: string;
        };
        if (!contractAddress) return req.reject(400, 'contractAddress is required');
        if (!circuit) return req.reject(400, 'circuit is required');
        if (!compiledArtifactRef) return req.reject(400, 'compiledArtifactRef is required');
        if (!sessionId) return req.reject(400, 'sessionId is required');
        if (rejectIfMainnetBlocked(req)) return;
        if (!checkRate(buildRateLimiter, sessionId, req)) return;
        let parsedArgs: unknown[] = [];
        if (args) { try { const v = JSON.parse(args); if (!Array.isArray(v)) return req.reject(400, 'args must be a JSON array'); parsedArgs = v; } catch { return req.reject(400, 'args must be valid JSON'); } }

        return runSubmission(req, async () => {
            const facadeCfg = facadeConfigFromEnv();
            await ensureNetworkId(facadeCfg.networkId);
            const resolved = await contractResolver(compiledArtifactRef);
            const argTypes = argTypesLoader(resolved.zkConfigPath, circuit);
            coerceCircuitArgs(parsedArgs, argTypes); // validate now -> 400
            await walletFactory({ sessionId, db, facadeConfig: facadeCfg, expectedUserId: req.user?.id });
            return startJob({
                kind: 'buildSponsorableTx', sessionId,
                request: { contractAddress, circuit, compiledArtifactRef, sessionId },
                requestedBy: req.user?.id,
                grantId: req.agentGrant?.ID, commandVersion: 1, encryptCommand: true,
                command: { op: 'buildSponsorable', contractAddress, circuit, compiledArtifactRef, args: parsedArgs }
            });
        });
    });

    srv.on('submitContractCallBatch', async (req: NightgateRequest) => {
        const { contractAddress, calls, compiledArtifactRef, sessionId, idempotencyKey, initialPrivateState, sponsorSessionId, independentCalls } = req.data as {
            contractAddress?: string;
            calls?: string;
            compiledArtifactRef?: string;
            sessionId?: string;
            idempotencyKey?: string;
            initialPrivateState?: string;
            sponsorSessionId?: string;
            independentCalls?: boolean;
        };

        if (!contractAddress) return req.reject(400, 'contractAddress is required');
        if (!compiledArtifactRef) return req.reject(400, 'compiledArtifactRef is required');
        if (!sessionId) return req.reject(400, 'sessionId is required');
        if (!calls) return req.reject(400, 'calls is required');

        if (rejectIfMainnetBlocked(req)) return;
        if (!checkRate(callRateLimiter, sessionId, req)) return;

        // Bounded: each call carries a proof, and one rejected call discards the
        // whole scope before submission.
        const { depth: rawBatchDepth, width: rawBatchWidth } = vaultDims(compiledArtifactRef);
        let parsedCalls: Array<{ circuit: string; args: unknown[]; merkleProof?: MerkleProofBundle }>;
        try {
            const v = JSON.parse(calls);
            if (!Array.isArray(v) || v.length === 0) return req.reject(400, 'calls must be a non-empty JSON array');
            if (v.length > 8) return req.reject(400, 'calls supports at most 8 entries per batch');
            parsedCalls = v.map((entry: any, i: number) => {
                if (!entry || typeof entry.circuit !== 'string' || !entry.circuit) {
                    throw new Error(`calls[${i}].circuit is required`);
                }
                if (entry.args !== undefined && !Array.isArray(entry.args)) {
                    throw new Error(`calls[${i}].args must be an array`);
                }
                // Validated here so a malformed proof is a 400, not a failed job.
                let merkleProof: MerkleProofBundle | undefined;
                if (entry.merkleProof !== undefined && entry.merkleProof?.docPair !== undefined) {
                    // Cross-root witnesses: no inclusion path.
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
                        let fieldValueBig: bigint;
                        try { fieldValueBig = BigInt(mp.fieldValue); } catch { throw new Error(`calls[${i}].merkleProof.fieldValue must be an integer (decimal string)`); }
                        if (fieldValueBig < 0n) throw new Error(`calls[${i}].merkleProof.fieldValue must be a non-negative integer`);
                        fieldValueStr = fieldValueBig.toString();
                    }
                    let fieldDigest: string | undefined;
                    if (mp.fieldDigest !== undefined) {
                        if (typeof mp.fieldDigest !== 'string' || !SHA256_HEX_RE.test(mp.fieldDigest)) {
                            throw new Error(`calls[${i}].merkleProof.fieldDigest must be 64 hex chars (32 bytes)`);
                        }
                        fieldDigest = mp.fieldDigest.toLowerCase();
                    }
                    let fieldSalt: string | undefined;
                    if (mp.fieldSalt !== undefined) {
                        if (typeof mp.fieldSalt !== 'string' || !SHA256_HEX_RE.test(mp.fieldSalt)) {
                            throw new Error(`calls[${i}].merkleProof.fieldSalt must be 64 hex chars (32 bytes)`);
                        }
                        fieldSalt = mp.fieldSalt.toLowerCase();
                    }
                    if (!Array.isArray(mp.siblings) || mp.siblings.length !== rawBatchDepth) {
                        throw new Error(`calls[${i}].merkleProof.siblings must be a JSON array of ${rawBatchDepth} hashes`);
                    }
                    for (const s of mp.siblings) {
                        if (typeof s !== 'string' || !SHA256_HEX_RE.test(s)) throw new Error(`calls[${i}].merkleProof.siblings entries must be 64 hex chars (32 bytes)`);
                    }
                    if (!Array.isArray(mp.dirs) || mp.dirs.length !== rawBatchDepth) {
                        throw new Error(`calls[${i}].merkleProof.dirs must be a JSON array of ${rawBatchDepth} booleans`);
                    }
                    for (const d of mp.dirs) {
                        if (typeof d !== 'boolean') throw new Error(`calls[${i}].merkleProof.dirs entries must be booleans`);
                    }
                    let setProof: { siblings: string[]; dirs: boolean[] } | undefined;
                    if (mp.setProof !== undefined) {
                        const sp = mp.setProof;
                        if (!sp || typeof sp !== 'object') throw new Error(`calls[${i}].merkleProof.setProof must be an object`);
                        if (!Array.isArray(sp.siblings) || sp.siblings.length !== SET_DEPTH) {
                            throw new Error(`calls[${i}].merkleProof.setProof.siblings must be a JSON array of ${SET_DEPTH} hashes`);
                        }
                        for (const s of sp.siblings) {
                            if (typeof s !== 'string' || !SHA256_HEX_RE.test(s)) throw new Error(`calls[${i}].merkleProof.setProof.siblings entries must be 64 hex chars (32 bytes)`);
                        }
                        if (!Array.isArray(sp.dirs) || sp.dirs.length !== SET_DEPTH) {
                            throw new Error(`calls[${i}].merkleProof.setProof.dirs must be a JSON array of ${SET_DEPTH} booleans`);
                        }
                        for (const d of sp.dirs) {
                            if (typeof d !== 'boolean') throw new Error(`calls[${i}].merkleProof.setProof.dirs entries must be booleans`);
                        }
                        setProof = { siblings: sp.siblings.map((s: string) => s.toLowerCase()), dirs: sp.dirs as boolean[] };
                    }
                    merkleProof = {
                        ...(fieldValueStr !== undefined ? { fieldValue: fieldValueStr } : {}),
                        ...(fieldDigest !== undefined ? { fieldDigest } : {}),
                        ...(fieldSalt !== undefined ? { fieldSalt } : {}),
                        siblings: mp.siblings.map((s: string) => s.toLowerCase()),
                        dirs: mp.dirs as boolean[],
                        ...(setProof ? { setProof } : {})
                    };
                }
                return { circuit: entry.circuit, args: entry.args ?? [], ...(merkleProof ? { merkleProof } : {}) };
            });
        } catch (e: unknown) {
            return req.reject(400, e instanceof Error && /^calls\[/.test(e.message) ? e.message : 'calls must be valid JSON');
        }

        let parsedInitialPrivateState: unknown;
        if (initialPrivateState) {
            try { parsedInitialPrivateState = JSON.parse(initialPrivateState); }
            catch { return req.reject(400, 'initialPrivateState must be valid JSON'); }
        }

        return runSubmission(req, async () => {
            const facadeCfg = facadeConfigFromEnv();
            await ensureNetworkId(facadeCfg.networkId);
            const resolved = await contractResolver(compiledArtifactRef);

            // Validate-coerce every call now so a bad arg is a 400 here, not a
            // failed job later. Raw args are persisted; the executor re-coerces.
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
                request: { contractAddress, circuits, compiledArtifactRef, sessionId, callCount: parsedCalls.length, feeSponsor: sponsor?.sponsorSessionId ?? null },
                idempotencyPayload: {
                    contractAddress, circuits, compiledArtifactRef, sessionId,
                    calls: parsedCalls, initialPrivateState: parsedInitialPrivateState,
                    feeSponsor: sponsor?.sponsorSessionId ?? null
                },
                requestedBy: req.user?.id,
                grantId: req.agentGrant?.ID,
                commandVersion: 1,
                encryptCommand: true,
                command: { op: 'callBatch', contractAddress, calls: parsedCalls, compiledArtifactRef, initialPrivateState: parsedInitialPrivateState, sponsorSessionId: sponsor?.sponsorSessionId, ...(independentCalls === true ? { independentCalls: true } : {}) }
            });
        });
    });
}
