# Actions reference

All OData V4 actions and functions exposed by NIGHTGATE, with signatures, request shapes, response shapes, error codes, and copy-pasteable examples.

OData distinguishes between **actions** (POST, may have side effects) and **functions** (GET, side-effect-free). NIGHTGATE follows this: write operations are actions, read-only operations are functions.

**Base path conventions** in examples:
- `http://localhost:4004/api/v1/nightgate/<actionName>` — main service
- `http://localhost:4004/api/v1/indexer/<functionName>()` — indexer service
- `http://localhost:4004/api/v1/analytics/<functionName>()` — analytics service
- `http://localhost:4004/api/v1/admin/<actionName>` — admin service

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

### `connectWalletForSigning(sessionId, seedHex) → { sessionId, signingEnabled }`

Upgrade an existing read-only session with **signing capability**. Stores the 32-byte BIP39-derived seed encrypted at rest. Triggers a fire-and-forget pre-warm of the wallet SDK in the worker thread — the actual sync happens in the background after this call returns.

| Field | Type | Constraints |
|---|---|---|
| `sessionId` | UUID | Returned by `connectWallet` |
| `seedHex` | String | 64 hex chars (first 32 bytes of BIP39 mnemonicToSeed) |

**Rate limit:** 5/hour per client IP.

**Errors:** 404 (no session), 410 (expired), 412 (session was already-signing), 429 (rate-limited).

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

### `deployContract(compiledArtifactRef, sessionId, initialPrivateState) → { submissionId, txHash, contractAddress, status }`

Deploy a Compact-compiled contract. The contract must be registered via `cds.requires.nightgate.contracts.<ref>` (or programmatically via `registerContract()`).

| Field | Type | Notes |
|---|---|---|
| `compiledArtifactRef` | String | Logical name from the registry (e.g. `"counter"`) |
| `sessionId` | UUID | Must have signing enabled |
| `initialPrivateState` | LargeString | JSON-encoded initial state (e.g. `"{}"`) |

A row is inserted into `PendingSubmissions` BEFORE the SDK is invoked (crash-recovery hook). `status` transitions: `pending` → `included` (SDK returned successfully) → `finalized` (crawler indexed the tx).

**Rate limit:** 5/hour per session.

**Errors:**
- 400 — `Wallet.InsufficientFunds` (insufficient dust), `OnChainStatus:FailEntirely`, `MalformedResult`
- 404 — contract not registered
- 503 — retryable transient (network, 1016 on preprod)

### `submitContractCall(contractAddress, circuit, compiledArtifactRef, sessionId, args) → { submissionId, txHash, contractAddress, status }`

Invoke a circuit on a deployed contract.

| Field | Type | Notes |
|---|---|---|
| `contractAddress` | String | From a prior `deployContract` |
| `circuit` | String | Circuit name (e.g. `"increment"`) |
| `compiledArtifactRef` | String | Logical name from registry |
| `sessionId` | UUID | Must have signing enabled |
| `args` | LargeString | JSON-encoded array (use `"[]"` for no args) |

**Rate limit:** 30/min per session.

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

### `getLiveness() / getReadiness() → { status, ... }`

Kubernetes-style probes.

### `getReorgHistory(limit?) → ReorgLog[]`

Last `limit` (default 10, max 100) reorg events with depth, detected-at timestamp, rolled-back tx count.

### `pauseCrawler() / resumeCrawler() / reindexFromHeight(height)` — actions

Operator controls. `reindexFromHeight` triggers a rollback to the specified height and a fresh catch-up from there.

## Analytics

`getBlockCount() / getTransactionCount() / getContractCount() / getAverageTransactionsPerBlock()` — simple aggregate queries over the indexed entities.

## Admin

`invalidateSession(sessionId)` / `invalidateAllSessions()` — force-close sessions. Distinct from `disconnectWallet` in that admin can target any session, not just one the caller owns.

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

Classification codes returned by `classifySubmissionError` (`srv/submission/TransactionSubmitter.ts`):

| Code | Retryable | Trigger |
|---|---|---|
| `TxFailed` | no | SDK `TxFailedError` (on-chain status wasn't `SucceedEntirely`) |
| `1014` | no | Substrate "invalid transaction" |
| `1016` | yes (preprod) / no (mainnet) | "Immediately Dropped" — preprod transient, mainnet has a known deterministic-rejection issue |
| `NetworkOrTimeout` | yes | `ECONNREFUSED`, `ETIMEDOUT`, `socket hang up`, etc. |
| `ContractTypeError` etc. | no | SDK contract-config errors |
| `WalletSigningNotAvailable` | no | Session has no encrypted seed key |
| `Wallet.InsufficientFunds` | no | Insufficient dust to pay fees, or insufficient NIGHT to satisfy outputs |
| `MalformedResult` | no | SDK returned without expected fields (likely SDK bug) |

For diagnostic 503s caused by the hosted Midnight indexer, see [docs/operations.md#troubleshooting](operations.md#troubleshooting).
