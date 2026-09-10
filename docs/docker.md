# Running NIGHTGATE standalone with Docker

The repo is itself a complete CAP application; the `Dockerfile` packages it
so one container yields a working attestation server: all four OData
services, the submission pipeline, wallet sessions, agent grants, and
in-process wasm proving. No host app, no Node installation, no other
container required.

Releases publish the image automatically: every `v*` tag triggers
`.github/workflows/release.yml`, which pushes
`ghcr.io/odatano/nightgate:<version>` and `:latest` and attaches an image
tarball to the GitHub release. So the usual path is pull, not build:

```bash
docker pull ghcr.io/odatano/nightgate:latest
```

## Quickstart

From the repo root:

```bash
ENCRYPTION_KEY=$(openssl rand -hex 32) \
NIGHTGATE_HTTP_PASSWORD=change-me \
docker compose -f docker/docker-compose.yml up -d nightgate
```

Or without compose:

```bash
docker build -t odatano/nightgate:0.16.2 .
docker run -d --name nightgate -p 4004:4004 \
  -e ENCRYPTION_KEY=$(openssl rand -hex 32) \
  -e NIGHTGATE_HTTP_PASSWORD=change-me \
  -v nightgate-data:/data \
  odatano/nightgate:0.16.2
```

The request log (JSON) masks `authorization`, `cookie` and `x-agent-token`
(`log.mask_headers` in the generated CDS config); a host embedding the plugin
gets the same mask at plugin load.

The container runs as the unprivileged `node` user (uid 1000). A named
volume for `/data` inherits that ownership; a bind-mounted host directory
must be writable by uid 1000 (`chown 1000:1000 <dir>`).

The server listens on `http://localhost:4004`; the OData services sit under
`/api/v1/nightgate`, `/api/v1/indexer`, `/api/v1/analytics`,
`/api/v1/admin`. All requests authenticate with HTTP basic
(`nightgate` / your password); agent requests additionally carry their
`x-agent-token` (0.14.0 agent grants).

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `ENCRYPTION_KEY` | required | Encrypts wallet viewing/seed keys and job commands at rest (32+ byte secret); a key ring `ENCRYPTION_KEYS=id=secret,...` + `ENCRYPTION_KEY_ACTIVE` is accepted instead (rotation: docs/operations.md) |
| `NIGHTGATE_HTTP_PASSWORD` | required | Basic-auth password |
| `NIGHTGATE_HTTP_USER` | `nightgate` | Basic-auth user |
| (agent tokens) | - | Requests carrying `x-agent-token` need NO basic credentials for `/api/v1/nightgate`; the agent-grant hook authenticates them (0.17.1), every `$batch` part included (0.23.0) |
| `NIGHTGATE_AUTH` | `basic` | `dummy` serves unauthenticated (local testing ONLY) |
| `NIGHTGATE_NETWORK` | `preprod` | Target Midnight network |
| `NIGHTGATE_CRAWLER_ENABLED` | `false` | Block crawler (verify surface works crawler-free) |
| `NIGHTGATE_NODE_URL` / `NIGHTGATE_INDEXER_HTTP_URL` / `NIGHTGATE_INDEXER_WS_URL` | per-network defaults | Endpoint overrides |
| `NIGHTGATE_PROOF_SERVER_URL` | unset | Set to switch proving from in-process wasm to a proof server |
| `NIGHTGATE_DB_PATH` | `/data/nightgate.db` | SQLite location (persist the `/data` volume) |
| `NIGHTGATE_SQLITE_BUSY_TIMEOUT_MS` | `30000` | How long a writer waits for the SQLite lock; multi-MB wallet-state saves of many warm facades hold it for seconds |
| `NODE_OPTIONS` | `--max-old-space-size=8192` | Heap; keep the container memory limit above it |
| `NIGHTGATE_NODE_FLAGS` | `--no-concurrent-recompilation` | V8 flags on the node command line (V8 flags are refused in `NODE_OPTIONS`). The default keeps optimizing compiles on the calling thread; a background compile thread and the main thread deadlocked at a GC safepoint on a live server (0.23.3). An empty value passes no flag |

Proving default is fully in-process (wasm): zero extra containers, but
proofs run for minutes each and block the executing thread. For serious
throughput bring up the `proof-server` service from the same compose file
and set `NIGHTGATE_PROOF_SERVER_URL=http://proof-server:6300`.

## Watchdog on the healthcheck

The image's HEALTHCHECK probes the readiness route every 30 s, and Docker
marks the container `unhealthy` after five failures. Docker never restarts
it for that: `restart: unless-stopped` acts on exits only. A process that
hangs with its main thread blocked stays up and unhealthy until someone
looks (seen live on 0.23.1: a deadlock inside V8, one hour of timeouts).
Run a watchdog next to the container, for example from cron every minute:

```sh
#!/bin/sh
C=nightgate-api; S=/run/nightgate-watchdog.count
st=$(docker inspect -f '{{.State.Health.Status}}' "$C" 2>/dev/null) || exit 0
n=$(cat "$S" 2>/dev/null || echo 0)
if [ "$st" = unhealthy ]; then
    n=$((n + 1)); echo "$n" > "$S"
    [ "$n" -ge 3 ] && docker restart -t 5 "$C" && echo 0 > "$S"
else
    echo 0 > "$S"
fi
```

Three consecutive unhealthy checks a minute apart, then `docker restart`
with a 5 s stop timeout: a hung main thread cannot handle SIGTERM, so the
90 s grace period would only delay the kill. The restart recovery closes
the previous process's sessions and fails or replays its interrupted jobs
(the sponsor pool re-warms afterwards). `starting` during the boot grace
period does not count.

## Schema upgrades

The entrypoint deploys the schema ONLY when the database file does not
exist yet: `cds deploy` recreates tables, an unconditional deploy would
wipe data on every boot. The startup preflight also probes each release's
NEW columns, so an old database refuses to boot with a migration hint
instead of failing at the first new action. After an image upgrade that
adds entities or columns (0.16.0: `Documents.userId/contractAddress/network`,
`PredicateAttestations.payloadHashB/allowedMask`; 0.18.0:
`PendingSubmissions.submitIntentData`), run the ADDITIVE
migration (keeps all data; it reads `NIGHTGATE_DB_PATH`, which the image
sets to `/data/nightgate.db`):

```bash
docker exec odatano-nightgate node scripts/apply-schema-delta.mjs
```

0.23.0 changed what the crawler stores, not the schema: `Transactions.raw`
now holds the extrinsic as a binary value (CAP's base64 transport; it held
`0x` hex text in a binary column, which PostgreSQL decodes as base64) and
`ContractActions.state` is empty (it was a second copy of the extrinsic).
The schema-delta script re-encodes existing SQLite rows in place and creates
the secondary indexes (the server creates the indexes at startup as well). On PostgreSQL the crawler could not have
indexed correctly before 0.23.0; if it ran, `reindexFromHeight(0)` on the
indexer service is the migration.

Recreating the volume (dev) or a destructive
`npx cds deploy --to "sqlite:/data/nightgate.db"` remain the wipe options.

## PostgreSQL (0.21.1)

Set `NIGHTGATE_DB_URL=postgres://user:pw@host:5432/db` and the container uses
PostgreSQL instead of the SQLite file: the schema is deployed with
`cds deploy` on every boot (additive evolution, an image upgrade brings its
own columns and views), `NIGHTGATE_DB_DEPLOY=never` skips that. The SQLite
busy-timeout and `NIGHTGATE_ALLOW_PRODUCTION_SQLITE` do not apply. The
compose file bundles a `postgres:16-alpine` under `--profile postgres`
(`NIGHTGATE_PG_PASSWORD`; the SQLite quickstart does not need it).

Connection pool (0.21.3): the image sets `requires.db.pool` to max 20,
acquire 30 s, destroy 5 s, idle 60 s, eviction 60 s, `testOnBorrow`, plus a
10 s client connect timeout, and `features.use_generic_pool: true`. CAP's
built-in pool loses a connection per timed-out acquire and empties under
load; the kind defaults (max 10, 1 s) did exactly that on a busy host.
Override any value with CAP's env vars (`cds_requires_db_pool_max=30`,
`cds_requires_db_pool_acquireTimeoutMillis=...`). The bundled
`nightgate-postgres` runs with `shared_buffers=1GB`, `max_wal_size=4GB`,
`checkpoint_timeout=15min`, `wal_buffers=64MB` (the wallet snapshot table is
write-heavy; scale `shared_buffers` with the host).

TLS via the `sslmode` query parameter, limited to what node-postgres honours
exactly: unset/`disable` = no TLS, `require` (or `ssl=true`) = TLS without
certificate verification, `verify-full` = chain and hostname verified against
the system CAs or `sslrootcert=<pem file>`. `allow`/`prefer` (opportunistic
TLS) and `verify-ca` (chain without hostname) are refused, as is any other
value.

Migrating an existing SQLite volume: stop the service, start the database
and wait for its healthcheck, then run the nightgate service once in
`migrate` mode. `docker compose run` attaches the same volume, network and
environment as the service, so the container sees `/data/nightgate.db` and
resolves `nightgate-postgres`:

```bash
docker compose -f docker/docker-compose.yml --profile postgres up -d --wait nightgate-postgres
docker compose -f docker/docker-compose.yml stop nightgate
NIGHTGATE_DB_URL=postgres://nightgate:$NIGHTGATE_PG_PASSWORD@nightgate-postgres:5432/nightgate \
  docker compose -f docker/docker-compose.yml --profile postgres run --rm --no-deps nightgate \
  migrate --from /data/nightgate.db
```

`migrate` mode serves nothing and needs only `NIGHTGATE_DB_URL`: neither
`ENCRYPTION_KEY` nor `NIGHTGATE_HTTP_PASSWORD` is read. It also waits for the
PostgreSQL listener itself (`NIGHTGATE_DB_WAIT_SECONDS`, default 60) before
`cds deploy`, so `--wait` is belt and braces. (A plain `docker run` needs the
project's volume and network names, which compose prefixes with the project:
`docker volume ls` / `docker network ls`.)

It deploys the schema and copies every persisted entity of the model,
`.texts` and CAP's own tables (`cds_outbox_Messages`) included: rows streamed
in batches, integers read as BigInt so `Integer64` keeps every digit, SQLite
0/1 become booleans, JSON columns stay text, views are skipped. A source
table the model does not define is listed; with rows it stops the run
unless `--ignore-unknown`. `Decimal` columns are copied as SQLite holds
them (integral values exact up to 64 bit; a value SQLite stored as a REAL
beyond 2^53 was rounded at write time and aborts the run). Row counts are
compared per table, a mismatch exits non-zero. `--dry-run` prints the plan,
`--force` appends into a non-empty target; the `SyncState` singleton a
previous boot may have written is replaced. The same script is
`npx nightgate-db-migrate --from <file> --to <url>` for a plugin host, which
needs `@cap-js/postgres` and `better-sqlite3` installed (the script says so
by name when one is missing). Keep the SQLite file until the PostgreSQL
backup and a smoke test succeed.

## Operational notes

- Stop gracefully (0.21.7): the entrypoint execs node as PID 1, so
  `docker stop` delivers SIGTERM to the server and cds runs its shutdown
  hooks. Since 0.23.0 that includes the wallet state flush: every facade is
  evicted with an acked final save (up to 60 s) before the worker thread is
  terminated. Give it time: the compose file sets `stop_grace_period: 90s`;
  with a plain `docker stop` pass `-t 90`.
  Before 0.21.7 the signal stopped at `npx`, and every stop was a SIGKILL
  after 10 s.
- Single instance only (`runtimeMode` is enforced by the app); do not scale
  the service to multiple replicas against one database.
- Without `NIGHTGATE_DB_URL` the entrypoint sets
  `NIGHTGATE_ALLOW_PRODUCTION_SQLITE=true`: the core rejects SQLite under the
  production profile by default, and the container is exactly the supported
  exception (one instance, volume-persisted). For production-grade
  deployments set `NIGHTGATE_DB_URL`.
- Mainnet submission stays gated off regardless of configuration.
- The healthcheck probes the HTTP root; first boot needs the start period
  because schema deploy and plugin init run before the port opens.
- The image contains the compiled contract artifacts
  (`contracts/**/managed`), so `attestation-vault`, `counter` and
  `shielded-token` resolve out of the box.
- A consumer's own artifact goes into a directory named by
  `NIGHTGATE_CONTRACTS_DIR` (bind-mount it, e.g. `/data/contracts`) and is
  registered on the running container with the admin action
  `registerContract` (0.21.0); no recreate, no restart. The registration is
  persisted and reloaded at boot. Likewise the sponsor allow-list can live in
  `NIGHTGATE_SPONSOR_POLICY_FILE` under the data volume and is re-read on
  every sponsored call.
