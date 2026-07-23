# Reference

Configuration matrix, runtime behavior, schema, and development setup for `@odatano/nightgate`.

For the OData action/function signatures, see [actions.md](actions.md). For design rationale, see [architecture.md](architecture.md). For day-to-day operations, see [operations.md](operations.md).

## Configuration

Configure the plugin under `cds.requires.nightgate`. Environment variables override CDS config. Code defaults to Preprod with the public RPC and the hosted Midnight indexer.

### Minimal

```json
{
  "cds": {
    "requires": {
      "nightgate": { "network": "preprod" }
    }
  }
}
```

Sufficient for read-side. `network` is the only required key — without it the plugin serves its OData surface but stays idle (no crawler, no submission), so a bare install never auto-crawls a chain nobody chose. Everything else defaults: `wss://rpc.preprod.midnight.network/`, the public Midnight indexer, `http://localhost:6300` for the proof server. A legacy `"kind": "nightgate"` in existing configs is inert and ignored.

### Full

```json
{
  "cds": {
    "requires": {
      "nightgate": {
        "network": "preprod",
        "nodeUrl": "wss://rpc.preprod.midnight.network/",
        "sessionTtlMs": 86400000,

        "indexerHttpUrl": "https://indexer.preprod.midnight.network/api/v4/graphql",
        "indexerWsUrl":   "wss://indexer.preprod.midnight.network/api/v4/graphql/ws",
        "proofServerUrl": "http://localhost:6300",
        "zkConfigBasePath": "./contracts",
        "privateStateBackend": "cap-db",
        "allowMainnetSubmission": false,
        "runtimeMode": "single-instance",
        "replicaCount": 1,
        "allowProductionSqlite": false,

        "contracts": {
          "counter": {
            "artifactPath":   "contracts/counter/src/managed/counter/contract/index.js",
            "privateStateId": "counterPrivateState",
            "zkConfigPath":   "contracts/counter/src/managed/counter"
          }
        },

        "crawler": {
          "enabled": true,
          "batchSize": 10,
          "maxRetries": 3,
          "retryDelay": 2000,
          "requestTimeout": 30000
        }
      }
    }
  }
}
```

### CDS keys

| Key | Default | Notes |
|---|---|---|
| `network` | `preprod` | `testnet` / `preprod` / `preview` / `mainnet`; invalid values fall back to `preprod` with a warning |
| `nodeUrl` | `wss://rpc.preprod.midnight.network/` | Substrate RPC WebSocket |
| `indexerHttpUrl` | preprod indexer URL | Wallet SDK's `publicDataProvider` HTTP endpoint; NOT used by the crawler |
| `indexerWsUrl` | derived from `indexerHttpUrl` (`http -> ws` + `/ws`) | Same, for subscriptions; set only if your indexer serves subscriptions somewhere non-standard |
| `proofServerUrl` | `http://localhost:6300` | Required for any submission flow (deploy/call/send/shield/unshield/dust-gen) |
| `zkConfigBasePath` | `./contracts` | Base for resolving relative `contracts.<name>.zkConfigPath` |
| `privateStateBackend` | `cap-db` | `cap-db` (default, production-grade encrypted CAP-DB tables) or `level` (legacy SDK LevelDB, **dev-only**, blocked on worker-routed submissions) |
| `contracts` | `{}` | Map of `<ref>` → `{ artifactPath, privateStateId, zkConfigPath }`, loaded into the in-memory registry on plugin startup |
| `sessionTtlMs` | `86400000` (24 h) | Wallet session lifetime |
| `runtimeMode` | `single-instance` | Current safety contract. Other modes fail closed. |
| `replicaCount` | `1` | Declared process/replica count. Values above 1 fail closed until distributed crawler/job leases exist. |
| `allowProductionSqlite` | `false` | Emergency-only escape hatch. Production startup with SQLite otherwise fails closed. |
| `crawler.enabled` | `true` | When `false`, services still load but block indexing is disabled |
| `crawler.nodeUrl` | top-level `nodeUrl` | Optional crawler-specific RPC override |
| `crawler.batchSize` | `10` | Blocks per catch-up batch |
| `crawler.fetchConcurrency` | `(default)` | Parallel RPC fetches during catch-up |
| `crawler.rpcBatchSize` | `(default)` | Substrate JSON-RPC batch size |
| `crawler.requestTimeout` | `30000` | RPC timeout (ms) |
| `crawlerlessChainConfirm` | `!crawler.enabled` | Advance a submitted job's `chainStatus` by a single per-tx Indexer query (`transactions(offset:{hash})`) instead of the crawler's `Transactions`/`TransactionResults`, so `requireChainSuccess` is reachable crawler-free. Only runs when the crawler is disabled (where it defaults on); `false` opts out. With the crawler enabled it never runs (the crawler is the sole source of truth), and an explicit opt-in is ignored with a warning |
| `palletMap` | `(built-in)` | Optional override of the Substrate pallet-index → tx-type classification map used by the `BlockProcessor` (`{ "<index>": { name, txType, isShielded?, isSystem? } }`) |
| `allowMainnetSubmission` | `false` | Gate for mainnet submission. Stays off until [forum thread 1190](https://forum.midnight.network) (`1016 Immediately Dropped`) is resolved |
| `granteeBinding` | `wallet` | How an authenticated principal maps to the AttestationVault `Bytes<32>` grantee id for on-chain disclosure grants: `wallet` (coin pubkey hash) / `did` (DID string) / `custom` (opaque 64-hex). Used by `registerGranteeIdentity` + the disclosure read gate |
| `allowSelfServiceGranteeRegistration` | `false` | Whether authenticated callers may register their own grantee identity via `registerGranteeIdentity`. **NIGHTGATE does not verify that the caller owns the binding input it registers** (no wallet-signature / DID-control proof), so under `wallet`/`did` binding an authenticated user could squat another party's grantee id. Off by default since 0.5.0 (review_001 P1); the action returns `403` unless explicitly enabled. Identities can always be registered through an operator proofing flow that writes `GranteeIdentities` directly. |
| `networks` | `{}` | Per-network indexer endpoints for the `network` override on `verifyAttestationState` / `verifyPredicateState`: `{ "<network>": { indexerHttpUrl, indexerWsUrl } }`. Only consulted when a verify call overrides to a network other than the configured one; unlisted networks use the built-in public indexer defaults. Top-level `indexerHttpUrl`/`indexerWsUrl` and `NIGHTGATE_INDEXER_*` env vars apply to the CONFIGURED network only. |

### Environment variables

| Variable | Purpose |
|---|---|
| `ENCRYPTION_KEY` | AES-256-GCM key (32-byte hex) for at-rest encryption of viewing keys + seed keys. Falls back to a dev key with warning if not set; **required** in production. |
| `NODE_ENV=production` | Enforces `ENCRYPTION_KEY` and rejects SQLite unless the emergency override is active |
| `NIGHTGATE_INSTANCE_ID` | Stable operator-provided instance identifier; otherwise CF instance GUID, hostname, or a generated UUID |
| `NIGHTGATE_REPLICA_COUNT` | Actual process/replica count. Must be `1`; takes precedence over CDS `replicaCount` |
| `CF_INSTANCE_INDEX` | Read-only, injected by Cloud Foundry (0-based). Any value `> 0` fails closed: only instance `0` may run the crawler, wallet cache and job scheduler. Not consulted off Cloud Foundry |
| `NIGHTGATE_ALLOW_PRODUCTION_SQLITE` | `true` temporarily permits production SQLite with a high-severity warning; intended only for a migration window |
| `NIGHTGATE_CHILD_JOB_WAIT_TIMEOUT_MS` | Parent-workflow watchdog; defaults to the worker RPC timeout plus 5 minutes. Timeout is fail-closed while the child may continue. |
| `NIGHTGATE_NETWORK` | Override `network` |
| `NIGHTGATE_NODE_URL` | Override `nodeUrl` |
| `NIGHTGATE_CRAWLER_NODE_URL` | Override `crawler.nodeUrl` |
| `NIGHTGATE_CRAWLER_ENABLED` | `false` / `0` / `no` / `off` disables the crawler at boot |
| `NIGHTGATE_CRAWLERLESS_CHAIN_CONFIRM` | Override `crawlerlessChainConfirm` (only effective with the crawler disabled); `false`/`0`/`no`/`off` opts out. Unset defaults to on when the crawler is disabled |
| `NIGHTGATE_FETCH_CONCURRENCY` | Override `crawler.fetchConcurrency` |
| `NIGHTGATE_RPC_BATCH_SIZE` | Override `crawler.rpcBatchSize` |
| `NIGHTGATE_INDEXER_HTTP_URL` | Override `indexerHttpUrl` (e.g. point at local indexer container) |
| `NIGHTGATE_INDEXER_WS_URL` | Override `indexerWsUrl`; optional, derived from the HTTP URL when unset |
| `NIGHTGATE_PROOF_SERVER_URL` | Override `proofServerUrl` |
| `NIGHTGATE_PROOF_NETWORK` | Network passed to the proof-server container; defaults to `preprod` |
| `NIGHTGATE_ZK_CONFIG_BASE` | Override `zkConfigBasePath` |
| `NIGHTGATE_PRIVATE_STATE_BACKEND` | Override `privateStateBackend` |
| `NIGHTGATE_GRANTEE_BINDING` | Override `granteeBinding` (`wallet` / `did` / `custom`) |
| `NIGHTGATE_ALLOW_SELF_SERVICE_GRANTEE_REGISTRATION` | Override `allowSelfServiceGranteeRegistration` (`false` / `0` / `no` / `off` disables) |
| `NIGHTGATE_PREWARM_SYNC_TIMEOUT_MS` | Upper bound for the `connectWalletForSigning` prewarm sync-to-tip wait; default `10800000` (3 h). Raise for slow cold syncs. |
| `NIGHTGATE_BALANCE_SYNC_TIMEOUT_MS` | Wallet balance sync-to-tip timeout in the worker's `balanceTx` pre-sync; default `180000` (180 s). A stalled sync fails cleanly instead of hanging. |
| `NIGHTGATE_DEBUG_WALLET_SYNC` | Set `true` to emit per-save wallet-sync timing logs; off by default to keep a consumer's stdout quiet |
| `SKIP_AUTO_INIT` | Set `true` **only in tests** to skip the plugin's `initialize()` (crawler + wallet worker). Must NOT be set in production. |
| `INDEXER_SECRET` | 32-byte hex secret for the indexer container's `APP__INFRA__SECRET` |
| `INDEXER_UPSTREAM_NODE_URL` | Upstream Substrate RPC for the indexer container (default = hosted preprod) |
| `LACE_VIEWING_KEY` | Consumed by `scripts/start-wallet-sync.mjs` and `scripts/run-deploy-e2e.mjs` to bootstrap a wallet session |
| `LACE_MNEMONIC` | BIP39 recovery phrase the scripts pass to `connectWalletForSigning`; NIGHTGATE HD-derives the per-role keys |
| `LACE_SEED_HEX` | Optional alternative to `LACE_MNEMONIC`: the full 64-byte BIP39 seed as 128 hex chars |
| `DEPLOY_E2E_DUST_WAIT_SECONDS` | `run-deploy-e2e.mjs` parameter — how long to wait after dust registration |
| `DEPLOY_E2E_SKIP_DUST_REG` | `1` to skip dust registration step in `run-deploy-e2e.mjs` |
| `NIGHTGATE_HEAP_MB` | Heap size for `scripts/dev.mjs` / `scripts/serve.mjs` (default `12288`) |

For local repository startup, drop these into a repo-root `.env`. The tracked template is at [.env.example](../.env.example).

## Runtime behavior

### Plugin lifecycle

- `cds-plugin.js` loads `src/plugin.ts`
- Model roots registered from `db/` and `srv/`
- Connector routes (`/zk-config`, `/contract-manifest`) attached during CAP bootstrap; HTTP security remains host-owned
- `initialize()` runs on `cds.on('served')`:
  1. Probes the CDS schema (SELECTs each required table). The schema is **not** auto-deployed — on the first missing table the plugin fails fast with `SchemaNotDeployedError` and instructs you to run `npm run deploy`
  2. Loads `cds.requires.nightgate.contracts` into the contract registry
  3. Spawns the wallet worker thread (`startWalletWorker()`) and wires the state-save sink
  4. Starts the crawler if `enabled` (default true)
- `shutdown()` runs on `cds.on('shutdown')`:
  1. Stops the crawler
  2. Stops the wallet worker (sends final state-save for each cached facade)

### Two parallel pipelines

NIGHTGATE runs two independent flows that meet at one reconciliation point. The full diagram lives in [architecture.md#the-two-pipelines](architecture.md#the-two-pipelines).

| Pipeline | Where it runs | What it does |
|---|---|---|
| **Block crawler** | Main thread | Catch-up + live block subscription via Substrate RPC; writes Blocks/Tx/Actions/UTXOs/Balances into CAP DB |
| **Wallet SDK** | `worker_threads` worker | ZK-aware wallet ops: shielded/unshielded/dust sub-wallets, transfer/swap/contract submission via the Midnight indexer + proof server |

They meet at `reconcilePendingSubmission`: when the crawler indexes a transaction whose hash matches a row in `PendingSubmissions`, the row's status flips to `finalized`.

For each fetched block the crawler also reads Substrate `System.Events` at that
exact block hash. Runtime metadata is cached by `specVersion` and used to map
`system.ExtrinsicSuccess` / `system.ExtrinsicFailed` to the event's
`applyExtrinsic` index. Only these canonical events create a
`TransactionResults` row, tagged `outcomeSource=substrate-system-events`.
Missing storage, metadata/decode errors, or a missing outcome remain unknown;
they are never converted to success. Rows created by older NIGHTGATE versions
have no `outcomeSource` and are deliberately ignored by `verifyDocument` and
`verifyPredicateAttestation`. Startup removes those known-invalid placeholder
rows after the upgraded schema has been deployed. Re-crawl historical blocks
to backfill verified outcomes; until then those historical outcomes correctly
remain unknown.

### Submission lifecycle

For every action that produces an on-chain transaction:

1. **Main thread**: validate args, rate-limit check, INSERT `PendingSubmissions` row with status=`pending`
2. **Main thread**: register a `CapDbPrivateStateProvider` instance under a fresh `proxyId` (only for deploy/call)
3. **Worker**: receive RPC, build via facade, balance, finalize (ZK proof gen — heavy), submit; return primitives
4. **Main thread**: UPDATE row with `txHash` + `status=included`; release proxy; classify any error
5. **Later, async**: crawler indexes the tx → `reconcilePendingSubmission` flips status to `finalized`

The `sessionId` field on `PendingSubmissions` is the OData user-session UUID (audit trail). The worker keys its facade cache on `accountId` (deterministic from viewing key) — they're different identifiers; see [architecture.md#the-sessionid-indirection](architecture.md#the-sessionid-indirection).

### Error classification

See [actions.md#error-model](actions.md#error-model) for the full table of error codes that `classifySubmissionError(err, network)` produces.

### Startup + failure semantics

- On first startup, the package probes the schema by SELECTing each required table. The schema is **not** auto-deployed: on the first missing table Nightgate remains offline and logs a "run `npm run deploy`" error. It never terminates the consuming CAP host process.
- If the Midnight node cannot be reached, the package logs a warning and continues in `offline` mode. Read-side requests are still served from cache; submission requests still work (they only need the indexer + proof server, not the node directly).
- If the wallet worker fails to start, the plugin logs a warning and continues — submission requests will return an error, read-side is unaffected.
- Repeated `initialize()` calls are idempotent.
- Contract registry loads from `cds.requires.nightgate.contracts` on every `initialize()`.

### Runtime topology contract

NIGHTGATE currently supports exactly one process/replica and one CAP tenant.
The crawler, wallet facade cache, job semaphore and cleanup scheduler are
process-local. Startup therefore fails closed before schema, worker or crawler
initialization when a replica count above one is declared or CAP multitenancy
is enabled. Declare the real count through `NIGHTGATE_REPLICA_COUNT` (preferred
for deployments) or `cds.requires.nightgate.replicaCount`.

Replica detection is declarative: it reads `NIGHTGATE_REPLICA_COUNT`,
`CF_INSTANCE_COUNT`, `KUBERNETES_REPLICA_COUNT` or the CDS `replicaCount`, none
of which a platform injects on its own. `WEB_CONCURRENCY` is deliberately
ignored: it counts HTTP worker processes within one instance, not replicas of
this stateful service. On Cloud Foundry there is one automatic backstop:
`CF_INSTANCE_INDEX` is injected per instance (0-based), so an accidental
scale-out where the operator forgot to declare the count still fails closed on
every instance except `0`. There is no equivalent auto-injected signal on
Kubernetes or bare processes, so declare the real count there.

`getHealth`, `getReadiness`, `getLiveness` and Prometheus metrics expose the
instance id and runtime topology state. This guard prevents accidental unsafe
operation; it is not a distributed lock or leader election. Deployment
descriptors must still ensure only one instance is started.

Production SQLite is rejected by the same preflight guard. Install and bind
`@cap-js/postgres` (or `@cap-js/hana`) in the consuming CAP application. A
legacy deployment can set `NIGHTGATE_ALLOW_PRODUCTION_SQLITE=true` only as a
temporary escape hatch; this does not make SQLite production-safe.

### Database profiles and migration

CAP recommends SQLite for development and PostgreSQL or SAP HANA for
production. The consuming application owns that choice; NIGHTGATE remains
database-agnostic and does not embed credentials. A typical host configuration
uses profile-specific database kinds:

```json
{
  "cds": { "requires": { "db": {
    "[development]": { "kind": "sqlite", "credentials": { "url": "db/local.db" } },
    "[production]":  { "kind": "postgres", "credentials": { "url": null } }
  } } }
}
```

Install `@cap-js/postgres` in the host. Inject production credentials through a
CAP service binding or `cds_requires_db_credentials_*`; never commit passwords.
Run `cds deploy --profile production` before starting a new database. CAP's
automatic schema evolution is non-destructive but cannot perform lossy key or
type changes; inspect generated deltas and back up before every deployment.

SQLite-to-PostgreSQL is a data migration, not an in-place schema evolution:
deploy the CDS model to an empty PostgreSQL database, stop all writers, export
and import the business/NIGHTGATE rows with a verified ETL, compare row counts
and `SyncState`, then switch the binding. Keep the SQLite file read-only until
the PostgreSQL backup and application smoke test succeed.

`db/midnight.db` persists indexed data plus encrypted wallet state. When switching networks, delete `db/midnight.db*` first.

### Background-job durability and restart safety

`BackgroundJobs` is the durable execution ledger for long-running wallet and
contract operations. Each row records a request fingerprint, attempt budget,
worker lease, heartbeat and (as soon as `TransactionSubmitter` creates it) the
`PendingSubmissions.ID` and transaction hash. A database constraint permanently
binds `(sessionId, kind, idempotencyKey)` to one job. This includes failed jobs:
an intentional new attempt must use a new key. Reusing a key with a different
request is rejected, while concurrent identical requests cannot create two job
rows.

Before upgrading an existing database, run `npm run check:job-idempotency`
against its binding. It is read-only and reports historical duplicate tuples.
Resolve those explicitly before `cds deploy`; the tool never guesses which
possibly-on-chain job should be retained.

The lifecycle is `pending -> running -> external_execution -> submitted ->
succeeded|failed`. `external_execution` begins immediately before the Midnight
SDK call that currently combines proof generation, balancing and broadcast.
`submitted` begins only when a transaction hash is available. A
process restart is deliberately fail-safe rather than an automatic blockchain
retry:

- `pending` or pre-effect `running` becomes `failed /
  PROCESS_RESTART_BEFORE_EXECUTION`;
- `external_execution` or `submitted` becomes `reconciliation_required /
  PROCESS_RESTART_RECONCILE`;
- a job in `reconciliation_required` must be checked against
  `PendingSubmissions`, its persisted `txHash`, or live contract state before a
caller creates a retry.

`BackgroundJobs.status` and `chainStatus` answer different questions. A job is
`succeeded` when NIGHTGATE's command/submission workflow returned successfully;
this does not assert that the finalized extrinsic executed successfully.
`chainStatus` is null for non-chain jobs, `pending` after a tx hash is reported,
and later `success` or `failure` only after the crawler correlates the finalized
transaction with a canonical `System.Events` outcome. `chainFinalizedAt` records
when that evidence became available. Predicate workflow parents aggregate their
children: any failed child means `failure`, all successful children mean
`success`, otherwise the parent remains `pending`.

The same rule applies without a process restart: if work throws after reaching
`external_execution` or `submitted`, the job becomes
`reconciliation_required / EXTERNAL_EXECUTION_FAILED`, because broadcast may
already have happened. Only failures proven to occur before that boundary are
ordinary `failed` jobs.

The command poller also performs conservative automatic reconciliation. It
requires the exact job `txHash` (or the hash on its linked
`PendingSubmissions` row), that submission in `finalized`, and a matching
crawler-indexed `Transactions` row. This completes the submission job with a
minimal `{ reconciled, submissionId, txHash, contractAddress, status }` result.
A hash alone, an `included` submission, or a live-state effect without a
transaction identity remains `reconciliation_required`. This proves the same
submission/finalization contract as the normal path; it does not claim business
execution success, because the crawler does not yet derive real execution
outcomes from chain events.

Leaf commands with local projections register an idempotent reconciliation
finalizer. `anchorDocument` restores `Documents.anchoredTxHash/anchoredAt`;
`grantDisclosure` restores `grantedTxHash`; `revokeDisclosure` immediately sets
`active=false` and stores `revokedTxHash`. Disclosure finalizers also trigger
the normal state reindex. These finalizers never call the wallet or submit a
transaction. The job remains `reconciliation_required` if a finalizer throws,
and may safely retry its projection writes on the next poll. Their result uses
the normal action-specific fields plus `reconciled: true`; only leaf kinds
without a registered finalizer use the minimal generic result.

When every child of a predicate workflow has been reconciled successfully, its
parent is moved back to `pending`. The normal versioned processor then resolves
the same deterministic children and rebuilds the full typed parent result; it
does not submit them again. Partially resolved workflows remain visible for
operator action.

This avoids duplicate on-chain effects. Wallet pre-warm, NIGHT transfer,
shield/unshield and dust jobs use versioned persisted commands. Their command
payload contains no seed material: the processor reloads encrypted signing
material from the user-owned `WalletSessions` row, verifies `requestedBy`, and
rebuilds the wallet facade. After a restart, a replayable job interrupted in
pre-effect `running` is returned to `pending` and claimed again. External-effect
states are never replayed.

Contract deploy and generic contract-call jobs also use versioned commands.
Their complete circuit arguments and initial private state are stored only as
AES-256-GCM ciphertext (`commandEncoding = aes-gcm-v1`) under `ENCRYPTION_KEY`;
the public `request` column remains redacted. The processor re-resolves the
registered artifact, revalidates wallet and sponsor ownership, coerces circuit
arguments again, and only then executes.

Document anchoring and disclosure grant/revoke jobs also use encrypted,
versioned commands and are replayable before their external-effect boundary.
Predicate issuance is represented as a durable parent workflow with one
deterministic child job per chain call. `parentJobId` and `workflowStep` make
those checkpoints explicit, while the child idempotency key
`workflow:<parent ID>:<step>` ensures a restarted parent resolves the same step
instead of submitting it again. Each child may cross the external-effect
boundary at most once.

The parent itself performs no chain submission. If an earlier child succeeded
but a later child fails or becomes ambiguous, the parent becomes
`reconciliation_required` rather than ordinary `failed`: retrying the complete
workflow under a new parent could otherwise duplicate the already completed
chain effect. A field predicate without the optional content-root anchoring has
only one chain step and can still fail normally before that step's external
boundary. Private predicate witnesses and Merkle paths are encrypted at rest in
the child command and never copied into the public request snapshot.

Prometheus exposes queued, running, reconciliation-required and oldest-queued
job gauges. The current single-instance topology remains enforced; leases make
ownership and stale execution observable but are not yet multi-replica leader
election.

**Reconciliation caveats (operational).** Automatic reconciliation is conservative
and fails safe, with two boundaries to monitor rather than treat as fully
self-healing:

- A leaf job whose transaction is finalized but whose `System.Events` never decode
  (a persistent runtime-metadata gap at that block) has no canonical outcome, so it
  stays `reconciliation_required` **indefinitely** instead of being resolved. This
  never produces a false success, but there is no timeout — alert on a non-zero
  `odatano_nightgate_jobs_reconciliation_required` gauge that does not drain, and
  reconcile such jobs manually against chain state.
- A job already resolved to `succeeded` / `failed` is not reverted if a later chain
  reorg removes its block and the cascaded `TransactionResults`. This is low risk
  because reconciliation only fires after `PendingSubmissions.status = finalized`
  (past confirmation depth), but it is not actively defended.

The single-instance poller scans only `pending` rows with a registered
`(kind, commandVersion)` processor. Commit visibility is awaited before
acquiring the per-kind semaphore. The
atomic `pending -> running` claim must affect exactly one row; otherwise no work
executes. Completion/failure writes are fenced by `leaseOwner` and the active
status, preventing a stale worker from overwriting a newer owner. Heartbeats do
not cancel or reclaim a hung live SDK promise because the old call may still
cross the external boundary later. Command replay is crash recovery, not an
unsafe concurrent takeover of a live process.

The `PrivateStates`, `ContractSigningKeys`, and `WalletSyncStates` tables are encrypted with passwords derived from the viewing key (via PBKDF2). Losing the `ENCRYPTION_KEY` env var means stored viewing/seed keys become unreadable — back it up separately. For private state migration, use `exportPrivateStates({ password })` to produce a portable encrypted blob.

### Security middleware

NIGHTGATE installs no global HTTP middleware. CORS, CSP, HSTS, correlation
headers and preflight handling are policies of the consuming CAP host. This is
intentional: a plugin must not alter unrelated services or static applications.
Hosts exposing `/zk-config/...` or `/contract-manifest` cross-origin must add
those paths to their own explicit CORS allow-list.

## Programmatic API

```ts
import {
  initialize,
  shutdown,
  getStatus,
  DEFAULT_NETWORK,
  DEFAULT_NODE_URL
} from '@odatano/nightgate';
```

`getStatus()` returns:

```ts
{
  initialized: boolean,
  crawlerEnabled: boolean,
  network?: string,
  nodeUrl?: string,
  mode: 'idle' | 'active' | 'offline',
  lastError?: string
}
```

## Services + entities

| Service | Path | Surface |
|---|---|---|
| `NightgateService` | `/api/v1/nightgate` | Blockchain entities + wallet sessions + token ops + contract ops |
| `NightgateIndexerService` | `/api/v1/indexer` | Sync state, health, reorgs, Prometheus metrics, crawler control |
| `NightgateAnalyticsService` | `/api/v1/analytics` | Aggregate counts |
| `NightgateAdminService` | `/api/v1/admin` | Session admin |

For per-action signatures and curl examples, see [actions.md](actions.md).

### NightgateService entities (all `@readonly` unless noted)

- `Blocks`, `Transactions`, `TransactionResults`, `TransactionSegments`, `TransactionFees`
- `ContractActions`, `ContractBalances`
- `UnshieldedUtxos`
- `ZswapLedgerEvents`, `DustLedgerEvents`
- `NightBalances`
- `PendingSubmissions` — submission lifecycle audit trail; READ is scoped to the caller's own sessions since 0.5.2 (admins read unfiltered)
- `WalletSessions` — projection excludes `viewingKeyHash` and `encryptedViewingKey`; `encryptedSeedKey` also internal-only; READ is scoped to the owning `userId` since 0.5.2 (admins read unfiltered)

### Schema additions (vs. 0.1.2)

| Entity / Field | Purpose |
|---|---|
| `PendingSubmissions` | Submission lifecycle (`pending` → `included` → `finalized` / `failed`). Written before SDK call, reconciled by crawler. |
| `PrivateStates` | Encrypted contract private state per `(accountId, contractAddress, privateStateId)`. Replaces the SDK's LevelDB provider. |
| `ContractSigningKeys` | Encrypted contract signing keys per `(accountId, contractAddress)`. |
| `WalletSyncStates` | Serialized SDK sub-wallet blobs (shielded/unshielded/dust) per `accountId`. Restart-resilient — restored on next `connectWalletForSigning`. |
| `WalletSessions.encryptedSeedKey` | Nullable field populated by `connectWalletForSigning`. Sessions without it can still do read-side flows. |
| `BackgroundJobs` | Async-job tracking for long-running actions (deploy, anchor, dust-reg, …). Poll via `getJobStatus(jobId, sessionId)`. |
| `Attestations` | On-chain attestation index (payload-hash anchor, attester, public metadata, `disclosureLevel`). Backs the `AttestationService` mixin's tiered projections. |
| `Documents` | Document anchor records. NIGHTGATE stores only the `sha256` commitment + a caller-supplied `storageRef` (`s3://…` \| `ipfs://…` \| `file:///…`) — **it never holds the document bytes**; the consumer owns storage. `anchorDocument` commits the hash on-chain via the `attest` circuit and records `anchoredTxHash`; `verifyDocument` re-checks the hash against the anchored, indexed, `SUCCESS` tx. |
| `DisclosureRoles` | Per-user disclosure-tier grants (`userId`, `role`, optional `scope`, `validFrom`/`validUntil`). Off-chain, operator-configured; resolved per-request by `attachDisclosureRole`; granted via the authority-gated admin `grantRole`. |
| `DisclosureGrants` | **Chain-derived** disclosure ACL, read off the AttestationVault `disclosures` ledger Map (`payloadHash`, `grantee`, `level`, `contractAddress`, `grantedTxHash`/`revokedTxHash`, `active`). Written by `grantDisclosure`/`revokeDisclosure` and reconciled to on-chain state by the post-submit reindexer. Distinct from the off-chain `DisclosureRoles` — this is the tamper-evident, attester-controlled source of truth. |
| `GranteeIdentities` | Binds `userId` → the `Bytes<32>` `granteeId` the AttestationVault checks (`bindingKind`, optional `scope`). Populated by `registerGranteeIdentity`; read by the disclosure gate to match a caller against on-chain grants. |

New enums in `db/types.cds`:

- `PendingSubmissionStatus`: `pending` | `included` | `finalized` | `failed`
- `BackgroundJobStatus`: `pending` | `running` | `external_execution` | `submitted` | `reconciliation_required` | `succeeded` | `failed` (durable job lifecycle; `reconciliation_required` is terminal until chain evidence resolves it)
- `DisclosureRole`: `public_only` | `legitimate_interest` | `authority` (EU Battery Reg Annex XIII tiers)

## Capability matrix

| Area | Status |
|---|---|
| CAP plugin integration | ✅ Auto-registers models, connector routes and lifecycle hooks |
| Node connectivity | ✅ `ws://` / `wss://` connections, config validation, offline fallback |
| Block catch-up + live sync | ✅ Finalized-block replay, header subscription, transient retry |
| Reorg recovery | ✅ Parent-hash detection, fork-point search, atomic rollback, `ReorgLog` |
| CAP-DB private state | ✅ Production-grade encrypted backend (T29) |
| Wallet sessions | ✅ Read-only + signing-upgraded, TTL cleanup, admin invalidation |
| Contract deploy / call | ✅ Worker-thread routed (Phase 2b), pending-row tracked, crawler-reconciled |
| Token ops (transfer, shield/unshield) | ✅ `sendNight`, `shieldFunds`, `unshieldFunds` via worker |
| Dust generation | ✅ `registerForDustGeneration` + `deregisterFromDustGeneration` |
| Diagnostics (balance, fee estimates) | ✅ `getWalletBalance`, `estimateSendNightFee`, `estimateShield/UnshieldFee` |
| Local Midnight indexer (docker) | ✅ Optional `midnightntwrk/indexer-standalone:4.3.2` service |
| Wallet state persistence | ✅ `WalletSyncStates` — restart resumes in seconds, not hours |
| Worker-thread architecture | ✅ Wallet SDK isolated from main thread (Phase 1+2a+2b) |
| Compact contracts | ✅ `counter` + `attestation-vault` registered with compiled artifacts shipped (0.3.0) |
| Live preprod end-to-end (T15) | ✅ Counter deployed live on preprod via the full stack (0.3.0) |
| On-chain disclosure grants | ✅ `grantDisclosure`/`revokeDisclosure` + chain-indexed `DisclosureGrants` + `granteeBinding` + on-chain read gate (0.3.4). Live-validated through grant → index → read-back; live revoke pending a healthy preprod indexer |
| Crawler-free state verification | ✅ `verifyAttestationState` / `verifyPredicateState` / `reindexDisclosures` read LIVE contract state (0.5.0); optional per-call `network` override reads another network's public indexer (0.7.0) |
| Mainnet submission | ❌ Gated by `allowMainnetSubmission: false` until forum 1190 resolves |
| Built-in authorization | ✅ `@requires` annotations; consumer app provides auth strategy |

## Project structure

Key directories:

```
src/
  index.ts                          # initialize/shutdown/getStatus + lifecycle
  plugin.ts                         # cds-plugin.js entry, connector routes, lifecycle
srv/
  nightgate-service.{cds,ts}        # main OData service + wallet/token-ops/contract handlers
  nightgate-indexer-service.{cds,ts}# sync/health/metrics/reorg
  analytics-service.{cds,ts}
  admin-service.{cds,ts}
  crawler/                          # Block crawler (main thread)
    Crawler.ts
    BlockProcessor.ts
  providers/
    MidnightNodeProvider.ts         # Substrate RPC client
  midnight/                         # Wallet SDK integration
    sdk-loader.ts                   # main-thread dynamic-import loader
    wallet-worker.ts                # worker entry — SDK lives here
    wallet-worker-client.ts         # main-thread RPC client
    providers.ts                    # provider bundle assembly (legacy main-thread path; test-only after Phase 2b)
    CapDbPrivateStateProvider.ts    # T29 — encrypted CAP-DB private state
  submission/                       # Submission orchestration (main thread)
    TransactionSubmitter.ts         # deploy/call lifecycle + pending-row mgmt
    handlers.ts                     # OData action handlers for deploy/call
    contract-registry.ts            # name → compiled artifact lookup
    wallet-material-factory.ts      # session → walletMaterial (accountId, password)
    wallet-facade-builder.ts        # main-thread glue to the worker facade
    dust-registration.ts            # register/deregister wrappers
    token-ops.ts                    # send/shield/unshield wrappers + diagnostics
  sessions/
    wallet-sessions.ts              # OData handlers for sessions + token ops
  utils/
    nightgate-config.ts             # typed config accessor + runtime resolver
    crypto.ts                       # AES-256-GCM for viewing/seed keys
    storage-encryption.ts           # SDK-wire-format PBKDF2 + AES-256-GCM
    format-error.ts                 # shared error → log-string helper
    sqlite-tuning.ts                # SQLite pragmas
    ...
contracts/
  counter/                          # Compact source + compiled artifact
docker/
  docker-compose.yml                # midnight-node, proof-server, indexer (standalone)
scripts/
  dev.mjs / serve.mjs               # node-spawn wrappers with 12 GB heap
  start-wallet-sync.mjs             # connectWallet + connectWalletForSigning
  probe-indexer.mjs                 # local indexer liveness check
  run-deploy-e2e.mjs                # end-to-end deploy test
  integration-*.mjs                 # real-SDK probes
```

## Integration scripts (no chain needed)

```bash
npm run smoke:sdk                  # 8 Midnight SDK packages load via dynamic import
npm run integration:providers      # provider bundle builds against real SDK
npm run integration:wallet-keys    # ZswapSecretKeys.fromSeed determinism
npm run integration:wallet-facade  # WalletFacade.init wiring (no chain access)
npm run integration:contract-registry  # registry resolves the real compiled counter
```

## Development commands

| Command | Use |
|---|---|
| `npm run dev` | `cds watch` with 12 GB heap |
| `npm run serve:sync` | `cds-serve` with 12 GB heap (no watch) |
| `npm run serve` | Plain `cds-serve` |
| `npm run sync:start` | Bootstrap a wallet session against the running server |
| `npm run sync:probe` | Check local indexer container status |
| `npm run deploy:e2e` | End-to-end deploy flow |
| `npm run build` | `cds:types` + `tsc -p tsconfig.build.json` (in-place compile) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm test` | Full Vitest suite with coverage |
| `npm run test:unit` | Unit tests only |
| `npm run clean` | Remove generated `.js` / `.d.ts` artifacts |
| `npm run cds:types` | Regenerate `@cds-models` |

## Testing baseline

- 64 test suites (Vitest; migrated from Jest in 0.7.0 after CAP 10 deprecated the Jest harness)
- 1163 tests passing
- 0 failures
- Integration scripts pass against the real SDK (`smoke:sdk`, `integration:*`)
- Known coverage gap by design: the facade OPERATION bodies in `srv/midnight/wallet-worker.ts` (transfer/shield/unshield/dust/deploy) run the real SDK and are exercised by the live e2e scripts; the worker's RPC dispatch, facade lifecycle, genuine-sync gate and save/ack protocol are unit-tested in-thread (`wallet-worker-dispatch.test.ts`)
- Coverage measurement note: the CAP-booted services execute the compiled `srv/*.js` (native require, outside vitest's module graph). The build emits sourcemaps and `vitest.config.ts` includes `srv/**/*.js` so this execution is remapped onto the `.ts` sources — don't remove either half, or every handler tested through the booted server reads as uncovered

Run locally:

```bash
npm run typecheck
npm test
npm run smoke:sdk
```
