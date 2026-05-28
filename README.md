# @odatano/nightgate

**SAP CAP plugin: Midnight blockchain indexer + transaction submission, exposed as OData V4.**

[![npm](https://img.shields.io/npm/v/@odatano/nightgate)](https://www.npmjs.com/package/@odatano/nightgate)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![Tests](https://img.shields.io/github/actions/workflow/status/ODATANO/NIGHTGATE/test.yaml?label=tests)](https://github.com/ODATANO/NIGHTGATE/actions)
[![Coverage](https://img.shields.io/codecov/c/github/ODATANO/NIGHTGATE)](https://codecov.io/gh/ODATANO/NIGHTGATE)

`@odatano/nightgate` ties a SAP CAP runtime directly to the [Midnight](https://midnight.network/) blockchain. A built-in crawler indexes blocks from a Substrate RPC node into CAP entities; a worker-thread-isolated wallet stack handles ZK-aware transaction submission (deploy/call Compact contracts, send NIGHT, shield/unshield, dust generation). The whole surface is exposed through standard OData V4 — no GraphQL, no SDK lock-in for consumers.

```text
                            ┌──────────────────────────────────────┐
                            │      Midnight Preprod / Mainnet      │
                            │   Substrate Node    GraphQL Indexer  │
                            └──────────────┬──────────────┬────────┘
                                           │              │
                            wss://         │ Substrate    │ GraphQL
                            JSON-RPC       │ RPC          │ HTTP + WS
                                           ▼              ▼
┌───────────────────────────────────────────────────────────────────────────┐
│  NIGHTGATE  (CAP plugin)                                                  │
│                                                                           │
│  Main thread                              Worker thread                   │
│  ┌──────────────────────┐                 ┌──────────────────────────┐    │
│  │  Crawler             │                 │  Wallet SDK              │    │
│  │  - BlockProcessor    │                 │  (Effect.ts fibers)      │    │
│  │  - reorg detection   │                 │  - facade.start (sync)   │    │
│  └─────────┬────────────┘                 │  - transferTransaction   │    │
│            │ atomic writes                │  - initSwap              │    │
│            ▼                              │  - registerForDustGen    │    │
│  ┌──────────────────────┐                 │  - deployContract        │    │
│  │  CAP DB              │◄────state-save──┤  - submitContractCall    │    │
│  │  (SQLite / HANA)     │   periodic save │                          │    │
│  └─────────┬────────────┘                 │ - private-state-rpc      │    │
│            │ OData V4                     └──────────┬───────────────┘    │
│            ▼                                         │                    │
│  4 services on /api/v1/{nightgate, indexer, analytics, admin}             │
└───────────────────────────────────────────────────────────────────────────┘
```

The wallet SDK lives in `worker_threads` because Midnight's Effect.ts fiber scheduler saturates the microtask queue during sync; isolating it keeps the main CAP request pipeline responsive.

## Highlights

| Capability | Status |
|---|---|
| Block-level indexing | ✅ Live + catch-up + reorg detection (`srv/crawler/`) |
| Wallet sessions | ✅ Read-only (viewing key) + signing (seed) with AES-256-GCM at rest |
| Contract deploy / call | ✅ Compact-compiled contracts (`deployContract`, `submitContractCall`) |
| Token transfer (shielded + unshielded) | ✅ `sendNight` with auto-detected receiver ledger |
| Cross-ledger shift | ✅ `shieldFunds` / `unshieldFunds` via SDK `initSwap` |
| Dust generation lifecycle | ✅ `registerForDustGeneration` / `deregisterFromDustGeneration` |
| Pre-flight diagnostics | ✅ `getWalletBalance`, `estimateSendNightFee`, `estimateShield/UnshieldFee` |
| Local Midnight indexer | ✅ Optional docker-compose service (`midnightntwrk/indexer-standalone`) |
| Offline mode | ✅ CAP app starts even if the upstream node is unreachable |

## Quick start

```bash
npm ci
npm run dev            # connects to public preprod RPC + hosted indexer
```

That's it for read-side + base config. For wallet signing + submission:

```bash
docker compose -f docker/docker-compose.yml up -d proof-server
$env:NODE_OPTIONS="--max-old-space-size=12288"   # PowerShell; wallet SDK needs ~8-12 GB heap
$env:NIGHTGATE_CRAWLER_ENABLED="false"           # optional; isolate sync workload
npm run serve:sync
```

For the full first-time-sync walkthrough see [docs/quickstart.md](docs/quickstart.md).

## Service surface

| Service | Path | What |
|---|---|---|
| `NightgateService` | `/api/v1/nightgate` | Blocks / transactions / wallet sessions / **token ops + contract ops** |
| `NightgateIndexerService` | `/api/v1/indexer` | Sync state, health, reorg history, Prometheus metrics, crawler control |
| `NightgateAnalyticsService` | `/api/v1/analytics` | Aggregate counts |
| `NightgateAdminService` | `/api/v1/admin` | Session invalidation |

## Write surface (NightgateService)

| Action | Purpose |
|---|---|
| `connectWallet(viewingKey)` | Open read-only session |
| `connectWalletForSigning(sessionId, seedHex)` | Upgrade with seed key; warms wallet SDK in worker |
| `disconnectWallet(sessionId)` | Close session, evict facade |
| `sendNight(sessionId, receiverAddress, amount, ttlIso?)` | Transfer NIGHT; ledger auto-detected from receiver address prefix |
| `shieldFunds(sessionId, amount, ttlIso?)` | Move own NIGHT unshielded → shielded |
| `unshieldFunds(sessionId, amount, ttlIso?)` | Move own NIGHT shielded → unshielded |
| `registerForDustGeneration(sessionId, dustReceiverAddress?)` | Register NIGHT UTXOs to start dust accrual |
| `deregisterFromDustGeneration(sessionId)` | Reverse: free UTXOs back to spendable |
| `deployContract(compiledArtifactRef, sessionId, initialPrivateState)` | Deploy a registered Compact contract |
| `submitContractCall(contractAddress, circuit, compiledArtifactRef, sessionId, args)` | Invoke a circuit on a deployed contract |

## Read surface (read-only functions)

| Function | Returns |
|---|---|
| `getWalletBalance(sessionId)` | Shielded + unshielded NIGHT balances, current DUST, registered UTXO counts |
| `estimateSendNightFee(sessionId, receiverAddress, amount, ttlIso?)` | DUST fee estimate for a transfer |
| `estimateShieldFee(sessionId, amount, ttlIso?)` | DUST fee for unshielded → shielded swap |
| `estimateUnshieldFee(sessionId, amount, ttlIso?)` | DUST fee for shielded → unshielded swap |
| `getSyncStatus()` / `getHealth()` / `getMetrics()` | Indexer operational state |
| Standard OData on `Blocks` / `Transactions` / `ContractActions` / `UnshieldedUtxos` / `NightBalances` | Full query surface with `$filter`, `$orderby`, `$top`, `$skip`, `$expand` |

For exhaustive signatures, error codes, and curl examples: [docs/actions.md](docs/actions.md).

## Documentation

- **[Quickstart](docs/quickstart.md)** — get from zero to first wallet-signed transaction
- **[Actions reference](docs/actions.md)** — every OData action + function with examples
- **[Architecture](docs/architecture.md)** — worker-thread design, submission flow, persistence model
- **[Operations](docs/operations.md)** — running NIGHTGATE day to day, scripts, local indexer, troubleshooting
- **[Reference](docs/reference.md)** — full configuration matrix + project structure
- **[Changelog](CHANGELOG.md)** — notable changes by version

## Use as a CAP plugin in another app

```bash
cd my-cap-app
npm install @odatano/nightgate @cap-js/sqlite
```

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

Then `cds watch`. Defaults to Preprod with public RPC + hosted indexer. Override via env vars or CDS config — see [docs/reference.md#configuration](docs/reference.md#configuration).

## Development

```bash
npm run dev                # cds watch with 12 GB heap (scripts/dev.mjs)
npm run serve:sync         # cds-serve with 12 GB heap — use this for long sync runs
npm run sync:start         # bootstrap a wallet session against the running server
npm run sync:probe         # check local Midnight indexer container status

npm run typecheck          # tsc --noEmit
npm run lint               # ESLint
npm test                   # Jest with coverage, 33+ suites, 435+ tests
npm run build              # Compile CDS types + TypeScript to JS

# Integration scripts (real SDK, no chain access required)
npm run smoke:sdk
npm run integration:providers
npm run integration:wallet-keys
npm run integration:wallet-facade
npm run integration:contract-registry
```

## License

[Apache-2.0](LICENSE)

## Links

- [ODATANO GitHub org](https://github.com/ODATANO)
- [Midnight Network](https://midnight.network/)
- [SAP CAP Documentation](https://cap.cloud.sap/docs/)
