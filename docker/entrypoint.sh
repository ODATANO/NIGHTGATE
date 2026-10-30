#!/usr/bin/env bash
# Container entrypoint: check secrets, build CDS_CONFIG (docker/cds-config.mjs),
# deploy the schema, serve. Details in docs/docker.md.
set -euo pipefail

DB_URL="${NIGHTGATE_DB_URL:-}"
DB_PATH="${NIGHTGATE_DB_PATH:-/data/nightgate.db}"
MODE="${1:-serve}"


# `migrate`: deploy the schema into PostgreSQL, copy a SQLite file into it, exit.
# Needs only the database URL (docs/docker.md).
if [ "$MODE" = "migrate" ]; then
    shift
    if [ -z "$DB_URL" ]; then
        echo "FATAL: migrate needs NIGHTGATE_DB_URL (the PostgreSQL target)." >&2
        exit 1
    fi
    CDS_CONFIG="$(node /app/docker/cds-config.mjs --db-only)" || exit 1
    export CDS_CONFIG
    # Wait for the PostgreSQL listener (NIGHTGATE_DB_WAIT_SECONDS, default 60).
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

if [ -z "${ENCRYPTION_KEY:-}" ] && [ -z "${ENCRYPTION_KEYS:-}" ]; then
    echo "FATAL: ENCRYPTION_KEY (or a key ring in ENCRYPTION_KEYS=id=secret,... with ENCRYPTION_KEY_ACTIVE) is required (high-entropy 32+ byte secret; generate with: openssl rand -hex 32)." >&2
    echo "       Wallet viewing/seed keys and job commands are AES-256-GCM encrypted at rest under this key." >&2
    exit 1
fi

# preprod and mainnet have no built-in node or indexer; without them the plugin stays offline and the
# health check would restart the container for nothing.
case "${NIGHTGATE_NETWORK:-preprod}" in
    preprod|mainnet)
        if [ -z "${NIGHTGATE_NODE_URL:-}" ] || [ -z "${NIGHTGATE_INDEXER_HTTP_URL:-}" ]; then
            echo "FATAL: network ${NIGHTGATE_NETWORK:-preprod} has no built-in node or indexer: set NIGHTGATE_NODE_URL and NIGHTGATE_INDEXER_HTTP_URL (your own, or Blockfrost with the project id in the URL; docs/self-hosted.md)." >&2
            exit 1
        fi ;;
esac

if [ -z "$DB_URL" ]; then
    mkdir -p "$(dirname "$DB_PATH")"
fi

AUTH_KIND="${NIGHTGATE_AUTH:-basic}"
if [ "$AUTH_KIND" = "dummy" ]; then
    echo "WARN: NIGHTGATE_AUTH=dummy serves UNAUTHENTICATED. Refused unless NIGHTGATE_ALLOW_UNAUTHENTICATED=true; local testing only." >&2
fi
# cds-config.mjs refuses a missing password, an unknown auth kind and a non-postgres URL.
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
    # SQLite under NODE_ENV=production is refused unless allowed; one container is the supported case.
    export NIGHTGATE_ALLOW_PRODUCTION_SQLITE="${NIGHTGATE_ALLOW_PRODUCTION_SQLITE:-true}"
    echo "NOTE: SQLite under the production profile (NIGHTGATE_ALLOW_PRODUCTION_SQLITE=$NIGHTGATE_ALLOW_PRODUCTION_SQLITE). Single instance only; set NIGHTGATE_DB_URL for PostgreSQL."
    # First boot only: `cds deploy` recreates tables. Upgrades run scripts/apply-schema-delta.mjs.
    if [ ! -f "$DB_PATH" ]; then
        echo "First boot: deploying schema to $DB_PATH"
        npx cds deploy --to "sqlite:$DB_PATH"
    fi
fi

echo "Starting NIGHTGATE (network=${NIGHTGATE_NETWORK:-preprod}, auth=$AUTH_KIND, db=$DB_LABEL)"
# node is PID 1 so SIGTERM reaches cds (an `sh -c` in between would not forward it).
# No concurrent recompilation: a background compile can deadlock with the main
# thread at a GC safepoint. V8 flags do not fit NODE_OPTIONS, so they go here.
NODE_FLAGS="${NIGHTGATE_NODE_FLAGS---no-concurrent-recompilation}"
# shellcheck disable=SC2086  # word splitting is the point: several flags
exec node $NODE_FLAGS /app/node_modules/@sap/cds/bin/serve.js
