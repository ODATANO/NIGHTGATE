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
