/**
 * Document ingestion (payloadHash, salted content root, inclusion paths) and
 * agent-output provenance. Leaf, node and descriptor hashes go through the
 * artifact's pure circuits so roots match the in-circuit recompute; external builders must too.
 */

import cds, { Request } from '@sap/cds';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { RateLimiter } from '../utils/rate-limiter';
import { getContractRegistration, slotWidthOf, importRegisteredArtifact } from './contract-registry';
import { blake2b256Hex, fromHex32, emptyLeafKeyHex } from './hashing';
import { buildMembershipSet, membershipPathFor, canonicalSetDigests } from './set-root';
import { BackgroundJobs } from '#cds-models/midnight';

export { blake2b256Hex } from './hashing';

const log = cds.log('nightgate:document-proof');

const HEX64_RE = /^[0-9a-fA-F]{64}$/;
const DEFAULT_ATTESTATION_VAULT_REF = 'attestation-vault';

// Default 16-slot dimensions; the tree builders take an optional width.
export const MERKLE_DEPTH = 4;
export const MAX_PROOF_FIELDS = 1 << MERKLE_DEPTH; // 16

export function slotWidthForRef(compiledRef: string): number {
    return slotWidthOf(getContractRegistration(compiledRef));
}

export const DEFAULT_VALUE_SCALE = 1000;
const UINT64_MAX = 18446744073709551615n;

// Compute-only, but each call imports the artifact and hashes a full tree.
const prepareRateLimiter = new RateLimiter({ windowMs: 60 * 60 * 1000, maxRequests: 120 });

// ---- Canonical JSON + hashing ---------------------------------------------

/**
 * Recursively sort object keys. Not a hash input: JS objects enumerate
 * integer-like keys numerically, so hashing uses `canonicalize`.
 */
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

/**
 * Canonical JSON: RFC 8785 member order (UTF-16 code units, integer-like keys
 * included), JSON.stringify number/string forms and undefined handling.
 */
export function canonicalize(value: unknown): string {
    if (value === null || typeof value !== 'object') {
        const s = JSON.stringify(value);
        return s === undefined ? 'null' : s;
    }
    if (Array.isArray(value)) return '[' + value.map(v => canonicalize(v === undefined ? null : v)).join(',') + ']';
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).filter(k => obj[k] !== undefined && typeof obj[k] !== 'function').sort();
    return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalize(obj[k])).join(',') + '}';
}

/** fieldKey = blake2b-256 of the field path. */
export function fieldKeyHex(fieldPath: string): string {
    return blake2b256Hex(fieldPath);
}

// ---- Value scaling --------------------------------------------------------

/**
 * Scale a raw value to the circuit's Uint<64>. Integer digit-strings take an
 * exact BigInt path; everything else Number x scale with a safe-integer guard.
 */
export function scaleFieldValue(raw: number | string, scale: number, label: string): bigint {
    // Number(true), Number([]) and Number('   ') would mint proof values.
    if (typeof raw !== 'number' && typeof raw !== 'string') {
        throw new Error(`${label}: value must be a number or numeric string`);
    }
    if (typeof raw === 'string') {
        raw = raw.trim();
        if (raw === '') throw new Error(`${label}: value must not be blank`);
        // Number() also parses hex and exponent forms.
        if (!/^\d+(\.\d+)?$/.test(raw)) throw new Error(`${label}: numeric strings must be decimal digits with an optional fraction`);
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
    /** Salted uint leaf: hash of FieldLeaf{field_key, value, salt}. */
    leafHash(fieldKey: Uint8Array, value: bigint, salt: Uint8Array): Uint8Array;
    nodeHash(left: Uint8Array, right: Uint8Array): Uint8Array;
    /** Salted bytes leaf: hash of BytesLeaf{field_key, value_digest, salt}. */
    bytesLeafHash(fieldKey: Uint8Array, valueDigest: Uint8Array, salt: Uint8Array): Uint8Array;
    /** Salted absent-slot leaf: hash of AbsentLeaf{field_key, salt}. */
    absentLeafHash(fieldKey: Uint8Array, salt: Uint8Array): Uint8Array;
    /** Membership-set leaf (unsalted; the allow-list is public). */
    setLeafHash(valueDigest: Uint8Array): Uint8Array;
    /** Schema-descriptor leaf: hash of SlotDescriptor{field_key, kind, scale}. */
    descriptorLeafHash(fieldKey: Uint8Array, kind: bigint, scale: bigint): Uint8Array;
    slotSalt(seed: Uint8Array, index: bigint): Uint8Array;
    /** Canonical padding-slot key ("nightgate/empty-leaf/v2" zero-padded). */
    emptyLeafKey(): Uint8Array;
}

export interface ProofFieldSpec {
    /** Field path; also the public label the fieldKey hashes. */
    field: string;
    /** 'uint' (default): scaled Uint<64>. 'bytes': blake2b-256 of the exact, untrimmed string. */
    kind?: 'uint' | 'bytes';
    /** Default 1000 (milli-units); 'uint' only. */
    scale?: number;
}

/** A literal top-level key wins (dotted keys stay addressable); otherwise dots descend. */
export function resolveFieldValue(document: Record<string, unknown>, fieldPath: string): unknown {
    if (Object.prototype.hasOwnProperty.call(document, fieldPath)) return document[fieldPath];
    let cur: unknown = document;
    for (const seg of fieldPath.split('.')) {
        // Own properties only: no resolution through the prototype chain.
        if (cur === null || typeof cur !== 'object' || !Object.prototype.hasOwnProperty.call(cur, seg)) return undefined;
        cur = (cur as Record<string, unknown>)[seg];
    }
    return cur;
}

export interface PreparedField {
    field: string;
    fieldKey: string;     // 64 hex
    kind: 'uint' | 'bytes';
    /** kind 'uint': scaled Uint<64>, decimal (witness material). */
    value?: string;
    /** kind 'bytes': 64 hex. */
    valueDigest?: string;
    /** 64 hex, witness material. */
    salt: string;
    siblings: string[];   // MERKLE_DEPTH x 64 hex
    dirs: boolean[];      // MERKLE_DEPTH booleans (true = node is LEFT child)
}

/** One slot of the shared schema, wire form. kind: 0 = uint, 1 = bytes, 2 = padding. */
export interface SchemaDescriptorWire {
    fieldKey: string;     // 64 hex
    kind: 0 | 1 | 2;
    scale: string;        // decimal Uint<64>; '0' for bytes/padding slots
}

/** One document's opening of one slot (witness material). */
export interface SlotOpeningWire {
    present: boolean;
    /** kind 0: scaled Uint<64>, decimal. */
    value?: string;
    /** kind 1: 64 hex. */
    valueDigest?: string;
}

/** A document's full cross-root opening (witness material). */
export interface DocumentOpeningWire {
    saltSeed: string;             // 64 hex
    slots: SlotOpeningWire[];     // one per slot, slot order
}

/**
 * Slot descriptors follow the spec regardless of the document's values; slots
 * past the list are padding: empty-leaf key, kind 2, scale 0.
 */
export function computeSchemaDescriptors(specs: ProofFieldSpec[], width: number = MAX_PROOF_FIELDS): SchemaDescriptorWire[] {
    const out: SchemaDescriptorWire[] = [];
    for (let i = 0; i < width; i++) {
        const spec = i < specs.length ? specs[i] : undefined;
        if (!spec) {
            out.push({ fieldKey: emptyLeafKeyHex(), kind: 2, scale: '0' });
        } else if (spec.kind === 'bytes') {
            out.push({ fieldKey: fieldKeyHex(spec.field), kind: 1, scale: '0' });
        } else {
            out.push({ fieldKey: fieldKeyHex(spec.field), kind: 0, scale: String(spec.scale ?? DEFAULT_VALUE_SCALE) });
        }
    }
    return out;
}

/**
 * Schema id = Merkle root over the descriptor leaves. Kind and scale are bound
 * so numerically colliding leaves (x=1 at scale 1000 vs 1000 at scale 1) differ.
 */
export function computeSchemaId(specs: ProofFieldSpec[], pure: PureCircuits, width: number = MAX_PROOF_FIELDS): string {
    const descriptors = computeSchemaDescriptors(specs, width);
    let level = descriptors.map(d =>
        pure.descriptorLeafHash(fromHex32(d.fieldKey), BigInt(d.kind), BigInt(d.scale)));
    while (level.length > 1) {
        const next: Uint8Array[] = [];
        for (let i = 0; i < level.length; i += 2) next.push(pure.nodeHash(level[i], level[i + 1]));
        level = next;
    }
    return Buffer.from(level[0]).toString('hex');
}

export interface BuiltContentRoot {
    contentRoot: string;
    schemaId: string;
    schema: SchemaDescriptorWire[];
    fields: PreparedField[];
    emptyFields: string[];
    /** Salted leaf hashes in slot order (informational). */
    leaves: string[];
    opening: DocumentOpeningWire;
}

/**
 * Salted content root; leaf index = position in `specs`, so the order must stay
 * stable. Blank values take the salted absent leaf. Only the same seed reproduces the root.
 */
export function buildDocumentContentRoot(
    document: Record<string, unknown>,
    specs: ProofFieldSpec[],
    pure: PureCircuits,
    saltSeed: Uint8Array,
    width: number = MAX_PROOF_FIELDS
): BuiltContentRoot {
    if (!(saltSeed instanceof Uint8Array) || saltSeed.length !== 32) {
        throw new Error('saltSeed must be 32 bytes');
    }
    const depth = Math.log2(width);
    const schema = computeSchemaDescriptors(specs, width);
    type LeafValue = { kind: 'uint'; scaled: bigint } | { kind: 'bytes'; digest: string } | null;
    const leaves: Uint8Array[] = [];
    const salts: Uint8Array[] = [];
    const leafValues: LeafValue[] = [];
    for (let i = 0; i < width; i++) {
        const spec = specs[i];
        const salt = pure.slotSalt(saltSeed, BigInt(i));
        salts.push(salt);
        const raw = spec ? (resolveFieldValue(document, spec.field) as number | string | null | undefined) : undefined;
        if (raw !== null && raw !== undefined && typeof raw === 'object') {
            throw new Error(`proofFields[${i}] (${spec!.field}): path resolves to an object/array, not a scalar`);
        }
        const isBlank = raw === null || raw === undefined
            || (typeof raw === 'string' && raw.trim() === '');
        if (spec && !isBlank) {
            if (spec.kind === 'bytes') {
                // Untrimmed: verifiers recompute from the raw document.
                if (typeof raw !== 'string') {
                    throw new Error(`proofFields[${i}] (${spec.field}): kind 'bytes' requires a string value`);
                }
                const digest = blake2b256Hex(raw);
                leafValues.push({ kind: 'bytes', digest });
                leaves.push(pure.bytesLeafHash(fromHex32(fieldKeyHex(spec.field)), fromHex32(digest), salt));
            } else {
                const scaled = scaleFieldValue(raw, spec.scale ?? DEFAULT_VALUE_SCALE, `proofFields[${i}] (${spec.field})`);
                leafValues.push({ kind: 'uint', scaled });
                leaves.push(pure.leafHash(fromHex32(fieldKeyHex(spec.field)), scaled, salt));
            }
        } else {
            leafValues.push(null);
            // Salted so a shared leaf layer does not reveal the presence pattern.
            leaves.push(pure.absentLeafHash(fromHex32(schema[i].fieldKey), salt));
        }
    }

    const levels: Uint8Array[][] = [leaves];
    for (let d = 0; d < depth; d++) {
        const prev = levels[d];
        const next: Uint8Array[] = [];
        for (let i = 0; i < prev.length; i += 2) next.push(pure.nodeHash(prev[i], prev[i + 1]));
        levels.push(next);
    }
    const contentRoot = Buffer.from(levels[depth][0]).toString('hex');

    const fields: PreparedField[] = [];
    const emptyFields: string[] = [];
    specs.forEach((spec, idx) => {
        const leafValue = leafValues[idx];
        if (leafValue === null) { emptyFields.push(spec.field); return; }
        const siblings: string[] = [];
        const dirs: boolean[] = [];
        let node = idx;
        for (let d = 0; d < depth; d++) {
            const isLeft = node % 2 === 0;
            siblings.push(Buffer.from(levels[d][isLeft ? node + 1 : node - 1]).toString('hex'));
            dirs.push(isLeft);
            node = Math.floor(node / 2);
        }
        const base = {
            field: spec.field, fieldKey: fieldKeyHex(spec.field),
            salt: Buffer.from(salts[idx]).toString('hex'), siblings, dirs
        };
        fields.push(leafValue.kind === 'bytes'
            ? { ...base, kind: 'bytes', valueDigest: leafValue.digest }
            : { ...base, kind: 'uint', value: leafValue.scaled.toString() });
    });

    const opening: DocumentOpeningWire = {
        saltSeed: Buffer.from(saltSeed).toString('hex'),
        slots: leafValues.map(lv => lv === null
            ? { present: false }
            : lv.kind === 'bytes'
                ? { present: true, valueDigest: lv.digest }
                : { present: true, value: lv.scaled.toString() })
    };

    const leafHexes = leaves.map(l => Buffer.from(l).toString('hex'));
    return {
        contentRoot, schemaId: computeSchemaId(specs, pure, width), schema,
        fields, emptyFields, leaves: leafHexes, opening
    };
}

// ---- Pure-circuit loading -------------------------------------------------

export async function loadPureCircuitsFromRegistry(compiledRef: string): Promise<PureCircuits> {
    const reg = getContractRegistration(compiledRef);
    if (!reg) throw new PureCircuitsUnavailableError(`contract '${compiledRef}' is not registered`);
    const mod: any = await importRegisteredArtifact(compiledRef);
    const pure = mod.pureCircuits ?? mod.default?.pureCircuits;
    if (!pure?.leafHash || !pure?.nodeHash || !pure?.bytesLeafHash || !pure?.absentLeafHash
        || !pure?.setLeafHash || !pure?.descriptorLeafHash || !pure?.slotSalt || !pure?.emptyLeafKey) {
        throw new PureCircuitsUnavailableError(
            `artifact '${compiledRef}' exports no leafHash/nodeHash/bytesLeafHash/absentLeafHash/setLeafHash/descriptorLeafHash/slotSalt pure circuits`);
    }
    return pure as PureCircuits;
}

export class PureCircuitsUnavailableError extends Error {
    constructor(message: string) { super(message); this.name = 'PureCircuitsUnavailableError'; }
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
    const job: any = await cds.db.run(
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

    srv.on('prepareDocumentProof', async (req: Request) => {
        const clientKey = (req as any)?._?.req?.ip || 'global';
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
        let producedAt: string;
        if (data.producedAt) {
            const t = new Date(data.producedAt);
            if (Number.isNaN(t.getTime())) return req.reject(400, 'producedAt must be a valid ISO-8601 timestamp');
            producedAt = t.toISOString();
        } else {
            // A retry under the same key re-derives the first call's envelope.
            producedAt = (data.idempotencyKey
                ? await findProducedAt(data.sessionId, data.idempotencyKey, (req as any).user?.id)
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
