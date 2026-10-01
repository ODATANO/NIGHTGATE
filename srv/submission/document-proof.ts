/**
 * Document proofs: the prepare handlers and agent-output provenance over a
 * vault's pure circuits. Canonical JSON, content roots, schema ids and the
 * membership-set rule live in `@odatano/contract-kit` and are re-exported here.
 */
import cds from '@sap/cds';
import { randomBytes } from 'node:crypto';
import { RateLimiter } from '../utils/rate-limiter';
import { getContractRegistration, slotWidthOf, importRegisteredArtifact } from './contract-registry';
import {
    blake2b256Hex,
    fromHex32,
    buildMembershipSet,
    membershipPathFor,
    canonicalSetDigests,
    sortKeys,
    canonicalize,
    fieldKeyHex,
    scaleFieldValue,
    resolveFieldValue,
    computeSchemaDescriptors,
    computeSchemaId,
    buildDocumentContentRoot,
    missingPureCircuits,
    MERKLE_DEPTH,
    MAX_PROOF_FIELDS,
    DEFAULT_VALUE_SCALE,
    type PureCircuits,
    type ProofFieldSpec,
    type PreparedField,
    type SchemaDescriptorWire,
    type SlotOpeningWire,
    type DocumentOpeningWire,
    type BuiltContentRoot
} from '@odatano/contract-kit';
import { BackgroundJobs, type BackgroundJob } from '#cds-models/midnight';
import { formatErr } from '../utils/format-error';
import type { NightgateRequest } from '../utils/request-types';
import { NightgateError } from '../utils/errors';

export {
    blake2b256Hex,
    sortKeys,
    canonicalize,
    fieldKeyHex,
    scaleFieldValue,
    resolveFieldValue,
    computeSchemaDescriptors,
    computeSchemaId,
    buildDocumentContentRoot,
    MERKLE_DEPTH,
    MAX_PROOF_FIELDS,
    DEFAULT_VALUE_SCALE
};
export type { PureCircuits, ProofFieldSpec, PreparedField, SchemaDescriptorWire, SlotOpeningWire, DocumentOpeningWire, BuiltContentRoot };

const log = cds.log('nightgate:document-proof');

const HEX64_RE = /^[0-9a-fA-F]{64}$/;
const DEFAULT_ATTESTATION_VAULT_REF = 'attestation-vault';

export function slotWidthForRef(compiledRef: string): number {
    return slotWidthOf(getContractRegistration(compiledRef));
}

// Compute-only, but each call imports the artifact and hashes a full tree.
const prepareRateLimiter = new RateLimiter({ windowMs: 60 * 60 * 1000, maxRequests: 120 });

// ---- Pure-circuit loading -------------------------------------------------

export async function loadPureCircuitsFromRegistry(compiledRef: string): Promise<PureCircuits> {
    const reg = getContractRegistration(compiledRef);
    if (!reg) throw new PureCircuitsUnavailableError(`contract '${compiledRef}' is not registered`);
    const mod: any = await importRegisteredArtifact(compiledRef);
    const pure = mod.pureCircuits ?? mod.default?.pureCircuits;
    if (missingPureCircuits(pure).length > 0) {
        throw new PureCircuitsUnavailableError(
            `artifact '${compiledRef}' exports no leafHash/nodeHash/bytesLeafHash/absentLeafHash/setLeafHash/descriptorLeafHash/slotSalt pure circuits`);
    }
    return pure as PureCircuits;
}

export class PureCircuitsUnavailableError extends NightgateError {
    constructor(message: string) { super('PURE_CIRCUITS_UNAVAILABLE', message); }
}

// ---- Handlers -------------------------------------------------------------

export const AGENT_OUTPUT_CONTENT_TYPE = 'application/vnd.nightgate.agent-output.v1+json';

/** `producedAt` of an agent-output envelope, recorded in the anchor job's request. */
export function agentOutputProducedAt(contentType: string | undefined, metadata: string): string | null {
    if (contentType !== AGENT_OUTPUT_CONTENT_TYPE) return null;
    try {
        const producedAt = JSON.parse(metadata)?.producedAt;
        return typeof producedAt === 'string' ? producedAt : null;
    } catch { return null; }
}

async function recordedProducedAt(sessionId: string, idempotencyKey: string, userId: string | undefined): Promise<string | null> {
    const job: BackgroundJob | undefined = await cds.db.run(
        SELECT.one.from(BackgroundJobs).columns('request')
            .where({ sessionId, kind: 'anchorDocument', idempotencyKey, requestedBy: userId ?? null })
            .orderBy('createdAt desc')
    );
    if (!job?.request) return null;
    try {
        const producedAt = JSON.parse(job.request)?.producedAt;
        return typeof producedAt === 'string' ? producedAt : null;
    } catch { return null; }
}

export interface DocumentProofHandlerDeps {
    /** Test seam; defaults to the registry-backed artifact import. */
    loadPure?: (compiledRef: string) => Promise<PureCircuits>;
    /** Test seam; defaults to the `producedAt` recorded by the anchor job under the same key. */
    findProducedAt?: (sessionId: string, idempotencyKey: string, userId: string | undefined) => Promise<string | null>;
}

export function registerDocumentProofHandlers(srv: any, deps: DocumentProofHandlerDeps = {}): void {
    const loadPure = deps.loadPure ?? loadPureCircuitsFromRegistry;
    const findProducedAt = deps.findProducedAt ?? recordedProducedAt;

    srv.on('prepareDocumentProof', async (req: NightgateRequest) => {
        const clientKey = req?._?.req?.ip || 'global';
        const rate = prepareRateLimiter.check(clientKey);
        if (!rate.allowed) {
            return req.reject(429, `Rate limited. Retry after ${Math.ceil(rate.retryAfterMs / 1000)}s`);
        }

        const data = req.data as { documentJson?: string; proofFieldsJson?: string; saltSeed?: string; compiledArtifactRef?: string };
        if (!data.documentJson) return req.reject(400, 'documentJson is required');
        if (!data.proofFieldsJson) return req.reject(400, 'proofFieldsJson is required');
        if (data.saltSeed !== undefined && data.saltSeed !== null && data.saltSeed !== '' && !HEX64_RE.test(data.saltSeed)) {
            return req.reject(400, 'saltSeed must be 64 hex chars (32 bytes)');
        }

        let document: Record<string, unknown>;
        try {
            document = JSON.parse(data.documentJson);
        } catch { return req.reject(400, 'documentJson must be valid JSON'); }
        if (!document || typeof document !== 'object' || Array.isArray(document)) {
            return req.reject(400, 'documentJson must be a JSON object');
        }

        let specs: ProofFieldSpec[];
        try {
            specs = JSON.parse(data.proofFieldsJson);
        } catch { return req.reject(400, 'proofFieldsJson must be valid JSON'); }
        if (!Array.isArray(specs) || specs.length === 0) {
            return req.reject(400, 'proofFieldsJson must be a non-empty JSON array');
        }
        const widthRef = data.compiledArtifactRef?.length ? data.compiledArtifactRef : DEFAULT_ATTESTATION_VAULT_REF;
        const slotWidth = slotWidthForRef(widthRef);
        if (specs.length > slotWidth) {
            return req.reject(400, `at most ${slotWidth} proof fields (depth-${Math.log2(slotWidth)} tree)`);
        }
        const seenFields = new Set<string>();
        for (let i = 0; i < specs.length; i++) {
            const s = specs[i];
            if (!s || typeof s.field !== 'string' || s.field.length === 0) {
                return req.reject(400, `proofFields[${i}].field must be a non-empty string`);
            }
            if (seenFields.has(s.field)) return req.reject(400, `proofFields[${i}]: duplicate field '${s.field}'`);
            seenFields.add(s.field);
            if (s.kind !== undefined && s.kind !== 'uint' && s.kind !== 'bytes') {
                return req.reject(400, `proofFields[${i}].kind must be 'uint' or 'bytes'`);
            }
            if (s.kind === 'bytes' && s.scale !== undefined) {
                return req.reject(400, `proofFields[${i}].scale is not applicable to kind 'bytes'`);
            }
            if (s.scale !== undefined && (!Number.isInteger(s.scale) || s.scale < 1 || s.scale > 1_000_000_000)) {
                return req.reject(400, `proofFields[${i}].scale must be a positive integer <= 10^9`);
            }
        }

        const compiledRef = widthRef;
        let pure: PureCircuits;
        try {
            pure = await loadPure(compiledRef);
        } catch (err) {
            if (err instanceof PureCircuitsUnavailableError) return req.reject(404, err.message);
            throw err;
        }

        const canonicalDocument = canonicalize(document);
        const payloadHash = blake2b256Hex(canonicalDocument);
        // Random for dictionary resistance; caller-supplied to re-prepare an anchored payload.
        const saltSeed = data.saltSeed && HEX64_RE.test(data.saltSeed)
            ? fromHex32(data.saltSeed)
            : randomBytes(32);
        let built: BuiltContentRoot;
        try {
            built = buildDocumentContentRoot(document, specs, pure, saltSeed, slotWidth);
        } catch (err) {
            return req.reject(400, (err as Error).message);
        }
        // Never log the response: it carries witness material.
        log.info(`prepared document proof: ${specs.length} fields, ${built.emptyFields.length} empty`);

        return {
            payloadHash,
            canonicalDocument,
            contentRoot: built.contentRoot,
            schemaId: built.schemaId,
            schema: JSON.stringify(built.schema),
            fields: JSON.stringify(built.fields),
            emptyFields: JSON.stringify(built.emptyFields),
            leaves: JSON.stringify(built.leaves),
            // Losing the seed makes the anchored root unprovable; leaking it
            // makes shared leaf hashes dictionary-testable.
            opening: JSON.stringify(built.opening)
        };
    });

    srv.on('prepareMembershipSet', async (req: NightgateRequest) => {
        const clientKey = req?._?.req?.ip || 'global';
        const rate = prepareRateLimiter.check(clientKey);
        if (!rate.allowed) {
            return req.reject(429, `Rate limited. Retry after ${Math.ceil(rate.retryAfterMs / 1000)}s`);
        }

        const data = req.data as {
            allowedValuesJson?: string; value?: string; valueDigest?: string; compiledArtifactRef?: string;
        };
        if (!data.allowedValuesJson) return req.reject(400, 'allowedValuesJson is required');
        let allowed: unknown;
        try {
            allowed = JSON.parse(data.allowedValuesJson);
        } catch { return req.reject(400, 'allowedValuesJson must be valid JSON'); }
        if (!Array.isArray(allowed) || allowed.length === 0 || allowed.some(v => typeof v !== 'string' || v.length === 0)) {
            return req.reject(400, 'allowedValuesJson must be a non-empty JSON array of non-empty strings');
        }
        // Raw cap: dedupe to 64 runs after hashing every entry.
        if (allowed.length > 1024) {
            return req.reject(400, 'allowedValuesJson exceeds 1024 raw entries');
        }
        if (data.value !== undefined && data.valueDigest !== undefined) {
            return req.reject(400, 'pass at most one of value / valueDigest');
        }
        if (data.valueDigest !== undefined && !HEX64_RE.test(data.valueDigest)) {
            return req.reject(400, 'valueDigest must be 64 hex chars (32 bytes)');
        }

        const compiledRef = data.compiledArtifactRef?.length ? data.compiledArtifactRef : DEFAULT_ATTESTATION_VAULT_REF;
        let pure: PureCircuits;
        try {
            pure = await loadPure(compiledRef);
        } catch (err) {
            if (err instanceof PureCircuitsUnavailableError) return req.reject(404, err.message);
            throw err;
        }

        try {
            const values = allowed as string[];
            if (data.value === undefined && data.valueDigest === undefined) {
                const { setRoot, digests } = buildMembershipSet(values, pure);
                return { setRoot, memberCount: digests.length };
            }
            const memberDigest = data.valueDigest ?? blake2b256Hex(data.value!);
            const path = membershipPathFor(values, memberDigest, pure);
            if (!path) return req.reject(400, 'value is not in the allowed list');
            // Never log the path: which slot matched narrows the hidden value.
            return {
                setRoot: path.setRoot,
                memberCount: canonicalSetDigests(values).length,
                setSiblingsJson: JSON.stringify(path.setSiblings),
                setDirsJson: JSON.stringify(path.setDirs)
            };
        } catch (err) {
            return req.reject(400, (err as Error).message);
        }
    });

    srv.on('attestAgentOutput', async (req: NightgateRequest) => {
        const data = req.data as {
            agentId?: string; inputHash?: string; outputHash?: string;
            modelId?: string; policyHash?: string; producedAt?: string; storageRef?: string;
            sessionId?: string; contractAddress?: string; compiledArtifactRef?: string;
            idempotencyKey?: string; sponsorSessionId?: string;
        };

        if (!data.agentId || data.agentId.length > 200) {
            return req.reject(400, 'agentId is required (at most 200 characters)');
        }
        for (const [name, value, required] of [
            ['inputHash', data.inputHash, true],
            ['outputHash', data.outputHash, true],
            ['policyHash', data.policyHash, false]
        ] as const) {
            if (!value) {
                if (required) return req.reject(400, `${name} is required`);
                continue;
            }
            if (!HEX64_RE.test(value)) return req.reject(400, `${name} must be 64 hex chars (32 bytes)`);
        }
        if (data.modelId && data.modelId.length > 200) return req.reject(400, 'modelId must be at most 200 characters');
        if (!data.sessionId) return req.reject(400, 'sessionId is required');
        if (!data.contractAddress) return req.reject(400, 'contractAddress is required');
        let producedAt: string;
        if (data.producedAt) {
            const t = new Date(data.producedAt);
            if (Number.isNaN(t.getTime())) return req.reject(400, 'producedAt must be a valid ISO-8601 timestamp');
            producedAt = t.toISOString();
        } else {
            // A retry under the same key re-derives the first call's envelope.
            producedAt = (data.idempotencyKey
                ? await findProducedAt(data.sessionId, data.idempotencyKey, req.user?.id)
                : null) ?? new Date().toISOString();
        }

        // Hashes only; agentId/modelId are public. Verifiers re-hash the canonical form.
        const envelope: Record<string, unknown> = {
            v: 1,
            agentId: data.agentId,
            inputHash: data.inputHash!.toLowerCase(),
            outputHash: data.outputHash!.toLowerCase(),
            producedAt
        };
        if (data.modelId) envelope.modelId = data.modelId;
        if (data.policyHash) envelope.policyHash = data.policyHash.toLowerCase();
        const envelopeJson = canonicalize(envelope);
        const payloadHash = blake2b256Hex(envelopeJson);

        // The envelope is the anchor's metadata blob, so the on-chain metadata hash commits to it.
        try {
            const anchored = await srv.send({
                event: 'anchorDocument',
                data: {
                    sha256: payloadHash,
                    contentType: AGENT_OUTPUT_CONTENT_TYPE,
                    storageRef: data.storageRef?.length ? data.storageRef : `agent-output://${data.agentId}`,
                    metadata: envelopeJson,
                    sessionId: data.sessionId,
                    contractAddress: data.contractAddress,
                    compiledArtifactRef: data.compiledArtifactRef,
                    idempotencyKey: data.idempotencyKey,
                    sponsorSessionId: data.sponsorSessionId
                },
                user: req.user,
                // Checked on this request already; the anchor job is recorded under the same grant.
                agentGrant: req.agentGrant
            } as any);
            return { ...anchored, payloadHash, envelopeJson };
        } catch (err: unknown) {
            const e = err as { code?: unknown; status?: unknown } | null | undefined;
            const status = Number(e?.status ?? e?.code);
            return req.reject(Number.isInteger(status) && status >= 400 && status < 600 ? status : 500,
                formatErr(err));
        }
    });
}
