# Changelog

## 0.1 - Midnight Indexer

### 0.1.2 - 2026-03-08

#### Preprod-First Readiness
- Added first-class Preprod support to the Nightgate runtime and plugin config.
- Added `NIGHTGATE_NETWORK`, `NIGHTGATE_NODE_URL`, and `NIGHTGATE_CRAWLER_NODE_URL` environment variable overrides for flexible runtime configuration.
- Switched repository defaults to the hosted Midnight Preprod RPC at `wss://rpc.preprod.midnight.network/` for a smoother out-of-the-box experience.
- Updated documentation to reflect the Preprod-first workflow and simplified configuration.

#### Simplified Configuration

- Code defaults to Preprod (`wss://rpc.preprod.midnight.network/`). No config needed for the common case.
- Removed `MIDNIGHT_*` env var aliases — only `NIGHTGATE_NETWORK`, `NIGHTGATE_NODE_URL`, and `NIGHTGATE_CRAWLER_NODE_URL` are supported.
- Removed unused `NIGHTGATE_DEFAULTS` export. Replaced by `DEFAULT_NETWORK` and `DEFAULT_NODE_URL`.
- `package.json` only needs `"nightgate": { "kind": "nightgate" }` — network and URL default in code.

### 0.1.1 - 2026-03-08

#### Reliability And Tooling

- Crawler startup now disconnects provider on startup failure to avoid leaked sockets.
- Crawler catch-up now guarantees `isCatchingUp` reset via `finally`.
- MidnightNodeProvider now guards async subscription callback rejections and logs them safely.
- Security middleware CORS allow-headers now includes `X-Correlation-ID`.

#### Service Capability Expansions

- Block ingestion now persists baseline `TransactionResults` and `TransactionFees` for every indexed transaction.
- Contract-classified transactions now persist `ContractActions` with deterministic address grouping and entry-point hints.
- Transaction metadata extraction now populates `size`, `hasProof`, `proofHash`, `contractAddress`, and `circuitName` fields.
- `NightgateIndexerService` now exposes operational actions: `pauseCrawler()`, `resumeCrawler()`, and `reindexFromHeight(height)`.
- `NightgateService` now exposes query primitives: `Blocks.range(startHeight, endHeight, limit)` and `Transactions.byType(txType, limit)`.

#### Validation Baseline

- `22` test suites passed
- `267` tests passed
- `0` failures
- coverage: `93.09%` statements, `81.77%` branches, `94.3%` functions, `93.62%` lines

### 0.1.0 - 2026-03-06

First public Nightgate package cut.

#### What This Release Delivers

- SAP CAP plugin bootstrap through `cds-plugin.js` and `src/plugin.ts`
- `cds.requires.nightgate` configuration model for Midnight node indexing
- Direct WebSocket connectivity to a Midnight node through `MidnightNodeProvider`
- Catch-up indexing, live subscription, transient retry handling, and reorg rollback in the crawler
- Local CAP-database persistence for blocks, transactions, sync state, and reorg history
- OData services for blockchain reads, indexer operations, analytics, and admin session management
- Wallet-session connect/disconnect flows with encrypted viewing-key storage, TTL cleanup, and admin invalidation
- Health, readiness, liveness, and Prometheus-style metrics endpoints
- Offline startup mode when the node is unavailable
- Auto-deploy attempt when the target schema is missing

#### Release Positioning

- This is a read-side first release.
- The package is already usable as an indexer and OData exposure layer for Midnight data.
- The package is not yet a full write-side blockchain interaction SDK.

#### Explicitly Out Of Scope In 0.1

- Transaction building
- Transaction signing
- Transaction submission
- Wallet execution flows beyond session registration/storage
- Built-in production authorization policy beyond CDS `@requires` annotations

#### Notes On Surface Area

- The schema and CDS services already expose a broader Midnight data model than the current extractor depth guarantees for every entity family.
- The strongest operational path in `0.1` is: node connectivity -> block ingest -> transaction ingest -> sync state -> health/metrics -> OData read access.
- Contract, balance, DUST, governance, and other higher-level projections are part of the public surface and will continue to deepen as extractor coverage expands.

#### Security Hardening

- CDS service auth annotations enabled: `@requires: 'authenticated-user'` on NightgateService and AnalyticsService, `@requires: 'admin'` on AdminService
- `ENCRYPTION_KEY` enforced in production (`NODE_ENV=production`) — startup fails without it
- Read-only guard covers all entities including NightBalances, DustRegistrations, TokenTypes, WalletSessions
- Rate limiter hardened with periodic sweep, max key cap, and `destroy()` cleanup
- Crawler: live blocks queued instead of dropped during catch-up; start failure resets running state; reorg uses batched deletes
- MidnightNodeProvider: reconnect timer cleanup, subscription cleanup on close, NaN block number rejection
- BlockProcessor: tx-type validation with allow-list
- Removed unused `sessionToken` field from WalletSessions
- SyncState initialization extracted to shared `ensureSyncStateSingleton()` utility
- `getReorgHistory` limit clamped to max 100; `byCardanoAddresses` array capped at 100

#### Verified Baseline At Release Time

- `21` test suites passed
- `251` tests passed
- `0` failures
- coverage: `98.99%` statements, `90.9%` branches, `99.25%` functions, `99.28%` lines
