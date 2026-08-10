# NIGHTGATE - OData for Midnight @odatano/nightgate

![Header Image](/docs/readme_header.png)

**SAP CAP plugin: Midnight blockchain indexer + transaction submission, exposed as OData V4.**

[![Tests](https://github.com/ODATANO/NIGHTGATE/actions/workflows/test.yaml/badge.svg)](https://github.com/ODATANO/NIGHTGATE/actions/workflows/test.yaml)
[![Coverage](https://img.shields.io/codecov/c/github/ODATANO/NIGHTGATE)](https://codecov.io/gh/ODATANO/NIGHTGATE)
[![npm](https://img.shields.io/npm/v/@odatano/nightgate)](https://www.npmjs.com/package/@odatano/nightgate)
[![npm downloads](https://img.shields.io/npm/dt/@odatano/nightgate?logo=npm&label=downloads&color=blue)](https://www.npmjs.com/package/@odatano/nightgate)
[![SAP CAP](https://img.shields.io/badge/SAP%20CAP-%40sap%2Fcds%20%5E10-0faaff?logo=sap)](https://cap.cloud.sap/)
[![License](https://img.shields.io/badge/license-Apache--2.0-yellow)](LICENSE)

`@odatano/nightgate` ties a SAP CAP runtime directly to the [Midnight](https://midnight.network/) blockchain. A built-in crawler indexes blocks from a Substrate RPC node into CAP entities; a worker-thread-isolated wallet stack handles ZK-aware transaction submission (deploy/call Compact contracts, send NIGHT or custom tokens on both the shielded and the unshielded ledger, dust generation, fee sponsoring). The whole surface is exposed through standard OData V4.

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
│            │ atomic writes                │  - finalize (ZK prove)   │    │
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

Or standalone with Docker, no Node installation and no host app required
(published on every release, see [docs/docker.md](docs/docker.md)):

```bash
docker pull ghcr.io/odatano/nightgate:latest
docker run -d -p 4004:4004 \
  -e ENCRYPTION_KEY=$(openssl rand -hex 32) \
  -e NIGHTGATE_HTTP_PASSWORD=change-me \
  -v nightgate-data:/data \
  ghcr.io/odatano/nightgate:latest
```

Configure the `.env` file (see `.env.example`) to point to a Substrate RPC node and a GraphQL indexer.

```bash
# target network
NIGHTGATE_NETWORK=preprod
 # Substrate RPC node                                                              
NIGHTGATE_NODE_URL=wss://rpc.preprod.midnight.network/
#  GraphQL indexer (HTTP only; WS derived from it)                                 
NIGHTGATE_INDEXER_HTTP_URL=https://indexer.preprod.midnight.network/api/v4/graphql
# Proving defaults to fully in-process (wasm): no proof server needed.
# For production, run the proof-server container (compose:
# midnightntwrk/proof-server on :6300) and point at it; configuring the URL
# selects server proving automatically.
# NIGHTGATE_PROOF_SERVER_URL=http://localhost:6300
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
| Token ops | `sendNight` (receiver ledger auto-detected; optional `tokenTypeHex` sends any custom token instead of NIGHT, shielded or unshielded depending on the receiver address), `registerForDustGeneration` / `deregisterFromDustGeneration` |
| Fee sponsoring | Generation delegation (`registerForDustGeneration` with a foreign `dustReceiverAddress`, own dust address via `deriveWalletInfo`) and per-tx sponsorship (optional `sponsorSessionId` on all submit actions: a second session pays the dust fee; cross-user use gated via `NIGHTGATE_FEE_SPONSOR_SESSION`) |
| Pre-flight | `getWalletBalance`, `estimateSendNightFee`, `deriveWalletInfo` |
| Compact contracts | `deployContract` / `submitContractCall` on registered compiled artifacts |
| Proving modes | `wasm` (default when no proof server is configured: fully in-process for wallet AND contract circuits, no Docker needed) or `server` (proof-server container, selected automatically by configuring `proofServerUrl`; recommended for production). Explicit override via `NIGHTGATE_PROVING_MODE`. |
| Document anchoring | `anchorDocument` / `verifyDocument`: sha256 hash on-chain, storage stays with the caller |
| Document ingestion | `prepareDocumentProof`: canonical JSON -> `payloadHash` + depth-4 Merkle content root with per-field inclusion paths (numeric and, since 0.15.0, `kind: 'bytes'` string fields), ready for the field-proof actions; `prepareMembershipSet` builds the canonical allow-list set root (compute-only, nothing persisted) |
| AI-agent access | `createAgentGrant` / `revokeAgentGrant`: scoped bearer tokens (`x-agent-token`) with action allowlist, daily job budget and pinned session/sponsor (fundless agents); `attestAgentOutput` anchors third-party-verifiable agent-output provenance. MCP companion: [`@odatano/nightgate-mcp`](https://github.com/ODATANO/NIGHTGATE-MCP) |
| ZK predicate attestations | `issuePredicateAttestation` / `issueFieldPredicateAttestation` (field-bound via content root) / `issueFieldPredicateAttestationBatch` (up to 8 field proofs in ONE tx, mixed kinds): prove `value ≤/≥ threshold` without revealing the value; `verifyPredicateAttestation` to check |
| Bytes equality + membership proofs | `issueFieldEqualityAttestation` (field carries exactly the value behind a public digest) and `issueFieldMembershipAttestation` (hidden value is ONE OF a public allow-list of up to 64 values, without revealing which), batchable alongside numeric claims (0.15.0) |
| Crawler-free verification | `verifyAttestationState` / `verifyPredicateState` / `reindexDisclosures` read live contract state from the public indexer (per-call `network` override, no wallet, no local index) |
| Tiered disclosure (RBAC) | `grantDisclosure` / `revokeDisclosure` (+ `registerGranteeIdentity`), on-chain `DisclosureGrants` index, `AttestationService` mixin with EU Battery Reg tiers |
| Browser / connector | `@odatano/nightgate/browser` (providers, witnesses, `prepareAttest` / `prepareGrantDisclosure` / `prepareRevokeDisclosure`) + `GET /zk-config/<contract>/…` + `GET /contract-manifest`: a wallet-driven dApp (Lace) needs neither the Compact toolchain nor `managed/` artifacts |
| Operations | Health / liveness / readiness, Prometheus metrics, `pauseCrawler` / `resumeCrawler` / `reindexFromHeight`, offline start (boots without upstream node), optional local indexer via docker-compose |

## Documentation

- **[Quickstart:](docs/quickstart.md)** get from zero to first wallet-signed transaction
- **[Actions reference:](docs/actions.md)** every OData action + function with examples
- **[Architecture:](docs/architecture.md)** worker-thread design, submission flow, persistence model
- **[Operations:](docs/operations.md)** running NIGHTGATE day to day, scripts, local indexer, troubleshooting
- **[Docker:](docs/docker.md)** standalone container (`ghcr.io/odatano/nightgate`), configuration, schema upgrades
- **[Reference:](docs/reference.md)** full configuration matrix + project structure
- **[Changelog:](CHANGELOG.md)** notable changes by version

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

Then `cds watch`. `network` is the only required key; everything else defaults to fully public endpoints: Preprod's public RPC, the hosted indexer, and in-process (wasm) proving, so no local container is required. Configure a proof-server URL to switch to server proving (recommended for production). Override via env vars or CDS config, see [docs/reference.md#configuration](docs/reference.md#configuration).

## Development

```bash
npm run dev                # cds watch with 12 GB heap (scripts/dev.mjs)
npm run serve:sync         # cds-serve with 12 GB heap, use this for long sync runs
npm run sync:start         # bootstrap a wallet session against the running server

npm run typecheck          # tsc --noEmit
npm run lint               # ESLint
npm test                   # full Vitest suite with coverage
npm run build              # Compile CDS types + TypeScript to JS

# Integration scripts (real SDK, no chain access required)
npm run smoke:sdk          # all SDK packages load
npm run integration:providers            # + wallet-keys, wallet-facade, contract-registry,
                                         #   connector-routes, attestation-vault, derive-wallet-info

# Live e2e against preprod (funded wallet required)
npm run deploy:e2e         # + predicate:e2e, disclosure:e2e, state-verify:e2e,
                           #   wasm-proving:e2e, wasm-contract:e2e, wasm-zswap:e2e
```

## License

[Apache-2.0](LICENSE)

## Links

- [ODATANO GitHub org](https://github.com/ODATANO)
- [Midnight Network](https://midnight.network/)
- [Consumer App Implementation](https://github.com/ODATANO/NIGHTPASS)
- [SAP CAP Documentation](https://cap.cloud.sap/docs/)
