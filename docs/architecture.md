# Architecture

How NIGHTGATE is structured, why, and where the load-bearing design decisions live. Audience: developers who need to understand or extend the system.

## The two pipelines

NIGHTGATE has two parallel data flows that share a single reconciliation point:

```
                Midnight Chain
                ──────────────
                │           │
        Substrate         GraphQL (hosted or local)
        RPC               │
        │                 │ (only the wallet SDK uses this)
        ▼                 ▼
  ┌─────────────┐   ┌──────────────────────────────┐
  │  Crawler    │   │  Wallet SDK in worker thread │
  │  (main)     │   │  - shielded sub-wallet       │
  │             │   │  - unshielded sub-wallet     │
  │             │   │  - dust sub-wallet           │
  └──────┬──────┘   └──────────────┬───────────────┘
         │                         │
   atomic writes              state-save (every 30 s)
   blocks/tx/actions          serialized blobs (~MB-scale)
         │                         │
         ▼                         ▼
   ┌────────────────────────────────────────────────────┐
   │   CAP DB (SQLite dev / HANA prod)                  │
   │   - Blocks, Transactions, ContractActions, ...     │
   │   - PendingSubmissions, PrivateStates              │
   │   - WalletSessions, WalletSyncStates               │
   └────────────────────────────────────────────────────┘
                         ▲
              reconcilePendingSubmission(txHash)
              flips pending → finalized when the
              crawler indexes a tx we submitted
```

Crawler indexes chain history from the Substrate node. The wallet SDK runs ZK transaction operations through the GraphQL indexer and submits via the Substrate node. Both write to the same CAP DB. They meet at `reconcilePendingSubmission`: when the crawler persists a transaction whose hash matches a row in `PendingSubmissions`, the row's status flips from `included` to `finalized`.

The two pipelines could theoretically share data (the indexer's GraphQL view duplicates a lot of what the crawler indexes), but they have different consumers (enterprise OData consumers vs. the wallet SDK's specific subscription shape) and the duplication is the simplest design.

## Why a worker thread

The Midnight wallet SDK is built on [Effect.ts](https://effect.website). Its fiber scheduler **monopolises the host's microtask queue** while a chain sync is running — we observed plain `setInterval` callbacks not firing for 75+ seconds during sync, and CAP request handlers timing out at 10 seconds while persistence saves were going through fine.

The fix is structural: run the wallet SDK in its own `worker_threads` worker. Each worker has its own V8 isolate with its own event loop, so the SDK's microtask saturation only affects that thread.

### Phase 1 — wallet sync isolation (2026-05-17)

- `srv/midnight/wallet-worker.ts` is the worker entry. Holds the `WalletFacade`, runs `facade.start()` for sync, owns the three sub-wallets.
- `srv/midnight/wallet-worker-client.ts` is the main-thread RPC client. One `MessageChannel` per call: post `{ kind: 'rpc', method, args, port }`, await the reply on the port.
- Push events on `parentPort` (no per-call port): `state-save`, `log`, `private-state-rpc`.
- Persistence: every 30 s the worker pushes a `state-save` event with serialized sub-wallet blobs. The main thread writes them via standard CAP `db.run`.

Verification proof: in a Phase-1 test run, the main thread's `setInterval` callbacks fired regularly throughout a 75-second wallet sync — they had been frozen entirely before.

### Phase 2a — dust registration in the worker (2026-05-17)

`facade.registerNightUtxosForDustGeneration` builds + finalizes + submits in one flow. Moving the whole flow into the worker means no SDK objects ever cross the thread boundary — the worker returns only primitives (`txId`, counts, addresses as strings). The RPC is `walletRegisterDustGeneration`.

### Phase 2b — contract deploy + call in the worker (2026-05-17)

`TransactionSubmitter.deploy / .call` used to run the SDK on the main thread. Phase 2b moved them into the worker via new RPCs `walletDeployContract` / `walletSubmitContractCall`. The compiled contract artifact (Compact `managed/` output) is dynamic-imported inside the worker and cached by name.

**New problem this introduced**: the SDK's `PrivateStateProvider` interface is called many times during a deploy/call. The real `CapDbPrivateStateProvider` (with CAP DB access + encryption) lives on the main thread. Solution: a **proxy** in the worker forwards each PS CRUD call back to main via a new `private-state-rpc` message kind. Main has a per-`proxyId` provider map; the worker's proxy is registered with a fresh proxyId per submission and unregistered in `finally`.

`setContractAddress` is synchronous in the SDK contract; we forward it as a fire-and-forget `parentPort.postMessage` (no port, no reply). `worker_threads` guarantees in-order message delivery, so the next async `set` / `get` arrives on main after the address has been applied.

### Phase 2b: token operations + diagnostics (2026-05-19)

The same worker pattern, extended to expose:

- `walletTransferNight` (build + balance + finalize + submit a NIGHT transfer)
- `walletShieldNight` / `walletUnshieldNight` (cross-ledger via `facade.initSwap`)
- `walletDeregisterDustGeneration` (symmetric to register)
- `walletGetBalance` (read-only snapshot of all three sub-wallet balances)
- `walletEstimateTransferFee` / `walletEstimateSwapFee` (build the recipe in the worker, call `facade.estimateTransactionFee`, discard the recipe — no proof generation, no submit)

## Submission flow

For every action that produces an on-chain transaction:

```
Main thread (handler)                                        Worker thread
─────────────────────                                        ─────────────
1. Validate args, rate-limit check                           (idle until step 5)
2. Look up session, decrypt viewing key, derive accountId
3. INSERT pending row in PendingSubmissions
   (status='pending', no txHash yet)
4. Build CapDbPrivateStateProvider for this submission       (only for deploy/call)
   register under fresh proxyId
5. Call walletXxxRpc({ sessionId: accountId, ... })  ──────► handler 'xxx':
                                                                ├─ ensureNetworkId
                                                                ├─ facade lookup by accountId
                                                                ├─ build via facade.transferTransaction
                                                                │  / initSwap / deployContract / ...
                                                                ├─ balance (lightweight)
                                                                ├─ finalizeRecipe (HEAVY: ZK proof)
                                                                ├─ submitTransaction
                                                                └─ return { txId, ...primitives }
                                                                ⇅ private-state-rpc (worker → main)
                                                                  per CRUD call on the proxy
6. unregisterPrivateStateProvider(proxyId)
7. UPDATE row: status='included', txHash, ...
8. Return primitives to OData caller
                                                                Later:
                                                                Crawler indexes the tx by hash
                                                                → reconcilePendingSubmission flips
                                                                  status to 'finalized'
```

Since the 0.2.0 async-job migration the handler doesn't block on this flow: it wraps steps 5–7 in a background job (`srv/submission/background-jobs.ts`), returns `{ jobId, status }` immediately, and callers poll `getJobStatus`. The worker's pre-balance step also waits for the wallet to be synced to tip (bounded by `NIGHTGATE_BALANCE_SYNC_TIMEOUT_MS`, default 180s) so submissions never balance against stale dust (which the node rejects as `Custom error: 170`).

### The "sessionId" indirection

The OData layer's `sessionId` is the user-facing UUID stored in `WalletSessions`. But the worker stores facades keyed on `accountId` — a deterministic hash of the viewing key. Multiple OData sessions with the same wallet share the same facade in the worker.

`TransactionSubmitter.makeDeployRpcArgs` / `makeCallRpcArgs` (and the token-ops handlers) translate `walletMaterial.accountId` → `sessionId` in the worker RPC. The OData session UUID stays on the `PendingSubmissions` row as audit metadata.

This was a bug in the first Phase 2b draft (worker passed the OData UUID as lookup key, missed the facade) — caught on the first live T15 attempt. Now consistently fixed in 4 places: `makeDeployRpcArgs`, `makeCallRpcArgs`, and the 4 token-ops args builders.

## Why no "build → external sign → submit"

ODATANO's Cardano transaction surface returns unsigned CBOR for external signing. The wallet's seed key never touches the server. Midnight doesn't support this pattern cleanly:

- `facade.finalizeRecipe()` triggers **ZK proof generation**. The proof requires witness data derived from the wallet's secret keys.
- The proof generation runs against a proof server (which the SDK calls over HTTP) but feeds it the proving witnesses, which come from the secret keys.
- The result is a `FinalizedTransaction` that bundles proofs + signatures + binding into one opaque object.

The `wallet-sdk-facade` doesn't expose a serialization of `FinalizedTransaction` for "build now, submit later" workflows. The low-level `ledger-v8.Transaction.serialize()` exists, but the facade doesn't surface it as part of its API contract.

**Architectural decision**: NIGHTGATE follows the SDK's grain. Submissions are one-shot — build + balance + prove + submit in a single worker call. The seed key has to be available server-side for proof generation; we accept that and store it encrypted (AES-256-GCM via `ENCRYPTION_KEY`).

What we do expose for safety:
- The seed is decrypted inside the OData handler, passed to the worker, and held in-memory only for the duration of the facade's lifetime.
- Periodic state-save blobs are encrypted with a per-session storage password derived from the viewing key (PBKDF2 + AES-256-GCM).
- A future `connectWalletExternalProver` mode could in principle accept signed-tx-blobs from a hardware wallet, but it's not in scope for now.

## Persistence model

### PendingSubmissions

One row per submission. Lifecycle:

- INSERT before the worker call (status=`pending`, no txHash)
- UPDATE on worker return (status=`included`, txHash set)
- UPDATE by crawler when indexing the tx (status=`finalized`)
- On error: UPDATE to status=`failed` with `errorCode` from `classifySubmissionError`

This is the crash-recovery point. If the server dies between worker submit and DB UPDATE, the row stays in `pending` but the txHash is null. On restart, the row will eventually get reconciled to `finalized` by the crawler IF the tx made it to the chain. If it didn't, the row stays orphan `pending` forever — call `/PendingSubmissions?$filter=status eq 'pending'&$top=10` to find them.

### PrivateStates

Per-(`accountId`, `contractAddress`, `privateStateId`) row with AES-256-GCM encrypted blob. The SDK CRUDs this via the proxy → main pipeline during deploy/call. Replaces the SDK's LevelDB private state provider, which the SDK docs explicitly warn against for production use.

### WalletSyncStates

Per-`accountId` row holding the serialized blobs for all three sub-wallets (shielded, unshielded, dust). Updated every 30 s during sync via the state-save push event. Restart-resilient: on next `connectWalletForSigning`, the facade-builder loads the prior blobs and the SDK does a delta-sync instead of starting from genesis (~5-6 h saved).

The serialized state contains `sub.serializeState()` output verbatim. The SDK's restore path normalizes (sometimes shrinking the blob slightly) — that's not corruption, that's the SDK compacting the format.

### WalletSessions

Per-OData-session UUID. Stores encrypted viewing key (always) + encrypted seed key (only after `connectWalletForSigning`). TTL configurable (default 24 h).

### ContractSigningKeys

SDK-managed per-(accountId, contractAddress) signing keys. Used internally by the SDK during contract deploy + call. Wire-format compatible with the SDK's LevelDB provider exports.

## Provider stack inside the worker

For each contract deploy/call, the worker assembles a 6-provider bundle the SDK expects:

| Slot | Source | What |
|---|---|---|
| `publicDataProvider` | `indexer-public-data-provider` package | GraphQL queries + WS subscriptions to the indexer |
| `zkConfigProvider` | `node-zk-config-provider` package | Reads `keys/` and `zkir/` from the contract's `managed/` directory |
| `proofProvider` | `http-client-proof-provider` package | HTTP to the proof server for ZK proof generation |
| `privateStateProvider` | Proxy back to main thread's `CapDbPrivateStateProvider` | per-(accountId, contractAddress, privateStateId) CRUD |
| `walletProvider` | Built from the worker's facade | `getCoinPublicKey`, `balanceTx`, `submitTx` |
| `midnightProvider` | same object as `walletProvider` | per Counter CLI convention |

`buildWorkerContractProviders()` and `buildWorkerWalletProvider()` in `srv/midnight/wallet-worker.ts` assemble this per call.

## Network ID — process-global gotcha

The Midnight SDK keeps the active network as **process-global** state via `setNetworkId()`. Every wallet/contract operation reads it and throws if it was never set. We call `ensureNetworkId(net, sdk)` in the worker before every SDK invocation. The wrapper is idempotent (cached, no-op on second call with same network).

This is a real footgun if you ever want to handle multi-network in one process. Today we don't.

## ESM-only SDK in a CommonJS project

All `@midnight-ntwrk/*` packages are ESM-only. NIGHTGATE is `"type": "commonjs"`. The submission code uses dynamic `import()` via `srv/midnight/sdk-loader.ts` (main thread) and `loadSdk()` / `loadContractsSdk()` / `loadAddressFormat()` in the worker.

Type-only imports work when the SDK provides clean `.d.ts`: `import type * as AddressFormat from '@midnight-ntwrk/wallet-sdk-address-format'` gives us `AddressFormat.MidnightBech32m`, `AddressFormat.DustAddress`, etc. for type-checking without emitting a `require()`. We use this pattern in the worker for the address-format and ledger-v8 packages.

For SDK packages with messy or absent types, we fall back to `any` and rely on runtime duck-typing — but per the project's no-duck-typing rule, only after verifying the actual `.d.ts` first. We don't write try/catch chains over guessed method names.
