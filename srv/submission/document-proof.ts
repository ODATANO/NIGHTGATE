/**
 * Actions that prepare document proofs and record AI agent outputs on-chain.
 * The hashing rules live in `@odatano/contract-kit` and are re-exported here.
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
import { NightgateError } from '../utils/errors';
import { attestAgentOutput, prepareDocumentProof, prepareMembershipSet } from '#cds-models/NightgateService';

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

const DEFAULT_ATTESTATION_VAULT_REF = 'attestation-vault';

export function slotWidthForRef(compiledRef: string): number {
    return slotWidthOf(getContractRegistration(compiledRef));
}

// These actions send nothing, but each call loads the contract and hashes a full tree.
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

/** Reads `producedAt` from agent-output metadata, so the job request records it. */
export function agentOutputProducedAt(contentType: string | null | undefined, metadata: string): string | null {
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
    /** For tests. Defaults to loading the registered contract. */
    loadPure?: (compiledRef: string) => Promise<PureCircuits>;
    /** For tests. Defaults to the `producedAt` stored by the earlier job with the same idempotency key. */
    findProducedAt?: (sessionId: string, idempotencyKey: string, userId: string | undefined) => Promise<string | null>;
}

export function registerDocumentProofHandlers(srv: cds.ApplicationService, deps: DocumentProofHandlerDeps = {}): void {
    const loadPure = deps.loadPure ?? loadPureCircuitsFromRegistry;
    const findProducedAt = deps.findProducedAt ?? recordedProducedAt;

    srv.on(prepareDocumentProof, async (req) => {
        const clientKey = req.http?.req?.ip || 'global';
        const rate = prepareRateLimiter.check(clientKey);
        if (!rate.allowed) {
            return req.reject(429, `Rate limited. Retry after ${Math.ceil(rate.retryAfterMs / 1000)}s`);
        }

        const data = req.data;
        if (!data.documentJson) return req.reject(400, 'documentJson is required');
        if (!data.proofFieldsJson) return req.reject(400, 'proofFieldsJson is required');

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
        // Random by default, so field hashes cannot be guessed by trying values.
        // A caller passes the old seed to rebuild a document already on-chain.
        const saltSeed = data.saltSeed
            ? fromHex32(data.saltSeed)
            : randomBytes(32);
        let built: BuiltContentRoot;
        try {
            built = buildDocumentContentRoot(document, specs, pure, saltSeed, slotWidth);
        } catch (err) {
            return req.reject(400, (err as Error).message);
        }
        // Never log the response. It holds the private proof inputs.
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
            // Holds the salt seed. Without it nothing can be proven about the stored root.
            // If it leaks, field values can be guessed by trying candidates.
            opening: JSON.stringify(built.opening)
        };
    });

    srv.on(prepareMembershipSet, async (req) => {
        const clientKey = req.http?.req?.ip || 'global';
        const rate = prepareRateLimiter.check(clientKey);
        if (!rate.allowed) {
            return req.reject(429, `Rate limited. Retry after ${Math.ceil(rate.retryAfterMs / 1000)}s`);
        }

        const data = req.data;
        if (!data.allowedValuesJson) return req.reject(400, 'allowedValuesJson is required');
        let allowed: unknown;
        try {
            allowed = JSON.parse(data.allowedValuesJson);
        } catch { return req.reject(400, 'allowedValuesJson must be valid JSON'); }
        if (!Array.isArray(allowed) || allowed.length === 0 || allowed.some(v => typeof v !== 'string' || v.length === 0)) {
            return req.reject(400, 'allowedValuesJson must be a non-empty JSON array of non-empty strings');
        }
        // Every entry is hashed before duplicates are removed, so limit the raw list size.
        if (allowed.length > 1024) {
            return req.reject(400, 'allowedValuesJson exceeds 1024 raw entries');
        }
        if (data.value !== undefined && data.valueDigest !== undefined) {
            return req.reject(400, 'pass at most one of value / valueDigest');
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
                return { setRoot, memberCount: digests.length, setSiblingsJson: null, setDirsJson: null };
            }
            const memberDigest = data.valueDigest ?? blake2b256Hex(data.value!);
            const path = membershipPathFor(values, memberDigest, pure);
            if (!path) return req.reject(400, 'value is not in the allowed list');
            // Never log the path. It reveals which list entry matched.
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

    srv.on(attestAgentOutput, async (req) => {
        const data = req.data;

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
            // A retry with the same key reuses the first call's time, so the hash stays the same.
            producedAt = (data.idempotencyKey
                ? await findProducedAt(data.sessionId, data.idempotencyKey, req.user?.id)
                : null) ?? new Date().toISOString();
        }

        // Only hashes go on-chain. agentId and modelId are public.
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

        // The envelope is sent as metadata, so its hash is stored on-chain.
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
                // Already checked for this request. The job is recorded under the same grant.
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
