# @odatano/nightgate-tx

[![npm](https://img.shields.io/npm/v/@odatano/nightgate-tx)](https://www.npmjs.com/package/@odatano/nightgate-tx)
[![npm downloads](https://img.shields.io/npm/dt/@odatano/nightgate-tx?logo=npm&label=downloads&color=blue)](https://www.npmjs.com/package/@odatano/nightgate-tx)
[![License](https://img.shields.io/badge/license-Apache--2.0-yellow)](LICENSE)

The NIGHTGATE client SDK: the hosted NIGHTGATE surface as functions, plus a
builder that proves and signs transactions **on your own machine with your
own key**. Under 1 MB; no server, database, proof server or Docker of your own.

```js
import { connect } from '@odatano/nightgate-tx';

// the public verify route: no wallet, no key, no auth
const ng = connect({ baseUrl: 'https://api.preprod.odatano.dev', servicePath: '/odata/v4/midnight-verify' });
const state = await ng.verifyAttestation({ contractAddress, attesterId, payloadHash, compiledArtifactRef: 'attestation-vault-32' });
```

## The two halves

**`connect()`** talks to a hosted NIGHTGATE. One method per capability; write
actions submit the job AND wait for the result, so one call returns the
`txHash`:

```js
const ng = connect({
    baseUrl: 'https://api.preprod.odatano.dev',
    token: 'oda_...'                  // or agentToken: 'ngat_...', or username and password
});

const proof = await ng.prepareDocumentProof({
    document: doc,
    proofFields: [{ field: 'battery.capacity_kwh' }]
});
await ng.anchorDocument({ sha256, storageRef, sessionId, contractAddress });
await ng.proveFieldPredicate({
    payloadHash: proof.payloadHash, fieldKey, value, fieldSalt,
    predicate: 'lessOrEqual', threshold, sessionId, contractAddress
});
```

Covered: `verifyAttestation`, `verifyPredicate`, `verifyPredicateAttestation`,
`verifyDocument`, `prepareDocumentProof`, `prepareMembershipSet`,
`anchorDocument`,
`attestAgentOutput`, `proveFieldPredicate`, `proveFieldEquality`,
`proveFieldMembership`, `proveFieldPredicatesBatch`, `proveDocumentIntegrity`,
`proveDocumentDiff`, `grantDisclosure`, `revokeDisclosure`, `registerDocument`, `retractAttestation`, `purgeExpired`,
wallet sessions, `deployContract`, `submitContractCall[Batch]`,
`mintShieldedTestToken`, `deriveTokenType`, `sendNight`, `sponsorFinalized`,
`sponsorUnbound`, `buildSponsorable`, `waitForJob`, and `callFunction`/`callAction`
as escape hatches for anything new.

**`createTxBuilder()`** builds, proves (in-process wasm) and signs locally; seed
and attestation secret never leave your machine. The ~5 KB result goes to the
sponsor:

```js
import { connect, createTxBuilder } from '@odatano/nightgate-tx';
import { prepareAttest } from '@odatano/nightgate-tx/calls';
import { Contract } from '@odatano/nightgate-tx/attestation-vault-32';

const api = { baseUrl: 'https://api.preprod.odatano.dev', token: 'oda_...' };
const builder = await createTxBuilder({
    seedHex,                                   // 128 hex chars, a 64-byte seed; yours, never sent anywhere
    networkId: 'preprod',
    api,                                       // reads the chain through the API; or indexerHttpUrl, indexerWsUrl, nodeUrl
    walletSync: false,
    zkConfigBaseUrl: 'https://api.preprod.odatano.dev/zk-config/attestation-vault-32',
    contractClass: Contract,
    contractName: 'attestation-vault-32'
});

const call = prepareAttest({ payloadHash, metadataHash, attestationSecret: builder.attestationSecret });
const { unboundTxB64 } = await builder.buildSponsorable({ contractAddress: VAULT, call, bind: false });

const job = await connect(api).sponsorUnbound({ unboundTxB64, idempotencyKey: `anchor-${payloadHash}` });
// job.txHash is the ledger identifier, job.transactionHash the hash explorers show (null until indexed)
```

A seed is 64 bytes, written as 128 hex characters:
`node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"`.
Write actions and `waitForJob` long-poll `getJobStatus` with `waitMs`, so one
call usually covers the wait; `longPollMs: 0` in `connect()` polls instead.
A step-by-step guide with a shared sandbox vault: [api.preprod.odatano.dev/quickstart](https://api.preprod.odatano.dev/quickstart).

The on-chain attestation carries **your** attester id; the sponsor pays the
dust and never sees a key, witness or preimage. Runnable version:
[`example/anchor.mjs`](./example/anchor.mjs).

Hosting the builder in a server: it runs on the awaiting thread (use a
`worker_threads` worker), and by default the wallet syncs from genesis for the
builder's life (a full core until tip). Vault calls move no value: pass
`walletSync: false` and always `await builder.close()`.
`deriveIdentity({ seedHex })` returns `attesterId` and the NIGHT address
without a builder. `provingMode: 'server'` proves on a proof server YOU run (it
receives the witnesses); `proofTimeoutMs` raises the 5 min per-request timeout.

## Batches

`buildSponsorable({ contractAddress, calls: [...] })` puts up to 8 calls into
ONE transaction (one fee). A causality pre-check aborts before proving
(`BatchCausalityViolation`, no fee, names the calls). For independent calls
(a proof cart: distinct claim keys) `independentCalls: true` orders them by
execution stage; `orderedPrefix: 1` keeps a leading in-batch anchor first.
Details: `docs/txbuilder.md` in the main repo.

## Parallel sponsoring

`buildSponsorable({ ..., bind: false })` returns `unboundTxB64` for
`ng.sponsorUnbound({ unboundTxB64 })`: one sponsor wallet
pays for many callers at once (one per registered dust backing). Same proof,
identity and TTL.

## Shielded swaps

Two wallets exchange shielded tokens without a contract; a sponsor pays the
fee. `createSwapWallet({ seedHex, indexerHttpUrl, indexerWsUrl })` syncs the
shielded coins only; with a gateway key, `createSwapWallet({ seedHex, api })`
syncs them through the gateway and needs no indexer. `buildHalf({ give, want })` returns one half of a swap and
its offer file (`swapoffer1...`); `takeOffer({ offer, expect })` reads the
offer's terms from the transaction, builds the mirror half and returns both for
`ng.sponsorSwap({ makerHalfB64, takerHalfB64 })`.
`serializeState()` / `walletState` resume a wallet without a sync from genesis;
`revert(offer)` frees the coins of a half that never landed, also after a
restart, and `pending()` lists what is still reserved.
A process that swaps and calls contracts on one seed runs one shielded wallet:
`createTxBuilder({ shieldedWallet: swap.shieldedWallet, walletSync: false })`
balances from the swap wallet's coins and neither starts nor stops it (one
sync, one state, one view of the spent coins). Details: `docs/txbuilder.md`
in the main repo.

A contract call that moves shielded value needs the same coins only:
`createTxBuilder({ ..., walletSync: 'shielded' })`. A call that creates a coin
for another wallet takes that wallet's keys as
`recipients: [{ coinPublicKey, encryptionPublicKey }]`. A sponsored call that
pays the wallet's own NIGHT into the contract needs the NIGHT coins too:
`walletSync: 'coins'` (shielded and unshielded, no dust; the dust history alone
takes hours). `onProgress` reports `{ phase: 'sync', wallet, appliedIndex,
highestIndex }` while a wallet syncs.

## Token factory

`tokenFactoryIssuerSecret({ seedHex })` is the issuer secret of a seed, by the
rule the server applies to a session on the same seed. `prepareMint({ name,
amount, recipientCoinPublicKey, issuerSecret })` is the call on a
`createTxBuilder({ package: '@odatano/contract-token-factory', walletSync: false })`
builder, `tokenTypeOf(pureCircuits, { issuerSecret, name, contractAddress })`
the type before the mint lands. The sponsor pays like for any call; the
factory has to be on its contract list.

## Your own contract, and sponsored deploys

`createTxBuilder({ contractClass, zkConfigDir })` reads your own `keys/` and
`zkir/` (nothing fetched; default `circuits` = those of the class;
`zkAssets.source` says where assets came from). `createTxBuilder({ package:
'@odatano/contract-<name>' })` takes class, name, private-state id and keys
from an installed lineage package and fetches its missing prover keys from the
package's release assets (`ensureZkAssets({ package })` alone warms them). Witnesses come from you: one
shared `witnesses` object, per-call `before` hooks swap what varies (single
calls run the same hook). `buildDeploySponsorable()` builds, proves and signs a
DEPLOY and returns the address it will create; a sponsor pays when the grant
has `allowDeploy` with budget left, and the landed address is sponsorable under
the same token.

## Self-funded submission

No sponsor: `/txbuilder` also exports the submission helpers.

```js
const tx = await deserializeTransaction(finalizedTxB64);
// balance the dust fee in your own wallet-sdk facade, then:
const identifier = txIdentifiers(finalized).at(-1);
await submitFinalized(finalized, { nodeUrl });
const landed = await waitLanded(identifier, { indexerHttpUrl, timeoutMs: 240_000 });
```

- `submitFinalized` / `submitExtrinsic`: submit over a one-shot WebSocket (the
  node's HTTP gateway rejects bodies over ~14 KB); needs the optional peer
  `@polkadot/api`.
- `probeLanded` / `waitLanded`: confirm by transaction identifier, against an
  indexer (`indexerHttpUrl`) or a NIGHTGATE server (`api`); `applied: false` =
  in a block, call failed, fee spent.
- `classifyNodeReject`: 170/171/196 stale dust proof (re-sync, rebuild; NOT out
  of dust), 138/173 funds, 219-224 sequencing (split the batch), 117 malformed,
  104 stale transcript (rebuild, `rebuildOnStaleTranscript`).
- `isTransportFailure` (probe, then resend the SAME bytes) and
  `isAlreadyImported` (1013: the first send is in the pool). Run `waitLanded`
  before trusting any refused resend.
- `withDustGuard`: snapshots the dust sub-wallet and restores it on a
  pre-mempool reject, which otherwise leaks the spent note. Never persist a
  post-reject dust state; one guarded build per facade at a time.

Full flow: [`example/self-funded.mjs`](./example/self-funded.mjs).

## Entry points

| Import | What you get |
| --- | --- |
| `@odatano/nightgate-tx` | `connect` + `createTxBuilder` (the whole SDK) |
| `@odatano/nightgate-tx/client` | the hosted-endpoint client alone |
| `@odatano/nightgate-tx/txbuilder` | the local builder, the swap wallet and offer files, the holder-registry claim key (`holderClaimKey`, `HOLDER_REGISTRY_CIRCUITS`), the self-funded submission helpers |
| `@odatano/nightgate-tx/calls` | the `prepare*` call builders, witnesses, attestation-secret helpers |
| `@odatano/nightgate-tx/attestation-vault` | the compiled contract class and its pure circuits |
| `@odatano/nightgate-tx/attestation-vault-32` | the 32-slot vault's contract class (pass `slotWidth: 32` to the `prepare*` helpers, `zkConfigBaseUrl` = `/zk-config/attestation-vault-32`) |
| `@odatano/nightgate-tx/set-root` | the canonical membership-set rule |

## Auth

`connect()` takes one of: `agentToken` (an `ngat_...` agent-grant token from
`createAgentGrant`, sent as `x-agent-token`; may be combined with Basic
transport credentials), `token` (Bearer), or `username`/`password` (Basic).
The verification reads need none.

## Costs and caveats

- **First build downloads the prover keys** (~83 MB for the vault set) from the
  host's `/zk-config`, cached under `~/.cache/nightgate-txbuilder/<contract>`.
  `circuits: ['attest']` fetches only what you call. `connect()` downloads
  nothing.
- **Local proving blocks the thread** for tens of seconds to minutes per proof.
- **Built transactions expire** (`ttlMinutes`, default 30).
- **Fetch prover keys from the host you submit to**: it pins the artifact
  generation to the deployed contract.
- **Proving memory follows the circuit's k**: ~1.8 GB RSS at k=17 (16-slot
  comparison circuit), ~3.5 GB at k=18 (32-slot); wasm memory never shrinks and
  `--max-old-space-size` does not bound it. See `docs/txbuilder.md`.
- **Match the Midnight line.** Pins midnight-js 4.1.1, compact-js 2.5.1,
  ledger-v8 8.1.0, compact-runtime 0.16.0 and zkir-v2 2.1.0 exactly. Two copies
  of a wasm-bearing package reject each other's objects (`expected instance of
  ContractMaintenanceAuthority` / `DustParameters` / `StateValue`). A fresh
  install resolves second copies of ledger-v8 and onchain-runtime-v3; pin both:
  `"overrides": { "@midnight-ntwrk/ledger-v8": "8.1.0", "@midnight-ntwrk/onchain-runtime-v3": "3.0.0" }`.
  Check: `find node_modules -type d -path '*@midnight-ntwrk/<pkg>'` shows one
  directory per package.

## Relationship to NIGHTGATE and the MCP server

Generated from the [`@odatano/nightgate`](https://www.npmjs.com/package/@odatano/nightgate)
tree: call builders and witnesses are the code the server runs. Install the full
plugin for the indexer, OData services and sponsor side. For MCP clients:
[`@odatano/nightgate-mcp`](https://github.com/ODATANO/NIGHTGATE-MCP).

Apache-2.0
