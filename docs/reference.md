# Reference

Detailed configuration, runtime behavior, API surface, and development guide for `@odatano/nightgate`.

## Configuration

Configure the plugin only under `cds.requires.nightgate`.

If the service is configured with `kind: "nightgate"` but no `network`, the plugin stays idle instead of auto-starting the crawler.

### Minimal Configuration

```json
{
  "cds": {
    "requires": {
      "nightgate": {
        "kind": "nightgate",
        "network": "testnet"
      }
    }
  }
}
```

### Full Runtime Configuration

```json
{
  "cds": {
    "requires": {
      "nightgate": {
        "kind": "nightgate",
        "network": "testnet",
        "nodeUrl": "ws://localhost:9944",
        "corsOrigin": "*",
        "sessionTtlMs": 86400000,
        "crawler": {
          "enabled": true,
          "nodeUrl": "ws://localhost:9944",
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

### Configuration Reference

| Key | Default | Notes |
|---|---|---|
| `network` | `testnet` at runtime | Valid values are `testnet` and `mainnet`; invalid values log an error and fall back to `testnet` |
| `nodeUrl` | `ws://localhost:9944` | Should be a WebSocket endpoint; non-`ws`/`wss` values log a warning |
| `crawler.enabled` | `true` | When `false`, services still load but active indexing is disabled |
| `crawler.nodeUrl` | top-level `nodeUrl` | Optional crawler-specific node URL override |
| `crawler.batchSize` | `10` | Number of blocks per catch-up progress batch |
| `crawler.maxRetries` | `3` | Maximum retries per block before the crawler records an error |
| `crawler.retryDelay` | `2000` | Base retry delay in milliseconds; backoff is calculated from this |
| `crawler.requestTimeout` | `30000` | RPC timeout in milliseconds |
| `sessionTtlMs` | `86400000` | Wallet session lifetime in milliseconds |
| `corsOrigin` | `*` | Reflected in `Access-Control-Allow-Origin` |

### Environment Variables

| Variable | Purpose | Default |
|---|---|---|
| `ENCRYPTION_KEY` | AES-256-GCM key material for wallet viewing-key encryption | Process-scoped dev fallback; **required** in production (`NODE_ENV=production`) — startup fails without it |
| `NODE_ENV=production` | Enables HSTS response header; enforces `ENCRYPTION_KEY` presence | Off unless explicitly set |

## Runtime Behavior

### Plugin Lifecycle

- `cds-plugin.js` loads `src/plugin.ts`
- model roots are registered from `db/` and `srv/`
- middleware is attached during CAP bootstrap
- `initialize()` runs on `cds.on('served')`
- `shutdown()` runs on `cds.on('shutdown')`

### Startup And Failure Semantics

- On first startup, the package checks whether `midnight.Blocks` exists
- if the schema is missing, it attempts `db.deploy()` automatically
- if the Midnight node cannot be reached, the package logs a warning and continues in `offline` mode
- repeated `initialize()` calls are idempotent

### Security Middleware

The bootstrap middleware sets:

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

It also short-circuits `OPTIONS` requests with HTTP `204`.

## Programmatic API

```ts
import {
  initialize,
  shutdown,
  getStatus,
  NIGHTGATE_DEFAULTS
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

## Services And Endpoints

| Service | Path | What it exposes |
|---|---|---|
| `NightgateService` | `/api/v1/nightgate` | Core blockchain entities plus wallet connect/disconnect actions |
| `NightgateIndexerService` | `/api/v1/indexer` | Sync state, health, readiness, liveness, metrics, reorg history |
| `NightgateAnalyticsService` | `/api/v1/analytics` | Aggregated counts and analytics projections |
| `NightgateAdminService` | `/api/v1/admin` | Wallet session administration and invalidation |

### NightgateService

Entities:

- `Blocks`
- `Transactions`
- `TransactionResults`
- `TransactionSegments`
- `TransactionFees`
- `ContractActions`
- `ContractBalances`
- `UnshieldedUtxos`
- `ZswapLedgerEvents`
- `DustLedgerEvents`
- `SystemParameters`
- `DParameterHistory`
- `TermsAndConditionsHistory`
- `DustGenerationStatus`
- `NightBalances`
- `DustRegistrations`
- `TokenTypes`
- `WalletSessions`

Actions and functions:

- `Blocks.latest()`
- `Blocks.byHeight(height)`
- `Blocks.range(startHeight, endHeight, limit)`
- `Transactions.byHash(hash)`
- `Transactions.byType(txType, limit)`
- `ContractActions.byAddress(address)`
- `ContractActions.history(address)`
- `UnshieldedUtxos.byOwner(owner)`
- `UnshieldedUtxos.unspent()`
- `SystemParameters.current()`
- `DustGenerationStatus.byCardanoAddress(address)`
- `DustGenerationStatus.byCardanoAddresses(addresses)`
- `NightBalances.getBalance(address)`
- `NightBalances.getTopHolders(limit)`
- `DustRegistrations.byCardanoStakeKey(stakeKey)`
- `WalletSessions.connectWallet(viewingKey)`
- `WalletSessions.disconnectWallet(sessionId)`

### NightgateIndexerService

Functions:

- `getSyncStatus()`
- `getHealth()`
- `getReorgHistory(limit)`
- `getLiveness()`
- `getReadiness()`
- `getMetrics()`
- `pauseCrawler()`
- `resumeCrawler()`
- `reindexFromHeight(height)`

Prometheus metric names use the `odatano_nightgate_` prefix.

### NightgateAnalyticsService

Entities and functions:

- `BlockStatistics`
- `ContractStatistics`
- `getBlockCount()`
- `getTransactionCount()`
- `getContractCount()`
- `getAverageTransactionsPerBlock()`

### NightgateAdminService

Actions:

- `invalidateSession(sessionId)`
- `invalidateAllSessions()`

The admin projection excludes `encryptedViewingKey` from the OData response surface.

## Current Capability Matrix

| Area | Status | What works now | Boundaries in `0.1.0` |
|---|---|---|---|
| CAP plugin integration | Ready | Registers models from `db/` and `srv/`, wires bootstrap middleware, starts on CAP `served`, stops on CAP `shutdown` | Configure only through `cds.requires.nightgate` |
| Node connectivity | Ready | Connects to Midnight nodes over `ws://` or `wss://`, validates runtime config, warns on bad URLs | No separate multi-node failover layer yet |
| Catch-up and live sync | Ready | Replays finalized blocks, subscribes to new heads, retries transient failures | Single active crawler instance per process |
| Reorg recovery | Ready | Detects chain divergence, finds fork points, rolls back indexed data, records `ReorgLog` | Designed for operational correctness, not deep historical reconciliation jobs |
| Local persistence | Ready | Persists blocks, transactions, sync state, reorg state, and related read-side entities via CAP DB APIs | SQLite-first default; host app controls broader DB strategy |
| Core OData reads | Ready | Blocks, transactions, UTXO reads, balance lookups, governance/system-parameter reads, wallet-session actions, plus range/type query helpers (`Blocks.range`, `Transactions.byType`) | Data quality depends on what the current crawler/parser version extracts into the local DB |
| Indexer operations API | Ready | `getSyncStatus`, `getHealth`, `getReorgHistory`, `getLiveness`, `getReadiness`, `getMetrics`, `pauseCrawler`, `resumeCrawler`, `reindexFromHeight` | Focused on one running indexer instance |
| Wallet sessions | Ready | Connect/disconnect flows, encrypted viewing-key storage, TTL expiry, cleanup job, admin invalidation | Sessions track `sessionId` only; token-based validation is not yet implemented |
| Analytics | Ready | Block count, transaction count, contract count, average transactions per block, CDS aggregate projections | Analytics are read-side aggregates over indexed local data |
| Midnight domain surface | Partial | Schema and service surface already include contracts, balances, DUST, governance, registrations, token types | Some entity families are ahead of full extractor/populator depth and will mature incrementally |
| Write-side blockchain workflows | Not included | None | No transaction build, signing, submission, or wallet execution flow in this release |
| Built-in authorization model | Ready | `@requires: 'authenticated-user'` on `NightgateService` and `NightgateAnalyticsService`; `@requires: 'admin'` on `NightgateAdminService` | The consuming CAP app must configure its auth strategy (e.g., mock users for dev, JWT/XSUAA for production) |

## Development Commands

| Command | Use |
|---|---|
| `npm run dev` | Start CAP from TypeScript sources with auto-reload |
| `npm run cds:watch` | Direct CAP watch command |
| `npm run build` | Build the plugin in place for packaging/runtime verification |
| `npm start` | Build first, then run the compiled layout |
| `npm run clean` | Remove generated `.js` and `.d.ts` build artifacts |
| `npm run cds:types` | Regenerate `@cds-models` |
| `npm run lint` | Run ESLint |
| `npm run typecheck` | Run TypeScript without emitting output |
| `npm test` | Full Jest suite with coverage |
| `npm run test:unit` | Unit tests only |

## Testing

Verified repository baseline from the latest full run:

- `22` test suites passed
- `267` tests passed
- `0` failures
- coverage: `93.09%` statements, `81.77%` branches, `94.3%` functions, `93.62%` lines

Run the same checks locally:

```bash
npm run lint
npm run typecheck
npm test
```

## Project Structure

```text
.
├── cds-plugin.js
├── db/
│   └── schema.cds
├── docker/
│   └── docker-compose.yml
├── src/
│   ├── index.ts
│   └── plugin.ts
├── srv/
│   ├── admin-service.cds
│   ├── admin-service.ts
│   ├── analytics-service.cds
│   ├── analytics-service.ts
│   ├── nightgate-indexer-service.cds
│   ├── nightgate-indexer-service.ts
│   ├── nightgate-service.cds
│   ├── nightgate-service.ts
│   ├── crawler/
│   │   ├── BlockProcessor.ts
│   │   ├── Crawler.ts
│   │   └── index.ts
│   ├── providers/
│   │   └── MidnightNodeProvider.ts
│   ├── sessions/
│   │   └── wallet-sessions.ts
│   ├── types/
│   │   ├── index.ts
│   │   └── nightgate.ts
│   └── utils/
│       ├── cds-model.ts
│       ├── crypto.ts
│       ├── rate-limiter.ts
│       ├── retry.ts
│       ├── scale.ts
│       ├── sync-state.ts
│       └── validation.ts
├── test/
│   └── unit/
└── @cds-models/
```
