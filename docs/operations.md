# Operations

Running NIGHTGATE day-to-day. Audience: anyone deploying it, debugging a stuck sync, or chasing why an action returned 503.

## Scripts at a glance

| Command | When to use | What it does |
|---|---|---|
| `npm run dev` | Iterating on code | `cds watch` with auto-reload + 12 GB heap (`scripts/dev.mjs`) |
| `npm run serve:sync` | Long-running sync, demos | `cds-serve` with 12 GB heap (no watch — avoids restarting on DB writes) |
| `npm run serve` | Production-ish | Plain `cds-serve` (no heap pre-config) |
| `npm run sync:start` | Bootstrap a wallet session | Calls `connectWallet` + `connectWalletForSigning` against `localhost:4004`, reads keys from `.env` |
| `npm run sync:probe` | Check local indexer container | Verifies `localhost:8088` is up + returning data |
| `npm run deploy:e2e` | End-to-end deploy flow | `sync:start` + `registerForDustGeneration` + 90 s wait + `deployContract(counter)` |
| `npm run build` | Before publish or after schema change | Generates `@cds-models/` types + compiles TS in-place |
| `npm run typecheck` | Pre-commit | `tsc --noEmit` |
| `npm test` | Pre-commit | Vitest with coverage (64 suites, 1163 tests) |
| Integration scripts | Verifying SDK wiring | `smoke:sdk`, `integration:providers`, `integration:wallet-keys`, `integration:wallet-facade`, `integration:contract-registry` |

### Why `serve:sync` and not `dev` for long runs

`cds watch` restarts on any change in the watched paths. Once the wallet SDK is syncing, the SQLite DB grows past 100 MB and gets touched frequently, so watch restarts the server every few minutes and kills the sync mid-flight. Use `serve:sync` (no watch, 12 GB heap pre-applied) for sessions you want to leave running for hours.

## Environment configuration

Two layers: `.env` (read by both CDS and our scripts) and CDS config under `cds.requires.nightgate` in `package.json`.

### .env

```env
# Network selection
NIGHTGATE_NETWORK=preprod                                 # preprod | testnet | mainnet
NIGHTGATE_NODE_URL=wss://rpc.preprod.midnight.network/    # Substrate RPC

# Crawler control
NIGHTGATE_CRAWLER_ENABLED=false                           # Turn off during wallet-sync runs

# Local indexer override (only if running the docker container)
# NIGHTGATE_INDEXER_HTTP_URL=http://localhost:8088/api/v4/graphql
# NIGHTGATE_INDEXER_WS_URL=ws://localhost:8088/api/v4/graphql/ws

# Wallet credentials for npm scripts (sync:start, deploy:e2e). NIGHTGATE HD-derives
# the per-role keys from the mnemonic, matching Lace — pass the mnemonic.
# .env is gitignored — these stay local. NEVER commit a real seed/mnemonic.
LACE_VIEWING_KEY=a32699a5a29e453f6e92624c2fbefdee173d3f1178e3f9c71bc3edb7d91c1403
LACE_MNEMONIC="word1 word2 word3 ... word24"

# Production-only: at-rest encryption key for stored viewing/seed keys
# ENCRYPTION_KEY=<64-hex-char>
```

In dev mode without `ENCRYPTION_KEY` set, the crypto layer falls back to a deterministic dev key with a warning log. Across restarts the dev key stays the same (so previously encrypted sessions still decrypt) but production deployments MUST set a real 32-byte secret.

### CDS config

Everything else goes under `cds.requires.nightgate` in `package.json` — see [reference.md#configuration](reference.md#configuration) for the full matrix.

## Local Midnight indexer (optional)

The hosted Midnight indexer at `indexer.preprod.midnight.network` occasionally returns 503s. NIGHTGATE includes a `midnightntwrk/indexer-standalone:4.3.2` service in `docker/docker-compose.yml` as a self-hosted alternative.

### Bring it up

```bash
docker compose -f docker/docker-compose.yml up -d indexer
```

The container talks to the hosted Substrate RPC by default (so we self-host the *flaky* GraphQL layer but keep the *reliable* RPC hosted — see [architecture.md](architecture.md) for the rationale). Storage is SQLite in a named docker volume.

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

A first-time cold sync from genesis on a fresh seed takes ~5-6 h wall-clock. The worker pegs ~3.8 GB heap once the shielded chain scan completes (it doesn't shrink — that's the in-memory merkle tree). Restart-from-blob is in seconds: every 30 s the worker persists state to `WalletSyncStates`, and a subsequent `connectWalletForSigning` for the same accountId loads the prior blob and delta-syncs from there.

## Persistence + restart resilience

Two state tables are load-bearing for restart:

- **`midnight.SyncState`** (singleton row) — crawler's chain-height progress
- **`midnight.WalletSyncStates`** (per-accountId) — wallet SDK's serialized sub-wallet blobs

You can inspect them at any time:

```bash
node -e "const s=require('better-sqlite3'); const r=new s('db/midnight.db',{readonly:true}).prepare('SELECT length(shieldedStateBlob) sh,length(dustStateBlob) du,updatedAt FROM midnight_WalletSyncStates').all(); console.log(r);"
```

Healthy progression looks like:
- `sh` stays roughly stable once at tip (your shielded notes don't change every block)
- `du` grows continuously (dust events flow at ~500/min on preprod)
- `du` may *shrink slightly* between saves (dust UTXOs expire) — that's normal live-tip behavior

If you see `sh` or `du` shrink dramatically, the SDK is probably revalidating during restore; the new value is the post-validation form. Not corruption.

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

When `NIGHTGATE_CRAWLER_ENABLED=false`, the row stays at whatever the last crawler run wrote — chainHeight comes from the node (always fresh), indexedHeight from the persisted SyncState (frozen). `status: unhealthy` and `lag` numbers don't mean anything for the wallet sync.

For wallet sync health, look at the `[facade-persist] saved` log lines (worker is processing events) and at the `WalletSyncStates` blob sizes (they should change between subsequent saves).

## Troubleshooting

### "no facade for sessionId=..."

Worker doesn't have a facade for the supplied session. Either:

1. Session has no signing material (`connectWalletForSigning` was never called)
2. Server was restarted between `connectWalletForSigning` and this call
3. (Pre-Phase-2b fix) the OData user-session UUID was passed instead of the accountId. Verify you're on the post-2026-05-19 build.

For (2): call `connectWalletForSigning` again with the same seed; the facade will rebuild from persisted blobs.

### "Wallet.InsufficientFunds: could not balance dust"

The wallet has less DUST than the operation's fee. Mostly hits on `deployContract` since contract deploys are dust-heavy.

**Diagnosis path:**
1. `getWalletBalance(sessionId)` — what's the actual dust balance?
2. `estimateSendNightFee(...)` or `estimateShield/UnshieldFee(...)` — pre-flight fee for what you're trying to do
3. Compare. If fee > balance, wait for more dust to accrue or register more NIGHT UTXOs to raise the cap.

**Causes:**
- Wallet has no unshielded NIGHT registered for dust gen (no accrual). Run `registerForDustGeneration` first, wait ~1-2 min for first dust.
- Wallet has shielded NIGHT only. Use `unshieldFunds(amount)` to move some unshielded, then `registerForDustGeneration`.
- Wallet is at dust cap (~5 tDUST on preprod default) and you need more. Wait for refill (~100 h to full from empty) or increase NIGHT holding.

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

The hosted preprod indexer's graphql-ws subscription degrades over a long, multi-call session — early calls succeed but later ones can hang inside the SDK's balance/submit (the proof server goes idle). The pre-balance sync wait is bounded (`NIGHTGATE_BALANCE_SYNC_TIMEOUT_MS`, default 180s) so it fails rather than hangs forever, but the SDK's own balance/submit calls aren't. Mitigations: keep sessions short / run independent flows separately, restart the server for a fresh subscription, or use a **caught-up** local indexer for heavy use.

### Server is up but OData requests hang

Phase-2a observation: while the wallet worker is mid-sync at full CPU, the main thread's CAP request pipeline can get starved (10 s `getHealth` curls time out while worker `state-save` events fire normally every 30 s). State-save uses `worker.on('message')` callbacks which don't go through the CAP request pipeline; requests do (auth, AsyncLocalStorage, transaction binding).

**Workarounds:**
- Wait for the wallet to reach tip — once `du` blob is stable-ish, the worker's CPU load drops and request handlers respond again
- For monitoring during sync, prefer direct DB queries over OData calls

### Zombie node processes / port 4004 in use

Multiple `cds-serve` / `cds watch` runs can leave processes holding port 4004:

```powershell
Get-NetTCPConnection -LocalPort 4004 -State Listen
```

Kill stale PIDs before starting a new run.

### Sync seems stuck — no new persist events

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
- [ ] `NIGHTGATE_CRAWLER_ENABLED` is true (or unset — the crawler defaults to on)
- [ ] CAP auth is configured (the default `dummy` strategy passes everyone)
- [ ] Rate limiters reviewed for production load (they're tuned for dev/demo)
- [ ] If using a local indexer container: it has reached `caught_up: true` AND has stable disk available
- [ ] `cds.requires.nightgate.allowMainnetSubmission` is `false` until the [forum 1190 issue](https://forum.midnight.network) is resolved
- [ ] Backup strategy in place for `WalletSyncStates` and `PendingSubmissions`
