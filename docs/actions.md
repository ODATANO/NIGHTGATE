# Actions reference

All OData V4 actions and functions exposed by NIGHTGATE, with signatures, request shapes, response shapes, error codes, and copy-pasteable examples.

OData distinguishes between **actions** (POST, may have side effects) and **functions** (GET, side-effect-free). NIGHTGATE follows this: write operations are actions, read-only operations are functions.

**Base path conventions** in examples:
- `http://localhost:4004/api/v1/nightgate/<actionName>` - main service
- `http://localhost:4004/api/v1/indexer/<functionName>()` - indexer service
- `http://localhost:4004/api/v1/analytics/<functionName>()` - analytics service
- `http://localhost:4004/api/v1/admin/<actionName>` - admin service

## Async job model (write actions)

Every action that submits an on-chain transaction is **asynchronous**: it returns `{ jobId, status: "pending" }` immediately, then you poll `getJobStatus(jobId, sessionId)` until `succeeded` or `failed`. This keeps multi-minute proof/submit work off the HTTP request. Each write action below documents its **job-result** shape (the parsed `result` on success); read-only **functions** return their result directly.

### `getJobStatus(jobId, sessionId) → { status, chainStatus, result, errorCode, errorMessage, submissionId, txHash, chainFinalizedAt, … }`

`status` (server-side workflow lifecycle): `pending | running | external_execution | submitted | reconciliation_required | succeeded | failed`. On success, `result` is a JSON string of the action's result shape; on failure, `errorCode` + `errorMessage` carry the classified error (see [Error model](#error-model)).

`reconciliation_required` is an explicit **terminal** state: execution was interrupted after an external effect may have occurred. The caller must NOT auto-retry - a fresh attempt needs a new `idempotencyKey`. The single-instance reconciler resolves such jobs automatically from durable chain evidence (a finalized `PendingSubmission` plus a `System.Events` outcome) once it becomes available.

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

Upgrade a read-only session with **signing capability**, encrypting the BIP39 seed at rest. Keys are HD-derived per Midnight role (zswap / dust / night) to match Lace - see `srv/utils/wallet-hd.ts`. Schedules a tracked pre-warm job that syncs the wallet SDK in the worker; poll `getJobStatus(prewarmJobId, sessionId)` to know when sync-to-tip is done before submitting.

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

Source funds come from the same ledger as the receiver. There is no cross-ledger conversion: NIGHT is an unshielded-only token.

| Field | Type | Notes |
|---|---|---|
| `sessionId` | UUID | Must have signing enabled |
| `receiverAddress` | String | Bech32m, ≥ 50 chars |
| `amount` | String | Decimal NIGHT atoms (parsed as `bigint` server-side; avoids Number precision loss). Sanity-bounded to `10^18`. |
| `ttlIso` | String (optional) | ISO-8601 future timestamp; default = now+10min |
| `tokenTypeHex` | String (optional) | Raw token type (64 hex, lowercased server-side) to send instead of NIGHT. Works on BOTH ledgers: the receiver address prefix decides whether the transfer spends shielded or unshielded holdings of that token. Shielded custom-token transfers are live-verified (see `contracts/shielded-token`); unshielded custom tokens go through the identical path but have not been exercised live yet. |
| `idempotencyKey` | String (optional) | Dedupes retries against the original job |

**Rate limit:** 10/min per client IP.

**Errors:**
- 400 - invalid address prefix, malformed amount, TTL in past
- 404 - session not found
- 412 - session not signing-enabled
- 429 - rate-limited
- 500 - `Wallet.InsufficientFunds`, `Wallet.Sync` errors from SDK

```bash
curl -X POST http://localhost:4004/api/v1/nightgate/sendNight \
  -H "Content-Type: application/json" \
  -d '{
    "sessionId": "c07b1f0a-...",
    "receiverAddress": "mn_addr_preprod1xcmxw094zxek0jp0tdc6e294tgrx0qn0l40ugjqhtqy3w5x7dkusuzphxg",
    "amount": "1000000"
  }'
```

### `registerForDustGeneration(sessionId, dustReceiverAddress?) → { txId, registeredCount, totalNightUtxos, dustReceiverAddress }`

Register the wallet's **unregistered unshielded NIGHT UTXOs** for dust generation. Returns a no-op response (`txId: ""`, `registeredCount: 0`) if there are no unregistered UTXOs to process.

| Field | Type | Notes |
|---|---|---|
| `sessionId` | UUID | Must have signing enabled |
| `dustReceiverAddress` | String (optional) | Bech32m DUST address (`mn_dust_*`); default = wallet's own dust address |
| `idempotencyKey` | String (optional) | Dedupes retries against the original job |

Initial DUST accrual takes ~1-2 minutes after the tx finalizes. Refill rate is ~5 tDUST per 100 hours (preprod parameters).

### `deregisterFromDustGeneration(sessionId) → { txId, deregisteredCount, totalNightUtxos }`

Reverse: deregister ALL the wallet's registered NIGHT UTXOs so they become spendable again. Per-UTXO selection is not exposed yet.

## Contract operations

### `deployContract(compiledArtifactRef, sessionId, initialPrivateState, idempotencyKey?, sponsorSessionId?) → { jobId, status }`

Deploy a Compact-compiled contract. The contract must be registered via `cds.requires.nightgate.contracts.<ref>` (or programmatically via `registerContract()`).

**Async** (see [Async job model](#async-job-model-write-actions)): returns `{ jobId, status: "pending" }` immediately; poll `getJobStatus(jobId, sessionId)`. The job result on success is `{ submissionId, txHash, contractAddress, status }` (here `status` is the `PendingSubmissions` lifecycle status - distinct from the job status).

| Field | Type | Notes |
|---|---|---|
| `compiledArtifactRef` | String | Logical name from the registry (e.g. `"counter"`) |
| `sessionId` | UUID | Must have signing enabled |
| `initialPrivateState` | LargeString | JSON-encoded initial state (e.g. `"{}"`) |
| `idempotencyKey` | String (optional) | Dedupes retries against the original job; reusing a key returns the existing `jobId` |

A row is inserted into `PendingSubmissions` BEFORE the SDK is invoked (crash-recovery hook). The result `status` transitions: `pending` → `included` (SDK returned successfully) → `finalized` (crawler indexed the tx).

**Rate limit:** 5/hour per session.

**Errors:**
- 400 - `Wallet.InsufficientFunds` (insufficient dust), `OnChainStatus:FailEntirely`, `MalformedResult`
- 404 - contract not registered
- 503 - retryable transient (network, 1016 on preprod)

### `submitContractCall(contractAddress, circuit, compiledArtifactRef, sessionId, args, idempotencyKey?, initialPrivateState?, sponsorSessionId?) → { jobId, status }`

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
| `initialPrivateState` | LargeString (optional) | JSON; seeded on this wallet's FIRST contact with the contract only (lets a non-deployer wallet act on a shared contract). Never overwrites existing private state. |
| `sponsorSessionId` | UUID (optional) | Second session that pays the dust fee. See **Per-tx fee sponsoring** below |

**Rate limit:** 30/min per session.

### `submitContractCallBatch(contractAddress, calls, compiledArtifactRef, sessionId, idempotencyKey?, initialPrivateState?, sponsorSessionId?) → { jobId, status }`

Invoke SEVERAL circuits on ONE deployed contract as a SINGLE transaction. The
calls execute inside one transaction scope (SDK
`withContractScopedTransaction`) and the batch is balanced, signed and
submitted ONCE. At most 8 calls per batch. Since 0.10.0 the on-chain apply
order is deterministic and equals the call order, so DEPENDENT calls may be
batched (e.g. `attest` -> `anchorContentRoot` -> `bindPassport` as one
transaction). Two limits apply: duplicate circuit names in one batch keep a
random relative order among themselves (see below), and a dependent batch stays
valid only while its leading calls fit the ledger's guaranteed execution stage,
which depends on the target contract's state (see **Ledger causality rule**
below, and read it before relying on a dependent batch in production).

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

One environment switch exists for diagnosis
(`NIGHTGATE_BATCH_SEGMENT_MODE`): `rewrite` is the default described above;
`observe` applies no ordering and only logs the randomized ids, so dependent
batches then apply in dice order. Leave it unset in production.

**Ledger causality rule (this limits what may be batched):** every contract
call is split into a GUARANTEED and a FALLIBLE transcript by the SDK's
`partitionTranscripts`, which allocates them by GAS COST. The ledger applies
all guaranteed stages before any fallible stage, and therefore rejects a
transaction in which a call carrying a fallible transcript is followed by a
call carrying a guaranteed one: the later call would run against state its
predecessor has not written yet. The node reports this as `1010: Invalid
Transaction: Custom error: 188`.

The catch is that per-call cost GROWS WITH CONTRACT STATE (deeper merkle paths
on larger maps), so the same batch is valid on a small contract and invalid
later, without any change on the caller's side. Measured on preprod with the
AttestationVault, batching `attest -> anchorContentRoot -> bindPassport`:
batches 1 and 2 landed with all three calls guaranteed, batch 3 was rejected
because `attest` had crossed into the fallible stage (5.34G guaranteed vs
6.04G fallible execution budget). Submitting `attest` on its own and batching
`[anchorContentRoot, bindPassport]` runs indefinitely.

Consequences for callers:

- A dependent batch is safe only while its leading calls stay guaranteed. If
  the first call is the expensive one (it usually is: it creates the record the
  others read), expect to split it off as the contract fills up.
- Putting the most expensive call LAST keeps a batch valid longest, since
  nothing behind it can be starved. This is the general form of the
  "order cell-updating calls last" rule from 0.15.3: an updating call is simply
  an expensive one.
- NIGHTGATE checks the partitioning BEFORE proving and fails the job with
  `errorCode: "BatchCausalityViolation"` and an explanatory message naming both
  calls, instead of spending proof generation and balancing on a transaction
  the node will reject. Nothing is submitted, and the code is never retryable
  (the shape is deterministic for the contract's current state). The per-call
  stages and their gas budgets are logged for every multi-call batch:
  `[nightgate:batch-segments] rewrite: ... -> attest=1158[f:6.04G] anchorContentRoot=52208[g:4.77G]`.

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
`submitContractCallBatch`, `anchorDocument`,
`issueFieldPredicateAttestation`, `issueFieldPredicateAttestationBatch`,
`grantDisclosure`, `revokeDisclosure`,
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
that JSON can't carry directly - a `Bytes<N>` parameter must arrive as a real
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
the circuit) - tag the value, or fix the registered contract's artifact path so
its `contract-info.json` resolves.

Example - calling `bindPassport(passportId: Bytes<32>, payload_hash: Bytes<32>)`:

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

### `anchorDocument(sha256, storageRef, sessionId, contractAddress, contentType?, size?, metadata?, compiledArtifactRef?, nonce?) → { jobId, status, documentId }`

Anchor a document's content hash on-chain via the AttestationVault `attest` circuit. NIGHTGATE stores only the hash + a caller-supplied `storageRef` (`file://` | `s3://` | `ipfs://`) - **never the bytes**. `documentId` is returned synchronously (the `Documents` row is inserted up-front, recording the caller as owner plus the anchoring `contractAddress`, network and artifact as evidence context); the job result is `{ documentId, attestationId, txHash, anchoredAt }`. `compiledArtifactRef` defaults to `attestation-vault`. `Documents` entity reads are owner-scoped (admins unfiltered). With `nonce` (64 hex, from `prepareAnchorCommitment`), the anchor runs as the guarded REVEAL (`attestGuarded` mode 1) against a previously committed commitment; a plain attest that front-ran the reveal is taken over in-circuit because its sequence number is newer than the commitment's. **Rate limit:** 10/hour per session.

### `prepareAnchorCommitment(sha256, metadata?, nonce?) → { commitment, nonce, metadataHash }` (compute-only)

Guarded (commit-reveal) anchoring, phase 0: computes `commitment = persistentHash{sha256, metadataHash, nonce}` (byte-identical to the circuit's in-circuit recompute) plus a random `nonce` when none is supplied. STORE the nonce and keep it SECRET until reveal: it is exactly what a mempool front-runner cannot forge. `metadata` must equal the later `anchorDocument` metadata. Why the guard exists: plain attest is first-come-first-served and insert-once, so a mempool observer could permanently claim a visible payload hash; commit-reveal closes that window for hashes that are secret until reveal (publicly known identifiers use `registerPassport` pre-assignment instead).

### `commitDocumentAnchor(commitment, sessionId, contractAddress, compiledArtifactRef?, idempotencyKey?, sponsorSessionId?) → { jobId, status }`

Guarded anchoring, phase 1: records the opaque commitment on-chain (`attestGuarded` mode 0; a mempool observer learns nothing about the payload). After the job finalizes, run `anchorDocument` with the SAME sha256/metadata plus the `nonce` (phase 2). Note: the reveal proves against a ledger snapshot; if the contested attest lands between proving and application, the reveal fails once and succeeds on re-prove (takeover branch). **Rate limit:** shared with `anchorDocument`.

### `verifyDocument(documentId, providedSha256) → { verified, anchoredTxHash, anchoredAt, originalSha256 }` (function)

`verified: true` iff the hash matches the stored `sha256`, `anchoredTxHash` is set, and that tx resolves to a `SUCCESS` result - or, when the crawler is disabled/lagging, confirmed directly against live contract state. The vault, artifact and network recorded at anchor time are authoritative for that state check: caller-supplied `contractAddress`/`compiledArtifactRef` may only CONFIRM them (a different one is a 400) and the fallback reads the RECORDED network's indexer, so another vault, artifact generation or chain attesting the same public hash cannot make the document appear verified; only legacy rows without recorded coordinates use the caller's values. A hash mismatch returns `verified: false` (not an error). Callable by any authenticated user holding the documentId (an unguessable capability handle; the response exposes no `storageRef`).

## Document ingestion (compute-only)

Synchronous helpers that turn structured data into the proof inputs the predicate actions consume. Nothing is persisted, no job is started; responses carry WITNESS material and are never logged.

### `prepareDocumentProof(documentJson, proofFieldsJson, saltSeed?, compiledArtifactRef?) → { payloadHash, canonicalDocument, contentRoot, fields, emptyFields, schemaId, schema, leaves, opening }`

Canonical JSON (recursively key-sorted) → blake2b-256 `payloadHash` (the value `anchorDocument` anchors), plus a depth-4 SALTED Merkle `contentRoot` over the ORDERED `proofFieldsJson` list (leaf index = list position; keep the order stable across anchor and proof) with per-field inclusion paths. `proofFieldsJson` is up to 16 `{ field, kind?, scale? }` entries: `kind: 'uint'` (default; numeric, scaled by `scale`, default 1000) or `kind: 'bytes'` (string value, entered as the blake2b-256 digest of the EXACT string; feeds the equality/membership actions; `scale` not allowed). `field` is a dot-separated path (numeric segments index arrays; a literal top-level key containing dots wins). Every leaf carries a per-slot salt derived from a per-document 32-byte seed (`saltSeed`: random by default, caller-supplied for a deterministic re-prepare of an already-anchored payload); absent values occupy the salted absent leaf (padding key `nightgate/empty-leaf/v2` ASCII zero-padded) and are reported in `emptyFields`, so a shared leaf layer reveals neither values nor the presence pattern. Leaf/node/descriptor hashing goes through the contract artifact's exported pure circuits, so root and schemaId are byte-identical to the in-circuit recompute. `fields` is a JSON array of `{ field, fieldKey, kind, value?, valueDigest?, salt, siblings, dirs }` (the `salt` feeds every single-field proof action as `fieldSalt`). `schemaId` is the schema ROOT over the 16 slot descriptors `{ fieldKey, kind, scale }` (returned as `schema`); it is anchored next to the content root and PROVEN by the comparison circuit. `opening` (`{ saltSeed, slots[16] }`) is the cross-root witness bundle: STORE it with the document; losing the seed makes the anchored root unprovable, leaking it makes shared leaf hashes dictionary-testable. **Rate limit:** 120/hour per client.

### `prepareMembershipSet(allowedValuesJson, value?, valueDigest?, compiledArtifactRef?) → { setRoot, memberCount, setSiblingsJson?, setDirsJson? }`

Canonical membership-set helper for `issueFieldMembershipAttestation` and `verifyPredicateState`. Builds the deterministic depth-6 set tree over an allow-list, so any party recomputes the same `setRoot` from the published list alone. Canonical rule: blake2b-256 each value (exact string), dedupe, sort ascending, pad to 64 slots by repeating the last member digest, leaf-wrap with the contract's `setLeafHash` pure circuit. Padding repeats a REAL member on purpose: every leaf must be a member digest, or the padding constant itself would be provable as a member of any non-full list. More than 64 DISTINCT values is a 400. Without `value`/`valueDigest`: returns `{ setRoot, memberCount }` (the verifier lane). With one of them: additionally the member's inclusion path (`setSiblingsJson`/`setDirsJson`; witness material, the matched slot narrows the hidden value); 400 when the value is not in the list. **Rate limit:** 120/hour per client (shared with `prepareDocumentProof`).

Consumers who need the canonical rule OUTSIDE a server context (anonymous read-side verifiers, browser bundles, unit tests pinning a claim catalog) should import the session-free `@odatano/nightgate/set-root` subpath instead of re-implementing it: `import { buildMembershipSet, membershipPathFor, canonicalSetDigests, SET_DEPTH, MAX_SET_VALUES } from '@odatano/nightgate/set-root'`. It is dependency-clean (no CAP, no Node builtins; loads in Node CJS/ESM and browser bundlers), takes the artifact's `setLeafHash`/`nodeHash` pure circuits as a parameter, and produces byte-identical roots to this action.

## ZK predicate attestations

Prove statements about anchored field values without revealing them (on-chain-verified): numeric predicates against a public threshold, bytes equality against a public digest, and set membership in a public allow-list. See [the AttestationVault contract](../contracts/attestation-vault). Every claim kind is root-bound; the commitment-only `issuePredicateAttestation` lane (commitValue/provePredicate) was removed in 0.16.0 because its on-chain commitment was overwritable while recorded claims did not embed it.

### `issueFieldPredicateAttestation(payloadHash, fieldKey, value, fieldSalt, predicate, threshold, sessionId, contractAddress, contentRoot?, schemaId?, siblingsJson?, dirsJson?, unit?, compiledArtifactRef?, idempotencyKey?, sponsorSessionId?) → { jobId, status, predicateAttestationId }`

Field-bound predicate proof: the proven value is cryptographically bound to a SPECIFIC passport field via Merkle inclusion against an anchored content root, so a verifier knows the value came from THIS passport's `fieldKey`, not an arbitrary committed number. The caller builds the content root + inclusion path off-chain with the contract's exported `pureCircuits` (hashing matches in-circuit). If `contentRoot` is supplied it is anchored first (`anchorContentRoot`, together with the mandatory `schemaId` from `prepareDocumentProof`), then `proveFieldPredicate` runs with the Merkle witnesses. `value` is the scaled integer field value (witness only, never persisted); `value`/`threshold` must fit Uint<64>. `siblingsJson`/`dirsJson`: JSON arrays of the DEPTH=4 inclusion path (4 × 64-hex siblings; 4 booleans). Job result: `{ predicateAttestationId, payloadHash, claim, proof }` (PAC-envelope shape). **Rate limit:** 10/hour per session.

### `issueFieldPredicateAttestationBatch(payloadHash, claimsJson, sessionId, contractAddress, contentRoot?, schemaId?, compiledArtifactRef?, idempotencyKey?, sponsorSessionId?) → { jobId, status, claims, droppedDuplicates }`

Batch pendant to the single field actions: prove up to 8 field-bound claims on ONE passport in ONE transaction (one balancing round, one submit, one confirmation wait, one fee event; with `sponsorSessionId` one dust spend for the whole batch). `claimsJson` entries may MIX the five claim kinds, discriminated by `predicate`: numeric `{ fieldKey, value, salt, siblings, dirs, predicate: 'lessOrEqual'|'greaterOrEqual', threshold, unit? }`, equality `{ fieldKey, expectedValue|expectedDigest, salt, siblings, dirs, predicate: 'bytesEquality' }`, membership `{ fieldKey, value|valueDigest, salt, allowedValues | setRoot+setSiblings+setDirs, siblings, dirs, predicate: 'setMembership' }`, cross-root integrity `{ predicate: 'documentIntegrity', payloadHashB, allowedMask, schema, openingA, openingB }`, cross-root diff `{ predicate: 'documentDiff', payloadHashB, k, schema, openingA, openingB }`, each validated like its single action. The cross-root kinds carry no fieldKey/inclusion path; document A is the batch `payloadHash`, and an in-batch `contentRoot` anchor is document A's root (document B's must already be anchored). If `contentRoot` is supplied it is anchored (with the mandatory `schemaId`) as the FIRST call of the SAME batch (segment ordering pins the anchor ahead of the proofs) and occupies one of the 8 call slots (max 7 claims with anchor). Exact duplicate claim tuples (numeric: fieldKey+threshold+predicate, equality: fieldKey+expectedDigest, membership: fieldKey+setRoot, integrity: payloadHashB+allowedMask, diff: payloadHashB+k) are dropped server-side (`droppedDuplicates`); claim keys are idempotent on-chain, so this is only a proving-time optimization. One `PredicateAttestations` row per claim, all sharing one `provenTxHash` on success; `claims` in the response is a JSON array of `{ predicateAttestationId, fieldKey, predicate, ... }` with the kind's statement fields. Proving work stays additive (N proofs = N provings, sequential). Failure: a false claim fails at LOCAL proving time (nothing submitted, no row proven); after submission the ledger's fallible phase can finalize PARTIAL_SUCCESS, in which case the job fails with `OnChainStatus:...` and callers verify per claim via `verifyPredicateAttestation` (crawler-free, no txHash needed). **Rate limit:** counts N claims against the shared 10/hour predicate budget, not one call.

### `issueFieldEqualityAttestation(payloadHash, fieldKey, expectedValue|expectedDigest, fieldSalt, sessionId, contractAddress, contentRoot?, schemaId?, siblingsJson?, dirsJson?, compiledArtifactRef?, idempotencyKey?, sponsorSessionId?) → { jobId, status, predicateAttestationId }`

Field-bound EQUALITY proof for a bytes-valued (string) field (`proveFieldEquality`): the anchored content root carries, at `fieldKey`, exactly the value whose blake2b-256 digest is `expectedDigest`. Pass exactly one of `expectedValue` (raw string; the server digests the EXACT string, no trimming) or `expectedDigest` (64 hex). The digest is PUBLIC (it is the statement), so this is an authenticity/binding proof, not a confidentiality feature: for low-entropy values the digest is dictionary-guessable. The field must have entered the content root as a bytes leaf (`prepareDocumentProof` with `kind: 'bytes'`); `siblingsJson`/`dirsJson` are the DEPTH=4 path as on the numeric action. If `contentRoot` is supplied it is anchored first (requires `schemaId`). **Rate limit:** 10/hour per session (shared predicate budget).

### `issueFieldMembershipAttestation(payloadHash, fieldKey, value|valueDigest, allowedValuesJson | setRoot+setSiblingsJson+setDirsJson, fieldSalt, sessionId, contractAddress, contentRoot?, schemaId?, siblingsJson?, dirsJson?, compiledArtifactRef?, idempotencyKey?, sponsorSessionId?) → { jobId, status, predicateAttestationId }`

Field-bound SET-MEMBERSHIP proof (`proveFieldMembership`): the field's HIDDEN value is one of a public allow-list, without revealing which one. Two Merkle folds over the same witnessed digest: the DEPTH=4 content fold binds it to THIS passport's `fieldKey`, the DEPTH=6 set fold proves it is a leaf of the canonical membership-set tree (up to 64 distinct values; see `prepareMembershipSet` for the canonical rule). Pass exactly one of `value` (raw string) or `valueDigest` (64 hex); both stay witness material, never persisted. Supply the list as `allowedValuesJson` (the server builds root + path and rejects 400 when the value is not in the list, BEFORE any proving) or precomputed as `setRoot` + `setSiblingsJson`/`setDirsJson` (6 × 64-hex siblings; 6 booleans). **Rate limit:** 10/hour per session (shared predicate budget).

### `issueDocumentIntegrityAttestation(payloadHashA, payloadHashB, allowedMask, schemaJson, openingAJson, openingBJson, sessionId, contractAddress, contentRootA?, contentRootB?, schemaId?, compiledArtifactRef?, idempotencyKey?, sponsorSessionId?) → { jobId, status, predicateAttestationId }`

Cross-root INTEGRITY proof (`proveDocumentComparison` mode 0): document B differs from document A ONLY in the slots flagged by the packed 16-bit `allowedMask` (bit i = slot i may differ; 0 = identical values; 65535 is rejected as vacuous), both bound to their anchored content roots, values hidden. The canonical version-integrity claim for re-anchored passports. v4 witness model: `schemaJson` is the SHARED 16-entry descriptor list and `openingAJson`/`openingBJson` are the documents' full openings (`prepareDocumentProof` returns them as `schema` and `opening`); the circuit recomputes the schema root AND both content roots in-circuit, so the anchored schema id is PROVEN to describe the trees (a forged schema label fails the proof) and the per-slot comparison runs on values under the shared schema. Both documents MUST be anchored under the SAME `schemaId`; a slot that changed, appeared or disappeared outside the mask fails at LOCAL proving time, nothing submitted. `payloadHashA != payloadHashB` (also asserted in-circuit); (A, B) order is part of the claim key. Optional `contentRootA`/`contentRootB` anchor first with `schemaId` (each a separate transaction; the batch action's `documentIntegrity` kind is the one-transaction path). **Rate limit:** 10/hour per session (shared predicate budget).

### `issueDocumentDiffAttestation(payloadHashA, payloadHashB, k, schemaJson, openingAJson, openingBJson, sessionId, contractAddress, contentRootA?, contentRootB?, schemaId?, compiledArtifactRef?, idempotencyKey?, sponsorSessionId?) → { jobId, status, predicateAttestationId }`

Cross-root DISTINCTNESS proof (`proveDocumentComparison` mode 1): at least `k` (1..16) of the 16 aligned slots differ between two anchored documents, without revealing which slots or what values. k=1 is "provably not the same document". Same v4 witness model as the integrity mode (`schemaJson` + `openingAJson`/`openingBJson`; witness material, never persisted). A counted difference is a value or presence change under the shared schema; both-empty compares equal; padding slots never count. Schema parity is structural: ONE witnessed descriptor list must fold to BOTH anchored schema ids. Fewer than k actual differences fail at LOCAL proving time. **Rate limit:** 10/hour per session (shared predicate budget).

### `verifyPredicateAttestation(predicateAttestationId) → { verified, predicate, threshold, unit, expectedDigest, setRoot, payloadHashB, allowedMask, provenTxHash, provenAt }` (function)

`verified: true` iff `provenTxHash` resolves to a `SUCCESS` result, or confirmed directly against live contract state when the crawler is disabled/lagging (the claim key is recomputed from the row; numeric rows check `field_predicate_results`, `bytesEquality` rows `field_equality_results`, `setMembership` rows `field_membership_results`, `documentIntegrity` rows `document_integrity_results`, `documentDiff` rows `document_diff_results`; a diff row's k rides in `threshold`).

## Crawler-free state verification

Read LIVE contract state via `queryContractState`: no block crawler, no local txHash, no server-side row required. Made for wallet-submitted transactions NIGHTGATE never saw (browser signs, no jobId). Both return clean negatives (`verified: false`, not a 5xx) when the state is absent or no live provider is configured. `network` (optional, e.g. `preview` | `preprod`) reads ANOTHER network's public indexer instead of the configured one (stateless, wallet-free; unknown values are a 400; per-network endpoints via `cds.requires.nightgate.networks.<network>.*`).

### `verifyAttestationState(contractAddress, payloadHash, contentRoot?, schemaId?, compiledArtifactRef?, network?) → { verified, attested, contentRootOk, schemaOk, attesterId }` (function)

Confirms `payloadHash` is present in the vault's attestation map (and, when `contentRoot` / `schemaId` are supplied, that they equal the anchored content root / schema id for that payload). Keyed entirely by the caller-supplied `payloadHash`: no enumeration. TRUST NOTE: an anchor is the anchoring attester's statement about their own payload. A verifier of cross-party claims must ALSO check `attesterId` against the identity it trusts and, for cross-root claims, `schemaId` against the canonical schema of the expected field panel; the comparison circuit proves the anchored schema id describes the trees, and this function makes both checks crawler-free.

### `verifyPredicateState(contractAddress, payloadHash, predicate, threshold?, fieldKey?, expectedDigest?, setRoot?, payloadHashB?, allowedMask?, k?, compiledArtifactRef?, network?) → { verified, proven }` (function)

The id-free counterpart to `verifyPredicateAttestation`: recomputes the on-chain claim key off-chain from the supplied coordinates and confirms the vault recorded a true result for it. Numeric predicates: supply `fieldKey` (numeric claims are field-bound; the commitment-only plain kind was removed in 0.16.0) and `threshold` (the SAME scaled integer the circuit hashed into the claim key; a scaling mismatch silently yields `verified: false`); results live in `field_predicate_results`. Bytes kinds: `predicate: 'bytesEquality'` + `fieldKey` + `expectedDigest` (`field_equality_results`), or `predicate: 'setMembership'` + `fieldKey` + `setRoot` (`field_membership_results`); `threshold` is ignored for both. Cross-root kinds: `predicate: 'documentIntegrity'` + `payloadHashB` + `allowedMask` (`document_integrity_results`), or `predicate: 'documentDiff'` + `payloadHashB` + `k` (`document_diff_results`); `payloadHash` is document A and the (A, B) order must match the proving order (it is part of the claim key). Every claim key additionally embeds the payload's ATTESTATION EPOCH (cross-root: both epochs), which this function reads from the same live state automatically: claims recorded during a front-runner's ownership window stop verifying after a guarded-attest takeover moved the epoch. External recomputes via `computeFieldPredicate/Equality/MembershipClaimKey` and the cross-root computers must pass the current epoch(s) from `attestation_seqs`.

## Disclosure grants

Surface the AttestationVault tiered-disclosure ACL (who is entitled to which tier of an attestation, on-chain) plus the passport-ownership registry. The grant/revoke circuits are attester-gated, `registerPassport` is registrar-gated (each enforced in-circuit; an unauthorized caller's tx is rejected). `level`: `0` = public, `1` = legitimate-interest, `2` = authority (EU Battery Reg Annex XIII tiers). See [the AttestationVault contract](../contracts/attestation-vault). **Note:** delivering tier-specific *cleartext* stays off-chain (consumer `after READ` redaction) - only entitlement is on-chain.

### `grantDisclosure(payloadHash, grantee, level, sessionId, contractAddress, compiledArtifactRef?, idempotencyKey?, sponsorSessionId?) → { jobId, status, disclosureGrantId }`

Grant a disclosure tier to a `grantee` (64-hex `Bytes<32>` id) on an existing attestation, via the `grantDisclosure` circuit. The payload must already be attested by the caller. `disclosureGrantId` is returned synchronously (the `DisclosureGrants` row is inserted up-front, `active=false`); it flips to `active=true` once the post-submit chain reindex confirms the grant in ledger state. Job result: `{ disclosureGrantId, payloadHash, grantee, level, txHash }`. `compiledArtifactRef` defaults to `attestation-vault`. **Rate limit:** 30/hour per session.

### `revokeDisclosure(payloadHash, grantee, sessionId, contractAddress, compiledArtifactRef?, idempotencyKey?, sponsorSessionId?) → { jobId, status }`

Revoke a previously-granted disclosure (removes the grantee entry on-chain) via the `revokeDisclosure` circuit. Attester-only. The matching `DisclosureGrants` row's `active` flips to `false`. Job result: `{ payloadHash, grantee, txHash }`. **Rate limit:** 30/hour per session.

### `reindexDisclosures(contractAddress, compiledArtifactRef?) → { contractAddress, active, deactivated, reconciledAt }`

Re-read the AttestationVault `disclosures` ledger Map from LIVE on-chain state and reconcile `DisclosureGrants`: the same reconciliation the server-signed grant/revoke path runs internally, exposed on demand. Use it after a WALLET-submitted grant/revoke that bypassed the plugin submission pipeline (browser signs, NIGHTGATE never saw a jobId). Crawler-independent, idempotent, self-healing. `active` is the count of grants present on-chain after reconciliation; returns a clean zero (not a 5xx) when no live provider is configured. **Rate limit:** 60/hour per contract.

### `registerPassport(passportId, ownerId, sessionId, contractAddress, compiledArtifactRef?, idempotencyKey?, sponsorSessionId?) → { jobId, status }`

Pre-register (or re-register) passport ownership via the `registerPassport` circuit. Registrar-only: normally the vault's DEPLOY session (since 0.16.0 the registrar identity is a public constructor argument; NIGHTGATE deploys inject the deploy session's attester id automatically, so the default semantics are unchanged, but an external deployer may nominate a DIFFERENT registrar identity; a non-registrar caller's tx is rejected in-circuit). Assigns the `passportId` (64-hex `Bytes<32>`) to an attester id (`ownerId`), so only that attester may bind or re-bind it via `bindPassport`. This blocks first-bind squatting for registered ids; re-registering an id is the ownership-transfer and squatter-recovery path (registrar re-points the id, the new owner rebinds). Unregistered ids stay open first-come-first-served. Job result: `{ passportId, ownerId, contractAddress, txHash }`. `compiledArtifactRef` defaults to `attestation-vault`. **Rate limit:** 30/hour per session.

### `registerGranteeIdentity(bindingInput, scope?) → { ID, granteeId, bindingKind }`

Bind the authenticated caller (`req.user.id`) to the `Bytes<32>` grantee id the AttestationVault checks, so on-chain grants resolve to this principal at read time. The binding kind is set per-deployment via `cds.requires.nightgate.granteeBinding` (default `wallet`): `wallet` → `bindingInput` is the caller's coin public key (hex); `did` → a DID string; `custom` → the 64-hex grantee id itself. `scope` optionally restricts the binding to one contract/attestation (omit for a global binding). Idempotent on `(userId, scope)`. Requires authentication (401 otherwise). The *proofing* of binding ownership is the consumer's policy.

## Diagnostics

### `getWalletBalance(sessionId) → { shieldedNight, unshieldedNight, dustBalance, registeredNightUtxoCount, totalNightUtxoCount, dustUtxoCount, dustPendingCount, dustPendingValue, dustRestoreCount }`

Read-only snapshot. All balances as decimal NIGHT atoms (or DUST atoms) - strings to preserve `bigint` precision. The dust diagnostics fields (0.15.2) expose the dust sub-wallet's local UTXO view: `dustUtxoCount` is the number of DUST notes the wallet tracks, `dustPendingCount`/`dustPendingValue` are in-flight dust spends awaiting confirmation, and `dustRestoreCount` counts the dust wedge protection's snapshot restores whose re-persist the database CONFIRMED (process-lifetime; a restore that could not be durably persisted is logged but not counted, and the live e2e gates on this counter). A wallet showing `registeredNightUtxoCount > 0` but `dustUtxoCount == 0` and `dustPendingCount == 0` while fee payments keep failing is dust-wedged (leaked in-flight spend) rather than genuinely empty; see the operations guide.

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
  "totalNightUtxoCount": 1,
  "dustUtxoCount": 1,
  "dustPendingCount": 0,
  "dustPendingValue": "0",
  "dustRestoreCount": 0
}
```

**Wallet still syncing:** the read waits at most `NIGHTGATE_WALLET_READ_SYNC_TIMEOUT_MS` (default 10 s) for the facade to reach the indexer tip, then answers `503` with error code `WALLET_SYNCING`. Treat it as retryable: poll again once the prewarm job reports ready. The same gate applies to the fee estimate below.

### `getWalletSyncProgress(sessionId) → { known, caughtUp, appliedIndex, streamTip, behindEvents, eventsPerSecond, etaSeconds, blockHeight, isConnected, indexerFresh, elapsedMs, phase, updatedAt }`

How far the wallet's catch-up has got and how fast it is moving. Poll this instead of guessing from elapsed time: a wallet that has been idle for a day needs a long catch-up, and without these numbers a slow sync and a hung one look identical.

`appliedIndex`, `streamTip` and `behindEvents` count dust LEDGER EVENTS, not blocks, and are decimal strings (`bigint` precision). `etaSeconds` is derived from the current rate and moves around; treat it as an order of magnitude. `known` is `false` until the first sync wait has reported anything, e.g. while the facade is still being built.

**Reading it:** slow but healthy is `appliedIndex` climbing with `eventsPerSecond` above zero. Genuinely stuck is `appliedIndex` unchanged across polls while `elapsedMs` grows, or `isConnected: false`. `indexerFresh: false` means the indexer itself is lagging, so its tip does not count as chain tip.

Cheap and safe to poll during a sync: the answer comes from a snapshot the wallet worker pushes to the main thread about every 15s, so no request reaches the CPU-saturated worker. `updatedAt` says how fresh the snapshot is. The same numbers appear in the server log at INFO under `nightgate:worker` (`genuine-sync [prewarm] ... rate=... eta=...`).

**Rate limit:** 60/min per client IP.

```bash
curl "http://localhost:4004/api/v1/nightgate/getWalletSyncProgress(sessionId='c07b1f0a-...')"
```

Response:
```json
{
  "known": true,
  "caughtUp": false,
  "appliedIndex": "1241903",
  "streamTip": "1262517",
  "behindEvents": "20614",
  "eventsPerSecond": 12.5,
  "etaSeconds": 1649,
  "blockHeight": "1951462",
  "isConnected": true,
  "indexerFresh": true,
  "elapsedMs": 245000,
  "phase": "prewarm",
  "updatedAt": "2026-08-04T09:00:00.000Z"
}
```

### `estimateSendNightFee(sessionId, receiverAddress, amount, ttlIso?) → { fee, toLedger }`

Pre-flight DUST fee for a `sendNight` call. Builds the recipe in the worker (lightweight; no ZK proof generation, no submit), discards it after fee calc. Useful to gate the user on whether dust balance is sufficient before triggering the actual send.

`fee` is DUST atoms as decimal string.

## Indexer / health / metrics

### `getHealth() → { status, chainHeight, indexedHeight, finalizedHeight, lag, finalizedLag, blocksPerSecond, syncStatus }`

Crawler sync state. **This is the crawler's view, not the wallet's.** During wallet-sync runs with `NIGHTGATE_CRAWLER_ENABLED=false`, this returns stale data (the last persisted SyncState row).

### `getSyncStatus() → SyncState`
### `getMetrics() → String`

`getMetrics` returns Prometheus text format. Metric prefix: `odatano_nightgate_*`. Includes chain height, indexed height, sync lag, block throughput, error counts, uptime, sync status (mapped: stopped=0, syncing=1, synced=2, error=3), runtime-topology gauges (`_runtime_topology_valid`, `_runtime_replicas`, `_runtime_database_info`), and background-job gauges (`_jobs_queued`, `_jobs_running`, `_jobs_reconciliation_required`, `_jobs_oldest_queued_seconds`).

### `getLiveness() → { status, timestamp, uptime }`
### `getReadiness() → { ready, crawlerEnabled, checks: { database, crawler, node, runtime } }`

Kubernetes-style probes. `getReadiness` reports `ready: true` when every applicable check passes; a deliberately disabled crawler (the Docker default) passes its `crawler`/`node` checks as not-applicable and is flagged via `crawlerEnabled: false`, so a submission/verification-only deployment is not permanently unready.

### `getReorgHistory(limit?) → ReorgLog[]`

Last `limit` (default 10, max 100) reorg events with depth, detected-at timestamp, rolled-back tx count.

### `pauseCrawler() / resumeCrawler() / reindexFromHeight(height)` - actions

Operator controls, `@requires: 'admin'` (since 0.5.2; unauthenticated or non-admin callers get 401/403). `reindexFromHeight` triggers a rollback to the specified height (including a recompute of the `NightBalances` projection for affected addresses) and a fresh catch-up from there. The read-only status/health/metrics functions above stay unrestricted for K8s probes and Prometheus.

## Analytics

`getBlockCount() / getTransactionCount() / getContractCount() / getAverageTransactionsPerBlock()` - simple aggregate queries over the indexed entities.

## Admin

`invalidateSession(sessionId)` / `invalidateAllSessions()` - force-close sessions. Distinct from `disconnectWallet` in that admin can target any session, not just one the caller owns.

`grantRole(userId, role, scope?, validUntil?)` - grant a disclosure tier (`public_only` | `legitimate_interest` | `authority`) read by the `AttestationService` mixin's `attachDisclosureRole` middleware. Caller must already hold `authority`. This is the **off-chain** tier table (`DisclosureRoles`).

> **On-chain alternative.** `attachDisclosureRole(req, db, { contractAddress, payloadHash? })` resolves the tier from the **on-chain** `DisclosureGrants` ACL instead: it maps the caller (via `GranteeIdentities` → `registerGranteeIdentity`) to a `Bytes<32>` grantee and matches active grants for that contract. With a `contractAddress` the on-chain result is authoritative (no off-chain fallback); without one, the off-chain `grantRole` table applies. The gate is a programmatic middleware - the consumer wires it into the reads it wants to gate.

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
| `1016` | yes (preprod) / no (mainnet) | "Immediately Dropped" - preprod transient, mainnet has a known deterministic-rejection issue |
| `NetworkOrTimeout` | yes | `ECONNREFUSED`, `ECONNRESET`, `ENOTFOUND`, `ETIMEDOUT`, `socket hang up`, `timeout` |
| `ContractTypeError` / `IncompleteCallTxPrivateStateConfig` / `IncompleteFindContractPrivateStateConfig` | no | SDK contract-config errors (classified by the thrown error's `name`) |
| `WalletSigningNotAvailable` | no | Session has no encrypted seed key |
| `<error name>` (default) | no | Any otherwise-unrecognized error - falls back to the thrown error's `name`, assumed non-retryable |

Other failures surface as the **raw node/SDK error** rather than a `classifySubmissionError` code:

- **Custom error `170` (dust validity window)** - raised by the node when the wallet's dust `ctime` is outside the grace window, usually a lagging indexer or a wallet not synced to tip. (`failed assert: predicate false` is the distinct predicate-circuit rejection.)
- **`Wallet.InsufficientFunds`** - raised by the wallet SDK when there's insufficient dust to pay fees, or insufficient NIGHT to satisfy outputs.
- **`MalformedResult`** - thrown by `TransactionSubmitter` when the SDK returns without the expected fields (likely an SDK bug); it is a distinct thrown error, not a `classifySubmissionError` code.

For diagnostic 503s caused by the hosted Midnight indexer, see [docs/operations.md#troubleshooting](operations.md#troubleshooting).
