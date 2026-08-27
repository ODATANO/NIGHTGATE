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
| `contractClass` | yes | the compiled `Contract` class (`@odatano/nightgate/browser/attestation-vault`, or `.../attestation-vault-32` for the 32-slot width variant; pass `contractName: 'attestation-vault-32'` and its `/zk-config/attestation-vault-32` base URL with it, and hand `slotWidth: 32` to the width-dependent `prepare*` helpers) |
| `networkId` | no | `preprod` by default |
| `accountIndex` | no | BIP32 account level, `0` by default |
| `cacheDir` | no | `~/.cache/nightgate-txbuilder/<contractName>` |
| `circuits` | no | which proving assets to fetch, default the vault's 11 |
| `ttlMinutes` | no | transaction TTL, default 30. The sponsor must submit within it. |
| `attestationSecret` | no | bring your own, else derived from the seed |
| `proofServerUrl` | no | unused under wasm proving; the SDK's config type asks for a URL, nothing calls it |
| `onProgress` | no | callback for asset download and build phases |

Returns `{ attestationSecret, attesterId, zkAssets, addresses, buildSponsorable, close }`.

### `buildSponsorable({ contractAddress, call | calls, initialPrivateState, bind?, attestationSecret? }) -> { finalizedTxB64 | unboundTxB64, serializedBytes, bound }`

Builds, proves, balances your own side, signs and finalizes ONE circuit call
(`call`) or a BATCH of up to 8 calls (`calls`) in ONE transaction, then stops.
Nothing is submitted. The transaction is fee-unpaid: it carries no dust, which
is exactly what makes it sponsorable.

**Batching** (`calls`): one transaction means one balancing round, one submit
and one fee event for the whole list, and, decisively, ONE contract state
transition: concurrent single attests against a vault conflict on its global
attestation sequence counter (any two in a block, regardless of attester, and
the losers' fees are spent), so a multi-document anchoring belongs in a batch,
not in parallel singles. Apply order = array order (deterministic, fail-closed
segment ordering); the ledger's causality rule is checked BEFORE proving and a
violation throws with `code: 'BatchCausalityViolation'` (put the most
expensive call last). Per-call `witnesses` are ignored for a batch: one shared
witnesses object, built from this builder's attestation secret (override via
`attestationSecret`), serves every call through a proof holder that swaps each
entry's `merkleProof` (the `prepare*` helpers return the raw bundle for this),
so prepare every batched call with the SAME secret. Same-named calls are
indistinguishable to the segment ordering (their relative order is not
guaranteed): duplicates are safe only when order-independent among
themselves, so GROUP them (both attests before both anchors). `bind: false`
refuses a batch that moves value; the sponsor's allow-list applies per
circuit and its size cap (default 64 KiB) to the whole transaction (~5.4 KB
per call).

**Verify per claim, never per batch.** After the sponsor's txHash lands, the
ledger's fallible phase can still finalize PARTIALLY: some calls applied,
others not, the fee spent either way. A batch consumer must confirm every
call's effect individually through the crawler-free reads
(`verifyAttestationState` for attest/anchor effects with `contentRoot` +
`schemaId`, `verifyPredicateState` for each proof claim with its exact
coordinates) and treat only the individually confirmed claims as
established. The txHash proves the transaction landed, not that every call
in it applied.

Two live-measured operational notes: (1) `1010/104` is the node's
PRE-MEMPOOL reject for a guaranteed-phase STATE CONFLICT (measured: two
concurrent read-modify-write calls on one cell reproduce it exactly): your
transaction was proven against contract state that moved before the node
executed its guaranteed stages. The fee is NOT spent. REBUILD against the
current state and hand fresh bytes over; resubmitting the identical
transaction re-runs the same stale reads and stays stuck. The fee-spending
`CHAIN_EXECUTION_FAILED` is the fallible-phase flavor of the same
conflict. (2) batching
`attest` together with its `anchorContentRoot` works only on a YOUNG vault:
`attest`'s gas crossed into the fallible class after roughly five
attestations in measurement, from then on the causality pre-check aborts
locally with `BatchCausalityViolation` (nothing submitted, no fee) and you
split like the server lanes do, attest in its own transaction, batch the
rest. The DURABLE batch shape is the proof cart: `anchorContentRoot` first,
then the proof calls (equality/membership/predicate, each with its own
`merkleProof`, swapped by the shared holder): anchor stays guaranteed and
the proofs may go fallible without breaking the order, so this shape stays
valid as the vault grows. Both the proof cart and the attest split are
live-proven through BOTH sponsor channels (bound `sponsorFinalizedTransaction`
and unbound `sponsorUnboundTransaction`).

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

## Batches on your own contract, and sponsored deploys (0.21.0)

**Batch witnesses.** A Compact contract instance binds its witnesses once, so a
batch needs ONE shared witnesses object plus a way to switch what varies per
call. Until 0.21.0 the batch path supplied the attestation vault's witnesses
regardless of contract, so a batch on your own contract failed at the first
witness the vault does not define. Now `buildSponsorable({ calls, witnesses })`
takes your shared witnesses (per-call `before` hooks swap what varies), a batch
whose entries all carry the same `witnesses` object uses that, and the vault
family keeps getting both from the builder. A foreign-contract batch without
either is refused up front with the real reason.

**Your own contract, your own keys.** `createTxBuilder({ zkConfigDir })` reads
`keys/` and `zkir/` from a local directory instead of a sponsor's `/zk-config`;
the verifier keys must cover every circuit of `contractClass`.

**Sponsored deploy.** `buildDeploySponsorable({ initialPrivateState,
constructorArgs, witnesses, bind })` builds, proves and signs a contract deploy
with YOUR key and hands back the fee-unpaid transaction plus the
`contractAddress` it will create. A sponsor pays the dust when its policy allows
deploys (`NIGHTGATE_SPONSOR_ALLOW_DEPLOY`, or `allowDeploy` in the policy file)
and, for a token caller, the grant carries `allowDeploy` with deploy budget
left (`maxDeploys`, default 1, separate from the daily job budget). A deploy has
its own byte ceiling (`NIGHTGATE_SPONSOR_MAX_DEPLOY_BYTES`, default 40960).
The budget is reserved before the sponsor broadcasts (one deploy per
transaction). After it lands, the address is recorded on the grant
(`deployedContracts`) and is sponsorable on top of the platform allow-list,
circuits included (a sponsor's circuit list names the shared contracts'
circuits, not yours), so the follow-up calls are sponsorable without an
operator round trip. Contract
maintenance updates are never sponsored. The build fails unless the
transaction carries exactly one deploy action with an address, so a returned
`contractAddress` is always usable. Persist the initial private state
yourself: the builder keeps it in memory only.
