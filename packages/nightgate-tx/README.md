# @odatano/nightgate-tx

The NIGHTGATE client SDK: everything a hosted NIGHTGATE can do, as functions.
Verify ZK attestations, ingest documents, prove field predicates, manage
disclosure, sponsor fees, and build transactions **on your own machine with
your own key**.

Under 1 MB. No server of your own, no database, no proof server, no Docker.

```js
import { connect } from '@odatano/nightgate-tx';

const ng = connect({ baseUrl: 'https://nightgate.example' });

// verification is a plain read: no wallet, no key, no auth
const state = await ng.verifyAttestation({ contractAddress, payloadHash });
```

## The two halves

**`connect()`** talks to a hosted NIGHTGATE. One method per capability; write
actions submit the job AND wait for the result, so one call returns the
`txHash`:

```js
const ng = connect({
    baseUrl: 'https://nightgate.example',
    agentToken: 'ngat_...'            // or token: / username: + password:
});

const proof = await ng.prepareDocumentProof({
    documentJson: JSON.stringify(doc),
    proofFieldsJson: JSON.stringify(['battery.capacity_kwh'])
});
await ng.anchorDocument({ sha256, storageRef, sessionId, contractAddress });
await ng.proveFieldPredicate({
    payloadHash: proof.payloadHash, fieldKey, value, fieldSalt,
    predicate: 'lessOrEqual', threshold, sessionId, contractAddress
});
```

Covered: `verifyAttestation`, `verifyPredicate`, `verifyPredicateAttestation`,
`verifyDocument`, `prepareDocumentProof`, `prepareMembershipSet`,
`prepareAnchorCommitment`, `anchorDocument`, `commitDocumentAnchor`,
`attestAgentOutput`, `proveFieldPredicate`, `proveFieldEquality`,
`proveFieldMembership`, `proveFieldPredicatesBatch`, `proveDocumentIntegrity`,
`proveDocumentDiff`, `grantDisclosure`, `revokeDisclosure`, `registerPassport`,
wallet sessions, `deployContract`, `submitContractCall[Batch]`,
`mintShieldedTestToken`, `deriveTokenType`, `sendNight`, `sponsorFinalized`,
`sponsorUnbound`, `buildSponsorable`, `waitForJob`, and `callFunction`/`callAction`
as escape hatches for anything new.

**`createTxBuilder()`** is the part no hosted API can give you: build, prove
(in-process wasm) and sign a transaction locally, so your seed and your
attestation secret never leave your machine, then hand the ~5 KB result to the
sponsor:

```js
import { connect, createTxBuilder } from '@odatano/nightgate-tx';
import { prepareAttest } from '@odatano/nightgate-tx/calls';
import { Contract } from '@odatano/nightgate-tx/attestation-vault';

const builder = await createTxBuilder({
    seedHex,                                   // yours; never sent anywhere
    networkId: 'preprod',
    indexerHttpUrl: 'https://indexer.preprod.midnight.network/api/v4/graphql',
    indexerWsUrl:   'wss://indexer.preprod.midnight.network/api/v4/graphql/ws',
    nodeUrl:        'wss://rpc.preprod.midnight.network/',
    zkConfigBaseUrl: 'https://nightgate.example/zk-config/attestation-vault',
    contractClass: Contract
});

const call = prepareAttest({ payloadHash, metadataHash, attestationSecret: builder.attestationSecret });
const { finalizedTxB64 } = await builder.buildSponsorable({ contractAddress: VAULT, call });

const ng = connect({ baseUrl: 'https://nightgate.example' });
const { txHash } = await ng.sponsorFinalized({ finalizedTxB64, sponsorSessionId });
```

The on-chain attestation carries **your** attester id; the sponsor pays the
dust and never sees a key, a witness or a preimage. A complete runnable version
is in [`example/anchor.mjs`](./example/anchor.mjs).

Two things to know before hosting the builder in a server: everything it does
runs on the thread that awaits it (put it in a `worker_threads` worker), and
by default the wallet syncs from genesis in the background for the life of
the builder, a full core until it reaches the tip. Vault calls move no value
and need no wallet state: pass `walletSync: false`, and always
`await builder.close()` to stop the sync and the indexer sockets.
`deriveIdentity({ seedHex })` gives `attesterId` and the NIGHT address
without a builder, in ~150 ms. With `provingMode: 'server'` (a proof server
YOU run; it receives the witnesses), `proofTimeoutMs` raises the SDK's 5 min
timeout of one proof request for circuits that prove longer.

## Batches

`buildSponsorable({ contractAddress, calls: [...] })` puts up to 8 circuit
calls into ONE transaction (one fee, one sponsoring), with deterministic
segment ordering and a causality pre-check that aborts BEFORE proving
(`BatchCausalityViolation`, no fee spent, the refusal names the calls). For a
batch of independent calls (a proof cart: distinct claim keys),
`independentCalls: true` groups them by execution stage so the cart stays
valid on a grown contract where plain call order is refused;
`orderedPrefix: 1` keeps a leading in-batch anchor in front. The durable
batch shape on a grown contract is the proof cart (anchor first, then
proofs); see `docs/txbuilder.md` in the main repo.

## Parallel sponsoring

`buildSponsorable({ ..., bind: false })` returns `unboundTxB64` for
`ng.sponsorUnbound({ unboundTxB64, sponsorSessionId })`: one sponsor wallet
pays for many callers at once (one per registered dust backing). Same proof,
same identity, same TTL. Needs a sponsor on NIGHTGATE 0.18 or later.

## Your own contract, and sponsored deploys

The builder is not tied to the attestation vault.
`createTxBuilder({ contractClass, zkConfigDir })` reads your own `keys/` and
`zkir/` (nothing is fetched; the default `circuits` are those of the class
you hand in). Witnesses come from you: on a single call or on the batch as
ONE shared `witnesses` object, with per-call `before` hooks swapping what
varies (single calls and batch entries run their hook the same way, so a
batch split into single-call transactions keeps its per-call state).
`buildDeploySponsorable()` builds, proves and signs a contract DEPLOY with
your key and names the address it will create; a sponsor pays the dust when
its grant carries `allowDeploy` with budget left, and the landed address is
sponsorable under the same token at once. Needs a sponsor on NIGHTGATE 0.21
or later; `zkAssets.source` says whether the assets came from a `/zk-config`
or your directory.

## Self-funded submission

For callers that pay their own dust and submit to the node themselves, with
no sponsor at all, `/txbuilder` also exports the submission lane:

```js
const tx = await deserializeTransaction(finalizedTxB64);
// balance the dust fee in your own wallet-sdk facade, then:
const identifier = txIdentifiers(finalized).at(-1);
await submitFinalized(finalized, { nodeUrl });
const landed = await waitLanded(identifier, { indexerHttpUrl, timeoutMs: 240_000 });
```

- `submitFinalized` / `submitExtrinsic` encode the extrinsic over HTTP (needs
  `@polkadot/api`, an optional peer dependency) and submit over a one-shot
  WebSocket: the node's HTTP gateway rejects bodies over ~14 KB.
- `probeLanded` / `waitLanded` confirm by transaction identifier, never by
  watching the contract address; `applied: false` means in a block but the
  call failed (fee spent, rebuild).
- `classifyNodeReject` reads the ledger sub-code: 170/171/196 stale dust
  proof (re-sync and rebuild, the wallet is NOT out of dust), 138/173 funds,
  219-224 sequencing (split the batch), 117 malformed.
- `isTransportFailure` (lost reply: probe, then resend the SAME bytes) and
  `isAlreadyImported` (1013 after a resend: the first send reached the pool,
  confirm instead of failing). Run `waitLanded` before trusting ANY refusal
  of a resend; the first send may have landed while the indexer lags.
- `withDustGuard` snapshots the dust sub-wallet before a build and restores
  it on a pre-mempool reject, which otherwise leaks the spent dust note until
  the wallet cannot balance. Never persist a post-reject dust state, and run
  one guarded build per facade at a time.

The complete flow, wallet facade and retry loop included, is
[`example/self-funded.mjs`](./example/self-funded.mjs).

## Entry points

| Import | What you get |
| --- | --- |
| `@odatano/nightgate-tx` | `connect` + `createTxBuilder` (the whole SDK) |
| `@odatano/nightgate-tx/client` | the hosted-endpoint client alone |
| `@odatano/nightgate-tx/txbuilder` | the local builder + the self-funded submission helpers |
| `@odatano/nightgate-tx/calls` | 13 `prepare*` call builders, witnesses, attestation-secret helpers |
| `@odatano/nightgate-tx/attestation-vault` | the compiled contract class and its pure circuits |
| `@odatano/nightgate-tx/attestation-vault-32` | the 32-slot width variant's contract class (panels of 17-32 fields; pass `slotWidth: 32` to the `prepare*` helpers and point `zkConfigBaseUrl` at `/zk-config/attestation-vault-32`) |
| `@odatano/nightgate-tx/set-root` | the canonical membership-set rule |

## Auth

`connect()` takes one of: `agentToken` (an `ngat_...` agent-grant token from
`createAgentGrant`, sent as `x-agent-token`; may be combined with Basic
transport credentials), `token` (Bearer), or `username`/`password` (Basic).
The verification reads need none.

## Costs and caveats

- **The local builder's first run downloads the prover keys** (~78 MB for the
  full vault set) from the host's `/zk-config` and caches them under
  `~/.cache/nightgate-txbuilder/<contract>`. Pass `circuits: ['attest']` to
  fetch only what you call. Later runs are offline; `connect()` alone never
  downloads anything.
- **Local proving blocks the thread** for tens of seconds; run it off your
  request path.
- **Locally built transactions expire** (`ttlMinutes`, default 30); hand them
  to the sponsor promptly.
- **Fetch prover keys from the host you submit to**: that pins the artifact
  generation to the actually deployed contract.

## Relationship to NIGHTGATE and the MCP server

This package is generated from the [`@odatano/nightgate`](https://www.npmjs.com/package/@odatano/nightgate)
tree, so the call builders and witnesses are the same code the server runs.
Install the full plugin if you also want the indexer, the OData services, the
crawler and the sponsor side. If your consumer is an AI agent speaking MCP
rather than JavaScript, use
[`@odatano/nightgate-mcp`](https://github.com/ODATANO/NIGHTGATE-MCP): same
capabilities as tools.

Apache-2.0
