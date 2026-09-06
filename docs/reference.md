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
| `proofTimeoutMs` | `300000` | HTTP timeout of ONE proof request to the proof server in server proving mode (0.22.0). midnight-js' own default; a proof past it fails the job and midnight-js re-requests the proof up to three times, so set it above the slowest proof. Ignored in wasm mode. |
| `zkConfigBasePath` | `./contracts` | Base for resolving relative `contracts.<name>.zkConfigPath` |
| `privateStateBackend` | `cap-db` | `cap-db` (default, production-grade encrypted CAP-DB tables) or `level` (legacy SDK LevelDB, **dev-only**, blocked on worker-routed submissions) |
| `contracts` | `{}` | Map of `<ref>` → `{ artifactPath, privateStateId, zkConfigPath, slotWidth? }`, loaded into the in-memory registry on plugin startup. `slotWidth` (16 or 32, default 16) declares the content-tree width of an attestation-vault-family artifact; the shipped `attestation-vault-32` registers with 32 and the whole proof surface sizes masks, k bounds and inclusion paths from it |
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
| `palletMap` | `(built-in)` | Optional override of the Substrate pallet-index → tx-type classification map used by the `BlockProcessor` (`{ "<index>": { name, txType, isShielded?, isSystem? } }`) |
| `allowMainnetSubmission` | `false` | Gate for mainnet submission. Stays off until [forum thread 1190](https://forum.midnight.network) (`1016 Immediately Dropped`) is resolved |
| `granteeBinding` | `wallet` | How an authenticated principal maps to the AttestationVault `Bytes<32>` grantee id for on-chain disclosure grants: `wallet` (coin pubkey hash) / `did` (DID string) / `custom` (opaque 64-hex). Used by `registerGranteeIdentity` + the disclosure read gate |
| `allowSelfServiceGranteeRegistration` | `false` | Whether authenticated callers may register their own grantee identity via `registerGranteeIdentity`. **NIGHTGATE does not verify that the caller owns the binding input it registers** (no wallet-signature / DID-control proof), so under `wallet`/`did` binding an authenticated user could squat another party's grantee id. Off by default since 0.5.0 (review_001 P1); the action returns `403` unless explicitly enabled. Identities can always be registered through an operator proofing flow that writes `GranteeIdentities` directly. |
| `networks` | `{}` | Per-network indexer endpoints for the `network` override on `verifyAttestationState` / `verifyPredicateState`: `{ "<network>": { indexerHttpUrl, indexerWsUrl } }`. Only consulted when a verify call overrides to a network other than the configured one; unlisted networks use the built-in public indexer defaults. Top-level `indexerHttpUrl`/`indexerWsUrl` and `NIGHTGATE_INDEXER_*` env vars apply to the CONFIGURED network only. |

### Environment variables

Every variable below is declared in `srv/utils/config-table.ts` with its kind,
default and bounds; the table is the single truth for the code, this section
(generated: `npm run config:table`, pinned by a unit test) and the wallet
worker, which receives the resolved values from the main thread and reads no
environment of its own. Parsing rules: an empty value counts as unset; a value
that does not parse is logged once and the default applies; a number outside
its bounds is clamped with a warning; booleans accept `true`/`false`, `1`/`0`,
`yes`/`no`, `on`/`off`. A CAP host may set any of them as
`cds.requires.nightgate.<camelCase>` (`NIGHTGATE_WORKER_RPC_TIMEOUT_MS` ->
`workerRpcTimeoutMs`); the environment variable wins, the CAP value beats the
default. The `ENCRYPTION_*` secrets are environment only.

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
| `NIGHTGATE_PROOF_TIMEOUT_MS` | ms (min 1) | `300000` | Override `proofTimeoutMs` (0.22.0); pinned into the env at plugin init for the wallet worker. The proof-server container has its own job TTL (`MIDNIGHT_PROOF_SERVER_JOB_TIMEOUT`, default 600 s): raise both, or a finished-but-expired job answers 5xx and midnight-js re-proves. Read in the wallet worker. |
| `NIGHTGATE_ZK_CONFIG_BASE` | path | `./contracts` | Override `zkConfigBasePath` |
| `NIGHTGATE_ZK_CONFIG_PUBLIC_URL` | url |  | Public base URL advertised by `/contract-manifest` for the `/zk-config/...` routes (behind a reverse proxy); unset = relative URLs, resolved by the client against the origin it fetched the manifest from |
| `NIGHTGATE_ZK_ASSET_URL` | string |  | A `/zk-config` base the server fetches missing prover keys from (`<url>/<contract>/keys/<circuit>.prover`, verified against `keys/manifest.json`); `none`/`off` disables the fetch. Unset: the release tag on raw.githubusercontent.com for the shipped contracts, no source for others. Offline installs run `nightgate-fetch-keys` once. |
| `NIGHTGATE_CONTRACTS_DIR` | string |  | Root directories (path-delimiter separated) a runtime `registerContract` (admin, 0.21.0) may point into; default: the package's and the working directory's `contracts/`. Importing an artifact executes its module, so paths outside are refused. The supported way to keep a consumer's artifacts outside the package: point it at that directory. The artifact's `@midnight-ntwrk/compact-runtime` import resolves from NIGHTGATE's own node_modules (worker snapshots since 0.21.0, the registration probe since 0.22.0), so the directory needs no node_modules of its own. |
| `NIGHTGATE_PRIVATE_STATE_BACKEND` | `cap-db` / `level` |  | Override `privateStateBackend` |
| `NIGHTGATE_GRANTEE_BINDING` | `wallet` / `did` / `custom` |  | Override `granteeBinding` (`wallet` / `did` / `custom`) |
| `NIGHTGATE_ALLOW_SELF_SERVICE_GRANTEE_REGISTRATION` | bool |  | Override `allowSelfServiceGranteeRegistration` (`false` / `0` / `no` / `off` disables) |
| `NIGHTGATE_CLOSE_SESSIONS_ON_RESTART` | bool |  | Override `closeSessionsOnRestart` (default on): `false` keeps the previous process's wallet sessions open across a restart |
| `NIGHTGATE_INSTANCE_ID` | string |  | Stable operator-provided instance identifier; otherwise CF instance GUID, hostname, or a generated UUID |
| `NIGHTGATE_REPLICA_COUNT` | int (min 1) |  | Actual process/replica count. Must be `1`; takes precedence over CDS `replicaCount` |
| `NIGHTGATE_ALLOW_PRODUCTION_SQLITE` | bool | `false` | `true` temporarily permits production SQLite with a high-severity warning; intended only for a migration window |
| `NIGHTGATE_ASSUME_DB_NETWORK` | string |  | Confirms which network an index written before 0.16.2 (rows without a recorded network id) belongs to; the boot guard refuses to bind such an index to the configured network otherwise. |
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
| `NIGHTGATE_PREWARM_SYNC_TIMEOUT_MS` | ms (min 1) | `43200000` | Absolute ceiling for the `connectWalletForSigning` prewarm sync-to-tip wait; default `43200000` (12 h, 0.21.0; was 3 h). A backstop: the primary bound is `NIGHTGATE_PREWARM_STALL_MS`. |
| `NIGHTGATE_PREWARM_STALL_MS` | ms (min 0) | `600000` | Prewarm fails when `appliedIndex` has not advanced for this long, regardless of elapsed time; default `600000` (10 min). A slow-but-moving sync is not stalled. `0` disables the stall bound (ceiling only). Read in the wallet worker. |
| `NIGHTGATE_SYNC_PROGRESS_STALE_S` | int (min 1) | `60` | `getWalletSyncProgress` reports `stale: true` once its snapshot is older than this; default `60` (four worker push intervals). |
| `NIGHTGATE_WALLET_READ_SYNC_TIMEOUT_MS` | ms (min 0) | `10000` | Bounded sync gate for facade-backed read actions (`getWalletBalance`, fee estimates): a catching-up facade answers 503 `WALLET_SYNCING` after this instead of parking the request; default `10000`, `0` waits indefinitely. |
| `NIGHTGATE_BALANCE_SYNC_TIMEOUT_MS` | ms (min 1) | `180000` | Worker-side wait for a genuine wallet sync before balancing a transaction; default `180000`. Read in the wallet worker. |
| `NIGHTGATE_SYNC_TIP_GAP` | int (min 0) | `8` | Blocks behind the indexer tip a wallet may be and still count as synced; default `8`. Read in the wallet worker. |
| `NIGHTGATE_SYNC_FRESHNESS_MS` | ms (min 1) | `300000` | How old the indexer's latest block may be for a wallet to count as synced (guards against a lagging self-hosted indexer, error 117); default `300000`. Read in the wallet worker. |
| `NIGHTGATE_PROGRESS_WATCH_MS` | ms (min 15000) | `60000` | Interval of the worker's idle progress watch that keeps `getWalletSyncProgress` fresh while a facade is behind; default `60000`, floor 15 s. Read in the wallet worker. |
| `NIGHTGATE_SAVE_INTERVAL_MS` | ms (min 10000) | `60000` | Wallet-state save tick of the worker; default `60000` (0.21.6, was 30 s), floor 10 s. Read in the wallet worker. |
| `NIGHTGATE_RESTORE_SAVE_ACK_TIMEOUT_MS` | ms (min 1) | `30000` | How long a facade restore waits for the acknowledgement of its immediate re-save; default `30000`. Read in the wallet worker. |
| `NIGHTGATE_DUST_COLD_START` | bool | `false` | `true` starts the dust sub-wallet from the secret key instead of the persisted state (diagnostic). Read in the wallet worker. |
| `NIGHTGATE_DUST_REGISTER_SETTLE_MS` | ms (min 0) | `90000` | How long `registerForDustGeneration` waits for the registration to apply locally before it reports `settled: false`; default `90000`. Read in the wallet worker. |
| `NIGHTGATE_SIGNING_KEY_RATE_LIMIT` | int (min 1) | `10` | `connectWalletForSigning` attempts per hour per principal; default `10`. |
| `NIGHTGATE_FEE_SPONSOR_SESSION` | list |  | Comma list of platform fee-sponsor session ids (the pool); overrides `feeSponsorSessions`. |
| `NIGHTGATE_SUBMIT_TRANSPORT_RETRIES` | int (min 0) | `2` | Resends of the SAME finalized transaction when the send itself fails (websocket closed at submit, `1000 Normal Closure`, `ECONNRESET`; never a node reject, never a reply-less wait), 0.22.0; default `2`, `0` disables. No rebuild, no re-proving: the facade re-pends the spends and the identical bytes go out again. Applies to every bound submit (deploy/call/batch, sends, dust registration, bound sponsoring). Read in the wallet worker. |
| `NIGHTGATE_SUBMIT_TRANSPORT_BACKOFF_MS` | ms (min 0) | `5000` | Pause before such a resend; default `5000`. Read in the wallet worker. |
| `NIGHTGATE_SUBMIT_LANDED_PROBE_MS` | ms (min 0) | `30000` | How long the worker polls the indexer for the transaction identifier before a resend, and after a resend was rejected (a reply lost on the first send may still have reached the node); default `30000`. A landed transaction is reported as submitted only with ledger result `SUCCESS`; in a block but not applied fails as `TxFailed` (fee spent). Read in the wallet worker. |
| `NIGHTGATE_SUBMIT_WATCH_TIMEOUT_MS` | ms (min 1) | `60000` | How long a bound submit waits for the node's first status after the send before the outcome counts as ambiguous (reconciled by identifier, never resent); default `60000`. Read in the wallet worker. |
| `NIGHTGATE_BATCH_SEGMENT_MODE` | `rewrite` / `observe` | `rewrite` | Batch segment ordering: `rewrite` (deterministic stage-grouped order) or `observe` (log only). Read in the wallet worker. |
| `NIGHTGATE_SPONSOR_POLICY_FILE` | path |  | Path to a JSON file `{ "allowedContracts": [], "allowedCircuits": [], "allowDeploy": false, "allowedTokenTypes": [] }` that replaces `NIGHTGATE_SPONSOR_ALLOWED_CONTRACTS`/`_CIRCUITS` while set (0.21.0). Calls on a grant's `deployedContracts` are exempt from `allowedCircuits` (0.21.2). Re-read per sponsored call behind an mtime cache, so the sponsor policy changes without a container recreate. Fail-closed: an unreadable or invalid file keeps the last good policy, and with none loaded yet sponsored calls answer `503 SPONSOR_POLICY_UNAVAILABLE`. |
| `NIGHTGATE_SPONSOR_ALLOWED_CONTRACTS` | list |  | Comma list of contract addresses a sponsor pays for (platform floor); empty = any. Replaced by `NIGHTGATE_SPONSOR_POLICY_FILE` while that is set. |
| `NIGHTGATE_SPONSOR_ALLOWED_CIRCUITS` | list |  | Comma list of circuit names a sponsor pays for (platform floor); empty = any. Replaced by `NIGHTGATE_SPONSOR_POLICY_FILE` while that is set. |
| `NIGHTGATE_SPONSOR_ALLOWED_TOKEN_TYPES` | list |  | Comma list of raw shielded token types (64 hex, what `deriveTokenType` returns) whose zswap offers the sponsor also pays for (0.22.0): a contract minting its own token to the caller, a caller spending that token into the contract. Unset = no offer at all (the default, unchanged). Also `allowedTokenTypes` in the policy file and on a grant (effective = floor ∩ grant; the floor must open it, a grant only narrows). The shape check then requires every net change of the offer (`deltas`, public per type) to be on a listed type, never NIGHT, every contract-owned coin to belong to a sponsorable contract, and a net change to exist OR a coin in the offer to be owned by a sponsorable contract (a burn nets to zero by construction: user input, contract transient, burn-address output; a zero-net offer without a contract coin is refused). User outputs are commitments, so a transfer of a listed type between users riding along is accepted by design: the sponsor pays dust, no sponsor value moves. An invalid entry fails closed (`503 SPONSOR_POLICY_UNAVAILABLE`). |
| `NIGHTGATE_SPONSOR_ALLOW_DEPLOY` | bool | `false` | Opens sponsored contract DEPLOYS on this deployment (0.21.0): `true`/`1`/`yes`. Off by default. A token caller additionally needs `allowDeploy` on its grant with deploy budget left; a plain caller inherits the floor. Also settable as `allowDeploy` in `NIGHTGATE_SPONSOR_POLICY_FILE`. |
| `NIGHTGATE_SPONSOR_MAX_TX_BYTES` | int (min 1) | `65536` | Byte ceiling of a sponsored call transaction the worker accepts; default `65536`. Read in the wallet worker. |
| `NIGHTGATE_SPONSOR_MAX_DEPLOY_BYTES` | int (min 1) | `40960` | Byte ceiling of a sponsored DEPLOY transaction (a deploy writes verifier keys on chain and costs a multiple of a call); default `40960`. Read in the wallet worker. |
| `NIGHTGATE_SPONSOR_WAIT` | `inblock` / `finalized` | `inblock` | Submission stage the unbound sponsor path waits for: `inblock` (default) or `finalized`. Read in the wallet worker. |
| `NIGHTGATE_SPONSOR_INDEXER_VISIBLE_MS` | ms (min 0) | `30000` | After InBlock, bounded wait until the public indexer shows the sponsored transaction; `0` skips the wait; default `30000`. Read in the wallet worker. |
| `NIGHTGATE_SPONSORED_CALLER_SYNC` | `wait` / `skip` | `wait` | `skip` omits the caller-side wallet sync when balancing a sponsored transaction (vault calls move no caller value). Read in the wallet worker. |
| `NIGHTGATE_NOTE_LEASE_MS` | ms (min 1) | `300000` | Lease on a dust note backing a sponsored transaction (parallel sponsoring from one wallet); a non-positive or non-numeric value falls back to the default `300000`. Read in the wallet worker. |
| `NIGHTGATE_BACKING_WAIT_MS` | ms (min 0) | `300000` | How long an unbound sponsoring waits for a free dust backing before it refuses; default `300000`. Read in the wallet worker. |
| `NIGHTGATE_SPONSOR_PREWARM_SYNC_MS` | ms (min 0) | `1800000` | Prewarm brings pool members to the chain tip one at a time (0.21.4); this caps the wait per sponsor, default 30 min, `0` = build only. |
| `NIGHTGATE_SPONSOR_STATUS_TIMEOUT_MS` | ms (min 1) | `45000` | Per-sponsor read cap of `getSponsorPoolStatus`; default `45000`. |
| `NIGHTGATE_SPONSOR_LEASE_WAIT_MS` | ms (min 0) | `120000` | How long a sponsored job waits for a busy or cooling sponsor before it fails over or gives up; default `120000`. |
| `NIGHTGATE_SPONSOR_COOLDOWN_MS` | ms (min 0) | `120000` | Bench time of a sponsor after a retryable failure; default `120000`. |
| `NIGHTGATE_SPONSOR_DUST_RETRIES` | int (min 0) | `4` | Rebuild-retries of a sponsored transaction on a dust race, on the same sponsor; default `4`. |
| `NIGHTGATE_SPONSOR_DUST_BACKOFF_MS` | ms (min 0) | `5000` | Pause before such a rebuild; default `5000`. |
| `ENCRYPTION_KEY` | secret |  | At-rest secret (32+ byte hex) for viewing keys, seed keys and encrypted job commands; key id `1` of the ring. Without any key a random per-process dev key is used (rows do not survive a restart); **required** in production. Env only, no CAP mapping. |
| `ENCRYPTION_KEYS` | secret |  | Key ring `id=secret,id=secret` (ids `[A-Za-z0-9_-]{1,16}`); `ENCRYPTION_KEY` joins it as id `1`. Every secret is HKDF-stretched; ciphertexts are `v2:<keyId>:...` envelopes (per-row data key wrapped by the ring key, key id bound as AAD). Pre-0.23 `iv:tag:data` values stay readable under id `1`. Env only, no CAP mapping. |
| `ENCRYPTION_KEY_ACTIVE` | string |  | Id of the ring key new ciphertexts are written under (required with more than one key). Startup refuses a database whose ciphertexts name a key id outside the ring; `nightgate-rewrap-keys` moves rows to the active key (see docs/operations.md, key rotation). Env only, no CAP mapping. |
<!-- config-table:end -->

Read by the standalone image and the dev scripts, not by the plugin:

| Variable | Purpose |
|---|---|
| `NIGHTGATE_DB_URL` | Standalone image (0.21.1): `postgres://user:pw@host:5432/db` selects PostgreSQL; the schema is deployed on every boot (`cds deploy`, additive). `?sslmode=`: `disable`, `require` (TLS unverified) or `verify-full` (chain + hostname, `sslrootcert=<pem>` optional); `allow`/`prefer`/`verify-ca` and unknown values refuse to start. Unset = SQLite file at `NIGHTGATE_DB_PATH`. |
| `NIGHTGATE_DB_DEPLOY` | Standalone image with `NIGHTGATE_DB_URL`: `auto` (default) deploys the schema at boot, `never` skips it. |
| `NIGHTGATE_DB_WAIT_SECONDS` | Standalone image `migrate` mode: seconds to wait for the PostgreSQL listener before `cds deploy` (default 60; 1..86400, other values refuse; each connect attempt is capped at the time left, so a dropped SYN cannot outlive the window). |
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

NIGHTGATE runs two independent flows that meet at one reconciliation point. The full diagram lives in [architecture.md#the-two-pipelines](architecture.md#the-two-pipelines).

| Pipeline | Where it runs | What it does |
|---|---|---|
| **Block crawler** | Main thread | Catch-up + live block subscription via Substrate RPC; writes Blocks/Tx/Actions/UTXOs/Balances into CAP DB |
| **Wallet SDK** | `worker_threads` worker | ZK-aware wallet ops: shielded/unshielded/dust sub-wallets, transfer/contract submission via the Midnight indexer + prover (proof server or in-process wasm) |

They do not meet on a hash (a job's identifier, the crawler's extrinsic hash and the indexer's transaction hash are three different values). The indexer confirmer resolves a job by its identifier and records the inclusion's block height and hash (`chainBlockHeight`, `chainBlockHash`, `indexerTxHash`) on the job and its `PendingSubmissions` row; a reorg rollback reverts every outcome confirmed at or above the fork height.

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
5. **Later, async**: the indexer confirmer resolves the identifier → `chainStatus`, block height/hash on the job, the attempt row flips to `finalized`

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
Pool (0.21.3): the plugin defaults `cds.features.use_generic_pool` to `true`
at registration (CAP's built-in pool loses a connection per timed-out
acquire and empties under load; `generic-pool` ships as a dependency), an
explicit host value wins. Size the pool for the worker's snapshot writes:
`cds.requires.db.pool` `{ max: 20, acquireTimeoutMillis: 30000,
destroyTimeoutMillis: 5000 }` and `cds.requires.db.client`
`{ connectionTimeoutMillis: 10000 }` are what the standalone image uses.
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
- `external_execution` WITHOUT a `txHash` becomes `failed /
  PROCESS_RESTART_BEFORE_BROADCAST` (0.23.0): every submitting path
  announces its identifier to the main thread and broadcasts only after it
  is persisted, so a hash-less row never sent anything;
- `external_execution` with a `txHash`, or `submitted`, becomes
  `reconciliation_required / PROCESS_RESTART_RECONCILE`;
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
and later `success` or `failure` only after the indexer confirmer resolves the
job's ledger identifier to a finalized transaction result; `chainFinalizedAt`
records when that evidence became available and `chainBlockHeight` /
`chainBlockHash` / `indexerTxHash` where the indexer places the inclusion. The
crawler cannot provide this evidence (it indexes the extrinsic hash, a
different value); it uses the recorded block height to revert outcomes on a
reorg. Predicate workflow parents aggregate their
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
AES-256-GCM ciphertext (`commandEncoding = aes-gcm-v1`) under the active ring key;
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

The `PrivateStates`, `ContractSigningKeys` and `WalletSyncStates` rows are encrypted (PBKDF2 + AES-GCM) under passwords derived from a per-account data key (`AccountKeys`). That key is sealed twice: under the ring's active key, so `nightgate-rewrap-keys` rotates it without the wallet's viewing key, and under the viewing-key-derived storage password, so a session that presents its viewing key opens it even after the ring rotated (and re-seals it under the active key). The ring alone therefore opens an account's rows; the viewing key alone opens nothing. Rows written before the account key (`keyScheme` null) are under ring key + viewing key or viewing key only: a session read migrates them, the rewrap tool migrates the ones a stored viewing key reaches and reports the rest, and the ring key they were written under must stay until none remain. A sync-state blob nobody can open is treated as no cached state (the wallet re-syncs). Losing every ring key means stored viewing/seed keys and account keys become unreadable - back the secrets up separately. For private state migration, use `exportPrivateStates({ password })` to produce a portable encrypted blob.

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
- `ContractActions` (one row per `Midnight` pallet extrinsic with its action
  type; `address` and `state` are null until the ledger payload is decoded),
  `ContractBalances`
- `UnshieldedUtxos` (written only by a decoder of the ledger payload; the
  crawler does not derive UTXOs from the extrinsic envelope)
- `ZswapLedgerEvents`, `DustLedgerEvents`
- `NightBalances` (same: no balance is derived from the extrinsic envelope)
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
