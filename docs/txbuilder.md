# Headless transaction builder (`@odatano/nightgate/txbuilder`)

Build, prove and sign a Midnight contract transaction **on your own machine,
with your own key**; a sponsor pays the fee and submits.

No NIGHTGATE server, database, CAP, proof server or Docker: proving runs
in-process (wasm), prover keys come from the sponsor's public `/zk-config` and
are cached on disk. Only the fee-unpaid transaction (~5 KB) crosses the wire.

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
attester id; the sponsor only pays the dust.

## Why it exists

The caller keeps its identity and key; the hosted side reduces to a metered
"submit these bytes" endpoint, the shape a pay-per-call gate needs.

## Install

`@odatano/nightgate-tx` is the same builder as a standalone package (under 1 MB).

```bash
npm install @odatano/nightgate-tx     # caller only
npm install @odatano/nightgate       # the full plugin, incl. the sponsor side
```

Imports differ only in the package name: `@odatano/nightgate/txbuilder` ->
`@odatano/nightgate-tx`, `@odatano/nightgate/browser` ->
`@odatano/nightgate-tx/calls`, `@odatano/nightgate/browser/attestation-vault`
-> `@odatano/nightgate-tx/attestation-vault`. The builder pulls only the
Midnight SDK packages; no CAP setup.

Version pairing: the package ships the vault modules it builds calls for.
nightgate-tx 0.6.x builds lineage-4 calls (vaults deployed with server 0.24),
0.5.x lineage 3, 0.4.x lineage 2; a mismatched pair fails against the vault.

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

Every `prepare*` helper of the browser export works the same way
(`prepareAnchorContentRoot`, `prepareProveFieldPredicate`,
`prepareGrantDisclosure`, ...). The document helpers (`prepareDocumentProof`
and friends) run offline and feed into them.

## API

### `createTxBuilder(opts) -> TxBuilder`

| option | required | meaning |
| --- | --- | --- |
| `seedHex` | yes | 128 hex chars (64-byte BIP39 seed); HD derivation matches Lace |
| `indexerHttpUrl`, `indexerWsUrl` | yes | public Midnight indexer; WS = HTTP URL + `/ws`, copy the versioned path |
| `nodeUrl` | yes | Substrate RPC (the wallet SDK's `relayURL`) |
| `zkConfigBaseUrl` | yes, unless `zkConfigDir` | public `/zk-config/<contract>` |
| `zkConfigDir` | no | local directory with `keys/` and `zkir/`; nothing is fetched, verifier keys must cover every circuit of `contractClass` |
| `contractClass` | yes | compiled `Contract` class. 32-slot vault: `.../attestation-vault-32` with `contractName: 'attestation-vault-32'`, its `/zk-config/attestation-vault-32`, and `slotWidth: 32` on the width-dependent `prepare*` helpers |
| `contractName` | no | logical contract name, default `attestation-vault`; names the default cache directory |
| `networkId` | no | default `preprod` |
| `accountIndex` | no | BIP32 account, default `0` |
| `cacheDir` | no | default `~/.cache/nightgate-txbuilder/<contractName>` |
| `circuits` | no | circuits to fetch prover keys and zkir for; default every circuit of `contractClass`, else the vault's 11 |
| `ttlMinutes` | no | transaction TTL, default 30; the sponsor must submit within it (stamped after proving) |
| `attestationSecret` | no | default derived from the seed |
| `provingMode` | no | `wasm` (default, in-process) or `server` (proves on `proofServerUrl`, which receives the witnesses) |
| `proofServerUrl` | with `server` | required by `provingMode: 'server'`, ignored otherwise |
| `proofTimeoutMs` | no | server proving: timeout of one proof request, default 300000 ms; the SDK retries up to 3 times, so set it above your slowest circuit |
| `walletSync` | no | default `true`: the wallet syncs from genesis on the calling thread for the builder's life (a full core until tip). `false`: no sync; value-free calls (every vault circuit) still build, value-moving calls fail at balancing |
| `onProgress` | no | callback for asset download and build phases |

Returns `{ attestationSecret, attesterId, zkAssets, addresses, provingMode, buildSponsorable, buildDeploySponsorable, close }`.
`close()` stops the wallet sync and the indexer sockets; otherwise both run
until the process exits.

### `deriveIdentity({ seedHex, networkId?, accountIndex?, attestationSecret? }) -> { attesterId, attestationSecret, addresses }`

The derivation `createTxBuilder` runs (role seeds, attestation secret,
`attesterId`, NIGHT address) without builder, wallet or network, ~150 ms. Use
it to show or register an identity before the first build.

### `buildSponsorable({ contractAddress, call | calls, initialPrivateState, bind?, attestationSecret?, independentCalls?, orderedPrefix? }) -> { finalizedTxB64 | unboundTxB64, serializedBytes, bound }`

Builds, proves, balances your side, signs and finalizes one call (`call`) or up
to 8 calls (`calls`) in ONE transaction. Nothing is submitted; the transaction
carries no dust, which makes it sponsorable.

**Batching** (`calls`): one balancing, one submit, one fee and one contract
state transition. Several calls on one vault belong in a batch, not in parallel
single transactions, which can refuse each other with `1010/104` (see below).
- Apply order = array order. The causality rule is checked before proving; a
  violation throws `code: 'BatchCausalityViolation'` (put the most expensive
  call last).
- Vault batches use one shared witnesses object built from the builder's
  attestation secret (override `attestationSecret`); it swaps each entry's
  `merkleProof`, so prepare every batched call with the SAME secret. Per-call
  `witnesses` are ignored.
- Same-named calls have no guaranteed relative order: batch them only when
  order-independent, grouped (both attests before both anchors).
- `bind: false` refuses a batch that moves value. The sponsor's allow-list
  applies per circuit, its size cap (default 64 KiB) to the whole transaction
  (~5.4 KB per call).

**Verify per claim, never per batch.** A landed batch can finalize partially,
fee spent either way. Confirm each effect: `verifyAttestationState` (with
`contentRoot` + `schemaId`) for attest/anchor, `verifyPredicateState` per proof
claim. The txHash proves the transaction landed, not that every call applied.

Operational notes:
- **`1010/104`**: pre-mempool refusal, fee NOT spent. Another transaction on the
  contract landed after you built: it changed a value your call reads, or grew
  a map your call touches by a trie level (maps are 16-ary; the declared gas is
  measured gas + 20 %, short while a map crosses 1, 16 or 256 entries). Rebuild
  against current state (`rebuildOnStaleTranscript`); identical bytes stay
  refused. `CHAIN_EXECUTION_FAILED` is the fee-spending fallible-phase variant
  of a value conflict.
- **`attest` + its `anchorContentRoot` in one batch** stays valid as the vault
  grows: both calls remain in the guaranteed stage (measured up to 4096
  attestations with preprod ledger parameters). `bindDocument` is fallible on
  all but tiny vaults and belongs last. If a call ever turns fallible ahead of
  a guaranteed one, the pre-check aborts locally (`BatchCausalityViolation`, no
  fee): send that call alone and batch the rest. Proof carts:
  `anchorContentRoot` first, then the proof calls. Both shapes work through
  both sponsor channels.

**Independent calls** (`independentCalls: true`): for a proof cart (distinct
claim keys, no shared cell) the builder groups the calls after `orderedPrefix`
by stage before proving, guaranteed-only first, call order within a group; on
a grown vault the same circuit can be guaranteed for one claim key and fallible
for another. `orderedPrefix: 1` keeps an in-batch `anchorContentRoot` first.
Dependent batches leave the flag unset. A remaining violation carries
`calls: [{ name, segId, stages }]` in apply order (also in the message), so a
consumer can split deterministically.

`bind` picks the handover. `true` (default) returns `finalizedTxB64` for
`sponsorFinalizedTransaction`. `false` returns `unboundTxB64`, the signed
pre-binding transaction for `sponsorUnboundTransaction`: the sponsor merges its
dust spend and binds, so one sponsor wallet pays for many callers in parallel
(one per registered dust backing). Proof, identity and TTL are identical.
Client: `ng.sponsorUnbound(...)`.

### `ensureZkAssets({ zkConfigBaseUrl, cacheDir, circuits })`

Warms the asset cache (build step, container image); `createTxBuilder` calls it.
Each run fetches `keys/manifest.json` and checks cached files by sha256:
files of a former contract generation are replaced (`refreshed` in the result;
a stale key fails `findDeployedContract` with `ContractTypeError`), a download
not matching the manifest is refused. Without a manifest the cache is used as
is. A `404` for a circuit the contract lacks is tolerated; any other error is
fatal.

## Running the sponsor half

A NIGHTGATE server with a funded, dust-registered wallet session:
- `sponsorFinalizedTransaction(finalizedTxB64, sponsorSessionId, idempotencyKey)`
  enforces the contract and circuit allow-list, balances dust and submits.
- `sponsorUnboundTransaction(unboundTxB64, ...)` pays from a locked dust
  backing; parallelism = distinct NIGHT UTxOs registered for dust generation.

The sponsor never sees a key, witness or preimage. For a one-machine test,
`buildSponsorable` also exists as an OData action (phase 1 against a stored
session); `npm run txbuilder:e2e` runs the real split.

## Costs and caveats

- **First run downloads the prover keys** (~83 MB for the vault set) and
  caches them; restrict `circuits` to the calls you make.
- **Everything runs on the calling thread**: ledger assembly, wallet sync and
  wasm proving. In a server, host the builder in a `worker_threads` worker and
  pass `walletSync: false` for value-free calls.
- **Proving blocks the thread.** `provingMode: 'server'` with `proofServerUrl`
  (`docker run -d -p 6300:6300 midnightntwrk/proof-server:8.1.0
  midnight-proof-server --network preprod`) is native and several times faster,
  but the proof server RECEIVES THE WITNESSES: use your own, never the
  sponsor's. A bare `proofServerUrl` changes nothing; `builder.provingMode`
  reports the active mode.
- **Memory follows the circuit's k, not the key size**: ~1.8 GB RSS at k=17
  (16-slot comparison circuit), ~3.5 GB at k=18 (32-slot), doubling per k. It
  is wasm memory: it never shrinks and `--max-old-space-size` does not bound
  it. Proves in one process serialize (peak = max, not sum); each process or
  worker has its own. Read k with `Zkir.deserialize(bzkir).getK()`
  (`@midnight-ntwrk/zkir-v2`). Server proving still loads the prover key
  client-side (sent with every `/prove`, ~2x key size transiently). Measure
  with `process.resourceUsage().maxRSS`; timer sampling under-reads while a
  prove blocks the loop.
- **`bind: false` refuses calls that need a balancing transaction** (the wallet
  added inputs to move value): the sponsor binds the base transaction alone.
  Use the bound handover; vault circuits move no value.
- **The TTL is real.** After `ttlMinutes` the node rejects the transaction.
- **Artifact generations must match.** Fetch `zkConfigBaseUrl` from the
  sponsor that serves the vault you target.
- **Anchored roots outlive the software only within one artifact
  generation.** Content roots, schema ids, set roots and claim keys come from
  the circuit's `transientHash` (not guaranteed stable across compiler
  generations; `persistentHash` would cost about 2.7 MB of prover key per
  hash instance and leave nothing wasm-provable). `payloadHash` is stable.
  Keep the `opening` of every anchored document: a vault on a new generation
  is a redeploy, and the holder re-anchors and re-proves from it.
- **The sponsor decides what it pays for**: fail-closed shape check (allow-listed
  contract calls only, nothing else in the envelope, size cap
  `NIGHTGATE_SPONSOR_MAX_TX_BYTES`).

## Batches on your own contract, and sponsored deploys

**Batch witnesses.** A contract instance binds its witnesses once, so a
foreign-contract batch needs one shared witnesses object: pass
`buildSponsorable({ calls, witnesses })` (per-call `before` hooks swap what
varies) or give every entry the same `witnesses` object. Vault calls get both
from the builder. A foreign batch with neither is refused up front.

**Your own contract, your own keys.** `createTxBuilder({ zkConfigDir })`, see
the option table.

**Sponsored deploy.** `buildDeploySponsorable({ initialPrivateState,
constructorArgs, witnesses, bind })` builds, proves and signs a deploy with
your key and returns the fee-unpaid transaction plus its `contractAddress`
(the build fails unless the transaction carries exactly one deploy). The
vault constructors take `[registrarId, recoveryId]` (both `Uint8Array(32)`;
a zero `recoveryId` disables the recovery modes of `registerDocument`).
- The sponsor pays when its policy allows deploys
  (`NIGHTGATE_SPONSOR_ALLOW_DEPLOY` or `allowDeploy` in the policy file) and,
  for a token caller, the grant has `allowDeploy` with budget left
  (`maxDeploys`, default 1, separate from the daily job budget, reserved
  before broadcast, one deploy per transaction).
- Byte ceiling: `NIGHTGATE_SPONSOR_MAX_DEPLOY_BYTES` (default 40960).
- The landed address is recorded on the grant (`deployedContracts`); its calls
  are sponsorable beyond the platform contract and circuit lists.
- Maintenance updates are never sponsored.
- Persist the initial private state yourself; the builder keeps it in memory
  only.

## Self-funded submission

For a caller that pays its own dust and submits to the node:
`@odatano/nightgate-tx/txbuilder` and `@odatano/nightgate/txbuilder` export
submit, reject classification, landing confirmation and dust-wedge protection.
`submitFinalized` needs the optional peer dependency `@polkadot/api`.

Below, `facade`, `configuration`, `zswapKeys` and `dustKey` are your own
wallet-sdk facade and its inputs; `builder` is a `createTxBuilder` instance.

```js
import {
    deserializeTransaction, txIdentifiers, submitFinalized,
    isTransportFailure, isAlreadyImported, waitLanded, withDustGuard
} from '@odatano/nightgate-tx/txbuilder';

const built = await builder.buildSponsorable({ contractAddress, calls, witnesses });
const tx = await deserializeTransaction(built.finalizedTxB64);

// Pay the fee from your own facade; the dust guard keeps a reject from wedging it.
const landed = await withDustGuard(facade, { configuration, dustKey }, async () => {
    const recipe = await facade.balanceFinalizedTransaction(
        tx, { shieldedSecretKeys: zswapKeys, dustSecretKey: dustKey },
        { ttl: new Date(Date.now() + 30 * 60_000), tokenKindsToBalance: ['dust'] }
    );
    const finalized = await facade.finalizeRecipe(recipe);
    const identifier = txIdentifiers(finalized).at(-1);
    const nodeUrl = 'wss://rpc.preprod.midnight.network/';
    const indexerHttpUrl = 'https://indexer.preprod.midnight.network/api/v4/graphql';

    // Transport failure: the tx MAY be in the mempool. Probe, then resend the SAME bytes.
    for (let attempt = 0; ; attempt++) {
        try { await submitFinalized(finalized, { nodeUrl }); break; }
        catch (e) {
            if (isAlreadyImported(e)) break;   // 1013: the first send is in the pool
            // Any other refused resend may mean the first send landed: wait before trusting it.
            const found = await waitLanded(identifier, { indexerHttpUrl, timeoutMs: attempt > 0 ? 30_000 : 0 });
            if (found) return found;
            if (!isTransportFailure(e) || attempt >= 2) throw e;
            await new Promise((r) => setTimeout(r, 5_000));
        }
    }

    // Confirm by identifier (blocks ~6 s apart, the indexer lags).
    const found = await waitLanded(identifier, { indexerHttpUrl, timeoutMs: 240_000, pollMs: 6_000 });
    if (found) return found;
    throw new Error('not visible on the indexer yet; it may still land');
});
if (!landed.applied) {
    // In a block but the call failed: fee spent, rebuild against current state.
}
```

Rules the helpers encode:

- **Submit over WebSocket.** The node's HTTP gateway returns 403 for bodies over
  ~14 KB, smaller than a proven call. `submitFinalized` encodes the
  `midnight.sendMnTransaction` extrinsic from the runtime metadata (HTTP) and
  submits `author_submitExtrinsic` over a one-shot socket.
- **The reject sub-code is the diagnosis** (`classifyNodeReject`):
  - `stale-dust-proof` (170/171/196): re-sync dust and rebuild; NOT out of dust.
  - `funds` (138/173, "could not balance dust"): out of dust.
  - `sequencing` (219-224): split into single-call transactions.
  - `malformed` (117): neither waiting nor an identical rebuild helps.
  - `stale-transcript` (104): rebuild against current state, e.g.
    `rebuildOnStaleTranscript(async () => sponsor(await builder.buildSponsorable(...)))`.
- **Transport is not a reject** (`isTransportFailure`): the transaction MAY be
  in the mempool. Probe (`probeLanded`), then resend the SAME bytes; a rebuild
  can land a second transaction. `1013 Transaction Already Imported` on a
  resend (`isAlreadyImported`): the first send is in the pool, confirm by
  identifier. Any other refused resend may also mean the first send landed:
  run a bounded `waitLanded` before trusting it, or a dust guard restores a
  snapshot it must not.
- **Confirm by identifier**, never by watching the contract address (another
  caller's transaction would confirm yours). `applied: false`: in a block, call
  failed, fee spent.
- **A pre-mempool reject leaks the spent dust note** in the SDK's dust wallet
  until a funded wallet cannot balance. `withDustGuard` snapshots the dust
  sub-wallet before the build and restores it on such a reject. Never persist
  a post-reject dust state; one guarded build per facade at a time.

Builders used only for building: `walletSync: false`, and always `close()`.
