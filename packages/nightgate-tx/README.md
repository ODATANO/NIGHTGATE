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

// document ingestion (compute-only, nothing anchored yet)
const proof = await ng.prepareDocumentProof({
    documentJson: JSON.stringify(doc),
    proofFieldsJson: JSON.stringify(['battery.capacity_kwh'])
});

// anchor + prove, each returns { txHash, ... } when the job settles
await ng.anchorDocument({ sha256, storageRef, sessionId, contractAddress });
await ng.proveFieldPredicate({
    payloadHash: proof.payloadHash, fieldKey, value, fieldSalt,
    predicate: 'lessOrEqual', threshold, sessionId, contractAddress
});

// anyone can check it later, crawler-free
await ng.verifyPredicate({ contractAddress, payloadHash, predicate: 'lessOrEqual', threshold });
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
and need no wallet state: pass `walletSync: false` (idle CPU 101 % -> 2 %,
same bytes, same proof), and always `await builder.close()` (it stops the
sync and the indexer sockets; before 0.4.1 it stopped nothing).
`deriveIdentity({ seedHex })` gives `attesterId` and the NIGHT address
without a builder, in ~150 ms.
With `provingMode: 'server'` (a proof server YOU run; it receives the
witnesses), `proofTimeoutMs` raises the SDK's 5 min timeout of one proof
request for circuits that prove longer (0.4.3).

Against a sponsor running NIGHTGATE 0.18 or later, prefer the parallel channel:
`buildSponsorable({ contractAddress: VAULT, call, bind: false })` returns
`unboundTxB64`, and `ng.sponsorUnbound({ unboundTxB64, sponsorSessionId })`
lets one sponsor wallet pay for many callers at once (one per registered dust
backing). Same proof, same identity, same TTL.

Since 0.3.0, `buildSponsorable({ contractAddress: VAULT, calls: [...] })`
batches up to 8 circuit calls into ONE transaction (one fee, one sponsoring),
with the same deterministic segment ordering and pre-proving causality
fail-fast as the server lane (`BatchCausalityViolation` aborts locally, no fee
spent). The durable batch shape on a grown contract is the proof cart (anchor
first, then proofs); see `docs/txbuilder.md` in the main repo.

Since 0.4.2, `buildSponsorable({ calls, independentCalls: true })` groups a
batch of independent calls (a proof cart: distinct claim keys) by execution
stage before proving, guaranteed-only first, so the cart stays causality-valid
on a grown vault where call order alone is refused about every second time;
`orderedPrefix: 1` keeps a leading in-batch anchor in front. A refusal now
carries `calls: [{ name, segId, stages }]` next to `code`.

Since 0.4.0 (sponsor running NIGHTGATE 0.21 or later), the builder works for
YOUR contract, not only the vault: `createTxBuilder({ contractClass, zkConfigDir })`
reads your own `keys/` and `zkir/` (nothing is fetched; the default
`circuits` are those of the class you hand in), `buildSponsorable({ calls,
witnesses })` batches calls on any contract under one shared witnesses object
(per-call `before` hooks swap what varies), and `buildDeploySponsorable()`
builds, proves and signs a contract DEPLOY with your key and names the
address it will create; a sponsor pays the dust when its grant carries
`allowDeploy` with budget left, and the landed address is sponsorable under
the same token at once. `zkAssets.source` says whether the assets came from a
`/zk-config` or your directory.

## Entry points

| Import | What you get |
| --- | --- |
| `@odatano/nightgate-tx` | `connect` + `createTxBuilder` (the whole SDK) |
| `@odatano/nightgate-tx/client` | the hosted-endpoint client alone |
| `@odatano/nightgate-tx/txbuilder` | the local builder alone |
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
