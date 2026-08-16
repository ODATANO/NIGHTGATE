/**
 * Crawler-free predicate-result reader. The AttestationVault records a proven
 * claim as a (true) entry in its per-kind result Map, keyed by the
 * persistentHash of the claim struct (e.g. FieldPredicateClaim{payload_hash,
 * field_key, threshold, op, epoch}; EVERY claim kind embeds the payload's
 * CURRENT attestation epoch from `attestation_seqs`, cross-root kinds both
 * documents' epochs). Knowing the public claim coordinates lets a
 * consumer recompute the claim key off-chain and confirm the proof landed
 * without the proof tx being indexed locally (no crawler, no txHash).
 *
 * The recompute uses `@midnight-ntwrk/compact-runtime`'s `persistentHash` +
 * CompactType constructors to reproduce the exact bytes the compiled circuit
 * emits. Validated against a live-emitted key in
 * scripts/integration-test-attestation-vault.mjs.
 *
 * Read/decode logic is dependency-injected (`ledger`, `queryContractState`,
 * `computeClaimKey`) to unit-test without the ESM-only SDK;
 * `readPredicateStateForContract` wires the real runtime + providers.
 */
import { pathToFileURL } from 'node:url';

function hexToBytes(h: string): Uint8Array {
    const out = new Uint8Array(h.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
    return out;
}

interface ResultMap { member(key: Uint8Array): boolean; lookup(key: Uint8Array): boolean }

/** Minimal shape of the compiled artifact's `ledger(state)` return we rely on. */
export interface PredicateLedger {
    field_predicate_results: ResultMap;
    field_equality_results: ResultMap;
    field_membership_results: ResultMap;
    document_integrity_results: ResultMap;
    document_diff_results: ResultMap;
    /**
     * payload_hash -> attestation epoch (0.16.0). Claim keys embed the epoch
     * at proving time; verifiers MUST recompute with the CURRENT epoch, so
     * claims recorded during a front-runner's ownership window stop
     * verifying after a guarded-attest takeover moved the epoch.
     */
    attestation_seqs: { member(key: Uint8Array): boolean; lookup(key: Uint8Array): bigint };
}

/**
 * Which on-chain result map a claim key lives in. The commitment-only
 * 'plain' kind was removed in 0.16.0 with commitValue/provePredicate.
 */
export type PredicateResultKind = 'field' | 'equality' | 'membership' | 'integrity' | 'diff';

export interface ReadPredicateResultDeps {
    contractAddress: string;
    /** 64-hex claim key (already recomputed). */
    claimKey: string;
    /** Result map selector; defaults to the field-bound numeric map. */
    kind?: PredicateResultKind;
    /** Decoder from the compiled artifact (`ledger`). */
    ledger: (state: any) => PredicateLedger;
    /** publicDataProvider.queryContractState; returns ContractState | null. */
    queryContractState: (contractAddress: string) => Promise<any | null>;
}

/**
 * Check whether a recorded (true) predicate result exists on-chain for
 * `claimKey`. Returns `null` when no contract state is available (unknown
 * contract / no live provider), so callers can keep a clean negative instead of
 * a 5xx.
 */
export async function readPredicateResult(
    deps: ReadPredicateResultDeps
): Promise<boolean | null> {
    const state = await deps.queryContractState(deps.contractAddress.toLowerCase());
    if (!state) return null;

    const led = deps.ledger(state.data ?? state);
    const kind = deps.kind ?? 'field';
    const map = kind === 'equality' ? led.field_equality_results
        : kind === 'membership' ? led.field_membership_results
        : kind === 'integrity' ? led.document_integrity_results
        : kind === 'diff' ? led.document_diff_results
        : led.field_predicate_results;
    const key = hexToBytes(deps.claimKey);
    // A predicate is proven iff the map holds a (true) entry for the claim key.
    return map.member(key) && map.lookup(key) === true;
}

/**
 * Recompute the `FieldPredicateClaim` key
 * (artifact `_descriptor_15` as of 0.16.0): Bytes<32> ++ Bytes<32> ++
 * Uint<64> ++ Uint<8> ++ Uint<64> (payload_hash, field_key, threshold, op,
 * epoch).
 */
export async function computeFieldPredicateClaimKey(
    payloadHash: string,
    fieldKey: string,
    threshold: bigint,
    op: number,
    epoch: bigint
): Promise<string> {
    const rt: any = await import('@midnight-ntwrk/compact-runtime');
    const dBytes32 = new rt.CompactTypeBytes(32);
    const dU64 = new rt.CompactTypeUnsignedInteger(18446744073709551615n, 8);
    const dU8 = new rt.CompactTypeUnsignedInteger(255n, 1);
    const fieldClaimType = {
        alignment() {
            return dBytes32.alignment()
                .concat(dBytes32.alignment().concat(dU64.alignment().concat(dU8.alignment().concat(dU64.alignment()))));
        },
        toValue(v: any) {
            return dBytes32.toValue(v.payload_hash)
                .concat(dBytes32.toValue(v.field_key)
                    .concat(dU64.toValue(v.threshold).concat(dU8.toValue(v.op).concat(dU64.toValue(v.epoch)))));
        }
    };
    const digest: Uint8Array = rt.persistentHash(fieldClaimType, {
        payload_hash: hexToBytes(payloadHash),
        field_key: hexToBytes(fieldKey),
        threshold,
        op: BigInt(op),
        epoch
    });
    return Buffer.from(digest).toString('hex');
}

/**
 * Bytes-equality counterpart: recompute the `FieldEqualityClaim` key,
 * Bytes<32> ++ Bytes<32> ++ Bytes<32> ++ Uint<64> (payload_hash, field_key, expected, epoch).
 */
/**
 * Off-chain recompute of the guarded-attest commitment:
 * persistentHash(AttestCommitPreimage{payload_hash, metadata_hash, nonce}),
 * byte-identical to attestGuarded's in-circuit recompute (parity pinned in
 * scripts/integration-test-attestation-vault.mjs).
 */
export async function computeAttestCommitment(
    payloadHash: string,
    metadataHash: string,
    nonce: string
): Promise<string> {
    const rt: any = await import('@midnight-ntwrk/compact-runtime');
    const dBytes32 = new rt.CompactTypeBytes(32);
    const commitType = {
        alignment() {
            return dBytes32.alignment().concat(dBytes32.alignment().concat(dBytes32.alignment()));
        },
        toValue(v: any) {
            return dBytes32.toValue(v.payload_hash)
                .concat(dBytes32.toValue(v.metadata_hash).concat(dBytes32.toValue(v.nonce)));
        }
    };
    const digest: Uint8Array = rt.persistentHash(commitType, {
        payload_hash: hexToBytes(payloadHash),
        metadata_hash: hexToBytes(metadataHash),
        nonce: hexToBytes(nonce)
    });
    return Buffer.from(digest).toString('hex');
}

export async function computeFieldEqualityClaimKey(
    payloadHash: string,
    fieldKey: string,
    expectedDigest: string,
    epoch: bigint
): Promise<string> {
    const rt: any = await import('@midnight-ntwrk/compact-runtime');
    const dBytes32 = new rt.CompactTypeBytes(32);
    const dU64 = new rt.CompactTypeUnsignedInteger(18446744073709551615n, 8);
    const equalityClaimType = {
        alignment() {
            return dBytes32.alignment().concat(dBytes32.alignment().concat(dBytes32.alignment().concat(dU64.alignment())));
        },
        toValue(v: any) {
            return dBytes32.toValue(v.payload_hash)
                .concat(dBytes32.toValue(v.field_key).concat(dBytes32.toValue(v.expected).concat(dU64.toValue(v.epoch))));
        }
    };
    const digest: Uint8Array = rt.persistentHash(equalityClaimType, {
        payload_hash: hexToBytes(payloadHash),
        field_key: hexToBytes(fieldKey),
        expected: hexToBytes(expectedDigest),
        epoch
    });
    return Buffer.from(digest).toString('hex');
}

/**
 * Set-membership counterpart: recompute the `FieldMembershipClaim` key,
 * Bytes<32> ++ Bytes<32> ++ Bytes<32> ++ Uint<64> (payload_hash, field_key, set_root, epoch).
 */
export async function computeFieldMembershipClaimKey(
    payloadHash: string,
    fieldKey: string,
    setRoot: string,
    epoch: bigint
): Promise<string> {
    const rt: any = await import('@midnight-ntwrk/compact-runtime');
    const dBytes32 = new rt.CompactTypeBytes(32);
    const dU64 = new rt.CompactTypeUnsignedInteger(18446744073709551615n, 8);
    const membershipClaimType = {
        alignment() {
            return dBytes32.alignment().concat(dBytes32.alignment().concat(dBytes32.alignment().concat(dU64.alignment())));
        },
        toValue(v: any) {
            return dBytes32.toValue(v.payload_hash)
                .concat(dBytes32.toValue(v.field_key).concat(dBytes32.toValue(v.set_root).concat(dU64.toValue(v.epoch))));
        }
    };
    const digest: Uint8Array = rt.persistentHash(membershipClaimType, {
        payload_hash: hexToBytes(payloadHash),
        field_key: hexToBytes(fieldKey),
        set_root: hexToBytes(setRoot),
        epoch
    });
    return Buffer.from(digest).toString('hex');
}

/**
 * Expand a packed 16-bit allowed mask (bit i = slot i may differ) into the
 * boolean vector the circuit takes. Exported for the handlers and tests.
 */
export function expandAllowedMask(mask: number): boolean[] {
    if (!Number.isInteger(mask) || mask < 0 || mask > 0xffff) {
        throw new Error('allowedMask must be an integer in 0..65535');
    }
    return Array.from({ length: 16 }, (_, i) => (mask & (1 << i)) !== 0);
}

/**
 * Cross-root integrity counterpart: recompute the `DocumentIntegrityClaim`
 * key (artifact `_descriptor_14` as of 0.16.0), Bytes<32> ++ Bytes<32> ++
 * Vector<16, Boolean> ++ Uint<64> ++ Uint<64> (the allowed mask travels as a
 * boolean vector, Compact has no bitwise ops; epoch_a/epoch_b are both
 * documents' attestation epochs).
 */
export async function computeDocumentIntegrityClaimKey(
    payloadHashA: string,
    payloadHashB: string,
    allowedMask: number,
    epochA: bigint,
    epochB: bigint
): Promise<string> {
    const rt: any = await import('@midnight-ntwrk/compact-runtime');
    const dBytes32 = new rt.CompactTypeBytes(32);
    const dU64 = new rt.CompactTypeUnsignedInteger(18446744073709551615n, 8);
    const dMask = new rt.CompactTypeVector(16, rt.CompactTypeBoolean);
    const integrityClaimType = {
        alignment() {
            return dBytes32.alignment().concat(dBytes32.alignment().concat(dMask.alignment().concat(dU64.alignment().concat(dU64.alignment()))));
        },
        toValue(v: any) {
            return dBytes32.toValue(v.payload_hash_a)
                .concat(dBytes32.toValue(v.payload_hash_b).concat(dMask.toValue(v.allowed_mask).concat(dU64.toValue(v.epoch_a).concat(dU64.toValue(v.epoch_b)))));
        }
    };
    const digest: Uint8Array = rt.persistentHash(integrityClaimType, {
        payload_hash_a: hexToBytes(payloadHashA),
        payload_hash_b: hexToBytes(payloadHashB),
        allowed_mask: expandAllowedMask(allowedMask),
        epoch_a: epochA,
        epoch_b: epochB
    });
    return Buffer.from(digest).toString('hex');
}

/**
 * Cross-root distinctness counterpart: recompute the `DocumentDiffClaim`
 * key (artifact `_descriptor_12` as of 0.16.0), Bytes<32> ++ Bytes<32> ++
 * Uint<8> ++ Uint<64> ++ Uint<64> (k, epoch_a, epoch_b).
 */
export async function computeDocumentDiffClaimKey(
    payloadHashA: string,
    payloadHashB: string,
    k: number,
    epochA: bigint,
    epochB: bigint
): Promise<string> {
    const rt: any = await import('@midnight-ntwrk/compact-runtime');
    const dBytes32 = new rt.CompactTypeBytes(32);
    const dU8 = new rt.CompactTypeUnsignedInteger(255n, 1);
    const dU64 = new rt.CompactTypeUnsignedInteger(18446744073709551615n, 8);
    const diffClaimType = {
        alignment() {
            return dBytes32.alignment().concat(dBytes32.alignment().concat(dU8.alignment().concat(dU64.alignment().concat(dU64.alignment()))));
        },
        toValue(v: any) {
            return dBytes32.toValue(v.payload_hash_a)
                .concat(dBytes32.toValue(v.payload_hash_b).concat(dU8.toValue(v.k).concat(dU64.toValue(v.epoch_a).concat(dU64.toValue(v.epoch_b)))));
        }
    };
    const digest: Uint8Array = rt.persistentHash(diffClaimType, {
        payload_hash_a: hexToBytes(payloadHashA),
        payload_hash_b: hexToBytes(payloadHashB),
        k: BigInt(k),
        epoch_a: epochA,
        epoch_b: epochB
    });
    return Buffer.from(digest).toString('hex');
}

export interface ReadPredicateStateForContractArgs {
    contractAddress: string;
    payloadHash: string;
    /** Required for the numeric predicates; ignored for the bytes kinds. */
    threshold?: bigint;
    op?: number;
    /** The bound field. Required for the numeric and bytes kinds. */
    fieldKey?: string;
    /** Bytes-equality claim: verify against `field_equality_results`. */
    expectedDigest?: string;
    /** Set-membership claim: verify against `field_membership_results`. */
    setRoot?: string;
    /** Cross-root claims: the second document's payload hash. */
    payloadHashB?: string;
    /** Document-integrity claim: packed 16-bit allowed mask (with payloadHashB). */
    allowedMask?: number;
    /** Document-diff claim: minimum differing slot count (with payloadHashB). */
    k?: number;
    /** Path to the compiled contract artifact (`.../contract/index.js`). */
    artifactPath: string;
    /** Config for the contract-only provider bundle (no wallet needed to read). */
    contractProvidersConfig: import('../midnight/providers').ContractProvidersConfig;
    /** Injectable field claim-key recompute (defaults to the real one). */
    computeFieldClaimKey?: typeof computeFieldPredicateClaimKey;
}

/**
 * Production wrapper: recompute the claim key, build a contract-only provider
 * bundle, load the artifact's `ledger`, and read the predicate result.
 * Dynamic import keeps the ESM-only SDK out of CJS load.
 */
export async function readPredicateStateForContract(
    args: ReadPredicateStateForContractArgs
): Promise<boolean | null> {
    const { buildContractProviders } = await import('../midnight/providers.js');
    const bundle = await buildContractProviders(args.contractProvidersConfig);
    const artifact: any = await import(pathToFileURL(args.artifactPath).href);

    // Query the state FIRST: claim keys embed the payload's CURRENT
    // attestation epoch (0.16.0), so the recompute needs the live ledger. A
    // payload without an epoch cannot carry a verifiable claim (clean
    // negative); a stale-epoch claim (recorded during a front-runner's
    // ownership window, then reclaimed via guarded attest) misses the map by
    // construction.
    const state = await bundle.publicDataProvider.queryContractState(args.contractAddress.toLowerCase());
    if (!state) return null;
    const led = artifact.ledger(state.data ?? state) as PredicateLedger;

    const epochOf = (payloadHex: string): bigint | null => {
        const key = hexToBytes(payloadHex);
        return led.attestation_seqs.member(key) ? led.attestation_seqs.lookup(key) : null;
    };
    const epochA = epochOf(args.payloadHash);
    if (epochA === null) return false;

    const kind: PredicateResultKind = args.payloadHashB
        ? (args.allowedMask !== undefined ? 'integrity' : 'diff')
        : args.expectedDigest ? 'equality'
        : args.setRoot ? 'membership'
        : 'field';
    let claimKey: string;
    if (kind === 'integrity' || kind === 'diff') {
        const epochB = epochOf(args.payloadHashB!);
        if (epochB === null) return false;
        if (kind === 'integrity') {
            claimKey = await computeDocumentIntegrityClaimKey(args.payloadHash, args.payloadHashB!, args.allowedMask!, epochA, epochB);
        } else {
            if (args.k === undefined) throw new Error('k is required for a document-diff claim');
            claimKey = await computeDocumentDiffClaimKey(args.payloadHash, args.payloadHashB!, args.k, epochA, epochB);
        }
    } else if (kind === 'equality') {
        if (!args.fieldKey) throw new Error('fieldKey is required for a bytes-equality claim');
        claimKey = await computeFieldEqualityClaimKey(args.payloadHash, args.fieldKey, args.expectedDigest!, epochA);
    } else if (kind === 'membership') {
        if (!args.fieldKey) throw new Error('fieldKey is required for a set-membership claim');
        claimKey = await computeFieldMembershipClaimKey(args.payloadHash, args.fieldKey, args.setRoot!, epochA);
    } else {
        if (args.threshold === undefined || args.op === undefined) {
            throw new Error('threshold and op are required for a numeric predicate claim');
        }
        if (!args.fieldKey) throw new Error('fieldKey is required for a numeric predicate claim');
        claimKey = await (args.computeFieldClaimKey ?? computeFieldPredicateClaimKey)(
            args.payloadHash, args.fieldKey, args.threshold, args.op, epochA);
    }

    return readPredicateResult({
        contractAddress: args.contractAddress,
        claimKey,
        kind,
        ledger: artifact.ledger,
        queryContractState: async () => state
    });
}
