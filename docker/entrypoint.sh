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
mkdir -p "$(dirname "$DB_PATH")"

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
        CDS_CONFIG=$(node -e '
            const { __NG_DB, __NG_USER, __NG_PW } = process.env;
            console.log(JSON.stringify({ requires: {
                db:   { kind: "sqlite", credentials: { url: __NG_DB } },
                auth: { impl: "./srv/utils/agent-token-auth.js", users: { [__NG_USER]: { password: __NG_PW } } }
            }}));')
        ;;
    dummy)
        echo "WARN: NIGHTGATE_AUTH=dummy serves UNAUTHENTICATED. Local testing only." >&2
        export __NG_DB="$DB_PATH"
        CDS_CONFIG=$(node -e '
            console.log(JSON.stringify({ requires: {
                db:   { kind: "sqlite", credentials: { url: process.env.__NG_DB } },
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
