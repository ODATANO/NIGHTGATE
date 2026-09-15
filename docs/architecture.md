# Architecture

Structure and design decisions, for developers extending NIGHTGATE.

## The two pipelines

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
   atomic writes              state-save (every 60 s)
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
              indexer confirmer: chainStatus + block
              height/hash of the inclusion, by the
              ledger identifier the job stores
```

The crawler indexes chain history from the Substrate node. The wallet SDK builds transactions against the GraphQL indexer and submits via the node. Both write to the CAP DB.

The pipelines share no hash: a job stores the ledger transaction identifier, the crawler indexes the extrinsic hash, the indexer reports a third hash. The indexer confirmer finds a job by its identifier and records block height and hash on the job and its `PendingSubmissions` row; a reorg rollback reverts every outcome at or above the fork height.

## Why a worker thread

The wallet SDK ([Effect.ts](https://effect.website)) saturates the microtask queue while syncing: timers stall and CAP requests time out. In a `worker_threads` worker it has its own event loop, and the main thread stays responsive.

### Worker layout

- `srv/midnight/wallet-worker.ts`: entry (thread guard, key ring hand-over, `parentPort` wiring). Modules in `srv/midnight/worker/` import without a `parentPort`:
  - `context.ts`: the facade registry, the log channel, the memoised SDK loaders, address helpers.
  - `facades.ts`: facade build, sync waits and progress, periodic state save with main-thread acks, per-session submit locks, `evict`.
  - `submit.ts`: dust wedge protection, same-transaction resend, the submit-intent handshake, dedicated submit clients, the wallet providers that route a build through them.
  - `sponsor.ts`: finalized and unbound fee sponsoring, the sponsorable shape check, offer token checks, dust backings and note leases.
  - `contracts.ts`: deploy, call, batch; provider construction, the deployed-contract query cache, phase timing. `private-state.ts`: the private-state proxy over the main thread.
  - `artifacts.ts`: scaffold cache, content-addressed snapshots, generation retention, generation-pinned import. `bounded-cache.ts`: the bounded cache both caches use.
  - `rotation.ts`: generation budget, admission drain, evict-all, `shutdown`. `rpc.ts`: the method table and the message dispatcher.
  - `tokens.ts`: transfers, balances, fee estimates, dust registration.
- `srv/midnight/wallet-worker-client.ts`: main-thread RPC client, one `MessageChannel` per call (`{ kind: 'rpc', method, args, port }`).
- Push events on `parentPort`: `state-save`, `log`, `private-state-rpc`.
- Every 60 s the worker pushes `state-save` with serialized sub-wallet blobs; the main thread writes them.

### Everything SDK-side runs in the worker

Build, balance, prove and submit run in the worker. No SDK object crosses the thread boundary; RPCs return primitives. Main RPCs:

- `walletRegisterDustGeneration` / `walletDeregisterDustGeneration`
- `walletDeployContract` / `walletSubmitContractCall` (artifact imported in the worker)
- `walletTransferNight` (NIGHT or custom token)
- `walletGetBalance`
- `walletEstimateTransferFee` (recipe only, no proof, no submit)

No shield/unshield: NIGHT is unshielded-only.

### Private state proxy

`CapDbPrivateStateProvider` (DB access, encryption) lives on the main thread. A worker proxy forwards each private-state call via `private-state-rpc`, registered under a fresh `proxyId` per submission and removed in `finally`. The synchronous `setContractAddress` is posted without a reply; `worker_threads` delivers messages in order.

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
                                                                │  / deployContract / ...
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
                                                                Indexer confirmer resolves the identifier
                                                                → chainStatus + block height/hash on the
                                                                  job and the attempt row ('finalized')
```

Steps 5-7 run as a background job (`srv/submission/background-jobs.ts`); the action returns `{ jobId, status }` and callers poll `getJobStatus`. Job kinds declare their traits in `srv/submission/job-kinds.ts` (heavy or light class, workflow parent, identifier-keyed). The poller claims pending rows per free class capacity (CAS `pending -> running` with owner and heartbeat) and re-queues a `running` job whose heartbeat is older than `NIGHTGATE_JOB_LEASE_TTL_MS`. A job past the external-effect boundary is never reclaimed; reconciliation resolves it by its identifier. Before balancing, the worker waits for the wallet to reach the tip (`NIGHTGATE_BALANCE_SYNC_TIMEOUT_MS`, default 180 s), since stale dust is rejected as `Custom error: 170`.

### The "sessionId" indirection

The OData `sessionId` is a `WalletSessions` UUID; the worker keys facades by `accountId`, a hash of the viewing key, so sessions of one wallet share a facade. `makeDeployRpcArgs`, `makeCallRpcArgs` and the token-ops args builders pass `accountId` as the worker's `sessionId`; the OData UUID stays on `PendingSubmissions` for audit.

## Signing and proving

Proving needs witness data from the wallet's secret keys, so the server-side flow is one call: build, balance, prove, submit. For that path the seed is stored encrypted (AES-256-GCM, `ENCRYPTION_KEY`) and held in memory for the facade's lifetime.

To keep a key off the server, the caller builds, proves and signs locally with the [txbuilder](txbuilder.md); a sponsor session pays the dust and submits (`sponsorFinalizedTransaction`, `sponsorUnboundTransaction`).

Proving runs on a proof server or in-process (`NIGHTGATE_PROVING_MODE=wasm`: the SDK prover for wallet circuits, `srv/midnight/wasm-proof-provider.ts` for contract circuits).

## Persistence model

### PendingSubmissions

One row per submission attempt:

- insert before the worker call (`pending`)
- `included` with `txHash` on worker return
- `finalized` or `failed` when the indexer confirmer or reconciliation resolves the identifier, with block height and hash
- `failed` with `errorCode` on a submit error

A reorg rollback reverts rows confirmed at or above the fork height.

### PrivateStates

One encrypted blob per (`accountId`, `contractAddress`, `privateStateId`), accessed through the proxy during deploy and call. Replaces the SDK's LevelDB provider.

### WalletSyncStates

Serialized shielded, unshielded and dust sub-wallet state per `accountId`, saved every 60 s and encrypted under the account's data key (`AccountKeys`). A restart resumes from it instead of syncing from genesis.

### WalletSessions

One row per session: encrypted viewing key, plus the encrypted seed after `connectWalletForSigning`. TTL configurable, default 24 h.

### ContractSigningKeys

SDK signing keys per (`accountId`, `contractAddress`), used for deploy and maintenance.

## Provider stack inside the worker

Per contract deploy or call the worker assembles:

| Slot | Source | What |
|---|---|---|
| `publicDataProvider` | `indexer-public-data-provider` package | GraphQL queries + WS subscriptions to the indexer |
| `zkConfigProvider` | `node-zk-config-provider` package | Reads `keys/` and `zkir/` from the contract's `managed/` directory |
| `proofProvider` | `http-client-proof-provider` package, or `srv/midnight/wasm-proof-provider.ts` when `NIGHTGATE_PROVING_MODE=wasm` | ZK proof generation for contract circuits: HTTP to the proof server, or in-process via zkir over the contract's local key material |
| `privateStateProvider` | Proxy back to main thread's `CapDbPrivateStateProvider` | per-(accountId, contractAddress, privateStateId) CRUD |
| `walletProvider` | Built from the worker's facade | `getCoinPublicKey`, `balanceTx`, `submitTx` |
| `midnightProvider` | same object as `walletProvider` | |

Built by `buildWorkerContractProviders()` (`srv/midnight/worker/contracts.ts`) and `buildWorkerWalletProvider()` (`srv/midnight/worker/submit.ts`).

## Network ID is process-global

The SDK holds the network in process-global state (`setNetworkId()`) and throws if unset. The worker calls the idempotent `ensureNetworkId(net, sdk)` before every SDK call. One process serves one network.

## ESM-only SDK in a CommonJS project

The Midnight packages are ESM-only; NIGHTGATE is CommonJS. SDK access uses dynamic `import()`: `srv/midnight/sdk-loader.ts` on the main thread, `loadSdk()` / `loadContractsSdk()` / `loadAddressFormat()` in the worker. `import type` is used where the SDK ships clean `.d.ts` (address-format, ledger-v8); otherwise `any`, checked against the actual `.d.ts`.
