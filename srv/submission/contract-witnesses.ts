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
    return {
        local_secret_key(ctx: { privateState: unknown }): [unknown, Uint8Array] {
            return [ctx.privateState, secret];
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
