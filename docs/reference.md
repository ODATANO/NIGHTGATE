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
      "nightgate": { "kind": "nightgate" }
    }
  }
}
```

Sufficient for read-side. Defaults to `preprod`, `wss://rpc.preprod.midnight.network/`, the public Midnight indexer, `http://localhost:6300` for the proof server.

### Full

```json
{
  "cds": {
    "requires": {
      "nightgate": {
        "kind": "nightgate",
        "network": "preprod",
        "nodeUrl": "wss://rpc.preprod.midnight.network/",
        "corsOrigin": "*",
        "sessionTtlMs": 86400000,

        "indexerHttpUrl": "https://indexer.preprod.midnight.network/api/v4/graphql",
        "indexerWsUrl":   "wss://indexer.preprod.midnight.network/api/v4/graphql/ws",
        "proofServerUrl": "http://localhost:6300",
        "zkConfigBasePath": "./contracts",
        "privateStateBackend": "cap-db",
        "allowMainnetSubmission": false,

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
| `network` | `preprod` | `testnet` / `preprod` / `mainnet`; invalid values fall back to `preprod` with a warning |
| `nodeUrl` | `wss://rpc.preprod.midnight.network/` | Substrate RPC WebSocket |
| `indexerHttpUrl` | preprod indexer URL | Wallet SDK's `publicDataProvider` HTTP endpoint; NOT used by the crawler |
| `indexerWsUrl` | preprod indexer WS URL | Same, for subscriptions |
| `proofServerUrl` | `http://localhost:6300` | Required for any submission flow (deploy/call/send/shield/unshield/dust-gen) |
| `zkConfigBasePath` | `./contracts` | Base for resolving relative `contracts.<name>.zkConfigPath` |
| `privateStateBackend` | `cap-db` | `cap-db` (default, production-grade encrypted CAP-DB tables) or `level` (legacy SDK LevelDB, **dev-only**, blocked on worker-routed submissions) |
| `contracts` | `{}` | Map of `<ref>` → `{ artifactPath, privateStateId, zkConfigPath }`, loaded into the in-memory registry on plugin startup |
| `corsOrigin` | `*` | Reflected in `Access-Control-Allow-Origin` |
| `contentSecurityPolicy` | strict default | Set to `'off'` to disable, or a string to override |
| `sessionTtlMs` | `86400000` (24 h) | Wallet session lifetime |
| `crawler.enabled` | `true` | When `false`, services still load but block indexing is disabled |
| `crawler.nodeUrl` | top-level `nodeUrl` | Optional crawler-specific RPC override |
| `crawler.batchSize` | `10` | Blocks per catch-up batch |
| `crawler.fetchConcurrency` | `(default)` | Parallel RPC fetches during catch-up |
| `crawler.rpcBatchSize` | `(default)` | Substrate JSON-RPC batch size |
| `crawler.requestTimeout` | `30000` | RPC timeout (ms) |
| `allowMainnetSubmission` | `false` | Gate for mainnet submission. Stays off until [forum thread 1190](https://forum.midnight.network) (`1016 Immediately Dropped`) is resolved |

### Environment variables

| Variable | Purpose |
|---|---|
| `ENCRYPTION_KEY` | AES-256-GCM key (32-byte hex) for at-rest encryption of viewing keys + seed keys. Falls back to a dev key with warning if not set; **required** in production. |
| `NODE_ENV=production` | Enables HSTS, enforces `ENCRYPTION_KEY` |
| `NIGHTGATE_NETWORK` | Override `network` |
| `NIGHTGATE_NODE_URL` | Override `nodeUrl` |
| `NIGHTGATE_CRAWLER_NODE_URL` | Override `crawler.nodeUrl` |
| `NIGHTGATE_CRAWLER_ENABLED` | `false` / `0` / `no` / `off` disables the crawler at boot |
| `NIGHTGATE_FETCH_CONCURRENCY` | Override `crawler.fetchConcurrency` |
| `NIGHTGATE_RPC_BATCH_SIZE` | Override `crawler.rpcBatchSize` |
| `NIGHTGATE_INDEXER_HTTP_URL` | Override `indexerHttpUrl` (e.g. point at local indexer container) |
| `NIGHTGATE_INDEXER_WS_URL` | Override `indexerWsUrl` |
| `NIGHTGATE_PROOF_SERVER_URL` | Override `proofServerUrl` |
| `NIGHTGATE_PROOF_NETWORK` | Network passed to the proof-server container; defaults to `preprod` |
| `NIGHTGATE_ZK_CONFIG_BASE` | Override `zkConfigBasePath` |
| `NIGHTGATE_PRIVATE_STATE_BACKEND` | Override `privateStateBackend` |
| `INDEXER_SECRET` | 32-byte hex secret for the indexer container's `APP__INFRA__SECRET` |
| `INDEXER_UPSTREAM_NODE_URL` | Upstream Substrate RPC for the indexer container (default = hosted preprod) |
| `LACE_VIEWING_KEY` | Consumed by `scripts/start-wallet-sync.mjs` and `scripts/run-t15.mjs` to bootstrap a wallet session |
| `LACE_MNEMONIC` | BIP39 recovery phrase the scripts pass to `connectWalletForSigning`; NIGHTGATE HD-derives the per-role keys |
| `LACE_SEED_HEX` | Optional alternative to `LACE_MNEMONIC`: the full 64-byte BIP39 seed as 128 hex chars |
| `T15_DUST_WAIT_SECONDS` | `run-t15.mjs` parameter — how long to wait after dust registration |
| `T15_SKIP_DUST_REG` | `1` to skip dust registration step in `run-t15.mjs` |
| `NIGHTGATE_HEAP_MB` | Heap size for `scripts/dev.mjs` / `scripts/serve.mjs` (default `12288`) |

For local repository startup, drop these into a repo-root `.env`. The tracked template is at [.env.example](../.env.example).

## Runtime behavior

### Plugin lifecycle

- `cds-plugin.js` loads `src/plugin.ts`
- Model roots registered from `db/` and `srv/`
- Security middleware attached during CAP bootstrap
- `initialize()` runs on `cds.on('served')`:
  1. Auto-deploys CDS schema if `Blocks` table doesn't exist
  2. Applies SQLite tuning pragmas (WAL, 64 MB cache, 256 MB mmap)
  3. Loads `cds.requires.nightgate.contracts` into the contract registry
  4. Spawns the wallet worker thread (`startWalletWorker()`) and wires the state-save sink
  5. Starts the crawler if `enabled` (default true)
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

- On first startup, the package checks whether `midnight.Blocks` exists. If the schema is missing, it attempts `db.deploy()` automatically.
- If the Midnight node cannot be reached, the package logs a warning and continues in `offline` mode. Read-side requests are still served from cache; submission requests still work (they only need the indexer + proof server, not the node directly).
- If the wallet worker fails to start, the plugin logs a warning and continues — submission requests will return an error, read-side is unaffected.
- Repeated `initialize()` calls are idempotent.
- Contract registry loads from `cds.requires.nightgate.contracts` on every `initialize()`.

### Switching existing databases

`db/midnight.db` persists indexed data plus encrypted wallet state. When switching networks, delete `db/midnight.db*` first.

The `PrivateStates`, `ContractSigningKeys`, and `WalletSyncStates` tables are encrypted with passwords derived from the viewing key (via PBKDF2). Losing the `ENCRYPTION_KEY` env var means stored viewing/seed keys become unreadable — back it up separately. For private state migration, use `exportPrivateStates(password)` to produce a portable encrypted blob.

### Security middleware

The bootstrap middleware sets these headers on every response:

- `X-Correlation-ID`
- `Access-Control-Allow-Origin`
- `Access-Control-Allow-Methods`
- `Access-Control-Allow-Headers` (includes `X-Correlation-ID`)
- `Access-Control-Max-Age`
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `X-XSS-Protection: 0`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'`
- `Strict-Transport-Security` in production only

It also short-circuits `OPTIONS` requests with HTTP 204.

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
- `PendingSubmissions` — submission lifecycle audit trail
- `WalletSessions` — projection excludes `viewingKeyHash` and `encryptedViewingKey`; `encryptedSeedKey` also internal-only

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
| `DisclosureRoles` | Per-user disclosure-tier grants (`userId`, `role`, optional `scope`, `validFrom`/`validUntil`). Resolved per-request by `attachDisclosureRole`; granted via the authority-gated admin `grantRole`. |

New enums in `db/types.cds`:

- `PendingSubmissionStatus`: `pending` | `included` | `finalized` | `failed`
- `DisclosureRole`: `public_only` | `legitimate_interest` | `authority` (EU Battery Reg Annex XIII tiers)

## Capability matrix

| Area | Status |
|---|---|
| CAP plugin integration | ✅ Auto-registers models, security middleware, lifecycle hooks |
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
| Compact contracts | ⚠️ `counter` registered; `AttestationVault` deferred to T10-extended |
| Live preprod end-to-end (T15) | ⚠️ Blocked on dust accrual (chain economics, not code) |
| Mainnet submission | ❌ Gated by `allowMainnetSubmission: false` until forum 1190 resolves |
| Built-in authorization | ✅ `@requires` annotations; consumer app provides auth strategy |

## Project structure

See [../CLAUDE.md](../CLAUDE.md) for the full annotated directory tree. Key directories:

```
src/
  index.ts                          # initialize/shutdown/getStatus + lifecycle
  plugin.ts                         # cds-plugin.js entry, security middleware
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
  run-t15.mjs                       # end-to-end submission test
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
| `npm run t15` | End-to-end submission flow |
| `npm run build` | `cds:types` + `tsc -p tsconfig.build.json` (in-place compile) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm test` | Full Jest suite with coverage |
| `npm run test:unit` | Unit tests only |
| `npm run clean` | Remove generated `.js` / `.d.ts` artifacts |
| `npm run cds:types` | Regenerate `@cds-models` |

## Testing baseline

- 48 test suites
- 672 tests passing
- 0 failures
- Integration scripts pass against the real SDK (`smoke:sdk`, `integration:*`)

Run locally:

```bash
npm run typecheck
npm test
npm run smoke:sdk
```
