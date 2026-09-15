/**
 * Crawler-free state verification from LIVE contract state. Neither handler
 * reads the principal: they are registered authenticated and anonymously.
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Request } from '@sap/cds';
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

export const SHA256_HEX_RE = /^[0-9a-fA-F]{64}$/;

export const DEFAULT_ATTESTATION_VAULT_REF = 'attestation-vault';

/**
 * Slot count, path depth and mask bound of a vault artifact. JS bitwise ops
 * are exact for bits 0..31, so widths up to 32 fit a Number mask.
 */
export function vaultDims(compiledRef: string | undefined): { width: number; depth: number; maxMask: number } {
    const width = slotWidthOf(getContractRegistration(compiledRef?.length ? compiledRef : DEFAULT_ATTESTATION_VAULT_REF));
    return { width, depth: Math.log2(width), maxMask: width === 32 ? 0xffffffff : (1 << width) - 1 };
}

// The circuits take Uint<64>; overflow would otherwise surface only as an
// opaque proving-time failure.
export const UINT64_MAX = (1n << 64n) - 1n;

export type PredicateKind = 'numeric' | 'equality' | 'membership' | 'integrity' | 'diff';

/**
 * The only predicate-literal parser, so an unknown literal cannot mint a wrong
 * claim key. `opCode` is set for numeric predicates only.
 */
export function parsePredicate(literal: unknown): { kind: PredicateKind; opCode: number | null } | null {
    if (literal === 'lessOrEqual') return { kind: 'numeric', opCode: 0 };
    if (literal === 'greaterOrEqual') return { kind: 'numeric', opCode: 1 };
    if (literal === 'bytesEquality') return { kind: 'equality', opCode: null };
    if (literal === 'setMembership') return { kind: 'membership', opCode: null };
    if (literal === 'documentIntegrity') return { kind: 'integrity', opCode: null };
    if (literal === 'documentDiff') return { kind: 'diff', opCode: null };
    return null;
}

/**
 * CAP delivers Integer64 (the mask type, since bit 31 overflows Int32) as a
 * string; coerce to a number, null when not an integer.
 */
export function coerceMask(raw: unknown): number | null {
    const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
    return typeof n === 'number' && Number.isInteger(n) ? n : null;
}

/**
 * True when an indexer is configured for the (possibly overridden) network;
 * when false the verify surfaces return a clean negative instead of a 5xx.
 */
export function liveProviderConfigured(networkOverride?: NightgateNetwork): boolean {
    const { network, submissionEndpoints } = resolveNightgateRuntimeConfig(getNightgatePluginConfig());
    if (networkOverride && networkOverride !== network) {
        const eps = resolveOverrideIndexerEndpoints(networkOverride, getNightgatePluginConfig());
        return Boolean(eps.indexerHttpUrl && eps.indexerWsUrl);
    }
    return Boolean(submissionEndpoints.indexerHttpUrl && submissionEndpoints.indexerWsUrl);
}

/** Contract-only provider config (no wallet) for read-side reindexing. */
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
 * Contract-only provider config for a per-call `network` override: only the
 * indexer endpoints swap (artifacts are network-agnostic, the read path never proves).
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

/** The optional `network` param: an unknown value is a 400, never a silent fallback. */
export function parseVerifyNetworkOverride(
    raw: string | undefined,
    req: Request
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
    gate?: (req: Request) => Promise<boolean> | boolean;
}

/** The read path's error mapping: bad arg encoding 400, unknown contract 404. */
async function runVerify(req: Request, op: () => Promise<unknown>): Promise<unknown> {
    try {
        return await op();
    } catch (err) {
        if (err instanceof CoercionError) return req.reject(400, err.message);
        if (err instanceof ContractNotRegisteredError) return req.reject(404, err.message);
        return req.reject(500, err instanceof Error ? err.message : String(err));
    }
}

/** Register both state-verification functions on `srv`. */
export function registerVerifyStateHandlers(srv: any, deps: VerifyStateDeps = {}): void {
    const contractResolver = deps.contractResolver ?? resolveContract;
    const attestationStateReader = deps.attestationStateReader ?? readAttestationStateForContract;
    const predicateStateReader = deps.predicateStateReader ?? readPredicateStateForContract;
    const gate = deps.gate;

    srv.on('verifyAttestationState', async (req: Request) => {
        if (gate && !(await gate(req))) return;
        const data = req.data as {
            contractAddress?: string;
            attesterId?: string;
            payloadHash?: string;
            documentId?: string;
            contentRoot?: string;
            schemaId?: string;
            compiledArtifactRef?: string;
            network?: string;
        };

        if (!data.contractAddress) return req.reject(400, 'contractAddress is required');
        // A payloadHash or attesterId next to a documentId must match the bound record.
        if (!data.documentId && !(data.attesterId && data.payloadHash)) {
            return req.reject(400, 'attesterId and payloadHash (the record), or documentId (a bound document id), are required');
        }
        if (data.payloadHash && !SHA256_HEX_RE.test(data.payloadHash)) {
            return req.reject(400, 'payloadHash must be 64 hex chars (32 bytes)');
        }
        if (data.attesterId && !SHA256_HEX_RE.test(data.attesterId)) {
            return req.reject(400, 'attesterId must be 64 hex chars (32 bytes)');
        }
        if (data.documentId && !SHA256_HEX_RE.test(data.documentId)) {
            return req.reject(400, 'documentId must be 64 hex chars (32 bytes)');
        }
        if (data.contentRoot && !SHA256_HEX_RE.test(data.contentRoot)) {
            return req.reject(400, 'contentRoot must be 64 hex chars (32 bytes)');
        }
        if (data.schemaId && !SHA256_HEX_RE.test(data.schemaId)) {
            return req.reject(400, 'schemaId must be 64 hex chars (32 bytes)');
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
                contentRoot: data.contentRoot,
                schemaId: data.schemaId,
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

    srv.on('verifyPredicateState', async (req: Request) => {
        if (gate && !(await gate(req))) return;
        const data = req.data as {
            contractAddress?: string;
            attesterId?: string;
            payloadHash?: string;
            attesterIdB?: string;
            fieldKey?: string;
            predicate?: string;
            threshold?: number | string;
            expectedDigest?: string;
            setRoot?: string;
            payloadHashB?: string;
            allowedMask?: number | string;
            k?: number;
            compiledArtifactRef?: string;
            network?: string;
        };

        if (!data.contractAddress) return req.reject(400, 'contractAddress is required');
        if (!data.attesterId) return req.reject(400, 'attesterId is required (the attester whose record carries the claim)');
        if (!SHA256_HEX_RE.test(data.attesterId)) {
            return req.reject(400, 'attesterId must be 64 hex chars (32 bytes)');
        }
        if (!data.payloadHash) return req.reject(400, 'payloadHash is required');
        if (!SHA256_HEX_RE.test(data.payloadHash)) {
            return req.reject(400, 'payloadHash must be 64 hex chars (32 bytes)');
        }
        if (data.attesterIdB && !SHA256_HEX_RE.test(data.attesterIdB)) {
            return req.reject(400, 'attesterIdB must be 64 hex chars (32 bytes)');
        }
        if (data.fieldKey && !SHA256_HEX_RE.test(data.fieldKey)) {
            return req.reject(400, 'fieldKey must be 64 hex chars (32 bytes)');
        }

        const parsed = parsePredicate(data.predicate);
        if (!parsed) return req.reject(400, "predicate must be 'lessOrEqual', 'greaterOrEqual', 'bytesEquality', 'setMembership', 'documentIntegrity' or 'documentDiff'");

        // A wrong coordinate would silently yield verified: false (the claim
        // key is recomputed from it), so validate shapes per kind here.
        let thresholdBig: bigint | undefined;
        let op: number | undefined;
        let expectedDigest: string | undefined;
        let setRoot: string | undefined;
        let payloadHashB: string | undefined;
        let allowedMask: number | undefined;
        let k: number | undefined;
        if (parsed.kind === 'integrity' || parsed.kind === 'diff') {
            const { width: verifyWidth, maxMask: verifyMaxMask } = vaultDims(data.compiledArtifactRef);
            if (!data.payloadHashB || !SHA256_HEX_RE.test(data.payloadHashB)) {
                return req.reject(400, `payloadHashB (64 hex chars) is required for predicate '${data.predicate}'`);
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
            if (!data.expectedDigest || !SHA256_HEX_RE.test(data.expectedDigest)) {
                return req.reject(400, "expectedDigest (64 hex chars) is required for predicate 'bytesEquality'");
            }
            expectedDigest = data.expectedDigest.toLowerCase();
        } else {
            if (!data.fieldKey) return req.reject(400, "fieldKey is required for predicate 'setMembership'");
            if (!data.setRoot || !SHA256_HEX_RE.test(data.setRoot)) {
                return req.reject(400, "setRoot (64 hex chars) is required for predicate 'setMembership'");
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

            // null (no on-chain state) and false both read as not proven.
            return { verified: proven === true, proven: proven === true };
        });
    });
}
