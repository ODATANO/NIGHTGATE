/**
 * Per-contract witness factories.
 *
 * The Compact compiler emits a `Witnesses<PS>` type per contract: off-chain
 * functions the SDK invokes during circuit execution. Each registered contract
 * gets either a real witness object built from the caller's wallet session, or
 * vacant witnesses (only valid for contracts that declare none).
 *
 * The factory receives a primitive snapshot (just the bits the witness needs) so
 * we don't smuggle SDK-shaped objects across the worker boundary or test seams.
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
    /**
     * Per-CALL proof bundle for the field-bound proof circuits. Absent for
     * every other circuit. Serialized as primitives so it survives the
     * worker-thread boundary:
     *   - `fieldValue`: decimal string of the Uint<64> field value
     *     (`proveFieldPredicate` only).
     *   - `fieldDigest`: 64-char hex digest of the field's value bytes
     *     (`proveFieldMembership` only; `proveFieldEquality` needs neither,
     *     its expected digest is a public circuit arg).
     *   - `siblings`: 4 × 64-char hex (the DEPTH=4 content-root path).
     *   - `dirs`: 4 booleans (true = current node is the LEFT child at that level).
     *   - `setProof`: DEPTH=6 membership-set path (`proveFieldMembership` only),
     *     6 × 64-char hex siblings + 6 booleans.
     */
    merkleProof?: MerkleProofBundle;
    /**
     * Batch mode: a mutable holder whose `current` proof the batch loop swaps
     * immediately before each call (wallet-worker builds `before` hooks for
     * batch-call-scope.ts). Resolved at witness INVOCATION time, so ONE
     * compiled contract instance serves N proof calls with N different
     * bundles inside one transaction scope. Mutually exclusive with
     * `merkleProof`. Same primitive serialization rules.
     */
    merkleProofHolder?: {
        current?: MerkleProofBundle;
    };
}

export interface MerkleProofBundle {
    fieldValue?:  string;
    fieldDigest?: string;
    siblings:     string[];
    dirs:         boolean[];
    setProof?:    { siblings: string[]; dirs: boolean[] };
}

const MERKLE_DEPTH = 4;
const SET_DEPTH = 6;

interface DecodedMerkleProof {
    fieldValue?:  bigint;
    fieldDigest?: Uint8Array;
    siblings:     Uint8Array[];
    dirs:         boolean[];
    setSiblings?: Uint8Array[];
    setDirs?:     boolean[];
}

function decodeMerkleProof(proof: MerkleProofBundle): DecodedMerkleProof {
    const fieldValue = proof.fieldValue !== undefined ? BigInt(proof.fieldValue) : undefined;
    const fieldDigest = proof.fieldDigest !== undefined ? hexToBytes32(proof.fieldDigest) : undefined;
    const siblings = (proof.siblings || []).map(hexToBytes32);
    const dirs = (proof.dirs || []).map(Boolean);
    if (siblings.length !== MERKLE_DEPTH || dirs.length !== MERKLE_DEPTH) {
        throw new Error(`merkleProof.siblings and .dirs must each have ${MERKLE_DEPTH} entries`);
    }
    let setSiblings: Uint8Array[] | undefined;
    let setDirs: boolean[] | undefined;
    if (proof.setProof) {
        setSiblings = (proof.setProof.siblings || []).map(hexToBytes32);
        setDirs = (proof.setProof.dirs || []).map(Boolean);
        if (setSiblings.length !== SET_DEPTH || setDirs.length !== SET_DEPTH) {
            throw new Error(`merkleProof.setProof.siblings and .dirs must each have ${SET_DEPTH} entries`);
        }
    }
    return { fieldValue, fieldDigest, siblings, dirs, setSiblings, setDirs };
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
 * Derives the per-session AttestationVault secret (32 raw bytes) from the wallet
 * seed, fed directly to the `local_secret_key()` witness. Domain-separated by a
 * v1 label so future contracts can derive their own without colliding.
 */
export function deriveAttestationSecret(seedBytes: Uint8Array): Uint8Array {
    return hmac(sha256, seedBytes, new TextEncoder().encode('nightgate/attestation-vault/v1'));
}

/**
 * Builds the AttestationVault witness object.
 *
 * `local_secret_key()` returns the same 32-byte secret on every call for a given
 * session; that determinism is what the circuit's
 * `persistentHash(local_secret_key())` relies on for a stable `attester_id`.
 * `ctx.privateState` passes through unchanged (this witness reads, never mutates).
 */
export function buildAttestationVaultWitnesses(input: WitnessFactoryInput): any {
    const secret = input.attestationSecret;
    // Decode the per-call predicate witnesses up-front (if present) so a
    // malformed salt fails fast rather than mid-proof. `attested_value` /
    // `value_salt` are only invoked by commitValue/provePredicate; for other
    // circuits they stay unused, so missing values throw only if actually hit.
    const value = input.witnessValues ? BigInt(input.witnessValues.attestedValue) : undefined;
    const salt  = input.witnessValues ? hexToBytes32(input.witnessValues.valueSalt) : undefined;
    // Per-call Merkle proof for proveFieldPredicate (only that circuit invokes
    // field_value/merkle_siblings/merkle_dirs; others leave them unused).
    // Static mode decodes up-front (fail fast); holder mode re-resolves at
    // every witness invocation so the batch loop can swap `holder.current`
    // between calls of one transaction scope.
    if (input.merkleProof && input.merkleProofHolder) {
        throw new Error('merkleProof and merkleProofHolder are mutually exclusive');
    }
    const staticProof = input.merkleProof ? decodeMerkleProof(input.merkleProof) : undefined;
    const holder = input.merkleProofHolder;
    const currentProof = (witnessName: string): DecodedMerkleProof => {
        if (holder) {
            if (!holder.current) {
                throw new Error(`${witnessName} witness invoked with an empty batch proof holder; set holder.current before the call`);
            }
            return decodeMerkleProof(holder.current);
        }
        if (staticProof === undefined) {
            throw new Error(`${witnessName} witness invoked without a merkleProof; the field-bound proof circuits require a proof bundle`);
        }
        return staticProof;
    };
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
        },
        field_value(ctx: { privateState: unknown }): [unknown, bigint] {
            const p = currentProof('field_value');
            if (p.fieldValue === undefined) {
                throw new Error('field_value witness invoked without a fieldValue; proveFieldPredicate requires a numeric proof bundle');
            }
            return [ctx.privateState, p.fieldValue];
        },
        merkle_siblings(ctx: { privateState: unknown }): [unknown, Uint8Array[]] {
            return [ctx.privateState, currentProof('merkle_siblings').siblings];
        },
        merkle_dirs(ctx: { privateState: unknown }): [unknown, boolean[]] {
            return [ctx.privateState, currentProof('merkle_dirs').dirs];
        },
        field_digest(ctx: { privateState: unknown }): [unknown, Uint8Array] {
            const p = currentProof('field_digest');
            if (p.fieldDigest === undefined) {
                throw new Error('field_digest witness invoked without a fieldDigest; proveFieldMembership requires a bytes proof bundle');
            }
            return [ctx.privateState, p.fieldDigest];
        },
        set_siblings(ctx: { privateState: unknown }): [unknown, Uint8Array[]] {
            const p = currentProof('set_siblings');
            if (p.setSiblings === undefined) {
                throw new Error('set_siblings witness invoked without a setProof; proveFieldMembership requires the membership-set path');
            }
            return [ctx.privateState, p.setSiblings];
        },
        set_dirs(ctx: { privateState: unknown }): [unknown, boolean[]] {
            const p = currentProof('set_dirs');
            if (p.setDirs === undefined) {
                throw new Error('set_dirs witness invoked without a setProof; proveFieldMembership requires the membership-set path');
            }
            return [ctx.privateState, p.setDirs];
        }
    };
}

export type WitnessFactory = (input: WitnessFactoryInput) => any;

/**
 * Registry of contract-name → witness-builder. Contracts not in this map
 * fall back to `withVacantWitnesses` (i.e. the Compact source declared no
 * witnesses; only valid for those). Counter is one such case.
 */
const FACTORIES: Record<string, WitnessFactory> = {
    'attestation-vault': buildAttestationVaultWitnesses
};

export function getContractWitnessFactory(contractName: string): WitnessFactory | undefined {
    return FACTORIES[contractName];
}
