# Quickstart

From `npm ci` to a working wallet-signed transaction. This walks through three paths in order of complexity:

1. **Read-side only** — index Preprod blocks against the hosted RPC. ~2 min setup.
2. **Wallet sessions + read** — connect a wallet, query its balance. ~5 min.
3. **Full submission flow** — sign and submit a NIGHT transfer or contract deploy. ~5 min once a synced wallet is available.

## Prerequisites

- Node.js ≥ 22 (CAP 10 minimum; the wallet SDK also needs `worker_threads` + `--env-file`)
- npm
- Docker Desktop (only if you want the local proof server or the local Midnight indexer)
- For wallet operations: a Midnight wallet seed (24-word BIP39 mnemonic) and viewing key. Get these from the [Lace wallet](https://www.lace.io/) extension.

## Path 1: Read-side only

```bash
npm ci
npm run dev
```

`npm run dev` uses `cds watch` with a 12 GB Node heap (configured in `scripts/dev.mjs`). The plugin defaults to Preprod with the public RPC at `wss://rpc.preprod.midnight.network/`. No `.env` or extra config required.

The crawler catches up from genesis (~100k blocks at first run; subsequent restarts are faster thanks to incremental sync). Watch the log for `[Crawler] Live subscription active`.

Verify:
```bash
curl "http://localhost:4004/api/v1/indexer/getHealth()"
curl "http://localhost:4004/api/v1/indexer/getSyncStatus()"
curl "http://localhost:4004/api/v1/nightgate/Blocks?\$top=5&\$orderby=height desc"
```

You should see non-zero `chainHeight` and the latest 5 blocks. **Done — read-side works.**

## Path 2: Wallet sessions

For wallet operations, the SDK runs in a separate worker thread and needs the proof server alongside. Add to `docker/docker-compose.yml` (already present) and start:

```bash
docker compose -f docker/docker-compose.yml up -d proof-server
```

The proof server is small (~23 MB image) but downloads ZK parameters on first contract compile (~500 MB to a few GB depending on circuit). Parameters persist in the `proof-server-data` named volume.

### Configure wallet credentials

Edit `.env` in the repo root (gitignored — never commit a real seed):

```env
NIGHTGATE_NETWORK=preprod
NIGHTGATE_NODE_URL=wss://rpc.preprod.midnight.network/

# Optional: disable crawler during wallet-only runs to free CPU/RAM for the worker
NIGHTGATE_CRAWLER_ENABLED=false

# Viewing key (64-hex encryption public key) + BIP39 mnemonic.
# NIGHTGATE HD-derives the per-role keys server-side, matching Lace — pass the mnemonic, not a raw seed.
LACE_VIEWING_KEY=a32699a5a29e453f6e92624c2fbefdee173d3f1178e3f9c71bc3edb7d91c1403
LACE_MNEMONIC="word1 word2 word3 ... word24"
```

If you have only the mnemonic, derive the viewing key with the included helper:
```bash
LACE_MNEMONIC="word1 word2 ... word24" node scripts/derive-keys.mjs
```

### Start the server

`serve:sync` runs `cds-serve` (no watch) against the persistent file DB, so deploy the schema once first (auto-deploy was removed — the submission path fails fast if the schema is missing):

```bash
npm run deploy        # cds deploy --to sqlite:db/midnight.db (first run / after schema changes)
npm run serve:sync    # cds-serve with the 12 GB heap
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

This calls `connectWallet` then `connectWalletForSigning` against `localhost:4004`, reading `LACE_VIEWING_KEY` / `LACE_MNEMONIC` from `.env`. Output:

```
--- 1. connectWallet ---
OK   sessionId = c07b1f0a-7251-488d-a64e-1bf69045d7a9

--- 2. connectWalletForSigning ---
OK   { ..., "signingEnabled": true }

Session to reuse: c07b1f0a-7251-488d-a64e-1bf69045d7a9
```

The server will start the wallet sync **in the worker thread** in the background. Expected server logs:

```
[wallet-sessions] facade pre-warm kicked off for d4c0f3cc9d3d285c
[facade] restored prior state for d4c0f3cc9d3d285c: shielded=true unshielded=true dust=true   (or =false on first run)
[worker] facade started for d4c0f3cc9d3d285c
[facade-persist] saved d4c0f3cc9d3d285c sh=4032 un=369 du=487021                              (every ~30 s)
```

**First run from a fresh seed**: cold sync takes ~5-6 hours wall-clock. The worker pegs ~3.8 GB heap during the shielded chain scan. Subsequent runs use the persisted blob from `WalletSyncStates` and delta-sync in seconds.

### Query the wallet

Once the sync hits tip (you see `[facade-persist] saved` lines with stable shielded/unshielded sizes and only the dust blob growing), query balance:

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

With a synced wallet that has some DUST (Lace shows the dust balance refilling), you can submit transactions.

### Pre-flight: estimate the fee

```bash
curl "http://localhost:4004/api/v1/nightgate/estimateSendNightFee(sessionId='...',receiverAddress='mn_addr_preprod1...',amount='1000000')"
```

Response: `{"fee":"123456","toLedger":"unshielded"}`. Compare against the wallet's `dustBalance` from `getWalletBalance`.

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

Response: `{"jobId":"...","status":"pending"}`. Submit actions are async — poll `getJobStatus(jobId, sessionId)` until `succeeded`; its `result` then holds `{"txId":"0x...","toLedger":"unshielded","amount":"1000000",...}`. The crawler later flips the matching `PendingSubmissions` row to `finalized` once the tx is indexed.

### Deploy a contract

The repo ships with a pre-compiled `counter` contract under `contracts/counter/`. Registration is already in `package.json` under `cds.requires.nightgate.contracts`.

```bash
curl -X POST http://localhost:4004/api/v1/nightgate/deployContract \
  -H "Content-Type: application/json" \
  -d '{
    "compiledArtifactRef": "counter",
    "sessionId": "c07b1f0a-...",
    "initialPrivateState": "{}"
  }'
```

Response: `{"jobId":"...","status":"pending"}`. Poll `getJobStatus`; the succeeded `result` is `{"submissionId":"...","txHash":"0x...","contractAddress":"0x...","status":"included"}`.

The deploy-e2e runner does the whole flow end-to-end (`connectWallet → connectWalletForSigning` → await prewarm sync → `registerForDustGeneration` → `deployContract`, polling each job):

```bash
npm run deploy:e2e
```

## Use NIGHTGATE in another CAP app

```bash
cd my-cap-app
npm install @odatano/nightgate @cap-js/sqlite
```

Add to `package.json`:

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

Then `cds watch`. `network` is the only required key (without it the plugin stays idle — it never auto-crawls a chain nobody chose); everything else defaults to the public Preprod endpoints. Override via env vars or CDS config — see [reference.md#configuration](reference.md#configuration). (A legacy `"kind": "nightgate"` in existing configs is harmless and ignored.)

The plugin auto-registers four OData services under `/api/v1/{nightgate,indexer,analytics,admin}`. All actions and functions documented in [actions.md](actions.md) are available immediately.

## Common next steps

- **Action reference** — [actions.md](actions.md) — every OData action + function with curl examples
- **Operations guide** — [operations.md](operations.md) — scripts, local indexer container, troubleshooting
- **Architecture** — [architecture.md](architecture.md) — worker-thread design, submission flow, persistence
- **Full configuration matrix** — [reference.md#configuration](reference.md#configuration)
