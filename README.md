# NIGHTGATE - OData for Midnight @odatano/nightgate

![Header Image](/docs/readme_header.png)

**SAP CAP plugin: Midnight blockchain indexer + transaction submission, exposed as OData V4.**

[![Tests](https://github.com/ODATANO/NIGHTGATE/actions/workflows/test.yaml/badge.svg)](https://github.com/ODATANO/NIGHTGATE/actions/workflows/test.yaml)
[![Coverage](https://img.shields.io/codecov/c/github/ODATANO/NIGHTGATE)](https://codecov.io/gh/ODATANO/NIGHTGATE)
[![npm](https://img.shields.io/npm/v/@odatano/nightgate)](https://www.npmjs.com/package/@odatano/nightgate)
[![npm downloads](https://img.shields.io/npm/dt/@odatano/nightgate?logo=npm&label=downloads&color=blue)](https://www.npmjs.com/package/@odatano/nightgate)
[![npm nightgate-tx](https://img.shields.io/npm/v/@odatano/nightgate-tx?label=nightgate-tx)](https://www.npmjs.com/package/@odatano/nightgate-tx)
[![nightgate-tx downloads](https://img.shields.io/npm/dt/@odatano/nightgate-tx?logo=npm&label=nightgate-tx%20downloads&color=blue)](https://www.npmjs.com/package/@odatano/nightgate-tx)
[![SAP CAP](https://img.shields.io/badge/SAP%20CAP-%40sap%2Fcds%20%5E10-0faaff?logo=sap)](https://cap.cloud.sap/)
[![License](https://img.shields.io/badge/license-Apache--2.0-yellow)](LICENSE)

`@odatano/nightgate` connects SAP CAP to the [Midnight](https://midnight.network/) blockchain. A crawler indexes blocks from a Substrate RPC node into CAP entities; a wallet stack in a worker thread submits transactions (Compact deploys and calls, NIGHT and custom-token transfers, dust generation, fee sponsoring). Everything is exposed as OData V4.

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

The wallet SDK runs in a worker thread because its sync saturates the microtask queue; the CAP request pipeline stays responsive.

## Quick start

```bash
npm ci
npm run dev           
```

Or standalone with Docker ([docs/docker.md](docs/docker.md)):

```bash
docker pull ghcr.io/odatano/nightgate:latest
docker run -d -p 4004:4004 \
  -e ENCRYPTION_KEY=$(openssl rand -hex 32) \
  -e NIGHTGATE_HTTP_PASSWORD=change-me \
  -v nightgate-data:/data \
  ghcr.io/odatano/nightgate:latest
```

`.env` (see `.env.example`):

```bash
NIGHTGATE_NETWORK=preprod
NIGHTGATE_NODE_URL=wss://rpc.preprod.midnight.network/
# GraphQL indexer, HTTP; the WS URL is derived
NIGHTGATE_INDEXER_HTTP_URL=https://indexer.preprod.midnight.network/api/v4/graphql
# Unset = in-process wasm proving. Setting it selects server proving (production).
# NIGHTGATE_PROOF_SERVER_URL=http://localhost:6300
NIGHTGATE_CRAWLER_ENABLED=false
ENCRYPTION_KEY=<random secret>
```

First sync walkthrough: [docs/quickstart.md](docs/quickstart.md).

## Services & capabilities

| Service | Path | Content |
|---|---|---|
| `NightgateService` | `/api/v1/nightgate` | chain data, wallet sessions, token / contract / attestation actions |
| `NightgateIndexerService` | `/api/v1/indexer` | sync state, health, metrics, crawler control |
| `NightgateAnalyticsService` | `/api/v1/analytics` | aggregate counts |
| `NightgateAdminService` | `/api/v1/admin` | sessions, contract registration, diagnostics |
| `NightgateVerifyService` | `/api/v1/verify` | unauthenticated state verification (`NIGHTGATE_PUBLIC_VERIFY=true`) |

Submit actions are async: they return `{ jobId, status }`; poll `getJobStatus(jobId, sessionId)`. Signatures, error codes and examples: [docs/actions.md](docs/actions.md).

| Capability | Surface |
|---|---|
| Block indexing | Crawler with reorg detection; OData queries on `Blocks`, `Transactions`, `ContractActions`, `UnshieldedUtxos`, `NightBalances` |
| Wallet sessions | `connectWallet` (viewing key, read-only), `connectWalletForSigning` (BIP39 mnemonic, Lace-compatible HD derivation); AES-256-GCM at rest, bound to the requesting user |
| Token ops | `sendNight` (ledger from the receiver address; `tokenTypeHex` for custom tokens), `registerForDustGeneration` / `deregisterFromDustGeneration` |
| Fee sponsoring | Dust generation delegation (`dustReceiverAddress`) and per-tx `sponsorSessionId` on submit actions (platform sponsors: `NIGHTGATE_FEE_SPONSOR_SESSION`) |
| Pre-flight | `getWalletBalance`, `estimateSendNightFee`, `deriveWalletInfo` |
| Compact contracts | `deployContract`, `submitContractCall`, `submitContractCallBatch` on registered artifacts |
| Proving | `wasm` in-process (default without a proof server) or `server` (selected by a proof-server URL; production). Override: `NIGHTGATE_PROVING_MODE` |
| Document anchoring | `anchorDocument` / `verifyDocument`: hash on chain, storage stays with the caller |
| Document ingestion | `prepareDocumentProof`: canonical JSON -> `payloadHash` + salted content root with per-field inclusion paths (16 slots, 32 on `attestation-vault-32`); `prepareMembershipSet`: canonical allow-list root. Compute-only |
| Agent access | `createAgentGrant` / `updateAgentGrant` / `rotateAgentGrantToken` / `revokeAgentGrant`: scoped bearer tokens (`x-agent-token`) with action allow-list, budgets, pinned session and sponsor; `attestAgentOutput`: verifiable agent-output provenance. MCP server: [`@odatano/nightgate-mcp`](https://github.com/ODATANO/NIGHTGATE-MCP) |
| Field proofs | `issueFieldPredicateAttestation` (`value <= / >= threshold`), `issueFieldEqualityAttestation` (value behind a public digest), `issueFieldMembershipAttestation` (one of up to 64 allowed values); `issueFieldPredicateAttestationBatch`: up to 8 mixed claims in one tx. Values stay hidden |
| Cross-document proofs | `issueDocumentIntegrityAttestation` (B differs from A only in a slot mask), `issueDocumentDiffAttestation` (at least k slots differ); same width only |
| Crawler-free verification | `verifyAttestationState`, `verifyPredicateState`, `reindexDisclosures`: live contract state from the public indexer, optional `network` override |
| Tiered disclosure | `grantDisclosure` / `revokeDisclosure` / `registerGranteeIdentity`, `DisclosureGrants` index, `AttestationService` with three tiers |
| Local tx building | `@odatano/nightgate/txbuilder` or [`@odatano/nightgate-tx`](packages/nightgate-tx/README.md): build, prove and sign with your own key, then `sponsorFinalizedTransaction` / `sponsorUnboundTransaction` pays and submits. The sponsor sees no key, witness or preimage |
| Browser | `@odatano/nightgate/browser` + `GET /zk-config/<contract>/…` + `GET /contract-manifest`: wallet-driven dApps without Compact toolchain or `managed/` artifacts |
| Operations | Health, liveness, readiness, Prometheus metrics, crawler pause / resume / reindex, offline start |

## Documentation

- [Quickstart](docs/quickstart.md): first wallet-signed transaction
- [Actions](docs/actions.md): every action and function with examples
- [Architecture](docs/architecture.md): worker thread, submission flow, persistence
- [Operations](docs/operations.md): scripts, local indexer, troubleshooting
- [Docker](docs/docker.md): standalone container, configuration, schema upgrades
- [Transaction builder](docs/txbuilder.md): build sponsorable transactions without a server
- [Reference](docs/reference.md): configuration and project structure
- [Changelog](CHANGELOG.md)

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

Then `cds watch`. `network` is the only required key; the defaults are the public RPC and indexer and wasm proving. Configuration: [docs/reference.md#configuration](docs/reference.md#configuration).

## Development

```bash
npm run dev                # cds watch, 12 GB heap
npm run serve:sync         # cds-serve, 12 GB heap; for long syncs and e2e runs
npm run sync:start         # create a wallet session on the running server

npm run typecheck
npm run lint
npm test                   # Vitest with coverage
npm run build              # CDS types + TypeScript

# Real SDK, no chain access
npm run smoke:sdk
npm run integration:providers   # also: wallet-keys, wallet-facade, contract-registry,
                                #   connector-routes, attestation-vault, derive-wallet-info

# Live e2e on preprod (funded wallet)
npm run deploy:e2e         # more lanes: docs/operations.md
```

## License

[Apache-2.0](LICENSE)

## Links

- [ODATANO GitHub org](https://github.com/ODATANO)
- [Midnight Network](https://midnight.network/)
- [Consumer App Implementation](https://github.com/ODATANO/NIGHTPASS)
- [SAP CAP Documentation](https://cap.cloud.sap/docs/)
