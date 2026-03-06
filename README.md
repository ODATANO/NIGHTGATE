# @odatano/nightgate

**CAP Plugin — Midnight Blockchain Indexer with OData V4 API**

[![npm](https://img.shields.io/npm/v/@odatano/nightgate)](https://www.npmjs.com/package/@odatano/nightgate)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

---

## What is @odatano/nightgate?

A self-contained **Midnight blockchain indexer** packaged as an SAP CAP plugin. It crawls blocks directly from a Midnight Node via Substrate RPC, stores them in local SQLite, and exposes the data as OData V4 endpoints.

```
Midnight Node (ws://localhost:9944)
    │  Substrate RPC
    ▼
ODATANO-NIGHTGATE Crawler
    │  Block Processing + Reorg Detection
    ▼
SQLite (local)
    │  CDS Query Layer
    ▼
OData V4 API  →  SAP Fiori, Excel, Power BI, REST clients
```

> **Looking for privacy-preserving attestations via ZK proofs?**
> Install [`@odatano/night-attestation`](../attestation/) alongside this package.

---

## Quick Start

### 1. Start a Midnight Node

```bash
docker compose -f docker/docker-compose.yml up -d
```

This starts a local Midnight Node in dev mode (`CFG_PRESET=dev`). The node produces blocks every ~8 seconds without needing testnet connectivity.

### 2. Install & Run

```bash
npm install @odatano/nightgate @cap-js/sqlite
cds watch
```

The crawler connects to the node, catches up on historical blocks, and then follows the chain tip in real-time:

```
[cds] - serving NightgateService { at: '/api/v1/nightgate' }
[cds] - serving NightgateIndexerService { at: '/api/v1/indexer' }
[cds] - serving NightgateAnalyticsService { at: '/api/v1/analytics' }
[cds] - serving NightgateAdminService { at: '/api/v1/admin' }

[MidnightNode] Connected to ws://localhost:9944
[Crawler] Catch-up: 0 → 142 (143 blocks, finalized)
[Crawler] Catch-up complete: 143 blocks in 0.8s
[Crawler] Live subscription active
```

### 3. Query via OData

```bash
# Latest blocks
curl http://localhost:4004/api/v1/nightgate/Blocks?\$top=5\&\$orderby=height%20desc

# Block with transactions expanded
curl http://localhost:4004/api/v1/nightgate/Blocks?\$expand=transactions

# Indexer health
curl http://localhost:4004/api/v1/indexer/getHealth()
```

---

## Consumer Integration (CAP Plugin)

Install `@odatano/nightgate` into any existing CAP app:

```bash
cd my-cap-app
npm install @odatano/nightgate @cap-js/sqlite
```

Add to `package.json`:

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

Run `cds watch` — all Nightgate services auto-register. The crawler starts indexing from the configured node.

### Local Development (This Repository)

```bash
npm ci
npm run dev
```

`npm run dev` is the preferred local entry point. It delegates to `npm run cds:watch`, which starts CAP directly from the TypeScript source tree. No manual build step is required before local development.

Useful scripts:

| Script | When to use it |
|---|---|
| `npm run dev` | Preferred local development command from `.ts` sources with auto-reload |
| `npm run cds:watch` | Direct CAP watch alias used by `npm run dev` |
| `npm run build` | Compile `src/` and `srv/` in-place for packaging or a production-style local run |
| `npm run build:plugin` | Explicit plugin-packaging build alias used by `npm run build` |
| `npm start` | Build via `prestart`, then launch CAP from the compiled runtime layout |
| `npm run clean` | Remove generated `.js` and `.d.ts` plugin build artifacts |

---

## Features

| Feature | Description |
|---|---|
| **Self-Contained Indexer** | Crawls blocks directly from a Midnight Node via Substrate RPC. No external indexer dependency. |
| **OData V4 API** | Full blockchain data exposed as OData V4 — Blocks, Transactions, UTXOs, Contract Actions, and more. |
| **Real-Time Sync** | Catch-up on historical blocks, then live subscription for new blocks. Reorg detection and recovery. |
| **Prometheus Metrics** | `getMetrics()` endpoint returns Prometheus-compatible gauges (chain height, lag, throughput, errors). |
| **K8s Probes** | `getLiveness()` and `getReadiness()` for Kubernetes health checks. |
| **CORS & Security Headers** | Configurable CORS, CSP, X-Frame-Options, HSTS (production), and more. |
| **Correlation IDs** | `X-Correlation-ID` header auto-generated or propagated on every request. |
| **Config Validation** | Network, nodeUrl validated at startup with clear error messages. |
| **DB Auto-Migration** | Automatically deploys schema on first startup if tables are missing. |
| **Docker Log Rotation** | `json-file` driver with 50MB / 5 file rotation on all containers. |

---

## Services

| Service | Path | Description |
|---|---|---|
| **NightgateService** | `/api/v1/nightgate` | Blockchain data — Blocks, Transactions, UTXOs, Contracts, Balances, Governance |
| **NightgateIndexerService** | `/api/v1/indexer` | Sync status, health, Prometheus metrics, K8s probes, reorg history |
| **NightgateAnalyticsService** | `/api/v1/analytics` | Aggregated blockchain statistics |
| **NightgateAdminService** | `/api/v1/admin` | Wallet session management |

---

## Architecture: Crawler-First Indexing

@odatano/nightgate **is** the indexer. It connects directly to a Midnight Node via Substrate JSON-RPC 2.0 over WebSocket.

### Data Flow

```
┌──────────────────────────┐
│  Midnight Node           │
│  (Docker / Testnet)      │
│  ws://localhost:9944     │
└──────────┬───────────────┘
           │ Substrate RPC
           │ chain_getBlock, chain_subscribeNewHeads
           ▼
┌──────────────────────────┐
│  MidnightNodeProvider    │  srv/providers/MidnightNodeProvider.ts
│  JSON-RPC 2.0 Client     │  WebSocket, reconnect, request tracking
└──────────┬───────────────┘
           │
           ▼
┌──────────────────────────┐
│  Crawler                 │  srv/crawler/Crawler.ts
│  Catch-Up + Live Sync    │  Reorg detection, batch processing
└──────────┬───────────────┘
           │
           ▼
┌──────────────────────────┐
│  BlockProcessor          │  srv/crawler/BlockProcessor.ts
│  Parse + Transform       │  Atomic DB writes via db.tx()
└──────────┬───────────────┘
           │
           ▼
┌──────────────────────────┐
│  SQLite (local)          │  18 blockchain entities + SyncState, ReorgLog
└──────────┬───────────────┘
           │
           ▼
┌──────────────────────────┐
│  OData V4                │  4 CDS services
│  /api/v1/nightgate       │
│  /api/v1/indexer         │
│  /api/v1/analytics       │
│  /api/v1/admin           │
└──────────────────────────┘
```

---

## Configuration

### Minimal (Local Dev)

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

### Full Configuration

```json
{
  "cds": {
    "requires": {
      "nightgate": {
        "kind": "nightgate",
        "network": "testnet",
        "nodeUrl": "ws://localhost:9944",
        "crawler": {
          "enabled": true,
          "batchSize": 10,
          "requestTimeout": 30000
        }
      }
    }
  }
}
```

### Environment Variables

Node connectivity is configured via `cds.requires.nightgate.nodeUrl`.

| Variable | Description | Default |
|---|---|---|
| `ENCRYPTION_KEY` | AES-256 key for viewing key encryption at rest | Process-scoped fallback |

---

## Docker

### Default: Midnight Node Only

```bash
docker compose -f docker/docker-compose.yml up -d
```

### Health Checks

```bash
# Node health
curl http://localhost:9944/health

# Indexer health
curl http://localhost:4004/api/v1/indexer/getHealth()
```

---

## Production & Operations

### Monitoring

```bash
# Prometheus metrics
curl http://localhost:4004/api/v1/indexer/getMetrics()
```

Returns:
```
odatano_nightgate_chain_height 12345
odatano_nightgate_indexed_height 12340
odatano_nightgate_sync_lag 5
odatano_nightgate_blocks_per_second 2.50
odatano_nightgate_consecutive_errors 0
odatano_nightgate_uptime_seconds 86400
odatano_nightgate_sync_status 2
```

### K8s Health Probes

```yaml
livenessProbe:
  httpGet:
    path: /api/v1/indexer/getLiveness()
    port: 4004
readinessProbe:
  httpGet:
    path: /api/v1/indexer/getReadiness()
    port: 4004
```

### Security Headers

All responses include:
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Content-Security-Policy: default-src 'self'`
- `Strict-Transport-Security` (production only)

### Correlation IDs

Every request gets an `X-Correlation-ID` header — either propagated from incoming request or auto-generated.

### Testing

```bash
npm test                  # All tests with coverage
npm run test:unit         # Unit tests only
```

---

## Project Structure

```
.
├── cds-plugin.js                 # CAP auto-discovery entry point
├── db/
│   └── schema.cds                # 18 blockchain entities + indexer state
├── srv/
│   ├── nightgate-service.*       # Blockchain OData V4 API definition + handlers
│   ├── nightgate-indexer-service.* # Sync status, health, Prometheus metrics
│   ├── analytics-service.*       # Aggregated statistics
│   ├── admin-service.*           # Session management
│   ├── crawler/
│   │   ├── Crawler.ts            # Catch-up + live sync + reorg detection
│   │   └── BlockProcessor.ts     # Block parsing + atomic DB writes
│   ├── providers/
│   │   └── MidnightNodeProvider.ts # Substrate JSON-RPC 2.0 WebSocket client
│   ├── sessions/
│   │   └── wallet-sessions.ts    # Wallet session handlers + cleanup
│   ├── types/
│   │   ├── nightgate.ts          # Public configuration types
│   │   └── index.ts              # Public type entry point
│   ├── utils/
│   │   ├── scale.ts              # SCALE codec for Substrate extrinsics
│   │   ├── crypto.ts             # AES-256-GCM for viewing keys
│   │   ├── retry.ts              # Transient error detection + backoff
│   │   └── validation.ts         # Input validation
├── docker/
│   └── docker-compose.yml        # Midnight Node (dev mode)
└── test/
    └── unit/                     # Unit tests
```

---

## License

[Apache-2.0](LICENSE)

## Links

- [ODATANO GitHub](https://github.com/ODATANO)
- [Midnight Network](https://midnight.network/)
- [SAP CAP Documentation](https://cap.cloud.sap/docs/)
- [`@odatano/night-attestation`](../attestation/) — Privacy-preserving ZK attestations (companion package)