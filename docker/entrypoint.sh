#!/usr/bin/env bash
# NIGHTGATE container entrypoint: validate secrets, wire db + auth via
# CDS_CONFIG (docker/cds-config.mjs), deploy the schema, then serve.
#
# Database (0.21.1):
#   NIGHTGATE_DB_URL=postgres://user:pw@host:5432/db  -> PostgreSQL. The schema
#       is deployed with `cds deploy` on EVERY boot (CAP's evolution is
#       additive; an image upgrade brings its own columns and views with it).
#       NIGHTGATE_DB_DEPLOY=never skips that, e.g. when a migration job owns it.
#   otherwise                                          -> SQLite file at
#       NIGHTGATE_DB_PATH (default /data/nightgate.db), deployed on first boot
#       only; upgrades run `nightgate-schema-delta` (see docs/docker.md).
set -euo pipefail

DB_URL="${NIGHTGATE_DB_URL:-}"
DB_PATH="${NIGHTGATE_DB_PATH:-/data/nightgate.db}"
MODE="${1:-serve}"

# `migrate` mode (0.21.1): deploy the schema into the PostgreSQL database and
# copy a SQLite file into it, then exit. It serves nothing, so it needs
# neither ENCRYPTION_KEY nor HTTP credentials, only the database URL. Run it
# as a one-off container BEFORE the first PostgreSQL start of the service,
# with every writer stopped:
#   NIGHTGATE_DB_URL=postgres://... docker compose run --rm --no-deps nightgate \
#     migrate --from /data/nightgate.db
# (same volume, network and env as the service; see docs/docker.md)
if [ "$MODE" = "migrate" ]; then
    shift
    if [ -z "$DB_URL" ]; then
        echo "FATAL: migrate needs NIGHTGATE_DB_URL (the PostgreSQL target)." >&2
        exit 1
    fi
    CDS_CONFIG="$(node /app/docker/cds-config.mjs --db-only)" || exit 1
    export CDS_CONFIG
    # A freshly created PostgreSQL may still be initialising: wait for the
    # listener (up to NIGHTGATE_DB_WAIT_SECONDS, default 60, a finite positive
    # number; anything else is refused) before deploying. Every connect attempt
    # is capped at the time left in the window, so a dropped (not refused)
    # SYN cannot outlive it.
    node -e '
        const { host, port } = JSON.parse(process.env.CDS_CONFIG).requires.db.credentials;
        const raw = process.env.NIGHTGATE_DB_WAIT_SECONDS ?? "60";
        const waitSeconds = Number(raw);
        if (!Number.isFinite(waitSeconds) || waitSeconds <= 0 || waitSeconds > 86400) { console.error(`FATAL: NIGHTGATE_DB_WAIT_SECONDS must be a number of seconds in 1..86400 (got ${JSON.stringify(raw)})`); process.exit(1); }
        const net = require("net"); const deadline = Date.now() + 1000 * waitSeconds;
        (function attempt() {
            const left = deadline - Date.now();
            if (left <= 0) { console.error(`FATAL: PostgreSQL at ${host}:${port} not reachable within ${waitSeconds}s`); process.exit(1); }
            const s = net.connect({ host, port }, () => { s.destroy(); process.exit(0); });
            s.setTimeout(Math.min(left, 5000), () => s.destroy(new Error("timeout")));
            s.on("error", () => { s.destroy(); setTimeout(attempt, Math.min(1000, Math.max(0, deadline - Date.now()))); });
        })();
    '
    echo "Deploying schema to PostgreSQL, then migrating: $*"
    npx cds deploy
    exec node /app/scripts/migrate-sqlite-to-postgres.mjs --to "$DB_URL" "$@"
fi

if [ -z "${ENCRYPTION_KEY:-}" ]; then
    echo "FATAL: ENCRYPTION_KEY is required (high-entropy 32+ byte secret; generate with: openssl rand -hex 32)." >&2
    echo "       Wallet viewing/seed keys are AES-256-GCM encrypted at rest under this key." >&2
    exit 1
fi

if [ -z "$DB_URL" ]; then
    mkdir -p "$(dirname "$DB_PATH")"
fi

# The image's HEALTHCHECK asks Nightgate's readiness route, which needs the
# routes mounted. They are fail-closed by design (they sit outside CAP
# authentication), so when the operator has configured neither a token nor
# explicit public access, generate an INTERNAL token: the routes then exist for
# the container itself and stay closed to everyone else. The token goes to a
# file because a HEALTHCHECK does not see variables exported here.
STATUS_TOKEN_FILE=/tmp/nightgate-status-token
if [ -z "${NIGHTGATE_STATUS_TOKEN:-}" ] \
   && [ "${NIGHTGATE_STATUS_ROUTES:-}" != "public" ] \
   && [ "${NIGHTGATE_STATUS_ROUTES:-}" != "off" ]; then
    NIGHTGATE_STATUS_TOKEN="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
    export NIGHTGATE_STATUS_TOKEN
    echo "NOTE: generated an internal status-route token for the container healthcheck. Set NIGHTGATE_STATUS_TOKEN to scrape /nightgate/metrics from outside."
fi
if [ -n "${NIGHTGATE_STATUS_TOKEN:-}" ]; then
    printf '%s' "$NIGHTGATE_STATUS_TOKEN" > "$STATUS_TOKEN_FILE"
    chmod 600 "$STATUS_TOKEN_FILE"
fi

AUTH_KIND="${NIGHTGATE_AUTH:-basic}"
if [ "$AUTH_KIND" = "dummy" ]; then
    echo "WARN: NIGHTGATE_AUTH=dummy serves UNAUTHENTICATED. Local testing only." >&2
fi
# Custom transport auth (0.17.1): basic as before, PLUS requests carrying
# x-agent-token pass for /api/v1/nightgate only, where the agent-grant hook
# does the real authentication. The single configured user IS the operator of
# this deployment and carries the admin role (NIGHTGATE_HTTP_ROLES overrides).
# cds-config.mjs refuses a missing password / unknown auth kind / non-postgres URL.
CDS_CONFIG="$(node /app/docker/cds-config.mjs)" || exit 1
export CDS_CONFIG

if [ -n "$DB_URL" ]; then
    DB_LABEL="postgres ($(printf '%s' "$DB_URL" | sed -E 's#://([^:/@]*)(:[^@]*)?@#://\1:***@#'))"
    if [ "${NIGHTGATE_DB_DEPLOY:-auto}" != "never" ]; then
        echo "Deploying schema to PostgreSQL (additive evolution; NIGHTGATE_DB_DEPLOY=never skips this)"
        npx cds deploy
    fi
else
    DB_LABEL="sqlite ($DB_PATH)"
    # The core's runtime-topology guard rejects SQLite under NODE_ENV=production
    # unless explicitly overridden: the container IS the supported case (exactly
    # one instance, volume-persisted), so the override is set here, visibly.
    # For production-grade deployments set NIGHTGATE_DB_URL instead.
    export NIGHTGATE_ALLOW_PRODUCTION_SQLITE="${NIGHTGATE_ALLOW_PRODUCTION_SQLITE:-true}"
    echo "NOTE: SQLite under the production profile (NIGHTGATE_ALLOW_PRODUCTION_SQLITE=$NIGHTGATE_ALLOW_PRODUCTION_SQLITE). Single instance only; set NIGHTGATE_DB_URL for PostgreSQL."
    # Schema deploy on FIRST boot only: `cds deploy` recreates tables and would
    # wipe data on an existing file. Upgrades run the additive delta:
    #   docker exec <container> node scripts/apply-schema-delta.mjs
    if [ ! -f "$DB_PATH" ]; then
        echo "First boot: deploying schema to $DB_PATH"
        npx cds deploy --to "sqlite:$DB_PATH"
    fi
fi

echo "Starting NIGHTGATE (network=${NIGHTGATE_NETWORK:-preprod}, auth=$AUTH_KIND, db=$DB_LABEL)"
# node itself becomes PID 1 (0.21.7). `exec npx cds-serve` put npm -> sh ->
# node in between, `sh -c` does not forward SIGTERM, so `docker stop` never
# reached the server: every stop ended in SIGKILL after the grace period
# (wallet state unsaved, sessions left open, one recreate raced and stayed
# down). With node in front, cds runs its shutdown hooks on SIGTERM.
exec node /app/node_modules/@sap/cds/bin/serve.js
