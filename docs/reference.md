# Reference

Configuration, runtime behavior and schema. Signatures: [actions.md](actions.md). Design: [architecture.md](architecture.md). Operations: [operations.md](operations.md).

## Configuration

The plugin reads `cds.requires.nightgate`. Environment variables override it. Without `network` the plugin serves OData but stays idle: no crawler, no submission.

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

Node and indexer are built in for preview, testnet and undeployed. Every other network refuses to start without `nodeUrl` and `indexerHttpUrl`, see [self-hosted.md](self-hosted.md). Proving runs in wasm unless a proof server is configured.

### CDS keys

| Key | Default | Notes |
|---|---|---|
| `network` | `mainnet` | `preview`, `testnet`, `preprod`, `mainnet`, `stagenet` or `undeployed`. An invalid value refuses to start |
| `nodeUrl` | built in on preview, testnet, undeployed | Substrate RPC WebSocket. Required on every other network |
| `indexerHttpUrl` | built in on preview, testnet, undeployed | Indexer GraphQL for the wallet SDK and the verify functions. Required on every other network |
| `indexerWsUrl` | derived from `indexerHttpUrl` | Subscription endpoint, only for a non-standard indexer |
| `proofServerUrl` | `http://localhost:6300` in server mode | Setting it selects server proving. Unset means wasm |
| `proofTimeoutMs` | `300000` | One proof request in server mode. midnight-js retries up to three times |
| `zkConfigBasePath` | `./contracts` | Base for relative `zkConfigPath` values |
| `privateStateBackend` | `cap-db` | `cap-db` stores encrypted rows in the database. `level` is the SDK LevelDB store, dev only |
| `contracts` | `{}` | `<ref>` to `{ package }` or `{ artifactPath, privateStateId, zkConfigPath }`. Optional `slotWidth` 16 or 32 for a vault artifact, `address` for `/contract-manifest` |
| `sessionTtlMs` | `86400000` | Wallet session lifetime |
| `closeSessionsOnRestart` | `true` | Close the previous process's wallet sessions at startup. Fee-sponsor sessions are exempt |
| `feeSponsorSessions` | none | Platform fee-sponsor session ids. `NIGHTGATE_FEE_SPONSOR_SESSION` overrides it |
| `jobs.concurrency.heavy` | `4` | Concurrent proof-generating jobs. Workflow parents have a separate cap of the same size |
| `jobs.concurrency.light` | `16` | Concurrent jobs per other kind |
| `jobs.concurrency.serial` | `1` | Concurrent `connectWalletForSigning` jobs |
| `runtimeMode` | `single-instance` | Other modes fail closed |
| `replicaCount` | `1` | Values above 1 fail closed |
| `allowProductionSqlite` | `false` | Permits SQLite in production |
| `allowMainnetSubmission` | `false` | Gate for mainnet submission |
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

Declared in `srv/utils/config-table.ts`. The table is generated with `npm run config:table` and pinned by a unit test. Empty means unset. An unparsable value is logged once and the default applies. Numbers out of bounds are clamped with a warning. Booleans accept `true`, `false`, `1`, `0`, `yes`, `no`, `on`, `off`. Every variable except the secrets can also be set as `cds.requires.nightgate.<camelCase>`, for example `workerRpcTimeoutMs`. Environment wins over CDS, CDS wins over the default.

<!-- config-table:start -->
| Variable | Kind | Default | Purpose |
|---|---|---|---|
| `NIGHTGATE_NETWORK` | `preview` / `testnet` / `preprod` / `mainnet` / `stagenet` / `undeployed` |  | Override `network` |
| `NIGHTGATE_NODE_URL` | url |  | Override `nodeUrl` |
| `NIGHTGATE_CRAWLER_NODE_URL` | url |  | Override `crawler.nodeUrl` |
| `NIGHTGATE_INDEXER_HTTP_URL` | url |  | Override `indexerHttpUrl` (e.g. point at local indexer container) |
| `NIGHTGATE_INDEXER_WS_URL` | url |  | Override `indexerWsUrl`; optional, derived from the HTTP URL when unset |
| `NIGHTGATE_PROOF_SERVER_URL` | url |  | Override `proofServerUrl` |
| `NIGHTGATE_PROVING_MODE` | `server` / `wasm` |  | Proving mode `wasm` (in-process) or `server` (proof server). Unset: `server` when a proof server is configured, `wasm` otherwise. `initialize()` pins the effective value into the env for the worker. Read in the wallet worker. |
| `NIGHTGATE_PROOF_TIMEOUT_MS` | ms (min 1) | `300000` | Override `proofTimeoutMs`; pinned into the env at plugin init for the wallet worker. The proof-server container has its own job TTL (`MIDNIGHT_PROOF_SERVER_JOB_TIMEOUT`, default 600 s): raise both, or a finished-but-expired job answers 5xx and midnight-js re-proves. Read in the wallet worker. |
| `NIGHTGATE_ZK_CONFIG_BASE` | path | `./contracts` | Override `zkConfigBasePath` |
| `NIGHTGATE_ZK_CONFIG_PUBLIC_URL` | url |  | Public base URL advertised by `/contract-manifest` for the `/zk-config/...` routes (behind a reverse proxy); unset = relative URLs, resolved by the client against the origin it fetched the manifest from |
| `NIGHTGATE_ZK_ASSET_URL` | string |  | A `/zk-config` base the server fetches missing prover keys from (`<url>/<contract>/keys/<circuit>.prover`, verified against `keys/manifest.json`); `none`/`off` disables the fetch. Unset: the release assets named by the installed lineage package (`contract.json#zkAssetUrl`), no source for a foreign artifact. Offline installs run `nightgate-fetch-keys` once. |
| `NIGHTGATE_CONTRACTS_DIR` | string |  | Root directories (path-delimiter separated) a runtime `registerContract` (admin) may point into; default: the working directory's `contracts/`. Importing an artifact executes its module, so paths outside are refused. The supported way to keep a consumer's artifacts outside the package: point it at that directory. The artifact's `@midnight-ntwrk/compact-runtime` import resolves from NIGHTGATE's own node_modules (worker snapshots and the registration probe), so the directory needs no node_modules of its own. |
| `NIGHTGATE_PRIVATE_STATE_BACKEND` | `cap-db` / `level` |  | Override `privateStateBackend` |
| `NIGHTGATE_GRANTEE_BINDING` | `wallet` / `did` / `custom` |  | Override `granteeBinding` (`wallet` / `did` / `custom`) |
| `NIGHTGATE_ALLOW_SELF_SERVICE_GRANTEE_REGISTRATION` | bool |  | Override `allowSelfServiceGranteeRegistration` (`false` / `0` / `no` / `off` disables) |
| `NIGHTGATE_CLOSE_SESSIONS_ON_RESTART` | bool |  | Override `closeSessionsOnRestart` (default on): `false` keeps the previous process's wallet sessions open across a restart |
| `NIGHTGATE_INSTANCE_ID` | string |  | Stable operator-provided instance identifier; otherwise CF instance GUID, hostname, or a generated UUID |
| `NIGHTGATE_REPLICA_COUNT` | int (min 1) |  | Actual process/replica count. Must be `1`; takes precedence over CDS `replicaCount` |
| `NIGHTGATE_ACCEPT_UNBOUND_ENVELOPES` | bool | `false` | `true` still reads v1/v2 ciphertexts in columns bound to a purpose and a row (v3); only until `nightgate-rewrap-keys` rewrote them |
| `NIGHTGATE_ALLOW_UNAUTHENTICATED` | bool | `false` | `true` permits `auth.kind: dummy` in production (every request unauthenticated and privileged); local testing only |
| `NIGHTGATE_ALLOW_PRODUCTION_SQLITE` | bool | `false` | `true` temporarily permits production SQLite with a high-severity warning; intended only for a migration window |
| `NIGHTGATE_ASSUME_DB_NETWORK` | string |  | Confirms which network an index without a recorded network id belongs to; the boot guard refuses to bind such an index to the configured network otherwise. |
| `NIGHTGATE_DEBUG_WALLET_SYNC` | bool | `false` | `true` logs wallet sync-state persistence at debug level |
| `NIGHTGATE_CRAWLER_ENABLED` | bool |  | `false` / `0` / `no` / `off` disables the crawler at boot |
| `NIGHTGATE_FETCH_CONCURRENCY` | int (min 1) |  | Override `crawler.fetchConcurrency` |
| `NIGHTGATE_RPC_BATCH_SIZE` | int (min 1) |  | Override `crawler.rpcBatchSize` |
| `NIGHTGATE_CRAWLER_START_HEIGHT` | int (min 1) |  | Override `crawler.startHeight`: first height to index while the index is EMPTY (the block below it is indexed as the parentless anchor). Ignored once the index holds blocks, so a restart resumes at the cursor. |
| `NIGHTGATE_CRAWLER_MAX_BPS` | int (min 1) |  | Override `crawler.maxBlocksPerSecond`: catch-up rate cap, so block ingestion can share a host with the submission side. Unset = unlimited. |
| `NIGHTGATE_CRAWLER_FAULT_GUARD` | bool |  | `false` lets a node transport fault shut the server down again, as CAP does by default. On by default: the crawler retries such a fault on its own, and taking the process down costs every sponsor facade its warm-up. Absorbed faults are counted in `getMetrics()`. |
| `NIGHTGATE_CRAWLER_DECODE_PAYLOADS` | bool |  | Override `crawler.decodePayloads`: decode stored ledger payloads in a pass behind the indexed tip (circuit names, transaction identifiers, zswap and DUST counts). Off by default; the decode runs in wasm on the main thread. |
| `NIGHTGATE_CRAWLER_INDEXER_SUPPLEMENT` | bool |  | Override `crawler.indexerSupplement`: fill what a block does not carry (segments, contract state and balances, ledger-event streams, the DUST registration flag) from the Midnight indexer, in a pass behind the indexed tip. Off by default; it makes the index depend on a second source. |
| `NIGHTGATE_CRAWLER_INDEXER_URL` | url |  | Override `crawler.indexerUrl`: the GraphQL endpoint the supplement pass reads. Default: the submission side's indexer (`NIGHTGATE_INDEXER_HTTP_URL`). A private indexer here keeps the pass off the public one, whose edge blocks the whole host IP under load, sponsor facades included. |
| `NIGHTGATE_CRAWLER_CONTRACT_STATE_HISTORY` | `none` / `watched` / `all` |  | Override `crawler.contractStateHistory` (default `none`): which contract actions keep their full state from the supplement. Every action keeps a sha256 and the size, the newest state per contract is in `ContractStates`; `watched` keeps the full state of the contracts in `NIGHTGATE_CRAWLER_CONTRACT_STATE_WATCH`, `all` of every action (hundreds of KB each). Older states come from the indexer through `ContractStates/stateAt`. |
| `NIGHTGATE_CRAWLER_CONTRACT_STATE_WATCH` | list |  | Override `crawler.contractStateWatch`: comma-separated contract addresses (hex) whose full state per action is kept under `contractStateHistory: watched`. |
| `NIGHTGATE_CRAWLER_SUPPLEMENT_MAX_BPS` | int (min 1) |  | Override `crawler.supplementBlocksPerSecond` (default 2): indexer requests per second of the supplement pass, one per block, paced per request. A hosted indexer may block the whole host IP (403 from their load balancer, also for the sponsor facades) at roughly 15 per second; on a 403 or 429 the pass backs off for one minute, doubling up to fifteen. |
| `NIGHTGATE_INSTANCE_LEASE_TTL_MS` | ms (min 15000) | `90000` | The process running job loops, restart recovery and crawler holds a database lease renewed every third of this; a second process on the same database waits this long for an expired lease, then refuses to start. Default 90 s. |
| `NIGHTGATE_JOB_LEASE_TTL_MS` | ms (min 60000) | `300000` | A `running` job whose heartbeat is older than this is reclaimed (re-dispatched with `attempt + 1`) unless it crossed the external-effect boundary; default 5 minutes, at least 60 s (twice the 30 s heartbeat). |
| `NIGHTGATE_CHILD_JOB_WAIT_TIMEOUT_MS` | ms (min 1) |  | Parent-workflow watchdog; defaults to the worker RPC timeout plus 5 minutes. Timeout is fail-closed while the child may continue. |
| `NIGHTGATE_WORKER_RPC_TIMEOUT_MS` | ms (min 1) | `1800000` | Backstop timeout of one wallet-worker RPC (a proof or a submit); default 30 minutes. |
| `NIGHTGATE_WORKER_DRAIN_MAX_MS` | ms (min 1) | `600000` | Upper bound of a worker rotation drain (in-flight submits complete first); default 10 minutes, then the worker is terminated and the cut calls fail `WORKER_ROTATED`. |
| `NIGHTGATE_WORKER_YOUNG_GEN_MB` | int (min 0, max 2048) | `128` | Young-generation size of the wallet worker thread (`resourceLimits.maxYoungGenerationSizeMb`); default 128, `0` = V8 default, clamped to 16..2048. |
| `NIGHTGATE_WALLET_WORKERS` | int (min 1, max 8) | `1` | Worker threads for user wallets; a wallet always lives in the same one (by its facade key). Each worker carries its own SDK, WASM and heap, so plan memory per worker. Default `1`. |
| `NIGHTGATE_SPONSOR_WORKERS` | `shared` / `dedicated` | `shared` | `dedicated` gives every pool sponsor a worker thread of its own, so sponsored jobs and sponsor restores run side by side; `shared` (default) keeps them in the user workers. Bound sponsoring (a call that names a sponsor session) needs the caller's and the sponsor's wallet in one worker and answers 412 otherwise. |
| `NIGHTGATE_WORKER_MAX_GENERATIONS` | int (min 0) | `32` | Distinct artifact generations a worker loads before it rotates (drain + fresh thread); default 32. Read in the wallet worker. |
| `NIGHTGATE_WORKER_GENERATION_CACHE` | int (min 1) | `8` | Scaffold and provider cache size per worker (bounded cache of artifact generations); default 8. Read in the wallet worker. |
| `NIGHTGATE_ARTIFACT_SNAPSHOT_DIR` | path |  | Base directory of the immutable content-addressed artifact snapshots the worker proves from; default `<tmpdir>/nightgate-artifact-snapshots`, layout `<base>/<install>/<digest>`. Read in the wallet worker. |
| `NIGHTGATE_ARTIFACT_SNAPSHOT_TTL_DAYS` | int (min 0) | `14` | Snapshots no live process holds are swept after this many days; default 14. Read in the wallet worker. |
| `NIGHTGATE_ARTIFACT_DIGEST_MAX_AGE_MS` | ms (min 0) | `300000` | How long the memoised current artifact digest (`getRuntimeInfo`, job resolves) may be trusted before the files are re-hashed regardless of their stat fingerprint. |
| `NIGHTGATE_DUST_RACE_RETRIES` | int (min 0) | `2` | Rebuild-retries of a bound deploy/call/batch on a transient dust race (`1010/170`, `1010/171`, `1010/196`, pre-mempool, fee unspent); default `2`. Each retry re-proves the call, hence smaller than the sponsor path's `NIGHTGATE_SPONSOR_DUST_RETRIES`. `0` disables. |
| `NIGHTGATE_DUST_RACE_BACKOFF_MS` | ms (min 0) | `5000` | Pause before such a rebuild, letting the dust wallet apply the spend it lost against; default `5000`. |
| `NIGHTGATE_STALE_TRANSCRIPT_RETRIES` | int (min 0) | `2` | Rebuild-retries of a bound deploy/call/batch the node refused against the current contract state (`1010/104`, pre-mempool, fee unspent; typically the gas budget after another transaction on the same contract grew a map); default `2`. Each retry re-runs and re-proves the call against current state. |
| `NIGHTGATE_STALE_TRANSCRIPT_BACKOFF_MS` | ms (min 0) | `15000` | Pause before such a rebuild, so the indexer serves the state that includes the competing transaction; default `15000`. |
| `NIGHTGATE_PREWARM_SYNC_TIMEOUT_MS` | ms (min 1) | `43200000` | Absolute ceiling for the `connectWalletForSigning` prewarm sync-to-tip wait; default `43200000` (12 h). A backstop: the primary bound is `NIGHTGATE_PREWARM_STALL_MS`. |
| `NIGHTGATE_PREWARM_STALL_MS` | ms (min 0) | `600000` | Prewarm fails when `appliedIndex` has not advanced for this long, regardless of elapsed time; default `600000` (10 min). A slow-but-moving sync is not stalled. `0` disables the stall bound (ceiling only). Read in the wallet worker. |
| `NIGHTGATE_SYNC_PROGRESS_STALE_S` | int (min 1) | `60` | `getWalletSyncProgress` reports `stale: true` once its snapshot is older than this; default `60` (four worker push intervals). |
| `NIGHTGATE_WALLET_READ_SYNC_TIMEOUT_MS` | ms (min 0) | `10000` | Bounded sync gate for facade-backed read actions (`getWalletBalance`, fee estimates): a catching-up facade answers 503 `WALLET_SYNCING` after this instead of parking the request; default `10000`, `0` waits indefinitely. |
| `NIGHTGATE_BALANCE_SYNC_TIMEOUT_MS` | ms (min 1) | `180000` | Worker-side wait for a genuine wallet sync before balancing a transaction; default `180000`. Read in the wallet worker. |
| `NIGHTGATE_SYNC_TIP_GAP` | int (min 0) | `8` | Blocks behind the indexer tip a wallet may be and still count as synced; default `8`. Read in the wallet worker. |
| `NIGHTGATE_SYNC_FRESHNESS_MS` | ms (min 1) | `300000` | How old the indexer's latest block may be for a wallet to count as synced (guards against a lagging self-hosted indexer, error 117); default `300000`. Read in the wallet worker. |
| `NIGHTGATE_STREAM_TIP_GRACE_MS` | ms (min 0) | `180000` | A failed read of the ledger-event stream tip (one-shot indexer subscription, 10 s) reuses the last successful read within this window; an unknown tip fails the sync gate for that tick. Default `180000` (three progress-watch ticks), `0` = off. Read in the wallet worker. |
| `NIGHTGATE_INDEXER_TIP_GRACE_MS` | ms (min 0) | `180000` | A failed read of the indexer's newest block (HTTP query, then the `blocks` subscription, 15 s + 10 s) reuses the last successful read within this window; its block timestamp still ages against `NIGHTGATE_SYNC_FRESHNESS_MS`, and an unknown tip fails the sync gate for that tick. Default `180000` (three progress-watch ticks), `0` = off. Read in the wallet worker. |
| `NIGHTGATE_PROGRESS_WATCH_MS` | ms (min 15000) | `60000` | Interval of the worker's progress watch: pushes each facade's sync-gate verdict to `getWalletSyncProgress` and `getSponsorPoolStatus` and checks restored sub-wallets for a rejected replay; default `60000`, floor 15 s. Read in the wallet worker. |
| `NIGHTGATE_SNAPSHOT_REPLAY_RESET_MS` | ms (min 0) | `300000` | A sub-wallet restored from a snapshot that stays at its restored offset while the ledger rejects its replayed events (dust: event older than the synced time or commitment below the tree index; shielded: commitment below the tree index) is replaced by a fresh one syncing from genesis once both have lasted this long; default `300000`, `0` disables the replacement. Read in the wallet worker. |
| `NIGHTGATE_DISCLOSURE_REINDEX_RETRY_MS` | ms (min 0) | `1800000` | When the disclosure reindex after a landed grant, revoke or retract fails, a `reindexDisclosures` job retries it with backoff for this long before failing `DISCLOSURE_REINDEX_FAILED`; default `1800000` (30 min), `0` = one attempt. |
| `NIGHTGATE_SYNC_STATE_LOG_MS` | ms (min 0) | `600000` | Interval of the per-facade INFO line `sync-state` (dust `appliedIndex` and `syncTime`, shielded `appliedIndex` and `firstFree`) written from the state save tick; default `600000`, `0` disables it. Read in the wallet worker. |
| `NIGHTGATE_STATE_AT_INDEXER_RATE` | int (min 1) | `2` | Indexer reads per second for `ContractStates/stateAt`, across all callers of this server, when the database lacks the state; default `2`. Equal requests share one read. Keep it low against a hosted indexer, which may block the host IP when it gets too many requests; raise it for an own indexer. |
| `NIGHTGATE_DECODE_WORKER_RPC_TIMEOUT_MS` | ms (min 1000) | `60000` | Timeout of one call into the decode worker, which reads contract state from the indexer and decodes it; default `60000`. |
| `NIGHTGATE_READINESS_DB_TIMEOUT_MS` | ms (min 100) | `2000` | How long `getReadiness()` waits for its database read before reporting `database: false`; default `2000`. The probe answers in bounded time even when the pool is exhausted. |
| `NIGHTGATE_EVENT_LOOP_LAG_WARN_MS` | ms (min 0) | `500` | Event-loop delay (p99 over the last 30 s) above which the main thread logs its lag and the database pool wait depth; default `500`, `0` = never log. The gauges in `getMetrics()` are always present. |
| `NIGHTGATE_SAVE_INTERVAL_MS` | ms (min 10000) | `60000` | Wallet-state save tick of the worker; default `60000`, floor 10 s. Read in the wallet worker. |
| `NIGHTGATE_DUST_SNAPSHOT_COLLAPSE` | bool | `false` | `true` saves the dust snapshot with foreign generation leaves collapsed (restore in seconds instead of minutes); falls back to the full snapshot when the collapsed one does not restore to the same roots, balance and UTXOs. The restore check runs in a helper thread of the wallet worker. Default `false`. Read in the wallet worker. |
| `NIGHTGATE_DUST_COLLAPSE_BUDGET_MS` | ms (min 1000) | `120000` | How long the restore check of one collapsed dust snapshot may run in the helper thread, counted from its start; past it the save tick writes the full snapshot once and the helper is restarted, checks waiting behind it are not charged. Default `120000`. Read in the wallet worker. |
| `NIGHTGATE_RESTORE_SAVE_ACK_TIMEOUT_MS` | ms (min 1) | `30000` | How long a facade restore waits for the acknowledgement of its immediate re-save; default `30000`. Read in the wallet worker. |
| `NIGHTGATE_DUST_COLD_START` | bool | `false` | `true` starts the dust sub-wallet from the secret key instead of the persisted state (diagnostic). Read in the wallet worker. |
| `NIGHTGATE_DUST_REGISTER_SETTLE_MS` | ms (min 0) | `90000` | How long `registerForDustGeneration` waits for the registration to apply locally before it reports `settled: false`; default `90000`. Read in the wallet worker. |
| `NIGHTGATE_PROVE_RATE_LIMIT` | int (min 1) | `60` | Rate class `prove`, calls per hour per session: contract calls and batches, token operations, the issue* attestations, `anchorDocument`, `registerDocument`, `retract`, the disclosure actions, `buildSponsorable`; a batch counts its claims. Default `60`. Every `NIGHTGATE_*_RATE_LIMIT` is replaced by `rateLimits` in `NIGHTGATE_SPONSOR_POLICY_FILE` while that names the class. |
| `NIGHTGATE_DEPLOY_RATE_LIMIT` | int (min 1) | `5` | Rate class `deploy`, `deployContract` calls per hour per session; default `5`. |
| `NIGHTGATE_SPONSOR_RATE_LIMIT` | int (min 1) | `120` | Rate class `sponsor`, calls per hour per principal that the pool or a pinned sponsor pays for: `sponsorFinalizedTransaction`, `sponsorUnboundTransaction`, `sponsorSwap`, `mintFactoryToken`; default `120`. |
| `NIGHTGATE_COMPUTE_RATE_LIMIT` | int (min 1) | `120` | Rate class `compute`, calls per hour per principal that compute or write without a transaction: `prepareDocumentProof`, `prepareMembershipSet`, `claimDisclosure`, `postSwapOffer`, `retireSwapOffer`, `reindexDisclosures` (per contract); default `120`. |
| `NIGHTGATE_READ_RATE_LIMIT` | int (min 1) | `60` | Rate class `read`, calls per minute per principal: `listSwapOffers`, `getSwapOffer`, `getBoardStatus`, `getRuntimeInfo`, `getWalletBalance`, `getWalletSyncProgress`, `getSponsorPoolStatus`, `estimateSendNightFee`; default `60`. |
| `NIGHTGATE_WALLET_RATE_LIMIT` | int (min 1) | `10` | Rate class `wallet`, calls per minute per principal: `connectWallet`, `sendNight`, `registerForDustGeneration`, `deregisterFromDustGeneration`; default `10`. |
| `NIGHTGATE_SIGNING_KEY_RATE_LIMIT` | int (min 1) | `10` | Rate class `signing`, `connectWalletForSigning` and `deriveWalletInfo` attempts per hour per principal; default `10`. |
| `NIGHTGATE_ADMIN_RATE_LIMIT` | int (min 1) | `10` | Rate class `admin`, grant administration calls (`createAgentGrant`, `createAgentGrants`, `updateAgentGrant`, `rotateAgentGrantToken`, `revokeAgentGrant`) per hour per principal; default `10`. |
| `NIGHTGATE_GRANT_DEFAULT_JOBS_PER_HOUR` | int (min 1) |  | `maxJobsPerHour` of a grant whose creation does not name it. Unset = no hourly budget. |
| `NIGHTGATE_GRANT_DEFAULT_JOBS_PER_DAY` | int (min 1) |  | `maxJobsPerDay` of a grant whose creation does not name it. Unset = no daily budget. |
| `NIGHTGATE_PUBLIC_VERIFY` | bool | `false` | Serve `verifyAttestationState` and `verifyPredicateState` without credentials under `/odata/v4/midnight-verify` (the image admits the path unauthenticated and answers CORS preflight with `*`); default off, the functions answer `404 PUBLIC_VERIFY_DISABLED`. |
| `NIGHTGATE_PUBLIC_VERIFY_RATE_LIMIT` | int (min 1) | `60` | Rate class `public-verify`, public verify calls per minute per client address; default `60`. |
| `NIGHTGATE_CLAIM_LIFETIME_S` | int (min 60) | `31536000` | Default claim lifetime in seconds for the issue* actions when the caller passes no `validUntil`; default one year, the vault caps a claim at five years ahead. |
| `NIGHTGATE_FEE_SPONSOR_SESSION` | list |  | Comma list of platform fee-sponsor session ids (the pool); overrides `feeSponsorSessions`. |
| `NIGHTGATE_SUBMIT_TRANSPORT_RETRIES` | int (min 0) | `2` | Resends of the SAME finalized transaction when nothing reached the node (connect phase failed) or the send itself died (websocket closed mid-send, `ECONNRESET`; the indexer is probed for the identifier first, and a resend the node refuses is looked up there too); never a node reject, never a reply-less wait. Default `2`, `0` disables. No rebuild, no re-proving. Applies to every submit: deploy/call/batch, sends, dust registration, bound and unbound sponsoring. Read in the wallet worker. |
| `NIGHTGATE_SUBMIT_TRANSPORT_BACKOFF_MS` | ms (min 0) | `5000` | Pause before such a resend; default `5000`. Read in the wallet worker. |
| `NIGHTGATE_SUBMIT_LANDED_PROBE_MS` | ms (min 0) | `30000` | How long the worker polls the indexer for the transaction identifier before a resend, and after a resend was rejected (a reply lost on the first send may still have reached the node); default `30000`. A landed transaction is reported as submitted only with ledger result `SUCCESS`; in a block but not applied fails as `TxFailedError` with the block height (fee spent). Read in the wallet worker. |
| `NIGHTGATE_SUBMIT_INTENT_ACK_TIMEOUT_MS` | ms (min 1000) | `120000` | How long the worker waits for the main thread to record an announced transaction identifier before it gives up without broadcasting; default 2 minutes. The main thread waits at most as long for such a record before it answers the caller. Keep it above the database pool acquire timeout plus the lock-contention retries. Read in the wallet worker. |
| `NIGHTGATE_SUBMIT_CONNECT_TIMEOUT_MS` | ms (min 1) | `20000` | Connect phase of a dedicated-client submit: client creation plus socket; default `20000`. A timeout here sent nothing (`transport/not-sent`, retried once on a fresh client, then a clean pre-inclusion failure). Read in the wallet worker. |
| `NIGHTGATE_SUBMIT_REQUEST_TIMEOUT_MS` | ms (min 1) | `30000` | Request phase of a dedicated-client submit: from the send until the node's first status (subscription acknowledged); default `30000`. A timeout here is ambiguous (`no-reply`): the transaction may or may not be in the pool, the job parks for the confirmer. Read in the wallet worker. |
| `NIGHTGATE_SUBMIT_LATE_GRACE_MS` | ms (min 0) | `300000` | After a request or watch phase timeout the attempt keeps its node subscription open this long and logs a late status or reject under the transaction identifier (evidence only; the job is parked for the confirmer either way); default `300000`. Read in the wallet worker. |
| `NIGHTGATE_SUBMIT_WATCH_TIMEOUT_MS` | ms (min 1) | `75000` | Watch phase of a submit: from the node's first status until InBlock (or Finalized, `NIGHTGATE_SPONSOR_WAIT`); default `75000`. A timeout here is ambiguous: the node took the request and nothing was included in time; the indexer is asked for 90 s, then the job parks for the confirmer. On the facade (bound) path this is the whole wait after the send. Read in the wallet worker. |
| `NIGHTGATE_REINDEX_REPLY_WAIT_MS` | ms (min 0) | `20000` | How long `reindexFromHeight` waits for its rollback before it answers `status: running` and lets it finish in the background; default `20000`. The rollback removes 2000 blocks per committed transaction, from the tip down. |
| `NIGHTGATE_BROADCAST_EXPIRY_MARGIN_MS` | ms (min 0) | `300000` | A job whose transaction the indexer does not know gets `chainStatus: dropped` and `BROADCAST_NOT_INCLUDED` once the indexer tip is this far past the transaction's validity window (ttl); default `300000`. A parked job also ends `failed`, a `succeeded` job keeps its status. The ttl is recorded at the submit intent; rows without one use the submit time plus one hour. |
| `NIGHTGATE_CHAIN_CONFIRM_LOOKUPS_PER_MINUTE` | int (min 1) | `120` | Indexer lookups per minute of the chain-outcome confirmer, over all jobs; default `120`. One lookup asks the indexer up to twice. |
| `NIGHTGATE_CHAIN_CONFIRM_BACKOFF_MAX_MS` | ms (min 1000) | `1800000` | Longest pause before the confirmer asks again about a job whose transaction has no outcome yet. The pause starts at 5 s and doubles per lookup; default 30 minutes. |
| `NIGHTGATE_BATCH_SEGMENT_MODE` | `rewrite` / `observe` | `rewrite` | Batch segment ordering: `rewrite` (deterministic stage-grouped order) or `observe` (log only). Read in the wallet worker. |
| `NIGHTGATE_SPONSOR_POLICY_FILE` | path |  | Path to a JSON file `{ "allowedContracts": [], "allowedCircuits": [], "allowDeploy": false, "allowedTokenTypes": [], "allowContractMints": false, "allowSwaps": false, "shareMintedTokenTypes": false, "contractCircuits": { "<address>": "*" }, "rateLimits": { "prove": 60 } }` that replaces `NIGHTGATE_SPONSOR_ALLOWED_CONTRACTS`/`_CIRCUITS` while set; `rateLimits` names rate classes and replaces their `NIGHTGATE_*_RATE_LIMIT` keys. `contractCircuits` maps a contract address (64 hex) to `"*"` or a circuit list that replaces `allowedCircuits` for calls on that contract; the contract counts as allowed. Calls on a grant's `deployedContracts` are exempt from `allowedCircuits`. Re-read per sponsored call behind an mtime cache, so the sponsor policy changes without a container recreate. Fail-closed: an unreadable or invalid file keeps the last good policy, and with none loaded yet sponsored calls answer `503 SPONSOR_POLICY_UNAVAILABLE`. |
| `NIGHTGATE_SPONSOR_ALLOWED_CONTRACTS` | list |  | Comma list of contract addresses a sponsor pays for (platform floor); empty = any contract may be called. The same list names the contracts an unshielded offer may pay into besides the called one, and there an empty list names none. Replaced by `NIGHTGATE_SPONSOR_POLICY_FILE` while that is set. |
| `NIGHTGATE_SPONSOR_ALLOWED_CIRCUITS` | list |  | Comma list of circuit names a sponsor pays for (platform floor); empty = any. Replaced by `NIGHTGATE_SPONSOR_POLICY_FILE` while that is set. |
| `NIGHTGATE_SPONSOR_ALLOWED_TOKEN_TYPES` | list |  | Comma list of raw shielded token types (64 hex, what `deriveTokenType` returns) whose zswap offers the sponsor also pays for: a contract minting its own token to the caller, a caller spending that token into the contract. Unset = no offer at all (the default). Also `allowedTokenTypes` in the policy file and on a grant (effective = floor ∩ grant; the floor must open it, a grant only narrows). The shape check then requires every net change of the offer (`deltas`, public per type) to be on a listed type, never NIGHT, every contract-owned coin to belong to a sponsorable contract, and a net change to exist OR a coin in the offer to be owned by a sponsorable contract (a burn nets to zero by construction: user input, contract transient, burn-address output; a zero-net offer without a contract coin is refused). User outputs are commitments, so a transfer of a listed type between users riding along is accepted by design: the sponsor pays dust, no sponsor value moves. An invalid entry fails closed (`503 SPONSOR_POLICY_UNAVAILABLE`). |
| `NIGHTGATE_SPONSOR_ALLOW_CONTRACT_MINTS` | bool | `false` | Also sponsors the zswap offer of a token that a contract call in the SAME transaction mints: `true`/`1`/`yes`. Off by default. The call declares its mints (`effects.shieldedMints`, domain separator and amount, bound by the proof); the type derived from domain separator and contract address has to be the offer's type, the contract sponsorable (allow-listed or deployed under the grant), the offer's net change negative and not larger than the declared amount. Such a type needs no entry in `allowedTokenTypes`, on the platform or on a grant. A transaction that moves the token without minting it (a payment into a contract, a swap) needs the entry, unless the token was minted under the caller's grant before: those types are recorded on the grant and count as listed while this switch is on. Also `allowContractMints` in the policy file. |
| `NIGHTGATE_SPONSOR_SHARE_MINTED_TOKEN_TYPES` | bool | `false` | Token types that landed sponsored mints created (table `LearnedTokenTypes`) count as listed for every grant, not only the minting one: `true`/`1`/`yes`. Off by default; needs `NIGHTGATE_SPONSOR_ALLOW_CONTRACT_MINTS`. A grant may still narrow to a subset with `allowedTokenTypes`. Also `shareMintedTokenTypes` in the policy file. |
| `NIGHTGATE_SPONSOR_ALLOW_SWAPS` | bool | `false` | Opens `sponsorSwap` on this deployment: `true`/`1`/`yes`. Off by default. The sponsor pays the dust of a shielded swap handed over as two proven, unbound halves; a token caller additionally needs `sponsorSwap` in its grant's `allowedActions`. Each half gives one token type and wants another, both in the effective `allowedTokenTypes`, never NIGHT; the halves mirror each other and the merged transaction balances. The terms are readable, the parties are not: a swap against a token amount of 1 is a transfer in effect, so this makes the sponsor a fee-free relay for the listed types, bounded by the rate limit and the grant's daily budget. Also `allowSwaps` in the policy file. |
| `NIGHTGATE_SPONSOR_ALLOW_TRANSFERS` | bool | `false` | Opens `sponsorTransfer` on this deployment: `true`/`1`/`yes`. Off by default. The sponsor pays the dust of a plain shielded transfer the caller built from its own coins; a token caller additionally needs `sponsorTransfer` in its grant's `allowedActions`. The declared token type must be in the effective `allowedTokenTypes`. The transfer carries an offer and nothing else, nets to zero and spends at most `NIGHTGATE_SPONSOR_SWAP_MAX_INPUTS` coins; its recipient and amount are commitments the sponsor cannot read, so the declaration is recorded, not verified. Also `allowTransfers` in the policy file. |
| `NIGHTGATE_SPONSOR_ALLOW_UNSHIELDED_OFFERS` | bool | `false` | Lets a sponsored call move unshielded tokens: the caller's own into the contract it calls, and the payouts the called contract requires: `true`/`1`/`yes`. Off by default. A token caller additionally needs `allowUnshieldedOffers` on its grant. The intent's unshielded offer must sit next to a sponsorable call, balance per token type on the ledger (inputs and contract payouts = outputs + what the called circuit takes in), send every output to a sponsorable contract, back to an input owner, or to a recipient the call's proven result pays (`claimedUnshieldedSpends`), and move only NIGHT or a type in `NIGHTGATE_SPONSOR_ALLOWED_UNSHIELDED_TOKEN_TYPES`; caller dust actions stay refused. The contract decides who is paid; the sponsor adds dust only, never value. Also `allowUnshieldedOffers` in the policy file. |
| `NIGHTGATE_SPONSOR_ALLOWED_UNSHIELDED_TOKEN_TYPES` | list |  | Comma list of raw unshielded token types (64 hex) a sponsored unshielded offer may move besides NIGHT, which is always allowed. Unset = NIGHT only. Also `allowedUnshieldedTokenTypes` in the policy file and on a grant (the grant only narrows). An invalid entry fails closed (`503 SPONSOR_POLICY_UNAVAILABLE`). |
| `NIGHTGATE_TOKEN_FACTORY_CONTRACT` | string |  | Address (64 hex) of the token-factory deployment `mintFactoryToken` and `burnFactoryToken` use when the call names no `contractAddress`. Unset: the call must name the factory. |
| `NIGHTGATE_SPONSOR_SWAP_MAX_INPUTS` | int (min 1) | `4` | Most zswap inputs one half of a sponsored swap, or a sponsored transfer, may carry; default `4`. Either carries at most two outputs (the coin it pays, its change). Every coin adds about 5 kB to the transaction: two halves with 4 inputs and 2 outputs each merge to about 60 kB, with 5 inputs each to about 70 kB, so a higher value also needs a higher `NIGHTGATE_SPONSOR_MAX_TX_BYTES`. Read in the wallet worker. |
| `NIGHTGATE_SPONSOR_ALLOW_DEPLOY` | bool | `false` | Opens sponsored contract DEPLOYS on this deployment: `true`/`1`/`yes`. Off by default. A token caller additionally needs `allowDeploy` on its grant with deploy budget left; a plain caller inherits the floor. Also settable as `allowDeploy` in `NIGHTGATE_SPONSOR_POLICY_FILE`. |
| `NIGHTGATE_SPONSOR_MAX_TX_BYTES` | int (min 1) | `65536` | Byte ceiling of a sponsored call transaction the worker accepts; default `65536`. Read in the wallet worker. |
| `NIGHTGATE_SPONSOR_MAX_DEPLOY_BYTES` | int (min 1) | `40960` | Byte ceiling of a sponsored DEPLOY transaction (a deploy writes verifier keys on chain and costs a multiple of a call); default `40960`. Read in the wallet worker. |
| `NIGHTGATE_SPONSOR_WAIT` | `inblock` / `finalized` | `inblock` | Submission stage every submit waits for on its dedicated node client: `inblock` (default) or `finalized`. The indexer confirmer records the final inclusion on the job either way. Read in the wallet worker. |
| `NIGHTGATE_SPONSOR_INDEXER_VISIBLE_MS` | ms (min 0) | `30000` | After the awaited status (InBlock or Finalized), bounded wait until the indexer shows the transaction and check its ledger result there (in a block but not applied fails as `TxFailedError`); `0` skips the wait and the check, the indexer confirmer still records the outcome on the job; default `30000`. Read in the wallet worker. |
| `NIGHTGATE_SPONSORED_CALLER_SYNC` | `wait` / `skip` | `wait` | `skip` omits the caller-side wallet sync when balancing a sponsored transaction (vault calls move no caller value). Read in the wallet worker. |
| `NIGHTGATE_NOTE_LEASE_MS` | ms (min 1) | `300000` | Lease on a dust note backing a sponsored transaction (parallel sponsoring from one wallet); a non-positive or non-numeric value falls back to the default `300000`. Read in the wallet worker. |
| `NIGHTGATE_BACKING_WAIT_MS` | ms (min 0) | `300000` | How long an unbound sponsoring waits for a free dust backing before it refuses; default `300000`. Read in the wallet worker. |
| `NIGHTGATE_SPONSOR_MAX_DUST_NOTES` | int (min 1) | `4` | How many dust notes an unbound sponsoring may combine when no single note covers the fee; default `4`. Each comes from its own NIGHT UTXO. `1` pays every fee from one note. Read in the wallet worker. |
| `NIGHTGATE_NOTE_SPENT_WAIT_MS` | ms (min 0) | `30000` | How long a dust backing stays reserved after its sponsored spend went out, until the sponsor wallet no longer lists the spent note; default `30000`. Released earlier, the next spend on that backing would be built on the same note and rejected (`1010/196`). `0` releases at once. Read in the wallet worker. |
| `NIGHTGATE_SPONSOR_PREWARM_SYNC_MS` | ms (min 0) | `1800000` | Prewarm brings pool members to the chain tip one at a time; this caps the wait per sponsor, default 30 min, `0` = build only. |
| `NIGHTGATE_SPONSOR_STATUS_TIMEOUT_MS` | ms (min 1) | `45000` | Per-sponsor read cap of `getSponsorPoolStatus`; default `45000`. |
| `NIGHTGATE_SPONSOR_LEASE_WAIT_MS` | ms (min 0) | `120000` | How long a sponsored job waits for a busy or cooling sponsor before it fails over or gives up; default `120000`. |
| `NIGHTGATE_SPONSOR_COOLDOWN_MS` | ms (min 0) | `120000` | Bench time of a sponsor after a retryable failure; default `120000`. |
| `NIGHTGATE_SPONSOR_DUST_RETRIES` | int (min 0) | `4` | Rebuild-retries of a sponsored transaction on a dust race, on the same sponsor, before the next sponsor takes over; default `4`. |
| `NIGHTGATE_SPONSOR_DUST_BACKOFF_MS` | ms (min 0) | `5000` | Pause before such a rebuild; default `5000`. |
| `ENCRYPTION_KEY` | secret |  | At-rest secret (32+ byte hex) for viewing keys, seed keys and encrypted job commands; key id `1` of the ring. Without any key a random per-process dev key is used (rows do not survive a restart); **required** in production. Env only, no CAP mapping. |
| `ENCRYPTION_KEYS` | secret |  | Key ring `id=secret,id=secret` (ids `[A-Za-z0-9_-]{1,16}`); `ENCRYPTION_KEY` joins it as id `1`. Every secret is HKDF-stretched; new ciphertexts are `v3:<keyId>:...` envelopes (per-row data key wrapped by the ring key; key id, column and row bound as AAD). Older `v2` and legacy `iv:tag:data` values stay readable, the legacy ones under id `1`. Env only, no CAP mapping. |
| `NIGHTGATE_RECEIPT_SIGNING_KEY` | secret |  | Ed25519 seed (64 hex) the instance signs job receipts with (`getJobStatus.receipt`, public key under `getReceiptKey`). Unset: derived from the active encryption key, so it changes with a key rotation. Env only, no CAP mapping. |
| `ENCRYPTION_KEY_ACTIVE` | string |  | Id of the ring key new ciphertexts are written under (required with more than one key). Startup refuses a database whose ciphertexts name a key id outside the ring; `nightgate-rewrap-keys` moves rows to the active key (see docs/operations.md, key rotation). Env only, no CAP mapping. |
<!-- config-table:end -->

Read by the standalone image and the dev scripts, not by the plugin:

| Variable | Purpose |
|---|---|
| `NIGHTGATE_DB_URL` | Image: `postgres://user:pw@host:5432/db` selects PostgreSQL. `?sslmode=` accepts `disable`, `require` or `verify-full` with optional `sslrootcert=<pem>`. Unset means SQLite at `NIGHTGATE_DB_PATH` |
| `NIGHTGATE_DB_DEPLOY` | Image with PostgreSQL: `auto` deploys the schema at boot, `never` skips. Default `auto` |
| `NIGHTGATE_DB_WAIT_SECONDS` | Image `migrate` mode: wait for the PostgreSQL listener, 1 to 86400. Default 60 |
| `NIGHTGATE_HEAP_MB` | Heap of `scripts/dev.mjs` and `scripts/serve.mjs`. Default `12288` |
| `NIGHTGATE_PROOF_NETWORK` | Network of the proof-server container. Default `mainnet` |

For a local checkout, put variables into a repo-root `.env`. Template: [.env.example](../.env.example).

## Runtime behavior

### Plugin lifecycle

- `cds-plugin.js` loads `src/plugin.ts`, which registers the models in `db/` and `srv/`.
- The connector routes `/zk-config` and `/contract-manifest` attach at CAP bootstrap. `GET /zk-config/<contract>` lists the circuits and the files below it: `keys/`, `zkir/` and `compiler/contract-manifest.json`.
- `initialize()` runs on `cds.on('served')`. It checks the schema, loads `contracts`, starts the wallet worker and, if enabled, the crawler.
- `shutdown()` runs on `cds.on('shutdown')`. It stops the crawler and the worker, which saves every cached wallet first.

### Startup and failure

- The schema is never deployed automatically. A missing table or column keeps NIGHTGATE offline with `SCHEMA_NOT_DEPLOYED`. The host process keeps running.
- An unreachable node logs a warning and starts in `offline` mode. Reads and submissions keep working.
- A wallet worker that fails to start logs a warning. Submissions fail, reads work.
- `initialize()` is idempotent and reloads `contracts`.

### Pipelines

The crawler reads the node on the main thread. The wallet SDK reads the indexer in the worker thread. Both write to one database and share no hash. The indexer confirmer records a job's block height, and a reorg rollback reverts outcomes at or above the fork height. Transaction outcomes come from `System.Events` only. A block without them is retried, never stored as success. The crawler decodes blocks below runtime version 2000000 with ledger 8 and later blocks with ledger 9. Details: [architecture.md](architecture.md).

### Error classification

Error codes of `classifySubmissionError(err, network)`: [actions.md#error-model](actions.md#error-model).

### HTTP error codes

Every error response carries `error.code`. It is a specific code where a client can act on it, else the class of its HTTP status. A 5xx keeps its code in production. Its message is withheld unless the code exposes it. Errors CAP raises before a service runs keep CAP's numeric code.

<!-- error-codes:start -->
| Code | HTTP | Retryable | Meaning |
|---|---|---|---|
| `INVALID_ARGUMENT` | 400 | no | A parameter is missing, malformed or out of range. |
| `UNAUTHENTICATED` | 401 | no | No or unknown principal, or a session the caller does not own. |
| `FORBIDDEN` | 403 | no | The principal may not perform this operation. |
| `NOT_FOUND` | 404 | no | The addressed record does not exist or is not visible to the caller. |
| `CONFLICT` | 409 | no | The request conflicts with the current state. |
| `GONE` | 410 | no | The addressed record expired or was closed. |
| `PRECONDITION_FAILED` | 412 | no | A required earlier step is missing (e.g. no signing key on the session). |
| `PAYLOAD_TOO_LARGE` | 413 | no | The request body exceeds a limit. |
| `RATE_LIMITED` | 429 | yes | A rate class or a grant budget is used up; the message names it, `Retry-After` says when to retry. |
| `INTERNAL` | 500 | no | Unexpected server failure; the message is withheld in production. |
| `NOT_IMPLEMENTED` | 501 | no | The operation is not available in this configuration. |
| `BAD_GATEWAY` | 502 | yes | An upstream (node, indexer, proof server) answered wrongly. |
| `UNAVAILABLE` | 503 | yes | Temporarily unavailable; retry later. |
| `ACCOUNT_KEY_UNAVAILABLE` | 503 | yes | The per-account data key could not be read. |
| `AGENT_GRANT_REVOKED` | 403 | no | The agent grant a queued job ran under was revoked; nothing was sponsored. |
| `ARG_COERCION_FAILED` | 400 | no | A circuit argument does not match the circuit's declared type. |
| `BATCH_CAUSALITY_VIOLATION` | 409 | no | A batch orders a fallible call before a guaranteed one; split or reorder it. |
| `CONTRACT_NOT_REGISTERED` | 404 | no | No compiled artifact is registered under this name. |
| `CONTRACT_REGISTRATION_REJECTED` | 400 | no | A runtime contract registration was refused. |
| `ENCRYPTION_KEY_UNKNOWN` | 500 | no | A stored ciphertext names a key id outside the configured ring. |
| `FEE_SPONSOR_UNUSABLE` | 400 | no | The fee-sponsor session cannot pay for this caller or is not ready. |
| `GRANT_REVOKED` | 409 | no | The agent grant is revoked; it cannot be changed any more. |
| `IDEMPOTENCY_KEY_CONFLICT` | 409 | no | The idempotency key was used with a different payload. |
| `IDEMPOTENCY_KEY_INVALID` | 400 | no | The idempotency key is longer than 128 characters. |
| `INSTANCE_LEASE_HELD` | 503 | no | Another process runs the background work on this database. |
| `JOB_ADMISSION_BUSY` | 503 | yes | The job admission lock is contended; retry after `Retry-After`. |
| `PRIVATE_STATE_EXPORT_INVALID` | 400 | no | The private-state export is not in the expected format. |
| `PRIVATE_STATE_EXPORT_UNREADABLE` | 400 | no | The private-state export does not decrypt with this password. |
| `PRIVATE_STATE_IMPORT_CONFLICT` | 409 | no | The private-state import would overwrite existing state. |
| `PROVER_KEYS_UNAVAILABLE` | 503 | yes | The contract's prover keys are not available on this server. |
| `RUNTIME_TOPOLOGY_UNSUPPORTED` | 503 | no | The deployment topology (replicas, multitenancy, database) is not supported. |
| `PUBLIC_VERIFY_DISABLED` | 404 | no | Unauthenticated verification is not enabled on this server. |
| `PURE_CIRCUITS_UNAVAILABLE` | 404 | no | The artifact does not export the pure circuits this operation needs. |
| `TOKEN_FACTORY_UNAVAILABLE` | 404 | no | No token-factory lineage is registered, or the artifact is not one. |
| `RUNTIME_UNAVAILABLE` | 503 | yes | The runtime did not start (schema, network or worker); see getRuntimeInfo. |
| `SCHEMA_NOT_DEPLOYED` | 503 | no | The database schema is missing tables or columns; run the schema delta. |
| `SESSION_NOT_FOUND` | 401 | no | The wallet session does not exist, is inactive or belongs to another user. |
| `SIGNING_KEY_EXPORT_REJECTED` | 400 | no | The signing-key export was refused. |
| `SPONSOR_POLICY_EMPTY` | 403 | no | The effective sponsor policy allows nothing for this caller. |
| `SPONSOR_POLICY_UNAVAILABLE` | 503 | yes | The sponsor policy file cannot be read; fail-closed. |
| `SPONSOR_REFUSED` | 403 | no | The sponsor refused the transaction under its policy. |
| `SWAP_OFFER_INVALID` | 400 | no | The posted text is not a swap half the offer board can carry. |
| `SPONSORED_CALL_NOT_APPLIED` | 409 | no | The sponsored call landed but did not apply (the caller's transcript is stale). |
| `SUBMIT_INTENT_REJECTED` | 409 | no | The server refused to record the broadcast; nothing was sent. |
| `SUBMIT_INTENT_TIMEOUT` | 503 | yes | The broadcast was not acknowledged in time; nothing was sent. |
| `SUBMIT_PHASE_FAILED` | 502 | no | A submission phase (send, watch) failed; `info.phase` names it. |
| `SUBMIT_WATCH_TIMEOUT` | 504 | no | The submission was sent but its inclusion was not seen in time; the outcome is unknown. |
| `SYNC_STATE_NETWORK_MISMATCH` | 503 | no | The database is bound to another network than the configured one. |
| `TOKEN_TYPE_INVALID` | 400 | no | The token type or contract address is malformed. |
| `TX_FAILED` | 409 | no | The transaction landed and failed on chain. |
| `WALLET_MATERIAL_UNAVAILABLE` | 501 | no | This session has no wallet material for signing. |
| `WALLET_NOT_SYNCED` | 503 | yes | The wallet did not reach the chain tip in time; nothing was sent. |
| `WALLET_SIGNING_NOT_AVAILABLE` | 409 | no | The session was connected without a signing key. |
| `WALLET_SYNCING` | 503 | yes | The wallet is still catching up; retry after `Retry-After`. |
| `WORKER_ROTATING` | 503 | yes | The wallet worker is rotating; retry. |
<!-- error-codes:end -->

### Runtime topology

NIGHTGATE runs as exactly one process and one CAP tenant. Startup fails closed when a replica count above one is declared or CAP multitenancy is on. The count comes from `NIGHTGATE_REPLICA_COUNT`, `replicaCount`, `CF_INSTANCE_COUNT` or `KUBERNETES_REPLICA_COUNT`. `WEB_CONCURRENCY` is ignored. On Cloud Foundry every instance with `CF_INSTANCE_INDEX` other than `0` fails closed. The guard is no leader election, so deploy one instance. Production SQLite fails closed too.

### Database

The host chooses the database. SQLite is for development, PostgreSQL or HANA for production.

```json
{
  "cds": { "requires": { "db": {
    "[development]": { "kind": "sqlite", "credentials": { "url": "db/local.db" } },
    "[production]":  { "kind": "postgres", "credentials": { "url": null } }
  } } }
}
```

- Inject credentials through a CAP service binding or `cds_requires_db_credentials_*`.
- The plugin sets `cds.features.use_generic_pool` to `true` unless the host sets it.
- The image uses pool `{ max: 20, acquireTimeoutMillis: 30000, destroyTimeoutMillis: 5000 }` and client `{ connectionTimeoutMillis: 10000 }`.
- Run `cds deploy --profile production` before the first start. Back up before each upgrade.
- SQLite to PostgreSQL: [docker.md#postgresql](docker.md#postgresql).
- Delete `db/midnight.db*` when switching networks.

### Background jobs

`BackgroundJobs` is the durable record of wallet and contract operations. It holds the request fingerprint, attempts, lease, heartbeat, the `PendingSubmissions` id and the transaction hash.

- `(sessionId, kind, idempotencyKey)` is unique. The same key with a different request is rejected. A failed job releases its key, unless it may be on chain or is a workflow step.
- Lifecycle: `pending`, `running`, `external_execution`, `submitted`, then `succeeded` or `failed`. `external_execution` starts right before the SDK call that proves, balances and broadcasts.
- `chainStatus` is `pending`, `success`, `failure` or `dropped`. The indexer confirmer sets it together with `chainBlockHeight`, `chainBlockHash` and `indexerTxHash`.
- After a restart, a job before the external effect fails or re-queues from its persisted command. A job past it parks as `reconciliation_required`.
- A parked job ends when the indexer shows its transaction, when the indexer tip passes its ttl by `NIGHTGATE_BROADCAST_EXPIRY_MARGIN_MS` (`BROADCAST_NOT_INCLUDED`), or when every child of a workflow parent succeeded.
- Alert on a `odatano_nightgate_jobs_reconciliation_required` that does not drain.
- Replayed commands carry no seed material. Circuit arguments, private state and witnesses are stored as AES-256-GCM ciphertext.

### Encrypted rows

`PrivateStates`, `ContractSigningKeys` and `WalletSyncStates` are encrypted under a per-account data key in `AccountKeys`. That key is sealed under the active ring key and under the viewing-key password. Rows with `keyScheme` null use the older derivation and migrate on a session read or through `nightgate-rewrap-keys`, see [operations.md#rotating-the-encryption-key](operations.md#rotating-the-encryption-key). Losing every ring key makes the stored keys unreadable, so back up the secrets.

### HTTP security

NIGHTGATE installs no global HTTP middleware. CORS, CSP and HSTS are host policy. The plugin registers two transport lanes with `@odatano/cap-auth`: the agent token on `/odata/v4/midnight` and public verify on `/odata/v4/midnight-verify`. They act only where the host uses that package as `cds.requires.auth.impl`, as the image does.

## Programmatic API

```ts
import { initialize, shutdown, getStatus, DEFAULT_NETWORK, DEFAULT_NODE_URLS, DEFAULT_INDEXER_URLS } from '@odatano/nightgate';
```

`getStatus()` returns `{ initialized, crawlerEnabled, network?, nodeUrl?, mode, lastError?, instanceId?, runtimeMode?, replicaCount?, databaseKind?, runtimeWarnings? }`. `mode` is `idle`, `active` or `offline`.

## Services and entities

| Service | Path | Surface |
|---|---|---|
| `NightgateService` | `/odata/v4/midnight` | Chain entities, wallet sessions, token and contract actions |
| `NightgateIndexerService` | `/odata/v4/midnight-indexer` | `SyncState`, `ReorgLog`, health, metrics, crawler control |
| `NightgateAnalyticsService` | `/odata/v4/midnight-analytics` | `BlockStatistics`, `ContractStatistics` |
| `NightgateAdminService` | `/odata/v4/midnight-admin` | Sessions, jobs, roles, swap offers, learned token types |
| `NightgateVerifyService` | `/odata/v4/midnight-verify` | `verifyAttestationState`, `verifyPredicateState` without credentials when `NIGHTGATE_PUBLIC_VERIFY=true` |

Signatures and examples: [actions.md](actions.md).

### NightgateService entities

All are read-only.

| Entity | Notes |
|---|---|
| `Blocks` | `author` is the validator's AURA key, null when the header seal does not verify. `slot` is the AURA slot. Older rows are rewritten in the background, tracked by `SyncState.authorBackfillHeight` and `authorsBackfilledAt` |
| `Transactions` | `isShielded`, `hasProof` and the final `txType` need `crawler.decodePayloads`. `byIdentifier(identifier)` finds a transaction by a ledger identifier, 404 while not indexed |
| `TransactionResults`, `TransactionSegments`, `TransactionFees` | Per-transaction outcome, segments and fees |
| `ContractActions` | One row per applied contract action. `entryPoint` needs `crawler.decodePayloads`. `stateHash`, `stateSize` and `state` need `crawler.indexerSupplement` |
| `ContractBalances` | Needs `crawler.indexerSupplement` |
| `ContractStates` | Newest state per contract. `stateAt(address, height)` returns the state after the newest action at or below `height`, with `source`, `verified`, `blockHash`, `ledgerParameters`, `coveredHeight` and `chainHeight` |
| `UnshieldedUtxos`, `NightBalances` | From `Midnight.UnshieldedTokens`. `registeredForDustGeneration` needs `crawler.indexerSupplement` |
| `ZswapLedgerEvents`, `DustLedgerEvents` | Indexer event streams. Need `crawler.indexerSupplement` |
| `Documents`, `PredicateAttestations`, `DisclosureGrants`, `GranteeIdentities` | Attestation and disclosure records |
| `PendingSubmissions` | Scoped to the caller's sessions. Admins see all |
| `WalletSessions` | Without key columns. Scoped to the owning user. Admins see all |
| `AgentGrants` | Agent grants of the caller |

### Stored tables

| Entity | Purpose |
|---|---|
| `PendingSubmissions` | Submission lifecycle `pending`, `included`, `finalized` or `failed`. Written before the SDK call |
| `BackgroundJobs` | Async jobs. Poll `getJobStatus(jobId, sessionId)` |
| `PrivateStates` | Encrypted private state per account, contract and private-state id |
| `ContractSigningKeys` | Encrypted contract signing keys per account and contract |
| `AccountKeys` | Per-account data keys |
| `WalletSyncStates` | Serialized sub-wallet states per account |
| `WalletSessions.encryptedSeedKey` | Set by `connectWalletForSigning`. Null means read-only session |
| `Attestations` | Attestation index: payload hash, attester, public metadata |
| `Documents` | `sha256` and the caller's `storageRef`, never the bytes |
| `DisclosureRoles` | Off-chain roles per user, granted by admin `grantRole` |
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
- `DisclosureRole`: `public_only`, `legitimate_interest`, `authority`
- `SwapOfferStatus`: `open`, `filled`, `retired`, `expired`

## Project structure

```
src/          plugin entry, connector routes, browser and txbuilder exports
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
