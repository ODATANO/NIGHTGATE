# Operations

Running, monitoring, upgrading and recovering NIGHTGATE. Configuration keys: [reference.md#configuration](reference.md#configuration).

## Scripts at a glance

| Command | What it does |
|---|---|
| `npm run dev` | `cds watch` with a 12 GB heap. For code changes only |
| `npm run serve:sync` | `cds-serve` with a 12 GB heap, no watch. Use it for long syncs and e2e lanes |
| `npm run serve` | Plain `cds-serve` |
| `npm run deploy` | Creates the SQLite schema in `db/midnight.db` |
| `npm run sync:start` | `connectWallet` and `connectWalletForSigning` against `localhost:4004`, keys from `.env` |
| `npm run sync:probe` | Probes the local indexer on `localhost:8088` |
| `npm run check:server` | Health, readiness and sponsor state of a running server. Optional URL argument, sponsor via `NIGHTGATE_SPONSOR_SESSION_ID` |
| `npm run check:job-idempotency` | Reports duplicate job idempotency keys |
| `node scripts/profile-workers.mjs [s]` | CPU profile of the main thread and every worker. Send `kill -USR1 <pid>` first |
| `npm run build`, `typecheck`, `lint`, `test` | Build, checks and the Vitest suite |
| `npm run check:release` | Release gate. `check:release:full` adds `integration:postgres` |
| e2e lanes | `deploy:e2e`, `sponsored-deploy:e2e`, `wasm-proving:e2e`, `wasm-contract:e2e`, `wasm-zswap:e2e`, `width32:e2e`, `field-predicate-batch:e2e`, `membership:e2e`, `document-diff:e2e`, `anchor-batch:e2e`, `dust-wedge:e2e`, `agent-layer:e2e`, `disclosure:e2e`, `state-verify:e2e`, `txbuilder:e2e`, `burst-sponsor:e2e`, `mint-token:e2e`. Each script header names its env vars. Run them against `serve:sync`, never `dev` |
| integration lanes | `smoke:sdk`, `integration:providers`, `integration:wallet-keys`, `integration:wallet-facade`, `integration:contract-registry`, `integration:connector-routes`, `integration:schema-delta`, `integration:derive-wallet-info`, `integration:utxo-identity`, `integration:postgres` |

`integration:postgres` starts a throwaway `postgres:16` container on port 15432 unless `NIGHTGATE_PG_URL` is set.

Package binaries: `nightgate-schema-delta`, `nightgate-fetch-keys`, `nightgate-db-migrate`, `nightgate-rewrap-keys`, `nightgate-compact-contract-state`.

## Environment

`.env` in the repo root is read by CDS and by the scripts. Template: [.env.example](../.env.example).

```env
NIGHTGATE_NETWORK=mainnet
NIGHTGATE_NODE_URL=ws://<node-host>:9944
NIGHTGATE_INDEXER_HTTP_URL=http://<indexer-host>:8088/api/v4/graphql
NIGHTGATE_CRAWLER_ENABLED=false
LACE_VIEWING_KEY=<64 hex>
LACE_MNEMONIC="word1 word2 ... word24"
# ENCRYPTION_KEY=<64 hex>
```

`LACE_*` are for the scripts only. Never commit a mnemonic. Without an encryption key a random per-process key is used, so sessions and job commands do not survive a restart. Production refuses to start without one.

## Own Midnight indexer

The alternative to a hosted indexer is `midnightntwrk/indexer-standalone` in `docker/docker-compose.yml`. Comparison: [self-hosted.md](self-hosted.md).

```bash
docker compose -f docker/docker-compose.yml up -d indexer
npm run sync:probe
```

- It reads the node in `INDEXER_UPSTREAM_NODE_URL`. Empty means it refuses to start.
- Set `INDEXER_SECRET` to 32 bytes of hex with at least one `a-f` character.
- The compose limits are 8 CPUs and 8 GB. Catch-up is bound by node latency, not by resources.
- A full mainnet sync takes days. Wait for `"caught_up":true` in `docker logs odatano-night-indexer`.
- Switch NIGHTGATE over only after catch-up: `NIGHTGATE_INDEXER_HTTP_URL=http://localhost:8088/api/v4/graphql`. A half-synced indexer leaves silent gaps in wallet state.

## Wallet sync

```bash
docker compose -f docker/docker-compose.yml up -d proof-server
npm run serve:sync
npm run sync:start   # second terminal
```

`connectWalletForSigning` schedules a prewarm job that syncs the wallet to the tip. Poll `getJobStatus(prewarmJobId, sessionId)` or `getWalletSyncProgress(sessionId)`. A cold sync from genesis takes hours. The worker saves state every `NIGHTGATE_SAVE_INTERVAL_MS` to `WalletSyncStates`, and a reconnect restores from it in seconds.

### Pre-synced wallet states

Sponsor wallets can be synced on another machine and imported.

```bash
node scripts/presync-wallets.mjs wallets.json --out presync     # wallets.json holds seeds, keep it out of git
node scripts/import-wallet-state.mjs --dry-run presync/*.json   # server stopped, server env loaded
node scripts/import-wallet-state.mjs presync/*.json
```

The import matches each file to a sponsor session by `sessionId`. It refuses a file whose seed fingerprint, account index, network or SDK version differs. Stop the server first, or a running wallet overwrites the row at its next save.

A saved state restores under the wallet SDK version that wrote it. The one exception: a state from wallet SDK 4.1.0 also restores under 5.0.0. After an upgrade to any other SDK version, every wallet syncs from the start once. On mainnet that takes hours per wallet. To keep the sponsors serving, presync them with the new version before the switch and import the files right after it. The wallets then only catch up the blocks since the presync.

## Prover keys

Prover keys are in neither the npm tarballs nor git. Each `@odatano/contract-*` package ships verifier keys, zkir and `keys/manifest.json`. The first job that proves a circuit fetches the missing keys from the release assets in `contract.json#zkAssetUrl`, or from `NIGHTGATE_ZK_ASSET_URL`. Every key is checked against the manifest.

Offline installs prefetch them once. The image does this at build time.

```bash
npx nightgate-fetch-keys attestation-vault
npx nightgate-fetch-keys @odatano/contract-attestation-vault-32
npx nightgate-fetch-keys attestation-vault-32 --from https://<host>/zk-config/attestation-vault-32
```

With `NIGHTGATE_ZK_ASSET_URL=none` nothing is fetched and a missing key fails the job with `PROVER_KEYS_UNAVAILABLE`.

## Schema upgrades

A release that adds columns, tables or views needs the additive migration once, with the server stopped. Without it the startup check names the missing objects and NIGHTGATE stays offline.

```bash
npx nightgate-schema-delta
docker exec odatano-nightgate node scripts/apply-schema-delta.mjs   # in the image
```

The image runs `cds deploy` against PostgreSQL on every boot. Two changes need a manual step first, and the changelog names them:

- A column that becomes `NOT NULL`: fix the rows that hold NULL in it.
- A removed column: remove the element from the stored model in `cds_model.csn` before the first boot, then `ALTER TABLE ... DROP COLUMN`.

On SQLite `nightgate-schema-delta` sets NULL rows of a `NOT NULL` column to the default and leaves a removed column in place.

### Older databases

- PostgreSQL binary columns written by older releases can hold base64 text: `ContractStates.state` and `zswapState`, `ContractActions.state` and `zswapState`, `Blocks.ledgerParameters`. Repair each column once: `UPDATE <table> SET <col> = decode(convert_from(<col>, 'UTF8'), 'base64') WHERE convert_from(substring(<col> from 1 for 12), 'UTF8') = 'bWlkbmlnaHQ6';`
- Contract states stored on every `ContractActions` row move into `ContractStates` with `npx nightgate-compact-contract-state --dry-run`, then without the flag. Server stopped, idempotent. Reclaim space with `VACUUM FULL midnight_contractactions` or `VACUUM` on SQLite.

## Monitoring

The probes of the indexer service need no credentials.

```bash
curl "http://localhost:4004/odata/v4/midnight-indexer/getLiveness()"
curl -i "http://localhost:4004/odata/v4/midnight-indexer/getReadiness()"   # 503 names the failing check
curl "http://localhost:4004/odata/v4/midnight-indexer/getHealth()"
curl "http://localhost:4004/odata/v4/midnight-indexer/getMetrics()"        # Prometheus text in {"value": "..."}
```

The container HEALTHCHECK (`docker/healthcheck.mjs`) asks `getReadiness()`. Its database read gives up after `NIGHTGATE_READINESS_DB_TIMEOUT_MS`.

| `phase` | Meaning | `ready` |
|---|---|---|
| `starting` | Plugin init not finished | false |
| `failed` | Init ended offline | false |
| `warming` | Sponsor pool prewarm running. Database, crawler and node checks do not count | true if runtime and init pass |
| `catching-up` | Crawler behind the tip | true |
| `ready` | All checks pass | true |
| `degraded` | A check fails now | false |

`getHealth()` is the crawler's view. With the crawler off, `indexedHeight` is frozen and `status` says nothing about wallets. Wallet health: `getWalletSyncProgress(sessionId)`.

Metrics in `getMetrics()`, prefix `odatano_nightgate_`:

| Metric | Meaning |
|---|---|
| `chain_height`, `indexed_height`, `sync_lag`, `sync_status`, `blocks_per_second`, `consecutive_errors` | Crawler |
| `absorbed_transport_faults` | Node transport faults the crawler retried |
| `jobs_queued`, `jobs_running`, `jobs_reconciliation_required`, `jobs_oldest_queued_seconds` | Jobs. Alert on a non-draining `jobs_reconciliation_required` |
| `wallet_worker_running`, `wallet_worker_inflight_rpcs`, `wallet_worker_exits`, `wallet_worker_rotations` | Wallet worker |
| `decode_worker_running`, `decode_worker_inflight_rpcs`, `decode_worker_exits` | Decode worker. It restarts on its next call |
| `event_loop_lag_p99_ms`, `event_loop_lag_max_ms` | Main thread, last 30 s window |
| `db_pool_*` | Database pool |
| `rate_limited_total` | 429 answers per rate class |
| `dust_collapse_ms`, `dust_collapse_p99_ms`, `dust_collapse_runs_total` | Per wallet, with `NIGHTGATE_DUST_SNAPSHOT_COLLAPSE=true` |
| `runtime_database_info`, `runtime_replicas`, `runtime_topology_valid`, `uptime_seconds` | Runtime |

Other probes:

- `getRuntimeInfo()`: `digestStale: true` means artifacts changed under the running server. Write jobs are refused until a restart.
- `getWorkerStatus()`: a rising `exitCount` is a crash loop, a growing `inFlightRpcs` is a stall.
- `getSponsorPoolStatus()`: `usable`, `caughtUp` and `lastError` per sponsor.
- `docker/watchdog.sh` restarts an unhealthy container from cron. It skips the first `NIGHTGATE_WATCHDOG_START_GRACE` seconds after a start, default 900.

## Indexing next to submissions

The crawler runs on the main thread and catches up unthrottled. The image ships with it off. To index on a host that also submits:

1. Pick the first height you need. Nothing below it is indexed.
2. With the crawler off, set the limits. A container needs a recreate to read them.

   ```bash
   NIGHTGATE_CRAWLER_START_HEIGHT=2351371   # empty index only
   NIGHTGATE_CRAWLER_MAX_BPS=20
   NIGHTGATE_FETCH_CONCURRENCY=1
   NIGHTGATE_RPC_BATCH_SIZE=8
   ```

3. Start with admin `resumeCrawler`, stop with `pauseCrawler`. Neither survives a restart. `NIGHTGATE_CRAWLER_ENABLED` decides at boot.
4. Watch the `Catch-up:` log line and `SyncState.blocksPerSecond`.

`startHeight` applies only while the index is empty. Once blocks exist, a restart resumes at the cursor.

### Removing a fee sponsor

A session in `NIGHTGATE_FEE_SPONSOR_SESSION` never expires. Taken out of the list, it expires one session lifetime later (`sessionTtlMs`, default 24 h), and the cleanup then deletes its encrypted seed. Using that wallet again needs its mnemonic, so keep the mnemonic before you remove a sponsor. The boot log names each key-holding session with its expiry.

### Reorgs and reindexing

A reorg rollback or `reindexFromHeight(h)` resets every job and submission confirmed at or above `h` to a pending chain status. The confirmer confirms them again. Never pass a height below the oldest job you care about, and never 0 on a production database.

### A block that will not index

A block that fails on every attempt stops catch-up and sets `syncStatus` to `error` with `lastError`. The log names the height. Recover with `pauseCrawler` then `resumeCrawler`, which retries it once, or `reindexFromHeight` below it. A transient failure, such as a node outage or empty `System.Events`, is retried every 30 s.

## Troubleshooting

### `no facade for sessionId=...`

`connectWalletForSigning` was never called, or the server restarted. Startup closes the previous process's sessions, except fee-sponsor sessions, and fails their queued jobs with `PROCESS_RESTART_SESSION_CLOSED`. Reconnect and submit again. `NIGHTGATE_CLOSE_SESSIONS_ON_RESTART=false` keeps sessions open.

### A wallet does not reach the tip

```bash
curl "http://localhost:4004/odata/v4/midnight/getWalletSyncProgress(sessionId='...')"
```

- `appliedIndex` rising with `eventsPerSecond` above 0: slow, see `etaSeconds` and the `genuine-sync` log line.
- `appliedIndex` static, or `isConnected: false`: stalled, check the indexer.
- Facades share a worker thread, so N parallel catch-ups each run at about 1/N speed.
- Do not delete `WalletSyncStates` rows to speed things up. That forces a sync from genesis.

### A restored wallet repeats `Error while applying sync update`

The restored snapshot is behind its own state, so every replayed event is rejected. After `NIGHTGATE_SNAPSHOT_REPLAY_RESET_MS` the worker replaces that sub-wallet with a fresh one syncing from genesis and logs `snapshot replay`. With the reset set to `0`, stop the server and delete the account's `WalletSyncStates` row.

### `Wallet.InsufficientFunds: could not balance dust`

The wallet has less DUST than the fee. Compare `getWalletBalance(sessionId).dustBalance` with the fee estimate.

- No NIGHT registered for dust: run `registerForDustGeneration`. Dust arrives after about two minutes.
- Wallet at its dust cap: wait, or hold more NIGHT.
- Wedged wallet: `registeredNightUtxoCount > 0` with `dustUtxoCount`, `dustPendingCount` and `dustBalance` at 0 across restarts. Stop the server, delete the wallet's `WalletSyncStates` row and reconnect.

### `Wallet.Sync: [object ErrorEvent]` in the log

The indexer subscription dropped. Check the indexer:

```bash
curl -s -o /dev/null -w "HTTP %{http_code}\n" -X POST -H "Content-Type: application/json" \
  -d '{"query":"{__typename}"}' "$NIGHTGATE_INDEXER_HTTP_URL"
```

- `200`: indexer fine, the drop was transient.
- `403`: a hosted indexer refuses the token.
- `410`: the host is shut down, see [self-hosted.md](self-hosted.md).
- `503`: indexer down.

### Slow contract calls

With `DEBUG=nightgate:worker` every contract call and batch logs a `timing:` line with the duration of each phase. `prove` and `submit` normally dominate. A large `balance` means wallet sync lag.

### A proof takes longer than 5 minutes

Raise `NIGHTGATE_PROOF_TIMEOUT_MS` above the slowest proof and `MIDNIGHT_PROOF_SERVER_JOB_TIMEOUT` of the proof server above that. `NIGHTGATE_WORKER_RPC_TIMEOUT_MS` must exceed build, prove and submit together.

### Submit failed with `1000 Normal Closure` or `ECONNRESET`

The worker checks the indexer, then resends the same transaction up to `NIGHTGATE_SUBMIT_TRANSPORT_RETRIES` times. Node rejects such as `1010`, `1014` and `1016` are never resent. A failure after the retries is an outage, so submit again later.

### Sponsor jobs get slower over days

The restore check of the collapsed dust snapshot grows with the dust tree. Watch `dust_collapse_p99_ms`. Every `uncollapsed` run means a slow restore from that snapshot. A longer `NIGHTGATE_SAVE_INTERVAL_MS` runs the check less often, at the cost of a longer replay after a restart.

### Contract artifacts outside the package

Point `NIGHTGATE_CONTRACTS_DIR` at the directory. On a running server use admin `registerContract`, then `createAgentGrant` with `allowedContracts`. No restart is needed.

## Rotating the encryption key

Ciphertexts name their ring key id, so a rotation is additive.

1. Add and activate the new key, keep the old one: `ENCRYPTION_KEYS=k2=<new secret>`, `ENCRYPTION_KEY_ACTIVE=k2`. Restart.
2. Stop the server. Run `npx nightgate-rewrap-keys --dry-run`, then without the flag, with the server's database settings. Exit 0 means nothing is left. Exit 1 lists accounts that still need their viewing key, and the old key must stay.
3. Start with both keys. Reconnecting wallets migrate their rows. Repeat step 2 until it exits 0. `--drop-legacy-sync-state` deletes sync states of wallets that never return.
4. Remove the old key and restart.

Every ring secret needs at least 32 characters in production. A `v1` or `v2` value in a bound column is refused with `UnboundEnvelopeError` until the tool rewrote it. `NIGHTGATE_ACCEPT_UNBOUND_ENVELOPES=true` reads them meanwhile. Removing a ring key before the rewrap loses the data keys it sealed.

## Contract signing keys

Each deploy stores a contract signing key in `ContractSigningKeys`. It can replace the contract's verifier keys. Export it once and keep it offline:

```
POST /odata/v4/midnight-admin/exportContractSigningKey
{ "sessionId": "<deploying session>", "contractAddress": "<address>", "password": "<16+ characters>" }
```

The result is an envelope sealed under the password. Import exists in code only: `CapDbPrivateStateProvider.importSigningKeys`.

## Database resets

Stop the server first.

```bash
rm db/midnight.db* && npm run deploy   # everything
node -e "new (require('better-sqlite3'))('db/midnight.db').exec('DELETE FROM midnight_Blocks; DELETE FROM midnight_SyncState')"   # crawler only
node -e "new (require('better-sqlite3'))('db/midnight.db').exec('DELETE FROM midnight_WalletSyncStates')"                        # wallets sync from genesis again
```

## Backups

Back up the database and the encryption secrets. Without the ring keys the encrypted rows cannot be read. `WalletSyncStates` saves hours of sync per wallet. `PendingSubmissions` and `BackgroundJobs` hold the evidence of what was sent.

## Production checklist

- [ ] `ENCRYPTION_KEY`, or `ENCRYPTION_KEYS` with `ENCRYPTION_KEY_ACTIVE`, set to real secrets
- [ ] After a rotation, `nightgate-rewrap-keys` exited 0 before the old key was removed
- [ ] PostgreSQL or HANA. Migrate SQLite with `nightgate-db-migrate`, see [docker.md](docker.md)
- [ ] One replica. A second process on the same database waits `NIGHTGATE_INSTANCE_LEASE_TTL_MS`, then refuses to start
- [ ] Crawler on where indexed entities are needed. The image sets `NIGHTGATE_CRAWLER_ENABLED=false`
- [ ] CAP auth configured. `dummy` admits everyone
- [ ] Rate limits checked for production load
- [ ] Own indexer, if used, at `caught_up: true` with enough disk
- [ ] `allowMainnetSubmission` stays `false`
- [ ] Backups of the database and the secrets
- [ ] `npm run check:release:full` passed
