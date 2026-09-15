# Reference

Configuration, runtime behavior, schema and development setup. Signatures: [actions.md](actions.md); design: [architecture.md](architecture.md); operations: [operations.md](operations.md).

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

`network` is the only required key; without it the plugin serves OData but stays idle (no crawler, no submission). Defaults: `wss://rpc.preprod.midnight.network/`, the public Midnight indexer, wasm proving. A legacy `"kind": "nightgate"` is ignored.

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
| `network` | `preprod` | `testnet` / `preprod` / `preview` / `mainnet` / `undeployed` (local stack: node `ws://127.0.0.1:9944`, indexer `127.0.0.1:8088`); an invalid value refuses to start |
| `nodeUrl` | `wss://rpc.preprod.midnight.network/` | Substrate RPC WebSocket |
| `indexerHttpUrl` | preprod indexer URL | Wallet SDK indexer endpoint; not used by the crawler |
| `indexerWsUrl` | derived from `indexerHttpUrl` (`http -> ws` + `/ws`) | Subscription endpoint, only for a non-standard indexer |
| `proofServerUrl` | `http://localhost:6300` (server mode only) | Proof server for all submissions; setting it selects server proving, unset = wasm |
| `proofTimeoutMs` | `300000` | Timeout of one proof request in server mode; midnight-js re-requests up to three times, so set it above the slowest proof. Ignored in wasm mode |
| `zkConfigBasePath` | `./contracts` | Base for relative `contracts.<name>.zkConfigPath` |
| `privateStateBackend` | `cap-db` | `cap-db` (encrypted CAP-DB tables) or `level` (SDK LevelDB, dev-only, blocked on worker-routed submissions) |
| `contracts` | `{}` | `<ref>` → `{ artifactPath, privateStateId, zkConfigPath, slotWidth? }`, loaded at startup. `slotWidth` 16 (default) or 32 sizes masks, k bounds and inclusion paths of a vault-family artifact |
| `sessionTtlMs` | `86400000` (24 h) | Wallet session lifetime |
| `closeSessionsOnRestart` | `true` | Close the previous process's wallet sessions at startup (`feeSponsorSessions` exempt); `false` keeps them |
| `jobs.concurrency.heavy` | `4` | Concurrent jobs per proof-generating kind (deploy, call, send, attestations); 4 saturates one proof server |
| `jobs.concurrency.light` | `16` | Concurrent jobs per remaining kind |
| `jobs.concurrency.serial` | `1` | Concurrent `connectWalletForSigning` jobs; catch-up shares one worker thread, so serialized wallets become usable one by one instead of all late |
| `runtimeMode` | `single-instance` | Other modes fail closed |
| `replicaCount` | `1` | Declared replica count; above 1 fails closed |
| `allowProductionSqlite` | `false` | Escape hatch; production SQLite otherwise fails closed |
| `crawler.enabled` | `true` | `false`: services load, no block indexing |
| `crawler.nodeUrl` | top-level `nodeUrl` | Optional crawler-specific RPC override |
| `crawler.batchSize` | `10` | Blocks per catch-up batch |
| `crawler.fetchConcurrency` | `(default)` | Parallel RPC fetches during catch-up |
| `crawler.rpcBatchSize` | `(default)` | Substrate JSON-RPC batch size |
| `crawler.requestTimeout` | `30000` | RPC timeout (ms) |
| `palletMap` | `(built-in)` | Override of the pallet-index → tx-type map of the `BlockProcessor` (`{ "<index>": { name, txType, isShielded?, isSystem? } }`) |
| `allowMainnetSubmission` | `false` | Gate for mainnet submission |
| `granteeBinding` | `wallet` | Principal → vault `Bytes<32>` grantee id: `wallet` (coin pubkey hash) / `did` (DID string) / `custom` (64 hex); used by `registerGranteeIdentity` and the disclosure read gate |
| `allowSelfServiceGranteeRegistration` | `false` | Lets callers register their own grantee identity. NIGHTGATE does not verify ownership of the binding input, so under `wallet`/`did` a user could claim another party's id; off = `403`. Operators can write `GranteeIdentities` directly |
| `networks` | `{}` | `{ "<network>": { indexerHttpUrl, indexerWsUrl } }` for the verify functions' `network` override; unlisted networks use the public defaults. Top-level indexer URLs and `NIGHTGATE_INDEXER_*` apply to the configured network only |

### Environment variables

Declared in `srv/utils/config-table.ts` (kind, default, bounds); the table below
is generated (`npm run config:table`) and pinned by a unit test. The wallet
worker reads no environment; it receives the resolved values. Empty = unset; an
unparsable value is logged once and the default applies; out-of-bounds numbers
are clamped with a warning; booleans: `true`/`false`, `1`/`0`, `yes`/`no`,
`on`/`off`. Except `ENCRYPTION_*`, each can be set as
`cds.requires.nightgate.<camelCase>` (`NIGHTGATE_WORKER_RPC_TIMEOUT_MS` ->
`workerRpcTimeoutMs`); env beats CAP beats default.

<!-- config-table:start -->
| Variable | Kind | Default | Purpose |
|---|---|---|---|
| `NIGHTGATE_NETWORK` | `preview` / `testnet` / `preprod` / `mainnet` / `undeployed` |  | Override `network` |
| `NIGHTGATE_NODE_URL` | url |  | Override `nodeUrl` |
| `NIGHTGATE_CRAWLER_NODE_URL` | url |  | Override `crawler.nodeUrl` |
| `NIGHTGATE_INDEXER_HTTP_URL` | url |  | Override `indexerHttpUrl` (e.g. point at local indexer container) |
| `NIGHTGATE_INDEXER_WS_URL` | url |  | Override `indexerWsUrl`; optional, derived from the HTTP URL when unset |
| `NIGHTGATE_PROOF_SERVER_URL` | url |  | Override `proofServerUrl` |
| `NIGHTGATE_PROVING_MODE` | `server` / `wasm` |  | Proving mode `wasm` (in-process) or `server` (proof server). Unset: `server` when a proof server is configured, `wasm` otherwise. `initialize()` pins the effective value into the env for the worker. Read in the wallet worker. |
| `NIGHTGATE_PROOF_TIMEOUT_MS` | ms (min 1) | `300000` | Override `proofTimeoutMs`; pinned into the env at plugin init for the wallet worker. The proof-server container has its own job TTL (`MIDNIGHT_PROOF_SERVER_JOB_TIMEOUT`, default 600 s): raise both, or a finished-but-expired job answers 5xx and midnight-js re-proves. Read in the wallet worker. |
| `NIGHTGATE_ZK_CONFIG_BASE` | path | `./contracts` | Override `zkConfigBasePath` |
| `NIGHTGATE_ZK_CONFIG_PUBLIC_URL` | url |  | Public base URL advertised by `/contract-manifest` for the `/zk-config/...` routes (behind a reverse proxy); unset = relative URLs, resolved by the client against the origin it fetched the manifest from |
| `NIGHTGATE_ZK_ASSET_URL` | string |  | A `/zk-config` base the server fetches missing prover keys from (`<url>/<contract>/keys/<circuit>.prover`, verified against `keys/manifest.json`); `none`/`off` disables the fetch. Unset: the release tag on raw.githubusercontent.com for the shipped contracts, no source for others. Offline installs run `nightgate-fetch-keys` once. |
| `NIGHTGATE_CONTRACTS_DIR` | string |  | Root directories (path-delimiter separated) a runtime `registerContract` (admin) may point into; default: the package's and the working directory's `contracts/`. Importing an artifact executes its module, so paths outside are refused. The supported way to keep a consumer's artifacts outside the package: point it at that directory. The artifact's `@midnight-ntwrk/compact-runtime` import resolves from NIGHTGATE's own node_modules (worker snapshots and the registration probe), so the directory needs no node_modules of its own. |
| `NIGHTGATE_PRIVATE_STATE_BACKEND` | `cap-db` / `level` |  | Override `privateStateBackend` |
| `NIGHTGATE_GRANTEE_BINDING` | `wallet` / `did` / `custom` |  | Override `granteeBinding` (`wallet` / `did` / `custom`) |
| `NIGHTGATE_ALLOW_SELF_SERVICE_GRANTEE_REGISTRATION` | bool |  | Override `allowSelfServiceGranteeRegistration` (`false` / `0` / `no` / `off` disables) |
| `NIGHTGATE_CLOSE_SESSIONS_ON_RESTART` | bool |  | Override `closeSessionsOnRestart` (default on): `false` keeps the previous process's wallet sessions open across a restart |
| `NIGHTGATE_INSTANCE_ID` | string |  | Stable operator-provided instance identifier; otherwise CF instance GUID, hostname, or a generated UUID |
| `NIGHTGATE_REPLICA_COUNT` | int (min 1) |  | Actual process/replica count. Must be `1`; takes precedence over CDS `replicaCount` |
| `NIGHTGATE_ALLOW_PRODUCTION_SQLITE` | bool | `false` | `true` temporarily permits production SQLite with a high-severity warning; intended only for a migration window |
| `NIGHTGATE_ASSUME_DB_NETWORK` | string |  | Confirms which network an index without a recorded network id belongs to; the boot guard refuses to bind such an index to the configured network otherwise. |
| `NIGHTGATE_STATUS_ROUTES` | `off` / `public` |  | Plain `/nightgate/metrics|health|ready` routes: unset = mounted only with `NIGHTGATE_STATUS_TOKEN`, `public` = mounted without a token, `off` = not mounted. |
| `NIGHTGATE_STATUS_ROUTES_PREFIX` | path | `/nightgate` | Path prefix of the plain status routes. |
| `NIGHTGATE_STATUS_TOKEN` | secret |  | Bearer token the plain status routes require; without it (and without `NIGHTGATE_STATUS_ROUTES=public`) they are not mounted. |
| `NIGHTGATE_DEBUG_WALLET_SYNC` | bool | `false` | `true` logs wallet sync-state persistence at debug level |
| `NIGHTGATE_CRAWLER_ENABLED` | bool |  | `false` / `0` / `no` / `off` disables the crawler at boot |
| `NIGHTGATE_FETCH_CONCURRENCY` | int (min 1) |  | Override `crawler.fetchConcurrency` |
| `NIGHTGATE_RPC_BATCH_SIZE` | int (min 1) |  | Override `crawler.rpcBatchSize` |
| `NIGHTGATE_JOB_LEASE_TTL_MS` | ms (min 1) | `300000` | A `running` job whose heartbeat is older than this is reclaimed (re-dispatched with `attempt + 1`) unless it crossed the external-effect boundary; default 5 minutes. |
| `NIGHTGATE_CHILD_JOB_WAIT_TIMEOUT_MS` | ms (min 1) |  | Parent-workflow watchdog; defaults to the worker RPC timeout plus 5 minutes. Timeout is fail-closed while the child may continue. |
| `NIGHTGATE_WORKER_RPC_TIMEOUT_MS` | ms (min 1) | `1800000` | Backstop timeout of one wallet-worker RPC (a proof or a submit); default 30 minutes. |
| `NIGHTGATE_WORKER_DRAIN_MAX_MS` | ms (min 1) | `600000` | Upper bound of a worker rotation drain (in-flight submits complete first); default 10 minutes, then the worker is terminated and the cut calls fail `WORKER_ROTATED`. |
| `NIGHTGATE_WORKER_YOUNG_GEN_MB` | int (min 0, max 2048) | `128` | Young-generation size of the wallet worker thread (`resourceLimits.maxYoungGenerationSizeMb`); default 128, `0` = V8 default, clamped to 16..2048. |
| `NIGHTGATE_WORKER_MAX_GENERATIONS` | int (min 0) | `32` | Distinct artifact generations a worker loads before it rotates (drain + fresh thread); default 32. Read in the wallet worker. |
| `NIGHTGATE_WORKER_GENERATION_CACHE` | int (min 1) | `8` | Scaffold and provider cache size per worker (bounded cache of artifact generations); default 8. Read in the wallet worker. |
| `NIGHTGATE_ARTIFACT_SNAPSHOT_DIR` | path |  | Base directory of the immutable content-addressed artifact snapshots the worker proves from; default `<tmpdir>/nightgate-artifact-snapshots`, layout `<base>/<install>/<digest>`. Read in the wallet worker. |
| `NIGHTGATE_ARTIFACT_SNAPSHOT_TTL_DAYS` | int (min 0) | `14` | Snapshots no live process holds are swept after this many days; default 14. Read in the wallet worker. |
| `NIGHTGATE_ARTIFACT_DIGEST_MAX_AGE_MS` | ms (min 0) | `300000` | How long the memoised current artifact digest (`getRuntimeInfo`, job resolves) may be trusted before the files are re-hashed regardless of their stat fingerprint. |
| `NIGHTGATE_DUST_RACE_RETRIES` | int (min 0) | `2` | Rebuild-retries of a bound deploy/call/batch on a transient dust race (`1010/170`, `1010/196`, pre-mempool, fee unspent); default `2`. Each retry re-proves the call, hence smaller than the sponsor path's `NIGHTGATE_SPONSOR_DUST_RETRIES`. `0` disables. |
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
| `NIGHTGATE_PROGRESS_WATCH_MS` | ms (min 15000) | `60000` | Interval of the worker's progress watch: pushes each facade's sync-gate verdict to `getWalletSyncProgress` and `getSponsorPoolStatus` and checks restored sub-wallets for a rejected replay; default `60000`, floor 15 s. Read in the wallet worker. |
| `NIGHTGATE_SNAPSHOT_REPLAY_RESET_MS` | ms (min 0) | `300000` | A sub-wallet restored from a snapshot that stays at its restored offset while the ledger rejects its replayed events (dust: event older than the synced time or commitment below the tree index; shielded: commitment below the tree index) is replaced by a fresh one syncing from genesis once both have lasted this long; default `300000`, `0` disables the replacement. Read in the wallet worker. |
| `NIGHTGATE_DISCLOSURE_REINDEX_RETRY_MS` | ms (min 0) | `1800000` | When the disclosure reindex after a landed grant, revoke or retract fails, a `reindexDisclosures` job retries it with backoff for this long before failing `DISCLOSURE_REINDEX_FAILED`; default `1800000` (30 min), `0` = one attempt. |
| `NIGHTGATE_SYNC_STATE_LOG_MS` | ms (min 0) | `600000` | Interval of the per-facade INFO line `sync-state` (dust `appliedIndex` and `syncTime`, shielded `appliedIndex` and `firstFree`) written from the state save tick; default `600000`, `0` disables it. Read in the wallet worker. |
| `NIGHTGATE_SAVE_INTERVAL_MS` | ms (min 10000) | `60000` | Wallet-state save tick of the worker; default `60000`, floor 10 s. Read in the wallet worker. |
| `NIGHTGATE_RESTORE_SAVE_ACK_TIMEOUT_MS` | ms (min 1) | `30000` | How long a facade restore waits for the acknowledgement of its immediate re-save; default `30000`. Read in the wallet worker. |
| `NIGHTGATE_DUST_COLD_START` | bool | `false` | `true` starts the dust sub-wallet from the secret key instead of the persisted state (diagnostic). Read in the wallet worker. |
| `NIGHTGATE_DUST_REGISTER_SETTLE_MS` | ms (min 0) | `90000` | How long `registerForDustGeneration` waits for the registration to apply locally before it reports `settled: false`; default `90000`. Read in the wallet worker. |
| `NIGHTGATE_SIGNING_KEY_RATE_LIMIT` | int (min 1) | `10` | `connectWalletForSigning` attempts per hour per principal; default `10`. |
| `NIGHTGATE_GRANT_ADMIN_RATE_LIMIT` | int (min 1) | `10` | Grant administration calls (`createAgentGrant`, `updateAgentGrant`, `rotateAgentGrantToken`, `revokeAgentGrant`) per hour per principal; default `10`. |
| `NIGHTGATE_PUBLIC_VERIFY` | bool | `false` | Serve `verifyAttestationState` and `verifyPredicateState` without credentials under `/api/v1/verify` (the image admits the path unauthenticated and answers CORS preflight with `*`); default off, the functions answer `404 PUBLIC_VERIFY_DISABLED`. |
| `NIGHTGATE_PUBLIC_VERIFY_RATE_LIMIT` | int (min 1) | `60` | Public verify calls per minute per client address; default `60`. |
| `NIGHTGATE_CLAIM_LIFETIME_S` | int (min 60) | `31536000` | Default claim lifetime in seconds for the issue* actions when the caller passes no `validUntil`; default one year, the vault caps a claim at five years ahead. |
| `NIGHTGATE_FEE_SPONSOR_SESSION` | list |  | Comma list of platform fee-sponsor session ids (the pool); overrides `feeSponsorSessions`. |
| `NIGHTGATE_SUBMIT_TRANSPORT_RETRIES` | int (min 0) | `2` | Resends of the SAME finalized transaction when the send itself fails (websocket closed at submit, `1000 Normal Closure`, `ECONNRESET`; never a node reject, never a reply-less wait); default `2`, `0` disables. No rebuild, no re-proving: the facade re-pends the spends and the identical bytes go out again. Applies to every bound submit (deploy/call/batch, sends, dust registration, bound sponsoring). Read in the wallet worker. |
| `NIGHTGATE_SUBMIT_TRANSPORT_BACKOFF_MS` | ms (min 0) | `5000` | Pause before such a resend; default `5000`. Read in the wallet worker. |
| `NIGHTGATE_SUBMIT_LANDED_PROBE_MS` | ms (min 0) | `30000` | How long the worker polls the indexer for the transaction identifier before a resend, and after a resend was rejected (a reply lost on the first send may still have reached the node); default `30000`. A landed transaction is reported as submitted only with ledger result `SUCCESS`; in a block but not applied fails as `TxFailed` (fee spent). Read in the wallet worker. |
| `NIGHTGATE_SUBMIT_INTENT_ACK_TIMEOUT_MS` | ms (min 1000) | `120000` | How long the worker waits for the main thread to record an announced transaction identifier before it gives up without broadcasting; default 2 minutes. Keep it above the database pool acquire timeout plus the lock-contention retries. Read in the wallet worker. |
| `NIGHTGATE_SUBMIT_CONNECT_TIMEOUT_MS` | ms (min 1) | `20000` | Connect phase of a dedicated-client submit: client creation plus socket; default `20000`. A timeout here sent nothing (`transport/not-sent`, retried once on a fresh client, then a clean pre-inclusion failure). Read in the wallet worker. |
| `NIGHTGATE_SUBMIT_REQUEST_TIMEOUT_MS` | ms (min 1) | `30000` | Request phase of a dedicated-client submit: from the send until the node's first status (subscription acknowledged); default `30000`. A timeout here is ambiguous (`no-reply`): the transaction may or may not be in the pool, the job parks for the confirmer. Read in the wallet worker. |
| `NIGHTGATE_SUBMIT_LATE_GRACE_MS` | ms (min 0) | `300000` | After a request or watch phase timeout the attempt keeps its node subscription open this long and logs a late status or reject under the transaction identifier (evidence only; the job is parked for the confirmer either way); default `300000`. Read in the wallet worker. |
| `NIGHTGATE_SUBMIT_WATCH_TIMEOUT_MS` | ms (min 1) | `75000` | Watch phase of a submit: from the node's first status until InBlock (or Finalized, `NIGHTGATE_SPONSOR_WAIT`); default `75000`. A timeout here is ambiguous: the node took the request and nothing was included in time; the indexer is asked for 90 s, then the job parks for the confirmer. On the facade (bound) path this is the whole wait after the send. Read in the wallet worker. |
| `NIGHTGATE_BROADCAST_EXPIRY_MARGIN_MS` | ms (min 0) | `300000` | A job parked in `reconciliation_required` whose transaction the indexer does not know ends `failed / BROADCAST_NOT_INCLUDED` once the indexer tip is this far past the transaction's validity window (ttl); default `300000`. The ttl is recorded at the submit intent; rows without one use the submit time plus one hour. |
| `NIGHTGATE_BATCH_SEGMENT_MODE` | `rewrite` / `observe` | `rewrite` | Batch segment ordering: `rewrite` (deterministic stage-grouped order) or `observe` (log only). Read in the wallet worker. |
| `NIGHTGATE_SPONSOR_POLICY_FILE` | path |  | Path to a JSON file `{ "allowedContracts": [], "allowedCircuits": [], "allowDeploy": false, "allowedTokenTypes": [] }` that replaces `NIGHTGATE_SPONSOR_ALLOWED_CONTRACTS`/`_CIRCUITS` while set. Calls on a grant's `deployedContracts` are exempt from `allowedCircuits`. Re-read per sponsored call behind an mtime cache, so the sponsor policy changes without a container recreate. Fail-closed: an unreadable or invalid file keeps the last good policy, and with none loaded yet sponsored calls answer `503 SPONSOR_POLICY_UNAVAILABLE`. |
| `NIGHTGATE_SPONSOR_ALLOWED_CONTRACTS` | list |  | Comma list of contract addresses a sponsor pays for (platform floor); empty = any. Replaced by `NIGHTGATE_SPONSOR_POLICY_FILE` while that is set. |
| `NIGHTGATE_SPONSOR_ALLOWED_CIRCUITS` | list |  | Comma list of circuit names a sponsor pays for (platform floor); empty = any. Replaced by `NIGHTGATE_SPONSOR_POLICY_FILE` while that is set. |
| `NIGHTGATE_SPONSOR_ALLOWED_TOKEN_TYPES` | list |  | Comma list of raw shielded token types (64 hex, what `deriveTokenType` returns) whose zswap offers the sponsor also pays for: a contract minting its own token to the caller, a caller spending that token into the contract. Unset = no offer at all (the default). Also `allowedTokenTypes` in the policy file and on a grant (effective = floor ∩ grant; the floor must open it, a grant only narrows). The shape check then requires every net change of the offer (`deltas`, public per type) to be on a listed type, never NIGHT, every contract-owned coin to belong to a sponsorable contract, and a net change to exist OR a coin in the offer to be owned by a sponsorable contract (a burn nets to zero by construction: user input, contract transient, burn-address output; a zero-net offer without a contract coin is refused). User outputs are commitments, so a transfer of a listed type between users riding along is accepted by design: the sponsor pays dust, no sponsor value moves. An invalid entry fails closed (`503 SPONSOR_POLICY_UNAVAILABLE`). |
| `NIGHTGATE_SPONSOR_ALLOW_DEPLOY` | bool | `false` | Opens sponsored contract DEPLOYS on this deployment: `true`/`1`/`yes`. Off by default. A token caller additionally needs `allowDeploy` on its grant with deploy budget left; a plain caller inherits the floor. Also settable as `allowDeploy` in `NIGHTGATE_SPONSOR_POLICY_FILE`. |
| `NIGHTGATE_SPONSOR_MAX_TX_BYTES` | int (min 1) | `65536` | Byte ceiling of a sponsored call transaction the worker accepts; default `65536`. Read in the wallet worker. |
| `NIGHTGATE_SPONSOR_MAX_DEPLOY_BYTES` | int (min 1) | `40960` | Byte ceiling of a sponsored DEPLOY transaction (a deploy writes verifier keys on chain and costs a multiple of a call); default `40960`. Read in the wallet worker. |
| `NIGHTGATE_SPONSOR_WAIT` | `inblock` / `finalized` | `inblock` | Submission stage the unbound sponsor path waits for: `inblock` (default) or `finalized`. Read in the wallet worker. |
| `NIGHTGATE_SPONSOR_INDEXER_VISIBLE_MS` | ms (min 0) | `30000` | After InBlock, bounded wait until the public indexer shows the sponsored transaction; `0` skips the wait; default `30000`. Read in the wallet worker. |
| `NIGHTGATE_SPONSORED_CALLER_SYNC` | `wait` / `skip` | `wait` | `skip` omits the caller-side wallet sync when balancing a sponsored transaction (vault calls move no caller value). Read in the wallet worker. |
| `NIGHTGATE_NOTE_LEASE_MS` | ms (min 1) | `300000` | Lease on a dust note backing a sponsored transaction (parallel sponsoring from one wallet); a non-positive or non-numeric value falls back to the default `300000`. Read in the wallet worker. |
| `NIGHTGATE_BACKING_WAIT_MS` | ms (min 0) | `300000` | How long an unbound sponsoring waits for a free dust backing before it refuses; default `300000`. Read in the wallet worker. |
| `NIGHTGATE_SPONSOR_PREWARM_SYNC_MS` | ms (min 0) | `1800000` | Prewarm brings pool members to the chain tip one at a time; this caps the wait per sponsor, default 30 min, `0` = build only. |
| `NIGHTGATE_SPONSOR_STATUS_TIMEOUT_MS` | ms (min 1) | `45000` | Per-sponsor read cap of `getSponsorPoolStatus`; default `45000`. |
| `NIGHTGATE_SPONSOR_LEASE_WAIT_MS` | ms (min 0) | `120000` | How long a sponsored job waits for a busy or cooling sponsor before it fails over or gives up; default `120000`. |
| `NIGHTGATE_SPONSOR_COOLDOWN_MS` | ms (min 0) | `120000` | Bench time of a sponsor after a retryable failure; default `120000`. |
| `NIGHTGATE_SPONSOR_DUST_RETRIES` | int (min 0) | `4` | Rebuild-retries of a sponsored transaction on a dust race, on the same sponsor; default `4`. |
| `NIGHTGATE_SPONSOR_DUST_BACKOFF_MS` | ms (min 0) | `5000` | Pause before such a rebuild; default `5000`. |
| `ENCRYPTION_KEY` | secret |  | At-rest secret (32+ byte hex) for viewing keys, seed keys and encrypted job commands; key id `1` of the ring. Without any key a random per-process dev key is used (rows do not survive a restart); **required** in production. Env only, no CAP mapping. |
| `ENCRYPTION_KEYS` | secret |  | Key ring `id=secret,id=secret` (ids `[A-Za-z0-9_-]{1,16}`); `ENCRYPTION_KEY` joins it as id `1`. Every secret is HKDF-stretched; ciphertexts are `v2:<keyId>:...` envelopes (per-row data key wrapped by the ring key, key id bound as AAD). Legacy `iv:tag:data` values stay readable under id `1`. Env only, no CAP mapping. |
| `ENCRYPTION_KEY_ACTIVE` | string |  | Id of the ring key new ciphertexts are written under (required with more than one key). Startup refuses a database whose ciphertexts name a key id outside the ring; `nightgate-rewrap-keys` moves rows to the active key (see docs/operations.md, key rotation). Env only, no CAP mapping. |
<!-- config-table:end -->

Read by the standalone image and the dev scripts, not by the plugin:

| Variable | Purpose |
|---|---|
| `NIGHTGATE_DB_URL` | Image: `postgres://user:pw@host:5432/db` selects PostgreSQL, schema deployed each boot (additive). `?sslmode=` `disable`, `require` (unverified) or `verify-full` (optional `sslrootcert=<pem>`); other values refuse to start. Unset = SQLite at `NIGHTGATE_DB_PATH` |
| `NIGHTGATE_DB_DEPLOY` | Image with `NIGHTGATE_DB_URL`: `auto` (default) deploys the schema at boot, `never` skips |
| `NIGHTGATE_DB_WAIT_SECONDS` | Image `migrate` mode: wait for the PostgreSQL listener before `cds deploy` (default 60, 1..86400) |
| `NIGHTGATE_HEAP_MB` | Heap size for `scripts/dev.mjs` / `scripts/serve.mjs` (default `12288`) |
| `NIGHTGATE_PROOF_NETWORK` | Network passed to the proof-server container; defaults to `preprod` |

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

Diagram: [architecture.md#the-two-pipelines](architecture.md#the-two-pipelines).

| Pipeline | Where it runs | What it does |
|---|---|---|
| **Block crawler** | Main thread | Catch-up + live block subscription via Substrate RPC; writes Blocks/Tx/Actions/UTXOs/Balances into CAP DB |
| **Wallet SDK** | `worker_threads` worker | ZK-aware wallet ops: shielded/unshielded/dust sub-wallets, transfer/contract submission via the Midnight indexer + prover (proof server or in-process wasm) |

The pipelines share no hash (job identifier, extrinsic hash and indexer hash differ). The indexer confirmer resolves a job by its identifier and records `chainBlockHeight`, `chainBlockHash` and `indexerTxHash` on the job and its `PendingSubmissions` row; a reorg rollback reverts outcomes confirmed at or above the fork height.

For each block the crawler reads `System.Events` at that block hash (metadata
cached by `specVersion`) and maps `ExtrinsicSuccess` / `ExtrinsicFailed` to the
extrinsic index. Only these events create `TransactionResults` rows
(`outcomeSource=substrate-system-events`); decode errors or a missing outcome
stay unknown, never success. Rows without `outcomeSource` are ignored by
`verifyDocument` and `verifyPredicateAttestation` and removed at startup;
re-crawl to backfill.

### Submission lifecycle

For every action that produces an on-chain transaction:

1. **Main thread**: validate args, rate-limit check, INSERT `PendingSubmissions` row with status=`pending`
2. **Main thread**: register a `CapDbPrivateStateProvider` instance under a fresh `proxyId` (only for deploy/call)
3. **Worker**: receive RPC, build via facade, balance, finalize (ZK proof gen - heavy), submit; return primitives
4. **Main thread**: UPDATE row with `txHash` + `status=included`; release proxy; classify any error
5. **Later, async**: the indexer confirmer resolves the identifier → `chainStatus`, block height/hash on the job, the attempt row flips to `finalized`

`PendingSubmissions.sessionId` is the OData session UUID (audit); the worker keys facades on `accountId` (derived from the viewing key). See [architecture.md#the-sessionid-indirection](architecture.md#the-sessionid-indirection).

### Error classification

Error codes of `classifySubmissionError(err, network)`: [actions.md#error-model](actions.md#error-model).

### Startup + failure semantics

- The schema is not auto-deployed: a missing table keeps NIGHTGATE offline with a "run `npm run deploy`" error; the host process keeps running.
- Unreachable node: warning, `offline` mode; reads and submissions (indexer + prover only) keep working.
- Wallet worker fails to start: warning; submissions return an error, reads unaffected.
- `initialize()` is idempotent and reloads `cds.requires.nightgate.contracts`.

### Runtime topology contract

NIGHTGATE supports exactly one process and one CAP tenant (crawler, facade
cache, job semaphore and cleanup are process-local). Startup fails closed when
a replica count above one is declared or CAP multitenancy is on. Declare the
count via `NIGHTGATE_REPLICA_COUNT` or `replicaCount`; `CF_INSTANCE_COUNT` and
`KUBERNETES_REPLICA_COUNT` are read too, `WEB_CONCURRENCY` is ignored (HTTP
workers, not replicas). Platforms inject none of these; on Cloud Foundry
`CF_INSTANCE_INDEX` makes every instance other than `0` fail closed. The guard
is not a lock or leader election: the deployment must start one instance.
Health, readiness, liveness and metrics expose instance id and topology.

Production SQLite is refused by the same guard; bind `@cap-js/postgres` or
`@cap-js/hana`. `NIGHTGATE_ALLOW_PRODUCTION_SQLITE=true` is a temporary escape
hatch only.

### Database profiles and migration

The host chooses the database (SQLite for development, PostgreSQL or HANA for
production); NIGHTGATE embeds no credentials. Typical profiles:

```json
{
  "cds": { "requires": { "db": {
    "[development]": { "kind": "sqlite", "credentials": { "url": "db/local.db" } },
    "[production]":  { "kind": "postgres", "credentials": { "url": null } }
  } } }
}
```

Inject credentials via a CAP service binding or `cds_requires_db_credentials_*`.
The plugin sets `cds.features.use_generic_pool` to `true` unless the host sets
it (CAP's built-in pool loses a connection per timed-out acquire). The
standalone image uses `cds.requires.db.pool` `{ max: 20, acquireTimeoutMillis:
30000, destroyTimeoutMillis: 5000 }` and `cds.requires.db.client`
`{ connectionTimeoutMillis: 10000 }`. Run `cds deploy --profile production`
before the first start; schema evolution cannot do lossy key or type changes,
so inspect deltas and back up before each deployment.

SQLite to PostgreSQL is a data migration: deploy the model to an empty
PostgreSQL database, stop all writers, run `npx nightgate-db-migrate --from
<sqlite file> --to <postgres url>` (all persisted entities in batches, row
counts compared per table; aborts on unknown source tables with rows unless
`--ignore-unknown` and on decimals SQLite rounded beyond 2^53; needs
`@cap-js/postgres` and `better-sqlite3`; image: `docker compose run --rm
--no-deps nightgate migrate --from <file>`), then switch the binding. Keep the
SQLite file read-only until backup and smoke test pass.

`db/midnight.db` holds indexed data and encrypted wallet state; delete `db/midnight.db*` when switching networks.

### Background-job durability and restart safety

`BackgroundJobs` is the durable ledger of wallet and contract operations:
request fingerprint, attempt budget, lease, heartbeat and, once known, the
`PendingSubmissions.ID` and transaction hash. `(sessionId, kind,
idempotencyKey)` is unique for good, failed jobs included: a new attempt needs a
new key, the same key with a different request is rejected.

Before upgrading a database run `npm run check:job-idempotency` (read-only,
reports duplicate tuples) and resolve duplicates before `cds deploy`.

Lifecycle: `pending -> running -> external_execution -> submitted ->
succeeded|failed`. `external_execution` starts right before the SDK call that
proves, balances and broadcasts; `submitted` once a transaction hash exists.
After a process restart:

- `pending` or pre-effect `running` without a persisted command: `failed /
  PROCESS_RESTART_BEFORE_EXECUTION`; versioned commands re-queue unless their
  signing session was closed at restart (`failed / PROCESS_RESTART_SESSION_CLOSED`);
- `external_execution` without `txHash`: `failed /
  PROCESS_RESTART_BEFORE_BROADCAST` (every path broadcasts only after its
  identifier is persisted);
- `external_execution` with `txHash`, or `submitted`:
  `reconciliation_required / PROCESS_RESTART_RECONCILE`;
- check a `reconciliation_required` job against `PendingSubmissions`, its
  `txHash` or live contract state before retrying.

A fresh `connectWalletForSigning` marks older queued or running prewarm jobs of
the same session `failed / SUPERSEDED` (no action needed). A superseded pending
job never starts; a running one finishes its wait and its result is discarded.

`status` and `chainStatus` answer different questions. `succeeded` means the
workflow returned, not that the extrinsic executed. `chainStatus` is null for
non-chain jobs, `pending` once a hash exists, then `success` or `failure` once
the indexer confirmer resolves the ledger identifier (`chainFinalizedAt`,
`chainBlockHeight`, `chainBlockHash`, `indexerTxHash`). The crawler indexes a
different hash and uses the block height only to revert outcomes on a reorg.
Predicate workflow parents aggregate children: any failed child `failure`, all
successful `success`, else `pending`.

Without a restart, a throw after `external_execution` or `submitted` gives
`reconciliation_required / EXTERNAL_EXECUTION_FAILED`; a submit with no node
status and no indexer entry parks as `reconciliation_required /
BROADCAST_UNCONFIRMED`. Only failures proven before the boundary are plain
`failed`.

A parked job leaves `reconciliation_required` when:

- the indexer shows the transaction: `succeeded`, or `failed /
  CHAIN_EXECUTION_FAILED` if the call did not apply;
- the indexer tip passes the transaction's ttl (recorded at the submit intent,
  30 to 60 min after the build; else submit time plus one hour) by
  `NIGHTGATE_BROADCAST_EXPIRY_MARGIN_MS` without the transaction: `failed /
  BROADCAST_NOT_INCLUDED`, `chainStatus: dropped`; a lost sponsored deploy
  refunds its grant reservation in the same transaction;
- all children of a workflow parent succeed.

Only absence counts: a transaction the indexer has but cannot confirm yet keeps
the job parked. Absence is judged against the tip of the same indexer answer
(the older tip when identifier and hash are both queried), so a lagging replica
never turns "not indexed yet" into "never included". A parent whose child
ended failed ends `failed / CHILD_FAILED`, naming the child, its code and the
steps already on chain.

The poller also reconciles conservatively: it needs the exact job `txHash` (or
its `PendingSubmissions` row's), that submission `finalized` and a matching
indexed `Transactions` row, then completes the job with `{ reconciled,
submissionId, txHash, contractAddress, status }`. A hash alone, an `included`
submission or a live-state effect stays `reconciliation_required`. This proves
submission and finalization, not business execution.

Leaf commands with local projections register idempotent finalizers that never
call the wallet: `anchorDocument` restores `Documents.anchoredTxHash/anchoredAt`,
`grantDisclosure` restores `grantedTxHash`, `revokeDisclosure` sets
`active=false` and `revokedTxHash` (both trigger a state reindex);
`submitContractCallBatch` and `registerPassport` only rebuild their result. A
throwing finalizer keeps the job parked and retries next poll. Results carry
the action's fields plus `reconciled: true`.

When all children of a predicate workflow are reconciled, the parent returns to
`pending` and rebuilds its result from the same deterministic children without
resubmitting. Partially resolved workflows stay visible for the operator.

Replay: prewarm, transfer, dust, deploy, contract call, anchoring and disclosure
jobs use versioned persisted commands without seed material. The processor
reloads encrypted signing material from the owning `WalletSessions` row, checks
`requestedBy`, re-resolves the artifact, re-checks wallet and sponsor ownership
and re-coerces arguments before executing. Circuit arguments, private state and
witnesses are stored only as AES-256-GCM ciphertext (`commandEncoding =
aes-gcm-v1`); the public `request` stays redacted. After a restart a pre-effect
`running` job returns to `pending` only if its session survived
(`closeSessionsOnRestart`); external-effect states never replay.

Predicate issuance is a parent workflow with one deterministic child per chain
call (`parentJobId`, `workflowStep`, child key `workflow:<parent ID>:<step>`);
each child crosses the external-effect boundary at most once. The parent submits
nothing: if a child succeeded and a later one fails or is ambiguous, the parent
goes to `reconciliation_required`, not `failed`, so a retry cannot duplicate the
completed effect.

Prometheus exposes queued, running, reconciliation-required and oldest-queued
job gauges.

**Reconciliation caveats.**

- A finalized transaction whose `System.Events` never decode has no canonical
  outcome and stays `reconciliation_required` indefinitely (never a false
  success): alert on a non-draining
  `odatano_nightgate_jobs_reconciliation_required` and reconcile manually.
- A resolved job is not reverted if a later reorg removes its block; low risk,
  since reconciliation requires `PendingSubmissions.status = finalized`.

The poller claims only `pending` rows with a registered `(kind,
commandVersion)` processor; the `pending -> running` claim must hit exactly one
row. Completion writes are fenced by `leaseOwner` and status. Heartbeats never
reclaim a hung live SDK call, which may still cross the boundary; replay is
crash recovery only.

`PrivateStates`, `ContractSigningKeys` and `WalletSyncStates` are encrypted (PBKDF2 + AES-GCM) under passwords derived from a per-account data key (`AccountKeys`), sealed under the ring's active key (`nightgate-rewrap-keys` rotates it without the viewing key) and under the viewing-key storage password (opens after a ring rotation, then re-seals). The ring alone opens an account's rows; the viewing key alone opens nothing. Rows with `keyScheme` null use the older derivation: a session read migrates them, the rewrap tool migrates those a stored viewing key reaches and reports the rest; keep their ring key until none remain. An unreadable sync blob counts as no cached state (re-sync). Losing every ring key makes the stored keys unreadable: back up the secrets. Portable private-state export: `exportPrivateStates({ password })`.

### Security middleware

NIGHTGATE installs no global HTTP middleware; CORS, CSP, HSTS and preflight are
host policy. Hosts serving `/zk-config/...` or `/contract-manifest`
cross-origin add them to their CORS allow-list. Exception in the standalone
image's transport auth, not the plugin: with `NIGHTGATE_PUBLIC_VERIFY=true` it
admits `/api/v1/verify` without credentials and answers its preflight with `*`.

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
| `NightgateVerifyService` | `/api/v1/verify` | `verifyAttestationState` + `verifyPredicateState` without credentials (`NIGHTGATE_PUBLIC_VERIFY=true`; off: `404 PUBLIC_VERIFY_DISABLED`), per-address rate limit |

For per-action signatures and curl examples, see [actions.md](actions.md).

### NightgateService entities (all `@readonly` unless noted)

- `Blocks`, `Transactions`, `TransactionResults`, `TransactionSegments`, `TransactionFees`
- `ContractActions` (one row per `Midnight` pallet extrinsic; `address` and `state` null until the ledger payload is decoded), `ContractBalances`
- `UnshieldedUtxos`, `NightBalances` (written only by a ledger-payload decoder, not derived from the extrinsic envelope)
- `ZswapLedgerEvents`, `DustLedgerEvents`
- `Documents`, `PredicateAttestations`, `DisclosureGrants`, `GranteeIdentities`
- `PendingSubmissions`: read scoped to the caller's sessions (admins unfiltered)
- `WalletSessions`: excludes `viewingKeyHash`, `encryptedViewingKey`, `encryptedSeedKey`; read scoped to the owning `userId` (admins unfiltered)

### Schema additions

| Entity / Field | Purpose |
|---|---|
| `PendingSubmissions` | Submission lifecycle `pending` → `included` → `finalized` / `failed`, written before the SDK call |
| `PrivateStates` | Encrypted private state per `(accountId, contractAddress, privateStateId)` |
| `ContractSigningKeys` | Encrypted contract signing keys per `(accountId, contractAddress)` |
| `WalletSyncStates` | Serialized sub-wallet blobs per `accountId`, restored on the next `connectWalletForSigning` |
| `WalletSessions.encryptedSeedKey` | Set by `connectWalletForSigning`; null = read-only session |
| `BackgroundJobs` | Async jobs; poll `getJobStatus(jobId, sessionId)` |
| `Attestations` | Attestation index (payload hash, attester, public metadata) behind the `AttestationService` tiers |
| `Documents` | `sha256` + caller `storageRef` (`s3://` \| `ipfs://` \| `file:///`); never the bytes. `anchorDocument` records `anchoredTxHash`, `verifyDocument` re-checks it |
| `DisclosureRoles` | Off-chain per-user tiers (`userId`, `role`, `scope`, `validFrom`/`validUntil`), granted via admin `grantRole` |
| `DisclosureGrants` | Chain-derived ACL from the vault `disclosures` map, reconciled after each grant/revoke |
| `GranteeIdentities` | `userId` → vault `granteeId` (`bindingKind`, `scope`), set by `registerGranteeIdentity` |

Enums in `db/types.cds`:

- `PendingSubmissionStatus`: `pending` | `included` | `finalized` | `failed`
- `BackgroundJobStatus`: `pending` | `running` | `external_execution` | `submitted` | `reconciliation_required` | `succeeded` | `failed`
- `DisclosureRole`: `public_only` | `legitimate_interest` | `authority` (levels 0, 1, 2)

## Capability matrix

| Area | Status |
|---|---|
| CAP plugin integration | ✅ Models, connector routes, lifecycle hooks |
| Node connectivity | ✅ `ws://` / `wss://`, config validation, offline fallback |
| Block catch-up + live sync | ✅ Finalized-block replay, header subscription, transient retry |
| Reorg recovery | ✅ Parent-hash detection, fork-point search, atomic rollback, `ReorgLog` |
| CAP-DB private state | ✅ Encrypted backend |
| Wallet sessions | ✅ Read-only + signing, TTL cleanup, admin invalidation |
| Contract deploy / call | ✅ Worker-routed, pending-row tracked, indexer-confirmed |
| Token ops (transfer) | ✅ `sendNight` (NIGHT is unshielded-only; no shield/unshield) |
| Dust generation | ✅ `registerForDustGeneration` + `deregisterFromDustGeneration` |
| Diagnostics (balance, fee estimates) | ✅ `getWalletBalance`, `estimateSendNightFee`, `getWalletSyncProgress` |
| Local Midnight indexer (docker) | ✅ Optional `midnightntwrk/indexer-standalone:4.3.3` service |
| Wallet state persistence | ✅ `WalletSyncStates`, restart resumes from the snapshot |
| Worker-thread architecture | ✅ Wallet SDK isolated from the main thread |
| Compact contracts | ✅ `counter`, `attestation-vault`, `attestation-vault-32`, `shielded-token` (compiled artifacts shipped) |
| Live preprod end-to-end | ✅ `npm run deploy:e2e` |
| On-chain disclosure grants | ✅ `grantDisclosure`/`revokeDisclosure`, `DisclosureGrants` index, `granteeBinding`, read gate |
| Crawler-free state verification | ✅ `verifyAttestationState` / `verifyPredicateState` / `reindexDisclosures` on live state, per-call `network` override |
| Bytes equality + set membership proofs | ✅ `issueFieldEqualityAttestation` / `issueFieldMembershipAttestation`, mixed-kind batch, `prepareMembershipSet` |
| Cross-root document diff proofs | ✅ `issueDocumentIntegrityAttestation` (width-bit slot mask) / `issueDocumentDiffAttestation` (at least k slots differ) over two anchored roots |
| Document-binding hardening | ✅ `bindDocument` (one id per payload, one payload per id), registrar-gated `registerDocument` (register, unregister, registrar transfer) |
| Mainnet submission | ❌ Gated by `allowMainnetSubmission: false` |
| Built-in authorization | ✅ `@requires` annotations; the host provides the auth strategy |

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
  nightgate-verify-service.{cds,ts} # unauthenticated verify functions
  crawler/                          # Block crawler (main thread)
    Crawler.ts
    BlockProcessor.ts
  providers/
    MidnightNodeProvider.ts         # Substrate RPC client
  midnight/                         # Wallet SDK integration
    sdk-loader.ts                   # main-thread dynamic-import loader
    wallet-worker.ts                # worker entry - SDK lives here
    wallet-worker-client.ts         # main-thread RPC client
    providers.ts                    # provider bundle assembly (legacy main-thread path; test-only)
    CapDbPrivateStateProvider.ts    # encrypted CAP-DB private state
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
npm run smoke:sdk                  # Midnight SDK packages load via dynamic import
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

- `npm test` passes with 0 failures; `smoke:sdk` and `integration:*` pass against the real SDK
- Worker dispatch, facade lifecycle, sync gate, save/ack and the facade operations are unit-tested in-thread against a fake facade (`wallet-worker-dispatch.test.ts`); real-SDK behavior runs in the live e2e scripts (`wasm-proving:e2e`, `wasm-contract:e2e`, `wasm-zswap:e2e`, `deploy:e2e`)
- Coverage: CAP-booted services run the compiled `srv/*.js`; sourcemaps plus `srv/**/*.js` in `vitest.config.ts` remap it onto the `.ts`. Removing either half makes booted-server handlers read as uncovered

Run locally:

```bash
npm run typecheck
npm test
npm run smoke:sdk
```
