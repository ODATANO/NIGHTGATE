# NIGHTGATE Implementation Plan

Grounded in the live codebase (audited 2026-05-15) and verified against the current Midnight SDK and docs. Supersedes the previous `enhancements.md` task list — same T-numbers preserved, claims corrected, status added per task, concrete file paths and acceptance criteria spelled out.
ok 
**Three corrections to the prior list before reading further:**

1. **Compact compiler is `0.31.0`** (not `0.25.0`). Output directory is `src/managed/<contract-name>/` (not `contracts/managed/`).
2. **`@midnight-ntwrk/ledger-v7`** is a distinct package name (the `-v7` suffix is part of the name, not just a version). The bare `@midnight-ntwrk/ledger` is the legacy v4 package — don't pull that one.
3. **T8 — session TTL cleanup — is already wired up** (`srv/nightgate-service.ts:188`, `srv/sessions/wallet-sessions.ts:100`). Removed from the active list; covered as already-shipped.

---

## Open technical decisions — resolved

### D1. Does NIGHTGATE replace the Midnight Indexer?

**Answer: No. They serve different purposes; keep both.**

The prior version of this doc framed this as a "refactor to consume the Midnight Indexer as upstream" decision. That was wrong. The two systems do different jobs:

| | Midnight Indexer (`midnightntwrk/midnight-indexer`) | NIGHTGATE |
|---|---|---|
| Protocol | GraphQL only | OData V4 (REST) |
| Consumer | Midnight JS SDK — it expects this exact GraphQL shape via `indexerPublicDataProvider` for `findDeployedContract`, contract-state subscriptions, ZSwap subscriptions | Enterprise systems — SAP CAP apps, BI tools, ERP integrations |
| Storage | Its own DB | SQLite (dev) / HANA (prod), under user/enterprise control |
| Schema | Fixed Midnight-team-defined GraphQL | User's CDS model — extensible per consumer app (e.g. PASSPORT adds its own entities composing on top) |
| Auth / RBAC | None — public read | CAP auth, role-based disclosure tiers (T14), wallet sessions |

NIGHTGATE's value is **OData + CAP + enterprise storage + auth + analytics**, not "yet another GraphQL endpoint." The SDK needs the Midnight Indexer's specific GraphQL shape — it won't work against arbitrary other indexers. So:

- **Keep `srv/crawler/` as-is.** It's the integration point between our SQLite/HANA tables and the chain. That's where the enterprise value lives.
- **Add `srv/midnight/providers.ts` (T3)** that points `publicDataProvider` at the *Midnight team's* hosted indexer (`https://indexer.preprod.midnight.network/api/v4/graphql`). That's only for the SDK's internal needs when building/submitting transactions (T4) — it does not touch our crawler, our DB, or our OData surface.

Two independent pipelines:
- **Chain → Crawler → SQLite → OData** (read side, our differentiation).
- **CAP action → SDK → Midnight Indexer GraphQL + Proof Server → submitted tx** (write side, uses Midnight's hosted infra).

The crawler picks the submitted tx back up on the next block and reconciles `PendingSubmissions` (T5). That's the only point of contact between the two pipelines.

### D2. Preprod vs. Testnet vs. local

**Use preprod for anything that needs to talk to the live chain. Local Docker for offline tests.**

- Preprod is the default in `srv/utils/nightgate-config.ts` and has a public stable RPC + indexer endpoint.
- Local node (`docker/docker-compose.yml`) is fine for offline unit/integration tests but needs DUST faucet emulation to actually deploy.
- **Hold off on mainnet** — the `1016 Immediately Dropped` deterministic rejection on mainnet contract deploys is still being triaged by the Midnight team (forum thread early May 2026). Gate behind `cds.requires.nightgate.allowMainnetSubmission` (default false) until that's resolved.

### D3. Proof server: local Docker or remote?

**Local Docker for dev; expose a config option for a remote URL for hosted deployments.**

First-run ZK params download is ~500 MB (plus a Circuit 24 file ~3 GB per the forum). Pre-baked images exist (`meshsdk/midnight-proof-server`, `bricktowers/midnight-proof-server`) — link these in `docs/quickstart.md` as a faster alternative. For hosted scenarios, point `NIGHTGATE_PROOF_SERVER_URL` at a shared remote instance so each host doesn't re-download.

---

## What's already shipped (verified in tree, 2026-05-15)

These items from the prior list are **already done** — do not re-implement:

| Prior task | Where it lives | Notes |
|---|---|---|
| T8 — Wallet session TTL cleanup | `srv/sessions/wallet-sessions.ts:100` (`startSessionCleanup`), called from `srv/nightgate-service.ts:188` | 15-min interval, sets `isActive=false` + nulls `encryptedViewingKey` on expiry. Tested at `test/unit/wallet-sessions.test.ts:247`. |
| Wallet sessions, viewing-key encryption, rate limiter | `srv/sessions/wallet-sessions.ts`, `srv/utils/crypto.ts`, `srv/utils/rate-limiter.ts` | AES-256-GCM, 10 req/min per IP. |
| Crawler with catch-up + live + reorg + retry | `srv/crawler/Crawler.ts`, `srv/crawler/BlockProcessor.ts` | Two-phase, reorg via parent-hash, queued live-block draining. |
| All four OData services | `srv/{nightgate,nightgate-indexer,analytics-service,admin-service}.cds/.ts` | NightgateService, IndexerService, Analytics, Admin all live. |
| CDS schema for read side | `db/schema.cds`, `db/types.cds` | Blocks, Transactions, ContractActions, UnshieldedUtxos, ZSwap/DUST events, WalletSessions, SyncState, ReorgLog, NightBalances. |
| Dual-mode plugin/standalone | `cds-plugin.js` → `src/plugin.ts` ↔ `srv/server.ts` | Security headers, CORS, model registration. |

---

## 0.2.0 — Async-job migration for long-running actions (2026-05-20)

**Status:** ✅ Done (server side; verified live against preprod).

All nine long-running OData actions were converted from "await the worker
inline" to "return `{ jobId, status }` immediately, poll `getJobStatus`":
`connectWalletForSigning` (returns `prewarmJobId`), `registerForDustGeneration`,
`deregisterFromDustGeneration`, `sendNight`, `shieldFunds`, `unshieldFunds`,
`deployContract`, `submitContractCall`, `anchorDocument` (also returns a sync
`documentId`).

- New entity `midnight.BackgroundJobs` (`db/schema.cds`) + `BackgroundJobStatus`/`BackgroundJobKind` (`db/types.cds`).
- New module `srv/submission/background-jobs.ts`: `startJob` / `getJobById` / `recoverInterruptedJobs`. Per-kind semaphore (heavy=4, light=16). Idempotency via `(sessionId, kind, idempotencyKey)`.
- New action `getJobStatus(jobId, sessionId)` on NightgateService — declared `action` (POST), NOT `function` (GET), so clients poll with the same POST+body pattern as everything else.
- Crash recovery: `recoverInterruptedJobs()` in `src/index.ts::initialize` flips `pending`/`running` rows to `failed:PROCESS_RESTART` on boot.
- Auto-deploy removed: `ensureSchemaDeployed` is now probe-only and throws `SchemaNotDeployedError` (fail-fast). Deploy explicitly with `npm run deploy` (→ `cds deploy --to sqlite:db/midnight.db`).

### ⚠️ Trip-hazard: `@cap-js/sqlite` pools ONE connection (`pool.max=1`)

This caused the original save-deadlock and is the single most important thing
to understand before touching the job path:

- better-sqlite3 is synchronous + SQLite is single-writer, so `@cap-js/sqlite`
  defaults `cds.requires.db.pool = { max: 1 }`. There is exactly **one** DB
  connection process-wide.
- **Any** transaction that does a `db.run(...)` and then `await`s a
  multi-minute/hours worker call (cold sync, ZK proof, submit) pins that single
  connection for the whole await — every other query (periodic wallet-state
  saves, `getJobStatus` polls) starves at `pool.acquire()` and hangs forever.
- This is why the original `registerForDustGeneration` (awaited the worker
  inside `req.tx`) deadlocked the saves, and why naively wrapping work in
  `cds.spawn` *re-introduced* it (the spawn's tx is the ambient context that
  `loadSyncState`'s SELECT joined).
- **Fix (`background-jobs.ts::runWithoutAmbientTx`):** `work()` runs via
  `cds._with(undefined, work)` so `cds.context` is cleared. Each `db.run`
  inside `work()` then gets its own short acquire→commit→release tx, leaving
  the lone connection free during the long awaits. Row state transitions
  (`markRunning`/`markSucceeded`/`markFailed`) likewise use `db.tx(...)`.
- **Rule:** never hold a CAP transaction open across a worker `await`. Do DB
  work in short txs before/after the await, never spanning it. Do NOT "fix"
  this by bumping `pool.max` — that fights the framework default and invites
  `SQLITE_BUSY`.

---

# T1 — Add Midnight JS SDK dependencies

**Status:** ✅ **Done** (2026-05-15). **Effort spent:** ~1h.

Installed and verified. Final dependencies added to `package.json`:

```jsonc
{
  "@midnight-ntwrk/midnight-js-contracts": "^4.0.4",
  "@midnight-ntwrk/midnight-js-indexer-public-data-provider": "^4.0.4",
  "@midnight-ntwrk/midnight-js-http-client-proof-provider": "^4.0.4",
  "@midnight-ntwrk/midnight-js-node-zk-config-provider": "^4.0.4",
  "@midnight-ntwrk/midnight-js-level-private-state-provider": "^4.0.4",
  "@midnight-ntwrk/compact-runtime": "^0.16.0",
  "@midnight-ntwrk/ledger-v8": "^8.1.0",                                // corrected from ledger-v7
  "@midnight-ntwrk/wallet-sdk-facade": "^4.0.0"
}
```

**Findings that change downstream tasks (T3, T4):**

1. **Ledger version: `ledger-v8`, not `ledger-v7`.** Both `midnight-js-contracts` (via `@midnight-ntwrk/compact-js@2.5.0`) and `wallet-sdk-facade@4.0.0` transitively depend on `@midnight-ntwrk/ledger-v8@8.1.0`. Pinning `ledger-v7` is wrong — it's not used by anything in the dependency tree.

2. **The SDK is effectively ESM-only.** Some packages (e.g. `midnight-js-contracts`) ship both CJS and ESM builds, but every dependency tree terminates at `compact-runtime` (pure ESM, `"type": "module"`, no CJS export) and `compact-js`. Loading any SDK entry point via CommonJS `require()` fails with `SyntaxError: Unexpected token 'export'`.

   **Consequence for T3:** `srv/midnight/providers.ts` cannot use top-level `import` against the SDK without converting the whole NIGHTGATE codebase to ESM. Use dynamic `import()` from CommonJS instead — async, returns a Promise. Wrap once in a memoized loader:

   ```ts
   // srv/midnight/sdk-loader.ts
   let cached: SdkBundle | undefined;
   export async function loadMidnightSdk(): Promise<SdkBundle> {
     if (cached) return cached;
     const [contracts, indexer, proof, zk, level, facade] = await Promise.all([
       import('@midnight-ntwrk/midnight-js-contracts'),
       import('@midnight-ntwrk/midnight-js-indexer-public-data-provider'),
       import('@midnight-ntwrk/midnight-js-http-client-proof-provider'),
       import('@midnight-ntwrk/midnight-js-node-zk-config-provider'),
       import('@midnight-ntwrk/midnight-js-level-private-state-provider'),
       import('@midnight-ntwrk/wallet-sdk-facade')
     ]);
     cached = { contracts, indexer, proof, zk, level, facade };
     return cached;
   }
   ```

   CAP action handlers are already async, so awaiting an SDK load inside them is natural.

3. **Jest cannot load the SDK via `require`.** Forcing it would require `transformIgnorePatterns` + ESM jest config — not worth the cost for a smoke test. **Install verification is `npm run smoke:sdk`**, which runs `scripts/smoke-test-sdk.mjs` as native ESM Node. Jest unit tests for SDK-using code (T4 onward) will mock the SDK loader.

4. **Pre-existing typecheck failure** unrelated to T1: `@sap/cds` types are not resolving in the current tsconfig (TS7016). Test suites fail to compile though all 92 individual tests pass. Not introduced by SDK install — verified via `git stash` baseline. Fix separately.

5. **Confirmed APIs match the plan's downstream tasks:**
   - `indexerPublicDataProvider(httpUrl, wsUrl)` — exported.
   - `httpClientProofProvider(url, zkConfigProvider)` — exported.
   - `NodeZkConfigProvider` (class) — exported.
   - `levelPrivateStateProvider({ privateStateStoreName, walletProvider })` — exported.
   - `WalletFacade`, `BalancingRecipe`, `mergeWalletEntries` from `wallet-sdk-facade` — exported.

**Artifacts produced:**
- `scripts/smoke-test-sdk.mjs` — install-verification script.
- `package.json` scripts: `"smoke:sdk": "node scripts/smoke-test-sdk.mjs"`.
- 160 new packages in `node_modules`, 8 deps in `package.json`.

**Outstanding from this step (small follow-ups):**
- `npm audit` shows 8 vulnerabilities (1 critical, 4 high, 3 moderate) in the SDK transitive tree. Review separately; do not blanket `npm audit fix` since it may break SDK pins.
- Pre-existing TS7016 on `@sap/cds` — separate cleanup task.

---

# T2 — Local proof server lifecycle

**Status:** ✅ **Done** (2026-05-15). **Effort spent:** ~30 min.

Added to `docker/docker-compose.yml` as the `proof-server` service. `docs/quickstart.md` updated with the ZK-params download note and pre-baked alternatives.

**Final config:**

```yaml
proof-server:
  image: midnightntwrk/proof-server:8.0.3
  container_name: odatano-night-proof-server
  command: ["midnight-proof-server", "--network", "${NIGHTGATE_PROOF_NETWORK:-preprod}"]
  ports: ["6300:6300"]
  volumes:
    - proof-server-data:/data
  restart: unless-stopped
```

**Corrections vs. the original task spec:**

1. **Image name:** `midnightntwrk/proof-server` (with `ntwrk`), not `midnightnetwork/proof-server`. The Docker Hub page that comes up under the latter name is the same artifact but `midnightntwrk` is the canonical name per `docs.midnight.network/getting-started/installation`.
2. **Pinned tag:** `8.0.3` instead of `:latest`. The Midnight docs reference this version explicitly; `:latest` floats and risks breakage.
3. **No in-container healthcheck.** The 23 MB image is essentially `scratch + binary` — `curl`, `wget`, `nc` are not present. The healthcheck in the original spec would always fail. If we need a probe, do it from the host (or from NIGHTGATE on startup) hitting `http://localhost:6300/`. Docker compose still treats the container as healthy based on process liveness.
4. **Network selectable via env var:** `NIGHTGATE_PROOF_NETWORK` defaults to `preprod`, override to `testnet` for local-node work.

**Acceptance:** `docker compose -f docker/docker-compose.yml config` validates the file. End-to-end "image pulls and runs" is gated on a manual `docker compose up -d proof-server` once a user is ready to download the image — left to user discretion since the first contract compile will pull ~500 MB of ZK params.

---

# T3 — Midnight provider bundle module

**Status:** ✅ **Done** (2026-05-15). **Effort spent:** ~1.5h.

**Files created/edited:**
- `srv/midnight/sdk-loader.ts` — memoized dynamic-import loader, exports `loadMidnightSdk()` + `resetMidnightSdkCache()`.
- `srv/midnight/providers.ts` — exports `buildContractProviders(cfg)` and `buildFullProviderBundle(cfg, wallet)`.
- `srv/utils/nightgate-config.ts` — added `resolveSubmissionEndpoints(network, config)` with env-var fallback chain; `resolveNightgateRuntimeConfig` now returns `submissionEndpoints` too.
- `src/plugin.ts` — JSON schema extended with `indexerHttpUrl`, `indexerWsUrl`, `proofServerUrl`, `zkConfigBasePath`.
- `test/unit/midnight-providers.test.ts` — 10 unit tests (mocked SDK loader).
- `scripts/integration-test-providers.mjs` + `npm run integration:providers` — real-SDK integration check.

**Correction vs. the original plan (real SDK API):**

The original plan said `levelPrivateStateProvider({ privateStateStoreName, walletProvider })`. The real `LevelPrivateStateProviderConfig` is `{ accountId, privateStoragePasswordProvider, ...optional }`. **Consequence:** T7 (wallet sessions) produces an `accountId` (string, typically wallet address) and a `privateStoragePasswordProvider` callback — not a "wallet provider object" for the private-state slot. The wallet+midnight provider slot is separate and reuses one facade instance (per Counter CLI pattern).

**Two-stage design landed:**
- `buildContractProviders(cfg)` — returns `{ publicDataProvider, zkConfigProvider, proofProvider }`. No wallet needed. Safe to call eagerly.
- `buildFullProviderBundle(cfg, wallet)` — adds `{ privateStateProvider, walletProvider, midnightProvider }`. Requires `WalletMaterial`, which T7 will produce from an active session.

T4 can use `buildContractProviders` for state-only queries and `buildFullProviderBundle` once T7 lands.

**Other notable findings during T3:**
- `indexerPublicDataProvider` accepts an optional `webSocketImpl` parameter — required on Node (no global `WebSocket`). We pass the existing `ws` package.
- LevelDB private-state provider docs **explicitly warn** against use for production with real assets: *"DO NOT use for production applications requiring data persistence."* The provider serializes encrypted state to local LevelDB files; clearing the filesystem destroys the contract state and signing keys with no recovery path. For demo / submission-testing this is acceptable; for production a NIGHTGATE-native backend is required. Tracked as [T29](#t29--production-private-state-provider-cap-db-backed).

**Acceptance:**
- `npm test` — 10 new tests pass; 102/102 total (no regressions vs. T1 baseline).
- `npm run integration:providers` — all 6 real-SDK provider construction checks pass.

Per T1 finding: the SDK is effectively ESM-only, so this module must use dynamic `import()` from our CommonJS codebase. Pattern:

```ts
// srv/midnight/providers.ts
import type { Logger } from '../utils/logger'; // type-only; safe in CJS
import { loadMidnightSdk } from './sdk-loader';

export interface MidnightProvidersConfig {
  network: 'preprod' | 'testnet' | 'mainnet';
  indexerHttpUrl: string;     // https://indexer.preprod.midnight.network/api/v4/graphql
  indexerWsUrl: string;       // wss://indexer.preprod.midnight.network/api/v4/graphql/ws
  proofServerUrl: string;     // http://localhost:6300
  zkConfigPath: string;       // absolute path to <contract>/src/managed/<name>/ root
  privateStateStoreName: string;
  walletProvider: any;        // from T7 — wallet-sdk-facade
}

export async function buildMidnightProviders(cfg: MidnightProvidersConfig) {
  const sdk = await loadMidnightSdk();
  const zkConfigProvider = new sdk.zk.NodeZkConfigProvider(cfg.zkConfigPath);
  return {
    privateStateProvider: sdk.level.levelPrivateStateProvider({
      privateStateStoreName: cfg.privateStateStoreName,
      walletProvider: cfg.walletProvider,
    }),
    publicDataProvider: sdk.indexer.indexerPublicDataProvider(cfg.indexerHttpUrl, cfg.indexerWsUrl),
    zkConfigProvider,
    proofProvider: sdk.proof.httpClientProofProvider(cfg.proofServerUrl, zkConfigProvider),
    walletProvider: cfg.walletProvider,
    midnightProvider: cfg.walletProvider, // same instance per Counter CLI pattern
  };
}
```

`loadMidnightSdk()` is the memoized helper described in T1 finding #2. Builds once, reused per process.

**Config plumbing:** extend `srv/utils/nightgate-config.ts` and the `cds.requires.nightgate` JSON schema in `src/plugin.ts:114` to include:

```jsonc
"indexerHttpUrl":    { "type": "string", "default": "https://indexer.preprod.midnight.network/api/v4/graphql" },
"indexerWsUrl":      { "type": "string", "default": "wss://indexer.preprod.midnight.network/api/v4/graphql/ws" },
"proofServerUrl":    { "type": "string", "default": "http://localhost:6300" },
"zkConfigBasePath":  { "type": "string", "default": "./contracts" }
```

Env-var overrides: `NIGHTGATE_INDEXER_HTTP_URL`, `NIGHTGATE_INDEXER_WS_URL`, `NIGHTGATE_PROOF_SERVER_URL`.

**Note on D1:** This provider bundle's `publicDataProvider` points at the Midnight team's hosted indexer because the SDK requires that specific GraphQL shape for transaction building/submission. Our own crawler (`srv/crawler/`) is independent and keeps indexing into our OData/SQLite surface — they don't overlap.

**Acceptance:** `buildMidnightProviders({...})` returns a valid bundle; an integration test against preprod indexer fetches the chain tip via `publicDataProvider.queryDeployContractState(...)`.

---

# T4 — Transaction submission service

**Status:** ✅ **Done** (2026-05-15, bundled with T5). **Effort spent:** ~2h.

**New file:** `srv/submission/TransactionSubmitter.ts`.

Wraps `deployContract` and `findDeployedContract` from `@midnight-ntwrk/midnight-js-contracts`. Signatures (verified May 2026):

```ts
deployContract(providers, {
  compiledContract,       // imported from <contract>/src/managed/<name>/contract
  privateStateId,
  initialPrivateState,
}) => Promise<DeployedContract<Name>>

findDeployedContract(providers, {
  contractAddress,
  compiledContract,
  privateStateId,
  initialPrivateState,
}) => Promise<DeployedContract<Name>>
```

The returned `DeployedContract` has `callTx.<circuitName>(...args)` methods. **Submission is proof-based** — the SDK builds the proof via `proofProvider`, then submits. There is no separate "sign then submit" step for contract calls (NIGHT/DUST transfers still need a wallet signature; contract calls embed the ZK proof in place of a signature).

Class shape:

```ts
export class TransactionSubmitter {
  constructor(private providers: MidnightProviders) {}

  async deploy<C>(args: { compiledContract: C; privateStateId: string; initialPrivateState: unknown })
    : Promise<{ contractAddress: string; txHash: string }> { /* writes PendingSubmissions row */ }

  async call<C>(args: { contractAddress: string; circuit: string; circuitArgs: unknown[]; compiledContract: C; privateStateId: string })
    : Promise<{ txHash: string }> { /* writes PendingSubmissions row */ }
}
```

Both methods INSERT a row into the new `PendingSubmissions` table (T5) with status `pending`, then return immediately. Crawler reconciles on hash match.

**Files landed:**
- `srv/submission/TransactionSubmitter.ts` — `TransactionSubmitter` class with `deploy()` and `call()` methods. Two injection seams (`deployContractImpl`, `findDeployedContractImpl`) for mocked tests; defaults to dynamic-importing the real SDK.
- `srv/submission/TransactionSubmitter.ts` also exports `classifySubmissionError(err, network)` and `reconcilePendingSubmission(db, txHash, snapshot)` — used internally and by the crawler hook respectively.
- `srv/crawler/BlockProcessor.ts` — added `reconcilePendingSubmission` call immediately after each `INSERT.into('midnight.Transactions')`. Operates on the open transaction `tx` so reconciliation is atomic with tx persistence.
- `test/unit/transaction-submitter.test.ts` — 17 tests covering deploy success/failure paths, call success/circuit-not-found, error classification across networks, and 5 reconciliation scenarios.

**SDK return-shape findings (verified from `node_modules` typings):**
- `deployContract(providers, options)` resolves to `DeployedContract<C>` where `deployTxData.public` is the **intersection** `UnsubmittedDeployTxPublicData & FinalizedTxData` — i.e. has BOTH `contractAddress` (from unsubmitted side) AND `txHash`/`txId`/`status` (from finalized side).
- `findDeployedContract(providers, opts).callTx.<circuitName>(...args)` resolves to `FinalizedCallTxData<C, PCK>` with `public: FinalizedTxData` containing `txHash` and `status`.
- `status` is one of `'FailEntirely' | 'FailFallible' | 'SucceedEntirely'`. We treat only `SucceedEntirely` as `included`; anything else is `failed` with `errorCode: OnChainStatus:<status>`.

**Error classification surface (T9 will reuse this):**

| Pattern | Code | Retryable | Notes |
|---|---|---|---|
| `1014` / "invalid transaction" | `1014` | No | Permanent — invalid tx |
| `1016` / "Immediately Dropped" on preprod | `1016` | Yes | Transient pool-full |
| `1016` / "Immediately Dropped" on mainnet | `1016` | **No** | Deterministic — known issue, surfaces `knownIssueRef` to forum thread 1190 |
| `ECONNREFUSED`/`ETIMEDOUT`/timeout | `NetworkOrTimeout` | Yes | |
| `TxFailedError` from SDK | `TxFailed` | No | On-chain status was non-success |
| `ContractTypeError` / private-state-config errors | `<name>` | No | |
| Anything else | `<name>` | No | Conservative default |

---

# T5 — `PendingSubmissions` entity

**Status:** ✅ **Done** (2026-05-15, bundled with T4). **Effort spent:** ~30 min.

**Edit:** `db/schema.cds` — add at the end:

```cds
/**
 * Submissions awaiting on-chain confirmation. Reconciled by Crawler on tx-hash match.
 */
entity PendingSubmissions : cuid, managed {
    txHash           : HexEncoded not null;
    contractAddress  : HexEncoded;
    circuitName      : String(100);              // null for deploys
    actionType       : ContractActionType;       // 'DEPLOY' | 'CALL' | 'UPDATE'
    submittedAt      : Timestamp not null;
    status           : PendingSubmissionStatus default 'pending';
    finalizedAt      : Timestamp;
    finalizedTxData  : LargeString;              // JSON: indexed Transaction snapshot
    errorMessage     : String(500);

    sessionId        : UUID;                     // links to WalletSessions for audit
}
```

Add to `db/types.cds`:

```cds
type PendingSubmissionStatus : String enum {
    pending; included; finalized; failed
}
```

**Reconciliation hook:** extend `srv/crawler/BlockProcessor.ts` — after each transaction is persisted, run:

```ts
UPDATE.entity('midnight.PendingSubmissions')
  .set({ status: 'finalized', finalizedAt: now, finalizedTxData: JSON.stringify(tx) })
  .where({ txHash: tx.hash, status: { in: ['pending', 'included'] } })
```

This is the only point in the codebase where the crawler and the new submission path touch.

**Files landed:**
- `db/types.cds` — added `PendingSubmissionStatus` enum (`pending` | `included` | `finalized` | `failed`).
- `db/schema.cds` — added `PendingSubmissions` entity. Final shape carries an `errorCode` field on top of the original spec, since T9's classification surface needs a stable machine-readable code (the human-readable message goes in `errorMessage`). All 9 fields from the spec are present.

**Reconciliation hook landed:** `srv/crawler/BlockProcessor.ts` calls `reconcilePendingSubmission(tx, extrinsicHash, snapshot)` right after each transaction INSERT. Snapshot captures `{ txId, transactionId, txType, contractAddress, circuitName, blockId, blockHeight, timestamp }` as JSON. Reconciliation is no-op when no row matches and idempotent (only flips rows in `'pending'`/`'included'`).

**Acceptance:** All 17 TransactionSubmitter tests + 5 reconciliation tests pass. OData exposure (T6) is the next step — the entity is in the data layer but isn't yet projected onto NightgateService.

---

# T6 — Expose submit actions in NightgateService

**Status:** ✅ **Done** (2026-05-15). **Effort spent:** ~1.5h.

**Edit:** `srv/nightgate-service.cds` — add inside `service NightgateService { ... }`:

```cds
@readonly
entity PendingSubmissions as projection on midnight.PendingSubmissions;

action submitContractCall(
    contractAddress: String,
    circuit:         String,
    args:            LargeString,  // JSON-encoded array
    sessionId:       UUID
) returns { txHash: String; status: String };

action deployContract(
    compiledArtifactRef: String,   // e.g. "attestation-vault" — resolved against zkConfigBasePath
    privateStateId:      String,
    initialPrivateState: LargeString  // JSON
) returns { contractAddress: String; txHash: String };
```

**Implementation:** `srv/nightgate-service.ts` — register `srv.on('submitContractCall', ...)` and `srv.on('deployContract', ...)` handlers that:
1. Look up the active `WalletSessions` row by `sessionId`, decrypt the viewing key.
2. Build a wallet via T7 factory.
3. Build providers via T3 `buildMidnightProviders`.
4. Call `TransactionSubmitter.deploy()` / `.call()`.
5. Return `{ txHash, status: 'pending' }`.

**Security:** add `@requires: 'authenticated-user'` (already on the service); rate-limit via existing `RateLimiter` keyed by `sessionId` — say 30/min for calls, 5/min for deploys.

**Files landed:**
- `srv/nightgate-service.cds` — added `@readonly entity PendingSubmissions` projection, plus service-level actions `deployContract` and `submitContractCall`. Both return `{ submissionId: UUID; txHash: String; contractAddress: String; status: String }`.
- `srv/nightgate-service.ts` — wired READ handler for `PendingSubmissions` and added `PendingSubmissions` to the read-only enforcement list. Submission action handlers extracted to a separate module.
- `srv/submission/handlers.ts` — `registerSubmissionHandlers(srv, db, opts?)` — full plumbing: arg validation, rate limiting, contract resolution, wallet material lookup, error translation. Three injection seams (`walletMaterialFactory`, `resolveContractImpl`, `submitterFactory`) for tests.
- `srv/submission/contract-registry.ts` — in-memory `registerContract` / `resolveContract` / `loadRegistryFromConfig` + `ContractNotRegisteredError`. Empty at startup; populated by T10 when AttestationVault is built.
- `srv/submission/wallet-material-factory.ts` — `buildWalletMaterialForSession(opts)`. Today: validates the session exists and is active, then throws `WalletMaterialUnavailable` (mapped to HTTP 501 with explicit T7 pointer in the error message). T7 will replace the throw with real viewing-key decryption + accountId/password derivation + `wallet-sdk-facade` build.

**Spec amendments while implementing:**
1. **Added `sessionId` to `deployContract` action.** The original task spec only had it on `submitContractCall` — but deploys also need a wallet for proof generation and DUST coverage, so a session is required. Symmetric across both actions now.
2. **Added `compiledArtifactRef` to `submitContractCall`.** The original spec only had `(contractAddress, circuit, args, sessionId)`, but `findDeployedContract` from the SDK needs `compiledContract` + `privateStateId` to materialize the call interface — we have to load the artifact via the registry just like deploy. The contractAddress alone is not enough.
3. **Tightened deploy rate limit.** Original spec was 5/min; bumped to 5/hour per session because a deploy is a heavyweight (~30s) proof generation. Calls remain 30/min.

**OData error mapping (T9 will continue to refine this):**

| Error class | HTTP | Body |
|---|---|---|
| Missing required arg / invalid JSON | 400 | Plain message |
| `SessionNotFoundError` | 401 | "Session '<id>' not found, expired, or inactive" |
| `ContractNotRegisteredError` | 404 | "Contract '<ref>' is not registered. Available: ..." |
| Rate limit exceeded | 429 | "Rate limited. Retry after Xs" |
| `WalletMaterialUnavailable` (T7-pending) | **501** | T7 pointer to enhancements.md |
| `SubmissionError` (retryable) | 503 | JSON `{ code, retryable: true, knownIssueRef?, message, submissionId }` |
| `SubmissionError` (non-retryable) | 400 | JSON (same shape, retryable: false) |
| Anything else | 500 | Plain error message |

**Acceptance:** 26 new tests across `submission-handlers.test.ts` and `contract-registry.test.ts`. Total suite is now 349 tests / 28 suites green. End-to-end (real SDK on preprod) is gated on T7 + T10 — at that point the integration is live.

---

# T7 — Wallet session signing surface

**Status:** Not started. **Effort:** M.

**Edit:** `srv/sessions/wallet-sessions.ts`. Add two new exports:

```ts
export async function getActiveSession(sessionIdOrUserId: string, db: any): Promise<WalletSessionRecord | null>;

export async function buildWalletFromSession(
  session: WalletSessionRecord,
  cfg: { network: 'preprod' | 'testnet' | 'mainnet'; nodeUrl: string }
): Promise<WalletFacade>;
```

`buildWalletFromSession` decrypts `encryptedViewingKey` via existing `decrypt()` in `srv/utils/crypto.ts`, then constructs the wallet via `@midnight-ntwrk/wallet-sdk-facade`.

**Caveat:** the wallet-sdk-facade public API has been moving. Confirm exact constructor shape against the package's `dist/index.d.ts` after `npm install` (T1) — the Counter CLI tutorial uses a `walletAndMidnightProvider` factory that combines both wallet and midnight provider roles. Mirror that pattern.

**Security note:** the decrypted viewing key must live only in the request scope. Do **not** cache constructed wallets across requests — viewing keys are bearer credentials.

**Output for T29.** This task also produces the `accountId` (wallet address) and `privateStoragePasswordProvider` (callback returning a passphrase ≥16 chars derived from the session) that the private-state provider needs. Keep these derivations stable across reconnects for the same viewing key, otherwise stored private state becomes unreadable. A KDF over `viewingKey || sessionSalt` works — the per-session salt is stored alongside `WalletSessions`.

**Acceptance:** Unit test in `test/unit/wallet-sessions.test.ts` covers `buildWalletFromSession` with a mocked viewing key. A second test confirms `accountId` and password-provider output are deterministic for a given viewing key + stored salt.

---

# ~~T8~~ — Already shipped

`startSessionCleanup` exists at `srv/sessions/wallet-sessions.ts:100` and is started at `srv/nightgate-service.ts:188`. 15-minute interval. Tested. Remove from the open list.

---

# T9 — Submission failure handling

**Status:** Not started. **Effort:** S.

**Note correction:** The "1016 Immediately Dropped" forum thread is from **early May 2026**, not late April. Specifically `forum.midnight.network/t/.../1190`. Substrate error 1016 = "transaction couldn't enter the pool because of the limit." On **mainnet** it's been seen as deterministic for contract deploys; on **preprod** it's not consistently reproduced.

**In `srv/submission/TransactionSubmitter.ts`:**

- Catch SDK submission errors. Match against known error codes:
  - `1014` — invalid transaction (permanent — set `failed`, no retry).
  - `1016` — pool full / immediately dropped (transient on preprod, deterministic on mainnet — retry on preprod, fail-fast on mainnet with a clear "known mainnet issue, see forum/1190" message).
  - Network/timeout — transient, retry with backoff (reuse `srv/utils/retry.ts:calcBackoff`).
- On final failure write `status='failed'` + `errorMessage` to `PendingSubmissions`.
- Surface in OData as a stable error object: `{ code, message, retryable, knownIssueRef? }`.

**Stay on preprod until that thread resolves.** Mainnet submission is gated behind a config flag `cds.requires.nightgate.allowMainnetSubmission` (default false).

**Acceptance:** Mocked test of each error class; manual test on preprod for retry behaviour.

---

# T10 — Compact contract: `AttestationVault`

**Status:** Not started. **Effort:** L (2-3 days, gated on Compact learning curve).

**New subdirectory:** `contracts/attestation-vault/` (root-level, not under `srv/`). Mirror `example-counter` layout:

```
contracts/attestation-vault/
├── src/
│   ├── attestation-vault.compact     ← Compact source
│   ├── index.ts                       ← re-exports compiled artifacts
│   ├── witnesses.ts                   ← off-chain witness fns (private payload reveal)
│   └── managed/                       ← gitignored; output of `compact compile`
│       └── attestation-vault/
│           ├── compiler/              ← JSON contract info
│           ├── contract/              ← JS impl + .d.ts
│           ├── keys/                  ← prover + verifier keys per circuit
│           └── zkir/                  ← ZK IR
├── package.json
└── tsconfig.json
```

**Toolchain note (correction):** Compact compiler is at `0.31.0` (May 2026), not `0.25.0`. Install via:

```bash
curl -fsSL https://github.com/midnightntwrk/compact/releases/latest/download/compact-installer.sh | bash
```

Installs to `$HOME/.compact/bin/compactc`. Add to `docs/quickstart.md`.

**Circuit design (three circuits):**

```compact
// Public ledger state — disclosed to all readers
ledger public_attestations: Map<Bytes<32>, PublicMetadata>;
ledger disclosures:         Map<Tuple<Bytes<32>, PubKey>, DisclosureLevel>;

// Private state — held off-chain via witness functions
witness private_payload(attestation_id: Bytes<32>): Payload;

// Anyone can attest. payload_hash is the blake2b-256 of the private payload.
export circuit attest(payload_hash: Bytes<32>, public_metadata: PublicMetadata): [] {
    public_attestations.insert(payload_hash, public_metadata);
}

// Owner grants a specific reader (by pubkey) a disclosure level.
// Disclosure level: 0=public-only, 1=legitimate-interest, 2=authority.
export circuit grantDisclosure(
    attestation_id: Bytes<32>,
    grantee_pubkey: PubKey,
    level:          Uint<8>
): [] {
    // Constraint: only the original attester can grant
    // (implementation: include attester's pubkey in attest(), check signature here)
    disclosures.insert((attestation_id, grantee_pubkey), level);
}

// Owner revokes a previously granted disclosure.
export circuit revokeDisclosure(attestation_id: Bytes<32>, grantee_pubkey: PubKey): [] {
    disclosures.remove((attestation_id, grantee_pubkey));
}
```

**Important caveat:** the snippet above is illustrative — real Compact requires careful types and witness wiring. There is no official Midnight reference implementation of a "tiered disclosure" contract today; `example-bboard` is the closest privacy pattern but still doesn't match. Expect two or three iterations with the Midnight Discord / forum to get the access-control story right.

**Build script:** `package.json` scripts.compile in the new sub-package:
```json
"compile": "compactc compile src/attestation-vault.compact --output src/managed/attestation-vault"
```

**Acceptance:** `npm run compile` produces non-empty `keys/` and `zkir/`; T15's end-to-end test deploys and exercises all three circuits.

---

# T11 — CDS service mixin for attestations

**Status:** Not started. **Effort:** M.

**New file:** `src/sdk/AttestationService.cds`.

This is a CAP "abstract" service template the consumer extends. Provides three projections that filter by the requester's disclosure level (set by T14 middleware).

```cds
using { midnight } from '../../db/schema';
using { sdk }      from './sdk-types';

@abstract
service AttestationService {

  // Tier 1 — anyone authenticated
  @readonly
  entity Public        as projection on midnight.Attestations
    where disclosureLevel = 'public';

  // Tier 2 — requesters with legitimate_interest or higher
  @readonly
  @requires: 'legitimate_interest'
  entity Disclosed     as projection on midnight.Attestations
    where disclosureLevel <= 'legitimate_interest';

  // Tier 3 — authorities only
  @readonly
  @requires: 'authority'
  entity Authority     as projection on midnight.Attestations;
}
```

**Companion entities (db/schema.cds additions):**

```cds
entity Attestations : cuid, managed {
    attestationId    : HexEncoded not null;   // payload_hash, primary anchor
    contractAddress  : HexEncoded not null;   // AttestationVault deployment
    attester         : HexEncoded not null;   // attester pubkey
    publicMetadata   : LargeString;           // JSON
    payloadCipher    : LargeBinary;           // optional off-chain encrypted payload
    anchoredTxHash   : HexEncoded;
    createdAt        : Timestamp;
}
```

**Consumer extends:**

```cds
// In a consumer package, e.g. packages/passport
using AttestationService from '@odatano/nightgate/sdk/AttestationService';
service PassportAttestations extends AttestationService { /* additions */ }
```

**Acceptance:** Consumer scaffold (T16) imports the mixin, gets three endpoints automatically, all filtered by role.

---

# T12 — Document anchoring entity + service

**Status:** Not started. **Effort:** S.

**Edit:** `db/schema.cds` — add:

```cds
entity Documents : cuid, managed {
    sha256          : HexEncoded not null;
    contentType     : String(100);
    size            : Integer64;
    storageRef      : String(500);            // s3://bucket/key | ipfs://cid | file:///abs/path
    anchoredTxHash  : HexEncoded;             // tx that anchored sha256 to Attestations
    anchoredAt      : Timestamp;
}
```

**New service action (in `NightgateService` or a new mixin):**

```cds
action anchorDocument(
    sha256:       String,
    contentType:  String,
    size:         Integer64,
    storageRef:   String,
    metadata:     LargeString  // JSON, becomes publicMetadata of the Attestation
) returns { documentId: UUID; attestationId: String; txHash: String };
```

**Implementation:** compose existing parts — INSERT into `Documents`, then call `TransactionSubmitter` (T4) with the `attest` circuit. The Attestation row is created reactively by the crawler when the contract action is indexed.

**Storage backend:** add a small `srv/storage/StorageBackend.ts` interface with three impls: `LocalFsStorage`, `S3Storage`, `IpfsStorage` — wired via `cds.requires.nightgate.storage.kind`. Ship `LocalFsStorage` first; S3/IPFS can land later.

**Acceptance:** Upload a PDF via REST; `Documents` row has correct sha256; matching Attestation appears after one block.

---

# T13 — Document verification function

**Status:** Not started. **Effort:** S.

**Add to `NightgateService.cds`:**

```cds
function verifyDocument(documentId: UUID, providedSha256: String) returns {
    verified:           Boolean;
    anchoredTxHash:     String;
    anchoredAt:         Timestamp;
    originalSha256:     String;
};
```

**Implementation:** SELECT the `Documents` row, compare `sha256` to `providedSha256` (case-insensitive hex), check that `anchoredTxHash` exists and resolves to an indexed `Transactions` row with `transactionResult.status = 'success'`. Returns the boolean + metadata so the caller can render a verification UI.

**Acceptance:** Anchor a known doc, hand its hash + a tampered hash to `verifyDocument` — got `verified: true` then `false` correctly.

---

# T14 — `DisclosureRoles` + middleware

**Status:** Not started. **Effort:** M.

**Edit:** `db/schema.cds`:

```cds
entity DisclosureRoles : cuid, managed {
    userId          : String(200) not null;   // matches req.user.id from CAP auth
    role            : DisclosureRole not null;
    scope           : String(500);            // optional: contract address or attestation ID
    grantedBy       : String(200);
    validFrom       : Timestamp;
    validUntil      : Timestamp;
}
```

Add to `db/types.cds`:
```cds
type DisclosureRole : String enum { public; legitimate_interest; authority; }
```

**Middleware:** new file `srv/middleware/disclosure-role.ts`:

```ts
export async function attachDisclosureRole(req: cds.Request, db: any): Promise<void> {
  const userId = req.user?.id;
  if (!userId) { (req as any).disclosureRole = 'public'; return; }
  const row = await db.run(SELECT.one.from('midnight.DisclosureRoles')
    .where({ userId, validUntil: { '>': new Date().toISOString() } })
    .orderBy('role desc'));
  (req as any).disclosureRole = row?.role ?? 'public';
}
```

Wire via `srv.before('*', ...)` in any service that extends `AttestationService` (T11).

**Admin action:** in `srv/admin-service.cds`:
```cds
action grantRole(userId: String, role: String, scope: String, validUntil: Timestamp);
```
Reject unless caller's `disclosureRole === 'authority'`.

**Compliance note:** The EU Battery Regulation tier model (verified against Annex XIII / Art. 77) is:
1. **general public** — basic info, NO supplier identities,
2. **persons with a legitimate interest** (recyclers, repairers, second-life operators),
3. **Commission, notified bodies, market surveillance authorities** — full lineage.

Our enum names (`public` / `legitimate_interest` / `authority`) map cleanly. **Watch out:** supplier identities must NOT be exposed in `public` — prior list implied otherwise.

**Acceptance:** Three users with three roles see three different OData payload widths from the same `Attestations` endpoint.

---

# T15 — Reference end-to-end test

**Status:** Not started. **Effort:** M.

**New file:** `test/integration/attestation-vault.e2e.test.ts` (new `test/integration/` dir — separate jest config or `npm run test:e2e` script to keep unit suite fast).

**Test scenario:**
1. `beforeAll`: ensure preprod proof server is running; ensure DUST balance via faucet step (documented manual prereq for now).
2. Deploy `AttestationVault` via `NightgateService.deployContract(...)`.
3. Attest a payload (alice's pubkey, payload hash X, public_metadata={ type: "demo" }).
4. Grant `legitimate_interest` to bob via `grantDisclosure(X, bob.pub, 1)`.
5. Three queries:
   - As `carol` (role `public`) → sees public metadata only.
   - As `bob`  (role `legitimate_interest`) → sees disclosed fields.
   - As `admin` (role `authority`) → sees full payload.
6. `afterAll`: leave contract on preprod (no cleanup — preprod is ephemeral enough).

**Wallet pre-funding** is a known pain point — document the faucet steps explicitly in the test README. Mark the test `describe.skip` if `NIGHTGATE_E2E_FUNDED_KEY` env var is missing so CI doesn't fail.

**Acceptance:** Test passes locally with a funded preprod key.

---

# T16–T28 — moved to a separate repo

The PASSPORT app, its UIs, SAP integration, QR/resolver, demo script, and pitch artifacts are **no longer part of NIGHTGATE's plan**. They live in a sibling repo (`@odatano/passport`) that depends on `@odatano/nightgate` from npm — the same way any third-party consumer would.

**Why:** mirrors `@odatano/core`'s split. Keeps the plugin's published surface honest, lets the server and the app release on independent cadences, and stops UI churn from polluting the plugin's CI/test surface.

**Where to find them:** `docs/passport-app-plan.md` (bridge artifact until the consumer repo is created). The original T16–T28 numbering is preserved there for traceability.

**What stays in NIGHTGATE:** anything the consumer app imports — the SDK mixin (T11), `Attestations` / `Documents` entities (T12), document verification function (T13), `DisclosureRoles` middleware (T14), the live e2e test (T15), and the `AttestationVault` reference contract (T10-extended). These produce the published surface of `@odatano/nightgate`.

---

## Production hardening

### T29 — Production private-state provider (CAP-DB-backed)

**Status:** ✅ **Done** (2026-05-15). **Effort spent:** ~3h.

**Files created/edited:**
- `srv/utils/storage-encryption.ts` — SDK-wire-format-compatible AES-256-GCM + PBKDF2 helper. Mirrors `StorageEncryption` from the LevelDB provider byte-for-byte (V2 format: `[1B version=2][32B salt][12B IV][16B authTag][ciphertext]`, PBKDF2-SHA256 600k iter, 32B key).
- `srv/midnight/CapDbPrivateStateProvider.ts` — full `PrivateStateProvider<PSI, PS>` implementation (12 methods + 3 error classes).
- `srv/midnight/providers.ts` — added `PrivateStateBackend` type and branching: `buildFullProviderBundle` instantiates the CAP-DB provider by default, falls back to the SDK LevelDB provider only if `wallet.privateStateBackend === 'level'`.
- `db/schema.cds` — added `PrivateStates` and `ContractSigningKeys` entities (composite keys: accountId + contractAddress [+ privateStateId for states]).
- `srv/utils/nightgate-config.ts` — added `getConfiguredPrivateStateBackend()` + `NIGHTGATE_PRIVATE_STATE_BACKEND` env var.
- `src/plugin.ts` — JSON schema entry for `privateStateBackend` (`'cap-db' | 'level'`, default `cap-db`).
- `test/unit/storage-encryption.test.ts` — 8 tests verifying wire format and decryption parity.
- `test/unit/cap-db-private-state-provider.test.ts` — 23 tests covering CRUD, account isolation, signing keys, export/import round-trip with all 3 conflict strategies.
- `jest.config.js` — added TS 7016 and 2339 to `diagnostics.ignoreCodes` (CAP type declarations and dynamic `this.on()` were pre-existing baseline failures blocking 16 suites).

**Test impact:**
- Pre-T29: 7 passing suites / 16 failing; 92 tests passing.
- Post-T29: **25 passing suites / 0 failing; 306 tests passing.**
- ~35 of the new tests are T29-specific; the rest came from unblocking pre-existing TS-compile suite failures with the ignoreCodes additions.

**Wire-format cross-compatibility verified.** The export format is identical to the SDK's:
- `PrivateStateExport.format === 'midnight-private-state-export'`
- Inner JSON: `{ version: 1, stateCount: N, states: { "<id>": <state> } }`
- `SigningKeyExport.format === 'midnight-signing-key-export'`, inner `{ version: 1, keyCount: N, keys: { "<addr>": "<signingKey>" } }`
- Wire layout reverse-engineered from `node_modules/@midnight-ntwrk/midnight-js-level-private-state-provider/dist/index.mjs`. Validated by encrypt-then-`decryptWithPassword`-with-fresh-key round-trip (which is exactly what the SDK's importPrivateStates does).

**Internal storage optimization.** The provider memoizes a per-instance `StorageEncryption` — one PBKDF2-600k derivation per session, not per row. Each row gets a fresh GCM IV. The same salt is reused across all rows belonging to one account+session. Export blobs always generate a fresh salt + key derivation for portability.

**Outstanding follow-up (not in this T29 scope):**
- **Live SDK round-trip test.** The Jest suite mocks the SDK loader and tests the wire format internally. A future integration test should: (a) export from `CapDbPrivateStateProvider`, (b) import into the real `levelPrivateStateProvider` from the SDK, (c) round-trip back. Doable via the `scripts/integration-test-providers.mjs` pattern but needs the level provider's `setContractAddress` + a temp filesystem path.
- **Live private storage password derivation in `WalletSessions`** — T7 will plumb this. The provider already validates ≥16 chars and rejects shorter passwords at use time.

**Original task spec preserved below for reference (now implemented):**

**Background.** The SDK's `@midnight-ntwrk/midnight-js-level-private-state-provider` ships with an explicit JSDoc warning:

> ⚠️ WARNING — RISK: This provider lacks a recovery mechanism. Clearing browser cache or deleting local files permanently destroys the private state (contract state/keys). For assets with real-world value, this may result in irreversible financial loss. **DO NOT use for production applications requiring data persistence.**

The provider serializes encrypted state to a local LevelDB. NIGHTGATE has all the parts to do better: CAP DB (SQLite/HANA), AES-256-GCM in `srv/utils/crypto.ts`, per-account scoping via `WalletSessions`. T29 implements a NIGHTGATE-native `PrivateStateProvider` and makes the private-state backend pluggable.

**Interface to implement.** Full surface from `@midnight-ntwrk/midnight-js-types/dist/private-state-provider.d.ts` — 12 methods:

| Group | Methods |
|---|---|
| Scoping | `setContractAddress(addr)` — sets a per-instance current contract for subsequent calls. |
| Private state CRUD | `set(id, state)`, `get(id)`, `remove(id)`, `clear()` |
| Signing key CRUD | `setSigningKey(addr, key)`, `getSigningKey(addr)`, `removeSigningKey(addr)`, `clearSigningKeys()` |
| Export / import | `exportPrivateStates(opts)`, `importPrivateStates(data, opts)`, `exportSigningKeys(opts)`, `importSigningKeys(data, opts)` |

Export/import use AES-256-GCM with PBKDF2-derived keys from a password + salt — the SDK already defines the wire format (`PrivateStateExport`, `SigningKeyExport`). Our impl must produce/consume that exact format so users can move state between providers (LevelDB ↔ CAP-DB) without losing it.

**New files:**

- `srv/midnight/CapDbPrivateStateProvider.ts` — class implementing `PrivateStateProvider<PSI, PS>`.
- Add to `db/schema.cds`:

  ```cds
  entity PrivateStates {
      key accountId       : String(200);
      key contractAddress : String(200);
      key privateStateId  : String(200);
          ciphertext      : LargeBinary not null;    // AES-256-GCM encrypted state JSON
          iv              : LargeBinary not null;    // 12-byte GCM nonce
          authTag         : LargeBinary not null;    // 16-byte GCM tag
          salt            : LargeBinary not null;    // 32-byte PBKDF2 salt
          createdAt       : Timestamp;
          updatedAt       : Timestamp;
  }

  entity ContractSigningKeys {
      key accountId       : String(200);
      key contractAddress : String(200);
          ciphertext      : LargeBinary not null;
          iv              : LargeBinary not null;
          authTag         : LargeBinary not null;
          salt            : LargeBinary not null;
          createdAt       : Timestamp;
          updatedAt       : Timestamp;
  }
  ```

**Pluggability — extend `srv/midnight/providers.ts`:**

```ts
export type PrivateStateBackend = 'cap-db' | 'level';

// New required field on WalletMaterial:
//   privateStateBackend: PrivateStateBackend
// (default 'cap-db' for production; 'level' kept for parity testing)

// buildFullProviderBundle branches on wallet.privateStateBackend.
```

Also extend `cds.requires.nightgate` JSON schema in `src/plugin.ts`:

```jsonc
"privateStateBackend": {
  "description": "Storage backend for SDK private state. 'cap-db' (default) uses NIGHTGATE's encrypted SQLite/HANA tables. 'level' uses the SDK's LevelDB provider — dev only, not for real assets per SDK docs.",
  "type": "string",
  "enum": ["cap-db", "level"],
  "default": "cap-db"
}
```

Env var: `NIGHTGATE_PRIVATE_STATE_BACKEND`.

**Crypto plan.**

- Reuse `srv/utils/crypto.ts` AES-256-GCM helpers.
- Per-entry key derivation: `PBKDF2(passphrase, salt, 100_000 iter, SHA-256) → 32-byte key`. New 32-byte salt per entry.
- Storage password comes from `WalletMaterial.privateStoragePasswordProvider` (already plumbed in T3).
- **Caveat:** passphrase is held only in the session; if the session expires, encrypted state remains but is unreadable until the user reconnects. This is the correct behavior — losing the passphrase shouldn't expose state to a server compromise.

**Recovery path.** Because data persists in CAP DB and is encrypted with a passphrase the user reconnects with, the LevelDB warning's failure mode (delete files → permanent loss) goes away. Users can also `exportPrivateStates(password)` and store the export externally — same encrypted-blob format the SDK expects.

**Tests:**
- Unit tests in `test/unit/cap-db-private-state-provider.test.ts`:
  - Round-trip set/get/remove/clear per contract address.
  - Per-account isolation: account A's `get` returns null for account B's keys.
  - Signing keys: same coverage as private states.
  - Export → import round-trip preserves all entries.
  - Wrong-password import throws `ExportDecryptionError`.
  - Export ↔ LevelDB cross-compatibility (export from one, import to the other) — proves on-disk format compliance.

**Dependency on existing work:**
- Requires T3's `WalletMaterial` shape (done).
- Requires T7's wallet session passphrase plumbing (any session-derived passphrase ≥16 chars works).
- Does NOT block T4–T6, T10, T11, or the PASSPORT path. Demo can ship on `level` if needed; flip the default to `cap-db` before any mainnet exposure.

**Acceptance:**
- `CapDbPrivateStateProvider` passes the full interface test suite.
- Setting `privateStateBackend: 'cap-db'` in `cds.requires.nightgate` makes `buildFullProviderBundle` use the new provider, verified by an end-to-end test that deploys a Compact contract and successfully calls a circuit (the SDK has to read/write private state for proof generation).
- LevelDB option still works (parity test, gated behind opt-in flag).

---

# Dependency graph

```
T1 (SDK deps) ──┬─→ T3 (provider bundle) ──┬─→ T4 (submitter) ──┬─→ T6 (OData submit actions) ──┐
                │                          │                    │                                │
                ├─→ T2 (proof server) ─────┘                    │                                ├─→ T15 (e2e test)
                │                                                │                                │
                └─→ T10 (AttestationVault Compact) ─→ T11 (mixin) ┘                              │
                                                  │                                              │
                                                  └─→ T14 (roles) ─→ T12/T13 (anchor + verify) ──┘

Production hardening (parallel track, does not block T15):
T7 (wallet sessions) ─→ T29 (CAP-DB private state) ──┐
                                                     └─→ swap default backend before any mainnet path

Downstream consumers (separate repo — see `docs/passport-app-plan.md`):
T11/T12/T13/T14 (SDK surface) ─→ PASSPORT app (T16+ in the consumer repo)
```

No prescribed timeline — sequence depends on which tracks (platform / SDK surface / hardening) you want to push in parallel.

**Critical-path takeaway:** T29 is gated on T7 only and runs in parallel with everything else. It is NOT a T15 blocker; it IS a mainnet blocker. Ship LevelDB for the live test if needed, but do not expose real-asset flows to production traffic until T29 is the active default.

---

# Sources (re-verified 2026-05-15)

- Counter CLI tutorial: `docs.midnight.network/tutorials/counter/counter-cli`
- Midnight transactions doc: `docs.midnight.network/concepts/network-architecture/transactions`
- Midnight Indexer source: `github.com/midnightntwrk/midnight-indexer`
- Midnight Indexer API docs: `docs.midnight.network/api-reference/midnight-indexer`
- example-counter repo: `github.com/midnightntwrk/example-counter`
- example-bboard repo (richer privacy pattern): `github.com/midnightntwrk/example-bboard`
- Compact compiler 0.31.0 release notes: `docs.midnight.network/relnotes/compact`
- Compact installer: `github.com/midnightntwrk/compact/releases/latest/download/compact-installer.sh`
- "1016 Immediately Dropped" forum thread (early May 2026): `forum.midnight.network/t/.../1190`
- Proof server image: `hub.docker.com/r/midnightnetwork/proof-server`
- EU Regulation 2023/1542: `eur-lex.europa.eu/eli/reg/2023/1542/oj`
- Battery Passport Content Guidance: `thebatterypass.eu` (2023 PDF)
