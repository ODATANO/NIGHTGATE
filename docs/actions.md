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

## API versioning while 0.x

A minor release may change or remove an action, a patch release never does. A removal is marked `@deprecated` in the CDS doc and here at least one minor release ahead. `getRuntimeInfo().apiVersion` reports the running major.minor.

## Async job model (write actions)

Every submitting action returns `{ jobId, status: "pending" }` and runs as a background job. The job result named per action is the parsed `result` of `getJobStatus`.

- A reused `idempotencyKey` returns the existing job. The same key with another payload is 409 `IDEMPOTENCY_KEY_CONFLICT`. A key over 128 characters is 400 `IDEMPOTENCY_KEY_INVALID`. Keys are per caller.
- A `failed` job releases its key. The next request with that key starts a new job, with any payload.
- A parked job (`reconciliation_required`) and a workflow step keep their key.

### `getJobStatus(jobId, sessionId, waitMs?, untilChain?) → { jobId, kind, status, result, errorCode, errorMessage, attempt, maxAttempts, submissionId, txHash, transactionId, transactionHash, chainStatus, chainFinalizedAt, chainBlockHeight, chainBlockHash, chainSegments, queuedAt, externalExecutionAt, submittedAt, startedAt, finishedAt, receipt }`

An action that changes nothing.

- `status`: `pending`, `running`, `external_execution`, `submitted`, `reconciliation_required`, `succeeded` or `failed`.
- `waitMs` (at most 25000) holds the call until the job settles or the time is up. Past 100 waiting calls the server answers at once. A call ends when its client disconnects.
- `untilChain: true` with `waitMs` keeps holding a `succeeded` job while `chainStatus` is `pending`. A receipt exists only after that.
- `result` is JSON text. On failure `errorCode` and `errorMessage` are set, see [Error model](#error-model).
- `txHash` equals `transactionId`, the ledger identifier. It exists once the transaction is built and stays the same when a sponsor adds its fee. `transactionHash` is the hash explorers show, `null` until indexed.
- `chainStatus`: `null`, `pending`, `success`, `failure` or `dropped`. It is independent of `status`: `succeeded` with `failure` means the transaction finalized but the call reverted. `succeeded` with `dropped` means the transaction never landed before its ttl.
- `chainBlockHeight` and `chainBlockHash` are the confirmed inclusion. A reorg rollback reverts by them.
- `chainSegments` (batches, once confirmed): JSON `[{ segment, calls, applied }]`. A partial success reads `failed` with `chainStatus: failure`. Resend only the segments with `applied: false`.
- `receipt` is set once a `sponsorSwap` or `sponsorTransfer` job succeeded on chain, see [Receipts](#receipts).

Every submit path persists the identifier as `txHash` before the broadcast. A `failed` job without `txHash` sent nothing. A pre-mempool reject closes its attempt `REJECTED` on `PendingSubmissions` and clears the hash.

**`reconciliation_required`.** Execution stopped after an external effect may have happened. Do not retry automatically. A new attempt needs a new `idempotencyKey`. The reconciler looks up `txHash` on the indexer and ends the job `succeeded`, `failed` with `CHAIN_EXECUTION_FAILED`, or `failed` with `BROADCAST_NOT_INCLUDED` and `chainStatus: dropped`. The last happens once the indexer tip is past the transaction's ttl plus `NIGHTGATE_BROADCAST_EXPIRY_MARGIN_MS` (default 5 min).

| Parked `errorCode` | Meaning |
|---|---|
| `BROADCAST_UNCONFIRMED` | submitted, no node status, not indexed yet |
| `EXTERNAL_EXECUTION_FAILED` | failure after the broadcast |
| `PROCESS_RESTART_RECONCILE` | restart after the broadcast |
| `CHILD_RECONCILIATION_REQUIRED` | a workflow step is on chain but a later step did not complete. Once every step succeeded the workflow runs again and reuses them |
| `CHAIN_EXECUTION_FAILED_UNCONFIRMED` | on-chain failure whose block height the confirmer has not recorded yet |

### Receipts

`receipt` is `{ payload, signature, publicKey, algorithm: "ed25519" }`. `payload` is canonical JSON with sorted keys of `{ v: 1, kind, jobId, network, txHash, transactionHash, blockHeight, blockHash, finalizedAt, swap | transfer }` with `kind` `swap` or `transfer`. A transfer carries `declared: true`, because its terms are the caller's statement. The signature is Ed25519 over the UTF-8 payload. The key is `NIGHTGATE_RECEIPT_SIGNING_KEY`, else derived from the active encryption key, so a key rotation changes it. `getReceiptKey()` publishes it without credentials. A third party checks a receipt with `verifyReceipt` from `@odatano/nightgate-tx`. The same facts always give the same signature.

## Rate limits

Every limited call belongs to one rate class with a fixed window and one count. The count is `NIGHTGATE_<CLASS>_RATE_LIMIT`, or `rateLimits.<class>` in `NIGHTGATE_SPONSOR_POLICY_FILE`, which applies without a restart. The caller is the agent grant, else the user, else the client address.

| Class | Window | Default | Counted per | Calls |
|---|---|---|---|---|
| `prove` | hour | 60 | caller and session | `submitContractCall`, `submitContractCallBatch`, `mintShieldedTestToken`, `burnFactoryToken`, the `issue*` actions (a batch counts its claims), `anchorDocument`, `attestAgentOutput`, `registerPassport`, `retractAttestation`, `purgeExpired`, `grantDisclosure`, `revokeDisclosure`, `buildSponsorable` |
| `deploy` | hour | 5 | caller and session | `deployContract` |
| `sponsor` | hour | 120 | caller | `sponsorFinalizedTransaction`, `sponsorUnboundTransaction`, `sponsorSwap`, `sponsorTransfer`, `mintFactoryToken` |
| `compute` | hour | 120 | caller | `prepareDocumentProof`, `prepareMembershipSet`, `claimDisclosure`, `grantDisclosureToHolders`, `revokeHolderDisclosure`, `postSwapOffer`, `retireSwapOffer`, `reindexDisclosures` (per contract) |
| `read` | minute | 60 | caller | `listSwapOffers`, `getSwapOffer`, `getBoardStatus`, `getReceiptKey`, `verifyDocument`, `verifyPredicateAttestation`, `getRuntimeInfo`, `getWalletBalance`, `getWalletSyncProgress`, `getSponsorPoolStatus`, `estimateSendNightFee` |
| `wallet` | minute | 10 | caller | `connectWallet`, `sendNight`, `registerForDustGeneration`, `deregisterFromDustGeneration` |
| `signing` | hour | 10 | caller | `connectWalletForSigning`, `deriveWalletInfo` |
| `admin` | hour | 10 | caller | `createAgentGrant`, `createAgentGrants`, `updateAgentGrant`, `rotateAgentGrantToken`, `revokeAgentGrant` |
| `public-verify` | minute | 60 | client address | the functions under `/odata/v4/midnight-verify` |

A grant adds `maxJobsPerHour` and `maxJobsPerDay` per UTC hour and day. A request that fails with a 4xx gives its unit back. Answers carry `RateLimit-Policy` and `RateLimit` headers. A refusal is `429 RATE_LIMITED` with `Retry-After`, not on `$batch` parts. `ContractStates/stateAt` shares one indexer budget for all callers (`NIGHTGATE_STATE_AT_INDEXER_RATE`, default 2 per second).

## Sessions

### `connectWallet(viewingKey, label?) → { ID, sessionId, label, connectedAt, expiresAt, isActive }`

Opens a read-only session. `viewingKey` is the wallet's encryption public key, 64 hex, stored AES-256-GCM encrypted. `label` has at most 100 characters. Rate class `wallet`.

```bash
curl -X POST http://localhost:4004/odata/v4/midnight/connectWallet \
  -H "Content-Type: application/json" \
  -d '{"viewingKey":"a32699a5a29e453f6e92624c2fbefdee173d3f1178e3f9c71bc3edb7d91c1403"}'
```

### `connectWalletForSigning(sessionId, mnemonic | seedHex, accountIndex?, idempotencyKey?, prewarm?) → { sessionId, signingEnabled, prewarmJobId, prewarmStatus }`

Adds signing. The BIP39 seed is stored encrypted. Keys derive per role as in Lace. The seed at `accountIndex` must derive the session's viewing key, so signer, session and on-chain attester id are one account. Use the same `accountIndex` as with `deriveWalletInfo`. A prewarm job syncs the wallet. Poll `getJobStatus(prewarmJobId, sessionId)` before submitting. `prewarm: false` syncs on the first submission. Errors: 400 invalid seed or another account, 404 no session, 410 expired, 412 already signing. Rate class `signing`.

### `disconnectWallet(sessionId)`

Closes the session and deletes its stored keys. The worker saves the wallet state once more and drops the wallet.

### `deriveWalletInfo(mnemonic | seedHex, accountIndex?) → { viewingKey, shieldedAddress, nightAddress, dustAddress, attesterId, accountIndex, network }`

Derives the session inputs without a session. Nothing is stored or logged. `dustAddress` is a receiver for `registerForDustGeneration`. `attesterId` is the vault's `caller_id()` of the wallet on every network. Pass it as `ownerId` of `registerPassport` before the wallet's first transaction. Rate class `signing`.

## Tokens and dust

### `sendNight(sessionId, receiverAddress, amount, ttlIso?, idempotencyKey?, tokenTypeHex?) → { jobId, status }`

Sends NIGHT, or the token `tokenTypeHex`. The address prefix picks the ledger: `mn_shield-addr_` pays from the shielded balance, `mn_addr_` from the unshielded one. `amount` is at most `10^18` atoms. `ttlIso` must lie in the future. Job result `{ txId, toLedger, amount, receiverAddress }`. Errors: 400 bad address, amount or ttl, 404 no session, 412 not signing. A job without funds fails with `Wallet.InsufficientFunds`. Rate class `wallet`.

### `estimateSendNightFee(sessionId, receiverAddress, amount, ttlIso?, tokenTypeHex?) → { fee, toLedger }`

DUST fee in atoms for a `sendNight`. Builds the recipe in the worker without proof or submit. Rate class `read`.

### `registerForDustGeneration(sessionId, dustReceiverAddress?, idempotencyKey?) → { jobId, status }`

Registers the wallet's unregistered unshielded NIGHT UTXOs for dust generation. Job result `{ txId, changed, reason, registeredCount, totalNightUtxos, dustReceiverAddress, requestedReceiver, registeredUtxosBefore, registeredUtxosAfter, settled, consolidated, message }`.

- Registration binds the address. Later NIGHT there generates dust for the same receiver.
- An already registered wallet succeeds with `changed: false` and `reason: "already-registered"`. To change the receiver, deregister and register again. `reason: "no-night-utxos"` means nothing to register.
- One registration consolidates its inputs into one UTXO. One registered UTXO yields one dust note, the unit of parallel sponsoring. Register first, then fund in separate payments.
- `registeredUtxosAfter` is read after the local apply, waiting up to `NIGHTGATE_DUST_REGISTER_SETTLE_MS` (default 90 s). Past it `settled` is false and the count `null`.

Dust accrues about 1 to 2 minutes after the transaction finalizes.

### `deregisterFromDustGeneration(sessionId, idempotencyKey?, sponsorSessionId?) → { jobId, status }`

Deregisters every registered NIGHT UTXO of the wallet. Job result `{ txId, deregisteredCount, totalNightUtxos }`.

### `mintShieldedTestToken(contractAddress, sessionId, compiledArtifactRef?, idempotencyKey?, sponsorSessionId?) → { jobId, status }`

Mints 100000000 atoms of the `shielded-token` test token (`@odatano/contract-shielded-token`) to the caller's zswap key. It exercises the zswap circuits, which NIGHT never touches. `compiledArtifactRef` accepts only `shielded-token`. Job result `{ txHash, contractAddress, tokenTypeHex, amount }`. Send the coins with `sendNight(tokenTypeHex)` once the wallet has synced them. Rate class `prove`.

### `mintFactoryToken(contractAddress?, name, amount, recipientCoinPublicKey, sessionId?, idempotencyKey?, sponsorSessionId?) → { jobId, status, name, amount, issuerKey, domain, tokenType }`

Mints on the `token-factory` lineage (`@odatano/contract-token-factory`). The session is the issuer. Its issuer key derives from the session's seed, and the caller never sees the issuer secret. `domain` and `tokenType` follow from issuer key, name and factory address, so the same name from another session is another token. `recipientCoinPublicKey` is a zswap coin public key.

- `contractAddress` defaults to `NIGHTGATE_TOKEN_FACTORY_CONTRACT`, which `getBoardStatus.factoryContract` names.
- A token caller may leave out `sessionId`. The session that pays its sponsored jobs then mints and is the issuer.
- A landed mint records the type in `LearnedTokenTypes` (at most 256) and, under a grant, in the grant's `mintedTokenTypes`.
- Job result `{ submissionId, txHash, contractAddress, tokenType }`. 404 `TOKEN_FACTORY_UNAVAILABLE` without the lineage. Grantable, circuit `mint`. Rate class `sponsor`.

### `burnFactoryToken(contractAddress?, name, amount, issuerKey?, sessionId, idempotencyKey?, sponsorSessionId?) → { jobId, status, name, amount, issuerKey, domain, tokenType }`

Burns `amount` of a factory token the session holds and lowers the factory's supply ledger. `issuerKey` defaults to the session's own. Job result as `submitContractCall`. Grantable, circuit `burn`. A grant's value budget counts the amount. Rate class `prove`.

### `deriveTokenType(contractAddress, domainSeparator?) → { tokenTypeHex, contractAddress, domainSeparator }` (function)

Computes `rawTokenType(domainSeparator, contractAddress)` for any minting contract. `domainSeparator` is text or 64 hex, default `nightgate:zswap-e2e`. The answer echoes the 64-hex form.

## Contracts

### `deployContract(compiledArtifactRef, sessionId, initialPrivateState?, idempotencyKey?, sponsorSessionId?, recoveryId?) → { jobId, status }`

Deploys a contract from `cds.requires.nightgate.contracts` or `registerContract`. Job result `{ submissionId, txHash, contractAddress, status }`, with `status` from `PendingSubmissions`: `pending`, `included`, `finalized`. `recoveryId` (vault only) is the attester id that may use `registerPassport` modes 3 and 4. Without it a lost registrar key locks the id registry for good. The registrar is the deploy session's attester id. 404 for an unknown contract. Rate class `deploy`.

### `submitContractCall(contractAddress, circuit, compiledArtifactRef, sessionId, args, idempotencyKey?, initialPrivateState?, sponsorSessionId?) → { jobId, status }`

Calls one circuit. `args` is a JSON array, see [Encoding circuit args](#encoding-circuit-args). `initialPrivateState` is used only on the wallet's first contact with the contract. Job result `{ submissionId, txHash, contractAddress, status }`. Rate class `prove`.

### `submitContractCallBatch(contractAddress, calls, compiledArtifactRef, sessionId, idempotencyKey?, initialPrivateState?, sponsorSessionId?, independentCalls?) → { jobId, status }`

Runs up to 8 circuit calls on one contract as one transaction. `calls` is a JSON array of `{ circuit, args }` in apply order. Job result `{ submissionId, txHash, contractAddress, circuits, status }` with `circuits` in apply order. Rate class `prove`.

- Segment ids are rewritten ascending in call order before proving. If that fails, the job aborts. `NIGHTGATE_BATCH_SEGMENT_MODE=observe` only logs.
- Same-name circuits have no fixed order among themselves.
- `independentCalls: true` orders calls by execution stage instead of call order. Use it only for calls that share no state.
- Proof witnesses ride per call in `merkleProof`. Single-field circuits take `fieldValue` or `fieldDigest`, `fieldSalt`, `siblings` and `dirs`; membership adds `setProof`. The comparison circuit takes `docPair: { schema, openingA, openingB }`. A malformed bundle is 400.

**Ledger causality.** The SDK splits each call into a guaranteed and a fallible part by gas cost. The ledger applies all guaranteed parts first and rejects a fallible call followed by a guaranteed one (`1010/188`). Cost grows with contract state, so a call's stage can move. On the vault `attest` and `anchorContentRoot` stay guaranteed and `bindDocument` is fallible, so put `bindDocument` last. Both rules are checked before proving, and nothing is submitted on a refusal:

- a stage conflict fails with `BatchCausalityViolation`, the message ending `Stages in apply order: <call>=<segment>[<stages>] ...`;
- a call that runs out of gas on a local ledger with the current state fails with `BatchGasBudgetExceeded`. Not checked in `observe` mode.

After submission a `PARTIAL_SUCCESS` fails the job with `OnChainStatus:...` and `chainStatus: failure`. Check the effect state, for example with `verifyAttestationState`.

### Fee sponsoring with `sponsorSessionId`

The session submit actions accept `sponsorSessionId`: `deployContract`, `submitContractCall`, `submitContractCallBatch`, `anchorDocument`, `attestAgentOutput`, the `issue*` actions, `grantDisclosure`, `revokeDisclosure`, `registerPassport`, `retractAttestation`, `purgeExpired`, `mintShieldedTestToken`, `mintFactoryToken`, `burnFactoryToken` and `deregisterFromDustGeneration`. The caller builds and signs, the sponsor pays the dust fee and submits. The caller needs no dust. A foreign sponsor must be listed in `NIGHTGATE_FEE_SPONSOR_SESSION` or `feeSponsorSessions`, else 404. A sponsor without signing is 412. Request and result carry `feeSponsor`.

### Encoding circuit args

Each element of `args` is coerced by the circuit's parameter types from the artifact's `contract-info.json`:

| Circuit parameter | JSON value | Coerced to |
|---|---|---|
| `Bytes<N>` | hex string, `0x` optional, or a `number[]` of bytes | `Uint8Array(N)`, length checked |
| `Uint<N>` | number or decimal string | `BigInt` |
| `Boolean` | `true` or `false` | boolean |
| struct | object with every declared field, each encoded by its own type | object with coerced fields |
| other (`Vector`, `Maybe`, `Either`) | the JSON value | unchanged |

Without `contract-info.json`, untagged arguments are 400. Tagged values always work: `{ "$bytes": "<hex>" }` and `{ "$uint": "<decimal>" }`. Invalid hex, a wrong length, a negative or non-integer `Uint` or a missing struct field is 400 naming `args[i]`.

```jsonc
"args": "[\"<64-hex document_id>\", {\"$bytes\":\"<64-hex payload_hash>\"}]"
```

## Cross-server fee sponsoring

The caller builds, proves and signs a call. The sponsor pays the dust and submits. Only the serialized transaction moves between them. Client side: [txbuilder.md](txbuilder.md).

The sponsor actions name no payer. The platform pool pays, or the wallet session the caller's grant is pinned to (`createAgentGrant` `sponsorSessionId`). Without either they answer 503. Poll `getJobStatus` with the returned `sessionId`.

### `buildSponsorable(contractAddress, circuit, compiledArtifactRef, sessionId, args) → { jobId, status }`

Builds, proves, signs and finalizes one call on the server without submitting. Job result `{ finalizedTxB64, serializedBytes }`. No dust is spent. Rate class `prove`.

### `sponsorFinalizedTransaction(finalizedTxB64, idempotencyKey?) → { jobId, status, sessionId }`

Checks the sponsor policy, adds the dust and submits a bound transaction. An unbound transaction is refused. Job result `{ txHash, circuits, contractAddress }`. Rate class `sponsor`.

### `sponsorUnboundTransaction(unboundTxB64, idempotencyKey?) → { jobId, status, sessionId }`

Takes the proven and signed transaction from txbuilder `buildSponsorable({ bind: false })`. Same policy as above. Locks one free dust backing, proves a dust-only spend, merges, binds and submits. Job result `{ txHash, circuits, contractAddress, note }` with `note` the backing used. Rate class `sponsor`.

- One wallet sponsors as many transactions at once as it has registered dust backings. A request waits up to `NIGHTGATE_BACKING_WAIT_MS` (default 5 min).
- A fee no single note covers is paid from up to `NIGHTGATE_SPONSOR_MAX_DUST_NOTES` backings (default 4).
- A lost dust race is rebuilt on the same sponsor (`NIGHTGATE_SPONSOR_DUST_RETRIES`, default 4).
- The job returns once in a block. `NIGHTGATE_SPONSOR_WAIT=finalized` waits for finality.

### `sponsorSwap(makerHalfB64 | offerId, takerHalfB64, idempotencyKey?, takerSecret?) → { jobId, status, sessionId }`

Sponsors a shielded swap without a contract. Each half is a proven transaction, for example from the wallet SDK's `initSwap(..., { payFees: false })`, given as an offer file (`swapoffer1...`, bech32m) or base64. A bound half binds the other one. The worker checks both, merges them, adds dust and submits. Job result `{ txHash, circuits: ["<swap>"], note, swap: { gives, wants } }` from the maker's side, each `{ tokenType, amount }`. Rate class `sponsor`.

Off unless `NIGHTGATE_SPONSOR_ALLOW_SWAPS` (policy file `allowSwaps`) is set, and a token needs `sponsorSwap` in `allowedActions`. Refused unless:

- each half carries an offer and nothing else, with no contract-owned coin;
- each half gives exactly one type and wants exactly one other, both in the effective `allowedTokenTypes`, neither NIGHT;
- each half has 1 to `NIGHTGATE_SPONSOR_SWAP_MAX_INPUTS` (default 4) inputs and at most two outputs;
- the halves mirror each other and the merge fits `NIGHTGATE_SPONSOR_MAX_TX_BYTES`. One input or output is about 5 kB.

`offerId` takes the maker half from the [offer board](#offer-board): 404 unknown, 409 closed, 403 without the matching `takerSecret`. A landed swap closes every open offer that spent one of its inputs. A second fill fails with `1010/103`. A half expires with the coin tree state it refers to. A half never handed over must be reverted in its wallet (`revertTransaction`).

### `sponsorTransfer(transferTxB64, tokenType, amount, idempotencyKey?) → { jobId, status, sessionId }`

Sponsors a plain shielded transfer built by the swap wallet's `buildTransfer`. The transaction is bound or unbound, base64 or offer-file text. Job result `{ txHash, circuits: ["<transfer>"], note, transfer: { tokenType, amount } }`. Rate class `sponsor`.

Off unless `NIGHTGATE_SPONSOR_ALLOW_TRANSFERS` (policy file `allowTransfers`) is set, and a token needs `sponsorTransfer` in `allowedActions`. `tokenType` must be in the effective `allowedTokenTypes`. The transaction must carry an offer and nothing else, spend 1 to `NIGHTGATE_SPONSOR_SWAP_MAX_INPUTS` coins, create one or two, and net to zero. Recipient, amount and type are commitments, so `tokenType` and `amount` are the caller's declaration. They count against the value budget and appear in the receipt as `declared: true`.

### Sponsor policy

The policy is a fail-closed shape check: allowlisted contract calls and nothing else. A deploy, an unshielded transfer, a zswap offer, caller dust actions, an unreadable structure or a transaction over `NIGHTGATE_SPONSOR_MAX_TX_BYTES` (default 65536) is refused, apart from the rights below.

```bash
NIGHTGATE_SPONSOR_ALLOWED_CONTRACTS=<vault address>,<other address>
NIGHTGATE_SPONSOR_ALLOWED_CIRCUITS=attest,anchorContentRoot,proveFieldPredicate
```

An empty list means no restriction. Whoever reaches the endpoint can then make you pay fees.

- **Policy file.** `NIGHTGATE_SPONSOR_POLICY_FILE` holds JSON with `allowedContracts`, `allowedCircuits`, `contractCircuits`, `allowDeploy`, `allowedTokenTypes`, `allowContractMints`, `allowSwaps`, `allowTransfers`, `shareMintedTokenTypes`, `allowUnshieldedOffers`, `allowedUnshieldedTokenTypes` and `rateLimits`. It is re-read per sponsored call and replaces the env settings. An invalid file keeps the last good policy. With none loaded every sponsored call is 503 `SPONSOR_POLICY_UNAVAILABLE`. Admin `getSponsorPolicy` shows the policy in force.
- **Circuits per contract.** `contractCircuits` (file only) maps a contract address to `"*"` or a list of circuits. The entry replaces `allowedCircuits` for that contract and allows the contract itself.
- **Grant lists.** A grant's `allowedContracts`, `allowedCircuits` and `allowedTokenTypes` narrow the platform lists for every action under its token. Circuits derive from the action, for example `anchorDocument` is `attest`. A missing grant list inherits the platform list. Disjoint contract or circuit lists are 403 `SPONSOR_POLICY_EMPTY`. Create and update answer 400 for such lists.
- **Re-resolved at execution.** A queued job runs under the current lists. A revoked grant fails its queued jobs with `AGENT_GRANT_REVOKED`.
- **Token offers.** A zswap offer passes when every net change is on a listed type other than NIGHT and every contract-owned coin belongs to a sponsorable contract.
- **Contract mints.** With `NIGHTGATE_SPONSOR_ALLOW_CONTRACT_MINTS` a type needs no list entry while a call of the same transaction mints it. A landed mint lists the type for its grant, or for every grant with `NIGHTGATE_SPONSOR_SHARE_MINTED_TOKEN_TYPES`.
- **Sponsored deploys.** Grant `allowDeploy` with `maxDeploys` (default 1, lifetime) and `NIGHTGATE_SPONSOR_ALLOW_DEPLOY` let the sponsor pay a deploy the caller built. Ceiling `NIGHTGATE_SPONSOR_MAX_DEPLOY_BYTES` (default 40960). A node reject refunds the budget. The landed address joins the grant's `deployedContracts`. Maintenance updates are never sponsored.
- **Unshielded offers.** Grant `allowUnshieldedOffers` and `NIGHTGATE_SPONSOR_ALLOW_UNSHIELDED_OFFERS` let a call move the caller's own NIGHT or `allowedUnshieldedTokenTypes` into the called contract, and pay out what the contract's proven result requires. The sponsor adds dust only. The job result lists `unshielded: [{ type, amount, to }]`.
- **Value budgets.** Grant `maxValuePerDay` caps the atoms moved per UTC day and type by swaps, transfers, mints and burns. Over it is 429 `grant-value`.

**Pool.** `NIGHTGATE_FEE_SPONSOR_SESSION` sessions form a pool with one in-flight dust spend per wallet. Callers wait up to `NIGHTGATE_SPONSOR_LEASE_WAIT_MS` (default 120 s). A failing sponsor is benched for `NIGHTGATE_SPONSOR_COOLDOWN_MS` and the job tries the next. Pool jobs run under the session id `00000000-0000-0000-0000-706f6f6c0000`.

**Submit timeouts.** Connect `NIGHTGATE_SUBMIT_CONNECT_TIMEOUT_MS` (20 s), request `NIGHTGATE_SUBMIT_REQUEST_TIMEOUT_MS` (30 s), watch until InBlock `NIGHTGATE_SUBMIT_WATCH_TIMEOUT_MS` (75 s). An ambiguous outcome is looked up on the indexer, else the job parks as `BROADCAST_UNCONFIRMED`.

**Contention.** Concurrent writes to the same contract state conflict. The loser is rejected with `1010/104` or lands as `PARTIAL_SUCCESS` with the fee paid, and must be rebuilt against the new state. Server-built calls rebuild (`NIGHTGATE_STALE_TRANSCRIPT_RETRIES`, default 2), a sponsored job cannot. Parallelize across contracts. Do not mix bound and unbound sponsoring on one sponsor wallet.

## Agent grants

A grant gives an autonomous agent a bearer token over one wallet session, sent in the `x-agent-token` header. Only its SHA-256 is stored. The token runs as the grant's operator, limited to `allowedActions`. Wallet lifecycle, sends, deploys, dust registration and grant administration are never grantable.

Always allowed under any token, without budget: entity reads (session entities narrowed to the grant's session, `GranteeIdentities` 403), the chain read functions including `ContractStates/stateAt`, the verify functions, `prepareDocumentProof`, `prepareMembershipSet`, `deriveTokenType`, `listSwapOffers`, `getSwapOffer`, `claimDisclosure`, `getJobStatus` and `getGrantUsage` for its own grant. `getSponsorPoolStatus` is 403.

### `createAgentGrant(sessionId, allowedActions, maxJobsPerDay?, maxJobsPerHour?, sponsorSessionId?, validUntil?, agentLabel?, allowedContracts?, allowedCircuits?, allowDeploy?, maxDeploys?, allowedTokenTypes?, allowUnshieldedOffers?, allowedUnshieldedTokenTypes?, maxValuePerDay?) → { grantId, token, ... }`

Creates one grant. The result repeats the stored settings. `token` is shown once. `sponsorSessionId` pins the wallet that pays the grant's sponsored jobs. See [Sponsor policy](#sponsor-policy) for the lists and rights. Rate class `admin`.

### `createAgentGrants(count, sessionId, allowedActions, labels?, ...) → { grants: [{ grantId, token, agentLabel }], ... }`

Creates 1 to 50 grants of one shape on one session. `labels` has exactly `count` entries, else the names are `<agentLabel>-1` to `<agentLabel>-n`. Budgets apply per grant. Rate class `admin`.

### `updateAgentGrant(grantId, ...) → { grantId, updated }`

Changes only the given settings. `null` clears `maxJobsPerHour`, `maxJobsPerDay`, `validUntil`, `agentLabel` and the lists. Session, sponsor and token are fixed. `maxDeploys` must be at least the deploys used. 409 `GRANT_REVOKED` on a revoked grant. Rate class `admin`.

### `rotateAgentGrantToken(grantId) → { grantId, token }`

Returns a new token once. The old one is 401 from the next request. Budgets and `deployedContracts` stay. Rate class `admin`.

### `revokeAgentGrant(grantId) → { revoked }`

Revokes at once. A grant of another user is 404. Rate class `admin`.

### `getGrantUsage(grantId?, since?, until?) → { grantId, since, until, jobs, landed, failed, deploysUsed, maxDeploys, jobsUsedToday, maxJobsPerDay, dustPaid, limits }` (function)

Jobs by kind and status between `since` and `until` (default the last 30 days, at most 366). `dustPaid` is the indexed DUST fees, null without the crawler. `limits` holds `jobsPerHour`, `jobsPerDay`, `valuePerDay` and the rate `classes` the grant can reach, each with what is left. Owner-scoped. A token reads only its own grant and may leave `grantId` empty.

## Offer board

Open maker halves posted for takers. The board stores intent, never value.

### `postSwapOffer(offer, expiresAt?, tags?, takerSecretHash?) → { offerId, status, bound, givesType, givesAmount, wantsType, wantsAmount, expiresAt, directed }`

`offer` is a maker half as offer file or base64. It is checked like a sponsored half except for the token allowlist, else 400 `SWAP_OFFER_INVALID`. `expiresAt` is at most 90 days ahead. `tags` holds up to 8 strings of up to 40 characters. The offer closes when a sponsored swap spends one of its inputs, when it expires, or when the poster retires it. `takerSecretHash` (sha256 of a secret) makes it directed: only the holder of the secret can take it. Grantable, also for a pool grant. Rate class `compute`.

### `listSwapOffers(givesType?, wantsType?, tag?, limit?, status?, since?, mine?, waitMs?) → [{ offerId, offer, bound, givesType, givesAmount, wantsType, wantsAmount, tags, expiresAt, postedAt, status, filledTxHash, closedAt, changedAt, directed }]` (function)

Open offers newest first. `status` `filled`, `retired`, `expired` or `all` orders by `changedAt`. `since` keeps offers changed after that instant, so `status: 'all'` with `since` is a change feed. `mine: true` keeps the caller's own posts. `waitMs` (at most 25000) holds the call until an offer matches. Never shows the poster or the nullifiers. Rate class `read`.

### `getSwapOffer(offerId) → { ... }` (function)

One offer in the board's shape, open or closed. 404 when unknown. Rate class `read`.

### `retireSwapOffer(offerId) → { offerId, status }`

Only the poster, the same user or grant. A closed offer answers 200 with its status. The poster's wallet keeps the coins reserved until it reverts the half. Rate class `compute`.

## Documents

### `anchorDocument(sha256, contentType?, size?, storageRef, metadata?, sessionId, contractAddress, compiledArtifactRef?, idempotencyKey?, sponsorSessionId?) → { jobId, status, documentId, attesterId }`

Records a document hash in the vault with one `attest` transaction. Only the hash and `storageRef` are stored, never the bytes. The `Documents` row is written at once, so `documentId` returns synchronously. Reads are owner-scoped. The record key `recordKey(attesterId, sha256)` derives from the caller in-circuit, so no other identity can take over the record. Job result `{ documentId, attestationId, attesterId, txHash, anchoredAt }`. Rate class `prove`.

### `verifyDocument(documentId, providedSha256, contractAddress?, compiledArtifactRef?) → { verified, included, stateChecked, anchoredTxHash, anchoredAt, originalSha256 }` (function)

`verified` is true when the hash matches and the attestation stands in live contract state. `included` means the anchoring transaction is indexed as `SUCCESS`. `stateChecked: false` means no live provider, so `verified` stays false. The contract, artifact and network recorded at anchor time win. Another caller value is 400. A mismatch is `verified: false` with `originalSha256: ''`. Rate class `read`.

### `attestAgentOutput(agentId, inputHash, outputHash, modelId?, policyHash?, producedAt?, storageRef?, sessionId, contractAddress, compiledArtifactRef?, idempotencyKey?, sponsorSessionId?) → { jobId, status, documentId, payloadHash, envelopeJson }`

Anchors a canonical envelope of an agent's input and output through `anchorDocument`. A third party checks it by hashing `envelopeJson` and calling `verifyAttestationState`. A retry with the same key reuses the first `producedAt`. Rate class `prove`.

### `prepareDocumentProof(document, proofFields, saltSeed?, compiledArtifactRef?) → { payloadHash, canonicalDocument, contentRoot, fields, emptyFields, schemaId, schema, leaves, opening }`

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

### `prepareMembershipSet(allowedValues, value?, valueDigest?, compiledArtifactRef?) → { setRoot, memberCount, setSiblings, setDirs }`

Canonical depth-6 set root for membership proofs. Each value is hashed with blake2b-256, deduplicated, sorted and padded to 64 by repeating the last member. More than 64 values is 400. With `value` or `valueDigest` the answer carries the inclusion path, 400 if it is no member. Outside a server use `@odatano/nightgate/set-root`, which gives the same roots. Rate class `compute`.

## ZK predicate attestations

Statements about anchored field values without revealing them: numeric thresholds, bytes equality, set membership, and integrity and diff between two documents. Each claim is bound to the content root and verified on chain. Contract: [AttestationVault](https://github.com/ODATANO/NIGHTGATE-CONTRACTS/tree/main/packages/attestation-vault).

- **Record.** A claim is proven against `recordKey(attesterId, payloadHash)`. `attesterId` defaults to the session's. A `contentRoot` given to an `issue*` action is anchored first, under the session's own record only, and needs `schemaId`.
- **Expiry.** `validUntil` (UNIX seconds) defaults to one year ahead (`NIGHTGATE_CLAIM_LIFETIME_S`), at most five years. An expired claim verifies false and can be removed with `purgeExpired`.
- **Width.** The `compiledArtifactRef` registration sets the width (16 by default). `attestation-vault-32` has 5-entry paths, 32-bit masks and `k` up to 32. Comparisons work only within one width.
- **Prover keys.** The npm package ships no prover keys. The first proving job fetches them from `NIGHTGATE_ZK_ASSET_URL` and checks them against `keys/manifest.json`. Offline: `npx nightgate-fetch-keys attestation-vault-32`. Container images contain them.
- **Failures.** A false claim fails at local proving and nothing is submitted.

All `issue*` actions return `{ jobId, status, predicateAttestationId }`, use rate class `prove` and write one `PredicateAttestations` row per claim. `siblings` and `dirs` are the inclusion path from `prepareDocumentProof`.

### `issueFieldPredicateAttestation(payloadHash, attesterId?, fieldKey, value, fieldSalt, contentRoot?, schemaId?, siblings, dirs, predicate, threshold, unit?, sessionId, contractAddress, compiledArtifactRef?, idempotencyKey?, sponsorSessionId?, validUntil?)`

Proves the scaled `value` is `lessOrEqual` or `greaterOrEqual` `threshold`. `value` stays witness and must fit `Uint<64>`. `threshold` is at most `2^63 - 1`. Job result `{ predicateAttestationId, payloadHash, claim, proof }`.

### `issueFieldPredicateAttestationBatch(payloadHash, attesterId?, contentRoot?, schemaId?, claims, sessionId, contractAddress, compiledArtifactRef?, idempotencyKey?, sponsorSessionId?, validUntil?) → { jobId, status, claims, droppedDuplicates }`

Proves up to 8 claims on one payload in one transaction. A given `contentRoot` takes one of the 8 slots. Each `BatchClaim` carries the inputs of the single action its `predicate` selects. For the document kinds the batch `payloadHash` is document A and B's root must already be anchored. Exact duplicates are dropped. All rows share one `provenTxHash`. After a `PARTIAL_SUCCESS` check each claim with `verifyPredicateAttestation`. The rate class counts one per claim.

### `issueFieldEqualityAttestation(payloadHash, attesterId?, fieldKey, expectedValue | expectedDigest, fieldSalt, contentRoot?, schemaId?, siblings, dirs, sessionId, contractAddress, compiledArtifactRef?, idempotencyKey?, sponsorSessionId?, validUntil?)`

Proves a `bytes` field holds the value behind `expectedDigest`, blake2b-256 of `expectedValue`. The digest is public, so this proves authenticity, not secrecy.

### `issueFieldMembershipAttestation(payloadHash, attesterId?, fieldKey, value | valueDigest, allowedValues | setRoot, setSiblings?, setDirs?, fieldSalt, contentRoot?, schemaId?, siblings, dirs, sessionId, contractAddress, compiledArtifactRef?, idempotencyKey?, sponsorSessionId?, validUntil?)`

Proves a hidden `bytes` value is one of up to 64 public values. Pass `allowedValues`, or `setRoot` with its 6-entry path from `prepareMembershipSet`. A value outside `allowedValues` is 400 before proving.

### `issueDocumentIntegrityAttestation(payloadHashA, payloadHashB, attesterIdA?, attesterIdB?, allowedMask, schema, openingA, openingB, contentRootA?, contentRootB?, schemaId?, sessionId, contractAddress, compiledArtifactRef?, idempotencyKey?, sponsorSessionId?, validUntil?)`

Proves document B differs from A only in the slots set in `allowedMask`. A mask that constrains no real slot is refused. The circuit recomputes the schema id and both roots, so both documents must be anchored under the same `schemaId`. The order of A and B is part of the claim. Each given content root is anchored in its own transaction first.

### `issueDocumentDiffAttestation(payloadHashA, payloadHashB, attesterIdA?, attesterIdB?, k, schema, openingA, openingB, contentRootA?, contentRootB?, schemaId?, sessionId, contractAddress, compiledArtifactRef?, idempotencyKey?, sponsorSessionId?, validUntil?)`

Proves at least `k` aligned slots differ, without revealing which. A change of value or presence counts. Slots empty in both do not.

### `verifyPredicateAttestation(predicateAttestationId) → { verified, included, stateChecked, predicate, threshold, unit, expectedDigest, setRoot, payloadHashB, allowedMask, provenTxHash, provenAt }` (function)

`verified` is true when the claim key, recomputed from the row and the current anchor, is in the vault's `claims` map and not expired. Retract, re-anchor or expiry turn it false. `included` and `stateChecked` as on `verifyDocument`. For a diff row `threshold` holds `k`. Rate class `read`.

## Crawler-free state verification

Both functions read live contract state from the indexer. They need no crawler, transaction hash or server row. Absent state or no live provider is `verified: false`, not a 5xx. `network` reads another configured network (`cds.requires.nightgate.networks.<network>`), unknown is 400.

**Public lane.** With `NIGHTGATE_PUBLIC_VERIFY=true` both functions answer without credentials under `/odata/v4/midnight-verify`, with the same signatures and CORS `*`. Off, they answer 404 `PUBLIC_VERIFY_DISABLED`. Rate class `public-verify`. Every call needs contract, payload and claim coordinates, so nothing is enumerable.

Everything checked here is recomputable from public data: the claim key is a `persistentHash` over the tagged claim struct, with `recordKey = persistentHash({ tag 21, attesterId, payloadHash })` and root and schema id from `content_anchors`. The Compact source ships in `@odatano/contract-attestation-vault`.

### `verifyAttestationState(contractAddress, attesterId?, payloadHash?, documentId?, contentRoot?, schemaId?, compiledArtifactRef?, network?) → { verified, attested, contentRootOk, schemaOk, bindingRegistered, attesterId, payloadHash, recordKey, documentId }` (function)

Checks the attester's record of `payloadHash` and, when given, its content root and schema id. A bound `documentId` replaces `attesterId` and `payloadHash`, and the answer names the attester. An anchor is the attester's own statement, so check `attesterId` against identities you trust. An unregistered document id is first come, first served. `bindingRegistered: true` says the registrar assigned the id to this attester.

### `verifyPredicateState(contractAddress, attesterId, payloadHash, fieldKey?, predicate, threshold?, expectedDigest?, setRoot?, payloadHashB?, attesterIdB?, allowedMask?, k?, compiledArtifactRef?, network?) → { verified, proven }` (function)

Recomputes the claim key from the given coordinates and checks `claims` for an unexpired entry. The inputs must be exactly those of the proof, including the A and B order. The key embeds the record's current anchor, so a claim under a former anchor verifies false. Anyone holding the opening may prove the same claim again and extend its expiry. The attester withdraws claims by retracting the record.

## Disclosure grants

The vault's on-chain disclosure list and document id registry. `level` is 0 public, 1 legitimate interest, 2 authority. Only the entitlement is on chain; delivering the matching text stays with the consumer.

### `grantDisclosure(payloadHash, grantee, level, sessionId, contractAddress, compiledArtifactRef?, idempotencyKey?, sponsorSessionId?) → { jobId, status, disclosureGrantId }`

Grants `grantee` a level on the session's own record. The `DisclosureGrants` row is written inactive and turns active once the chain confirms. Job result `{ disclosureGrantId, payloadHash, grantee, level, txHash }`. Rate class `prove`.

### `revokeDisclosure(payloadHash, grantee, sessionId, contractAddress, compiledArtifactRef?, idempotencyKey?, sponsorSessionId?) → { jobId, status }`

Removes the grantee's entry. Attester only. Job result `{ payloadHash, grantee, txHash }`. Rate class `prove`.

### `reindexDisclosures(contractAddress, compiledArtifactRef?) → { contractAddress, active, deactivated, reconciledAt }`

Updates `DisclosureGrants` from live state, for example after a grant submitted outside this server. Without a live provider `active` is zero. Rate class `compute`, per contract.

### `registerPassport(documentId, passportId?, ownerId, mode?, sessionId, contractAddress, compiledArtifactRef?, idempotencyKey?, sponsorSessionId?) → { jobId, status }`

Manages the document id registry. `passportId` is an alias of `documentId`.

| `mode` | Caller | Effect |
|---|---|---|
| 0 (default) | registrar | assigns `documentId` to `ownerId`, releasing another attester's binding |
| 1 | registrar | removes the assignment |
| 2 | registrar | hands the registrar role to `ownerId` |
| 3 | recovery identity | sets `ownerId` as the new registrar |
| 4 | recovery identity | hands the recovery role to `ownerId` |

Job result `{ documentId, ownerId, mode, contractAddress, txHash }`. Rate class `prove`.

### `retractAttestation(payloadHash, sessionId, contractAddress, compiledArtifactRef?, idempotencyKey?, sponsorSessionId?) → { jobId, status }`

Removes the caller's record: attestation, content anchor, disclosure grants and document binding. Claims on its root stop verifying. The payload may be attested again. Job result `{ mode, key, contractAddress, txHash }`. Rate class `prove`.

### `purgeExpired(kind, key, sessionId, contractAddress, compiledArtifactRef?, idempotencyKey?, sponsorSessionId?) → { jobId, status }`

Removes an expired claim (`kind: 'claim'`, `key` the claim key). Any session may call it. The vault refuses an entry that has not expired. Rate class `prove`.

### `registerGranteeIdentity(bindingInput, scope?) → { ID, granteeId, bindingKind }`

Links the caller to the grantee id that grants name. `granteeBinding` (default `wallet`) sets the input: a coin public key, a DID for `did`, or the 64-hex id for `custom`. `scope` narrows the link to one contract or attestation. Idempotent per user and scope. Proving ownership of the input is the consumer's policy.

## Disclosure to token holders

A document's text bound to a shielded token type. Whoever holds a token of the type reads it, without the issuer learning who. A holder registers on the `holder-registry` contract (`@odatano/contract-holder-registry`) with `registerHolder(coin, claim_key)`, which passes one coin through the contract and back. The claim key is `holderClaimKey(secret)` from `@odatano/nightgate-tx`. The call is sponsorable like any other.

### `grantDisclosureToHolders(payloadHash, tokenType, registryAddress, content?, contentType?, expiresAt?) → { holderGrantId, payloadHash, tokenType, registryAddress, hasContent, expiresAt, status }`

Binds `payloadHash` to `tokenType`. `content` (up to 1 MiB) must hash to `payloadHash`, by blake2b-256 or sha256 of the UTF-8 text, and is stored encrypted. `expiresAt` is at most a year ahead. The same grantor, payload, type and registry again updates the grant (`status: "updated"`). Grantable. Rate class `compute`.

### `revokeHolderDisclosure(holderGrantId) → { holderGrantId, status }`

Grantor only. Rate class `compute`.

### `claimDisclosure(payloadHash, tokenType, claimSecret) → { entitled, reason, payloadHash, tokenType, registryAddress, holderGrantId, contentType, contentHashKind, content, expiresAt, registries }`

Computes the claim key from `claimSecret`, reads the registry live and returns the stored text, or `entitled: false` with a `reason` and the `registries` checked. 503 without a live indexer. Every token may call it. Rate class `compute`.

## Diagnostics

### `getWalletBalance(sessionId) → { shieldedNight, unshieldedNight, shieldedTokens, dustBalance, registeredNightUtxoCount, totalNightUtxoCount, dustUtxoCount, dustPendingCount, dustPendingValue, dustRestoreCount }` (function)

Amounts are atom strings. `shieldedTokens` lists other shielded types as `{ tokenType, amount }`. `dustPendingCount` and `dustPendingValue` are spends in flight. `dustRestoreCount` counts dust state restores after a rejected submission. Registered UTXOs with no dust notes and no pending spends while fees fail point to a stuck dust state, see the operations guide. A wallet that does not reach the tip within `NIGHTGATE_WALLET_READ_SYNC_TIMEOUT_MS` (default 10 s) answers 503 `WALLET_SYNCING`. Rate class `read`.

### `getWalletSyncProgress(sessionId) → { known, caughtUp, appliedIndex, streamTip, behindEvents, eventsPerSecond, etaSeconds, blockHeight, isConnected, indexerFresh, indexerTipAgeSeconds, indexerError, elapsedMs, phase, updatedAt, lastProgressAt, staleSeconds, stale, jobId, jobStatus, restoredFromSnapshot, snapshotSavedAt, facadeBuildStartedAt, facadeBuiltAt }` (function)

Catch-up progress from a snapshot the worker pushes about every 15 s.

- `appliedIndex`, `streamTip` and `behindEvents` count dust ledger events, not blocks. `known: false` means nothing reported yet.
- Stuck: `appliedIndex` stays while `elapsedMs` grows, or `isConnected` is false. `indexerFresh: false`: the indexer lags beyond `NIGHTGATE_SYNC_FRESHNESS_MS` or its tip could not be read (`indexerError`).
- `stale` past `NIGHTGATE_SYNC_PROGRESS_STALE_S` means nobody is syncing. `jobId` is the latest prewarm job. A prewarm fails after `NIGHTGATE_PREWARM_STALL_MS` (default 10 min) without progress.
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

`getLiveness`, `getReadiness`, `getMetrics`, `getSyncStatus`, `getHealth`, `getBoardStatus` and `getReceiptKey` are anonymous. `getRuntimeInfo`, `getWorkerStatus` and `getReorgHistory` need a user. Crawler control needs admin.

### `getLiveness() → { status, timestamp, uptime, instanceId }`

200 while the process runs. Does not touch the database.

### `getReadiness() → { ready, phase, crawlerEnabled, checks: { database, crawler, node, runtime, initialization }, initializationMode, instanceId, runtimeMode, replicaCount, databaseKind, runtimeWarnings }`

503 when not ready. `phase` is `starting`, `warming`, `catching-up`, `ready`, `degraded` or `failed`. While `warming` the sponsor pool prewarms and the process counts as ready. A disabled crawler passes `crawler` and `node`. `initializationMode: 'offline'` means a refused schema preflight or a failed start. A failing check adds a reason to `runtimeWarnings`.

### `getHealth() → { status, chainHeight, indexedHeight, finalizedHeight, lag, finalizedLag, blocksPerSecond, syncStatus, instanceId, runtimeMode, replicaCount, databaseKind, topologyValid, runtimeWarnings }`

The crawler's view. `status` is `unhealthy` when an enabled crawler stopped or lags more than 100 blocks, `degraded` above 10 blocks or after five minutes without a block, else `healthy`.

### `getSyncStatus() → SyncState`

The persisted crawler state.

### `getMetrics() → String`

Prometheus text, prefix `odatano_nightgate_`: heights, lag, throughput, errors, sync status (stopped 0, syncing 1, synced 2, error 3), runtime topology, jobs and wallet worker. Over OData the text arrives as `{"value":"..."}`; unwrap it for a Prometheus parser.

### `getBoardStatus() → { openOffers, offersFilledToday, swapsToday, sponsorsConfigured, sponsorsReady, factoryContract, version, asOf }`

Counts for a market page, recomputed at most every 10 s. Days are UTC. `sponsorsReady` counts sponsors at tip with a spendable note. Rate class `read`.

### `getReceiptKey() → { publicKey, algorithm }`

The Ed25519 key that signs [receipts](#receipts). Rate class `read`.

### `getRuntimeInfo() → { version, apiVersion, network, provingMode, instanceId, runtimeMode, databaseKind, uptime, node, contracts }`

`node` is `{ version, specName, specVersion, transactionVersion, ledgerVersion, peers, isSyncing, errors }` of the node the crawler reads, null while no crawler runs. A node call that fails leaves its field null and is named in `errors`. `contracts` lists `{ name, artifactDigest, currentDigest, digestStale, digestError, package, version, slotWidth, privateStateId }`. `artifactDigest` is the loaded build that jobs are pinned to, `currentDigest` the files now. `digestStale: true` means the files changed under the running server, and write jobs fail until a restart. Rate class `read`.

### `getWorkerStatus() → { started, running, inFlightRpcs, exitCount, rotationCount, lastExitCode, lastExitAt, rpcTimeoutMs, facadeCount, facades }`

Health of the wallet worker thread. A climbing `exitCount` means a crash loop, a growing `inFlightRpcs` a stall. `facades` is admin only.

### `getReorgHistory(limit?) → ReorgLog[]`

The last `limit` reorgs (default 10, at most 100).

### `pauseCrawler()`, `resumeCrawler() → { status, running, message }`

`resumeCrawler` starts the crawler whatever `NIGHTGATE_CRAWLER_ENABLED` says and retries a block latched as unindexable. Neither survives a restart.

### `reindexFromHeight(height) → { status, message, requestedHeight, effectiveStartHeight, blocksRolledBack, transactionsRolledBack, crawlerResumed }`

Rolls back indexed data from `height` up and indexes it again. `NightBalances` are recomputed, and job outcomes confirmed at or above the height return to a pending chain status. The rollback removes 2000 blocks per committed transaction, from the tip down. When it outlasts `NIGHTGATE_REINDEX_REPLY_WAIT_MS` (20 s) the answer is `status: running` and the rollback finishes in the background. A crawler that ran before is then resumed at the end. While a reindex runs, `pauseCrawler`, `resumeCrawler` and a second `reindexFromHeight` answer 409.

`SyncState.reindexTargetHeight` holds the target until the last slice committed. A failed slice sets `syncStatus` to `error` with `lastError` and leaves the crawler stopped. A restart or `resumeCrawler` finishes the open rollback first, then starts the crawler. A new `reindexFromHeight` above an open target removes down to that target.

## Analytics

`getBlockCount()`, `getTransactionCount()`, `getContractCount()` and `getAverageTransactionsPerBlock()` aggregate the indexed entities. `getContractCount` counts distinct contract addresses. Entities: `BlockStatistics` (one row per block with `transactionCount`, page size 100, at most 1000) and `ContractStatistics` (actions per `actionType`).

## Admin

Read-only entities: `WalletSessions`, `DisclosureRoles`, `BackgroundJobs` (without `command`, `request` and `result`, a database view that needs `cds deploy` or `nightgate-schema-delta`), `LearnedTokenTypes`, and `SwapOffers` with poster and nullifiers.

- `invalidateSession(sessionId)`, `invalidateAllSessions()`: force-close any session.
- `exportContractSigningKey(sessionId, contractAddress, password) → { format, encryptedPayload, salt, contractAddress, accountId }`: the contract's maintenance key, sealed under `password` (at least 16 characters). No action restores it. `CapDbPrivateStateProvider.importSigningKeys` reads it back in code. Whoever holds it can replace the contract's verifier keys.
- `registerContract(name, artifactPath, zkConfigPath, privateStateId, slotWidth?) → { name, source, artifactPath, zkConfigPath, privateStateId, slotWidth, artifactDigest, hasProverKeys }`: registers an artifact without a restart. Paths must lie in `NIGHTGATE_CONTRACTS_DIR`. The module is validated before anything changes, saved in `ContractRegistrations` and reloaded at boot. A config name is 409. A new build under a name is a new generation, and jobs of the old one refuse. `hasProverKeys: false` allows deploy and verify only.
- `unregisterContract(name) → { removed }`: config names are 409.
- `listContracts() → [{ name, source, artifactPath, zkConfigPath, privateStateId, slotWidth, artifactDigest, hasProverKeys }]`: `source` is `config` or `runtime`.
- `getJobStats(windowHours?) → { windowHours, since, total, byStatus, topErrors, oldestQueuedSeconds }`: default 24 hours, at most 720.
- `getSponsorPolicy(grantId?) → { source, path, loadedAt, ignoredEnv, floor, floorError, grant, effective, effectiveError }`: the platform policy and, with `grantId`, what the grant may use. 404 for an unknown grant.
- `reconcileNightBalances(address?, after?, limit?) → { checked, next, drifted }`: `NightBalances` rows that differ from the indexed UTXOs. Writes nothing. `limit` at most 500. `field: 'row'` is a missing row.
- `redecodeFromHeight(height) → { fromHeight, previousDecodedHeight, blocks, changed }`: lowers the payload decode cursor so the decode pass rewrites the decoded fields from `height` up. `changed` is false when the cursor already stood below.
- `profileWorker(seconds?, dir?, thread?) → { thread, seconds, file, ... }`: CPU profile of the `worker` (default) or `main` thread for 1 to 120 s (default 20). The `.cpuprofile` goes to `nightgate-profiles/` in the OS temp folder or its subfolder `dir`.
- `grantRole(userId, role, scope?, validUntil?)`: grants an off-chain disclosure tier (`public_only`, `legitimate_interest`, `authority`). The caller needs `authority`.
- `revokeRole(userId, role, scope?) → Integer`: ends matching active grants now and returns how many. No `scope` matches only unscoped grants.

`attachDisclosureRole(req, db, { contractAddress, payloadHash?, attesterId? })` is the middleware that resolves a tier. With `contractAddress` it reads the on-chain `DisclosureGrants` for the caller's grantee id. Without it the `grantRole` table applies.

## Chain entities

Every `@readonly` entity supports the OData V4 query options.

```bash
curl "http://localhost:4004/odata/v4/midnight/Blocks?\$top=10&\$orderby=height desc"
```

Bound read functions, for example `Transactions/byHash(hash='0x…')`. A list function takes `limit` (1 to 5000) and `skip`. A full page means more rows exist.

| Function | Order | Default `limit` |
|---|---|---|
| `Blocks/latest()`, `Blocks/byHeight(height)` | one block | - |
| `Blocks/range(startHeight, endHeight, limit, skip)` | height ascending | 100 |
| `Transactions/byHash(hash, limit, skip)` | newest first | 100 |
| `Transactions/byType(txType, limit, skip)` | newest first | 100 |
| `Transactions/byIdentifier(identifier)` | one inclusion, 404 until indexed | - |
| `Transactions/ledgerTransaction(hash)` | the ledger transaction as base64, 404 until indexed | - |
| `ContractActions/byAddress(address, limit, skip)` | oldest first | 100 |
| `ContractActions/history(address, limit, skip)` | newest first | 100 |
| `ContractStates/stateAt(address, height?)` | one snapshot | - |
| `UnshieldedUtxos/byOwner(owner, limit, skip)` | newest first | 1000 |
| `UnshieldedUtxos/unspent(limit, skip)` | newest first | 1000 |
| `NightBalances/getBalance(address)` | one balance | - |
| `NightBalances/getTopHolders(limit, skip)` | highest first | 10 |

A hash can occur in more than one block, because the timestamp transaction repeats its hash.

`Transactions/byIdentifier` returns `{ identifier, hash, ledgerTxHash, blockHeight, blockHash, status, failedSegments }`. `status` is null until the indexer supplement has the result.

`ContractStates/stateAt` returns the state at `height`, default the newest, with `source` `history`, `current` or `indexer`. `blockHash` belongs to the state's block. `ledgerParameters` are those in effect at `height`, default the chain tip, because a contract at rest keeps its old state while the chain moves on. Both are null when unknown. 404 when no state is known. 503 while the crawler holds a newer action than the indexer; retry in a few seconds. 429 `indexer-budget` past the shared budget. 502 `BAD_GATEWAY` when the indexer fails, with the cause in the message and URLs removed.

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

`stateAt` keeps its 502 and 503 messages too. Every other 5xx keeps its `code` and withholds the message.

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

Job codes (`classifySubmissionError`):

| Code | Retryable | Trigger |
|---|---|---|
| `TxFailed` | no | on-chain status other than `SucceedEntirely` |
| `1014` | no | invalid transaction |
| `1016` | yes on test networks, no on mainnet | immediately dropped |
| `NetworkOrTimeout` | yes | `transport`. With `wallet-not-synced` nothing was built and a sponsored job moves to the next sponsor. With `not-sent` nothing is on chain and the attempt is closed `REJECTED` |
| `SubmitAmbiguous` | no | `ambiguous`; the job parks as `BROADCAST_UNCONFIRMED`, see [async job model](#async-job-model-write-actions) |
| `PoolInvalid` | yes | pool status Invalid without a ledger code; one rebuild on sponsored paths |
| `SubmitIntentRejected` | no | the identifier could not be persisted, nothing broadcast |
| `SubmitIntentTimeout` | no | identifier not recorded within `NIGHTGATE_SUBMIT_INTENT_ACK_TIMEOUT_MS`, nothing broadcast |
| `SponsorPolicyRefused` | no | `policy` |
| `BatchCausalityViolation` | no | `causality`; `calls` with name, segment and stages |
| `BatchGasBudgetExceeded` | no | `gas-budget`; split the batch |
| `ContractTypeError`, `IncompleteCallTxPrivateStateConfig`, `IncompleteFindContractPrivateStateConfig` | no | SDK contract configuration errors |
| `WalletSigningNotAvailable` | no | the session has no seed |
| `CHILD_FAILED` | no | a workflow step failed; the message names the steps already on chain |
| `<error name>` | no | any other error, by its `name` |

Raw node or SDK errors:

- **`1010/103`**: a spent coin, or a zswap proof against a coin tree state the node no longer accepts. No fee, never rebuilt. A filled or aged swap half ends here.
- **`1010/170`, `1010/171`, `1010/196`** (dust race): the dust spend was built on an outdated dust state. No fee. Deploy, call and batch rebuild in the worker (`NIGHTGATE_DUST_RACE_RETRIES`, default 2), sponsored paths per `NIGHTGATE_SPONSOR_DUST_RETRIES`.
- **`failed assert: predicate false`**: a predicate circuit rejected the claim.
- **`Wallet.InsufficientFunds`**: not enough dust for the fee or NIGHT for the outputs.
- **`MalformedResult`**: the SDK returned without the expected fields.

For 503s caused by the indexer, see [operations.md](operations.md#troubleshooting).
