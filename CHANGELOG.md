# Changelog

## 0.29.0 - 2026-09-29

### Features

- `sponsorSwap(makerHalfB64, takerHalfB64, sponsorSessionId, idempotencyKey?)`: the
  sponsor pays the dust of a shielded swap handed over as two proven halves, bound or
  unbound, each as offer file (bech32m, `swapoffer1...`) or base64.
  Each half gives one token type and wants another, both in `allowedTokenTypes`; the
  halves mirror each other. Off by default: `NIGHTGATE_SPONSOR_ALLOW_SWAPS` / policy
  file `allowSwaps`, and `sponsorSwap` in a grant's `allowedActions`. Job result
  `{ txHash, swap: { gives, wants } }`. `NIGHTGATE_SPONSOR_SWAP_MAX_INPUTS` (4).
- `NIGHTGATE_SPONSOR_ALLOW_CONTRACT_MINTS` / policy file `allowContractMints` (default
  off): the sponsor pays the offer of a token a call of the same transaction mints,
  without an `allowedTokenTypes` entry. The contract has to be sponsorable, the
  offer creates at most the declared amount.
- A landed mint under a grant records the type (`AgentGrants.mintedTokenTypes`); it
  counts as listed for that grant while contract mints are sponsored.
- Admin `getSponsorPolicy(grantId?)`: platform policy, its source and load time,
  the grant's lists, the effective policy or the reason it is empty.
- `@odatano/nightgate-tx` 0.8.0 (txbuilder):
  - `createSwapWallet`: shielded-only wallet, `buildHalf`, `takeOffer`, `revert`,
    `serializeState` / `walletState`; coin selection within `maxInputs` (4),
    `coins()`, `spendable(tokenType)`.
  - `encodeOffer`, `decodeOffer`, `readSwapTerms`, `sameSwapTerms`.
  - `createTxBuilder`: `walletSync: 'shielded'`, `walletState`, `waitForSync()`,
    `serializeWalletState()`, `shieldedKeys`.
  - `buildSponsorable` / `buildDeploySponsorable`: `recipients` for coins created
    for another wallet.
  - `deriveIdentity` returns `addresses.shielded` and `shieldedKeys`; `deriveRoleSeeds`.
  - Client `ng.sponsorSwap(...)`.

### Fixes

- `createAgentGrant` / `updateAgentGrant` answer 400 for contract or circuit lists
  that share nothing with the platform's and for a token type the platform does not
  list (were accepted, the grant then failed at its next sponsored call).
- Grant token types that share nothing with the platform's sponsor no offer; the
  grant's calls without an offer keep working (was `403 SPONSOR_POLICY_EMPTY` on
  every sponsored call).
- A WARN names the sponsor env settings a policy file replaces.
- `Transactions.txType` of a transaction without contract action or unshielded
  movement is `shielded_transfer` or `dust_registration` once decoded
  (`crawler.decodePayloads`; was `contract_call`).

### Schema

- `AgentGrants.mintedTokenTypes`; additive, probed at startup (`nightgate-schema-delta`).

### Dependencies

- `@scure/base` ^2.2.0 (bech32m), already in the tree through the wallet SDK.

## 0.28.2 - 2026-09-29

### Fixes

- `Transactions.isShielded` and `hasProof` come from the decoded ledger payload
  (`crawler.decodePayloads`): zswap inputs, outputs or transients; a contract
  call or zswap proof. Both are `null` until a row is decoded (were always `false`).
- `Transactions.proofHash` is no longer set (was the extrinsic hash).
- `palletMap` `isShielded` applies only until the payload is decoded.

### Schema

- `Transactions.isShielded` / `hasProof` lose their `false` default; no migration.

## 0.28.1 - 2026-09-28

### Features

- Admin `revokeRole(userId, role, scope?)`: ends active disclosure-role grants
  (`validUntil` = now, rows kept), returns the number ended; caller needs `authority`.

### Fixes

- `grantRole` rejects a `validUntil` that is not a timestamp or not in the future (400).
- `verifyDocument` returns `originalSha256` only when the provided hash matches, else `''`.
- A worker RPC waits at most `NIGHTGATE_SUBMIT_INTENT_ACK_TIMEOUT_MS` for pending
  submit-intent hooks before it answers the caller.

## 0.28.0 - 2026-09-27

### Breaking

- `error.code` of a reject that names only a status is a string: `INVALID_ARGUMENT`,
  `NOT_FOUND`, ... instead of `"400"`; in-process callers (`srv.send`) read the
  number from `status`. HTTP statuses are unchanged.

### Features

- One error registry (`docs/reference.md#http-error-codes`, `npm run errors:table`);
  error classes carry their code, also across the wallet-worker boundary. A 5xx
  keeps its code in production; its body is reduced to code and message.
- `getJobStatus.chainSegments` for confirmed batches: `[{ segment, calls, applied }]`.
- Admin `reconcileNightBalances(address?, after?, limit?)`: drift report, no writes.
- One process per database runs jobs, restart recovery and crawler (`InstanceLeases`,
  `NIGHTGATE_INSTANCE_LEASE_TTL_MS`, 90 s). A process whose lease was taken over
  dispatches no job, refuses write actions and broadcasts, and reports offline.
- A timed-out worker RPC is cancelled at the worker's next wait point (sync,
  backing, before proving); never after the submit intent.
- `@odatano/nightgate-tx` 0.7.0: `isRetryable(err)`, `RETRYABLE_ERROR_CODES`.

### Fixes

- A wallet not at the tip before the build fails retryable (`NetworkOrTimeout`,
  `wallet-not-synced`) and a sponsored job fails over (was `SubmitAmbiguous`).
- A job refused by a revoked grant or the sponsor policy fails with
  `AGENT_GRANT_REVOKED` / `SPONSOR_POLICY_UNAVAILABLE` / `SPONSOR_POLICY_EMPTY`
  (was `Error`).
- Missing prover keys answer 503 `PROVER_KEYS_UNAVAILABLE` (was a 500).
- `BlockStatistics` counts per returned row; default page 100, max 1000.
- The crawler's error counter increments in the statement; spent UTXOs are
  looked up once per block.

### Schema

- `BackgroundJobs.chainSegments`, new entity `InstanceLeases`; additive, probed at startup.

## 0.27.2 - 2026-09-27

### Fixes

- A sponsor held back by the indexer freshness check says why: `indexer
  unreachable (HTTP 403)` (or `timeout`) when the tip read failed, `indexer's
  newest block is Ns old` when it lags. A failed read used to be reported as
  `indexer not fresh` like a lagging indexer; an answer from the indexer's edge
  that is not JSON is recognised as a refusal.
- `getWalletSyncProgress` gains `indexerTipAgeSeconds` and `indexerError`; the
  worker's idle-sync log line carries `indexerError`.
- Disconnecting a session no longer evicts the wallet's facade while another
  user's session that holds the signing key uses it; another user's
  viewing-only session still never keeps the keys in memory.
- A worker RPC whose message cannot be posted settles at once instead of
  holding its entry until the timeout.
- Node notifications buffered for subscription ids that are never registered
  are capped (16 per id, 32 ids) and dropped on unsubscribe.
- The SCALE parser skips 65 bytes for an ECDSA extrinsic signature (was 64,
  which misread the rest of such an extrinsic).
- A fork search deeper than 100 blocks throws instead of returning an
  unverified height; nothing is rolled back and the next head retries.
- `CapDbPrivateStateProvider.clear()` removes the current contract's private
  states only, like `get`/`set`/`remove` and the SDK's own provider (it
  removed every contract's states of the account).
- `grantDisclosure` replayed under its idempotency key restores the
  `pendingLevel` it found; the replay starts no job, so nothing cleared it.
- An `idempotencyKey` over 128 characters is refused with 400
  `IDEMPOTENCY_KEY_INVALID` (was a database error, 500 on PostgreSQL).
- `attestAgentOutput` records its `anchorDocument` job under the caller's agent
  grant (revocation and per-grant usage cover it).
- A worker exit counts as a rotation only for the worker that announced it; a
  stopped worker's announcement no longer hides the next worker's crash.
- The worker's deploy-query cache is bounded (256 entries).
- `NIGHTGATE_JOB_LEASE_TTL_MS` is at least 60 s (twice the heartbeat); a
  shorter lease reclaimed running jobs.
- `profileWorker` writes only inside `nightgate-profiles/` in the OS temp dir;
  `dir` names a folder there, a path outside it is a 400.
- Reconciliation lookups that fail log at debug level instead of silently.

## 0.27.1 - 2026-09-27

### Fixes

- Tests: the predicate handler tests compare each proof argument exactly; a
  time-derived argument containing the field value's digits failed them.

## 0.27.0 - 2026-09-27

### Breaking

- The indexer supplement no longer stores the full contract state on every
  `ContractActions` row. Each action gets `stateHash`/`zswapStateHash`
  (sha256) and `stateSize`/`zswapStateSize`; the full state stays only under
  `crawler.contractStateHistory` `watched` (addresses in
  `crawler.contractStateWatch`) or `all`
  (`NIGHTGATE_CRAWLER_CONTRACT_STATE_HISTORY`, `_WATCH`). Default `none`.

### Features

- `ContractStates`: the newest state per contract, written by the supplement
  (a higher block wins, the same block replaces); a rollback drops the rows at
  or above the fork height.
- `ContractStates/stateAt(address, height)`: the state after the contract's
  newest action at or below `height`, from `ContractStates`, a kept per-action
  state, or the indexer (supplement URL, then `NIGHTGATE_INDEXER_HTTP_URL`),
  with `source` and `verified` (indexer bytes against the stored hash).
  Above the crawler's indexed tip, or when the newest action at that height
  has no hash yet, `verified` is null. Indexer reads are capped at 2 per
  second across callers (429 + `Retry-After`).
- `nightgate-compact-contract-state` (`scripts/compact-contract-state.mjs`,
  `--dry-run`, `--batch`): moves stored per-action states to the new layout,
  honours the history setting, idempotent.

### Fixes

- The payload decoder marks `SYSTEM` transactions `absent` instead of trying to
  deserialize them as a ledger `Transaction`, which failed on every one and
  logged a warning each.

### Schema

- New columns on `ContractActions`, new entity `ContractStates`; additive
  (`cds deploy` on PostgreSQL, `nightgate-schema-delta` on SQLite). The startup
  preflight probes both.

## 0.26.0 - 2026-09-26

### Breaking

- A v1/v2 ciphertext in a column bound to a purpose and a row (wallet session
  keys, account keys, job commands) is refused (`UnboundEnvelopeError`); run
  `nightgate-rewrap-keys` before the upgrade, or set
  `NIGHTGATE_ACCEPT_UNBOUND_ENVELOPES=true` until it ran. The tool itself
  still reads them.
- `auth.kind: dummy` refuses to start in production unless
  `NIGHTGATE_ALLOW_UNAUTHENTICATED=true`.
- Image: the basic-auth user carries no role unless `NIGHTGATE_HTTP_ROLES`
  names one (was `admin`); set `NIGHTGATE_HTTP_ROLES=admin` for the admin
  service.
- Compose publishes port 4004 on `127.0.0.1` only
  (`NIGHTGATE_BIND_ADDRESS=0.0.0.0` restores the old binding).
- `AttestationService` tiers (`Public`, `Disclosed`, `Authority`) require an
  authenticated user, also in a host projection without the tier handlers.

### Fixes and hardening

- Concurrent resolutions of one account key each get their own buffer
  (`resolveAccountDek`); a caller that zeroes its copy after use no longer
  zeroes the key of the others.
- Contract deploys, calls and batches read private states still under a legacy
  password: the worker-routed provider gets `privateStoragePasswordFallbacks`.
- `invalidateSession` / `invalidateAllSessions` deactivate the session first
  and evict the facade under the facade build lock, so a build in flight cannot
  put the keys back.
- The crawler never stores a block with extrinsics whose `System.Events` are
  empty or undecodable: empty is a transient error (retried), undecodable a
  permanent one (the block latches). Such a block used to be stored without its
  UTXO rows and balance deltas.
- A crawl pass that fails on a transient error records `lastError` and runs
  again after 30 s; finalized head and header reads go through the retry. A
  permanent failure sets `syncStatus` to `error`, and `resumeCrawler` restarts
  a crawler that stopped that way (it used to answer "already running").
- Ledger error `171` (OutOfDustValidityWindow, a lagging node) is a dust race:
  rebuilt and resubmitted like `170` and `196`.
- A workflow step that is on chain but whose record fails after lock-contention
  retries parks the workflow as `reconciliation_required` instead of failing
  it; the re-run reuses the landed step.
- An idempotency key reused with a different payload answers 409
  `IDEMPOTENCY_KEY_CONFLICT` (was a masked 500).
- `attestAgentOutput` retried under the same `idempotencyKey` without
  `producedAt` reuses the first call's `producedAt` (recorded in the anchor
  job's request), so the retry yields the same envelope and job instead of a
  409.
- Heavy job kinds share ONE concurrency cap (`jobs.concurrency.heavy`, 4)
  instead of 4 per kind; workflow parents have their own cap of the same size,
  so a parent never holds a slot its children need.
- A wallet build that outlives the worker RPC timeout is joined by the next
  `init` instead of started twice; an evict during the build zeroes the
  finished keys instead of registering them.
- The node connection pings every 30 s; a socket without an
  answer for one interval is closed and reconnected.
- Rollback and `reindexFromHeight` query and delete in chunks of 5000 ids
  (PostgreSQL caps a statement at 65535 parameters).
- Indexes: `UnshieldedUtxos.createdAtTransaction_ID`; `Blocks.height` becomes
  unique (`ng_blocks_height_unique` replaces `ng_blocks_height`; with
  duplicate heights the old index stays and startup warns).
- SCALE compact decoding reads the four-byte mode unsigned.
- The node URL in the unreachable-node warning is logged without credentials.
- Version in `package.json`, lock and the compose default tag.

## 0.25.10 - 2026-09-26

- `NIGHTGATE_DUST_SNAPSHOT_COLLAPSE=true` saves the dust snapshot with every
  generation-tree leaf collapsed that does not back one of the wallet's own
  dust UTXOs (`night_indices`). The ledger re-expands foreign leaves on each
  dtime update and never collapses them again, so the snapshot and its restore
  (`DustLocalState.deserialize`, one synchronous wasm call) grew with the
  chain: 6 MB and 5 to 7 minutes on preprod, 7 KB and 4 s with the flag.
  Roots, balance and spends are unchanged. Default off.
- The collapsed state is restored once before it is saved and must give the
  same roots, balance and UTXO count; otherwise, and on any error in that path,
  the save keeps the SDK snapshot and logs the reason once
  (`srv/midnight/worker/dust-collapse.ts`).
- Snapshot state and `offset` come from one emitted wallet state, so a restore
  replays from the offset that matches the saved state.
- Version in `package.json`, lock and the compose default tag.

## 0.25.9 - 2026-09-26

- `getSponsorPoolStatus` keeps showing a sponsor while the wallet worker does
  not answer (e.g. while it restores another wallet's dust snapshot, a single
  synchronous call of several minutes): the row carries the last dust figures
  the worker pushed, `stale: true` and `asOf`, `usable: false`,
  `unshieldedNight: null`, `lastError` with the reason. It used to read
  `dustNotes: 0` for every sponsor. A live read answers `stale: false` with
  the read time as `asOf`.
- The worker attaches `dust` figures (balance, free and pending notes,
  restore count, NIGHT UTXO counts, `at`) to the sync snapshot it pushes when
  a facade reaches the tip and on every progress-watch tick
  (`dustFiguresOf`); a push without them keeps the previous ones.
- Two additive fields on the `getSponsorPoolStatus` return type; no schema
  change, no migration, no config change.
- Version in `package.json`, lock and the compose default tag.

## 0.25.8 - 2026-09-25

- A parked job whose kind has a reconciliation finalizer and whose command is
  stored encrypted (`aes-gcm-v1`) resolves again: the finalizer decrypted the
  command without its job binding (`jobCommandBinding`), the decrypt threw and
  the job stayed `reconciliation_required` although the indexer had its
  outcome. Affects `sponsorUnboundTransaction`, `sponsorFinalizedTransaction`,
  `submitContractCallBatch`, `anchorDocument`, `grantDisclosure`,
  `revokeDisclosure`, `registerPassport`, `retract` and
  `fieldPredicateBatchProof` since 0.23.4. Parked jobs resolve on the next
  confirm pass after the upgrade.
- Version in `package.json`, lock and the compose default tag.

## 0.25.7 - 2026-09-25

- `NIGHTGATE_INDEXES` (`srv/utils/db-indexes.ts`) gains five indexes the
  indexer supplement updates and deletes through: `TransactionFees.transaction_ID`,
  `TransactionSegments.transactionResult_ID`, `ContractBalances.contractAction_ID`,
  `ZswapLedgerEvents.transaction_ID`, `DustLedgerEvents.transaction_ID`.
- Four for newest-first reads: `Blocks.createdAt`, `Transactions.createdAt`,
  `ContractActions.createdAt`, `Transactions(txType, createdAt)`; DESC, on
  PostgreSQL `DESC NULLS LAST` to match the ORDER BY of the nullable column
  (`IndexSpec.postgres`, `indexStatement(spec, kind)`). Serves
  `$orderby=createdAt desc`, `byType` and `history`.
- Created at start with IF NOT EXISTS. On a large live PostgreSQL create all
  nine once with `CREATE INDEX CONCURRENTLY` first; the start is then a no-op.
- `network: mainnet` defaults to the public mainnet endpoints:
  `wss://rpc.mainnet.midnight.network/` (`DEFAULT_NODE_URLS.mainnet`, before: the
  preprod relay) and `indexer.mainnet.midnight.network` (before:
  `indexer.midnight.network`, which does not answer).
- Version in `package.json`, lock and the compose default tag.

## 0.25.6 - 2026-09-24

- The indexer supplement pass is paced: `crawler.supplementBlocksPerSecond` /
  `NIGHTGATE_CRAWLER_SUPPLEMENT_MAX_BPS` (default 2) spaces its requests per
  block; the batch of 25 per second used to go out at once. The public
  indexers block the whole host IP with a 403 from their load balancer at
  roughly 15 per second, and that block also hit the sponsor facades'
  WebSocket on the hosted box (2026-09-24, after ~1200 blocks).
- On a 403 or 429 the pass backs off for one minute, doubling up to fifteen,
  instead of retrying every four seconds and keeping the block alive
  (`IndexerHttpError` with the status, `isIndexerRateLimit()` in
  `srv/crawler/indexer-supplement.ts`); a pass that gets through resets it.
- The pass can read its own indexer: `crawler.indexerUrl` /
  `NIGHTGATE_CRAWLER_INDEXER_URL` (default: the submission side's
  `NIGHTGATE_INDEXER_HTTP_URL`). A private indexer keeps the backfill off the
  public one; the start log names the host and the rate.
- `stop()` wakes a pass that is backing off and ends a pass in flight after
  the block it is on (cursor recorded); `pauseCrawler` and the shutdown no
  longer wait a backoff out.
- Tests: the 500 ms slots at two per second, the 60 s / 120 s / interval
  ladder across a 403, a 429 and a success, the client's status on a 403,
  the two env overrides, stop during a backoff and during a pass.
- Version in `package.json`, lock and the compose default tag.

## 0.25.5 - 2026-09-24

- One catch-up at a time: `catchUp()` in `srv/crawler/Crawler.ts` joins a
  run in flight instead of starting a twin (`catchUpInFlight`). The
  pipeline's second pass and the live gap handler fired within milliseconds
  of each other once a long catch-up ended (two `Catch-up: 2684838 → 2684909`
  lines on the hosted box), both persisted the same blocks, and the loser's
  `duplicate key value violates unique constraint "midnight_blocks_hash"`
  latched as a poison block: `syncStatus = error`, readiness 503, watchdog
  restart, sponsor facades gone. Twice on 2026-09-24 (05:11 and 05:29 UTC),
  each time right after the catch-up the previous restart had caused.
- A block another writer landed meanwhile is already indexed, not a fault:
  `persistFromNode` returns the zero-count result when the unique violation
  names a block that exists (`isUniqueViolation()` in `srv/utils/retry.ts`:
  PostgreSQL, SQLite and HANA messages). A unique violation without the row
  still propagates and still latches.
- `docker/watchdog.sh`, two stages: when readiness reports only the crawler
  down (database, runtime, initialization fine) it cycles the crawler in
  place (`pauseCrawler` + `resumeCrawler` through the operator API inside the
  container) and restarts the container only if that has not helped three
  checks later; any other failing check restarts at once. `docs/docker.md`
  points at the script instead of carrying its own copy.
- `resolveSpecVersion`: a node answer that disagrees with the shared
  `LastRuntimeUpgrade` value stays with the block that asked (the one
  carrying the upgrade); a block that waited on that lookup asks for itself.
  Two batches fetched at once used to give the upgrade block's version to
  its predecessor.
- ORDER BY on PostgreSQL keeps the NULLS clause for a NOT NULL column
  reached through a join and for a column alias of one
  (`$orderby=parent/height`: the outer join yields NULL); only the query's
  own columns drop it (`stripNullsForNotNull` reads the query's `from` and
  `columns`).
- `docker/watchdog.sh` defaults to the compose file's container name
  `odatano-nightgate`; another name goes in the cron line as
  `NIGHTGATE_CONTAINER=<name>`, and a container `docker inspect` cannot find
  is logged instead of silently skipped.
- Tests: the join, a live head arriving as the subscription opens, the twin
  writer against the real unique index, the helper's messages, the parallel
  runtime lookup, ORDER BY through a join.
- Version in `package.json`, lock and the compose default tag.

## 0.25.4 - 2026-09-23

- ORDER BY on PostgreSQL no longer carries a NULLS clause for key and
  `not null` columns. `@cap-js/postgres` renders every ordering term as
  `ASC NULLS FIRST` / `DESC NULLS LAST` (SQLite's null order), the opposite
  of a Postgres btree index, so the planner sorted the whole table for any
  `ORDER BY … LIMIT` on such a column. CAP orders every `$top` read by the
  key: `Blocks?$top=1` was `ORDER BY "$b".ID ASC NULLS FIRST LIMIT 1`, a
  parallel seq scan and top-N sort over 2M rows, 0.8 to 7.6 s on the hosted
  box; `Blocks/latest()` (`height DESC NULLS LAST`) 0.9 s although
  `ng_blocks_height` exists; `ContractActions?$top=1` 0.9 s. With the
  clause gone the primary keys and the existing secondary indexes serve
  these reads (`srv/utils/pg-order-nulls.ts`, installed from `src/index.ts`
  before `ensureIndexes` when the db kind is postgres; rendered through the
  real driver in the unit test). No new index, no schema change.

## 0.25.3 - 2026-09-23

- Agent tokens may call the bound read functions of the indexer entities
  without an allowlist entry: `Blocks/latest`, `byHeight`, `range`,
  `Transactions/byHash`, `byType`, `ContractActions/byAddress`, `history`,
  `UnshieldedUtxos/byOwner`, `unspent`, `NightBalances/getBalance`,
  `getTopHolders` (`AGENT_ALWAYS_ALLOWED_EVENTS`). They read the same public
  rows `READ` already admits, but a bound function arrives as its own event
  and the names were not grantable either, so an ODATANO ACCESS key got 403
  on `Blocks/latest()` although the gateway's reference offered the call.

## 0.25.2 - 2026-09-23

- The crawler no longer asks the node for the runtime version of every block.
  `state_getRuntimeVersion` at a historical hash makes a Substrate node load
  and compile that block's runtime unless it is one of the two it keeps
  instantiated (`--runtime-cache-size`); against the public preprod RPC that
  was 2 to 8 s per call for every block behind a runtime upgrade, eight of them
  in each batch frame, so the frame took 17 to 38 s against a 30 s timeout and
  the catch-up fell from 20 to 0.5 blocks/s at height 1,568,000 (the upgrade to
  spec 1000000) while every retry looked transient. The batch frame now reads
  `System.LastRuntimeUpgrade` instead, a plain storage read at any height, and
  the node is asked for the version once per distinct value: an upgrade still
  applies from its first block, a million blocks under one runtime cost one
  call. The node remains the authority; the decoded value cross-checks it, and
  an answer that disagrees with the value (the block carrying an upgrade still
  reports the previous one) is used for that block only, never cached under the
  value. A block without that storage (pruned or racing node) is asked per block
  as before. Same for the on-demand path (`processBlockByHash`).
- A batch-frame timeout names the frame (`in a batch frame of N calls`), not
  only the first call in it: the old message blamed `chain_getBlock` for a
  frame that was waiting on something else.
- The `Timestamp.Now` storage key was wrong (its second half hashed to no
  pallet item), so the node answered null for every block and the block time
  came from the `Timestamp.set` inherent: one wasted read per block, and a
  dependency on the pallet map for a value the state holds directly. The key
  is now twox128("Timestamp") + twox128("Now"); the inherent stays the
  fallback for a pruned or racing node. Same value, same column.

## 0.25.1 - 2026-09-22

- `SyncState.syncProgress` reports the share of the CHAIN that is indexed
  (`lastIndexedHeight / chainHeight`), not the progress of the current
  catch-up run. A run starts wherever the cursor left off, so the old figure
  fell on every restart while the index kept growing: 36 % indexed read as
  5.7 %. The column now says which of the two it is, and a chain that is still
  at genesis reports 100 rather than null.
- A node transport fault no longer shuts the server down. CAP ends the process
  on any unhandled rejection, so a crawler talking to a slow or incomplete node
  could take the submission side with it, and every restart costs each sponsor
  facade its warm-up. Faults carrying the node transport's signature are logged
  and counted (`getMetrics()`, `absorbed_transport_faults`); everything else
  reaches `cds.shutdown`, the same end CAP would have brought about, after any
  listener that was already registered has seen it: an error reporter listens
  here too and ends nothing, so a captured listener is never taken for a
  shutdown. A fault
  qualifies only when the message reads like the node transport AND the stack
  comes from the crawler or its provider: a defect thrown inside the crawler,
  or a connection reset on the submission side, still ends the process. `NIGHTGATE_CRAWLER_FAULT_GUARD=false`
  restores the old behaviour.
- A prefetched block batch carries a rejection handler from the moment it is
  queued. It sits in the queue until the loop reaches it and can fail before
  anything awaits it; the queue's own `await` still reports the failure.

## 0.25.0 - 2026-09-21

- The crawler indexes unshielded UTXOs. `Midnight.UnshieldedTokens` in
  `System.Events` carries a transaction's consumed and produced outputs, and
  the crawler already fetched and decoded those records; `UnshieldedUtxos` and
  `NightBalances` now fill from them. The Bech32m owner and the DUST
  `initialNonce` are derived per row and match the Midnight indexer's values.
- `ContractActions` carry their `address` and record a maintenance update as
  `UPDATE`, one row per action the chain reported, so a transaction that only
  moved tokens no longer produces a spurious `CALL` row. These are the actions
  that APPLIED; a call in a failed segment is not among them.
- `Transactions` carry `ledgerTxHash`, `contractAddress`, and
  `senderAddress` / `receiverAddress` / `nightAmount` for an unambiguous
  one-to-one transfer. `txType` follows the reported events, so deploys,
  maintenance updates and plain transfers are told apart.
- `TransactionResults` record `PARTIAL_SUCCESS`, which the model had and
  nothing ever wrote.
- Two optional passes trail the indexed tip, both off by default.
  `crawler.decodePayloads` / `NIGHTGATE_CRAWLER_DECODE_PAYLOADS` decodes the
  stored ledger payload into circuit names, identifiers and the zswap and DUST
  counts, recording the outcome in `Transactions.payloadDecode`.
  `crawler.indexerSupplement` / `NIGHTGATE_CRAWLER_INDEXER_SUPPLEMENT` fills
  what a block does not carry from the Midnight indexer: `TransactionFees`,
  `TransactionSegments`, `ContractActions.state`, `ContractBalances`, both
  ledger-event streams and `registeredForDustGeneration`.
- Both passes keep a cursor on `SyncState` and read it with `reorgGeneration`
  in one query, advancing only when neither moved: a rollback to the cursor's
  own height leaves the cursor alone, so the generation is the signal that a
  pass's work is gone. Resetting a cursor replays the range.
- `NightBalances` counts NIGHT only; other tokens in the same UTXO set were
  being added to it.
- `Blocks.stateRoot` holds the substrate header's state root, which was being
  written into a column named `ledgerParameters`. That column now holds the
  ledger parameters, filled by the supplement and only when they change.
- **Schema delta.** `UnshieldedUtxos` is unique on `(intentHash, outputIndex)`:
  one transaction can carry several intents whose outputs both start at 0.
  New columns on `Transactions`, `ContractActions`, `Blocks` and `SyncState`.
  `npx nightgate-schema-delta` migrates SQLite. An index built before this
  release holds no UTXO rows; a full history needs a re-index.

## 0.24.5 - 2026-09-21

- The crawler can index next to the submission side. `crawler.startHeight` /
  `NIGHTGATE_CRAWLER_START_HEIGHT` begins at a chosen height instead of
  genesis: while the index is empty the block below it is indexed as the
  anchor, the one block allowed to have no parent, and catch-up starts above
  it. Once the index holds blocks the cursor decides, so a restart resumes
  where it stopped and a rollback that empties the table seeds again.
  `crawler.maxBlocksPerSecond` / `NIGHTGATE_CRAWLER_MAX_BPS` caps the
  catch-up rate; persist is the pacer and the fetch queue is bounded, so the
  cap bounds fetching too. Both are unset by default.
- A block that fails deterministically no longer runs on a loop. Catch-up
  ended with `syncStatus` at `error`, the live subscription overwrote it with
  `synced`, and every finalized head re-entered the same block about once per
  six seconds. The height is latched instead: `chainHeight` keeps following
  the chain, nothing is indexed, and the log and `lastError` name it.
  `pauseCrawler` + `resumeCrawler`, `reindexFromHeight` or a restart retries
  it. A transient failure, a node outage above all, is not latched.
- `getReadiness()` answers 503 when a check fails. It returned 200 with
  `ready: false` in the payload, which orchestrators and the container
  healthcheck read as healthy. A host that restarts unhealthy containers will
  now act on a process that is persistently not ready.

## 0.24.4 - 2026-09-19

- One status surface. The plain `/nightgate/metrics|health|ready` routes,
  `NIGHTGATE_STATUS_TOKEN`, `NIGHTGATE_STATUS_ROUTES`,
  `NIGHTGATE_STATUS_ROUTES_PREFIX` and the internal token the image
  entrypoint generated for its own healthcheck are removed. The read-only
  probes of the indexer service (`getLiveness`, `getReadiness`,
  `getMetrics`, `getSyncStatus`, `getHealth`) are anonymous at the model
  level since 0.24.3 and answer the same payloads through CAP; the container
  HEALTHCHECK now asks `getReadiness()`. `getMetrics()` keeps returning the
  Prometheus text inside the OData envelope. A scraper that used
  `/nightgate/metrics` reads `getMetrics()` and unwraps `value`.

## 0.24.3 - 2026-09-19

- Transport auth of the standalone image moves to `@odatano/cap-auth`
  (`cds.requires.auth.impl`, `kind: basic`, `realm: nightgate`). The
  package runs its basic lane (timing-safe compare, 20 failures per 15 min
  per client address and user, then 429 with `Retry-After`), then the
  registered lanes, then CAP's own strategy for `kind`; it sends no
  terminal 401 of its own. NIGHTGATE registers two lanes from the plugin
  (`srv/utils/transport-lanes.ts`): the agent token on `/api/v1/nightgate`
  (marker principal, the grant hook authenticates, also per `$batch` part)
  and the public verify lane under `NIGHTGATE_PUBLIC_VERIFY`. A request
  without credentials is CAP's: the anonymous indexer probes (getLiveness,
  getReadiness, getMetrics, getSyncStatus, getHealth) answer 200 through
  the model on the image now (0.24.2 opened them in the model; the image's
  middleware still refused them before CAP saw the request), everything
  `authenticated-user` gets CAP's `WWW-Authenticate` challenge. A wrong
  basic credential never reaches a lane. The model test pins a
  service-level `@requires` on every served service; the package's
  contract table runs against the booted services
  (`test/unit/transport-auth-contract.test.ts`).
  `srv/utils/agent-token-auth.ts` is gone. Consumer hosts are unaffected
  (the lanes only act under `@odatano/cap-auth`).

## 0.24.2 - 2026-09-19

- `NightgateIndexerService.getLiveness()` answered 401 without credentials
  under `NODE_ENV=production`. CAP authorizes the service before the
  operation, and a service without a service-level `@requires` is implicitly
  `authenticated-user` in production, so the function's own `any` was never
  reached (seen live behind ODATANO ACCESS: the gateway's credential-free
  probe had to fall back to operator auth). The service is now `@requires:
  'any'` with the requirement on every element. The read-only probes the
  model always meant for K8s and Prometheus (getLiveness, getReadiness,
  getMetrics, getSyncStatus, getHealth) are public now, as their test
  claimed; SyncState, ReorgLog, getReorgHistory, getRuntimeInfo and
  getWorkerStatus stay `authenticated-user`, pause/resume/reindex stay
  `admin`. Behind api.nightgate.dev the gateway still requires a key for
  `/api/v1/indexer/*`. A model test pins the layout
  (`test/unit/service-auth-annotations.test.ts`).
- `eslint` is pinned exactly (10.11.0). `@sap/cds-dk` bundles `@eslint/js`,
  whose `eslint` peer range npm re-resolves against the registry during
  `npm ci`; with a caret range every new eslint release made the lockfile
  look out of sync and failed CI.

## 0.24.1 - 2026-09-17

- Every submit goes out on its own phased node client (connect / request /
  watch budgets, indexer lookup on an ambiguous outcome). Bound submits
  (deploys, calls, batches, sends, dust registration, bound sponsoring) used
  the wallet SDK's `submitTransaction`, whose promise settles only when the
  node closes the shared socket: a `1010` reject held the worker for
  minutes, and the sponsor pool read as unsynced meanwhile. The wallet's
  pending bookkeeping is kept (pend before the send, revert on failure);
  `NIGHTGATE_SUBMIT_TRANSPORT_RETRIES` now also covers a failed connect
  phase; `NIGHTGATE_SPONSOR_WAIT` applies to all submits (default InBlock,
  the indexer confirmer records finality on the job). A landed transaction
  whose call did not apply fails as `TxFailedError` with the block height on
  every path, after `InBlock` and after `Finalized` alike. A submit whose
  every attempt failed before a send restores the dust snapshot like a
  pre-mempool reject (the SDK revert frees the pending marker, not the note).
  Once a send may have reached the node and the indexer does not show it,
  every later failure of the same submit is `ambiguous` (`SubmitAmbiguous`,
  identifier kept, no rebuild, no dust restore), whatever the later attempt
  answered.
- Sync gate: a failed read of the ledger-event stream tip (one-shot indexer
  subscription) reuses the last read for `NIGHTGATE_STREAM_TIP_GRACE_MS`
  (default 3 min, `0` = off) instead of reporting the tip unknown, which
  failed the gate for that tick and took a sponsor out of the pool for a
  minute at a time.
- Compose: `init: true` on the `nightgate` service (tini reaps the zombies a
  killed health check leaves behind node as PID 1).
- Docs: anchored roots, schema ids, set roots and claim keys are bound to
  the artifact generation (`transientHash`); `payloadHash` is not. Keep the
  `opening`, a vault on a new compiler generation is re-anchored from it.

## 0.24.0 - 2026-09-12

Vault lineage 4 (both widths), `@odatano/nightgate-tx` 0.6.0. BREAKING:
redeploy and re-anchor. Schema delta: `BackgroundJobs.grantId`,
`Documents.attesterId`, `DisclosureGrants.attesterId` / `changedAtHeight`,
`PredicateAttestations.attesterId` / `attesterIdB` (`nightgate-schema-delta`).

- Records keyed by `recordKey(attesterId, payloadHash)`; commit-reveal,
  sequence and epoch removed; an attest is one transaction.
- `retract(mode, key)`: own record (0) or expired claim (1). Claims carry
  `valid_until` (max five years), extend-only on re-proof.
- Claim keys embed record key, content root and schema id.
- `registerDocument` / `bindDocument` replace the passport circuits; a
  re-registered id drops a foreign binding. Constructor `(registrar,
  recovery)`; recovery re-points the registrar (mode 3) or itself (mode 4).
- Actions: `anchorDocument` returns `attesterId`; `issue*` take `attesterId`
  and `validUntil` (`NIGHTGATE_CLAIM_LIFETIME_S`); `verifyAttestationState`
  by `attesterId` + `payloadHash` or `documentId`, reports `recordKey`,
  `bindingRegistered`; `registerPassport` `mode` 0-4; `deployContract`
  `recoveryId`; new `retractAttestation`, `purgeExpired`.
- `verifyDocument` / `verifyPredicateAttestation`: `verified` needs the live
  read; `included` and `stateChecked` reported separately.
- Browser / txbuilder: proof helpers take `recordKey` and `validUntil`;
  `prepareRegisterDocument`, `prepareBindDocument`, `prepareRetract`;
  vault `constructorArgs` `[registrarId, recoveryId]`; `keys/manifest.json`
  covers verifier keys and zkir.
- `submitContractCallBatch` `merkleProof` carries `fieldSalt`, accepts
  `docPair`; `threshold` at most 2^63 - 1.
- Disclosure projection ordered by block height; confirmation writes never
  overwrite a newer row; a failed post-submit reindex retries as a
  `reindexDisclosures` job (`NIGHTGATE_DISCLOSURE_REINDEX_RETRY_MS`).
- Jobs re-read their agent grant at execution (`AGENT_GRANT_REVOKED`,
  `AGENT_GRANT_SCOPE`).
- `updateAgentGrant`, `rotateAgentGrantToken`, `getGrantUsage`
  (`NIGHTGATE_GRANT_ADMIN_RATE_LIMIT`); public verify lane `/api/v1/verify`
  (`NIGHTGATE_PUBLIC_VERIFY`, `NIGHTGATE_PUBLIC_VERIFY_RATE_LIMIT`).
- Submit: late intent ack fails the job (`SubmitIntentTimeout`,
  `NIGHTGATE_SUBMIT_INTENT_ACK_TIMEOUT_MS`); unbound dust intent takes the
  lowest free segment; `1010/104` rebuilt (`NIGHTGATE_STALE_TRANSCRIPT_RETRIES`).
- Wallet: rejected snapshot replay resets the sub-wallet
  (`NIGHTGATE_SNAPSHOT_REPLAY_RESET_MS`); `sync-state` log
  (`NIGHTGATE_SYNC_STATE_LOG_MS`); `getSponsorPoolStatus.caughtUp` is the
  sync gate; pool jobs prefer members at the gate.
- `/metrics` reports the database pool; `qs` overridden to 6.16.0.

## 0.23.4 - 2026-09-11

Authorization, key handling and runtime gating. No circuit change; schema delta:
two nullable columns (`DisclosureGrants.pendingLevel`, `Documents.sessionId`),
added by `cds deploy` at boot. Stored `v2` envelopes stay readable; run
`nightgate-rewrap-keys` to bind them.

- **A disclosure level changes only once the chain took it.** `grantDisclosure`
  on an existing grant used to write the requested level into the row before
  the session check and before any confirmation, and the off-chain read ACL
  trusts that row. The row is now written after the session check, an existing
  row keeps its confirmed `level` and carries the request as `pendingLevel`
  (new nullable column, additive); the executor and the reconciliation
  finalizer move it into `level` on inclusion and drop it when the chain
  refuses. A refused caller leaves the row untouched.
- **Write actions answer 503 while the runtime is down.** Initialisation
  failed or not completed: every action that needs the wallet worker, node or
  proof server (`connectWallet`, sends, deploys, submits, grants) is refused
  with `RUNTIME_UNAVAILABLE`, `Retry-After` and a message that survives
  production sanitising and names no internals (the startup error stays in
  the log and the admin status), instead of creating half-backed state. Reads,
  readiness and the compute-only actions (`prepareDocumentProof`,
  `prepareMembershipSet`, `deriveWalletInfo`, `getJobStatus`, grant admin)
  stay reachable.
- **Agent-token reads stop at the session.** A token could list every
  `Documents` row of its operator, `storageRef` included, because entity
  reads were only owner-scoped. Tokens now read an explicit entity set
  (chain projections, plus `WalletSessions`, `PendingSubmissions`,
  `Documents` narrowed to the grant's session and the grant's own
  `AgentGrants` row); everything else answers 403. Schema delta: one
  nullable `Documents.sessionId` column, filled by `anchorDocument`; rows
  from before the column stay owner-readable and never token-readable.
- **Grant lists bound every action.** `allowedContracts` /
  `allowedCircuits` now refuse (403) any token action outside them, not only
  sponsored calls; an empty list is still no restriction. The circuits are
  derived from the action itself (`grantDisclosure` runs `grantDisclosure`,
  `anchorDocument` commits with `attestGuarded`, or `attest` with `guarded:
  false`, the `issue*` actions their proof circuits plus `anchorContentRoot`) and from
  batch `calls`, not only from a `circuit` field; an action whose circuits
  cannot be derived is refused while a circuit list is set. The execution-time policy treats a grant past `validUntil`
  like a revoked one, so an expired grant sponsors no queued job.
- **Tier gates resolve the role themselves.** The SDK's `Disclosed` /
  `Authority` before-handlers read `req.disclosureRole` that the `*` hook
  attaches; CAP starts both at once, so a reader could be refused before
  the role was there. The gate now attaches the role itself when it is
  missing, and both dispatch orders give the same answer.
- **Stored envelopes are bound to their row.** New ciphertexts are `v3`
  envelopes whose AAD carries key id, purpose and row id (session id, job
  id, account id); a value copied to another row or column does not
  decrypt. `v2` stays readable; `nightgate-rewrap-keys` rewrites it.
- **The viewing-key seal of the account key needs the ring too.** The
  `vk1` seal is now wrapped in a ring envelope: a database copy plus a
  viewing key opens no data key, private state or contract signing key
  without `ENCRYPTION_KEY`. Bare seals are wrapped on first use and by the
  rewrap tool. A ring key that leaves without a rewrap can no longer be
  replaced by the viewing key; run the rewrap first.
- **Signing-key custody.** Admin action `exportContractSigningKey(sessionId,
  contractAddress, password)` returns one contract's maintenance authority
  as the `midnight-signing-key-export` envelope `importSigningKeys` restores;
  procedure in docs/operations.md. Production refuses an encryption secret
  shorter than 32 characters instead of warning.
- The real-circuit contract checks are Vitest suites now:
  `test/integration/attestation-vault.test.ts` (76 scenarios) and
  `attestation-vault-32.test.ts` (18), one test per guard, each describe on
  a fresh contract state; `npm test` runs them, `npm run test:contract`
  runs just those. The sequential scripts
  `scripts/integration-test-attestation-vault[-32].mjs` and their npm
  aliases are gone; `check:release` no longer needs the compiled srv twins
  for them.
- **SDK client survives a closed keep-alive socket, without doubling a write.**
  A caller that proves locally between two requests came back to a pooled
  socket the server had already closed and got `fetch failed` /
  `ECONNRESET`. `connect()` now retries such a request once on a fresh
  connection, but only when a second delivery cannot create a second effect:
  GETs, and POSTs that carry an `idempotencyKey` the server dedupes on. A
  write without a key surfaces the error after one attempt; pass
  `idempotencyKey` on submit actions to get the retry.
- **Wording.** Comments and docs describe the vault in terms of documents,
  canonical JSON and external identifiers; the circuit and action names
  (`registerPassport`, `bindPassport`, `passportId`) are unchanged API.

## 0.23.3 - 2026-09-10

A production hang and a lost broadcast. No schema or circuit change.

- **A lost broadcast ends the job.** A sponsored transaction the node never
  included (four in ~2100 sponsorings: no reject, no status, never on the
  indexer) parked its job in `reconciliation_required` forever. Every
  submit intent now records the transaction's `ttl` on the attempt row;
  once the indexer tip is past it plus `NIGHTGATE_BROADCAST_EXPIRY_MARGIN_MS`
  (5 min) and the indexer has no record, the job ends
  `failed / BROADCAST_NOT_INCLUDED`, `chainStatus: dropped`. Only absence
  counts (an indexed transaction without a confirmable result stays
  parked), the tip comes from the same indexer answer as the absence (the
  older one when identifier and hash are both tried), and without a tip
  there is no verdict. A lost sponsored deploy refunds its deploy
  reservation; a workflow parent whose child was lost ends
  `failed / CHILD_FAILED`. Rows from before this release use the submit
  time plus one hour.
- **`BROADCAST_UNCONFIRMED` while parked.** The ambiguous submit outcome
  has its own park code; `EXTERNAL_EXECUTION_FAILED` stays for a failure
  after the broadcast.
- **The submit says which phase died.** The dedicated-client submit
  (unbound sponsoring) drives the node client's event stream itself
  (`srv/midnight/worker/phased-submit.ts`) with one budget per phase:
  connect (`NIGHTGATE_SUBMIT_CONNECT_TIMEOUT_MS`, 20 s; nothing sent,
  retried once on a fresh client, then a clean pre-inclusion failure),
  request (`NIGHTGATE_SUBMIT_REQUEST_TIMEOUT_MS`, 30 s, until the node's
  first status; ambiguous `no-reply`) and watch
  (`NIGHTGATE_SUBMIT_WATCH_TIMEOUT_MS`, 75 s, until InBlock; ambiguous).
  Every status and socket event is logged with its offset; a timed-out
  attempt keeps listening for `NIGHTGATE_SUBMIT_LATE_GRACE_MS` (5 min) and
  logs a late reject or InBlock under the identifier; closing an abandoned
  client is bounded. `@midnightntwrk/wallet-sdk-node-client` and `effect`
  are direct dependencies now.
- **No concurrent recompilation in the container.** A live 0.23.1 server
  stopped answering for an hour: a lock-order deadlock inside V8 (node
  22.23.2) between the main thread at a GC safepoint and a background
  TurboFan compile holding the same transition-array lock. The entrypoint
  starts node with `--no-concurrent-recompilation`; `NIGHTGATE_NODE_FLAGS`
  overrides the flag list (V8 flags are refused in `NODE_OPTIONS`).
- `docs/docker.md` carries a cron watchdog on the healthcheck: Docker never
  restarts an unhealthy container by itself.
- Image tag `0.23.3`.

## 0.23.2 - 2026-09-06

`@odatano/nightgate-tx` 0.5.1, the fix for a 0.5.0 packaging break.

- **nightgate-tx 0.5.1.** Every in-process (wasm) build of 0.5.0 failed on
  load with `Cannot find module '../utils/config'`: the shipped proof
  provider and the batch scope imported the server's config table
  statically, and the table is not in the package (server proving was
  unaffected). Both now read through `srv/midnight/runtime-config`: the
  config table inside the server, the environment in the package.
  `check:slim` walks every relative require of a shipped runtime file and
  refuses one that resolves outside the package; the real-install probe
  loads the proof provider from the clean install and checks the
  environment fallback.
- The package README documents the ledger-v8 override a fresh consumer
  install needs: the wallet SDK declares `^8.1.x`, a second copy (8.1.1)
  next to the pinned 8.1.0 fails the dust wallet with `expected instance
  of DustParameters`; pin `"@midnight-ntwrk/ledger-v8": "8.1.0"` in
  `overrides`.
- Image tag `0.23.2`; no server behaviour change.

## 0.23.1 - 2026-09-06

`@odatano/nightgate-tx` 0.5.0, the caller-side companion of 0.23.0. The
server release carried the generated package at 0.4.5, which builds
lineage-2 vault calls.

- **nightgate-tx 0.5.0 (BREAKING).** Ships the lineage-3 vault modules
  (`attestation-vault`, `attestation-vault-32`); `prepareAttestCommit` takes
  `expiresAt` and `prepareAttestReveal` emits the five-argument
  `attestGuarded`, so a 0.4.x caller fails against a redeployed vault. The
  witness builder and hex codec are the shared `src/browser` sources; the
  zk-asset fetch accepts gzip-encoded responses; `prepublishOnly` refuses a
  stale generated tree.
- Image tag `0.23.1`; no server code change.

## 0.23.0 - 2026-09-05

Hardening release across the whole server: authentication, submission
bookkeeping, encryption at rest, crawler correctness, worker structure,
configuration and packaging. Schema delta: `ContractActions.address`
nullable, inclusion columns on `BackgroundJobs` and `PendingSubmissions`,
`SyncState.reorgGeneration`, new `AccountKeys` table, `keyScheme` marker on
the private-state tables; `nightgate-schema-delta` applies all of it, the
image redeploys. Breaking items first; every deployed attestation vault
must be redeployed and its documents re-anchored.

### Breaking

- **Vault lineage 3.** `attestGuarded(mode, payload, meta, nonce,
  expires_at)`: a commitment is bound to its committer, expires at block
  time (7-day cap), a fresh reveal inherits the commitment's sequence and a
  revealed attestation is final. `anchorDocument` is guarded by default
  (`guarded: false` for public hashes); `commitDocumentAnchor` and browser
  `prepareAttestCommit` take `expiresAt`. Both widths recompiled.
- **Prover keys leave the npm tarball** (0.72 MB packed, was 86.9 MB). A
  missing `keys/<circuit>.prover` is fetched from `NIGHTGATE_ZK_ASSET_URL`
  (default: the release's GitHub tree for shipped contracts) and verified
  against `keys/manifest.json`; `nightgate-fetch-keys` pre-fetches for
  offline installs. The artifact digest covers verifier keys, zkir, module
  and manifest; 0.22 digests still match as `legacy`.
- **Nothing is derived from the extrinsic envelope.** No contract address
  from the extrinsic hash, no NIGHT transfer, UTXO or balance from a signed
  extrinsic's call args. Those `Transactions` columns and
  `ContractActions.address` are null until the ledger payload is decoded;
  `ContractStatistics` counts per action type. The delta clears old values.
- **Canonical JSON follows RFC 8785**: integer-like keys sort as strings.
- **`/contract-manifest` emits relative URLs** unless
  `NIGHTGATE_ZK_CONFIG_PUBLIC_URL` is set; a dApp on another origin passes
  `manifestUrl` to `createNightgateConnectorProviders` or uses
  `resolveManifestUrl`.
- **Removed:** `probeCrossServerSponsor` (action, executor, worker handler),
  `crawlerlessChainConfirm` (the confirmer is always on), the lease fields
  of `getJobStatus`. **Node 22.12 or newer.**

### Security

- `$batch` parts are authenticated from the envelope token; the transport
  principal without a token is rejected. Owner-scoped entity reads under a
  token return the caller's rows.
- The agent token never reaches the request log: CAP's JSON format prints
  every header and masked only its defaults. `src/cap-log-mask-boot.ts`
  adds `x-agent-token` to `log.mask_headers` as the first import of every
  entry point (the formatter freezes the list on a logger's first use);
  the image config states it too. Rotate tokens issued earlier if the
  container logs were readable by anyone but the operator.
- Rate limits are keyed by grant, then user, then address, 64 keys per
  principal with LRU eviction; new limits on the sponsor actions (120/h)
  and `buildSponsorable` (30/h). Failed basic-auth attempts are throttled
  per address (20 per 15 min, then 429 with `Retry-After`).
- Sponsor policy is resolved when the job runs (`AGENT_GRANT_REVOKED` for a
  revoked grant); an unpinned grant cannot name a sponsor; a wallet facade
  stays warm only for the same user's sessions; admin `WalletSessions` and
  `DisclosureRoles` are read-only; `prepareDocumentProof` resolves own
  properties only and accepts decimal numeric strings only.

### Encryption at rest

- Key ring: `ENCRYPTION_KEYS=id=secret,...` + `ENCRYPTION_KEY_ACTIVE`
  (`ENCRYPTION_KEY` alone = id `1`). Ciphertexts are v2 envelopes (per-row
  DEK under an HKDF-stretched KEK, key id in the AAD); legacy `iv:tag:data`
  still reads. The dev fallback key is random per process.
- Account data keys (`AccountKeys`): private states, contract signing keys
  and sync-state blobs are encrypted under a per-account DEK sealed under
  the ring and under the viewing-key password. `nightgate-rewrap-keys`
  rotates every account without a viewing key and exits 1 while legacy
  rows remain; the boot preflight refuses an unknown key id. Cached DEKs are
  zeroed on disconnect and shutdown, and a resolution in flight at eviction
  time does not repopulate the cache.

### Submission

- Every submit path announces the transaction identifier before it
  broadcasts and persists it as the job's `txHash` first; rejected attempts
  are closed, refunded and taken off the job in one transaction; restart
  recovery fails hash-less `external_execution` rows plainly
  (`PROCESS_RESTART_BEFORE_BROADCAST`).
- Chain evidence is the indexer confirmer's block: `chainBlockHeight`,
  `chainBlockHash`, `indexerTxHash` on job and attempt row, written in one
  transaction and never without a height. Every commit is reorg-safe: each
  rollback increments `SyncState.reorgGeneration` as its first write (one
  atomic `+ 1` that holds the row lock for the whole rollback), a confirmer
  captures the generation before its lookup and refuses the commit when it
  moved. A reorg rollback and `reindexFromHeight` revert every job and
  attempt confirmed at or above the fork by that height, chain-failed
  attempts included. A failure the worker proves directly goes through the
  same lookup or parks as `CHAIN_EXECUTION_FAILED_UNCONFIRMED`.
- Submit failures are classified once in the worker (`pre-mempool-reject`,
  `dust-race`, `transport`, `ambiguous`, `landed-not-applied`, `policy`,
  `causality`, `internal`) and travel the RPC as data (`WorkerSubmitError`);
  both sponsor channels share one decision table
  (`NIGHTGATE_SPONSOR_DUST_RETRIES`). A wait that ended without a reply is
  ambiguous, never resent.
- Unbound sponsoring picks the free dust backing with the most headroom,
  values the notes at the spend's block time and refuses a backing whose
  fresh note no longer covers the fee before proving (three re-selects).
- Job kinds declare their traits in one table (`srv/submission/job-kinds.ts`);
  the heavy, workflow-parent, identifier-keyed and session-bound sets derive
  from it. Expired leases are reclaimed (`NIGHTGATE_JOB_LEASE_TTL_MS`), the
  poller claims rows up to free capacity, the equality/membership/integrity/
  diff workflow parents reconcile.
- Worker rotation drains submitting calls only, bounded by
  `NIGHTGATE_WORKER_DRAIN_MAX_MS`; rotation and shutdown flush every facade
  with an acked save; reads cut by a rotation are repeated once
  (`WORKER_ROTATED`); sync waits and private-state round trips are bounded.

### Crawler

- `Transactions.raw` is a binary value (PostgreSQL-safe; the delta clears
  lossy text values, `reindexFromHeight(0)` restores them). Block timestamps
  come from storage or the `Timestamp.set` inherent, never the wall clock.
  The runtime version rides per block; registry and pallet map are cached
  per `specVersion` and a block is classified with its own runtime's map.
  A missing or invalid runtime version, an unreadable metadata or one that
  lists no pallets fails the block instead of guessing.
- The node provider never stops reconnecting, `stop()` waits for the
  in-flight persist, a failed header lookup during the fork search
  propagates, secondary indexes are created at startup, lock contention is
  recognised by SQLSTATE (40001, 40P01, 55P03, 57014) with a shared retry.

### Structure

- The wallet worker is eleven modules under `srv/midnight/worker/`;
  `wallet-worker.ts` is the composition root. Artifact snapshots live per
  install (`<base>/<install>/<digest>` with holder files).
- One typed config table (`srv/utils/config-table.ts`, 80 keys): uniform
  parsing, every key settable via `cds.requires.nightgate`, the worker reads
  the resolved snapshot from `workerData`, `docs/reference.md` is generated
  (`npm run config:table`) and pinned by a test.
- One witness builder and one hex codec (`src/browser/witnesses.mjs`,
  `hex.mjs`) for server, worker and browser; `npm run check:vault-parity`
  keeps the 16- and 32-slot sources in step; `slotWidth` is 16 or 32.
  Main-thread artifact readers are generation-pinned; a job resolve compares
  the memoised digest instead of re-hashing the prover keys.

### Packaging and operations

- PostgreSQL integration lane (`npm run integration:postgres`), a CI job and
  part of the tag gate (`check:release:full`). `nightgate-schema-delta` needs
  no cds-dk. `check:exports` verifies every `bin`, every manifest circuit's
  verifier/zkir/bzkir in the tarball, and that packed build output has a
  tracked source.
- Image runs as `node`; `.dockerignore` excludes `packages/`, `deploy/`,
  `.github/`; `deploy/contabo/` removed; the compose tag is pinned to the
  package version by a test; `packages/nightgate-tx` publishes only from a
  fresh generated tree; the txbuilder's asset fetch accepts gzip responses.
- `getRuntimeInfo().apiVersion` and a written 0.x API rule;
  `estimateSendNightFee` takes `tokenTypeHex`; `mintShieldedTestToken` runs
  under the heavy cap; bins are linted.

## 0.22.2 - 2026-09-02

Midnight SDK line moved to midnight-js 4.1.1 / compact-js 2.5.1 / ledger-v8
8.1.0 (exact pins) in `@odatano/nightgate` and `@odatano/nightgate-tx` 0.4.5.
No schema change, no circuit change, no action change.

- **One copy of every Midnight package.** midnight-js 4.1.1 routes all its
  ledger, compact-js, compact-runtime, onchain-runtime and platform-js
  imports through the new `@midnight-ntwrk/midnight-js-protocol`, which pins
  ledger-v8 8.1.0, compact-js 2.5.1, compact-runtime 0.16.0 exactly. Both
  packages now pin the same set exactly (midnight-js 4.1.1, compact-js
  2.5.1, ledger-v8 8.1.0, compact-runtime 0.16.0, zkir-v2 2.1.0); a consumer
  on that line dedupes without overrides. Two copies of a wasm-bearing
  package reject each other's objects with messages like `expected instance
  of ContractMaintenanceAuthority`. compact-js 2.5.3 is NOT the target: it
  depends on a ledger-v9 alpha. The 0.22.1 tree itself carried a second
  compact-runtime (0.15.0 nested under compact-js 2.5.0); gone.
- **Zswap offers follow the transcript segment** (upstream, midnight-js
  contracts 4.1.1): shielded outputs, inputs and transients of a contract
  call are placed in the guaranteed or fallible segment according to where
  the contract's transcript claims them, instead of always in segment 0.
  The sponsor's offer check already inspected both `guaranteedOffer` and
  `fallibleOffer`; nothing to change on the NIGHTGATE side.
- **LevelDB private-state backend password** (dev-only opt-in
  `privateStateBackend: 'level'`): midnight-js 4.1.1 validates the storage
  password (16+ characters, three character classes, no runs, no
  sequences); the derived 64-char hex has two classes. `levelStoragePassword`
  re-encodes it deterministically for the level provider only (byte pairs
  joined by `-`, fixed suffix). A level store written before 0.22.2 does not
  open with the new key; the default CAP-DB backend is unaffected.
- **Upstream additions worth knowing:** the indexer provider moved to Apollo
  client 4 and throws typed `IndexerQueryError`/`IndexerDataError`/
  `IndexerSubscriptionDataError` instead of bare `Error`s; midnight-js warns
  on the console when a proof-server or indexer URL uses `http:`/`ws:` to a
  non-loopback host (the compose proof server at `http://proof-server:6300`
  logs it once per provider bundle); `NodeZkConfigProvider` rejects circuit
  ids outside `[a-zA-Z0-9._-]` (the standard-circuit lookups such as
  `midnight/zswap/spend` keep failing over to the wallet SDK's key material
  as before).
- **Sizing note for in-process wasm proving**, measured on the vault's
  `proveDocumentComparison`: k=17 (38.5 MB prover key) peaks at 1.82 GB
  RSS, k=18 (72.9 MB) at 3.45 GB; ~47x the prover key, doubling per k. The
  JS heap stays around 50 MB, the rest is wasm linear memory, which never
  shrinks (a second prove in the same process adds ~46 MB). Two proves in
  one process serialize and peak at the maximum, not the sum. Under
  `provingMode: 'server'` the client still loads the prover key (it travels
  in every `/prove` request) but not the proving working set. Documented in
  `docs/txbuilder.md`.

## 0.22.1 - 2026-08-31

Single-call `before` hooks and self-funded submission, under
`@odatano/nightgate/txbuilder` and `@odatano/nightgate-tx` 0.4.4 alike. No
server behavior change, no schema change, no circuit change.

- **`before` hooks run for single calls**: `buildSponsorable({ call })` (and a
  one-entry `calls`) now invokes the call's `before` hook immediately before
  proving, exactly like a batch entry. Previously the hook was batch-only: a
  single call proved with the witnesses as they stood, and a batch split into
  single-call transactions silently dropped its hooks; an unarmed witness
  holder then proves value 0 with a zero salt, which on an insert-style
  circuit lands as a commitment nobody can open.
- **Self-funded submission** exports on `/txbuilder`, for callers that pay
  their own dust and submit to the node themselves: `submitFinalized`
  (extrinsic encoding over HTTP via `@polkadot/api`, a new optional peer
  dependency; submit over a one-shot WebSocket, the node's HTTP gateway 403s
  bodies over ~14 KB) plus `submitExtrinsic`, `deserializeTransaction`,
  `txIdentifiers`, `probeLanded` (confirm by identifier, reports
  `applied: false` for in-a-block-but-call-failed), `classifyNodeReject`
  (170/171/196 stale dust proof, 138/173 funds, 219-224 sequencing, 117
  malformed), `isPreMempoolReject`, `isTransportFailure` (probe, then resend
  the SAME bytes), `isAlreadyImported` (1013 after a resend = the first send
  reached the pool, confirm by identifier instead of failing), `waitLanded`
  (`probeLanded` in a bounded loop; ANY refused resend can mean the first
  send landed while the indexer lags, so wait for the identifier before
  trusting the reject) and
  `withDustGuard` (dust sub-wallet snapshot before a
  build, restore on a pre-mempool reject). `probeLanded` reads a missing
  transaction result, an HTTP failure or a GraphQL error as unknown (null),
  never as applied; a socket close before the submit reply fails immediately
  as transport instead of waiting out the timeout. Docs: `docs/txbuilder.md`,
  "Self-funded submission"; the packaged README carries the same flow.
- **Image chores**: `.dockerignore` mirrors the `.gitignore` rules for DB
  backups, wallet-state dumps and env files, recursively (`**/.env*` with an
  `.env.example` exception; dockerignore patterns are rooted, so `*.log` and
  `.env.*` never covered subdirectories and a local `COPY . .` build shipped
  operational data); compose default image tag 0.22.1.

## 0.22.0 - 2026-08-30

Custom-token balances, struct circuit arguments, proof request timeout,
same-transaction resend, contract artifacts outside the package, sponsored
zswap offers of a contract's own token. Additive schema migration (one
nullable `AgentGrants` column). No circuit change. `@odatano/nightgate-tx`
0.4.3.

- **`getWalletBalance.shieldedTokens[]`**: every shielded token type other
  than NIGHT with a non-zero balance, `{ tokenType, amount }` (raw 64-hex
  type, atoms). Pairs with `deriveTokenType` and `sendNight(tokenTypeHex)`;
  a contract-minted token was spendable but invisible.
- **Struct circuit arguments** on `submitContractCall` /
  `submitContractCallBatch`: a `contract-info.json` `Struct` parameter
  (`ShieldedCoinInfo`, `QualifiedShieldedCoinInfo`, own structs) is coerced
  field by field with the field's own type, tagged or introspected, nested
  structs included; missing field / non-object / field errors keep the
  `args[i]` prefix. `Vector` / `Maybe` / `Either` still pass through.
- **`proofTimeoutMs`** (cds) / `NIGHTGATE_PROOF_TIMEOUT_MS`: HTTP timeout of
  one proof request in server proving mode, default 300000 (midnight-js'
  default), pinned into the env at init like the proving mode. A proof past
  the timeout failed the job and midnight-js re-requested it up to three
  times. The proof server's `MIDNIGHT_PROOF_SERVER_JOB_TIMEOUT` goes with it.
- **Same-transaction resend on a transport failure**: when the SEND of a
  finalized transaction fails (websocket closed at submit, `1000 Normal
  Closure`, `ECONNRESET`, no reply), the worker asks the indexer for the
  identifier, then hands the SAME transaction back to
  `facade.submitTransaction` (which re-pends the spends):
  `NIGHTGATE_SUBMIT_TRANSPORT_RETRIES` (2), `_BACKOFF_MS` (5 s),
  `NIGHTGATE_SUBMIT_LANDED_PROBE_MS` (30 s). A landed transaction is
  reported as submitted only with ledger result `SUCCESS`; in a block
  but not applied (`FAILURE` / `PARTIAL_SUCCESS`) fails as `TxFailed`
  (fee spent, rebuild). Any refused resend (validity reject, `1013
  Already Imported`) is checked against the indexer before the refusal
  propagates. Transport = socket closed/reset/refused, submit timeouts
  (`TimeoutError`, `timed out`, `no reply`). Every bound submit (deploy/call/batch,
  sends, dust registration, bound sponsoring). Before: the job failed and a
  re-run rebuilt and re-proved the call (live: a 13 min proof twice). Node
  rejects are never resent. `classifySubmissionError` counts the transport
  lines as `NetworkOrTimeout`.
- **Contract artifacts outside the package**: the `registerContract`
  validation probe imports the artifact from a disposable copy next to a
  `node_modules` link to NIGHTGATE's runtime (as the worker's snapshots do),
  so `NIGHTGATE_CONTRACTS_DIR` points at a consumer's own directory without a
  node_modules there. Documented as the supported layout.
- **Sponsored zswap offers, `allowedTokenTypes`**: the sponsor shape check
  refused every non-empty offer, so a token contract's `mint` (minted coin
  to the caller) or `burn` / `receiveShielded` (caller's coin into the
  contract) could never be sponsored although no sponsor value moves.
  Floor `NIGHTGATE_SPONSOR_ALLOWED_TOKEN_TYPES` / policy-file
  `allowedTokenTypes`, grant `createAgentGrant(..., allowedTokenTypes)`
  (new nullable column, effective = floor ∩ grant, the floor must open
  it; empty = no offers, unchanged). With a list, an offer passes iff every
  net change (`deltas`, public per raw token type) is on a listed type and
  never NIGHT, every contract-owned coin belongs to a sponsorable contract,
  and a net change exists or a coin in the offer is owned by a sponsorable
  contract (the ledger drops zero deltas: a zero-net offer says nothing and
  is refused, except when the contract itself received or spent a coin in
  it, which is what a burn looks like: user input, contract transient,
  burn-address output, net zero). User outputs are commitments, so a
  transfer of a listed type between users riding along is accepted by
  design. Entries are raw 64-hex types (`deriveTokenType`); an invalid
  floor entry fails closed (503).
- **txbuilder `proofTimeoutMs`** (`@odatano/nightgate-tx` 0.4.3):
  `createTxBuilder({ provingMode: 'server', proofServerUrl, proofTimeoutMs })`
  passes the HTTP timeout of one proof request to the SDK (default 5 min,
  the same ceiling as the server's). The TTL is stamped after proving.
- Packaging: `files` names the four shipped contracts explicitly
  (`counter`, `attestation-vault`, `attestation-vault-32`,
  `shielded-token`) instead of `contracts/**`, so a foreign directory
  under `contracts/` never reaches the tarball; `.dockerignore` drops
  `scratch/` and those directories from local image builds. Compose:
  image tag 0.22.0, `NIGHTGATE_PROOF_TIMEOUT_MS` passed to the server,
  `MIDNIGHT_PROOF_SERVER_JOB_TIMEOUT` (default 600) to the proof-server
  container, both in `.env.example`. `proofTimeoutMs` in the plugin's
  `cds.schema`; `shieldedTokens` on the client/token-ops return types;
  txbuilder `proofProviderConfig()` exported.
- Docs: `docs/reference.md` (config + env), `docs/actions.md` (struct
  arguments, `shieldedTokens`, sponsored offers), `docs/operations.md`
  (upgrade note, three troubleshooting entries), `docs/txbuilder.md`.

## 0.21.9 - 2026-08-29

Stage-grouped segment order for independent batch calls. No schema change,
no SDK change, no circuit change. `@odatano/nightgate-tx` 0.4.2.

- **`independentCalls`** on `submitContractCallBatch`, the worker's batch op
  and txbuilder `buildSponsorable({ calls })`: the calls past
  `orderedPrefix` share no state and are grouped by execution stage before
  proving (guaranteed-only first, call order within a group).
  `issueFieldPredicateAttestationBatch` sets it itself, with its optional
  in-batch `anchorContentRoot` pinned first. Why: a proof cart is a set of
  claims with distinct keys, and on a grown vault `partitionTranscripts`
  puts the same circuit in different stages for different keys (measured
  on demo.zkpassport.eu, vault 4a8893cf: `proveFieldPredicate` 5.86G
  guaranteed vs 6.05G fallible, budget in between), so call order alone
  failed the causality pre-check on about every second cart while a valid
  order existed. Dependent batches leave the flag unset and keep call
  order, including the fail-fast.
- **Structured refusal.** The pre-check throws `BatchCausalityError`
  (`code: 'BatchCausalityViolation'`, `calls: [{ name, segId, stages }]` in
  apply order) and appends the same list to the message
  (`Stages in apply order: ...`); the txbuilder restores `calls` from the
  message when the SDK wrapper drops the typed error.
- `orderBatchSegments`/`withOrderedBatchSegments`/`runBatchInScope` take
  `{ independentCalls, orderedPrefix }`; `batchCallStages(tx)` exported.

## 0.21.8 - 2026-08-29

txbuilder: wallet sync cost, socket leak, identity. No schema change, no
SDK change, no circuit change. `@odatano/nightgate-tx` 0.4.1.

- **`close()` stopped nothing.** It called `facade.close?.()`; the facade
  has `stop()`, so the call was a no-op and every builder's wallet sync
  (three indexer streams, from genesis) ran until the process exited. Now
  `facade.stop()` plus the public-data provider's sockets:
  `indexerPublicDataProvider` has no close, so the builder hands it a
  tracking `ws` subclass (`trackingWebSocket`) and terminates what it
  opened. Measured (attest, bind:false, fresh seed, wasm): idle CPU with
  the builder open 89-101 %, after `close()` 93 % before / 0 % now; indexer
  sockets 1-2 before / 0 after.
- **`walletSync: false`** on `createTxBuilder` skips `facade.start()`. A
  call that moves no value needs no wallet state to build, prove and sign
  (balancing returns the tx untouched, signing is the keystore alone); a
  value-moving call fails at balancing. Measured against the default: build
  27.7 s vs 24.5 s (proving dominates), event-loop lag p50 7 ms vs 108 ms
  during the build, idle CPU 2 % vs 101 %, identical 5284 bytes. Sponsored
  on preprod from a never-synced seed: 006f31fc4a5831e05dddf3d2598912ff0f7b2fdc4c86f4482646b1a3d87fbf9b8e (66 s incl. dust proof in wasm; verifyAttestationState confirms the caller attester id).
- **`deriveIdentity({ seedHex, networkId?, accountIndex?, attestationSecret? })`**:
  `attesterId`, attestation secret and NIGHT address without a builder or
  the network (~150 ms; was a full `createTxBuilder`). Exported from
  `@odatano/nightgate/txbuilder` and the `nightgate-tx` root.
- Docs: everything the builder does runs on the calling thread; host it in
  a `worker_threads` worker (`docs/txbuilder.md`, slim README, example).

## 0.21.7 - 2026-08-28

Graceful container stop. No schema change, no SDK change.

- Entrypoint runs `exec node /app/node_modules/@sap/cds/bin/serve.js`:
  node is PID 1 and receives SIGTERM, so cds runs its shutdown hooks
  (wallet state flush, worker exit). `exec npx cds-serve` put npm -> sh ->
  node in between and `sh -c` does not forward the signal: every
  `docker stop` ended in SIGKILL after 10 s ("Container failed to exit
  within 10s of kill" in the docker journal), and one recreate raced on the
  kill and left the new container in `Created` (api.nightgate.dev, ~10 min
  outage, 2026-08-28 12:54 UTC).
- Compose `nightgate` service: `stop_grace_period: 90s`.
- `test/unit/docker-cds-config.test.ts` pins the entrypoint's exec form and
  LF line endings.

## 0.21.6 - 2026-08-28

Worker GC load from the save tick. No schema change, no SDK change.

- **Save tick 60 s, configurable.** `NIGHTGATE_SAVE_INTERVAL_MS` (default
  60000, min 10000; was a fixed 30 s). Measured on the hosted pool with
  `profileWorker` (0.21.5, three warm facades): 63 scavenges of ~180 ms in a
  20 s window, GC 42 % of the worker, `DustWallet.serialize` the only hot
  path; the dust blob changes with practically every block, so each tick
  re-serialized and pushed multi-MB strings per facade.
- **Worker young generation 128 MB.** `NIGHTGATE_WORKER_YOUNG_GEN_MB`
  (default 128, `0` = V8 default 16 MB, 16..2048) sets
  `resourceLimits.maxYoungGenerationSizeMb` on the wallet worker; the
  old-generation limit still comes from NODE_OPTIONS (verified: a worker with
  only the young size set keeps the inherited `heap_size_limit`).
- Hosted box: the Contabo image's hourly `drop_caches` cron was found and
  disabled (operations note); it explains the hourly IO stalls behind the
  0.21.3 pool incident.

## 0.21.5 - 2026-08-28

`profileWorker` sees both threads and the heap. No schema change, no SDK
change.

- `profileWorker(seconds, dir, thread)`: `thread: 'main'` profiles the CAP
  process's main thread (request handling, state-save pipeline, pollers)
  with the same in-thread profiler; `'worker'` stays the default. Both
  return `heapBefore`/`heapAfter` (used/total/limit/external heap, malloced,
  RSS, ArrayBuffers in MB of that isolate) and `gc` (collections in the
  window, total ms, JSON `byKind`). Shared implementation
  `srv/midnight/cpu-profile.ts`. Live finding that asked for it: five
  minutes after a sponsored call the hosted worker sampled at GC 77 % /
  idle 14 % with the heap far below its 8 GB limit, and the main thread
  carried a steady 35 % of a core.
- `profileWorker` failures keep their message in production (`$sanitize:
  false`), a 503 no longer reads "Service Unavailable" only.

## 0.21.4 - 2026-08-28

Sponsor pool on one worker thread: the cheap fixes from the sharding
analysis. No schema change, no SDK change.

- **Prewarm serializes catch-up to the tip.** `prewarmFeeSponsorPool` waits
  for each sponsor to reach the chain tip (`walletWaitForSyncedState`) before
  starting the next one, so the first pool member is usable after 1/N of
  the wall clock instead of all N crawling together on the shared thread
  (measured: one wallet alone 113 events/s, three together ~26 each).
  `NIGHTGATE_SPONSOR_PREWARM_SYNC_MS` caps the wait per sponsor (default
  30 min; 0 = build only, the old behaviour); a sponsor still behind is
  logged and the loop moves on.
- **Boot sweep keeps sessions holding a signing key.**
  `closeSessionsFromPreviousProcess` closes viewing-only leftovers only; a
  session upgraded with a mnemonic (a pool member taken out of the config,
  a consumer's custodial wallet) stays active and is rebuilt lazily. Before,
  removing an id from `NIGHTGATE_FEE_SPONSOR_SESSION` and restarting revoked
  its key for good.
- **Idle progress watch.** The worker peeks every facade's dust progress
  every `NIGHTGATE_PROGRESS_WATCH_MS` (default 60 s), refreshes the cached
  `getWalletSyncProgress` snapshot and logs `idle-sync ... behindEvents=`
  while a facade is behind with no job waiting. A far-behind idle wallet no
  longer looks like a hang.
- `getSponsorPoolStatus`: per-sponsor status read cap 45 s (was 20 s;
  `NIGHTGATE_SPONSOR_STATUS_TIMEOUT_MS`). Three warm facades on one thread
  make a read take 5-30 s; 20 s reported healthy sponsors as not warm.
- **Admin `profileWorker(seconds?, dir?)`**: CPU profile of the wallet worker
  thread with the in-thread V8 profiler (`node:inspector` inside the worker,
  1..120 s, worker keeps serving); returns self time by function/file,
  inclusive hot paths and the idle/GC/wasm shares
  (`srv/midnight/cpu-profile-summary.ts`), writes the raw `.cpuprofile` for
  DevTools. Reference point: a warm facade at tip idles > 90 % (local
  measurement: 8 % of the worker for one facade, dust serialisation + GC).

## 0.21.3 - 2026-08-28

CAP connection pool under load. No schema change, no SDK change.

- **`features.use_generic_pool` defaults to true** (`src/cap-pool-default.ts`,
  applied at plugin registration; an explicit host value stays). CAP's
  built-in pool (`@cap-js/db-service` 3.0.x, `generic-pool.js` `#dispense`)
  loses a connection whenever it dispenses one to a request that already
  timed out: with the kind default of 1 s the pool emptied on
  api.nightgate.dev after a night of checkpoint stalls and every request
  failed with `Pool resource could not be acquired` (2026-08-28 04:25 UTC).
  `generic-pool` (new dependency) does not have the defect; the repro is
  pinned against the installed db-service in `test/unit/cap-db-pool.test.ts`.
- Standalone image, PostgreSQL: `requires.db.pool` = max 20, acquire 30 s,
  destroy 5 s, idle 60 s, eviction 60 s, testOnBorrow; `requires.db.client`
  `connectionTimeoutMillis` 10 s (`docker/cds-config.mjs`; CAP's
  `cds_requires_db_pool_*` env vars override). Compose `nightgate-postgres`:
  `shared_buffers=1GB max_wal_size=4GB checkpoint_timeout=15min
  wal_buffers=64MB`.

## 0.21.2 - 2026-08-27

Sponsored deploys under a circuit floor. No schema change, no SDK change.

- Calls on a contract deployed under a grant (`deployedContracts`) are
  exempt from `allowedCircuits`: the effective policy carries the grant's
  deployed addresses as `ownContracts`, the sponsor command passes them
  through and the worker's shape check skips the circuit list for a call
  on one of them. The contract list and the byte ceiling still apply. On a
  server with `NIGHTGATE_SPONSOR_ALLOWED_CIRCUITS` (or a policy file with
  `allowedCircuits`) the deploy used to land and every follow-up call was
  refused with `circuit '<name>' is not sponsorable` (api.nightgate.dev,
  `counter.increment`, 2026-08-27).

## 0.21.1 - 2026-08-27

PostgreSQL in the standalone image. No schema change, no SDK change.

- **`NIGHTGATE_DB_URL`.** `postgres://…` selects PostgreSQL in the container
  (`docker/cds-config.mjs` builds the CDS config; unit-tested); the schema is
  deployed with `cds deploy` on every boot (additive evolution),
  `NIGHTGATE_DB_DEPLOY=never` skips it. Without the URL the SQLite path is
  unchanged. Compose gains a `postgres:16-alpine` under `--profile postgres`
  (`NIGHTGATE_PG_PASSWORD`).
- **`nightgate-db-migrate`** (`scripts/migrate-sqlite-to-postgres.mjs`):
  copies every persisted entity of the loaded model from a SQLite file into
  a deployed, empty PostgreSQL database through CAP (0/1 -> boolean, JSON
  columns as text, views skipped; `.texts` and CAP's own tables such as
  `cds_outbox_Messages` included), rows streamed via the statement iterator
  in batches of 500 (flat memory on large indexer databases), integers read
  as BigInt (`Integer64` exact; a `Decimal` SQLite already holds as a REAL
  beyond 2^53 aborts, `scripts/migrate-values.mjs`), source tables the model
  does not define are listed and abort with rows unless `--ignore-unknown`,
  per-table row-count check, `--dry-run`, `--force`; the `SyncState`
  singleton a previous boot wrote is replaced. Needs `@cap-js/postgres` +
  `better-sqlite3` in a plugin host (named in the error when missing).
  Documented invocation: `docker compose run --rm --no-deps nightgate migrate
  --from /data/nightgate.db` (same volume, network and env as the service).
  `migrate` mode branches off before the server checks: it needs only
  `NIGHTGATE_DB_URL` (`cds-config.mjs --db-only`, no `ENCRYPTION_KEY`, no
  HTTP password) and waits for the PostgreSQL listener
  (`NIGHTGATE_DB_WAIT_SECONDS`, default 60, validated 1..86400, per-attempt
  socket timeout capped at the time left) before `cds deploy`.
- `NIGHTGATE_DB_URL` `?sslmode=`: `disable`, `require` (TLS unverified) or
  `verify-full` (chain + hostname, `sslrootcert=<pem>`); `allow`/`prefer`/
  `verify-ca` cannot be honoured exactly by node-postgres and refuse, as do
  unknown modes.
- Compose: no `:?` required variables anymore. `NIGHTGATE_PG_PASSWORD` broke
  the SQLite quickstart (compose interpolates before profile selection),
  `ENCRYPTION_KEY`/`NIGHTGATE_HTTP_PASSWORD` broke `up proof-server`; the
  containers refuse to start on an empty value instead (entrypoint,
  `cds-config.mjs`, postgres image). Image `migrate` mode runs deploy + migration as a
  one-off container (`docker run --rm ... <image> migrate --from
  /data/nightgate.db`).
- Compose default image tag 0.21.1.

## 0.21.0 - 2026-08-25

Runtime contract registration, per-grant sponsor policy, sponsored deploys,
generation-pinned artifacts, honest 503/sync/dust reporting. Additive schema
migration (six nullable `AgentGrants` columns, `ContractRegistrations`
table). No vault redeploy, no circuit change. `@odatano/nightgate-tx` 0.4.0.

- **Runtime contract registration.** Admin `registerContract` /
  `unregisterContract` / `listContracts`. Paths must lie inside
  `NIGHTGATE_CONTRACTS_DIR` (several roots, canonical, relative paths tried
  under each); module validated in a disposable worker thread, verifier keys
  and `zkir/` directory required; persisted in `ContractRegistrations`,
  reloaded at boot, pinned by generation digest; register/unregister per
  name serialised. Config contracts are the immutable floor (409).
- **Sponsor policy per grant.** `createAgentGrant(allowedContracts,
  allowedCircuits)`; effective policy of a token call = platform floor ∩
  grant (absent grant list = floor, empty floor = grant, empty intersection
  = `403 SPONSOR_POLICY_EMPTY` at admission). Revoking the grant removes its
  reach.
- **Sponsor policy file.** `NIGHTGATE_SPONSOR_POLICY_FILE`: JSON
  `{ allowedContracts, allowedCircuits, allowDeploy }`, re-read per sponsored
  call behind an mtime cache, replaces the env lists while set. Invalid or
  missing file: last good policy, else `503 SPONSOR_POLICY_UNAVAILABLE`; a
  missing file is logged once.
- **Sponsored deploys.** Grant `allowDeploy` + `maxDeploys` (lifetime,
  default 1, `deploysUsed`); floor `NIGHTGATE_SPONSOR_ALLOW_DEPLOY` or policy
  file `allowDeploy`. Shape check admits one `ContractDeploy` per
  transaction under `NIGHTGATE_SPONSOR_MAX_DEPLOY_BYTES` (40960); maintenance
  updates refused. Budget reserved at the submit-intent in one DB
  transaction with the `PendingSubmissions` row (`actionType: DEPLOY`,
  `deployed`, `deployReservation` in `submitIntentData`) and the job
  transition (`reportBroadcastOn`). Rejected attempt: row closed, refund,
  hash cleared in one transaction (`reportSubmissionRejectedOn`); if that
  cannot commit, the job parks under `REJECTED_ATTEMPT_BOOKKEEPING_PENDING`
  and `settleRejectedSponsorAttempts` re-runs the bookkeeping each
  reconciliation tick (job ends `SPONSOR_ATTEMPT_REJECTED`). Chain-failed
  deploys keep their reservation. Landed address recorded in
  `AgentGrants.deployedContracts`, added to the effective policy after the
  intersection; the reconciliation finalizer records it on both the crawler
  and the indexer-confirmer path.
- **txbuilder.** `buildDeploySponsorable({ initialPrivateState,
  constructorArgs, witnesses, bind })` returns the deploy transaction and
  `contractAddress` (exactly one deploy action required).
  `buildSponsorable({ calls, witnesses })` batches on any contract under one
  shared witnesses object (per-call `before` hooks; the vault family may omit
  it). `createTxBuilder({ zkConfigDir })` uses local `keys/` + `zkir/`
  (directories, verifier key per circuit, prover key + bzkir per circuit to
  prove); default `circuits` = circuits of `contractClass`, else the vault's
  set. `ZkAssetResult.source` (`remote` | `local`), `describeLocalZkAssets`,
  `readDeployAddress`. `@odatano/nightgate-tx` 0.4.0.
- **Artifact generations.** Digest (`srv/submission/artifact-digest.ts`)
  over module bytes, `privateStateId`, non-default slot width, prover and
  verifier keys, zkir, and module format (`moduleFormat:commonjs` section for
  CommonJS only; 0.20 digests of CommonJS artifacts accepted as legacy, ESM
  digests unchanged). Worker verifies the digest on disk, materialises an
  immutable snapshot `NIGHTGATE_ARTIFACT_SNAPSHOT_DIR/<install>/<pid>/<digest>/
  {module/artifact.mjs|.cjs,keys,zkir}` (temp build, verify, rename;
  `node_modules` link for bare imports; foreign `node_modules` = refuse) and
  imports class and assets from it only. Scaffold and zk/proving provider
  caches bounded by `NIGHTGATE_WORKER_GENERATION_CACHE` (8); snapshots
  released with their generation, dead-process roots and snapshots older
  than `NIGHTGATE_ARTIFACT_SNAPSHOT_TTL_DAYS` (14) swept at first use;
  indexer WebSocket client shared per endpoint. Worker rotation after
  `NIGHTGATE_WORKER_MAX_GENERATIONS` (32, 0 = never): admission closed
  (`WORKER_ROTATING`, retried by the client), in-flight calls complete,
  clean exit, respawn on next call; `getWorkerStatus().rotationCount`,
  metric `wallet_worker_rotations`. Main process imports no artifact for
  jobs (`resolveContract(name, digest, { compile: true })` only on request).
- **Retryable 503s.** `JOB_ADMISSION_BUSY`, `WALLET_SYNCING` and retryable
  submission classifications keep `error.code` and message under
  `NODE_ENV=production` (`$sanitize: false`) and set `Retry-After`, also on
  `registerForDustGeneration`, `deregisterFromDustGeneration`, `sendNight`.
- **Sync progress.** `getWalletSyncProgress`: `stale`, `staleSeconds`
  (`NIGHTGATE_SYNC_PROGRESS_STALE_S`, 60), `lastProgressAt`, prewarm
  `jobId`/`jobStatus`, `restoredFromSnapshot`, `snapshotSavedAt`,
  `facadeBuildStartedAt`, `facadeBuiltAt`; INFO line RESTORED/COLD START
  under `nightgate:facade`. Facade origins dropped with the worker.
- **Prewarm bound.** Fails on no `appliedIndex` progress for
  `NIGHTGATE_PREWARM_STALL_MS` (10 min, also when the wallet state cannot be
  read); absolute ceiling `NIGHTGATE_PREWARM_SYNC_TIMEOUT_MS` (12 h).
- **Dust race.** `1010/170` and `1010/196` are one retryable classification
  (`srv/submission/dust-race.ts`, `transient: "dust-race"`); bound
  deploy/call/batch paths rebuild-retry before a txHash exists
  (`NIGHTGATE_DUST_RACE_RETRIES` 2, `NIGHTGATE_DUST_RACE_BACKOFF_MS` 5 s).
- **Dust registration.** `registerForDustGeneration` returns `changed`,
  `reason` (`already-registered` | `no-night-utxos`, from the full coin
  set), `requestedReceiver`, `dustReceiverAddress` only when applied,
  `totalNightUtxos`, `registeredUtxosBefore`, `registeredUtxosAfter`,
  `settled`, `consolidated`, `message` (`NIGHTGATE_DUST_REGISTER_SETTLE_MS`,
  90 s).
- **Misc.** Compose default image tag 0.21.0; snapshot copies the module's
  source map with rebased `sourceRoot`; worker client
  `RegisterDustGenerationOutcome` type; `sponsored-deploy:e2e` lane;
  `burst-sponsor:e2e` takes `NIGHTGATE_AGENT_TOKEN`.

## 0.20.0 - 2026-08-24

Monitoring surface. What a dashboard or a scraper needs was already known
inside the process and unreachable from outside. Additive, with one migration.

- **Plain status routes.** `getMetrics()` builds Prometheus text and CAP wraps
  it as `{"value": "# HELP ..."}`, which no scraper parses; a container probe
  cannot express `/api/v1/indexer/getReadiness()` either. The same payloads are
  now served as `text/plain` and plain JSON from the same code
  (`srv/monitoring/status.ts`), and ready answers 200 or 503.

  They mount during CAP's bootstrap, BEFORE its authentication middlewares, so
  they are **fail-closed**: nothing mounts until an operator sets
  `NIGHTGATE_STATUS_TOKEN` (bearer, constant-time compare) or
  `NIGHTGATE_STATUS_ROUTES=public`. And they are **namespaced** under
  `/nightgate` (`NIGHTGATE_STATUS_ROUTES_PREFIX`): CAP registers its own
  `/health` right after that event, so a generic path would let a NIGHTGATE
  database problem decide an unrelated service's health.
- **`getRuntimeInfo()`**: version, network, proving mode, and two artifact
  digests per registered contract. `artifactDigest` is the generation this
  process loaded, `currentDigest` what is on disk now; a mismatch is exactly
  the state where every write job fails the generation guard until restart.
  Memoised behind a stat fingerprint (365 ms to 12.8 ms).
- **`getWorkerStatus()`**: wallet worker health, exit history included. The
  per-facade list is admin-only (it names the wallets this process holds); the
  count is not. Residency comes from the facade registry and is dropped when
  the worker exits, so a pool restored at the tip is neither under- nor
  over-reported.
- **`getSponsorPoolStatus()`**: fee-sponsor pool health in one call.
  `dustNotes` is the parallelism and counts FREE notes only. It is not
  `registeredNightUtxos`, the sponsor's own NIGHT registered for dust
  generation: generation is delegable, so a foreign wallet pointing its NIGHT
  here grows the notes while the own count stays put (measured, 3 to 14).
  Never builds a cold facade, and not grantable to agent tokens.
- **`getJobStats()`** on the admin service, aggregating in SQL rather than over
  every row of the window.
- **Readiness includes initialisation.** A process whose `initialize()` bailed
  answered ready:true whenever the crawler was disabled. It now requires
  `initialized` AND a non-offline mode, and a failed submission bootstrap
  counts as a failed initialisation rather than a warning.
- **A worker crash and a planned stop are told apart.** Both drop facade
  residency, since a facade lives in the worker. A crash then keeps the storage
  passphrases that state-saves the worker already delivered still need, because
  it cannot be waited on; a planned stop drains those saves and releases the
  passphrases, so a `shutdown()` plus re-initialise in one process does not
  leave credentials of closed sessions referenced.
- **One session-expiry rule** (`srv/utils/session-expiry.ts`), replacing nine
  bare date comparisons that each had to remember the platform-sponsor
  exemption. Facade eviction uses it too.
- **Registered contracts with witnesses can be deployed.** An unknown contract
  got an empty witness object, and a Compact constructor checks every declared
  name, so anything with a witness died before the deploy started. The
  fallback is now a stub that satisfies the check and throws when a circuit
  reaches for it.
- **Job admission survives a busy database.** Five attempts over ~14 s instead
  of three over 5.5 s, and an exhausted budget answers 503 ("nothing was
  written, retry") instead of a bare 500. A workflow whose earlier step is
  already on chain escalates to `reconciliation_required` rather than failing,
  and does so conservatively when the child state cannot be read either.
- **Optional `label` on wallet sessions**, settable at `connectWallet`.
  Cosmetic, never used for lookup or authorisation.
- **The image health-checks NIGHTGATE, not just its HTTP port**
  (`docker/healthcheck.mjs`); a 401 or an unexpected 404 is a failure.

**Migration:** `WalletSessions` gains `label`. Run `nightgate-schema-delta`
before upgrading; the entrypoint only deploys a schema when the database file
does not exist. A 0.19 database keeps the server offline with the missing
column named, rather than failing on the first `connectWallet`.

No SDK release: nothing under `packages/`, `src/txbuilder`, `src/browser` or
`src/sdk` changed.

## Earlier releases

0.1.0 to 0.19.0: [docs/changelog-0.x.md](docs/changelog-0.x.md).
