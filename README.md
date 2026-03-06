# @odatano/nightgate

**CAP Plugin - Midnight Blockchain Indexer with OData V4 API**

[![npm](https://img.shields.io/npm/v/@odatano/nightgate)](https://www.npmjs.com/package/@odatano/nightgate)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

## What It Is

`@odatano/nightgate` is a self-contained Midnight blockchain indexer packaged as an SAP CAP plugin. It connects directly to a Midnight node over Substrate JSON-RPC WebSocket, normalizes chain data into CAP entities, and exposes that data through OData V4 services.

Version `0.1.0` is intentionally a read-side first release: indexing, persistence, OData exposure, health/metrics, and wallet-session handling are in scope; transaction build/sign/submit flows are not.

It supports two main modes:

- **Plugin mode** inside another CAP app via `cds.requires.nightgate`
- **Standalone repo mode** from this repository via `npm run dev`

If the node is unavailable, the CAP app can still start and the package reports `offline` runtime status instead of crashing the host process.

```text
Midnight Node (ws://localhost:9944)
    |
    | Substrate RPC / WebSocket
    v
MidnightNodeProvider
    |
    | Catch-up, live sync, retry, reorg detection
    v
Crawler + BlockProcessor
    |
    | Atomic persistence via CAP DB API
    v
SQLite / CAP Database
    |
    | OData V4
    v
NightgateService / NightgateIndexerService / Analytics / Admin
```

If you also need privacy-preserving attestation flows, pair this package with `@odatano/night-attestation`.

For the fastest path from install to first API call, see [docs/quickstart.md](docs/quickstart.md).

## Highlights

| Capability | Current Behavior |
|---|---|
| Direct node indexing | Connects to a Midnight node over `ws://` or `wss://`; no external indexer required |
| CAP plugin auto-registration | Registers `db/` and `srv/` models automatically through `cds-plugin.js` |
| Catch-up plus live sync | Indexes historical finalized blocks, then subscribes to new heads |
| Reorg handling | Detects parent-hash mismatches, finds fork points, rolls back affected data, records `ReorgLog` |
| OData API | Exposes blockchain, indexer, analytics, and admin services |
| Operational endpoints | Health, readiness, liveness, reorg history, and Prometheus-style metrics |
| Wallet session support | `connectWallet` and `disconnectWallet` actions plus admin invalidation actions |
| Runtime hardening | CORS, correlation IDs, security headers, offline mode, auto-deploy attempt for missing schema |

See also [CHANGELOG.md](CHANGELOG.md) for the first-release summary.

## Current Capability Matrix

| Area | Status | What works now | Boundaries in `0.1.0` |
|---|---|---|---|
| CAP plugin integration | Ready | Registers models from `db/` and `srv/`, wires bootstrap middleware, starts on CAP `served`, stops on CAP `shutdown` | Configure only through `cds.requires.nightgate` |
| Node connectivity | Ready | Connects to Midnight nodes over `ws://` or `wss://`, validates runtime config, warns on bad URLs | No separate multi-node failover layer yet |
| Catch-up and live sync | Ready | Replays finalized blocks, subscribes to new heads, retries transient failures | Single active crawler instance per process |
| Reorg recovery | Ready | Detects chain divergence, finds fork points, rolls back indexed data, records `ReorgLog` | Designed for operational correctness, not deep historical reconciliation jobs |
| Local persistence | Ready | Persists blocks, transactions, sync state, reorg state, and related read-side entities via CAP DB APIs | SQLite-first default; host app controls broader DB strategy |
| Core OData reads | Ready | Blocks, transactions, UTXO reads, balance lookups, governance/system-parameter reads, wallet-session actions | Data quality depends on what the current crawler/parser version extracts into the local DB |
| Indexer operations API | Ready | `getSyncStatus`, `getHealth`, `getReorgHistory`, `getLiveness`, `getReadiness`, `getMetrics` | Focused on one running indexer instance |
| Wallet sessions | Ready | Connect/disconnect flows, encrypted viewing-key storage, TTL expiry, cleanup job, admin invalidation | Session auth policy is host-app specific |
| Analytics | Ready | Block count, transaction count, contract count, average transactions per block, CDS aggregate projections | Analytics are read-side aggregates over indexed local data |
| Midnight domain surface | Partial | Schema and service surface already include contracts, balances, DUST, governance, registrations, token types | Some entity families are ahead of full extractor/populator depth and will mature incrementally |
| Write-side blockchain workflows | Not included | None | No transaction build, signing, submission, or wallet execution flow in this release |
| Built-in authorization model | Not included by default | None enforced out of the box | `@requires` examples are commented; the consuming CAP app should decide auth policy |

## Quick Start

If you want the step-by-step version, use [docs/quickstart.md](docs/quickstart.md). The section below stays as the short form.

### Run This Repository Locally

```bash
npm ci
docker compose -f docker/docker-compose.yml up -d
npm run dev
```

`npm run dev` starts CAP directly from the TypeScript source tree through `cds watch`. No manual build step is required for local development.

Typical startup output looks like this:

```text
[cds] - serving NightgateService { at: '/api/v1/nightgate' }
[cds] - serving NightgateIndexerService { at: '/api/v1/indexer' }
[cds] - serving NightgateAnalyticsService { at: '/api/v1/analytics' }
[cds] - serving NightgateAdminService { at: '/api/v1/admin' }

[odatano-nightgate] Network: testnet
[odatano-nightgate] Node: ws://localhost:9944
[MidnightNode] Connected to ws://localhost:9944
[Crawler] Catch-up complete: ...
[Crawler] Live subscription active
```

### Use It As A CAP Plugin

Install the package into any CAP application:

```bash
cd my-cap-app
npm install @odatano/nightgate @cap-js/sqlite
```

Add Nightgate configuration to `package.json`:

```json
{
  "cds": {
    "requires": {
      "db": { "kind": "sqlite" },
      "nightgate": {
        "kind": "nightgate",
        "network": "testnet",
        "nodeUrl": "ws://localhost:9944"
      }
    }
  }
}
```

Then run:

```bash
cds watch
```

### Query The API

```bash
# Latest blocks
curl "http://localhost:4004/api/v1/nightgate/Blocks?$top=5&$orderby=height desc"

# Block with transactions expanded
curl "http://localhost:4004/api/v1/nightgate/Blocks?$expand=transactions"

# Indexer health
curl "http://localhost:4004/api/v1/indexer/getHealth()"

# Prometheus-style metrics
curl "http://localhost:4004/api/v1/indexer/getMetrics()"
```

## Configuration

Configure the plugin only under `cds.requires.nightgate`.

Important activation rule:

- If the service is configured with `kind: "nightgate"` but no `network`, the plugin stays idle instead of auto-starting the crawler.

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
| `ENCRYPTION_KEY` | AES-256-GCM key material for wallet viewing-key encryption | Process-scoped dev fallback |
| `NODE_ENV=production` | Enables HSTS response header | Off unless explicitly set |

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

The bootstrap middleware currently sets:

- `X-Correlation-ID`
- `Access-Control-Allow-Origin`
- `Access-Control-Allow-Methods`
- `Access-Control-Allow-Headers`
- `Access-Control-Max-Age`
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `X-XSS-Protection: 0`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'`
- `Strict-Transport-Security` in production only

It also short-circuits `OPTIONS` requests with HTTP `204`.

## Programmatic API

The package exports a small runtime API in addition to CAP plugin behavior:

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

Representative entities:

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

Representative actions:

- `Blocks.latest()`
- `Blocks.byHeight(height)`
- `Transactions.byHash(hash)`
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

Key functions:

- `getSyncStatus()`
- `getHealth()`
- `getReorgHistory(limit)`
- `getLiveness()`
- `getReadiness()`
- `getMetrics()`

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

Admin actions:

- `invalidateSession(sessionId)`
- `invalidateAllSessions()`

The admin projection excludes `encryptedViewingKey` from the OData response surface.

## Development Commands

| Command | Use |
|---|---|
| `npm run dev` | Start CAP from TypeScript sources with auto-reload |
| `npm run cds:watch` | Direct CAP watch command |
| `npm run build` | Build the plugin in place for packaging/runtime verification |
| `npm start` | Build first, then run the compiled layout |
| `npm run clean` | Remove generated `.js` and `.d.ts` build artifacts |
| `npm run lint` | Run ESLint |
| `npm run typecheck` | Run TypeScript without emitting output |
| `npm test` | Full Jest suite with coverage |
| `npm run test:unit` | Unit tests only |

## Testing

Current verified repository baseline from the latest full run:

- `18` test suites passed
- `245` tests passed
- `0` failures
- coverage: `98.97%` statements, `89.37%` branches, `99.25%` functions, `99.27%` lines

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
│       ├── crypto.ts
│       ├── rate-limiter.ts
│       ├── retry.ts
│       ├── scale.ts
│       └── validation.ts
├── test/
│   └── unit/
└── @cds-models/
```

## License

[Apache-2.0](LICENSE)

## Links

- [ODATANO GitHub](https://github.com/ODATANO)
- [ODATANO NIGHT repo](https://github.com/ODATANO/ODATANO-NIGHT)
- [Midnight Network](https://midnight.network/)
- [SAP CAP Documentation](https://cap.cloud.sap/docs/)