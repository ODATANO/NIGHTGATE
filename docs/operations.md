# Operations

Running NIGHTGATE: scripts, configuration, wallet sync, upgrades, monitoring, troubleshooting.

## Scripts at a glance

| Command | When to use | What it does |
|---|---|---|
| `npm run dev` | Iterating on code | `cds watch`, 12 GB heap (`scripts/dev.mjs`) |
| `npm run serve:sync` | Long sync runs, e2e lanes | `cds-serve`, 12 GB heap, no watch |
| `npm run serve` | Production-like | Plain `cds-serve` |
| `npm run sync:start` | Bootstrap a wallet session | `connectWallet` + `connectWalletForSigning` against `localhost:4004`, keys from `.env` |
| `npm run sync:probe` | Check the local indexer | `localhost:8088` up and returning data |
| `npm run deploy:e2e` | Deploy flow | `sync:start` + `registerForDustGeneration` + 90 s wait + `deployContract(counter)` |
| `npm run sponsored-deploy:e2e` | Sponsored deploy under an agent grant | Grant with `allowDeploy`/`maxDeploys: 1` -> txbuilder `buildDeploySponsorable` -> `sponsorUnboundTransaction` -> follow-up call on the new address -> second deploy refused. `NIGHTGATE_GRANT_CONTRACTS=<a>,<b>` adds contracts; prints `GRANT_TOKEN`/`SPONSOR_SESSION` for `burst-sponsor:e2e` (`NIGHTGATE_AGENT_TOKEN`) |
| `npm run wasm-proving:e2e` | In-process proving (server on `NIGHTGATE_PROVING_MODE=wasm`) | NIGHT self-transfer without a proof server |
| `npm run wasm-contract:e2e` | Contract flow in wasm mode | `deployContract(counter)` + `increment()` |
| `npm run wasm-zswap:e2e` | zswap circuits in-process | Deploys `shielded-token`, mints, shielded self-transfer via `sendNight` `tokenTypeHex` |
| `npm run width32:e2e` | 32-slot vault | Deploys `attestation-vault-32`, 24-field document, attest+anchor batch, k-of-32 diff, crawler-free verify |
| `npm run check:server` | Check a running server | Health/readiness; sponsor dust/balance/sync with `NIGHTGATE_SPONSOR_SESSION_ID`; optional URL argument |
| `npm run build` | Before publish, after schema changes | `@cds-models/` types + in-place TS compile |
| `npm run typecheck` | Pre-commit | `tsc --noEmit` |
| `npm test` | Pre-commit | Vitest suite with coverage |
| Integration scripts | SDK wiring | `smoke:sdk`, `integration:providers`, `integration:wallet-keys`, `integration:wallet-facade`, `integration:contract-registry` |
| `npm run integration:postgres` | Before a tag; after changes to crawler writes, indexes or lock retry | Against PostgreSQL 16: model deploy, `Transactions.raw` BYTEA round trip, `ensureIndexes` idempotency, SQLSTATE classification (55P03, 40P01, 57014, 40001; not 23505), `withLockContentionRetry`. Throwaway `postgres:16` container on port 15432 unless `NIGHTGATE_PG_URL` is set. `check:release:full` = `check:release` + this lane |

### Why `serve:sync` and not `dev` for long runs

`cds watch` restarts on changes in watched paths, including the database files a sync writes, and kills the sync. Use `serve:sync` for runs that last hours.

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

# Wallet credentials for npm scripts (sync:start, deploy:e2e); per-role keys are
# HD-derived from the mnemonic like Lace. .env is gitignored; never commit a mnemonic.
LACE_VIEWING_KEY=a32699a5a29e453f6e92624c2fbefdee173d3f1178e3f9c71bc3edb7d91c1403
LACE_MNEMONIC="word1 word2 word3 ... word24"

# At-rest encryption key for stored viewing/seed keys and job commands
# (key id 1 of the ring; a ring is ENCRYPTION_KEYS=id=secret,... + ENCRYPTION_KEY_ACTIVE)
# ENCRYPTION_KEY=<64-hex-char>
```

Without an encryption key a random per-process dev key is used (warning logged): wallet sessions and encrypted job commands do not survive a restart. Production refuses to start without one.

### CDS config

All other settings: `cds.requires.nightgate`, see [reference.md#configuration](reference.md#configuration).

## Local Midnight indexer (optional)

Self-hosted alternative to the hosted indexer (which returns occasional 503s): `midnightntwrk/indexer-standalone:4.3.3` in `docker/docker-compose.yml`.

### Bring it up

```bash
docker compose -f docker/docker-compose.yml up -d indexer
```

It uses the hosted Substrate RPC by default and stores SQLite in a named volume.

### Verify it's up

```bash
npm run sync:probe
```

Reports `/live` status, GraphQL schema access, latest indexed block and the block at height 100.

### Initial catch-up

Indexes from genesis; a full preprod sync takes days. Wait for `"caught_up":true` in `docker logs odatano-night-indexer`.

**Do not switch NIGHTGATE to the local indexer before catch-up.** Wallet subscriptions against a half-synced indexer produce silent data gaps.

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

`connectWalletForSigning` schedules a prewarm job that syncs the wallet to tip; poll `getJobStatus(prewarmJobId, sessionId)` or `getWalletSyncProgress(sessionId)`. Server log lines to expect: `restored prior state for <id>`, `facade started for <id> (restored=...)`, `periodic-save interval armed for <id> (every 60s)`. `RPC-CORE: subscribeRuntimeVersion: disconnected ... 1000 Normal Closure` is harmless.

A cold sync from genesis takes hours; the worker heap stays near 4 GB after the shielded scan. State is saved every 60 s (`NIGHTGATE_SAVE_INTERVAL_MS`) to `WalletSyncStates`; reconnecting the same account delta-syncs from it in seconds.

## Prover keys

The npm tarball ships no `*.prover` file. The first job that proves a circuit
fetches the missing keys from `NIGHTGATE_ZK_ASSET_URL` (a `/zk-config` base;
shipped contracts default to the release's git tag), verifies them against
`keys/manifest.json` and stores them next to the verifier keys. Artifact
digests and recorded evidence stay unchanged; no restart. Offline installs:

```bash
npx nightgate-fetch-keys attestation-vault
npx nightgate-fetch-keys attestation-vault-32 --from https://host/zk-config/attestation-vault-32
NIGHTGATE_ZK_ASSET_URL=none   # refuse to fetch; a missing key fails the job with PROVER_KEYS_UNAVAILABLE
```

After recompiling a shipped contract, run `npm run keys:manifest` and commit
the manifest with the managed tree (`check:exports` fails on a stale one).
The Docker image carries every key.

## Persistence + restart resilience

Restart state:

- **`midnight.SyncState`** (single row): crawler progress
- **`midnight.WalletSyncStates`** (per account): serialized sub-wallet states

Inspect:

```bash
node -e "const s=require('better-sqlite3'); const r=new s('db/midnight.db',{readonly:true}).prepare('SELECT length(shieldedStateBlob) sh,length(dustStateBlob) du,updatedAt FROM midnight_WalletSyncStates').all(); console.log(r);"
```

Healthy at tip: `sh` roughly stable; `du` grows, and may shrink slightly between saves as dust UTXOs expire. A large shrink after a restore is the SDK's normalized form, not corruption.

### Reorgs and `reindexFromHeight`

Confirmed jobs carry `chainBlockHeight`, `chainBlockHash` and `indexerTxHash`
(`BackgroundJobs`, `PendingSubmissions`). A reorg rollback or
`reindexFromHeight(h)` resets every job and attempt row confirmed at or above
`h` to a pending chain status in the transaction that removes the blocks; the
confirmer re-confirms them on its next tick. The job identifier, extrinsic
hash and indexer transaction hash are three different values; only the
height links a job to a block.

Attempts closed as `CHAIN_EXECUTION_FAILED` (landed, not applied) carry a
height and return to `pending` with their job; pre-mempool rejects have no
height and are not touched. Such a failure without a recorded height parks
under `CHAIN_EXECUTION_FAILED_UNCONFIRMED` until the confirmer records it.

## Schema upgrades

A release that adds columns, tables or views needs the additive migration
once, with the server stopped. New columns are nullable; existing rows keep
their behaviour.

```bash
npx nightgate-schema-delta                 # or: node scripts/apply-schema-delta.mjs
docker exec odatano-nightgate node scripts/apply-schema-delta.mjs   # in the image
```

Without it the startup preflight names the missing objects and NIGHTGATE
stays offline; the host process keeps running.

## Monitoring endpoints

Plain HTTP routes for scrapers and probes (the OData `getMetrics()` wraps the
Prometheus body in JSON).

**Off until configured.** They mount before CAP's authentication, so OData
auth does not protect them. Pick one:

```bash
NIGHTGATE_STATUS_TOKEN=$(openssl rand -hex 32)   # bearer token, the sane default
NIGHTGATE_STATUS_ROUTES=public                   # anonymous, a deliberate choice
```

```bash
curl -H "authorization: Bearer $TOKEN" http://localhost:4004/nightgate/metrics
curl -H "authorization: Bearer $TOKEN" http://localhost:4004/nightgate/health
curl -i -H "authorization: Bearer $TOKEN" http://localhost:4004/nightgate/ready
```

Same payloads as the OData functions (`srv/monitoring/status.ts`).
`/nightgate/ready` answers 200 when ready, else 503 naming the failing check.

The prefix keeps them off the host app's own `/health`. Override with
`NIGHTGATE_STATUS_ROUTES_PREFIX`; `NIGHTGATE_STATUS_ROUTES=off` disables them.

- `getRuntimeInfo()`: per contract the loaded digest and the current file
  digest. `digestStale: true` = artifacts replaced under the running server;
  every write job is refused until restart.
- `getWorkerStatus()`: climbing `exitCount` = crash loop, ever-growing
  `inFlightRpcs` = stall. Not part of `getReadiness()`. Per-facade list admin only.

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

With `NIGHTGATE_CRAWLER_ENABLED=false`, `chainHeight` is fresh (node) but `indexedHeight` is frozen, so `status` and `lag` say nothing about the wallet.

Wallet sync health: `getWalletSyncProgress(sessionId)`.

## Troubleshooting

### "no facade for sessionId=..."

The worker has no facade for the session:

1. `connectWalletForSigning` was never called, or
2. the server restarted since.

Startup closes the previous process's sessions (except `NIGHTGATE_FEE_SPONSOR_SESSION` ids) and fails their queued jobs with `PROCESS_RESTART_SESSION_CLOSED`. Reconnect with `connectWallet` + `connectWalletForSigning` (the facade rebuilds from the saved state) and re-submit. Opt out: `NIGHTGATE_CLOSE_SESSIONS_ON_RESTART=false`.

### A wallet takes forever to reach `CAUGHT UP`

Slow or stuck?

```bash
curl "http://localhost:4004/api/v1/nightgate/getWalletSyncProgress(sessionId='...')"
```

Climbing `appliedIndex` with `eventsPerSecond` > 0: slow, see `etaSeconds` (log: `genuine-sync [prewarm] ... rate=... eta=...`). `appliedIndex` static while `elapsedMs` grows, or `isConnected: false`: stalled, check the indexer (below).

All facades share one worker thread, so N concurrent catch-ups run at about 1/N speed each; count the `facade started for ...` lines.

Restart recovery drops queued `connectWalletForSigning` jobs (`PROCESS_RESTART_SESSION_JOB_DROPPED`). To clear leftover rows, stop the server and run:

```sql
UPDATE midnight_BackgroundJobs
   SET status = 'failed', errorCode = 'MANUAL_DROP', finishedAt = datetime('now')
 WHERE kind = 'connectWalletForSigning' AND status IN ('pending', 'running');
```

Do not delete `midnight_WalletSyncStates`: that forces a full resync.

### A restored wallet stays at one `appliedIndex` and the log repeats `Error while applying sync update`

Cause line: `received an event with a timestamp prior to the time already synced to` (dust) or `values inserted non-linearly into zswap commitment tree` (shielded). The restored snapshot's offset is behind its state, so every replayed event is rejected and the SDK retries forever.

After `NIGHTGATE_SNAPSHOT_REPLAY_RESET_MS` (default 5 min) the worker replaces that sub-wallet with a fresh one syncing from genesis (WARN `snapshot replay <account>: ... replaced by a fresh one syncing from genesis`) and persists it; the genesis sync takes hours. With the reset disabled (`0`): stop the server and delete the account's `midnight_WalletSyncStates` row.

The `sync-state` INFO line (every `NIGHTGATE_SYNC_STATE_LOG_MS` and after a restore) shows dust `appliedIndex`/`syncTime` and shielded `appliedIndex`/`firstFree`. `getSponsorPoolStatus` shows such a sponsor with `caughtUp: false`, `usable: false` and `lastError`.

### "Wallet.InsufficientFunds: could not balance dust"

Less DUST than the fee (typically `deployContract`).

**Diagnosis:** compare `getWalletBalance(sessionId).dustBalance` with `estimateSendNightFee(...)`.

**Causes:**
- No NIGHT registered for dust generation: run `registerForDustGeneration`, first dust after ~1-2 min.
- Wallet at its dust cap: wait for refill or hold more NIGHT.
- **Dust-wedged wallet:** a pre-mempool reject (e.g. 1014) leaked the in-flight dust note. Signature: `registeredNightUtxoCount > 0`, `dustUtxoCount == 0`, `dustPendingCount == 0`, `dustBalance` 0 across restarts. The worker restores the dust sub-wallet from a pre-build snapshot automatically. Manual heal: stop the server, delete the wallet's `midnight_WalletSyncStates` row, restart and reconnect.

### "Wallet.Sync: [object ErrorEvent]" spamming the log

The indexer GraphQL-WS subscription dropped, usually an indexer 503. Check:

```bash
curl -s -o /dev/null -w "HTTP %{http_code}\n" \
  -X POST -H "Content-Type: application/json" \
  -d '{"query":"{__typename}"}' https://indexer.preprod.midnight.network/api/v4/graphql
```

- `HTTP 200`: indexer fine; likely a transient WS issue
- `HTTP 503`: indexer down; restart the sync once it is back, or use the local container

### Submissions stall on the 5th+ call of a long session (public indexer)

The hosted indexer's graphql-ws subscription degrades over long multi-call sessions; later calls can hang inside the SDK's balance/submit (only the pre-balance sync wait is bounded, `NIGHTGATE_BALANCE_SYNC_TIMEOUT_MS`, default 180 s). Mitigation: short sessions, a server restart for a fresh subscription, or a caught-up local indexer.

### Contract calls feel slow: read the phase timing

With `DEBUG=nightgate:worker` every `submitContractCall` / `submitContractCallBatch`
logs one line, also on failure: `submitContractCall timing: <contract>.<circuit>
init=..ms compile=..ms findContract=..ms circuitToProve=..ms prove=..ms
balance=..ms submit=..ms total=..ms`. Normally `prove` and `submit` dominate
and warm `findContract` is about 1 s. Large `circuitToProve` = local circuit
execution; large `balance` = wallet sync lag.

### A proof takes longer than 5 minutes

midnight-js allows 5 min per proof request and re-requests a timed-out proof up to three times. Set `proofTimeoutMs` (cds) / `NIGHTGATE_PROOF_TIMEOUT_MS` above the slowest proof and `MIDNIGHT_PROOF_SERVER_JOB_TIMEOUT` (proof server, default 600 s) above that, else an expired job answers 5xx and is re-proven. `NIGHTGATE_WORKER_RPC_TIMEOUT_MS` must exceed build + prove + submit. Compose reads both variables from `.env`.

### Submit failed with `1000 Normal Closure` / `ECONNRESET`

The RPC closed the websocket during send. The worker checks the indexer, then resends the SAME transaction (`NIGHTGATE_SUBMIT_TRANSPORT_RETRIES`, default 2); log: `resending the SAME transaction (no rebuild, no re-proving)` or `landed`. Failing after the resends = real outage, re-issue. Node rejects (`1010`, `1014`, `1016`) are never resent.

### Contract artifacts outside the package

Point `NIGHTGATE_CONTRACTS_DIR` at the directory. The artifact's bare `@midnight-ntwrk/compact-runtime` import resolves from NIGHTGATE's own node_modules; the directory needs no node_modules. On a running server: admin `registerContract`, then `createAgentGrant` with `allowedContracts`; no restart. The platform allow-list can live in `NIGHTGATE_SPONSOR_POLICY_FILE` (re-read per call).

### Server is up but OData requests hang

A worker syncing at full CPU can starve the main thread's CAP request pipeline (`getHealth` times out while `state-save` events still arrive).

**Workarounds:**
- Wait until the wallet reaches tip; the load drops.
- Monitor via direct DB queries during the sync.

### Zombie node processes / port 4004 in use

```powershell
Get-NetTCPConnection -LocalPort 4004 -State Listen
```

Kill stale PIDs before starting a new run.

### Sync seems stuck - no new persist events

No `save-tick #N pushed` lines (`DEBUG=nightgate:worker`) for several minutes:

1. Unchanged state is not pushed (`save-tick #N unchanged, skipping push`); check `getWalletSyncProgress`.
2. Look for `Wallet.Sync` errors (dead subscription).
3. Otherwise restart the server; the facade rebuilds from the last save.

### After a code change, `serve:sync` says "module not found"

The compiled `.js` files are stale:

```bash
npm run build
```

Then restart (or iterate with `npm run dev`).

## Rotating the encryption key

Ciphertexts name their ring key id, so rotation is additive. The tool rewraps wallet sessions, encrypted job commands and `AccountKeys` (the per-account data keys for private state, signing keys and sync blobs). Rows with `keyScheme` null (`PrivateStates`, `ContractSigningKeys`, `WalletSyncStates`) need the wallet's viewing key: they migrate on reconnect, or via the tool if the session still holds a readable viewing key.

1. Add and activate the new key, keep the old one: `ENCRYPTION_KEYS=k2=<new secret>`, `ENCRYPTION_KEY_ACTIVE=k2`, `ENCRYPTION_KEY` (id `1`) stays. Restart.
2. Stop the server; run `npx nightgate-rewrap-keys --dry-run`, then without `--dry-run` (same `NIGHTGATE_DB_URL` / `NIGHTGATE_DB_PATH` as the server). Exit 0: nothing legacy left. Exit 1: listed accounts still need their viewing key; the old key MUST stay.
3. Start with both keys; reconnecting wallets migrate their rows. Repeat the tool (server stopped) until exit 0. `--drop-legacy-sync-state` deletes sync-state rows of wallets that never return (they re-sync from genesis); private state and signing keys are never dropped.
4. Remove the old key and restart. Startup refuses while a ring-sealed ciphertext names a key outside the ring.

Secrets are read by the main thread only. In production every ring secret needs at least 32 characters.

Envelopes (`v3`) bind key id, purpose and row id in the AAD: a value copied to another row does not decrypt; the tool rewrites `v2` values. The data key is sealed under the ring and under the viewing key: a DB copy plus a viewing key opens nothing without the ring, and removing a ring key without a rewrap loses the data keys it sealed.

## Contract signing keys (maintenance authority)

Each deploy stores a contract signing key in `ContractSigningKeys` (under the deploying account's key). It can replace the contract's verifier keys. Export it once and keep it offline:

```
POST /api/v1/admin/exportContractSigningKey
{ "sessionId": "<deploying session>", "contractAddress": "<address>", "password": "<16+ characters>" }
```

Result: a `midnight-signing-key-export` envelope (`encryptedPayload`, `salt`) sealed under the password, restorable with `importSigningKeys`. Needs the admin role and the session's viewing key; refuses a key row no session has read since the account key was introduced.

## Database operations

### Reset (lose everything)

```bash
# Stop server first
rm db/midnight.db*
npm run deploy   # recreate the schema; all blocks, sessions and sync state are gone
```

### Crawler-only reset

```bash
node -e "const s=require('better-sqlite3'); const db=new s('db/midnight.db'); db.exec('DELETE FROM midnight_Blocks; DELETE FROM midnight_SyncState'); db.close();"
```

### Wallet-only reset (force re-sync from genesis)

```bash
node -e "const s=require('better-sqlite3'); const db=new s('db/midnight.db'); db.exec('DELETE FROM midnight_WalletSyncStates'); db.close();"
```

The next `connectWalletForSigning` starts a cold sync (hours).

## Production checklist (before deploying)

- [ ] `ENCRYPTION_KEY` (or `ENCRYPTION_KEYS` + `ENCRYPTION_KEY_ACTIVE`) set to real secrets
- [ ] after a key rotation: `nightgate-rewrap-keys` exited 0 before the old key was removed
- [ ] Database is PostgreSQL or HANA (image: `NIGHTGATE_DB_URL`, migration via `nightgate-db-migrate`, see docs/docker.md). Production SQLite is rejected at startup; `NIGHTGATE_ALLOW_PRODUCTION_SQLITE=true` is for migration only
- [ ] One replica (`NIGHTGATE_REPLICA_COUNT=1`); more replicas, CAP multitenancy or `CF_INSTANCE_INDEX > 0` fail startup
- [ ] `NIGHTGATE_CRAWLER_ENABLED` true or unset (default on)
- [ ] CAP auth configured (`dummy` admits everyone)
- [ ] Rate limits reviewed for production load
- [ ] Local indexer (if used): `caught_up: true` and enough disk
- [ ] `cds.requires.nightgate.allowMainnetSubmission` stays `false` (mainnet submission is not supported)
- [ ] Backup strategy in place for `WalletSyncStates` and `PendingSubmissions`
- [ ] `npm run check:release:full` passed (the PostgreSQL lane needs Docker or `NIGHTGATE_PG_URL`)
