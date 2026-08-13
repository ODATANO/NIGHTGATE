/**
 * Document ingestion + agent-output provenance
 * (agent-access-layer FR, workstreams 3 and 4 / phases C and D).
 *
 * `prepareDocumentProof` bridges "here is a document as structured fields"
 * to the fixed proof-input shapes of `issueFieldPredicateAttestation`:
 * canonical JSON -> payloadHash, ordered proof fields -> depth-4 Merkle
 * content root + per-field inclusion paths. Compute-only: nothing is
 * persisted, no job is started, and the response carries witness material
 * (scaled values), so it is never logged.
 *
 * `attestAgentOutput` anchors an agent-output provenance envelope
 * (v1: agentId, inputHash, outputHash, optional modelId/policyHash,
 * producedAt) through the existing `anchorDocument` pipeline. The canonical
 * envelope rides as the anchor's public metadata blob, so the on-chain
 * metadata hash commits to the envelope itself and any third party can
 * verify with envelope + `verifyAttestationState` alone.
 *
 * Hashing conventions (deliberately the ecosystem's, NOT the FR's original
 * sha256/JCS sketch): canonical JSON = recursively key-sorted
 * JSON.stringify; hashes = blake2b-256; fieldKey = blake2b256(fieldPath);
 * default value scale x1000; empty leaves = leafHash(blake2b256(
 * 'nightgate/content-root/empty-leaf/v1'), 0). This matches the on-chain
 * scheme the AttestationVault consumers already use (NIGHTPASS
 * passport-anchor.ts), with a NIGHTGATE-namespaced empty leaf. Leaf/node
 * hashing always goes through the contract artifact's exported pure
 * circuits so the off-chain root is byte-identical to the in-circuit fold.
 */

import cds, { Request } from '@sap/cds';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { RateLimiter } from '../utils/rate-limiter';
import { getContractRegistration } from './contract-registry';
import { blake2b256Hex, fromHex32 } from './hashing';
import { buildMembershipSet, membershipPathFor, canonicalSetDigests } from './set-root';

// Re-exported so existing consumers of this module keep their import site;
// the definition moved to the dependency-clean ./hashing (set-root subpath).
export { blake2b256Hex } from './hashing';

const log = cds.log('nightgate:document-proof');

const HEX64_RE = /^[0-9a-fA-F]{64}$/;
const DEFAULT_ATTESTATION_VAULT_REF = 'attestation-vault';

export const MERKLE_DEPTH = 4;
export const MAX_PROOF_FIELDS = 1 << MERKLE_DEPTH; // 16
export const DEFAULT_VALUE_SCALE = 1000;
const EMPTY_LEAF_KEY = 'nightgate/content-root/empty-leaf/v1';
const UINT64_MAX = 18446744073709551615n;

// 120/h per client: pure compute, but the response carries witness material
// and the merkle build imports the artifact, so unbounded hammering is not free.
const prepareRateLimiter = new RateLimiter({ windowMs: 60 * 60 * 1000, maxRequests: 120 });

// ---- Canonical JSON + hashing ---------------------------------------------

/** Recursively sort object keys so the same logical payload always hashes equal. */
export function sortKeys(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sortKeys);
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.keys(value as Record<string, unknown>).sort()
                .map(k => [k, sortKeys((value as Record<string, unknown>)[k])])
        );
    }
    return value;
}

/** Deterministic canonical JSON string of a payload. */
export function canonicalize(value: unknown): string {
    return JSON.stringify(sortKeys(value));
}

/** Canonical 32-byte field id for a field path (public label hash). */
export function fieldKeyHex(fieldPath: string): string {
    return blake2b256Hex(fieldPath);
}

// ---- Value scaling --------------------------------------------------------

/**
 * Scale a raw field value to the Uint<64> integer the circuit compares.
 * Digit-strings with scale 1 take the exact BigInt path (values beyond
 * 2^53 stay precise); everything else goes through Number x scale with a
 * safe-integer guard. Throws with a user-facing message on bad input.
 */
export function scaleFieldValue(raw: number | string, scale: number, label: string): bigint {
    // Explicit type gate: Number(true) is 1, Number([]) is 0 and so on, so a
    // loose conversion would silently mint proof values from non-numerics.
    if (typeof raw !== 'number' && typeof raw !== 'string') {
        throw new Error(`${label}: value must be a number or numeric string`);
    }
    if (typeof raw === 'string') {
        // Number('   ') is 0: trim first and refuse blank strings so no proof
        // value is minted from whitespace. The tree builder treats blank
        // strings as absent BEFORE calling this; standalone callers get the
        // error.
        raw = raw.trim();
        if (raw === '') throw new Error(`${label}: value must not be blank`);
    }
    if (typeof raw === 'string' && /^\d+$/.test(raw)) {
        const scaled = BigInt(raw) * BigInt(scale);
        if (scaled > UINT64_MAX) throw new Error(`${label}: scaled value exceeds Uint<64>`);
        return scaled;
    }
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new Error(`${label}: value must be numeric`);
    if (n < 0) throw new Error(`${label}: value must be non-negative (predicates compare Uint<64>)`);
    const scaled = Math.round(n * scale);
    if (!Number.isSafeInteger(scaled)) {
        throw new Error(`${label}: scaled value exceeds Number.MAX_SAFE_INTEGER; pass an integer digit-string with scale 1`);
    }
    return BigInt(scaled);
}

// ---- Content-root Merkle tree ---------------------------------------------

export interface PureCircuits {
    leafHash(fieldKey: Uint8Array, value: bigint): Uint8Array;
    nodeHash(left: Uint8Array, right: Uint8Array): Uint8Array;
    /** Bytes-valued leaf: persistentHash(BytesLeaf{field_key, value_digest}). */
    bytesLeafHash(fieldKey: Uint8Array, valueDigest: Uint8Array): Uint8Array;
    /** Membership-set leaf: persistentHash(SetLeaf{value_digest}). */
    setLeafHash(valueDigest: Uint8Array): Uint8Array;
}

export interface ProofFieldSpec {
    /** Field path in the document (also the public label the fieldKey hashes). */
    field: string;
    /**
     * Leaf kind. 'uint' (default): numeric value, scaled to Uint<64>.
     * 'bytes': string value, entered as blake2b-256 digest of the exact
     * string (no trimming; the raw document is the canonical form).
     */
    kind?: 'uint' | 'bytes';
    /** Value scale (default 1000, milli-units). Only valid for kind 'uint'. */
    scale?: number;
}

/**
 * Resolve a field path in the document. A literal top-level key wins (so
 * keys that themselves contain dots stay addressable); otherwise dots
 * descend into nested objects (numeric segments index into arrays).
 * Returns undefined when any segment is missing.
 */
export function resolveFieldValue(document: Record<string, unknown>, fieldPath: string): unknown {
    if (Object.prototype.hasOwnProperty.call(document, fieldPath)) return document[fieldPath];
    let cur: unknown = document;
    for (const seg of fieldPath.split('.')) {
        if (cur === null || typeof cur !== 'object') return undefined;
        cur = (cur as Record<string, unknown>)[seg];
    }
    return cur;
}

export interface PreparedField {
    field: string;
    fieldKey: string;     // 64 hex
    kind: 'uint' | 'bytes';
    /** kind 'uint' only: scaled Uint<64>, decimal string (witness material). */
    value?: string;
    /** kind 'bytes' only: blake2b-256 of the exact string value, 64 hex. */
    valueDigest?: string;
    siblings: string[];   // MERKLE_DEPTH x 64 hex
    dirs: boolean[];      // MERKLE_DEPTH booleans (true = node is LEFT child)
}

/**
 * Build the depth-4 content root over an ORDERED field list (leaf index =
 * position in `specs`; the order is part of the tree identity, so callers
 * must keep it stable across anchor and proof). Fields whose document value
 * is absent (null/undefined/'') occupy the fixed empty leaf and appear in
 * `emptyFields` instead of `fields`.
 */
export function buildDocumentContentRoot(
    document: Record<string, unknown>,
    specs: ProofFieldSpec[],
    pure: PureCircuits
): { contentRoot: string; fields: PreparedField[]; emptyFields: string[] } {
    const emptyLeaf = pure.leafHash(fromHex32(fieldKeyHex(EMPTY_LEAF_KEY)), 0n);

    type LeafValue = { kind: 'uint'; scaled: bigint } | { kind: 'bytes'; digest: string } | null;
    const leaves: Uint8Array[] = [];
    const leafValues: LeafValue[] = [];
    for (let i = 0; i < MAX_PROOF_FIELDS; i++) {
        const spec = specs[i];
        const raw = spec ? (resolveFieldValue(document, spec.field) as number | string | null | undefined) : undefined;
        if (raw !== null && raw !== undefined && typeof raw === 'object') {
            throw new Error(`proofFields[${i}] (${spec!.field}): path resolves to an object/array, not a scalar`);
        }
        // Blank includes whitespace-only strings: Number('   ') would be 0.
        const isBlank = raw === null || raw === undefined
            || (typeof raw === 'string' && raw.trim() === '');
        if (spec && !isBlank) {
            if (spec.kind === 'bytes') {
                // The digest covers the EXACT string as it appears in the
                // document (no trimming): a verifier recomputing from the raw
                // document must land on the same digest.
                if (typeof raw !== 'string') {
                    throw new Error(`proofFields[${i}] (${spec.field}): kind 'bytes' requires a string value`);
                }
                const digest = blake2b256Hex(raw);
                leafValues.push({ kind: 'bytes', digest });
                leaves.push(pure.bytesLeafHash(fromHex32(fieldKeyHex(spec.field)), fromHex32(digest)));
            } else {
                const scaled = scaleFieldValue(raw, spec.scale ?? DEFAULT_VALUE_SCALE, `proofFields[${i}] (${spec.field})`);
                leafValues.push({ kind: 'uint', scaled });
                leaves.push(pure.leafHash(fromHex32(fieldKeyHex(spec.field)), scaled));
            }
        } else {
            leafValues.push(null);
            leaves.push(emptyLeaf);
        }
    }

    const levels: Uint8Array[][] = [leaves];
    for (let d = 0; d < MERKLE_DEPTH; d++) {
        const prev = levels[d];
        const next: Uint8Array[] = [];
        for (let i = 0; i < prev.length; i += 2) next.push(pure.nodeHash(prev[i], prev[i + 1]));
        levels.push(next);
    }
    const contentRoot = Buffer.from(levels[MERKLE_DEPTH][0]).toString('hex');

    const fields: PreparedField[] = [];
    const emptyFields: string[] = [];
    specs.forEach((spec, idx) => {
        const leafValue = leafValues[idx];
        if (leafValue === null) { emptyFields.push(spec.field); return; }
        const siblings: string[] = [];
        const dirs: boolean[] = [];
        let node = idx;
        for (let d = 0; d < MERKLE_DEPTH; d++) {
            const isLeft = node % 2 === 0;
            siblings.push(Buffer.from(levels[d][isLeft ? node + 1 : node - 1]).toString('hex'));
            dirs.push(isLeft);
            node = Math.floor(node / 2);
        }
        const base = { field: spec.field, fieldKey: fieldKeyHex(spec.field), siblings, dirs };
        fields.push(leafValue.kind === 'bytes'
            ? { ...base, kind: 'bytes', valueDigest: leafValue.digest }
            : { ...base, kind: 'uint', value: leafValue.scaled.toString() });
    });

    return { contentRoot, fields, emptyFields };
}

// ---- Pure-circuit loading -------------------------------------------------

export async function loadPureCircuitsFromRegistry(compiledRef: string): Promise<PureCircuits> {
    const reg = getContractRegistration(compiledRef);
    if (!reg) throw new PureCircuitsUnavailableError(`contract '${compiledRef}' is not registered`);
    const importSpec = path.isAbsolute(reg.artifactPath)
        ? pathToFileURL(reg.artifactPath).href
        : reg.artifactPath;
    const mod: any = await import(importSpec);
    const pure = mod.pureCircuits ?? mod.default?.pureCircuits;
    if (!pure?.leafHash || !pure?.nodeHash || !pure?.bytesLeafHash || !pure?.setLeafHash) {
        throw new PureCircuitsUnavailableError(
            `artifact '${compiledRef}' exports no leafHash/nodeHash/bytesLeafHash/setLeafHash pure circuits`);
    }
    return pure as PureCircuits;
}

export class PureCircuitsUnavailableError extends Error {
    constructor(message: string) { super(message); this.name = 'PureCircuitsUnavailableError'; }
}

// ---- Handlers -------------------------------------------------------------

export interface DocumentProofHandlerDeps {
    /** Test seam; defaults to the registry-backed artifact import. */
    loadPure?: (compiledRef: string) => Promise<PureCircuits>;
}

export function registerDocumentProofHandlers(srv: any, deps: DocumentProofHandlerDeps = {}): void {
    const loadPure = deps.loadPure ?? loadPureCircuitsFromRegistry;

    srv.on('prepareDocumentProof', async (req: Request) => {
        const clientKey = (req as any)?._?.req?.ip || 'global';
        const rate = prepareRateLimiter.check(clientKey);
        if (!rate.allowed) {
            return req.reject(429, `Rate limited. Retry after ${Math.ceil(rate.retryAfterMs / 1000)}s`);
        }

        const data = req.data as { documentJson?: string; proofFieldsJson?: string; compiledArtifactRef?: string };
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
        if (specs.length > MAX_PROOF_FIELDS) {
            return req.reject(400, `at most ${MAX_PROOF_FIELDS} proof fields (depth-${MERKLE_DEPTH} tree)`);
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

        const compiledRef = data.compiledArtifactRef?.length ? data.compiledArtifactRef : DEFAULT_ATTESTATION_VAULT_REF;
        let pure: PureCircuits;
        try {
            pure = await loadPure(compiledRef);
        } catch (err) {
            if (err instanceof PureCircuitsUnavailableError) return req.reject(404, err.message);
            throw err;
        }

        const canonicalDocument = canonicalize(document);
        const payloadHash = blake2b256Hex(canonicalDocument);
        let built: ReturnType<typeof buildDocumentContentRoot>;
        try {
            built = buildDocumentContentRoot(document, specs, pure);
        } catch (err) {
            return req.reject(400, (err as Error).message);
        }
        // Never log: response carries witness material (scaled field values).
        log.info(`prepared document proof: ${specs.length} fields, ${built.emptyFields.length} empty`);

        return {
            payloadHash,
            canonicalDocument,
            contentRoot: built.contentRoot,
            fields: JSON.stringify(built.fields),
            emptyFields: JSON.stringify(built.emptyFields)
        };
    });

    srv.on('prepareMembershipSet', async (req: Request) => {
        const clientKey = (req as any)?._?.req?.ip || 'global';
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

    srv.on('attestAgentOutput', async (req: Request) => {
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
        let producedAt = new Date().toISOString();
        if (data.producedAt) {
            const t = new Date(data.producedAt);
            if (Number.isNaN(t.getTime())) return req.reject(400, 'producedAt must be a valid ISO-8601 timestamp');
            producedAt = t.toISOString();
        }

        // Envelope v1: hashes only, no content; agentId/modelId are public by
        // design. Canonical form is what verifiers re-hash.
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

        // Reuse the anchorDocument pipeline unchanged (rate limit, Documents
        // row, job, sponsoring). The canonical envelope rides as the public
        // metadata blob, so the on-chain metadata hash commits to it.
        try {
            const anchored = await srv.send({
                event: 'anchorDocument',
                data: {
                    sha256: payloadHash,
                    contentType: 'application/vnd.nightgate.agent-output.v1+json',
                    storageRef: data.storageRef?.length ? data.storageRef : `agent-output://${data.agentId}`,
                    metadata: envelopeJson,
                    sessionId: data.sessionId,
                    contractAddress: data.contractAddress,
                    compiledArtifactRef: data.compiledArtifactRef,
                    idempotencyKey: data.idempotencyKey,
                    sponsorSessionId: data.sponsorSessionId
                },
                user: (req as any).user
            });
            return { ...anchored, payloadHash, envelopeJson };
        } catch (err: any) {
            const status = Number(err?.code ?? err?.status);
            return req.reject(Number.isInteger(status) && status >= 400 && status < 600 ? status : 500,
                String(err?.message ?? err));
        }
    });
}
