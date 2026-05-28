# Feature Request: ZK Predicate / Range-Proof Attestation

**Status:** proposed
**Requested by:** NIGHTPASS (Battery Passport / Tractus-X consumer track)
**Date:** 2026-05-28
**Affects:** `contracts/attestation-vault/`, `src/sdk/AttestationService.ts`

---

## Summary

Extend `AttestationVault` from a **commitment + disclosure-grant** model into one that can also **prove a predicate over a hidden numeric value** — e.g. `value ≤ threshold` — without revealing the value and without the verifier needing the cleartext. Surface it through `AttestationService` so a consumer app can request "prove field X satisfies predicate P" and receive a portable proof envelope.

Today `attestation-vault.compact` stores `payload_hash`/`metadata_hash` commitments and manages disclosure grants at `level` 0/1/2 (public / legitimate-interest / authority). It proves **who may see** an attestation; it cannot prove **a fact about** the hidden value. This FR adds that missing capability.

## Why (external driver, with evidence)

A reconnaissance of Eclipse Tractus-X / Catena-X (report: `~/tractusx-recon/REPORT.md`) found:

- Tractus-X has **no** zero-knowledge / predicate / range-proof capability anywhere (verified across 11 repos).
- Its closest primitive — the draft Data Trust & Security KIT's **AAC-SD** (BBS+) — can *reveal* or *hide* an attribute, but a hidden attribute is a hash commitment that "can be verified only if the private data is accessible by the consumer." It cannot prove a fact about a hidden value. **This is structurally identical to the current AttestationVault model.**
- The Battery Pass data model carries **no** disclosure-tier field; tiering is coarse and policy-side (proven in `~/tractusx-recon/poc/02-aas-passport/`).

⇒ NIGHTGATE's differentiated Tractus-X integration is to provide **AAC-SD's missing third disclosure mode** (`zkPredicate`): prove `footprintValue ≤ threshold` in ZK. This FR is the engine; the consumer-side envelope + wiring stays in NIGHTPASS.

The target proof envelope (the `proof` block this must fill) is already drafted: `~/tractusx-recon/poc/03-zk-attestation/proof-envelope.json` + `RFC.md`.

## Proposed change

### 1. Compact circuit (extends `attestation-vault.compact`, `pragma language_version >= 0.20`)

Add a predicate-proving circuit. Sketch (names illustrative):

```compact
// private value + blinding, supplied off-chain like local_secret_key()
witness attested_value(): Uint<64>;     // the hidden numeric (e.g. scaled footprint)
witness value_salt(): Bytes<32>;

// numeric commitment the circuit can BOTH bind and range-check
circuit value_commitment(): Bytes<32> {
  return persistentHash<...>(attested_value(), value_salt());
}

// prove committed value satisfies predicate vs a public threshold
export circuit provePredicate(
  payload_hash: Bytes<32>,
  threshold:    Uint<64>,
  op:           Uint<8>      // 0 = lessOrEqual, 1 = greaterOrEqual
): [] {
  assert(public_attestations.member(disclose(payload_hash)), "no attestation");
  const v = attested_value();
  if (op == 0) { assert(v <= disclose(threshold), "predicate false"); }
  else         { assert(v >= disclose(threshold), "predicate false"); }
  // bind the proof to the on-chain commitment so it can't be swapped
  assert(value_commitment() == /* stored numeric commitment */, "commitment mismatch");
}
```

**Design point — numeric commitment.** The current `payload_hash` is a `blake2b-256` of an arbitrary blob, which the circuit cannot range-check. A predicate proof needs the value committed in a form the circuit can both *bind* and *compare* (e.g. a `persistentHash(value, salt)` stored alongside, or a Pedersen-style commitment). Decide and add the numeric-commitment storage.

### 2. `AttestationService` SDK surface (`src/sdk/AttestationService.ts`)

```ts
issuePredicateAttestation({ value, salt?, predicate, threshold, unit })
  : { commitment, claim: { predicate, threshold, unit }, proof, verificationMethod }

verifyPredicateAttestation({ commitment, claim, proof, verificationKey })
  : boolean
```

Output field names MUST match the PAC envelope so NIGHTPASS drops them in unchanged:
`digestMultibase` (commitment), `claim {predicate, threshold, unit}`, `proof {system, circuit, verificationMethod, proofValue}`.

### 3. Verification-key distribution

NIGHTGATE already depends on `@midnight-ntwrk/midnight-js-node-zk-config-provider` (zk verification keys) and `@midnight-ntwrk/midnight-js-http-client-proof-provider` (proof server) — so the building blocks exist. Decide how an *external* Tractus-X consumer (outside the dataspace, possibly without a Midnight node) obtains and trusts the verification key: issuer `did:web` document entry, a NIGHTGATE verifier endpoint, or a Catena-X trusted-list entry.

## Key design decision to resolve

**On-chain vs off-chain verification.** Midnight normally verifies a circuit proof when the tx hits the ledger. The PAC use case wants an **off-chain, portable proof** a Tractus-X consumer verifies with just the verification key — no Midnight node access. Confirm whether the proof artifact from `midnight-js-contracts` + the proof provider can be verified standalone (with `node-zk-config-provider` keys) or whether verification requires `midnight-js-indexer-public-data-provider` / ledger reads. **This shapes the consumer dependency surface and the whole integration RFC.**

## Acceptance criteria

1. Proof for `value=47.3 (scaled), threshold=50, op=lessOrEqual` **verifies true**.
2. Proof for `value=51, lessOrEqual 50` **fails** to generate/verify.
3. Tampering with `threshold` / `commitment` / `proofValue` **fails** verification.
4. `value` is **not recoverable** from `{commitment, claim, proof}`.
5. Verification uses **only** the published verification key (no cleartext; no Midnight node — or, if node access is required, that is the documented design outcome).
6. Outputs populate `~/tractusx-recon/poc/03-zk-attestation/proof-envelope.json` unchanged in shape.
7. Covered by an integration test (extend `scripts/integration-test-attestation-vault.mjs` / `npm run integration:attestation-vault`) and the Compact build (`managed/` regenerated).

## Phasing

- **Phase 1:** `lessOrEqual`, `greaterOrEqual`, bounded `range` over scaled integers (fixed-point for floats like kg CO₂/kWh).
- **Later:** set membership, equality-to-public-commitment.

## Sequencing note

NIGHTPASS's consumption of this is gated behind NIGHTGATE **T15** (live e2e vs preprod) per NIGHTPASS conventions; this circuit work should slot after T15 is green so it's built against verified plumbing.

## What NIGHTPASS owns (does NOT belong here)

Battery Pass field→predicate mapping (`sustainability.carbonFootprint.footprintValue`), the `PredicateAttestationCredential.jsonld` profile, PAC envelope assembly, DTR `/credential` discovery + EDC dataplane retrieval, consumer-side `verifyPredicateAttestation` call.

## References

- Recon report: `~/tractusx-recon/REPORT.md`
- PAC envelope + RFC: `~/tractusx-recon/poc/03-zk-attestation/{proof-envelope.json,RFC.md}`
- Data-model tiering proof: `~/tractusx-recon/poc/02-aas-passport/FINDINGS.md`
- Existing contract: `contracts/attestation-vault/src/attestation-vault.compact`
- Existing SDK: `src/sdk/AttestationService.ts`
