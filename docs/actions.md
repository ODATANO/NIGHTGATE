# Actions reference

All OData V4 actions and functions: signatures, request and response shapes, error codes, examples. Actions are POST (side effects), functions GET (read-only).

Base paths:
- `http://localhost:4004/api/v1/nightgate/<actionName>` - main service
- `http://localhost:4004/api/v1/indexer/<functionName>()` - indexer service
- `http://localhost:4004/api/v1/analytics/<functionName>()` - analytics service
- `http://localhost:4004/api/v1/admin/<actionName>` - admin service
- `http://localhost:4004/api/v1/verify/<functionName>(...)` - public verify service (see [Crawler-free state verification](#crawler-free-state-verification))

## API versioning while 0.x

Paths stay `/api/v1/...` until 1.0. Under 0.x a minor release may change or
remove an action, a patch release never does; a removal is marked
`@deprecated` (CDS doc and this file) at least one minor release ahead.
`getRuntimeInfo().apiVersion` reports the running major.minor.

## Async job model (write actions)

Every submitting action returns `{ jobId, status: "pending" }`; poll `getJobStatus(jobId, sessionId)` until `succeeded` or `failed`. Each write action lists its job-result shape (the parsed `result`); functions return their result directly.

### `getJobStatus(jobId, sessionId) → { status, chainStatus, result, errorCode, errorMessage, submissionId, txHash, chainFinalizedAt, chainBlockHeight, chainBlockHash, … }`

`status`: `pending | running | external_execution | submitted | reconciliation_required | succeeded | failed`. `result` is the action's result as a JSON string; on failure `errorCode` + `errorMessage` (see [Error model](#error-model)). `chainBlockHeight` / `chainBlockHash` are the confirmed inclusion coordinates; a reorg rollback reverts by them. An on-chain failure without a block height stays briefly in `reconciliation_required` / `CHAIN_EXECUTION_FAILED_UNCONFIRMED` until the confirmer records the coordinates.

`reconciliation_required`: execution was interrupted after an external effect may have occurred. Do NOT auto-retry; a new attempt needs a new `idempotencyKey`. The reconciler resolves it by the job's `txHash` on the indexer: `succeeded`, `failed / CHAIN_EXECUTION_FAILED`, or, once the indexer tip is past the transaction's `ttl` (30 to 60 min) plus `NIGHTGATE_BROADCAST_EXPIRY_MARGIN_MS` (default 5 min), `failed / BROADCAST_NOT_INCLUDED` with `chainStatus: dropped` (nothing on chain). Parked `errorCode`: `BROADCAST_UNCONFIRMED` (submitted, no node status, not indexed yet), `EXTERNAL_EXECUTION_FAILED` (failure after the broadcast), `PROCESS_RESTART_RECONCILE` (restart after the broadcast). Manual check: `verifyAttestationState` for an `attest`, else the identifier on the indexer.

Every submit path broadcasts only after the transaction identifier is persisted as the job's `txHash`. A `failed` job without `txHash` sent nothing; `reconciliation_required` always carries the one identifier that may be on chain. A pre-mempool reject closes its attempt `REJECTED` on `PendingSubmissions` and clears the hash before anything else is sent.

`chainStatus` (`null | pending | success | failure | dropped`) is the on-chain outcome, independent of `status`: `succeeded` with `failure` means the tx finalized but the call reverted; `dropped` means never included (rule above). The response also carries `submissionId`, `txHash`, `chainFinalizedAt` and lease/attempt/timestamp fields.

## Session lifecycle

### `connectWallet(viewingKey) → { sessionId, ID, connectedAt, expiresAt, isActive }`

Open a **read-only** session; the viewing key is stored AES-256-GCM encrypted.

| Field | Type | Constraints |
|---|---|---|
| `viewingKey` | String | 64 hex chars (the encryption public key of the wallet) |
| `label` | String (optional) | Operator-facing name, at most 100 chars |

**Rate limit:** 10/min per client IP.

```bash
curl -X POST http://localhost:4004/api/v1/nightgate/connectWallet \
  -H "Content-Type: application/json" \
  -d '{"viewingKey":"a32699a5a29e453f6e92624c2fbefdee173d3f1178e3f9c71bc3edb7d91c1403"}'
```

### `connectWalletForSigning(sessionId, mnemonic, seedHex?, accountIndex?) → { sessionId, signingEnabled, prewarmJobId, prewarmStatus }`

Add **signing** to a read-only session: the BIP39 seed is stored encrypted, keys are HD-derived per role (zswap / dust / night) as in Lace. Starts a prewarm job; poll `getJobStatus(prewarmJobId, sessionId)` until synced before submitting.

| Field | Type | Constraints |
|---|---|---|
| `sessionId` | UUID | Returned by `connectWallet` |
| `mnemonic` | String | BIP39 recovery phrase (preferred) |
| `seedHex` | String (optional) | Alternative to `mnemonic`: the full 64-byte BIP39 seed as 128 hex chars |
| `accountIndex` | Integer (optional, default 0) | BIP32 account level; pass the SAME value used with `deriveWalletInfo` for this wallet |
| `idempotencyKey` | String (optional) | Dedupes retries |
| `prewarm` | Boolean (optional) | `false` skips the prewarm job; the wallet syncs on the first submission |

**Fail-closed:** 400 unless the seed at `accountIndex` derives the session's viewing key, so signer, session and on-chain attester id (`caller_id()`) are one account.

**Rate limit:** 10/hour per client IP (default; override via `NIGHTGATE_SIGNING_KEY_RATE_LIMIT`). Shared with `deriveWalletInfo`.

**Errors:** 400 (invalid mnemonic/seed/accountIndex, or seed does not derive the session's viewing key), 404 (no session), 410 (expired), 412 (already signing), 429 (rate-limited).

### `disconnectWallet(sessionId)`

Close a session: nulls the encrypted keys, evicts the worker's wallet facade, persists a final state save.

### `deriveWalletInfo(mnemonic | seedHex, accountIndex?) → { viewingKey, shieldedAddress, nightAddress, dustAddress, attesterId, accountIndex, network }`

Derive `viewingKey` (input to `connectWallet`), addresses and `attesterId` from a mnemonic or seed without creating a session; nothing is stored or logged. Same derivation as `connectWalletForSigning` for the same `accountIndex` (default 0). `dustAddress` is a `dustReceiverAddress` for `registerForDustGeneration`. **Rate limit:** 10/hour per client IP (shared with `connectWalletForSigning`).

`attesterId` is the vault's `caller_id()` for this wallet, network-independent. Pass it as `registerPassport`'s `ownerId` to register a document id for a wallet before its first transaction.

## Token operations

### `sendNight(sessionId, receiverAddress, amount, ttlIso?) → { txId, toLedger, amount, receiverAddress }`

Send NIGHT (or `tokenTypeHex`) to a Midnight address. The Bech32m prefix picks the ledger (`mn_shield-addr_*` shielded, `mn_addr_*` unshielded); funds come from the same ledger.

| Field | Type | Notes |
|---|---|---|
| `sessionId` | UUID | Must have signing enabled |
| `receiverAddress` | String | Bech32m, ≥ 50 chars |
| `amount` | String | Decimal atoms, at most `10^18` |
| `ttlIso` | String (optional) | ISO-8601 future timestamp; default = now+10min |
| `tokenTypeHex` | String (optional) | Raw token type (64 hex) instead of NIGHT; the receiver prefix picks shielded or unshielded holdings |
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

Register the wallet's unregistered unshielded NIGHT UTXOs for dust generation. The result reports what happened:

- Registration binds the **address**: later NIGHT arriving there generates dust for the same receiver. On an already-registered wallet the call changes nothing and still succeeds: `changed: false`, `reason: "already-registered"`, `dustReceiverAddress: null`, `requestedReceiver`, and a `message` to deregister first and register again with the new receiver. `reason: "no-night-utxos"`: nothing to register.
- One registration consolidates its inputs (`registeredCount` = inputs, `consolidated: true`). One registered UTXO yields one dust note, the unit of parallel sponsoring, so read `registeredUtxosAfter` (observed after local apply, `settled: true`; waits up to `NIGHTGATE_DUST_REGISTER_SETTLE_MS`, default 90 s, else `settled: false` and `null`).
- Register first, then fund in separate payments: each payment stays a separate registered UTXO.

| Field | Type | Notes |
|---|---|---|
| `sessionId` | UUID | Must have signing enabled |
| `dustReceiverAddress` | String (optional) | Bech32m DUST address (`mn_dust_*`); default = wallet's own dust address |
| `idempotencyKey` | String (optional) | Dedupes retries against the original job |

DUST accrues ~1-2 min after the tx finalizes; refill ~5 tDUST per 100 h (preprod parameters).

### `deregisterFromDustGeneration(sessionId) → { txId, deregisteredCount, totalNightUtxos }`

Deregister all of the wallet's registered NIGHT UTXOs (no per-UTXO selection).

## Contract operations

### `deployContract(compiledArtifactRef, sessionId, initialPrivateState, idempotencyKey?, sponsorSessionId?, recoveryId?) → { jobId, status }`

Deploy a contract registered via `cds.requires.nightgate.contracts.<ref>` or `registerContract`. Job result: `{ submissionId, txHash, contractAddress, status }` (`status` = `PendingSubmissions` lifecycle: `pending` -> `included` -> `finalized`).

| Field | Type | Notes |
|---|---|---|
| `compiledArtifactRef` | String | Logical name from the registry (e.g. `"counter"`) |
| `sessionId` | UUID | Must have signing enabled |
| `initialPrivateState` | LargeString | JSON-encoded initial state (e.g. `"{}"`) |
| `idempotencyKey` | String (optional) | Dedupes retries; a reused key returns the existing `jobId` |
| `recoveryId` | String (optional) | Vault family only: 64-hex attester id that may re-point the registrar (`registerPassport` modes 3 and 4). The registrar is the deploy session's attester id. Absent = no recovery; a lost registrar key then locks the id registry for good. |

**Rate limit:** 5/hour per session.

**Errors:**
- 400 - `Wallet.InsufficientFunds` (insufficient dust), `OnChainStatus:FailEntirely`, `MalformedResult`
- 404 - contract not registered
- 503 - retryable transient (network, 1016 on preprod)

### `submitContractCall(contractAddress, circuit, compiledArtifactRef, sessionId, args, idempotencyKey?, initialPrivateState?, sponsorSessionId?) → { jobId, status }`

Invoke a circuit on a deployed contract. Job result: `{ submissionId, txHash, contractAddress, status }`.

| Field | Type | Notes |
|---|---|---|
| `contractAddress` | String | From a prior `deployContract` |
| `circuit` | String | Circuit name (e.g. `"increment"`) |
| `compiledArtifactRef` | String | Logical name from registry |
| `sessionId` | UUID | Must have signing enabled |
| `args` | LargeString | JSON-encoded array (use `"[]"` for no args). See **Encoding circuit args** below |
| `idempotencyKey` | String (optional) | Dedupes retries; a reused key returns the existing `jobId` |
| `initialPrivateState` | LargeString (optional) | JSON; seeded only on this wallet's first contact with the contract, never overwrites |
| `sponsorSessionId` | UUID (optional) | Second session that pays the dust fee. See **Per-tx fee sponsoring** below |

**Rate limit:** 30/min per session.

### `submitContractCallBatch(contractAddress, calls, compiledArtifactRef, sessionId, idempotencyKey?, initialPrivateState?, sponsorSessionId?, independentCalls?) → { jobId, status }`

Run up to 8 circuits on ONE contract as ONE transaction (balanced, signed and
submitted once). Apply order = call order, so dependent calls may be batched,
with two limits: same-name circuits are unordered among themselves, and a
dependent batch is valid only while its leading calls stay in the ledger's
guaranteed stage (see **Ledger causality rule**).

Ordering: before proving, NIGHTGATE reassigns the batch's segment ids ascending
in call order (fee/dust segments untouched). Fail-closed: if that fails, the
job aborts before proving. `NIGHTGATE_BATCH_SEGMENT_MODE=observe` skips the
rewrite and only logs the random ids (diagnosis only; default `rewrite`).

Proof witnesses ride per call in `merkleProof`: single-field circuits take
`fieldValue` or `fieldDigest`, `fieldSalt` (required by the circuit), `siblings`
and `dirs` (depth log2(width)), membership additionally `setProof`; the
cross-root circuit takes `docPair: { schema, openingA, openingB }` (the shapes
of `prepareDocumentProof`'s `schema` and `opening`) and no inclusion path.
A malformed bundle is a 400 before any job.

**Ledger causality rule:** the SDK splits each call into a guaranteed and a
fallible transcript by gas cost. The ledger applies all guaranteed stages
first and rejects a call with a fallible transcript followed by one with a
guaranteed transcript (`1010: Invalid Transaction: Custom error: 188`).
Per-call cost grows with contract state, so a call's stage can move. On the
vault, `attest` and `anchorContentRoot` stay guaranteed as the vault grows, and
`bindDocument` is fallible on all but tiny vaults: `attest -> anchorContentRoot
-> bindDocument` is valid, `bindDocument` ahead of a guaranteed call is not.

- Put the most expensive call last; send a fallible call that must precede a
  guaranteed one as its own transaction.
- The partition is checked before proving: the job fails with
  `errorCode: "BatchCausalityViolation"` (never retryable, nothing submitted),
  its message ending `Stages in apply order: <call>=<segment>[<stages>] ...`.
  Every multi-call batch logs stages and gas (`[nightgate:batch-segments]`).
- Independent calls (distinct claim keys, no shared cell): `independentCalls:
  true` groups calls by stage before proving (guaranteed-only first, call order
  within a group). `issueFieldPredicateAttestationBatch` sets it; its in-batch
  `anchorContentRoot` stays first.

**Failure semantics:** an error before submission submits nothing. After
submission the tx can finalize `PARTIAL_SUCCESS` (on chain, a subset applied):
the job fails with `OnChainStatus:...` and `chainStatus: failure`; verify
effect state (e.g. `verifyAttestationState`).

Job result: `{ submissionId, txHash, contractAddress, circuits, status }`, one
`txHash`, `circuits` in apply order.

| Field | Type | Notes |
|---|---|---|
| `contractAddress` | String | From a prior `deployContract` |
| `calls` | LargeString | JSON array of `{ circuit, args }` in apply order; `args` per **Encoding circuit args** |
| `compiledArtifactRef` | String | Logical name from registry |
| `sessionId` | UUID | Must have signing enabled |
| `idempotencyKey` | String (optional) | Dedupes retries |
| `initialPrivateState` | LargeString (optional) | Seeded on this wallet's first contact with the contract, as in `submitContractCall` |
| `sponsorSessionId` | UUID (optional) | Second session pays the dust fee once for the whole batch. See **Per-tx fee sponsoring** |
| `independentCalls` | Boolean (optional) | Calls share no state: order by execution stage instead of call order |

**Rate limit:** 30/min per session (shared with `submitContractCall`).

#### Per-tx fee sponsoring (`sponsorSessionId`)

Submit actions (`deployContract`, `submitContractCall`,
`submitContractCallBatch`, `anchorDocument`, the `issue*` actions,
`grantDisclosure`, `revokeDisclosure`, `registerPassport`,
`retractAttestation`, `purgeExpired`, `mintShieldedTestToken`,
`attestAgentOutput`, `deregisterFromDustGeneration`) accept an optional
`sponsorSessionId`: the caller builds and signs (shielded/unshielded balancing
only), the sponsor balances the dust fee and submits. The caller needs no NIGHT
or dust; the sponsor must be signing-capable.

A caller may use its own sessions; a foreign sponsor must be listed in
`NIGHTGATE_FEE_SPONSOR_SESSION` (comma separated) or `feeSponsorSessions`,
else 404; a viewing-key-only sponsor is 412. Job request and result carry
`feeSponsor`.

#### Encoding circuit args

`args` is a JSON array; each element is coerced before the call by the
circuit's declared parameter types (the artifact's `contract-info.json`):

| Circuit param | Pass in the JSON array as | Coerced to |
|---|---|---|
| `Bytes<N>` | hex string (`"ab…"`, optional `0x` prefix), **or** a `number[]` of bytes | `Uint8Array(N)` (length-checked) |
| `Uint<N>` | a number (`47300`) or a decimal string (`"47300"`) | `BigInt` |
| `Boolean` | `true` / `false` | boolean |
| a Compact struct (`ShieldedCoinInfo`, `QualifiedShieldedCoinInfo`, your own) | a JSON object with every declared field, each in its own encoding from this table (tags work one level down, nested structs recurse) | an object with the fields coerced by their own types; a missing field or a non-object is a 400 naming the argument index |
| other (`Vector`, `Maybe`, `Either`, …) | the JSON value | passed through unchanged |

Without `contract-info.json` for the circuit, untagged arguments are a **400**;
use tagged values (honored always):

- `{ "$bytes": "<hex>" }` → `Uint8Array`
- `{ "$uint": "<decimal>" }` (or `{ "$uint": 123 }`) → `BigInt`

Example - calling `bindDocument(document_id: Bytes<32>, payload_hash: Bytes<32>)`:

```jsonc
// convention (introspected): each 64-hex string becomes a Uint8Array(32)
"args": "[\"<64-hex document_id>\", \"<64-hex payload_hash>\"]"

// equivalent, explicit tags:
"args": "[{\"$bytes\":\"<64-hex document_id>\"}, {\"$bytes\":\"<64-hex payload_hash>\"}]"
```

Invalid hex, a wrong `Bytes<N>` length or a non-integer/negative `Uint` is a
**400** (`args[i]: …`).

## Custom tokens

### `mintShieldedTestToken(contractAddress, sessionId, compiledArtifactRef?, idempotencyKey?, sponsorSessionId?) → { jobId, status }`

Mint the bundled `contracts/shielded-token` test token to the caller's zswap
public key (exercises the zswap circuits, which NIGHT never touches).
`compiledArtifactRef` accepts only `shielded-token` (or omit it): the result
carries this fixture's separator and amount. Other minting contracts use
`submitContractCall` plus `deriveTokenType`.

```bash
curl -X POST .../deployContract   -d '{"compiledArtifactRef":"shielded-token","sessionId":"<id>","initialPrivateState":"{}"}'
# -> jobId; poll getJobStatus for contractAddress

curl -X POST .../mintShieldedTestToken   -d '{"contractAddress":"<addr>","sessionId":"<id>"}'
# -> jobId; result { txHash, contractAddress, tokenTypeHex, amount: "100000000" }
```

Each call mints 100000000 atoms; repeated calls mint distinct coins. Send them
with `sendNight(tokenTypeHex)` once the wallet has synced the coin (a few
blocks).

### `deriveTokenType(contractAddress, domainSeparator?) → { tokenTypeHex, contractAddress, domainSeparator }` (function)

Compute-only. A token is `rawTokenType(domainSeparator, contractAddress)`, the
separator being the 32 bytes the contract passes to `mintShieldedToken`
(`pad(32, "...")`); works for any minting contract. `domainSeparator`: the
plain string (default `nightgate:zswap-e2e`, the bundled token) or 64 hex; the
response echoes the 64-hex form used.

## Cross-server fee sponsoring

The caller builds, proves, signs and finalizes a call; the sponsor pays the
dust and submits. Only the serialized transaction moves between them. Client
side: [txbuilder.md](txbuilder.md).

### `buildSponsorable(contractAddress, circuit, compiledArtifactRef, sessionId, args) → { jobId, status }`

Phase 1 on the server: build, prove, sign and finalize ONE call without
submitting. Job result `{ finalizedTxB64, serializedBytes }` (~5 KB base64 for
a vault call); no dust spent. The txbuilder SDK does the same locally.
**Rate limit:** 30/hour per session.

Session-scoped rate limits are keyed by principal and session
(`<agent grant or user>:<sessionId>`).

### `sponsorFinalizedTransaction(finalizedTxB64, sponsorSessionId, idempotencyKey?) → { jobId, status, sessionId }`

Phase 2: check the sponsor policy, balance dust with `sponsorSessionId`,
submit. Poll `getJobStatus` with the returned `sessionId` (the sponsor
session; a grant may inject it server-side). Job result
`{ txHash, circuits, contractAddress }`. **Rate limit:** 120/hour per
principal, shared with `sponsorUnboundTransaction`.

The policy is a fail-closed shape check: allow-listed contract calls and
nothing else. A deploy, an unshielded transfer, a zswap offer, caller-side dust
actions, an unreadable structure or a tx over `NIGHTGATE_SPONSOR_MAX_TX_BYTES`
(default 65536) refuse. Exception: a zswap offer passes when the policy lists
its token types (`NIGHTGATE_SPONSOR_ALLOWED_TOKEN_TYPES`, policy file, grant
`allowedTokenTypes`): every net change must be on a listed type (never NIGHT),
every contract-owned coin must belong to a sponsorable contract, and a net
change must exist unless a coin is owned by a sponsorable contract (a burn nets
to zero). The allow-list bounds which calls are paid:

```bash
NIGHTGATE_SPONSOR_ALLOWED_CONTRACTS=<vault addr>,<other addr>
NIGHTGATE_SPONSOR_ALLOWED_CIRCUITS=attest,anchorContentRoot,proveFieldPredicate
```

An empty list means no restriction (private deployments only). Whoever can
reach this endpoint can make you pay fees.

**Policy layers (changeable while the server runs):**

- **Sponsor binding.** A grant without `sponsorSessionId` cannot name a
  sponsor (403). A token never inherits the operator's other sponsors or the
  pool; bind the grant to one sponsor session or the pool sentinel.
- **Always allowed under any token** (no list entry, no budget): entity reads
  (chain projections; `WalletSessions`, `PendingSubmissions`, `Documents`
  narrowed to the grant's session, `AgentGrants` to the grant;
  `GranteeIdentities` and other entities 403), `verifyDocument`,
  `verifyAttestationState`, `verifyPredicateState`,
  `verifyPredicateAttestation`, `prepareDocumentProof`,
  `prepareMembershipSet`, `deriveTokenType`, `getJobStatus`, `getGrantUsage`
  (own grant). Everything else needs `allowedActions`; wallet lifecycle,
  sends, deploys, registration and grant administration are never grantable.
- **Re-resolved at execution.** A queued job runs under the current floor ∩
  the grant's current lists: a revoked grant fails its queued jobs
  (`AGENT_GRANT_REVOKED`), an expired one sponsors nothing after `validUntil`.
- **Policy follows the grant.** `createAgentGrant(..., allowedContracts,
  allowedCircuits, allowedTokenTypes)` bounds every action under the token: a
  `contractAddress` outside `allowedContracts` or a circuit outside
  `allowedCircuits` is 403 at admission. Circuits derive from the action
  (`grantDisclosure` -> `grantDisclosure`, `anchorDocument` -> `attest`,
  `issue*` -> proof circuit(s) + `anchorContentRoot`, batch -> its `calls`);
  an action whose circuits cannot be derived is refused while a list is set.
  An empty grant list is no restriction. Sponsored calls run under platform
  lists ∩ grant lists; an absent grant list inherits the platform list; for
  contracts and circuits an empty platform list lets the grant be the whole
  policy, for token types it means no offers. Disjoint non-empty lists:
  `403 SPONSOR_POLICY_EMPTY`.
- **Policy file (platform floor).** `NIGHTGATE_SPONSOR_POLICY_FILE` = JSON
  `{ "allowedContracts": [...], "allowedCircuits": [...], "allowDeploy": false,
  "allowedTokenTypes": [...] }`, re-read per sponsored call (mtime cache),
  replaces the env lists. Fail-closed: an invalid file keeps the last good
  policy; with none loaded every sponsored call is
  `503 SPONSOR_POLICY_UNAVAILABLE`.
- **Sponsored deploys.** `createAgentGrant(..., allowDeploy: true,
  maxDeploys?)` lets the sponsor pay a deploy the caller built and signed
  (txbuilder `buildDeploySponsorable`). Requires the floor
  (`NIGHTGATE_SPONSOR_ALLOW_DEPLOY=true` or policy-file `allowDeploy`) AND the
  grant with budget left (`maxDeploys`, default 1, lifetime, separate from
  `maxJobsPerDay`). Not matched against `allowedContracts`; own ceiling
  `NIGHTGATE_SPONSOR_MAX_DEPLOY_BYTES` (default 40960); one deploy per
  transaction. The budget is reserved at the submit intent, atomically with
  the attempt: parallel deploys cannot exceed it, a provable node reject
  refunds it, an on-chain failure does not. The landed address goes into
  `deployedContracts` and is sponsorable on top of `floor ∩ grant`, exempt
  from `allowedCircuits` (contract list and byte ceiling still apply).
  Maintenance updates are never sponsored.
- **Grant administration.** `updateAgentGrant(grantId, ...)` changes only the
  given parameters; `null` clears `maxJobsPerDay`, `validUntil`, `agentLabel`
  and the allow-lists; `sessionId`, `sponsorSessionId` and the token are
  immutable; `maxDeploys` >= deploys used; a new `maxJobsPerDay` applies to
  the current UTC day. `rotateAgentGrantToken(grantId)` returns a new token
  once; the old one is 401 from the next request; budgets and
  `deployedContracts` stay. Both owner-scoped (foreign 404; revoked: update
  `409 GRANT_REVOKED`, rotate 404), never grantable, rate limit shared with
  create/revoke (`NIGHTGATE_GRANT_ADMIN_RATE_LIMIT`, default 10/hour per
  principal).
- **Usage per grant.** Jobs under a token carry `BackgroundJobs.grantId`
  (inherited by child jobs). `getGrantUsage(grantId, since?, until?)` returns
  jobs by kind and status, `landed`, `failed`, deploy and daily budgets, and
  `dustPaid` (indexed DUST fees; null without the crawler). Default window 30
  days up to now, max 366. Owner-scoped; a token reads only its own grant.

**Pool + failover.** `NIGHTGATE_FEE_SPONSOR_SESSION` sessions form a lease
pool: one in-flight dust spend per wallet, callers wait up to
`NIGHTGATE_SPONSOR_LEASE_WAIT_MS` (default 120 s), caught-up members first,
a retryably failing sponsor benched for `NIGHTGATE_SPONSOR_COOLDOWN_MS` while
the job tries the next. Omit `sponsorSessionId` or pass the sentinel
`00000000-0000-0000-0000-706f6f6c0000` to use the pool; an explicit session
stays exact. Members warm one after another at boot. A grant pinned to the
sentinel may grant only `sponsorFinalizedTransaction` /
`sponsorUnboundTransaction`; `getJobStatus` polls under the sentinel.
Idempotency keys are per caller. Throughput scales with the number of pool
wallets.

The caller's TTL applies (`buildSponsorable` / SDK `ttlMinutes`, default 30); a
late transaction is rejected by the node.

### `sponsorUnboundTransaction(unboundTxB64, sponsorSessionId, idempotencyKey?) → { jobId, status, sessionId }`

Phase 2, parallel channel. Takes the unbound (pre-binding) proven and signed
tx from txbuilder `buildSponsorable({ bind: false })`, applies the same shape
check, allow-list, pool, grant and idempotency rules, locks one free dust
backing of the sponsor, proves a dust-only spend, merges, binds and submits.
Job result `{ txHash, circuits, contractAddress, note }` (`note` = backing
used). **Rate limit:** 120/hour per principal, shared with
`sponsorFinalizedTransaction`.

Parallelism: only the dust build is serialized per wallet; one wallet sponsors
as many transactions at once as it has distinct registered dust backings.
Same-backing requests wait up to `NIGHTGATE_BACKING_WAIT_MS` (default 5 min).
A lost dust race (`1010/170`, `1010/196`) is rebuilt on the same sponsor
(`NIGHTGATE_SPONSOR_DUST_RETRIES`, default 4; `NIGHTGATE_SPONSOR_DUST_BACKOFF_MS`,
default 5000). Job concurrency: `cds.requires.nightgate.jobs.concurrency.heavy`
(default 4). Returns once in a block (`NIGHTGATE_SPONSOR_WAIT=finalized` waits
for finality).

Submit timeouts per phase, for every submit (bound and unbound; each goes
out on its own node client, never on the wallet's shared socket): connect
(`NIGHTGATE_SUBMIT_CONNECT_TIMEOUT_MS`, 20 s; nothing sent, resent on a fresh
client up to `NIGHTGATE_SUBMIT_TRANSPORT_RETRIES` times), request
(`NIGHTGATE_SUBMIT_REQUEST_TIMEOUT_MS`, 30 s; ambiguous, `no-reply`), watch
until InBlock (`NIGHTGATE_SUBMIT_WATCH_TIMEOUT_MS`, 75 s; ambiguous). Logged as
`submit-phases <site> <identifier> ...`; a timed-out attempt keeps listening
for `NIGHTGATE_SUBMIT_LATE_GRACE_MS` (5 min) and logs `submit-late
<identifier>`. An ambiguous outcome is looked up on the indexer (90 s); if
unknown, the job parks as `BROADCAST_UNCONFIRMED` until indexed or past its ttl.
A node reject answers within the request phase, so a rejected bound submit
frees the worker in seconds, not when the node closes the socket.

**Contention.** Concurrent writes to the SAME contract state conflict at the
ledger: each call's transcript applies only if the state it read still holds
([smart contract security](https://docs.midnight.network/compact/smart-contract-security)).
The loser is rejected at admission (`1010/104`, or pool status Invalid) or
lands as `PARTIAL_SUCCESS` (call not applied, fee paid) and must be REBUILT
against the new state; resubmitting the same bytes never helps and the sponsor
does not retry it. The node validates against the best block, so a tx built on
a predicted post-tx1 state can be submitted only once tx1 is in a block.
Parallelize across contracts; within one contract serialize per caller or
batch (`submitContractCallBatch`). Do not mix bound and unbound sponsoring on
one sponsor wallet.

`1010/104` also hits calls on distinct keys while a map is small: a call built
before another grew the map across 1, 16 or 256 entries lacks gas for one more
trie level. Server-built calls (deploy, `submitContractCall`, batch, `issue*`,
anchors) rebuild (`NIGHTGATE_STALE_TRANSCRIPT_RETRIES`, default 2, after
`NIGHTGATE_STALE_TRANSCRIPT_BACKOFF_MS`); a sponsored job cannot rebuild the
caller's bytes and fails with `1010/104`.

### `anchorDocument(sha256, storageRef, sessionId, contractAddress, contentType?, size?, metadata?, compiledArtifactRef?, idempotencyKey?, sponsorSessionId?) → { jobId, status, documentId, attesterId }`

Anchor a document hash in the vault with ONE `attest` transaction. Only the hash and the caller's `storageRef` (`file://` | `s3://` | `ipfs://`) are stored, **never the bytes**. The `Documents` row (owner, `attesterId`, contract, network, artifact) is inserted at once, so `documentId` returns synchronously; reads are owner-scoped (admins unfiltered). `compiledArtifactRef` defaults to `attestation-vault`.

The record key `recordKey(attesterId, sha256)` is derived from the caller in-circuit: no other identity can pre-empt or take over the record, and another session's attest of the same hash is a separate record. Verifiers name it by both values or a bound document id. Job result `{ documentId, attestationId, attesterId, txHash, anchoredAt }`.

**Rate limit:** 10/hour per session.

### `verifyDocument(documentId, providedSha256) → { verified, included, stateChecked, anchoredTxHash, anchoredAt, originalSha256 }` (function)

`verified: true` iff the hash matches, `anchoredTxHash` is set and the attestation stands in live contract state (a retract turns it false). `included`: the anchoring tx indexed as `SUCCESS`; `stateChecked: false`: no live provider for the record's network, so `verified` stays false and only `included` is reported. The vault, artifact and network recorded at anchor time are authoritative: a different caller-supplied `contractAddress`/`compiledArtifactRef` is a 400 and the recorded network's indexer is read; only rows without recorded coordinates use caller values. A mismatch is `verified: false`, not an error. Any authenticated caller holding the `documentId` may call it (the response has no `storageRef`).

## Document ingestion (compute-only)

Synchronous helpers that turn structured data into the proof inputs the predicate actions consume. Nothing is persisted, no job is started; responses carry WITNESS material and are never logged.

### `prepareDocumentProof(documentJson, proofFieldsJson, saltSeed?, compiledArtifactRef?) → { payloadHash, canonicalDocument, contentRoot, fields, emptyFields, schemaId, schema, leaves, opening }`

Canonical JSON (RFC 8785 order: keys sorted by UTF-16 code units, so `"10"` precedes `"9"`; an external payloadHash must follow the same rule) → blake2b-256 `payloadHash` (what `anchorDocument` anchors), plus a salted Merkle `contentRoot` of depth log2(width) over the ordered `proofFieldsJson` (leaf index = position; keep it stable across anchor and proof) with per-field inclusion paths.

- `proofFieldsJson`: up to width (16, or 32 with `compiledArtifactRef: 'attestation-vault-32'`) `{ field, kind?, scale? }` entries. `kind: 'uint'` (default; number x `scale`, default 1000) or `'bytes'` (blake2b-256 of the exact string, for the equality/membership actions; no `scale`). `field` is a dot path (numeric segments index arrays; a literal top-level key with dots wins).
- Per-slot salts derive from a 32-byte seed (`saltSeed`: random unless given for a deterministic re-prepare). Absent values use the salted absent leaf (key `nightgate/empty-leaf/v2`, ASCII zero-padded) and are listed in `emptyFields`.
- Hashing uses the artifact's pure circuits, so root and `schemaId` equal the in-circuit recompute.
- `fields`: `{ field, fieldKey, kind, value?, valueDigest?, salt, siblings, dirs }`; `salt` is the proof actions' `fieldSalt`.
- `schemaId`: root over the slot descriptors `{ fieldKey, kind, scale }` (`schema`), anchored with the content root and proven by the comparison circuit. It covers only keys, kinds, scales and order: identically shaped field lists share one schemaId. For panels split across documents, put the segment in the field path (`seg02.locus03`).
- `opening` (`{ saltSeed, slots[width] }`): store it with the document; losing the seed makes the root unprovable, leaking it makes leaf hashes dictionary-testable.
- **Roots are bound to the artifact generation.** `contentRoot`, `schemaId`, membership set roots and every claim key derived from them use the circuit's `transientHash`, which is not guaranteed stable across compiler generations; `payloadHash` (blake2b outside the circuit) is. A vault compiled with a new compiler generation is a redeploy with an empty ledger: holders re-anchor from the stored `opening` and re-prove, older claims are not carried over. Verification of what is anchored today needs today's artifact, which ships with each release.

**Rate limit:** 120/hour per client.

### `prepareMembershipSet(allowedValuesJson, value?, valueDigest?, compiledArtifactRef?) → { setRoot, memberCount, setSiblingsJson?, setDirsJson? }`

Canonical depth-6 set root for `issueFieldMembershipAttestation` and `verifyPredicateState`: blake2b-256 each exact string, dedupe, sort ascending, pad to 64 by repeating the last member digest, leaf-wrap with the `setLeafHash` pure circuit. Padding repeats a real member so the padding value is never provable. More than 64 distinct values: 400. Without `value`/`valueDigest`: `{ setRoot, memberCount }`. With one: plus the inclusion path (`setSiblingsJson`/`setDirsJson`, witness); 400 if not a member. **Rate limit:** 120/hour per client (shared with `prepareDocumentProof`).

Outside a server: `import { buildMembershipSet, membershipPathFor, canonicalSetDigests, SET_DEPTH, MAX_SET_VALUES } from '@odatano/nightgate/set-root'` (no CAP, no Node builtins; takes the artifact's `setLeafHash`/`nodeHash` pure circuits; byte-identical roots).

## ZK predicate attestations

Prove statements about anchored field values without revealing them: numeric predicates against a public threshold, bytes equality against a public digest, set membership in a public allow-list, cross-document integrity and diff. Every claim is root-bound and verified on chain. Contract: [AttestationVault](../contracts/attestation-vault).

**The record.** A claim is proven against one attester's record (`recordKey(attesterId, payloadHash)`). `issue*` actions take an optional `attesterId` (cross-root: `attesterIdA`/`attesterIdB`; batch entries `attesterIdB`), default the session's own; a content root can only be anchored under the session's own record. `PredicateAttestations` rows record the attester; the verify functions take the same selector.

**Claim expiry.** Every `issue*` action takes an optional `validUntil` (UNIX seconds): default one year ahead (`NIGHTGATE_CLAIM_LIFETIME_S`), at most five years. An expired claim verifies false and can be removed with `purgeExpired`.

**Width variants:** tree dimensions come from the `compiledArtifactRef` registration (`slotWidth`, default 16). `attestation-vault-32` carries 32 fields under one root: 5-entry inclusion paths, 32-entry schema/opening, `allowedMask` up to 32 bits, `k` up to 32. Same circuits and deploy cost; the comparison prover is 72.9 MB (~2x proving time). Cross-root proofs only within one width; the variants are separate contracts, so pick a width per document family.

**Prover keys.** The npm package ships modules, verifier keys, zkir and `keys/manifest.json` (sha256 + size per prover key), but no prover keys. Deploy and crawler-free verification need nothing more; the first proving job fetches missing keys from `NIGHTGATE_ZK_ASSET_URL` (a `/zk-config` base; default: the release's git tag), verifies them against the manifest and writes them next to the verifier keys (also required to serve `/zk-config`). Without outbound access, fetch once:

```bash
npx nightgate-fetch-keys attestation-vault-32
# or from a NIGHTGATE that already has them:
npx nightgate-fetch-keys attestation-vault-32 --from https://host/zk-config/attestation-vault-32
```

The generation digest pins the manifest, not the key bytes: a fetch changes no recorded evidence and needs no restart. Container images already contain the keys.

### `issueFieldPredicateAttestation(payloadHash, attesterId?, fieldKey, value, fieldSalt, predicate, threshold, sessionId, contractAddress, contentRoot?, schemaId?, siblingsJson?, dirsJson?, unit?, compiledArtifactRef?, idempotencyKey?, sponsorSessionId?) → { jobId, status, predicateAttestationId }`

Prove the scaled integer `value` at `fieldKey` against `threshold` (`proveFieldPredicate`, Merkle inclusion in the anchored content root). A given `contentRoot` is anchored first (`anchorContentRoot`, requires `schemaId`). `value` stays witness, never persisted; `value` must fit Uint<64>, `threshold` is recorded and stays at most 9223372036854775807 (2^63 - 1). `siblingsJson`/`dirsJson`: inclusion path of depth log2(width) (4 × 64-hex siblings and 4 booleans at width 16, 5 at 32). Job result `{ predicateAttestationId, payloadHash, claim, proof }`. **Rate limit:** 10/hour per session.

### `issueFieldPredicateAttestationBatch(payloadHash, attesterId?, claimsJson, sessionId, contractAddress, contentRoot?, schemaId?, compiledArtifactRef?, idempotencyKey?, sponsorSessionId?) → { jobId, status, claims, droppedDuplicates }`

Prove up to 8 claims on ONE payload in ONE transaction (one balancing, submit, confirmation and fee; with `sponsorSessionId` one dust spend). `claimsJson` entries mix kinds by `predicate`, each validated like its single action:

- numeric: `{ fieldKey, value, salt, siblings, dirs, predicate: 'lessOrEqual'|'greaterOrEqual', threshold, unit? }`
- equality: `{ fieldKey, expectedValue|expectedDigest, salt, siblings, dirs, predicate: 'bytesEquality' }`
- membership: `{ fieldKey, value|valueDigest, salt, allowedValues | setRoot+setSiblings+setDirs, siblings, dirs, predicate: 'setMembership' }`
- integrity: `{ predicate: 'documentIntegrity', payloadHashB, attesterIdB?, allowedMask, schema, openingA, openingB }`
- diff: `{ predicate: 'documentDiff', payloadHashB, attesterIdB?, k, schema, openingA, openingB }`

Cross-root: document A is the batch `payloadHash`; an in-batch `contentRoot` is A's root, B's must already be anchored. A given `contentRoot` (with `schemaId`) is anchored as the first call and takes one of the 8 slots. Exact duplicate claims are dropped (`droppedDuplicates`). One `PredicateAttestations` row per claim, one shared `provenTxHash`; `claims` is a JSON array of `{ predicateAttestationId, fieldKey, predicate, ... }`. Proofs run sequentially, one per claim. A false claim fails at local proving (nothing submitted); after submission `PARTIAL_SUCCESS` fails the job with `OnChainStatus:...`, so verify per claim with `verifyPredicateAttestation`. **Rate limit:** N claims against the shared 10/hour predicate budget.

### `issueFieldEqualityAttestation(payloadHash, attesterId?, fieldKey, expectedValue|expectedDigest, fieldSalt, sessionId, contractAddress, contentRoot?, schemaId?, siblingsJson?, dirsJson?, compiledArtifactRef?, idempotencyKey?, sponsorSessionId?) → { jobId, status, predicateAttestationId }`

Prove the bytes field at `fieldKey` holds the value whose blake2b-256 digest is `expectedDigest` (`proveFieldEquality`). Pass one of `expectedValue` (exact string, no trimming) or `expectedDigest` (64 hex). The digest is public: authenticity, not confidentiality (a low-entropy value is guessable). The field must be `kind: 'bytes'` in `prepareDocumentProof`; path as on the numeric action; a given `contentRoot` is anchored first (requires `schemaId`). **Rate limit:** 10/hour per session (shared predicate budget).

### `issueFieldMembershipAttestation(payloadHash, attesterId?, fieldKey, value|valueDigest, allowedValuesJson | setRoot+setSiblingsJson+setDirsJson, fieldSalt, sessionId, contractAddress, contentRoot?, schemaId?, siblingsJson?, dirsJson?, compiledArtifactRef?, idempotencyKey?, sponsorSessionId?) → { jobId, status, predicateAttestationId }`

Prove the hidden bytes value at `fieldKey` is one of a public allow-list of up to 64 values, without revealing which (`proveFieldMembership`; set rule: `prepareMembershipSet`). Pass one of `value` or `valueDigest` (64 hex; witness, never persisted), and either `allowedValuesJson` (400 before proving if the value is absent) or `setRoot` + `setSiblingsJson`/`setDirsJson` (6 × 64-hex siblings, 6 booleans). **Rate limit:** 10/hour per session (shared predicate budget).

### `issueDocumentIntegrityAttestation(payloadHashA, payloadHashB, attesterIdA?, attesterIdB?, allowedMask, schemaJson, openingAJson, openingBJson, sessionId, contractAddress, contentRootA?, contentRootB?, schemaId?, compiledArtifactRef?, idempotencyKey?, sponsorSessionId?) → { jobId, status, predicateAttestationId }`

Prove document B differs from A only in slots set in `allowedMask` (`proveDocumentComparison` mode 0; width bits, bit i = slot i may differ, 0 = identical; a mask constraining no real slot is rejected), values hidden. `schemaJson` is the shared descriptor list, `openingAJson`/`openingBJson` the openings (`schema`/`opening` from `prepareDocumentProof`); the circuit recomputes the schema root and both content roots, so a forged schema id fails the proof. Both documents must be anchored under the same `schemaId`. A change outside the mask fails at local proving. `payloadHashA != payloadHashB` (asserted in-circuit); (A, B) order is part of the claim key. `contentRootA`/`contentRootB` anchor first, one transaction each (the batch `documentIntegrity` kind does it in one). **Rate limit:** 10/hour per session (shared predicate budget).

### `issueDocumentDiffAttestation(payloadHashA, payloadHashB, attesterIdA?, attesterIdB?, k, schemaJson, openingAJson, openingBJson, sessionId, contractAddress, contentRootA?, contentRootB?, schemaId?, compiledArtifactRef?, idempotencyKey?, sponsorSessionId?) → { jobId, status, predicateAttestationId }`

Prove at least `k` (1..width) aligned slots differ between two anchored documents, hiding which (`proveDocumentComparison` mode 1; k=1: provably not the same document). Witnesses as in the integrity mode, never persisted. A value or presence change counts; both-empty and padding slots do not. One descriptor list must fold to both anchored schema ids. Fewer than k differences fail at local proving. **Rate limit:** 10/hour per session (shared predicate budget).

### `verifyPredicateAttestation(predicateAttestationId) → { verified, included, stateChecked, predicate, threshold, unit, expectedDigest, setRoot, payloadHashB, allowedMask, provenTxHash, provenAt }` (function)

`verified: true` iff the claim stands in live state: the claim key, recomputed from the row and the payload's current anchor (root, schema id), is in the vault's `claims` map and not past `valid_until`. Retract, re-anchor or expiry turn it false. `included`: proof tx indexed as `SUCCESS`; `stateChecked: false`: no live provider for the record's network, so `verified` stays false and only `included` is reported. A diff row's k is in `threshold`.

## Crawler-free state verification

Read live contract state (`queryContractState`): no crawler, txHash or server row needed, e.g. for wallet-submitted transactions. Absent state or no live provider: `verified: false`, not a 5xx. `network` (e.g. `preview` | `preprod`) reads another network's public indexer (unknown: 400; endpoints via `cds.requires.nightgate.networks.<network>.*`).

**Public lane.** `NIGHTGATE_PUBLIC_VERIFY=true` serves both functions without credentials at `/api/v1/verify` (`NightgateVerifyService`, same signatures and results): the image admits the path unauthenticated with CORS `*`; a CAP host serves it under `@requires: 'any'`. Off (default): `404 PUBLIC_VERIFY_DISABLED`. Rate limit `NIGHTGATE_PUBLIC_VERIFY_RATE_LIMIT` (default 60/min per client address). Nothing enumerable: every call needs contract, payload and claim coordinates. `verifyDocument` and `verifyPredicateAttestation` stay private (owner-scoped rows).

**Independent verification:** everything these functions check is recomputable from public data: read the vault state from the public indexer, recompute the claim key (`persistentHash` over the tagged claim struct, e.g. bytes equality `{ tag 17, recordKey, contentRoot, schemaId, fieldKey, expectedDigest }` with `recordKey = persistentHash({ tag 21, attesterId, payloadHash })` and root and schema id from `content_anchors`), and look it up in `claims` (value: `valid_until` block time). The Compact source ships in the npm package under `contracts/attestation-vault/src/`.

### `verifyAttestationState(contractAddress, attesterId?, payloadHash?, documentId?, contentRoot?, schemaId?, compiledArtifactRef?, network?) → { verified, attested, contentRootOk, schemaOk, bindingRegistered, attesterId, payloadHash, recordKey, documentId }` (function)

Checks the attester's record of `payloadHash` (`recordKey(attesterId, payloadHash)`) is in the vault's attestation map and, when given, that `contentRoot` / `schemaId` match its anchor. Alternatively a bound `documentId` resolves the record via `document_bindings` and the answer names the attester (a `payloadHash` or `attesterId` next to it must match). No enumeration. **Trust:** an anchor is the attester's own statement; for cross-party claims also check `attesterId` against the identity you trust and, for cross-root claims, `schemaId` against the expected panel schema. A resolution by `documentId` alone is only as trustworthy as the id's registration: unregistered ids are first-come-first-served, so any attester may bind a free id to its own record of the same hash (`bindingRegistered: false`); `bindingRegistered: true` says the registrar assigned the id to this attester.

### `verifyPredicateState(contractAddress, attesterId, payloadHash, predicate, threshold?, fieldKey?, expectedDigest?, setRoot?, payloadHashB?, attesterIdB?, allowedMask?, k?, compiledArtifactRef?, network?) → { verified, proven }` (function)

Id-free counterpart to `verifyPredicateAttestation`: recomputes the claim key from the given coordinates and checks the `claims` map for an unexpired entry. `attesterId` names the record owner (cross-root: `attesterIdB` for document B, default `attesterId`).

- Numeric: `fieldKey` + `threshold` (the same scaled integer the circuit hashed, else `verified: false`).
- `bytesEquality`: `fieldKey` + `expectedDigest`; `setMembership`: `fieldKey` + `setRoot` (`threshold` ignored).
- `documentIntegrity`: `payloadHashB` + `allowedMask`; `documentDiff`: `payloadHashB` + `k`. `payloadHash` is document A; the (A, B) order must match the proving order.

The claim key embeds the record's current anchor (root and schema id; cross-root: both roots, shared schema), read from the same state: a claim under a former anchor, an expired claim, or a comparison without both anchors under one schema verifies false. External recomputes (`computeFieldPredicate/Equality/MembershipClaimKey` and the cross-root computers) must pass the current root(s) and schema id from `content_anchors`.

`valid_until` is a storage lifetime, not a policy of the attester: the proof circuits need no attester secret, so any holder of the opening (salt seed and values) may prove the same statement again and extend the expiry up to the five-year cap, never shorten it. The attester withdraws claims by retracting the record; re-anchoring the same root under the same record makes the unexpired claims resolve again without a new proof.

## Disclosure grants

The vault's on-chain disclosure ACL (which grantee holds which tier of a record) plus the document identifier registry (`registerDocument` / `bindDocument` circuits). Grant and revoke are attester-gated, `registerPassport` registrar-gated, both enforced in-circuit. `level`: `0` public, `1` legitimate interest, `2` authority. Only entitlement is on chain; tier-specific cleartext delivery stays off-chain (consumer `after READ` redaction). Contract: [AttestationVault](../contracts/attestation-vault).

### `grantDisclosure(payloadHash, grantee, level, sessionId, contractAddress, compiledArtifactRef?, idempotencyKey?, sponsorSessionId?) → { jobId, status, disclosureGrantId }`

Grant `grantee` (64-hex `Bytes<32>`) a tier on the session's own record of the payload (`grantDisclosure` circuit); the caller must have attested it. The `DisclosureGrants` row is inserted at once (`active=false`) and set active once the chain reindex confirms the grant. Job result `{ disclosureGrantId, payloadHash, grantee, level, txHash }`. `compiledArtifactRef` defaults to `attestation-vault`. **Rate limit:** 30/hour per session.

### `revokeDisclosure(payloadHash, grantee, sessionId, contractAddress, compiledArtifactRef?, idempotencyKey?, sponsorSessionId?) → { jobId, status }`

Remove a grantee's entry on chain (`revokeDisclosure` circuit); attester-only. The `DisclosureGrants` row turns inactive. Job result `{ payloadHash, grantee, txHash }`. **Rate limit:** 30/hour per session.

### `reindexDisclosures(contractAddress, compiledArtifactRef?) → { contractAddress, active, deactivated, reconciledAt }`

Reconcile `DisclosureGrants` with the vault `disclosures` map in live state, e.g. after a wallet-submitted grant or revoke. Idempotent, crawler-independent. `active` = grants on chain afterwards; zero (not a 5xx) without a live provider. **Rate limit:** 60/hour per contract.

### `registerPassport(documentId, ownerId, mode?, sessionId, contractAddress, compiledArtifactRef?, idempotencyKey?, sponsorSessionId?) → { jobId, status }`

Document id registry (`registerDocument` circuit; `passportId` is an alias of `documentId`). Modes 0 to 2 are registrar-only, in-circuit: the registrar is a constructor argument (NIGHTGATE deploys use the deploy session's attester id; an external deployer may nominate another). `mode` 0 (default) assigns `documentId` (64 hex) to `ownerId`, the only attester who may bind it via `bindDocument`; re-registering transfers ownership and releases a binding held by another attester (the id resolves to nothing until the new owner binds). Unregistered ids stay first-come-first-served. `mode` 1 unregisters (`ownerId` ignored); `mode` 2 hands the registrar role to `ownerId` (`documentId` ignored). Modes 3 and 4 belong to the recovery identity named at deploy (`deployContract` `recoveryId`; `documentId` ignored): 3 re-points the registrar to `ownerId`, 4 hands the recovery role to `ownerId`. Job result `{ documentId, ownerId, mode, contractAddress, txHash }`. **Rate limit:** 30/hour per session.

### `retractAttestation(payloadHash, sessionId, contractAddress, compiledArtifactRef?, idempotencyKey?, sponsorSessionId?) → { jobId, status }`

Remove the caller's record of a payload (`retract` circuit, mode 0): attestation, content anchor, disclosure grants and document binding leave the chain; `DisclosureGrants` rows turn inactive. Claims on its root stop verifying (they stay in `claims` until purged). The payload may be attested again. Job result `{ mode, key, contractAddress, txHash }`. **Rate limit:** 30/hour per session.

### `purgeExpired(kind, key, sessionId, contractAddress, compiledArtifactRef?, idempotencyKey?, sponsorSessionId?) → { jobId, status }`

Removes an expired ledger entry via the `retract` circuit; any wallet session may call it. `kind` `claim` removes an expired claim (`key` = claim key, mode 1). The vault refuses an entry that has not expired. **Rate limit:** 30/hour per session.

### `registerGranteeIdentity(bindingInput, scope?) → { ID, granteeId, bindingKind }`

Bind the caller (`req.user.id`) to the `Bytes<32>` grantee id the vault checks, so on-chain grants resolve to this principal. `cds.requires.nightgate.granteeBinding` (default `wallet`) sets what `bindingInput` is: `wallet` the coin public key (hex), `did` a DID, `custom` the 64-hex id. `scope` narrows the binding to one contract or attestation (omit for global). Idempotent on `(userId, scope)`. Proving ownership of the binding input is the consumer's policy.

## Diagnostics

### `getWalletBalance(sessionId) → { shieldedNight, unshieldedNight, shieldedTokens[], dustBalance, registeredNightUtxoCount, totalNightUtxoCount, dustUtxoCount, dustPendingCount, dustPendingValue, dustRestoreCount }`

Read-only; amounts are decimal atom strings. `shieldedTokens`: other shielded token types with a non-zero balance (`tokenType` as returned by `deriveTokenType`, `amount`), spendable via `sendNight(tokenTypeHex)`. Dust fields: `dustUtxoCount` tracked notes, `dustPendingCount`/`dustPendingValue` in-flight spends, `dustRestoreCount` wedge-protection restores confirmed persisted (process lifetime). `registeredNightUtxoCount > 0` with `dustUtxoCount == 0` and `dustPendingCount == 0` while fees keep failing means a dust wedge, not an empty wallet (see the operations guide).

**Rate limit:** 60/min per client IP.

```bash
curl "http://localhost:4004/api/v1/nightgate/getWalletBalance(sessionId='c07b1f0a-...')"
```

Response:
```json
{
  "shieldedNight": "1000000000000",
  "unshieldedNight": "0",
  "shieldedTokens": [{ "tokenType": "248c11531d5a35b333a590489c47d6fe114be403e442bf6e088e3e9b0c06fdbc", "amount": "420000000" }],
  "dustBalance": "2098000",
  "registeredNightUtxoCount": 1,
  "totalNightUtxoCount": 1,
  "dustUtxoCount": 1,
  "dustPendingCount": 0,
  "dustPendingValue": "0",
  "dustRestoreCount": 0
}
```

**Wallet still syncing:** after `NIGHTGATE_WALLET_READ_SYNC_TIMEOUT_MS` (default 10 s) without reaching the indexer tip the read answers `503 WALLET_SYNCING` (retryable; poll again once the prewarm job is ready). Same gate for the fee estimate.

### `getSponsorPoolStatus() → [{ sessionId, configured, usable, dustBalance, unshieldedNight, totalNightUtxoCount, registeredNightUtxos, dustNotes, pendingDustNotes, dustRestoreCount, caughtUp, lastError }]`

Health of every session in `NIGHTGATE_FEE_SPONSOR_SESSION` / `cds.requires.nightgate.feeSponsorSessions`.

- `dustNotes`: spendable notes = parallel sponsoring capacity (one note per in-flight tx; committed notes count in `pendingDustNotes`). Not the same as `registeredNightUtxos` (the sponsor's own registered NIGHT; delegated generation adds notes without it).
- `pendingDustNotes > 0`: spend in flight or a leaked note; `dustRestoreCount`: wedge-protection restores.
- `usable`: spendable notes, dust > 0 and `caughtUp`.
- `caughtUp`: the sync gate a sponsored job must pass (connected, within `NIGHTGATE_SYNC_TIP_GAP` events of the dust stream tip, indexer fresh), as last pushed by the worker every `NIGHTGATE_PROGRESS_WATCH_MS`; a reading older than two intervals counts as false. A readable balance does not imply it; `lastError` then says why.
- `dustBalance`, `unshieldedNight`: null unless admin or session owner. An unreadable sponsor is a row with `lastError`.
- Never builds a cold facade: a sponsor neither resident nor reporting progress returns `lastError`. Per-sponsor cap `NIGHTGATE_SPONSOR_STATUS_TIMEOUT_MS` (default 45 s), enforced on the worker RPC.
- Not available to agent tokens (403).

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
  }
]
```

### `getWalletSyncProgress(sessionId) → { known, caughtUp, appliedIndex, streamTip, behindEvents, eventsPerSecond, etaSeconds, blockHeight, isConnected, indexerFresh, elapsedMs, phase, updatedAt, lastProgressAt, staleSeconds, stale, jobId, jobStatus, restoredFromSnapshot, snapshotSavedAt, facadeBuiltAt }`

Wallet catch-up progress, from a snapshot the worker pushes about every 15 s (cheap to poll during a sync; also logged at INFO under `nightgate:worker` as `genuine-sync [<phase>] ... rate=... eta=...`).

- `appliedIndex`, `streamTip`, `behindEvents`: dust ledger events (not blocks), decimal strings. `etaSeconds`: order of magnitude. `known: false`: nothing reported yet.
- Healthy: `appliedIndex` climbs, `eventsPerSecond` > 0. Stuck: `appliedIndex` unchanged while `elapsedMs` grows, or `isConnected: false`. `indexerFresh: false`: the indexer lags, its tip is not chain tip.
- `staleSeconds`: snapshot age; `stale` past `NIGHTGATE_SYNC_PROGRESS_STALE_S` (default 60 s) means nobody is syncing. `jobId`/`jobStatus`: latest prewarm job. `lastProgressAt`: last advance of `appliedIndex`. The prewarm fails after `NIGHTGATE_PREWARM_STALL_MS` (default 10 min) without progress, or at `NIGHTGATE_PREWARM_SYNC_TIMEOUT_MS` (default 12 h).
- Sync state is persisted per account (`WalletSyncStates`); a reconnect applies only the delta, a wallet without snapshot syncs from zero. `restoredFromSnapshot` (false = cold start), `snapshotSavedAt`, `facadeBuildStartedAt`, `facadeBuiltAt` (null while deserializing, which takes minutes for a large dust state); all null while nothing is built. Logged under `nightgate:facade` (`sync state RESTORED from snapshot ...`, `COLD START`, `built in Ns`).

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

### `estimateSendNightFee(sessionId, receiverAddress, amount, ttlIso?, tokenTypeHex?) → { fee, toLedger }`

DUST fee (atoms, decimal string) for a `sendNight`: builds the recipe in the worker, no proof, no submit. `tokenTypeHex` (64 hex) prices a custom-token send.

## Indexer / health / metrics

### `getHealth() → { status, chainHeight, indexedHeight, finalizedHeight, lag, finalizedLag, blocksPerSecond, syncStatus }`

The crawler's view, not the wallet's; with `NIGHTGATE_CRAWLER_ENABLED=false` it returns the last persisted `SyncState`.

### `getSyncStatus() → SyncState`
### `getMetrics() → String`

`getMetrics` returns Prometheus text, prefix `odatano_nightgate_*`: chain and indexed height, sync lag, block throughput, error counts, uptime, sync status (stopped=0, syncing=1, synced=2, error=3), runtime topology (`_runtime_topology_valid`, `_runtime_replicas`, `_runtime_database_info`), jobs (`_jobs_queued`, `_jobs_running`, `_jobs_reconciliation_required`, `_jobs_oldest_queued_seconds`) and wallet worker (`_wallet_worker_running`, `_wallet_worker_inflight_rpcs`, `_wallet_worker_exits`).

Over OData the text arrives wrapped in JSON (`{"value":"..."}`); unwrap it before feeding a Prometheus parser. The five read-only probes (`getLiveness`, `getReadiness`, `getMetrics`, `getSyncStatus`, `getHealth`) are anonymous at the model level, so a scraper or a K8s probe needs no credentials; `getReadiness()` answers 503 when a check fails. (Up to 0.24.3 the image also served plain `/nightgate/metrics|health|ready` routes behind their own bearer token; they are gone, the OData functions are the one surface.)

### `getRuntimeInfo() → { version, apiVersion, network, provingMode, instanceId, runtimeMode, databaseKind, uptime, contracts[] }`

Process identity plus two digests per registered contract: `artifactDigest` (the generation loaded and stamped onto persisted commands) and `currentDigest` (the files now). `digestStale: true`: artifacts were replaced under the running server; write jobs fail the generation guard until restart. A contract whose artifact does not load returns null digests with `digestError`. `currentDigest` is cached by file stat fingerprint (size, mtime, ctime, inode, mode) and re-hashed after `NIGHTGATE_ARTIFACT_DIGEST_MAX_AGE_MS` (default 5 min); `resolveContract` always hashes the bytes it imports. `@requires: 'authenticated-user'`, 30/min per client.

### `getWorkerStatus() → { started, running, inFlightRpcs, exitCount, rotationCount, lastExitCode, lastExitAt, rpcTimeoutMs, facadeCount, facades[] }`

Process-level worker health (per facade: `getWalletSyncProgress`). A climbing `exitCount` means crash-looping; an ever-growing `inFlightRpcs` a stall. Not part of `getReadiness` (a busy worker must not leave rotation). `facades[]` is admin-only (its ids identify wallets across tenants); `facadeCount` is always set. `@requires: 'authenticated-user'`.

### `getLiveness() → { status, timestamp, uptime }`
### `getReadiness() → { ready, crawlerEnabled, checks: { database, crawler, node, runtime, initialization }, initializationMode }`

Kubernetes-style probes. `ready: true` when every applicable check passes; a disabled crawler (the Docker default) passes `crawler`/`node` as not applicable (`crawlerEnabled: false`).

`initialization` is true only after `initialize()` completed and did not end offline. It fails for:

- `initializationMode: 'offline'`: schema preflight refused the database, or the crawler or submission pipeline did not start.
- `'idle'` without the initialised flag: before `initialize()`, `SKIP_AUTO_INIT`, plugin never started, or after `shutdown()` (a successful crawler-less start is also `'idle'`, but with the flag).

A failing check appends a sanitised reason to `runtimeWarnings`; the raw error stays in the log. With `SKIP_AUTO_INIT`, probe your host's own endpoint.

### `getReorgHistory(limit?) → ReorgLog[]`

Last `limit` (default 10, max 100) reorg events with depth, detected-at timestamp, rolled-back tx count.

### `pauseCrawler() / resumeCrawler() / reindexFromHeight(height)` - actions

`@requires: 'admin'` (401/403 otherwise). `reindexFromHeight` rolls back to the height (recomputing `NightBalances` for affected addresses; job and submission outcomes confirmed at or above it return to a pending chain status until re-confirmed) and catches up from there. Status, health and metrics functions stay open for probes.

`resumeCrawler` starts the crawler whatever `NIGHTGATE_CRAWLER_ENABLED` says, with the configured brakes (`crawler.fetchConcurrency`, `crawler.rpcBatchSize`, `crawler.maxBlocksPerSecond`); neither pause nor resume survives a restart. It also retries a block that was latched as unindexable, which is the recovery path when `syncStatus` sits at `error` and `lastError` names a height.

## Analytics

`getBlockCount() / getTransactionCount() / getContractCount() / getAverageTransactionsPerBlock()` - simple aggregate queries over the indexed entities. `getContractCount` counts distinct contract addresses reported by the pallet's contract events; `ContractStatistics` counts actions per type.

## Admin

`invalidateSession(sessionId)` / `invalidateAllSessions()`: force-close any session (unlike `disconnectWallet`, not only the caller's own).

`exportContractSigningKey(sessionId, contractAddress, password) → { format, encryptedPayload, salt, contractAddress, accountId }`: export a contract's maintenance signing key from the session that deployed it, sealed under `password` (at least 16 characters); `importSigningKeys` restores it. Whoever holds it can replace the contract's verifier keys; store it offline.

`BackgroundJobs` (read-only entity): the job queue without `command`, `request` and `result` (`command` is encrypted at rest), with full OData queries, e.g. `?$filter=status eq 'failed'&$orderby=createdAt desc`. It is a SQL view: on an existing database it appears only after `cds deploy` or `nightgate-schema-delta`.

`getJobStats(windowHours?) → { windowHours, since, total, byStatus[], topErrors[], oldestQueuedSeconds }`: counts per status and the ten most frequent error codes over `windowHours` (default 24, max 720).

`registerContract(name, artifactPath, zkConfigPath, privateStateId, slotWidth?) → { name, source, artifactPath, zkConfigPath, privateStateId, slotWidth, artifactDigest, hasProverKeys }`: register a contract artifact without a restart.

- Contracts from `cds.requires.nightgate.contracts` are the immutable floor: a config name is `409`.
- Paths must resolve inside `NIGHTGATE_CONTRACTS_DIR` (default: the package's and the working directory's `contracts/`); importing an artifact executes its module.
- Validated before anything changes: the module exports a Compact `Contract` class, the zk-config directory holds `keys/*.verifier` and `zkir/`.
- Persisted in `ContractRegistrations`, reloaded at boot. `artifactDigest` is the generation persisted commands are pinned to; a new artifact under the same name is a new generation, and jobs recorded against the old one refuse.
- `hasProverKeys: false`: deploy and verify only, no proving here. `/zk-config`, `/contract-manifest` and `getRuntimeInfo()` see the contract at once.

`unregisterContract(name) → { removed }`: remove a runtime registration; config names are `409`.

`listContracts() → [{ name, source, ..., artifactDigest, hasProverKeys }]`: every known contract, `source` `config` or `runtime`.

`profileWorker(seconds?, dir?, thread?) → { thread, seconds, file, facadeCount, sampledMs, idlePercent, gcPercent, wasmPercent, topFunctions[], topFiles[], topInclusive[], heapBefore, heapAfter, gc }`: CPU profile of the wallet worker (`thread: 'worker'`, default) or the main thread (`'main'`) for `seconds` (1..120, default 20) while it keeps serving. Returns self time by function and file, inclusive hot paths, idle/GC/wasm shares, heap figures before and after, and GC counts (`gc.byKind` as JSON). The `.cpuprofile` is written under `dir` (default: OS temp dir, `nightgate-profiles/`). The request waits `seconds + 60 s`. A warm facade at tip idles above 90 %, GC under 10 %.

`grantRole(userId, role, scope?, validUntil?)`: grant an off-chain disclosure tier (`public_only` | `legitimate_interest` | `authority`, table `DisclosureRoles`), read by the `AttestationService` middleware `attachDisclosureRole`. The caller must hold `authority`.

> **On-chain alternative.** `attachDisclosureRole(req, db, { contractAddress, payloadHash?, attesterId? })` resolves the tier from active on-chain `DisclosureGrants` for the caller's grantee id (`registerGranteeIdentity`). One attestation is named by `payloadHash` plus its `attesterId`; a payload without its attester resolves to `public_only`. With `contractAddress` the on-chain result is authoritative (no off-chain fallback); without it the `grantRole` table applies. The consumer wires the middleware into the reads it gates.

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

OData envelope `{ error: { code, message } }`. For submission errors `message` is a JSON string with the classification:

```json
{
  "error": {
    "code": "400",
    "message": "{\"code\":\"Wallet.InsufficientFunds\",\"retryable\":false,\"message\":\"Insufficient Funds: could not balance dust\",\"submissionId\":\"54b1968a-...\"}"
  }
}
```

**Retryable 503s keep their body in production** (CAP otherwise replaces every 5xx message under `NODE_ENV=production`) and set `Retry-After`:

| `error.code` | Meaning | `Retry-After` |
|---|---|---|
| `JOB_ADMISSION_BUSY` | database busy for the whole admission retry budget; nothing written or submitted, resend | 2 s |
| `WALLET_SYNCING` | a wallet read hit the sync gate; poll again once the prewarm job is ready | 15 s |
| a retryable submission code (`1016`, `NetworkOrTimeout`) | the JSON payload below, `retryable: true` | none |

Every other 5xx is a server fault and stays sanitised.

**Classification.** The wallet worker classifies a submit failure once, from the SDK error objects, and sends the result as data (`code`, `ledgerCode`, `retryable`, batch `calls`, cause chain); the main thread never parses message text. Worker codes:

| Worker code | Meaning |
|---|---|
| `pre-mempool-reject` | node refused before the mempool, fee unspent; `ledgerCode` `1010/<n>`, `1014`, `1016` or `intent-rejected` |
| `dust-race` | `1010/170`, `1010/196` or `pool-invalid`; rebuild-retryable |
| `transport` | the send failed before an answer; `closing-socket` when it never left |
| `ambiguous` | the broadcast may have landed; reconciled by identifier, never rebuilt |
| `landed-not-applied` | on chain, call not applied |
| `policy` | sponsor shape check or allow-list refusal |
| `causality` | batch causality refusal before proving |
| `internal` | anything else |

Job codes (`classifySubmissionError`, `srv/submission/TransactionSubmitter.ts`):

| Code | Retryable | Trigger |
|---|---|---|
| `TxFailed` | no | SDK `TxFailedError`: on-chain status not `SucceedEntirely` |
| `1014` | no | Substrate "invalid transaction" |
| `1016` | yes (preprod) / no (mainnet) | "Immediately Dropped" |
| `NetworkOrTimeout` | yes | `transport`: `ECONNREFUSED`, `ECONNRESET`, `ENOTFOUND`, `ETIMEDOUT`, `socket hang up`, `timeout` |
| `NetworkOrTimeout` (`not-sent`) | yes | `transport`, `not-sent`: connect failed before the send; nothing on chain, attempt closed `REJECTED`, sponsored job fails after one retry on a fresh client |
| `SubmitAmbiguous` | no | `ambiguous`: no node status (`no-reply`), no InBlock, or node request timeout, and the indexer does not know the tx; job parks as `reconciliation_required / BROADCAST_UNCONFIRMED`, resolved by identifier (see [async job model](#async-job-model-write-actions)) |
| `PoolInvalid` | yes | `dust-race`, `pool-invalid`: pool status Invalid without a ledger code; one rebuild on sponsored paths |
| `SubmitIntentRejected` | no | `pre-mempool-reject`, `intent-rejected`: the identifier could not be persisted, nothing broadcast |
| `SubmitIntentTimeout` | no | `pre-mempool-reject`, `intent-timeout`: identifier not recorded within `NIGHTGATE_SUBMIT_INTENT_ACK_TIMEOUT_MS`; nothing broadcast, retry with a new `idempotencyKey` |
| `SponsorPolicyRefused` | no | `policy` |
| `BatchCausalityViolation` | no | `causality`; `calls` (name, segId, stages in apply order) on the classification and in the message |
| `ContractTypeError` / `IncompleteCallTxPrivateStateConfig` / `IncompleteFindContractPrivateStateConfig` | no | SDK contract configuration errors (by error `name`) |
| `WalletSigningNotAvailable` | no | session has no encrypted seed |
| `<error name>` (default) | no | any other error, by its `name` |

Raw node or SDK errors instead of a job code:

- **`1010/170`, `1010/196` (dust race):** the dust spend was built on a dust state the node has moved past (170: stale merkle root or validity window, e.g. lagging indexer or unsynced wallet; 196: nullifier already known, concurrent spend of the same note). Pre-mempool, no fee. Marked `retryable: true, transient: "dust-race"`; deploy, call and batch rebuild inside the worker call (`NIGHTGATE_DUST_RACE_RETRIES`, default 2; `NIGHTGATE_DUST_RACE_BACKOFF_MS`, default 5000), sponsored paths via `NIGHTGATE_SPONSOR_DUST_RETRIES`. `failed assert: predicate false` is a predicate-circuit rejection.
- **`Wallet.InsufficientFunds`:** not enough dust for the fee or NIGHT for the outputs.
- **`MalformedResult`:** the SDK returned without the expected fields; thrown by `TransactionSubmitter`, not a job code.

For diagnostic 503s caused by the hosted Midnight indexer, see [docs/operations.md#troubleshooting](operations.md#troubleshooting).
