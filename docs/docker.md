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

The server listens on `http://localhost:4004`; the OData services sit under
`/api/v1/nightgate`, `/api/v1/indexer`, `/api/v1/analytics`,
`/api/v1/admin`. All requests authenticate with HTTP basic
(`nightgate` / your password); agent requests additionally carry their
`x-agent-token` (0.14.0 agent grants).

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `ENCRYPTION_KEY` | required | Encrypts wallet viewing/seed keys at rest (32+ byte secret) |
| `NIGHTGATE_HTTP_PASSWORD` | required | Basic-auth password |
| `NIGHTGATE_HTTP_USER` | `nightgate` | Basic-auth user |
| (agent tokens) | - | Requests carrying `x-agent-token` need NO basic credentials for `/api/v1/nightgate`; the agent-grant hook authenticates them (0.17.1) |
| `NIGHTGATE_AUTH` | `basic` | `dummy` serves unauthenticated (local testing ONLY) |
| `NIGHTGATE_NETWORK` | `preprod` | Target Midnight network |
| `NIGHTGATE_CRAWLER_ENABLED` | `false` | Block crawler (verify surface works crawler-free) |
| `NIGHTGATE_NODE_URL` / `NIGHTGATE_INDEXER_HTTP_URL` / `NIGHTGATE_INDEXER_WS_URL` | per-network defaults | Endpoint overrides |
| `NIGHTGATE_PROOF_SERVER_URL` | unset | Set to switch proving from in-process wasm to a proof server |
| `NIGHTGATE_DB_PATH` | `/data/nightgate.db` | SQLite location (persist the `/data` volume) |
| `NODE_OPTIONS` | `--max-old-space-size=8192` | Heap; keep the container memory limit above it |

Proving default is fully in-process (wasm): zero extra containers, but
proofs run for minutes each and block the executing thread. For serious
throughput bring up the `proof-server` service from the same compose file
and set `NIGHTGATE_PROOF_SERVER_URL=http://proof-server:6300`.

## Schema upgrades

The entrypoint deploys the schema ONLY when the database file does not
exist yet: `cds deploy` recreates tables, an unconditional deploy would
wipe data on every boot. The startup preflight also probes each release's
NEW columns, so an old database refuses to boot with a migration hint
instead of failing at the first new action. After an image upgrade that
adds entities or columns (0.16.0: `Documents.userId/contractAddress/network`,
`PredicateAttestations.payloadHashB/allowedMask`), run the ADDITIVE
migration (keeps all data; it reads `NIGHTGATE_DB_PATH`, which the image
sets to `/data/nightgate.db`):

```bash
docker exec odatano-nightgate node scripts/apply-schema-delta.mjs
```

Recreating the volume (dev) or a destructive
`npx cds deploy --to "sqlite:/data/nightgate.db"` remain the wipe options.

## Operational notes

- Single instance only (`runtimeMode` is enforced by the app); do not scale
  the service to multiple replicas against one database.
- The entrypoint sets `NIGHTGATE_ALLOW_PRODUCTION_SQLITE=true`: the core
  rejects SQLite under the production profile by default, and the container
  is exactly the supported exception (one instance, volume-persisted).
  For production-grade deployments configure PostgreSQL/HANA and unset it.
- Mainnet submission stays gated off regardless of configuration.
- The healthcheck probes the HTTP root; first boot needs the start period
  because schema deploy and plugin init run before the port opens.
- The image contains the compiled contract artifacts
  (`contracts/**/managed`), so `attestation-vault`, `counter` and
  `shielded-token` resolve out of the box.
