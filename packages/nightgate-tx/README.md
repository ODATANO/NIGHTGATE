# @odatano/nightgate-tx

[![npm](https://img.shields.io/npm/v/@odatano/nightgate-tx)](https://www.npmjs.com/package/@odatano/nightgate-tx)
[![npm downloads](https://img.shields.io/npm/dt/@odatano/nightgate-tx?logo=npm&label=downloads&color=blue)](https://www.npmjs.com/package/@odatano/nightgate-tx)
[![License](https://img.shields.io/badge/license-Apache--2.0-yellow)](LICENSE)

The NIGHTGATE client SDK. `connect()` calls a hosted NIGHTGATE.
`createTxBuilder()` builds, proves and signs Midnight transactions on your own
machine with your own key, and a sponsor pays the fee. No server, database,
proof server or Docker of your own.

```bash
npm install @odatano/nightgate-tx
```

## Build locally, let a sponsor pay

```js
import { connect, createTxBuilder } from '@odatano/nightgate-tx';
import { prepareAttest } from '@odatano/nightgate-tx/calls';
import { Contract } from '@odatano/nightgate-tx/attestation-vault-32';

const api = { baseUrl: 'https://gateway.example', token: 'oda_...' };
const builder = await createTxBuilder({
    seedHex,                        // 128 hex chars, a 64-byte seed that never leaves the process
    networkId: 'mainnet',
    api,                            // reads the chain through the server
    walletSync: false,              // vault calls move no value
    zkConfigBaseUrl: 'https://gateway.example/zk-config/attestation-vault-32',
    contractClass: Contract,
    contractName: 'attestation-vault-32'
});

const call = prepareAttest({ payloadHash, metadataHash, attestationSecret: builder.attestationSecret });
const { unboundTxB64 } = await builder.buildSponsorable({ contractAddress: VAULT, call, bind: false });
const job = await connect(api).sponsorUnbound({ unboundTxB64, idempotencyKey: `anchor-${payloadHash}` });
await builder.close();
// job.txHash is the ledger identifier, job.transactionHash the hash explorers show
```

- With `api`, the server's crawler must run. Every build pins its newest indexed block.
- The on-chain attestation carries your attester id. The sponsor never sees a key, witness or preimage.
- Create a seed with `node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"`.
- Runnable version: [`example/anchor.mjs`](./example/anchor.mjs). Guide: [api.preview.odatano.dev/quickstart](https://api.preview.odatano.dev/quickstart).

## Call a hosted NIGHTGATE

```js
import { connect } from '@odatano/nightgate-tx';

const verify = connect({ baseUrl: 'https://gateway.example', servicePath: '/odata/v4/midnight-verify' });
const state = await verify.verifyAttestation({ contractAddress, attesterId, payloadHash, compiledArtifactRef: 'attestation-vault-32' });

const ng = connect({ baseUrl: 'https://gateway.example', token: 'oda_...' });
const proof = await ng.prepareDocumentProof({ document: doc, proofFields: [{ field: 'battery.capacity_kwh' }] });
```

- One method per server action, such as `anchorDocument`, `proveFieldPredicate`, `grantDisclosure`, `sendNight`, `sponsorSwap` and `sponsorTransfer`. `callFunction` and `callAction` reach any other.
- Write actions submit the job and wait for its result. They long-poll `getJobStatus`. `longPollMs: 0` polls instead.
- Auth is one of `agentToken` (`ngat_...`, sent as `x-agent-token`), `token` (Bearer) or `username` with `password` (Basic). The public verify route needs none.
- A refused call throws `NightgateApiError` with `status`, `code` and, on 429 and retryable 503, `retryAfterSeconds`. `isRetryable(err)` says whether to repeat it.

## What else the builder does

The reference is [`docs/txbuilder.md`](https://github.com/ODATANO/NIGHTGATE/blob/main/docs/txbuilder.md).

- [Batches](https://github.com/ODATANO/NIGHTGATE/blob/main/docs/txbuilder.md#batches): up to 8 calls in one transaction with one fee.
- [Shielded swaps](https://github.com/ODATANO/NIGHTGATE/blob/main/docs/txbuilder.md#shielded-swaps): `createSwapWallet`, offer files and sponsored transfers.
- [Unshielded transfers](https://github.com/ODATANO/NIGHTGATE/blob/main/docs/txbuilder.md#unshielded-transfers): `createUnshieldedWallet` pays NIGHT to an address, a sponsor pays the fee.
- [Token factory](https://github.com/ODATANO/NIGHTGATE/blob/main/docs/txbuilder.md#token-factory): mint named tokens from your own seed.
- [Holder registry](https://github.com/ODATANO/NIGHTGATE/blob/main/docs/txbuilder.md#holder-registry): register a token holding with `holderClaimKey`.
- Your own contract: `createTxBuilder({ package: '@odatano/contract-<name>' })` or `{ contractClass, zkConfigDir }`. `buildDeploySponsorable()` builds a sponsored deploy.
- [Contracts deployed before ledger 9](https://github.com/ODATANO/NIGHTGATE/blob/main/docs/txbuilder.md#contracts-deployed-before-ledger-9): build with the contract package tagged `ledger8`.
- `ng.waitForReceipt({ jobId, sessionId })` waits for the receipt of a sponsored transfer or swap.
- [Self-funded submission](https://github.com/ODATANO/NIGHTGATE/blob/main/docs/txbuilder.md#self-funded-submission): pay your own dust and submit to the node. Runnable: [`example/self-funded.mjs`](./example/self-funded.mjs).
- `deriveIdentity({ seedHex })` returns the attester id and addresses without a builder.

## Entry points

| import | contents |
| --- | --- |
| `@odatano/nightgate-tx` | `connect` and `createTxBuilder` |
| `@odatano/nightgate-tx/client` | the hosted-endpoint client alone |
| `@odatano/nightgate-tx/txbuilder` | the builder, the swap wallet, offer files, holder and token-factory helpers, submission helpers |
| `@odatano/nightgate-tx/calls` | the `prepare*` call builders, witnesses, attestation-secret helpers |
| `@odatano/nightgate-tx/attestation-vault` | the 16-slot vault's contract class and pure circuits |
| `@odatano/nightgate-tx/attestation-vault-32` | the 32-slot vault. Pass `slotWidth: 32` to the `prepare*` helpers |
| `@odatano/nightgate-tx/set-root` | the canonical membership-set rule |

## Caveats

- The builder runs on the calling thread. In a server, host it in a `worker_threads` worker, pass `walletSync: false` for value-free calls and always `close()` it.
- The first build downloads the prover keys from the host's `/zk-config` and caches them under `~/.cache/nightgate-txbuilder`. `circuits: ['attest']` fetches only what you call.
- Fetch prover keys from the host you submit to. It pins the artifact generation to the deployed contract.
- Wasm proving blocks the thread for tens of seconds to minutes per proof. Memory follows the circuit's k, about 1.8 GB RSS at k=17 and 3.5 GB at k=18.
- `provingMode: 'server'` proves on a proof server you run. It receives the witnesses and sees the coins you spend.
- Built transactions expire after `ttlMinutes`, default 30.
- Ledger 9 networks only. Pins midnight-js 5.0.0, compact-js 3.0.0, compact-runtime 0.21.0 and ledger-v9 1.0.0, with no `overrides` needed. Two copies of a wasm package reject each other's objects (`expected instance of ...`). Check with `npm ls @midnightntwrk/ledger-v9` that the tree holds one.

## Related

Generated from the [`@odatano/nightgate`](https://www.npmjs.com/package/@odatano/nightgate)
tree, so call builders and witnesses are the code the server runs. Install the
full plugin for the indexer, OData services and sponsor side. For MCP clients:
[`@odatano/nightgate-mcp`](https://github.com/ODATANO/NIGHTGATE-MCP).

Apache-2.0
