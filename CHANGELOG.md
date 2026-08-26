# Changelog

## 0.21.0 - 2026-08-25

A running server can be told about a new consumer, and it stops reporting
things that are not true. Additive, one schema migration (six nullable
`AgentGrants` columns + the `ContractRegistrations` table); no vault
redeploy, no circuit change.

- **The 503 reason reaches the caller.** CAP replaces the message of every
  5xx with the generic reason phrase when `NODE_ENV=production`, so the
  "nothing was written, retry" advice of a busy admission only ever reached
  the server log; a client classifying on the message treated a retryable
  503 as a failed step. The retryable 503s (`JOB_ADMISSION_BUSY`,
  `WALLET_SYNCING`, retryable submission classifications) now opt out of the
  sanitisation, carry a stable `error.code`, and set `Retry-After`. Genuine
  server faults stay sanitised.
- **Sync progress says when it is old.** `getWalletSyncProgress` kept
  answering `caughtUp: false` with its last figures after the prewarm job had
  ended; a poller reported progress off a two-hour-old snapshot. It now
  carries `staleSeconds` and `stale` (past `NIGHTGATE_SYNC_PROGRESS_STALE_S`,
  60 s), `lastProgressAt`, and the session's latest prewarm `jobId`/`jobStatus`
  so the next call is `getJobStatus`, not a guess. It also says whether the
  facade was RESTORED from the persisted sync snapshot (minutes of delta,
  `snapshotSavedAt`) or COLD-STARTED (hours from zero), the difference an
  operator could not see until the sync was over; the same fact is one INFO
  line under `nightgate:facade` instead of a debug line. Registered BEFORE
  the worker init (`facadeBuildStartedAt`, `facadeBuiltAt` null meanwhile):
  a grown dust snapshot deserialises for minutes (live: 15 MB, ~7 min, then
  4 s of chain delta), and those minutes must not read as "nothing known".
- **Prewarm bounded by progress, not by the clock.** A healthy wallet syncing
  at a third of its idle rate on a loaded machine failed at three hours while
  still applying events. The wait now fails when `appliedIndex` has not
  advanced for `NIGHTGATE_PREWARM_STALL_MS` (10 min) and says "no progress";
  a moving sync runs up to the absolute ceiling
  `NIGHTGATE_PREWARM_SYNC_TIMEOUT_MS`, now 12 h, whose message says "still N
  events behind". Both are retryable for the sponsor pool.
- **One dust-race classification for every submitting path.** `1010/170`
  (stale dust proof) and `1010/196` (nullifier already known) are a transient
  race: pre-mempool, fee unspent, heal = rebuild. The sponsored paths had
  rebuilt-and-retried on them since 0.18 while `classifySubmissionError`
  still marked every 1010 terminal, so a deploy hitting the same race failed
  and the operator retried by hand. The coded race now has one definition
  (`srv/submission/dust-race.ts`), the classifier reports it `retryable`
  with `transient: "dust-race"`, and the bound deploy/call/batch paths
  rebuild-retry inside the worker call, before any txHash exists
  (`NIGHTGATE_DUST_RACE_RETRIES` 2, `NIGHTGATE_DUST_RACE_BACKOFF_MS` 5 s).
- **Dust registration reports the outcome, not the inputs.** Registration
  binds the address, so registering an already-registered wallet with a
  different receiver did nothing and answered success, echoing the receiver
  it had not applied. The result now carries `changed`/`reason`, a
  `dustReceiverAddress` only when one was applied, `requestedReceiver`, and a
  `message` naming `deregisterFromDustGeneration` as the way to move
  generation. And since one registration over many UTXOs consolidates them
  (nine in, two out, two dust notes instead of nine), the result reports
  `registeredUtxosBefore`/`registeredUtxosAfter` observed after the tx
  applies locally (`settled`, `consolidated`;
  `NIGHTGATE_DUST_REGISTER_SETTLE_MS`). Register first, fund afterwards in
  separate payments, to keep the notes split; documented in `docs/actions.md`.
- **Policy follows the grant.** Onboarding a sponsored consumer needed an
  agent grant AND a matching entry in `NIGHTGATE_SPONSOR_ALLOWED_CONTRACTS`,
  maintained by hand in two places, and the env change meant a container
  recreate with a ~20 min cold sponsor pool (three times on 2026-08-24/25).
  `createAgentGrant` gains `allowedContracts`/`allowedCircuits`; a sponsored
  call under the grant's token runs under the intersection of the platform
  floor and the grant (absent grant list = inherit, empty floor = the grant
  is the policy, empty intersection = `403 SPONSOR_POLICY_EMPTY` at
  admission). Revoking the grant removes its sponsoring reach. Two nullable
  columns on `AgentGrants` (`allowedContracts`, `allowedCircuits`, schema
  delta); existing grants behave as before.
- **Sponsor policy file.** `NIGHTGATE_SPONSOR_POLICY_FILE` names a JSON
  `{ allowedContracts, allowedCircuits }` re-read per sponsored call behind
  an mtime cache, replacing the env lists while set: the platform floor
  changes without a restart. Fail-closed: an unreadable or invalid file keeps
  the last good policy, and with none loaded yet sponsored calls answer
  `503 SPONSOR_POLICY_UNAVAILABLE`, never "allow any".
- **Batches on any contract.** The txbuilder's batch path hard-coded the
  attestation vault's witnesses, so a batch on a consumer's own contract
  failed at the first witness the vault does not define, with an error
  naming that witness and not the cause. `buildSponsorable({ calls,
  witnesses })` now takes one shared witnesses object for any contract
  (per-call `before` hooks swap what varies), a batch whose entries carry the
  same witnesses uses those, the vault family keeps getting both from the
  builder, and a foreign batch without either is refused up front with the
  real reason. `createTxBuilder({ zkConfigDir })` reads a consumer's own
  `keys/` and `zkir/` locally instead of a sponsor's `/zk-config`.
  `@odatano/nightgate-tx` 0.4.0 ships this txbuilder: `buildDeploySponsorable`,
  `zkConfigDir`, foreign-contract batches with shared `witnesses`, the
  contract's own circuits as the default `circuits`, `ZkAssetResult.source`,
  `describeLocalZkAssets` and `readDeployAddress`.
- **Sponsored deploys, a distinct right.** A consumer deploying its own
  contract needed a funded wallet with dust first, the one step sponsoring
  exists to remove. txbuilder `buildDeploySponsorable()` builds, proves and
  signs the deploy with the caller's own key (the caller owns the contract)
  and hands the fee-unpaid transaction plus its future address to a sponsor.
  The sponsor pays only when its floor opens deploys
  (`NIGHTGATE_SPONSOR_ALLOW_DEPLOY` / policy file `allowDeploy`) AND, for a
  token caller, the grant carries `allowDeploy` with budget left
  (`maxDeploys`, default 1, separate from the daily job budget: a deploy
  writes verifier keys on chain and costs a multiple of a call). The shape
  check now tells a deploy from a maintenance update (the latter stays
  refused forever), applies a deploy-specific byte ceiling
  (`NIGHTGATE_SPONSOR_MAX_DEPLOY_BYTES`, 40960) and admits ONE deploy per
  transaction. The budget is reserved atomically at the submit-intent,
  before the sponsor broadcasts (one conditional UPDATE bounded by
  `maxDeploys`, in the SAME database transaction as the attempt row AND
  the job's own transition to `submitted` with the identifier; the row
  carries the grant and the deployed address; a nack means nothing goes
  out, a provably rejected attempt is closed, refunded and taken off the
  job (hash CAS on the lease) in one transaction; if that transaction
  cannot commit after its retries the rebuild loop stops and the job parks
  under the persisted marker `REJECTED_ATTEMPT_BOOKKEEPING_PENDING`, which
  the reconciler's settle pass (every tick, crawler or not, and after a
  restart) resolves by re-running exactly that bookkeeping and failing the
  job as `SPONSOR_ATTEMPT_REJECTED`, instead of the generic reconciliation
  an indexer lookup could never resolve; and a broadcast that is only
  reconciled later, by the
  crawler evidence or the crawler-free indexer confirmer alike, records the
  address from the row through the kind's reconciliation finalizer), so
  parallel requests on a stale counter cannot overspend and a crash leaves
  the job either still running with nothing reserved (replayed on restart)
  or submitted with hash, row and reservation together. A deploy whose
  transaction is proven to have FAILED on chain keeps its reservation (the
  sponsor paid the fee); refunds are only for attempts that never reached
  the chain. The landed address is recorded in the grant's
  `deployedContracts` and is sponsorable ON TOP of `floor ∩ grant`: appended
  to `allowedContracts` it would have been intersected away again under a
  non-empty platform floor. Four more nullable `AgentGrants` columns
  (`allowDeploy`, `maxDeploys`, `deploysUsed`, `deployedContracts`), covered
  by the same schema delta.
- **Contracts registered at runtime.** `cds.requires.nightgate.contracts` was
  read once at startup, so making a consumer's artifact known meant a
  restart that closed every wallet session and re-warmed the facades (three
  for one consumer's contract and its revisions on 2026-08-24/25). The
  admin service gains `registerContract` / `unregisterContract` /
  `listContracts`: validated before anything changes (paths inside
  `NIGHTGATE_CONTRACTS_DIR`, module exports a `Contract` class, verifier keys
  and `zkir/` present), persisted in a new `ContractRegistrations` table
  (schema delta), reloaded at boot, and pinned by the same generation
  digest a startup registration gets. The config stays the immutable floor
  (409). Register/unregister of one name are serialised (memory entry,
  digest and persisted row belong to the same generation; a failed request
  cannot roll back a concurrent successful one), and contract modules are
  loaded pinned to their generation digest, on the main thread and in the
  worker: an ESM artifact under a URL keyed by the digest, a CommonJS
  artifact with its filename cache entry dropped first (Node caches CJS by
  filename underneath `import()`), so a re-pointed alias or a revision
  written in place under the same path executes as itself instead of the
  cached class. The main process imports no artifact for a job any more
  (`resolveContract` compiles only on request, registration validates the
  module in a disposable worker thread), so hot re-registrations no longer
  grow the main process's module cache either; relative registration paths
  are tried under EVERY allowed root (`NIGHTGATE_CONTRACTS_DIR` takes
  several; the defaults are two) and roots are canonical, so a root behind
  a symlink or junction works. The digest is not a label the worker trusts: it recomputes
  it from the module, the prover/verifier keys and the zkir files on disk
  (`srv/submission/artifact-digest.ts`, the same bytes the registry hashes)
  and refuses a mismatch. And because Node reads a module when `import()`
  runs and the SDK reads keys and zkir lazily at proving time, the worker
  never hands either of them the mutable registration directory: per
  generation it materialises an immutable, content-addressed snapshot
  (`NIGHTGATE_ARTIFACT_SNAPSHOT_DIR/<install>/<pid>/<digest>`, one tree
  per installation AND per process so a second instance or an overlapping
  upgrade can neither repoint the runtime link nor sweep a snapshot another
  process is proving from, roots of dead processes swept at start-up;
  canonical module name
  `artifact.mjs`/`.cjs` carrying the EFFECTIVE module format, which is
  decided by the nearest package.json for a `.js` file and is part of the
  generation digest (ESM adds no section, so recorded digests stay as they
  were; a CommonJS artifact's digest changes, and jobs or evidence recorded
  by 0.20.0 against an unchanged CommonJS artifact keep working because the
  pre-0.21.0 form is accepted as the same generation, said once at INFO),
  so byte-identical artifacts under different file names share one
  snapshot and a `.js` ESM contract does not depend on Node's syntax
  detection outside its package scope; built under a temp name, verified
  against the digest, renamed into place, never written again, with a
  `node_modules` link so the module's bare `@midnight-ntwrk/compact-runtime`
  import resolves to NIGHTGATE's own pinned runtime; the root is marked as
  NIGHTGATE's and a foreign `node_modules` under it makes the worker refuse
  rather than delete), imports the class from the snapshot module and points
  `withCompiledFileAssets` and the zk config provider at the snapshot only.
  A file rewritten in place after that can neither change the pinned class
  nor be combined with it. Retention: a job holds its generation for the
  whole call, a generation evicted from the worker's bounded caches
  (`NIGHTGATE_WORKER_GENERATION_CACHE`, 8) is swept once no job holds it,
  and stale snapshots (`NIGHTGATE_ARTIFACT_SNAPSHOT_TTL_DAYS`, 14) plus
  leftover temp builds go at the worker's first use; the indexer WebSocket
  client is shared per endpoint. Node's own ESM module cache keeps every
  imported generation until the worker exits, so the worker counts the
  distinct generations it imported and rotates after
  `NIGHTGATE_WORKER_MAX_GENERATIONS` (32; 0 = never): a DRAIN, checked on
  every call's completion (failed calls included), that closes admission
  first (a call arriving after the announcement is refused with
  `WORKER_ROTATING` and retried by the main thread on the respawned worker,
  calls made meanwhile wait for the exit), lets everything in flight finish
  and exits at zero; reported as `rotationCount` (also the
  `wallet_worker_rotations` metric), never as a crash.
- **Smaller corrections from the release review.** `registerForDustGeneration`
  decides `already-registered` from the full coin set (the SDK's available
  set excludes registered UTXOs, so a fully registered wallet used to read as
  `no-night-utxos`); the prewarm stall bound also fires when the wallet state
  cannot be read (a dead state observable ran to the 12 h ceiling);
  `registerForDustGeneration`, `deregisterFromDustGeneration` and `sendNight`
  set `Retry-After` on a busy admission like the submission actions do; the
  txbuilder's default `circuits` is now every circuit of the `contractClass`
  handed in, not the vault's set (live: a foreign contract's only circuit had
  no prover key on the follow-up call); its `zkConfigDir` mode returns the public `ZkAssetResult` shape
  (`fetched: 0`, `source: 'local'`; `ensureZkAssets` reports
  `source: 'remote'`); the txbuilder declaration and JSDoc describe the
  batch witness rule as implemented (one shared object, or the entries'
  common one, or the vault family's own); the worker client's
  `registerDustGeneration` type carries the 0.21.0 outcome fields; a
  snapshot copies the module's source map under the referenced name with
  its `sourceRoot` rebased so the sources keep resolving; `zkConfigDir`
  requires `keys/` and `zkir/` to be directories and, for the circuits the
  builder will prove, the prover key and bzkir (not only every circuit's
  verifier key; a class that cannot be introspected falls back to the
  vault's set like the remote path, so empty asset directories never pass;
  `cached` counts the verified files), and a runtime registration requires
  `zkir/` to be a
  directory; a missing sponsor policy file is logged once, not per call;
  `buildDeploySponsorable` fails the build unless
  exactly one deploy action with an address is present (no empty
  `contractAddress` as a success) and its declaration returns the
  bound-or-unbound union for a generally typed input; a successful dust
  registration reports the full NIGHT UTXO count; the facade origin
  (`restoredFromSnapshot`, build timestamps) is dropped with the worker, so
  `getWalletSyncProgress` never describes a facade of a dead worker; the
  compose default image tag follows the release.

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

## 0.19.0 - 2026-08-22

A 32-slot vault lineage and multi-call batches in the txbuilder SDK. No
change to the existing 16-slot vault: deployed contracts, claim keys and
byte layouts stay identical, nothing to redeploy.

- **`attestation-vault-32`, a second registered contract lineage** with 32
  content slots: documents up to 32 fields, k-of-32 diff proofs, 32-bit
  integrity masks. Registered contracts carry a `slotWidth` attribute
  (default 16) and the whole surface is width-parameterized from it
  (document proofs, witnesses, mask/k/path validation, predicate-state
  recompute, browser helpers via the new `./browser/attestation-vault-32`
  subpath, `/zk-config` + contract manifest). Cross-root proofs work only
  between documents of the SAME width; the width is part of the tree shape.
  Cost is honest: the comparison prover alone is 72.9 MB and proves in
  ~443 s wasm / ~92 s on a proof server, the content-tree circuits grow with
  the deeper fold, the attest/anchor/grant circuits are byte-identical.
  The 32er's 113 MB of PROVER keys are the one thing the package does not
  carry (the registry rejects the resulting tarball); see the entry below.
  Measured 8/16/32/64 before
  choosing: keys scale linearly with width, wasm proving hits its 4 GB
  ceiling at 64, so 16/32 is the supported menu (the registry accepts
  8/16/32 and rejects 64: the mask path is 32-bit). A non-default width is
  part of the artifact GENERATION digest: re-pointing a registered alias to
  a different width trips the same fail-closed guard as swapping the
  artifact bytes, while width-16 digests recorded by earlier releases stay
  valid (the default adds no digest section).
- **txbuilder multi-call batch**: `buildSponsorable({ calls: [...] })` puts
  up to 8 circuit calls into ONE transaction (one fee, one sponsoring),
  with the same deterministic segment ordering and pre-proving causality
  fail-fast as the server lane (`BatchCausalityViolation`, no fee burned).
  Same-name circuit calls are grouped but unordered among themselves. The
  durable batch shape on a grown contract is the proof cart (anchor first,
  then proofs); attest+anchor pairs stay legal only on young vaults.
  `@odatano/nightgate-tx` 0.3.0 ships the same txbuilder (including the
  batch) and exports the 32er contract module as `./attestation-vault-32`
  (keys come from `/zk-config` as before).
- **`allowedMask` is now `Integer64`** (entity column, action parameter and
  the verify projections): a 32-bit mask with bit 31 set overflows a signed
  Int32 column (PostgreSQL/HANA) and `Edm.Int32` clients. OData serializes
  the value as a STRING now (IEEE754-compatible Int64 handling); the server
  accepts both number and string. SQLite stores dynamically, so existing
  dev databases need no migration; on typed databases redeploy the schema.
- **Submit-race lore measured, docs corrected**: node reject `1010/104` is
  the guaranteed-phase state conflict, rejected PRE-mempool with the fee
  unspent; the cure is REBUILDING against fresh state (resubmitting the
  identical bytes sticks). `CHAIN_EXECUTION_FAILED` is the fee-spending
  fallible-phase flavor of the same conflict. `docs/txbuilder.md` and
  `docs/actions.md` carry the operational guidance (verify per claim,
  independent verification without NIGHTGATE, schema-id/segment caveat,
  attest concurrency warning).
- **Width-32 prover keys are fetched, not packed.** Carrying every width's
  full prover set made the tarball 204 MB and the npm registry refuses it
  (413). The package ships the 32er's contract module, verifier keys, zkir
  and Compact source; its 113 MB of prover keys are not in it, which keeps
  the package in the same size class as 0.18. Deploying `attestation-vault-32`
  and verifying its claims crawler-free work as they are; PROVING its
  circuits locally (and serving them over `/zk-config`) needs the keys on
  disk. One command puts them there, defaulting to this release's own git
  tag, whose layout IS the `/zk-config` layout:
  `npx nightgate-fetch-keys attestation-vault-32` (or `--from
  https://host/zk-config/attestation-vault-32` to pull from a NIGHTGATE that
  has them). Run it before the first proof: prover keys are part of the
  artifact GENERATION digest, so adding them changes what the contract
  resolves to. A server that boots without them says so once, by name.
  Container images are unaffected, they build from the repo and have
  everything.
- **`npm run check:server`**: one-shot health probe of a running server
  (health, readiness, optional sponsor dust/balance/sync), local or hosted.

## 0.18.0 - 2026-08-19

Parallel fee sponsoring from ONE sponsor wallet; no circuit change, no vault
redeploy.

- **`sponsorUnboundTransaction`, the parallel sponsoring channel.** The caller
  builds with `buildSponsorable({ bind: false })` (txbuilder SDK; client
  `ng.sponsorUnbound`) and hands over the signed PRE-BINDING transaction; the
  sponsor locks one free dust BACKING of its wallet, builds and proves a
  dust-only spend against it, merges it into the caller's transaction, binds
  and submits. Proving and submit run outside the per-wallet lock (only the
  fast dust build is serialized), each in-flight submit uses its own node
  client, so one wallet sponsors as many transactions at once as it has
  distinct registered dust backings. Same shape check, allow-list, pool,
  idempotency and grant surface as `sponsorFinalizedTransaction` (both
  phase-2 actions are agent-grantable and pool-aware). Job concurrency is the
  heavy cap (`jobs.concurrency.heavy`, default 4). Live on preprod: 4
  sponsorings from one wallet, 4 backings, 3 of them in the same block, 86 s
  end to end.
- **Dust races self-heal.** A `1010/170` or `1010/196` (dust spend built
  against a state the node moved past, or on a note whose nullifier the node
  already knows) rebuilds and resubmits on the SAME sponsor
  (`NIGHTGATE_SPONSOR_DUST_RETRIES`, default 4,
  `NIGHTGATE_SPONSOR_DUST_BACKOFF_MS`, default 5000) instead of benching it;
  the worker's RPC errors now carry the nested cause chain, so the node's
  reject line is visible to that classification (it was not before);
  same-backing requests queue on the backing lock (`NIGHTGATE_BACKING_WAIT_MS`,
  default 5 min); the dust spend's ctime is the indexer block time, not the
  wall clock. Only non-dust retryable failures still fail over.
- **Two SDK node-client traits worked around** (both hit live): the wallet
  SDK's node client shares ONE socket per facade and disconnects it when any
  submission stream ends, so concurrent submits on one facade lose each
  other's `Finalized`; and `WsProvider.disconnect()` returns before the socket
  is closed, so a fresh or just-used client sends on a closing socket. The
  parallel channel therefore submits on a pool of dedicated submission
  clients with a settle window after creation and after every use, and
  retries once when the request itself dies on that close.
- **Read side.** `getWalletBalance` already reports dust notes; the sponsor
  path logs the backing each transaction paid from and the pre-submit ledger
  cost. Job result of `sponsorUnboundTransaction`:
  `{ txHash, circuits, contractAddress, note }`.
- **Sponsor pool warms at boot.** The sessions in `NIGHTGATE_FEE_SPONSOR_SESSION`
  are restored one after another right after the worker starts (background,
  per-sponsor failures logged); before, the first sponsored job after a
  restart paid for the cold restore of a pool member (live: 6 min restore
  plus catch-up of a 20 h old state, every other job queued behind it).
  Concurrent pool jobs now spread round-robin across the members (the LRU
  touch happens before the first await).
- **A sponsored call that did not APPLY is a failure, not a success.** A
  transaction can sit in a block with only its guaranteed part (the fee)
  applied and the contract-call segment rejected (ledger `PARTIAL_SUCCESS`,
  typically the call lost a concurrent write to the same contract state). The
  unbound sponsor path now reads the ledger result from the indexer after the
  transaction landed and fails the job with the failed segment ids
  (`SponsoredCallNotAppliedError`); the caller rebuilds against the current
  contract state (see the boundary entry below for why the sponsor does not).
  Before, such a job reported `succeeded` and the caller's next call failed
  with `expected a cell, received null`.
- **Sponsoring latency.** The sponsor's dust spend is proved with the
  facade's proving service (the proof server in server mode) instead of
  always in-process wasm, which was ~45 s of every sponsoring on the hosted
  box; the unbound submit returns at `InBlock` (`NIGHTGATE_SPONSOR_WAIT=
  finalized` restores the old wait) and then waits until the public indexer
  has the transaction (`NIGHTGATE_SPONSOR_INDEXER_VISIBLE_MS`, default 30 s
  cap; a caller that builds its next call right away reads contract state
  from that indexer, and between InBlock and indexing it served an
  inconsistent state: `expected a cell, received null`); the txbuilder
  retries a build once on that read; the client SDK polls every 2 s (was
  5 s). Measured hosted: 64-88 s per sponsored transaction before, ~10 s after
  (warm sponsor, proof server).
- **Configured platform sponsor sessions do not expire.** The sessions in
  `NIGHTGATE_FEE_SPONSOR_SESSION` are infrastructure: `resolveFeeSponsor`
  ignores their `expiresAt` and the 15-min cleanup sweep skips them. Before,
  the pool silently died 24 h after setup (`sessionTtlMs`) and the sweep even
  wiped its key material (live: the hosted pool, 2026-08-19). Existing pools
  set up before this release must be re-created once if they already
  expired.
- **Submit watchdog.** A sponsor submit whose `Finalized` watch never fires
  (the node closed the socket under the subscription; the SDK client has no
  auto-reconnect after its own disconnect) no longer pins the job until the
  TTL: after `NIGHTGATE_SUBMIT_WATCH_TIMEOUT_MS` (default 60 s) the watch is
  abandoned, the client evicted, and the indexer asked for the transaction
  identifier; on-chain counts as landed, otherwise the outcome is AMBIGUOUS
  and the job ends `reconciliation_required` for the indexer confirmer (never
  a second broadcast, see below). Live: a content-root anchor hung 13+ min
  with the node idle.
- **txbuilder: `proofServerUrl`.** Prove the contract circuit on a
  holder-owned proof server instead of in-process wasm (native,
  multi-threaded: `attest` 7-9 s instead of 25-35 s; the 38 MB comparison
  circuit minutes faster). It receives the witnesses, so only ever a proof
  server you run yourself. `builder.provingMode` says which is active. The
  builder now opens ONE indexer public-data provider (it leaked one WebSocket
  per `buildSponsorable` before).
- Review hardening on the new pool: a backing lease carries a token, is
  RENEWED while its job works (the TTL is a crash backstop, an active lease
  is never taken over by time) and released ownership-checked;
  `NIGHTGATE_NOTE_LEASE_MS` is validated (positive integer, else the 5 min
  default); the dedicated submit clients reserve their pool slot
  synchronously (a concurrent first burst cannot exceed the cap of 8 clients
  while the SDK import is pending); benched pool members are EXCLUDED from the
  unbound candidate list for their cooldown (not merely sorted last); a dust
  race that outlives its retries fails the job without benching the sponsor
  (it is the caller's transaction losing, not a sponsor-health problem); a
  GENERIC pool Invalid (no ledger code) gets one rebuild at most (each costs a
  full dust proof and it may be a caller-side invalid transaction); the SDK's
  `waitForJob` honours `timeoutMs` while polls fail transiently; the txbuilder
  declaration types `buildSponsorable` as a discriminated union with
  overloads, so a 0.17 consumer's `finalizedTxB64: string` still compiles.
- **The unbound sponsor path crosses the external-effect boundary BEFORE it
  broadcasts.** The worker announces the transaction identifier over the RPC
  channel (`submit-intent`) and waits for the main thread to record the
  boundary; only then does it send. The job crosses `external_execution` once;
  every broadcast ATTEMPT (a dust-race rebuild is a new transaction) gets its
  own `PendingSubmissions` row and is reported `submitted` with its
  identifier, the previous attempt's row is marked failed (`REBUILT`). A
  failure after a broadcast therefore ends in `reconciliation_required` with
  the identifier, never in a plain `failed` for a call that may be on-chain;
  if the boundary cannot be persisted, nothing is broadcast. Outcomes are
  classified by what they prove: a PRE-INCLUSION reject (1010/*, pool
  Invalid, closing socket, a nacked intent) cannot be on-chain, so the
  attempt is marked `REJECTED`, its hash is taken off the job
  (`reportSubmissionRejected`) and a rebuild may follow (an exhausted run is a
  plain `failed`); a call that landed but did NOT apply (`PARTIAL_SUCCESS`)
  is TERMINAL for the sponsor job (the caller's transcript is stale from a
  same-contract conflict; re-attaching fresh dust to the same caller bytes is
  rejected at admission every time, measured live: 6 losers x 4 retries x
  1010): the job fails `CHAIN_EXECUTION_FAILED` with the identifier straight
  from the runner (the worker proved the outcome via the indexer; job + attempt
  row in one write, no transient `reconciliation_required` that a polling
  client would read as terminal), the caller rebuilds against the current state; an AMBIGUOUS outcome (the watch
  timed out and the indexer did not know the transaction yet) is never
  rebuilt (two identifiers, two fees could land): the job ends
  `reconciliation_required` with its identifier. The indexer chain-outcome
  confirmer looks transactions up by IDENTIFIER (what the wallet SDK returns
  and NIGHTGATE stores as `txHash`, `hash` as fallback), is registered even
  with the crawler on (restricted to the identifier-keyed sponsor kinds,
  which the crawler's extrinsic-hash matching can never resolve), and also
  resolves `reconciliation_required` rows of those kinds: indexer SUCCESS ->
  `succeeded`, FAILURE/PARTIAL_SUCCESS -> `failed`, unknown -> stays.
  The BOUND channel (`sponsorFinalizedTransaction`) crosses the same boundary
  (it had none before, not even in 0.17): the worker announces the identifier
  between finalize and submit, the processor records the attempt, and a
  failover to the next pool sponsor closes the attempt row first. Restart
  recovery fails an identifier-keyed job that was waiting to rebuild after a
  provable reject (`external_execution` without a hash) as
  `PROCESS_RESTART_AFTER_REJECT` instead of parking it in reconciliation.
  Job row and attempt row are finalized in ONE transaction (reconcile pass and
  the regular succeeded-confirm pass alike, so a crawler-free deployment never
  leaves the `PendingSubmissions` row `included` under a confirmed job); the
  result written on a reconciled success is the CANONICAL action shape
  (`txHash`, `circuits`, `contractAddress`, `note`, `feeSponsor` = the
  CONCRETE sponsor, never the pool sentinel), rebuilt from the coordinates the
  worker announced with the intent (inspected contract + circuits, dust
  backing, paying account; stored in the attempt row's new INTERNAL column
  `submitIntentData`, excluded from the OData projection, `finalizedTxData`
  keeps its public meaning as the indexed-transaction snapshot; existing
  databases: `nightgate-schema-delta` adds the column); a nacked intent (job
  writes failed after the row insert) closes its attempt row `REJECTED`
  instead of leaving it pending.
- **txbuilder safety.** Server proving is an explicit opt-in
  (`provingMode: 'server'` + `proofServerUrl`): a bare `proofServerUrl`,
  documented as unused in 0.17, keeps in-process wasm, so an old value cannot
  start sending witnesses on upgrade. `bind: false` refuses a call whose
  recipe carries a balancing transaction (the sponsor binds the base alone;
  the vault circuits move no value, value-moving calls use the bound
  handover).
- **SQLite lock contention no longer 500s an admission.** The job-row INSERT
  retries a lost write lock like the status writes already did, and the busy
  timeout is 30 s (`cds.requires.db.client.timeout`; image env
  `NIGHTGATE_SQLITE_BUSY_TIMEOUT_MS`): a box that keeps many wallets warm saves
  multi-MB states for seconds at a time (live: `database is locked` on
  `sponsorFinalizedTransaction`).
- `@odatano/nightgate-tx` 0.2.0: `buildSponsorable` gained `bind`, the client
  `sponsorUnbound`, and `waitForJob` survives transient poll failures
  (429/502/503/504, network, timeout) for up to `pollGraceMs` (default 5 min)
  instead of losing a running job's handle (live: a reverse proxy answered
  one poll with 502 while the server was restoring a wallet; the job landed).

Not changed: concurrent writes to the SAME contract state still conflict at
the ledger (the caller rebuilds), and the bound channel stays serialized per
sponsor wallet; do not mix bound and unbound sponsoring on one wallet.

## 0.17.2 - 2026-08-18

Sponsor pool with failover; no circuit change.

- **`sponsorFinalizedTransaction` fails over across the platform pool.** A
  wallet carries ONE dust spend in flight (concurrent balances race its dust
  notes into 1010 rejects), so throughput scales with the NUMBER of sponsor
  wallets, not with one wallet's balance. The sessions in
  `NIGHTGATE_FEE_SPONSOR_SESSION` now form a lease pool: each sponsored job
  leases one wallet for its duration (callers queue on the pool, bounded by
  `NIGHTGATE_SPONSOR_LEASE_WAIT_MS`, default 120s), and a sponsor that fails
  RETRYABLY (cold facade, sync gap, stale dust `1010/170`) is benched for
  `NIGHTGATE_SPONSOR_COOLDOWN_MS` while the job tries the next one. Policy
  refusals and malformed transactions never retry: they would fail on every
  sponsor identically.
- **Pool grants.** `createAgentGrant` accepts the pool sentinel
  `00000000-0000-0000-0000-706f6f6c0000` as `sponsorSessionId` (a reserved
  UUID: every carrying surface is Edm.Guid): the concrete sponsor is chosen
  per job with failover. A sentinel grant may allow ONLY
  `sponsorFinalizedTransaction` (other actions cannot use the pool and would
  burn budget before failing); `getJobStatus` polls under the sentinel, and
  concrete member ids are normalized to it. Omitting `sponsorSessionId` on
  `sponsorFinalizedTransaction` uses the pool too, when one is configured. An
  EXPLICIT sponsor session stays exact: pinning is a security boundary. Pool
  jobs are KEYED under the sentinel (stable idempotency identity) and
  idempotency keys are scoped per caller, so shared sponsors never share a
  dedupe namespace. Admission validates nothing for pool jobs: a broken pool
  entry cannot block the request, resolution happens per candidate in the
  processor (resolution failures fail over too).

## 0.17.1 - 2026-08-18

Standalone-image fix for external agents; no runtime change for plugin
consumers, no circuit change.

- **Agent tokens pass transport auth on their own.** The image's basic auth
  401ed every request before the grant hook ran, so an external agent needed
  the OPERATOR's transport password alongside its `ngat_` token, which defeats
  per-agent tokens. The image now wires a custom transport auth
  (`srv/utils/agent-token-auth.ts`): basic credentials behave exactly as
  before; a request carrying `x-agent-token` passes for `/api/v1/nightgate`
  ONLY, where `enforceAgentGrant` performs the real authentication (invalid
  token 401 non-leaking, out-of-scope event 403, principal swapped to the
  grant's operator). All other services keep requiring basic auth; wrong basic
  credentials never fall through to the token lane. Found live: the first
  cross-machine sponsoring run against api.nightgate.dev.
- `@odatano/nightgate-tx` 0.1.2: `circuits` restricts only the heavy prover
  keys; verifier keys are always fetched for the contract's full circuit list
  (findDeployedContract reads them all, so 0.1.1's restricted first build
  died with ENOENT). Missing address-format shims fixed in 0.1.1; the slim
  check now installs the packed tarball into a clean prefix and imports every
  entry point, which is the probe that would have caught both.

## 0.17.0 - 2026-08-18

Cross-server fee sponsoring: a caller builds, proves and signs a contract call
on its OWN machine with its OWN key, and a separate NIGHTGATE server pays the
dust and submits. No circuit change, no vault redeploy: the compiled artifacts
and every verifier key are byte-identical to 0.16.0.

- **`sponsorFinalizedTransaction(finalizedTxB64, sponsorSessionId,
  idempotencyKey)`.** Takes a fee-unpaid, caller-signed, proven transaction as
  base64, enforces the sponsor's contract and circuit allow-list
  (`NIGHTGATE_SPONSOR_ALLOWED_CONTRACTS` / `_CIRCUITS`), balances dust with the
  sponsor session and submits. The sponsor never sees a key, a witness or a
  preimage: by the time the bytes arrive, the proof is done, and the on-chain
  attestation carries the CALLER's attester id.
- **`buildSponsorable(...)`** produces exactly those bytes server-side, for
  callers that keep their session on a NIGHTGATE instance of their own. Phase 1
  and phase 2 can run on different machines with only transport between them.
- **`@odatano/nightgate/txbuilder`**: the same phase 1 as a standalone SDK.
  `createTxBuilder({ seedHex, indexerHttpUrl, indexerWsUrl, zkConfigBaseUrl,
  contractClass })` derives the caller's identity locally, fetches the prover
  keys from a public `/zk-config` into a disk cache (offline from the second
  run), proves in-process on wasm and returns `{ finalizedTxB64 }`. No CAP, no
  database, no proof server, no Docker; the seed and the attestation secret
  never leave the process. All `prepare*` helpers of the browser export feed
  straight into it. Documented in `docs/txbuilder.md`.
- **`probeCrossServerSponsor(...)`** runs both phases in one job against a live
  network, as a deployment self-check for a sponsor operator.
- **The sponsor policy is a fail-closed SHAPE check.** Review finding: the
  allow-list only inspected the contract calls it FOUND, so a transaction with
  one allowed call plus a deploy, an unshielded transfer, a zswap offer or its
  own dust actions passed, and the sponsor paid for the whole envelope. Now
  everything that is not an allow-listed contract call refuses, unreadable
  structure refuses, and `NIGHTGATE_SPONSOR_MAX_TX_BYTES` (default 65536) caps
  the size; a value that is not a positive integer falls back to the default
  instead of disabling the cap. The response also returns the sponsor `sessionId` the job is keyed
  by, so agent-grant callers (which never see the injected sponsor id) can
  poll; the SDK prefers that server-returned session. `mintShieldedTestToken`
  rejects a foreign `compiledArtifactRef` (the result enrichment is
  fixture-specific), and the SDK's `sendNight` now waits for the job like
  every other write method.
- **`sponsorFinalizedTransaction` is agent-grantable.** The transaction arrives
  proven and signed, so a grant spends nothing but the pinned sponsor's dust,
  which is exactly what sponsor pinning and the daily budget already meter; the
  on-chain effect carries the builder's identity, never the session's.
  `getJobStatus` may poll under the grant's pinned sponsor session (phase-2
  jobs are keyed by it); a WRITE naming that session still rejects.
  `deriveTokenType` and `prepareMembershipSet` join the always-allowed
  compute-only surface (the latter closes a gap: it was exposed as an MCP tool
  but denied under a token). `buildSponsorable` and `mintShieldedTestToken`
  stay non-grantable.
- Sponsored callers with no coins can skip wallet sync entirely
  (`NIGHTGATE_SPONSORED_CALLER_SYNC=skip`), which is what makes a throwaway
  caller identity usable within seconds.
- New live lanes: `npm run txbuilder:e2e` (local build, remote sponsor, the
  real split) and `npm run cross-server-probe:e2e` (both phases server-side).
- **`@odatano/nightgate-tx`, the client SDK (0.1.0).** Every capability of a
  hosted NIGHTGATE as a callable function (the MCP server's surface, for code):
  crawler-free verification, document ingestion, the ZK attestation actions,
  disclosure, tokens, cross-server sponsoring, and job polling that submits and
  waits in one call, plus the local txbuilder for the part no hosted API can
  offer (your key stays on your machine). Under 1 MB packed, six entry points
  (`.`, `./client`, `./txbuilder`, `./calls`, `./attestation-vault`,
  `./set-root`), no `@sap/cds` anywhere in its dependency closure. GENERATED
  from this tree by `npm run build:slim`, file by file at the same relative
  path, so the call builders and witnesses stay the same code the server uses;
  `npm run check:slim` resolves every entry point the way a consumer does and
  fails if a proving artifact ever lands in the tarball. The client is also a
  subpath of the main package (`@odatano/nightgate/client`). Runnable example
  in `packages/nightgate-tx/example/anchor.mjs`.
- **`mintShieldedTestToken` + `deriveTokenType`.** The bundled
  `contracts/shielded-token` shipped compiled artifacts but had no first-class
  surface: using it meant a generic `submitContractCall` plus knowing the
  contract's domain separator to compute the token type by hand.
  `mintShieldedTestToken(contractAddress, sessionId)` mints and returns the
  `tokenTypeHex` you then hand to `sendNight`, and `deriveTokenType` exposes the
  derivation on its own for any minting contract.

## 0.16.3 - 2026-08-17

Diagnoses and fails fast on the ledger constraint that kills dependent batched
calls. No circuit change, no vault redeploy: the compiled artifacts and every
verifier key are byte-identical to 0.16.0.

- **Root cause of the `1010/188` rejects.** Every contract call is split into a
  GUARANTEED and a FALLIBLE transcript by the SDK's `partitionTranscripts`,
  allocated by GAS COST. The ledger applies all guaranteed stages before any
  fallible one and rejects a transaction where a fallible call is followed by a
  guaranteed one, since the later call would read state its predecessor has not
  written yet. Per-call cost grows with contract state, so a dependent batch
  flips from valid to invalid as the contract fills up, with no change on the
  caller's side. Live on preprod: batches 1 and 2 of
  `attest -> anchorContentRoot -> bindPassport` landed with all calls
  guaranteed, batch 3 was rejected once `attest` crossed into the fallible
  stage (5.34G guaranteed vs 6.04G fallible).
- This supersedes the 0.15.3 reading ("a call that updates an existing ledger
  cell must not be followed by another call"), which was the special case of an
  expensive call: updating calls are simply costly, and ordering them last
  worked because nothing behind them could be starved.
- **Fail fast instead of a blind reject.** `submitContractCallBatch` now checks
  the partitioning BEFORE proving and aborts with an error naming the offending
  pair, rather than spending proof generation and balancing on a transaction
  the node will reject with a bare `1010/188`. The job fails with the stable
  code `BatchCausalityViolation` (never retryable: nothing was submitted and
  the shape is deterministic for the current contract state). Fail-open by
  construction: if a future SDK exposes no transcripts, nothing is blocked.
- **The partitioning is logged** for every multi-call batch, with each call's
  execution budget:
  `[nightgate:batch-segments] rewrite: ... -> attest=1158[f:6.04G] anchorContentRoot=52208[g:4.77G]`.
- `docs/actions.md` documented the now-superseded cell-update rule and used the
  affected order as its example; it now carries the causality rule, the
  measured numbers and the consequences for callers.
- New live lane `npm run anchor-batch:e2e` (deploys a throwaway vault,
  populates it via `REPRO_PREFILL=N`, submits the anchor batch as a fresh bind
  and as a same-owner rebind), and the runner is back on the current
  `anchorContentRoot` signature.
- Consumers: splitting the expensive leading call into its own transaction is
  the durable shape. Live-verified over 8 consecutive rounds on a growing
  vault, both remaining calls stayed guaranteed.

## 0.16.2 - 2026-08-16

Release-tooling fix; no runtime, circuit or packaged-code change (the
compiled vault artifacts and every verifier key remain byte-identical to
0.16.0, so a vault deployed with 0.16.0 stays valid).

- The tag workflow's gate job ran `check:release` on a fresh checkout,
  where `cds-typer` has not generated `@cds-models` yet, so `typecheck`
  failed on every service import and no release or image was produced.
  `check:release` now builds first, which makes the chain self-sufficient
  for all three callers (CI, the tag workflow, `prepublishOnly`).
- New `npm run check:fresh-tree`: runs the release gates in a throwaway
  clone with no generated artifacts and a fresh `npm ci`, which is what
  CI actually sees. A locally grown working tree hides missing build
  outputs and optional native modules; this reproduces them.

## 0.16.1 - 2026-08-16

Packaging and tooling fixes; no runtime or circuit change (the compiled
vault artifacts and every verifier key are byte-identical to 0.16.0, so a
vault deployed with 0.16.0 stays valid).

- The schema migration and its integration lane ran on `better-sqlite3`,
  an OPTIONAL peer of `@cap-js/sqlite` that a clean install does not
  guarantee (CI on Node 24 had none). Both now use Node's built-in
  `node:sqlite`, so `npx nightgate-schema-delta` needs no native module;
  `better-sqlite3` remains a fallback for older runtimes. The migration
  keeps its all-or-nothing transaction, now via explicit BEGIN/COMMIT.
- `npm run clean` deleted EVERY `.d.ts` under `src/` and `srv/`,
  including the hand-written browser declarations that have no `.ts`
  source. A build from a freshly cleaned tree therefore lost
  `src/browser/index.d.ts` and shipped an untyped browser entry. Clean now
  only removes files whose `.ts` source sits next to them.
- `check:exports` additionally fails when a packed file is neither tracked
  by git nor build output, which is exactly the gap that let the missing
  declaration pass unnoticed locally.

## 0.16.0 - 2026-08-16

Cross-root document diff proofs: the first BINARY vault circuits, relating
TWO anchored content roots in one proof.

- **Integrity mode** (`issueDocumentIntegrityAttestation`): prove document
  B differs from document A ONLY in the slots flagged by a public 16-bit
  `allowedMask` (bit i = slot i may differ), values hidden. The canonical
  version-integrity claim for re-anchored passports: "v2 changed nothing
  outside the allowed field set". The proof witnesses the shared schema
  descriptor list plus both documents' full openings (salt seed + slot
  values), recomputes both salted content roots in-circuit and asserts
  value equality outside the mask. A field that changed, appeared or
  disappeared outside the mask fails the proof.
- **Distinctness mode** (`issueDocumentDiffAttestation`): prove at least
  `k` of the 16 aligned slots differ between two anchored documents,
  without revealing which slots or what values. k=1 is "provably not the
  same document"; higher k is the distinctness claim (USDA-style "differs
  at enough loci"). Both modes share one v4 witness model
  (`schemaJson` + `openingAJson`/`openingBJson`, see below) and compare on
  VALUE level under the shared schema. Absence policy: both-empty is no
  difference, present-vs-absent IS a difference, a changed value is a
  difference, padding slots never count.
- **Anchors carry a PROVEN schema id** (`anchorContentRoot(payload_hash,
  content_root, schema_id)`, new `content_schemas` ledger map): the
  schema id is the depth-4 root over the 16 slot DESCRIPTORS
  (fieldKey/kind/scale; `prepareDocumentProof` returns it plus the
  descriptor list as `schema`; `computeSchemaId` is exported).
  `proveDocumentComparison` witnesses ONE shared descriptor list,
  RECOMPUTES the schema root in-circuit and asserts it against BOTH
  anchors, then recomputes both content roots from the witnessed openings
  under that schema. Schema parity is therefore structural AND the
  anchored label is proven to describe the trees: an attester who anchors
  document B under document A's schema id while B's tree was built over a
  different field list cannot run the comparison (adversarial repro pinned
  in `integration:attestation-vault`). All anchoring actions take a
  `schemaId` param (required whenever a contentRoot is supplied), and
  `verifyAttestationState` gains a `schemaId` param + `schemaOk` result so
  verifiers can check the anchored schema (and `attesterId`) crawler-free.
- **Salted leaves** (v4 leaf rule): every content-tree leaf (uint, bytes
  AND absent slots) carries a per-slot salt derived from a per-document
  32-byte seed (`slotSalt` pure circuit; `prepareDocumentProof` generates
  the seed, accepts `saltSeed` for deterministic re-prepare, and returns
  the full `opening` bundle plus a per-field `salt`). Shared leaf hashes
  are no longer dictionary-testable and do not reveal the presence
  pattern. CONSUMER: the opening (seed) is the document's commitment
  material, STORE it; the single-field proof actions now REQUIRE
  `fieldSalt` (batch claims: `salt`), and the cross-root actions take
  `schemaJson`/`openingAJson`/`openingBJson` instead of leaf layers. The
  equality proof's public digest statement is unchanged (the digest is the
  statement), but running it now needs the slot salt.
- **Anchoring is insert-once-or-identical**: re-anchoring an
  already-anchored payload with a different root or schema id is rejected
  in-circuit ("content root already anchored" / "schema already
  anchored"); an identical re-anchor stays a no-op. Previously the owner
  could silently overwrite an anchored root, invalidating every claim
  proven against it. Also in-circuit: a document cannot be compared with
  itself (`payload_hash_a != payload_hash_b` asserted; previously
  server-side only).
- Both modes run through ONE mode-switched circuit,
  `proveDocumentComparison(a, b, mode, allowedMask, k)` (mode 0 =
  integrity, mode 1 = diff; the inactive statement rides as a neutral
  dummy). One circuit instead of two because every exported circuit adds a
  2119-byte verifier key to the DEPLOY transaction, and the node caps a
  transaction's written bytes at 32 KiB: the 13-circuit vault deploy wrote
  33,361 bytes and was rejected as `1010: Invalid Transaction: Transaction
  would exhaust the block limits` (empirically bisected on preprod;
  31,781-byte deploys are accepted). The 12-circuit merged vault writes
  ~31.2 KiB. The claim structs, claim keys and result maps are unchanged,
  so verifiers see no difference.
- Both claim kinds are batchable via `issueFieldPredicateAttestationBatch`
  (`predicate: 'documentIntegrity'` / `'documentDiff'` entries carry
  `payloadHashB` plus `schema`/`openingA`/`openingB`; document A is the
  batch payloadHash), verifiable crawler-free via `verifyPredicateState`
  (new `payloadHashB` / `allowedMask` / `k` params) and
  `verifyPredicateAttestation`, and grantable to agents.
- Slot alignment is positional: both documents MUST be prepared with the
  SAME ordered proofFields list. (A, B) order is part of the claim key;
  verify with the proving order.
- **Tree hashing moved to transient hashes**: every in-circuit tree hash
  (`leafHash`, `nodeHash`, `bytesLeafHash`, `setLeafHash`) is now
  `upgradeFromTransient(transientHash<...>(...))` instead of
  `persistentHash`. In-circuit SHA-256 costs ~2.7 MB of prover key PER
  INSTANCE; the algebraic transient hash costs ~0.13 MB once and is
  near-free per additional instance (measured with compiled probe
  contracts). Claim keys stay `persistentHash` (claims ARE stored state
  identity), so all recorded claim keys and the crawler-free recomputes
  are unchanged. CAVEAT per the Compact docs: `transientHash` is "not
  guaranteed to persist between [Compact] upgrades", so a future compactc
  upgrade that changes the transient hash changes every content/set root;
  that already implies the redeploy-and-re-anchor procedure the vault has
  for any leaf-rule change, and anchors are cheap to re-issue. Prover
  sizes: `proveDocumentComparison` drops 290.4 MB -> 38.5 MB (still the
  vault's largest; the in-circuit salted-root recompute over three leaf
  families costs more than bare leaf folding, and stays in the
  wasm-proven 0.15.0 size class), the whole vault ~76 MB. That removes
  the 0.16.0-rc wasm limit: ALL circuits, cross-root included, prove in
  in-process wasm mode again, no proof server required; the compose
  proof-server memory limit is raised to 12G for the 38.5 MB circuit (4G
  containers were OOM-killed under far smaller ones).
- CONSUMER: vault REDEPLOY required (new verifier-key set, empty ledger,
  re-anchor, same procedure as 0.15.0; bundle the two). The
  `PredicateAttestations` table gains `payloadHashB` + `allowedMask`
  columns (cds deploy or schema delta). BREAKING for external content-root
  builders (NIGHTPASS passport-anchor.ts): the leaf/node rule is now the
  contract's transient hash, so roots MUST be computed via the artifact's
  pure circuits (as `srv/submission/document-proof.ts` does) rather than
  reimplemented with a generic hash library; additionally the padding-slot
  key changed from a blake2b digest to
  `pad(32, "nightgate/empty-leaf/v2")` (a Compact literal cannot express
  an arbitrary digest; the constant lives in the contract as the
  `emptyLeafKey()` pure circuit and byte-parity is pinned by tests).
- **Vault constructor now takes the registrar as a PUBLIC argument**
  (`constructor(initial_registrar: Bytes<32>)`), replacing the
  witness-derived `disclose(caller_id())`: shrinking the deploy was the
  first response to the 32 KiB write cap, and the arg constructor is kept
  because it is lighter and strictly more flexible. NIGHTGATE's worker
  injects the deploy session's attester id automatically (`persistentHash`
  over the same secret the `local_secret_key()` witness serves), so
  "registrar = deploy session" semantics are unchanged; external deployers
  must now pass the argument and MAY point the registrar at a different
  identity. Deploy-time attester-id parity with the in-circuit
  `caller_id()` is pinned in `integration:attestation-vault`.
- The 32 KiB per-transaction write cap is documented for the Midnight team
  with the full probe matrix; the node's error string does not name the
  overflowing dimension, and the worker now logs every transaction's
  serialized size and ledger cost (`Transaction.cost`) before submit so
  future cap hits are diagnosable from the field.
- **schemaId binds the full slot interpretation** (soundness fix): the
  schema descriptors carry `kind` and `scale`, not just the field keys.
  Without them, x=1 at scale 1000 and x=1000 at scale 1 produce the SAME
  leaf value and previously the same schema id, so a mask-0 integrity
  proof could claim "unchanged" across a 1000x reinterpretation; now the
  two anchor different schema ids and the in-circuit schema recompute
  rejects the comparison. Tree-hash generation binding: schema root and
  content roots are computed by the SAME artifact hash, so a compactc
  generation change (redeploy) can never mix root generations.
- **BREAKING: the commitment-only predicate lane is removed**
  (`issuePredicateAttestation` action, `commitValue`/`provePredicate`
  circuits, `value_commitments`/`predicate_results` ledger maps, the
  `attested_value`/`value_salt` witnesses and the browser `WitnessValues`
  surface). Root cause: `commitValue` overwrote the stored commitment
  while `PredicateClaim` did not embed it, so replacing the commitment
  (which every new issue call did, with a fresh salt) left all previously
  recorded claims verifiable against an opening that no longer matched.
  Only immutable, root-bound field claims remain; numeric claims now
  REQUIRE `fieldKey` in `verifyPredicateState`, the unverified
  `valueCommitment` passthrough parameter/column is gone (the PAC
  envelope's `digestMultibase` is now null and its `proof.circuit` is
  derived from the predicate kind), and the vault drops two verifier keys
  (~4.2 KB deploy budget) plus ~5.6 MB of prover keys.
- **In-circuit range guards** for direct contract callers:
  `proveFieldPredicate` asserts `op <= 1` (any other value used to
  silently select greaterOrEqual), `grantDisclosure` asserts `level <= 2`,
  and `proveDocumentComparison` pins the INACTIVE mode's argument to its
  neutral dummy (integrity: k == 1; diff: all-false mask), so a
  transaction's public args never suggest a statement the circuit did not
  check.
- Handler hardening: `value`/`threshold` are bounded to Uint<64> up-front,
  and raw membership allow-lists are capped at 1024 entries before
  hashing (64 distinct values as before; `prepareMembershipSet` enforces
  the same raw cap).
- **Vacuous integrity masks are rejected IN-CIRCUIT** (soundness fix): a
  mask that frees every REAL (non-padding) schema slot says nothing
  ("everything may differ"), and a server-side 400 alone left direct
  wallet callers able to record that claim on-chain.
  `proveDocumentComparison` mode 0 now asserts at least one constrained
  real slot ("mask must constrain at least one schema slot"), which
  subsumes the all-ones mask AND masks freeing every real slot of a
  shorter schema. Server (single action + batch) and the browser helper
  reject the same class schema-aware with a clean error; real-artifact
  negatives (all-ones and 4-field-schema 0b1111) and browser negatives
  are pinned.
- **Canonical-slot guard** (soundness fix, in-circuit): the witnessed
  schema descriptors are range-checked BEFORE any root math. An
  out-of-range `kind` used to land on the absent leaf in `slotLeaf` but
  compare as a bytes field in `slotDiff`, so two all-absent roots could
  prove a fabricated k=1 diff. `proveDocumentComparison` now asserts
  `kind <= 2` for all 16 slots, `scale == 0` for non-uint slots, and the
  canonical empty key + absent openings for padding slots (adversarial
  repro for kind 3 and 255 pinned in `integration:attestation-vault`;
  ~2 KB prover-size cost).
- **Holder/attester privilege separation (browser)**: the proof circuits
  never invoke `local_secret_key`, so the browser proof helpers
  (`prepareProveFieldPredicate`/`Equality`/`Membership`, both cross-root
  helpers) no longer require `attestationSecret`, and
  `buildAttestationVaultWitnesses` accepts a secret-less witness set (the
  witness throws only if an owner-gated circuit actually resolves it).
  `CONTRACTS['attestation-vault'].attesterGated` drops the proof circuits
  accordingly. A holder proving against an anchored root never receives
  the owner secret.
- **Document evidence binding**: `Documents` rows persist `userId`,
  `contractAddress` and `network` at anchor time. `verifyDocument` treats
  the RECORDED anchoring vault as authoritative: a caller-supplied
  `contractAddress` may only confirm it (mismatch = 400), so a different
  vault attesting the same public hash can no longer make a document
  appear verified. Rows from earlier releases carry nulls and keep the
  caller-supplied behavior.
- **Owner-scoped reads for `Documents` and `GranteeIdentities`**
  (previously readable by every authenticated user, exposing `storageRef`
  paths, not-yet-public hashes and userId->grantee bindings): non-admin
  reads are filtered to the requesting user, like `WalletSessions`.
  Cross-user verification stays possible via `verifyDocument` (the
  documentId is an unguessable capability handle; the response carries no
  `storageRef`). `getJobStatus` ownership is now FAIL-CLOSED: the job's
  recorded `requestedBy` must match the caller (admins exempt); a
  missing/closed session row no longer opens the job up.
- Ops/delivery hardening: startup schema preflight probes the release's
  NEW COLUMNS (`Documents.userId/contractAddress/network`,
  `PredicateAttestations.payloadHashB/allowedMask`), so a previous-release
  database fails at boot with the migration hint instead of at the first
  action; `apply-schema-delta.mjs` takes the db path as argument /
  `NIGHTGATE_DB_PATH` (Docker's `/data/nightgate.db`) instead of
  hardcoding `db/midnight.db`; the compose image tag follows the release
  (`NIGHTGATE_IMAGE_TAG` override); `/zk-config` responses drop
  `immutable` for `no-cache` + content-hash ETag revalidation (the URL is
  not content-addressed, and a redeploy must not leave browsers on
  year-old keys); `@midnight-ntwrk/compact-runtime` is pinned EXACTLY to
  0.16.0 (`transientHash` is not guaranteed stable across runtime
  upgrades and published roots depend on it); an explicitly configured
  invalid `NIGHTGATE_NETWORK` now REFUSES to start instead of silently
  falling back to preprod; the compose proof-server binds to
  127.0.0.1 only (unauthenticated, proving requests carry private
  witness data); `SyncState.nodeUrl`, `getStatus` and startup logging
  strip URL-embedded credentials; `getReadiness` treats a deliberately
  disabled crawler as not-applicable (new `crawlerEnabled` result field)
  instead of reporting a healthy submission-only deployment as
  `ready: false`; agent grants can allowlist
  `issueFieldEqualityAttestation`/`issueFieldMembershipAttestation`
  (batch parity).
- **Guarded attest: commit-reveal with front-run takeover** (new
  `attestGuarded` circuit, the vault's 11th; 23.3 KB of verifier keys
  total, deploy stays well under the 32 KiB write cap; its prover is
  5.2 MB). Plain `attest` is first-come-first-served AND insert-once, so a
  mempool observer could permanently claim a visible payload hash. The
  guarded path commits an opaque commitment
  (persistentHash{payload, metadataHash, nonce}) first and reveals later;
  SEQUENCING makes it effective although plain attest keeps existing:
  every attestation records its creation sequence
  (`attestation_seqs`/`attest_seq_next` ledger state, plain attest
  records it too), and a reveal whose commitment PREDATES the current
  attestation takes it over in-circuit (the sniper cannot forge an older
  commitment without the nonce; a NEWER commitment cannot re-take, no
  ping-pong). A takeover erases EVERY effect of the sniper's ownership
  window: the sniper-anchored content root + schema are removed, the
  payload's disclosure grants are removed, and claim results recorded
  during that window stop verifying, because ALL FIVE claim keys now
  embed the payload's **attestation epoch** (`attestation_seqs`; cross-root
  claims embed both documents' epochs) and the takeover moves it, while
  the crawler-free readers always recompute claim keys with the CURRENT
  epoch from ledger state (a claim under a stale epoch misses the map by
  construction; sequence values are unique, so a stale epoch never
  recurs). Commitments are CONSUMED on every successful reveal
  (one-shot): without that, replaying an already-successful reveal would
  satisfy the takeover comparison against the revealer's OWN attestation
  and delete a meanwhile-anchored root, bypassing insert-once. Server
  surface: `prepareAnchorCommitment` (compute-only; returns commitment +
  SECRET nonce), `commitDocumentAnchor` (async commit), and
  `anchorDocument` gains an optional `nonce` param (reveal). Browser:
  `prepareAttestCommit`/`prepareAttestReveal`. Off-chain commitment
  recompute (`computeAttestCommitment`) is byte-identical to the circuit;
  pinned in `integration:attestation-vault`: the full sniper scenario
  (attest + anchor + claim + self-grant, then takeover with root/grant
  removal and the claim dead under the current epoch) AND the
  reveal-replay repro (rejected, anchored root survives). BREAKING for
  claim-key recomputes: `computeFieldPredicate/Equality/MembershipClaimKey`
  take an `epoch`, the cross-root computers take `epochA`/`epochB`;
  `verifyPredicateState`/`verifyPredicateAttestation` read the epoch from
  the same state query automatically. Commit-reveal protects payload
  hashes that are secret until reveal; for publicly known identifiers
  registrar pre-assignment (`registerPassport`) remains the answer.
- **BREAKING (browser): the signature-derived attester secret is
  REMOVED** (`deriveAttestationSecretFromSignature`,
  `ATTESTER_SECRET_MESSAGE`). A signature over a fixed public message is
  shareable authentication evidence, not key material: any dApp that got
  the user to sign the same message derived the SAME attester identity
  and could run every owner-gated circuit as it. Replacement flow:
  `generateAttestationSecret()` (random 32 bytes) +
  `sealAttestationSecret`/`openAttestationSecret` (WebCrypto AES-256-GCM
  under an HKDF-derived key; the unlock material MAY be a wallet
  signature because it only decrypts a ciphertext held in the dApp's own
  origin storage, it is not the secret). The browser bundle check pins
  the removal so the footgun cannot resurface.
- **Network/database binding, fail-closed**: an existing `SyncState` row
  from ANOTHER network now refuses the boot (central in `initialize()`,
  so submission-only deployments are covered too, not only the crawler
  path); the error demands a separate database per network. A legacy row
  WITHOUT a recorded network is no bypass either: a demonstrably empty
  index (no blocks) is bound to the configured network in place, a
  populated one refuses to start unless the operator confirms the
  binding once via `NIGHTGATE_ASSUME_DB_NETWORK=<network>`. The same
  pass backfills credential-redacted `nodeUrl` values persisted by
  earlier releases, and `MidnightNodeProvider` redacts the node URL in
  its connect log and connection errors (which feed `lastError`/status).
  `facadeConfigFromEnv` now THROWS on an invalid configured network, so
  every submission/job/provider entry point is fail-closed even though
  the CAP host stays online after a rejected init.
- **Evidence provenance completed**: `Documents` additionally records
  `compiledArtifactRef`; `PredicateAttestations` gains `network` +
  `compiledArtifactRef`. `verifyDocument` and `verifyPredicateAttestation`
  verify against the RECORDED vault/artifact/network (caller parameters
  may only confirm the recorded coordinates; the crawler-free state
  fallback reads the recorded network's indexer instead of the currently
  configured one). Pre-0.16.0 rows carry nulls and keep the old behavior.
- **Artifact GENERATIONS are pinned by digest** (the registry name alone
  is a mutable alias: `registerContract` overwrites, so after an upgrade
  or re-configuration the same `compiledArtifactRef` can resolve to a
  different artifact). `getArtifactGenerationDigest` canonically hashes
  the FULL registration: the Compact-emitted module, the
  `privateStateId` (for the vault that is an attester identity: the same
  paths under a different id are a DIFFERENT registration) and every
  proving-relevant asset (`keys/*.verifier`, `keys/*.prover`, `zkir/*`),
  each length-prefixed section-labeled; the per-name cache invalidates
  on register/unregister/clear. `startJob` stamps the digest into every
  persisted contract command, workflow CHILD commands INHERIT the
  parent's digest (so an alias re-pointed between workflow steps can
  never mix generations within one workflow, e.g. anchor from one
  artifact and proof from another), and both the executor AND the
  reconciliation finalizer compare fail-closed at run time: a re-pointed
  alias refuses to execute/finalize, and a digest-less command from an
  older release refuses too instead of silently running against today's
  registration (the reviewer's 0.15-deploy-job-executes-0.16 scenario).
  Evidence rows (`Documents`, `PredicateAttestations`) record the digest
  as `artifactDigest`, and the crawler-free verify paths return a clean
  negative when the recorded generation no longer matches what the alias
  resolves to. Historical generations stay usable by registering them
  under their own (e.g. versioned) alias. Note the granularity: ANY
  recompile yields a new generation (the emitted module embeds source line
  numbers in its assert messages), even when the verifier keys are
  byte-identical and a deployed vault therefore stays valid. Deliberate and
  fail-closed: re-issue the action, or re-register the exact artifact,
  rather than letting a command or an evidence row silently span two
  builds. The binding is TAMPER-PROOF at
  the registry seam too: registrations are stored as FROZEN CLONES and
  `getContractRegistration` returns the readonly snapshot (a caller's
  retained object is no longer a live handle into the registry), and
  `resolveContract(name, expectedDigest)` verifies ATOMICALLY: it
  captures the snapshot once, RECOMPUTES the digest from the files'
  current bytes (no cache) and imports exactly that snapshot, so neither
  a concurrent `registerContract` between check and use nor an asset
  overwritten in place under an unchanged path can swap generations
  (executor, reconciliation finalizer and both crawler-free verify paths
  all resolve through this pinned form; race/mutation repros pinned in
  the registry unit tests and the digest round-trip in
  `integration:contract-registry`).
- **Tag releases are gated by CI**: the `v*` release workflow now runs a
  `check` job (the SAME `check:release` script npm `prepublishOnly` and
  the test workflow use: lint, typecheck, full suite, real-artifact
  vault integration, legacy schema-delta migration, browser bundle +
  types, packed-tarball invariants) and verifies the tag version equals
  `package.json` BEFORE any registry login; image build/push and the
  GitHub release depend on that job, so a red gate can no longer publish
  (previously the test workflow only ran in parallel).
- **The migration actually ships**: `scripts/apply-schema-delta.mjs` is
  published (files allowlist) and installed as the `nightgate-schema-delta`
  bin; it resolves the package root itself, takes the db path as
  argument/`NIGHTGATE_DB_PATH`, and states its SQLite-only scope
  (PostgreSQL/HANA migrate via their own deployers). The Compact SOURCE
  of the shipped artifacts is published too (auditability).
  `check:exports` asserts both tarball invariants; `prepublishOnly` and
  CI additionally run the real-artifact `integration:attestation-vault`
  and the browser bundle check. The SQLite table-rebuild path (NOT NULL
  relaxations) now snapshots and restores the table's indexes and
  triggers inside the same transaction (previously DROP TABLE silently
  discarded operator-added ones), pinned by the new
  `integration:schema-delta` lane, which migrates a synthetic pre-0.15
  legacy database and asserts columns, data, index and trigger all
  survive (runs in CI). The browser type surface matches the runtime:
  `BuildWitnessesInput.attestationSecret` is optional in the
  declarations too, and the consumer-mode type check pins a secretless
  holder build. Sizes with the new circuit: provers 81.0 MB total, npm
  tarball 86.1 MB.
- Live lane: `npm run document-diff:e2e`; real-circuit integration proof
  (positive/negative for both kinds, absence policy, schema-mismatch
  abort, re-anchor rejections, A-vs-A rejection, op/level/dummy range
  rejections, empty-leaf parity, byte-exact claim-key parity incl.
  order-sensitivity) in `integration:attestation-vault`. The
  `predicate:e2e` lane is removed with its action; `state-verify:e2e`
  runs the field-bound predicate instead.

## 0.15.3 - 2026-08-14

- `classifySubmissionError` no longer conflates Substrate 1010 ("Invalid
  Transaction", a node VALIDITY reject) with 1014 ("priority too low", a
  POOL reject): invalid transactions now classify as `1010`, with the
  ledger's inner `Custom error: N` surfaced as `1010/N` (e.g. `1010/188`
  SequencingCheckFailure, `1010/170` InvalidDustSpendProof). The error is
  deep-inspected, so codes buried in SDK wrappers are found. BEHAVIORAL:
  consumers matching on errorCode `'1014'` for invalid transactions must
  also accept `1010`/`1010/N` (retryability is unchanged: false for both).
- New diagnosis lane `scripts/run-rebind-repro-e2e.mjs` (rebind-in-batch
  reject on populated vault state; captures the node's RPC-CORE line).
  Live diagnosis result: the ledger's sequencing check (1010/188) rejects a
  batch whose update of an existing cell is FOLLOWED by a later intent on
  populated contract state, independent of NIGHTGATE's segment-id handling
  (reproduced with untouched randomized ids). Consumers should order
  cell-updating calls LAST in a batch; insert-only batches are unaffected.
- Batch segment ordering keeps the proven id rewrite (the diagnosis
  exonerated it as a 1010/188 cause) and gains a diagnostic
  `NIGHTGATE_BATCH_SEGMENT_MODE=observe` that proves as-is with the
  randomized ids only logged; unknown mode values warn and fall back to the
  rewrite. Rebind-in-batch with the update ordered last is live-proven on
  the populated production vault (tx `c2fcb0d8765507a9…`).
- Reject classification (`classifySubmissionError` and the worker's
  pre-mempool detection) can no longer throw while inspecting an error: a
  throwing `[util.inspect.custom]` on an SDK error now degrades to a safe
  fallback instead of skipping job-failure handling or disarming the dust
  guard.

## 0.15.2 - 2026-08-13

Dust wedge protection plus a public set-root surface.

### Dust pending-note leak on pre-mempool rejects (live incident, preprod)

A submission rejected BEFORE the mempool (Substrate 1014 dust contention and
friends) could leak the spent dust note's in-flight marker: the SDK facade's
revert runs, but the dust wallet's sync filter can erase the pending marker
in the build-to-reject window, after which nothing ever reclaims the note. A
wallet whose whole dust sits in one note (the normal self-generation shape)
is then permanently wedged (`could not balance dust`, dustBalance 0 across
restarts); only a cold re-sync healed it. Upstream report drafted; NIGHTGATE
now defends itself:

- The worker serializes the dust sub-wallet BEFORE every build that books a
  dust spend and, when the submit dies provably pre-mempool (1010/1014/1016,
  deliberately not 1013 "already imported"), swaps in a dust wallet restored
  from that snapshot. Sync resumes from the snapshot's progress index like a
  restart warm-restore. Wired at every submit site: both wallet providers
  (contract lanes incl. sponsored), `sendNight`, dust register/deregister.
  Post-mempool failures never restore (a landed-but-failed tx has consumed
  its dust fee).
- The restored snapshot is persisted IMMEDIATELY under a bumped dust epoch,
  and the restore path WAITS (bounded) for the main thread's persist ack:
  a save tick that already serialized the pre-restore wallet drops its dust
  blob, acks of dust pushed under an older epoch never advance the
  confirmed baseline, and the main thread chains state-save persists in
  arrival order. A crash between restore and the next periodic save can no
  longer warm-restore the wedged state; `dustRestoreCount` counts only
  persist-CONFIRMED restores, so the e2e gate also proves durability.
- Reject classification reads the WHOLE error structure: the SDK buries the
  node's reject under generic wrappers (live: `(FiberFailure)
  SubmissionError: Transaction submission error` with the actual `1010:
  Invalid Transaction` only in the nested cause), so matching `err.message`
  alone never triggered the guard.
- LIVE-PROVEN on preprod (`npm run dust-wedge:e2e`): a dust-spending send
  whose ttl expires during proving dies pre-mempool (1010), the runner
  ASSERTS the guard lane ran INCLUDING the acked re-persist
  (`dustRestoreCount` 0 -> 1; a green balance alone would also be produced
  by the SDK's fast-path revert, the exact path that failed in the
  incident), the dust note survives, and a follow-up send succeeds
  (tx `00c61e25217f71e8…`).
- `getWalletBalance` gains `dustUtxoCount`, `dustPendingCount`,
  `dustPendingValue` and `dustRestoreCount` (times the wedge protection
  restored this wallet's dust state, process-lifetime): a wedged wallet
  (registered NIGHT, zero dust UTXOs, zero pending) is now distinguishable
  from a genuinely empty one. Manual heal for pre-0.15.2 wedges documented
  in the operations guide.

### `@odatano/nightgate/set-root` export

The canonical membership-set rule (digest, dedupe, sort, pad-with-last,
depth-6 fold) is now importable session-free: `buildMembershipSet`,
`membershipPathFor`, `canonicalSetDigests`, `SET_DEPTH`, `MAX_SET_VALUES`.
Dependency-clean (no CAP, no Node builtins; blake2b moved to a shared
`hashing` module, hex via `@noble/hashes`), so it loads in Node CJS/ESM and
browser bundlers alike; pure circuits stay a parameter. Consumers that
re-implemented the rule locally (read-side verifiers, golden-vector tests)
can now import it instead.

## 0.15.1 - 2026-08-11

Internal job-runner cleanup, no API or schema change. `startJob` now defers
detached job dispatch through the request context's `succeeded` hook (the
same commit signal CAP's own task queue uses) instead of polling up to 10
minutes for the job row to become visible. A rolled-back request no longer
schedules any work at all; the 2s durable command poller stays as the
safety net for persisted commands. Unit suite green (72 files, 1465 tests).

## 0.15.0 - 2026-08-10

ZK proofs for STRING fields: bytes equality and set membership, batchable
alongside the numeric predicates. Live-proven end-to-end on preprod
(`npm run membership:e2e`): equality proof (tx `8df02e14…`), mixed batch with
numeric + membership + dropped duplicate in ONE tx (`c4c56387…`), all three
claim kinds verified crawler-free, non-member 400 before proving, wrong-set
batch aborted at local proving with nothing on-chain. Unit suite green
(72 files, 1462 tests); `npm run integration:attestation-vault` additionally
drives both circuits through compact-runtime locally incl. byte-exact
claim-key parity and an adversarial padding-slot rejection.

### Two new AttestationVault circuits (redeploy required)

- `proveFieldEquality(payload_hash, field_key, expected_digest)`: the anchored
  content root carries, at `field_key`, exactly the value whose blake2b-256
  digest is the PUBLIC `expected_digest`. No value witness at all; the circuit
  rebuilds the bytes leaf from public inputs and folds the DEPTH=4 path.
  Authenticity/binding, NOT confidentiality (a low-entropy value's digest is
  dictionary-guessable, documented as such). Claim recorded in the new
  `field_equality_results` map.
- `proveFieldMembership(payload_hash, field_key, set_root)`: the field's
  HIDDEN value is one of a public allow-list (up to 64 distinct values)
  without revealing which. Two folds over the same witnessed digest: the
  DEPTH=4 content fold binds it to THIS passport's field, the new DEPTH=6 set
  fold proves membership in the canonical set tree. Claim recorded in
  `field_membership_results`.
- String fields enter the content root as `bytesLeafHash(field_key,
  value_digest)` leaves (new exported pure circuit, plus `setLeafHash` for
  the set tree). Numeric-only documents produce byte-identical roots to
  0.14.0.
- Canonical set rule (any verifier recomputes the root from the published
  list alone): digest each value (exact string, blake2b-256), dedupe, sort
  ascending, pad to 64 slots by repeating the last member digest. The
  padding deliberately repeats a REAL member so every tree leaf is a member
  digest; a designated empty-leaf constant would itself be provable as a
  member of any non-full list.
- CONSUMER ACTION: adding circuits changes the verifier-key set, so deployed
  vaults need a REDEPLOY, and a redeployed vault starts with an EMPTY ledger
  (registrar = the deploying session): switch the contract address and
  re-create needed state (attest, anchorContentRoot, bindPassport, grants,
  registrations). Same procedure as the 0.10.0 upgrade.

### New actions

- `issueFieldEqualityAttestation(payloadHash, fieldKey, expectedValue |
  expectedDigest, ...)` and `issueFieldMembershipAttestation(payloadHash,
  fieldKey, value | valueDigest, allowedValuesJson | setRoot + path, ...)`,
  both with optional in-flow content-root anchoring, fee sponsoring and
  idempotency like the numeric action. A membership value not in the list is
  a 400 BEFORE any job or rate-limit spend.
- `issueFieldPredicateAttestationBatch` accepts MIXED claim kinds (numeric +
  equality + membership in ONE transaction), discriminated per claim by
  `predicate`; per-kind dedup tuples; the per-call witness holder carries a
  proof bundle now. Distinct circuit names make batch segment ordering fully
  deterministic for mixed batches.
- `prepareDocumentProof` field specs gained `kind: 'uint' | 'bytes'`
  (bytes: string value entered as the digest of the EXACT string, no
  trimming; `scale` not allowed). Response fields carry `kind` and
  `valueDigest` for bytes leaves.
- `prepareMembershipSet(allowedValuesJson, value?, valueDigest?)`
  (compute-only): canonical set root, member count and, for a member, the
  inclusion path (witness material, never logged).
- `verifyPredicateState` verifies the new kinds crawler-free via
  `predicate: 'bytesEquality'` + `expectedDigest` or `predicate:
  'setMembership'` + `setRoot`; `verifyPredicateAttestation` falls back to
  live state for the new rows too and returns their statement columns.

### Schema and internals

- `PredicateAttestations`: `op`/`threshold` are now nullable (the bytes kinds
  carry neither), new `expectedDigest` and `setRoot` columns. Operators:
  `cds deploy` or `scripts/apply-schema-delta.mjs` on existing databases.
- `apply-schema-delta.mjs` learned constraint RELAXATION: when a column's
  NOT NULL was dropped in the target schema, the table is rebuilt in place
  (create target shape, copy rows, swap; views dropped up front and
  recreated), still inside one transaction. Additive-only migrations could
  not express the op/threshold change. Views the DDL does not manage
  (consumer-added) are snapshotted and restored, never silently deleted; if
  one cannot be restored, the migration reports it with its original SQL and
  ABORTS, rolling the whole transaction back (database unchanged, view
  included).
- One predicate-literal parser replaces the four duplicated validation
  chains (an unknown literal can no longer mint a wrong op code).
- Witness layer: new `field_digest`/`set_siblings`/`set_dirs` witnesses; the
  per-call `merkleProof` became a bundle `{ fieldValue?, fieldDigest?,
  siblings, dirs, setProof? }` end-to-end (handlers, submitter, worker,
  browser mirror). The browser export ships `prepareProveFieldEquality` /
  `prepareProveFieldMembership` and the extended witness typings.
- Committed artifact grows by the two prover keys (~19.5 MB equality,
  ~38.5 MB membership, two Merkle folds).

## 0.14.0 - 2026-08-07

Live-proven end-to-end on preprod (`npm run agent-layer:e2e`): grant-token
lane incl. 403 negatives, agent-anchored document, content root + 2 field
predicates in one tx (`d9ce36dc…`), crawler-free per-claim verification,
provenance envelope anchored and third-party verified, budget 429,
post-revoke 401.

### Agent grants: scoped bearer capabilities for AI agents

New `AgentGrants` surface so an operator can hand an autonomous agent a
restricted capability over one wallet session instead of the session itself:

- `createAgentGrant(sessionId, allowedActions, maxJobsPerDay?, sponsorSessionId?, validUntil?, agentLabel?)`
  returns an opaque bearer token ONCE; only its SHA-256 is stored (same
  discipline as `viewingKeyHash`). `revokeAgentGrant(grantId)` kills it
  immediately; the owner-scoped read-only `AgentGrants` entity never exposes
  the hash.
- A request carrying the token in the `x-agent-token` header runs as the
  grant's operator (the effective `req.user`, so every existing `userId`
  gate applies unchanged) but is restricted by a `before('*')` enforcement
  hook: the read-only verify surface and `getJobStatus` are always
  available; write actions only when allow-listed. READs of session-scoped
  entities are additionally narrowed to the grant (WalletSessions and
  PendingSubmissions to the grant's session, AgentGrants to the grant
  itself), so a one-session agent cannot enumerate its operator's other
  sessions or grants; chain-derived entities stay readable. Grantable actions are
  the attestation/predicate/disclosure set; wallet lifecycle, sends,
  deploys, passport/identity registration and grant administration are
  never grantable (403).
- Requests are pinned to the grant's `sessionId` and, when set, its
  `sponsorSessionId` (mismatch 403, absent values injected), so a
  sponsor-bound agent always runs sponsored and fundless.
- `maxJobsPerDay` meters allow-listed write actions per UTC day via atomic
  conditional UPDATEs on the grant row (429 when exhausted). Durable in the
  DB, unlike the in-memory rate limiters, which stay in place as burst
  protection. Budget spend is detached from the request transaction, so a
  failed request still counts (over-counting beats a retry loophole).

Transport authentication remains the host app's concern; the token
authorizes and scopes within the service. On-chain authority is unchanged:
proofs still sign with the session wallet.

### Document ingestion: prepareDocumentProof

Bridges "here is a document as structured fields" to the field-predicate
proof surface. Canonical JSON (recursively key-sorted) -> blake2b-256
`payloadHash`, plus a depth-4 Merkle `contentRoot` over an ORDERED list of
up to 16 proof fields with per-field inclusion paths, ready for
`issueFieldPredicateAttestation[Batch]`. Field paths are dot-separated and
descend into nested objects/arrays (a literal top-level key containing dots
wins); a path landing on an object is a 400. Field keys are
`blake2b256(fieldPath)`, values scale x1000 by default (per-field override),
absent values occupy a fixed empty leaf. Leaf/node hashing goes through the
contract artifact's exported pure circuits, so the off-chain root is
byte-identical to the in-circuit fold (same scheme the NIGHTPASS
content-root builder established). Compute-only and synchronous: nothing
persisted, no job; the response carries witness material (scaled values)
and is never logged.

### Standalone Docker image

The repo is itself a complete CAP app; the new `Dockerfile` packages it so
one container yields a working attestation server (all four OData services,
submission pipeline, agent grants, in-process wasm proving; no host app
required). `docker/docker-compose.yml` gains a `nightgate` service:

```
ENCRYPTION_KEY=$(openssl rand -hex 32) NIGHTGATE_HTTP_PASSWORD=change-me \
docker compose -f docker/docker-compose.yml up -d nightgate
```

The entrypoint fails closed without `ENCRYPTION_KEY`, wires SQLite
(`/data` volume) + HTTP basic auth via `CDS_CONFIG`, and deploys the schema
on first boot only (`cds deploy` recreates tables; upgrades are manual, see
`docs/docker.md`). Proving defaults to in-process wasm; set
`NIGHTGATE_PROOF_SERVER_URL` to offload to the proof-server service. The
npm package is unaffected (`files` whitelist).

### Agent-output provenance: attestAgentOutput

Anchors "agent X produced output O from input I at time T (model M, policy
P)" via the existing `anchorDocument` pipeline. The canonical v1 envelope
(`{ v, agentId, inputHash, outputHash, producedAt, modelId?, policyHash? }`)
is built and hashed server-side and rides as the anchor's public metadata
blob, so the on-chain metadata hash commits to the envelope itself. Third
parties verify by re-hashing the returned `envelopeJson` and calling
`verifyAttestationState`: no trust in the server required. Grantable to
agents; `prepareDocumentProof` is always available to valid agent tokens
(compute-only).

## 0.13.0 - 2026-08-04

Minor rather than patch: session ids no longer survive a process restart by
default (details below).

### Behaviour change: a restart closes the previous process's wallet sessions

`connectWallet` inserts a row per call and only `disconnectWallet` closes one,
so every ungraceful stop leaked its handles for the full 24h TTL (observed: 12
simultaneously active rows for one wallet). Those leftovers kept a wallet's
in-memory keys alive past a legitimate `disconnectWallet` (the shared-session
guard counted them as live users) and kept encrypted seed material at rest for
a day after the owning process died.

Plugin init now closes them and clears the same key columns `disconnectWallet`
clears. Configured fee-sponsor sessions are exempt (pinned ids, deliberately
long-lived); this is safe because `runtimeMode` already enforces a single
replica. Opt out with `NIGHTGATE_CLOSE_SESSIONS_ON_RESTART=false` or
`cds.requires.nightgate.closeSessionsOnRestart: false`.

Queued jobs that signed with a closed session are failed in the same startup
step with `PROCESS_RESTART_SESSION_CLOSED`: their replay reloads signing
material from the session row the cleanup just cleared, so claiming them could
only die later with a misleading "Session not found". Jobs of exempt sessions,
and all jobs when the cleanup is opted out, replay as before.

### Fix: restart recovery no longer replays prewarm jobs

Recovery re-queued every interrupted `connectWalletForSigning`, warming wallets
nobody had asked for; each crash left one more behind, and since all facades
share the ONE worker thread, the unrequested catch-ups starved the wallet the
host actually wanted (live: not synced after 80 minutes with two unrequested
facades alongside). These jobs are now terminal on restart
(`PROCESS_RESTART_SESSION_JOB_DROPPED`); their only product was in-process
state for a caller that did not survive.

### Fix: wallet prewarms run one at a time

Prewarms were a "light" job kind (cap 16), but catch-up is CPU-bound
single-threaded work in that one worker thread: N concurrent prewarms each ran
at roughly 1/N speed and the first wallet became usable last.
`connectWalletForSigning` is now capped at one concurrent job
(`jobs.concurrency.serial`, default 1). Total time to warm N wallets is
unchanged; time to the FIRST usable wallet drops by about a factor of N. A job
waiting on the cap stays `pending` and holds no lease.

### Feature: catch-up progress is visible

Between "facade started" and "CAUGHT UP" nothing was logged above debug level,
so a slow sync and a hung one looked identical from outside. The sync wait now
logs INFO every 15s (applied index, stream tip, events behind, current rate,
ETA), and the new OData function `getWalletSyncProgress(sessionId)` returns the
same numbers. It reads a snapshot the worker pushes to the main thread instead
of issuing an RPC, so it stays responsive exactly when the worker is saturated.

## 0.12.1 - 2026-08-03

### Feature: wallet-delegated proving modality in `@odatano/nightgate/browser`

FR: `docs/feature-requests/browser-wallet-delegated-proving.md`.
`createNightgateConnectorProviders` gained a `proving` option
(`'server' | 'wallet' | 'auto'`, default `'server'`) and now assembles the
proof provider itself instead of leaving it to the consumer. With
`'wallet'` the contract circuits are proved INSIDE the connected
DApp-Connector wallet via `connector.getProvingProvider(...)`: no Docker
proof server, no CORS wall, and the transaction preimage never leaves the
user's machine. The browser counterpart of `srv/midnight/wasm-proof-provider.ts`.

Only the CONTRACT's circuits are answered from our `zkConfigProvider`;
standard circuits (zswap/dust) and the BLS ceremony parameters are the
wallet's own business, so a miss on our side is expected rather than an
error.

`proving: 'wallet'` THROWS when the connected wallet has no
`getProvingProvider` - it never silently falls back to a remote proof
server, because that would move the preimage somewhere the caller did not
ask for. `'auto'` is the forgiving variant (wallet when available, else
server). The assembled modality is returned as `provingModality`
(`'server' | 'wallet' | 'none'`) so consumers can log and display where
proving actually happens.

Also: `buildProofProvider` is exported separately (for consumers that
assemble the other providers themselves), typed in `src/browser/index.d.ts`
plus a new `src/browser/providers.d.mts` so the deep `.mjs` path is typed
too.

### Browser typing fixes (consumer-visible, repo-invisible)

- `BuildWitnessesInput` now declares `merkleProofHolder` (plus the exported
  `MerkleProofHolder` type). The 0.12.0 batch mode has been supported at
  runtime since that release but was undeclared, so TypeScript consumers
  could not use the public batch surface in a typed way.
- `index.d.ts` imports `AttestationVaultWitnesses` locally: `export { … }
  from` re-exports a name without binding it, and `PreparedCall.witnesses`
  references it, so the declaration failed with TS2304 for any consumer.
- New `npm run check:browser-types` (`scripts/check-browser-types.mjs`)
  typechecks a probe against the browser entry with **skipLibCheck OFF** and
  package-name resolution - i.e. the way a consumer does. The repo's own
  typecheck has skipLibCheck on and therefore checks no declaration contents
  at all, which is how both bugs above (and the `zk-config` import in
  `providers.d.mts`) stayed invisible here while breaking installs. Wired
  into `prepublishOnly`; verified to fail when either fix is reverted.

### Packaging fixes found while releasing this

- `./browser/providers.mjs` is now a declared subpath in `exports` (with
  `types`), and `src/**/*.d.mts` is in `files`. Without both, the deep import
  the new declaration describes would have failed at a consumer's install with
  `ERR_PACKAGE_PATH_NOT_EXPORTED`, and the declaration would not have shipped.
- **`src/browser/*.d.ts` was never tracked in git.** The `src/**/*.d.ts`
  ignore treats declarations as in-place build output, but src/browser ships
  hand-written `.mjs` with hand-written declarations and has no `.ts` to
  generate them from - so a fresh clone published
  `@odatano/nightgate/browser` with NO types at all. The ignore now has a
  negation and `index.d.ts` / `witnesses.d.ts` are tracked. Pre-existing, not
  introduced by this release.
- `providers.d.mts` describes its zk-config dependency structurally instead of
  importing from the declaration-less `./zk-config.mjs`; the import made the
  file error for any consumer with `skipLibCheck: false` (the repo's own
  typecheck hides this - only an installed-package typecheck catches it).
- New `npm run check:exports` (`scripts/check-package-exports.mjs`) verifies
  every `exports` target - including every `types` condition - exists on disk
  AND is inside the real `npm pack` tarball. Wired into `prepublishOnly`.
  Verified against an actual pack → install → deep-import → consumer-typecheck
  round trip, and confirmed to fail when either half of the fix is reverted.

Default behavior is byte-for-byte unchanged; with `proving` unset the
server path is exactly what 0.12.0 did. Verified: 69 suites / 1323 tests,
typecheck + `check:browser` clean. The live acceptance run (a vault call
proved through bob-the-mooonlighter with the proof server STOPPED) is
pending and tracked in the FR.

## 0.12.0 - 2026-08-01

### Feature: `issueFieldPredicateAttestationBatch` proves N field predicates in ONE transaction

FR: `docs/feature-requests/batched-field-predicate-attestations.md` (the
server lane of NIGHTPASS's ZK proof cart). New action: up to 8
`proveFieldPredicate` claims on one passport in a single transaction; an
optional `contentRoot` is anchored as the FIRST call of the SAME batch
(0.10.0 segment ordering pins it ahead of the proofs) and occupies one call
slot. One balancing/submit/confirmation round and one fee event for the
whole cart; with `sponsorSessionId` one dust spend total. Proving stays
additive (N proofs = N provings).

Mechanics: witness factories accept a `merkleProofHolder` resolved at
invocation time (server `contract-witnesses.ts` + browser `witnesses.mjs`
in lockstep); `BatchCall` entries take an optional `before()` hook that
`runBatchInScope` invokes right before each `callTx`, so the worker swaps
the holder's current proof per call inside one scope. The generic
`submitContractCallBatch` surface gained per-call `merkleProof` entries on
the wire (worker, client, submitter); hook-less batches are byte-identical
to before. Exact duplicate claim tuples are dropped server-side
(`droppedDuplicates`; claim keys are idempotent on-chain), the predicate
rate limiter counts N claims per batch, command payloads stay encrypted.
Failure semantics: a false predicate fails at LOCAL proving (nothing
submitted, no row proven); post-submission PARTIAL_SUCCESS fails the job
with `OnChainStatus:...` and callers verify per claim via
`verifyPredicateAttestation`.

Review hardening (pre-release): `dirs` entries are validated as strict
booleans on both predicate actions (`map(Boolean)` would have turned
`"false"` into `true` and corrupted the Merkle path); the post-success
projection marks ALL claim rows proven in ONE `UPDATE ... where ID in`
(no partial proven-marking after an on-chain success); the generic
`submitContractCallBatch` action now validates and forwards per-call
`merkleProof` entries instead of dropping them; `RateLimiter.checkMany`
consumes N slots all-or-nothing (a 429'd batch eats no budget).

## 0.11.1 - 2026-07-29

### Perf: wallet-save pipeline CPU + findDeployedContract query cache

FR: `docs/feature-requests/wallet-save-pipeline-cpu-efficiency.md`. Live
profiling on the NIGHTPASS demo VPS showed the node process pinned at
100-240% of a core for entire runs and ~74% of a core at idle, driven by the
wallet-state save pipeline; plus a fixed multi-second pre-proof setup on
every contract call. Fixes:

- **One PBKDF2 per session instead of per save**: `saveSyncState` derives the
  storage key once per (accountId, passphrase) using a deterministic salt
  (same pattern as `CapDbPrivateStateProvider`); blob wire format unchanged.
  Memoized keys are scoped to the wallet's connected lifetime, not the
  process: `evictWalletFacade` zeroes and drops the account's key after the
  final save (waiting out in-flight saves so no blob is garbled mid-encrypt),
  plugin shutdown zeroes all of them (`StorageEncryption.clear()`).
- **Key derivation off the main thread**: the remaining per-session PBKDF2
  runs through async `crypto.pbkdf2` on the libuv threadpool, so saves no
  longer stall HTTP responses.
- **Changed-only sub-blob pushes**: the worker's 30 s tick and the evict
  final-save push only sub-blobs that differ from the last acked save
  (typically just the churning dust blob, not all three).
- **findDeployedContract query cache**: the two IMMUTABLE indexer queries the
  SDK re-runs on every contract call (deploy tx data, deploy-time contract
  state) are cached per (indexer, contract address) in the worker; part of
  the 8.4 s measured per predicate call on the grown vault state. Current-
  state queries stay uncached: the verifier-key check must see maintenance
  transactions from other clients, and call transcripts must build against
  fresh state.
- **Phase timing instrumentation** (debug level): one
  `submitContractCall(-Batch) timing:` line per submission with the
  wall-clock phase breakdown (init/compile/findContract/prove/balance/
  submit/...), also on failure.

Measured on the same box after items 1-3: idle CPU ~74% -> ~5% of a core
(postgres ~27% -> ~1.4%), predicate-call pre-proof setup 68 s -> ~10 s,
visitor run 3.9 -> 3.0 min, zero dropped saves. The query cache was then
verified live on a full visitor run: findContract on the predicate call
8.4 s -> 1.1 s (batch 3.3 -> 1.8 s); the remaining second is the
deliberately uncached verifier-key check.

## 0.11.0 - 2026-07-28

### Feature: `NIGHTGATE_PROVING_MODE=wasm` proves everything in-process (no Docker proof server for dev/test/CI)

FR: `docs/feature-requests/wasm-proving-without-docker.md`. New env var
`NIGHTGATE_PROVING_MODE`: `server` (default, unchanged behavior) proxies
proving to the proof-server container; `wasm` proves fully in-process, so no
proof server needs to run at all. Wallet transactions go through the SDK's
`makeWasmProvingService()` passed to `WalletFacade.init`; contract deploy/call
circuits go through the new `srv/midnight/wasm-proof-provider.ts`, which
replaces midnight-js's `httpClientProofProvider` under wasm mode (zkir-v2
computes locally what the proof server computes remotely; contract keys from
the contract's `managed/` zkConfig, standard keys + BLS params from the SDK's
S3 provider). `@midnight-ntwrk/zkir-v2` and `@midnight-ntwrk/midnight-js-types`
promoted to direct dependencies. Default resolution makes zero-config fully
public: `wasm` unless a proof server is EXPLICITLY configured (env var or cds
config), which selects `server`; `NIGHTGATE_PROVING_MODE` overrides either
way, and existing deployments with a configured proof server keep their
behavior unchanged. Caveats (documented in `docs/reference.md`): proving keys
download from Midnight's S3 at runtime with an in-memory-only cache, proving
costs seconds of CPU per transaction, production should run a proof server.

Verified live on preprod with a dead proof-server URL
(`NIGHTGATE_PROOF_SERVER_URL=http://127.0.0.1:9999`, nothing reachable):
NIGHT self-transfer `00474d79de7e5f52...` (send job 55.9 s wall-clock
including the first-run proving-key download), counter deploy `37bb15aa...`
(79.3 s) + increment `d58e4420...` (76.3 s), and mint on the compact-0.31
shielded-token artifact `56892f3e...` (~170 s), so both compiler generations
prove through the local zkir. New harnesses
`scripts/run-wasm-proving-e2e.mjs` / `run-wasm-contract-e2e.mjs`
(`npm run wasm-proving:e2e` / `wasm-contract:e2e`).

A repo-wide multi-agent review (36 confirmed findings) was applied in the
same release:

- Dependency truthfulness: `@midnightntwrk/wallet-sdk-capabilities` and
  `@midnightntwrk/wallet-sdk-prover-client` (directly imported by the wasm
  proving path) promoted to direct dependencies; `express` and `undici`
  (script-only) moved to devDependencies.
- `tokenTypeHex` is lowercased server-side (the SDK matches token types by
  exact lowercase string) and the 10^18 NIGHT sanity bound no longer rejects
  valid custom-token amounts (Uint<128> bound applies instead).
- wasm proving hardening: missing key material now fails with an error naming
  the keyLocation and the underlying zkConfig failure instead of dying deep in
  the WASM; rejected loads are no longer memoized forever; wallet and contract
  proving share ONE per-worker S3 key cache instead of one per session.
- Wallet-session job commands (`sendNight`, dust register/deregister,
  prewarm) are now persisted AES-GCM-encrypted like contract-call commands
  (tamper protection for the replay path; existing plaintext rows keep
  decoding via their `json-v1` marker).
- Dead code removed: unused `loadWalletSdk` bundle (the main thread no longer
  imports the contracts/facade packages it never used), unused
  `walletPing`/`walletSerializeState` RPC pair, unused `deleteSyncState` and
  `hasContractWitnessFactory`; deliberate test hooks renamed to the
  `__...ForTests` convention; the public `NightgateConfig` type now re-exports
  the real plugin config instead of a stale copy.
- Test additions: worker transfer (incl. `tokenTypeHex` consumption + ledger
  routing), balance/fee reads, dust register/deregister filter and no-op
  branches, contract-call private-state seeding guard, proving-mode routing,
  external-effect-boundary invariants, `resolveContract` artifact wrapping.
- Docs reconciled against the code (removed-feature mentions, env-var matrix,
  network list, entity list, action parameter tables); CLAUDE.md rewritten
  against the 0.11.0 tree.

Also in this release, built to measure the zswap circuits in-process (NIGHT
alone cannot exercise them, it is unshielded-only):

- New contract `contracts/shielded-token`: `mint()` mints 100000000 atoms of
  the contract's own shielded token to the caller's zswap public key
  (registered as third compiled artifact).
- `sendNight` gained an optional `tokenTypeHex` parameter (64 hex raw token
  type) to transfer a custom token instead of NIGHT; validation, job
  plumbing, and worker transfer support included. Default behavior unchanged.
- `scripts/run-wasm-zswap-e2e.mjs` (`npm run wasm-zswap:e2e`): deploy →
  mint → shielded self-transfer. Live on preprod: contract `2bf41737...`,
  transfer tx `00e9065c...`, send job 176.1 s wall-clock including the
  first-run download of the zswap prover keys (11 MB spend + 5.7 MB output),
  zswap spend/output proved in-process by the WASM prover.

## 0.10.5 - 2026-07-28

### Removed: `shieldFunds` / `unshieldFunds` / `estimateShieldFee` / `estimateUnshieldFee` (BREAKING)

NIGHT is an unshielded-only token; a shield/unshield conversion does not exist
in the Midnight protocol (bug report:
`docs/feature-requests/bug_003-initswap-drops-destination-half-fund-loss.md`).
The four actions implemented an operation that can never produce a valid
transaction: shielded and unshielded NIGHT are distinct ledger token types
that never balance against each other, and the one-sided `initSwap` operand
shape additionally made the SDK facade silently drop the destination half.
Verified live on preview (node rejects with `1010 Custom error: 138`,
BalanceCheckOverspend).

Removed end-to-end: OData actions, session handlers + swap rate limiter,
`token-ops` wrappers, worker-client RPCs (`walletShieldNight` /
`walletUnshieldNight` / `walletEstimateSwapFee`), and the worker handlers
(`shieldNight` / `unshieldNight` / `estimateSwapFee`). `sendNight`, dust
registration, and all other wallet actions are unchanged. No schema change.

## 0.10.4 - 2026-07-27

### Fix: discarded/failed wallet recipes no longer leak coins into pendingUtxos; loop-free fee estimates

Root-caused live in the sibling browser-wallet project on preview (bug report:
`docs/feature-requests/bug_002-recipe-pending-utxo-leak-and-estimatefee-hang.md`,
verified claim-by-claim against the vendored SDK): recipe builders move the
selected coins into the sub-wallets' `pendingUtxos` at BUILD time, and a
recipe that is discarded (fee estimate) is never reverted. The phantom spend
is persisted by the periodic state save, so one estimate call could brick a
session wallet ("Insufficient funds" on a funded wallet) across restarts.
Separately, `estimateTransactionFee` re-runs the dust balancer's uncapped
synchronous convergence loop and can pin the worker's event loop.

All in `srv/midnight/wallet-worker.ts`:

- `estimateTransferFee` / `estimateSwapFee` now price the balanced recipe via
  the loop-free `calculateTransactionFee` and ALWAYS revert the recipe in a
  `finally` (new helpers `revertRecipeBestEffort` / `feeOfDiscardedRecipe`).
- Contract-call path: the recipe is reverted when `finalizeRecipe` fails (the
  SDK only reverts the balancing tx of an unbound recipe, stranding the base
  tx's in-place unshielded spends) and when the empty-DustActions 117 guard
  aborts after a successful finalize.
- Sponsored path: caller-side sign/finalize failures revert the caller
  recipe; sponsor-phase failures revert on BOTH facades, including the
  stranded caller-finalized tx. A SUBMIT failure also reverts the caller
  facade (the SDK's error path only reverts the sponsor it ran on).

The UNPROVEN submit flows (transferNight, shield/unshield, dust
registration) are unchanged: the vendored facade already reverts prove and
submit failures itself. No schema change, no API change; estimate fee
results now come from `calculateFee` (same figure on a balanced recipe, min
1 atom).

## 0.10.3 - 2026-07-26

### Fix: session-expiry sweep no longer evicts the live facade of a shared wallet

Found live on the NIGHTPASS demo (FR
`docs/feature-requests/session-sweep-evicts-live-facade.md`): the facade
cache is keyed by accountId while sessions are per-connect rows with a 24h
TTL. A consumer that reconnects the same wallet on every boot accumulates
several active rows for the same account; when any OLD row expired, the
15-minute cleanup sweep silently evicted the facade the CURRENT session was
actively using (`getWalletBalance failed: No facade for sessionId=...`
roughly 24h after the row that created it). `disconnectWallet` had the same
collision.

- New guard: before evicting, the sweep and `disconnectWallet` check whether
  ANOTHER active, non-expired session row references the same wallet (via
  the persisted `viewingKeyHash`, no decryption needed). If so, only the
  expiring/disconnecting row is deactivated and the facade stays.
- The sweep now decides once per wallet instead of once per row, and logs
  every eviction and every skip at info level (the old eviction was silent,
  which is why the incident took hours to diagnose).
- Legacy rows without a `viewingKeyHash` keep the old behavior (evict), as
  the secure default.
- Admin `invalidateSession`/`invalidateAllSessions` force-evict stays
  deliberately account-wide (operator tool) and now logs the eviction.
- **Deactivate-first ordering (review fix).** Both the sweep and
  `disconnectWallet` deactivate the owning row(s) BEFORE deciding about the
  facade. Checking first was a TOCTOU race: two concurrent disconnects of
  the same wallet would each see the other still active and both skip the
  eviction, leaving the in-memory keys cached with no live session. With
  deactivate-first, at least one caller observes zero live references. The
  sweep's deactivation is scoped to the selected rows so nothing expires
  unseen between SELECT and UPDATE.
- **Expired disconnect evicts too (review fix).** The `disconnectWallet`
  410 path (already-expired session) now runs the same shared-session-aware
  eviction; previously it only deactivated the row, and since the sweep
  selects only ACTIVE rows, a sole session's in-memory keys would have
  stayed cached forever.
- **Per-account lock.** New `srv/utils/keyed-lock.ts` (in-process mutex,
  sound because the runtime topology is enforced single-instance):
  `getOrBuildWalletFacade` and the check+evict decision take the same
  account lock, so a facade being (re)built concurrently cannot be torn
  down by a stale eviction decision.

No schema change, no API change. Consumers that self-heal on
`No facade for sessionId` (reconnect + reindex) can keep that logic as a
safety net; it should no longer trigger.

## 0.10.2 - 2026-07-25

### Fix: wallet-worker waits no longer hold an open request transaction (PostgreSQL pool starvation)

Found live 2026-07-24: `getWalletBalance` awaited the wallet worker INSIDE the
CAP-managed request transaction. On a facade still syncing to the indexer tip
that wait blocks for minutes, and the open transaction pins one database
connection the whole time (`idle in transaction`). A consumer polling balances
of warming wallets drained the entire PostgreSQL pool; SQLite's single-writer
model had hidden the pattern. FR:
`docs/feature-requests/worker-calls-outside-request-tx.md` (all four items).

- **Session reads detach from the request tx.** `runWithoutAmbientTx` is now
  exported from `srv/submission/background-jobs.ts`; the facade-backed read
  handlers (`getWalletBalance`, `estimateSendNightFee`, `estimateShieldFee`,
  `estimateUnshieldFee`) resolve their `WalletSessions` lookup on a
  short-lived autocommit connection, so the subsequent worker await pins
  nothing. `connectWalletForSigning` does the same for its session read (the
  in-handler viewing-key derivation loads the ESM SDK, slow on first use);
  its key write + job insert stay on the ambient tx and commit together.
- **Bounded sync gate for worker reads.** The four read actions wait at most
  `NIGHTGATE_WALLET_READ_SYNC_TIMEOUT_MS` (default 10 s, `<= 0` disables) for
  genuine sync, then answer **503 with error code `WALLET_SYNCING`** instead
  of blocking. Status surfaces can poll cheaply; caller-side timeouts are no
  longer needed (and never helped, since the server kept waiting).
- **`disconnectWallet` evicts outside any transaction.** The facade evict
  (which awaits the worker's final state save) now runs with no open request
  tx; all DB work in the handler autocommits.
- Duplicated session-lookup blocks in `getWalletBalance` /
  `estimateSendNightFee` replaced with the shared
  `loadSigningSessionAccountId` helper (behavior-identical status codes).
- **Boot hygiene: a fresh prewarm supersedes orphaned predecessors.** Restart
  recovery re-queues an interrupted `connectWalletForSigning` while the
  consumer's boot prewarm starts a fresh one; every hard restart multiplied
  the blocked worker waits (observed: 16+ heartbeating jobs). A fresh
  `connectWalletForSigning` now marks every older queued or running prewarm
  job of the same session as `failed / SUPERSEDED` (new internal helper
  `supersedeQueuedJobs` in `srv/submission/background-jobs.ts`, not part of
  the package's public exports). Superseded pending jobs never start; a job
  superseded mid-run keeps its terminal `SUPERSEDED` status and its late
  result is discarded quietly (no `RESULT_PERSIST_FAILED` noise). Status
  readers should treat `SUPERSEDED` as expected and follow the successor job.
  Design limit: this is status hygiene, not cancellation - an already-running
  worker wait continues until it resolves on its own (all prewarms of one
  account coalesce on the same facade sync). The sweep joins the handler's
  request tx, so it never requests a second pool connection.

**Consumer note (NIGHTPASS):** treat `503 WALLET_SYNCING` from
`getWalletBalance` and the fee estimates as retryable; poll again once the
prewarm job reports ready. No schema change in this release.

## 0.10.1 - 2026-07-24

### `deriveWalletInfo` exposes the AttestationVault attester identity

`deriveWalletInfo` returns a new field `attesterId` (64-hex): the value the
vault circuits compute as `caller_id()`, derived offline as
`persistentHash<Bytes<32>>(deriveAttestationSecret(zswapRoleSeed))`.
Network-independent. Pass it as `registerPassport`'s `ownerId` to pre-register
a passportId for a wallet before that wallet's first on-chain call. Consumers
obtain the value via the `deriveWalletInfo` action; the computation lives in
the internal helper `deriveAttesterId(zswapSeed)` in `srv/utils/wallet-info.ts`
(not part of the package's public exports).

### Fix: signing honors the session's `accountIndex` (was silently account 0)

`deriveWalletInfo` supported `accountIndex`, but `connectWalletForSigning` did
not: the signing path (facade build, adapter pubkeys, and the AttestationVault
witness secret) always derived account 0. For a wallet connected with a
non-zero account, viewing key, attester id and the actual signer belonged to
DIFFERENT accounts, with no error.

- `connectWalletForSigning` takes an optional `accountIndex` (default 0),
  persisted as new column `WalletSessions.accountIndex` and threaded through
  every seed-consuming site (wallet adapters, worker facade init, witness
  secret, fee-sponsor facade).
- **Fail-closed consistency check:** the action now derives the seed's viewing
  key at the requested `accountIndex` and rejects with 400 when it does not
  match the session's viewing key, so a wrong account or wrong mnemonic fails
  loudly at connect time instead of silently signing with foreign keys.

**Upgrade note (consumers):** new column `WalletSessions.accountIndex`; a
normal `cds deploy` adds it, an existing DB gets it without a wipe via
`scripts/apply-schema-delta.mjs`. Rows without the column sign with account 0,
exactly as before. Behavioral change: `connectWalletForSigning` calls whose
seed does not derive the session's viewing key (previously accepted and
mis-signing) now return 400.

## 0.10.0 - 2026-07-24

### AttestationVault passport hardening (contract change) + deterministic batch apply order

**Fix: `bindPassport` rebind-takeover guard.** `passport_bindings.insert`
overwrites and only `payload_hash` ownership was checked, so any attester
could re-bind an already-bound passportId onto their own attestation and
hijack the QR resolution (same takeover class as the 0.6.1 attest() fix). An
already-bound, unregistered id can now only be re-bound by the owner of its
currently bound attestation; same-owner rebinding stays allowed.

**Feature: registrar-gated passport pre-registration.** New contract
constructor locks the DEPLOYER's attester identity as `registrar`; a new
registrar-only circuit `registerPassport(passportId, owner_id)` fills
`passport_owners`. Registered ids bind/re-bind ONLY for their registered
attester (blocks first-bind squatting, and recovers a squatted id: registrar
re-points it, the owner rebinds over the foreign binding). Unregistered ids
stay first-come-first-served (squattable by design); register where that
risk matters. New OData action `registerPassport(...)` (async job like
grant/revokeDisclosure, 30/h per session) + browser helper
`prepareRegisterPassport`.

**Feature: deterministic batch apply order** (lifts the 0.9.3
order-independence restriction). The SDK randomizes each call's segment id
and the ledger applies merged intents in ascending segment order, so a
dependent batch only landed by luck (~1/3). The batch path now wraps the
proof provider and rewrites the batch's EXISTING segment ids into call order
before proving (`ledger-v8` recomputes binding); dependent flows like
attest -> bindPassport -> anchorContentRoot run as ONE tx. Fail-closed: if
the ordering cannot be established for a multi-call batch, the submission
aborts BEFORE proving (nothing submitted) instead of silently proving in
randomized order. Limitation: duplicate circuit names keep a random relative
order among themselves. New `srv/midnight/batch-segment-order.ts`.

Notes:

- Recompiled `managed/` artifact (compactc 0.31.0), now 9 circuits. No CDS
  schema change. The deploying session's secret defines the registrar:
  deploy from the session that should manage passport ownership.
- **Redeploy required for the guard + registrar, and a redeployed vault
  starts with an EMPTY ledger:** switch the contract address AND re-create
  needed state (attest, bindPassport, anchorContentRoot, grants), otherwise
  QR resolution appears lost.
- Job-pool fix: `grantDisclosure`/`revokeDisclosure`/`registerPassport` now
  run in the HEAVY pool (full ZK proof generation; light since 0.9.0 was an
  oversight that could over-saturate the proof server).
- Verified: contract regression checks in
  `scripts/integration-test-attestation-vault.mjs`, and two full live rounds
  on preprod (fresh vault deploy, first-try dependent 3-call batch with
  on-chain SUCCESS, registerPassport, bind on the registered id). The
  statistical forced-order stress proof (6/6 vs 0/6) runs consumer-side.

## 0.9.3 - 2026-07-24

### Feature: batched contract calls in one transaction (`submitContractCallBatch`)

New submission action `submitContractCallBatch(contractAddress, calls,
compiledArtifactRef, sessionId, idempotencyKey?, initialPrivateState?,
sponsorSessionId?)`: several circuit calls against ONE deployed contract execute
inside a single transaction scope (SDK `withContractScopedTransaction`) and are
balanced, signed and submitted ONCE. Calls in one batch must be
order-independent: the SDK applies merged intents in unspecified order, so
dependent calls belong in separate transactions (proven pattern: `attest`
single, then `bindPassport` + `anchorContentRoot` as a batch). [Lifted in
0.10.0 by deterministic batch apply order.] A failure before
submission discards the scope (nothing submitted);
after submission the ledger's fallible phase can still finalize the tx as
PARTIAL_SUCCESS (on chain, subset of calls applied), which fails the job with
`OnChainStatus:...`. At most 8 calls per batch. With `sponsorSessionId`, the
two-phase dust balancing runs once for the whole batch.

- Job kind `submitContractCallBatch` (heavy pool), command op `callBatch`,
  encrypted at rest like single calls; idempotencyKey dedupes retries.
- One `PendingSubmissions` row tracks the batch; `circuitName` is the ordered
  `+`-joined circuit list (truncated to the column).
- Job result: `{ submissionId, txHash, contractAddress, circuits, status }`,
  with one txHash for the whole batch.
- Same first-contact private-state seeding, arg coercion (per call), mainnet
  gate, rate limit (shared with `submitContractCall`) and sponsor authorization
  rules as `submitContractCall`. No Compact contract change.

## 0.9.2 - 2026-07-23

### Feature: crawler-free chain-outcome confirmation

With the crawler disabled (the recommended mode for submission-focused
deployments, and what the NIGHTPASS demo runs), `chainStatus` could never leave
`pending`: the only path advancing it (`refreshSucceededChainOutcomes`) needs the
crawler-populated `Transactions`/`TransactionResults` tables. Any consumer gating
on `chainStatus === 'success'` (`requireChainSuccess`) then waited to the poll
timeout even though the tx had landed on chain.

A second, crawler-free path now advances `chainStatus` with a single Indexer
GraphQL query per submitted tx (`transactions(offset:{hash})`), mapping the
result status to `success`/`failure`. It is scoped to our own jobs (they carry
the tx hash), one point lookup per pending job, never a scan. Workflow parents
are unchanged; they keep aggregating from children.

- One-shot HTTP by design, not `publicDataProvider.watchForTxData`: that looks up
  by `identifier` (our jobs persist the `hash`, so it would never match) and is
  an Apollo poll that would leak on every tick for a not-yet-final or dropped tx.
  The query runs under an `AbortSignal` deadline, so a stuck lookup cancels and
  just retries next tick.
- Decoupled from the command poller: the pass runs in the background under a
  single-flight guard with bounded lookup concurrency, so a slow Indexer never
  stalls command polling or reconciliation.
- Status mapping: `SUCCESS` -> `success`, `FAILURE`/`PARTIAL_SUCCESS` -> `failure`;
  an unknown/future status is left unconfirmed (retry) rather than a wrong verdict.
- Gating: `NIGHTGATE_CRAWLERLESS_CHAIN_CONFIRM` (env) / `crawlerlessChainConfirm`
  (config). Runs ONLY when the crawler is disabled (where it defaults on; `false`
  opts out). With the crawler enabled it never runs, so the crawler stays the
  sole `chainStatus` writer and the two paths can never race; an explicit opt-in
  is ignored with a warning.
- The existing crawler path (`refreshSucceededChainOutcomes`) is untouched. No
  schema change. New: `srv/submission/chain-outcome-confirmer.ts`,
  `config.resolveCrawlerlessChainConfirmEnabled`.

## 0.9.1 - 2026-07-22

### Fix: pin the Midnight SDK to 4.0.x so a fresh install keeps a single compact-js copy

0.9.0 pinned `@midnight-ntwrk/compact-js` to exactly `2.5.0` (the version the
tested SDK `midnight-js-contracts@4.0.4` requires) but allowed the SDK as a
range (`^4.0.4`). Since then `midnight-js-contracts@4.1.0` shipped, which pulls
`compact-js@2.5.1`, so a FRESH consumer install resolved BOTH `2.5.0` (our pin,
nested) and `2.5.1` (the newer SDK, hoisted). Two copies reintroduce the
distinct-`TypeId` skew that breaks contract deploys (`Cannot read properties of
undefined (reading 'ctor')`). Our own repo was unaffected only because the
committed lockfile pins the SDK to 4.0.4; lockfiles are not published, so
consumers re-resolved to 4.1.0.

Fix: the six direct `@midnight-ntwrk/midnight-js-*` dependencies are now
`~4.0.4` (`>=4.0.4 <4.1.0`) instead of `^4.0.4`. The SDK stays on 4.0.x, which
requires `compact-js@2.5.0`, matching our pin, so a fresh install dedupes to a
single `2.5.0`. No code change; moving to the 4.1.x SDK (and `compact-js@2.5.1`)
is a deliberate future bump.

## 0.9.0 - 2026-07-22

### Hardening pass: submission recovery, crawler resilience, DB indexes, leveled logging

A broad, review-driven cleanup across the submission, crawler and provider
layers, plus a move to CAP-native leveled logging.

**Submission / wallet worker**

1. Worker crash recovery. A wallet-worker that exits after a successful start
   is now respawned on the next RPC instead of permanently rejecting every
   deploy/call. In-flight RPCs are rejected on worker exit/error (no more calls
   hanging forever on a dead reply port), and every RPC has a backstop timeout
   (`NIGHTGATE_WORKER_RPC_TIMEOUT_MS`, default 30 min). Long sync waits
   (`waitForSyncedState`) use a larger per-call timeout matching the worker's own
   sync budget, so a legitimately long cold sync (fresh seed, full shielded scan)
   is not killed mid-flight. "Never started" still rejects; only a genuine crash
   respawns.
2. Per-facade serialization. Concurrent balance+submit calls on the same wallet
   (and on a shared fee sponsor) are serialized through a deadlock-free
   multi-key lock, so two submissions cannot select overlapping UTXO/dust
   inputs and get the second rejected as a double-select.
3. Indexer providers are built once per (indexer + proof + zkConfig) and reused
   instead of opening a fresh graphql-ws connection on every submission (socket
   leak under load).
4. Session eviction now zeroes ALL secrets (dust key, unshielded keystore,
   attestation secret), not just the zswap keys.
5. `markFailed`'s status write can no longer mask the classified
   `SubmissionError` under write contention, and a sync-state subscription no
   longer leaks on the stalled-indexer poll path.

**Background jobs: persistent, restart-safe state machine**

The async runner behind the long-running submission actions (`deployContract`,
`submitContractCall`, `anchorDocument`, `sendNight`, `shield`/`unshieldFunds`,
dust register/deregister, predicate attestations) is now a durable state
machine instead of a fire-and-forget spawn.

1. Explicit lifecycle `pending -> running -> external_execution -> submitted ->
   succeeded | failed`, plus the terminal `reconciliation_required`. The
   `external_execution` boundary is crossed immediately BEFORE any SDK call that
   can create a chain effect; `submitted` is set only once a real `txHash`
   exists. `queuedAt`, `externalExecutionAt` and `submittedAt` each carry a
   distinct, well-defined meaning.
2. Crash-safe recovery on boot, never a blind second submit: `pending`/`running`
   rows (provably before the external-effect boundary) become
   `failed:PROCESS_RESTART_BEFORE_EXECUTION` (a new key may retry);
   `external_execution`/`submitted` rows become
   `reconciliation_required:PROCESS_RESTART_RECONCILE` (verify chain state first).
3. No `cds.spawn` and no private `cds._with`: work runs outside the request /
   transaction context through a module-level Node `AsyncResource`. Each row
   mutation uses its own short tx, so a job holds no pool connection while its
   multi-minute work is in flight.
4. Persisted worker lease (`leaseOwner`, `leaseExpiresAt`, `heartbeatAt`) and
   `attempt`/`maxAttempts`. The `pending -> running` claim must update exactly
   one row or the job does not execute; every heartbeat, completion and failure
   write is fenced on `leaseOwner` + status, so a superseded worker cannot
   overwrite a newly owned state.
5. Idempotency is enforced by a database unique constraint on
   `(sessionId, kind, idempotencyKey)`. A key stays permanently bound to its
   first job (including `failed`/reconciliation states); a conscious retry needs
   a new key. A reused key with a changed payload is rejected via a SHA-256
   payload fingerprint. `idempotencyPayload` lets a caller dedupe on a stable
   semantic input even when the request carries freshly generated resource IDs,
   so deduplicated documents/predicate attestations return the ORIGINAL IDs and
   leave no orphan rows. Two truly-concurrent requests with the same key are
   resolved to the single winning job (the loser's INSERT collision rolls back
   through a savepoint and returns the winner), never a raw error. Invariant: a
   job performs at most one external submission.
6. `getJobStatus` surfaces lease, attempt, `submissionId`, `txHash` and the
   three lifecycle timestamps. New Prometheus gauges: `*_jobs_queued`,
   `*_jobs_running`, `*_jobs_reconciliation_required`,
   `*_jobs_oldest_queued_seconds`. Consumers (NIGHTPASS) treat
   `reconciliation_required` as an explicit terminal state.
7. Long-running wallet, contract, document and disclosure operations now use
   encrypted, versioned commands claimed by a replay poller. Multi-submit
   predicate operations are durable parent/child workflows: every chain call
   has a deterministic child idempotency key and may cross the external-effect
   boundary at most once. A partial workflow or any live failure after that
   boundary becomes `reconciliation_required`, never an automatically
   retryable failure.
8. The replay poller conservatively auto-reconciles jobs when their exact
   `PendingSubmission` is finalized and the crawler has indexed the same
   transaction. Incomplete evidence remains untouched; submission reconciliation
   is intentionally separate from contract execution verification.
   Idempotent leaf finalizers restore document/disclosure projections (including
   fail-closed `active=false` on revoke) and return the normal typed result
   shape before the job becomes succeeded. Fully successful child sets requeue
   their workflow parent so it can rebuild its typed result without another
   chain submission.
9. Job workflow completion and chain execution are now separate signals.
   `status=succeeded` means the server-side submission workflow completed;
   `chainStatus=pending|success|failure` and `chainFinalizedAt` are populated
   later from verified System.Events outcomes. Predicate parents aggregate the
   chain outcomes of their deterministic children. Reconciliation, direct
   outcome refresh and parent aggregation use bounded keyset scans with
   wraparound, so unresolved rows cannot pin a fixed 100-row window and starve
   later jobs.

Upgrade gotcha (consumers): `BackgroundJobs` gains the unique constraint plus
new columns (`payloadFingerprint`, `commandVersion`, `command`,
`commandEncoding`, `requestedBy`, `parentJobId`, `workflowStep`, `queuedAt`,
`externalExecutionAt`, `submittedAt`, `attempt`, `maxAttempts`, `leaseOwner`,
`leaseExpiresAt`, `heartbeatAt`, `submissionId`, `txHash`, `chainStatus`,
`chainFinalizedAt`; `TransactionResults` gains `outcomeSource`). A `cds deploy` /
`scripts/apply-schema-delta.mjs` adds them; `npm run check:job-idempotency`
preflights an existing database for rows that would violate the new constraint.

**Crawler / node provider**

1. Transaction outcomes are no longer fabricated as `SUCCESS`. The fetch batch
   reads historical `System.Events`, decodes them with runtime metadata cached
   by `specVersion`, and maps `system.ExtrinsicSuccess` / `ExtrinsicFailed` by
   `applyExtrinsic` index. Unknown or undecodable outcomes produce no result
   row. New rows carry `outcomeSource=substrate-system-events`; legacy rows with
   no source are never trusted by document/predicate verification.
2. Reconnect handling is registered BEFORE the initial catch-up, so a socket
   drop during the (possibly hours-long) first sync resumes ingestion instead
   of silently bricking the crawler. A connection-loss error is treated as
   transient (awaits reconnect) rather than fatal.
2. When node reconnection is permanently abandoned (max attempts), the crawler
   flips `SyncState` to `error` instead of going idle while still reporting
   healthy.
3. The first finalized head Substrate replays on (re)subscribe is buffered and
   no longer dropped by a registration race.
4. A pruned/racing node returning a null block body is now a retried transient
   error instead of a `TypeError` that aborted catch-up. `chainHeight` only
   advances, so a replayed old head no longer skews lag/health metrics.
5. Extrinsic classification uses the REAL Midnight pallet-index map (read from
   the runtime metadata, specVersion 1000000) instead of the generic Substrate
   defaults, which were wrong for Midnight (e.g. index 5 is `Midnight`, not
   `Sudo`; there is no `Balances`/`Contracts` pallet). System/inherent/governance
   txs now classify correctly instead of falling to `unknown`. The map is
   hardcoded (re-verify on Midnight runtime upgrades; `cds.requires.nightgate.
   palletMap` remains an override). Note: Midnight wraps all user operations in
   one call (`Midnight.send_mn_transaction`), so deploy/call/shielded cannot be
   distinguished at the pallet level.

**Schema / config / packaging**

1. Unique index on `Blocks.hash` (via `@assert.unique`) for the crawler's
   hottest parent-linkage lookup. Upgrade gotcha: on an existing DB the
   constraint is added by `cds deploy` / `scripts/apply-schema-delta.mjs`, not
   automatically. (`Transactions.hash` is intentionally NOT unique: on-chain,
   inherent/system extrinsics in early blocks share identical hashes.)
2. `corsOrigin` arrays now work (reflect the request Origin plus `Vary: Origin`)
   instead of emitting a comma-joined header every browser rejects.
3. `network` config enum includes `preview`; `@sap/cds` peer range tightened to
   `>=10 <11`.
4. Removed dead code (the unused single-block `fetchBlockWithRetry` /
   `fetchBlockData` path) and its tests. Also removed the SQLite tuning pragmas
   (`srv/utils/sqlite-tuning.ts`): they were non-functional (`db.pragma` is not
   available on the pooled connection), WAL is already set by `@cap-js/sqlite`,
   and production SQLite is now rejected outright, so no dev-only pragma tuning
   is applied at startup.
5. `@midnight-ntwrk/compact-js` pinned to `2.5.0` (was `2.5.1`) to match the
   exact version `midnight-js-contracts` / `midnight-js-types` require. The skew
   left two compact-js copies with distinct `TypeId` symbols, so a worker-built
   `CompiledContract` was unrecognised by the SDK's deploy path and contract
   deploys failed with `Cannot read properties of undefined (reading 'ctor')`.
   Now deduped to a single 2.5.0.

**Runtime safety / topology**

1. Fail-closed single-instance guard. Startup now rejects unsupported runtime
   topologies before any schema, worker or crawler work, because the crawler,
   wallet-facade cache, job semaphore and cleanup scheduler are process-local:
   more than one declared replica, CAP multitenancy, or (on Cloud Foundry)
   `CF_INSTANCE_INDEX > 0`. Rejection takes Nightgate offline and surfaces via
   `getHealth`/`getReadiness`/`getLiveness` + Prometheus; the CAP host process is
   never terminated. Replica detection is declarative (`NIGHTGATE_REPLICA_COUNT`,
   `CF_INSTANCE_COUNT`, `KUBERNETES_REPLICA_COUNT`, CDS `replicaCount`);
   `WEB_CONCURRENCY` is ignored (it counts in-instance HTTP workers, not
   replicas). This is a safety backstop, not a distributed lock or leader
   election, so deployment descriptors must still start a single instance.
2. Production SQLite is rejected by the same preflight (configure PostgreSQL or
   SAP HANA). `NIGHTGATE_ALLOW_PRODUCTION_SQLITE=true` is a temporary,
   migration-window-only escape hatch that downgrades the rejection to a
   high-severity warning.

**Logging**

Operational logging moved from raw `console.*` to CAP's leveled logger, one
named channel per subsystem (`nightgate:crawler`, `nightgate:node`,
`nightgate:submit`, `nightgate:facade`, `nightgate:sessions`,
`nightgate:indexer`, `nightgate:sync`, `nightgate:crypto`,
`nightgate:worker-client`, and `nightgate:worker` for the worker thread's
relayed lines). Chatty per-tick/per-block diagnostics are now `debug` (silent
by default, enable per subsystem via CAP log config), so consumers control
verbosity instead of getting raw stdout. The only remaining direct
`console.error` is the deliberate "schema not deployed" operator banner in the
plugin bootstrap, which must print unprefixed before the process exits.

## 0.8.3 - 2026-07-19

### Fix: background-job status writes retried under write contention

The tiny `mark*` status UPDATEs in the job runner had no protection against
SQLite write-lock loss. Observed live under two parallel sponsored runs: a
job's failure write AND its `markFailed` fallback both hit 'database is
locked', the row stayed non-terminal, and the consumer's poller only gave up
at its own watchdog timeout ten minutes later. Now:

1. `markRunning` / `markSucceeded` / `markFailed` and the
   `recoverInterruptedJobs` sweep retry bounded (3 attempts, backoff) on
   `database is locked` / SQLITE_BUSY. Only the status write is retried,
   never the job work itself (no double-submit risk).
2. If `markSucceeded` still cannot land, the job is closed as
   `failed:RESULT_PERSIST_FAILED` with an explicit "on-chain effects may
   exist" message instead of stranding pollers on a forever-'running' row.
3. If even `markFailed` exhausts its retries, it logs the unpersisted
   classification at error level (jobId + code + message) and returns; the
   row is swept by restart recovery.

## 0.8.2 - 2026-07-19

### Fix: wallet-state persist sink hardened against write contention

With many concurrently active facades (sponsor pools, parallel consumer
runs) the periodic state saves kept losing the SQLite write lock to foreign
commit traffic and failed on every tick ('database is locked' storms, up to
pool starvation). `saveSyncState` now serializes ALL persists through one
global in-process chain (across accounts; the CPU-heavy PBKDF2/AES stays
outside it) and retries the short DB section bounded (3 attempts, backoff)
on write contention. Measured with a consumer's 3-way parallel sponsored
runs: zero persist failures, all runs green.

## 0.8.1 - 2026-07-19

### Sponsored submissions: instant callers

Two changes that let a sponsored caller wallet submit within seconds instead
of waiting out a full chain sync:

1. **`NIGHTGATE_SPONSORED_CALLER_SYNC=skip`** bypasses the CALLER's
   genuine-sync wait in the two-phase sponsored balancing. The caller only
   balances shielded/unshielded; a wallet that provably holds nothing (e.g. a
   public demo minting fresh identity wallets) has nothing to select, so the
   wait buys nothing. Default stays `genuine` (safe for callers that hold
   coins). The SPONSOR's sync is unconditional: it spends the dust.
2. **Submission jobs ensure the caller facade on demand.** WalletMaterial
   gains `ensureFacade()` (idempotent worker init, same call the
   connectWalletForSigning prewarm makes); every submission handler invokes
   it before dispatching. A session that was never prewarmed, or whose
   facade was evicted, no longer fails with "No facade for sessionId".
3. **`connectWalletForSigning(prewarm: false)`** skips scheduling the
   sync-to-tip prewarm job entirely. Pair it with the env skip above:
   without it, the background prewarm sync races the submission's on-demand
   facade init on the same account (observed live as an SQLITE_BUSY storm).

## 0.8.0 - 2026-07-18

### Feature: per-transaction fee sponsoring (`sponsorSessionId`)

A new optional `sponsorSessionId` parameter on the submission
actions lets a SECOND wallet session pay the dust fee for a transaction the
calling session builds and signs. The calling wallet needs neither NIGHT nor
dust, ever.

Actions: `deployContract`, `submitContractCall`, `anchorDocument`,
`issuePredicateAttestation`, `issueFieldPredicateAttestation`,
`grantDisclosure`, `revokeDisclosure`, and `deregisterFromDustGeneration`

Mechanics (wallet worker, two-phase balancing per the SDK contract):

1. Caller facade: `balanceUnboundTransaction` with `tokenKindsToBalance:
   ['shielded','unshielded']`, `signRecipe` for any unshielded inputs,
   `finalizeRecipe`. Result: a fully signed, fee-unpaid transaction.
2. Sponsor facade: `balanceFinalizedTransaction` with `tokenKindsToBalance:
   ['dust']` ONLY (re-balancing the caller's kinds would double-spend),
   `finalizeRecipe`, and the SPONSOR submits. Both phases share one TTL.
   The sponsor wallet is genuine-synced before balancing dust (117 guard).

Authorization guard: a caller may sponsor from its OWN sessions; cross-user
sponsoring requires the operator to list the sponsor session id(s) in
`NIGHTGATE_FEE_SPONSOR_SESSION` (comma separated) or cds config
`feeSponsorSessions`. Foreign non-listed session ids read back as 404.
The sponsor session must be signing-capable (`connectWalletForSigning`).
Job request and result carry `feeSponsor` for audit; worker logs name the
sponsor on every sponsored dispatch.

## 0.7.3 - 2026-07-18

### Feature: `deriveWalletInfo` returns the wallet's DUST address

New `dustAddress` field (`mn_dust_<network>...`) on the derivation result,
computed facade-free from the dust role seed
(`DustSecretKey.fromSeed(...).publicKey` + `DustAddress.encodePublicKey`).
This is the missing input for dust GENERATION DELEGATION (fee sponsoring):
register a funded wallet's NIGHT with another wallet's `dustAddress` as
`dustReceiverAddress` on `registerForDustGeneration`, and that wallet accrues
the dust and pays its own fees while holding zero NIGHT. Proven live on
preview: a zero-NIGHT wallet anchored a full attestation flow from sponsored
dust.

### Fix: `deregisterFromDustGeneration` works again (two bugs)

1. The worker read the full coin set from `synced.unshielded.allCoins`, which
   the current wallet SDK renamed to `totalCoins`; deregistration silently
   reported 0/0 with registered UTXOs present. Now
   `totalCoins ?? allCoins ?? coins`.
2. The SDK's deregistration recipe is fee-less by design (`allowFeePayment`
   0, no dust spends) and expects the CALLER to balance the fee via
   `balanceUnprovenTransaction(tx, keys, { ttl, tokenKindsToBalance:
   ['dust'] })`; submitting unbalanced is rejected by the node with
   `1010 Custom error: 138` (BalanceCheckOverspend). The worker now balances
   before finalizing. Note: the recipe is already fully signed; re-signing
   after balancing duplicates the offer signatures (`1010/192`), so it is
   balance -> finalize -> submit.

Receiver rotation (deregister, then register with a new
`dustReceiverAddress`) is thereby possible and live-verified. Inherent limit:
a wallet whose entire generation is delegated away has no dust to pay its own
deregistration fee.


## 0.7.2 - 2026-07-15

### Config: signing-key rate limit raised to 10/hour and made tunable

The limiter shared by `connectWalletForSigning` and `deriveWalletInfo` now
defaults to 10 requests/hour/IP (was 5) and can be overridden via
`NIGHTGATE_SIGNING_KEY_RATE_LIMIT`. Motivation: multi-wallet consumers that
prewarm every configured server wallet at login (one `connectWalletForSigning`
per wallet per server run) exhausted the old budget during demos. The bound
stays tight; the other limiters are unchanged.

## 0.7.1 - 2026-07-15

### Config: one indexer URL is enough (ws endpoint derived)

`NIGHTGATE_INDEXER_WS_URL` / `indexerWsUrl` is now optional: when only the
HTTP URL is overridden (env, config, or a `networks.<network>` entry of the
verify `network` override), the GraphQL subscription endpoint is derived from
it (`http -> ws` scheme plus `/ws` suffix, the pattern every known indexer
deployment follows, hosted and indexer-standalone alike). Previously,
overriding only the HTTP URL silently paired it with the built-in default WS
endpoint of the configured network: a mixed pair pointing at two different
indexers. An explicit WS URL still wins for setups that serve subscriptions
somewhere non-standard; configs that set both are unchanged. The wallet
worker's dust-stream probe reuses the same shared helper
(`srv/utils/indexer-url.ts`, cds-free so the worker thread does not pull in
`@sap/cds`).

### Docs: README consolidated

Highlights + service/write/read/browser surface merged into one "Services &
capabilities" table, a key-env-vars block added to the quick start,
`.env.example`s and `docs/reference.md` updated to the single-URL indexer
setup, stale test-runner facts refreshed (Vitest, 63 suites / 1104 tests).

## 0.7.0 - 2026-07-14

### Feature: optional `network` override on the crawler-free verify surface

`verifyAttestationState` and `verifyPredicateState` accept a new optional
`network` parameter (`preview` | `testnet` | `preprod` | `mainnet` |
`undeployed`). The live-state read is stateless and wallet-free, so a server
configured for one network can now verify an anchor on another network's
public indexer without a second NIGHTGATE process. Omitting the parameter, or
passing the configured network, keeps today's behavior bit-for-bit (top-level
config and `NIGHTGATE_INDEXER_*` env overrides keep winning for the configured
network); an unknown value is a 400, never a silent fallback. A different
valid network swaps ONLY the indexer endpoints: built-in public defaults, or
`cds.requires.nightgate.networks.<network>.indexerHttpUrl/indexerWsUrl` for
non-default indexers. Proof server, zkConfig and the compiled artifact stay as
configured (artifacts are network-agnostic; the read path never proves).

Deliberately NOT on `reindexDisclosures` (it writes `DisclosureGrants` rows
the read gate consumes; mixing networks there needs its own design), nor on
the DB-backed fallbacks of `verifyDocument` / `verifyPredicateAttestation`
(the local `Transactions` table is by definition the configured network), nor
on any submission path (wallet sessions are network-bound).

Requested by NIGHTPASS (Passport Explorer, cross-network verification);
replaces the per-network peer-instance workaround
(`docs/feature-requests/verify-state-network-override.md`).

### Config: `kind: "nightgate"` retired from the documented consumer config

The `kind` marker never did anything: NIGHTGATE registers no CAP kind preset,
and the configured-check always reduced to "is a network selected". Worse, the
docs' minimal config (`{ "kind": "nightgate" }` alone, "defaults to preprod")
did NOT actually start the crawler - without a `network` the plugin stays
idle by design (never auto-crawl a chain nobody chose). The documented minimal
consumer config is now the one that works:

```json
"nightgate": { "network": "preprod" }
```

Existing configs that still carry `"kind": "nightgate"` keep working - the
marker is inert and ignored. `isNightgatePluginConfigured` is simplified to
exactly that predicate, and the dead `kind`/empty-`kinds` entries are removed
from the plugin's own package.json.

### Internal: test suite migrated from Jest to Vitest

CAP 10 deprecated the Jest harness (Vitest is the successor), so the full
suite now runs under Vitest 4; jest/ts-jest/@types/jest are removed. No
runtime code changed. Full run drops from ~60s to ~14s (test files now run in
parallel fork processes; each fork has its own env, in-memory DB and ports).

A coverage review after the migration closed the largest unit-test gaps
(63 suites / 1097 tests total): the deriveWalletInfo handler + the
rejection ladders of every token-op/diagnostics action and the TTL-cleanup
facade eviction (wallet-sessions 77→92%), the parallel catch-up fetch
pipeline incl. batch de-interleaving (BlockProcessor 70→97%), every
CoercionError branch (arg-coercion 100%), and - newly possible because
Vitest imports the ESM SDK - the off-chain claim-key recomputation pinned
byte-exact against the spike-verified encoding with the REAL compact-runtime,
plus both crawler-free state-reader production wrappers (predicate-state
32→100%, attestation-state 100%). The wallet worker itself is now driven
in-thread with a mocked parentPort + stubbed SDK seam
(wallet-worker-dispatch.test.ts): RPC dispatch and error protocol, boot
guard, facade lifecycle incl. restore-vs-fresh and the dust cold-start
flag, the genuine-sync gate (dust stream tip vs appliedIndex, freshness),
and the periodic-save push/ack/unchanged-skip protocol (0→37%); the facade
OPERATION bodies (transfer/shield/unshield/dust/deploy) intentionally stay
covered by the live e2e scripts.

A follow-up sweep covered the remaining substantive gaps: the FULL
issueFieldPredicateAttestation handler (0.4.3's field-bound predicate  -
validation ladder, witness-only value transport, optional content-root
anchoring), REAL-SDK HD-derivation regression tests pinning the live-verified
Lace per-role derivation byte-exact (wallet-hd 26→97%, wallet-info 41→100%  -
the exact site of the 2026-05 wrong-account bug), the crawler's batch-retry
policy, MidnightNodeProvider's rpcBatch protocol (order-by-id, batch errors,
timeouts) and connect/subscription edges, plus rate-limiter capacity/sweep,
SCALE MultiAddress variants and contract-registry guards
(handlers.ts 81→96%; overall statements 87%, lines 89%). The worker's
Custom-error-117 guards are unit-tested too: `describeTxDust` (the intent
dust dump that makes a 117 attributable) and `buildWorkerWalletProvider`'s
balanceTx fail-fast on an empty DustActions section + submitTx pre-submit
warn (wallet-worker 0→51% overall; the remaining half is the SDK
choreography of the token/deploy op bodies, live-e2e territory).

Coverage attribution fix: cds.test() boots the services from the compiled
`srv/*.js` via native require, OUTSIDE vitest's module graph - handlers
exercised through the booted server were counted as uncovered on the `.ts`
sources (jest intercepted every require, so its numbers never showed this).
The in-place build now emits sourcemaps (`tsconfig.build.json`
`sourceMap: true`; maps are not published and `npm run clean` removes them)
and the coverage include also lists `srv/**/*.js`, so the v8 provider remaps
booted-server execution back onto the `.ts` sources
(nightgate-service.ts 26→98%, nightgate-indexer-service.ts 64→97%). Overall
statement coverage lands at 83% (lines 85%); statement/line are the robust
metrics - the function metric gets noisier through the merged maps.
Two behavioral notes for test authors, also recorded in CLAUDE.md: vi.mock
factories cannot read non-hoisted top-level variables (use `vi.hoisted`), and
mocks do NOT reach the CAP-booted service (cds.test() loads compiled `srv/*.js`
via native require; stub such collaborators with `vi.spyOn` on the natively
required module instead).

## 0.6.9 - 2026-07-13

### Fix: only the deploying wallet could call a contract

`submitContractCall` passed `findDeployedContract` a `privateStateId` but never
an `initialPrivateState`. The private-state store is per wallet and only
`deployContract` seeds it, so any OTHER wallet calling an existing contract
failed with `No private state found at private state ID '<id>'`. That blocked
the entire multi-caller case: several wallets acting on one shared contract
(N producers anchoring in one AttestationVault, N agents on one counter).

`submitContractCall` now scopes the store to the contract
(`setContractAddress`, required before the read or the store rejects it),
checks whether this wallet has a private state for the contract, and seeds one
ONLY when it is absent (default `{}`, what a stateless contract deploys with).
An existing private state is never handed to the SDK's `initialPrivateState`
variant, which would overwrite it. New optional `initialPrivateState` (JSON) on
the action for contracts whose private state is not empty.

Found and live-verified by NIGHTPASS: a programmatically created producer
wallet anchoring in the vault deployed by another wallet
(`docs/feature-requests/contract-call-private-state-seeding.md`).

## 0.6.8 - 2026-07-13

### Fix: unshielded token ops rejected with `1010 Custom error: 192`

`sendNight` (and the `shieldFunds` / `unshieldFunds` swap paths) built
transactions whose UNSHIELDED inputs carried no signatures: the facade's
`transferTransaction` / `initSwap` recipes must pass through
`facade.signRecipe(recipe, signFn)` before `finalizeRecipe`, since unshielded
inputs are signature-authorized (unlike proof-authorized zswap inputs). The
node rejected every such submission at the mempool with
`1010 Custom error: 192`, decoded from midnight-node source as
`MalformedError::InputsSignaturesLengthMismatch`. Register/deregister were
unaffected (their facade APIs take the sign function directly). All three ops
now sign the recipe with the session's unshielded keystore; a recipe without
unshielded inputs signs as a no-op. Found live while funding fresh producer
wallets from an existing preview wallet.

## 0.6.7 - 2026-07-13

### deriveWalletInfo: programmatic wallet creation without Lace

Implements FR `docs/feature-requests/derive-wallet-info.md` (requested by
NIGHTPASS for its one-instance-per-producer topology and by EQUINOX).

- **New action `deriveWalletInfo(mnemonic|seedHex, accountIndex?)`**: derives a
  wallet's connectable identity (`viewingKey`, `shieldedAddress`,
  `nightAddress`) as a pure function of the secret. No session, nothing
  persisted, the secret never logged; role seeds are zeroed and zswap secret
  keys cleared after use. Rate-limited like `connectWalletForSigning` (the
  request carries secret material). Derivation is identical to the signing
  path (per-role HD seeds, Lace-exact), so the derived identity IS the account
  `connectWalletForSigning` signs with for the same secret. Generating the
  mnemonic itself stays consumer-side by design (`bip39.generateMnemonic`);
  the service never returns private key material.
- **`deriveRoleSeeds` gains an optional `accountIndex`** (default 0,
  bit-identical to before): one phrase can host multiple independent wallet
  accounts (e.g. one per producer).
- New integration check `npm run integration:derive-wallet-info` verifies the
  derived shielded address against the live Lace reference account, the
  seedHex/mnemonic equivalence, account-index independence and per-network
  encoding. Validation paths are unit-tested (`test/unit/wallet-info.test.ts`).

## 0.6.6 - 2026-07-12

### Wallet persistence hardening (latent bugs from the error-117 review)

Four defects found during the Custom-error-117 investigation, none the cause
of that incident but each real. Two further review findings were verified and
closed as not-bugs: the missing save-after-submit (wallet state is provably
reconstructable from the public event stream, a lost 30s window only costs
seconds of replay) and the missing per-account submit mutex (the SDK's
`SubscriptionRef.modifyEffect` serializes concurrent balancing under a
semaphore, so parallel spends cannot double-select dust notes).

- **Evict final-save no longer dropped**: `evictWalletFacade` deleted the
  session registry entry BEFORE awaiting the worker evict, so the worker's
  final `state-save` push always arrived with no registered session and was
  discarded (every disconnect/expiry lost up to 30s of state). Order swapped;
  the registry entry now outlives the evict RPC.
- **Failed persists are retried**: the worker marked blobs as saved when it
  PUSHED them, not when the main thread persisted them; one transient
  "database is locked" during a save tick stranded the persisted row until
  the wallet state next changed. New `state-save-ack` protocol: the main
  thread acks a save only after `saveSyncState` succeeded (drops and failures
  do not ack), and the worker re-pushes unacked blobs on the next tick.
- **Cross-network restore guard**: `WalletSyncStates` gains a nullable
  `networkId` column, written with every save; `loadSyncState` refuses a row
  whose stored network differs from the running one (cold start instead of
  restoring another network's state). The accountId is network-agnostic, so
  this trap previously relied on operators wiping the table manually.
- **Cross-wallet restore guard**: `WalletSyncStates` gains a nullable
  `seedFingerprint` column (HMAC of the bip39 seed); `loadSyncState` refuses
  a row written by a different seed, so wallet A's blobs can no longer be
  restored into a facade running wallet B's keys via a shared viewing key.
  (A direct viewing-key-from-seed assertion is not implementable: the Lace
  viewing key is not derivable from the seed via the SDK's key derivation,
  verified empirically against a live wallet.)

**Consumer upgrade note**: the two new columns are ADDITIVE. Do not
`cds.deploy` over a live database (drop+create); run
`ALTER TABLE midnight_WalletSyncStates ADD COLUMN networkId TEXT;` and
`ALTER TABLE midnight_WalletSyncStates ADD COLUMN seedFingerprint TEXT;`
instead. Pre-existing rows have NULL in both and keep restoring as before;
the guards engage as soon as the first post-upgrade save stamps them.

## 0.6.2 - 2026-07-09

### SECURITY: AttestationVault attest() ownership takeover fixed

`attest()` inserted into `attestation_owners` with no guard, and Compact's `Map.insert` overwrites. `payload_hash` is public on-chain, so anyone could re-attest a known hash, become the recorded owner, and then pass every owner-gated assert (`grantDisclosure` / `revokeDisclosure` / `commitValue` / `bindPassport` / `anchorContentRoot`), e.g. self-grant an authority disclosure or revoke legitimate grants.

- **Fix**: `assert(!public_attestations.member(disclose(payload_hash)), "already attested")` at the top of `attest`; attestations are now first-come-first-served per payload_hash. There is deliberately no update path yet; re-anchoring the same document now fails with `already attested`.
- Recompiled `managed/` artifact committed (compactc 0.31.0, WSL; 8 circuits, attest prover/verifier keys and zkir changed). **Only newly deployed vaults get the guard**; vaults already on chain keep the vulnerable attest and should be redeployed if takeover matters for them.
- Regression check added to `scripts/integration-test-attestation-vault.mjs`: drives the real emitted circuits via compact-runtime; re-attest rejected, non-owner still fails owner-gated circuits, prior grants survive, fresh hashes attest. Also repaired the script's (and `spike-disclosure-indexer.mjs`') stale 3-field witness stubs, broken since the 0.4.3 field-predicate witnesses were added.
- Known remaining overwrite of the same class, NOT changed here: `bindPassport` lets the owner of ANY attestation re-bind an already-bound `passportId` to their own attestation (`passport_bindings.insert` overwrites, no current-binding ownership check).

## 0.6.1 - 2026-07-09

### Wallet SDK migrated to the @midnightntwrk scope (fixes the sync stall)

The wallet-sdk family moved upstream from `@midnight-ntwrk/*` (frozen) to `@midnightntwrk/*`; 0.6.0 still resolved the dead scope, whose packages lack the indexer-4.3.x-era fixes (WebSocket subscription leak, `DustGenerationDtimeUpdate` handling in the dust subscription, prover-client compatibility with undici >= 8.2) and starve server-side cold syncs under the indexer 4.3.3 per-connection subscription quotas. FR: `docs/feature-requests/migrate-wallet-sdk-scope.md`.

- **Deps** (pins per the `@midnightntwrk/wallet-sdk@1.2.0` barrel): facade ^4.1.0, shielded ^3.0.2, dust-wallet ^4.2.0, unshielded-wallet ^3.1.0, hd ^3.0.3, address-format ^3.1.2, abstractions ^2.1.0. `ledger-v8`, `compact-js`, `compact-runtime` and all `midnight-js-*` stay in the old scope (not migrated upstream). `npm ls --all` resolves every wallet-sdk package to `@midnightntwrk/*` code, so no dual-scope class-identity mixing.
- **Phantom-dep shim**: `midnight-js-utils@4.0.4` imports `@midnight-ntwrk/wallet-sdk-address-format` at runtime without declaring it (previously satisfied by our own hoisted old-scope dep). Satisfied via npm alias `"@midnight-ntwrk/wallet-sdk-address-format": "npm:@midnightntwrk/wallet-sdk-address-format@^3.1.2"`, i.e. the new-scope code under the old name; only strings cross that boundary (`parseCoinPublicKeyToHex` and friends). Drop the alias when `midnight-js-*` is bumped to >= 4.1.1, which declares the dep properly.
- **Import sweep**: `sdk-loader.ts`, `wallet-worker.ts`, `wallet-hd.ts`, integration scripts, test mocks.
- **`getWalletSdkVersion()`** (and the worker's twin) now locate the facade `package.json` by walking `require.resolve.paths()`, since the package's `exports` map exposes neither `./package.json` nor a `require` condition; the sync-state stamp reports the real version instead of `wallet-sdk-facade@unknown`.
- **Upgrade note**: persisted wallet sync-state blobs are stamped with the SDK version, so the version change discards pre-migration blobs and forces one cold re-sync per wallet. That is intended: blobs written by the frozen SDK predate the quota-aware subscription handling.
- Verification: typecheck, lint, 54/54 suites with 863/863 tests, smoke:sdk (8/8 SDK packages), integration:contract-registry, `npm audit` 0 findings.

## 0.6.0 - 2026-07-09

### CAP 10 toolchain + Int64/Decimal string coercions

Toolchain lifted to `@sap/cds` 10.0.3; code keeps running in both CAP 9 and CAP 10 hosts (peer stays `@sap/cds >=9.0.0`). Full notes: `docs/release-0.6.0.md`.

- **CAP 10 toolchain**: `@sap/cds ^10`, `@sap/cds-dk ^10`, `@cap-js/sqlite ^3` (better-sqlite3 12), `@cap-js/cds-test ^1`, `@cap-js/cds-types ^0.18`, `@cap-js/cds-typer ^0.40`, `eslint ^10`. Node >= 22 is required (CAP 10 minimum; engines field unchanged).
- **Int64/Decimal coercions**: CAP 10 returns Integer64/Decimal values from the DB as strings. All arithmetic read sites are coerced; this also fixes a catch-up bug that would have surfaced under CAP 10 (`"0" + 1 = "01"` as the start height). `getHealth`/`getMetrics` contractually keep returning numbers.
- **cds-typer workaround**: `cds:types` runs with `--outputDTsFiles false` because the new default emission (.d.ts + .js) crashes tsc 5.9.
- **Config**: sqlite credentials are now named `url` instead of the deprecated `database`.
- **Consumer note**: no schema delta, no API change. In a CAP 10 host, OData serializes Integer64/Decimal fields (heights, balances, amounts) as **strings**; coerce accordingly in client code. CAP 9 hosts are unaffected.
- Verification: typecheck, lint, 54/54 suites with 863/863 tests, smoke:sdk (8/8 SDK packages), integration:providers, integration:contract-registry, `npm audit` 0 findings.

## 0.5.2 - 2026-07-09

### Code hardening: admin-gated indexer ops, gapless catch-up, reorg-safe NightBalances, scoped reads

- **Admin gating**: `pauseCrawler` / `resumeCrawler` / `reindexFromHeight` now `@requires: 'admin'` (probes/status stay open for K8s/Prometheus).
- **Gapless catch-up**: a failed batch is re-queued once, then the crawler stops with syncStatus `error` instead of skipping heights; height-sequenced persists refuse orphan blocks (missing parent above genesis throws).
- **Reorg-safe NightBalances**: shared rollback utility (`srv/crawler/rollback.ts`) for reorg + manual reindex recomputes NightBalances per affected address from the remaining rows, so rollback + re-index can no longer double-count balances. `reindexFromHeight` runs its rollback in an explicit committed tx before the crawler restarts.
- **Reorg height guard**: replayed finalized heads are ignored, gaps trigger catch-up instead of rollback, genesis replays never roll back.
- **Scoped reads**: `WalletSessions` / `PendingSubmissions` entity READs are scoped to the requesting user (admins unfiltered); no schema change.
- `protocolVersion` is queried per batch/block; the cache is only an RPC-error fallback.
- Deps: `npm audit` clean (prod: path-to-regexp/undici/ws/qs chain; dev: cds-dk 9.9.3, tsx 4.23); package.json ranges unchanged. Tests: 863/863 (25 new).

## 0.5.1 - 2026-07-07

### verifyPredicateState: id-free crawler-free predicate verification

- Exposes `readPredicateStateForContract` as a first-class service function keyed by claim coordinates (`payloadHash`, `fieldKey?`, `predicate`, `threshold`), so wallet-submitted predicate proofs self-confirm without a `PredicateAttestations` row, a txHash, or the block crawler. Mirrors `verifyAttestationState`.

## 0.5.0 - 2026-07-07

### Crawler-free state verification + auth hardening

Adds crawler-independent on-chain state verification and fixes the review_001 P1-P3 security findings. A consumer whose transactions do not flow through NIGHTGATE's own submission pipeline (e.g. a browser wallet signs and submits, handing back only a txHash) can now confirm the on-chain **effect** directly against live contract state. Full notes: `docs/release-0.5.0.md`.

- **Crawler-free verification** (all read live contract state via `indexerPublicDataProvider.queryContractState`; clean negative, not a 5xx, when no live provider is configured):
  - `verifyAttestationState(contractAddress, payloadHash, contentRoot?)` confirms a payload hash is present in the vault's attestation map (and, when supplied, that the anchored content root matches).
  - `reindexDisclosures(contractAddress)` reconciles `DisclosureGrants` on demand from live state, for wallet-submitted grant/revoke that bypass the plugin pipeline.
  - `verifyDocument` / `verifyPredicateAttestation` fall back to live state when the local `Transactions` table has no matching row. `verifyDocument` gains optional `contractAddress` / `compiledArtifactRef` (non-breaking). Predicate claim keys are recomputed off-chain (`persistentHash` of `PredicateClaim` / `FieldPredicateClaim`, byte-exact per `scripts/spike-state-verification.mjs`) and looked up in `predicate_results` / `field_predicate_results`.
  - New readers `srv/submission/attestation-state.ts` and `predicate-state.ts`; live e2e via `npm run state-verify:e2e`.
- **Security hardening (review_001)**:
  - P1: sessions bound to the owning principal via new `WalletSessions.userId`; every session action, `buildWalletMaterialForSession` (`expectedUserId`), and `getJobStatus` scope to `req.user.id`. Foreign sessionId reads back as 404, unauthenticated callers get 401.
  - P1: **`allowSelfServiceGranteeRegistration` now defaults to `false`** (was `true`); NIGHTGATE cannot verify ownership of the binding input, so the safe default is off.
  - P2: admin `invalidateSession` / `invalidateAllSessions` and the TTL cleanup now null both encrypted keys and evict the cached `WalletFacade`.
  - P3: `jest.config.js` `testTimeout: 60000`.
- **Upgrade**: two new columns, `WalletSessions.userId` and `PredicateAttestations.fieldKey`. Fresh installs get them via `cds deploy`; on an **existing** DB run `scripts/apply-schema-delta.mjs` (now reconciles missing columns via `ALTER TABLE ADD COLUMN`) to avoid a data wipe. Legacy sessions without `userId` read back as 404, so users reconnect once. Tests: 827/827.

## 0.4.3 - 2026-07-02

### Field-bound predicate proofs

Binds a proven predicate value to a **specific passport field** via a Merkle content root, so a verifier knows the value came from *this* attestation, not an arbitrary committed number. Live-verified on Preview.

- **Compact** (`attestation-vault.compact`): new `anchorContentRoot(payload_hash, content_root)` + `proveFieldPredicate(payload_hash, field_key, threshold, op)` circuits. The circuit recomputes the field's Merkle leaf from the witnessed value + inclusion path, folds to a root (depth-4, unrolled), asserts it equals the anchored content root, then checks the predicate. Pure `leafHash` / `nodeHash` exported so the off-chain builder hashes identically.
- **Consolidation**: `bindPassport` (+ `passport_bindings`) folded in from the former NIGHTPASS passport-attestation contract; one contract now covers the full surface. Recompiled `managed/` (compactc 0.31.0): 8 circuits + prover/verifier keys.
- **Plugin wiring**: `merkleProof` threaded through both witness builders (browser + server, kept in lockstep) and the full wallet-worker RPC path. New `issueFieldPredicateAttestation` action + handler (anchors the root if needed, then proves); browser prepare helpers.

## 0.4.2 - 2026-07-01

### Preview network support

Adds the Midnight **Preview** network (the active public dev chain since 2026-01-07) as a first-class option, so both the server-side submission path and consumers can target it. Previously `network: "preview"` was rejected and silently fell back to preprod.

- **`preview` is now a valid `NightgateNetwork`** (`cds.requires.nightgate.network`), with default endpoints: indexer `https://indexer.preview.midnight.network/api/v4/graphql` (+ WS), node `wss://rpc.preview.midnight.network/`. Proof server via `--network preview` (docker-compose `NIGHTGATE_PROOF_NETWORK`).
- Replaced two hard-coded network unions in `TransactionSubmitter` (`TransactionSubmitterDeps.network`, `classifySubmissionError`) with the canonical `NightgateNetwork` type so they no longer drift.
- Live-validated: the browser connector (NIGHTPASS) ran a full deploy + attest + zero-knowledge predicate round-trip on Preview against the public indexer. Tests 779/779, typecheck clean.

## 0.4.1 - 2026-06-29

### Undeployed local network + connector-route tests

- **`networkId: 'undeployed'`** is now a first-class network, so the plugin can run against a local midnight-local-dev stack (node :9944, indexer :8088, proof-server :6300) without Preview funding or tDUST. Verified against a live `indexer-standalone:4.3.2`.
- `nightgate-config`: `undeployed` added to the valid networks + local node/indexer defaults; network unions widened; config schema enum extended.
- `/zk-config` + `/contract-manifest` routes extracted into `src/connector-routes.ts` so the real handlers are testable on a bare Express app (no cds lifecycle). Behavior unchanged.
- New `scripts/integration-test-connector-routes.mjs` (27 assertions: manifest, ETag/304 caching, registry 404 boundary).

## 0.4.0 - 2026-06-29

### Browser / connector surface for wallet-driven AttestationVault calls

Exposes NIGHTGATE building blocks so a browser dApp (NIGHTPASS via the Lace DApp-Connector) can attest / grant / revoke on the AttestationVault without the Compact toolchain or a copy of `managed/`. The headless server-side submission path is unchanged.

- **`@odatano/nightgate/browser` (ESM)**: attester-secret derivation + witnesses, `FetchZkConfigProvider`, `InMemoryPrivateStateProvider`, `createNightgateConnectorProviders`, and `prepareAttest` / `prepareGrantDisclosure` / `prepareRevokeDisclosure` call helpers. New `./browser` and `./browser/attestation-vault` subpath exports; `check:browser` script; optional `@midnight-ntwrk/dapp-connector-api` peer dep.
- **HTTP routes** (mounted in the security-header bootstrap hook): `GET /zk-config/<contract>/{keys,zkir}/<circuit>` (ETag / 304 / cache) serves a contract's proving artifacts, and `GET /contract-manifest` advertises network, zk-config base URL, and registered contracts. Only registered contracts are servable: `contract-registry.getContractRegistration()` is the security boundary.
- **Manifest address pinning**: optional `cds.requires.nightgate.contracts.<name>.address` is advertised in the manifest so connector consumers can self-configure.
- **Wallet sync-gate fix**: `waitForGenuineSync` reads `facade.state()` instead of blocking on `waitForSyncedState()`.
- **Tooling**: Node `>=22` (`engines`), CI matrix moved to 22.x / 24.x, eslint browser globals for `src/browser/**`.

Live-validated on preprod through prove + balance via Lace; submit is gated only by wallet DUST.

## 0.3.6 - 2026-06-09

### Disclosure-grants hardening and cleanup

- **No more orphan optimistic rows**: `grantDisclosure` now reuses an existing `DisclosureGrants` row for the same `(contractAddress, payloadHash, grantee)` (re-affirming `level` and clearing a stale `revokedTxHash`) instead of inserting a duplicate on every retry/re-grant.
- **Sweep grace window**: the post-submit reindexer no longer deactivates active rows modified within the last 10 minutes (`sweepGraceMs`, injectable). Protects just-submitted grants from being swept when the queried node/indexer view lags the chain; explicit revokes are unaffected (the revoke handler flips its own row directly).
- **Self-service grantee registration is now gateable**: new `cds.requires.nightgate.allowSelfServiceGranteeRegistration` config (env: `NIGHTGATE_ALLOW_SELF_SERVICE_GRANTEE_REGISTRATION`). Default `true` (shipped 0.3.4 behavior). Set `false` on deployments where identities must come from an operator proofing flow - NIGHTGATE does not verify that a caller *owns* the binding input it registers, so open self-registration allows squatting a grantee id under `wallet`/`did` binding.
- **`contractAddress` normalized to lowercase** at every write/read boundary (grant/revoke handlers, reindexer, on-chain role gate), so mixed-case caller input can no longer split one logical grant across case-variant rows or miss the lookup.
- **Cleanups**: removed a dead `try/catch` around `Number(level)`; the wallet-worker sync snapshot timeout timer is now cleared (no stray 30 s timers per poll iteration).

## 0.3.5 - 2026-06-09

### Wallet sync robustness

- **`getWalletBalance` fix**: read the dust balance from the synced `FacadeState`'s `DustWalletState` (`synced.dust.balance(now)`), not `facade.dust` (a `DustWalletAPI` with no `balance()`). The latter threw `dust.balance is not a function` (HTTP 500).
- **Genuine-sync gate** (`waitForGenuineSync`): the SDK's `isSynced` flag is unreliable: when the wallet never receives a chain tip, `highestIndex` stays `0` and `isSynced` is trivially true (`appliedIndex >= 0`) while the wallet is 100k+ blocks behind. Balancing then spends dust whose merkle roots have pruned out of the node's ~1h `root_history`, so the node rejects the tx with `Custom error 117` (NotNormalized / empty dust actions). The worker now polls the dust `appliedIndex` against the indexer's **real** tip and refuses to submit with a clear `"wallet N blocks behind"` instead of building a doomed stale-dust tx. Wired into the prewarm sync + `balanceTx`. Known limit: the public preprod endpoints stall the dust catch-up, so a far-behind wallet needs a stable local indexer to reach the tip.

## 0.3.4 - 2026-06-07

### 2026-06-07: On-chain disclosure grants (for NIGHTPASS)

Surfaces the existing attester-gated `AttestationVault` tiered-disclosure ACL through the plugin so tier **entitlement** becomes on-chain source of truth. No Compact change: the `grantDisclosure` / `revokeDisclosure` circuits already existed. Live-validated on preprod through grant → chain index → `active=true` read-back (the live revoke is pending, blocked by a preprod indexer / dust-sync limitation, not the feature). FR: `docs/feature-requests/expose-disclosure-grants.md`.

- **Write side**: `grantDisclosure` / `revokeDisclosure` async-job OData actions on `NightgateService`. Attester-only (enforced in-circuit), idempotency-key dedupe, rate-limited, mainnet-gated.
- **Read side**: `DisclosureGrants` entity, chain-derived from the on-chain `disclosures` ledger Map via the artifact's `ledger()` decoder. The outer map is **not iterable** (member/lookup only), so grants are enumerated via the iterable `attestation_owners` then drilled into the inner per-payload map. Reconciled to on-chain state by a best-effort post-submit reindexer (`srv/submission/disclosure-indexer.ts`).
- **Grantee binding**: `cds.requires.nightgate.granteeBinding` (`wallet` | `did` | `custom`, default `wallet`) + `GranteeIdentities` entity + `registerGranteeIdentity` action + `deriveGranteeId` / `resolveGranteeId` (`srv/submission/grantee-identity.ts`).
- **Gate**: `attachDisclosureRole({ contractAddress, payloadHash? })` resolves the tier from the on-chain ACL (level `0/1/2` → `public_only` / `legitimate_interest` / `authority`) when a contract scope is given, and is authoritative there; without a scope it falls back to the off-chain `DisclosureRoles` table (unchanged behavior).
- **Tooling / migration**: `npm run disclosure:e2e` (live e2e) + `scripts/apply-schema-delta.mjs`, which additively creates the new tables (`DisclosureGrants`, `GranteeIdentities`) on an existing database. `cds-serve` does **not** auto-create them, so **existing consumers must run this (or `cds deploy`) on upgrade** or reads/writes fail with `no such table`. Tests: 767/767.

## 0.3.3 - 2026-06-05

### 2026-06-05: Code-quality cleanup

- Refactor + readability pass across multiple files; no functional or behavioral change.
- Removed the superseded `db/enhancements.md`, purged internal task references, and renamed the deploy e2e script.

## 0.3.2 - 2026-06-01

### 2026-06-01: Typed argument coercion for `submitContractCall`

The generic `submitContractCall` action can now pass `Bytes<N>` (and other non-JSON-native) circuit arguments. Previously only the built-in `attest` / `commitValue` / `provePredicate` wrappers (which encode internally) worked, so any consumer-registered circuit taking `Bytes<N>` was uncallable via the public OData surface. Reported by NIGHTPASS (T19); unblocks calls like `bindPassport(passportId: Bytes<32>, …)`. FR: `docs/feature-requests/submitcontractcall-bytes-args.md`.

- New `srv/submission/arg-coercion.ts`, wired into the `submitContractCall` handler. Two encodings supported: introspected convention (circuit arg types from the artifact's `contract-info.json`) and explicit tagged values. Invalid hex / wrong byte length / non-integer `Uint` surface as a clean `400`, not a deep circuit type error.
- Docs: `docs/actions.md` → *Encoding circuit args*. Tests: full suite 709/709 (+18).

## 0.3.1 - 2026-05-31

### 2026-05-31: Packaging, consumer subpath exports

- Added `./cds-plugin`, `./cds-plugin.js`, and `./package.json` subpath exports so consumers and CAP tooling resolve the plugin entry cleanly. `.gitignore` housekeeping. No runtime behavior change.

## 0.3.0 - 2026-05-29

### 2026-05-29: ZK predicate attestations (on-chain-verified)

Extends `AttestationVault` from commitment + disclosure-grant into **proving a predicate** (`value ≤ / ≥ threshold`) over a hidden numeric value, without revealing the value - NIGHTGATE's differentiator for Tractus-X / Battery Passport. Verified live on preprod: `47300 ≤ 50000` accepted on-chain; `51 ≤ 50` rejected by the circuit (`failed assert: predicate false`).

- Compact circuit (`contracts/attestation-vault`): new `commitValue` + `provePredicate` circuits, `value_commitments` / `predicate_results` ledger maps, `attested_value` / `value_salt` witnesses, `persistentCommit`-based numeric commitment. Existing `attest` / `grantDisclosure` / `revokeDisclosure` unchanged; recompiled `managed/` artifacts committed.
- New OData actions on `NightgateService`: `issuePredicateAttestation` (async job: `commitValue` → `provePredicate`) and `verifyPredicateAttestation` (confirms the proof tx resolves to a SUCCESS result, mirroring `verifyDocument`). New `PredicateAttestations` entity - it never stores the hidden value or salt.
- Per-call witnesses thread through `submitter.call` → wallet-worker → `withWitnesses`; the hidden value travels only as a circuit witness, never as a circuit arg.
- PAC envelope helper `toPredicateEnvelope` (`digestMultibase` / `claim` / `proof`) in `src/sdk/AttestationService.ts` for consumer apps.
- Verification model: Midnight exposes no standalone off-chain proof verifier, so verification is on-chain/indexer-trust - the ledger only includes the tx if the in-circuit predicate + commitment asserts held. VK-only portable verification is deferred.

### 2026-05-29: Private-state + sync robustness fixes

Both exposed by the first live deploy→call sequence (T15 was deploy-only; contract calls had only ever been mocked):

- `CapDbPrivateStateProvider` used a **random per-instance salt**, so a contract CALL could not decrypt private state a prior DEPLOY wrote (`Salt mismatch: data was encrypted with a different password/salt`). Now a **deterministic per-(account, password) salt** - cross-instance reads work while keeping the one-PBKDF2-per-instance optimization and the integrity check. Regression test added.
- The `balanceTx` pre-sync `waitForSyncedState()` net (added below) was **unbounded** → a dropped, non-retried indexer subscription hung submissions forever. Now bounded via `NIGHTGATE_BALANCE_SYNC_TIMEOUT_MS` (default 180s); a stalled sync fails cleanly instead of hanging.

### 2026-05-29: T15 - first live preprod contract deploy

The submission stack exercised end-to-end against preprod for the first time. Three fixes were required to reach green:

- **Per-role HD key derivation** (`srv/utils/wallet-hd.ts`): keys were derived from the raw BIP39 seed → a different Midnight account than Lace (an empty sibling) → `could not balance dust`. Now derives the zswap / dust / night keys from their respective HD roles (account 0, index 0) via `@midnight-ntwrk/wallet-sdk-hd`, matching Lace. `connectWalletForSigning` now takes the BIP39 mnemonic (or 128-hex seed). New deps: `wallet-sdk-hd`, `bip39`, `undici`.
- **Prewarm now blocks on `waitForSyncedState`** - it previously only kicked off the chain sync, so the deploy balanced against stale (restored) dust and the node rejected the tx with `1010 Invalid Transaction: Custom error: 170` (dust validity window). A safety `waitForSyncedState` was also added to `balanceTx`.
- **Indexer endpoint guidance**: the wallet reads block timestamps (the dust `ctime`) from the indexer, so the indexer must be at the chain tip - a lagging indexer reproduces the same error 170. `.env.example` updated accordingly. Known caveat: the public preprod indexer's graphql-ws subscription degrades over long multi-call sessions; use a caught-up local indexer for heavy use.

### 2026-05-20: Async-job migration for long-running actions

All nine long-running OData actions now return `{ jobId, status }` immediately and the caller polls `getJobStatus(jobId, sessionId)`, instead of blocking the HTTP request on multi-minute proof/submit work.

- New `BackgroundJobs` entity + `BackgroundJobStatus` / `BackgroundJobKind` types; new `srv/submission/background-jobs.ts` (per-kind semaphore - heavy=4, light=16 - plus idempotency and crash recovery that flips interrupted rows to `failed:PROCESS_RESTART` on boot).
- New `getJobStatus(jobId, sessionId)` action (declared `action`/POST, so clients poll with the same POST+body pattern as everything else).
- Migrated: `connectWalletForSigning` (returns `prewarmJobId`), `registerForDustGeneration`, `deregisterFromDustGeneration`, `sendNight`, `shieldFunds`, `unshieldFunds`, `deployContract`, `submitContractCall`, `anchorDocument`.
- Note: `issuePredicateAttestation` (added later with the ZK predicate-attestation feature) also uses the async-job model - it returns `{ jobId, status }` and is polled via `getJobStatus`, making it the tenth async/pollable action in 0.3.0.
- Auto-deploy removed: `ensureSchemaDeployed` is now probe-only (fail-fast); deploy explicitly with `npm run deploy`.
- Trip-hazard documented: never hold a CAP transaction open across a worker `await` - `@cap-js/sqlite` pools a single connection, so doing so starves every other query. Work runs via `runWithoutAmbientTx` (clears `cds.context`) with short per-write txs.

### 2026-05-20: Attestation / Documents / Disclosure surface (T11–T14)

The published consumer surface that `@odatano/passport` (and other apps) import on top of the plugin.

- **T11** - abstract `AttestationService` CDS mixin (`src/sdk/AttestationService.cds` / `.ts`) with `Public` / `Disclosed` / `Authority` role-tier projections over `Attestations`, wired by `registerAttestationServiceHandlers`. Exported as `@odatano/nightgate/sdk/AttestationService` (+ `.cds`).
- **T12** - `Documents` entity + `anchorDocument` action: anchors a content hash on-chain via the `attest` circuit. Caller-managed storage by design - NIGHTGATE stores only the `sha256` + a caller-supplied `storageRef` (`file://` / `s3://` / `ipfs://`), never the document bytes.
- **T13** - `verifyDocument(documentId, providedSha256)`: confirms the hash matches an anchored tx that resolves to a SUCCESS `TransactionResults` row.
- **T14** - `DisclosureRoles` entity + `DisclosureRole` enum (`public_only` / `legitimate_interest` / `authority`, mapped to EU Battery Regulation Annex XIII tiers), `attachDisclosureRole` request middleware, and an authority-gated admin `grantRole` action.

### 2026-05-19: Diagnostics tier

Read-only pre-flight functions complementing the Token-Ops Core write actions. Same worker-thread pattern, but using CDS `function` (GET) since these don't submit transactions.

- New OData functions on `NightgateService`:
  - `getWalletBalance(sessionId)` - snapshot of shielded NIGHT, unshielded NIGHT, current DUST, registered and total NIGHT UTXO counts. All amounts as decimal strings to preserve bigint precision.
  - `estimateSendNightFee(sessionId, receiverAddress, amount, ttlIso?)` - pre-flight DUST fee for `sendNight`. Builds the recipe in the worker (no proof generation, no submit) and calls `facade.estimateTransactionFee`.
  - `estimateShieldFee(sessionId, amount, ttlIso?)` / `estimateUnshieldFee(sessionId, amount, ttlIso?)` - symmetric pre-flight fees for the ledger-shift operations.
- New worker RPCs: `walletGetBalance`, `walletEstimateTransferFee`, `walletEstimateSwapFee`.
- Shared `loadSigningSessionAccountId` helper extracts the duplicated session-lookup + viewing-key-decrypt + accountId-derive block. New handlers use it; older handlers retain inlined logic (cleanup opportunity later).
- Shared `handleSwapEstimate` factored helper removes duplication between shield/unshield estimate handlers.
- Diagnostics rate limit: 60/min per client IP - generous since these inform UI and should be pollable.

### 2026-05-19: Token-Ops Core

Four new write actions on `NightgateService` covering the basic Midnight wallet operations beyond contract deploy/call. All follow the established one-shot pattern (build + balance + prove + submit in a single worker RPC; primitives back across the thread boundary).

- `sendNight(sessionId, receiverAddress, amount, ttlIso?)` - transfer NIGHT to any address. Destination ledger auto-detected from the Bech32m HRP prefix (`mn_shield-addr_` → shielded, `mn_addr_` → unshielded). Built via `facade.transferTransaction`.
- `shieldFunds(sessionId, amount, ttlIso?)` - move the wallet's own NIGHT from unshielded → shielded via `facade.initSwap`. Same NIGHT atom amount appears on both sides (1:1 ledger shift, not value swap).
- `unshieldFunds(sessionId, amount, ttlIso?)` - symmetric counterpart. Useful in practice for making NIGHT available to `registerForDustGeneration` (only unshielded NIGHT can be registered).
- `deregisterFromDustGeneration(sessionId)` - symmetric pair to existing `registerForDustGeneration`. Removes ALL the wallet's registered NIGHT UTXOs from dust generation, making them spendable again. Per-UTXO narrowing not yet exposed.
- New `parseReceiverAddress` helper in the worker handles Bech32m prefix detection.
- `encodeAddressString` extended with TypeScript overloads for `DustAddress` / `ShieldedAddress` / `UnshieldedAddress` (was DustAddress only). The library's invariant `HasCodec<T>` constraint forced this design.
- New `srv/submission/token-ops.ts` module collects the wrappers for the three transfer/swap actions. The dust deregister wrapper lives alongside the existing register in `dust-registration.ts`.
- Rate limits: `sendNight` 10/min, `shieldFunds`/`unshieldFunds` 5 per 5 min (heavier ZK work), `deregisterFromDustGeneration` 10/h.
- Shared validation helpers: `parseNightAmount` (bigint parse + sanity bound at 10^18 atoms), `validateOptionalTtl` (ISO-8601 future timestamp check).

### 2026-05-17: Phase 2b - `deployContract` / `submitContractCall` moved into the worker thread

Builds on Phase 1 (wallet SDK isolation) and Phase 2a (dust registration in worker). All contract submission paths now run entirely in the worker; no SDK objects cross the thread boundary.

- `TransactionSubmitter.deploy/.call` rewired:
  - Build a `CapDbPrivateStateProvider` on the main thread (where CAP DB lives), register it under a fresh ephemeral `proxyId`
  - RPC the worker via new `walletDeployContract` / `walletSubmitContractCall`
  - Worker re-imports the Compact artifact (cached by name), assembles publicData/zk/proof providers itself, uses the existing facade as walletProvider/midnightProvider
  - On return, unregister the proxy; classify any errors via existing `classifySubmissionError`
- New `private-state-rpc` message kind: worker proxies CRUD calls back to the main-side `CapDbPrivateStateProvider`. `setContractAddress` is fire-and-forget (sync per SDK contract; ordering on `parentPort` guarantees subsequent async set/get arrive after).
- Worker RPC error shape changed: `{ ok: false, error: { name, message } }` (was `{ error: string }`) so the main-thread `classifySubmissionError` sees the original `err.name` (e.g. `TxFailedError`).
- Old `TransactionSubmitterDeps` test seams `deployContractImpl` / `findDeployedContractImpl` removed; replaced by `walletDeployContractImpl` / `walletSubmitContractCallImpl` (default to the real worker-client exports).
- `DeployArgs` / `CallArgs` reshape: `{ contractName, registration: { artifactPath, privateStateId, zkConfigPath }, initialPrivateState, sessionId }`. `sessionId` now required (worker keys facade lookup on the derived accountId, but the audit row preserves the OData user-session UUID).
- `ResolvedContract` gained `artifactPath: string` field so handlers can forward it without re-doing path resolution.
- Legacy `level` private-state backend rejected on the worker-routed submission path with a clear error message - the SDK's bundled LevelDB provider doesn't cross thread boundaries.
- `buildFullProviderBundle` / `buildContractProviders` remain exported from `srv/midnight/providers.ts` for `test/unit/midnight-providers.test.ts` only; no longer the production path.

### 2026-05-18: Local Midnight indexer container

The hosted `indexer.preprod.midnight.network` was observed returning 503s. Added a self-hosted alternative.

- New `indexer` service in `docker/docker-compose.yml`: `midnightntwrk/indexer-standalone:4.3.2`, port 8088, named volume `indexer-data` for SQLite persistence.
- Container talks to the hosted preprod Substrate RPC by default (`wss://rpc.preprod.midnight.network/`) - we self-host the *flaky* GraphQL layer but keep the *reliable* RPC hosted. Switch to a local node via `INDEXER_UPSTREAM_NODE_URL=ws://node:9944`.
- New `npm run sync:probe` (`scripts/probe-indexer.mjs`) - verifies the container is up and returning data.
- NIGHTGATE flips to the local indexer via `NIGHTGATE_INDEXER_HTTP_URL` + `NIGHTGATE_INDEXER_WS_URL` env vars (already plumbed in `srv/utils/nightgate-config.ts:resolveNightgateRuntimeConfig`).
- Initial container catch-up: ~2-3 blocks/sec observed → ~2-3 days for full preprod sync. Don't flip NIGHTGATE to use it until `caught_up: true` shows in the container logs.
- Documentation: see [docs/operations.md#local-midnight-indexer](docs/operations.md#local-midnight-indexer-optional).

### Code-quality cleanup pass (2026-05-19)

Repo-wide audit found 15 sloppiness items (lazy `as any` casts, silent `catch {}` blocks, duck-typed fallback chains, etc.). All fixable findings cleaned up; one (Tier 3 `typeof timer.unref` guard) was reverted after tests showed it was a load-bearing contract, not laziness.

- `srv/utils/nightgate-config.ts:getNightgatePluginConfig()` - new typed accessor for `cds.requires.nightgate`. Consolidates 9 separate `(cds.env as any).requires?.nightgate || {}` callsites into one with a proper `NightgatePluginConfig` interface.
- `db` fields on service classes typed as `cds.DatabaseService` (was `any`). 8 sites cleaned.
- `(this.nodeProvider as any).rpcBatch(...)` → typed `MidnightNodeProvider.rpcBatch()` direct.
- `(provider as any)[method]` in worker-client → typed switch over the 8 known PrivateStateProvider methods.
- `signedBlock: null as any` placeholder → discriminated union `PreparedBlockSkipped | PreparedBlockFetched` on `alreadyIndexed`. `persistFromNode` now takes only the fetched variant; TypeScript enforces the contract.
- `(entry.saveTimer as any).unref?.()` → typed `entry.saveTimer.unref()` (NodeJS.Timeout always has unref).
- `network as any` casts dropped (narrower union assigns cleanly to wider).
- Worker `evict()` empty `catch {}` blocks now log via `formatErr()`.
- New `srv/utils/format-error.ts:formatErr()` - single shared helper for "stringify error for log without producing `[object Object]`". Replaces 5 sites of duplicated `err?.message ?? err` / `err?.message ?? String(err)`.
- `(cds as any).load` → typed `cds.load() + cds.linked()` (both typed in `@cap-js/cds-types`). Existence guards retained for tests with partial cds mocks.
- DB query results in `nightgate-indexer-service.ts` typed via small `IdRow` projection interface.
- Address parse/decode in worker uses proper `MidnightBech32m.parse(s).decode(DustAddress, networkId)` from `@midnight-ntwrk/wallet-sdk-address-format` (the previous code imported from the wrong package - `wallet-sdk-abstractions` - and silently dropped the conversion).
- Address encode uses proper `MidnightBech32m.encode<T>(networkId, addr).toString()` (was a 5-method-name try/catch fallback chain).
- Obsolete debug script `scripts/derive-addresses.mjs` deleted.
- `[deploy-debug]` console.log instrumentation in `srv/submission/handlers.ts` removed.

### 2026-05-17: T30 - wallet state persistence

- New `WalletSyncStates` entity per accountId, holding serialized shielded / unshielded / dust sub-wallet blobs.
- Periodic state-save (every 30 s) pushed from the worker thread to the main thread via `state-save` message; persisted via standard CAP `db.run`.
- Restore-first builder: on next `connectWalletForSigning`, the facade-builder loads prior blobs from `WalletSyncStates` and the SDK does a delta-sync from there. Saves ~5-6 h of cold-sync wall-clock on restart.
- Final state-save fired during `evict()` on session disconnect.
- Encryption: each blob encrypted with a per-session storage password derived from the viewing key (PBKDF2 + AES-256-GCM, wire-format compatible with the SDK's LevelDB exports).
- SDK-version gating on restore: the SDK can refuse blobs from incompatible versions; we record the version with each save.

### 2026-05-17: T30 Phase 1 - wallet SDK in a worker thread

The Midnight wallet SDK is built on Effect.ts. Its fiber scheduler monopolises the host's microtask queue during sync, freezing CAP request handlers and `db.run` for tens of seconds at a time. Phase 1 isolates the SDK in a `worker_threads` worker.

- New `srv/midnight/wallet-worker.ts` - worker entry holding the `WalletFacade` and the three sub-wallets.
- New `srv/midnight/wallet-worker-client.ts` - main-thread RPC client. Per-call `MessageChannel`; push events on `parentPort` for state-save + log forwarding.
- Original synchronous facade-builder rewritten as a thin glue layer that spawns the worker, wires the state-save sink, and returns stub objects to legacy callers (which throw a Phase-2 migration error if used directly).
- Diagnostic learnings (don't repeat): `_getActiveHandles()` doesn't count WebSocket subscriptions; `progress.appliedIndex` + `progress.highestRelevantWalletIndex` + `progress.isConnected` are the real fields (not `sourceGap` / `applyGap`); the two `RPC-CORE: subscribeRuntimeVersion ... 1000 Normal Closure` logs at sync start are NOT errors.

### 2026-05-17: T30 Phase 2a - dust registration in the worker

`facade.registerNightUtxosForDustGeneration` flows wholly through the worker. No SDK objects cross the thread boundary; the worker returns only primitives (`txId`, counts, addresses as strings).

- New worker RPC `walletRegisterDustGeneration({ sessionId, dustReceiverAddress?, syncTimeoutMs? })` wraps the entire flow inside the worker: `waitForSyncedState` → filter unregistered NIGHT UTXOs → `registerNightUtxosForDustGeneration` → `finalizeRecipe` → `submitTransaction`.
- `srv/submission/dust-registration.ts` is now a thin wrapper around the worker RPC.
- Tests rewritten to mock the worker-client (411 passing post-Phase-2a).

### Pre-Phase-2 baseline - Server-side submission stack (T1–T10, T29)

Tracking T1–T10 (and T29) from `db/enhancements.md`. Code-complete on main as of 2026-05-16; not yet exercised against a live preprod chain (T15).

#### Submission stack

- New `srv/midnight/` module containing the memoized dynamic-import SDK loader (`sdk-loader.ts`), provider bundle assembly (`providers.ts`), and CAP-DB-backed `PrivateStateProvider` (`CapDbPrivateStateProvider.ts`) replacing the SDK's LevelDB provider for production.
- New `srv/submission/` module containing `TransactionSubmitter` (deploy + call), OData action handlers, contract registry with cross-platform `file://` URL handling for ESM artifacts, wallet-material factory deriving deterministic `accountId` + storage password from viewing key, and `wallet-facade-builder` constructing real `WalletFacade` instances with per-account cache.
- New OData actions on `NightgateService`: `deployContract(compiledArtifactRef, sessionId, initialPrivateState)`, `submitContractCall(contractAddress, circuit, compiledArtifactRef, sessionId, args)`. Rate-limited per session (5 deploys/hour, 30 calls/min).
- New `WalletSessions.connectWalletForSigning(sessionId, seedHex)` action. Encrypts a 32-byte seed (via existing `ENCRYPTION_KEY` AES-256-GCM helpers) into `WalletSessions.encryptedSeedKey`. Required before submission flows. Rate-limited 5/hour/IP.
- `disconnectWallet` now also nukes `encryptedSeedKey` and evicts cached `WalletFacade` instances.

#### Schema

- Added `PendingSubmissions` entity tracking submission lifecycle (`pending` → `included` → `finalized` / `failed`) with `txHash`, `contractAddress`, `circuitName`, `actionType`, `submittedAt`, `finalizedAt`, `finalizedTxData`, `errorCode`, `errorMessage`, `sessionId`.
- Added `PrivateStates` entity: encrypted SDK private state keyed by `(accountId, contractAddress, privateStateId)`.
- Added `ContractSigningKeys` entity: encrypted SDK signing keys keyed by `(accountId, contractAddress)`.
- Added `WalletSessions.encryptedSeedKey` field (nullable). Existing read-only sessions still work.
- Added `PendingSubmissionStatus` enum to `db/types.cds`.

#### Crawler integration

- `BlockProcessor` now calls `reconcilePendingSubmission(tx, extrinsicHash, snapshot)` immediately after each transaction INSERT, flipping matching `PendingSubmissions` rows to `finalized` with a JSON snapshot of the indexed transaction. Atomic with persistence (runs on the same `tx` handle). No-op for transactions that didn't originate from NIGHTGATE's submission path.

#### Configuration

- New `cds.requires.nightgate` keys: `indexerHttpUrl`, `indexerWsUrl`, `proofServerUrl`, `zkConfigBasePath`, `privateStateBackend` (`'cap-db'` default | `'level'` opt-in), `contracts` (registry map), `allowMainnetSubmission` (default `false`).
- New env vars: `NIGHTGATE_INDEXER_HTTP_URL`, `NIGHTGATE_INDEXER_WS_URL`, `NIGHTGATE_PROOF_SERVER_URL`, `NIGHTGATE_PROOF_NETWORK`, `NIGHTGATE_ZK_CONFIG_BASE`, `NIGHTGATE_PRIVATE_STATE_BACKEND`.
- `src/index.ts` calls `loadRegistryFromConfig(nightgateConfig)` on startup and logs registered contract refs.

#### Compact contracts

- Added `contracts/` directory with the bundled `counter` contract (`contracts/counter/`). Source at `src/counter.compact`; compiled `managed/counter/` (contract JS + prover/verifier keys + ZK IR) committed to repo so consumers don't need a Compact toolchain.
- `cds.requires.nightgate.contracts.counter` registered in `package.json` for in-repo standalone runs.
- `contracts/README.md` covers Compact toolchain install (`compact-installer.sh`) and recompile instructions (Linux/macOS/WSL only; no native Windows binary as of compactc 0.31.0).

#### Docker

- `docker/docker-compose.yml` adds `proof-server` service (`midnightntwrk/proof-server:8.0.3`, port 6300). Network selectable via `NIGHTGATE_PROOF_NETWORK` (default `preprod`).

#### Dependencies

- Added: `@midnight-ntwrk/midnight-js-contracts@^4.0.4`, `@midnight-ntwrk/midnight-js-indexer-public-data-provider@^4.0.4`, `@midnight-ntwrk/midnight-js-http-client-proof-provider@^4.0.4`, `@midnight-ntwrk/midnight-js-node-zk-config-provider@^4.0.4`, `@midnight-ntwrk/midnight-js-level-private-state-provider@^4.0.4`, `@midnight-ntwrk/compact-runtime@^0.16.0`, `@midnight-ntwrk/ledger-v8@^8.1.0`, `@midnight-ntwrk/wallet-sdk-facade@^4.0.0`. Note: `ledger-v8`, not `ledger-v7`; the package name carries the version suffix.

#### Tooling

- New `srv/utils/storage-encryption.ts`, a PBKDF2-SHA256 (600k iter) + AES-256-GCM helper. SDK-wire-format-compatible (matches `@midnight-ntwrk/midnight-js-level-private-state-provider` export blob format byte-for-byte). Used by `CapDbPrivateStateProvider` for `exportPrivateStates`/`importPrivateStates`/`exportSigningKeys`/`importSigningKeys`.
- New integration scripts (native-ESM, exercise the real Midnight SDK): `npm run smoke:sdk`, `npm run integration:providers`, `npm run integration:wallet-keys`, `npm run integration:wallet-facade`, `npm run integration:contract-registry`.
- `jest.config.js` `diagnostics.ignoreCodes` extended with TS 2339 and 7016 (pre-existing CAP type friction, unblocks 16 previously-failing test suites).

#### Verified baseline

- `31` test suites passed
- `394` tests passed
- `0` failures
- All 5 integration scripts pass against the real Midnight SDK

## 0.1 - Midnight Indexer

### 0.1.2 - 2026-03-08

#### Preprod-First Readiness
- Added first-class Preprod support to the Nightgate runtime and plugin config.
- Added `NIGHTGATE_NETWORK`, `NIGHTGATE_NODE_URL`, and `NIGHTGATE_CRAWLER_NODE_URL` environment variable overrides for flexible runtime configuration.
- Switched repository defaults to the hosted Midnight Preprod RPC at `wss://rpc.preprod.midnight.network/` for a smoother out-of-the-box experience.
- Updated documentation to reflect the Preprod-first workflow and simplified configuration.

#### Simplified Configuration

- Code defaults to Preprod (`wss://rpc.preprod.midnight.network/`). No config needed for the common case.
- Removed `MIDNIGHT_*` env var aliases; only `NIGHTGATE_NETWORK`, `NIGHTGATE_NODE_URL`, and `NIGHTGATE_CRAWLER_NODE_URL` are supported.
- Removed unused `NIGHTGATE_DEFAULTS` export. Replaced by `DEFAULT_NETWORK` and `DEFAULT_NODE_URL`.
- `package.json` only needs `"nightgate": { "kind": "nightgate" }`; network and URL default in code.

### 0.1.1 - 2026-03-08

#### Reliability And Tooling

- Crawler startup now disconnects provider on startup failure to avoid leaked sockets.
- Crawler catch-up now guarantees `isCatchingUp` reset via `finally`.
- MidnightNodeProvider now guards async subscription callback rejections and logs them safely.
- Security middleware CORS allow-headers now includes `X-Correlation-ID`.

#### Service Capability Expansions

- Block ingestion now persists baseline `TransactionResults` and `TransactionFees` for every indexed transaction.
- Contract-classified transactions now persist `ContractActions` with deterministic address grouping and entry-point hints.
- Transaction metadata extraction now populates `size`, `hasProof`, `proofHash`, `contractAddress`, and `circuitName` fields.
- `NightgateIndexerService` now exposes operational actions: `pauseCrawler()`, `resumeCrawler()`, and `reindexFromHeight(height)`.
- `NightgateService` now exposes query primitives: `Blocks.range(startHeight, endHeight, limit)` and `Transactions.byType(txType, limit)`.

#### Validation Baseline

- `22` test suites passed
- `267` tests passed
- `0` failures
- coverage: `93.09%` statements, `81.77%` branches, `94.3%` functions, `93.62%` lines

### 0.1.0 - 2026-03-06

First public Nightgate package cut.

#### What This Release Delivers

- SAP CAP plugin bootstrap through `cds-plugin.js` and `src/plugin.ts`
- `cds.requires.nightgate` configuration model for Midnight node indexing
- Direct WebSocket connectivity to a Midnight node through `MidnightNodeProvider`
- Catch-up indexing, live subscription, transient retry handling, and reorg rollback in the crawler
- Local CAP-database persistence for blocks, transactions, sync state, and reorg history
- OData services for blockchain reads, indexer operations, analytics, and admin session management
- Wallet-session connect/disconnect flows with encrypted viewing-key storage, TTL cleanup, and admin invalidation
- Health, readiness, liveness, and Prometheus-style metrics endpoints
- Offline startup mode when the node is unavailable
- Auto-deploy attempt when the target schema is missing

#### Release Positioning

- This is a read-side first release.
- The package is already usable as an indexer and OData exposure layer for Midnight data.
- The package is not yet a full write-side blockchain interaction SDK.

#### Explicitly Out Of Scope In 0.1

- Transaction building
- Transaction signing
- Transaction submission
- Wallet execution flows beyond session registration/storage
- Built-in production authorization policy beyond CDS `@requires` annotations

#### Notes On Surface Area

- The schema and CDS services already expose a broader Midnight data model than the current extractor depth guarantees for every entity family.
- The strongest operational path in `0.1` is: node connectivity -> block ingest -> transaction ingest -> sync state -> health/metrics -> OData read access.
- Contract, balance, DUST, governance, and other higher-level projections are part of the public surface and will continue to deepen as extractor coverage expands.

#### Security Hardening

- CDS service auth annotations enabled: `@requires: 'authenticated-user'` on NightgateService and AnalyticsService, `@requires: 'admin'` on AdminService
- `ENCRYPTION_KEY` enforced in production (`NODE_ENV=production`); startup fails without it
- Read-only guard covers all entities including NightBalances, DustRegistrations, TokenTypes, WalletSessions
- Rate limiter hardened with periodic sweep, max key cap, and `destroy()` cleanup
- Crawler: live blocks queued instead of dropped during catch-up; start failure resets running state; reorg uses batched deletes
- MidnightNodeProvider: reconnect timer cleanup, subscription cleanup on close, NaN block number rejection
- BlockProcessor: tx-type validation with allow-list
- Removed unused `sessionToken` field from WalletSessions
- SyncState initialization extracted to shared `ensureSyncStateSingleton()` utility
- `getReorgHistory` limit clamped to max 100; `byCardanoAddresses` array capped at 100

#### Verified Baseline At Release Time

- `21` test suites passed
- `251` tests passed
- `0` failures
- coverage: `98.99%` statements, `90.9%` branches, `99.25%` functions, `99.28%` lines
