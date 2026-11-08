# Architecture

Structure of NIGHTGATE, for developers extending it.

## Two pipelines

```
        Midnight node                 Midnight indexer
        Substrate RPC                 GraphQL HTTP + WS
             │                              │
             ▼                              ▼
  ┌─────────────────────┐      ┌───────────────────────────────┐
  │ Crawler, main thread│      │ Wallet SDK, worker threads    │
  │ BlockProcessor      │      │ shielded, unshielded and dust │
  │ reorg rollback      │      │ build, prove, submit to node  │
  └──────────┬──────────┘      └───────────────┬───────────────┘
             │ blocks, transactions,           │ wallet state save
             │ contract actions                │ every 60 s
             ▼                                 ▼
  ┌─────────────────────────────────────────────────────────────┐
  │ CAP database: SQLite, PostgreSQL or HANA                    │
  └─────────────────────────────────────────────────────────────┘
             │
             ▼
  OData V4 on /odata/v4/midnight, -indexer, -verify, -analytics, -admin
```

- The crawler indexes chain history from the node. It decodes a block with the ledger of its runtime: ledger 8 below runtime version 2000000, ledger 9 from it.
- The wallet SDK syncs from the indexer and submits to the node.
- The pipelines share no hash. A job stores the ledger transaction identifier, the crawler stores the extrinsic hash, the indexer reports a third hash.
- The indexer confirmer finds a job by its identifier and records block height and hash on the job. A reorg rollback reverts every outcome at or above the fork height.

## Threads

The wallet SDK saturates the microtask queue while it syncs. It runs in `worker_threads` workers, so CAP requests on the main thread stay responsive.

- **Wallet workers**: `srv/midnight/wallet-worker.ts`, modules in `srv/midnight/worker/`. `NIGHTGATE_WALLET_WORKERS` sets the count, default 1. A wallet always lives in the same worker. `NIGHTGATE_SPONSOR_WORKERS=dedicated` gives every pool sponsor its own worker.
- **Dust check helper**: each wallet worker checks the collapsed dust state in a helper thread, `srv/midnight/dust-verify-worker.ts`.
- **Decode worker**: `srv/midnight/decode-worker.ts` reads contract state and decodes ledger payloads for the verify functions and the crawler. Ledger wasm blocks its thread, so this keeps HTTP free. Database writes stay on the main thread.

The main-thread client is `srv/midnight/wallet-worker-client.ts`. Every call gets its own `MessageChannel`. No SDK object crosses a thread boundary. Calls return plain data.

Worker modules:

| File | Content |
|---|---|
| `context.ts` | facade registry, log channel, SDK loaders, address helpers |
| `facades.ts` | facade build, sync waits and progress, periodic state save, per-session locks |
| `submit.ts` | the send path, submit-intent handshake, dust wedge protection |
| `sponsor.ts` | finalized and unbound sponsoring, shape checks, dust backings |
| `contracts.ts` | deploy, call, batch, contract providers |
| `tokens.ts` | transfers, balances, fee estimates, dust registration |
| `artifacts.ts` | contract artifact snapshots pinned by digest |
| `rotation.ts` | worker restart after too many artifact generations |
| `rpc.ts` | method table and dispatcher |
| `private-state.ts` | private-state proxy to the main thread |

The worker pushes `state-save`, `log` and `private-state-rpc` messages on `parentPort`.

## Submission flow

Every action that writes to the chain runs as a background job:

1. The handler validates, checks the rate class and returns `{ jobId, status }`.
2. The scheduler claims the job, `pending` to `running`, with an owner and a heartbeat.
3. The main thread inserts a `PendingSubmissions` row and, for deploys and calls, registers a private-state provider under a fresh proxy id.
4. The worker waits for the wallet to reach the tip, up to `NIGHTGATE_BALANCE_SYNC_TIMEOUT_MS` (180 s). Stale dust is rejected with error 170.
5. The worker builds, balances, proves and submits. Before it sends, it announces the transaction to the main thread.
6. The main thread records the result. The indexer confirmer later sets `finalized` with block height and hash.

Job code lives in `srv/submission/`: `background-jobs.ts`, `job-store.ts`, `job-registry.ts`, `job-scheduler.ts`, `job-reconciliation.ts`. `job-kinds.ts` declares each kind's class. A `running` job with a heartbeat older than `NIGHTGATE_JOB_LEASE_TTL_MS` is reclaimed. A job that may have reached the chain is never reclaimed. Reconciliation resolves it by its identifier.

The OData `sessionId` is a `WalletSessions` id. The worker keys facades by `accountId`, which is derived from the viewing key, so sessions of one wallet share a facade.

## Signing and proving

Server-side signing needs the seed. It is stored encrypted under `ENCRYPTION_KEY` and held in memory while the facade lives. To keep a key off the server, the caller builds, proves and signs with the [txbuilder](txbuilder.md), and a sponsor pays and submits through `sponsorFinalizedTransaction` or `sponsorUnboundTransaction`.

Proving uses a proof server or runs in-process. In wasm mode the SDK prover handles wallet circuits and `srv/midnight/wasm-proof-provider.ts` handles contract circuits.

Per deploy or call the worker assembles these providers, in `buildWorkerContractProviders()` and `buildWorkerWalletProvider()`:

| Slot | Source |
|---|---|
| `publicDataProvider` | midnight-js indexer public data provider |
| `zkConfigProvider` | midnight-js node zk config provider over the contract's keys and zkir |
| `proofProvider` | HTTP proof-server client, or the wasm proof provider |
| `privateStateProvider` | proxy to `CapDbPrivateStateProvider` on the main thread |
| `walletProvider`, `midnightProvider` | built from the worker's facade |

## Persistence

| Entity | Content |
|---|---|
| `PendingSubmissions` | one row per attempt: `pending`, `included`, `finalized` or `failed` |
| `PrivateStates` | encrypted contract private state per account, contract and state id |
| `WalletSyncStates` | serialized sub-wallet state per account, encrypted under its key in `AccountKeys`. A restart resumes from it |
| `WalletSessions` | encrypted viewing key, plus the encrypted seed after `connectWalletForSigning`. TTL `sessionTtlMs`, default 24 h |
| `ContractSigningKeys` | contract maintenance keys per account and contract |

## ESM SDK in a CommonJS project

The Midnight packages are ESM-only. NIGHTGATE is CommonJS. SDK access goes through memoized dynamic `import()`: `srv/midnight/sdk-loader.ts` on the main thread, `loadSdk()`, `loadContractsSdk()` and `loadAddressFormat()` in `srv/midnight/worker/context.ts`.
