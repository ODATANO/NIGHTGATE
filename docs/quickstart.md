# Quickstart

From `npm ci` to a wallet-signed transaction, in three steps:

1. **Read-side only**: index Preprod blocks.
2. **Wallet sessions**: connect a wallet, query its balance.
3. **Submission**: send NIGHT or deploy a contract.

## Prerequisites

- Node.js >= 22, npm
- Docker, only for a local proof server or indexer
- For wallet operations: a 24-word BIP39 mnemonic and viewing key, e.g. from [Lace](https://www.lace.io/)

## Path 1: Read-side only

```bash
npm ci
npm run dev
```

`npm run dev` runs `cds watch` with a 12 GB heap against the public Preprod RPC; no `.env` needed. The crawler catches up from genesis on the first run and resumes afterwards. Wait for `[Crawler] Live subscription active`, then:
```bash
curl "http://localhost:4004/api/v1/indexer/getHealth()"
curl "http://localhost:4004/api/v1/indexer/getSyncStatus()"
curl "http://localhost:4004/api/v1/nightgate/Blocks?\$top=5&\$orderby=height desc"
```

Expect a non-zero `chainHeight` and five blocks.

## Path 2: Wallet sessions

Proving options:

- **Default, wasm:** wallet and contract circuits prove in-process; prover keys are fetched on first use. Costs seconds of worker CPU per proof.
- **Production, proof server:** `docker compose -f docker/docker-compose.yml up -d proof-server`, then set `NIGHTGATE_PROOF_SERVER_URL` (or `proofServerUrl`), which selects server proving. `NIGHTGATE_PROVING_MODE` overrides. ZK parameters persist in the `proof-server-data` volume.

### Configure wallet credentials

`.env` in the repo root (gitignored, never commit a real seed):

```env
NIGHTGATE_NETWORK=preprod
NIGHTGATE_NODE_URL=wss://rpc.preprod.midnight.network/

# Optional: frees CPU and memory for the wallet worker
NIGHTGATE_CRAWLER_ENABLED=false

# 64-hex viewing key + BIP39 mnemonic (keys are HD-derived server-side like Lace)
LACE_VIEWING_KEY=a32699a5a29e453f6e92624c2fbefdee173d3f1178e3f9c71bc3edb7d91c1403
LACE_MNEMONIC="word1 word2 word3 ... word24"
```

Viewing key from a mnemonic:
```bash
LACE_MNEMONIC="word1 word2 ... word24" node scripts/derive-keys.mjs
```

### Start the server

`serve:sync` uses the persistent file DB, which is not deployed automatically:

```bash
npm run deploy        # cds deploy --to sqlite:db/midnight.db (first run, after schema changes)
npm run serve:sync    # cds-serve, 12 GB heap
```

Expected log:
```
[serve.mjs] NODE_OPTIONS = --max-old-space-size=12288
[cds] - server listening on { url: 'http://localhost:4004' }
[wallet-worker-client] worker ready
[odatano-nightgate] Wallet worker thread ready
[odatano-nightgate] Network: preprod
[odatano-nightgate] Startup state: stopped (crawler disabled)
```

### Bootstrap a wallet session

In a second terminal:

```bash
npm run sync:start
```

Calls `connectWallet` and `connectWalletForSigning` with the `.env` credentials:

```
--- 1. connectWallet ---
OK   sessionId = c07b1f0a-7251-488d-a64e-1bf69045d7a9

--- 2. connectWalletForSigning ---
OK   { ..., "signingEnabled": true }

Session to reuse: c07b1f0a-7251-488d-a64e-1bf69045d7a9
```

The wallet then syncs in the worker thread:

```
[wallet-sessions] facade pre-warm kicked off for d4c0f3cc9d3d285c
[facade] restored prior state for d4c0f3cc9d3d285c: shielded=true unshielded=true dust=true   (false on first run)
[worker] facade started for d4c0f3cc9d3d285c
[facade-persist] saved d4c0f3cc9d3d285c sh=4032 un=369 du=487021                              (every 60 s)
```

A cold sync from a fresh seed takes hours and several GB of worker heap; later runs resume from `WalletSyncStates`. Track it with `getWalletSyncProgress(sessionId)`.

### Query the wallet

After the sync reaches the tip (`caughtUp: true`):

```bash
curl "http://localhost:4004/api/v1/nightgate/getWalletBalance(sessionId='c07b1f0a-...')"
```

Response:
```json
{
  "shieldedNight": "1000000000000",
  "unshieldedNight": "0",
  "dustBalance": "2098000",
  "registeredNightUtxoCount": 1,
  "totalNightUtxoCount": 1
}
```

## Path 3: Send a transaction

Requires a synced wallet with DUST.

### Estimate the fee

```bash
curl "http://localhost:4004/api/v1/nightgate/estimateSendNightFee(sessionId='...',receiverAddress='mn_addr_preprod1...',amount='1000000')"
```

Response: `{"fee":"123456","toLedger":"unshielded"}`; compare with `dustBalance`.

### Send NIGHT

```bash
curl -X POST http://localhost:4004/api/v1/nightgate/sendNight \
  -H "Content-Type: application/json" \
  -d '{
    "sessionId": "c07b1f0a-...",
    "receiverAddress": "mn_addr_preprod1xcmxw094zxek0jp0tdc6e294tgrx0qn0l40ugjqhtqy3w5x7dkusuzphxg",
    "amount": "1000000"
  }'
```

Response: `{"jobId":"...","status":"pending"}`. Poll `getJobStatus(jobId, sessionId)` until `succeeded`; `result` holds `{"txId":"0x...","toLedger":"unshielded","amount":"1000000",...}`.

### Deploy a contract

`contracts/counter/` is precompiled and registered in `package.json` (`cds.requires.nightgate.contracts`). Also registered: `attestation-vault` (16 fields per document) and `attestation-vault-32` (32 fields); cross-document proofs need the same width. See [contracts/README.md](../contracts/README.md).

```bash
curl -X POST http://localhost:4004/api/v1/nightgate/deployContract \
  -H "Content-Type: application/json" \
  -d '{
    "compiledArtifactRef": "counter",
    "sessionId": "c07b1f0a-...",
    "initialPrivateState": "{}"
  }'
```

Poll `getJobStatus`; `result` is `{"submissionId":"...","txHash":"0x...","contractAddress":"0x...","status":"included"}`.

End to end (connect, prewarm, `registerForDustGeneration`, `deployContract`):

```bash
npm run deploy:e2e
```

## Use NIGHTGATE in another CAP app

```bash
cd my-cap-app
npm install @odatano/nightgate @cap-js/sqlite
```

The package ships contract modules, verifier keys and zkir, but no prover keys. The first proving job fetches them from the release tag (override: `NIGHTGATE_ZK_ASSET_URL`, a `/zk-config` base) and checks them against `keys/manifest.json`. Without outbound access, run `npx nightgate-fetch-keys <contract>` once after install.

`package.json`:

```json
{
  "cds": {
    "requires": {
      "db": { "kind": "sqlite" },
      "nightgate": { "network": "preprod" }
    }
  }
}
```

Then `cds watch`. `network` is required (without it the plugin stays idle); everything else defaults to public endpoints. Configuration: [reference.md#configuration](reference.md#configuration). A `"kind": "nightgate"` entry is ignored.

The services register under `/api/v1/{nightgate,indexer,analytics,admin,verify}`.

## Next

- [actions.md](actions.md): actions and functions
- [operations.md](operations.md): scripts, local indexer, troubleshooting
- [architecture.md](architecture.md): worker thread, submission flow, persistence
- [reference.md#configuration](reference.md#configuration): configuration
