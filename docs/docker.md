# Running NIGHTGATE standalone with Docker

The `Dockerfile` packages the repo as a complete CAP application: all OData
services, submission pipeline, wallet sessions, agent grants and in-process
wasm proving in one container.

Every `v*` tag publishes `ghcr.io/odatano/nightgate:<version>` and `:latest`
(`.github/workflows/release.yml`) plus an image tarball on the GitHub release:

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
docker build -t odatano/nightgate:local .
docker run -d --name nightgate -p 4004:4004 \
  -e ENCRYPTION_KEY=$(openssl rand -hex 32) \
  -e NIGHTGATE_HTTP_PASSWORD=change-me \
  -v nightgate-data:/data \
  odatano/nightgate:local
```

The JSON request log masks `authorization`, `cookie` and `x-agent-token`
(`log.mask_headers`); the plugin sets the same mask in a host app.

Runs as user `node` (uid 1000); a bind-mounted `/data` must be writable by
uid 1000 (`chown 1000:1000 <dir>`).

Listens on `http://localhost:4004`: `/api/v1/nightgate`, `/api/v1/indexer`,
`/api/v1/analytics`, `/api/v1/admin`. HTTP basic auth (`nightgate` / your
password) via `@odatano/cap-auth` (`kind: basic`, realm `nightgate`; 20
failed attempts per 15 min per client address and user, then 429 with
`Retry-After`); agent requests use `x-agent-token`. A request without
credentials is anonymous and the CDS model decides: the read-only indexer
probes (`getLiveness`, `getReadiness`, `getMetrics`, `getSyncStatus`,
`getHealth`) answer without credentials, everything else challenges.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `ENCRYPTION_KEY` | required | Encrypts viewing/seed keys, job commands and account data keys; at least 32 characters in production. Alternative: ring `ENCRYPTION_KEYS=id=secret,...` + `ENCRYPTION_KEY_ACTIVE` (rotation: docs/operations.md) |
| `NIGHTGATE_HTTP_PASSWORD` | required | Basic-auth password |
| `NIGHTGATE_HTTP_USER` | `nightgate` | Basic-auth user |
| (agent tokens) | - | `x-agent-token` requests need no basic credentials on `/api/v1/nightgate`; the grant hook authenticates them, incl. every `$batch` part |
| `NIGHTGATE_AUTH` | `basic` | `dummy` = unauthenticated, local testing only |
| `NIGHTGATE_NETWORK` | `preprod` | Target network |
| `NIGHTGATE_CRAWLER_ENABLED` | `false` | Block crawler (verification works without it) |
| `NIGHTGATE_CRAWLER_START_HEIGHT` | unset | First height to index while the index is empty; unset walks from genesis |
| `NIGHTGATE_CRAWLER_MAX_BPS` | unset | Catch-up rate cap, so the crawler can share the host with the submission side |
| `NIGHTGATE_NODE_URL` / `NIGHTGATE_INDEXER_HTTP_URL` / `NIGHTGATE_INDEXER_WS_URL` | per-network defaults | Endpoint overrides |
| `NIGHTGATE_PROOF_SERVER_URL` | unset | Set = proof-server proving instead of wasm |
| `NIGHTGATE_DB_PATH` | `/data/nightgate.db` | SQLite file (persist `/data`) |
| `NIGHTGATE_SQLITE_BUSY_TIMEOUT_MS` | `30000` | SQLite lock wait for writers (large wallet-state saves hold the lock for seconds) |
| `NODE_OPTIONS` | `--max-old-space-size=8192` | Heap; container memory limit must be higher |
| `NIGHTGATE_NODE_FLAGS` | `--no-concurrent-recompilation` | V8 flags on the node command line (not allowed in `NODE_OPTIONS`). The default avoids a compile-thread/GC-safepoint deadlock; empty = no flag |
| `NIGHTGATE_PUBLIC_VERIFY` | `false` | `verifyAttestationState` / `verifyPredicateState` without credentials under `/api/v1/verify` (CORS preflight `*`) |
| `NIGHTGATE_PUBLIC_VERIFY_RATE_LIMIT` | `60` | Public verify calls per minute per client address |
| `NIGHTGATE_GRANT_ADMIN_RATE_LIMIT` | `10` | Grant administration calls per hour per principal (create, update, rotate, revoke) |

Default proving is in-process wasm: no extra container, but proofs take
minutes and block the thread. For throughput start the compose `proof-server`
service and set `NIGHTGATE_PROOF_SERVER_URL=http://proof-server:6300`.

## Watchdog on the healthcheck

The HEALTHCHECK probes readiness every 30 s; five failures mark the container
`unhealthy`. Docker does not restart unhealthy containers
(`restart: unless-stopped` acts on exits only), so run a watchdog, e.g. from
cron every minute:

```sh
#!/bin/sh
C=odatano-nightgate; S=/run/nightgate-watchdog.count
st=$(docker inspect -f '{{.State.Health.Status}}' "$C" 2>/dev/null) || exit 0
n=$(cat "$S" 2>/dev/null || echo 0)
if [ "$st" = unhealthy ]; then
    n=$((n + 1)); echo "$n" > "$S"
    [ "$n" -ge 3 ] && docker restart -t 5 "$C" && echo 0 > "$S"
else
    echo 0 > "$S"
fi
```

Restart after three unhealthy checks a minute apart, with a 5 s stop timeout
(a hung main thread ignores SIGTERM). Restart recovery closes the old
sessions and fails or replays interrupted jobs. `starting` does not count.

## Schema upgrades

SQLite: the entrypoint deploys the schema only when the database file does
not exist (`cds deploy` recreates tables). The startup preflight probes new
columns and refuses to boot an old database with a migration hint. After an
image upgrade that adds entities or columns, run the additive migration
(reads `NIGHTGATE_DB_PATH`):

```bash
docker exec odatano-nightgate node scripts/apply-schema-delta.mjs
```

Crawler storage format (`Transactions.raw` binary, `ContractActions.state`
empty): the script re-encodes existing SQLite rows and creates the secondary
indexes (the server also creates them at startup). On PostgreSQL, indexed data
from releases before 0.23.0 needs `reindexFromHeight(0)` on the indexer service.

Wipe options: recreate the volume, or `npx cds deploy --to "sqlite:/data/nightgate.db"`.

## PostgreSQL

`NIGHTGATE_DB_URL=postgres://user:pw@host:5432/db` selects PostgreSQL. The
schema is deployed with `cds deploy` on every boot (additive);
`NIGHTGATE_DB_DEPLOY=never` skips it. SQLite busy timeout and
`NIGHTGATE_ALLOW_PRODUCTION_SQLITE` do not apply. Compose bundles
`postgres:16-alpine` under `--profile postgres` (`NIGHTGATE_PG_PASSWORD`).

Pool (`requires.db.pool`): max 20, acquire 30 s, destroy 5 s, idle 60 s,
eviction 60 s, `testOnBorrow`, 10 s connect timeout,
`features.use_generic_pool: true`. Override via CAP env vars
(`cds_requires_db_pool_max=30`, `cds_requires_db_pool_acquireTimeoutMillis=...`).
Bundled `nightgate-postgres`: `shared_buffers=1GB`, `max_wal_size=4GB`,
`checkpoint_timeout=15min`, `wal_buffers=64MB`; scale `shared_buffers` with the host.

TLS via `sslmode`: unset/`disable` = none, `require` (or `ssl=true`) = TLS
without certificate check, `verify-full` = chain and hostname against system
CAs or `sslrootcert=<pem file>`. Any other value (`allow`, `prefer`,
`verify-ca`, ...) is refused.

Migrating a SQLite volume: stop the service, start the database, run the
service once in `migrate` mode (`docker compose run` reuses its volume,
network and environment):

```bash
docker compose -f docker/docker-compose.yml --profile postgres up -d --wait nightgate-postgres
docker compose -f docker/docker-compose.yml stop nightgate
NIGHTGATE_DB_URL=postgres://nightgate:$NIGHTGATE_PG_PASSWORD@nightgate-postgres:5432/nightgate \
  docker compose -f docker/docker-compose.yml --profile postgres run --rm --no-deps nightgate \
  migrate --from /data/nightgate.db
```

`migrate` mode serves nothing and reads only `NIGHTGATE_DB_URL`. It waits for
the PostgreSQL listener (`NIGHTGATE_DB_WAIT_SECONDS`, default 60) before
`cds deploy`. A plain `docker run` needs the compose-prefixed volume and
network names (`docker volume ls` / `docker network ls`).

It deploys the schema and copies every persisted entity, incl. `.texts` and
`cds_outbox_Messages`, in batches: integers as BigInt (`Integer64` exact),
SQLite 0/1 as booleans, JSON as text, views skipped. Unknown source tables
with rows stop the run unless `--ignore-unknown`. `Decimal` values are copied
as stored; a REAL beyond 2^53 aborts. Row counts are compared per table
(mismatch = non-zero exit). `--dry-run` prints the plan; `--force` appends to
a non-empty target (the `SyncState` row is replaced). Plugin hosts:
`npx nightgate-db-migrate --from <file> --to <url>` (needs `@cap-js/postgres`
and `better-sqlite3`). Keep the SQLite file until a PostgreSQL backup and a
smoke test succeed.

## Operational notes

- Graceful stop: node flushes every wallet state (acked final save, up to
  60 s) on SIGTERM. Compose sets `stop_grace_period: 90s`; with plain
  `docker stop` pass `-t 90`.
- Compose sets `init: true`: tini runs as PID 1 and reaps orphaned processes
  (node does not; every health check docker kills would otherwise leave a
  zombie). With plain `docker run` pass `--init`.
- Single instance only; never scale replicas against one database.
- Without `NIGHTGATE_DB_URL` the entrypoint sets
  `NIGHTGATE_ALLOW_PRODUCTION_SQLITE=true` (single volume-backed instance).
  For production set `NIGHTGATE_DB_URL`.
- Mainnet submission is always gated off.
- The healthcheck (`docker/healthcheck.mjs`) probes the readiness route; the
  90 s start period covers schema deploy and plugin init.
- Compiled artifacts are in the image: `attestation-vault`,
  `attestation-vault-32`, `counter`, `shielded-token`.
- Own artifacts: bind-mount a directory as `NIGHTGATE_CONTRACTS_DIR` (e.g.
  `/data/contracts`) and call the admin action `registerContract`; persisted,
  reloaded at boot, no restart. The sponsor allow-list can live in
  `NIGHTGATE_SPONSOR_POLICY_FILE` (re-read per sponsored call).
