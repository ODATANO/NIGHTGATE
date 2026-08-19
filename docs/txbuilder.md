# Headless transaction builder (`@odatano/nightgate/txbuilder`)

Build, prove and sign a Midnight contract transaction **on your own machine,
with your own key**, and let someone else pay the fee.

This is the caller half of cross-server fee sponsoring. It needs no NIGHTGATE
server, no database, no CAP, no proof server and no Docker: proving runs
in-process on wasm, the prover keys come from the sponsor's public `/zk-config`
and are cached on disk. What crosses the wire is one fee-unpaid transaction of
roughly 5 KB.

```
YOUR machine                                  SPONSOR's server
------------                                  ----------------
seed  ->  attester id
attestation secret
prepare* call  ->  prove (wasm)
balance own side, sign, finalize
                    finalizedTxB64  ------->  policy check (contracts, circuits)
                    (~5 KB base64)            balance dust, submit
                                              txHash
```

Nothing secret leaves the process. The on-chain attestation carries **your**
attester id; the sponsor only pays the dust and never holds your key.

## Why it exists

An agent that wants to anchor a document on Midnight has two things it does not
want to give away: its identity and its key. Handing a mnemonic to a hosted
service gives away both. This split lets the agent keep both, and reduces the
hosted side to a metered "submit these bytes" endpoint, which is exactly the
shape an x402-style pay-per-call gate wants.

## Install

If you only want to BUILD transactions, install the slim companion instead: it
is the same code, packaged on its own, under 1 MB instead of 81 MB.

```bash
npm install @odatano/nightgate-tx     # caller only
npm install @odatano/nightgate       # the full plugin, incl. the sponsor side
```

The imports differ only in the package name (`@odatano/nightgate-tx` ->
`@odatano/nightgate-tx/calls` -> `@odatano/nightgate-tx/attestation-vault`); see
`packages/nightgate-tx/README.md`. Either way, the txbuilder pulls the Midnight
SDK packages and nothing else. You do not have to install or configure the CAP
side.

## Use

```js
import { createTxBuilder } from '@odatano/nightgate/txbuilder';
import { prepareAttest } from '@odatano/nightgate/browser';
import { Contract } from '@odatano/nightgate/browser/attestation-vault';

const builder = await createTxBuilder({
    seedHex,                       // 128 hex chars, YOUR 64-byte BIP39 seed; never sent anywhere
    networkId: 'preprod',
    indexerHttpUrl: 'https://indexer.preprod.midnight.network/api/v4/graphql',
    indexerWsUrl:   'wss://indexer.preprod.midnight.network/api/v4/graphql/ws',
    nodeUrl:        'wss://rpc.preprod.midnight.network/',
    zkConfigBaseUrl: 'https://sponsor.example/zk-config/attestation-vault',
    contractClass: Contract
});

console.log(builder.attesterId);   // the identity every attestation you build will carry

const call = prepareAttest({
    payloadHash,
    metadataHash,
    attestationSecret: builder.attestationSecret
});

const { finalizedTxB64, serializedBytes } = await builder.buildSponsorable({
    contractAddress: VAULT,
    call
});

await fetch('https://sponsor.example/api/v1/nightgate/sponsorFinalizedTransaction', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ finalizedTxB64, sponsorSessionId })
});

await builder.close();
```

Every `prepare*` helper of the browser export works the same way: `prepareAttest`,
`prepareAnchorContentRoot`, `prepareProveFieldPredicate`, `prepareProveFieldEquality`,
`prepareProveFieldMembership`, `prepareGrantDisclosure`, and the rest. The
document helpers (`prepareDocumentProof` and friends) run entirely offline and
feed straight into these.

## API

### `createTxBuilder(opts) -> TxBuilder`

| option | required | meaning |
| --- | --- | --- |
| `seedHex` | yes | 128 hex chars (64-byte BIP39 seed). Role-specific HD derivation matches Lace, so this lands on the same account the server would use. |
| `indexerHttpUrl`, `indexerWsUrl` | yes | any public Midnight indexer for the network. The WS URL is the HTTP one with a `/ws` suffix; the path is versioned, so copy it rather than deriving it by hand. |
| `nodeUrl` | yes | the Substrate RPC the wallet SDK talks to (its `relayURL`) |
| `zkConfigBaseUrl` | yes | a public `/zk-config/<contract>` (the sponsor's, or any host serving the same artifacts) |
| `contractClass` | yes | the compiled `Contract` class |
| `networkId` | no | `preprod` by default |
| `accountIndex` | no | BIP32 account level, `0` by default |
| `cacheDir` | no | `~/.cache/nightgate-txbuilder/<contractName>` |
| `circuits` | no | which proving assets to fetch, default the vault's 11 |
| `ttlMinutes` | no | transaction TTL, default 30. The sponsor must submit within it. |
| `attestationSecret` | no | bring your own, else derived from the seed |
| `proofServerUrl` | no | unused under wasm proving; the SDK's config type asks for a URL, nothing calls it |
| `onProgress` | no | callback for asset download and build phases |

Returns `{ attestationSecret, attesterId, zkAssets, addresses, buildSponsorable, close }`.

### `buildSponsorable({ contractAddress, call, initialPrivateState, bind? }) -> { finalizedTxB64 | unboundTxB64, serializedBytes, bound }`

Builds, proves, balances your own side, signs and finalizes ONE circuit call,
then stops. Nothing is submitted. The transaction is fee-unpaid: it carries no
dust, which is exactly what makes it sponsorable.

`bind` picks the handover format. `true` (default) returns `finalizedTxB64`, a
bound transaction for `sponsorFinalizedTransaction`. `false` returns
`unboundTxB64`, the signed PRE-BINDING transaction for
`sponsorUnboundTransaction` (0.18): the sponsor merges its own dust spend into
it and binds, which is what lets ONE sponsor wallet pay for many callers in
parallel (one per registered dust backing). Everything else is identical: same
proof, same identity, same TTL. Prefer `bind: false` against a sponsor that
runs 0.18 or later; the SDK client exposes it as `ng.sponsorUnbound(...)`.

### `ensureZkAssets({ zkConfigBaseUrl, cacheDir, circuits })`

Exposed separately so you can warm the cache in a build step or a container
image. `createTxBuilder` calls it for you. A `404` for a circuit the contract
does not expose is tolerated; any other error is fatal. Cached files are never
re-downloaded, so only the first run needs the network for assets.

## Running the sponsor half

The sponsor is a normal NIGHTGATE server with a funded, dust-registered wallet
session. It exposes `sponsorFinalizedTransaction(finalizedTxB64,
sponsorSessionId, idempotencyKey)`, which deserializes the transaction, enforces
its contract and circuit allow-list, balances dust and submits, and (0.18)
`sponsorUnboundTransaction(unboundTxB64, ...)`, the parallel channel that pays
from a locked dust backing so N callers can be sponsored at once from one
wallet. It never sees a key, a witness or a preimage: by the time the bytes
arrive, the proof is done. To sponsor N in parallel, register N NIGHT UTxOs
for dust generation in the sponsor wallet (parallelism = distinct backings).

If you want both halves on one machine (for a test), `buildSponsorable` also
exists as an OData action, which runs phase 1 server-side against a stored
session. `npm run cross-server-probe:e2e` exercises that path;
`npm run txbuilder:e2e` exercises the real split, with phase 1 in the local
process and only the bytes going to the server.

## Costs and caveats

- **First run downloads the prover keys** (~81 MB for the full vault set) and
  caches them. Restrict `circuits` to what you actually call to cut that down.
- **Proving blocks the thread.** It is wasm in-process; run it off your request
  path or in a worker. Or opt in to `provingMode: 'server'` with
  `proofServerUrl` pointing at YOUR OWN proof server (`docker run -d -p
  6300:6300 midnightntwrk/proof-server:8.1.0 midnight-proof-server --network
  preprod`): native and multi-threaded, `attest` drops from 25-35 s to 7-9 s
  and the 38 MB comparison circuit from 4-5 min to well under a minute. The
  proof server RECEIVES THE WITNESSES, so never point this at the sponsor's;
  that is why it is an explicit opt-in and a bare `proofServerUrl` (documented
  as unused in 0.17) still does nothing. `builder.provingMode` tells you which
  mode is active.
- **`bind: false` refuses calls that need a balancing transaction** (the call
  moves shielded or unshielded value and the wallet had to add inputs): the
  sponsor binds the base transaction alone, so handing it over unbound would
  produce a different, unbalanced transaction. Use the bound handover for
  those; the vault's attestation and proof circuits move no value.
- **The TTL is real.** A transaction the sponsor submits after `ttlMinutes` is
  rejected by the node. Ship the bytes promptly.
- **Artifact generations must match.** The `zkConfigBaseUrl` you fetch from and
  the vault you target have to be the same generation of the compiled contract.
  Fetching from the sponsor's own `/zk-config` is the reliable way to guarantee
  that.
- **The sponsor decides what it pays for.** The server enforces a fail-closed
  shape check (only allow-listed contract calls, nothing else in the envelope,
  size-capped via `NIGHTGATE_SPONSOR_MAX_TX_BYTES`); allow-listing contracts
  and circuits bounds which calls it will pay for.
