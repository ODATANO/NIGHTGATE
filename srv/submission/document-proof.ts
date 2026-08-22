/**
 * Document ingestion + agent-output provenance
 * (agent-access-layer FR, workstreams 3 and 4 / phases C and D).
 *
 * `prepareDocumentProof` bridges "here is a document as structured fields"
 * to the fixed proof-input shapes of `issueFieldPredicateAttestation`:
 * canonical JSON -> payloadHash, ordered proof fields -> salted Merkle
 * content root (depth log2(width): 4 on the 16-slot default, 5 on
 * attestation-vault-32) + per-field inclusion paths. Compute-only: nothing is
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
 * default value scale x1000. v4 (0.16.0): every leaf is SALTED with a
 * per-slot salt derived from a per-document 32-byte seed (`slotSalt` pure
 * circuit); absent slots use the salted absent leaf (padding key
 * "nightgate/empty-leaf/v2" ASCII zero-padded), so a shared leaf layer is
 * not dictionary-testable and does not reveal the presence pattern. The
 * schema id is the depth-4 root over the 16 slot DESCRIPTORS (fieldKey,
 * kind, scale), in-circuit recomputable. Leaf/node/descriptor hashing
 * always goes through the contract artifact's exported pure circuits so
 * the off-chain roots are byte-identical to the in-circuit recompute
 * (NIGHTPASS passport-anchor.ts must adopt this rule with the 0.16.0
 * redeploy).
 */

import cds, { Request } from '@sap/cds';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { RateLimiter } from '../utils/rate-limiter';
import { getContractRegistration, slotWidthOf } from './contract-registry';
import { blake2b256Hex, fromHex32, emptyLeafKeyHex } from './hashing';
import { buildMembershipSet, membershipPathFor, canonicalSetDigests } from './set-root';

// Re-exported so existing consumers of this module keep their import site;
// the definition moved to the dependency-clean ./hashing (set-root subpath).
export { blake2b256Hex } from './hashing';

const log = cds.log('nightgate:document-proof');

const HEX64_RE = /^[0-9a-fA-F]{64}$/;
const DEFAULT_ATTESTATION_VAULT_REF = 'attestation-vault';

// Classic 16-slot vault dimensions; kept exported for compatibility. The
// tree builders below take an optional WIDTH (16/32) so wider vault variants
// (`slotWidth` on the contract registration) reuse the same canonical rules.
export const MERKLE_DEPTH = 4;
export const MAX_PROOF_FIELDS = 1 << MERKLE_DEPTH; // 16

/** Content-tree width (provable fields per document) of a registered artifact. */
export function slotWidthForRef(compiledRef: string): number {
    return slotWidthOf(getContractRegistration(compiledRef));
}

export const DEFAULT_VALUE_SCALE = 1000;
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
    /** Per-slot salt derived from the document's 32-byte salt seed. */
    slotSalt(seed: Uint8Array, index: bigint): Uint8Array;
    /** Canonical padding-slot key ("nightgate/empty-leaf/v2" zero-padded). */
    emptyLeafKey(): Uint8Array;
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
    /** Per-slot salt, 64 hex (witness material; the leaf's commitment opening). */
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

/** One document's opening of one slot, wire form (witness material). */
export interface SlotOpeningWire {
    present: boolean;
    /** schema kind 0, present: scaled Uint<64> decimal string. */
    value?: string;
    /** schema kind 1, present: blake2b-256 digest, 64 hex. */
    valueDigest?: string;
}

/** A document's full cross-root opening, wire form (witness material). */
export interface DocumentOpeningWire {
    saltSeed: string;             // 64 hex, the per-document salt seed
    slots: SlotOpeningWire[];     // exactly 16, slot order
}

/**
 * The 16 slot descriptors of an ORDERED proofFields list. Spec slots use the
 * spec's declared interpretation REGARDLESS of the document's value or
 * presence; padding slots beyond the list use the canonical empty-leaf key
 * with kind 2 and scale 0.
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
 * The schema id (= schema ROOT) of an ORDERED proofFields list: the depth-4
 * Merkle root over the 16 descriptor leaves, computed with the artifact's
 * pure circuits so it is byte-identical to the in-circuit recompute of
 * `proveDocumentComparison`. Binding kind and scale is what makes the schema
 * assert sound: two documents whose leaves collide numerically (x=1 at scale
 * 1000 vs x=1000 at scale 1) anchor DIFFERENT schema ids. Because the
 * comparison circuit RECOMPUTES this root from witnessed descriptors, an
 * anchored schema id is proven to describe the tree, not merely claimed.
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
    /** Salted leaf hashes in slot order (informational; the root's layer). */
    leaves: string[];
    /** The full cross-root opening (witness material). */
    opening: DocumentOpeningWire;
}

/**
 * Build the depth-4 SALTED content root over an ORDERED field list (leaf
 * index = position in `specs`; the order is part of the tree identity, so
 * callers must keep it stable across anchor and proof). Every slot's salt is
 * derived from `saltSeed` via the artifact's `slotSalt` circuit; fields whose
 * document value is absent (null/undefined/'') occupy the salted absent leaf
 * and appear in `emptyFields`. The seed is the document's commitment opening:
 * KEEP it (re-preparing with the same seed reproduces the same root; a fresh
 * seed yields a DIFFERENT root that an already-anchored payload rejects).
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
                leaves.push(pure.bytesLeafHash(fromHex32(fieldKeyHex(spec.field)), fromHex32(digest), salt));
            } else {
                const scaled = scaleFieldValue(raw, spec.scale ?? DEFAULT_VALUE_SCALE, `proofFields[${i}] (${spec.field})`);
                leafValues.push({ kind: 'uint', scaled });
                leaves.push(pure.leafHash(fromHex32(fieldKeyHex(spec.field)), scaled, salt));
            }
        } else {
            leafValues.push(null);
            // Absent slots are salted too: a shared leaf layer reveals neither
            // values nor the presence pattern.
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

    // The cross-root witness bundle: seed + per-slot openings in slot order.
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
    const importSpec = path.isAbsolute(reg.artifactPath)
        ? pathToFileURL(reg.artifactPath).href
        : reg.artifactPath;
    const mod: any = await import(importSpec);
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
        // Width comes from the target artifact's registration (slotWidth,
        // default 16), so `attestation-vault-32` accepts up to 32 fields.
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
        // The salt seed is the document's commitment opening: random by
        // default (dictionary resistance), caller-supplied for a
        // deterministic re-prepare of an already-anchored payload.
        const saltSeed = data.saltSeed && HEX64_RE.test(data.saltSeed)
            ? fromHex32(data.saltSeed)
            : randomBytes(32);
        let built: BuiltContentRoot;
        try {
            built = buildDocumentContentRoot(document, specs, pure, saltSeed, slotWidth);
        } catch (err) {
            return req.reject(400, (err as Error).message);
        }
        // Never log: response carries witness material (scaled field values).
        log.info(`prepared document proof: ${specs.length} fields, ${built.emptyFields.length} empty`);

        return {
            payloadHash,
            canonicalDocument,
            contentRoot: built.contentRoot,
            schemaId: built.schemaId,
            // The shared descriptor list behind schemaId (public).
            schema: JSON.stringify(built.schema),
            fields: JSON.stringify(built.fields),
            emptyFields: JSON.stringify(built.emptyFields),
            // Salted leaf layer in slot order (informational).
            leaves: JSON.stringify(built.leaves),
            // Cross-root witness bundle: STORE alongside the document. The
            // saltSeed inside is the opening of every leaf; losing it makes
            // the anchored root unprovable, leaking it makes shared leaf
            // hashes dictionary-testable again.
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
        // Same raw cap as the submission paths: a canonical set holds at most
        // 64 DISTINCT digests, but dedupe runs after digesting, so an
        // unbounded raw list would let one request hash arbitrarily many
        // entries before the 64-limit ever triggers.
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
