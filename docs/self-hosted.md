# Self-hosted

What your own NIGHTGATE needs behind it. To only call NIGHTGATE, use the hosted gateway at `api.preview.odatano.dev` instead.

## What each part needs

| Part | Needs |
|---|---|
| Crawler | node RPC, `nodeUrl` |
| Wallet sessions, sponsoring, swaps | node RPC and indexer GraphQL, `indexerHttpUrl` |
| Verify service | indexer GraphQL |
| Proving | nothing by default, or a proof server in `proofServerUrl` |

Preview has public endpoints built in. Mainnet and preprod have none, so NIGHTGATE refuses to start there until `nodeUrl` and `indexerHttpUrl` are set. Node and indexer must run ledger 9.

## Option A: hosted node and indexer

Use the URLs as the provider gives them. An access token in the query string is fine. A token is usually bound to one network.

```env
NIGHTGATE_NETWORK=mainnet
NIGHTGATE_NODE_URL=wss://<node-host>?token=<token>
NIGHTGATE_INDEXER_HTTP_URL=https://<indexer-host>/api/v4/graphql?token=<token>
```

The WebSocket URL is derived: `ws` scheme, `/ws` after the path, the query kept. Set `NIGHTGATE_INDEXER_WS_URL` only for a non-standard path. Check the indexer:

```bash
curl -s -X POST -H 'Content-Type: application/json' -d '{"query":"{ block { height } }"}' \
  "https://<indexer-host>/api/v4/graphql?token=$TOKEN"
```

- `401` or `403` means a missing or wrong token.
- Logs and error texts strip the query, so the token does not appear there.
- Hosted indexers usually meter requests. A wallet sync from genesis streams for minutes per wallet.
- A wallet state saved against one indexer does not carry over. The first sync against a new indexer starts from genesis.

## Option B: your own node and indexer

- **Node**: a mainnet or preprod node follows a Cardano node of the same network through db-sync. That is three containers and a day or more of sync. Midnight's node documentation has the compose file. The `node` service in `docker/docker-compose.yml` is a local dev chain, not mainnet.
- **Indexer**: the `indexer` service in `docker/docker-compose.yml` runs `midnightntwrk/indexer-standalone`. It reads the node in `INDEXER_UPSTREAM_NODE_URL`, which may also be a hosted node RPC with its token. It indexes from genesis, which takes days on mainnet.

```bash
INDEXER_UPSTREAM_NODE_URL=ws://<your-node>:9944 docker compose -f docker/docker-compose.yml up -d indexer
```

Wait until its log shows `"caught_up":true` or `GET /ready` answers 200. A half-synced indexer gives wallets silent data gaps.

```env
NIGHTGATE_NETWORK=mainnet
NIGHTGATE_NODE_URL=ws://<your-node>:9944
NIGHTGATE_INDEXER_HTTP_URL=http://127.0.0.1:8088/api/v4/graphql
```

Probing and switching to your own indexer: [operations.md](operations.md).

## Verify calls on another network

`verifyAttestationState` and `verifyPredicateState` take a `network` parameter. For a network other than the configured one, the indexer comes from `cds.requires.nightgate.networks.<network>.indexerHttpUrl`. Without that entry, mainnet and preprod answer "not verified" and preview uses its public indexer.

## Library users

`@odatano/nightgate-tx` with `api` reads the chain through the server and needs no indexer for calls that move no value. A wallet sync for swaps, transfers or coin arguments needs an indexer. See [txbuilder.md](txbuilder.md).
