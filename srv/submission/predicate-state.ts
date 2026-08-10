/**
 * Crawler-free predicate-result reader. The AttestationVault records a proven
 * predicate as a (true) entry in the `predicate_results` ledger Map, keyed by
 *   claimKey = persistentHash<PredicateClaim>{payload_hash, threshold, op}.
 * Knowing (payload_hash, threshold, op) lets a consumer recompute claimKey
 * off-chain and confirm the proof landed without the proof tx being indexed
 * locally (no crawler, no txHash).
 *
 * The recompute uses `@midnight-ntwrk/compact-runtime`'s `persistentHash` +
 * CompactType constructors to reproduce the exact bytes the compiled circuit
 * emits. Validated against a live-emitted key in
 * scripts/spike-state-verification.mjs.
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
    predicate_results: ResultMap;
    field_predicate_results: ResultMap;
    field_equality_results: ResultMap;
    field_membership_results: ResultMap;
}

/** Which on-chain result map a claim key lives in. */
export type PredicateResultKind = 'plain' | 'field' | 'equality' | 'membership';

export interface ReadPredicateResultDeps {
    contractAddress: string;
    /** 64-hex claim key (already recomputed). */
    claimKey: string;
    /** Result map selector; wins over the legacy `field` flag. */
    kind?: PredicateResultKind;
    /** Legacy: when true, read `field_predicate_results` (field-bound proof). */
    field?: boolean;
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
    const kind = deps.kind ?? (deps.field ? 'field' : 'plain');
    const map = kind === 'field' ? led.field_predicate_results
        : kind === 'equality' ? led.field_equality_results
        : kind === 'membership' ? led.field_membership_results
        : led.predicate_results;
    const key = hexToBytes(deps.claimKey);
    // A predicate is proven iff the map holds a (true) entry for the claim key.
    return map.member(key) && map.lookup(key) === true;
}

/**
 * Recompute the on-chain `PredicateClaim` claim key off-chain, byte-for-byte
 * identical to the compiled circuit. Dynamic-imports the ESM-only compact-runtime.
 */
export async function computePredicateClaimKey(
    payloadHash: string,
    threshold: bigint,
    op: number
): Promise<string> {
    const rt: any = await import('@midnight-ntwrk/compact-runtime');
    // Mirror _descriptor_11 (PredicateClaim, artifact of 0.15.0; indices shift
    // per recompile): Bytes<32> ++ Uint<64> ++ Uint<8>.
    const dBytes32 = new rt.CompactTypeBytes(32);
    const dU64 = new rt.CompactTypeUnsignedInteger(18446744073709551615n, 8);
    const dU8 = new rt.CompactTypeUnsignedInteger(255n, 1);
    const predicateClaimType = {
        alignment() {
            return dBytes32.alignment().concat(dU64.alignment().concat(dU8.alignment()));
        },
        toValue(v: any) {
            return dBytes32.toValue(v.payload_hash)
                .concat(dU64.toValue(v.threshold).concat(dU8.toValue(v.op)));
        }
    };
    const digest: Uint8Array = rt.persistentHash(predicateClaimType, {
        payload_hash: hexToBytes(payloadHash),
        threshold,
        op: BigInt(op)
    });
    return Buffer.from(digest).toString('hex');
}

/**
 * Field-bound counterpart: recompute the `FieldPredicateClaim` key
 * (artifact `_descriptor_9` as of 0.15.0): Bytes<32> ++ Bytes<32> ++
 * Uint<64> ++ Uint<8>.
 */
export async function computeFieldPredicateClaimKey(
    payloadHash: string,
    fieldKey: string,
    threshold: bigint,
    op: number
): Promise<string> {
    const rt: any = await import('@midnight-ntwrk/compact-runtime');
    const dBytes32 = new rt.CompactTypeBytes(32);
    const dU64 = new rt.CompactTypeUnsignedInteger(18446744073709551615n, 8);
    const dU8 = new rt.CompactTypeUnsignedInteger(255n, 1);
    const fieldClaimType = {
        alignment() {
            return dBytes32.alignment()
                .concat(dBytes32.alignment().concat(dU64.alignment().concat(dU8.alignment())));
        },
        toValue(v: any) {
            return dBytes32.toValue(v.payload_hash)
                .concat(dBytes32.toValue(v.field_key)
                    .concat(dU64.toValue(v.threshold).concat(dU8.toValue(v.op))));
        }
    };
    const digest: Uint8Array = rt.persistentHash(fieldClaimType, {
        payload_hash: hexToBytes(payloadHash),
        field_key: hexToBytes(fieldKey),
        threshold,
        op: BigInt(op)
    });
    return Buffer.from(digest).toString('hex');
}

/**
 * Bytes-equality counterpart: recompute the `FieldEqualityClaim` key,
 * Bytes<32> ++ Bytes<32> ++ Bytes<32> (payload_hash, field_key, expected).
 */
export async function computeFieldEqualityClaimKey(
    payloadHash: string,
    fieldKey: string,
    expectedDigest: string
): Promise<string> {
    const rt: any = await import('@midnight-ntwrk/compact-runtime');
    const dBytes32 = new rt.CompactTypeBytes(32);
    const equalityClaimType = {
        alignment() {
            return dBytes32.alignment().concat(dBytes32.alignment().concat(dBytes32.alignment()));
        },
        toValue(v: any) {
            return dBytes32.toValue(v.payload_hash)
                .concat(dBytes32.toValue(v.field_key).concat(dBytes32.toValue(v.expected)));
        }
    };
    const digest: Uint8Array = rt.persistentHash(equalityClaimType, {
        payload_hash: hexToBytes(payloadHash),
        field_key: hexToBytes(fieldKey),
        expected: hexToBytes(expectedDigest)
    });
    return Buffer.from(digest).toString('hex');
}

/**
 * Set-membership counterpart: recompute the `FieldMembershipClaim` key,
 * Bytes<32> ++ Bytes<32> ++ Bytes<32> (payload_hash, field_key, set_root).
 */
export async function computeFieldMembershipClaimKey(
    payloadHash: string,
    fieldKey: string,
    setRoot: string
): Promise<string> {
    const rt: any = await import('@midnight-ntwrk/compact-runtime');
    const dBytes32 = new rt.CompactTypeBytes(32);
    const membershipClaimType = {
        alignment() {
            return dBytes32.alignment().concat(dBytes32.alignment().concat(dBytes32.alignment()));
        },
        toValue(v: any) {
            return dBytes32.toValue(v.payload_hash)
                .concat(dBytes32.toValue(v.field_key).concat(dBytes32.toValue(v.set_root)));
        }
    };
    const digest: Uint8Array = rt.persistentHash(membershipClaimType, {
        payload_hash: hexToBytes(payloadHash),
        field_key: hexToBytes(fieldKey),
        set_root: hexToBytes(setRoot)
    });
    return Buffer.from(digest).toString('hex');
}

export interface ReadPredicateStateForContractArgs {
    contractAddress: string;
    payloadHash: string;
    /** Required for the numeric predicates; ignored for the bytes kinds. */
    threshold?: bigint;
    op?: number;
    /** When set, verify a field-bound proof instead of a plain one. */
    fieldKey?: string;
    /** Bytes-equality claim: verify against `field_equality_results`. */
    expectedDigest?: string;
    /** Set-membership claim: verify against `field_membership_results`. */
    setRoot?: string;
    /** Path to the compiled contract artifact (`.../contract/index.js`). */
    artifactPath: string;
    /** Config for the contract-only provider bundle (no wallet needed to read). */
    contractProvidersConfig: import('../midnight/providers').ContractProvidersConfig;
    /** Injectable plain claim-key recompute (defaults to the real one). */
    computeClaimKey?: typeof computePredicateClaimKey;
    /** Injectable field claim-key recompute (defaults to the real one). */
    computeFieldClaimKey?: typeof computeFieldPredicateClaimKey;
}

/**
 * Production wrapper: recompute the claim key, build a contract-only provider
 * bundle, load the artifact's `ledger`, and read the predicate result. `fieldKey`
 * set → verify against `field_predicate_results`, else `predicate_results`.
 * Dynamic import keeps the ESM-only SDK out of CJS load.
 */
export async function readPredicateStateForContract(
    args: ReadPredicateStateForContractArgs
): Promise<boolean | null> {
    const { buildContractProviders } = await import('../midnight/providers.js');
    const bundle = await buildContractProviders(args.contractProvidersConfig);
    const artifact: any = await import(pathToFileURL(args.artifactPath).href);

    const kind: PredicateResultKind = args.expectedDigest ? 'equality'
        : args.setRoot ? 'membership'
        : args.fieldKey ? 'field'
        : 'plain';
    let claimKey: string;
    if (kind === 'equality') {
        if (!args.fieldKey) throw new Error('fieldKey is required for a bytes-equality claim');
        claimKey = await computeFieldEqualityClaimKey(args.payloadHash, args.fieldKey, args.expectedDigest!);
    } else if (kind === 'membership') {
        if (!args.fieldKey) throw new Error('fieldKey is required for a set-membership claim');
        claimKey = await computeFieldMembershipClaimKey(args.payloadHash, args.fieldKey, args.setRoot!);
    } else {
        if (args.threshold === undefined || args.op === undefined) {
            throw new Error('threshold and op are required for a numeric predicate claim');
        }
        claimKey = kind === 'field'
            ? await (args.computeFieldClaimKey ?? computeFieldPredicateClaimKey)(
                args.payloadHash, args.fieldKey!, args.threshold, args.op)
            : await (args.computeClaimKey ?? computePredicateClaimKey)(
                args.payloadHash, args.threshold, args.op);
    }

    return readPredicateResult({
        contractAddress: args.contractAddress,
        claimKey,
        kind,
        ledger: artifact.ledger,
        queryContractState: (addr: string) => bundle.publicDataProvider.queryContractState(addr)
    });
}
