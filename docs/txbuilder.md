# Headless transaction builder (`@odatano/nightgate/txbuilder`)

The builder builds, proves and signs a Midnight contract transaction on your
own machine, with your own key. A sponsor pays the fee and submits.

You need no NIGHTGATE server, database, proof server or Docker of your own.
Proving runs in-process with wasm. Prover keys come from the sponsor's public
`/zk-config` and are cached on disk. Only the fee-unpaid transaction of about
5 KB goes to the sponsor. Seed, witnesses and preimages never leave the
process, and the on-chain attestation carries your attester id.

## Install

```bash
npm install @odatano/nightgate-tx     # the caller side alone
npm install @odatano/nightgate        # the full plugin, with the sponsor side
```

Both ship the same builder. In `@odatano/nightgate-tx`, `/browser` is
`/calls` and `/browser/attestation-vault` is `/attestation-vault`. The other
paths keep their name. The package ships the vault modules it builds calls
for, so use a release that matches the vault you call.

## Use

```js
import { createTxBuilder } from '@odatano/nightgate/txbuilder';
import { connect } from '@odatano/nightgate/client';
import { prepareAttest } from '@odatano/nightgate/browser';
import { Contract } from '@odatano/nightgate/browser/attestation-vault';

const api = { baseUrl: 'https://sponsor.example', agentToken };
const builder = await createTxBuilder({
    seedHex,                        // 128 hex chars, your 64-byte BIP39 seed
    networkId: 'mainnet',
    api,
    walletSync: false,              // vault calls move no value
    zkConfigBaseUrl: 'https://sponsor.example/zk-config/attestation-vault',
    contractClass: Contract
});

const call = prepareAttest({ payloadHash, metadataHash, attestationSecret: builder.attestationSecret });
const { finalizedTxB64 } = await builder.buildSponsorable({ contractAddress: VAULT, call });
const job = await connect(api).sponsorFinalized({ finalizedTxB64 });
await builder.close();
```

Every `prepare*` helper of the browser export works the same way, for example
`prepareAnchorContentRoot`, `prepareProveFieldPredicate` and
`prepareGrantDisclosure`. `prepareDocumentProof` and the other document
helpers run offline and feed them.

A refused server call throws `NightgateApiError` with `status` and `code`. A
429 and a retryable 503 also carry `retryAfterSeconds`. `isRetryable(err)`
says whether the same call may be repeated.

## `createTxBuilder(opts) -> TxBuilder`

| option | required | meaning |
| --- | --- | --- |
| `seedHex` | yes | 128 hex chars, a 64-byte BIP39 seed. HD derivation matches Lace |
| `api` | yes, unless indexer URLs and `nodeUrl` | a NIGHTGATE server to read the chain through. Takes the `connect()` options or a connected client. Contract state, deploys and `probeLanded` then come from `ContractStates/stateAt`, `ContractActions` and `Transactions/byIdentifier`. The server's crawler must run, because every build pins its newest indexed block (`Blocks/latest`). A wallet sync still needs the indexer URLs, unless `api` is the options object with a gateway key (`token: 'oda_…'`). Then the wallet syncs through the gateway's indexer lane. A connected client carries no key and never takes the lane |
| `maxLagBlocks` | no | with `api`, default 60. A contract state from a server further behind the chain is refused, because a build on a stale state can fail on chain with the fee spent |
| `indexerHttpUrl`, `indexerWsUrl` | yes, unless `api` | a Midnight indexer you can reach. With `api` only needed for a wallet sync |
| `nodeUrl` | yes, unless `api` | Substrate RPC URL. With `api` the builder dials no node |
| `package` | no | an installed lineage package (`@odatano/contract-<name>`). Supplies `contractClass`, `contractName`, `privateStateId` and the keys directory. Missing prover keys are fetched from its release assets and checked against its `keys/manifest.json`. Explicit options win |
| `from` | no | directory `package` resolves from, default `process.cwd()` |
| `zkConfigBaseUrl` | yes, unless `zkConfigDir` or `package` | a public `/zk-config/<contract>`. The first build fetches `compiler/contract-manifest.json` and the keys into `cacheDir`. A server without the manifest is refused before any key is downloaded |
| `zkConfigDir` | no | local directory with `keys/`, `zkir/` and `compiler/contract-manifest.json` as compactc writes them. Nothing is fetched. Verifier keys must cover every circuit of `contractClass` |
| `contractClass` | yes, unless `package` | the compiled `Contract` class |
| `contractName` | no | default `attestation-vault`. Names the default cache directory |
| `privateStateId` | no | default `attestationVaultPrivateState` |
| `networkId` | no | default `mainnet` |
| `accountIndex` | no | BIP32 account, default `0` |
| `cacheDir` | no | default `~/.cache/nightgate-txbuilder/<contractName>` |
| `proverMaterialDir` | no | keys of the wallet's own circuits and the BLS parameters, default `~/.cache/nightgate-txbuilder/prover-material` |
| `circuits` | no | circuits to fetch prover keys and zkir for. Default every circuit of `contractClass`, else the vault's 11 |
| `ttlMinutes` | no | transaction TTL, default 30. The sponsor must submit within it |
| `attestationSecret` | no | default derived from the seed |
| `provingMode` | no | `wasm` (default) proves in-process. `server` proves wallet and contract circuits on `proofServerUrl` |
| `proofServerUrl` | with `server` | the proof server receives the witnesses and sees the coins you spend. Use only one you run |
| `proofTimeoutMs` | no | server proving, timeout of one proof request, default 300000. The SDK retries a timed-out proof, so set it above your slowest circuit |
| `walletSync` | no | `true` (default), `false`, `'shielded'` or `'coins'`. See the table below |
| `walletState` | no | from `serializeWalletState()`. The sub-wallets in it resume instead of syncing from genesis |
| `shieldedWallet` | no | a started shielded wallet of the same seed, such as `swap.shieldedWallet`. The builder balances from it and never starts or stops it. Excludes `walletState.shielded` |
| `fetchFn` | no | fetch for the contract's proving files, default the global `fetch` |
| `onProgress` | no | callback for asset download, wallet start and build phases. While a wallet syncs it gets `{ phase: 'sync', wallet, appliedIndex, highestIndex, isConnected }` at most once a second per wallet and once at the tip |

The 32-slot vault takes `.../attestation-vault-32` as `contractClass`,
`contractName: 'attestation-vault-32'`, its `/zk-config/attestation-vault-32`
and `slotWidth: 32` on the width-dependent `prepare*` helpers.

| call | `walletSync` |
| --- | --- |
| vault circuits, a token-factory mint, any call that moves no coin of the builder | `false` |
| a sponsored swap half, a call with a shielded coin argument | `'shielded'` |
| a sponsored call that pays the builder's own NIGHT into the contract | `'coins'` |
| a self-funded submission, where the builder pays its own dust | `true` |

`true` syncs every sub-wallet from genesis on the calling thread. The dust
history alone takes hours on mainnet. `'shielded'` syncs the shielded coins,
`'coins'` adds the NIGHT coins. With `false` a call that moves value fails at
balancing.

The builder returns `{ attestationSecret, attesterId, zkAssets, addresses,
shieldedKeys, provingMode, walletSync, waitForSync, serializeWalletState,
buildSponsorable, buildDeploySponsorable, revert, close }`.

- `walletSync` is the resolved mode: `'all'`, `'coins'`, `'shielded'` or `'none'`.
- `waitForSync()` resolves when every started sub-wallet reached the tip and reads the chain at ledger 9, a shared shielded wallet included. A wallet catches up a moment before it learns that the chain runs ledger 9. A build in that moment would be for the ledger before it.
- `serializeWalletState()` returns `{ shielded?, unshielded?, dust? }` for the synced sub-wallets. It holds the coins, so store it like a key.
- `revert(tx)` releases the coins a built transaction reserved, when it will not land. Takes an offer file, base64 or bytes, bound or not.
- `close()` stops the wallet sync and the indexer sockets. Without it both run until the process exits.

### One shielded wallet per seed

A process that swaps and calls contracts on one seed runs one shielded wallet.
Separate wallets each sync the chain and see only their own spends, so two
builds can pick the same coin.

```js
const swap = await createSwapWallet({ seedHex, indexerHttpUrl, indexerWsUrl, walletState });
const builder = await createTxBuilder({ seedHex, api, package: '@acme/contract-pay', shieldedWallet: swap.shieldedWallet, walletSync: false });
await swap.sync();
const { finalizedTxB64 } = await builder.buildSponsorable({ contractAddress, call });
await builder.close();                   // leaves the wallet running
await swap.close();                      // stops it
```

## `deriveIdentity({ seedHex, networkId?, accountIndex?, attestationSecret? })`

Returns `{ attesterId, attestationSecret, addresses, shieldedKeys }` without
builder, wallet or network. `shieldedKeys` is `{ coinPublicKey,
encryptionPublicKey }`, what another builder lists under `recipients`.
`deriveRoleSeeds(seedHex, accountIndex?)` returns the per-role seeds, which
are secret keys.

## `buildSponsorable(input) -> { finalizedTxB64 | unboundTxB64, serializedBytes, bound }`

Input: `{ contractAddress, call | calls, witnesses?, initialPrivateState?,
bind?, attestationSecret?, independentCalls?, orderedPrefix?, gasHeadroom?,
recipients? }`.

Builds, proves, balances your side, signs and finalizes one `call` or up to 8
`calls` in one transaction. Nothing is submitted. The transaction carries no
dust, which makes it sponsorable.

- `bind: true` (default) returns `finalizedTxB64` for `sponsorFinalizedTransaction` (client `sponsorFinalized`).
- `bind: false` returns `unboundTxB64` for `sponsorUnboundTransaction` (client `sponsorUnbound`). The sponsor merges its dust spend and binds, so one sponsor wallet pays for many callers at once.
- `bind: false` refuses a call that needs a balancing transaction because it moves value. Use the bound handover for it.
- `recipients: [{ coinPublicKey, encryptionPublicKey }]` lists the wallets a call creates a shielded coin for, such as a mint to a third party. Without them the build fails with `Unable to resolve encryption public key for recipient`.

### Batches

A batch has one balancing, one fee and one contract state transition. Several
calls on one vault belong in one batch. Parallel single transactions can
refuse each other with `1010/104`.

- Calls apply in array order. The ledger runs all guaranteed stages before any fallible one.
- A causality violation is caught before proving and throws `code: 'BatchCausalityViolation'`, with `calls: [{ name, segId, stages }]` in apply order.
- Before proving the builder applies the batch to a local ledger. A call that runs out of gas throws `code: 'BatchGasBudgetExceeded'`. Split the batch.
- `independentCalls: true` groups the calls after `orderedPrefix` by stage, guaranteed first. Use it for a proof cart with distinct claim keys. `orderedPrefix: 1` keeps an in-batch `anchorContentRoot` first.
- A contract instance binds its witnesses once. Pass one shared `witnesses` object, or give every call the same one. Per-call `before` hooks set what varies.
- Vault batches without shared witnesses get them from the builder's attestation secret, or `attestationSecret`. Prepare every batched call with the same secret.
- `attest` and its `anchorContentRoot` stay in the guaranteed stage as the vault grows. `bindDocument` is fallible and goes last.
- A landed batch can finalize partially, fee spent. Verify each claim with `verifyAttestationState` or `verifyPredicateState`, never the batch.

### Stale state and gas headroom

`1010/104` is a pre-mempool refusal, fee not spent. Another transaction
changed a value your call reads, or grew a map your call touches by a trie
level. Maps are 16-ary, and the declared gas is measured gas plus 20 %, so it
falls short while a map crosses 1, 16 or 256 entries. Identical bytes stay
refused. Rebuild against current state, for example with
`rebuildOnStaleTranscript`. `CHAIN_EXECUTION_FAILED` is the fallible-phase
variant, and it spends the fee.

`gasHeadroom` (single call, 1 to 10) multiplies the call's declared gas before
proving, so the call still applies after a parallel caller opened the next
trie level. The fee grows with it. A batch takes no headroom, and a circuit
that calls another contract is refused.

The factor is an upper bound. The ledger limits the time a node needs to
dismiss a transaction: 15 ms, or 2 µs per byte for a larger one, on the current
networks. The guaranteed gas and the checks of the proofs count toward it, and
a transaction over the limit is refused with `1010/231`. The builder reads the
chain's limits and lowers the factor to what fits once a sponsor added its dust
spend, down to 1. A heavy call has room for less than `1.5`. `onProgress`
reports `{ phase: 'gas-headroom', factor, requested, guaranteed, fallible }`,
with `factor` the one applied. The sponsor checks the finished transaction
again and refuses one over the limit before it sends it.

### Contracts deployed before ledger 9

The fork translates a contract's state but keeps its verifier keys. A contract
deployed before the fork is therefore called with the package version compiled
for ledger 8, under its own name next to the current one:

```bash
npm install vault-ledger8@npm:@odatano/contract-attestation-vault@ledger8
```

```js
const builder = await createTxBuilder({ package: 'vault-ledger8', circuits: ['attest'], api, seedHex, networkId, walletSync: false });
```

- An own contract works the same way: pass `contractClass` and `zkConfigDir` of the ledger 8 build. The builder reads the compiler's runtime from `compiler/contract-info.json`. The build's folder needs `compact-runtime` 0.16.0 as a dependency of its `package.json`, and the project installs that folder as its own dependency, for example `file:./pot-ledger8`.
- `expected instance of ChargedState` means two copies of `@midnight-ntwrk/onchain-runtime-v3`, usually from a separate `npm install` inside the build's folder. `npm ls @midnight-ntwrk/onchain-runtime-v3` must show one version in one place.
- The result is a ledger 9 transaction. A sponsor handles it like any other.
- Pass a contract deployed after the fork to a builder of the current package. Each builder serves one of the two.
- One call per transaction. A batch is refused.
- `buildDeploySponsorable` is refused. A new deploy uses the current package.
- A circuit that spends a shielded coin the contract already holds is refused by midnight-js.
- With the current package, such a contract fails with a message that names this section's cause.
- The server's own contract actions, such as `submitContractCall` or `issue*`, use the current packages and refuse such a contract with a message that names this path. Build the call here and hand it to `sponsorUnboundTransaction`. The server's reads keep working.

## `buildDeploySponsorable({ initialPrivateState?, constructorArgs?, witnesses?, recipients?, bind? })`

Builds, proves and signs a deploy with your key. Returns the same shape as
`buildSponsorable` plus `contractAddress`. The build fails unless the
transaction carries exactly one deploy. The vault constructors take
`[registrarId, recoveryId]`, both `Uint8Array(32)`.

- The sponsor pays when its policy allows deploys (`NIGHTGATE_SPONSOR_ALLOW_DEPLOY` or `allowDeploy` in the policy file).
- A token caller also needs a grant with `allowDeploy` and budget left (`maxDeploys`, default 1).
- Byte ceiling: `NIGHTGATE_SPONSOR_MAX_DEPLOY_BYTES`, default 40960.
- The landed address is recorded on the grant (`deployedContracts`). Its calls are sponsorable beyond the platform contract and circuit lists.
- Maintenance updates are never sponsored.
- The builder keeps the initial private state in memory only. Persist it yourself.

## Proving files

`ensureZkAssets({ zkConfigBaseUrl, cacheDir, circuits? })` or
`ensureZkAssets({ package, from?, circuits? })` warms the cache, for example
in a container build. `createTxBuilder` calls it.

- Each run checks cached files by sha256 against the served `keys/manifest.json` and downloads stale ones again (`refreshed`). Without a manifest the cache is used as is.
- A `404` for a circuit the contract lacks is tolerated. Any other error is fatal.
- With `package` the package is the cache. Missing prover keys come from `contract.json#zkAssetUrl` (`source: 'package'`).
- `resolveBuilderPackage({ package, from? })` returns what the builder reads from a package, after checking it against the digest in `contract.json`.
- The wallet's own circuits and the BLS parameters live under `proverMaterialDir`. A missing or damaged file is downloaded by the wallet SDK, which checks it against the hash its ledger release declares. `createProverMaterialProvider({ dir })` returns this provider for the SDK's `makeWasmProvingService`.

## Shielded swaps

Two wallets exchange shielded tokens without a contract. Each builds one half:
it spends the coin it gives and creates the coin it wants. Two mirrored halves
merge into one transaction that settles both legs or none. A sponsor pays the
fee with `sponsorSwap`, so neither party needs NIGHT or dust.

```js
import { connect } from '@odatano/nightgate/client';
import { createSwapWallet } from '@odatano/nightgate/txbuilder';

const give = { tokenType: CREDIT, amount: 1000n };
const want = { tokenType: DATA, amount: 300n };

const maker = await createSwapWallet({ seedHex, indexerHttpUrl, indexerWsUrl });
await maker.sync();
const { offer } = await maker.buildHalf({ give, want });    // offer file text, swapoffer1...

const taker = await createSwapWallet({ seedHex: other, indexerHttpUrl, indexerWsUrl });
await taker.sync();
const { makerHalfB64, takerHalfB64 } = await taker.takeOffer({ offer, expect: { gives: give, wants: want } });
const { txHash } = await connect({ baseUrl, agentToken }).sponsorSwap({ makerHalfB64, takerHalfB64 });
```

### `createSwapWallet(opts) -> SwapWallet`

| option | required | meaning |
| --- | --- | --- |
| `seedHex` | yes | 128 hex chars, a 64-byte BIP39 seed |
| `indexerHttpUrl`, `indexerWsUrl` | yes, unless `api` | the indexer the wallet syncs from |
| `api` | no | the `connect()` options with a gateway key (`{ baseUrl, token: 'oda_…' }`). The wallet syncs through the gateway's indexer lane |
| `networkId` | no | default `mainnet` |
| `accountIndex` | no | default 0 |
| `provingMode` | no | `wasm` (default) or `server` |
| `proofServerUrl` | with `server` | sees the coins you spend. Use only one you run |
| `proverMaterialDir` | no | as for `createTxBuilder` |
| `walletState` | no | from `serializeState()`. Resumes instead of syncing from genesis |
| `maxInputs` | no | most coins one half spends, default 4, the sponsor's default `NIGHTGATE_SPONSOR_SWAP_MAX_INPUTS` |
| `onProgress` | no | as for `createTxBuilder` |

Only the shielded wallet syncs. The saved state holds the coins, so store it
like a key. The wallet returns `{ address, coinPublicKey,
encryptionPublicKey, provingMode, maxInputs, sync, balances, pendingBalances,
pending, coins, spendable, buildHalf, buildTransfer, takeOffer, revert,
serializeState, shieldedWallet, close }`.

- `buildHalf({ give, want, bind? })` returns `{ halfB64, tx, offer?, bound, terms, serializedBytes, revert }`. `bind: true` (default) binds the half and adds the offer file.
- `takeOffer({ offer, expect? })` returns `{ makerHalfB64, takerHalfB64, bound, terms, revert }`. It reads the terms from the transaction, refuses when they differ from `expect`, and builds the mirror half in the offer's form.
- `balances()` sums the free coins per token type. A half gives only from them.
- `pendingBalances()` sums what built halves bring back once their swaps land.
- `coins()` lists the free coins. `spendable(tokenType)` is the most one half can give, the sum of the `maxInputs` largest free coins.
- `pending()` lists the reserved coins with the `ttl` the SDK waits for each.
- `revert(input)` releases the coins of a half or transfer that did not land, from its offer file, base64 or bytes. The saved state carries reservations across restarts.
- `shieldedWallet` is the wallet behind it, for `createTxBuilder({ shieldedWallet })`.
- `buildHalf` spends the smallest coins that still fit `maxInputs`, so trading merges small coins. A wallet with two token types can take its own offer to merge coins.
- A half refers to a recent state of the coin tree and expires with it. Hand the halves over soon after building.
- A half with 4 inputs is about 30 kB, the merged swap about 60 kB. A sponsor that accepts more inputs needs a larger `NIGHTGATE_SPONSOR_MAX_TX_BYTES`, default 65536.

### Transfers

```js
const built = await wallet.buildTransfer({ tokenType: CREDIT, amount: 250n, to: recipientShieldedAddress });
const { txHash } = await ng.sponsorTransfer({ transferTxB64: built.txB64, tokenType: CREDIT, amount: '250' });
```

- `buildTransfer({ tokenType, amount, to, bind? })` returns `{ txB64, tx, bound, serializedBytes, inputs, terms, revert }`. `to` is a shielded address (`mn_shield-addr_...`).
- The recipient gets one coin, the wallet its change.
- A transfer nets to zero and shows no token type. The server records `tokenType` and `amount` as the caller's declaration (`declared: true` in the receipt). It checks the shape with the rule of `readTransferShape(tx)`.
- `getJobStatus` of a landed swap or transfer carries `receipt`, once the chain confirmed the job. `sponsorSwap` and `sponsorTransfer` return the `jobId` for that call, and `receipt` when it is already there. It usually is not yet, because they return when the job succeeded and the chain confirms later.
- `ng.waitForReceipt({ jobId })` waits for the receipt and throws when the job fails or can have none. A server before 0.43.1 also needs the returned `sessionId`. It holds a call on the server where it can, and otherwise polls from 10 s up to 60 s. A metered gateway may bill each call.
- `verifyReceipt(receipt, publicKey)` from the client checks a receipt against the key `ng.getReceiptKey()` publishes.

### Unshielded transfers

```js
import { createUnshieldedWallet } from '@odatano/nightgate/txbuilder';

const wallet = await createUnshieldedWallet({ seedHex, indexerHttpUrl, indexerWsUrl });
await wallet.sync();
const built = await wallet.buildTransfer({ amount: 2_000_000_000n, to: recipientAddress });
const { txHash } = await ng.sponsorTransfer({ transferTxB64: built.txB64, tokenType: built.terms.tokenType, amount: String(built.terms.amount) });
```

- `createUnshieldedWallet({ seedHex, networkId?, accountIndex?, indexerHttpUrl, indexerWsUrl, api?, walletState?, ttlMinutes? })` syncs only the seed's unshielded coins. `api` with a gateway key replaces the indexer URLs.
- The wallet returns `{ address, nightTokenType, sync, balances, coins, pending, buildTransfer, revert, serializeState, close }`.
- `buildTransfer({ amount, to, tokenType?, bind? })` returns the record of the shielded `buildTransfer`. `to` is an unshielded address (`mn_addr_...`). `tokenType` defaults to NIGHT.
- The wallet signs the transfer with the seed's key. The sponsor pays the fee, so the wallet needs no DUST.
- The recipient gets one coin, the wallet its change. A transfer to the wallet's own address is refused.
- Await `sync()` before the first `buildTransfer`. It resolves once the wallet caught up and reads the chain at ledger 9. Before that `buildTransfer` refuses.
- The wallet asks the indexer for its newest block before it starts. An indexer that does not answer fails `createUnshieldedWallet` with the reason it gave, for example `HTTP 410`, because the wallet SDK would wait on it without an error. `createSwapWallet` and a builder that syncs wallets do the same.
- An unshielded transfer shows type, amount and recipient. The server reads them from the transaction and refuses a `tokenType` or `amount` that differs. `readUnshieldedTransfer(tx)` reads them by the same rule.
- The receipt carries the recipient as `transfer.to` and `declared: false`.
- A built transfer is valid for `ttlMinutes`, default 30. `revert(input)` releases the coins of one that did not land, from its base64 or bytes.

### Offer files

- `encodeOffer(txOrBytes)` writes the text form, bech32m under the prefix `swapoffer`, with no length limit.
- `decodeOffer(text | base64 | bytes)` returns `{ tx, bound, bytes }`.
- `readSwapTerms(tx)` returns `{ gives, wants, inputs, outputs }`. It throws for anything but a plain swap half, by the rules the sponsor applies.
- `sameSwapTerms(terms, expect)` compares two sets of terms.

## Holder registry

`holderClaimKey(claimSecretHex)` is the `claim_key` a holder registers on the
`holder-registry` contract. The 32-byte secret stays with the holder.
`HOLDER_REGISTRY_CIRCUITS` lists the two circuits. A registration takes a coin
argument, so the builder needs `walletSync: 'shielded'`.

```js
const bytes = (hex) => new Uint8Array(Buffer.from(hex, 'hex'));
const claimSecret = randomBytes(32).toString('hex');            // keep it
const { finalizedTxB64 } = await builder.buildSponsorable({
    contractAddress: registryAddress,
    call: {
        circuitId: 'registerHolder',
        args: [{ nonce: new Uint8Array(randomBytes(32)), color: bytes(tokenType), value: 1n }, bytes(holderClaimKey(claimSecret))],
        witnesses: {}
    }
});
// after sponsorFinalized lands:
await ng.callAction('claimDisclosure', { payloadHash, tokenType, claimSecret });
```

## Token factory

A seed mints its own named tokens on a `token-factory` deployment.
`tokenFactoryIssuerSecret({ seedHex, accountIndex? })` is the issuer secret a
server session on the same seed gets. `tokenTypeOf` gives the type before
anything is built. A mint moves no coin of the builder, so `walletSync: false`
is enough. For a recipient other than the builder, list its keys under
`recipients`.

```js
import { createTxBuilder, tokenFactoryIssuerSecret, prepareMint, tokenTypeOf } from '@odatano/nightgate-tx/txbuilder';
import { pureCircuits } from '@odatano/contract-token-factory';

const issuerSecret = await tokenFactoryIssuerSecret({ seedHex });
const b = await createTxBuilder({ seedHex, api, package: '@odatano/contract-token-factory', walletSync: false });
const { type } = await tokenTypeOf(pureCircuits, { issuerSecret, name: 'CREDIT', contractAddress: factory });
const { unboundTxB64 } = await b.buildSponsorable({
    contractAddress: factory,
    call: prepareMint({ name: 'CREDIT', amount: 1000n, recipientCoinPublicKey: b.shieldedKeys.coinPublicKey, issuerSecret }),
    bind: false
});
```

The factory must be on the sponsor's contract list and `mint` on its circuit
list. `prepareBurn` and `tokenFactoryWitnesses` are exported too.

## The sponsor side

A NIGHTGATE server with a funded, dust-registered wallet session runs it.

- `sponsorFinalizedTransaction(finalizedTxB64, idempotencyKey?)` checks the contract and circuit allow-list, pays dust from the sponsor pool and submits.
- `sponsorUnboundTransaction(unboundTxB64, idempotencyKey?)` pays from a locked dust backing. Parallel capacity is the number of NIGHT UTxOs registered for dust generation.
- The policy is described under [cross-server fee sponsoring](actions.md#cross-server-fee-sponsoring).

`npm run txbuilder:e2e` runs the real split.

## Costs and caveats

- The first run downloads the prover keys and caches them. Restrict `circuits` to the calls you make.
- Ledger assembly, wallet sync and wasm proving all run on the calling thread. In a server, host the builder in a `worker_threads` worker.
- `provingMode: 'server'` proves several times faster. Start a proof server with `docker run -d -p 6300:6300 midnightntwrk/proof-server:<version> midnight-proof-server`. It receives the witnesses, so never use the sponsor's.
- After wasm proving the wallet SDK keeps a 10 minute timer per proof. A script calls `process.exit()` after `close()` to end at once.
- Proving memory follows the circuit's k, about 1.8 GB RSS at k=17 and 3.5 GB at k=18. Wasm memory never shrinks and `--max-old-space-size` does not bound it. `Zkir.deserialize(bzkir).getK()` from `@midnightntwrk/zkir-v2` reads k.
- The TTL is real. After `ttlMinutes` the node rejects the transaction.
- Fetch `zkConfigBaseUrl` from the sponsor that serves the vault you target, so the artifact generation matches.
- Content roots, schema ids, set roots and claim keys use the circuit's `transientHash`, which may change with a compiler generation. `payloadHash` is stable. Keep the `opening` of every anchored document, so you can re-anchor on a redeployed vault.

## Self-funded submission

A caller that pays its own dust submits to the node with the helpers of
`/txbuilder`. `submitFinalized` needs the optional peer dependency
`@polkadot/api`. `facade` and `configuration` below are your own wallet SDK
facade and its resolved configuration. `sealTx` wraps a ledger transaction
into the SDK's sealed handle, and `openTx` reads one back.

```js
import { deserializeTransaction, txIdentifiers, submitFinalized, waitLanded, sealTx, openTx } from '@odatano/nightgate-tx/txbuilder';

const built = await builder.buildSponsorable({ contractAddress, calls, witnesses });
const tx = await deserializeTransaction(built.finalizedTxB64);
const recipe = await facade.balanceFinalizedTransaction(
    await sealTx('Finalized', tx, configuration.forks),
    { ttl: new Date(Date.now() + 30 * 60_000), tokenKindsToBalance: ['dust'] }
);
const handle = await facade.finalizeRecipe(recipe);
const finalized = await openTx(handle);
const identifier = txIdentifiers(finalized).at(-1);
await submitFinalized(finalized, { nodeUrl });
const landed = await waitLanded(identifier, { indexerHttpUrl, timeoutMs: 240_000, pollMs: 6_000 });
```

[`example/self-funded.mjs`](../packages/nightgate-tx/example/self-funded.mjs)
runs the full flow with the resend loop the rules below describe.

- `submitFinalized` submits over a one-shot WebSocket. The node's HTTP gateway refuses bodies over about 14 KB. `submitExtrinsic` sends an encoded extrinsic.
- `classifyNodeReject(err)` returns `{ kind, subCode }`.
  - `stale-dust-proof` (170, 171, 196): re-sync dust and rebuild. The wallet is not out of dust.
  - `funds` (138, 173): out of dust.
  - `sequencing` (188, 219 to 224): send the calls as separate transactions.
  - `malformed` (117): neither waiting nor a rebuild helps.
  - `stale-transcript` (104): rebuild against current state, for example `rebuildOnStaleTranscript(async () => sponsor(await builder.buildSponsorable(...)))`.
- `isPreMempoolReject(err)` is true for 1010, 1014 and 1016. No fee was spent, but the fee's coins stay reserved until `facade.revertTransaction(handle)`.
- `isTransportFailure(err)` means the transaction may be in the mempool. Probe, then resend the same bytes. A rebuild can land a second transaction.
- `isAlreadyImported(err)` (1013) on a resend means the first send is in the pool. Any other refused resend may mean it landed, so run a bounded `waitLanded` before you revert.
- `probeLanded(identifier, opts)` and `waitLanded(identifier, opts)` ask an indexer (`indexerHttpUrl`) or a NIGHTGATE server (`api`). Confirm by identifier, never by the contract address. `applied: false` means in a block, call failed, fee spent.
