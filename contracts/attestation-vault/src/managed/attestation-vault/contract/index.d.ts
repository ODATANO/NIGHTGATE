import type * as __compactRuntime from '@midnight-ntwrk/compact-runtime';

export type Witnesses<PS> = {
  local_secret_key(context: __compactRuntime.WitnessContext<Ledger, PS>): [PS, Uint8Array];
  attested_value(context: __compactRuntime.WitnessContext<Ledger, PS>): [PS, bigint];
  value_salt(context: __compactRuntime.WitnessContext<Ledger, PS>): [PS, Uint8Array];
}

export type ImpureCircuits<PS> = {
  attest(context: __compactRuntime.CircuitContext<PS>,
         payload_hash_0: Uint8Array,
         metadata_hash_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
  grantDisclosure(context: __compactRuntime.CircuitContext<PS>,
                  payload_hash_0: Uint8Array,
                  grantee_0: Uint8Array,
                  level_0: bigint): __compactRuntime.CircuitResults<PS, []>;
  revokeDisclosure(context: __compactRuntime.CircuitContext<PS>,
                   payload_hash_0: Uint8Array,
                   grantee_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
  commitValue(context: __compactRuntime.CircuitContext<PS>,
              payload_hash_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
  provePredicate(context: __compactRuntime.CircuitContext<PS>,
                 payload_hash_0: Uint8Array,
                 threshold_0: bigint,
                 op_0: bigint): __compactRuntime.CircuitResults<PS, []>;
}

export type ProvableCircuits<PS> = {
  attest(context: __compactRuntime.CircuitContext<PS>,
         payload_hash_0: Uint8Array,
         metadata_hash_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
  grantDisclosure(context: __compactRuntime.CircuitContext<PS>,
                  payload_hash_0: Uint8Array,
                  grantee_0: Uint8Array,
                  level_0: bigint): __compactRuntime.CircuitResults<PS, []>;
  revokeDisclosure(context: __compactRuntime.CircuitContext<PS>,
                   payload_hash_0: Uint8Array,
                   grantee_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
  commitValue(context: __compactRuntime.CircuitContext<PS>,
              payload_hash_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
  provePredicate(context: __compactRuntime.CircuitContext<PS>,
                 payload_hash_0: Uint8Array,
                 threshold_0: bigint,
                 op_0: bigint): __compactRuntime.CircuitResults<PS, []>;
}

export type PureCircuits = {
}

export type Circuits<PS> = {
  attest(context: __compactRuntime.CircuitContext<PS>,
         payload_hash_0: Uint8Array,
         metadata_hash_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
  grantDisclosure(context: __compactRuntime.CircuitContext<PS>,
                  payload_hash_0: Uint8Array,
                  grantee_0: Uint8Array,
                  level_0: bigint): __compactRuntime.CircuitResults<PS, []>;
  revokeDisclosure(context: __compactRuntime.CircuitContext<PS>,
                   payload_hash_0: Uint8Array,
                   grantee_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
  commitValue(context: __compactRuntime.CircuitContext<PS>,
              payload_hash_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
  provePredicate(context: __compactRuntime.CircuitContext<PS>,
                 payload_hash_0: Uint8Array,
                 threshold_0: bigint,
                 op_0: bigint): __compactRuntime.CircuitResults<PS, []>;
}

export type Ledger = {
  public_attestations: {
    isEmpty(): boolean;
    size(): bigint;
    member(key_0: Uint8Array): boolean;
    lookup(key_0: Uint8Array): Uint8Array;
    [Symbol.iterator](): Iterator<[Uint8Array, Uint8Array]>
  };
  attestation_owners: {
    isEmpty(): boolean;
    size(): bigint;
    member(key_0: Uint8Array): boolean;
    lookup(key_0: Uint8Array): Uint8Array;
    [Symbol.iterator](): Iterator<[Uint8Array, Uint8Array]>
  };
  disclosures: {
    isEmpty(): boolean;
    size(): bigint;
    member(key_0: Uint8Array): boolean;
    lookup(key_0: Uint8Array): {
      isEmpty(): boolean;
      size(): bigint;
      member(key_1: Uint8Array): boolean;
      lookup(key_1: Uint8Array): bigint;
      [Symbol.iterator](): Iterator<[Uint8Array, bigint]>
    }
  };
  value_commitments: {
    isEmpty(): boolean;
    size(): bigint;
    member(key_0: Uint8Array): boolean;
    lookup(key_0: Uint8Array): Uint8Array;
    [Symbol.iterator](): Iterator<[Uint8Array, Uint8Array]>
  };
  predicate_results: {
    isEmpty(): boolean;
    size(): bigint;
    member(key_0: Uint8Array): boolean;
    lookup(key_0: Uint8Array): boolean;
    [Symbol.iterator](): Iterator<[Uint8Array, boolean]>
  };
}

export type ContractReferenceLocations = any;

export declare const contractReferenceLocations : ContractReferenceLocations;

export declare class Contract<PS = any, W extends Witnesses<PS> = Witnesses<PS>> {
  witnesses: W;
  circuits: Circuits<PS>;
  impureCircuits: ImpureCircuits<PS>;
  provableCircuits: ProvableCircuits<PS>;
  constructor(witnesses: W);
  initialState(context: __compactRuntime.ConstructorContext<PS>): __compactRuntime.ConstructorResult<PS>;
}

export declare function ledger(state: __compactRuntime.StateValue | __compactRuntime.ChargedState): Ledger;
export declare const pureCircuits: PureCircuits;
