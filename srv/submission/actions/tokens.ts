/**
 * Shielded test-token mint, token-factory mint and token-type derivation.
 * SPDX-License-Identifier: Apache-2.0
 */
import crypto from 'node:crypto';
import { ensureNetworkId } from '../../midnight/providers';
import { deriveRawTokenType, TokenTypeError, SHIELDED_TEST_TOKEN_REF, SHIELDED_TEST_TOKEN_CIRCUIT } from '../token-type';
import { TOKEN_FACTORY_REF, TOKEN_FACTORY_MINT_CIRCUIT, TOKEN_FACTORY_BURN_CIRCUIT, parseFactoryTokenName, parseFactoryMintAmount } from '../token-factory';
import { startJob } from '../background-jobs';
import { HEX64_RE } from '../../utils/hex';
import { configString } from '../../utils/config';
import { getConfiguredFeeSponsorSessions } from '../fee-sponsor';
import { getNightgatePluginConfig } from '../../utils/nightgate-config';
import { PLATFORM_POOL_SENTINEL } from '../sponsor-pool';
import { consumeValueBudget } from '../../sessions/agent-grants';
import { facadeConfigFromEnv, rejectIfMainnetBlocked, checkRate, runSubmission } from './common';
import type { SubmissionContext } from './context';
import type { Request } from '@sap/cds';
import { burnFactoryToken, deriveTokenType, mintFactoryToken, mintShieldedTestToken } from '#cds-models/NightgateService';

/** The factory a call names, else the instance default. Rejects and returns undefined without either. */
function factoryAddressFor(req: Request, raw: unknown): string | undefined {
    const address = String(raw ?? configString('NIGHTGATE_TOKEN_FACTORY_CONTRACT') ?? '').trim().toLowerCase();
    if (!address) { req.reject(400, 'contractAddress is required (a token-factory deployment; NIGHTGATE_TOKEN_FACTORY_CONTRACT sets the default)'); return undefined; }
    if (!HEX64_RE.test(address)) { req.reject(400, 'contractAddress must be 64 hex characters'); return undefined; }
    return address;
}

/** A token caller without `sessionId` mints from the session that pays its jobs: the grant's pin, else the first pool wallet. */
function mintSessionFor(req: Request, raw: unknown): string | undefined {
    if (raw) return String(raw);
    if (!req.agentGrant) { req.reject(400, 'sessionId is required'); return undefined; }
    const pinned = req.agentGrant.sponsorSessionId;
    if (pinned && pinned !== PLATFORM_POOL_SENTINEL) return String(pinned);
    const pool = getConfiguredFeeSponsorSessions(getNightgatePluginConfig());
    if (pool.length === 0) { req.reject(503, 'no fee sponsor is configured on this server (NIGHTGATE_FEE_SPONSOR_SESSION), so there is no session to mint from'); return undefined; }
    return pool[0];
}

/** A grant's value budget takes the amount a mint or burn moves. Returns false after rejecting. */
async function takeValueBudget(req: Request, db: SubmissionContext['db'], tokenType: string, amount: bigint): Promise<boolean> {
    const grantId = req.agentGrant?.ID;
    if (!grantId) return true;
    return consumeValueBudget(db, req, String(grantId), tokenType, amount);
}

export function registerTokenActions(ctx: Pick<SubmissionContext, 'srv' | 'db' | 'walletFactory' | 'contractResolver' | 'resolveSponsorForRequest' | 'tokenFactory'>): void {
    const { srv, db, walletFactory, contractResolver, resolveSponsorForRequest, tokenFactory } = ctx;

    // The session is the issuer. Its issuer secret comes from its seed inside the worker,
    // so the caller never handles the secret.
    srv.on(mintFactoryToken, async (req) => {
        const { contractAddress, name, amount, recipientCoinPublicKey, idempotencyKey, sponsorSessionId } = req.data;
        const address = factoryAddressFor(req, contractAddress);
        if (!address) return;
        const parsedName = parseFactoryTokenName(name);
        if (!parsedName.ok) return req.reject(400, parsedName.message);
        const parsedAmount = parseFactoryMintAmount(amount);
        if (!parsedAmount.ok) return req.reject(400, parsedAmount.message);
        const recipient = String(recipientCoinPublicKey ?? '').trim().toLowerCase();
        if (!HEX64_RE.test(recipient)) return req.reject(400, 'recipientCoinPublicKey must be 64 hex characters (a Zswap coin public key)');
        const sessionId = mintSessionFor(req, req.data.sessionId);
        if (!sessionId) return;
        if (rejectIfMainnetBlocked(req)) return;
        if (!checkRate('sponsor', 'sponsor', req)) return;

        return runSubmission(req, async () => {
            const facadeCfg = facadeConfigFromEnv();
            await ensureNetworkId(facadeCfg.networkId);
            await contractResolver(TOKEN_FACTORY_REF);
            await walletFactory({ sessionId, db, facadeConfig: facadeCfg, expectedUserId: req.user?.id });
            const issuerKey = await tokenFactory.issuerKeyForSession({ sessionId, db, expectedUserId: req.user?.id });
            const token = await tokenFactory.describeToken({ issuerKey, name: parsedName.name, contractAddress: address });
            if (!await takeValueBudget(req, db, token.tokenType, parsedAmount.amount)) return undefined;
            const sponsor = await resolveSponsorForRequest(req, sponsorSessionId);
            const amountText = parsedAmount.amount.toString();

            const job = await startJob({
                kind: 'mintFactoryToken',
                sessionId,
                idempotencyKey,
                request: { contractAddress: address, name: parsedName.name, amount: amountText, recipientCoinPublicKey: recipient, tokenType: token.tokenType, sessionId, feeSponsor: sponsor?.sponsorSessionId ?? null },
                idempotencyPayload: { contractAddress: address, name: parsedName.name, amount: amountText, recipientCoinPublicKey: recipient, sessionId, feeSponsor: sponsor?.sponsorSessionId ?? null },
                requestedBy: req.user?.id,
                grantId: req.agentGrant?.ID,
                commandVersion: 1,
                encryptCommand: true,
                command: {
                    op: 'call', contractAddress: address, circuit: TOKEN_FACTORY_MINT_CIRCUIT, compiledArtifactRef: TOKEN_FACTORY_REF,
                    // Tagged values work without the contract's type info. The untagged struct needs it.
                    args: [{ $bytes: parsedName.nameHex }, { $uint: amountText }, { bytes: { $bytes: recipient } }],
                    sponsorSessionId: sponsor?.sponsorSessionId, mintedTokenType: token.tokenType
                }
            });
            return { ...job, name: parsedName.name, amount: amountText, issuerKey: token.issuerKey, domain: token.domain, tokenType: token.tokenType };
        });
    });

    // The burn takes a fresh coin of the token: the wallet funds it from its own coins and the
    // contract sends it to the burn address. Anyone holding the token may burn it.
    srv.on(burnFactoryToken, async (req) => {
        const { contractAddress, name, amount, sessionId, idempotencyKey, sponsorSessionId } = req.data;
        const address = factoryAddressFor(req, contractAddress);
        if (!address) return;
        const parsedName = parseFactoryTokenName(name);
        if (!parsedName.ok) return req.reject(400, parsedName.message);
        const parsedAmount = parseFactoryMintAmount(amount);
        if (!parsedAmount.ok) return req.reject(400, parsedAmount.message);
        let issuerKey = req.data.issuerKey ? String(req.data.issuerKey).trim().toLowerCase() : '';
        if (issuerKey && !HEX64_RE.test(issuerKey)) return req.reject(400, 'issuerKey must be 64 hex characters');
        if (!sessionId) return req.reject(400, 'sessionId is required');
        if (rejectIfMainnetBlocked(req)) return;
        if (!checkRate('prove', sessionId, req)) return;

        return runSubmission(req, async () => {
            const facadeCfg = facadeConfigFromEnv();
            await ensureNetworkId(facadeCfg.networkId);
            await contractResolver(TOKEN_FACTORY_REF);
            await walletFactory({ sessionId, db, facadeConfig: facadeCfg, expectedUserId: req.user?.id });
            if (!issuerKey) issuerKey = await tokenFactory.issuerKeyForSession({ sessionId, db, expectedUserId: req.user?.id });
            const token = await tokenFactory.describeToken({ issuerKey, name: parsedName.name, contractAddress: address });
            if (!await takeValueBudget(req, db, token.tokenType, parsedAmount.amount)) return undefined;
            const sponsor = await resolveSponsorForRequest(req, sponsorSessionId);
            const amountText = parsedAmount.amount.toString();
            // The nonce names the new coin; any 32 bytes do, the wallet pays for it.
            const nonce = crypto.randomBytes(32).toString('hex');

            const job = await startJob({
                kind: 'burnFactoryToken',
                sessionId,
                idempotencyKey,
                request: { contractAddress: address, name: parsedName.name, amount: amountText, issuerKey, tokenType: token.tokenType, sessionId, feeSponsor: sponsor?.sponsorSessionId ?? null },
                idempotencyPayload: { contractAddress: address, name: parsedName.name, amount: amountText, issuerKey, sessionId, feeSponsor: sponsor?.sponsorSessionId ?? null },
                requestedBy: req.user?.id,
                grantId: req.agentGrant?.ID,
                commandVersion: 1,
                encryptCommand: true,
                command: {
                    op: 'call', contractAddress: address, circuit: TOKEN_FACTORY_BURN_CIRCUIT, compiledArtifactRef: TOKEN_FACTORY_REF,
                    args: [{ $bytes: token.domain }, { nonce: { $bytes: nonce }, color: { $bytes: token.tokenType }, value: { $uint: amountText } }],
                    sponsorSessionId: sponsor?.sponsorSessionId
                }
            });
            return { ...job, name: parsedName.name, amount: amountText, issuerKey, domain: token.domain, tokenType: token.tokenType };
        });
    });

    // A dedicated action, because the token type depends on the test token's
    // domain separator, which a plain contract call does not return.
    srv.on(mintShieldedTestToken, async (req) => {
        const { contractAddress, sessionId, compiledArtifactRef, idempotencyKey, sponsorSessionId } = req.data;
        if (!contractAddress) return req.reject(400, 'contractAddress is required (deploy shielded-token first)');
        if (!sessionId) return req.reject(400, 'sessionId is required');
        if (rejectIfMainnetBlocked(req)) return;
        if (!checkRate('prove', sessionId, req)) return;

        // The result assumes the test token's separator and amount.
        // Another contract would get a wrong tokenTypeHex.
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
                // The contract counts its mints and uses the count as nonce, so repeated calls mint different coins.
                command: {
                    op: 'call', contractAddress, circuit: SHIELDED_TEST_TOKEN_CIRCUIT,
                    compiledArtifactRef: artifactRef, args: [],
                    sponsorSessionId: sponsor?.sponsorSessionId
                }
            });
        });
    });

    // Only computes. Works for any contract, not just the test token.
    srv.on(deriveTokenType, async (req) => {
        const { contractAddress, domainSeparator } = req.data;
        if (!contractAddress) return req.reject(400, 'contractAddress is required');
        try {
            return await deriveRawTokenType(contractAddress, domainSeparator);
        } catch (e) {
            if (e instanceof TokenTypeError) return req.reject(400, e.message);
            throw e;
        }
    });
}
