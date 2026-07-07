/**
 * Crawler-free predicate-result reader (onchain-state-verification-crawlerless FR,
 * proposal #3). The AttestationVault records a proven predicate as a (true) entry
 * in the `predicate_results` ledger Map, keyed by
 *   claimKey = persistentHash<PredicateClaim>{payload_hash, threshold, op}.
 * A consumer that knows (payload_hash, threshold, op) can recompute claimKey
 * off-chain and confirm the proof landed WITHOUT the proof tx being indexed
 * locally — no crawler, no txHash.
 *
 * The claim key recompute uses `@midnight-ntwrk/compact-runtime`'s exported
 * `persistentHash` + CompactType constructors, reproducing the exact bytes the
 * compiled circuit emits (the artifact builds `_descriptor_7` the same way).
 * Validated against a live-emitted key in scripts/spike-state-verification.mjs.
 *
 * Read/decode logic is dependency-injected (`ledger`, `queryContractState`,
 * `computeClaimKey`) so it unit-tests without the ESM-only SDK. The
 * `readPredicateStateForContract` wrapper wires the real runtime + providers.
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
}

export interface ReadPredicateResultDeps {
    contractAddress: string;
    /** 64-hex claim key (already recomputed). */
    claimKey: string;
    /** When true, read `field_predicate_results` (field-bound proof) instead. */
    field?: boolean;
    /** Decoder from the compiled artifact (`ledger`). */
    ledger: (state: any) => PredicateLedger;
    /** publicDataProvider.queryContractState — returns ContractState | null. */
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
    const map = deps.field ? led.field_predicate_results : led.predicate_results;
    const key = hexToBytes(deps.claimKey);
    // A predicate is proven iff the map holds a (true) entry for the claim key.
    return map.member(key) && map.lookup(key) === true;
}

/**
 * Recompute the on-chain `PredicateClaim` claim key off-chain, byte-for-byte
 * identical to the compiled circuit. ESM-only: dynamic-imports compact-runtime.
 * Injectable so the reader unit-tests without the SDK.
 */
export async function computePredicateClaimKey(
    payloadHash: string,
    threshold: bigint,
    op: number
): Promise<string> {
    const rt: any = await import('@midnight-ntwrk/compact-runtime');
    // Mirror _descriptor_7 (PredicateClaim): Bytes<32> ++ Uint<64> ++ Uint<8>.
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
 * Field-bound counterpart: recompute the on-chain `FieldPredicateClaim` key
 * (artifact `_descriptor_6`): Bytes<32> ++ Bytes<32> ++ Uint<64> ++ Uint<8>.
 * Verified byte-exact against a live-emitted key in
 * scripts/spike-state-verification.mjs.
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

export interface ReadPredicateStateForContractArgs {
    contractAddress: string;
    payloadHash: string;
    threshold: bigint;
    op: number;
    /** When set, verify the field-bound proof (`field_predicate_results`). */
    fieldKey?: string;
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
 * bundle, load the artifact's `ledger`, and read the predicate result. When
 * `fieldKey` is set it verifies the field-bound proof against
 * `field_predicate_results`; otherwise the plain `predicate_results`. Dynamic
 * import keeps the ESM-only SDK out of CJS load.
 */
export async function readPredicateStateForContract(
    args: ReadPredicateStateForContractArgs
): Promise<boolean | null> {
    const { buildContractProviders } = await import('../midnight/providers.js');
    const bundle = await buildContractProviders(args.contractProvidersConfig);
    const artifact: any = await import(pathToFileURL(args.artifactPath).href);

    const field = Boolean(args.fieldKey);
    const claimKey = field
        ? await (args.computeFieldClaimKey ?? computeFieldPredicateClaimKey)(
            args.payloadHash, args.fieldKey!, args.threshold, args.op)
        : await (args.computeClaimKey ?? computePredicateClaimKey)(
            args.payloadHash, args.threshold, args.op);

    return readPredicateResult({
        contractAddress: args.contractAddress,
        claimKey,
        field,
        ledger: artifact.ledger,
        queryContractState: (addr: string) => bundle.publicDataProvider.queryContractState(addr)
    });
}
