# Quickstart

From `npm ci` to a wallet-signed transaction, run from a clone of this repository.

## Prerequisites

- Node.js 22.12 or later
- A Midnight node and indexer. Mainnet needs your own or hosted ones in `NIGHTGATE_NODE_URL` and `NIGHTGATE_INDEXER_HTTP_URL`, see [self-hosted.md](self-hosted.md).
- For wallet operations: a 24-word BIP39 mnemonic, for example from [Lace](https://www.lace.io/)

## 1. Index blocks

`.env` in the repository root (gitignored, never commit a real seed):

```env
NIGHTGATE_NETWORK=mainnet
NIGHTGATE_NODE_URL=ws://<node-host>:9944
NIGHTGATE_INDEXER_HTTP_URL=http://<indexer-host>:8088/api/v4/graphql
ENCRYPTION_KEY=<output of openssl rand -hex 32>
```

```bash
npm ci
npm run dev
```

The crawler catches up from genesis on the first run and resumes afterwards. Once the log shows `Live subscription active`:

```bash
curl "http://localhost:4004/odata/v4/midnight-indexer/getSyncStatus()"
curl "http://localhost:4004/odata/v4/midnight/Blocks?\$top=5&\$orderby=height desc"
```

## 2. Connect a wallet

Add the wallet to `.env`. `NIGHTGATE_CRAWLER_ENABLED=false` leaves CPU and memory to the wallet worker.

```env
NIGHTGATE_CRAWLER_ENABLED=false
LACE_VIEWING_KEY=<64 hex>
LACE_MNEMONIC="word1 word2 ... word24"
```

`LACE_MNEMONIC="..." node scripts/derive-keys.mjs` prints the viewing key of a mnemonic.

Long syncs run under `serve:sync`, which uses the file database and does not restart on file changes:

```bash
npm run deploy        # first run and after schema changes
npm run serve:sync
```

In a second terminal:

```bash
npm run sync:start
```

It calls `connectWallet` and `connectWalletForSigning` and prints the session id. The wallet then syncs in the worker. A first sync takes long and needs several GB of heap. Later runs resume from the saved state. Watch it with `getWalletSyncProgress(sessionId)` until `caughtUp` is true, then:

```bash
curl "http://localhost:4004/odata/v4/midnight/getWalletBalance(sessionId='<session>')"
```

## 3. Send a transaction

Mainnet submission is off by default. Set `cds.requires.nightgate.allowMainnetSubmission` to `true` in `package.json` or `.cdsrc.json` first. The transaction spends real NIGHT and DUST.

The wallet needs DUST. Estimate the fee first and compare it with `dustBalance`:

```bash
curl "http://localhost:4004/odata/v4/midnight/estimateSendNightFee(sessionId='<session>',receiverAddress='mn_addr1...',amount='1000000')"
```

Send NIGHT:

```bash
curl -X POST http://localhost:4004/odata/v4/midnight/sendNight \
  -H "Content-Type: application/json" \
  -d '{ "sessionId": "<session>", "receiverAddress": "mn_addr1...", "amount": "1000000" }'
```

The answer is `{ "jobId": "...", "status": "pending" }`. Poll `getJobStatus` until `status` is `succeeded`. `result` holds the `txId`.

Deploy a contract:

```bash
curl -X POST http://localhost:4004/odata/v4/midnight/deployContract \
  -H "Content-Type: application/json" \
  -d '{ "compiledArtifactRef": "counter", "sessionId": "<session>", "initialPrivateState": {} }'
```

The job's `result` carries `txHash` and `contractAddress`. `npm run deploy:e2e` runs connect, prewarm, dust registration and deploy end to end.

## Contracts

The contracts are npm dependencies, registered in `cds.requires.nightgate.contracts` with one `{ "package": "..." }` entry each: `@odatano/contract-counter`, `-attestation-vault`, `-attestation-vault-32`, `-shielded-token`, `-token-factory`, `-holder-registry`. Sources: [NIGHTGATE-CONTRACTS](https://github.com/ODATANO/NIGHTGATE-CONTRACTS).

The packages ship verifier keys and zkir but no prover keys. The first proving job fetches them. `NIGHTGATE_ZK_ASSET_URL` overrides the source. Without outbound access, run `npx nightgate-fetch-keys <contract>` once.

## Proving

- Default: wasm in-process. A proof costs tens of seconds to minutes of worker CPU.
- Production: `docker compose -f docker/docker-compose.yml up -d proof-server` and `NIGHTGATE_PROOF_SERVER_URL=http://localhost:6300`. A proof-server URL selects server proving. `NIGHTGATE_PROVING_MODE` overrides.

## Next

- [Install as a CAP plugin](../README.md#install-as-a-cap-plugin)
- [actions.md](actions.md): actions and functions
- [operations.md](operations.md): scripts, own indexer, troubleshooting
- [reference.md#configuration](reference.md#configuration): configuration
