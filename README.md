# @odatano/nightgate

**CAP Plugin - Midnight Blockchain Indexer with OData V4 API**

[![npm](https://img.shields.io/npm/v/@odatano/nightgate)](https://www.npmjs.com/package/@odatano/nightgate)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![Tests](https://img.shields.io/github/actions/workflow/status/ODATANO/NIGHTGATE/test.yaml?label=tests)](https://github.com/ODATANO/NIGHTGATE/actions)
[![Coverage](https://img.shields.io/codecov/c/github/ODATANO/NIGHTGATE)](https://codecov.io/gh/ODATANO/NIGHTGATE)


`@odatano/nightgate` is a self-contained Midnight blockchain indexer packaged as an SAP CAP plugin. It connects directly to a Midnight node over Substrate JSON-RPC WebSocket, normalizes chain data into CAP entities, and exposes it through OData V4 services.

This project integrates with the Midnight Network. For more information about the Midnight Network, please visit their website: [Midnight Network](https://midnight.network/).


```text
Midnight Node (local ws://localhost:9944 or remote wss://rpc.preprod.midnight.network/)
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

## Highlights

| Capability | Details |
|---|---|
| Direct node indexing | Connects over `ws://` or `wss://`; no external indexer required |
| CAP plugin auto-registration | Registers `db/` and `srv/` models automatically through `cds-plugin.js` |
| Catch-up plus live sync | Indexes historical finalized blocks, then subscribes to new heads |
| Reorg handling | Detects parent-hash mismatches, rolls back affected data, records `ReorgLog` |
| OData API | Blockchain, indexer, analytics, and admin services |
| Operational endpoints | Health, readiness, liveness, reorg history, Prometheus-style metrics |
| Wallet sessions | `connectWallet` / `disconnectWallet` with encrypted viewing-key storage |
| Offline mode | CAP app starts even if the node is unreachable |

Version `0.1.2` is a read-side first release. Transaction build/sign/submit flows are not yet included.

## Quick Start

### Preprod (default — no Docker needed)

```bash
npm ci
npm run dev
```

Nightgate defaults to Preprod with the public RPC at `wss://rpc.preprod.midnight.network/`. No `.env` or extra config required.

### Testnet with local Docker node

```bash
npm ci
docker compose -f docker/docker-compose.yml up -d
```

Create a `.env` in the repo root:

```env
NIGHTGATE_NETWORK=testnet
NIGHTGATE_NODE_URL=ws://localhost:9944
```

```bash
npm run dev
```

### Use as a CAP plugin

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
      "nightgate": { "kind": "nightgate" }
    }
  }
}
```

Then `cds watch`. Defaults to Preprod. Override via env vars or CDS config:

| Env var | CDS config key | Default |
|---|---|---|
| `NIGHTGATE_NETWORK` | `network` | `preprod` |
| `NIGHTGATE_NODE_URL` | `nodeUrl` | `wss://rpc.preprod.midnight.network/` |
| `NIGHTGATE_CRAWLER_NODE_URL` | `crawler.nodeUrl` | same as `nodeUrl` |

If switching an existing DB to a different network, delete `db/midnight.db*` first.

### Query The API

```bash
# Latest blocks
curl "http://localhost:4004/api/v1/nightgate/Blocks?$top=5&$orderby=height desc"

# Indexer health
curl "http://localhost:4004/api/v1/indexer/getHealth()"

# Prometheus-style metrics
curl "http://localhost:4004/api/v1/indexer/getMetrics()"
```

## Services

| Service | Path |
|---|---|
| `NightgateService` | `/api/v1/nightgate` |
| `NightgateIndexerService` | `/api/v1/indexer` |
| `NightgateAnalyticsService` | `/api/v1/analytics` |
| `NightgateAdminService` | `/api/v1/admin` |

## Documentation

- [Quickstart Guide](docs/quickstart.md): step-by-step from zero to first API call
- [Reference](docs/reference.md): configuration, runtime behavior, full API surface, project structure
- [Release 0.1.2](docs/release-0.1.2.md): prepared GitHub/npm release notes and publish checklist
- [Changelog](CHANGELOG.md): list of notable changes by version

## Development

```bash
npm run dev         # Start with auto-reload
npm run lint        # ESLint
npm run typecheck   # TypeScript check
npm run cds:types   # Regenerate @cds-models
npm test            # Full test suite with coverage
```

## License

[Apache-2.0](LICENSE)

## Links

- [ODATANO GitHub](https://github.com/ODATANO)
- [Midnight Network](https://midnight.network/)
- [SAP CAP Documentation](https://cap.cloud.sap/docs/)
