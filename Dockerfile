# syntax=docker/dockerfile:1
# NIGHTGATE standalone image. The repo is a complete CAP app, so `docker run` gives a working attestation server.
# Proving runs in-process by default. Set NIGHTGATE_PROOF_SERVER_URL to use a proof server.

FROM node:22.23.4-slim AS build
# better-sqlite3 falls back to a source build when no prebuilt binary matches.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
# Full install on purpose: the repo-as-app serves via its devDependencies
# (@sap/cds, @sap/cds-dk, @cap-js/sqlite). Slimming is a later optimization.
RUN npm ci
COPY . .
RUN npm run build
# The image carries every prover key of the registered lineages (fetched from
# the packages' release assets, verified against their manifests); refuse to
# build one that would fetch at runtime.
RUN set -e; for c in counter shielded-token token-factory holder-registry attestation-vault attestation-vault-32; do node scripts/fetch-contract-keys.mjs "$c"; done

FROM node:22.23.4-slim
ARG VERSION=dev
ARG BUILD_DATE=unknown
ARG VCS_REF=unknown
LABEL org.opencontainers.image.title="NIGHTGATE" \
      org.opencontainers.image.description="Midnight blockchain indexer + attestation/submission layer (SAP CAP)" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.source="https://github.com/ODATANO/NIGHTGATE"
ENV NODE_ENV=production
# Wallet catch-up and in-process wasm proving allocate well past Node's
# default heap; override to match the container's memory limit.
ENV NODE_OPTIONS=--max-old-space-size=8192
ENV NIGHTGATE_DB_PATH=/data/nightgate.db
# The plugin only initializes with an explicit network; preprod is the image's default. The entrypoint
# refuses preprod and mainnet without NIGHTGATE_NODE_URL and NIGHTGATE_INDEXER_HTTP_URL (docs/self-hosted.md).
ENV NIGHTGATE_NETWORK=preprod
# Attestation-server default: the verify surface is crawler-free, and a
# fresh container crawling the whole chain into SQLite is rarely what a
# puller wants. Enable explicitly to run NIGHTGATE as a block indexer.
ENV NIGHTGATE_CRAWLER_ENABLED=false
WORKDIR /app
# Unprivileged runtime: the image's own user owns /app (contract registration
# writes under NIGHTGATE_CONTRACTS_DIR) and /data (database, wallet state).
COPY --from=build --chown=node:node /app /app
RUN chmod +x /app/docker/entrypoint.sh && mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 4004
# docker/healthcheck.mjs asks getReadiness(), because the plugin keeps CAP alive while NIGHTGATE is offline.
HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=5 \
    CMD node /app/docker/healthcheck.mjs
ENTRYPOINT ["/app/docker/entrypoint.sh"]
