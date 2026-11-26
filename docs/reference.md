# Reference

Configuration, runtime behavior and schema. Signatures: [actions.md](actions.md). Design: [architecture.md](architecture.md). Operations: [operations.md](operations.md).

## Configuration

NIGHTGATE reads `cds.requires.nightgate`. Environment variables override it. Without `network` the server serves OData but stays idle: no crawler, no submission.

```json
{
  "cds": {
    "requires": {
      "nightgate": {
        "network": "mainnet",
        "nodeUrl": "ws://<node-host>:9944",
        "indexerHttpUrl": "http://<indexer-host>:8088/api/v4/graphql",
        "proofServerUrl": "http://localhost:6300",
        "contracts": {
          "attestation-vault": { "package": "@odatano/contract-attestation-vault" },
          "my-contract": {
            "artifactPath":   "contracts/my-contract/managed/my-contract/contract/index.js",
            "privateStateId": "myContractPrivateState",
            "zkConfigPath":   "contracts/my-contract/managed/my-contract"
          }
        },
        "crawler": { "enabled": true, "batchSize": 10 }
      }
    }
  }
}
```

Node and indexer are built in for preview and for undeployed, the name of a local node. Every other network refuses to start without `nodeUrl` and `indexerHttpUrl`, see [self-hosted.md](self-hosted.md). Proving runs in wasm unless a proof server is configured.

### CDS keys

| Key | Default | Notes |
|---|---|---|
| `network` | none | `preview`, `preprod`, `mainnet`, `stagenet` or `undeployed`, the name of a local node. Without one the server stays idle. The image sets `mainnet`. An invalid value refuses to start |
| `nodeUrl` | built in on preview, undeployed | Substrate RPC WebSocket. Required on every other network |
| `indexerHttpUrl` | built in on preview, undeployed | Indexer GraphQL for the wallet SDK and the verify functions. Required on every other network |
| `indexerWsUrl` | derived from `indexerHttpUrl` | Subscription endpoint, only for a non-standard indexer |
| `proofServerUrl` | `http://localhost:6300` in server mode | Setting it selects server proving. Unset means wasm |
| `proofTimeoutMs` | `300000` | One proof request in server mode, retries included; a timed-out request is not retried |
| `contracts` | the five lineages in `package.json`: `counter`, `attestation-vault`, `attestation-vault-32`, `holder-registry`, `token-factory` | `<ref>` to `{ package }` or `{ artifactPath, privateStateId, zkConfigPath }`. A relative path counts from the working directory. Optional `slotWidth` 16 or 32 for a vault artifact, `address` for `/contract-manifest` |
| `sessionTtlMs` | `86400000` | Wallet session lifetime |
| `closeSessionsOnRestart` | `true` | Close the previous process's wallet sessions at startup. Fee-sponsor sessions are exempt |
| `feeSponsorSessions` | none | Platform fee-sponsor session ids. `NIGHTGATE_FEE_SPONSOR_SESSIONS` overrides it |
| `jobs.concurrency.heavy` | `4` | Concurrent proof-generating jobs. Workflow parents have a separate cap of the same size |
| `jobs.concurrency.light` | `16` | Concurrent jobs per other kind |
| `jobs.concurrency.serial` | `1` | Concurrent `connectWalletForSigning` jobs |
| `runtimeMode` | `single-instance` | Other modes fail closed |
| `replicaCount` | `1` | Values above 1 fail closed |
| `allowMainnetSubmission` | `false` | `true` lets actions that submit run on mainnet; `NIGHTGATE_ALLOW_MAINNET_SUBMISSION` overrides |
| `crawler.enabled` | `true` | `false` loads the services without block indexing |
| `crawler.nodeUrl` | `nodeUrl` | RPC endpoint for the crawler only |
| `crawler.batchSize` | `10` | Blocks per catch-up batch |
| `crawler.fetchConcurrency` | `8` | Block batches fetched at the same time |
| `crawler.rpcBatchSize` | `32` | Heights per JSON-RPC batch request |
| `crawler.requestTimeout` | `30000` | RPC timeout in ms |
| `crawler.maxRetries` | `3` | Attempts per block fetch |
| `crawler.retryDelay` | `2000` | Base backoff in ms between attempts |
| `palletMap` | built in | `{ "<index>": { name, txType, isShielded?, isSystem? } }`. Overrides defaults and runtime metadata |
| `granteeBinding` | `wallet` | How a user maps to the vault grantee id: `wallet` (coin public key), `did` or `custom` (64 hex) |
| `allowSelfServiceGranteeRegistration` | `false` | Lets callers register their own grantee id. Ownership of the input is not verified. Off answers `403` |
| `networks` | `{}` | `{ "<network>": { indexerHttpUrl, indexerWsUrl } }` for the `network` parameter of the verify functions |

### Environment variables

Declared in `srv/utils/config-table.ts`. The table is generated with `npm run config:table` and pinned by a unit test. Empty means unset. An unparsable value is logged once and the default applies. Numbers out of bounds are clamped with a warning. Booleans accept `true`, `false`, `1`, `0`, `yes`, `no`, `on`, `off`. Every variable except the secrets can also be set under `cds.requires.nightgate`, by the one key the column `CDS key` names; a dot leads into a nested object, so `crawler.enabled` is `{ "crawler": { "enabled": false } }`. No other spelling is read, and a start warns when it finds one it knows. A variable that was renamed is read under its former name until 1.0, as its row says, and a start warns for it too. Environment wins over CDS, CDS wins over the default.

<!-- config-table:start -->
| Variable | CDS key | Kind | Default | Purpose |
|---|---|---|---|---|
| `NIGHTGATE_NETWORK` | `network` | `preview` / `preprod` / `mainnet` / `stagenet` / `undeployed` |  | Override `network` |
| `NIGHTGATE_NODE_URL` | `nodeUrl` | url |  | Override `nodeUrl` |
| `NIGHTGATE_ALLOW_MAINNET_SUBMISSION` | `allowMainnetSubmission` | bool |  | `true` lets actions that submit a transaction run on mainnet, where they spend real NIGHT and DUST. Off by default, so a server pointed at mainnet only indexes and reads until the operator turns it on; such an action answers 403 until then. |
| `NIGHTGATE_CRAWLER_NODE_URL` | `crawler.nodeUrl` | url |  | Override `crawler.nodeUrl` |
| `NIGHTGATE_INDEXER_HTTP_URL` | `indexerHttpUrl` | url |  | Override `indexerHttpUrl` (e.g. point at local indexer container) |
| `NIGHTGATE_INDEXER_WS_URL` | `indexerWsUrl` | url |  | Override `indexerWsUrl`; optional, derived from the HTTP URL when unset |
| `NIGHTGATE_PROOF_SERVER_URL` | `proofServerUrl` | url |  | Override `proofServerUrl` |
| `NIGHTGATE_PROVING_MODE` | `provingMode` | `server` / `wasm` |  | Proving mode `wasm` (in-process) or `server` (proof server). Unset: `server` when a proof server is configured, `wasm` otherwise. `initialize()` pins the effective value into the env for the worker. Read in the wallet worker. |
| `NIGHTGATE_PROOF_TIMEOUT_MS` | `proofTimeoutMs` | ms (min 1) | `300000` | Override `proofTimeoutMs`; pinned into the env at startup for the wallet worker. The proof-server container has its own job TTL (`MIDNIGHT_PROOF_SERVER_JOB_TIMEOUT`, default 600 s): raise both, or a finished-but-expired job answers 5xx and midnight-js re-proves. Read in the wallet worker. |
| `NIGHTGATE_ZK_CONFIG_PUBLIC_URL` | `zkConfigPublicUrl` | url |  | Public base URL advertised by `/contract-manifest` for the `/zk-config/...` routes (behind a reverse proxy); unset = relative URLs, resolved by the client against the origin it fetched the manifest from |
| `NIGHTGATE_ZK_ASSET_URL` | `zkAssetUrl` | string |  | A `/zk-config` base the server fetches missing prover keys from (`<url>/<contract>/keys/<circuit>.prover`, verified against `keys/manifest.json`); `none`/`off` disables the fetch. Unset: the release assets named by the installed lineage package (`contract.json#zkAssetUrl`), no source for a foreign artifact. Offline installs run `scripts/fetch-contract-keys.mjs` once. |
| `NIGHTGATE_CONTRACTS_DIR` | `contractsDir` | string |  | Root directories (path-delimiter separated) a runtime `registerContract` (admin) may point into; default: the working directory's `contracts/`. Importing an artifact executes its module, so paths outside are refused. The supported way to keep a consumer's artifacts outside the package: point it at that directory. The artifact's `@midnight-ntwrk/compact-runtime` import resolves from NIGHTGATE's own node_modules (worker snapshots and the registration probe), so the directory needs no node_modules of its own. |
| `NIGHTGATE_GRANTEE_BINDING` | `granteeBinding` | `wallet` / `did` / `custom` |  | Override `granteeBinding` (`wallet` / `did` / `custom`) |
| `NIGHTGATE_ALLOW_SELF_SERVICE_GRANTEE_REGISTRATION` | `allowSelfServiceGranteeRegistration` | bool |  | Override `allowSelfServiceGranteeRegistration` (`false` / `0` / `no` / `off` disables) |
| `NIGHTGATE_SESSION_TTL_MS` | `sessionTtlMs` | ms (min 60000) | `86400000` | How long a wallet session lives after `connectWallet`; default 24 h. A session listed as fee sponsor does not expire. |
| `NIGHTGATE_CLOSE_SESSIONS_ON_RESTART` | `closeSessionsOnRestart` | bool |  | Override `closeSessionsOnRestart` (default on): `false` keeps the previous process's wallet sessions open across a restart |
| `NIGHTGATE_INSTANCE_ID` | `instanceId` | string |  | Stable operator-provided instance identifier; otherwise CF instance GUID, hostname, or a generated UUID |
| `NIGHTGATE_REPLICA_COUNT` | `replicaCount` | int (min 1) |  | Actual process/replica count. Must be `1`; takes precedence over CDS `replicaCount` |
| `NIGHTGATE_ALLOW_UNAUTHENTICATED` | `allowUnauthenticated` | bool | `false` | A server with `auth.kind: dummy` or `mocked` listens on `127.0.0.1` only. `true` permits such a kind in production (every request unauthenticated and privileged); local testing only. Without it such a server does not start. |
| `NIGHTGATE_TRUST_PROXY` | `trustProxy` | int (min 0) | `0` | Number of reverse proxies in front of the server. The caller address for rate limits and the login throttle is then read from `X-Forwarded-For`, that many entries from the right; default `0` uses the address of the connection. Set it only when every request passes exactly these proxies, because a caller that reaches the server directly could name any address. |
| `NIGHTGATE_DEBUG_WALLET_SYNC` | `debugWalletSync` | bool | `false` | `true` logs wallet sync-state persistence at debug level |
| `NIGHTGATE_CRAWLER_ENABLED` | `crawler.enabled` | bool |  | Override `crawler.enabled`: `false` / `0` / `no` / `off` disables the crawler at boot |
| `NIGHTGATE_CRAWLER_FETCH_CONCURRENCY` | `crawler.fetchConcurrency` | int (min 1) |  | Override `crawler.fetchConcurrency` Its former name `NIGHTGATE_FETCH_CONCURRENCY` is not read. |
| `NIGHTGATE_CRAWLER_RPC_BATCH_SIZE` | `crawler.rpcBatchSize` | int (min 1) |  | Override `crawler.rpcBatchSize` Its former name `NIGHTGATE_RPC_BATCH_SIZE` is not read. |
| `NIGHTGATE_CRAWLER_START_HEIGHT` | `crawler.startHeight` | int (min 2) |  | Override `crawler.startHeight`: first height to index while the index is EMPTY (the block below it is indexed as the parentless anchor). Unset means 2: block 0 has no events and cannot be stored, so block 1 is the first one. Ignored once the index holds blocks, so a restart resumes at the cursor. |
| `NIGHTGATE_CRAWLER_MAX_BPS` | `crawler.maxBlocksPerSecond` | int (min 1) |  | Override `crawler.maxBlocksPerSecond`: catch-up rate cap, so block ingestion can share a host with the submission side. Unset = unlimited. |
| `NIGHTGATE_CRAWLER_FAULT_GUARD` | `crawlerFaultGuard` | bool |  | `false` lets a node transport fault shut the server down again, as CAP does by default. On by default: the crawler retries such a fault on its own, and taking the process down costs every sponsor facade its warm-up. Absorbed faults are counted in `getMetrics()`. |
| `NIGHTGATE_CRAWLER_DECODE_PAYLOADS` | `crawler.decodePayloads` | bool |  | Override `crawler.decodePayloads`: decode stored ledger payloads in a pass behind the indexed tip (circuit names, transaction identifiers, zswap and DUST counts). Off by default; the decode runs in wasm on the main thread. |
| `NIGHTGATE_CRAWLER_INDEXER_SUPPLEMENT` | `crawler.indexerSupplement` | bool |  | Override `crawler.indexerSupplement`: fill what a block does not carry (segments, contract state and balances, ledger-event streams, the DUST registration flag) from the Midnight indexer, in a pass behind the indexed tip. Off by default; it makes the index depend on a second source. |
| `NIGHTGATE_CRAWLER_INDEXER_URL` | `crawler.indexerUrl` | url |  | Override `crawler.indexerUrl`: the GraphQL endpoint the supplement pass reads. Default: the submission side's indexer (`NIGHTGATE_INDEXER_HTTP_URL`). A private indexer here keeps the pass off the public one, whose edge blocks the whole host IP under load, sponsor facades included. |
| `NIGHTGATE_CRAWLER_CONTRACT_STATE_HISTORY` | `crawler.contractStateHistory` | `none` / `watched` / `all` |  | Override `crawler.contractStateHistory` (default `none`): which contract actions keep their full state from the supplement. Every action keeps a sha256 and the size, the newest state per contract is in `ContractStates`, and every deploy keeps its full state in each mode; `watched` keeps the full state of the contracts in `NIGHTGATE_CRAWLER_CONTRACT_STATE_WATCH`, `all` of every action (hundreds of KB each). Older states come from the indexer through `ContractStates/stateAt`. |
| `NIGHTGATE_CRAWLER_CONTRACT_STATE_WATCH` | `crawler.contractStateWatch` | list |  | Override `crawler.contractStateWatch`: comma-separated contract addresses (hex) whose full state per action is kept under `contractStateHistory: watched`. |
| `NIGHTGATE_CRAWLER_SUPPLEMENT_MAX_BPS` | `crawler.supplementBlocksPerSecond` | int (min 1) |  | Override `crawler.supplementBlocksPerSecond` (default 2): indexer requests per second of the supplement pass, one per block, paced per request. A hosted indexer may block the whole host IP (403 from their load balancer, also for the sponsor facades) at roughly 15 per second; on a 403 or 429 the pass backs off for one minute, doubling up to fifteen. |
| `NIGHTGATE_INSTANCE_LEASE_TTL_MS` | `instanceLeaseTtlMs` | ms (min 15000) | `90000` | The process running job loops, restart recovery and crawler holds a database lease renewed every third of this; a second process on the same database waits this long for an expired lease, then refuses to start. Default 90 s. |
| `NIGHTGATE_JOB_LEASE_TTL_MS` | `jobLeaseTtlMs` | ms (min 60000) | `300000` | A `running` job whose heartbeat is older than this is reclaimed (re-dispatched with `attempt + 1`) unless it crossed the external-effect boundary; default 5 minutes, at least 60 s (twice the 30 s heartbeat). |
| `NIGHTGATE_CHILD_JOB_WAIT_TIMEOUT_MS` | `childJobWaitTimeoutMs` | ms (min 1) |  | Parent-workflow watchdog; defaults to the worker RPC timeout plus 5 minutes. Timeout is fail-closed while the child may continue. |
| `NIGHTGATE_WORKER_RPC_TIMEOUT_MS` | `workerRpcTimeoutMs` | ms (min 1) | `1800000` | Backstop timeout of one wallet-worker RPC (a proof or a submit); default 30 minutes. |
| `NIGHTGATE_WORKER_DRAIN_MAX_MS` | `workerDrainMaxMs` | ms (min 1) | `600000` | Upper bound of a worker rotation drain (in-flight submits complete first); default 10 minutes, then the worker is terminated and the cut calls fail `WORKER_ROTATED`. |
| `NIGHTGATE_WORKER_YOUNG_GEN_MB` | `workerYoungGenMb` | int (min 0, max 2048) | `128` | Young-generation size of the wallet worker thread (`resourceLimits.maxYoungGenerationSizeMb`); default 128, `0` = V8 default, clamped to 16..2048. |
| `NIGHTGATE_WALLET_WORKERS` | `walletWorkers` | int (min 1, max 8) | `1` | Worker threads for user wallets; a wallet always lives in the same one (by its facade key). Each worker carries its own SDK, WASM and heap, so plan memory per worker. Default `1`. |
| `NIGHTGATE_SPONSOR_WORKERS` | `sponsorWorkers` | `shared` / `dedicated` | `shared` | `dedicated` gives every pool sponsor a worker thread of its own, so sponsored jobs and sponsor restores run side by side; `shared` (default) keeps them in the user workers. Bound sponsoring (a call that names a sponsor session) needs the caller's and the sponsor's wallet in one worker and answers 412 otherwise. |
| `NIGHTGATE_WORKER_MAX_GENERATIONS` | `workerMaxGenerations` | int (min 0) | `32` | Distinct artifact generations a worker loads before it rotates (drain + fresh thread); default 32. Read in the wallet worker. |
| `NIGHTGATE_WORKER_GENERATION_CACHE` | `workerGenerationCache` | int (min 1) | `8` | Scaffold and provider cache size per worker (bounded cache of artifact generations); default 8. Read in the wallet worker. |
| `NIGHTGATE_ARTIFACT_SNAPSHOT_DIR` | `artifactSnapshotDir` | path |  | Base directory of the immutable content-addressed artifact snapshots the worker proves from; default `<tmpdir>/nightgate-artifact-snapshots`, layout `<base>/<install>/<digest>`. Read in the wallet worker. |
| `NIGHTGATE_ARTIFACT_SNAPSHOT_TTL_DAYS` | `artifactSnapshotTtlDays` | int (min 0) | `14` | Snapshots no live process holds are swept after this many days; default 14. Read in the wallet worker. |
| `NIGHTGATE_ARTIFACT_DIGEST_MAX_AGE_MS` | `artifactDigestMaxAgeMs` | ms (min 0) | `300000` | How long the memoised current artifact digest (`getRuntimeInfo`, job resolves) may be trusted before the files are re-hashed regardless of their stat fingerprint. |
| `NIGHTGATE_DUST_RACE_RETRIES` | `dustRaceRetries` | int (min 0) | `2` | Rebuild-retries of a bound deploy/call/batch on a transient dust race (`1010/170`, `1010/171`, `1010/196`, pre-mempool, fee unspent); default `2`. Each retry re-proves the call, hence smaller than the sponsor path's `NIGHTGATE_SPONSOR_DUST_RETRIES`. `0` disables. |
| `NIGHTGATE_DUST_RACE_BACKOFF_MS` | `dustRaceBackoffMs` | ms (min 0) | `5000` | Pause before such a rebuild, letting the dust wallet apply the spend it lost against; default `5000`. |
| `NIGHTGATE_STALE_TRANSCRIPT_RETRIES` | `staleTranscriptRetries` | int (min 0) | `2` | Rebuild-retries of a bound deploy/call/batch the node refused against the current contract state (`1010/104`, pre-mempool, fee unspent; typically the gas budget after another transaction on the same contract grew a map); default `2`. Each retry re-runs and re-proves the call against current state. |
| `NIGHTGATE_STALE_TRANSCRIPT_BACKOFF_MS` | `staleTranscriptBackoffMs` | ms (min 0) | `15000` | Pause before such a rebuild, so the indexer serves the state that includes the competing transaction; default `15000`. |
| `NIGHTGATE_PREWARM_SYNC_TIMEOUT_MS` | `prewarmSyncTimeoutMs` | ms (min 1) | `43200000` | Absolute ceiling for the `connectWalletForSigning` prewarm sync-to-tip wait; default `43200000` (12 h). A backstop: the primary bound is `NIGHTGATE_PREWARM_STALL_MS`. |
| `NIGHTGATE_PREWARM_STALL_MS` | `prewarmStallMs` | ms (min 0) | `600000` | Prewarm fails when `appliedIndex` has not advanced for this long, regardless of elapsed time; default `600000` (10 min). A slow-but-moving sync is not stalled. `0` disables the stall bound (ceiling only). Read in the wallet worker. |
| `NIGHTGATE_SYNC_PROGRESS_STALE_S` | `syncProgressStaleS` | int (min 1) | `60` | `getWalletSyncProgress` reports `stale: true` once its snapshot is older than this, or than two `NIGHTGATE_PROGRESS_WATCH_MS` when that is longer; default `60`. A syncing wallet pushes a snapshot about every 15 s, a caught-up one every `NIGHTGATE_PROGRESS_WATCH_MS`. |
| `NIGHTGATE_WALLET_READ_SYNC_TIMEOUT_MS` | `walletReadSyncTimeoutMs` | ms (min 0) | `10000` | Bounded sync gate for facade-backed read actions (`getWalletBalance`, fee estimates): a catching-up facade answers 503 `WALLET_SYNCING` after this instead of parking the request; default `10000`, `0` waits indefinitely. |
| `NIGHTGATE_BALANCE_SYNC_TIMEOUT_MS` | `balanceSyncTimeoutMs` | ms (min 1) | `180000` | Worker-side wait for a genuine wallet sync before balancing a transaction; default `180000`. Read in the wallet worker. |
| `NIGHTGATE_SYNC_TIP_GAP` | `syncTipGap` | int (min 0) | `8` | Blocks behind the indexer tip a wallet may be and still count as synced; default `8`. Read in the wallet worker. |
| `NIGHTGATE_SYNC_FRESHNESS_MS` | `syncFreshnessMs` | ms (min 1) | `300000` | How old the indexer's latest block may be for a wallet to count as synced (guards against a lagging self-hosted indexer, error 117); default `300000`. Read in the wallet worker. |
| `NIGHTGATE_STREAM_TIP_GRACE_MS` | `streamTipGraceMs` | ms (min 0) | `180000` | A failed read of the ledger-event stream tip (one-shot indexer subscription, 10 s) reuses the last successful read within this window; an unknown tip fails the sync gate for that tick. Default `180000` (three progress-watch ticks), `0` = off. Read in the wallet worker. |
| `NIGHTGATE_INDEXER_TIP_GRACE_MS` | `indexerTipGraceMs` | ms (min 0) | `180000` | A failed read of the indexer's newest block (HTTP query, then the `blocks` subscription, 15 s + 10 s) reuses the last successful read within this window; its block timestamp still ages against `NIGHTGATE_SYNC_FRESHNESS_MS`, and an unknown tip fails the sync gate for that tick. Default `180000` (three progress-watch ticks), `0` = off. Read in the wallet worker. |
| `NIGHTGATE_PROGRESS_WATCH_MS` | `progressWatchMs` | ms (min 15000) | `60000` | Interval of the worker's progress watch: pushes each facade's sync-gate verdict to `getWalletSyncProgress` and `getSponsorPoolStatus` and checks restored sub-wallets for a rejected replay; default `60000`, floor 15 s. Read in the wallet worker. |
| `NIGHTGATE_SNAPSHOT_REPLAY_RESET_MS` | `snapshotReplayResetMs` | ms (min 0) | `300000` | A sub-wallet restored from a snapshot that stays at its restored offset while the ledger rejects its replayed events (dust: event older than the synced time or commitment below the tree index; shielded: commitment below the tree index) is replaced by a fresh one syncing from genesis once both have lasted this long; default `300000`, `0` disables the replacement. Read in the wallet worker. |
| `NIGHTGATE_DISCLOSURE_REINDEX_RETRY_MS` | `disclosureReindexRetryMs` | ms (min 0) | `1800000` | When the disclosure reindex after a landed grant, revoke or retract fails, a `reindexDisclosures` job retries it with backoff for this long before failing `DISCLOSURE_REINDEX_FAILED`; default `1800000` (30 min), `0` = one attempt. |
| `NIGHTGATE_SYNC_STATE_LOG_MS` | `syncStateLogMs` | ms (min 0) | `600000` | Interval of the per-facade INFO line `sync-state` (dust `appliedIndex` and `syncTime`, shielded `appliedIndex` and `firstFree`) written from the state save tick; default `600000`, `0` disables it. Read in the wallet worker. |
| `NIGHTGATE_STATE_AT_INDEXER_RATE` | `stateAtIndexerRate` | int (min 1) | `2` | Indexer reads per second for `ContractStates/stateAt` and `Blocks/ledgerParametersAt`, across all callers of this server, when the database lacks the answer; default `2`. Equal requests share one read. Keep it low against a hosted indexer, which may block the host IP when it gets too many requests; raise it for an own indexer. |
| `NIGHTGATE_STATE_AT_CACHE_MB` | `stateAtCacheMb` | int (min 0, max 4096) | `64` | Contract states from the indexer at the block of one of their actions, kept for `ContractStates/stateAt` once that block is finalized in the index, as megabytes of their base64 form. Such a state never changes, so a repeated read does not ask the indexer; `0` keeps none. Default `64`. |
| `NIGHTGATE_DECODE_WORKER_RPC_TIMEOUT_MS` | `decodeWorkerRpcTimeoutMs` | ms (min 1000) | `60000` | Timeout of one call into the decode worker, which reads contract state from the indexer and decodes it; default `60000`. |
| `NIGHTGATE_READINESS_DB_TIMEOUT_MS` | `readinessDbTimeoutMs` | ms (min 100) | `2000` | How long `getReadiness()` waits for its database read before reporting `database: false`; default `2000`. The probe answers in bounded time even when the pool is exhausted. |
| `NIGHTGATE_EVENT_LOOP_LAG_WARN_MS` | `eventLoopLagWarnMs` | ms (min 0) | `500` | Event-loop delay (p99 over the last 30 s) above which the main thread logs its lag and the database pool wait depth; default `500`, `0` = never log. The gauges in `getMetrics()` are always present. |
| `NIGHTGATE_SAVE_INTERVAL_MS` | `saveIntervalMs` | ms (min 10000) | `60000` | Wallet-state save tick of the worker; default `60000`, floor 10 s. Read in the wallet worker. |
| `NIGHTGATE_DUST_SNAPSHOT_COLLAPSE` | `dustSnapshotCollapse` | bool | `false` | `true` saves the dust snapshot with foreign generation leaves collapsed (restore in seconds instead of minutes); falls back to the full snapshot when the collapsed one does not restore to the same roots, balance and UTXOs. The restore check runs in a helper thread of the wallet worker. Default `false`. Read in the wallet worker. |
| `NIGHTGATE_DUST_COLLAPSE_BUDGET_MS` | `dustCollapseBudgetMs` | ms (min 1000) | `120000` | How long the restore check of one collapsed dust snapshot may run in the helper thread, counted from its start; past it the save tick writes the full snapshot once and the helper is restarted, checks waiting behind it are not charged. Default `120000`. Read in the wallet worker. |
| `NIGHTGATE_RESTORE_SAVE_ACK_TIMEOUT_MS` | `restoreSaveAckTimeoutMs` | ms (min 1) | `30000` | How long a facade restore waits for the acknowledgement of its immediate re-save; default `30000`. Read in the wallet worker. |
| `NIGHTGATE_DUST_COLD_START` | `dustColdStart` | bool | `false` | `true` starts the dust sub-wallet from the secret key instead of the persisted state. Read in the wallet worker. Diagnostic: it can change or go without notice. |
| `NIGHTGATE_DUST_REGISTER_SETTLE_MS` | `dustRegisterSettleMs` | ms (min 0) | `90000` | How long `registerForDustGeneration` waits for the registration to apply locally before it reports `settled: false`; default `90000`. Read in the wallet worker. |
| `NIGHTGATE_PROVE_RATE_LIMIT` | `proveRateLimit` | int (min 1) | `60` | Rate class `prove`, calls per hour per session: contract calls and batches, token operations, the `prove*` actions, `anchorDocument`, `registerDocument`, `retractAttestation`, `purgeExpired`, the disclosure actions, `buildSponsorable`; a batch counts its claims. Default `60`. Every `NIGHTGATE_*_RATE_LIMIT` is replaced by `rateLimits` in `NIGHTGATE_SPONSOR_POLICY_FILE` while that names the class. |
| `NIGHTGATE_DEPLOY_RATE_LIMIT` | `deployRateLimit` | int (min 1) | `5` | Rate class `deploy`, `deployContract` calls per hour per session; default `5`. |
| `NIGHTGATE_SPONSOR_RATE_LIMIT` | `sponsorRateLimit` | int (min 1) | `120` | Rate class `sponsor`, calls per hour per principal that the pool or a pinned sponsor pays for: `sponsorFinalized`, `sponsorUnbound`, `sponsorSwap`, `sponsorTransfer`, `mintFactoryToken`; default `120`. |
| `NIGHTGATE_COMPUTE_RATE_LIMIT` | `computeRateLimit` | int (min 1) | `120` | Rate class `compute`, calls per hour per principal that compute or write without a transaction: `prepareDocumentProof`, `prepareMembershipSet`, `claimDisclosure`, `grantDisclosureToHolders`, `revokeHolderDisclosure`, `postSwapOffer`, `retireSwapOffer`, `reindexDisclosures` (per contract); default `120`. |
| `NIGHTGATE_READ_RATE_LIMIT` | `readRateLimit` | int (min 1) | `60` | Rate class `read`, calls per minute per principal: `listSwapOffers`, `getSwapOffer`, `getBoardStatus`, `getReceiptKey`, `verifyDocument`, `verifyPredicateAttestation`, `getRuntimeInfo`, `getWalletBalance`, `getWalletSyncProgress`, `getSponsorPoolStatus`, `estimateSendTokenFee`, `getGrantUsage`, and the open probes `getHealth` and `getSyncStatus` per client address; default `60`. |
| `NIGHTGATE_QUERY_RATE_LIMIT` | `queryRateLimit` | int (min 1) | `600` | Rate class `query`, reads per minute per principal: every entity read, the bound read functions, `getJobStatus` and the analytics functions. Each part of a `$batch` counts on its own; default `600`. |
| `NIGHTGATE_QUERY_TIMEOUT_MS` | `queryTimeoutMs` | ms (min 0) | `15000` | PostgreSQL stops a statement of an entity read or a read function after this time, and the read answers 504 `QUERY_TIMEOUT`; default `15000`, `0` = no limit. SQLite has no such limit. |
| `NIGHTGATE_QUERY_CONCURRENCY` | `queryConcurrency` | int (min 1) | `4` | Most entity reads and read functions one principal may run at the same time; one more answers 429. `getJobStatus` does not count. Default `4`. |
| `NIGHTGATE_BATCH_MAX_PARTS` | `batchMaxParts` | int (min 1) | `20` | Most requests one `$batch` may carry; more answers 429. An explicit `cds.odata.batch_limit` wins; default `20`. |
| `NIGHTGATE_VERIFY_RATE_LIMIT` | `verifyRateLimit` | int (min 1) | `600` | Rate class `verify`, calls per minute per principal: `verifyAttestation`, `verifyPredicate`, `verifyDisclosure` on the service that needs credentials; default `600`. |
| `NIGHTGATE_STATE_DECODE_CACHE_MB` | `stateDecodeCacheMb` | int (min 0, max 4096) | `64` | Decoded contract states kept for the state readers, as megabytes of their serialized form. A state is decoded once and reused until the indexer returns other bytes; `0` decodes on every read. Default `64`. |
| `NIGHTGATE_WALLET_RATE_LIMIT` | `walletRateLimit` | int (min 1) | `10` | Rate class `wallet`, calls per minute per principal: `connectWallet`, `sendToken`, `registerForDustGeneration`, `deregisterFromDustGeneration`; default `10`. |
| `NIGHTGATE_SIGNING_RATE_LIMIT` | `signingRateLimit` | int (min 1) | `10` | Rate class `signing`, `connectWalletForSigning` and `deriveWalletInfo` attempts per hour per principal; default `10`. Its former name `NIGHTGATE_SIGNING_KEY_RATE_LIMIT` is not read. |
| `NIGHTGATE_ADMIN_RATE_LIMIT` | `adminRateLimit` | int (min 1) | `10` | Rate class `admin`, grant administration calls (`createAgentGrant`, `createAgentGrants`, `updateAgentGrant`, `rotateAgentGrantToken`, `revokeAgentGrant`) per hour per principal; default `10`. |
| `NIGHTGATE_GRANT_DEFAULT_JOBS_PER_HOUR` | `grantDefaultJobsPerHour` | int (min 1) |  | `maxJobsPerHour` of a grant whose creation does not name it. Unset = no hourly budget. |
| `NIGHTGATE_GRANT_DEFAULT_JOBS_PER_DAY` | `grantDefaultJobsPerDay` | int (min 1) |  | `maxJobsPerDay` of a grant whose creation does not name it. Unset = no daily budget. |
| `NIGHTGATE_PUBLIC_VERIFY` | `publicVerify` | bool | `false` | Serve `verifyAttestation`, `verifyPredicate` and `verifyDisclosure` without credentials under `/odata/v4/midnight-verify` (the image admits the path unauthenticated and answers CORS preflight with `*`); default off, the functions answer `404 PUBLIC_VERIFY_DISABLED`. |
| `NIGHTGATE_PUBLIC_VERIFY_RATE_LIMIT` | `publicVerifyRateLimit` | int (min 1) | `60` | Rate class `public-verify`, public verify calls per minute per client address; default `60`. |
| `NIGHTGATE_CLAIM_LIFETIME_S` | `claimLifetimeS` | int (min 60) | `31536000` | Default claim lifetime in seconds for the `prove*` actions when the caller passes no `validUntil`; default one year, the vault caps a claim at five years ahead. |
| `NIGHTGATE_FEE_SPONSOR_SESSIONS` | `feeSponsorSessions` | list |  | Comma list of platform fee-sponsor session ids (the pool); overrides `feeSponsorSessions`. A listed wallet only pays fees: as the acting session of an action that signs, moves coins or registers it answers 403. Its former name `NIGHTGATE_FEE_SPONSOR_SESSION` is not read. |
| `NIGHTGATE_SUBMIT_TRANSPORT_RETRIES` | `submitTransportRetries` | int (min 0) | `2` | Resends of the SAME finalized transaction when nothing reached the node (connect phase failed) or the send itself died (websocket closed mid-send, `ECONNRESET`; the indexer is probed for the identifier first, and a resend the node refuses is looked up there too); never a node reject, never a reply-less wait. Default `2`, `0` disables. No rebuild, no re-proving. Applies to every submit: deploy/call/batch, sends, dust registration, bound and unbound sponsoring. Read in the wallet worker. |
| `NIGHTGATE_SUBMIT_TRANSPORT_BACKOFF_MS` | `submitTransportBackoffMs` | ms (min 0) | `5000` | Pause before such a resend; default `5000`. Read in the wallet worker. |
| `NIGHTGATE_SUBMIT_LANDED_PROBE_MS` | `submitLandedProbeMs` | ms (min 0) | `30000` | How long the worker polls the indexer for the transaction identifier before a resend, and after a resend was rejected (a reply lost on the first send may still have reached the node); default `30000`. A landed transaction is reported as submitted only with ledger result `SUCCESS`; in a block but not applied fails as `TxFailedError` with the block height (fee spent). Read in the wallet worker. |
| `NIGHTGATE_SUBMIT_INTENT_ACK_TIMEOUT_MS` | `submitIntentAckTimeoutMs` | ms (min 1000) | `120000` | How long the worker waits for the main thread to record an announced transaction identifier before it gives up without broadcasting; default 2 minutes. The main thread waits at most as long for such a record before it answers the caller. Keep it above the database pool acquire timeout plus the lock-contention retries. Read in the wallet worker. |
| `NIGHTGATE_SUBMIT_CONNECT_TIMEOUT_MS` | `submitConnectTimeoutMs` | ms (min 1) | `20000` | Connect phase of a dedicated-client submit: client creation plus socket; default `20000`. A timeout here sent nothing (`transport/not-sent`, retried once on a fresh client, then a clean pre-inclusion failure). Read in the wallet worker. |
| `NIGHTGATE_SUBMIT_REQUEST_TIMEOUT_MS` | `submitRequestTimeoutMs` | ms (min 1) | `30000` | Request phase of a dedicated-client submit: from the send until the node's first status (subscription acknowledged); default `30000`. A timeout here is ambiguous (`no-reply`): the transaction may or may not be in the pool, the job parks for the confirmer. Read in the wallet worker. |
| `NIGHTGATE_SUBMIT_LATE_GRACE_MS` | `submitLateGraceMs` | ms (min 0) | `300000` | After a request or watch phase timeout the attempt keeps its node subscription open this long and logs a late status or reject under the transaction identifier (evidence only; the job is parked for the confirmer either way); default `300000`. Read in the wallet worker. |
| `NIGHTGATE_SUBMIT_WATCH_TIMEOUT_MS` | `submitWatchTimeoutMs` | ms (min 1) | `75000` | Watch phase of a submit: from the node's first status until InBlock (or Finalized, `NIGHTGATE_SUBMIT_WAIT`); default `75000`. A timeout here is ambiguous: the node took the request and nothing was included in time; the indexer is asked for 90 s, then the job parks for the confirmer. On the facade (bound) path this is the whole wait after the send. Read in the wallet worker. |
| `NIGHTGATE_REINDEX_REPLY_WAIT_MS` | `reindexReplyWaitMs` | ms (min 0) | `20000` | How long `reindexFromHeight` waits for its rollback before it answers `status: running` and lets it finish in the background; default `20000`. The rollback removes 2000 blocks per committed transaction, from the tip down. |
| `NIGHTGATE_BROADCAST_EXPIRY_MARGIN_MS` | `broadcastExpiryMarginMs` | ms (min 0) | `300000` | A job whose transaction the indexer does not know gets `chainStatus: dropped` and `BROADCAST_NOT_INCLUDED` once the indexer tip is this far past the transaction's validity window (ttl); default `300000`. A parked job also ends `failed`, a `succeeded` job keeps its status. The ttl is recorded at the submit intent; rows without one use the submit time plus one hour. |
| `NIGHTGATE_CHAIN_CONFIRM_LOOKUPS_PER_MINUTE` | `chainConfirmLookupsPerMinute` | int (min 1) | `120` | Indexer lookups per minute of the chain-outcome confirmer, over all jobs; default `120`. One lookup asks the indexer up to twice. |
| `NIGHTGATE_CHAIN_CONFIRM_BACKOFF_MAX_MS` | `chainConfirmBackoffMaxMs` | ms (min 1000) | `1800000` | Longest pause before the confirmer asks again about a job whose transaction has no outcome yet. The pause starts at 5 s and doubles per lookup; default 30 minutes. |
| `NIGHTGATE_SPONSOR_POLICY_FILE` | `sponsorPolicyFile` | path |  | Path to a JSON file `{ "allowedContracts": [], "allowedCircuits": [], "allowedTokenTypes": [], "allowContractMints": false, "allowSwaps": false, "shareMintedTokenTypes": false, "contractCircuits": { "<address>": "*" }, "rateLimits": { "prove": 60 } }` that replaces `NIGHTGATE_SPONSOR_ALLOWED_CONTRACTS`/`_CIRCUITS` while set; `rateLimits` names rate classes and replaces their `NIGHTGATE_*_RATE_LIMIT` keys. `contractCircuits` maps a contract address (64 hex) to `"*"` or a circuit list that replaces `allowedCircuits` for calls on that contract; the contract counts as allowed. Calls on a grant's `deployedContracts` are exempt from `allowedCircuits`. Re-read per sponsored call behind an mtime cache, so the sponsor policy changes without a container recreate. Fail-closed: an unreadable or invalid file keeps the last good policy, and with none loaded yet sponsored calls answer `503 SPONSOR_POLICY_UNAVAILABLE`. |
| `NIGHTGATE_SPONSOR_ALLOWED_CONTRACTS` | `sponsorAllowedContracts` | list |  | Comma list of contract addresses a sponsor pays for (platform floor); empty = any contract may be called. The same list names the contracts an unshielded offer may pay into besides the called one, and there an empty list names none. Replaced by `NIGHTGATE_SPONSOR_POLICY_FILE` while that is set. |
| `NIGHTGATE_SPONSOR_ALLOWED_CIRCUITS` | `sponsorAllowedCircuits` | list |  | Comma list of circuit names a sponsor pays for (platform floor); empty = any. Replaced by `NIGHTGATE_SPONSOR_POLICY_FILE` while that is set. |
| `NIGHTGATE_SPONSOR_ALLOWED_TOKEN_TYPES` | `sponsorAllowedTokenTypes` | list |  | Comma list of raw shielded token types (64 hex, what `deriveTokenType` returns) whose zswap offers the sponsor also pays for: a contract minting its own token to the caller, a caller spending that token into the contract. Unset = no offer at all (the default). Also `allowedTokenTypes` in the policy file and on a grant (effective = floor ∩ grant; the floor must open it, a grant only narrows). The shape check then requires every net change of the offer (`deltas`, public per type) to be on a listed type, never NIGHT, every contract-owned coin to belong to a sponsorable contract, and a net change to exist OR a coin in the offer to be owned by a sponsorable contract (a burn nets to zero by construction: user input, contract transient, burn-address output; a zero-net offer without a contract coin is refused). User outputs are commitments, so a transfer of a listed type between users riding along is accepted by design: the sponsor pays dust, no sponsor value moves. An invalid entry fails closed (`503 SPONSOR_POLICY_UNAVAILABLE`). |
| `NIGHTGATE_SPONSOR_ALLOW_CONTRACT_MINTS` | `sponsorAllowContractMints` | bool | `false` | Also sponsors the zswap offer of a token that a contract call in the SAME transaction mints: `true`/`1`/`yes`. Off by default. The call declares its mints (`effects.shieldedMints`, domain separator and amount, bound by the proof); the type derived from domain separator and contract address has to be the offer's type, the contract sponsorable (allow-listed or deployed under the grant), the offer's net change negative and not larger than the declared amount. Such a type needs no entry in `allowedTokenTypes`, on the platform or on a grant. A transaction that moves the token without minting it (a payment into a contract, a swap) needs the entry, unless the token was minted under the caller's grant before: those types are recorded on the grant and count as listed while this switch is on. Also `allowContractMints` in the policy file. |
| `NIGHTGATE_SPONSOR_SHARE_MINTED_TOKEN_TYPES` | `sponsorShareMintedTokenTypes` | bool | `false` | Token types that landed sponsored mints created (table `LearnedTokenTypes`) count as listed for every grant, not only the minting one: `true`/`1`/`yes`. Off by default; needs `NIGHTGATE_SPONSOR_ALLOW_CONTRACT_MINTS`. A grant may still narrow to a subset with `allowedTokenTypes`. Also `shareMintedTokenTypes` in the policy file. |
| `NIGHTGATE_SPONSOR_ALLOW_SWAPS` | `sponsorAllowSwaps` | bool | `false` | Opens `sponsorSwap` on this deployment: `true`/`1`/`yes`. Off by default. The sponsor pays the dust of a shielded swap handed over as two proven, unbound halves; a token caller additionally needs `sponsorSwap` in its grant's `allowedActions`. Each half gives one token type and wants another, both in the effective `allowedTokenTypes`, never NIGHT; the halves mirror each other and the merged transaction balances. The terms are readable, the parties are not: a swap against a token amount of 1 is a transfer in effect, so this makes the sponsor a fee-free relay for the listed types, bounded by the rate limit and the grant's daily budget. Also `allowSwaps` in the policy file. |
| `NIGHTGATE_SPONSOR_ALLOW_TRANSFERS` | `sponsorAllowTransfers` | bool | `false` | Opens `sponsorTransfer` on this deployment: `true`/`1`/`yes`. Off by default. The sponsor pays the dust of a plain transfer the caller built from its own coins; a token caller additionally needs `sponsorTransfer` in its grant's `allowedActions`. A shielded transfer: the declared token type must be in the effective `allowedTokenTypes`. The transfer carries an offer and nothing else, nets to zero and spends at most `NIGHTGATE_SPONSOR_MAX_INPUTS` coins; its recipient and amount are commitments the sponsor cannot read, so the declaration is recorded, not verified. An unshielded transfer, NIGHT included, also needs `NIGHTGATE_SPONSOR_ALLOW_UNSHIELDED_OFFERS`; its type, amount and recipient are read from the transaction. Also `allowTransfers` in the policy file. |
| `NIGHTGATE_SPONSOR_ALLOW_UNSHIELDED_OFFERS` | `sponsorAllowUnshieldedOffers` | bool | `false` | Lets a sponsored call move unshielded tokens: the caller's own into the contract it calls, and the payouts the called contract requires: `true`/`1`/`yes`. Off by default. A token caller additionally needs `allowUnshieldedOffers` on its grant. The intent's unshielded offer must sit next to a sponsorable call, balance per token type on the ledger (inputs and contract payouts = outputs + what the called circuit takes in), send every output to a sponsorable contract, back to an input owner, or to a recipient the call's proven result pays (`claimedUnshieldedSpends`), and move only NIGHT or a type in `NIGHTGATE_SPONSOR_ALLOWED_UNSHIELDED_TOKEN_TYPES`; caller dust actions stay refused. The contract decides who is paid; the sponsor adds dust only, never value. Together with `NIGHTGATE_SPONSOR_ALLOW_TRANSFERS` it also opens `sponsorTransfer` for a plain unshielded transfer to one address. Also `allowUnshieldedOffers` in the policy file. |
| `NIGHTGATE_SPONSOR_ALLOWED_UNSHIELDED_TOKEN_TYPES` | `sponsorAllowedUnshieldedTokenTypes` | list |  | Comma list of raw unshielded token types (64 hex) a sponsored unshielded offer may move besides NIGHT, which is always allowed. Unset = NIGHT only. Also `allowedUnshieldedTokenTypes` in the policy file and on a grant (the grant only narrows). An invalid entry fails closed (`503 SPONSOR_POLICY_UNAVAILABLE`). |
| `NIGHTGATE_TOKEN_FACTORY_CONTRACT` | `tokenFactoryContract` | string |  | Address (64 hex) of the token-factory deployment `mintFactoryToken` and `burnFactoryToken` use when the call names no `contractAddress`. Unset: the call must name the factory. |
| `NIGHTGATE_SPONSOR_MAX_INPUTS` | `sponsorMaxInputs` | int (min 1) | `4` | Most zswap inputs one half of a sponsored swap, or a sponsored transfer, may carry; default `4`. Either carries at most two outputs (the coin it pays, its change). Every coin adds about 5 kB to the transaction: two halves with 4 inputs and 2 outputs each merge to about 60 kB, with 5 inputs each to about 70 kB, so a higher value also needs a higher `NIGHTGATE_SPONSOR_MAX_TX_BYTES`. Read in the wallet worker. Its former name `NIGHTGATE_SPONSOR_SWAP_MAX_INPUTS` is not read. |
| `NIGHTGATE_SPONSOR_MAX_TX_BYTES` | `sponsorMaxTxBytes` | int (min 1) | `65536` | Byte ceiling of a sponsored call transaction or unshielded transfer the worker accepts; default `65536`. Read in the wallet worker. |
| `NIGHTGATE_SPONSOR_MAX_DEPLOY_BYTES` | `sponsorMaxDeployBytes` | int (min 1) | `40960` | Byte ceiling of a sponsored DEPLOY transaction (a deploy writes verifier keys on chain and costs a multiple of a call); default `40960`. Read in the wallet worker. |
| `NIGHTGATE_SPONSOR_MAX_MAINTENANCE_BYTES` | `sponsorMaxMaintenanceBytes` | int (min 1) | `40960` | Byte ceiling of a sponsored maintenance update transaction (an update that inserts verifier keys writes them on chain like a deploy); default `40960`. Read in the wallet worker. |
| `NIGHTGATE_SUBMIT_WAIT` | `submitWait` | `inblock` / `finalized` | `inblock` | Submission stage every submit waits for on its dedicated node client: `inblock` (default) or `finalized`. The indexer confirmer records the final inclusion on the job either way. Read in the wallet worker. Its former name `NIGHTGATE_SPONSOR_WAIT` is not read. |
| `NIGHTGATE_SUBMIT_INDEXER_VISIBLE_MS` | `submitIndexerVisibleMs` | ms (min 0) | `30000` | After the awaited status (InBlock or Finalized), bounded wait until the indexer shows the transaction and check its ledger result there (in a block but not applied fails as `TxFailedError`); `0` skips the wait and the check, the indexer confirmer still records the outcome on the job; default `30000`. Read in the wallet worker. Its former name `NIGHTGATE_SPONSOR_INDEXER_VISIBLE_MS` is not read. |
| `NIGHTGATE_SPONSORED_CALLER_SYNC` | `sponsoredCallerSync` | `wait` / `skip` | `wait` | `skip` omits the caller-side wallet sync when balancing a sponsored transaction (vault calls move no caller value). Read in the wallet worker. |
| `NIGHTGATE_NOTE_LEASE_MS` | `noteLeaseMs` | ms (min 1) | `300000` | Lease on a dust note backing a sponsored transaction (parallel sponsoring from one wallet); a non-positive or non-numeric value falls back to the default `300000`. Read in the wallet worker. |
| `NIGHTGATE_BACKING_WAIT_MS` | `backingWaitMs` | ms (min 0) | `300000` | How long an unbound sponsoring waits for a free dust backing before it refuses; default `300000`. Read in the wallet worker. |
| `NIGHTGATE_SPONSOR_MAX_DUST_NOTES` | `sponsorMaxDustNotes` | int (min 1) | `4` | How many dust notes an unbound sponsoring may combine when no single note covers the fee; default `4`. Each comes from its own NIGHT UTXO. `1` pays every fee from one note. Read in the wallet worker. |
| `NIGHTGATE_NOTE_SPENT_WAIT_MS` | `noteSpentWaitMs` | ms (min 0) | `30000` | How long a dust backing stays reserved after its sponsored spend went out, until the sponsor wallet no longer lists the spent note; default `30000`. Released earlier, the next spend on that backing would be built on the same note and rejected (`1010/196`). `0` releases at once. Read in the wallet worker. |
| `NIGHTGATE_SPONSOR_PREWARM_SYNC_MS` | `sponsorPrewarmSyncMs` | ms (min 0) | `1800000` | Prewarm brings pool members to the chain tip one at a time; this caps the wait per sponsor, default 30 min, `0` = build only. |
| `NIGHTGATE_SPONSOR_STATUS_TIMEOUT_MS` | `sponsorStatusTimeoutMs` | ms (min 1) | `45000` | Per-sponsor read cap of `getSponsorPoolStatus`; default `45000`. |
| `NIGHTGATE_SPONSOR_LEASE_WAIT_MS` | `sponsorLeaseWaitMs` | ms (min 0) | `120000` | How long a sponsored job waits for a busy or cooling sponsor before it fails over or gives up; default `120000`. |
| `NIGHTGATE_SPONSOR_COOLDOWN_MS` | `sponsorCooldownMs` | ms (min 0) | `120000` | Bench time of a sponsor after a retryable failure; default `120000`. |
| `NIGHTGATE_SPONSOR_DUST_RETRIES` | `sponsorDustRetries` | int (min 0) | `4` | Rebuild-retries of a sponsored transaction on a dust race, on the same sponsor, before the next sponsor takes over; default `4`. |
| `NIGHTGATE_SPONSOR_DUST_BACKOFF_MS` | `sponsorDustBackoffMs` | ms (min 0) | `5000` | Pause before such a rebuild; default `5000`. |
| `ENCRYPTION_KEY` |  | secret |  | At-rest secret (32+ byte hex) for viewing keys, seed keys and encrypted job commands; key id `1` of the ring. Without any key a random per-process dev key is used (rows do not survive a restart); **required** in production. Env only, no CAP mapping. |
| `ENCRYPTION_KEYS` |  | secret |  | Key ring `id=secret,id=secret` (ids `[A-Za-z0-9_-]{1,16}`); `ENCRYPTION_KEY` joins it as id `1`. Every secret is HKDF-stretched; new ciphertexts are `v3:<keyId>:...` envelopes (per-row data key wrapped by the ring key; key id, column and row bound as AAD). Older `v2` and legacy `iv:tag:data` values stay readable, the legacy ones under id `1`. Env only, no CAP mapping. |
| `NIGHTGATE_RECEIPT_SIGNING_KEY` |  | secret |  | Ed25519 seed (64 hex) the instance signs job receipts with (`getJobStatus.receipt`, public key under `getReceiptKey`). Unset: derived from the active encryption key, so it changes with a key rotation. Env only, no CAP mapping. |
| `ENCRYPTION_KEY_ACTIVE` |  | string |  | Id of the ring key new ciphertexts are written under (required with more than one key). Startup refuses a database whose ciphertexts name a key id outside the ring; `scripts/rewrap-encryption-keys.mjs` moves rows to the active key (see docs/operations.md, key rotation). Env only, no CAP mapping. |
<!-- config-table:end -->

Read by the image and the dev scripts, not by the server:

| Variable | Purpose |
|---|---|
| `NIGHTGATE_DB_URL` | Image: `postgres://user:pw@host:5432/db` selects PostgreSQL. `?sslmode=` accepts `disable`, `require` or `verify-full` with optional `sslrootcert=<pem>`. Unset means SQLite at `NIGHTGATE_DB_PATH` |
| `NIGHTGATE_DB_DEPLOY` | Image with PostgreSQL: `auto` deploys the schema at boot, `never` skips. Default `auto` |
| `NIGHTGATE_DB_WAIT_SECONDS` | Image `migrate` mode: wait for the PostgreSQL listener, 1 to 86400. Default 60 |
| `NIGHTGATE_HEAP_MB` | Heap of `scripts/dev.mjs` and `scripts/serve.mjs`. Default `12288` |

For a local checkout, put variables into a repo-root `.env`. Template: [.env.example](../.env.example).

## Runtime behavior

### Server lifecycle

- CAP loads `srv/server.ts`, which registers the hooks below.
- The connector routes `/zk-config` and `/contract-manifest` attach at CAP bootstrap. `GET /zk-config/<contract>` lists the circuits and the files below it: `keys/`, `zkir/` and `compiler/contract-manifest.json`.
- `initialize()` runs on `cds.on('served')`. It checks the schema, loads `contracts`, starts the wallet worker and, if enabled, the crawler.
- `shutdown()` runs on `cds.on('shutdown')`. It stops the crawler and the worker, which saves every cached wallet first.

### Startup and failure

- The server never deploys the schema. A missing table or column keeps NIGHTGATE offline with `SCHEMA_NOT_DEPLOYED`, and the server keeps running. The image entrypoint deploys it: on SQLite when the file is missing, on PostgreSQL at every boot.
- An unreachable node logs a warning and starts in `offline` mode. Reads and submissions keep working.
- A wallet worker that fails to start logs a warning. Submissions fail, reads work.
- `initialize()` is idempotent and reloads `contracts`.

### Pipelines

The crawler reads the node on the main thread. The wallet SDK reads the indexer in the worker thread. Both write to one database and share no hash. The indexer confirmer records a job's block height, and a reorg rollback reverts outcomes at or above the fork height. Transaction outcomes come from `System.Events` only. A block without them is retried, never stored as success. The crawler decodes blocks below runtime version 2000000 with ledger 8 and later blocks with ledger 9. Details: [architecture.md](architecture.md).

### Error classification

Error codes of `classifySubmissionError(err, network)`: [actions.md#error-model](actions.md#error-model).

### HTTP error codes

Every error response carries `error.code`. It is a specific code where a client can act on it, else the class of its HTTP status. A job ends with a code of this table, as `getJobStatus.errorCode`. `Job` marks the codes made for jobs, and a code without an HTTP status only ends a job. The server repeats a job by itself only on a code marked `Job` and `Retryable`. `Retryable` means a new attempt of the same call can succeed and doubles nothing. Every code of this server is upper case with underscores. A 5xx keeps its code in production. Its message is withheld unless the code exposes it. An input CAP refuses before the handler keeps its code, with status 400: `ASSERT_FORMAT`, `ASSERT_RANGE`, `ASSERT_ENUM`, `ASSERT_DATA_TYPE`, `ASSERT_MANDATORY`, `ASSERT_ARRAY` and `ASSERT_TARGET`. A numeric CAP code becomes the class of its status.

<!-- error-codes:start -->
| Code | HTTP | Job | Retryable | Meaning |
|---|---|---|---|---|
| `INVALID_ARGUMENT` | 400 |  | no | A parameter is missing, malformed or out of range. |
| `UNAUTHENTICATED` | 401 |  | no | No or unknown principal, or a session the caller does not own. |
| `FORBIDDEN` | 403 |  | no | The principal may not perform this operation. |
| `NOT_FOUND` | 404 |  | no | The addressed record does not exist or is not visible to the caller. |
| `CONFLICT` | 409 |  | no | The request conflicts with the current state. |
| `GONE` | 410 |  | no | The addressed record expired or was closed. |
| `PRECONDITION_FAILED` | 412 |  | no | A required earlier step is missing (e.g. no signing key on the session). |
| `PAYLOAD_TOO_LARGE` | 413 |  | no | The request body exceeds a limit. |
| `RATE_LIMITED` | 429 |  | yes | A rate class or a grant budget is used up; the message names it, `Retry-After` says when to retry. |
| `INTERNAL` | 500 |  | no | Unexpected server failure; the message is withheld in production. |
| `NOT_IMPLEMENTED` | 501 |  | no | The operation is not available in this configuration. |
| `BAD_GATEWAY` | 502 |  | yes | An upstream (node, indexer, proof server) answered wrongly. |
| `UNAVAILABLE` | 503 |  | yes | Temporarily unavailable; retry later. |
| `ACCOUNT_KEY_UNAVAILABLE` | 503 |  | yes | The per-account data key could not be read. |
| `ACCOUNT_MOVE_BLOCKED` | 409 |  | no | An open session holds this wallet under another spelling of its viewing key. Close that session, then connect again. |
| `AGENT_GRANT_REVOKED` | 403 | yes | no | The agent grant a queued job ran under was revoked; nothing was sponsored. |
| `ARG_COERCION_FAILED` | 400 |  | no | A circuit argument does not match the circuit's declared type. |
| `BATCH_CAUSALITY_VIOLATION` | 409 | yes | no | A batch orders a fallible call before a guaranteed one; split or reorder it. |
| `CONTRACT_NOT_REGISTERED` | 404 |  | no | No compiled artifact is registered under this name. |
| `CONTRACT_REGISTRATION_REJECTED` | 400 |  | no | A runtime contract registration was refused. |
| `ENCRYPTION_KEY_UNKNOWN` | 500 |  | no | A stored ciphertext names a key id outside the configured ring. |
| `FEE_SPONSOR_UNUSABLE` | 403, 404, 410, 412 | yes | no | The session named by `sponsorSessionId` cannot pay. The status says why: 403 the caller is not signed in, 404 no such session of this caller, 410 expired, 412 it has no signing key. |
| `GRANT_REVOKED` | 409 |  | no | The agent grant is revoked; it cannot be changed any more. |
| `IDEMPOTENCY_KEY_CONFLICT` | 409 |  | no | The idempotency key was used with a different payload. |
| `IDEMPOTENCY_KEY_INVALID` | 400 |  | no | The idempotency key is longer than 128 characters. |
| `INSTANCE_LEASE_HELD` | 503 |  | no | Another process runs the background work on this database. |
| `JOB_ADMISSION_BUSY` | 503 |  | yes | The job admission lock is contended; retry after `Retry-After`. |
| `PRIVATE_STATE_EXPORT_INVALID` | 400 |  | no | The private-state export is not in the expected format. |
| `PRIVATE_STATE_EXPORT_UNREADABLE` | 400 |  | no | The private-state export does not decrypt with this password. |
| `PRIVATE_STATE_IMPORT_CONFLICT` | 409 |  | no | The private-state import would overwrite existing state. |
| `PROVER_KEYS_UNAVAILABLE` | 503 |  | yes | The contract's prover keys are not available on this server. |
| `RUNTIME_TOPOLOGY_UNSUPPORTED` | 503 |  | no | The deployment topology (replicas, multitenancy, database) is not supported. |
| `PUBLIC_VERIFY_DISABLED` | 404 |  | no | Unauthenticated verification is not enabled on this server. |
| `QUERY_TIMEOUT` | 504 |  | no | A read ran longer than its time limit and was stopped; narrow the filter or sort by an indexed column. |
| `QUERY_NOT_INDEXED` | 400 |  | no | A read of a chain table filters or sorts by a column without an index; the message names the columns that have one. |
| `PURE_CIRCUITS_UNAVAILABLE` | 404 |  | no | The artifact does not export the pure circuits this operation needs. |
| `TOKEN_FACTORY_UNAVAILABLE` | 404 |  | no | No token-factory lineage is registered, or the artifact is not one. |
| `RUNTIME_UNAVAILABLE` | 503 |  | yes | The runtime did not start (schema, network or worker); see getRuntimeInfo. |
| `SCHEMA_NOT_DEPLOYED` | 503 |  | no | The database schema is missing tables or columns; run the schema delta. |
| `SESSION_NOT_FOUND` | 404 | yes | no | The wallet session does not exist, is inactive or belongs to another user. |
| `SIGNING_KEY_EXPORT_REJECTED` | 400 |  | no | The signing-key export was refused. |
| `SPONSOR_DUST_UNAVAILABLE` | 503 | yes | no | The sponsor has no free dust note that covers the fee: too little dust, or every note is in use. A later attempt may succeed. |
| `SPONSOR_POLICY_EMPTY` | 403 | yes | no | The effective sponsor policy allows nothing for this caller. |
| `SPONSOR_POLICY_UNAVAILABLE` | 503 | yes | yes | The sponsor policy file cannot be read; fail-closed. |
| `SPONSOR_REFUSED` | 403 | yes | no | The sponsor refused the transaction under its policy. |
| `SWAP_OFFER_INVALID` | 400 |  | no | The posted text is not a swap half the offer board can carry. |
| `SUBMIT_INTENT_REJECTED` | 409 | yes | no | The server refused to record the broadcast; nothing was sent. |
| `SUBMIT_INTENT_TIMEOUT` | 503 | yes | yes | The announced transaction was not recorded in time; nothing was sent. The server does not repeat the job itself. |
| `SUBMIT_PHASE_FAILED` | 502 |  | no | A submission phase (send, watch) failed; `info.phase` names it. |
| `SUBMIT_WATCH_TIMEOUT` | 504 |  | no | The submission was sent but its inclusion was not seen in time; the outcome is unknown. |
| `SYNC_STATE_CHAIN_MISMATCH` | 503 |  | no | The node serves another chain than the one the database was indexed from. Indexing stops. |
| `SYNC_STATE_NETWORK_MISMATCH` | 503 |  | no | The database is bound to another network than the configured one. |
| `TOKEN_TYPE_INVALID` | 400 |  | no | The token type or contract address is malformed. |
| `TX_FAILED` | 409 | yes | no | The transaction landed and failed on chain. |
| `WALLET_MATERIAL_UNAVAILABLE` | 501 |  | no | This session has no wallet material for signing. |
| `WALLET_NOT_SYNCED` | 503 |  | yes | The wallet did not reach the chain tip in time; nothing was sent. |
| `WALLET_SIGNING_NOT_AVAILABLE` | 409 | yes | no | The session was connected without a signing key. |
| `WALLET_SYNCING` | 503 |  | yes | The wallet is still catching up; retry after `Retry-After`. |
| `WORKER_ROTATING` | 503 | yes | yes | The wallet worker is rotating; retry. |
| `AGENT_GRANT_SCOPE` |  | yes | no | The agent grant no longer covers what the queued job would do; nothing was executed. |
| `BATCH_GAS_BUDGET_EXCEEDED` |  | yes | no | A call of the batch runs out of gas before proving; split the batch. |
| `BROADCAST_NOT_INCLUDED` |  | yes | no | The transaction was sent and is in no block; the chain is past its expiry. |
| `BROADCAST_UNCONFIRMED` |  | yes | no | The transaction was sent, the node gave no status and the indexer does not show it yet. |
| `CHAIN_EXECUTION_FAILED` |  | yes | no | The transaction is on chain and its contract call did not apply. |
| `CHAIN_EXECUTION_FAILED_UNCONFIRMED` |  | yes | no | The call failed on chain, and the block of the transaction is not recorded yet. |
| `CHILD_FAILED` |  | yes | no | A workflow step failed; the message names the steps already on chain. |
| `CHILD_RECONCILIATION_REQUIRED` |  | yes | no | A workflow step is on chain and a later step did not complete. |
| `CONTRACT_CONFIG_INVALID` |  | yes | no | The SDK refused the contract call as configured (argument types or private state); the message names its error. |
| `DISCLOSURE_REINDEX_FAILED` |  | yes | no | The disclosure grants of a contract could not be read back after a landed change. |
| `EXTERNAL_EXECUTION_FAILED` |  | yes | no | The job failed after its transaction was sent; check the chain before a new attempt. |
| `LEASE_EXPIRED` |  | yes | no | The process that ran the job stopped reporting. |
| `MALFORMED_RESULT` |  | yes | no | The SDK returned a submission result without the expected fields. |
| `NETWORK_OR_TIMEOUT` |  | yes | yes | The send failed before the node answered; nothing is on chain. |
| `POOL_INVALID` |  | yes | yes | The pool reported the transaction invalid without a ledger code; a competing transaction may have spent a coin first. |
| `PROCESS_RESTART_BEFORE_BROADCAST` |  | yes | no | The server restarted after the transaction was announced and before it was sent. |
| `PROCESS_RESTART_BEFORE_EXECUTION` |  | yes | no | The server restarted before the job did anything outside the database. |
| `PROCESS_RESTART_RECONCILE` |  | yes | no | The server restarted after the transaction was sent. |
| `PROCESS_RESTART_SESSION_CLOSED` |  | yes | no | The server restarted and closed the wallet session the queued job belongs to. |
| `PROCESS_RESTART_SESSION_JOB_DROPPED` |  | yes | no | The server restarted while a job of the wallet session itself was running. |
| `REJECTED` |  | yes | no | The attempt was refused before any block took it; nothing is on chain. |
| `REJECTED_ATTEMPT_BOOKKEEPING_PENDING` |  | yes | no | A refused sponsored attempt is not booked back yet; the reconciler does it. |
| `RESULT_PERSIST_FAILED` |  | yes | no | The transaction was sent, but the result of the job could not be stored. |
| `SPONSOR_ATTEMPT_REJECTED` |  | yes | no | A sponsored attempt was refused before any block took it; its budget is booked back. |
| `SUBMIT_AMBIGUOUS` |  | yes | no | The transaction may have reached the node; it is never built again. |
| `SUPERSEDED` |  | yes | no | Another run took the job over while this one was still working. |
| `UNKNOWN_ERROR` |  | yes | no | Any other failure; the message starts with the name of the error. |
| `WORKER_ROTATED` |  | yes | no | The wallet worker was restarted while the job was running in it. |
<!-- error-codes:end -->

### Runtime topology

NIGHTGATE runs as exactly one process and one CAP tenant. Startup fails closed when a replica count above one is declared or CAP multitenancy is on. The count comes from `NIGHTGATE_REPLICA_COUNT`, `replicaCount`, `CF_INSTANCE_COUNT` or `KUBERNETES_REPLICA_COUNT`. `WEB_CONCURRENCY` is ignored. On Cloud Foundry every instance with `CF_INSTANCE_INDEX` other than `0` fails closed. The guard is no leader election, so deploy one instance. Production SQLite fails closed too.

### Database

The CAP configuration chooses the database. SQLite runs one instance. The image supports SQLite and PostgreSQL. HANA is not tested.

```json
{
  "cds": { "requires": { "db": {
    "[development]": { "kind": "sqlite", "credentials": { "url": "db/local.db" } },
    "[production]":  { "kind": "postgres", "credentials": { "url": null } }
  } } }
}
```

- Inject credentials through a CAP service binding or `cds_requires_db_credentials_*`.
- `package.json` sets `cds.features.use_generic_pool: true`. `CDS_CONFIG` or `CDS_FEATURES_USE__GENERIC__POOL` overrides it.
- The image uses pool `{ max: 20, acquireTimeoutMillis: 30000, destroyTimeoutMillis: 5000 }` and client `{ connectionTimeoutMillis: 10000 }`.
- Run `cds deploy --profile production` before the first start. Back up before each upgrade.
- SQLite to PostgreSQL: [docker.md#postgresql](docker.md#postgresql).
- Delete `db/midnight.db*` when switching networks.

### Background jobs

`BackgroundJobs` is the durable record of wallet and contract operations. It holds the request fingerprint, attempts, lease, heartbeat, the `PendingSubmissions` id and the transaction hash.

- `(sessionId, kind, idempotencyKey)` is unique. The same key with a different request is rejected. A failed job releases its key, unless it may be on chain or is a workflow step.
- Lifecycle: `pending`, `running`, `external_execution`, `submitted`, then `succeeded` or `failed`. `external_execution` starts right before the SDK call that proves, balances and broadcasts.
- `chainStatus` is `pending`, `success`, `failure` or `dropped`. The indexer confirmer sets it together with `blockHeight` and `blockHash`.
- After a restart, a job before the external effect fails or re-queues from its persisted command. A job past it parks as `reconciliation_required`.
- A parked job ends when the indexer shows its transaction, when the indexer tip passes its ttl by `NIGHTGATE_BROADCAST_EXPIRY_MARGIN_MS` (`BROADCAST_NOT_INCLUDED`), or when every child of a workflow parent succeeded.
- Alert on a `odatano_nightgate_jobs_reconciliation_required` that does not drain.
- Replayed commands carry no seed material. Circuit arguments, private state and witnesses are stored as AES-256-GCM ciphertext.

### Encrypted rows

`PrivateStates`, `ContractSigningKeys` and `WalletSyncStates` are encrypted under a per-account data key in `AccountKeys`. That key is sealed under the active ring key and under the viewing-key password. A key rotation is in [operations.md#rotating-the-encryption-key](operations.md#rotating-the-encryption-key). Losing every ring key makes the stored keys unreadable, so back up the secrets.

### HTTP security

NIGHTGATE installs no global HTTP middleware. CORS, CSP and HSTS belong to the proxy in front of it. It registers two transport lanes with `@odatano/cap-auth`: the agent token on `/odata/v4/midnight` and public verify on `/odata/v4/midnight-verify`. They act only where `cds.requires.auth.impl` is that package, as in the image.

## Services and entities

| Service | Path | Surface |
|---|---|---|
| `NightgateService` | `/odata/v4/midnight` | Chain entities, wallet sessions, token and contract actions |
| `NightgateIndexerService` | `/odata/v4/midnight-indexer` | `SyncState`, `ReorgLog`, health, metrics, crawler control |
| `NightgateAnalyticsService` | `/odata/v4/midnight-analytics` | `BlockStatistics`, `ContractStatistics` |
| `NightgateAdminService` | `/odata/v4/midnight-admin` | Sessions, jobs, roles, swap offers, learned token types, and the operator's tables: `AgentGrants` with lists and counters, `PendingSubmissions`, `SyncState` with the markers of the background passes |
| `NightgateVerifyService` | `/odata/v4/midnight-verify` | `verifyAttestation`, `verifyPredicate`, `verifyDisclosure` without credentials when `NIGHTGATE_PUBLIC_VERIFY=true` |

Signatures and examples: [actions.md](actions.md).

### NightgateService entities

All are read-only. Hex values are lowercase without `0x`; a read takes either spelling, see [actions.md](actions.md).

| Entity | Notes |
|---|---|
| `Blocks` | `ledgerParametersAt(height)` returns the ledger parameters in effect at `height`, default the chain tip, with `coveredHeight` and `chainHeight`. `author` is the validator's AURA key, null when the header seal does not verify. `slot` is the AURA slot. Older rows are rewritten in the background, tracked by `authorBackfillHeight` and `authorsBackfilledAt` of `SyncState` in the admin service |
| `Transactions` | `extrinsicHash` is the hash of the extrinsic, `txHash` the hash explorers and the Midnight indexer show, `blockHeight` and `indexInBlock` the position in the chain. `circuit` is the name of the first circuit the transaction calls. `circuit`, `isShielded`, `hasProof` and the final `txType` need `crawler.decodePayloads` and are null until the payload is decoded. `byTxId(txId)` finds a transaction by a ledger identifier, 404 while not indexed |
| `TransactionResults`, `TransactionSegments`, `TransactionFees` | Per-transaction outcome, segments and fees |
| `ContractActions` | One row per applied contract action, in chain order by `blockHeight`, `indexInBlock`, `actionIndex`. `circuit` is the circuit name, null until `crawler.decodePayloads` has decoded the transaction and for a deploy or an update. `stateHash`, `stateSize` and `state` need `crawler.indexerSupplement` |
| `ContractBalances` | Needs `crawler.indexerSupplement` |
| `ContractStates` | Newest state per contract. `stateAt(contractAddress, height)` returns the state after the newest action at or below `height`, with `source`, `verified`, `blockHash`, `ledgerParameters`, `coveredHeight` and `chainHeight` |
| `UnshieldedUtxos`, `NightBalances` | From `Midnight.UnshieldedTokens`. A UTXO carries `blockHeight` and `indexInBlock` of the transaction that created it. `registeredForDustGeneration` needs `crawler.indexerSupplement` |
| `ZswapLedgerEvents`, `DustLedgerEvents` | Indexer event streams. Need `crawler.indexerSupplement` |
| `Documents`, `PredicateAttestations`, `DisclosureGrants`, `GranteeIdentities` | Attestation and disclosure records. Scoped to the owning user, for an agent token to its session. Admins see all |
| `WalletSessions` | Keyed by `sessionId`. Without the stored viewing key and seed. Scoped to the owning user. Admins see all |
| `AgentGrants` | Agent grants of the caller: session, label, validity, limits and the deploy right. The lists come back from the create and update actions, the use from `getGrantUsage` |

### Stored tables

| Entity | Purpose |
|---|---|
| `PendingSubmissions` | Submission lifecycle `pending`, `included`, `finalized` or `failed`. Written before the SDK call |
| `BackgroundJobs` | Async jobs. Poll `getJobStatus(jobId)` |
| `PrivateStates` | Encrypted private state per account, contract and private-state id |
| `ContractSigningKeys` | Encrypted contract signing keys per account and contract |
| `AccountKeys` | Per-account data keys |
| `WalletSyncStates` | Serialized sub-wallet states per account |
| `WalletSessions.encryptedSeedKey` | Set by `connectWalletForSigning`. Null means read-only session |
| `Documents` | `payloadHash` and the caller's `storageRef`, never the bytes |
| `DisclosureGrants` | Read from the vault `disclosures` map after each grant or revoke |
| `HolderDisclosureGrants` | Disclosures granted to the holders of a token type |
| `GranteeIdentities` | User to vault grantee id, set by `registerGranteeIdentity` |
| `AgentGrants` | Agent tokens, rights and budgets. `mintedTokenTypes` lists token types minted under the grant |
| `SwapOffers`, `LearnedTokenTypes` | Offer board and token types learned from sponsored mints |
| `ContractRegistrations` | Contracts registered at runtime |
| `TransactionIdentifiers` | Ledger identifiers of indexed transactions |
| `SyncState`, `ReorgLog`, `InstanceLeases` | Crawler progress, reorg history, process lease |

Enums in `db/types.cds`:

- `BackgroundJobStatus`: `pending`, `running`, `external_execution`, `submitted`, `reconciliation_required`, `succeeded`, `failed`
- `BackgroundJobChainStatus`: `pending`, `success`, `failure`, `dropped`
- `SwapOfferStatus`: `open`, `filled`, `retired`, `expired`

## Project structure

```
src/          startup and shutdown, connector routes, browser and txbuilder exports
srv/          the five OData services
  crawler/    block crawler
  providers/  Substrate RPC client
  midnight/   wallet SDK, worker threads
  submission/ actions, job executors, finalizers, contract registry
  sessions/   wallet sessions, agent grants
  utils/      config, encryption, errors
docker/       image and compose files
scripts/      dev and serve wrappers, e2e lanes, migrations, key tools
test/         unit and integration suites
```

## Development

Scripts: [operations.md#scripts-at-a-glance](operations.md#scripts-at-a-glance). Before a tag run `npm run check:release`. `check:release:full` adds the PostgreSQL lane.
