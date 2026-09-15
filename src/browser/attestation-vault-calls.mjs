// Typed call-input helpers for the AttestationVault contract (browser path).
//
// These prepare the inputs a contract call needs (circuit id, the Uint8Array
// arguments, and the witness object) so a consumer can pass them straight to
// midnight-js's findDeployedContract() .callTx.<circuit>(...) (with the
// witnesses bound) or createUnprovenCallTx.
//
// Only the OWNER-GATED circuits (attest, grant/revokeDisclosure,
// registerDocument, bindDocument, anchorContentRoot, retract of a payload)
// require the attestationSecret; the proof circuits never invoke
// local_secret_key, so a HOLDER proves against an anchored root without ever
// receiving the owner secret (privilege separation).
//
// The hex↔bytes conversion and witness assembly are pure and verifiable here;
// the actual SDK call + prove + balance + submit is the live-integration step
// (see providers.mjs scope note).

import { buildAttestationVaultWitnesses } from './witnesses.mjs';
import { hexToBytes32 } from './hex.mjs';

const nowSeconds = () => Math.floor(Date.now() / 1000);
/** Default claim lifetime (one year); the vault caps `valid_until` at five years ahead. */
export const DEFAULT_CLAIM_LIFETIME_S = 365 * 24 * 60 * 60;
const ZERO32 = () => new Uint8Array(32);

function claimValidUntil(validUntil) {
    const v = BigInt(validUntil ?? nowSeconds() + DEFAULT_CLAIM_LIFETIME_S);
    if (v <= BigInt(nowSeconds())) throw new Error('validUntil must lie in the future (UNIX seconds)');
    return v;
}

/**
 * Prepare a `revokeDisclosure(payload_hash, grantee)` call.
 * Every proof helper takes an optional `validUntil` (UNIX seconds, default
 * one year ahead, at most five years): the claim's expiry on the ledger.
 * @returns {{ circuitId: string, args: Uint8Array[], witnesses: object }}
 */
export function prepareRevokeDisclosure({ payloadHash, grantee, attestationSecret }) {
    if (!(attestationSecret instanceof Uint8Array)) throw new Error('attestationSecret (Uint8Array) is required');
    return {
        circuitId: 'revokeDisclosure',
        args: [hexToBytes32(payloadHash, 'payloadHash'), hexToBytes32(grantee, 'grantee')],
        witnesses: buildAttestationVaultWitnesses({ attestationSecret })
    };
}

/**
 * Prepare a `grantDisclosure(payload_hash, grantee, level)` call.
 * `level`: 0=public, 1=legitimate-interest, 2=authority.
 */
export function prepareGrantDisclosure({ payloadHash, grantee, level, attestationSecret }) {
    if (!(attestationSecret instanceof Uint8Array)) throw new Error('attestationSecret (Uint8Array) is required');
    const lvl = BigInt(level);
    if (lvl < 0n || lvl > 2n) throw new Error('level must be 0, 1 or 2');
    return {
        circuitId: 'grantDisclosure',
        args: [hexToBytes32(payloadHash, 'payloadHash'), hexToBytes32(grantee, 'grantee'), lvl],
        witnesses: buildAttestationVaultWitnesses({ attestationSecret })
    };
}

/**
 * Prepare an `attest(payload_hash, metadata_hash)` call. The vault keys the
 * record by the caller's attester id and the hash (`recordKeyOf`), so no
 * other identity can pre-empt or take over it; the same hash attested by
 * another identity is a different record.
 */
export function prepareAttest({ payloadHash, metadataHash, attestationSecret }) {
    if (!(attestationSecret instanceof Uint8Array)) throw new Error('attestationSecret (Uint8Array) is required');
    return {
        circuitId: 'attest',
        args: [hexToBytes32(payloadHash, 'payloadHash'), hexToBytes32(metadataHash, 'metadataHash')],
        witnesses: buildAttestationVaultWitnesses({ attestationSecret })
    };
}

/**
 * Prepare a `registerDocument(mode, document_id, owner_id)` call.
 * Modes 0-2 registrar-only: `mode` 0 (default) assigns or re-assigns the id
 * to an attester id so only that attester may bind or re-bind it (first-bind
 * protection and squatter recovery; another attester's binding is released);
 * 1 unregisters the id (`ownerId` ignored); 2 transfers the registrar role to
 * `ownerId` (`documentId` ignored). Modes 3-4 recovery-only (`documentId`
 * ignored): 3 re-points the registrar to `ownerId`, 4 hands the recovery
 * role to `ownerId`.
 */
export function prepareRegisterDocument({ documentId, ownerId, mode, attestationSecret }) {
    if (!(attestationSecret instanceof Uint8Array)) throw new Error('attestationSecret (Uint8Array) is required');
    const m = BigInt(mode ?? 0);
    if (m < 0n || m > 4n) throw new Error('mode must be 0 (register), 1 (unregister), 2 (transfer registrar), 3 (recovery: set registrar) or 4 (recovery: set recovery)');
    const id = m >= 2n ? ZERO32() : hexToBytes32(documentId, 'documentId');
    const owner = m === 1n ? ZERO32() : hexToBytes32(ownerId, 'ownerId');
    return {
        circuitId: 'registerDocument',
        args: [m, id, owner],
        witnesses: buildAttestationVaultWitnesses({ attestationSecret })
    };
}

/** Alias of prepareRegisterDocument (mode 0) with the former parameter name. */
export function prepareRegisterPassport({ passportId, ownerId, attestationSecret }) {
    return prepareRegisterDocument({ documentId: passportId, ownerId, mode: 0, attestationSecret });
}

/**
 * Prepare a `bindDocument(document_id, payload_hash)` call: the external
 * identifier resolves on-chain to the attestation. One id per payload, one
 * payload per id; a rebind clears the previous pairing on both sides.
 */
export function prepareBindDocument({ documentId, payloadHash, attestationSecret }) {
    if (!(attestationSecret instanceof Uint8Array)) throw new Error('attestationSecret (Uint8Array) is required');
    return {
        circuitId: 'bindDocument',
        args: [hexToBytes32(documentId, 'documentId'), hexToBytes32(payloadHash, 'payloadHash')],
        witnesses: buildAttestationVaultWitnesses({ attestationSecret })
    };
}

/** Alias of prepareBindDocument with the former parameter name. */
export function prepareBindPassport({ passportId, payloadHash, attestationSecret }) {
    return prepareBindDocument({ documentId: passportId, payloadHash, attestationSecret });
}

/**
 * Prepare a `retract(mode, key)` call. Mode 0 removes the caller's own
 * payload (attestation, anchor, disclosures, binding; `key` = payload hash).
 * Mode 1 removes an expired claim (`key` = claim key), mode 2 an expired
 * commitment (`key` = commitment ledger key), mode 3 an expired payload mark
 * (`key` = payload tag); anyone may run those three.
 */
export function prepareRetract({ mode, key, attestationSecret }) {
    if (!(attestationSecret instanceof Uint8Array)) throw new Error('attestationSecret (Uint8Array) is required');
    const m = BigInt(mode ?? 0);
    if (m < 0n || m > 3n) throw new Error('mode must be 0 (payload), 1 (expired claim), 2 (expired commitment) or 3 (expired mark)');
    return {
        circuitId: 'retract',
        args: [m, hexToBytes32(key, 'key')],
        witnesses: buildAttestationVaultWitnesses({ attestationSecret })
    };
}

export function prepareRetractAttestation({ payloadHash, attestationSecret }) {
    return prepareRetract({ mode: 0, key: payloadHash, attestationSecret });
}

export function preparePurgeExpired({ kind, key, attestationSecret }) {
    const mode = kind === 'claim' ? 1 : null;
    if (mode === null) throw new Error("kind must be 'claim'");
    return prepareRetract({ mode, key, attestationSecret });
}

/**
 * The ledger key of an attester's record for a payload, as hex:
 * `recordKey(attesterId, payloadHash)` of the compiled artifact
 * (`pureCircuits` of the `@odatano/nightgate/browser/attestation-vault`
 * subpath, or the -32 twin). Public and recomputable by anyone: the proof
 * helpers and the verify functions take it, the owner-gated circuits derive
 * it from the caller's own identity.
 */
export function recordKeyOf({ pureCircuits, attesterId, payloadHash }) {
    if (typeof pureCircuits?.recordKey !== 'function') throw new Error('pureCircuits (the compiled vault artifact\'s pureCircuits) is required');
    const key = pureCircuits.recordKey(hexToBytes32(attesterId, 'attesterId'), hexToBytes32(payloadHash, 'payloadHash'));
    return Array.from(key, b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Prepare an `anchorContentRoot(payload_hash, content_root, schema_id)` call.
 * `contentRoot` is the off-chain Merkle root over the passport's provable
 * fields, `schemaId` the identifier of the ORDERED proofFields list it was
 * built over (the server's `prepareDocumentProof` returns both). Anchoring
 * is insert-once-or-identical per payload: a different root or
 * schema for an already-anchored payload is rejected in-circuit.
 */
export function prepareAnchorContentRoot({ payloadHash, contentRoot, schemaId, attestationSecret }) {
    if (!(attestationSecret instanceof Uint8Array)) throw new Error('attestationSecret (Uint8Array) is required');
    return {
        circuitId: 'anchorContentRoot',
        args: [hexToBytes32(payloadHash, 'payloadHash'), hexToBytes32(contentRoot, 'contentRoot'), hexToBytes32(schemaId, 'schemaId')],
        witnesses: buildAttestationVaultWitnesses({ attestationSecret })
    };
}

/**
 * Prepare a `proveFieldPredicate(record_key, field_key, threshold, op,
 * valid_until)` call, the field-bound predicate proof. `recordKey` names the
 * attester's record of the document (`recordKeyOf`). The witnessed `merkleProof`
 * ({ fieldValue, siblings[4] hex, dirs[4] }) proves `field_key`'s value is in the
 * anchored content root; `op`: 0 = value ≤ threshold, 1 = value ≥ threshold.
 */
export function prepareProveFieldPredicate({ recordKey, fieldKey, threshold, op, validUntil, merkleProof, attestationSecret, slotWidth }) {
    if (!merkleProof || !merkleProof.fieldSalt) throw new Error('merkleProof ({ fieldValue, fieldSalt, siblings, dirs }) is required (v4 salted leaves)');
    const opNum = BigInt(Number(op));
    if (opNum !== 0n && opNum !== 1n) throw new Error('op must be 0 (lessOrEqual) or 1 (greaterOrEqual)');
    return {
        circuitId: 'proveFieldPredicate',
        args: [hexToBytes32(recordKey, 'recordKey'), hexToBytes32(fieldKey, 'fieldKey'), BigInt(threshold), opNum, claimValidUntil(validUntil)],
        witnesses: buildAttestationVaultWitnesses({ attestationSecret, merkleProof, slotWidth }),
        // Raw bundle passthrough for the txbuilder's batch path (one shared
        // witnesses object with a proof holder swaps these per call).
        merkleProof, slotWidth
    };
}

/**
 * Prepare a `proveFieldEquality(record_key, field_key, expected_digest,
 * valid_until)` call: prove the anchored content root carries, at `field_key`, exactly the
 * value whose digest is `expectedDigest` (public statement; authenticity, not
 * confidentiality). `merkleProof` needs only { siblings[4] hex, dirs[4] }.
 */
export function prepareProveFieldEquality({ recordKey, fieldKey, expectedDigest, validUntil, merkleProof, attestationSecret, slotWidth }) {
    if (!merkleProof || !merkleProof.fieldSalt) throw new Error('merkleProof ({ fieldSalt, siblings, dirs }) is required (v4 salted leaves)');
    return {
        circuitId: 'proveFieldEquality',
        args: [hexToBytes32(recordKey, 'recordKey'), hexToBytes32(fieldKey, 'fieldKey'), hexToBytes32(expectedDigest, 'expectedDigest'), claimValidUntil(validUntil)],
        witnesses: buildAttestationVaultWitnesses({ attestationSecret, merkleProof, slotWidth }),
        merkleProof, slotWidth
    };
}

/**
 * Prepare a `proveFieldMembership(record_key, field_key, set_root,
 * valid_until)` call:
 * prove the field's HIDDEN value digest is one of a public allow-list without
 * revealing which. `merkleProof` is the full bundle: { fieldDigest,
 * siblings[4] hex, dirs[4], setProof: { siblings[6] hex, dirs[6] } }; the
 * server's `prepareMembershipSet` (or an equivalent canonical builder:
 * digest, dedupe, sort ascending, pad to 64) yields setRoot + setProof.
 */
export function prepareProveFieldMembership({ recordKey, fieldKey, setRoot, validUntil, merkleProof, attestationSecret, slotWidth }) {
    if (!merkleProof || !merkleProof.fieldDigest || !merkleProof.fieldSalt || !merkleProof.setProof) {
        throw new Error('merkleProof ({ fieldDigest, fieldSalt, siblings, dirs, setProof }) is required (v4 salted leaves)');
    }
    return {
        circuitId: 'proveFieldMembership',
        args: [hexToBytes32(recordKey, 'recordKey'), hexToBytes32(fieldKey, 'fieldKey'), hexToBytes32(setRoot, 'setRoot'), claimValidUntil(validUntil)],
        witnesses: buildAttestationVaultWitnesses({ attestationSecret, merkleProof, slotWidth }),
        merkleProof, slotWidth
    };
}

/**
 * Prepare a cross-root INTEGRITY call: document B differs from
 * document A ONLY in the slots flagged by `allowedMask` (packed width-bit
 * integer, 16 bits default / 32 with `slotWidth: 32`, bit i = slot i may
 * differ; expanded to the circuit's Vector<width, Boolean> arg here). Runs
 * the mode-switched `proveDocumentComparison(a, b, mode=0, allowed_mask, k,
 * valid_until)` circuit (one verifier key serves both cross-root kinds; the deploy's
 * per-tx write cap forbids two). `docPair` is `{ schema, openingA,
 * openingB }` (v4): the SHARED width-entry descriptor list plus both
 * documents' full openings
 * (the server's `prepareDocumentProof` returns them as `schema` and
 * `opening`). The circuit recomputes schema root and both content roots
 * from these. Both documents must be prepared with the SAME ordered
 * proofFields list; `recordKeyA` / `recordKeyB` name the two records
 * (`recordKeyOf`, possibly of different attesters), and (A, B) order is
 * part of the claim key.
 */
export function prepareProveFieldsUnchangedExcept({ recordKeyA, recordKeyB, allowedMask, validUntil, docPair, attestationSecret, slotWidth }) {
    if (!docPair || !docPair.schema || !docPair.openingA || !docPair.openingB) throw new Error('docPair ({ schema, openingA, openingB }) is required');
    // Width of the target artifact (16 default, 32 for attestation-vault-32).
    // JS bitwise operators are exact for bits 0..31, so a Number mask carries
    // widths up to 32.
    const width = slotWidth ?? 16;
    const maxMask = width === 32 ? 0xffffffff : (1 << width) - 1;
    const mask = Number(allowedMask);
    if (!Number.isInteger(mask) || mask < 0 || mask > maxMask) throw new Error(`allowedMask must be an integer in 0..${maxMask}`);
    // Non-vacuity (the circuit rejects this too): at least one REAL
    // (non-padding) schema slot must stay constrained, or the claim says
    // nothing ("everything may differ").
    if (Array.isArray(docPair.schema)
        && docPair.schema.every((s, i) => Number(s?.kind) === 2 || (mask & (1 << i)) !== 0)) {
        throw new Error('allowedMask frees every real (non-padding) schema slot; the claim would be vacuous');
    }
    const maskVector = Array.from({ length: width }, (_, i) => (mask & (1 << i)) !== 0);
    return {
        circuitId: 'proveDocumentComparison',
        args: [hexToBytes32(recordKeyA, 'recordKeyA'), hexToBytes32(recordKeyB, 'recordKeyB'), 0n, maskVector, 1n, claimValidUntil(validUntil)],
        witnesses: buildAttestationVaultWitnesses({ attestationSecret, merkleProof: { docPair }, slotWidth }),
        merkleProof: { docPair }, slotWidth
    };
}

/**
 * Prepare a cross-root DISTINCTNESS call: at least `k` (1..16) of
 * the 16 aligned slots differ, without revealing which or what. Runs the
 * mode-switched `proveDocumentComparison(a, b, mode=1, allowed_mask, k,
 * valid_until)` circuit; the mask arg is a neutral all-false dummy in this mode.
 * `docPair` is `{ schema, openingA, openingB }` (v4), as on the integrity
 * helper. A counted difference is a value or presence change under the
 * shared schema; schema parity is structural (one witnessed descriptor
 * list, proven against both anchors), so both documents must be anchored
 * with the same schemaId.
 */
export function prepareProveFieldsDiffer({ recordKeyA, recordKeyB, k, validUntil, docPair, attestationSecret, slotWidth }) {
    if (!docPair || !docPair.schema || !docPair.openingA || !docPair.openingB) throw new Error('docPair ({ schema, openingA, openingB }) is required');
    const width = slotWidth ?? 16;
    const kNum = Number(k);
    if (!Number.isInteger(kNum) || kNum < 1 || kNum > width) throw new Error(`k must be an integer in 1..${width}`);
    return {
        circuitId: 'proveDocumentComparison',
        args: [hexToBytes32(recordKeyA, 'recordKeyA'), hexToBytes32(recordKeyB, 'recordKeyB'), 1n, Array.from({ length: width }, () => false), BigInt(kNum), claimValidUntil(validUntil)],
        witnesses: buildAttestationVaultWitnesses({ attestationSecret, merkleProof: { docPair }, slotWidth }),
        merkleProof: { docPair }, slotWidth
    };
}
