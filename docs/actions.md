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

### `registerForDustGeneration(sessionId, dustReceiverAddress?) → { txId, changed, reason, registeredCount, totalNightUtxos, dustReceiverAddress, requestedReceiver, registeredUtxosBefore, registeredUtxosAfter, settled, consolidated, message }`

Register the wallet's **unregistered unshielded NIGHT UTXOs** for dust generation.

**The result reports what happened, not what was asked** (0.21.0):

- Registration binds the **address**: once a wallet is registered, every NIGHT arriving there generates dust for the same receiver. A call naming a different receiver on an already-registered wallet therefore changes nothing. It answers `changed: false`, `reason: "already-registered"`, `dustReceiverAddress: null` (a receiver is only echoed when it was applied), `requestedReceiver` and a `message` pointing at `deregisterFromDustGeneration` (deregister, then register again naming the new receiver). The standing receiver is not readable from the wallet SDK, so the server cannot tell an identical re-request from a changed one and does not refuse; the job succeeds with `changed: false`. `reason: "no-night-utxos"` is the other no-op: nothing unshielded to register.
- `registeredCount` counts the **inputs**. One registration over several UTXOs is one transaction and it **consolidates** them (measured: nine 100-NIGHT UTXOs registered as nine, settled as two). One registered UTXO yields one dust note and dust notes are the parallel sponsoring capacity, so the number that matters is `registeredUtxosAfter`: the wallet's registered NIGHT UTXO count observed after the transaction was applied locally (`settled: true`; bounded by `NIGHTGATE_DUST_REGISTER_SETTLE_MS`, default 90 s, else `settled: false` and `null`). `consolidated: true` says the inputs merged.
- **Order matters:** register the wallet first, fund it afterwards in separate payments. Each later payment arrives already registered and stays a separate UTXO (measured: eleven payments, eleven notes). A bulk registration of many existing UTXOs merges them.

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

## Custom tokens

### `mintShieldedTestToken(contractAddress, sessionId, compiledArtifactRef?, idempotencyKey?, sponsorSessionId?) → { jobId, status }`

`compiledArtifactRef` accepts only the bundled `shielded-token` (or may be
omitted): the result is enriched with THIS fixture's domain separator and mint
amount, so a foreign minting contract would execute fine and then be reported
with a wrong `tokenTypeHex`. Other contracts go through `submitContractCall`
plus `deriveTokenType` with their own separator.

Mints the bundled `contracts/shielded-token` test token to the caller's own
zswap public key. NIGHT is unshielded-only, so no NIGHT transfer ever exercises
the zswap prover circuits; this is how you get shielded coins that do, and how a
deployment sanity-checks custom-token support end to end.

Deploy the contract once, then mint into it:

```bash
curl -X POST .../deployContract   -d '{"compiledArtifactRef":"shielded-token","sessionId":"<id>","initialPrivateState":"{}"}'
# -> jobId; poll getJobStatus for contractAddress

curl -X POST .../mintShieldedTestToken   -d '{"contractAddress":"<addr>","sessionId":"<id>"}'
# -> jobId; result { txHash, contractAddress, tokenTypeHex, amount: "100000000" }
```

Each call mints 100000000 atoms. The contract's round counter feeds the coin
nonce, so repeated calls mint distinct coins rather than colliding.

`tokenTypeHex` is the part that makes the balance usable: pass it to
`sendNight(tokenTypeHex: ...)` to transfer the custom token instead of NIGHT.
The wallet has to sync the minted coin first, which takes a few blocks.

### `deriveTokenType(contractAddress, domainSeparator?) → { tokenTypeHex, contractAddress, domainSeparator }` (function)

Compute-only: no wallet, no chain access, no proving.

A minted token is addressed by `rawTokenType(domainSeparator, contractAddress)`,
where the separator is the 32 bytes the contract passes to `mintShieldedToken`
(in Compact, `pad(32, "...")`). Two contracts with the same separator mint
DIFFERENT tokens, and one contract can mint several by using several separators,
so the pair is the identity.

`domainSeparator` takes either the plain string the contract padded (default:
`nightgate:zswap-e2e`, the bundled token's) or 64 hex characters for the padded
bytes verbatim. The echoed `domainSeparator` is always the 64-hex form actually
used, so you can see how your input was interpreted.

This is not restricted to the bundled token: any minting contract's token type
is derived the same way.

## Cross-server fee sponsoring (0.17.0)

Split a contract call in two: the **caller** builds, proves, signs and finalizes
it, the **sponsor** pays the dust and submits. The two halves can run on
different machines with only the serialized transaction between them, so the
caller keeps its signing key and its identity while the sponsor carries the fee.
The full client-side story, including the standalone
`@odatano/nightgate/txbuilder` SDK, is in [txbuilder.md](txbuilder.md).

### `buildSponsorable(contractAddress, circuit, compiledArtifactRef, sessionId, args) → { jobId, status }`

Phase 1, server-side. Builds, proves, balances the caller's own side, signs and
finalizes ONE circuit call, then STOPS before submitting. Poll `getJobStatus`;
the result is `{ finalizedTxB64, serializedBytes }` (roughly 5 KB of base64 for
a vault call). Nothing was submitted and no dust was spent.

A caller who does not run NIGHTGATE at all does this same step locally with the
txbuilder SDK, which is the point of the split.

### `sponsorFinalizedTransaction(finalizedTxB64, sponsorSessionId, idempotencyKey?) → { jobId, status, sessionId }`

Phase 2. Deserializes the caller's fee-unpaid transaction, enforces the
sponsor's policy, balances dust with `sponsorSessionId` and submits. The
response's `sessionId` is the SPONSOR session the job is keyed by; poll
`getJobStatus` with it (an agent-grant caller may not know it otherwise, since
the grant injects the pinned sponsor server-side). Job result:
`{ txHash, circuits, contractAddress }`.

The sponsor never sees a key, a witness or a preimage: the proof is already
done. The policy is a FAIL-CLOSED shape check, not just an allow-list: the
transaction may contain allow-listed contract calls and NOTHING else. A
contract deploy, an unshielded transfer, a zswap offer or caller-side dust
actions riding in the same envelope refuse, as does a transaction whose
structure the inspection cannot read, or one over the size budget
(`NIGHTGATE_SPONSOR_MAX_TX_BYTES`, default 65536; a single vault call is
~5.4 KB). On top of that the allow-list bounds WHICH calls are paid for:

```bash
NIGHTGATE_SPONSOR_ALLOWED_CONTRACTS=<vault addr>,<other addr>
NIGHTGATE_SPONSOR_ALLOWED_CIRCUITS=attest,anchorContentRoot,proveFieldPredicate
```

An empty list means "no restriction", which is only appropriate for a private
deployment. Treat this endpoint as spend authority: whoever can reach it can
make you pay a transaction fee.

**Changeable while the server runs (0.21.0).** A container's environment is
fixed at creation, so a one-line change to these lists used to mean a
recreate and a ~20 min cold sponsor pool. Two layers replace that:

- **Policy follows the grant.** `createAgentGrant(..., allowedContracts,
  allowedCircuits)` records which contracts and circuits THAT consumer may
  have sponsored. A sponsored call made with the grant's token runs under the
  intersection of the platform lists and the grant's; an absent grant list
  inherits the platform list, an empty platform list lets the grant be the
  whole policy. Onboarding a consumer is then one call, and revoking the
  grant removes its sponsoring reach with it. Two non-empty lists that share
  nothing refuse at admission with `403 SPONSOR_POLICY_EMPTY` (a grant can
  narrow the floor, never widen it).
- **Policy file for the platform floor.** Set `NIGHTGATE_SPONSOR_POLICY_FILE`
  to a JSON file `{ "allowedContracts": [...], "allowedCircuits": [...] }`
  (for the Docker image, under the data volume). It is re-read on every
  sponsored call behind an mtime cache and replaces the two env variables
  while set. Fail-closed: an unreadable or invalid file keeps the last good
  policy in force, and with none loaded yet every sponsored call answers
  `503 SPONSOR_POLICY_UNAVAILABLE`; it never falls back to "allow any".
- **Sponsored deploys, a distinct right.** A consumer deploying its own
  contract used to need a funded wallet with dust first, the one step
  sponsoring exists to remove. `createAgentGrant(..., allowDeploy: true,
  maxDeploys?)` lets the sponsor also pay for a contract DEPLOY the caller
  built and signed with its own key (txbuilder `buildDeploySponsorable`; the
  caller owns the contract, the sponsor never sees a key). Off by default,
  never implied by an action list, and gated twice: the server's floor must
  open it (`NIGHTGATE_SPONSOR_ALLOW_DEPLOY=true`, or `allowDeploy` in the
  policy file) AND the grant must carry it with deploy budget left
  (`maxDeploys`, default 1, a lifetime count separate from `maxJobsPerDay`,
  because a deploy writes verifier keys on chain and costs a multiple of a
  call). A deploy is not matched against `allowedContracts` (the address does
  not exist yet); it has its own byte ceiling
  (`NIGHTGATE_SPONSOR_MAX_DEPLOY_BYTES`, default 40960), and at most ONE
  deploy per sponsored transaction. The budget is reserved at the
  submit-intent, before the sponsor broadcasts, in one database transaction
  with the attempt row and the job's transition: two parallel deploys under
  a `maxDeploys: 1` grant cannot both go out, a crash cannot leave a
  reservation without its attempt, and an attempt the node provably rejects
  is closed and refunded together. A deploy that lands but fails on chain
  keeps its reservation (the fee was paid). After the deploy lands the
  address is recorded in the grant's `deployedContracts` and is sponsorable
  ON TOP of `floor ∩ grant` (no static allow-list could have named it), so the
  follow-up calls are sponsorable at once, whatever the platform floor says.
  That includes the circuit list (0.21.2): calls on a grant-deployed address
  are exempt from `allowedCircuits`, whose names belong to the shared
  contracts, not to the caller's own; the contract list and the byte
  ceiling still apply. Contract maintenance updates are never sponsored.

**Pool + failover (0.17.2).** The sessions in `NIGHTGATE_FEE_SPONSOR_SESSION`
form a lease pool: one in-flight dust spend per wallet, callers queue on the
pool (`NIGHTGATE_SPONSOR_LEASE_WAIT_MS`, default 120s), and a sponsor that
fails retryably (cold facade, sync gap, stale dust) is benched for
`NIGHTGATE_SPONSOR_COOLDOWN_MS` while the job tries the next one. Omit
`sponsorSessionId` (or pass the pool sentinel
`00000000-0000-0000-0000-706f6f6c0000`, a reserved UUID because the field is
Edm.Guid) to use the pool; an explicit session stays exact. The pool members
are warmed one after another at boot (0.18.0), so a restart does not hand the
first jobs a cold sponsor. Grants may pin the
sentinel as `sponsorSessionId`, but then only `sponsorFinalizedTransaction` /
`sponsorUnboundTransaction` are grantable (other actions cannot use the pool);
`getJobStatus` polls under the
sentinel (concrete member ids are normalized to it). Idempotency keys are
scoped per caller. Throughput scales
with the NUMBER of pool wallets, not with one wallet's balance.

The caller's TTL applies. `buildSponsorable` (and the SDK's `ttlMinutes`,
default 30) sets it; a transaction handed over too late is rejected by the node.

### `sponsorUnboundTransaction(unboundTxB64, sponsorSessionId, idempotencyKey?) → { jobId, status, sessionId }`

Phase 2, PARALLEL channel (0.18). Takes the UNBOUND (pre-binding) proven and
signed transaction the txbuilder SDK returns for `buildSponsorable({ bind:
false })`, applies the same fail-closed shape check, allow-list, pool, grant and
idempotency rules as `sponsorFinalizedTransaction`, then locks ONE free dust
BACKING of the sponsor wallet, builds and proves a dust-only spend against it,
merges it into the caller's transaction, binds and submits. Job result:
`{ txHash, circuits, contractAddress, note }` (`note` = the backing paid from).

What makes it parallel: the sponsor's proving and submit run outside the
per-wallet lock (only the fast dust build is serialized), each in-flight submit
uses its own node client, and one wallet sponsors as many transactions at once
as it has DISTINCT registered dust backings (NIGHT UTxOs). Same-backing
requests queue on the backing lock (`NIGHTGATE_BACKING_WAIT_MS`, default 5 min);
a lost dust race (`1010/170`, `1010/196`) is rebuilt and resubmitted on the
same sponsor (`NIGHTGATE_SPONSOR_DUST_RETRIES`, default 4, backoff
`NIGHTGATE_SPONSOR_DUST_BACKOFF_MS`, default 5000). Job concurrency is the
heavy cap (`cds.requires.nightgate.jobs.concurrency.heavy`, default 4). The
sponsor proves its dust spend with its proving service (the proof server in
server mode) and returns once the transaction is in a block
(`NIGHTGATE_SPONSOR_WAIT=finalized` waits for finality instead); a watch that
never fires is abandoned after `NIGHTGATE_SUBMIT_WATCH_TIMEOUT_MS` (default 60 s)
and settled by an indexer lookup. Live on
preprod: 4 sponsorings from one wallet, 4 backings, 3 of them in one block.

Two things it does NOT change: concurrent writes to the SAME contract state
still conflict at the ledger, and mixing bound and unbound sponsoring on ONE
sponsor wallet is not recommended (the bound balancer does not see the backing
locks; one side rejects and self-heals). The first is a property of Midnight's
contract model, not of sponsoring: contract state is account-style (a shared
value updated in place, see
[ledgers](https://docs.midnight.network/concepts/ledgers)), and every call
carries a transcript "read X, wrote Y" that the ledger applies only if X still
holds (see [smart contract
security](https://docs.midnight.network/compact/smart-contract-security)). Two
callers that built against the same X race; the first to land changes X and the
second is rejected at admission (`1010/104`, or pool status Invalid) and must
REBUILD against the new state, resubmitting the same bytes never helps. The
node validates against the best block, not against the pool, so a transaction
built against a predicted post-tx1 state can only be submitted once tx1 is in a
block. Parallelism is therefore across distinct contracts (one vault per
tenant, for example); within one contract, serialize per caller or batch the
calls into one transaction (`submitContractCallBatch`). Concretely for this
action: when two sponsored calls on the same contract land in the same block,
the loser's job fails with `errorCode` from the ledger result
(`PARTIAL_SUCCESS`, the call segment did not apply; the sponsor paid the fee)
and the transaction identifier; the sponsor does NOT retry it (re-attaching
fresh dust to the same caller bytes is rejected at admission), the caller
rebuilds the call against the current state and submits again. A transient
dust race on the sponsor's side (`1010/170`, `1010/196`) IS retried by the
sponsor, transparently.

### `probeCrossServerSponsor(contractAddress, circuit, compiledArtifactRef, sessionId, args, sponsorSessionId) → { jobId, status }`

Runs both phases in one job (build, serialize, deserialize, sponsor, submit) as
a deployment self-check for a sponsor operator. Result:
`{ txHash, serializedBytes, roundTrip }`.

A zero-funded caller session needs no wallet sync at all; set
`NIGHTGATE_SPONSORED_CALLER_SYNC=skip` so a throwaway caller identity is usable
within seconds instead of minutes.

## Document anchoring

**Concurrency note (applies to every attest path, including wallet/txbuilder-submitted):** every `attest`/`attestGuarded` call reads and increments the vault's GLOBAL attestation sequence counter (part of the 0.16 front-running protection), so two attest transactions landing in the same block window conflict regardless of attester: the first applies, the rest finalize as failed contract calls WITH the fee spent (`CHAIN_EXECUTION_FAILED`). Do not fire concurrent attests against one vault and do not blind-retry on that failure. Anchor sequentially, or put multiple calls into ONE transaction via `submitContractCallBatch` / the batch attestation action (one state transition, one fee event).

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

Canonical JSON (recursively key-sorted) → blake2b-256 `payloadHash` (the value `anchorDocument` anchors), plus a SALTED Merkle `contentRoot` of depth log2(width) (4 on the 16-slot default, 5 on `attestation-vault-32`) over the ORDERED `proofFieldsJson` list (leaf index = list position; keep the order stable across anchor and proof) with per-field inclusion paths. `proofFieldsJson` is up to WIDTH `{ field, kind?, scale? }` entries (16 default, 32 with `compiledArtifactRef: 'attestation-vault-32'`): `kind: 'uint'` (default; numeric, scaled by `scale`, default 1000) or `kind: 'bytes'` (string value, entered as the blake2b-256 digest of the EXACT string; feeds the equality/membership actions; `scale` not allowed). `field` is a dot-separated path (numeric segments index arrays; a literal top-level key containing dots wins). Every leaf carries a per-slot salt derived from a per-document 32-byte seed (`saltSeed`: random by default, caller-supplied for a deterministic re-prepare of an already-anchored payload); absent values occupy the salted absent leaf (padding key `nightgate/empty-leaf/v2` ASCII zero-padded) and are reported in `emptyFields`, so a shared leaf layer reveals neither values nor the presence pattern. Leaf/node/descriptor hashing goes through the contract artifact's exported pure circuits, so root and schemaId are byte-identical to the in-circuit recompute. `fields` is a JSON array of `{ field, fieldKey, kind, value?, valueDigest?, salt, siblings, dirs }` (the `salt` feeds every single-field proof action as `fieldSalt`). `schemaId` is the schema ROOT over the width slot descriptors `{ fieldKey, kind, scale }` (returned as `schema`); it is anchored next to the content root and PROVEN by the comparison circuit. The schema id covers EXACTLY field keys, kinds, scales and their order, nothing from the document body: two documents prepared with identically-shaped field lists share ONE schemaId. When splitting a larger panel across several segment documents, put the segment into the field path itself (e.g. `seg02.locus03` instead of `locus03`) so each segment anchors a distinct, self-identifying schema; the panel name inside the document does not reach the schema id. `opening` (`{ saltSeed, slots[width] }`) is the cross-root witness bundle: STORE it with the document; losing the seed makes the anchored root unprovable, leaking it makes shared leaf hashes dictionary-testable. **Rate limit:** 120/hour per client.

### `prepareMembershipSet(allowedValuesJson, value?, valueDigest?, compiledArtifactRef?) → { setRoot, memberCount, setSiblingsJson?, setDirsJson? }`

Canonical membership-set helper for `issueFieldMembershipAttestation` and `verifyPredicateState`. Builds the deterministic depth-6 set tree over an allow-list, so any party recomputes the same `setRoot` from the published list alone. Canonical rule: blake2b-256 each value (exact string), dedupe, sort ascending, pad to 64 slots by repeating the last member digest, leaf-wrap with the contract's `setLeafHash` pure circuit. Padding repeats a REAL member on purpose: every leaf must be a member digest, or the padding constant itself would be provable as a member of any non-full list. More than 64 DISTINCT values is a 400. Without `value`/`valueDigest`: returns `{ setRoot, memberCount }` (the verifier lane). With one of them: additionally the member's inclusion path (`setSiblingsJson`/`setDirsJson`; witness material, the matched slot narrows the hidden value); 400 when the value is not in the list. **Rate limit:** 120/hour per client (shared with `prepareDocumentProof`).

Consumers who need the canonical rule OUTSIDE a server context (anonymous read-side verifiers, browser bundles, unit tests pinning a claim catalog) should import the session-free `@odatano/nightgate/set-root` subpath instead of re-implementing it: `import { buildMembershipSet, membershipPathFor, canonicalSetDigests, SET_DEPTH, MAX_SET_VALUES } from '@odatano/nightgate/set-root'`. It is dependency-clean (no CAP, no Node builtins; loads in Node CJS/ESM and browser bundlers), takes the artifact's `setLeafHash`/`nodeHash` pure circuits as a parameter, and produces byte-identical roots to this action.

## ZK predicate attestations

Prove statements about anchored field values without revealing them (on-chain-verified): numeric predicates against a public threshold, bytes equality against a public digest, and set membership in a public allow-list. See [the AttestationVault contract](../contracts/attestation-vault). Every claim kind is root-bound; the commitment-only `issuePredicateAttestation` lane (commitValue/provePredicate) was removed in 0.16.0 because its on-chain commitment was overwritable while recorded claims did not embed it.

**Width variants:** every document-bound action takes its tree dimensions from the `compiledArtifactRef`'s registration (`slotWidth`, default 16). With `compiledArtifactRef: 'attestation-vault-32'` a document carries up to 32 provable fields under ONE root (depth-5 inclusion paths of 5 siblings/dirs, 32-entry schema/opening lists, `allowedMask` up to 32 bits, `k` up to 32), which is what a global "at least k of N differ" claim over a 17-32-field panel needs. Everything else is unchanged: same circuits, same claim maps, identical deploy cost; `proveDocumentComparison`'s prover doubles (72.9 MB, ~2x proving time) and the content-tree circuits (equality/membership/predicate) grow moderately with the deeper fold, while the attest/anchor/grant provers stay byte-identical. Cross-root proofs work only between documents of the SAME width, and both variants are separate deployed contracts: pick the width per document family and keep it. The 16-slot default behaves exactly as before.

**Getting the 32er prover keys.** The npm package ships `attestation-vault-32` with its contract module, verifier keys and zkir, but not its 113 MB of prover keys (with them the tarball exceeds what the registry accepts). Deploying the contract and verifying its claims crawler-free need nothing else; proving its circuits on this machine, and serving them to browser provers over `/zk-config`, needs the keys on disk. Fetch them once, before the first proof, and restart the server:

```bash
npx nightgate-fetch-keys attestation-vault-32
# or from a NIGHTGATE that already has them:
npx nightgate-fetch-keys attestation-vault-32 --from https://host/zk-config/attestation-vault-32
```

The default source is the release's own git tag, whose directory layout is byte-for-byte the `/zk-config` layout. Prover keys are part of the artifact GENERATION digest, so adding them changes what the alias resolves to: evidence recorded before the fetch fails the generation guard by design. Container images build from the repo and already contain the keys.

### `issueFieldPredicateAttestation(payloadHash, fieldKey, value, fieldSalt, predicate, threshold, sessionId, contractAddress, contentRoot?, schemaId?, siblingsJson?, dirsJson?, unit?, compiledArtifactRef?, idempotencyKey?, sponsorSessionId?) → { jobId, status, predicateAttestationId }`

Field-bound predicate proof: the proven value is cryptographically bound to a SPECIFIC passport field via Merkle inclusion against an anchored content root, so a verifier knows the value came from THIS passport's `fieldKey`, not an arbitrary committed number. The caller builds the content root + inclusion path off-chain with the contract's exported `pureCircuits` (hashing matches in-circuit). If `contentRoot` is supplied it is anchored first (`anchorContentRoot`, together with the mandatory `schemaId` from `prepareDocumentProof`), then `proveFieldPredicate` runs with the Merkle witnesses. `value` is the scaled integer field value (witness only, never persisted); `value`/`threshold` must fit Uint<64>. `siblingsJson`/`dirsJson`: JSON arrays of the depth-log2(width) inclusion path (4 × 64-hex siblings and 4 booleans on the 16-slot default, 5 each on `attestation-vault-32`). Job result: `{ predicateAttestationId, payloadHash, claim, proof }` (PAC-envelope shape). **Rate limit:** 10/hour per session.

### `issueFieldPredicateAttestationBatch(payloadHash, claimsJson, sessionId, contractAddress, contentRoot?, schemaId?, compiledArtifactRef?, idempotencyKey?, sponsorSessionId?) → { jobId, status, claims, droppedDuplicates }`

Batch pendant to the single field actions: prove up to 8 field-bound claims on ONE passport in ONE transaction (one balancing round, one submit, one confirmation wait, one fee event; with `sponsorSessionId` one dust spend for the whole batch). `claimsJson` entries may MIX the five claim kinds, discriminated by `predicate`: numeric `{ fieldKey, value, salt, siblings, dirs, predicate: 'lessOrEqual'|'greaterOrEqual', threshold, unit? }`, equality `{ fieldKey, expectedValue|expectedDigest, salt, siblings, dirs, predicate: 'bytesEquality' }`, membership `{ fieldKey, value|valueDigest, salt, allowedValues | setRoot+setSiblings+setDirs, siblings, dirs, predicate: 'setMembership' }`, cross-root integrity `{ predicate: 'documentIntegrity', payloadHashB, allowedMask, schema, openingA, openingB }`, cross-root diff `{ predicate: 'documentDiff', payloadHashB, k, schema, openingA, openingB }`, each validated like its single action. The cross-root kinds carry no fieldKey/inclusion path; document A is the batch `payloadHash`, and an in-batch `contentRoot` anchor is document A's root (document B's must already be anchored). If `contentRoot` is supplied it is anchored (with the mandatory `schemaId`) as the FIRST call of the SAME batch (segment ordering pins the anchor ahead of the proofs) and occupies one of the 8 call slots (max 7 claims with anchor). Exact duplicate claim tuples (numeric: fieldKey+threshold+predicate, equality: fieldKey+expectedDigest, membership: fieldKey+setRoot, integrity: payloadHashB+allowedMask, diff: payloadHashB+k) are dropped server-side (`droppedDuplicates`); claim keys are idempotent on-chain, so this is only a proving-time optimization. One `PredicateAttestations` row per claim, all sharing one `provenTxHash` on success; `claims` in the response is a JSON array of `{ predicateAttestationId, fieldKey, predicate, ... }` with the kind's statement fields. Proving work stays additive (N proofs = N provings, sequential). Failure: a false claim fails at LOCAL proving time (nothing submitted, no row proven); after submission the ledger's fallible phase can finalize PARTIAL_SUCCESS, in which case the job fails with `OnChainStatus:...` and callers verify per claim via `verifyPredicateAttestation` (crawler-free, no txHash needed). **Rate limit:** counts N claims against the shared 10/hour predicate budget, not one call.

### `issueFieldEqualityAttestation(payloadHash, fieldKey, expectedValue|expectedDigest, fieldSalt, sessionId, contractAddress, contentRoot?, schemaId?, siblingsJson?, dirsJson?, compiledArtifactRef?, idempotencyKey?, sponsorSessionId?) → { jobId, status, predicateAttestationId }`

Field-bound EQUALITY proof for a bytes-valued (string) field (`proveFieldEquality`): the anchored content root carries, at `fieldKey`, exactly the value whose blake2b-256 digest is `expectedDigest`. Pass exactly one of `expectedValue` (raw string; the server digests the EXACT string, no trimming) or `expectedDigest` (64 hex). The digest is PUBLIC (it is the statement), so this is an authenticity/binding proof, not a confidentiality feature: for low-entropy values the digest is dictionary-guessable. The field must have entered the content root as a bytes leaf (`prepareDocumentProof` with `kind: 'bytes'`); `siblingsJson`/`dirsJson` are the depth-log2(width) path as on the numeric action. If `contentRoot` is supplied it is anchored first (requires `schemaId`). **Rate limit:** 10/hour per session (shared predicate budget).

### `issueFieldMembershipAttestation(payloadHash, fieldKey, value|valueDigest, allowedValuesJson | setRoot+setSiblingsJson+setDirsJson, fieldSalt, sessionId, contractAddress, contentRoot?, schemaId?, siblingsJson?, dirsJson?, compiledArtifactRef?, idempotencyKey?, sponsorSessionId?) → { jobId, status, predicateAttestationId }`

Field-bound SET-MEMBERSHIP proof (`proveFieldMembership`): the field's HIDDEN value is one of a public allow-list, without revealing which one. Two Merkle folds over the same witnessed digest: the depth-log2(width) content fold binds it to THIS passport's `fieldKey`, the DEPTH=6 set fold proves it is a leaf of the canonical membership-set tree (up to 64 distinct values; see `prepareMembershipSet` for the canonical rule). Pass exactly one of `value` (raw string) or `valueDigest` (64 hex); both stay witness material, never persisted. Supply the list as `allowedValuesJson` (the server builds root + path and rejects 400 when the value is not in the list, BEFORE any proving) or precomputed as `setRoot` + `setSiblingsJson`/`setDirsJson` (6 × 64-hex siblings; 6 booleans). **Rate limit:** 10/hour per session (shared predicate budget).

### `issueDocumentIntegrityAttestation(payloadHashA, payloadHashB, allowedMask, schemaJson, openingAJson, openingBJson, sessionId, contractAddress, contentRootA?, contentRootB?, schemaId?, compiledArtifactRef?, idempotencyKey?, sponsorSessionId?) → { jobId, status, predicateAttestationId }`

Cross-root INTEGRITY proof (`proveDocumentComparison` mode 0): document B differs from document A ONLY in the slots flagged by the packed width-bit `allowedMask` (16 bits default, 32 bits on `attestation-vault-32`; bit i = slot i may differ; 0 = identical values; the all-ones mask is rejected as vacuous), both bound to their anchored content roots, values hidden. The canonical version-integrity claim for re-anchored passports. v4 witness model: `schemaJson` is the SHARED width-entry descriptor list and `openingAJson`/`openingBJson` are the documents' full openings (`prepareDocumentProof` returns them as `schema` and `opening`); the circuit recomputes the schema root AND both content roots in-circuit, so the anchored schema id is PROVEN to describe the trees (a forged schema label fails the proof) and the per-slot comparison runs on values under the shared schema. Both documents MUST be anchored under the SAME `schemaId`; a slot that changed, appeared or disappeared outside the mask fails at LOCAL proving time, nothing submitted. `payloadHashA != payloadHashB` (also asserted in-circuit); (A, B) order is part of the claim key. Optional `contentRootA`/`contentRootB` anchor first with `schemaId` (each a separate transaction; the batch action's `documentIntegrity` kind is the one-transaction path). **Rate limit:** 10/hour per session (shared predicate budget).

### `issueDocumentDiffAttestation(payloadHashA, payloadHashB, k, schemaJson, openingAJson, openingBJson, sessionId, contractAddress, contentRootA?, contentRootB?, schemaId?, compiledArtifactRef?, idempotencyKey?, sponsorSessionId?) → { jobId, status, predicateAttestationId }`

Cross-root DISTINCTNESS proof (`proveDocumentComparison` mode 1): at least `k` (1..width) of the width aligned slots (16 default, 32 on `attestation-vault-32`) differ between two anchored documents, without revealing which slots or what values. k=1 is "provably not the same document". Same v4 witness model as the integrity mode (`schemaJson` + `openingAJson`/`openingBJson`; witness material, never persisted). A counted difference is a value or presence change under the shared schema; both-empty compares equal; padding slots never count. Schema parity is structural: ONE witnessed descriptor list must fold to BOTH anchored schema ids. Fewer than k actual differences fail at LOCAL proving time. **Rate limit:** 10/hour per session (shared predicate budget).

### `verifyPredicateAttestation(predicateAttestationId) → { verified, predicate, threshold, unit, expectedDigest, setRoot, payloadHashB, allowedMask, provenTxHash, provenAt }` (function)

`verified: true` iff `provenTxHash` resolves to a `SUCCESS` result, or confirmed directly against live contract state when the crawler is disabled/lagging (the claim key is recomputed from the row; numeric rows check `field_predicate_results`, `bytesEquality` rows `field_equality_results`, `setMembership` rows `field_membership_results`, `documentIntegrity` rows `document_integrity_results`, `documentDiff` rows `document_diff_results`; a diff row's k rides in `threshold`).

## Crawler-free state verification

Read LIVE contract state via `queryContractState`: no block crawler, no local txHash, no server-side row required. Made for wallet-submitted transactions NIGHTGATE never saw (browser signs, no jobId). Both return clean negatives (`verified: false`, not a 5xx) when the state is absent or no live provider is configured. `network` (optional, e.g. `preview` | `preprod`) reads ANOTHER network's public indexer instead of the configured one (stateless, wallet-free; unknown values are a 400; per-network endpoints via `cds.requires.nightgate.networks.<network>.*`).

**Independent verification (no NIGHTGATE trust required):** these functions are conveniences, not trust anchors. Everything they check is recomputable by a third party from public data alone: pull the vault's contract state from the public indexer, recompute the claim key (`persistentHash` over the claim struct: for a bytes-equality claim `{ payloadHash, fieldKey, expectedDigest, epoch }`, with `epoch` read from the same state's `attestation_seqs` map), and look it up in the matching result map (`field_predicate_results`, `field_equality_results`, `field_membership_results`, `document_integrity_results`, `document_diff_results`). The claim structs and hashing rules are the Compact source, which ships in the npm package under `contracts/attestation-vault/src/`, so a certifying party can audit the rule and run the check with their own tooling end to end.

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

### `getSponsorPoolStatus() → [{ sessionId, configured, usable, dustBalance, unshieldedNight, totalNightUtxoCount, registeredNightUtxos, dustNotes, pendingDustNotes, dustRestoreCount, caughtUp, lastError }]`

Fee-sponsor pool health in one call (0.20.0). Covers every session listed in `NIGHTGATE_FEE_SPONSOR_SESSION` / `cds.requires.nightgate.feeSponsorSessions`, so a caller no longer has to know those ids out of band and fan out `getWalletBalance` per sponsor.

`dustNotes` **is** the parallelism: unbound sponsoring locks one free dust note per in-flight transaction, so N notes means N concurrent sponsorships from one wallet. It counts SPENDABLE notes, so a note already committed to an in-flight spend is not in it (it shows up in `pendingDustNotes` instead). It is not `registeredNightUtxos`, which counts the sponsor own NIGHT registered for dust generation: dust generation is delegable, so a foreign wallet pointing its NIGHT here grows the notes while the own registrations stay put. `pendingDustNotes > 0` means a spend is in flight or a note leaked (the wedge signature), `dustRestoreCount` counts how often the wedge protection fired, and `usable` is the short answer (spendable notes present and dust above zero).

Listed for every authenticated caller, because every authenticated caller may already use these sponsors and a dry pool is why their submissions fail. `dustBalance` and `unshieldedNight` are null unless the caller is an admin or owns the session; the counts and operational flags stay readable either way. An unreadable sponsor comes back as a row with `lastError` rather than failing the call, so one bad entry cannot hide the rest of the pool.

**Not available to agent tokens.** A token request runs as the grant's operator, so allowing it would have let any grant, whatever session it is bound to, read the pool status of every sponsor session that operator owns, exact balances included. It is neither always-allowed nor allow-listable and returns 403.

The read never builds a cold wallet facade. A sponsor is treated as cold only when it is NEITHER resident in this process NOR has reported sync progress, and such a row comes back with `lastError` saying so; a facade restored from persisted state at the tip is resident without ever reporting progress, and it IS read. A status endpoint that creates work lets a polling monitor accumulate worker calls that outlive their request. Each sponsor is additionally capped by `NIGHTGATE_SPONSOR_STATUS_TIMEOUT_MS` (default 20 s), and the cap reaches the worker RPC itself rather than only the caller's wait.

**Rate limit:** 60/min per client IP.

Response:
```json
[
  {
    "sessionId": "cf5a952e-744a-4543-ac57-5ee7c97db6ab",
    "configured": true,
    "usable": true,
    "dustBalance": "12065772407328298858",
    "unshieldedNight": "950000000",
    "totalNightUtxoCount": 4,
    "registeredNightUtxos": 4,
    "dustNotes": 11,
    "pendingDustNotes": 0,
    "dustRestoreCount": 0,
    "caughtUp": true,
    "lastError": null
  },
  {
    "sessionId": "ccfbe02d-7e0e-458b-8a12-3738c75c8f09",
    "configured": true,
    "usable": false,
    "dustBalance": null,
    "unshieldedNight": null,
    "totalNightUtxoCount": 0,
    "registeredNightUtxos": 0,
    "dustNotes": 0,
    "pendingDustNotes": 0,
    "dustRestoreCount": 0,
    "caughtUp": false,
    "lastError": "sponsor facade is not warm yet; ask again once it has synced"
  }
]
```

### `getWalletSyncProgress(sessionId) → { known, caughtUp, appliedIndex, streamTip, behindEvents, eventsPerSecond, etaSeconds, blockHeight, isConnected, indexerFresh, elapsedMs, phase, updatedAt, lastProgressAt, staleSeconds, stale, jobId, jobStatus, restoredFromSnapshot, snapshotSavedAt, facadeBuiltAt }`

How far the wallet's catch-up has got and how fast it is moving. Poll this instead of guessing from elapsed time: a wallet that has been idle for a day needs a long catch-up, and without these numbers a slow sync and a hung one look identical.

`appliedIndex`, `streamTip` and `behindEvents` count dust LEDGER EVENTS, not blocks, and are decimal strings (`bigint` precision). `etaSeconds` is derived from the current rate and moves around; treat it as an order of magnitude. `known` is `false` until the first sync wait has reported anything, e.g. while the facade is still being built.

**Reading it:** slow but healthy is `appliedIndex` climbing with `eventsPerSecond` above zero. Genuinely stuck is `appliedIndex` unchanged across polls while `elapsedMs` grows, or `isConnected: false`. `indexerFresh: false` means the indexer itself is lagging, so its tip does not count as chain tip.

Cheap and safe to poll during a sync: the answer comes from a snapshot the wallet worker pushes to the main thread about every 15s, so no request reaches the CPU-saturated worker. The same numbers appear in the server log at INFO under `nightgate:worker` (`genuine-sync [prewarm] ... rate=... eta=...`).

**Is anyone still syncing?** (0.21.0) The snapshot outlives the wait that produced it, so a poller could read plausible numbers for hours after the prewarm job had ended. `staleSeconds` is the age of the reading and `stale` is true past `NIGHTGATE_SYNC_PROGRESS_STALE_S` (default 60 s, four push intervals): a stale snapshot describes a sync nobody is running. `jobId`/`jobStatus` name the session's latest prewarm job, so the next call is `getJobStatus(jobId)` rather than a guess. `lastProgressAt` is when `appliedIndex` last advanced; unchanged while `updatedAt` keeps moving is a stalled sync, which the prewarm now fails on its own after `NIGHTGATE_PREWARM_STALL_MS` (default 10 min) with a message that says so. A slow-but-moving sync runs up to the absolute ceiling `NIGHTGATE_PREWARM_SYNC_TIMEOUT_MS` (default 12 h) and its failure message says that instead.

**Minutes or hours?** (0.21.0) A restart destroys the session row, not the wallet's sync state: that is persisted per account (`WalletSyncStates`) and restored on the next `connectWallet`, so a reconnect applies only the delta since the last save (measured: 4 s when fresh, ~6 min after an hour of chain). Only a wallet with no usable snapshot syncs from zero (3 to 4 h for one with history). `restoredFromSnapshot` says which of the two is running, `snapshotSavedAt` what it resumes from, `facadeBuildStartedAt` when this process started building the facade and `facadeBuiltAt` when the worker finished (`null` while it is still deserialising the snapshot: a grown dust state is large, live 15 MB took ~7 min to deserialise and then 4 s to catch up, so the fields are set BEFORE the worker init and already say what is being restored). All four are `null` while nothing is being built. The same fact is one INFO line under `nightgate:facade` (`sync state RESTORED from snapshot saved ...` / `COLD START`, then `built in Ns`).

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
  "updatedAt": "2026-08-04T09:00:00.000Z",
  "lastProgressAt": "2026-08-04T08:59:57.000Z",
  "staleSeconds": 4,
  "stale": false,
  "jobId": "9e2c1c1a-...",
  "jobStatus": "running"
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

`getMetrics` returns Prometheus text format. Metric prefix: `odatano_nightgate_*`. Includes chain height, indexed height, sync lag, block throughput, error counts, uptime, sync status (mapped: stopped=0, syncing=1, synced=2, error=3), runtime-topology gauges (`_runtime_topology_valid`, `_runtime_replicas`, `_runtime_database_info`), background-job gauges (`_jobs_queued`, `_jobs_running`, `_jobs_reconciliation_required`, `_jobs_oldest_queued_seconds`) and wallet-worker gauges (`_wallet_worker_running`, `_wallet_worker_inflight_rpcs`, `_wallet_worker_exits`).

**Scrapers want the plain route, not this function.** Over OData the body arrives wrapped as `{"@odata.context":"...","value":"# HELP ..."}`, which no Prometheus can parse. Since 0.20.0 the identical text is served as `text/plain` at `GET /nightgate/metrics`, alongside `GET /nightgate/health` and `GET /nightgate/ready` for probes that cannot express an OData function call. Same payloads, computed by the same code.

Those routes are mounted on the express app during CAP's `bootstrap` event, **before** CAP attaches its authentication middlewares to the service paths, so whatever protects the OData surface does not protect them. Two consequences, both deliberate:

- **Fail-closed.** Nothing is mounted until the operator says how the routes may be reached: `NIGHTGATE_STATUS_TOKEN=<secret>` (then every request needs `Authorization: Bearer <secret>`, compared in constant time) or `NIGHTGATE_STATUS_ROUTES=public` for deliberate anonymous access. Neither set means no extra HTTP surface. `NIGHTGATE_STATUS_ROUTES=off` disables them outright.
- **Namespaced.** Everything lives under a prefix, `/nightgate` by default and configurable via `NIGHTGATE_STATUS_ROUTES_PREFIX`. NIGHTGATE is a plugin in someone else's express app, and CAP registers its own `/health` right after the bootstrap event, so a handler on a generic path would shadow the host's own liveness endpoint and let a NIGHTGATE database problem decide a foreign app's health.

Error responses carry no internal detail; the reason goes to the log.

### `getRuntimeInfo() → { version, network, provingMode, instanceId, runtimeMode, databaseKind, uptime, contracts[] }`

What this process IS, including two digests per registered contract. `artifactDigest` is the generation this process **loaded** and stamped onto persisted commands; `currentDigest` is what the files hash to **right now**, which is what `resolveContract` compares against. `digestStale: true` means they disagree: artifacts were replaced under the running server, and every write job fails the generation guard until it restarts. Reporting only the cached digest would have hidden exactly the failure this function exists to explain. A contract whose artifact does not load returns both digests as null with `digestError` set.

Hashing the registered artifacts is expensive (roughly 200 MB for the bundled set), so `currentDigest` is memoised behind a per-file stat fingerprint (size, mtime, ctime, inode, mode) and re-hashed regardless once the entry is older than `NIGHTGATE_ARTIFACT_DIGEST_MAX_AGE_MS` (default 5 minutes). `resolveContract` does not use that cache: its check runs against the bytes it is about to import. `@requires: 'authenticated-user'`, rate-limited to 30/min per client.

### `getWorkerStatus() → { started, running, inFlightRpcs, exitCount, lastExitCode, lastExitAt, rpcTimeoutMs, facadeCount, facades[] }`

Wallet worker health at process level, as opposed to `getWalletSyncProgress(sessionId)` per facade. A climbing `exitCount` means the submission side is crash-looping; an `inFlightRpcs` that only grows is a stall. Deliberately its own function and **not** an entry in `getReadiness().checks`: a worker that is merely busy must not take the process out of rotation.

`facades[]` is **admin only** and empty for everyone else; `facadeCount` is always populated. The per-facade `sessionId` is the wallet cacheKey, an accountId derived from wallet material and stable across sessions, so handing the list to every authenticated caller would disclose which wallets the process holds, across tenants. `@requires: 'authenticated-user'`.

### `getLiveness() → { status, timestamp, uptime }`
### `getReadiness() → { ready, crawlerEnabled, checks: { database, crawler, node, runtime, initialization }, initializationMode }`

Kubernetes-style probes. `getReadiness` reports `ready: true` when every applicable check passes; a deliberately disabled crawler (the Docker default) passes its `crawler`/`node` checks as not-applicable and is flagged via `crawlerEnabled: false`, so a submission/verification-only deployment is not permanently unready.

`initialization` (0.20.0) is true only once `initialize()` has **completed successfully**: it requires both that the process finished initialising and that it did not end up offline. Two states fail it, and neither condition alone catches both:

- **Initialisation failed**, `initializationMode: 'offline'` — an un-migrated database the schema preflight refused, a crawler that would not start, a submission pipeline that did not come up. `initialize()` still sets its initialised flag in some of these, so the mode has to be checked as well.
- **Initialisation never ran or was torn down**, `initializationMode: 'idle'` with the flag unset — the startup window before `initialize()` runs, `SKIP_AUTO_INIT`, a host that never started the plugin, or the state after `shutdown()`. Note that a *successful* crawler-less start also reports `'idle'`, so the mode alone cannot separate these.

Before this check, such a process answered `ready: true` whenever the crawler was disabled, because a plain SELECT on the old `SyncState` table succeeded, and the pod took traffic with submission and sessions never wired up. When the check fails, a stable, sanitised reason is appended to `runtimeWarnings`; the raw startup error stays in the log because it carries the database path and driver SQL.

**If you embed NIGHTGATE with `SKIP_AUTO_INIT`** and still want its readiness to describe your host, either let the plugin initialise or probe your own endpoint: this one reports what NIGHTGATE can do, and a NIGHTGATE that never started cannot serve.

### `getReorgHistory(limit?) → ReorgLog[]`

Last `limit` (default 10, max 100) reorg events with depth, detected-at timestamp, rolled-back tx count.

### `pauseCrawler() / resumeCrawler() / reindexFromHeight(height)` - actions

Operator controls, `@requires: 'admin'` (since 0.5.2; unauthenticated or non-admin callers get 401/403). `reindexFromHeight` triggers a rollback to the specified height (including a recompute of the `NightBalances` projection for affected addresses) and a fresh catch-up from there. The read-only status/health/metrics functions above stay unrestricted for K8s probes and Prometheus.

## Analytics

`getBlockCount() / getTransactionCount() / getContractCount() / getAverageTransactionsPerBlock()` - simple aggregate queries over the indexed entities.

## Admin

`invalidateSession(sessionId)` / `invalidateAllSessions()` - force-close sessions. Distinct from `disconnectWallet` in that admin can target any session, not just one the caller owns.

`BackgroundJobs` (read-only entity, 0.20.0) - the job queue over OData, projected without `command`, `request` and `result` (payload carriers; `command` is encrypted at rest). Until now the queue was only reachable through `getJobStatus(jobId, sessionId)`, which needs an id the caller already has. Full OData query surface, so `?$filter=status eq 'failed'&$orderby=createdAt desc` works. **Adding this projection creates a SQL view, so it does not exist on an already-deployed database until `cds deploy` or `nightgate-schema-delta` has run.**

`getJobStats(windowHours?) → { windowHours, since, total, byStatus[], topErrors[], oldestQueuedSeconds }` (0.20.0) - the cheap aggregate for a dashboard: counts per status plus the ten error codes that are piling up, over the last `windowHours` (default 24, max 720). `topErrors` is what turns "many jobs failed" into a diagnosis, for instance a run of `1010/188` meaning batched calls are crossing the guaranteed/fallible boundary.

`registerContract(name, artifactPath, zkConfigPath, privateStateId, slotWidth?) → { name, source, artifactPath, zkConfigPath, privateStateId, slotWidth, artifactDigest, hasProverKeys }` (0.21.0) - make a contract artifact known **without a restart**. Until now `cds.requires.nightgate.contracts` was read once at startup, so every new consumer contract (and each revision) cost a process restart that closed every wallet session and re-warmed the facades. The config stays the immutable floor: a config name is refused with `409`, and everything else adds next to it. Paths must resolve inside `NIGHTGATE_CONTRACTS_DIR` (default: the package's and the working directory's `contracts/`; importing an artifact executes its module, so an arbitrary path is not accepted from anyone). Validated before anything changes: the module must export a Compact `Contract` class, the zk-config directory must hold `keys/*.verifier` and `zkir/`. Persisted in `ContractRegistrations` and reloaded at boot; the returned `artifactDigest` is the generation every persisted command gets pinned to. Re-registering a runtime name under a new artifact is a new generation, so jobs recorded against the previous one refuse, exactly as after a config change. `hasProverKeys: false` means the contract deploys and verifies here but cannot be proven here. `/zk-config`, `/contract-manifest` and `getRuntimeInfo()` see the new contract immediately. Onboarding a consumer is then `registerContract` + `createAgentGrant(allowedContracts: [...])`, no restart, no recreate.

`unregisterContract(name) → { removed }` (0.21.0) - remove a runtime registration (memory + table). Config names refuse with `409`.

`listContracts() → [{ name, source, ..., artifactDigest, hasProverKeys }]` (0.21.0) - every contract this process knows, `source` `config` or `runtime`.

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

**Retryable 503s keep their body in production.** CAP replaces the message of every 5xx with the generic reason phrase when `NODE_ENV=production`. The 503s NIGHTGATE raises as advice opt out of that, so a client can switch on `error.code` and read `error.message` in any environment; each also sets a `Retry-After` header:

| `error.code` | Meaning | `Retry-After` |
|---|---|---|
| `JOB_ADMISSION_BUSY` | the database stayed busy for the whole admission retry budget; nothing was written, nothing submitted, send the same request again | 2 s |
| `WALLET_SYNCING` | a facade-backed read hit the bounded sync gate; poll again once the prewarm job reports ready | 15 s |
| a retryable submission code (`1016`, `NetworkOrTimeout`) | the JSON payload below, with `retryable: true` | none |

Every other 5xx is a genuine server fault and stays sanitised.

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

- **`1010/170` and `1010/196` (transient dust race)** - the dust spend was built against a dust state the node has already moved past (170: stale merkle root or validity window, usually a lagging indexer or a wallet not synced to tip; 196: the note's nullifier is already known, a concurrent spend on the same note). Pre-mempool, no fee spent. Since 0.21.0 ONE classification covers every submitting path: `classifySubmissionError` marks them `retryable: true, transient: "dust-race"`, and the bound `deployContract` / `submitContractCall` / batch paths rebuild and resubmit inside the worker call before any txHash exists (`NIGHTGATE_DUST_RACE_RETRIES`, default 2, `NIGHTGATE_DUST_RACE_BACKOFF_MS`, default 5000), the same self-heal the sponsored paths have had since 0.18 (`NIGHTGATE_SPONSOR_DUST_RETRIES`). A job that still fails carries that code. (`failed assert: predicate false` is the distinct predicate-circuit rejection.)
- **`Wallet.InsufficientFunds`** - raised by the wallet SDK when there's insufficient dust to pay fees, or insufficient NIGHT to satisfy outputs.
- **`MalformedResult`** - thrown by `TransactionSubmitter` when the SDK returns without the expected fields (likely an SDK bug); it is a distinct thrown error, not a `classifySubmissionError` code.

For diagnostic 503s caused by the hosted Midnight indexer, see [docs/operations.md#troubleshooting](operations.md#troubleshooting).
