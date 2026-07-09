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

### `getJobStatus(jobId, sessionId) → { status, result, errorCode, errorMessage }`

`status`: `pending | running | succeeded | failed`. On success, `result` is a JSON string of the action's result shape; on failure, `errorCode` + `errorMessage` carry the classified error (see [Error model](#error-model)).

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

### `connectWalletForSigning(sessionId, mnemonic, seedHex?) → { sessionId, signingEnabled, prewarmJobId, prewarmStatus }`

Upgrade a read-only session with **signing capability**, encrypting the BIP39 seed at rest. Keys are HD-derived per Midnight role (zswap / dust / night) to match Lace — see `srv/utils/wallet-hd.ts`. Schedules a tracked pre-warm job that syncs the wallet SDK in the worker; poll `getJobStatus(prewarmJobId, sessionId)` to know when sync-to-tip is done before submitting.

| Field | Type | Constraints |
|---|---|---|
| `sessionId` | UUID | Returned by `connectWallet` |
| `mnemonic` | String | BIP39 recovery phrase (preferred) |
| `seedHex` | String (optional) | Alternative to `mnemonic`: the full 64-byte BIP39 seed as 128 hex chars |

**Rate limit:** 5/hour per client IP.

**Errors:** 400 (invalid mnemonic/seed), 404 (no session), 410 (expired), 412 (already signing), 429 (rate-limited).

### `disconnectWallet(sessionId)`

Close a session: nullifies stored encrypted keys, evicts the cached wallet facade in the worker, persists a final state-save blob.

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

### `deployContract(compiledArtifactRef, sessionId, initialPrivateState, idempotencyKey?) → { jobId, status }`

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

**Rate limit:** 30/min per session.

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

`verified: true` iff the hash matches the stored `sha256`, `anchoredTxHash` is set, and that tx resolves to a `SUCCESS` result. A hash mismatch returns `verified: false` (not an error).

## ZK predicate attestations

Prove a hidden numeric value satisfies a predicate against a public threshold, without revealing the value (on-chain-verified). See [the AttestationVault contract](../contracts/attestation-vault).

### `issuePredicateAttestation(payloadHash, value, predicate, threshold, sessionId, contractAddress, salt?, unit?, valueCommitment?, compiledArtifactRef?) → { jobId, status, predicateAttestationId }`

The payload must already be attested. Submits `commitValue` then `provePredicate`; the ledger only includes the tx if the in-circuit commitment + predicate asserts hold, so a succeeded job IS the verified proof. `value` is a scaled integer (caller owns float scaling); it is used only as a circuit witness and **never persisted**. `predicate`: `lessOrEqual` | `greaterOrEqual`. `salt` (64-hex commitment opening) is generated if omitted. Job result: `{ predicateAttestationId, payloadHash, claim, proof }` (PAC-envelope shape). **Rate limit:** 10/hour per session.

### `verifyPredicateAttestation(predicateAttestationId) → { verified, predicate, threshold, unit, valueCommitment, provenTxHash, provenAt }` (function)

`verified: true` iff `provenTxHash` resolves to a `SUCCESS` result (needs the crawler enabled to index the proof tx).

## Disclosure grants

Surface the AttestationVault tiered-disclosure ACL: who is entitled to which tier of an attestation, on-chain. Both write circuits are attester-gated (a non-attester caller's tx is rejected). `level`: `0` = public, `1` = legitimate-interest, `2` = authority (EU Battery Reg Annex XIII tiers). See [the AttestationVault contract](../contracts/attestation-vault). **Note:** delivering tier-specific *cleartext* stays off-chain (consumer `after READ` redaction) — only entitlement is on-chain.

### `grantDisclosure(payloadHash, grantee, level, sessionId, contractAddress, compiledArtifactRef?, idempotencyKey?) → { jobId, status, disclosureGrantId }`

Grant a disclosure tier to a `grantee` (64-hex `Bytes<32>` id) on an existing attestation, via the `grantDisclosure` circuit. The payload must already be attested by the caller. `disclosureGrantId` is returned synchronously (the `DisclosureGrants` row is inserted up-front, `active=false`); it flips to `active=true` once the post-submit chain reindex confirms the grant in ledger state. Job result: `{ disclosureGrantId, payloadHash, grantee, level, txHash }`. `compiledArtifactRef` defaults to `attestation-vault`. **Rate limit:** 30/hour per session.

### `revokeDisclosure(payloadHash, grantee, sessionId, contractAddress, compiledArtifactRef?, idempotencyKey?) → { jobId, status }`

Revoke a previously-granted disclosure (removes the grantee entry on-chain) via the `revokeDisclosure` circuit. Attester-only. The matching `DisclosureGrants` row's `active` flips to `false`. Job result: `{ payloadHash, grantee, txHash }`. **Rate limit:** 30/hour per session.

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

`getMetrics` returns Prometheus text format. Metric prefix: `odatano_nightgate_*`. Includes chain height, indexed height, sync lag, block throughput, error counts, uptime, sync status (mapped: stopped=0, syncing=1, synced=2, error=3).

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
