# @odatano/night-indexer

**CAP Plugin — Midnight Blockchain Indexer with OData V4 API**

[![npm](https://img.shields.io/npm/v/@odatano/night-indexer)](https://www.npmjs.com/package/@odatano/night-indexer)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

---

## What is @odatano/night-indexer?

A self-contained **Midnight blockchain indexer** packaged as an SAP CAP plugin. It crawls blocks directly from a Midnight Node via Substrate RPC, stores them in local SQLite, and exposes the data as OData V4 endpoints.

```
Midnight Node (ws://localhost:9944)
    │  Substrate RPC
    ▼
ODATANO-NIGHT Crawler
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
npm install @odatano/night-indexer @cap-js/sqlite
cds watch
```

The crawler connects to the node, catches up on historical blocks, and then follows the chain tip in real-time:

```
[cds] - serving MidnightService { at: '/api/v1/midnight' }
[cds] - serving MidnightIndexerService { at: '/api/v1/indexer' }
[cds] - serving MidnightAnalyticsService { at: '/api/v1/analytics' }
[cds] - serving MidnightAdminService { at: '/api/v1/admin' }

[MidnightCrawler] Connected to ws://localhost:9944
[MidnightCrawler] Catch-up: 0 → 142 (142 blocks)
[MidnightCrawler] Catch-up complete. Processed 142 blocks (178.2 blocks/s)
[MidnightCrawler] Live: subscribed to new block headers
```

### 3. Query via OData

```bash
# Latest blocks
curl http://localhost:4004/api/v1/midnight/Blocks?\$top=5\&\$orderby=height%20desc

# Block with transactions expanded
curl http://localhost:4004/api/v1/midnight/Blocks?\$expand=transactions

# Indexer health
curl http://localhost:4004/api/v1/indexer/getHealth()
```

---

## Consumer Integration (CAP Plugin)

Install `@odatano/night-indexer` into any existing CAP app:

```bash
cd my-cap-app
npm install @odatano/night-indexer @cap-js/sqlite
```

Add to `package.json`:

```json
{
  "cds": {
    "requires": {
      "db": { "kind": "sqlite" },
      "midnight": {
        "kind": "midnight",
        "network": "testnet",
        "nodeUrl": "ws://localhost:9944"
      }
    }
  }
}
```

Run `cds watch` — all indexer services auto-register. The crawler starts indexing from the configured node.

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
| **MidnightService** | `/api/v1/midnight` | Blockchain data — Blocks, Transactions, UTXOs, Contracts, Balances, Governance |
| **MidnightIndexerService** | `/api/v1/indexer` | Sync status, health, Prometheus metrics, K8s probes, reorg history |
| **MidnightAnalyticsService** | `/api/v1/analytics` | Aggregated blockchain statistics |
| **MidnightAdminService** | `/api/v1/admin` | Wallet session management |

---

## Architecture: Crawler-First Indexing

@odatano/night-indexer **is** the indexer. It connects directly to a Midnight Node via Substrate JSON-RPC 2.0 over WebSocket.

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
│  MidnightNodeProvider    │  lib/providers/MidnightNodeProvider.ts
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
│  /api/v1/midnight        │
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
      "midnight": {
        "kind": "midnight",
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
      "midnight": {
        "kind": "midnight",
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

| Variable | Description | Default |
|---|---|---|
| `MIDNIGHT_NODE_URL` | Override Midnight node WebSocket URL | `ws://localhost:9944` |
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
odatano_night_chain_height 12345
odatano_night_indexed_height 12340
odatano_night_sync_lag 5
odatano_night_blocks_per_second 2.50
odatano_night_consecutive_errors 0
odatano_night_uptime_seconds 86400
odatano_night_sync_status 2
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
packages/indexer/
├── cds-plugin.js                 # CAP auto-discovery entry point
├── db/
│   └── schema.cds                # 18 blockchain entities + indexer state
├── srv/
│   ├── midnight-service.cds      # Blockchain OData V4 API definition
│   ├── midnight-service.ts       # Service handler + crawler startup
│   ├── midnight-indexer-service.* # Sync status, health, Prometheus metrics
│   ├── analytics-service.*       # Aggregated statistics
│   ├── admin-service.*           # Session management
│   ├── crawler/
│   │   ├── Crawler.ts            # Catch-up + live sync + reorg detection
│   │   └── BlockProcessor.ts     # Block parsing + atomic DB writes
│   ├── utils/
│   │   ├── scale.ts              # SCALE codec for Substrate extrinsics
│   │   ├── crypto.ts             # AES-256-GCM for viewing keys
│   │   ├── retry.ts              # Transient error detection + backoff
│   │   └── validation.ts         # Input validation
│   └── lib/
│       └── midnight-client.ts    # Blockchain type definitions
├── lib/
│   ├── providers/
│   │   └── MidnightNodeProvider.ts   # Substrate JSON-RPC 2.0 WebSocket client
│   └── types/
│       ├── midnight.ts           # SDK config types
│       └── index.ts              # Public TypeScript API
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