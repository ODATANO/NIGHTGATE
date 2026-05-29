/**
 * Per-contract witness factories (T10-extended).
 *
 * The Midnight Compact compiler emits a `Witnesses<PS>` type per contract:
 * an object whose keys map to off-chain functions that the SDK invokes during
 * circuit execution. For each registered contract we either supply a real
 * witness object built from the caller's wallet session, or fall back to
 * vacant witnesses (only valid for contracts that declare none).
 *
 * The witness factory receives a primitive snapshot of the FacadeEntry —
 * just the bits the witness needs — so we don't smuggle SDK-shaped objects
 * across the worker boundary or test seams.
 */
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha256';

export interface WitnessFactoryInput {
    /**
     * 32-byte AES-GCM-encryptable secret derived once per wallet session
     * from the seed key. Stable across reconnects for the same viewing key.
     */
    attestationSecret: Uint8Array;
    /**
     * Per-CALL witnesses for the ZK-predicate circuits (`commitValue` /
     * `provePredicate`). Absent for `attest`/`grant`/`revoke`, which don't
     * invoke `attested_value()`/`value_salt()`. Serialized as primitives so it
     * survives the worker-thread boundary:
     *   - `attestedValue`: decimal string of the Uint<64> value being proven.
     *   - `valueSalt`: 64-char hex of the 32-byte commitment opening.
     */
    witnessValues?: {
        attestedValue: string;
        valueSalt:     string;
    };
}

function hexToBytes32(hex: string): Uint8Array {
    const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
    if (!/^[0-9a-fA-F]{64}$/.test(clean)) {
        throw new Error('valueSalt must be 64 hex chars (32 bytes)');
    }
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
    return out;
}

/**
 * Derives the per-session AttestationVault secret from the wallet seed.
 *
 * Output: 32 raw bytes, fed directly to the `local_secret_key()` witness.
 * Domain-separated by a v1 label so future contracts that need their own
 * secret can derive a fresh one without colliding.
 */
export function deriveAttestationSecret(seedBytes: Uint8Array): Uint8Array {
    return hmac(sha256, seedBytes, new TextEncoder().encode('nightgate/attestation-vault/v1'));
}

/**
 * Builds the AttestationVault witness object.
 *
 * `local_secret_key()` returns the same 32-byte secret on every call for a
 * given session — that determinism is what `persistentHash(local_secret_key())`
 * inside the circuit relies on to produce a stable `attester_id`.
 *
 * The witness signature matches the generated `Witnesses<PS>` type:
 *   local_secret_key(ctx): [PS, Uint8Array]
 * We pass `ctx.privateState` through unchanged because this witness reads
 * but does not mutate the private state slot.
 */
export function buildAttestationVaultWitnesses(input: WitnessFactoryInput): any {
    const secret = input.attestationSecret;
    // Decode the per-call predicate witnesses up-front (if present) so a
    // malformed salt fails fast rather than mid-proof. `attested_value` /
    // `value_salt` are only invoked by commitValue/provePredicate; for other
    // circuits they stay unused, so missing values throw only if actually hit.
    const value = input.witnessValues ? BigInt(input.witnessValues.attestedValue) : undefined;
    const salt  = input.witnessValues ? hexToBytes32(input.witnessValues.valueSalt) : undefined;
    return {
        local_secret_key(ctx: { privateState: unknown }): [unknown, Uint8Array] {
            return [ctx.privateState, secret];
        },
        attested_value(ctx: { privateState: unknown }): [unknown, bigint] {
            if (value === undefined) {
                throw new Error('attested_value witness invoked without a per-call value; commitValue/provePredicate require witnessValues');
            }
            return [ctx.privateState, value];
        },
        value_salt(ctx: { privateState: unknown }): [unknown, Uint8Array] {
            if (salt === undefined) {
                throw new Error('value_salt witness invoked without a per-call salt; commitValue/provePredicate require witnessValues');
            }
            return [ctx.privateState, salt];
        }
    };
}

export type WitnessFactory = (input: WitnessFactoryInput) => any;

/**
 * Registry of contract-name → witness-builder. Contracts not in this map
 * fall back to `withVacantWitnesses` (i.e. the Compact source declared no
 * witnesses — only valid for those). Counter is one such case.
 */
const FACTORIES: Record<string, WitnessFactory> = {
    'attestation-vault': buildAttestationVaultWitnesses
};

export function getContractWitnessFactory(contractName: string): WitnessFactory | undefined {
    return FACTORIES[contractName];
}

export function hasContractWitnessFactory(contractName: string): boolean {
    return Object.prototype.hasOwnProperty.call(FACTORIES, contractName);
}
