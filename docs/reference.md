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

Sufficient for read-side. `network` is the only required key - without it the plugin serves its OData surface but stays idle (no crawler, no submission), so a bare install never auto-crawls a chain nobody chose. Everything else defaults: `wss://rpc.preprod.midnight.network/`, the public Midnight indexer, `http://localhost:6300` for the proof server. A legacy `"kind": "nightgate"` in existing configs is inert and ignored.

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
| `network` | `preprod` | `testnet` / `preprod` / `preview` / `mainnet` / `undeployed` (local midnight-local-dev standalone stack: node `ws://127.0.0.1:9944`, indexer `127.0.0.1:8088`); invalid values fall back to `preprod` with a warning |
| `nodeUrl` | `wss://rpc.preprod.midnight.network/` | Substrate RPC WebSocket |
| `indexerHttpUrl` | preprod indexer URL | Wallet SDK's `publicDataProvider` HTTP endpoint; NOT used by the crawler |
| `indexerWsUrl` | derived from `indexerHttpUrl` (`http -> ws` + `/ws`) | Same, for subscriptions; set only if your indexer serves subscriptions somewhere non-standard |
| `proofServerUrl` | `http://localhost:6300` (only used in server proving mode) | Proof server for all submission flows (deploy/call/send/dust-gen). Explicitly configuring it selects server proving; leaving it unset selects in-process wasm proving. |
| `zkConfigBasePath` | `./contracts` | Base for resolving relative `contracts.<name>.zkConfigPath` |
| `privateStateBackend` | `cap-db` | `cap-db` (default, production-grade encrypted CAP-DB tables) or `level` (legacy SDK LevelDB, **dev-only**, blocked on worker-routed submissions) |
| `contracts` | `{}` | Map of `<ref>` → `{ artifactPath, privateStateId, zkConfigPath, slotWidth? }`, loaded into the in-memory registry on plugin startup. `slotWidth` (8/16/32, default 16) declares the content-tree width of an attestation-vault-family artifact; the shipped `attestation-vault-32` registers with 32 and the whole proof surface sizes masks, k bounds and inclusion paths from it |
| `sessionTtlMs` | `86400000` (24 h) | Wallet session lifetime |
| `closeSessionsOnRestart` | `true` | Close the wallet sessions the previous process left behind at startup. Configured `feeSponsorSessions` are exempt. `false` keeps them, for consumers that hold session ids across restarts |
| `jobs.concurrency.heavy` | `4` | Concurrent jobs per proof-generating kind (deploy, call, send, attestations). 4 saturates one proof server |
| `jobs.concurrency.light` | `16` | Concurrent jobs per remaining kind |
| `jobs.concurrency.serial` | `1` | Concurrent jobs for `connectWalletForSigning`. Wallet catch-up is CPU-bound work in a single shared worker thread, so parallel prewarms all crawl instead of the first one finishing; serialized, each wallet becomes usable after its own catch-up. Raise only if you would rather have every wallet warm late than one warm early |
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
| `NIGHTGATE_PREWARM_SYNC_TIMEOUT_MS` | Absolute ceiling for the `connectWalletForSigning` prewarm sync-to-tip wait; default `43200000` (12 h, 0.21.0; was 3 h). A backstop: the primary bound is `NIGHTGATE_PREWARM_STALL_MS`. |
| `NIGHTGATE_PREWARM_STALL_MS` | Prewarm fails when `appliedIndex` has not advanced for this long, regardless of elapsed time; default `600000` (10 min). A slow-but-moving sync is not stalled. `0` disables the stall bound (ceiling only). |
| `NIGHTGATE_SYNC_PROGRESS_STALE_S` | `getWalletSyncProgress` reports `stale: true` once its snapshot is older than this; default `60` (four worker push intervals). |
| `NIGHTGATE_DUST_RACE_RETRIES` | Rebuild-retries of a bound deploy/call/batch on a transient dust race (`1010/170`, `1010/196`, pre-mempool, fee unspent); default `2`. Each retry re-proves the call, hence smaller than the sponsor path's `NIGHTGATE_SPONSOR_DUST_RETRIES`. `0` disables. |
| `NIGHTGATE_DUST_RACE_BACKOFF_MS` | Pause before such a rebuild, letting the dust wallet apply the spend it lost against; default `5000`. |
| `NIGHTGATE_CONTRACTS_DIR` | Root directories (path-delimiter separated) a runtime `registerContract` (admin, 0.21.0) may point into; default: the package's and the working directory's `contracts/`. Importing an artifact executes its module, so paths outside are refused. |
| `NIGHTGATE_SPONSOR_POLICY_FILE` | Path to a JSON file `{ "allowedContracts": [], "allowedCircuits": [] }` that replaces `NIGHTGATE_SPONSOR_ALLOWED_CONTRACTS`/`_CIRCUITS` while set (0.21.0). Calls on a grant's `deployedContracts` are exempt from `allowedCircuits` (0.21.2). Re-read per sponsored call behind an mtime cache, so the sponsor policy changes without a container recreate. Fail-closed: an unreadable or invalid file keeps the last good policy, and with none loaded yet sponsored calls answer `503 SPONSOR_POLICY_UNAVAILABLE`. |
| `NIGHTGATE_SPONSOR_ALLOW_DEPLOY` | Opens sponsored contract DEPLOYS on this deployment (0.21.0): `true`/`1`/`yes`. Off by default. A token caller additionally needs `allowDeploy` on its grant with deploy budget left; a plain caller inherits the floor. Also settable as `allowDeploy` in `NIGHTGATE_SPONSOR_POLICY_FILE`. |
| `NIGHTGATE_DB_URL` | Standalone image (0.21.1): `postgres://user:pw@host:5432/db` selects PostgreSQL; the schema is deployed on every boot (`cds deploy`, additive). `?sslmode=`: `disable`, `require` (TLS unverified) or `verify-full` (chain + hostname, `sslrootcert=<pem>` optional); `allow`/`prefer`/`verify-ca` and unknown values refuse to start. Unset = SQLite file at `NIGHTGATE_DB_PATH`. |
| `NIGHTGATE_DB_DEPLOY` | Standalone image with `NIGHTGATE_DB_URL`: `auto` (default) deploys the schema at boot, `never` skips it. |
| `NIGHTGATE_DB_WAIT_SECONDS` | Standalone image `migrate` mode: seconds to wait for the PostgreSQL listener before `cds deploy` (default 60; 1..86400, other values refuse; each connect attempt is capped at the time left, so a dropped SYN cannot outlive the window). |
| `NIGHTGATE_ARTIFACT_SNAPSHOT_DIR` | Base directory under which the wallet worker materialises the immutable, content-addressed snapshot of each contract artifact generation it loads and proves with (0.21.0). Layout: `<base>/<install>/<pid>/<digest>/{module/artifact.mjs\|.cjs,keys,zkir}` plus a `node_modules` link for bare-specifier resolution at the per-process level, so two installations or two processes of one user never share a link or a snapshot (refcounts and evictions are process-local). Default base: the OS temp directory (`nightgate-artifact-snapshots`). The per-process root is marked with `.nightgate-snapshot-root`; a real `node_modules` directory or a link NIGHTGATE did not create there makes the worker refuse (fail-closed, nothing is deleted). Roots of dead processes are removed at the worker's first use; a snapshot is removed when its generation leaves the worker's caches and no job holds it. Budget the prover keys of the generations in use, per running process. |
| `NIGHTGATE_WORKER_MAX_GENERATIONS` | Distinct contract artifact generations the wallet worker imports before it rotates (exits cleanly at its next idle moment; the main thread respawns it on the next call and counts a `rotationCount`, not an exit) to release Node's ESM module cache (0.21.0). Default 32; `0` never rotates. A rotation costs the warm facades (a large dust snapshot deserialises for minutes), so keep it generous unless you hot-register many revisions. |
| `NIGHTGATE_ARTIFACT_SNAPSHOT_TTL_DAYS` | Snapshots not used for this long (and leftover `.tmp-*` builds of dead processes) are swept at the worker's first snapshot use (0.21.0). Default 14; `0` sweeps everything unused at start-up. |
| `NIGHTGATE_WORKER_GENERATION_CACHE` | How many artifact generations the worker keeps warm at once (contract classes, zk config + proving providers), oldest evicted (0.21.0). Default 8. |
| `NIGHTGATE_SPONSOR_MAX_DEPLOY_BYTES` | Byte ceiling for a sponsored deploy transaction; default `40960` (a deploy writes verifier keys on chain; the ledger caps written bytes at 32 KiB). Separate from `NIGHTGATE_SPONSOR_MAX_TX_BYTES`. |
| `NIGHTGATE_DUST_REGISTER_SETTLE_MS` | How long `registerForDustGeneration` watches the wallet for the registration to apply locally before reporting `registeredUtxosAfter`; default `90000`. `0` skips the observation (`settled: false`). |
| `NIGHTGATE_BALANCE_SYNC_TIMEOUT_MS` | Wallet balance sync-to-tip timeout in the worker's `balanceTx` pre-sync; default `180000` (180 s). A stalled sync fails cleanly instead of hanging. |
| `NIGHTGATE_WALLET_READ_SYNC_TIMEOUT_MS` | Bounded sync gate for the facade-backed read actions (`getWalletBalance`, `estimateSendNightFee`); default `10000` (10 s). A facade still syncing answers `503` with code `WALLET_SYNCING` instead of blocking the request; `0` or negative disables the gate (wait indefinitely). |
| `NIGHTGATE_PROVING_MODE` | How transactions are proved: `server` proxies to the proof-server container at `proofServerUrl`; `wasm` proves in-process, so no Docker proof server is needed. Default: `server` when a proof server is explicitly configured (env var or cds config), otherwise `wasm` (fully public zero-config). Wallet transactions go through the SDK's WASM prover; contract deploy/call circuits go through NIGHTGATE's own in-process provider (`srv/midnight/wasm-proof-provider.ts`, zkir over the contract's local key material). WASM caveats: standard-circuit proving keys download from Midnight's S3 bucket at runtime (hard-coded host inside the SDK, NO integrity verification of the fetched material, one in-memory cache per process start) and each proof costs seconds of CPU in the worker thread. Accepted risk for the dev/test scope of this mode; production stays on `server`. |
| `NIGHTGATE_DEBUG_WALLET_SYNC` | Set `true` to emit per-save wallet-sync timing logs; off by default to keep a consumer's stdout quiet |
| `NIGHTGATE_RESTORE_SAVE_ACK_TIMEOUT_MS` | How long the dust wedge protection waits for the DB to confirm the restored snapshot's re-persist before logging `persist NOT confirmed` (the restore itself stays effective in memory); default `30000` |
| `NIGHTGATE_WORKER_RPC_TIMEOUT_MS` | Upper bound for a single worker RPC (build+prove+submit); default `1800000` (30 min). The child-job wait timeout derives from it (+5 min) unless `NIGHTGATE_CHILD_JOB_WAIT_TIMEOUT_MS` overrides it explicitly. |
| `NIGHTGATE_SYNC_TIP_GAP` | Max allowed gap (dust-event indices) between wallet state and indexer tip for the genuine-sync gate to latch; default `8` |
| `NIGHTGATE_SYNC_FRESHNESS_MS` | Max age of the indexer's latest block for the sync gate to accept it as "fresh"; default `300000` (5 min) |
| `NIGHTGATE_DUST_COLD_START` | Set `true` to ignore the persisted dust state blob and rebuild the dust sub-wallet from chain (escape hatch for pruned merkle roots / error 117) |
| `NIGHTGATE_SPONSORED_CALLER_SYNC` | Set `skip` to skip the caller-facade sync wait in sponsored contract calls (advanced; default is to wait) |
| `NIGHTGATE_FEE_SPONSOR_SESSION` | Operator-designated sponsor sessionId allowed to pay fees across users (security-relevant; unset = same-user sponsoring only). Exempt from the restart cleanup below, so a pinned id survives restarts |
| `NIGHTGATE_CLOSE_SESSIONS_ON_RESTART` | Close the wallet sessions left by the previous process at startup; default `true` (`false` / `0` / `no` / `off` opts out). Sessions are per-connect handles owned by a caller in a process, so an ungraceful stop otherwise leaks them for the full TTL. Set `false` only if consumers hold session ids across restarts and expect them to keep working |
| `NIGHTGATE_SIGNING_KEY_RATE_LIMIT` | Max `connectWalletForSigning` requests per client per hour; default `10` |
| `NIGHTGATE_ZK_CONFIG_PUBLIC_URL` | Public base URL advertised by `/contract-manifest` for the `/zk-config/...` routes (behind a reverse proxy); default = request host |
| `SKIP_AUTO_INIT` | Set `true` **only in tests** to skip the plugin's `initialize()` (crawler + wallet worker). Must NOT be set in production. |
| `INDEXER_SECRET` | 32-byte hex secret for the indexer container's `APP__INFRA__SECRET` |
| `INDEXER_UPSTREAM_NODE_URL` | Upstream Substrate RPC for the indexer container (default = hosted preprod) |
| `LACE_VIEWING_KEY` | Consumed by `scripts/start-wallet-sync.mjs` and `scripts/run-deploy-e2e.mjs` to bootstrap a wallet session |
| `LACE_MNEMONIC` | BIP39 recovery phrase the scripts pass to `connectWalletForSigning`; NIGHTGATE HD-derives the per-role keys |
| `LACE_SEED_HEX` | Optional alternative to `LACE_MNEMONIC`: the full 64-byte BIP39 seed as 128 hex chars |
| `DEPLOY_E2E_DUST_WAIT_SECONDS` | `run-deploy-e2e.mjs` parameter - how long to wait after dust registration |
| `DEPLOY_E2E_SKIP_DUST_REG` | `1` to skip dust registration step in `run-deploy-e2e.mjs` |
| `NIGHTGATE_HEAP_MB` | Heap size for `scripts/dev.mjs` / `scripts/serve.mjs` (default `12288`) |

For local repository startup, drop these into a repo-root `.env`. The tracked template is at [.env.example](../.env.example).

## Runtime behavior

### Plugin lifecycle

- `cds-plugin.js` loads `src/plugin.ts`
- Model roots registered from `db/` and `srv/`
- Connector routes (`/zk-config`, `/contract-manifest`) attached during CAP bootstrap; HTTP security remains host-owned
- `initialize()` runs on `cds.on('served')`:
  1. Probes the CDS schema (SELECTs each required table). The schema is **not** auto-deployed - on the first missing table the plugin fails fast with `SchemaNotDeployedError` and instructs you to run `npm run deploy`
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
| **Wallet SDK** | `worker_threads` worker | ZK-aware wallet ops: shielded/unshielded/dust sub-wallets, transfer/contract submission via the Midnight indexer + prover (proof server or in-process wasm) |

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
3. **Worker**: receive RPC, build via facade, balance, finalize (ZK proof gen - heavy), submit; return primitives
4. **Main thread**: UPDATE row with `txHash` + `status=included`; release proxy; classify any error
5. **Later, async**: crawler indexes the tx → `reconcilePendingSubmission` flips status to `finalized`

The `sessionId` field on `PendingSubmissions` is the OData user-session UUID (audit trail). The worker keys its facade cache on `accountId` (deterministic from viewing key) - they're different identifiers; see [architecture.md#the-sessionid-indirection](architecture.md#the-sessionid-indirection).

### Error classification

See [actions.md#error-model](actions.md#error-model) for the full table of error codes that `classifySubmissionError(err, network)` produces.

### Startup + failure semantics

- On first startup, the package probes the schema by SELECTing each required table. The schema is **not** auto-deployed: on the first missing table Nightgate remains offline and logs a "run `npm run deploy`" error. It never terminates the consuming CAP host process.
- If the Midnight node cannot be reached, the package logs a warning and continues in `offline` mode. Read-side requests are still served from cache; submission requests still work (they only need the indexer + proof server, not the node directly).
- If the wallet worker fails to start, the plugin logs a warning and continues - submission requests will return an error, read-side is unaffected.
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
deploy the CDS model to an empty PostgreSQL database, stop all writers, copy
the rows with `npx nightgate-db-migrate --from <sqlite file> --to <postgres url>`
(0.21.1; every persisted entity of the loaded model incl. `.texts` and CAP's
own tables, streamed in batches with integers read as BigInt, a Decimal
SQLite rounded beyond 2^53 aborts, unknown source tables with rows abort
unless `--ignore-unknown`, row counts compared per table; needs
`@cap-js/postgres` and `better-sqlite3` in the host; the standalone image does
both steps as `docker compose run --rm --no-deps nightgate migrate --from
<file>`), then switch the binding. Keep the SQLite file read-only until the
PostgreSQL backup and application smoke test succeed.

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

- legacy `pending` or pre-effect `running` rows without a persisted command
  become `failed / PROCESS_RESTART_BEFORE_EXECUTION`; versioned commands
  return to the queue, unless the session they sign with was closed by the
  restart cleanup (`failed / PROCESS_RESTART_SESSION_CLOSED`, see the
  wallet-session section);
- `external_execution` or `submitted` becomes `reconciliation_required /
  PROCESS_RESTART_RECONCILE`;
- a job in `reconciliation_required` must be checked against
  `PendingSubmissions`, its persisted `txHash`, or live contract state before a
caller creates a retry.

One more terminal code exists for prewarm hygiene: a fresh
`connectWalletForSigning` marks every older queued or running prewarm job of
the same session as `failed / SUPERSEDED` - queued orphans never start, and
an orphan already mid-run is terminally marked (its wait continues, see
below). `SUPERSEDED` is expected and needs no operator action; the successor
job carries the live prewarm status.

Superseding is status hygiene, not cancellation: a superseded PENDING job
never starts, but one caught mid-run keeps its in-flight worker wait until
that resolves on its own (its late completion is then discarded quietly). In
practice those waits coalesce - every prewarm of the same account blocks on
the same facade sync - but rapid-fire fresh prewarms during a long cold sync
still each add one real wait until the shared sync finishes.

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
the normal state reindex. `submitContractCallBatch` and `registerPassport`
register projection-free finalizers that only rebuild their documented result
shape from the persisted command + evidence. These finalizers never call the
wallet or submit a transaction. The job remains `reconciliation_required` if a
finalizer throws, and may safely retry its projection writes on the next poll.
Their result uses the normal action-specific fields plus `reconciled: true`;
only leaf kinds without a registered finalizer use the minimal generic result.

When every child of a predicate workflow has been reconciled successfully, its
parent is moved back to `pending`. The normal versioned processor then resolves
the same deterministic children and rebuilds the full typed parent result; it
does not submit them again. Partially resolved workflows remain visible for
operator action.

This avoids duplicate on-chain effects. Wallet pre-warm, NIGHT transfer and
dust jobs use versioned persisted commands. Their command
payload contains no seed material: the processor reloads encrypted signing
material from the user-owned `WalletSessions` row, verifies `requestedBy`, and
rebuilds the wallet facade. After a restart, a replayable job interrupted in
pre-effect `running` is returned to `pending`, but it is claimed again only if
its session survived the restart: by default startup closes the previous
process's sessions (0.13.0), so jobs that signed with one of them are failed up
front with `PROCESS_RESTART_SESSION_CLOSED` instead of dying later on a
missing session. Jobs signed by exempt fee-sponsor sessions, and all jobs when
`closeSessionsOnRestart: false`, replay as before. External-effect states are
never replayed.

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
  never produces a false success, but there is no timeout - alert on a non-zero
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

The `PrivateStates`, `ContractSigningKeys`, and `WalletSyncStates` tables are encrypted with passwords derived from the viewing key (via PBKDF2). Losing the `ENCRYPTION_KEY` env var means stored viewing/seed keys become unreadable - back it up separately. For private state migration, use `exportPrivateStates({ password })` to produce a portable encrypted blob.

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
- `Documents`: anchored document hashes (`anchorDocument`)
- `PredicateAttestations`: issued ZK predicate attestations
- `DisclosureGrants`: on-chain disclosure ACL index
- `GranteeIdentities`: registered grantee bindings
- `PendingSubmissions` - submission lifecycle audit trail; READ is scoped to the caller's own sessions since 0.5.2 (admins read unfiltered)
- `WalletSessions` - projection excludes `viewingKeyHash` and `encryptedViewingKey`; `encryptedSeedKey` also internal-only; READ is scoped to the owning `userId` since 0.5.2 (admins read unfiltered)

### Schema additions (vs. 0.1.2)

| Entity / Field | Purpose |
|---|---|
| `PendingSubmissions` | Submission lifecycle (`pending` → `included` → `finalized` / `failed`). Written before SDK call, reconciled by crawler. |
| `PrivateStates` | Encrypted contract private state per `(accountId, contractAddress, privateStateId)`. Replaces the SDK's LevelDB provider. |
| `ContractSigningKeys` | Encrypted contract signing keys per `(accountId, contractAddress)`. |
| `WalletSyncStates` | Serialized SDK sub-wallet blobs (shielded/unshielded/dust) per `accountId`. Restart-resilient - restored on next `connectWalletForSigning`. |
| `WalletSessions.encryptedSeedKey` | Nullable field populated by `connectWalletForSigning`. Sessions without it can still do read-side flows. |
| `BackgroundJobs` | Async-job tracking for long-running actions (deploy, anchor, dust-reg, …). Poll via `getJobStatus(jobId, sessionId)`. |
| `Attestations` | On-chain attestation index (payload-hash anchor, attester, public metadata, `disclosureLevel`). Backs the `AttestationService` mixin's tiered projections. |
| `Documents` | Document anchor records. NIGHTGATE stores only the `sha256` commitment + a caller-supplied `storageRef` (`s3://…` \| `ipfs://…` \| `file:///…`) - **it never holds the document bytes**; the consumer owns storage. `anchorDocument` commits the hash on-chain via the `attest` circuit and records `anchoredTxHash`; `verifyDocument` re-checks the hash against the anchored, indexed, `SUCCESS` tx. |
| `DisclosureRoles` | Per-user disclosure-tier grants (`userId`, `role`, optional `scope`, `validFrom`/`validUntil`). Off-chain, operator-configured; resolved per-request by `attachDisclosureRole`; granted via the authority-gated admin `grantRole`. |
| `DisclosureGrants` | **Chain-derived** disclosure ACL, read off the AttestationVault `disclosures` ledger Map (`payloadHash`, `grantee`, `level`, `contractAddress`, `grantedTxHash`/`revokedTxHash`, `active`). Written by `grantDisclosure`/`revokeDisclosure` and reconciled to on-chain state by the post-submit reindexer. Distinct from the off-chain `DisclosureRoles` - this is the tamper-evident, attester-controlled source of truth. |
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
| Token ops (transfer) | ✅ `sendNight` via worker (NIGHT is unshielded-only; no shield/unshield conversion exists) |
| Dust generation | ✅ `registerForDustGeneration` + `deregisterFromDustGeneration` |
| Diagnostics (balance, fee estimates) | ✅ `getWalletBalance`, `estimateSendNightFee`, `getWalletSyncProgress` (catch-up rate + ETA, 0.13.0) |
| Local Midnight indexer (docker) | ✅ Optional `midnightntwrk/indexer-standalone:4.3.2` service |
| Wallet state persistence | ✅ `WalletSyncStates` - restart resumes in seconds, not hours |
| Worker-thread architecture | ✅ Wallet SDK isolated from main thread (Phase 1+2a+2b) |
| Compact contracts | ✅ `counter` + `attestation-vault` + `attestation-vault-32` (0.19.0, 32-slot width variant) + `shielded-token` registered with compiled artifacts shipped (`mintShieldedTestToken` + `deriveTokenType` drive the token one) |
| Live preprod end-to-end (T15) | ✅ Counter deployed live on preprod via the full stack (0.3.0) |
| On-chain disclosure grants | ✅ `grantDisclosure`/`revokeDisclosure` + chain-indexed `DisclosureGrants` + `granteeBinding` + on-chain read gate (0.3.4). Live-validated through grant → index → read-back; live revoke pending a healthy preprod indexer |
| Crawler-free state verification | ✅ `verifyAttestationState` / `verifyPredicateState` / `reindexDisclosures` read LIVE contract state (0.5.0); optional per-call `network` override reads another network's public indexer (0.7.0) |
| Bytes equality + set membership proofs | ✅ `issueFieldEqualityAttestation` / `issueFieldMembershipAttestation` + mixed-kind batch + `prepareMembershipSet`; string fields via `prepareDocumentProof` `kind: 'bytes'` (0.15.0) |
| Cross-root document diff proofs | ✅ `issueDocumentIntegrityAttestation` (unchanged-except with a width-bit slot mask: 16 bits default, 32 on `attestation-vault-32`) / `issueDocumentDiffAttestation` (at least k of width slots differ, k up to 32) over TWO anchored content roots, batchable + crawler-free verifiable (0.16.0; width variants 0.19.0) |
| Passport-binding hardening | ✅ `bindPassport` rebind guard + registrar-gated `registerPassport` pre-registration (0.10.0). Registered ids bind only for their registered attester; deployed vaults need a redeploy |
| Mainnet submission | ❌ Gated by `allowMainnetSubmission: false` until forum 1190 resolves |
| Built-in authorization | ✅ `@requires` annotations; consumer app provides auth strategy |

## Project structure

Key directories:

```
src/
  index.ts                          # initialize/shutdown/getStatus + lifecycle
  plugin.ts                         # cds-plugin.js entry, connector routes, lifecycle
  browser/                          # @odatano/nightgate/browser (dApp providers, prepare* calls)
  txbuilder/                        # @odatano/nightgate/txbuilder (headless, server-free build)
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
    wallet-worker.ts                # worker entry - SDK lives here
    wallet-worker-client.ts         # main-thread RPC client
    providers.ts                    # provider bundle assembly (legacy main-thread path; test-only after Phase 2b)
    CapDbPrivateStateProvider.ts    # T29 - encrypted CAP-DB private state
  submission/                       # Submission orchestration (main thread)
    TransactionSubmitter.ts         # deploy/call lifecycle + pending-row mgmt
    handlers.ts                     # OData action handlers for deploy/call
    contract-registry.ts            # name → compiled artifact lookup
    wallet-material-factory.ts      # session → walletMaterial (accountId, password)
    wallet-facade-builder.ts        # main-thread glue to the worker facade
    dust-registration.ts            # register/deregister wrappers
    token-ops.ts                    # sendNight wrapper + balance/fee diagnostics
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

- 68 test suites, 1248 tests, 0 failures (Vitest; migrated from Jest in 0.7.0 after CAP 10 deprecated the Jest harness; counts as of 0.11.0)
- Integration scripts pass against the real SDK (`smoke:sdk`, `integration:*`)
- The worker's RPC dispatch, facade lifecycle, genuine-sync gate, save/ack protocol AND the facade operation bodies (transfer incl. `tokenTypeHex`, balance/fee reads, dust register/deregister, contract-call private-state seeding) are unit-tested in-thread against a fake facade (`wallet-worker-dispatch.test.ts`); real-SDK behavior is exercised by the live e2e scripts (`wasm-proving:e2e`, `wasm-contract:e2e`, `wasm-zswap:e2e`, `deploy:e2e`)
- Coverage measurement note: the CAP-booted services execute the compiled `srv/*.js` (native require, outside vitest's module graph). The build emits sourcemaps and `vitest.config.ts` includes `srv/**/*.js` so this execution is remapped onto the `.ts` sources - don't remove either half, or every handler tested through the booted server reads as uncovered

Run locally:

```bash
npm run typecheck
npm test
npm run smoke:sdk
```
