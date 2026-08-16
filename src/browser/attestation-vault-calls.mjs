// Typed call-input helpers for the AttestationVault contract (browser path).
//
// These prepare the inputs a contract call needs (circuit id, the Uint8Array
// arguments, and the witness object) so a consumer can pass them straight to
// midnight-js's findDeployedContract() .callTx.<circuit>(...) (with the
// witnesses bound) or createUnprovenCallTx.
//
// Only the OWNER-GATED circuits (attest, grant/revokeDisclosure,
// registerPassport, bindPassport, anchorContentRoot) require the
// attestationSecret; the proof circuits never invoke local_secret_key, so a
// HOLDER proves against an anchored root without ever receiving the owner
// secret (privilege separation).
//
// The hex↔bytes conversion and witness assembly are pure and verifiable here;
// the actual SDK call + prove + balance + submit is the live-integration step
// (see providers.mjs scope note).

import { buildAttestationVaultWitnesses } from './witnesses.mjs';

function hexTo32(hex, label) {
    const clean = String(hex || '').replace(/^0x/, '');
    if (!/^[0-9a-fA-F]{64}$/.test(clean)) throw new Error(`${label} must be 32-byte hex (64 chars)`);
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
    return out;
}

/**
 * Prepare a `revokeDisclosure(payload_hash, grantee)` call.
 * @returns {{ circuitId: string, args: Uint8Array[], witnesses: object }}
 */
export function prepareRevokeDisclosure({ payloadHash, grantee, attestationSecret }) {
    if (!(attestationSecret instanceof Uint8Array)) throw new Error('attestationSecret (Uint8Array) is required');
    return {
        circuitId: 'revokeDisclosure',
        args: [hexTo32(payloadHash, 'payloadHash'), hexTo32(grantee, 'grantee')],
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
        args: [hexTo32(payloadHash, 'payloadHash'), hexTo32(grantee, 'grantee'), lvl],
        witnesses: buildAttestationVaultWitnesses({ attestationSecret })
    };
}

/**
 * Prepare an `attest(payload_hash, metadata_hash)` call.
 */
export function prepareAttest({ payloadHash, metadataHash, attestationSecret }) {
    if (!(attestationSecret instanceof Uint8Array)) throw new Error('attestationSecret (Uint8Array) is required');
    return {
        circuitId: 'attest',
        args: [hexTo32(payloadHash, 'payloadHash'), hexTo32(metadataHash, 'metadataHash')],
        witnesses: buildAttestationVaultWitnesses({ attestationSecret })
    };
}

/**
 * Prepare a `registerPassport(passportId, owner_id)` call. Registrar-only
 * (the vault's deployer identity): pre-assigns the passportId to an attester
 * id so only that attester may bind or re-bind it (first-bind-squatting
 * protection and squatter recovery).
 */
export function prepareRegisterPassport({ passportId, ownerId, attestationSecret }) {
    if (!(attestationSecret instanceof Uint8Array)) throw new Error('attestationSecret (Uint8Array) is required');
    return {
        circuitId: 'registerPassport',
        args: [hexTo32(passportId, 'passportId'), hexTo32(ownerId, 'ownerId')],
        witnesses: buildAttestationVaultWitnesses({ attestationSecret })
    };
}

/**
 * Prepare a `bindPassport(passportId, payload_hash)` call (QR resolution binding).
 */
export function prepareBindPassport({ passportId, payloadHash, attestationSecret }) {
    if (!(attestationSecret instanceof Uint8Array)) throw new Error('attestationSecret (Uint8Array) is required');
    return {
        circuitId: 'bindPassport',
        args: [hexTo32(passportId, 'passportId'), hexTo32(payloadHash, 'payloadHash')],
        witnesses: buildAttestationVaultWitnesses({ attestationSecret })
    };
}

/**
 * Prepare an `attestGuarded(mode=0, commitment, zero, zero)` COMMIT call
 * (commit-reveal attest, 0.16.0). `commitment` is
 * persistentHash(AttestCommitPreimage{payloadHash, metadataHash, nonce}); the
 * server's `prepareAnchorCommitment` computes it (or any byte-identical
 * recompute). Keep the nonce secret until reveal.
 */
export function prepareAttestCommit({ commitment, attestationSecret }) {
    if (!(attestationSecret instanceof Uint8Array)) throw new Error('attestationSecret (Uint8Array) is required');
    return {
        circuitId: 'attestGuarded',
        args: [0n, hexTo32(commitment, 'commitment'), new Uint8Array(32), new Uint8Array(32)],
        witnesses: buildAttestationVaultWitnesses({ attestationSecret })
    };
}

/**
 * Prepare an `attestGuarded(mode=1, payload_hash, metadata_hash, nonce)`
 * REVEAL call. Requires a finalized commit by the SAME attester; a plain
 * attest that front-ran the reveal is taken over in-circuit when its
 * sequence number is newer than the commitment's.
 */
export function prepareAttestReveal({ payloadHash, metadataHash, nonce, attestationSecret }) {
    if (!(attestationSecret instanceof Uint8Array)) throw new Error('attestationSecret (Uint8Array) is required');
    return {
        circuitId: 'attestGuarded',
        args: [1n, hexTo32(payloadHash, 'payloadHash'), hexTo32(metadataHash, 'metadataHash'), hexTo32(nonce, 'nonce')],
        witnesses: buildAttestationVaultWitnesses({ attestationSecret })
    };
}

/**
 * Prepare an `anchorContentRoot(payload_hash, content_root, schema_id)` call.
 * `contentRoot` is the off-chain Merkle root over the passport's provable
 * fields, `schemaId` the identifier of the ORDERED proofFields list it was
 * built over (the server's `prepareDocumentProof` returns both). Anchoring
 * is insert-once-or-identical per payload (0.16.0): a different root or
 * schema for an already-anchored payload is rejected in-circuit.
 */
export function prepareAnchorContentRoot({ payloadHash, contentRoot, schemaId, attestationSecret }) {
    if (!(attestationSecret instanceof Uint8Array)) throw new Error('attestationSecret (Uint8Array) is required');
    return {
        circuitId: 'anchorContentRoot',
        args: [hexTo32(payloadHash, 'payloadHash'), hexTo32(contentRoot, 'contentRoot'), hexTo32(schemaId, 'schemaId')],
        witnesses: buildAttestationVaultWitnesses({ attestationSecret })
    };
}

/**
 * Prepare a `proveFieldPredicate(payload_hash, field_key, threshold, op)` call,
 * the field-bound predicate proof. The witnessed `merkleProof`
 * ({ fieldValue, siblings[4] hex, dirs[4] }) proves `field_key`'s value is in the
 * anchored content root; `op`: 0 = value ≤ threshold, 1 = value ≥ threshold.
 */
export function prepareProveFieldPredicate({ payloadHash, fieldKey, threshold, op, merkleProof, attestationSecret }) {
    if (!merkleProof || !merkleProof.fieldSalt) throw new Error('merkleProof ({ fieldValue, fieldSalt, siblings, dirs }) is required (v4 salted leaves)');
    const opNum = BigInt(Number(op));
    if (opNum !== 0n && opNum !== 1n) throw new Error('op must be 0 (lessOrEqual) or 1 (greaterOrEqual)');
    return {
        circuitId: 'proveFieldPredicate',
        args: [hexTo32(payloadHash, 'payloadHash'), hexTo32(fieldKey, 'fieldKey'), BigInt(threshold), opNum],
        witnesses: buildAttestationVaultWitnesses({ attestationSecret, merkleProof })
    };
}

/**
 * Prepare a `proveFieldEquality(payload_hash, field_key, expected_digest)`
 * call: prove the anchored content root carries, at `field_key`, exactly the
 * value whose digest is `expectedDigest` (public statement; authenticity, not
 * confidentiality). `merkleProof` needs only { siblings[4] hex, dirs[4] }.
 */
export function prepareProveFieldEquality({ payloadHash, fieldKey, expectedDigest, merkleProof, attestationSecret }) {
    if (!merkleProof || !merkleProof.fieldSalt) throw new Error('merkleProof ({ fieldSalt, siblings, dirs }) is required (v4 salted leaves)');
    return {
        circuitId: 'proveFieldEquality',
        args: [hexTo32(payloadHash, 'payloadHash'), hexTo32(fieldKey, 'fieldKey'), hexTo32(expectedDigest, 'expectedDigest')],
        witnesses: buildAttestationVaultWitnesses({ attestationSecret, merkleProof })
    };
}

/**
 * Prepare a `proveFieldMembership(payload_hash, field_key, set_root)` call:
 * prove the field's HIDDEN value digest is one of a public allow-list without
 * revealing which. `merkleProof` is the full bundle: { fieldDigest,
 * siblings[4] hex, dirs[4], setProof: { siblings[6] hex, dirs[6] } }; the
 * server's `prepareMembershipSet` (or an equivalent canonical builder:
 * digest, dedupe, sort ascending, pad to 64) yields setRoot + setProof.
 */
export function prepareProveFieldMembership({ payloadHash, fieldKey, setRoot, merkleProof, attestationSecret }) {
    if (!merkleProof || !merkleProof.fieldDigest || !merkleProof.fieldSalt || !merkleProof.setProof) {
        throw new Error('merkleProof ({ fieldDigest, fieldSalt, siblings, dirs, setProof }) is required (v4 salted leaves)');
    }
    return {
        circuitId: 'proveFieldMembership',
        args: [hexTo32(payloadHash, 'payloadHash'), hexTo32(fieldKey, 'fieldKey'), hexTo32(setRoot, 'setRoot')],
        witnesses: buildAttestationVaultWitnesses({ attestationSecret, merkleProof })
    };
}

/**
 * Prepare a cross-root INTEGRITY call (0.16.0): document B differs from
 * document A ONLY in the slots flagged by `allowedMask` (packed 16-bit
 * integer, bit i = slot i may differ; expanded to the circuit's
 * Vector<16, Boolean> arg here). Runs the mode-switched
 * `proveDocumentComparison(a, b, mode=0, allowed_mask, k)` circuit (one
 * verifier key serves both cross-root kinds; the deploy's per-tx write cap
 * forbids two). `docPair` is `{ schema, openingA, openingB }` (v4): the
 * SHARED 16-entry descriptor list plus both documents' full openings
 * (the server's `prepareDocumentProof` returns them as `schema` and
 * `opening`). The circuit recomputes schema root and both content roots
 * from these. Both documents must be prepared with the SAME ordered
 * proofFields list; (A, B) order is part of the claim key.
 */
export function prepareProveFieldsUnchangedExcept({ payloadHashA, payloadHashB, allowedMask, docPair, attestationSecret }) {
    if (!docPair || !docPair.schema || !docPair.openingA || !docPair.openingB) throw new Error('docPair ({ schema, openingA, openingB }) is required');
    const mask = Number(allowedMask);
    if (!Number.isInteger(mask) || mask < 0 || mask > 0xffff) throw new Error('allowedMask must be an integer in 0..65535');
    // Non-vacuity (the circuit rejects this too): at least one REAL
    // (non-padding) schema slot must stay constrained, or the claim says
    // nothing ("everything may differ").
    if (Array.isArray(docPair.schema)
        && docPair.schema.every((s, i) => Number(s?.kind) === 2 || (mask & (1 << i)) !== 0)) {
        throw new Error('allowedMask frees every real (non-padding) schema slot; the claim would be vacuous');
    }
    const maskVector = Array.from({ length: 16 }, (_, i) => (mask & (1 << i)) !== 0);
    return {
        circuitId: 'proveDocumentComparison',
        args: [hexTo32(payloadHashA, 'payloadHashA'), hexTo32(payloadHashB, 'payloadHashB'), 0n, maskVector, 1n],
        witnesses: buildAttestationVaultWitnesses({ attestationSecret, merkleProof: { docPair } })
    };
}

/**
 * Prepare a cross-root DISTINCTNESS call (0.16.0): at least `k` (1..16) of
 * the 16 aligned slots differ, without revealing which or what. Runs the
 * mode-switched `proveDocumentComparison(a, b, mode=1, allowed_mask, k)`
 * circuit; the mask arg is a neutral all-false dummy in this mode.
 * `docPair` is `{ schema, openingA, openingB }` (v4), as on the integrity
 * helper. A counted difference is a value or presence change under the
 * shared schema; schema parity is structural (one witnessed descriptor
 * list, proven against both anchors), so both documents must be anchored
 * with the same schemaId.
 */
export function prepareProveFieldsDiffer({ payloadHashA, payloadHashB, k, docPair, attestationSecret }) {
    if (!docPair || !docPair.schema || !docPair.openingA || !docPair.openingB) throw new Error('docPair ({ schema, openingA, openingB }) is required');
    const kNum = Number(k);
    if (!Number.isInteger(kNum) || kNum < 1 || kNum > 16) throw new Error('k must be an integer in 1..16');
    return {
        circuitId: 'proveDocumentComparison',
        args: [hexTo32(payloadHashA, 'payloadHashA'), hexTo32(payloadHashB, 'payloadHashB'), 1n, Array.from({ length: 16 }, () => false), BigInt(kNum)],
        witnesses: buildAttestationVaultWitnesses({ attestationSecret, merkleProof: { docPair } })
    };
}
