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
import { blake2b } from '@noble/hashes/blake2b';
import { bytesToHex } from '@noble/hashes/utils';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { RateLimiter } from '../utils/rate-limiter';
import { getContractRegistration } from './contract-registry';

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

/** blake2b-256 hex of a UTF-8 string (the on-chain hashing scheme). */
export function blake2b256Hex(input: string): string {
    return bytesToHex(blake2b(Buffer.from(input, 'utf8'), { dkLen: 32 }));
}

/** Canonical 32-byte field id for a field path (public label hash). */
export function fieldKeyHex(fieldPath: string): string {
    return blake2b256Hex(fieldPath);
}

function fromHex32(hex: string): Uint8Array {
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
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
}

export interface ProofFieldSpec {
    /** Field path in the document (also the public label the fieldKey hashes). */
    field: string;
    /** Value scale (default 1000, milli-units). */
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
    fieldKey: string;    // 64 hex
    value: string;       // scaled Uint<64>, decimal string (witness material)
    siblings: string[];  // MERKLE_DEPTH x 64 hex
    dirs: boolean[];     // MERKLE_DEPTH booleans (true = node is LEFT child)
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

    const leaves: Uint8Array[] = [];
    const scaledValues: (bigint | null)[] = [];
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
            const scaled = scaleFieldValue(raw, spec.scale ?? DEFAULT_VALUE_SCALE, `proofFields[${i}] (${spec.field})`);
            scaledValues.push(scaled);
            leaves.push(pure.leafHash(fromHex32(fieldKeyHex(spec.field)), scaled));
        } else {
            scaledValues.push(null);
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
        const scaled = scaledValues[idx];
        if (scaled === null) { emptyFields.push(spec.field); return; }
        const siblings: string[] = [];
        const dirs: boolean[] = [];
        let node = idx;
        for (let d = 0; d < MERKLE_DEPTH; d++) {
            const isLeft = node % 2 === 0;
            siblings.push(Buffer.from(levels[d][isLeft ? node + 1 : node - 1]).toString('hex'));
            dirs.push(isLeft);
            node = Math.floor(node / 2);
        }
        fields.push({ field: spec.field, fieldKey: fieldKeyHex(spec.field), value: scaled.toString(), siblings, dirs });
    });

    return { contentRoot, fields, emptyFields };
}

// ---- Pure-circuit loading -------------------------------------------------

async function loadPureCircuitsFromRegistry(compiledRef: string): Promise<PureCircuits> {
    const reg = getContractRegistration(compiledRef);
    if (!reg) throw new PureCircuitsUnavailableError(`contract '${compiledRef}' is not registered`);
    const importSpec = path.isAbsolute(reg.artifactPath)
        ? pathToFileURL(reg.artifactPath).href
        : reg.artifactPath;
    const mod: any = await import(importSpec);
    const pure = mod.pureCircuits ?? mod.default?.pureCircuits;
    if (!pure?.leafHash || !pure?.nodeHash) {
        throw new PureCircuitsUnavailableError(
            `artifact '${compiledRef}' exports no leafHash/nodeHash pure circuits`);
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
