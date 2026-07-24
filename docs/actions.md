# Actions reference

All OData V4 actions and functions exposed by NIGHTGATE, with signatures, request shapes, response shapes, error codes, and copy-pasteable examples.

OData distinguishes between **actions** (POST, may have side effects) and **functions** (GET, side-effect-free). NIGHTGATE follows this: write operations are actions, read-only operations are functions.

**Base path conventions** in examples:
- `http://localhost:4004/api/v1/nightgate/<actionName>` — main service
- `http://localhost:4004/api/v1/indexer/<functionName>()` — indexer service
- `http://localhost:4004/api/v1/analytics/<functionName>()` — analytics service
- `http://localhost:4004/api/v1/admin/<actionName>` — admin service

## Async job model (write actions)

Every action that submits an on-chain transaction is **asynchronous**: it returns `{ jobId, status: "pending" }` immediately, then you poll `getJobStatus(jobId, sessionId)` until `succeeded` or `failed`. This keeps multi-minute proof/submit work off the HTTP request. Each write action below documents its **job-result** shape (the parsed `result` on success); read-only **functions** return their result directly.

### `getJobStatus(jobId, sessionId) → { status, chainStatus, result, errorCode, errorMessage, submissionId, txHash, chainFinalizedAt, … }`

`status` (server-side workflow lifecycle): `pending | running | external_execution | submitted | reconciliation_required | succeeded | failed`. On success, `result` is a JSON string of the action's result shape; on failure, `errorCode` + `errorMessage` carry the classified error (see [Error model](#error-model)).

`reconciliation_required` is an explicit **terminal** state: execution was interrupted after an external effect may have occurred. The caller must NOT auto-retry — a fresh attempt needs a new `idempotencyKey`. The single-instance reconciler resolves such jobs automatically from durable chain evidence (a finalized `PendingSubmission` plus a `System.Events` outcome) once it becomes available.

`chainStatus` (`null | pending | success | failure`) is the on-chain execution outcome, **independent of `status`**, populated later from `System.Events`: `status: succeeded` means the submission workflow completed, while `chainStatus: success` confirms the transaction was finalized and executed successfully on-chain. A `chainStatus: failure` on a `succeeded` job means the tx finalized but the contract call reverted. The response also carries `submissionId`, `txHash`, `chainFinalizedAt`, and lease/attempt/timestamp bookkeeping fields.

## Session lifecycle

### `connectWallet(viewingKey) → { sessionId, ID, connectedAt, expiresAt, isActive }`

Open a **read-only** session against a Midnight wallet. Stores the viewing key encrypted at rest via AES-256-GCM. The session is needed for all subsequent wallet operations.

| Field | Type | Constraints |
|---|---|---|
| `viewingKey` | String | 64 hex chars (the encryption public key of the wallet) |

**Rate limit:** 10/min per client IP.

```bash
curl -X POST http://localhost:4004/api/v1/nightgate/connectWallet \
  -H "Content-Type: application/json" \
  -d '{"viewingKey":"a32699a5a29e453f6e92624c2fbefdee173d3f1178e3f9c71bc3edb7d91c1403"}'
```

Response:
```json
{
  "ID": "9d7d5f1e-233b-4f0b-946c-52e5287d3558",
  "sessionId": "c07b1f0a-7251-488d-a64e-1bf69045d7a9",
  "connectedAt": "2026-05-19T05:28:24.722Z",
  "expiresAt": "2026-05-20T05:28:24.722Z",
  "isActive": true
}
```

### `connectWalletForSigning(sessionId, mnemonic, seedHex?, accountIndex?) → { sessionId, signingEnabled, prewarmJobId, prewarmStatus }`

Upgrade a read-only session with **signing capability**, encrypting the BIP39 seed at rest. Keys are HD-derived per Midnight role (zswap / dust / night) to match Lace — see `srv/utils/wallet-hd.ts`. Schedules a tracked pre-warm job that syncs the wallet SDK in the worker; poll `getJobStatus(prewarmJobId, sessionId)` to know when sync-to-tip is done before submitting.

| Field | Type | Constraints |
|---|---|---|
| `sessionId` | UUID | Returned by `connectWallet` |
| `mnemonic` | String | BIP39 recovery phrase (preferred) |
| `seedHex` | String (optional) | Alternative to `mnemonic`: the full 64-byte BIP39 seed as 128 hex chars |
| `accountIndex` | Integer (optional, default 0) | BIP32 account level; pass the SAME value used with `deriveWalletInfo` for this wallet |

**Seed/session consistency check (0.10.1, fail-closed):** the action derives the seed's viewing key at `accountIndex` and rejects with 400 unless it equals the session's viewing key. This guarantees the signer, the session identity, and the on-chain attester id (`caller_id()`) all belong to the same account; previously a non-zero account silently signed with account-0 keys.

**Rate limit:** 10/hour per client IP (default; override via `NIGHTGATE_SIGNING_KEY_RATE_LIMIT`). Shared with `deriveWalletInfo`.

**Errors:** 400 (invalid mnemonic/seed/accountIndex, or seed does not derive the session's viewing key), 404 (no session), 410 (expired), 412 (already signing), 429 (rate-limited).

### `disconnectWallet(sessionId)`

Close a session: nullifies stored encrypted keys, evicts the cached wallet facade in the worker, persists a final state-save blob.

### `deriveWalletInfo(mnemonic | seedHex, accountIndex?) → { viewingKey, shieldedAddress, nightAddress, dustAddress, attesterId, accountIndex, network }`

Derive a wallet's connectable identity from its secret WITHOUT creating a session or persisting anything (the mnemonic/seed is never stored or logged). Removes the last Lace dependency from programmatic wallet creation: generate a BIP39 phrase consumer-side, call this to learn the `viewingKey` (input to `connectWallet`), the `nightAddress` (faucet funding target), the `shieldedAddress` and the `dustAddress` (pass as `dustReceiverAddress` to `registerForDustGeneration`). Derivation is identical to the signing path (per-role HD seeds, Lace-exact), so the derived identity IS the account `connectWalletForSigning` will sign with for the same secret and the same `accountIndex`. `accountIndex` (default 0) selects the BIP32 account level; pass the same value to `connectWalletForSigning` when upgrading the session. **Rate limit:** 10/hour per client IP (shared with `connectWalletForSigning`).

`attesterId` (0.10.1) is the wallet's AttestationVault attester identity, the value the vault circuits compute as `caller_id()`. It is network-independent and matches what `attestation_owners` will store once the wallet attests. Pass it as `registerPassport`'s `ownerId` to pre-register a passportId for a wallet that has never touched the chain (first-bind squatting protection from the very first bind).

## Token operations

### `sendNight(sessionId, receiverAddress, amount, ttlIso?) → { txId, toLedger, amount, receiverAddress }`

Transfer NIGHT to any Midnight address. The destination ledger is auto-detected from the Bech32m prefix:

- `mn_shield-addr_*` → shielded transfer
- `mn_addr_*` → unshielded transfer

Source funds come from the same ledger as the receiver. Use `shieldFunds` / `unshieldFunds` for cross-ledger conversion.

| Field | Type | Notes |
|---|---|---|
| `sessionId` | UUID | Must have signing enabled |
| `receiverAddress` | String | Bech32m, ≥ 50 chars |
| `amount` | String | Decimal NIGHT atoms (parsed as `bigint` server-side; avoids Number precision loss). Sanity-bounded to `10^18`. |
| `ttlIso` | String (optional) | ISO-8601 future timestamp; default = now+10min |

**Rate limit:** 10/min per client IP.

**Errors:**
- 400 — invalid address prefix, malformed amount, TTL in past
- 404 — session not found
- 412 — session not signing-enabled
- 429 — rate-limited
- 500 — `Wallet.InsufficientFunds`, `Wallet.Sync` errors from SDK

```bash
curl -X POST http://localhost:4004/api/v1/nightgate/sendNight \
  -H "Content-Type: application/json" \
  -d '{
    "sessionId": "c07b1f0a-...",
    "receiverAddress": "mn_addr_preprod1xcmxw094zxek0jp0tdc6e294tgrx0qn0l40ugjqhtqy3w5x7dkusuzphxg",
    "amount": "1000000"
  }'
```

### `shieldFunds(sessionId, amount, ttlIso?) → { txId, amount, shieldedReceiverAddress }`

Move the wallet's own NIGHT from unshielded → shielded ledger. Uses the SDK's `initSwap` primitive. Same NIGHT atom amount appears on both sides — it's a ledger-shift, not a value exchange.

### `unshieldFunds(sessionId, amount, ttlIso?) → { txId, amount, unshieldedReceiverAddress }`

Symmetric: shielded → unshielded. **Practical use case**: only unshielded NIGHT can be registered for dust generation. Move shielded NIGHT here first to enable dust accrual.

For both: rate limit 5 per 5 min (heavier ZK work). Same error model as `sendNight`.

### `registerForDustGeneration(sessionId, dustReceiverAddress?) → { txId, registeredCount, totalNightUtxos, dustReceiverAddress }`

Register the wallet's **unregistered unshielded NIGHT UTXOs** for dust generation. Returns a no-op response (`txId: ""`, `registeredCount: 0`) if there are no unregistered UTXOs to process.

| Field | Type | Notes |
|---|---|---|
| `sessionId` | UUID | Must have signing enabled |
| `dustReceiverAddress` | String (optional) | Bech32m DUST address (`mn_dust_*`); default = wallet's own dust address |

Initial DUST accrual takes ~1-2 minutes after the tx finalizes. Refill rate is ~5 tDUST per 100 hours (preprod parameters).

### `deregisterFromDustGeneration(sessionId) → { txId, deregisteredCount, totalNightUtxos }`

Reverse: deregister ALL the wallet's registered NIGHT UTXOs so they become spendable again. Per-UTXO selection is not exposed yet.

## Contract operations

### `deployContract(compiledArtifactRef, sessionId, initialPrivateState, idempotencyKey?, sponsorSessionId?) → { jobId, status }`

Deploy a Compact-compiled contract. The contract must be registered via `cds.requires.nightgate.contracts.<ref>` (or programmatically via `registerContract()`).

**Async** (see [Async job model](#async-job-model-write-actions)): returns `{ jobId, status: "pending" }` immediately; poll `getJobStatus(jobId, sessionId)`. The job result on success is `{ submissionId, txHash, contractAddress, status }` (here `status` is the `PendingSubmissions` lifecycle status — distinct from the job status).

| Field | Type | Notes |
|---|---|---|
| `compiledArtifactRef` | String | Logical name from the registry (e.g. `"counter"`) |
| `sessionId` | UUID | Must have signing enabled |
| `initialPrivateState` | LargeString | JSON-encoded initial state (e.g. `"{}"`) |
| `idempotencyKey` | String (optional) | Dedupes retries against the original job; reusing a key returns the existing `jobId` |

A row is inserted into `PendingSubmissions` BEFORE the SDK is invoked (crash-recovery hook). The result `status` transitions: `pending` → `included` (SDK returned successfully) → `finalized` (crawler indexed the tx).

**Rate limit:** 5/hour per session.

**Errors:**
- 400 — `Wallet.InsufficientFunds` (insufficient dust), `OnChainStatus:FailEntirely`, `MalformedResult`
- 404 — contract not registered
- 503 — retryable transient (network, 1016 on preprod)

### `submitContractCall(contractAddress, circuit, compiledArtifactRef, sessionId, args, idempotencyKey?) → { jobId, status }`

Invoke a circuit on a deployed contract.

**Async**: returns `{ jobId, status: "pending" }` immediately; poll `getJobStatus(jobId, sessionId)`. The job result on success is `{ submissionId, txHash, contractAddress, status }` (the lifecycle status, not the job status).

| Field | Type | Notes |
|---|---|---|
| `contractAddress` | String | From a prior `deployContract` |
| `circuit` | String | Circuit name (e.g. `"increment"`) |
| `compiledArtifactRef` | String | Logical name from registry |
| `sessionId` | UUID | Must have signing enabled |
| `args` | LargeString | JSON-encoded array (use `"[]"` for no args). See **Encoding circuit args** below |
| `idempotencyKey` | String (optional) | Dedupes retries against the original job; reusing a key returns the existing `jobId` |
| `sponsorSessionId` | UUID (optional) | Second session that pays the dust fee. See **Per-tx fee sponsoring** below |

**Rate limit:** 30/min per session.

### `submitContractCallBatch(contractAddress, calls, compiledArtifactRef, sessionId, idempotencyKey?, initialPrivateState?, sponsorSessionId?) → { jobId, status }`

Invoke SEVERAL circuits on ONE deployed contract as a SINGLE transaction. The
calls execute inside one transaction scope (SDK
`withContractScopedTransaction`) and the batch is balanced, signed and
submitted ONCE. At most 8 calls per batch. Since 0.10.0 the on-chain apply
order is deterministic and equals the call order, so DEPENDENT calls may be
batched (e.g. `attest` -> `bindPassport` -> `anchorContentRoot` as one
transaction). Exception: duplicate circuit names in one batch keep a random
relative order among themselves (see below); batch distinct circuits when
that matters.

How the ordering works: build-side state threading was never the problem
(inside the scope the SDK already feeds each call's `nextContractState` into
the next call; verified in `midnight-js-contracts` 4.0.x). But each call's
intent got a RANDOM segment id (`Transaction.fromPartsRandomized`) and the
ledger applies merged intents in ascending segment order, so a dependent
batch only landed when the dice fell in call order. NIGHTGATE now wraps the
proof provider and, before proving (the transaction is still unbound and
unproven, where `ledger-v8` allows rewriting `Transaction.intents` and
recomputes binding), reassigns the batch's existing segment ids ascending in
call order. Only the batch's own intents are permuted; fee/dust segments are
never touched. FAIL-CLOSED: for a multi-call batch the ordering must succeed,
otherwise the submission aborts BEFORE proving (an error before submission,
nothing reaches the chain), never silently proving in randomized order.
Duplicate circuit names do not fail the ordering, but their relative order
among themselves is not guaranteed (indistinguishable by `entryPoint`).

**Failure semantics** distinguish two phases. An error BEFORE submission (bad
circuit name, a throwing call, proving/balancing) discards the scope; nothing
is submitted. AFTER submission the ledger's fallible phase still applies: the
transaction can finalize as `PARTIAL_SUCCESS`, meaning it IS on chain and a
subset of the batched calls may have been applied. The job then fails with
`OnChainStatus:...` (and the crawler-free confirmer maps `PARTIAL_SUCCESS` to
`chainStatus: failure`); callers must verify effect state (e.g.
`verifyAttestationState`) rather than assume all-or-nothing.

**Async**: returns `{ jobId, status: "pending" }`; poll `getJobStatus`. The job
result on success is `{ submissionId, txHash, contractAddress, circuits, status }`
with ONE `txHash` for the whole batch; `circuits` echoes the included calls in
order.

| Field | Type | Notes |
|---|---|---|
| `contractAddress` | String | From a prior `deployContract` |
| `calls` | LargeString | JSON array of `{ circuit, args }`, applied in order (duplicate circuit names lose their relative order, see above). Per-call `args` follow **Encoding circuit args** below |
| `compiledArtifactRef` | String | Logical name from registry |
| `sessionId` | UUID | Must have signing enabled |
| `idempotencyKey` | String (optional) | Dedupes retries |
| `initialPrivateState` | LargeString (optional) | Seeded on this wallet's first contact with the contract, as in `submitContractCall` |
| `sponsorSessionId` | UUID (optional) | Second session pays the dust fee, ONCE for the whole batch (one sponsor sync + one dust spend instead of one per call). See **Per-tx fee sponsoring** |

**Rate limit:** 30/min per session (shared with `submitContractCall`).

**When to use:** several sequential calls to the same contract, including
dependent flows (since 0.10.0: `attest` -> `bindPassport` ->
`anchorContentRoot` as ONE batch). The batch removes the per-call sponsor
re-sync and block-inclusion wait, roughly a 3x latency win for the anchor
flow.

#### Per-tx fee sponsoring (`sponsorSessionId`)

Every submit action (`deployContract`, `submitContractCall`,
`submitContractCallBatch`, `anchorDocument`, `issuePredicateAttestation`,
`issueFieldPredicateAttestation`, `grantDisclosure`, `revokeDisclosure`,
`registerPassport`, `deregisterFromDustGeneration`) accepts
an optional `sponsorSessionId`. When set, the calling session builds and signs
the transaction (balancing shielded/unshielded only) and the sponsor session
balances ONLY the dust fee and submits; the caller needs neither NIGHT nor
dust. The sponsor session must be signing-capable
(`connectWalletForSigning`).

Authorization: a caller may use its OWN sessions freely; cross-user
sponsoring (the platform-sponsor model) requires the operator to list the
sponsor session id(s) in `NIGHTGATE_FEE_SPONSOR_SESSION` (comma separated) or
cds config `feeSponsorSessions`. A foreign, non-listed id is rejected with
404; a viewing-key-only sponsor with 412. The job request and result carry
`feeSponsor` for audit.

#### Encoding circuit args

`args` is a JSON array, but a compiled Compact circuit expects native value types
that JSON can't carry directly — a `Bytes<N>` parameter must arrive as a real
`Uint8Array(N)`, and a `Uint<N>` as a `BigInt`. NIGHTGATE coerces each element
**before** invoking the circuit, driven by the circuit's declared parameter types
(read from the compiled artifact's `contract-info.json`). Two encodings are
supported per element:

| Circuit param | Pass in the JSON array as | Coerced to |
|---|---|---|
| `Bytes<N>` | hex string (`"ab…"`, optional `0x` prefix), **or** a `number[]` of bytes | `Uint8Array(N)` (length-checked) |
| `Uint<N>` | a number (`47300`) or a decimal string (`"47300"`) | `BigInt` |
| `Boolean` | `true` / `false` | boolean |
| other (`Vector`, struct, …) | the JSON value | passed through unchanged |

For circuits NIGHTGATE can't introspect (no `contract-info.json` found for the
circuit), use **tagged values**, which are honored regardless of metadata:

- `{ "$bytes": "<hex>" }` → `Uint8Array`
- `{ "$uint": "<decimal>" }` (or `{ "$uint": 123 }`) → `BigInt`

An **untagged** argument for a circuit whose types can't be introspected is
rejected with a clear **400** (rather than silently passed through to fail inside
the circuit) — tag the value, or fix the registered contract's artifact path so
its `contract-info.json` resolves.

Example — calling `bindPassport(passportId: Bytes<32>, payload_hash: Bytes<32>)`:

```jsonc
// convention (introspected): each 64-hex string becomes a Uint8Array(32)
"args": "[\"<64-hex passportId>\", \"<64-hex payload_hash>\"]"

// equivalent, explicit tags:
"args": "[{\"$bytes\":\"<64-hex passportId>\"}, {\"$bytes\":\"<64-hex payload_hash>\"}]"
```

Invalid hex, a byte length that doesn't match `Bytes<N>`, or a non-integer/negative
`Uint` value is rejected with a clear **400** (`args[i]: …`) rather than failing
deep inside the circuit's type guard.

## Document anchoring

### `anchorDocument(sha256, storageRef, sessionId, contractAddress, contentType?, size?, metadata?, compiledArtifactRef?) → { jobId, status, documentId }`

Anchor a document's content hash on-chain via the AttestationVault `attest` circuit. NIGHTGATE stores only the hash + a caller-supplied `storageRef` (`file://` | `s3://` | `ipfs://`) — **never the bytes**. `documentId` is returned synchronously (the `Documents` row is inserted up-front); the job result is `{ documentId, attestationId, txHash, anchoredAt }`. `compiledArtifactRef` defaults to `attestation-vault`. **Rate limit:** 10/hour per session.

### `verifyDocument(documentId, providedSha256) → { verified, anchoredTxHash, anchoredAt, originalSha256 }` (function)

`verified: true` iff the hash matches the stored `sha256`, `anchoredTxHash` is set, and that tx resolves to a `SUCCESS` result — or, when the crawler is disabled/lagging, confirmed directly against live contract state via the optional `contractAddress`. A hash mismatch returns `verified: false` (not an error).

## ZK predicate attestations

Prove a hidden numeric value satisfies a predicate against a public threshold, without revealing the value (on-chain-verified). See [the AttestationVault contract](../contracts/attestation-vault).

### `issuePredicateAttestation(payloadHash, value, predicate, threshold, sessionId, contractAddress, salt?, unit?, valueCommitment?, compiledArtifactRef?) → { jobId, status, predicateAttestationId }`

The payload must already be attested. Submits `commitValue` then `provePredicate`. A job with `status=succeeded` means the server-side submission workflow completed; inspect `getJobStatus.chainStatus` or call `verifyPredicateAttestation` for the later canonical chain outcome. `value` is a scaled integer (caller owns float scaling); it is used only as a circuit witness and **never persisted**. `predicate`: `lessOrEqual` | `greaterOrEqual`. `salt` (64-hex commitment opening) is generated if omitted. Job result: `{ predicateAttestationId, payloadHash, claim, proof }` (PAC-envelope shape). **Rate limit:** 10/hour per session.

### `issueFieldPredicateAttestation(payloadHash, fieldKey, value, predicate, threshold, sessionId, contractAddress, contentRoot?, siblingsJson?, dirsJson?, unit?, compiledArtifactRef?, idempotencyKey?, sponsorSessionId?) → { jobId, status, predicateAttestationId }`

Field-bound predicate proof (hardened model). Like `issuePredicateAttestation`, but the proven value is cryptographically bound to a SPECIFIC passport field via Merkle inclusion against an anchored content root, so a verifier knows the value came from THIS passport's `fieldKey`, not an arbitrary committed number. The caller builds the content root + inclusion path off-chain with the contract's exported `pureCircuits` (hashing matches in-circuit). If `contentRoot` is supplied it is anchored first (`anchorContentRoot`), then `proveFieldPredicate` runs with the Merkle witnesses. `value` is the scaled integer field value (witness only, never persisted). `siblingsJson`/`dirsJson`: JSON arrays of the DEPTH=4 inclusion path (4 × 64-hex siblings; 4 booleans). **Rate limit:** 10/hour per session (shared with `issuePredicateAttestation`).

### `verifyPredicateAttestation(predicateAttestationId) → { verified, predicate, threshold, unit, valueCommitment, provenTxHash, provenAt }` (function)

`verified: true` iff `provenTxHash` resolves to a `SUCCESS` result, or confirmed directly against live contract state when the crawler is disabled/lagging (the claim key is recomputed from the row; field-bound rows check `field_predicate_results`).

## Crawler-free state verification

Read LIVE contract state via `queryContractState`: no block crawler, no local txHash, no server-side row required. Made for wallet-submitted transactions NIGHTGATE never saw (browser signs, no jobId). Both return clean negatives (`verified: false`, not a 5xx) when the state is absent or no live provider is configured. `network` (optional, e.g. `preview` | `preprod`) reads ANOTHER network's public indexer instead of the configured one (stateless, wallet-free; unknown values are a 400; per-network endpoints via `cds.requires.nightgate.networks.<network>.*`).

### `verifyAttestationState(contractAddress, payloadHash, contentRoot?, compiledArtifactRef?, network?) → { verified, attested, contentRootOk, attesterId }` (function)

Confirms `payloadHash` is present in the vault's attestation map (and, when `contentRoot` is supplied, that it equals the anchored content root for that payload). Keyed entirely by the caller-supplied `payloadHash`: no enumeration.

### `verifyPredicateState(contractAddress, payloadHash, predicate, threshold, fieldKey?, compiledArtifactRef?, network?) → { verified, proven }` (function)

The id-free counterpart to `verifyPredicateAttestation`: recomputes the on-chain claim key off-chain from the supplied coordinates and confirms the vault recorded a true result for it. Supply `fieldKey` for a field-bound proof (`field_predicate_results`); omit it for a plain one (`predicate_results`). `threshold` must be the SAME scaled integer the circuit hashed into the claim key; a scaling mismatch silently yields `verified: false`.

## Disclosure grants

Surface the AttestationVault tiered-disclosure ACL (who is entitled to which tier of an attestation, on-chain) plus the passport-ownership registry. The grant/revoke circuits are attester-gated, `registerPassport` is registrar-gated (each enforced in-circuit; an unauthorized caller's tx is rejected). `level`: `0` = public, `1` = legitimate-interest, `2` = authority (EU Battery Reg Annex XIII tiers). See [the AttestationVault contract](../contracts/attestation-vault). **Note:** delivering tier-specific *cleartext* stays off-chain (consumer `after READ` redaction) — only entitlement is on-chain.

### `grantDisclosure(payloadHash, grantee, level, sessionId, contractAddress, compiledArtifactRef?, idempotencyKey?, sponsorSessionId?) → { jobId, status, disclosureGrantId }`

Grant a disclosure tier to a `grantee` (64-hex `Bytes<32>` id) on an existing attestation, via the `grantDisclosure` circuit. The payload must already be attested by the caller. `disclosureGrantId` is returned synchronously (the `DisclosureGrants` row is inserted up-front, `active=false`); it flips to `active=true` once the post-submit chain reindex confirms the grant in ledger state. Job result: `{ disclosureGrantId, payloadHash, grantee, level, txHash }`. `compiledArtifactRef` defaults to `attestation-vault`. **Rate limit:** 30/hour per session.

### `revokeDisclosure(payloadHash, grantee, sessionId, contractAddress, compiledArtifactRef?, idempotencyKey?, sponsorSessionId?) → { jobId, status }`

Revoke a previously-granted disclosure (removes the grantee entry on-chain) via the `revokeDisclosure` circuit. Attester-only. The matching `DisclosureGrants` row's `active` flips to `false`. Job result: `{ payloadHash, grantee, txHash }`. **Rate limit:** 30/hour per session.

### `reindexDisclosures(contractAddress, compiledArtifactRef?) → { contractAddress, active, deactivated, reconciledAt }`

Re-read the AttestationVault `disclosures` ledger Map from LIVE on-chain state and reconcile `DisclosureGrants`: the same reconciliation the server-signed grant/revoke path runs internally, exposed on demand. Use it after a WALLET-submitted grant/revoke that bypassed the plugin submission pipeline (browser signs, NIGHTGATE never saw a jobId). Crawler-independent, idempotent, self-healing. `active` is the count of grants present on-chain after reconciliation; returns a clean zero (not a 5xx) when no live provider is configured. **Rate limit:** 60/hour per contract.

### `registerPassport(passportId, ownerId, sessionId, contractAddress, compiledArtifactRef?, idempotencyKey?, sponsorSessionId?) → { jobId, status }`

Pre-register (or re-register) passport ownership via the `registerPassport` circuit. Registrar-only: the calling session must be the vault's DEPLOYER (its attester identity is locked in as `registrar` at deploy time; a non-registrar caller's tx is rejected in-circuit). Assigns the `passportId` (64-hex `Bytes<32>`) to an attester id (`ownerId`), so only that attester may bind or re-bind it via `bindPassport`. This blocks first-bind squatting for registered ids; re-registering an id is the ownership-transfer and squatter-recovery path (registrar re-points the id, the new owner rebinds). Unregistered ids stay open first-come-first-served. Job result: `{ passportId, ownerId, contractAddress, txHash }`. `compiledArtifactRef` defaults to `attestation-vault`. **Rate limit:** 30/hour per session.

### `registerGranteeIdentity(bindingInput, scope?) → { ID, granteeId, bindingKind }`

Bind the authenticated caller (`req.user.id`) to the `Bytes<32>` grantee id the AttestationVault checks, so on-chain grants resolve to this principal at read time. The binding kind is set per-deployment via `cds.requires.nightgate.granteeBinding` (default `wallet`): `wallet` → `bindingInput` is the caller's coin public key (hex); `did` → a DID string; `custom` → the 64-hex grantee id itself. `scope` optionally restricts the binding to one contract/attestation (omit for a global binding). Idempotent on `(userId, scope)`. Requires authentication (401 otherwise). The *proofing* of binding ownership is the consumer's policy.

## Diagnostics

### `getWalletBalance(sessionId) → { shieldedNight, unshieldedNight, dustBalance, registeredNightUtxoCount, totalNightUtxoCount }`

Read-only snapshot. All balances as decimal NIGHT atoms (or DUST atoms) — strings to preserve `bigint` precision.

**Rate limit:** 60/min per client IP.

```bash
curl "http://localhost:4004/api/v1/nightgate/getWalletBalance(sessionId='c07b1f0a-...')"
```

Response:
```json
{
  "shieldedNight": "1000000000000",
  "unshieldedNight": "0",
  "dustBalance": "2098000",
  "registeredNightUtxoCount": 1,
  "totalNightUtxoCount": 1
}
```

### `estimateSendNightFee(sessionId, receiverAddress, amount, ttlIso?) → { fee, toLedger }`

Pre-flight DUST fee for a `sendNight` call. Builds the recipe in the worker (lightweight; no ZK proof generation, no submit), discards it after fee calc. Useful to gate the user on whether dust balance is sufficient before triggering the actual send.

`fee` is DUST atoms as decimal string.

### `estimateShieldFee(sessionId, amount, ttlIso?) → { fee, direction: "shield" }`
### `estimateUnshieldFee(sessionId, amount, ttlIso?) → { fee, direction: "unshield" }`

Symmetric pre-flight estimates for the ledger-shift operations.

## Indexer / health / metrics

### `getHealth() → { status, chainHeight, indexedHeight, finalizedHeight, lag, finalizedLag, blocksPerSecond, syncStatus }`

Crawler sync state. **This is the crawler's view, not the wallet's.** During wallet-sync runs with `NIGHTGATE_CRAWLER_ENABLED=false`, this returns stale data (the last persisted SyncState row).

### `getSyncStatus() → SyncState`
### `getMetrics() → String`

`getMetrics` returns Prometheus text format. Metric prefix: `odatano_nightgate_*`. Includes chain height, indexed height, sync lag, block throughput, error counts, uptime, sync status (mapped: stopped=0, syncing=1, synced=2, error=3), runtime-topology gauges (`_runtime_topology_valid`, `_runtime_replicas`, `_runtime_database_info`), and background-job gauges (`_jobs_queued`, `_jobs_running`, `_jobs_reconciliation_required`, `_jobs_oldest_queued_seconds`).

### `getLiveness() → { status, timestamp, uptime }`
### `getReadiness() → { ready, checks: { database, crawler, node } }`

Kubernetes-style probes. `getReadiness` reports `ready: true` only when all three subsystem checks pass.

### `getReorgHistory(limit?) → ReorgLog[]`

Last `limit` (default 10, max 100) reorg events with depth, detected-at timestamp, rolled-back tx count.

### `pauseCrawler() / resumeCrawler() / reindexFromHeight(height)` — actions

Operator controls, `@requires: 'admin'` (since 0.5.2; unauthenticated or non-admin callers get 401/403). `reindexFromHeight` triggers a rollback to the specified height (including a recompute of the `NightBalances` projection for affected addresses) and a fresh catch-up from there. The read-only status/health/metrics functions above stay unrestricted for K8s probes and Prometheus.

## Analytics

`getBlockCount() / getTransactionCount() / getContractCount() / getAverageTransactionsPerBlock()` — simple aggregate queries over the indexed entities.

## Admin

`invalidateSession(sessionId)` / `invalidateAllSessions()` — force-close sessions. Distinct from `disconnectWallet` in that admin can target any session, not just one the caller owns.

`grantRole(userId, role, scope?, validUntil?)` — grant a disclosure tier (`public_only` | `legitimate_interest` | `authority`) read by the `AttestationService` mixin's `attachDisclosureRole` middleware. Caller must already hold `authority`. This is the **off-chain** tier table (`DisclosureRoles`).

> **On-chain alternative.** `attachDisclosureRole(req, db, { contractAddress, payloadHash? })` resolves the tier from the **on-chain** `DisclosureGrants` ACL instead: it maps the caller (via `GranteeIdentities` → `registerGranteeIdentity`) to a `Bytes<32>` grantee and matches active grants for that contract. With a `contractAddress` the on-chain result is authoritative (no off-chain fallback); without one, the off-chain `grantRole` table applies. The gate is a programmatic middleware — the consumer wires it into the reads it wants to gate.

## Standard OData over entities

Every `@readonly` entity supports the full OData V4 query surface. Examples:

```bash
# Latest 10 blocks
curl "http://localhost:4004/api/v1/nightgate/Blocks?\$top=10&\$orderby=height desc"

# Transactions in a given block
curl "http://localhost:4004/api/v1/nightgate/Transactions?\$filter=block_ID eq <uuid>"

# Pending submissions for a specific session
curl "http://localhost:4004/api/v1/nightgate/PendingSubmissions?\$filter=sessionId eq 'c07b1f0a-...'"

# Top 5 NIGHT holders
curl "http://localhost:4004/api/v1/nightgate/NightBalances/NightgateService.getTopHolders(limit=5)"
```

## Error model

Error responses follow OData's `{ error: { code, message } }` envelope. For submission errors specifically, the `message` field is a **JSON-stringified payload** with the classification:

```json
{
  "error": {
    "code": "400",
    "message": "{\"code\":\"Wallet.InsufficientFunds\",\"retryable\":false,\"message\":\"Insufficient Funds: could not balance dust\",\"submissionId\":\"54b1968a-...\"}"
  }
}
```

Codes returned by `classifySubmissionError` (`srv/submission/TransactionSubmitter.ts`):

| Code | Retryable | Trigger |
|---|---|---|
| `TxFailed` | no | SDK `TxFailedError` (on-chain status wasn't `SucceedEntirely`) |
| `1014` | no | Substrate "invalid transaction" (matches `1014` or `invalid transaction` in the error message) |
| `1016` | yes (preprod) / no (mainnet) | "Immediately Dropped" — preprod transient, mainnet has a known deterministic-rejection issue |
| `NetworkOrTimeout` | yes | `ECONNREFUSED`, `ECONNRESET`, `ENOTFOUND`, `ETIMEDOUT`, `socket hang up`, `timeout` |
| `ContractTypeError` / `IncompleteCallTxPrivateStateConfig` / `IncompleteFindContractPrivateStateConfig` | no | SDK contract-config errors (classified by the thrown error's `name`) |
| `WalletSigningNotAvailable` | no | Session has no encrypted seed key |
| `<error name>` (default) | no | Any otherwise-unrecognized error — falls back to the thrown error's `name`, assumed non-retryable |

Other failures surface as the **raw node/SDK error** rather than a `classifySubmissionError` code:

- **Custom error `170` (dust validity window)** — raised by the node when the wallet's dust `ctime` is outside the grace window, usually a lagging indexer or a wallet not synced to tip. (`failed assert: predicate false` is the distinct predicate-circuit rejection.)
- **`Wallet.InsufficientFunds`** — raised by the wallet SDK when there's insufficient dust to pay fees, or insufficient NIGHT to satisfy outputs.
- **`MalformedResult`** — thrown by `TransactionSubmitter` when the SDK returns without the expected fields (likely an SDK bug); it is a distinct thrown error, not a `classifySubmissionError` code.

For diagnostic 503s caused by the hosted Midnight indexer, see [docs/operations.md#troubleshooting](operations.md#troubleshooting).
