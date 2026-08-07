# syntax=docker/dockerfile:1
# NIGHTGATE standalone image: the repo itself is a complete CAP app, this
# packages it so `docker run` (or the compose service in docker/) yields a
# working attestation server. Zero-config proving default is in-process wasm;
# point NIGHTGATE_PROOF_SERVER_URL at a proof-server container to switch.

FROM node:22-slim AS build
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

FROM node:22-slim
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
# The plugin only initializes with an EXPLICIT network (an unconfigured
# plugin must not start crawling/submitting inside a host app). For the
# standalone image, preprod is the explicit default; override per run.
ENV NIGHTGATE_NETWORK=preprod
# Attestation-server default: the verify surface is crawler-free, and a
# fresh container crawling the whole chain into SQLite is rarely what a
# puller wants. Enable explicitly to run NIGHTGATE as a block indexer.
ENV NIGHTGATE_CRAWLER_ENABLED=false
WORKDIR /app
COPY --from=build /app /app
RUN chmod +x /app/docker/entrypoint.sh
VOLUME /data
EXPOSE 4004
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=5 \
    CMD node -e "fetch('http://localhost:4004/').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/app/docker/entrypoint.sh"]
