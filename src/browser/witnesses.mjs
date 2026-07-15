// Browser-safe witness + attester-secret helpers for the wallet-connector path.
//
// This is the BROWSER mirror of `srv/submission/contract-witnesses.ts` (server
// path). Kept as a small self-contained ESM module so the browser bundle never
// reaches into `srv/` (which carries Node-only assumptions). The two MUST stay
// in lockstep on:
//   - the domain-separation label   'nightgate/attestation-vault/v1'
//   - the witness object shape       { local_secret_key, attested_value, value_salt }
// Only @noble/hashes (pure JS) is used; no Node built-ins.
//
// Design: the vault has no contract private state; attester identity = HMAC
// over secret material; the connector cannot expose the seed, so material
// comes from `signData`.

import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha256';

const ATTESTATION_VAULT_LABEL = 'nightgate/attestation-vault/v1';

function hexToBytes32(hex) {
    const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
    if (!/^[0-9a-fA-F]{64}$/.test(clean)) {
        throw new Error('value must be 64 hex chars (32 bytes)');
    }
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
    return out;
}

function hexToBytes(hex) {
    const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
    if (clean.length % 2 !== 0 || /[^0-9a-fA-F]/.test(clean)) {
        throw new Error('invalid hex string');
    }
    const out = new Uint8Array(clean.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
    return out;
}

/**
 * Derive the 32-byte AttestationVault secret from arbitrary key material.
 *
 * SAME primitive as the server's `deriveAttestationSecret(seedBytes)` (same
 * HMAC-SHA256 + domain label), so that, IF the same material is supplied to both
 * paths, the on-chain `attester_id = persistentHash(local_secret_key())`
 * matches. The server feeds the wallet seed; the browser cannot get the seed and
 * feeds connector-derived material instead (see `deriveAttestationSecretFromSignature`).
 * Cross-path identities therefore coincide only when the material is shared.
 */
export function deriveAttestationSecret(material) {
    return hmac(sha256, material, new TextEncoder().encode(ATTESTATION_VAULT_LABEL));
}

/**
 * Browser attester-secret derivation from a DApp-Connector `signData` result.
 *
 * `signature` is the hex `Signature.signature` returned by
 * `connector.signData(FIXED_MESSAGE, { encoding:'text', keyType:'unshielded' })`.
 * Stable across sessions ONLY if the wallet's unshielded signature is
 * deterministic; otherwise derive once and persist the result client-side.
 */
export function deriveAttestationSecretFromSignature(signatureHex) {
    return deriveAttestationSecret(hexToBytes(signatureHex));
}

/**
 * Build the AttestationVault witness object bound to a given attester secret
 * (and optional per-call value/salt for commitValue/provePredicate, and an
 * optional Merkle inclusion proof for proveFieldPredicate).
 *
 * Witness signature matches the generated `Witnesses<PS>`:
 *   local_secret_key(ctx): [PS, Uint8Array]
 *   field_value(ctx):      [PS, bigint]
 *   merkle_siblings(ctx):  [PS, Uint8Array[]]   (DEPTH=4 × Bytes<32>)
 *   merkle_dirs(ctx):      [PS, boolean[]]      (DEPTH=4)
 * `ctx.privateState` is passed through unchanged; the vault has no private state.
 *
 * `merkleProof` (for proveFieldPredicate): { fieldValue, siblings: string[4] hex,
 * dirs: boolean[4] }. Unused witnesses simply are never invoked for other
 * circuits, so a proof-less call (attest/grant/commitValue/…) is unaffected.
 */
const MERKLE_DEPTH = 4;

export function buildAttestationVaultWitnesses({ attestationSecret, witnessValues, merkleProof } = {}) {
    if (!(attestationSecret instanceof Uint8Array) || attestationSecret.length !== 32) {
        throw new Error('attestationSecret must be a 32-byte Uint8Array');
    }
    const value = witnessValues ? BigInt(witnessValues.attestedValue) : undefined;
    const salt = witnessValues ? hexToBytes32(witnessValues.valueSalt) : undefined;

    let fieldValue, siblings, dirs;
    if (merkleProof) {
        fieldValue = BigInt(merkleProof.fieldValue);
        siblings = (merkleProof.siblings || []).map(hexToBytes32);
        dirs = (merkleProof.dirs || []).map(Boolean);
        if (siblings.length !== MERKLE_DEPTH || dirs.length !== MERKLE_DEPTH) {
            throw new Error(`merkleProof.siblings and .dirs must each have ${MERKLE_DEPTH} entries`);
        }
    }

    return {
        local_secret_key(ctx) {
            return [ctx.privateState, attestationSecret];
        },
        attested_value(ctx) {
            if (value === undefined) {
                throw new Error('attested_value witness invoked without a per-call value; commitValue/provePredicate require witnessValues');
            }
            return [ctx.privateState, value];
        },
        value_salt(ctx) {
            if (salt === undefined) {
                throw new Error('value_salt witness invoked without a per-call salt; commitValue/provePredicate require witnessValues');
            }
            return [ctx.privateState, salt];
        },
        field_value(ctx) {
            if (fieldValue === undefined) {
                throw new Error('field_value witness invoked without a merkleProof; proveFieldPredicate requires merkleProof');
            }
            return [ctx.privateState, fieldValue];
        },
        merkle_siblings(ctx) {
            if (siblings === undefined) {
                throw new Error('merkle_siblings witness invoked without a merkleProof; proveFieldPredicate requires merkleProof');
            }
            return [ctx.privateState, siblings];
        },
        merkle_dirs(ctx) {
            if (dirs === undefined) {
                throw new Error('merkle_dirs witness invoked without a merkleProof; proveFieldPredicate requires merkleProof');
            }
            return [ctx.privateState, dirs];
        }
    };
}

/** Fixed message a consumer signs to derive a stable attester secret. */
export const ATTESTER_SECRET_MESSAGE = 'nightgate:attestation-vault:attester-secret:v1';
