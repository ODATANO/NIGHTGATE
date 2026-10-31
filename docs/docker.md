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

From the repo root, with the node and indexer URLs of the network:

```bash
# your own node and indexer; hosted ones: their URLs with the access token in the query
NODE_URL='ws://<node-host>:9944'
INDEXER_URL='http://<indexer-host>:8088/api/v4/graphql'
ENCRYPTION_KEY=$(openssl rand -hex 32) \
NIGHTGATE_HTTP_PASSWORD=change-me \
NIGHTGATE_NODE_URL="$NODE_URL" \
NIGHTGATE_INDEXER_HTTP_URL="$INDEXER_URL" \
docker compose -f docker/docker-compose.yml up -d nightgate
```

Or without compose:

```bash
docker build -t odatano/nightgate:local .
docker run -d --name nightgate -p 4004:4004 \
  -e ENCRYPTION_KEY=$(openssl rand -hex 32) \
  -e NIGHTGATE_HTTP_PASSWORD=change-me \
  -e NIGHTGATE_NODE_URL="$NODE_URL" \
  -e NIGHTGATE_INDEXER_HTTP_URL="$INDEXER_URL" \
  -v nightgate-data:/data \
  odatano/nightgate:local
```

On preprod and mainnet the entrypoint refuses to start without `NIGHTGATE_NODE_URL`
and `NIGHTGATE_INDEXER_HTTP_URL` ([self-hosted.md](self-hosted.md)). On preview the public
endpoints are built in.

The JSON request log masks `authorization`, `cookie` and `x-agent-token`
(`log.mask_headers`); the plugin sets the same mask in a host app.

Runs as user `node` (uid 1000); a bind-mounted `/data` must be writable by
uid 1000 (`chown 1000:1000 <dir>`).

Listens on `http://localhost:4004`: `/odata/v4/midnight`, `/odata/v4/midnight-indexer`,
`/odata/v4/midnight-analytics`, `/odata/v4/midnight-admin`, and the credential-free
`/odata/v4/midnight-verify`. HTTP basic auth (`nightgate` / your
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
| (agent tokens) | - | `x-agent-token` requests need no basic credentials on `/odata/v4/midnight`; the grant hook authenticates them, incl. every `$batch` part |
| `NIGHTGATE_HTTP_ROLES` | none | Roles of the basic-auth user, comma separated; `admin` opens the admin service (signing-key export, session invalidation, job queue) |
| `NIGHTGATE_AUTH` | `basic` | `dummy` = unauthenticated and privileged; refused unless `NIGHTGATE_ALLOW_UNAUTHENTICATED=true`, local testing only |
| `NIGHTGATE_BIND_ADDRESS` | `127.0.0.1` | Compose only: host address port 4004 is published on. Basic auth is plain text without TLS: put a TLS reverse proxy in front before `0.0.0.0` |
| `NIGHTGATE_NETWORK` | `preprod` | Target network |
| `NIGHTGATE_CRAWLER_ENABLED` | `false` | Block crawler (verification works without it) |
| `NIGHTGATE_NODE_URL` / `NIGHTGATE_INDEXER_HTTP_URL` | required on preprod and mainnet; built in on preview | Node RPC and indexer GraphQL of the network: your own, or hosted ones with the access token in the URL ([self-hosted.md](self-hosted.md)) |
| `NIGHTGATE_PROOF_SERVER_URL` | unset | Set = proof-server proving instead of wasm |
| `NIGHTGATE_DB_PATH` | `/data/nightgate.db` | SQLite file (persist `/data`) |
| `NODE_OPTIONS` | `--max-old-space-size=8192` | Heap; container memory limit must be higher |
| `NIGHTGATE_NODE_FLAGS` | `--no-concurrent-recompilation` | V8 flags on the node command line (not allowed in `NODE_OPTIONS`). The default avoids a compile-thread/GC-safepoint deadlock; empty = no flag |

Every other variable is listed in [reference.md](reference.md). Default proving is in-process wasm,
which blocks a thread for each proof. For throughput start the compose `proof-server` service
and set `NIGHTGATE_PROOF_SERVER_URL=http://proof-server:6300`.

## Watchdog on the healthcheck

The HEALTHCHECK probes readiness every 30 s; five failures mark the container
`unhealthy`. Docker does not restart unhealthy containers
(`restart: unless-stopped` acts on exits only), so run `docker/watchdog.sh`
from cron every minute:

```sh
cp docker/watchdog.sh /root/nightgate-api/watchdog.sh
crontab -l | { cat; echo '* * * * * /root/nightgate-api/watchdog.sh'; } | crontab -
```

What it does after three unhealthy checks a minute apart:

- Only the crawler down: `pauseCrawler` + `resumeCrawler` inside the container; the sponsor facades keep running.
- Still unhealthy three checks later, or any other check failing: `docker restart -t 5`. Restart recovery closes old sessions and fails or replays interrupted jobs.
- No restart while `starting`, and none within `NIGHTGATE_WATCHDOG_START_GRACE` seconds (900) of the start, when the sponsor wallets warm at full CPU (`phase: warming`). Skipped restarts are logged.
- Variables at the top of the script: `NIGHTGATE_CONTAINER` (default `odatano-nightgate`; an unknown name is logged, never watched), `NIGHTGATE_WATCHDOG_LOG`, `NIGHTGATE_HOST_GUARD` (a command whose `exit 1` skips the restart while the host is stalled).

## Schema upgrades

SQLite: the entrypoint deploys the schema only when the database file does
not exist (`cds deploy` recreates tables). The startup preflight probes new
columns and refuses to boot an old database with a migration hint. After an
image upgrade that adds entities or columns, run the additive migration
(reads `NIGHTGATE_DB_PATH`):

```bash
docker exec odatano-nightgate node scripts/apply-schema-delta.mjs
```

The script also re-encodes rows of an older storage format and creates the secondary indexes. Wipe: recreate the volume, or `npx cds deploy --to "sqlite:/data/nightgate.db"`. Hand-made steps for older databases: [operations.md#schema-upgrades](operations.md#schema-upgrades).

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

`migrate` mode serves nothing: it waits for PostgreSQL
(`NIGHTGATE_DB_WAIT_SECONDS`, default 60), deploys the schema and copies every
persisted entity in batches, with exact `Integer64`, SQLite 0/1 as booleans and
row counts compared per table. Unknown source tables with rows stop the run
unless `--ignore-unknown`; `--dry-run` prints the plan; `--force` appends to a
non-empty target. Plugin hosts run `npx nightgate-db-migrate --from <file> --to
<url>` (needs `@cap-js/postgres` and `better-sqlite3`). Keep the SQLite file
until a PostgreSQL backup and a smoke test succeed.

## Operational notes

- Graceful stop: node flushes every wallet state (acked final save, up to
  60 s) on SIGTERM. Compose sets `stop_grace_period: 90s`; with plain
  `docker stop` pass `-t 90`.
- Compose sets `init: true`: tini runs as PID 1 and reaps orphaned processes
  (node does not; every health check docker kills would otherwise leave a
  zombie). With plain `docker run` pass `--init`.
- Single instance only; never scale replicas against one database. A second process on the same database refuses to start (`InstanceLeases`).
- Without `NIGHTGATE_DB_URL` the entrypoint sets
  `NIGHTGATE_ALLOW_PRODUCTION_SQLITE=true` (single volume-backed instance).
  For production set `NIGHTGATE_DB_URL`.
- Mainnet submission is always gated off.
- The healthcheck (`docker/healthcheck.mjs`) probes the readiness route; the
  90 s start period covers schema deploy and plugin init. Readiness is 200
  while the sponsor pool warms (`phase: warming`).
- Compiled artifacts are in the image: `attestation-vault`,
  `attestation-vault-32`, `counter`, `shielded-token`, `token-factory`,
  `holder-registry`.
- Own artifacts: bind-mount a directory as `NIGHTGATE_CONTRACTS_DIR` (e.g.
  `/data/contracts`) and call the admin action `registerContract`; persisted,
  reloaded at boot, no restart. The sponsor allow-list can live in
  `NIGHTGATE_SPONSOR_POLICY_FILE` (re-read per sponsored call).
