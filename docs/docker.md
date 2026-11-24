# Running NIGHTGATE with Docker

The image is the complete CAP application: all OData services, submission, wallet sessions, agent grants and in-process wasm proving. Every release publishes `ghcr.io/odatano/nightgate:<version>` and `:latest`.

## Start

With compose, from the repository root:

```bash
ENCRYPTION_KEY=$(openssl rand -hex 32) \
NIGHTGATE_HTTP_PASSWORD=change-me \
NIGHTGATE_NODE_URL='ws://<node-host>:9944' \
NIGHTGATE_INDEXER_HTTP_URL='http://<indexer-host>:8088/api/v4/graphql' \
docker compose -f docker/docker-compose.yml up -d nightgate
```

With `docker run`, pass the same variables with `-e`, plus `-p 127.0.0.1:4004:4004 -v nightgate-data:/data --init`. Basic auth is plain text, so publish on another address only behind a TLS proxy.

- Node and indexer are built in for preview and undeployed only. Every other network needs `NIGHTGATE_NODE_URL` and `NIGHTGATE_INDEXER_HTTP_URL`. On mainnet and preprod the entrypoint refuses to start without them. On stagenet the server starts and stays offline. See [self-hosted.md](self-hosted.md).
- The container runs as uid 1000. A bind-mounted `/data` must be writable by it.
- Compose publishes every port on `127.0.0.1`: the server (4004), the node (9944, 30333), the indexer (8088) and the proof server (6300). `NIGHTGATE_BIND_ADDRESS=0.0.0.0` publishes the server on all addresses, `NODE_BIND_ADDRESS` and `INDEXER_BIND_ADDRESS` do the same for node and indexer. Basic auth is plain text without TLS, so put a TLS reverse proxy in front.
- Behind a reverse proxy set `NIGHTGATE_TRUST_PROXY` to the number of proxies. Without it every caller has the proxy's address, so the rate limits per address and the login throttle count all callers as one: 20 wrong passwords lock everyone out for 15 minutes. Set it only when no caller can reach the server directly.

## Authentication

- HTTP basic auth through `@odatano/cap-auth`, realm `nightgate`. 20 failed attempts per 15 minutes per client address and user answer 429 with `Retry-After`.
- Agent requests send `x-agent-token` and need no basic credentials.
- The indexer functions `getLiveness`, `getReadiness`, `getSyncStatus`, `getHealth`, `getBoardStatus` and `getReceiptKey` answer without credentials. `getMetrics` needs the admin role, so its reader is a user with `NIGHTGATE_HTTP_ROLES=admin`.
- `/odata/v4/midnight-verify` answers without credentials when `NIGHTGATE_PUBLIC_VERIFY=true`.
- The request log masks `authorization`, `cookie` and `x-agent-token`.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `ENCRYPTION_KEY` | required | Encrypts stored keys, job commands and wallet state. A key ring is `ENCRYPTION_KEYS=id=secret,...` with `ENCRYPTION_KEY_ACTIVE`, see [operations.md](operations.md) |
| `NIGHTGATE_HTTP_PASSWORD` | required | Basic-auth password |
| `NIGHTGATE_HTTP_USER` | `nightgate` | Basic-auth user |
| `NIGHTGATE_HTTP_ROLES` | none | Comma-separated roles of that user. `admin` opens the admin service |
| `NIGHTGATE_TRUST_PROXY` | `0` | Number of reverse proxies in front of the server, see the note above |
| `NIGHTGATE_NETWORK` | `mainnet` | Target network |
| `NIGHTGATE_NODE_URL` | built in on preview and undeployed | Node RPC |
| `NIGHTGATE_INDEXER_HTTP_URL` | built in on preview and undeployed | Indexer GraphQL |
| `NIGHTGATE_CRAWLER_ENABLED` | `false` | Block crawler. Verification works without it |
| `NIGHTGATE_PROOF_SERVER_URL` | unset | Set selects proof-server proving. Compose: `http://proof-server:6300` |
| `NIGHTGATE_DB_PATH` | `/data/nightgate.db` | SQLite file |
| `NIGHTGATE_DB_URL` | unset | `postgres://...` selects PostgreSQL |
| `NODE_OPTIONS` | `--max-old-space-size=8192` | Heap. Keep the container memory limit above it |
| `NIGHTGATE_NODE_FLAGS` | `--no-concurrent-recompilation` | V8 flags on the node command line. Empty sets none |
| `NIGHTGATE_SQLITE_BUSY_TIMEOUT_MS` | `30000` | How long a SQLite write waits for the lock |
| `NIGHTGATE_IMAGE_TAG` | the release | Compose only: the image tag to run |
| `NIGHTGATE_WATCHDOG_CYCLE_GRACE` | `900` | Watchdog only: seconds a restart cycle counts as tried |

Compose also passes `ENCRYPTION_KEYS`, `ENCRYPTION_KEY_ACTIVE`, `NIGHTGATE_DB_DEPLOY`, `NIGHTGATE_PUBLIC_VERIFY`, `NIGHTGATE_FEE_SPONSOR_SESSIONS` and `NIGHTGATE_SPONSOR_POLICY_FILE`. Any other variable needs an entry under `environment` in `docker/docker-compose.yml`. All variables: [reference.md](reference.md#environment-variables).

## Schema upgrades on SQLite

The entrypoint deploys the schema only when the database file does not exist. The startup check refuses an older database and names the migration. After an image upgrade that adds entities or columns, run the migration with the server stopped, then start it:

```bash
docker compose -f docker/docker-compose.yml stop nightgate
docker compose -f docker/docker-compose.yml run --rm --no-deps --entrypoint node nightgate scripts/apply-schema-delta.mjs
docker compose -f docker/docker-compose.yml start nightgate
```

The script reads `NIGHTGATE_DB_PATH`, renames columns, adds tables, columns and indexes, rebuilds a table whose key or constraints changed. Manual steps: [operations.md#schema-upgrades](operations.md#schema-upgrades).

## PostgreSQL

`NIGHTGATE_DB_URL=postgres://user:pw@host:5432/db` selects PostgreSQL. The entrypoint runs `cds deploy` on every boot. `NIGHTGATE_DB_DEPLOY=never` skips it. Compose bundles `postgres:16-alpine` under `--profile postgres` with the password in `NIGHTGATE_PG_PASSWORD`.

- TLS through `sslmode`: `disable` or unset, `require` without certificate check, `verify-full` against system CAs or `sslrootcert=<pem file>`. Other values are refused.
- Pool defaults: max 20, acquire timeout 30 s, connect timeout 10 s. CAP env vars override them, for example `cds_requires_db_pool_max=30`.

Migrate a SQLite volume:

```bash
docker compose -f docker/docker-compose.yml --profile postgres up -d --wait nightgate-postgres
docker compose -f docker/docker-compose.yml stop nightgate
NIGHTGATE_DB_URL=postgres://nightgate:$NIGHTGATE_PG_PASSWORD@nightgate-postgres:5432/nightgate \
  docker compose -f docker/docker-compose.yml --profile postgres run --rm --no-deps nightgate \
  migrate --from /data/nightgate.db
```

`migrate` waits for PostgreSQL up to `NIGHTGATE_DB_WAIT_SECONDS` (60), deploys the schema, copies every table and compares row counts. Flags: `--dry-run`, `--force` for a non-empty target, `--ignore-unknown` for unknown source tables. From a clone, run `node scripts/migrate-sqlite-to-postgres.mjs --from <file> --to <url>`. Keep the SQLite file until a backup and a smoke test of PostgreSQL succeed.

## Health and watchdog

The HEALTHCHECK asks `getReadiness()` every 30 s after a 90 s start period. Five failures mark the container `unhealthy`. Readiness stays 200 while the sponsor pool warms.

Docker does not restart an unhealthy container. Run `docker/watchdog.sh` from cron every minute:

```sh
crontab -l | { cat; echo '* * * * * /root/nightgate-api/watchdog.sh'; } | crontab -
```

- After three unhealthy checks with only the crawler down, it pauses and resumes the crawler. Both calls need the `admin` role, so set `NIGHTGATE_HTTP_ROLES=admin`. Without it the cycle is refused, the log says so, and the container is restarted instead.
- Otherwise, or still unhealthy three checks later, it restarts the container.
- A server that still answers `getLiveness()` gets `NIGHTGATE_WATCHDOG_STOP_WAIT` seconds to save its wallet states before the restart, default 90. One that does not answer is stopped after 5.
- No restart within `NIGHTGATE_WATCHDOG_START_GRACE` seconds of the start, default 900.
- `NIGHTGATE_CONTAINER` names the container, default `odatano-nightgate`. `NIGHTGATE_WATCHDOG_LOG` sets the log file. `NIGHTGATE_HOST_GUARD` names a command that can veto a restart.

## Notes

- On SIGTERM every wallet state is saved, up to 60 s. Running submits get up to 40 s of that, the saves the rest. A dust snapshot whose check does not fit is left at its last periodic save. Compose sets `stop_grace_period: 90s`. With `docker stop` pass `-t 90`.
- Compose sets `init: true` so zombie processes are reaped. With `docker run` pass `--init`.
- One instance per database. A second process on the same database refuses to start.
- Without `NIGHTGATE_DB_URL` the entrypoint allows SQLite under the production profile. Use PostgreSQL in production.
- Mainnet submission is off unless `NIGHTGATE_ALLOW_MAINNET_SUBMISSION` is `true`, because a transaction there spends real NIGHT and DUST. Until then an action that submits answers 403. Indexing and reads work either way.
- The image carries the prover keys of `counter`, `token-factory`, `holder-registry`, `attestation-vault` and `attestation-vault-32`.
- Own contracts: mount a directory as `NIGHTGATE_CONTRACTS_DIR` and call the admin action `registerContract`. The registration persists across restarts.
- `NIGHTGATE_SPONSOR_POLICY_FILE` holds the sponsor allow-list and is re-read on change.
