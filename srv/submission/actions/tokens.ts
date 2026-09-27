/**
 * Shielded test-token mint and token-type derivation.
 * SPDX-License-Identifier: Apache-2.0
 */
import { ensureNetworkId } from '../../midnight/providers';
import { deriveRawTokenType, TokenTypeError, SHIELDED_TEST_TOKEN_REF, SHIELDED_TEST_TOKEN_CIRCUIT } from '../token-type';
import { startJob } from '../background-jobs';
import type { NightgateRequest } from '../../utils/request-types';
import { callRateLimiter, facadeConfigFromEnv, rejectIfMainnetBlocked, checkRate, runSubmission } from './common';
import type { SubmissionContext } from './context';

export function registerTokenActions(ctx: Pick<SubmissionContext, 'srv' | 'db' | 'walletFactory' | 'contractResolver' | 'resolveSponsorForRequest'>): void {
    const { srv, db, walletFactory, contractResolver, resolveSponsorForRequest } = ctx;

    // A generic call would leave the caller without the fixture's domain
    // separator, which the token type derives from.
    srv.on('mintShieldedTestToken', async (req: NightgateRequest) => {
        const { contractAddress, sessionId, compiledArtifactRef, idempotencyKey, sponsorSessionId } = req.data as {
            contractAddress?: string; sessionId?: string; compiledArtifactRef?: string;
            idempotencyKey?: string; sponsorSessionId?: string;
        };
        if (!contractAddress) return req.reject(400, 'contractAddress is required (deploy shielded-token first)');
        if (!sessionId) return req.reject(400, 'sessionId is required');
        if (rejectIfMainnetBlocked(req)) return;
        if (!checkRate(callRateLimiter, sessionId, req)) return;

        // The result uses the fixture's separator and amount, so a foreign
        // contract would be reported with a wrong tokenTypeHex.
        if (compiledArtifactRef && compiledArtifactRef !== SHIELDED_TEST_TOKEN_REF) {
            return req.reject(400,
                `mintShieldedTestToken only mints the bundled '${SHIELDED_TEST_TOKEN_REF}' fixture; `
                + `for other contracts use submitContractCall and deriveTokenType with the contract's own domain separator`);
        }
        const artifactRef = SHIELDED_TEST_TOKEN_REF;

        return runSubmission(req, async () => {
            const facadeCfg = facadeConfigFromEnv();
            await ensureNetworkId(facadeCfg.networkId);
            await contractResolver(artifactRef);
            await walletFactory({ sessionId, db, facadeConfig: facadeCfg, expectedUserId: req.user?.id });
            const sponsor = await resolveSponsorForRequest(req, sponsorSessionId);

            return startJob({
                kind: 'mintShieldedTestToken',
                sessionId,
                idempotencyKey,
                request: { contractAddress, compiledArtifactRef: artifactRef, sessionId, feeSponsor: sponsor?.sponsorSessionId ?? null },
                requestedBy: req.user?.id,
                grantId: req.agentGrant?.ID,
                commandVersion: 1,
                encryptCommand: true,
                // The contract's round counter feeds the nonce: repeat calls mint distinct coins.
                command: {
                    op: 'call', contractAddress, circuit: SHIELDED_TEST_TOKEN_CIRCUIT,
                    compiledArtifactRef: artifactRef, args: [],
                    sponsorSessionId: sponsor?.sponsorSessionId
                }
            });
        });
    });

    // Compute-only; not restricted to the bundled token.
    srv.on('deriveTokenType', async (req: NightgateRequest) => {
        const { contractAddress, domainSeparator } = req.data as {
            contractAddress?: string; domainSeparator?: string;
        };
        if (!contractAddress) return req.reject(400, 'contractAddress is required');
        try {
            return await deriveRawTokenType(contractAddress, domainSeparator);
        } catch (e) {
            if (e instanceof TokenTypeError) return req.reject(400, e.message);
            throw e;
        }
    });
}
