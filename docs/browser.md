# Contract calls from the browser (`@odatano/nightgate-tx/calls`)

`connectContract` runs calls, batches and deploys on one contract through a
connected wallet. The wallet balances the transaction, pays the fee and
submits it. The page holds no seed.

A NIGHTGATE server supplies the list of its contracts under
`/contract-manifest` and their proving files under `/zk-config`. It works for
every contract in that list.

In `@odatano/nightgate` the same export is `@odatano/nightgate/browser`.

## Use

```js
import { connectContract } from '@odatano/nightgate-tx/calls';
import { Contract } from './managed/counter/contract/index.js';

const connector = await window.midnight.mnLace.connect('preprod');
const counter = await connectContract({
    connector,
    contract: 'counter',            // its name in the manifest
    contractClass: Contract,
    manifestUrl: 'https://gateway.example/contract-manifest',
    contractAddress: COUNTER
});

const tx = await counter.call({ circuitId: 'increment' });
// { txHash, transactionHash, blockHeight, result }
```

## `connectContract(opts) -> ConnectedContract`

| option | required | meaning |
| --- | --- | --- |
| `connector` | yes | the connected wallet, as `window.midnight.<wallet>.connect(networkId)` returns it |
| `contract` | yes | the contract's name in the manifest |
| `contractClass` | yes | the compiled `Contract` class |
| `manifestUrl` | yes, unless `manifest` | the server's `/contract-manifest` |
| `manifest` | no | the parsed manifest, when the app fetched it already. Pass `manifestUrl` too when the app runs on another origin |
| `contractAddress` | yes, unless you deploy | the deployed contract |
| `witnesses` | no | the contract's witnesses. A call can bring its own |
| `privateStateId` | no | default `<contract>PrivateState` |
| `initialPrivateState` | no | default `{}` |
| `proving` | no | `'server'` (default), `'wallet'` or `'auto'` |
| `proofServerUrl` | no | a proof server for `'server'` and `'auto'`. Default: the one the wallet reports |
| `ttlMinutes` | no | default 30. The transaction expires after it |
| `expectedManifestHash` | no | SHA-256 of the compiler manifest under `/zk-config/<contract>`. Proving files from another build are refused |
| `fetchFn`, `webSocket` | no | replacements for `fetch` and `WebSocket` outside a browser |

The returned object has `contractAddress`, `networkId`, `provingModality` and
three methods.

| method | returns |
| --- | --- |
| `call(call)` | `{ txHash, transactionHash, blockHeight, result }` |
| `batch(calls, { witnesses?, independentCalls?, orderedPrefix? })` | `{ txHash, transactionHash, blockHeight }` |
| `deploy({ args?, witnesses?, initialPrivateState? })` | `{ txHash, transactionHash, blockHeight, contractAddress }` |

A call is `{ circuitId, args?, witnesses?, before? }`. The `prepare*` helpers
return this shape, so their result goes straight into `call()`:

```js
import { connectContract, prepareAttest } from '@odatano/nightgate-tx/calls';
import { Contract } from '@odatano/nightgate-tx/attestation-vault-32';

const vault = await connectContract({ connector, contract: 'attestation-vault-32', contractClass: Contract, manifestUrl, contractAddress: VAULT });
await vault.call(prepareAttest({ payloadHash, metadataHash, attestationSecret }));
```

`txHash` is the ledger identifier, `transactionHash` the hash explorers show,
as in the job results of the server. A result means the transaction applied
fully. One that lands without applying fully throws the `TxFailedError` of
midnight-js, with the fee spent.

## Proving

- `'server'` proves on a proof server. It receives the private inputs of the call.
- `'wallet'` proves inside the wallet. It throws when the wallet cannot prove, so private inputs never reach a server unasked.
- `'auto'` uses the wallet when it can prove and agrees to, else the proof server.

`provingModality` on the returned object says which one is in use. `connectContract` throws when nothing can prove: no `proofServerUrl`, a wallet that reports no proof server and does not prove itself.

## Batches

`batch(calls)` runs up to 8 calls in one transaction, with one fee. The calls
apply in array order.

- A contract takes its witnesses once. Pass one `witnesses` object to `batch()` and set what differs per call in each call's `before` hook. Calls that all carry the same `witnesses` object work too.
- A batch the ledger would refuse fails before proving. The error has `code: 'BatchCausalityViolation'` with `calls: [{ name, segId, stages }]` in apply order, or `code: 'BatchGasBudgetExceeded'`. Split the batch.
- `independentCalls: true` groups the calls after `orderedPrefix` by stage. The rules are those of the builder, see [Batches](txbuilder.md#batches).

For the attestation vault, `prepareVaultBatch` builds the shared witnesses and
the `before` hooks from prepared calls:

```js
import { prepareVaultBatch, prepareAttest, prepareAnchorContentRoot } from '@odatano/nightgate-tx/calls';

const { calls, witnesses } = prepareVaultBatch([
    prepareAttest({ payloadHash, metadataHash, attestationSecret }),
    prepareAnchorContentRoot({ payloadHash, contentRoot, schemaId, attestationSecret })
], { attestationSecret });
await vault.batch(calls, { witnesses });
```

`computeAttesterId(attestationSecret)` returns the attester id these calls
carry on chain, as hex.

## Deploy

```js
const counter = await connectContract({ connector, contract: 'counter', contractClass: Contract, manifestUrl });
const { contractAddress } = await counter.deploy();
await counter.call({ circuitId: 'increment' });
```

`deploy({ args })` takes the constructor arguments. Later calls of the same
object go to the new address.

## Caveats

- The wallet pays the fee from its own dust. No sponsor takes part.
- Private state is kept in memory and is gone after a reload.
- `createNightgateConnectorProviders` returns the midnight-js providers alone, for an app that drives midnight-js itself.
