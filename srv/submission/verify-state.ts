/**
 * Verify functions that read the live contract state from the public indexer.
 * They never look at the caller, because they are also served anonymously.
 * SPDX-License-Identifier: Apache-2.0
 */

import cds, { type ActionRequest } from '@sap/cds';
import { verifyAttestationState, verifyPredicateState } from '#cds-models/NightgateService';
import { resolveContract, ContractNotRegisteredError, getContractRegistration, slotWidthOf } from './contract-registry';
import { CoercionError } from './arg-coercion';
import { readAttestationStateForContract } from './attestation-state';
import { readPredicateStateForContract } from './predicate-state';
import type { ContractProvidersConfig } from '../midnight/providers';
import {
    resolveNightgateRuntimeConfig,
    type NightgateNetwork,
    VALID_NIGHTGATE_NETWORKS,
    resolveOverrideIndexerEndpoints,
    getNightgatePluginConfig
} from '../utils/nightgate-config';


export const DEFAULT_ATTESTATION_VAULT_REF = 'attestation-vault';

/**
 * Field count, Merkle path depth and largest field mask of a vault contract.
 * JS bit operations work up to 32 bits, so a width of 32 still fits a number.
 */
export function vaultDims(compiledRef: string | null | undefined): { width: number; depth: number; maxMask: number } {
    const width = slotWidthOf(getContractRegistration(compiledRef?.length ? compiledRef : DEFAULT_ATTESTATION_VAULT_REF));
    return { width, depth: Math.log2(width), maxMask: width === 32 ? 0xffffffff : (1 << width) - 1 };
}

// The circuits take Uint<64>. Checking early avoids an unclear failure during proving.
export const UINT64_MAX = (1n << 64n) - 1n;

export type PredicateKind = 'numeric' | 'equality' | 'membership' | 'integrity' | 'diff';

/**
 * The single parser for predicate names, so an unknown name never yields a wrong claim.
 * `opCode` is set for numeric predicates only.
 */
export function parsePredicate(literal: unknown): { predicate: string; kind: PredicateKind; opCode: number | null } | null {
    if (literal === 'lessOrEqual') return { predicate: literal, kind: 'numeric', opCode: 0 };
    if (literal === 'greaterOrEqual') return { predicate: literal, kind: 'numeric', opCode: 1 };
    if (literal === 'bytesEquality') return { predicate: literal, kind: 'equality', opCode: null };
    if (literal === 'setMembership') return { predicate: literal, kind: 'membership', opCode: null };
    if (literal === 'documentIntegrity') return { predicate: literal, kind: 'integrity', opCode: null };
    if (literal === 'documentDiff') return { predicate: literal, kind: 'diff', opCode: null };
    return null;
}

/**
 * CAP returns Integer64 values as strings. The mask needs Integer64 because bit 31 does not fit Int32.
 * Returns a number, or null when the value is not an integer.
 */
export function coerceMask(raw: unknown): number | null {
    const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
    return typeof n === 'number' && Number.isInteger(n) ? n : null;
}

/**
 * True when an indexer is configured for the requested network.
 * When false, the verify functions answer "not verified" instead of an error.
 */
export function liveProviderConfigured(networkOverride?: NightgateNetwork): boolean {
    const { network, submissionEndpoints } = resolveNightgateRuntimeConfig(getNightgatePluginConfig());
    if (networkOverride && networkOverride !== network) {
        const eps = resolveOverrideIndexerEndpoints(networkOverride, getNightgatePluginConfig());
        return Boolean(eps.indexerHttpUrl && eps.indexerWsUrl);
    }
    return Boolean(submissionEndpoints.indexerHttpUrl && submissionEndpoints.indexerWsUrl);
}

export function contractProvidersConfigFromEnv(zkConfigPath: string): ContractProvidersConfig {
    const { submissionEndpoints } = resolveNightgateRuntimeConfig(getNightgatePluginConfig());
    return {
        indexerHttpUrl: submissionEndpoints.indexerHttpUrl,
        indexerWsUrl: submissionEndpoints.indexerWsUrl,
        proofServerUrl: submissionEndpoints.proofServerUrl,
        zkConfigPath
    };
}

/**
 * Provider config for a call that names another network.
 * Only the indexer endpoints change. Reading never proves, and contracts are the same on every network.
 */
export function contractProvidersConfigForNetwork(
    zkConfigPath: string,
    networkOverride?: NightgateNetwork
): ContractProvidersConfig {
    const base = contractProvidersConfigFromEnv(zkConfigPath);
    if (!networkOverride) return base;
    const { network } = resolveNightgateRuntimeConfig(getNightgatePluginConfig());
    if (networkOverride === network) return base;
    const eps = resolveOverrideIndexerEndpoints(networkOverride, getNightgatePluginConfig());
    return { ...base, indexerHttpUrl: eps.indexerHttpUrl, indexerWsUrl: eps.indexerWsUrl };
}

/** Parses the optional `network` parameter. An unknown value is rejected, never replaced by the default. */
export function parseVerifyNetworkOverride(
    raw: string | null | undefined,
    req: ActionRequest<unknown, unknown>
): { ok: boolean; network?: NightgateNetwork } {
    if (!raw) return { ok: true };
    if (!(VALID_NIGHTGATE_NETWORKS as readonly string[]).includes(raw)) {
        req.reject(400, `network must be one of: ${VALID_NIGHTGATE_NETWORKS.join(', ')}`);
        return { ok: false };
    }
    return { ok: true, network: raw as NightgateNetwork };
}

export interface VerifyStateDeps {
    contractResolver?: typeof resolveContract;
    attestationStateReader?: typeof readAttestationStateForContract;
    predicateStateReader?: typeof readPredicateStateForContract;
    /** Runs first; false means the gate already rejected the request. */
    gate?: (req: ActionRequest<unknown, unknown>) => Promise<boolean> | boolean;
}

async function runVerify<T>(req: ActionRequest<unknown, unknown>, op: () => Promise<T>): Promise<T> {
    try {
        return await op();
    } catch (err) {
        if (err instanceof CoercionError) return req.reject(400, err.message);
        if (err instanceof ContractNotRegisteredError) return req.reject(404, err.message);
        return req.reject(500, err instanceof Error ? err.message : String(err));
    }
}

/** Register both state-verification functions on `srv`. */
export function registerVerifyStateHandlers(srv: cds.ApplicationService, deps: VerifyStateDeps = {}): void {
    const contractResolver = deps.contractResolver ?? resolveContract;
    const attestationStateReader = deps.attestationStateReader ?? readAttestationStateForContract;
    const predicateStateReader = deps.predicateStateReader ?? readPredicateStateForContract;
    const gate = deps.gate;

    srv.on(verifyAttestationState, async (req) => {
        if (gate && !(await gate(req))) return;
        const data = req.data;

        if (!data.contractAddress) return req.reject(400, 'contractAddress is required');
        // With a documentId, a given payloadHash or attesterId must match the document's attestation.
        if (!data.documentId && !(data.attesterId && data.payloadHash)) {
            return req.reject(400, 'attesterId and payloadHash (the record), or documentId (a bound document id), are required');
        }
        const netParsed = parseVerifyNetworkOverride(data.network, req);
        if (!netParsed.ok) return;

        const compiledRef = data.compiledArtifactRef && data.compiledArtifactRef.length > 0
            ? data.compiledArtifactRef
            : DEFAULT_ATTESTATION_VAULT_REF;

        const NEGATIVE = { verified: false, attested: false, contentRootOk: false, schemaOk: false, bindingRegistered: false, attesterId: '', payloadHash: '', recordKey: '', documentId: '' };

        if (!liveProviderConfigured(netParsed.network)) return NEGATIVE;

        return runVerify(req, async () => {
            const resolved = await contractResolver(compiledRef);
            const state = await attestationStateReader({
                contractAddress: data.contractAddress!,
                attesterId: data.attesterId ? data.attesterId.toLowerCase() : undefined,
                payloadHash: data.payloadHash ? data.payloadHash.toLowerCase() : undefined,
                documentId: data.documentId ? data.documentId.toLowerCase() : undefined,
                contentRoot: data.contentRoot ?? undefined,
                schemaId: data.schemaId ?? undefined,
                artifactPath: resolved.artifactPath,
                contractProvidersConfig: contractProvidersConfigForNetwork(resolved.zkConfigPath, netParsed.network)
            });

            if (!state) return NEGATIVE;

            const verified = state.attested
                && (data.contentRoot ? state.contentRootOk : true)
                && (data.schemaId ? state.schemaOk : true);
            return {
                verified,
                attested: state.attested,
                contentRootOk: state.contentRootOk,
                schemaOk: state.schemaOk,
                bindingRegistered: state.bindingRegistered,
                attesterId: state.attesterId,
                payloadHash: state.payloadHash,
                recordKey: state.recordKey,
                documentId: state.documentId
            };
        });
    });

    srv.on(verifyPredicateState, async (req) => {
        if (gate && !(await gate(req))) return;
        const data = req.data;

        if (!data.contractAddress) return req.reject(400, 'contractAddress is required');
        if (!data.attesterId) return req.reject(400, 'attesterId is required (the attester whose record carries the claim)');
        if (!data.payloadHash) return req.reject(400, 'payloadHash is required');

        const parsed = parsePredicate(data.predicate);
        if (!parsed) return req.reject(400, "predicate must be 'lessOrEqual', 'greaterOrEqual', 'bytesEquality', 'setMembership', 'documentIntegrity' or 'documentDiff'");

        // The claim is looked up from these inputs, so a bad input would just answer false.
        // Validate them per predicate kind to give a clear error instead.
        let thresholdBig: bigint | undefined;
        let op: number | undefined;
        let expectedDigest: string | undefined;
        let setRoot: string | undefined;
        let payloadHashB: string | undefined;
        let allowedMask: number | undefined;
        let k: number | undefined;
        if (parsed.kind === 'integrity' || parsed.kind === 'diff') {
            const { width: verifyWidth, maxMask: verifyMaxMask } = vaultDims(data.compiledArtifactRef);
            if (!data.payloadHashB) {
                return req.reject(400, `payloadHashB is required for predicate '${data.predicate}'`);
            }
            payloadHashB = data.payloadHashB.toLowerCase();
            if (parsed.kind === 'integrity') {
                const coerced = data.allowedMask === undefined || data.allowedMask === null
                    ? null
                    : coerceMask(data.allowedMask);
                if (coerced === null || coerced < 0 || coerced > verifyMaxMask) {
                    return req.reject(400, `allowedMask (integer 0..${verifyMaxMask}) is required for predicate 'documentIntegrity'`);
                }
                allowedMask = coerced;
            } else {
                if (data.k === undefined || data.k === null || !Number.isInteger(data.k) || data.k < 1 || data.k > verifyWidth) {
                    return req.reject(400, `k (integer 1..${verifyWidth}) is required for predicate 'documentDiff'`);
                }
                k = data.k;
            }
        } else if (parsed.kind === 'numeric') {
            if (!data.fieldKey) return req.reject(400, `fieldKey is required for predicate '${data.predicate}'`);
            if (data.threshold === undefined || data.threshold === null) return req.reject(400, 'threshold is required');
            try { thresholdBig = BigInt(data.threshold); } catch { return req.reject(400, 'threshold must be an integer'); }
            if (thresholdBig < 0n) return req.reject(400, 'threshold must be a non-negative integer');
            if (thresholdBig > UINT64_MAX) return req.reject(400, 'threshold exceeds Uint<64>');
            op = parsed.opCode!;
        } else if (parsed.kind === 'equality') {
            if (!data.fieldKey) return req.reject(400, "fieldKey is required for predicate 'bytesEquality'");
            if (!data.expectedDigest) {
                return req.reject(400, "expectedDigest is required for predicate 'bytesEquality'");
            }
            expectedDigest = data.expectedDigest.toLowerCase();
        } else {
            if (!data.fieldKey) return req.reject(400, "fieldKey is required for predicate 'setMembership'");
            if (!data.setRoot) {
                return req.reject(400, "setRoot is required for predicate 'setMembership'");
            }
            setRoot = data.setRoot.toLowerCase();
        }

        const netParsed = parseVerifyNetworkOverride(data.network, req);
        if (!netParsed.ok) return;

        const compiledRef = data.compiledArtifactRef && data.compiledArtifactRef.length > 0
            ? data.compiledArtifactRef
            : DEFAULT_ATTESTATION_VAULT_REF;

        const NEGATIVE = { verified: false, proven: false };

        if (!liveProviderConfigured(netParsed.network)) return NEGATIVE;

        return runVerify(req, async () => {
            const resolved = await contractResolver(compiledRef);
            const proven = await predicateStateReader({
                contractAddress: data.contractAddress!,
                attesterId: data.attesterId!.toLowerCase(),
                payloadHash: data.payloadHash!.toLowerCase(),
                attesterIdB: data.attesterIdB ? data.attesterIdB.toLowerCase() : undefined,
                fieldKey: data.fieldKey ? data.fieldKey.toLowerCase() : undefined,
                threshold: thresholdBig,
                op,
                expectedDigest,
                setRoot,
                payloadHashB,
                allowedMask,
                k,
                slotWidth: vaultDims(compiledRef).width,
                artifactPath: resolved.artifactPath,
                contractProvidersConfig: contractProvidersConfigForNetwork(resolved.zkConfigPath, netParsed.network)
            });

            return { verified: proven === true, proven: proven === true };
        });
    });
}
