# Operations

Running NIGHTGATE day-to-day. Audience: anyone deploying it, debugging a stuck sync, or chasing why an action returned 503.

## Scripts at a glance

| Command | When to use | What it does |
|---|---|---|
| `npm run dev` | Iterating on code | `cds watch` with auto-reload + 12 GB heap (`scripts/dev.mjs`) |
| `npm run serve:sync` | Long-running sync, demos | `cds-serve` with 12 GB heap (no watch - avoids restarting on DB writes) |
| `npm run serve` | Production-ish | Plain `cds-serve` (no heap pre-config) |
| `npm run sync:start` | Bootstrap a wallet session | Calls `connectWallet` + `connectWalletForSigning` against `localhost:4004`, reads keys from `.env` |
| `npm run sync:probe` | Check local indexer container | Verifies `localhost:8088` is up + returning data |
| `npm run deploy:e2e` | End-to-end deploy flow | `sync:start` + `registerForDustGeneration` + 90 s wait + `deployContract(counter)` |
| `npm run wasm-proving:e2e` | Verify in-process proving (server on `NIGHTGATE_PROVING_MODE=wasm`) | NIGHT self-transfer proved without a proof server; strongest with a dead `NIGHTGATE_PROOF_SERVER_URL` |
| `npm run wasm-contract:e2e` | Verify contract flow under wasm mode | `deployContract(counter)` + `increment()`; in wasm mode both prove in-process |
| `npm run wasm-zswap:e2e` | Measure zswap circuits in-process | Deploys `shielded-token`, mints, shielded self-transfer via `sendNight` `tokenTypeHex` |
| `npm run width32:e2e` | Verify the 32-slot vault lineage | Deploys `attestation-vault-32`, 24-field document, attest+anchor batch, k-of-32 diff, crawler-free verify |
| `npm run check:server` | Health-check a running server | Health/readiness plus sponsor dust/balance/sync when `NIGHTGATE_SPONSOR_SESSION_ID` is set; `check:server:hosted` targets the hosted box |
| `npm run build` | Before publish or after schema change | Generates `@cds-models/` types + compiles TS in-place |
| `npm run typecheck` | Pre-commit | `tsc --noEmit` |
| `npm test` | Pre-commit | Full Vitest suite with coverage |
| Integration scripts | Verifying SDK wiring | `smoke:sdk`, `integration:providers`, `integration:wallet-keys`, `integration:wallet-facade`, `integration:contract-registry` |

### Why `serve:sync` and not `dev` for long runs

`cds watch` restarts on any change in the watched paths. Once the wallet SDK is syncing, the SQLite DB grows past 100 MB and gets touched frequently, so watch restarts the server every few minutes and kills the sync mid-flight. Use `serve:sync` (no watch, 12 GB heap pre-applied) for sessions you want to leave running for hours.

## Environment configuration

Two layers: `.env` (read by both CDS and our scripts) and CDS config under `cds.requires.nightgate` in `package.json`.

### .env

```env
# Network selection
NIGHTGATE_NETWORK=preprod                                 # preview | testnet | preprod | mainnet | undeployed
NIGHTGATE_NODE_URL=wss://rpc.preprod.midnight.network/    # Substrate RPC

# Crawler control
NIGHTGATE_CRAWLER_ENABLED=false                           # Turn off during wallet-sync runs

# Local indexer override (only if running the docker container)
# NIGHTGATE_INDEXER_HTTP_URL=http://localhost:8088/api/v4/graphql
# NIGHTGATE_INDEXER_WS_URL=ws://localhost:8088/api/v4/graphql/ws

# Wallet credentials for npm scripts (sync:start, deploy:e2e). NIGHTGATE HD-derives
# the per-role keys from the mnemonic, matching Lace - pass the mnemonic.
# .env is gitignored - these stay local. NEVER commit a real seed/mnemonic.
LACE_VIEWING_KEY=a32699a5a29e453f6e92624c2fbefdee173d3f1178e3f9c71bc3edb7d91c1403
LACE_MNEMONIC="word1 word2 word3 ... word24"

# Production-only: at-rest encryption key for stored viewing/seed keys
# ENCRYPTION_KEY=<64-hex-char>
```

In dev mode without `ENCRYPTION_KEY` set, the crypto layer falls back to a deterministic dev key with a warning log. Across restarts the dev key stays the same (so previously encrypted sessions still decrypt) but production deployments MUST set a real 32-byte secret.

### CDS config

Everything else goes under `cds.requires.nightgate` in `package.json` - see [reference.md#configuration](reference.md#configuration) for the full matrix.

## Local Midnight indexer (optional)

The hosted Midnight indexer at `indexer.preprod.midnight.network` occasionally returns 503s. NIGHTGATE includes a `midnightntwrk/indexer-standalone:4.3.2` service in `docker/docker-compose.yml` as a self-hosted alternative.

### Bring it up

```bash
docker compose -f docker/docker-compose.yml up -d indexer
```

The container talks to the hosted Substrate RPC by default (so we self-host the *flaky* GraphQL layer but keep the *reliable* RPC hosted - see [architecture.md](architecture.md) for the rationale). Storage is SQLite in a named docker volume.

### Verify it's up

```bash
npm run sync:probe
```

Reports `/live` HTTP 200, GraphQL schema accessible, latest indexed block, sample block @ height 100.

### Initial catch-up

The container indexes from genesis. At observed preprod rate (~2-3 blocks/s), full sync of ~830k preprod blocks takes **2-3 days** wall-clock. Watch `docker logs odatano-night-indexer | findstr caught_up` for `"caught_up":true`.

**Don't flip NIGHTGATE to use the local indexer until catch-up is complete**. The wallet SDK's subscriptions assume tip-level data; querying a half-synced indexer leads to silent data gaps.

### Flip NIGHTGATE to use it

In `.env`, uncomment:
```env
NIGHTGATE_INDEXER_HTTP_URL=http://localhost:8088/api/v4/graphql
NIGHTGATE_INDEXER_WS_URL=ws://localhost:8088/api/v4/graphql/ws
```

Restart with `npm run serve:sync`.

## Running a wallet sync

End-to-end first-time flow:

```bash
# Terminal 1: server
docker compose -f docker/docker-compose.yml up -d proof-server
npm run serve:sync

# Terminal 2: bootstrap
npm run sync:start
```

`sync:start` does `connectWallet` + `connectWalletForSigning`. The latter schedules a tracked pre-warm job that syncs the facade to tip; poll `getJobStatus(prewarmJobId, sessionId)` for completion. Expected log progression in the server terminal:

```
[wallet-sessions] facade pre-warm kicked off for d4c0f3cc9d3d285c
[facade] restored prior state for d4c0f3cc9d3d285c: shielded=true unshielded=true dust=true   (or =false on first run)
[worker] facade started for d4c0f3cc9d3d285c (restored=true)
[facade] worker init ok for d4c0f3cc9d3d285c: alreadyExisted=false sdk=wallet-sdk-facade@8.0.x
2026-MM-DD HH:MM:SS RPC-CORE: subscribeRuntimeVersion: disconnected ... 1000 Normal Closure   (twice; harmless)
[facade-persist] saved <sid> sh=N un=N du=N                                                    (every ~30 s once events flow)
```

A first-time cold sync from genesis on a fresh seed takes ~5-6 h wall-clock. The worker pegs ~3.8 GB heap once the shielded chain scan completes (it doesn't shrink - that's the in-memory merkle tree). Restart-from-blob is in seconds: every 30 s the worker persists state to `WalletSyncStates`, and a subsequent `connectWalletForSigning` for the same accountId loads the prior blob and delta-syncs from there.

## Persistence + restart resilience

Two state tables are load-bearing for restart:

- **`midnight.SyncState`** (singleton row) - crawler's chain-height progress
- **`midnight.WalletSyncStates`** (per-accountId) - wallet SDK's serialized sub-wallet blobs

You can inspect them at any time:

```bash
node -e "const s=require('better-sqlite3'); const r=new s('db/midnight.db',{readonly:true}).prepare('SELECT length(shieldedStateBlob) sh,length(dustStateBlob) du,updatedAt FROM midnight_WalletSyncStates').all(); console.log(r);"
```

Healthy progression looks like:
- `sh` stays roughly stable once at tip (your shielded notes don't change every block)
- `du` grows continuously (dust events flow at ~500/min on preprod)
- `du` may *shrink slightly* between saves (dust UTXOs expire) - that's normal live-tip behavior

If you see `sh` or `du` shrink dramatically, the SDK is probably revalidating during restore; the new value is the post-validation form. Not corruption.

## Upgrading to 0.20.0

The release adds one column (`WalletSessions.label`) and one SQL view (the
`BackgroundJobs` projection), so an existing database needs the migration
once:

```bash
npx nightgate-schema-delta                 # or: node scripts/apply-schema-delta.mjs
docker exec odatano-nightgate node scripts/apply-schema-delta.mjs   # in the image
```

It is additive and keeps existing rows. If you skip it, the startup preflight
names exactly what is missing and Nightgate stays offline rather than failing
later on the first `connectWallet`; the host process keeps running.

## Monitoring endpoints

Three plain HTTP routes exist next to the OData functions, because the OData
shapes cannot be consumed by the tools that want this data. `getMetrics()`
returns the Prometheus body wrapped as `{"value": "# HELP ..."}`, which no
scraper parses, and a `HEALTHCHECK` or Kubernetes probe cannot express
`/api/v1/indexer/getReadiness()`.

**They stay off until you configure them.** They are mounted during CAP's
bootstrap event, BEFORE CAP attaches its authentication middlewares to the
service paths, so whatever protects the OData surface does not protect these.
Pick one:

```bash
NIGHTGATE_STATUS_TOKEN=$(openssl rand -hex 32)   # bearer token, the sane default
NIGHTGATE_STATUS_ROUTES=public                   # anonymous, a deliberate choice
```

```bash
curl -H "authorization: Bearer $TOKEN" http://localhost:4004/nightgate/metrics
curl -H "authorization: Bearer $TOKEN" http://localhost:4004/nightgate/health
curl -i -H "authorization: Bearer $TOKEN" http://localhost:4004/nightgate/ready
```

Same payloads as the functions they mirror, computed by the same code
(`srv/monitoring/status.ts`). `/nightgate/ready` is the one with a status code
worth scripting against: 200 when ready, 503 otherwise, with the failing check
named in the body.

The prefix is not decoration. NIGHTGATE is a CAP plugin, usually inside
somebody else's express app, and CAP registers its OWN `/health` immediately
after the bootstrap event where these mount. A handler on a generic path would
shadow the host's liveness endpoint for the whole application, letting a
NIGHTGATE database problem decide a foreign service's health. Override with
`NIGHTGATE_STATUS_ROUTES_PREFIX`; `NIGHTGATE_STATUS_ROUTES=off` disables them.

Two reads answer questions that used to have no answer from outside:

- `getRuntimeInfo()` carries two digests per contract: the generation this
  process LOADED, and what the files hash to right now. `digestStale: true`
  means artifacts were replaced under the running server, which makes the
  generation guard refuse every write job until it restarts. When all writes
  suddenly fail, look here first.
- `getWorkerStatus()` reports the wallet worker at process level. A climbing
  `exitCount` is a crash loop; an `inFlightRpcs` that only grows is a stall.
  It deliberately does not feed `getReadiness()`, so a busy worker never takes
  the process out of rotation. The per-facade list is admin only.

## Reading the indexer health endpoint

`GET /api/v1/indexer/getHealth()` reports the **crawler's** view, not the wallet's:

```json
{
  "status": "unhealthy",
  "chainHeight": 829111,
  "indexedHeight": 40383,
  "lag": 788728,
  "syncStatus": "error"
}
```

When `NIGHTGATE_CRAWLER_ENABLED=false`, the row stays at whatever the last crawler run wrote - chainHeight comes from the node (always fresh), indexedHeight from the persisted SyncState (frozen). `status: unhealthy` and `lag` numbers don't mean anything for the wallet sync.

For wallet sync health, look at the `[facade-persist] saved` log lines (worker is processing events) and at the `WalletSyncStates` blob sizes (they should change between subsequent saves).

## Troubleshooting

### "no facade for sessionId=..."

Worker doesn't have a facade for the supplied session. Either:

1. Session has no signing material (`connectWalletForSigning` was never called)
2. Server was restarted between `connectWalletForSigning` and this call
3. (Pre-Phase-2b fix) the OData user-session UUID was passed instead of the accountId. Verify you're on the post-2026-05-19 build.

For (2): call `connectWalletForSigning` again with the same seed; the facade will rebuild from persisted blobs.

From 0.13.0 the session id itself is also gone after a restart: startup closes the sessions the previous process left behind, since nobody holds their ids any more and each one kept seed material at rest for a day. Reconnect with `connectWallet` and then `connectWalletForSigning`, which is what a consumer does at boot anyway. Configured `NIGHTGATE_FEE_SPONSOR_SESSION` ids are exempt and keep working. Queued jobs that signed with one of the closed sessions are failed at the same time with `PROCESS_RESTART_SESSION_CLOSED` (their replay could no longer decrypt signing material); re-submit the action from the fresh session if it is still wanted. Opt out entirely with `NIGHTGATE_CLOSE_SESSIONS_ON_RESTART=false`.

### A wallet takes forever to reach `CAUGHT UP`

First establish whether it is slow or stuck, which used to be indistinguishable from outside:

```bash
curl "http://localhost:4004/api/v1/nightgate/getWalletSyncProgress(sessionId='...')"
```

`appliedIndex` climbing with `eventsPerSecond` above zero means it is working, just far behind; `etaSeconds` gives the order of magnitude. The same line is in the log at INFO (`genuine-sync [prewarm] ... rate=... eta=...`). An `appliedIndex` that does not move while `elapsedMs` grows, or `isConnected: false`, is a real stall: check the indexer as described below.

If it is merely slow, count how many facades are syncing at once. **Every wallet facade lives in the same worker thread**, and catch-up is CPU-bound single-threaded work, so N concurrent catch-ups each run at roughly 1/N speed. Look for `facade started for ...` lines: one per facade the process has warmed.

Before 0.13.0 the usual cause of unexpected extra facades was restart recovery replaying `connectWalletForSigning`, one per previous ungraceful stop. Those jobs are now dropped on restart (`PROCESS_RESTART_SESSION_JOB_DROPPED`). On an older build, or to clear rows left by one, stop the server and run:

```sql
UPDATE midnight_BackgroundJobs
   SET status = 'failed', errorCode = 'MANUAL_DROP', finishedAt = datetime('now')
 WHERE kind = 'connectWalletForSigning' AND status IN ('pending', 'running');
```

Leave `midnight_WalletSyncStates` alone: that is the expensive warm state, and deleting it forces a full resync.

### "Wallet.InsufficientFunds: could not balance dust"

The wallet has less DUST than the operation's fee. Mostly hits on `deployContract` since contract deploys are dust-heavy.

**Diagnosis path:**
1. `getWalletBalance(sessionId)` - what's the actual dust balance?
2. `estimateSendNightFee(...)` - pre-flight fee for what you're trying to do
3. Compare. If fee > balance, wait for more dust to accrue or register more NIGHT UTXOs to raise the cap.

**Causes:**
- Wallet has no unshielded NIGHT registered for dust gen (no accrual). Run `registerForDustGeneration` first, wait ~1-2 min for first dust.
- Wallet is at dust cap (~5 tDUST on preprod default) and you need more. Wait for refill (~100 h to full from empty) or increase NIGHT holding.
- **Dust-wedged wallet** (pre-0.15.2, or a case that slipped past the guard): a submission that died before the mempool (Substrate 1014 dust contention and friends) leaked its in-flight dust spend, and the wallet's whole dust sat in that one note. Signature in `getWalletBalance`: `registeredNightUtxoCount > 0` but `dustUtxoCount == 0` and `dustPendingCount == 0`, with `dustBalance` pinned at 0 across restarts. Since 0.15.2 the worker restores the dust sub-wallet from a pre-build snapshot on such rejects automatically. Manual heal: stop the server, delete the wallet's `midnight_WalletSyncStates` row, restart and reconnect the session; the cold re-sync rebuilds from chain (~5-15 min on preprod), where the aborted spend never existed.

### "Wallet.Sync: [object ErrorEvent]" spamming the log

GraphQL-WS subscription to the indexer dropped. Most often: the hosted Midnight indexer is having a 503 spell. Check:

```bash
curl -s -o /dev/null -w "HTTP %{http_code}\n" \
  -X POST -H "Content-Type: application/json" \
  -d '{"query":"{__typename}"}' https://indexer.preprod.midnight.network/api/v4/graphql
```

- `HTTP 200` → indexer is fine; might be a transient WS-only issue
- `HTTP 503` → indexer is down. Restart the wallet sync after it's back, or use the local container

### Submissions stall on the 5th+ call of a long session (public indexer)

The hosted preprod indexer's graphql-ws subscription degrades over a long, multi-call session - early calls succeed but later ones can hang inside the SDK's balance/submit (the proof server goes idle). The pre-balance sync wait is bounded (`NIGHTGATE_BALANCE_SYNC_TIMEOUT_MS`, default 180s) so it fails rather than hangs forever, but the SDK's own balance/submit calls aren't. Mitigations: keep sessions short / run independent flows separately, restart the server for a fresh subscription, or use a **caught-up** local indexer for heavy use.

### Contract calls feel slow: read the phase timing

Every `submitContractCall` / `submitContractCallBatch` logs ONE debug line
with a wall-clock phase breakdown (`submitContractCall timing: <contract>.<circuit>
init=..ms compile=..ms findContract=..ms circuitToProve=..ms prove=..ms
balance=..ms submit=..ms total=..ms`), also when a phase throws, so a timeout
attributes itself to its phase. Enable the channel with `DEBUG=nightgate:worker`.
Expected shape on preprod: `prove` (proof server or in-process wasm) and
`submit` (chain inclusion) dominate; `findContract` is ~1 s warm (the two
immutable deploy queries are cached per contract address, the verifier-key
check stays live). A large `circuitToProve` points at local circuit
execution, a large `balance` at wallet sync lag.

### Server is up but OData requests hang

Phase-2a observation: while the wallet worker is mid-sync at full CPU, the main thread's CAP request pipeline can get starved (10 s `getHealth` curls time out while worker `state-save` events fire normally every 30 s). State-save uses `worker.on('message')` callbacks which don't go through the CAP request pipeline; requests do (auth, AsyncLocalStorage, transaction binding).

**Workarounds:**
- Wait for the wallet to reach tip - once `du` blob is stable-ish, the worker's CPU load drops and request handlers respond again
- For monitoring during sync, prefer direct DB queries over OData calls

### Zombie node processes / port 4004 in use

Multiple `cds-serve` / `cds watch` runs can leave processes holding port 4004:

```powershell
Get-NetTCPConnection -LocalPort 4004 -State Listen
```

Kill stale PIDs before starting a new run.

### Sync seems stuck - no new persist events

No `[facade-persist] saved` lines for several minutes:

1. Are the persisted blobs actually changing? The worker skips push if blobs are byte-identical to last save (`if blobs.shielded === lastBlobs.shielded && ...`)
2. Subscription died? Look for any `Wallet.Sync` error lines
3. The Effect.ts fiber may have hit an internal exception that wasn't propagated. Ctrl+C the server and restart; the facade will rebuild from the last blob.

### After a code change, `serve:sync` says "module not found"

You changed a TypeScript file but didn't rebuild. The compiled `.js` files are stale.

```bash
npm run build
```

Then restart. (Or use `npm run dev` while iterating, accepting the watch-driven restarts.)

## Database operations

### Reset (lose everything)

```bash
# Stop server first
rm db/midnight.db*
npm run deploy   # re-create the schema (auto-deploy was removed); loses all blocks, sessions, sync state
```

### Crawler-only reset

```bash
node -e "const s=require('better-sqlite3'); const db=new s('db/midnight.db'); db.exec('DELETE FROM midnight_Blocks; DELETE FROM midnight_SyncState'); db.close();"
```

### Wallet-only reset (force re-sync from genesis)

```bash
node -e "const s=require('better-sqlite3'); const db=new s('db/midnight.db'); db.exec('DELETE FROM midnight_WalletSyncStates'); db.close();"
```

Next `connectWalletForSigning` will start a fresh ~5-6 h cold sync.

## Production checklist (before deploying)

- [ ] `ENCRYPTION_KEY` set to a real 32-byte hex secret (not the dev fallback)
- [ ] CDS database is PostgreSQL or HANA, not SQLite. Production SQLite is now **rejected at startup** (fail closed); `NIGHTGATE_ALLOW_PRODUCTION_SQLITE=true` is a temporary migration-only escape hatch
- [ ] Exactly one replica declared (`NIGHTGATE_REPLICA_COUNT=1`); more than one replica, CAP multitenancy, or (on Cloud Foundry) `CF_INSTANCE_INDEX > 0` fails startup closed
- [ ] `NIGHTGATE_CRAWLER_ENABLED` is true (or unset - the crawler defaults to on)
- [ ] CAP auth is configured (the default `dummy` strategy passes everyone)
- [ ] Rate limiters reviewed for production load (they're tuned for dev/demo)
- [ ] If using a local indexer container: it has reached `caught_up: true` AND has stable disk available
- [ ] `cds.requires.nightgate.allowMainnetSubmission` is `false` until the [forum 1190 issue](https://forum.midnight.network) is resolved
- [ ] Backup strategy in place for `WalletSyncStates` and `PendingSubmissions`
