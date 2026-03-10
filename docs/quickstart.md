# Quickstart

This guide gets `@odatano/nightgate` from zero to first successful API call with the current `0.1.2` feature set.

It covers both supported entry points:

- run this repository directly
- use Nightgate as a CAP plugin in another app

## Prerequisites

- Node.js and npm
- Docker Desktop (only for local testnet mode)

## Option A: Run This Repository Directly

### 1. Install dependencies

```bash
npm ci
```

### 2. Choose the target environment

#### Preprod (default — no Docker needed)

```bash
npm run dev
```

Nightgate defaults to Preprod with the public RPC at `wss://rpc.preprod.midnight.network/`. No `.env` or extra config needed.

#### Testnet with local Docker node

```bash
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

If switching from a different network, delete `db/midnight.db*` first.

Nightgate starts CAP from the TypeScript source tree and then:

- registers its CAP models
- attempts schema deployment if the DB is still empty
- connects to the Midnight node
- runs historical catch-up
- switches to live indexing

Override the target via `NIGHTGATE_NETWORK` and `NIGHTGATE_NODE_URL` env vars or a repo-root `.env` file.

### 4. Check that the service is up

Expected service paths:

- `/api/v1/nightgate`
- `/api/v1/indexer`
- `/api/v1/analytics`
- `/api/v1/admin`

Typical startup output:

```text
[cds] - bootstrapping from { file: 'srv/server.ts' }
[cds] - serving NightgateService { at: '/api/v1/nightgate' }
[cds] - serving NightgateIndexerService { at: '/api/v1/indexer' }
[cds] - serving NightgateAnalyticsService { at: '/api/v1/analytics' }
[cds] - serving NightgateAdminService { at: '/api/v1/admin' }

[odatano-nightgate] Network: testnet
[odatano-nightgate] Node: ws://localhost:9944
[odatano-nightgate] Initializing crawler and starting catch-up...
[MidnightNode] Connected to ws://localhost:9944
[odatano-nightgate] Startup state: syncing (crawler started)
[Crawler] Live subscription active
```

The output above shows local standalone mode. For Preprod, the key lines should look like this instead:

```text
[odatano-nightgate] Network: preprod
[odatano-nightgate] Node: wss://rpc.preprod.midnight.network/
[MidnightNode] Connected to wss://rpc.preprod.midnight.network/
```

In standalone repo mode, CAP bootstraps through `srv/server.ts`, which imports the same Nightgate plugin hooks that `cds-plugin.js` provides in consumer apps.

Nightgate emits one explicit startup-state line:

- `syncing` when the crawler starts normally
- `stopped` when the plugin is unconfigured or the crawler is disabled
- `offline` when startup falls back after a node or runtime error

### 5. Make the first API calls

```bash
curl "http://localhost:4004/api/v1/indexer/getHealth()"
curl "http://localhost:4004/api/v1/indexer/getSyncStatus()"
curl "http://localhost:4004/api/v1/nightgate/Blocks?$top=5&$orderby=height desc"
curl "http://localhost:4004/api/v1/analytics/getBlockCount()"
```

If indexing has already started, you should see a non-empty sync state and block data.

## Option B: Use Nightgate In Another CAP App

### 1. Install the package

```bash
cd my-cap-app
npm install @odatano/nightgate @cap-js/sqlite
```

### 2. Add configuration

Add this to your `package.json`:

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

Nightgate defaults to Preprod. Override via env vars (`NIGHTGATE_NETWORK`, `NIGHTGATE_NODE_URL`) or CDS config.

### 3. Start the CAP app

```bash
cds watch
```

Nightgate is discovered through [cds-plugin.js](../cds-plugin.js) and registers itself automatically.

### 4. Verify the plugin endpoints

```bash
curl "http://localhost:4004/api/v1/indexer/getReadiness()"
curl "http://localhost:4004/api/v1/indexer/getMetrics()"
curl "http://localhost:4004/api/v1/nightgate/Transactions?$top=5"
```

## Useful Configuration

These are the most relevant runtime settings for first use:

```json
{
  "cds": {
    "requires": {
      "nightgate": {
        "kind": "nightgate",
        "corsOrigin": "*",
        "sessionTtlMs": 86400000,
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

Meaning of the main knobs:

- `network`: `testnet`, `preprod`, or `mainnet`
- `nodeUrl`: Midnight node WebSocket endpoint. For public Preprod use `wss://rpc.preprod.midnight.network/`
- `crawler.enabled`: disable active indexing but still expose services
- `crawler.batchSize`: progress batch size during catch-up
- `crawler.maxRetries`: retries per block before error handling kicks in
- `crawler.retryDelay`: base retry delay in milliseconds
- `crawler.requestTimeout`: RPC timeout in milliseconds
- `sessionTtlMs`: wallet session lifetime
- `corsOrigin`: value returned in `Access-Control-Allow-Origin`

## What You Can Use Immediately

After startup, these are the most useful entry points in `0.1.2`:

- blockchain reads through `/api/v1/nightgate`
- sync, health, readiness, liveness, metrics, and reorg history through `/api/v1/indexer`
- aggregate counts through `/api/v1/analytics`
- wallet session invalidation through `/api/v1/admin`

Current release scope is read-side first:

- indexing and persistence are included
- OData exposure is included
- wallet session storage and cleanup are included
- transaction build, sign, and submit flows are not included yet

## Troubleshooting

### Node unreachable

If the Midnight node cannot be reached, Nightgate does not crash the host app. It logs a warning and continues in offline mode.

Check:

- the node is running
- the configured `nodeUrl` is correct
- the endpoint uses `ws://` or `wss://`

### No block data yet

Check the indexer service first:

```bash
curl "http://localhost:4004/api/v1/indexer/getSyncStatus()"
curl "http://localhost:4004/api/v1/indexer/getHealth()"
```

If the DB is empty and the node is healthy, give the crawler a moment to catch up.

### Switching an existing workspace to Preprod

This repository persists indexed data in [../db/midnight.db](../db/midnight.db). If you previously ran against a different network, delete [../db/midnight.db](../db/midnight.db), [../db/midnight.db-shm](../db/midnight.db-shm), and [../db/midnight.db-wal](../db/midnight.db-wal) before the first Preprod run.

### Production encryption key

Wallet viewing keys are encrypted at rest. In production (`NODE_ENV=production`), `ENCRYPTION_KEY` **must** be set: the process will refuse to start without it. In development, a process-scoped fallback is used automatically.

## Related Docs

- [README.md](../README.md)
- [Reference](reference.md) — configuration, runtime behavior, full API surface
- [Release 0.1.2](release-0.1.2.md) — prepared release notes and publish checklist
- [CHANGELOG.md](../CHANGELOG.md)