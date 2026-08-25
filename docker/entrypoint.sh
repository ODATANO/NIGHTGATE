#!/usr/bin/env bash
# NIGHTGATE container entrypoint: validate secrets, wire db + auth via
# CDS_CONFIG, deploy the schema on first boot, then serve.
set -euo pipefail

if [ -z "${ENCRYPTION_KEY:-}" ]; then
    echo "FATAL: ENCRYPTION_KEY is required (high-entropy 32+ byte secret; generate with: openssl rand -hex 32)." >&2
    echo "       Wallet viewing/seed keys are AES-256-GCM encrypted at rest under this key." >&2
    exit 1
fi

DB_PATH="${NIGHTGATE_DB_PATH:-/data/nightgate.db}"
# SQLite busy timeout (ms): how long a writer waits for the lock before
# `database is locked`. Multi-MB wallet-state saves of many warm facades hold
# the lock for seconds; better-sqlite3's default of 5 s was too short live.
export __NG_SQLITE_TIMEOUT="${NIGHTGATE_SQLITE_BUSY_TIMEOUT_MS:-30000}"
mkdir -p "$(dirname "$DB_PATH")"

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
case "$AUTH_KIND" in
    basic)
        if [ -z "${NIGHTGATE_HTTP_PASSWORD:-}" ]; then
            echo "FATAL: NIGHTGATE_HTTP_PASSWORD is required with basic auth." >&2
            echo "       (Local unauthenticated testing only: set NIGHTGATE_AUTH=dummy.)" >&2
            exit 1
        fi
        export __NG_DB="$DB_PATH" __NG_USER="${NIGHTGATE_HTTP_USER:-nightgate}" __NG_PW="$NIGHTGATE_HTTP_PASSWORD"
        # Custom transport auth (0.17.1): basic as before, PLUS requests
        # carrying x-agent-token pass for /api/v1/nightgate only, where the
        # agent-grant hook does the real authentication. External agents
        # therefore need ONLY their ngat_ token, not the operator password.
        # The single configured user IS the operator of this deployment, so it
        # carries the admin role: without it `user.is('admin')` is false and
        # the whole admin service (session invalidation, the job queue,
        # getJobStats) answers 403 to the only account the image has.
        # NIGHTGATE_HTTP_ROLES overrides for a deployment that wants less.
        export __NG_ROLES="${NIGHTGATE_HTTP_ROLES:-admin}"
        CDS_CONFIG=$(node -e '
            const { __NG_DB, __NG_USER, __NG_PW, __NG_ROLES } = process.env;
            const roles = String(__NG_ROLES || "").split(",").map(r => r.trim()).filter(Boolean);
            console.log(JSON.stringify({ requires: {
                db:   { kind: "sqlite", credentials: { url: __NG_DB }, client: { timeout: Number(process.env.__NG_SQLITE_TIMEOUT) || 30000 } },
                auth: { impl: "./srv/utils/agent-token-auth.js", users: { [__NG_USER]: { password: __NG_PW, roles } } }
            }}));')
        ;;
    dummy)
        echo "WARN: NIGHTGATE_AUTH=dummy serves UNAUTHENTICATED. Local testing only." >&2
        export __NG_DB="$DB_PATH"
        CDS_CONFIG=$(node -e '
            console.log(JSON.stringify({ requires: {
                db:   { kind: "sqlite", credentials: { url: process.env.__NG_DB }, client: { timeout: Number(process.env.__NG_SQLITE_TIMEOUT) || 30000 } },
                auth: { kind: "dummy" }
            }}));')
        ;;
    *)
        echo "FATAL: unsupported NIGHTGATE_AUTH='$AUTH_KIND' (use: basic | dummy)." >&2
        exit 1
        ;;
esac
export CDS_CONFIG

# The core's runtime-topology guard rejects SQLite under NODE_ENV=production
# unless explicitly overridden: the container IS the supported case (exactly
# one instance, volume-persisted), so the override is set here, visibly.
# For production-grade deployments configure PostgreSQL/HANA instead.
export NIGHTGATE_ALLOW_PRODUCTION_SQLITE="${NIGHTGATE_ALLOW_PRODUCTION_SQLITE:-true}"
echo "NOTE: SQLite under the production profile (NIGHTGATE_ALLOW_PRODUCTION_SQLITE=$NIGHTGATE_ALLOW_PRODUCTION_SQLITE). Single instance only; use PostgreSQL/HANA for production-grade setups."

# Schema deploy on FIRST boot only: `cds deploy` recreates tables and would
# wipe data on an existing file. After an image upgrade that adds entities,
# either recreate the volume or run the deploy manually (accepting the wipe):
#   docker exec <container> npx cds deploy --to "sqlite:$NIGHTGATE_DB_PATH"
if [ ! -f "$DB_PATH" ]; then
    echo "First boot: deploying schema to $DB_PATH"
    npx cds deploy --to "sqlite:$DB_PATH"
fi

echo "Starting NIGHTGATE (network=${NIGHTGATE_NETWORK:-preprod}, auth=$AUTH_KIND, db=$DB_PATH)"
exec npx cds-serve
