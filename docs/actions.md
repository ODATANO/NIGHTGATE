# Actions reference

OData V4 actions (POST, side effects) and functions (GET, read-only). Parameter names and types come from the CDS model under `srv/*.cds`. This page adds what the model does not say.

| Base path | Service | Access |
|---|---|---|
| `/odata/v4/midnight` | `NightgateService`: chain entities, sessions, jobs, proofs, sponsoring | authenticated user |
| `/odata/v4/midnight-indexer` | `NightgateIndexerService`: probes, sync state, crawler control | set per function |
| `/odata/v4/midnight-analytics` | `NightgateAnalyticsService` | authenticated user |
| `/odata/v4/midnight-admin` | `NightgateAdminService` | admin |
| `/odata/v4/midnight-verify` | `NightgateVerifyService`, see [Crawler-free state verification](#crawler-free-state-verification) | anonymous, off by default |

A function parameter left out of the URL counts as `null`. An undeclared parameter answers 400.

`contractName` is the name a contract is registered under, as `listContracts` and `/contract-manifest` show it.

A hex parameter takes its value with or without `0x`, in either letter case, also inside a list or a structure. This holds for hashes, attester ids, field keys, salts, digests, token types, contract addresses, seeds and viewing keys. The server works with lowercase hex without `0x` and answers in that spelling.

An amount is a decimal integer in atoms, sent as text: digits only, no sign, no spaces, no `0x`. An address is the bech32m text of the wallet, `mn_addr...` unshielded, `mn_shield-addr...` shielded, `mn_dust...` DUST, with the network after the kind on a test network and without it on mainnet. A value in another form answers 400 `ASSERT_FORMAT` with the parameter in `target`, before the action runs.

A value from a fixed list is declared as that list in the model. A parameter outside its list answers 400 `ASSERT_ENUM`, a number outside its range 400 `ASSERT_RANGE`. That holds for every page size `limit`: `Transactions/byHash` 1 to 5000 (default 100), `listSwapOffers` 1 to 200 (default 50), `getReorgHistory` 1 to 100 (default 10), `reconcileNightBalances` 1 to 500 (default 500). No list is cut down silently.

A wallet session that does not exist, is inactive or belongs to another user answers 404 `SESSION_NOT_FOUND` on every action that names one. The values follow one spelling rule: states this server defines are lowercase with underscores (`reconciliation_required`, `catching_up`), values taken from the Midnight indexer keep its upper case (`SUCCESS`, `PARTIAL_SUCCESS`), and names of checks are written like action names (`greaterOrEqual`).

A 64-bit integer arrives as text, in a table read and in the answer of an action or function: every block height, the block time in UNIX seconds, a difference of two heights. So `Blocks.height` and `getJobStatus.blockHeight` are both `"4242"`. A 32-bit number, such as a count or an attempt, is a JSON number.

An instant is a timestamp in ISO 8601, sent and answered: `"2027-11-22T00:00:00Z"`. That holds for every `validUntil` and `expiresAt`. The one number among the times is the block time in UNIX seconds, as the chain states it.

A threshold and a numeric field value are decimal integers sent as text, like an amount, and go up to 2^64-1: `"threshold": "50000"` in a body, `threshold='50000'` in a function URL. A JSON number there answers 400 `ASSERT_DATA_TYPE`, and an answer carries the same text.

Where a number is taken, send an integer above 2^53 as a decimal string. JSON rounds such a number on the way, so the server refuses it with 400 where it would enter a proof: `merkleProof.fieldValue` and every `Uint` argument of a circuit.

## API versioning

From 1.0 the API follows semantic versioning. A major release is needed when a correct call answers differently or fails after the upgrade. A minor release may add an answer field, an optional parameter or an enum value, and may refuse an invalid input earlier than before, so read answers by field name and accept enum values you do not know. What goes away is marked `@deprecated` in the CDS doc and here, and stays for at least one minor release and 90 days. A patch release never changes the API.

Before 1.0, a minor release may change or remove an action, and a patch release never does. `getRuntimeInfo().apiVersion` reports the running major.minor.

### Former action names

A request under a former name answers 404. The first start renames stored jobs and grants that still carry one.

| Former name | Current name |
|---|---|
| `issueFieldPredicateAttestation` | `proveFieldPredicate` |
| `issueFieldEqualityAttestation` | `proveFieldEquality` |
| `issueFieldMembershipAttestation` | `proveFieldMembership` |
| `issueDocumentIntegrityAttestation` | `proveDocumentIntegrity` |
| `issueDocumentDiffAttestation` | `proveDocumentDiff` |
| `issueFieldPredicateAttestationBatch` | `proveClaims` |
| `verifyAttestationState` | `verifyAttestation` |
| `verifyPredicateState` | `verifyPredicate` |
| `verifyDisclosureState` | `verifyDisclosure` |
| `sponsorFinalizedTransaction` | `sponsorFinalized` |
| `sponsorUnboundTransaction` | `sponsorUnbound` |
| `registerPassport` | `registerDocument` |
| `sendNight` | `sendToken` |
| `estimateSendNightFee` | `estimateSendTokenFee` |

`allowedActions` of `createAgentGrant`, `createAgentGrants` and `updateAgentGrant` refuses a former name with 400.

## Async job model (write actions)

Every submitting action returns `{ jobId, status: "pending" }` and runs as a background job. The job result named per action is the parsed `result` of `getJobStatus`.

- A reused `idempotencyKey` returns the existing job. The same key with another payload is 409 `IDEMPOTENCY_KEY_CONFLICT`. A key over 128 characters is 400 `IDEMPOTENCY_KEY_INVALID`. Keys are per caller: per user, and for an agent token per grant, so two tokens never meet on a key.
- The conflict names the job that holds the key to the caller that started it: the error body carries `@nightgate.job` with `{ jobId, status, chainStatus }`. A token sees it for a job of its own grant.
- A `failed` job releases its key. The next request with that key starts a new job, with any payload.
- A parked job (`reconciliation_required`) and a workflow step keep their key.
- On mainnet a submitting action answers 403 until the operator sets `NIGHTGATE_ALLOW_MAINNET_SUBMISSION=true`, because it spends real NIGHT and DUST. Reads and verify functions are not affected.

### `getJobStatus(jobId, sessionId?, waitMs?, untilChain?) → { jobId, kind, status, result, errorCode, errorMessage, attempt, maxAttempts, submissionId, txId, txHash, chainStatus, chainFinalizedAt, blockHeight, blockHash, chainSegments, queuedAt, externalExecutionAt, submittedAt, startedAt, finishedAt, receipt }` (function)

Reads a job with GET. A POST answers 405.

- `jobId` is enough. A caller reads the jobs it started, an agent token the jobs of its own grant. Any other job is 404.
- `sessionId` is optional. When given it must be the session the job runs under. For a sponsored job that is the `sessionId` the sponsor action returned.
- `status`: `pending`, `running`, `external_execution`, `submitted`, `reconciliation_required`, `succeeded` or `failed`.
- `waitMs` (at most 25000) holds the call until the job settles or the time is up. Past 100 waiting calls the server answers at once. A call ends when its client disconnects.
- `untilChain: true` with `waitMs` keeps holding a `succeeded` job while `chainStatus` is `pending`. A receipt exists only after that.
- `result` is a JSON object: what the action returned. It is null while the job has none. On failure `errorCode` and `errorMessage` are set, see [Error model](#error-model).
- `txId` is a ledger identifier of the transaction. It exists once the transaction is built and stays the same when a sponsor adds its fee. `txHash` is the ledger hash, the one explorers show. It exists once the transaction is ready to send.
- `chainStatus`: `null`, `pending`, `success`, `failure` or `dropped`. It is independent of `status`: `succeeded` with `failure` means the transaction finalized but the call reverted. `succeeded` with `dropped` means the transaction never landed before its ttl.
- `blockHeight` and `blockHash` are the confirmed inclusion. A reorg rollback reverts by them. `blockHeight` is text, like every block height.
- `chainSegments` (batches, once confirmed): a list of `{ segment, calls, applied }`, empty for any other job. A partial success reads `failed` with `chainStatus: failure`. Resend only the segments with `applied: false`.
- `receipt` is set once a `sponsorSwap` or `sponsorTransfer` job succeeded on chain, see [Receipts](#receipts).

Every submit path persists `txId` and `txHash` before the broadcast. A `failed` job without `txId` sent nothing. A pre-mempool reject closes its attempt `REJECTED` on `PendingSubmissions` and clears both.

**`reconciliation_required`.** Execution stopped after an external effect may have happened. Do not retry automatically. A new attempt needs a new `idempotencyKey`. The reconciler looks up `txId` on the indexer and ends the job `succeeded`, `failed` with `CHAIN_EXECUTION_FAILED`, or `failed` with `BROADCAST_NOT_INCLUDED` and `chainStatus: dropped`. The last happens once the indexer tip is past the transaction's ttl plus `NIGHTGATE_BROADCAST_EXPIRY_MARGIN_MS` (default 5 min).

| Parked `errorCode` | Meaning |
|---|---|
| `BROADCAST_UNCONFIRMED` | submitted, no node status, not indexed yet |
| `EXTERNAL_EXECUTION_FAILED` | failure after the broadcast |
| `PROCESS_RESTART_RECONCILE` | restart after the broadcast |
| `CHILD_RECONCILIATION_REQUIRED` | a workflow step is on chain but a later step did not complete. Once every step succeeded the workflow runs again and reuses them |
| `CHAIN_EXECUTION_FAILED_UNCONFIRMED` | on-chain failure whose block height the confirmer has not recorded yet |
| `RESULT_PERSIST_FAILED` | the transaction was sent, but the job's result could not be stored |
| `REJECTED_ATTEMPT_BOOKKEEPING_PENDING` | a refused sponsored attempt is not booked back yet; the reconciler does it |
| `LEASE_EXPIRED` | the process that ran the job stopped reporting after the broadcast. A job in that state without `txId` ends `failed` with the same code, as does one that was interrupted by more than three restarts |

### Receipts

`receipt` is `{ payload, signature, publicKey, algorithm: "ed25519" }`. `payload` is canonical JSON with sorted keys of `{ v: 2, kind, jobId, network, txId, txHash, blockHeight, blockHash, finalizedAt, swap | transfer }` with `kind` `swap` or `transfer`. A shielded transfer carries `declared: true`, because its terms are the caller's statement. An unshielded transfer carries `declared: false` and the recipient as `transfer.to`, because the server read its terms from the transaction. The signature is Ed25519 over the UTF-8 payload. The key is `NIGHTGATE_RECEIPT_SIGNING_KEY`, else derived from the active encryption key, so a key rotation changes it. `getReceiptKey()` publishes it without credentials. A third party checks a receipt with `verifyReceipt` from `@odatano/nightgate-tx`. The same facts always give the same signature.

## Rate limits

Every limited call belongs to one rate class with a fixed window and one count. The count is `NIGHTGATE_<CLASS>_RATE_LIMIT`, or `rateLimits.<class>` in `NIGHTGATE_SPONSOR_POLICY_FILE`, which applies without a restart. The caller is the agent grant, else the user, else the client address.

| Class | Window | Default | Counted per | Calls |
|---|---|---|---|---|
| `prove` | hour | 60 | caller and session | `submitContractCall`, `submitContractCallBatch`, `burnFactoryToken`, the `prove*` actions (a batch counts its claims), `anchorDocument`, `attestAgentOutput`, `registerDocument`, `retractAttestation`, `purgeExpired`, `grantDisclosure`, `revokeDisclosure`, `buildSponsorable` |
| `deploy` | hour | 5 | caller and session | `deployContract` |
| `sponsor` | hour | 120 | caller | `sponsorFinalized`, `sponsorUnbound`, `sponsorSwap`, `sponsorTransfer`, `mintFactoryToken` |
| `compute` | hour | 120 | caller | `prepareDocumentProof`, `prepareMembershipSet`, `claimDisclosure`, `grantDisclosureToHolders`, `revokeHolderDisclosure`, `postSwapOffer`, `retireSwapOffer`, `reindexDisclosures` (per contract) |
| `read` | minute | 60 | caller | `listSwapOffers`, `getSwapOffer`, `getBoardStatus`, `getReceiptKey`, `verifyDocument`, `verifyPredicateAttestation`, `getRuntimeInfo`, `getWalletBalance`, `getWalletSyncProgress`, `getSponsorPoolStatus`, `estimateSendTokenFee`, `getGrantUsage`, `getHealth`, `getSyncStatus` |
| `query` | minute | 600 | caller | every entity read, the bound read functions, `getJobStatus`, the analytics functions. Each request in a `$batch` counts on its own |
| `verify` | minute | 600 | caller | `verifyAttestation`, `verifyPredicate`, `verifyDisclosure` |
| `wallet` | minute | 10 | caller | `connectWallet`, `sendToken`, `registerForDustGeneration`, `deregisterFromDustGeneration` |
| `signing` | hour | 10 | caller | `connectWalletForSigning`, `deriveWalletInfo` |
| `admin` | hour | 10 | caller | `createAgentGrant`, `createAgentGrants`, `updateAgentGrant`, `rotateAgentGrantToken`, `revokeAgentGrant` |
| `public-verify` | minute | 60 | client address | the functions under `/odata/v4/midnight-verify` |

A grant adds `maxJobsPerHour` and `maxJobsPerDay` per UTC hour and day. A request that fails with a 4xx gives its unit back. Answers carry `RateLimit-Policy` and `RateLimit` headers. A refusal is `429 RATE_LIMITED` with `Retry-After`, not on `$batch` parts. `ContractStates/stateAt` and `Blocks/ledgerParametersAt` share one indexer budget for all callers (`NIGHTGATE_STATE_AT_INDEXER_RATE`, default 2 per second).

## Sessions

### `connectWallet(viewingKey, label?) → { sessionId, label, connectedAt, expiresAt, isActive }`

Opens a read-only session. `viewingKey` is the wallet's encryption public key, 64 hex, stored AES-256-GCM encrypted. One key is one account in every spelling: private states, contract signing keys and the saved wallet state are found again under `0x` or upper case. `label` has at most 100 characters. Rate class `wallet`. `sessionId` is the one id of the session: every session action takes it, and `WalletSessions(<sessionId>)` reads the session.

```bash
curl -X POST http://localhost:4004/odata/v4/midnight/connectWallet \
  -H "Content-Type: application/json" \
  -d '{"viewingKey":"a32699a5a29e453f6e92624c2fbefdee173d3f1178e3f9c71bc3edb7d91c1403"}'
```

### `connectWalletForSigning(sessionId, mnemonic | seedHex, accountIndex?, idempotencyKey?, prewarm?) → { sessionId, signingEnabled, jobId, status }`

Adds signing. The BIP39 seed is stored encrypted. Keys derive per role as in Lace. The seed at `accountIndex` must derive the session's viewing key, so signer, session and on-chain attester id are one account. Use the same `accountIndex` as with `deriveWalletInfo`. A prewarm job syncs the wallet, and `jobId` names it. Poll `getJobStatus(jobId, sessionId)` before submitting. `prewarm: false` syncs on the first submission and answers `jobId: null`. Errors: 400 invalid seed or another account, 404 no session, 410 expired. A second call replaces the stored seed and starts a new prewarm. Rate class `signing`.

### `disconnectWallet(sessionId) → { sessionId, isActive }`

Closes the session and deletes its stored keys. The worker saves the wallet state once more and drops the wallet.

### `deriveWalletInfo(mnemonic | seedHex, accountIndex?) → { viewingKey, shieldedAddress, nightAddress, dustAddress, attesterId, accountIndex, network }`

Derives the session inputs without a session. Nothing is stored or logged. `dustAddress` is a receiver for `registerForDustGeneration`. `attesterId` is the vault's `caller_id()` of the wallet on every network. Pass it as `ownerId` of `registerDocument` before the wallet's first transaction. Rate class `signing`.

## Tokens and dust

### `sendToken(sessionId, receiverAddress, amount, expiresAt?, idempotencyKey?, tokenType?) → { jobId, status }`

Sends NIGHT, or the token `tokenType`. The kind of the address picks the ledger: `mn_shield-addr` pays from the shielded balance, `mn_addr` from the unshielded one. `amount` is at most `10^18` atoms. `expiresAt` is the instant after which the chain refuses the transaction, default 10 minutes from now; it must lie in the future. Job result `{ txId, toLedger, amount, receiverAddress }`. Errors: 400 bad address, amount or `expiresAt`, 404 no session, 412 not signing. A job without funds fails with `Wallet.InsufficientFunds`. Rate class `wallet`.

`sendToken`, `registerForDustGeneration` and `deregisterFromDustGeneration` wait until the wallet is at the tip of a fresh indexer, at most `NIGHTGATE_BALANCE_SYNC_TIMEOUT_MS`. A wallet that is still behind fails the job with `WALLET_NOT_SYNCED`, and nothing is built. Retry once `getWalletSyncProgress` says the wallet caught up.

### `estimateSendTokenFee(sessionId, receiverAddress, amount, expiresAt?, tokenType?) → { fee, toLedger }`

DUST fee in atoms for a `sendToken`. Builds the recipe in the worker without proof or submit. Rate class `read`.

### `registerForDustGeneration(sessionId, dustReceiverAddress?, idempotencyKey?) → { jobId, status }`

Registers the wallet's unregistered unshielded NIGHT UTXOs for dust generation. Job result `{ txId, changed, reason, registeredCount, totalNightUtxos, dustReceiverAddress, requestedReceiver, registeredUtxosBefore, registeredUtxosAfter, settled, consolidated, message }`.

- Registration binds the address. Later NIGHT there generates dust for the same receiver.
- An already registered wallet succeeds with `changed: false` and `reason: "already-registered"`. To change the receiver, deregister and register again. `reason: "no-night-utxos"` means nothing to register.
- One registration consolidates its inputs into one UTXO. One registered UTXO yields one dust note, the unit of parallel sponsoring. Register first, then fund in separate payments.
- `registeredUtxosAfter` is read after the local apply, waiting up to `NIGHTGATE_DUST_REGISTER_SETTLE_MS` (default 90 s). Past it `settled` is false and the count `null`.

Dust accrues about 1 to 2 minutes after the transaction finalizes.

### `deregisterFromDustGeneration(sessionId, idempotencyKey?, sponsorSessionId?) → { jobId, status }`

Deregisters every registered NIGHT UTXO of the wallet. Job result `{ txId, deregisteredCount, totalNightUtxos }`.

### `mintFactoryToken(contractAddress?, name, amount, receiverCoinPublicKey, sessionId?, idempotencyKey?, sponsorSessionId?) → { jobId, status, name, amount, issuerKey, domain, tokenType }`

Mints on the `token-factory` lineage (`@odatano/contract-token-factory`). The session is the issuer. Its issuer key derives from the session's seed, and the caller never sees the issuer secret. `domain` and `tokenType` follow from issuer key, name and factory address, so the same name from another session is another token. `receiverCoinPublicKey` is a zswap coin public key.

- `contractAddress` defaults to `NIGHTGATE_TOKEN_FACTORY_CONTRACT`, which `getBoardStatus.factoryContract` names.
- The session that mints signs the mint and is the issuer. A token caller may leave out `sessionId` and mints as the wallet session of its grant.
- A sponsor wallet pays the fee and never issues a token. A grant the platform pool pays for answers 403 and cannot list this action: build the mint with `@odatano/nightgate-tx` (`prepareMint`) and hand it to `sponsorUnbound`, then the caller's own key is the issuer.
- A landed mint records the type in `LearnedTokenTypes` (at most 256, of which one grant holds at most 32) and, under a grant, in the grant's `mintedTokenTypes`.
- Job result `{ submissionId, txId, txHash, contractAddress, tokenType }`. 404 `TOKEN_FACTORY_UNAVAILABLE` without the lineage. Grantable, circuit `mint`. Rate class `sponsor`.

### `burnFactoryToken(contractAddress?, name, amount, issuerKey?, sessionId, idempotencyKey?, sponsorSessionId?) → { jobId, status, name, amount, issuerKey, domain, tokenType }`

Burns `amount` of a factory token the session holds and lowers the factory's supply ledger. `issuerKey` defaults to the session's own. Job result as `submitContractCall`. Grantable, circuit `burn`. A grant's value budget counts the amount. Rate class `prove`.

### `deriveTokenType(contractAddress, domainSeparator) → { tokenType, contractAddress, domainSeparator }` (function)

Computes `rawTokenType(domainSeparator, contractAddress)` for any minting contract. `domainSeparator` is the text the contract pads to 32 bytes when it mints, or those 32 bytes as 64 hex. The answer echoes the 64-hex form. 400 without a separator. A token of the token factory needs no call: `mintFactoryToken` answers its `tokenType`.

## Contracts

### `deployContract(contractName, sessionId, initialPrivateState?, idempotencyKey?, sponsorSessionId?, recoveryId?) → { jobId, status }`

Deploys a contract from `cds.requires.nightgate.contracts` or `registerContract`. Job result `{ submissionId, txId, txHash, contractAddress, status }`, with `status` from `PendingSubmissions`: `pending`, `included`, `finalized`. `recoveryId` (vault only) is the attester id that may use `registerDocument` modes 3 and 4. Without it a lost registrar key locks the id registry for good. The registrar is the deploy session's attester id. 404 for an unknown contract. Rate class `deploy`.

### `submitContractCall(contractAddress, circuit, contractName, sessionId, args, idempotencyKey?, initialPrivateState?, sponsorSessionId?) → { jobId, status }`

Calls one circuit. `args` is a JSON array, see [Encoding circuit args](#encoding-circuit-args). `initialPrivateState` is used only on the wallet's first contact with the contract. Job result `{ submissionId, txId, txHash, contractAddress, status }`. Rate class `prove`.

### `submitContractCallBatch(contractAddress, calls, contractName, sessionId, idempotencyKey?, initialPrivateState?, sponsorSessionId?, independentCalls?) → { jobId, status }`

Runs up to 8 circuit calls on one contract as one transaction. `calls` is a JSON array of `{ circuit, args }` in apply order. Job result `{ submissionId, txId, txHash, contractAddress, circuits, status }` with `circuits` in apply order. Rate class `prove`.

- The server supplies witnesses only to a contract that is one of its installed contract packages. It tells by the checksum of the contract's files, not by the name the contract is registered under. Calls into any other contract are built by the caller, for example with the transaction builder, and sponsored.
- Segment ids are rewritten ascending in call order before proving. If that fails, the job aborts. The server logs the order of every batch with each call's stage.
- Same-name circuits have no fixed order among themselves.
- `independentCalls: true` orders calls by execution stage instead of call order. Use it only for calls that share no state.
- Proof witnesses ride per call in `merkleProof`. Single-field circuits take `fieldValue` or `fieldDigest`, `fieldSalt`, `siblings` and `dirs`; membership adds `setProof`. The comparison circuit takes `docPair: { schema, openingA, openingB }`. Hashes in a bundle take `0x` and either letter case, like hex parameters. A malformed bundle is 400.

**Ledger causality.** The SDK splits each call into a guaranteed and a fallible part by gas cost. The ledger applies all guaranteed parts first and rejects a fallible call followed by a guaranteed one (`1010/188`). Cost grows with contract state, so a call's stage can move. On the vault `attest` and `anchorContentRoot` stay guaranteed and `bindDocument` is fallible, so put `bindDocument` last. Both rules are checked before proving, and nothing is submitted on a refusal:

- a stage conflict fails with `BATCH_CAUSALITY_VIOLATION`, the message ending `Stages in apply order: <call>=<segment>[<stages>] ...`;
- a call that runs out of gas on a local ledger with the current state fails with `BATCH_GAS_BUDGET_EXCEEDED`.

After submission a `PARTIAL_SUCCESS` fails the job with `TX_FAILED` and `chainStatus: failure`; the message names the status. Check the effect state, for example with `verifyAttestation`.

### Fee sponsoring with `sponsorSessionId`

The session submit actions accept `sponsorSessionId`: `deployContract`, `submitContractCall`, `submitContractCallBatch`, `anchorDocument`, `attestAgentOutput`, the `prove*` actions, `grantDisclosure`, `revokeDisclosure`, `registerDocument`, `retractAttestation`, `purgeExpired`, `mintFactoryToken`, `burnFactoryToken` and `deregisterFromDustGeneration`. The caller builds and signs, the sponsor pays the dust fee and submits. The caller needs no dust. A foreign sponsor must be listed in `NIGHTGATE_FEE_SPONSOR_SESSIONS` or `feeSponsorSessions`, else 404. A sponsor without signing is 412. Request and result carry `feeSponsor`.

### Encoding circuit args

Each element of `args` is coerced by the circuit's parameter types from the artifact's `contract-info.json`:

| Circuit parameter | JSON value | Coerced to |
|---|---|---|
| `Bytes<N>` | hex string, `0x` optional, or a `number[]` of bytes | `Uint8Array(N)`, length checked |
| `Uint<N>` | number or decimal string | `BigInt` |
| `Boolean` | `true` or `false` | boolean |
| `Field` | number or decimal string | `BigInt` |
| struct | object with every declared field, each encoded by its own type | object with coerced fields |
| `Vector<N, T>` | array of N values, each encoded by `T` | array with coerced entries, length checked |
| other (`Maybe`, `Either`, `Opaque`) | the JSON value | unchanged |

Without `contract-info.json`, untagged arguments are 400. Tagged values work there: `{ "$bytes": "<hex>" }` and `{ "$uint": "<decimal>" }`. With it, a tag must fit the parameter: `$bytes` on a `Uint` is 400. Also 400, naming `args[i]` where one argument is at fault: invalid hex, a wrong length, a negative or non-integer `Uint`, a missing struct field, a wrong number of arguments, and a circuit the contract does not have (the message lists its circuits).

```jsonc
"args": "[\"<64-hex document_id>\", {\"$bytes\":\"<64-hex payload_hash>\"}]"
```

## Cross-server fee sponsoring

The caller builds, proves and signs a call. The sponsor pays the dust and submits. Only the serialized transaction moves between them. Client side: [txbuilder.md](txbuilder.md).

The sponsor actions name no payer. The platform pool pays, or the wallet session the caller's grant is pinned to (`createAgentGrant` `sponsorSessionId`). Without either they answer 503. Poll `getJobStatus` with the returned `jobId`.

### `buildSponsorable(contractAddress, circuit, contractName, sessionId, args) → { jobId, status }`

Builds, proves, signs and finalizes one call on the server without submitting. Job result `{ finalizedTxB64, serializedBytes }`. No dust is spent. Rate class `prove`.

### `sponsorFinalized(finalizedTxB64, idempotencyKey?) → { jobId, status, sessionId }`

Checks the sponsor policy, adds the dust and submits a bound transaction. An unbound transaction is refused. Job result `{ txId, txHash, circuits, contractAddress }`. Rate class `sponsor`.

### `sponsorUnbound(unboundTxB64, idempotencyKey?) → { jobId, status, sessionId }`

Takes the proven and signed transaction from txbuilder `buildSponsorable({ bind: false })`. Same policy as above. Locks one free dust backing, proves a dust-only spend, merges, binds and submits. Job result `{ txId, txHash, circuits, contractAddress, note }` with `note` the backing used. Rate class `sponsor`.

- One wallet sponsors as many transactions at once as it has registered dust backings. A request waits up to `NIGHTGATE_BACKING_WAIT_MS` (default 5 min).
- A fee no single note covers is paid from up to `NIGHTGATE_SPONSOR_MAX_DUST_NOTES` backings (default 4).
- A lost dust race is rebuilt on the same sponsor (`NIGHTGATE_SPONSOR_DUST_RETRIES`, default 4), then the next sponsor in the pool takes over.
- The job returns once in a block. `NIGHTGATE_SUBMIT_WAIT=finalized` waits for finality.

### `sponsorSwap(makerHalfB64 | offerId, takerHalfB64, idempotencyKey?) → { jobId, status, sessionId }`

Sponsors a shielded swap without a contract. Each half is a proven transaction, for example from the wallet SDK's `initSwap(..., { payFees: false })`, given as an offer file (`swapoffer1...`, bech32m) or base64. A bound half binds the other one. The worker checks both, merges them, adds dust and submits. With `offerId` the offer must still be open when the swap is sent, see `retireSwapOffer`. Job result `{ txId, txHash, circuits: ["<swap>"], note, swap: { gives, wants } }` from the maker's side, each `{ tokenType, amount }`. Rate class `sponsor`.

Off unless `NIGHTGATE_SPONSOR_ALLOW_SWAPS` (policy file `allowSwaps`) is set, and a token needs `sponsorSwap` in `allowedActions`. Refused unless:

- each half carries an offer and nothing else, with no contract-owned coin;
- each half gives exactly one type and wants exactly one other, both in the effective `allowedTokenTypes`, neither NIGHT;
- each half has 1 to `NIGHTGATE_SPONSOR_MAX_INPUTS` (default 4) inputs and at most two outputs;
- the halves mirror each other and the merge fits `NIGHTGATE_SPONSOR_MAX_TX_BYTES`. One input or output is about 5 kB.

`offerId` takes the maker half from the [offer board](#offer-board): 404 unknown, 409 closed. A landed swap closes every open offer that spent one of its inputs. A second fill fails with `1010/103`. A half expires with the coin tree state it refers to. A half never handed over must be reverted in its wallet (`revertTransaction`).

### `sponsorTransfer(transferTxB64, tokenType, amount, idempotencyKey?) → { jobId, status, sessionId }`

Sponsors a plain transfer the caller built: a shielded one from the swap wallet's `buildTransfer`, or an unshielded one, NIGHT included, from `createUnshieldedWallet`. The transaction is bound or unbound, base64 or offer-file text. Job result `{ txId, txHash, circuits: ["<transfer>"], note, transfer: { tokenType, amount, to? } }`. Rate class `sponsor`.

Off unless `NIGHTGATE_SPONSOR_ALLOW_TRANSFERS` (policy file `allowTransfers`) is set, and a token needs `sponsorTransfer` in `allowedActions`. `amount` is a positive integer in atoms, at most `2^128 - 1`, and counts against the value budget of `tokenType`.

- **Shielded.** `tokenType` must be in the effective `allowedTokenTypes`. The transaction must carry an offer and nothing else, spend 1 to `NIGHTGATE_SPONSOR_MAX_INPUTS` coins, create one or two, and net to zero. Recipient, amount and type are commitments, so `tokenType` and `amount` are the caller's declaration. The receipt says `declared: true`.
- **Unshielded.** Also needs `NIGHTGATE_SPONSOR_ALLOW_UNSHIELDED_OFFERS` (policy file `allowUnshieldedOffers`), and a token needs `allowUnshieldedOffers` on its grant. The type is NIGHT or one in the effective `allowedUnshieldedTokenTypes`. The transaction must carry one intent with one signed unshielded offer and nothing else. The offer pays one address, sends any change back to a spender, balances, and spends no UTXO of the sponsor. The transaction stays under `NIGHTGATE_SPONSOR_MAX_TX_BYTES`. The offer is public, so `tokenType` and `amount` must match it, else 400. The result's `transfer.to` is the recipient's address, and the receipt says `declared: false`.

### Sponsor policy

The policy is a fail-closed shape check: allowlisted contract calls and nothing else. A deploy, an unshielded transfer, a zswap offer, caller dust actions, an unreadable structure or a transaction over `NIGHTGATE_SPONSOR_MAX_TX_BYTES` (default 65536) is refused, apart from the rights below.

```bash
NIGHTGATE_SPONSOR_ALLOWED_CONTRACTS=<vault address>,<other address>
NIGHTGATE_SPONSOR_ALLOWED_CIRCUITS=attest,anchorContentRoot,proveFieldPredicate
```

An empty list means no restriction. Whoever reaches the endpoint can then make you pay fees.

- **Policy file.** `NIGHTGATE_SPONSOR_POLICY_FILE` holds JSON with `allowedContracts`, `allowedCircuits`, `contractCircuits`, `allowedTokenTypes`, `allowContractMints`, `allowSwaps`, `allowTransfers`, `shareMintedTokenTypes`, `allowUnshieldedOffers`, `allowedUnshieldedTokenTypes` and `rateLimits`. It is re-read per sponsored call and replaces the env settings. An invalid file keeps the last good policy. With none loaded every sponsored call is 503 `SPONSOR_POLICY_UNAVAILABLE`. Admin `getSponsorPolicy` shows the policy in force.
- **Circuits per contract.** `contractCircuits` (file only) maps a contract address to `"*"` or a list of circuits. The entry replaces `allowedCircuits` for that contract and allows the contract itself.
- **Grant lists.** A grant's `allowedContracts`, `allowedCircuits` and `allowedTokenTypes` narrow the platform lists for every action under its token. Circuits derive from the action, for example `anchorDocument` is `attest`. A missing grant list inherits the platform list. Disjoint contract or circuit lists are 403 `SPONSOR_POLICY_EMPTY`. Create and update answer 400 for such lists.
- **Re-resolved at execution.** A queued job runs under the current lists. A revoked grant fails its queued jobs with `AGENT_GRANT_REVOKED`.
- **Token offers.** A zswap offer passes when every net change is on a listed type other than NIGHT and every contract-owned coin belongs to a sponsorable contract.
- **Contract mints.** With `NIGHTGATE_SPONSOR_ALLOW_CONTRACT_MINTS` a type needs no list entry while a call of the same transaction mints it. A landed mint lists the type for its grant, or for every grant with `NIGHTGATE_SPONSOR_SHARE_MINTED_TOKEN_TYPES`.
- **Sponsored deploys.** The sponsor pays a deploy the caller built for a token whose grant has `allowDeploy` and budget left (`maxDeploys`, default 1, lifetime). A caller without a token is the operator and needs no grant. There is no server-wide switch. Ceiling `NIGHTGATE_SPONSOR_MAX_DEPLOY_BYTES` (default 40960). A node reject refunds the budget. The landed address joins the grant's `deployedContracts`. Maintenance updates are never sponsored.
- **Sponsored maintenance updates.** The sponsor pays a maintenance update of a contract the token's grant deployed sponsored, for a grant with `allowMaintenance` and budget left (`maxMaintenanceUpdates`, default 8, lifetime). An update of any other contract is refused. A caller without a token is the operator and may update any contract. One update per transaction, ceiling `NIGHTGATE_SPONSOR_MAX_MAINTENANCE_BYTES` (default 40960). A node reject refunds the budget. The update may insert or remove verifier keys and replace the maintenance authority, so the contract's keys decide what it becomes, and the sponsor pays only the fee.
- **Unshielded offers.** Grant `allowUnshieldedOffers` and `NIGHTGATE_SPONSOR_ALLOW_UNSHIELDED_OFFERS` let a call move the caller's own NIGHT or `allowedUnshieldedTokenTypes` into the called contract, and pay out what the contract's proven result requires. The sponsor adds dust only. The job result lists `unshielded: [{ type, amount, to }]`. A grant that also holds `sponsorTransfer` may send these types to any address, see `sponsorTransfer` above.
- **Value budgets.** Grant `maxValuePerDay` caps the atoms moved per UTC day and type by swaps, transfers, mints and burns. Over it is 429 `grant-value`. For a shielded transfer the budget counts the amount the caller declares, because the transaction does not show it. Tokens that a sponsored contract call moves through an unshielded offer are not counted.
- **Cost.** The sponsor asks the ledger for the cost of the finished transaction before it sends it. One the node would refuse fails with `SPONSOR_REFUSED` and the ledger's reason: over the time to dismiss for its size, or over a block limit. `sponsorUnbound`, `sponsorSwap` and `sponsorTransfer` check before the dust spend is proven.

**A sponsor only pays.** A session listed in `NIGHTGATE_FEE_SPONSOR_SESSIONS` pays fees and does nothing else. As `sessionId` it is accepted by `connectWalletForSigning`, `disconnectWallet`, `getWalletBalance`, `getWalletSyncProgress` and `getJobStatus`. Every action that signs, moves coins or registers answers 403, for the owner of the wallet too. A grant bound to it can list only the sponsor actions and the offer board actions. A sponsor holds no NIGHT of its own: another wallet delegates its dust with `registerForDustGeneration` and the sponsor's dust address as `dustReceiverAddress`.

**Pool.** `NIGHTGATE_FEE_SPONSOR_SESSIONS` sessions form a pool with one in-flight dust spend per wallet. Callers wait up to `NIGHTGATE_SPONSOR_LEASE_WAIT_MS` (default 120 s). A failing sponsor is benched for `NIGHTGATE_SPONSOR_COOLDOWN_MS` and the job tries the next. Pool jobs run under the session id `00000000-0000-0000-0000-706f6f6c0000`.

**Submit timeouts.** Connect `NIGHTGATE_SUBMIT_CONNECT_TIMEOUT_MS` (20 s), request `NIGHTGATE_SUBMIT_REQUEST_TIMEOUT_MS` (30 s), watch until InBlock `NIGHTGATE_SUBMIT_WATCH_TIMEOUT_MS` (75 s). An ambiguous outcome is looked up on the indexer, else the job parks as `BROADCAST_UNCONFIRMED`.

**Contention.** Concurrent writes to the same contract state conflict. The loser is rejected with `1010/104` or lands as `PARTIAL_SUCCESS` with the fee paid, and must be rebuilt against the new state. Server-built calls rebuild (`NIGHTGATE_STALE_TRANSCRIPT_RETRIES`, default 2), a sponsored job cannot. Parallelize across contracts. Do not mix bound and unbound sponsoring on one sponsor wallet.

## Agent grants

A grant gives an autonomous agent a bearer token over one wallet session, sent in the `x-agent-token` header. Only its SHA-256 is stored. The token runs as the grant's operator, limited to `allowedActions`. Grantable are `anchorDocument`, `attestAgentOutput`, the `prove*` actions, `grantDisclosure`, `revokeDisclosure`, `reindexDisclosures`, `sponsorFinalized`, `sponsorUnbound`, `sponsorSwap`, `sponsorTransfer`, `postSwapOffer`, `retireSwapOffer`, `grantDisclosureToHolders`, `revokeHolderDisclosure`, `mintFactoryToken` and `burnFactoryToken`. Every other action answers 403 under a token.

Always allowed under any token, without budget: entity reads (session entities narrowed to the grant's session, `GranteeIdentities` 403), the chain read functions including `ContractStates/stateAt` and `Blocks/ledgerParametersAt`, the verify functions, `prepareDocumentProof`, `prepareMembershipSet`, `deriveTokenType`, `listSwapOffers`, `getSwapOffer`, `claimDisclosure`, `getJobStatus` and `getGrantUsage` for its own grant. `getSponsorPoolStatus` is 403. These calls still count in their rate class.

### `createAgentGrant(sessionId, allowedActions, maxJobsPerDay?, maxJobsPerHour?, sponsorSessionId?, validUntil?, label?, allowedContracts?, allowedCircuits?, allowDeploy?, maxDeploys?, allowedTokenTypes?, allowUnshieldedOffers?, allowedUnshieldedTokenTypes?, maxValuePerDay?) → { grantId, token, ... }`

Creates one grant. The result repeats the stored settings. `token` is shown once. `sponsorSessionId` pins the wallet that pays the grant's sponsored jobs. The reserved id `00000000-0000-0000-0000-706f6f6c0000` makes a pool grant, which the platform pool pays. It needs a configured pool, else 412. Its `allowedActions` hold only `sponsorFinalized`, `sponsorUnbound`, `sponsorSwap`, `sponsorTransfer`, `postSwapOffer` and `retireSwapOffer`, else 400. See [Sponsor policy](#sponsor-policy) for the lists and rights. Rate class `admin`.

### `createAgentGrants(count, sessionId, allowedActions, labels?, ...) → { grants: [{ grantId, token, label }], ... }`

Creates 1 to 50 grants of one shape on one session. `labels` has exactly `count` entries, else the names are `<label>-1` to `<label>-n`. Budgets apply per grant. Rate class `admin`.

### `updateAgentGrant(grantId, ...) → { grantId, updated }`

Changes only the given settings. `null` clears `maxJobsPerHour`, `maxJobsPerDay`, `validUntil`, `label` and the lists. Session, sponsor and token are fixed. `maxDeploys` must be at least the deploys used. 409 `GRANT_REVOKED` on a revoked grant. Rate class `admin`.

### `rotateAgentGrantToken(grantId) → { grantId, token }`

Returns a new token once. The old one is 401 from the next request. Budgets and `deployedContracts` stay. Rate class `admin`.

### `revokeAgentGrant(grantId) → { revoked }`

Revokes at once. A grant of another user is 404. Rate class `admin`.

### `getGrantUsage(grantId?, since?, until?) → { grantId, since, until, jobs, landed, failed, deploysUsed, maxDeploys, maintenanceUpdatesUsed, maxMaintenanceUpdates, jobsUsedToday, maxJobsPerDay, dustPaid, limits }` (function)

Jobs by kind and status between `since` and `until` (default the last 30 days, at most 366). `dustPaid` is the indexed DUST fees of the landed jobs, null without the crawler. `limits` holds `jobsPerHour`, `jobsPerDay`, `valuePerDay` and the rate `classes` the grant can reach, each with what is left. Owner-scoped. A token reads only its own grant and may leave `grantId` empty.

## Offer board

Open maker halves posted for takers. The board stores intent, never value. Every offer on it can be taken by anyone who holds the wanted token. For a deal with one partner, hand the offer file to that partner and leave the board out.

### `postSwapOffer(offer, expiresAt?, tags?) → { offerId, status, bound, givesType, givesAmount, wantsType, wantsAmount, expiresAt }`

`offer` is a maker half as offer file or base64. It is checked like a sponsored half except for the token allowlist, else 400 `SWAP_OFFER_INVALID`. `expiresAt` is at most 90 days ahead. `tags` holds up to 8 strings of up to 40 characters. The offer closes when a sponsored swap spends one of its inputs, when it expires, or when the poster retires it. Grantable, also for a pool grant. Rate class `compute`.

### `listSwapOffers(givesType?, wantsType?, tag?, limit?, status?, since?, mine?, waitMs?) → [{ offerId, bound, givesType, givesAmount, wantsType, wantsAmount, tags, expiresAt, postedAt, status, filledTxHash, closedAt, changedAt }]` (function)

Open offers newest first. A row carries the terms, not the half; `getSwapOffer` returns the half. `status` `filled`, `retired`, `expired` or `all` orders by `changedAt`. `since` keeps offers changed after that instant and lists them oldest change first, so `status: 'all'` with `since` is a change feed: pass the last `changedAt` as the next `since`. A full page ends with every offer that changed at the same instant as its last one, so it can hold more than `limit`. `mine: true` keeps the caller's own posts. `waitMs` (at most 25000) holds the call until an offer matches. Never shows the poster or the nullifiers. Rate class `read`.

### `getSwapOffer(offerId) → { offer, ... }` (function)

One offer in the board's shape plus the half as `offer`, open or closed. 404 when unknown. Rate class `read`.

### `retireSwapOffer(offerId) → { offerId, status }`

Only the poster, the same user or grant. A closed offer answers 200 with its status. The poster's wallet keeps the coins reserved until it reverts the half. Rate class `compute`.

Retiring also stops a take that was accepted and is not sent yet. The take's job checks the offer when it starts and again right before the send, and fails with `swap offer <id> is retired, so the swap was not sent`. A swap that was already sent cannot be stopped: it lands, and the offer then reads `filled`. An offer that expires while its take waits stops the take the same way.

## Documents

### `anchorDocument(payloadHash, contentType?, size?, storageRef, metadata?, sessionId, contractAddress, contractName?, idempotencyKey?, sponsorSessionId?) → { jobId, status, anchorId, attesterId }`

Records a document hash in the vault with one `attest` transaction. Only the hash and `storageRef` are stored, never the bytes. The `Documents` row is written at once, so `anchorId`, the server's id of the anchored document, returns synchronously. Reads are owner-scoped. The record key `recordKey(attesterId, payloadHash)` derives from the caller in-circuit, so no other identity can take over the record. Job result `{ documentId, attestationId, attesterId, txId, txHash, anchoredAt }`. Rate class `prove`.

### `verifyDocument(anchorId, payloadHash, contractAddress?, contractName?) → { verified, included, stateChecked, anchoredTxHash, anchoredAt, payloadHash }` (function)

`verified` is true when the hash matches and the attestation stands in live contract state. `included` means the anchoring transaction is indexed as `SUCCESS`. `stateChecked: false` means no live provider, so `verified` stays false. The contract, artifact and network recorded at anchor time win. Another caller value is 400. A mismatch is `verified: false` with `payloadHash: ''`. Rate class `read`.

### `attestAgentOutput(agentId, inputHash, outputHash, modelId?, policyHash?, producedAt?, storageRef?, sessionId, contractAddress, contractName?, idempotencyKey?, sponsorSessionId?) → { jobId, status, anchorId, payloadHash, envelopeJson }`

Anchors a canonical envelope of an agent's input and output through `anchorDocument`. A third party checks it by hashing `envelopeJson` and calling `verifyAttestation`. A retry with the same key reuses the first `producedAt`. Rate class `prove`.

### `prepareDocumentProof(document, proofFields, saltSeed?, contractName?) → { payloadHash, canonicalDocument, contentRoot, fields, emptyFields, schemaId, schema, leaves, opening }`

Turns a JSON document into the inputs of the proof actions. Nothing is stored or logged.

- `payloadHash` is blake2b-256 of canonical JSON with keys sorted by UTF-16 code units, so `"10"` precedes `"9"`. It is what `anchorDocument` anchors.
- `contentRoot` is a salted Merkle root over the ordered `proofFields`. The position is the slot, so keep the order stable. Width is 16, or 32 with `attestation-vault-32`.
- `kind: 'uint'` (default) scales a number by `scale` (default 1000). `kind: 'bytes'` hashes the exact string for equality and membership.
- `field` is a dot path. A literal top-level key containing dots wins.
- Absent values use the salted absent leaf and are listed in `emptyFields`.
- `schemaId` is the root over the slot descriptors in `schema`. Fields lists of the same shape share one `schemaId`.
- Store `opening` (`saltSeed` and the slots). Without it the root cannot be proven. Leaking it makes the leaf hashes testable against guesses.
- Roots and claim keys use the circuit's `transientHash`. A vault built with a new compiler is a redeploy, and holders anchor again from `opening`.

Rate class `compute`.

### `prepareMembershipSet(allowedValues, value?, valueDigest?, contractName?) → { setRoot, memberCount, setSiblings, setDirs }`

Canonical depth-6 set root for membership proofs. Each value is hashed with blake2b-256, deduplicated, sorted and padded to 64 by repeating the last member. More than 64 values is 400. With `value` or `valueDigest` the answer carries the inclusion path, 400 if it is no member. Outside a server use `@odatano/nightgate-tx/set-root`, which gives the same roots. Rate class `compute`.

## ZK predicate attestations

Statements about anchored field values without revealing them: numeric thresholds, bytes equality, set membership, and integrity and diff between two documents. Each claim is bound to the content root and verified on chain. Contract: [AttestationVault](https://github.com/ODATANO/NIGHTGATE-CONTRACTS/tree/main/packages/attestation-vault).

- **Record.** A claim is proven against `recordKey(attesterId, payloadHash)`. `attesterId` defaults to the session's. A `contentRoot` given to an `prove*` action is anchored first, under the session's own record only, and needs `schemaId`.
- **Expiry.** `validUntil` is a timestamp, default one year ahead (`NIGHTGATE_CLAIM_LIFETIME_S`), at most five years. The claim expires at that second. An expired claim verifies false and can be removed with `purgeExpired`.
- **Width.** The contract that `contractName` names sets the width (16 by default). `attestation-vault-32` has 5-entry paths, 32-bit masks and `k` up to 32. Comparisons work only within one width.
- **Prover keys.** The contract packages ship no prover keys. The first proving job fetches them from the release assets named in each package's `contract.json`, or from `NIGHTGATE_ZK_ASSET_URL` when it is set, and checks them against `keys/manifest.json`. Offline: `node scripts/fetch-contract-keys.mjs attestation-vault-32`. Container images contain them.
- **Failures.** A false claim fails at local proving and nothing is submitted.

All `prove*` actions return `{ jobId, status, predicateAttestationId }`, use rate class `prove` and write one `PredicateAttestations` row per claim. Reads of that table are owner-scoped: a caller lists the rows of its own proofs, an agent token those of its session. A third party checks a claim with `verifyPredicate` or `verifyPredicateAttestation`. `siblings` and `dirs` are the inclusion path from `prepareDocumentProof`.

### `proveFieldPredicate(payloadHash, attesterId?, fieldKey, value, fieldSalt, contentRoot?, schemaId?, siblings, dirs, predicate, threshold, unit?, sessionId, contractAddress, contractName?, idempotencyKey?, sponsorSessionId?, validUntil?)`

Proves the scaled `value` is `lessOrEqual` or `greaterOrEqual` `threshold`. `value` stays witness. `value` and `threshold` are decimal strings and must fit `Uint<64>`. Job result `{ predicateAttestationId, payloadHash, claim, proof }`.

### `proveClaims(payloadHash, attesterId?, contentRoot?, schemaId?, claims, sessionId, contractAddress, contractName?, idempotencyKey?, sponsorSessionId?, validUntil?) → { jobId, status, claims, droppedDuplicates }`

Proves up to 8 claims on one payload in one transaction. A given `contentRoot` takes one of the 8 slots. Each `BatchClaim` carries the inputs of the single action its `predicate` selects. For the document kinds the batch `payloadHash` is document A and B's root must already be anchored. Exact duplicates are dropped. All rows share one `provenTxHash`. After a `PARTIAL_SUCCESS` check each claim with `verifyPredicateAttestation`. The rate class counts one per claim.

### `proveFieldEquality(payloadHash, attesterId?, fieldKey, expectedValue | expectedDigest, fieldSalt, contentRoot?, schemaId?, siblings, dirs, sessionId, contractAddress, contractName?, idempotencyKey?, sponsorSessionId?, validUntil?)`

Proves a `bytes` field holds the value behind `expectedDigest`, blake2b-256 of `expectedValue`. The digest is public, so this proves authenticity, not secrecy.

### `proveFieldMembership(payloadHash, attesterId?, fieldKey, value | valueDigest, allowedValues | setRoot, setSiblings?, setDirs?, fieldSalt, contentRoot?, schemaId?, siblings, dirs, sessionId, contractAddress, contractName?, idempotencyKey?, sponsorSessionId?, validUntil?)`

Proves a hidden `bytes` value is one of up to 64 public values. Pass `allowedValues`, or `setRoot` with its 6-entry path from `prepareMembershipSet`. A value outside `allowedValues` is 400 before proving.

### `proveDocumentIntegrity(payloadHashA, payloadHashB, attesterIdA?, attesterIdB?, allowedMask, schema, openingA, openingB, contentRootA?, contentRootB?, schemaId?, sessionId, contractAddress, contractName?, idempotencyKey?, sponsorSessionId?, validUntil?)`

Proves document B differs from A only in the slots set in `allowedMask`. A mask that constrains no real slot is refused. The circuit recomputes the schema id and both roots, so both documents must be anchored under the same `schemaId`. The order of A and B is part of the claim. Each given content root is anchored in its own transaction first.

### `proveDocumentDiff(payloadHashA, payloadHashB, attesterIdA?, attesterIdB?, k, schema, openingA, openingB, contentRootA?, contentRootB?, schemaId?, sessionId, contractAddress, contractName?, idempotencyKey?, sponsorSessionId?, validUntil?)`

Proves at least `k` aligned slots differ, without revealing which. A change of value or presence counts. Slots empty in both do not.

### `verifyPredicateAttestation(predicateAttestationId) → { verified, included, stateChecked, contractAddress, attesterId, payloadHash, fieldKey, predicate, threshold, unit, expectedDigest, setRoot, attesterIdB, payloadHashB, allowedMask, k, provenTxHash, provenAt }` (function)

`verified` is true when the claim key, recomputed from the row and the current anchor, is in the vault's `claims` map and not expired. Retract, re-anchor or expiry turn it false. `included` and `stateChecked` as on `verifyDocument`. Rate class `read`.

A field the predicate does not use is `null`, never `0` or empty text: `threshold` and `unit` belong to `lessOrEqual` and `greaterOrEqual`, `expectedDigest` to `bytesEquality`, `setRoot` to `setMembership`, `attesterIdB` and `payloadHashB` to the two document kinds, `allowedMask` to `documentIntegrity`, `k` to `documentDiff`. `contractAddress`, `attesterId`, `payloadHash` and `fieldKey` are what `verifyPredicate` takes, so the claim can be checked on chain without trusting this answer. `provenTxHash` is `null` until the proof is on chain.

## Crawler-free state verification

The three functions read live contract state from the indexer. They need no crawler, transaction hash or server row. Absent state, no live provider and a contract that is not a vault are `verified: false`. An unknown `contractName` answers 404, an input that does not fit the circuit 400. Other failures keep their code, and a retryable one sets `Retry-After`. Every call asks the indexer for its newest block and reads the state at that block, so `blockHeight` names the block the answer holds at, also for `verified: false`. It is null only without a live provider. A contract's state is decoded once and reused until the indexer returns other bytes. Rate class `verify`. `network` reads another configured network (`cds.requires.nightgate.networks.<network>`), unknown is 400.

**Public lane.** With `NIGHTGATE_PUBLIC_VERIFY=true` they answer without credentials under `/odata/v4/midnight-verify`, with the same signatures and CORS `*`. Off, they answer 404 `PUBLIC_VERIFY_DISABLED`. Rate class `public-verify`. Every call needs contract, payload and claim coordinates, so nothing is enumerable.

Everything checked here is recomputable from public data: the claim key is a `persistentHash` over the tagged claim struct, with `recordKey = persistentHash({ tag 21, attesterId, payloadHash })` and root and schema id from `content_anchors`. The Compact source ships in `@odatano/contract-attestation-vault`.

### `verifyAttestation(contractAddress, attesterId?, payloadHash?, documentId?, contentRoot?, schemaId?, contractName?, network?) → { verified, attested, contentRootOk, schemaOk, bindingRegistered, attesterId, payloadHash, recordKey, documentId, blockHeight }` (function)

Checks the attester's record of `payloadHash` and, when given, its content root and schema id. A bound `documentId` replaces `attesterId` and `payloadHash`, and the answer names the attester. An anchor is the attester's own statement, so check `attesterId` against identities you trust. An unregistered document id is first come, first served. `bindingRegistered: true` says the registrar assigned the id to this attester.

All three verify functions read the contract from the indexer. When it cannot serve the state they answer 502 `BAD_GATEWAY` with `Retry-After` and the indexer's reason, never `verified: false`. A contract whose state was last written under ledger 8 answers 409 `CONFLICT`.

### `verifyPredicate(contractAddress, attesterId, payloadHash, fieldKey?, predicate, threshold?, expectedDigest?, setRoot?, payloadHashB?, attesterIdB?, allowedMask?, k?, contractName?, network?) → { verified, proven, blockHeight }` (function)

Recomputes the claim key from the given coordinates and checks `claims` for an unexpired entry. The inputs must be exactly those of the proof, including the A and B order. `threshold` is a decimal string, quoted in the URL. The key embeds the record's current anchor, so a claim under a former anchor verifies false. Anyone holding the opening may prove the same claim again and extend its expiry. The attester withdraws claims by retracting the record.

### `verifyDisclosure(contractAddress, attesterId, payloadHash, grantee, minLevel?, contractName?, network?) → { verified, granted, level, blockHeight }` (function)

Reads the grantee's entry in `disclosures` under the attester's record of `payloadHash`. `level` is 0 public, 1 legitimate interest, 2 authority, and null without a grant. `verified` is true when a grant exists and its level is at least `minLevel`, default 0. A revoked grant and a retracted attestation leave no grant. Needs no `DisclosureGrants` row, so it also answers for a grant submitted outside this server.

## Disclosure grants

The vault's on-chain disclosure list and document id registry. `level` is 0 public, 1 legitimate interest, 2 authority. Only the entitlement is on chain; delivering the matching text stays with the consumer.

### `grantDisclosure(payloadHash, grantee, level, sessionId, contractAddress, contractName?, idempotencyKey?, sponsorSessionId?) → { jobId, status, disclosureGrantId }`

Grants `grantee` a level on the session's own record. The `DisclosureGrants` row is written inactive and turns active once the chain confirms. Reads of that table are owner-scoped: a caller lists the grants it asked for, an agent token those of its session. A third party checks a grant with `verifyDisclosure`. Job result `{ disclosureGrantId, payloadHash, grantee, level, txId, txHash }`. Rate class `prove`.

### `revokeDisclosure(payloadHash, grantee, sessionId, contractAddress, contractName?, idempotencyKey?, sponsorSessionId?) → { jobId, status }`

Removes the grantee's entry. Attester only. Job result `{ payloadHash, grantee, txId, txHash }`. Rate class `prove`.

### `reindexDisclosures(contractAddress, contractName?) → { contractAddress, active, deactivated, reconciledAt }`

Updates `DisclosureGrants` from live state, for example after a grant submitted outside this server. A row that comes only from the chain has no owner, so only an admin lists it until its attester calls `grantDisclosure` for it. Without a live provider, and for a contract that is no vault, `active` is zero. Rate class `compute`, per contract.

### `registerDocument(documentId, ownerId, mode?, sessionId, contractAddress, contractName?, idempotencyKey?, sponsorSessionId?) → { jobId, status }`

Manages the document id registry of the vault. `documentId` is the id the contract binds to an attester, not the `anchorId` of `anchorDocument`.

| `mode` | Caller | Effect |
|---|---|---|
| 0 (default) | registrar | assigns `documentId` to `ownerId`, releasing another attester's binding |
| 1 | registrar | removes the assignment |
| 2 | registrar | hands the registrar role to `ownerId` |
| 3 | recovery identity | sets `ownerId` as the new registrar |
| 4 | recovery identity | hands the recovery role to `ownerId` |

Mode 1 ignores `ownerId`, and modes 2 to 4 ignore `documentId`. Job result `{ documentId, ownerId, mode, contractAddress, txId, txHash }`. Rate class `prove`.

### `retractAttestation(payloadHash, sessionId, contractAddress, contractName?, idempotencyKey?, sponsorSessionId?) → { jobId, status }`

Removes the caller's record: attestation, content anchor, disclosure grants and document binding. Claims on its root stop verifying. The payload may be attested again. Job result `{ mode, key, contractAddress, txId, txHash }`. Rate class `prove`.

### `purgeExpired(kind, key, sessionId, contractAddress, contractName?, idempotencyKey?, sponsorSessionId?) → { jobId, status }`

Removes an expired claim (`kind: 'claim'`, `key` the claim key). Any session may call it. The vault refuses an entry that has not expired. Rate class `prove`.

### `registerGranteeIdentity(bindingInput, scope?) → { ID, granteeId, bindingKind }`

Links the caller to the grantee id that grants name. Off by default: it answers 403 unless the server sets `allowSelfServiceGranteeRegistration`. The server setting `granteeBinding`, default `wallet`, sets the input: a coin public key, a DID for `did`, or the 64-hex id for `custom`. A key or an id takes `0x` and either letter case. A DID is hashed as the text it is, so its spelling is part of the id. `scope` narrows the link to one contract or attestation. Idempotent per user and scope. Proving ownership of the input is the consumer's policy.

## Disclosure to token holders

A document's text bound to a shielded token type. Whoever holds a token of the type reads it, without the issuer learning who. A holder registers on the `holder-registry` contract (`@odatano/contract-holder-registry`) with `registerHolder(coin, claim_key)`, which passes one coin through the contract and back. The claim key is `holderClaimKey(secret)` from `@odatano/nightgate-tx`. The call is sponsorable like any other.

### `grantDisclosureToHolders(payloadHash, tokenType, registryAddress, content?, contentType?, expiresAt?) → { holderGrantId, payloadHash, tokenType, registryAddress, hasContent, expiresAt, status }`

Binds `payloadHash` to `tokenType`. `content` (up to 1,048,576 characters) must hash to `payloadHash`, by blake2b-256 or sha256 of the UTF-8 text, and is stored encrypted. `expiresAt` is at most 366 days ahead. The same grantor, payload, type and registry again updates the grant (`status: "updated"`). Grantable. Rate class `compute`.

### `revokeHolderDisclosure(holderGrantId) → { holderGrantId, status }`

Grantor only. Rate class `compute`.

### `claimDisclosure(payloadHash, tokenType, claimSecret) → { entitled, reason, payloadHash, tokenType, registryAddress, holderGrantId, contentType, contentHashKind, content, expiresAt, registries }`

Computes the claim key from `claimSecret`, reads the registry live and returns the stored text, or `entitled: false` with a `reason` and the `registries` checked. A registry that holds another contract counts as not registered. `entitled: false` is answered only when every registry was read; otherwise the read error is returned, 502 `BAD_GATEWAY` for an indexer that cannot serve the state. 503 without a live indexer. Every token may call it. Rate class `compute`.

## Diagnostics

### `getWalletBalance(sessionId) → { shieldedNight, unshieldedNight, shieldedTokens, dustBalance, registeredNightUtxoCount, totalNightUtxoCount, dustUtxoCount, dustPendingCount, dustPendingValue, dustRestoreCount }` (function)

Amounts are atom strings. `shieldedTokens` lists other shielded types as `{ tokenType, amount }`. `dustPendingCount` and `dustPendingValue` are spends in flight. `dustRestoreCount` counts dust state restores after a rejected submission. Registered UTXOs with no dust notes and no pending spends while fees fail point to a stuck dust state, see the operations guide. A wallet that does not reach the tip within `NIGHTGATE_WALLET_READ_SYNC_TIMEOUT_MS` (default 10 s) answers 503 `WALLET_SYNCING`. Rate class `read`.

### `getWalletSyncProgress(sessionId) → { known, caughtUp, appliedIndex, streamTip, behindEvents, eventsPerSecond, etaSeconds, blockHeight, isConnected, indexerFresh, indexerTipAgeSeconds, indexerError, elapsedMs, phase, updatedAt, lastProgressAt, staleSeconds, stale, jobId, jobStatus, restoredFromSnapshot, snapshotSavedAt, facadeBuildStartedAt, facadeBuiltAt }` (function)

Catch-up progress from a snapshot the worker pushes about every 15 s while the wallet syncs, and every `NIGHTGATE_PROGRESS_WATCH_MS` once it caught up.

- `appliedIndex`, `streamTip` and `behindEvents` count dust ledger events, not blocks. `known: false` means nothing reported yet.
- Stuck: `appliedIndex` stays while `elapsedMs` grows, or `isConnected` is false. `indexerFresh: false`: the indexer lags beyond `NIGHTGATE_SYNC_FRESHNESS_MS` or its tip could not be read (`indexerError`).
- `stale` past `NIGHTGATE_SYNC_PROGRESS_STALE_S`, or past two `NIGHTGATE_PROGRESS_WATCH_MS` when that is longer, means nobody is syncing. `jobId` is the latest prewarm job. A prewarm fails after `NIGHTGATE_PREWARM_STALL_MS` (default 10 min) without progress.
- `restoredFromSnapshot: false` is a cold start. `facadeBuiltAt` is null while a large state deserializes.

Rate class `read`.

### `getSponsorPoolStatus() → [{ sessionId, configured, usable, dustBalance, unshieldedNight, totalNightUtxoCount, registeredNightUtxos, dustNotes, pendingDustNotes, dustRestoreCount, caughtUp, stale, asOf, lastError }]` (function)

Health of each configured fee sponsor.

- `dustNotes` is the number of transactions the sponsor can pay at once. `pendingDustNotes > 0` means a spend in flight or a leaked note.
- `usable` needs spendable notes, dust and `caughtUp`. `caughtUp` is the sync gate a sponsored job must pass, from the worker's last push.
- `dustBalance` and `unshieldedNight` are null unless admin or owner.
- `stale: true`: the worker did not answer within `NIGHTGATE_SPONSOR_STATUS_TIMEOUT_MS` (default 45 s). The figures are from `asOf` and `usable` is false.
- Never builds a wallet that is not loaded. 403 for agent tokens.

Rate class `read`.

## Indexer service

`getLiveness`, `getReadiness`, `getSyncStatus`, `getHealth`, `getBoardStatus` and `getReceiptKey` are anonymous. `getRuntimeInfo` and `getReorgHistory` need a user. `getMetrics`, `getWorkerStatus` and crawler control need admin. `getLiveness` and `getReadiness` are never rate limited, the other anonymous ones count in `read` per client address.

### `getLiveness() → { status, timestamp, uptime, instanceId }`

200 while the process runs. Does not touch the database.

### `getReadiness() → { ready, phase, crawlerEnabled, checks: { database, crawler, node, runtime, initialization }, initializationMode, instanceId, runtimeMode, replicaCount, databaseKind, runtimeWarnings }`

503 when not ready. `phase` is `starting`, `warming`, `catching_up`, `ready`, `degraded` or `failed`. While `warming` the sponsor pool prewarms and the process counts as ready. A disabled crawler passes `crawler` and `node`. `initializationMode: 'offline'` means a refused schema preflight or a failed start. A failing check adds a reason to `runtimeWarnings`.

### `getHealth() → { status, chainHeight, indexedHeight, finalizedHeight, lag, finalizedLag, blocksPerSecond, syncStatus, instanceId, runtimeMode, replicaCount, databaseKind, topologyValid, runtimeWarnings }`

The crawler's view. `status` is `unhealthy` when an enabled crawler stopped or lags more than 100 blocks, `degraded` above 10 blocks or after five minutes without a block, else `healthy`.

### `getSyncStatus() → SyncState`

The persisted crawler state.

### `getMetrics() → String`

Admin only. Prometheus text, prefix `odatano_nightgate_`: heights, lag, throughput, errors, sync status (stopped 0, syncing 1, synced 2, error 3), runtime topology, jobs and wallet worker. Over OData the text arrives as `{"value":"..."}`; unwrap it for a Prometheus parser.

### `getBoardStatus() → { openOffers, offersFilledToday, swapsToday, sponsorsConfigured, sponsorsReady, factoryContract, version, asOf }`

Counts for a market page, recomputed at most every 10 s. Days are UTC. `sponsorsReady` counts sponsors at tip with a spendable note. Rate class `read`.

### `getReceiptKey() → { publicKey, algorithm }`

The Ed25519 key that signs [receipts](#receipts). Rate class `read`.

### `getRuntimeInfo() → { version, apiVersion, network, provingMode, instanceId, runtimeMode, databaseKind, uptime, node, contracts }`

`node` is `{ version, specName, specVersion, transactionVersion, ledgerVersion, peers, isSyncing, errors }` of the node the crawler reads, null while no crawler runs. A node call that fails leaves its field null and is named in `errors`. `contracts` lists `{ name, artifactDigest, currentDigest, digestStale, digestError, package, version, slotWidth, privateStateId }`. `artifactDigest` is the loaded build that jobs are pinned to, `currentDigest` the files now. `digestStale: true` means the files changed under the running server, and write jobs fail until a restart. Rate class `read`.

### `getWorkerStatus() → { started, running, inFlightRpcs, exitCount, rotationCount, lastExitCode, lastExitAt, rpcTimeoutMs, pool, workers, facadeCount, facades }`

Health of the threads that run the wallets, for admins. A climbing `exitCount` means a crash loop, a growing `inFlightRpcs` a stall. `pool` is the configuration `{ walletWorkers, sponsorWorkers }`. `workers` has one entry per started thread: `{ id, running, inFlightRpcs, facadeCount, walletKeys }`. `facades` lists the wallets the server holds: `{ walletKey, label, caughtUp, updatedAt }`. A `walletKey` is derived from the wallet and stays the same in every session of that wallet.

### `getReorgHistory(limit?) → ReorgLog[]`

The last `limit` reorgs (default 10, at most 100).

### `pauseCrawler()`, `resumeCrawler() → { status, running, message }`

`resumeCrawler` starts the crawler whatever `NIGHTGATE_CRAWLER_ENABLED` says and retries a block latched as unindexable. Neither survives a restart. `pauseCrawler` answers 409 while a crawler start is running. When the crawler could not start at boot because the node did not answer, the server refuses write actions with 503 until a `resumeCrawler` succeeds.

### `reindexFromHeight(height) → { status, message, requestedHeight, effectiveStartHeight, blocksRolledBack, transactionsRolledBack, crawlerResumed }`

Rolls back indexed data from `height` up and indexes it again. `NightBalances` are recomputed, and job outcomes confirmed at or above the height return to a pending chain status. The rollback removes 2000 blocks per committed transaction, from the tip down. When it outlasts `NIGHTGATE_REINDEX_REPLY_WAIT_MS` (20 s) the answer is `status: running` and the rollback finishes in the background. A crawler that ran before is then resumed at the end. While a reindex runs, `pauseCrawler`, `resumeCrawler` and a second `reindexFromHeight` answer 409.

`SyncState.reindexTargetHeight` holds the target until the last slice committed. A failed slice sets `syncStatus` to `error` with `lastError` and leaves the crawler stopped. A restart or `resumeCrawler` finishes the open rollback first, then starts the crawler. A new `reindexFromHeight` above an open target removes down to that target.

## Analytics

`getBlockCount()`, `getTransactionCount()`, `getContractCount()` and `getAverageTransactionsPerBlock()` aggregate the indexed entities. `getContractCount` counts distinct contract addresses. Entities: `BlockStatistics` (one row per block with `transactionCount`, page size 100, at most 1000) and `ContractStatistics` (actions per `actionType`).

## Admin

Read-only entities: `WalletSessions`, `BackgroundJobs` (without `command`, `request` and `result`, a database view that needs `cds deploy` or `scripts/apply-schema-delta.mjs`), `LearnedTokenTypes`, and `SwapOffers` with poster and nullifiers.

- `invalidateSession(sessionId) → { sessionId, isActive }`, `invalidateAllSessions() → { invalidated }`: force-close any session. `invalidated` counts the sessions that were active.
- `exportContractSigningKey(sessionId, contractAddress, password) → { format, encryptedPayload, salt, contractAddress, accountId }`: the contract's maintenance key, sealed under `password` (at least 16 characters). No action restores it.
- `registerContract(name, artifactPath, zkConfigPath, privateStateId, slotWidth?) → { name, source, artifactPath, zkConfigPath, privateStateId, slotWidth, artifactDigest, hasProverKeys }`: registers an artifact without a restart. Paths must lie in `NIGHTGATE_CONTRACTS_DIR`. The module is validated before anything changes, saved in `ContractRegistrations` and reloaded at boot. A config name is 409. A new build under a name is a new generation, and jobs of the old one refuse. `hasProverKeys: false` allows deploy and verify only.
- `unregisterContract(name) → { removed }`: config names are 409.
- `listContracts() → [{ name, source, artifactPath, zkConfigPath, privateStateId, slotWidth, artifactDigest, hasProverKeys }]`: `source` is `config` or `runtime`.
- `getJobStats(windowHours?) → { windowHours, since, total, byStatus, topErrors, oldestQueuedSeconds }`: default 24 hours, at most 720.
- `getSponsorPolicy(grantId?) → { source, path, loadedAt, ignoredEnv, floor, floorError, grant, effective, effectiveError }`: the platform policy and, with `grantId`, what the grant may use. 404 for an unknown grant.
- `reconcileNightBalances(address?, after?, limit?) → { checked, next, drifted }`: `NightBalances` rows that differ from the indexed UTXOs. Writes nothing. `limit` at most 500. `field: 'row'` is a missing row.
- `redecodeFromHeight(height) → { fromHeight, previousDecodedHeight, blocks, changed }`: lowers the payload decode cursor so the decode pass rewrites the decoded fields from `height` up. `changed` is false when the cursor already stood below.
- `profileWorker(seconds?, dir?, thread?) → { thread, seconds, file, ... }`: CPU profile of the `worker` (default) or `main` thread for 1 to 120 s (default 20). The `.cpuprofile` goes to `nightgate-profiles/` in the OS temp folder or its subfolder `dir`.

## Chain entities

Every `@readonly` entity supports the OData V4 query options.

```bash
curl "http://localhost:4004/odata/v4/midnight/Blocks?\$top=10&\$orderby=height desc"
```

Every entity holds hashes, contract addresses, token types and identifiers as lowercase hex without `0x`. A `$filter`, a key and a read function take such a value with or without `0x`, in either letter case. A value that is not hex answers 400.

```bash
curl "http://localhost:4004/odata/v4/midnight/Blocks?\$filter=hash eq '0x718C…7B2C'"
```

A read returns at most 1000 rows. When more exist, the answer carries `@odata.nextLink`, the address of the next page. `$count=true` adds the total. `createdAt` is the time the server stored the row.

Reads have these limits:

- Every read counts in the rate class `query`, 600 per minute per caller. Past it the answer is 429 with `Retry-After`.
- A caller runs at most 4 reads at the same time (`NIGHTGATE_QUERY_CONCURRENCY`). One more answers 429 with `Retry-After`. `getJobStatus` does not count.
- A `$batch` carries at most 20 requests (`NIGHTGATE_BATCH_MAX_PARTS`), and each counts as one read. A larger one answers 429 `BATCH_TOO_MANY_REQ`.
- On PostgreSQL a read or a read function that runs longer than 15 seconds (`NIGHTGATE_QUERY_TIMEOUT_MS`) is stopped and answers 504 `QUERY_TIMEOUT`. SQLite has no such limit.
- `Blocks`, `Transactions`, `TransactionResults`, `TransactionFees`, `ContractActions`, `DustLedgerEvents` and `BlockStatistics` filter and sort by indexed columns only. A `$filter` needs one condition on an indexed column with `eq`, `lt`, `le`, `gt`, `ge` or `in`, joined to the rest with `and`. A `$orderby` starts with an indexed column. Otherwise the answer is 400 `QUERY_NOT_INDEXED`, and its message names the indexed columns. A read along a key or a navigation, such as `Blocks(<ID>)/transactions`, takes any filter. `$count=true` is allowed.

The order of the chain is on the row. `Transactions`, `ContractActions` and `UnshieldedUtxos` carry `blockHeight` and `indexInBlock`, the place of the transaction in its block, next to their own `actionIndex` or `outputIndex`. A UTXO has the place of the transaction that created it. Sort by these columns, all ascending or all descending. `createdAt` is the time the server stored a row, the same for every row of a block, and says nothing about their order.

| Read | Query |
|---|---|
| The newest block | `Blocks?$orderby=height desc&$top=1` |
| The block at a height | `Blocks?$filter=height eq 4711` |
| The blocks between two heights | `Blocks?$filter=height ge 4000 and height le 4711&$orderby=height` |
| The transactions of a type, newest first | `Transactions?$filter=txType eq 'contract_call'&$orderby=blockHeight desc,indexInBlock desc` |
| The actions of a contract, in the order of the chain | `ContractActions?$filter=contractAddress eq '3c…3c'&$orderby=blockHeight,indexInBlock,actionIndex` |
| The actions of a contract, newest first | `ContractActions?$filter=contractAddress eq '3c…3c'&$orderby=blockHeight desc,indexInBlock desc,actionIndex desc` |
| The actions of a contract from a height on | `ContractActions?$filter=contractAddress eq '3c…3c' and blockHeight ge 4000&$orderby=blockHeight,indexInBlock,actionIndex` |
| The UTXOs of an address, newest first | `UnshieldedUtxos?$filter=owner eq 'mn_addr…'&$orderby=blockHeight desc,indexInBlock desc,outputIndex desc` |
| The unspent UTXOs of an address | `UnshieldedUtxos?$filter=owner eq 'mn_addr…' and spentAtTransaction_ID eq null` |
| Every unspent UTXO, newest first | `UnshieldedUtxos?$filter=spentAtTransaction_ID eq null&$orderby=blockHeight desc,indexInBlock desc,outputIndex desc` |
| The balance of an address | `NightBalances('mn_addr…')`, 404 for an address without a row |
| The highest balances | `NightBalances?$orderby=balance desc&$top=10` |

Bound read functions answer what a query cannot, for example `Transactions/byHash(hash='718c…7b2c')`.

| Function | Answer |
|---|---|
| `Transactions/byHash(hash, limit, skip)` | the transactions with that hash, newest first. `limit` is 1 to 5000, default 100. A full page means more rows exist |
| `Transactions/byTxId(txId)` | one inclusion, 404 until indexed |
| `Transactions/ledgerTransaction(hash)` | the ledger transaction as base64, 404 until indexed |
| `ContractStates/stateAt(contractAddress, height?)` | one snapshot |
| `Blocks/ledgerParametersAt(height?)` | the ledger parameters in effect, 404 when unknown |

A transaction has two hashes and one or more identifiers. `extrinsicHash` is the hash of the extrinsic, as the node and Substrate tools show it. `txHash` is the hash of the ledger transaction, as explorers and the Midnight indexer show it. A ledger transaction has one or more identifiers, and a job names the last one as its `txId`; `byTxId` finds the transaction by any of them. `indexInBlock` is the position of the transaction in its block. `byHash` and `ledgerTransaction` find a transaction by either. An extrinsic hash can occur in more than one block, because the timestamp transaction repeats its hash.

`Transactions/byTxId` returns `{ txId, extrinsicHash, txHash, blockHeight, blockHash, status, failedSegments }`. `status` is null until the indexer supplement has the result.

`ContractStates/stateAt` returns the state at `height`, default the newest, with `source` `history`, `current` or `indexer`. `blockHash` belongs to the state's block. `ledgerParameters` are those in effect at `height`, default the chain tip, because a contract at rest keeps its old state while the chain moves on. Both are null when unknown. 404 when no state is known. 503 while the crawler holds a newer action than the indexer; retry in a few seconds. 429 `indexer-budget` past the shared budget. 502 `BAD_GATEWAY` when the indexer fails, with the cause in the message and URLs removed.

`Blocks/ledgerParametersAt` returns `{ height, ledgerParameters, coveredHeight, chainHeight }`: the parameters in effect at `height`, default the chain tip, as base64. A builder needs them for a deploy, which has no contract state to read them from. The database answers first, else the indexer under the shared budget. 404 when neither knows them, 429 and 502 as for `stateAt`.

## Error model

OData envelope `{ error: { code, message } }`. `code` is a specific code where a client can act on it, otherwise the class of the HTTP status. The full list is in [reference.md](reference.md#http-error-codes). For submission errors `message` is a JSON string with the classification:

```json
{"error":{"code":"INVALID_ARGUMENT","message":"{\"code\":\"Wallet.InsufficientFunds\",\"retryable\":false,\"message\":\"Insufficient Funds: could not balance dust\",\"submissionId\":\"54b1968a-...\"}"}}
```

CAP hides every 5xx message under `NODE_ENV=production`. These keep their body and set `Retry-After`:

| `error.code` | Meaning | `Retry-After` |
|---|---|---|
| `JOB_ADMISSION_BUSY` | database busy for the whole admission retry budget, nothing written | 2 s |
| `WALLET_SYNCING` | a wallet read hit the sync gate | 15 s |
| a retryable submission code | the JSON payload with `retryable: true` | none |

`stateAt` and `ledgerParametersAt` keep their 502 and 503 messages too. Every other 5xx keeps its `code` and withholds the message.

**Worker classification.** The wallet worker classifies a submit failure once from the SDK error objects and sends `code`, `ledgerCode`, `retryable`, batch `calls` and the cause chain as data.

| Worker code | Meaning |
|---|---|
| `pre-mempool-reject` | refused before the mempool, fee unspent; `ledgerCode` `1010/<n>`, `1014`, `1016` or `intent-rejected` |
| `dust-race` | `1010/170`, `1010/171`, `1010/196` or `pool-invalid`; rebuild-retryable |
| `transport` | the send failed before an answer: `closing-socket`, `not-sent` or `wallet-not-synced` |
| `ambiguous` | the broadcast may have landed; reconciled by identifier, never rebuilt |
| `landed-not-applied` | on chain, call not applied |
| `policy` | sponsor shape check or allowlist refusal |
| `causality` | batch causality refusal before proving |
| `gas-budget` | a batch call runs out of gas before proving |
| `internal` | anything else |

Job codes. A job ends with a code of this server or with a number of the node.

- **Codes of this server** are upper case with underscores. The full list is the table of [error codes](reference.md#http-error-codes), generated from the server; it marks the codes made for jobs. A failure that also refuses a request has the same code in a job, for example `SPONSOR_REFUSED`, `ARG_COERCION_FAILED` or `WALLET_NOT_SYNCED`, and keeps it across a restart. Any other failure is `UNKNOWN_ERROR`, and its message starts with the name of the error.
- **Numbers of the node** stay as the node states them:

| Code | Retried by the server | Trigger |
|---|---|---|
| `1010`, `1010/<n>` | no, except the dust races `1010/170`, `1010/171` and `1010/196` | invalid transaction, with the ledger error `<n>` where the node names one |
| `1014` | no | pool reject, priority too low |
| `1016` | yes on test networks, no on mainnet | immediately dropped |

The server repeats a job itself for `NETWORK_OR_TIMEOUT`, `POOL_INVALID`, `SPONSOR_POLICY_UNAVAILABLE` and the dust races. With `NETWORK_OR_TIMEOUT` nothing is on chain; a sponsored job moves to the next sponsor when the wallet was not synced. `SUBMIT_AMBIGUOUS` parks the job as `BROADCAST_UNCONFIRMED`, see [async job model](#async-job-model-write-actions). `BATCH_CAUSALITY_VIOLATION` carries `calls` with name, segment and stages.

Raw node or SDK errors:

- **`1010/103`**: a spent coin, or a zswap proof against a coin tree state the node no longer accepts. No fee, never rebuilt. A filled or aged swap half ends here.
- **`1010/170`, `1010/171`, `1010/196`** (dust race): the dust spend was built on an outdated dust state. No fee. Deploy, call and batch rebuild in the worker (`NIGHTGATE_DUST_RACE_RETRIES`, default 2), sponsored paths per `NIGHTGATE_SPONSOR_DUST_RETRIES`.
- **`1010/231`**: the transaction takes a node longer to dismiss than the ledger allows for its size. The guaranteed gas of its calls and the checks of its proofs count, the limit is 15 ms or 2 µs per byte on the current networks. No fee. A sponsor refuses such a transaction before sending it, see [Sponsor policy](#sponsor-policy).
- **`failed assert: predicate false`**: a predicate circuit rejected the claim.
- **`Wallet.InsufficientFunds`**: not enough dust for the fee or NIGHT for the outputs.
- **`MALFORMED_RESULT`**: the SDK returned without the expected fields.

For 503s caused by the indexer, see [operations.md](operations.md#troubleshooting).
