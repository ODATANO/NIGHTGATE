# NIGHTGATE - OData for Midnight @odatano/nightgate

![Header Image](/docs/readme_header.png)

**SAP CAP plugin: Midnight blockchain indexer + transaction submission, exposed as OData V4.**

[![Tests](https://github.com/ODATANO/NIGHTGATE/actions/workflows/test.yaml/badge.svg)](https://github.com/ODATANO/NIGHTGATE/actions/workflows/test.yaml)
[![Coverage](https://img.shields.io/codecov/c/github/ODATANO/NIGHTGATE)](https://codecov.io/gh/ODATANO/NIGHTGATE)
[![npm](https://img.shields.io/npm/v/@odatano/nightgate)](https://www.npmjs.com/package/@odatano/nightgate)
[![npm downloads](https://img.shields.io/npm/dt/@odatano/nightgate?logo=npm&label=downloads&color=blue)](https://www.npmjs.com/package/@odatano/nightgate)
[![SAP CAP](https://img.shields.io/badge/SAP%20CAP-%40sap%2Fcds%20%5E10-0faaff?logo=sap)](https://cap.cloud.sap/)
[![License](https://img.shields.io/badge/license-Apache--2.0-yellow)](LICENSE)

`@odatano/nightgate` ties a SAP CAP runtime directly to the [Midnight](https://midnight.network/) blockchain. A built-in crawler indexes blocks from a Substrate RPC node into CAP entities; a worker-thread-isolated wallet stack handles ZK-aware transaction submission (deploy/call Compact contracts, send NIGHT, shield/unshield, dust generation). The whole surface is exposed through standard OData V4 — no GraphQL, no SDK lock-in for consumers.

```text
                            ┌──────────────────────────────────────┐
                            │      Midnight Preview / Preprod      │
                            │   Substrate Node    GraphQL Indexer  │
                            └──────────────┬──────────────┬────────┘
                                           │              │
                            wss://         │ Substrate    │ GraphQL
                            JSON-RPC       │ RPC          │ HTTP + WS
                                           ▼              ▼
┌───────────────────────────────────────────────────────────────────────────┐
│  NIGHTGATE                                                                │
│                                                                           │
│  Main thread                              Worker thread                   │
│  ┌──────────────────────┐                 ┌──────────────────────────┐    │
│  │  Crawler             │                 │  Wallet SDK              │    │
│  │  - BlockProcessor    │                 │                          │    │
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

## Quick start

```bash
npm ci
npm run dev           
```

Configure the `.env` file (see `.env.example`) to point to a Substrate RPC node and a GraphQL indexer.

```bash
# target network
NIGHTGATE_NETWORK=preprod
 # Substrate RPC node                                                              
NIGHTGATE_NODE_URL=wss://rpc.preprod.midnight.network/
#  GraphQL indexer (HTTP only; WS derived from it)                                 
NIGHTGATE_INDEXER_HTTP_URL = "https://indexer.preview.midnight.network/api/v4/graphql"
# local proof server & wallets for submission (compose: midnightntwrk/proof-server on :6300)
NIGHTGATE_PROOF_SERVER_URL=http://localhost:6300                                     
NIGHTGATE_CRAWLER_ENABLED=false                   
ENCRYPTION_KEY=<random secret>                   
```

For the full first-time-sync walkthrough see [docs/quickstart.md](docs/quickstart.md).

## Services & capabilities

Four OData V4 services: **`NightgateService`** (`/api/v1/nightgate`: chain data, wallet sessions, all token / contract / attestation actions), **`NightgateIndexerService`** (`/api/v1/indexer`: sync state, health, metrics, crawler control), **`NightgateAnalyticsService`** (`/api/v1/analytics`: aggregate counts), **`NightgateAdminService`** (`/api/v1/admin`: session administration).

Submit actions are **async**: they return `{ jobId, status }`; poll `getJobStatus(jobId, sessionId)` for the result. Exhaustive signatures, error codes, and curl examples: [docs/actions.md](docs/actions.md).

| Capability | Surface |
|---|---|
| Block indexing | Live + catch-up crawler with reorg detection (`srv/crawler/`); standard OData (`$filter`, `$orderby`, `$top`, `$expand`) on `Blocks`, `Transactions`, `ContractActions`, `UnshieldedUtxos`, `NightBalances` |
| Wallet sessions | `connectWallet` (viewing key, read-only) upgraded via `connectWalletForSigning` (BIP39 mnemonic, HD-derived to match Lace); AES-256-GCM at rest, sessions bound to the requesting user |
| Token ops | `sendNight` (receiver ledger auto-detected), `shieldFunds` / `unshieldFunds`, `registerForDustGeneration` / `deregisterFromDustGeneration` |
| Fee sponsoring | Generation delegation (`registerForDustGeneration` with a foreign `dustReceiverAddress`, own dust address via `deriveWalletInfo`) and per-tx sponsorship (optional `sponsorSessionId` on all submit actions: a second session pays the dust fee; cross-user use gated via `NIGHTGATE_FEE_SPONSOR_SESSION`) |
| Pre-flight | `getWalletBalance`, `estimateSendNightFee`, `estimateShieldFee` / `estimateUnshieldFee`, `deriveWalletInfo` |
| Compact contracts | `deployContract` / `submitContractCall` on registered compiled artifacts |
| Document anchoring | `anchorDocument` / `verifyDocument`: sha256 hash on-chain, storage stays with the caller |
| ZK predicate attestations | `issuePredicateAttestation` / `issueFieldPredicateAttestation` (field-bound via content root): prove `value ≤/≥ threshold` without revealing the value; `verifyPredicateAttestation` to check |
| Crawler-free verification | `verifyAttestationState` / `verifyPredicateState` / `reindexDisclosures` read live contract state from the public indexer (per-call `network` override, no wallet, no local index) |
| Tiered disclosure (RBAC) | `grantDisclosure` / `revokeDisclosure` (+ `registerGranteeIdentity`), on-chain `DisclosureGrants` index, `AttestationService` mixin with EU Battery Reg tiers |
| Browser / connector | `@odatano/nightgate/browser` (providers, witnesses, `prepareAttest` / `prepareGrantDisclosure` / `prepareRevokeDisclosure`) + `GET /zk-config/<contract>/…` + `GET /contract-manifest`: a wallet-driven dApp (Lace) needs neither the Compact toolchain nor `managed/` artifacts |
| Operations | Health / liveness / readiness, Prometheus metrics, `pauseCrawler` / `resumeCrawler` / `reindexFromHeight`, offline start (boots without upstream node), optional local indexer via docker-compose |

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
      "nightgate": { "network": "preprod" }
    }
  }
}
```

Then `cds watch`. `network` is the only required key; everything else defaults to Preprod's public RPC + hosted indexer. Override via env vars or CDS config — see [docs/reference.md#configuration](docs/reference.md#configuration).

## Development

```bash
npm run dev                # cds watch with 12 GB heap (scripts/dev.mjs)
npm run serve:sync         # cds-serve with 12 GB heap — use this for long sync runs
npm run sync:start         # bootstrap a wallet session against the running server
npm run sync:probe         # check local Midnight indexer container status

npm run typecheck          # tsc --noEmit
npm run lint               # ESLint
npm test                   # Vitest with coverage, 63 suites, 1104 tests
npm run build              # Compile CDS types + TypeScript to JS

# Integration scripts (real SDK, no chain access required)
npm run smoke:sdk          # all SDK packages load
npm run integration:providers            # + wallet-keys, wallet-facade, contract-registry,
                                         #   connector-routes, attestation-vault, derive-wallet-info

# Live e2e against preprod (funded wallet required)
npm run deploy:e2e         # + predicate:e2e, disclosure:e2e, state-verify:e2e
```

## License

[Apache-2.0](LICENSE)

## Links

- [ODATANO GitHub org](https://github.com/ODATANO)
- [Midnight Network](https://midnight.network/)
- [SAP CAP Documentation](https://cap.cloud.sap/docs/)
