// Typed call-input helpers for the AttestationVault contract (browser path).
//
// These prepare the inputs a contract call needs — circuit id, the Uint8Array
// arguments, and the witness object (attester secret + optional value/salt) —
// so a consumer can pass them straight to midnight-js's findDeployedContract()
// .callTx.<circuit>(...) (with the witnesses bound) or createUnprovenCallTx.
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
 * Prepare an `anchorContentRoot(payload_hash, content_root)` call. `contentRoot`
 * is the off-chain Merkle root over the passport's provable fields (built with
 * the contract's exported pureCircuits so it matches proveFieldPredicate).
 */
export function prepareAnchorContentRoot({ payloadHash, contentRoot, attestationSecret }) {
    if (!(attestationSecret instanceof Uint8Array)) throw new Error('attestationSecret (Uint8Array) is required');
    return {
        circuitId: 'anchorContentRoot',
        args: [hexTo32(payloadHash, 'payloadHash'), hexTo32(contentRoot, 'contentRoot')],
        witnesses: buildAttestationVaultWitnesses({ attestationSecret })
    };
}

/**
 * Prepare a `proveFieldPredicate(payload_hash, field_key, threshold, op)` call —
 * the field-bound predicate proof. The witnessed `merkleProof`
 * ({ fieldValue, siblings[4] hex, dirs[4] }) proves `field_key`'s value is in the
 * anchored content root; `op`: 0 = value ≤ threshold, 1 = value ≥ threshold.
 */
export function prepareProveFieldPredicate({ payloadHash, fieldKey, threshold, op, merkleProof, attestationSecret }) {
    if (!(attestationSecret instanceof Uint8Array)) throw new Error('attestationSecret (Uint8Array) is required');
    if (!merkleProof) throw new Error('merkleProof ({ fieldValue, siblings, dirs }) is required');
    const opNum = BigInt(Number(op));
    if (opNum !== 0n && opNum !== 1n) throw new Error('op must be 0 (lessOrEqual) or 1 (greaterOrEqual)');
    return {
        circuitId: 'proveFieldPredicate',
        args: [hexTo32(payloadHash, 'payloadHash'), hexTo32(fieldKey, 'fieldKey'), BigInt(threshold), opNum],
        witnesses: buildAttestationVaultWitnesses({ attestationSecret, merkleProof })
    };
}
