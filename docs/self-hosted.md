# Self-hosted

Running your own NIGHTGATE: what it needs behind it, and the two ways to get a
Midnight node and indexer for preprod or mainnet. If you only want to call
NIGHTGATE, the hosted gateway at `api.preprod.odatano.dev` needs none of this.

## What each part needs

| Part | Needs | Why |
|---|---|---|
| Crawler (`/odata/v4/midnight` reads) | node RPC (`nodeUrl`) | indexes blocks from the Substrate RPC |
| Wallet worker (sessions, sponsoring, swaps) | node RPC + indexer GraphQL (`indexerHttpUrl`) | the wallet SDK syncs from the indexer and submits to the node |
| Verify service | indexer GraphQL | reads live contract state |
| Proving | nothing, or a proof server (`proofServerUrl`) | wasm in-process by default |

Preview has public endpoints built in: `network: "preview"` alone starts. Preprod
and mainnet have none since Midnight retired its hosted endpoints (preprod on
2026-10-09, mainnet on 2026-09-30; the old indexer hosts answer HTTP 410), so
NIGHTGATE refuses to start there until `nodeUrl` and `indexerHttpUrl` are set.

## Option A: Blockfrost

A project id per network from [blockfrost.io](https://blockfrost.io), product
"Midnight Preprod" or "Midnight Mainnet". The token goes into the URL; a preprod
token does not work on mainnet and the other way round.

```env
NIGHTGATE_NETWORK=preprod
NIGHTGATE_NODE_URL=wss://rpc.midnight-preprod.blockfrost.io?project_id=<token>
NIGHTGATE_INDEXER_HTTP_URL=https://midnight-preprod.blockfrost.io/api/v0?project_id=<token>
```

Mainnet: `midnight-mainnet` in both hosts. The WebSocket URL is derived
(`wss://…/api/v0/ws?project_id=<token>`); set `NIGHTGATE_INDEXER_WS_URL` only for
a non-standard path. Check:

```bash
curl -s -X POST -H 'Content-Type: application/json' -d '{"query":"{ block { height } }"}' \
  "https://midnight-preprod.blockfrost.io/api/v0?project_id=$TOKEN"
```

`403` means a missing or mismatched token. A wallet state saved against another
indexer does not carry over: the first sync against Blockfrost starts from
genesis.

Cost: Blockfrost meters requests; a wallet sync from genesis is minutes of
streaming per wallet, a sponsor pool with several wallets more. Logs and error
texts strip the query, so the token does not land in them.

## Option B: your own node and indexer

The same images Midnight publishes, on your own box.

- **Node**: a Midnight node on preprod or mainnet follows a Cardano node of the
  same network through db-sync, so it is three containers and a day or more of
  sync; Midnight's node documentation has the compose. The `node` service in
  `docker/docker-compose.yml` is a local dev chain for tests, not preprod. Keep
  the node current: ledger 8.1.3 (node 1.0.400) closes a critical consensus
  issue, and operators are asked to upgrade.
- **Indexer**: `midnightntwrk/indexer-standalone`, the `indexer` service in
  `docker/docker-compose.yml`. It reads the node in `INDEXER_UPSTREAM_NODE_URL`
  (your node, or Blockfrost's `wss://rpc.midnight-preprod.blockfrost.io?project_id=…`)
  and indexes from genesis: days on preprod. Wait for `"caught_up":true` in its
  log, or `GET /ready` answering 200.

```bash
INDEXER_UPSTREAM_NODE_URL=ws://<your-node>:9944 docker compose -f docker/docker-compose.yml up -d indexer
```

- Do not point NIGHTGATE at a half-synced indexer: wallet subscriptions against
  it produce silent data gaps.

```env
NIGHTGATE_NETWORK=preprod
NIGHTGATE_NODE_URL=ws://<your-node>:9944
NIGHTGATE_INDEXER_HTTP_URL=http://127.0.0.1:8088/api/v4/graphql
```

An indexer on Blockfrost's node and NIGHTGATE on your own indexer is a valid
middle way: one token, no chain on disk, the sync path under your control.
Sizing and the memory watchdog for the indexer: [operations.md](operations.md).

## Which to pick

- Blockfrost: nothing to run, a token to keep secret, per-request cost, a
  cold wallet sync on the first start.
- Own: the node stack and the indexer to run, disk for the chain, no third party in the
  wallet's sync path, the indexer can be shared by every NIGHTGATE and every
  agent you run.

## Verify calls on another network

`verifyAttestationState` and `verifyPredicateState` take a `network`
parameter. For a network other than the configured one the indexer comes from
`cds.requires.nightgate.networks.<network>.indexerHttpUrl`; without an entry,
preprod and mainnet answer "not verified" (no indexer to ask), preview uses its
public one.

## Library users

`@odatano/nightgate-tx` with `api` (the gateway or your instance) reads the
chain through the server and needs no indexer for value-free calls. A wallet
sync (swaps, transfers, coin arguments) needs an indexer: with a gateway key the
gateway's indexer lane, otherwise `indexerHttpUrl` and `indexerWsUrl` from this
page. See [txbuilder.md](txbuilder.md).
