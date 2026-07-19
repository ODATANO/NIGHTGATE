# Changelog

## 0.8.3 - 2026-07-19

### Fix: background-job status writes retried under write contention

The tiny `mark*` status UPDATEs in the job runner had no protection against
SQLite write-lock loss. Observed live under two parallel sponsored runs: a
job's failure write AND its `markFailed` fallback both hit 'database is
locked', the row stayed non-terminal, and the consumer's poller only gave up
at its own watchdog timeout ten minutes later. Now:

1. `markRunning` / `markSucceeded` / `markFailed` and the
   `recoverInterruptedJobs` sweep retry bounded (3 attempts, backoff) on
   `database is locked` / SQLITE_BUSY. Only the status write is retried,
   never the job work itself (no double-submit risk).
2. If `markSucceeded` still cannot land, the job is closed as
   `failed:RESULT_PERSIST_FAILED` with an explicit "on-chain effects may
   exist" message instead of stranding pollers on a forever-'running' row.
3. If even `markFailed` exhausts its retries, it logs the unpersisted
   classification at error level (jobId + code + message) and returns; the
   row is swept by restart recovery.

## 0.8.2 - 2026-07-19

### Fix: wallet-state persist sink hardened against write contention

With many concurrently active facades (sponsor pools, parallel consumer
runs) the periodic state saves kept losing the SQLite write lock to foreign
commit traffic and failed on every tick ('database is locked' storms, up to
pool starvation). `saveSyncState` now serializes ALL persists through one
global in-process chain (across accounts; the CPU-heavy PBKDF2/AES stays
outside it) and retries the short DB section bounded (3 attempts, backoff)
on write contention. Measured with a consumer's 3-way parallel sponsored
runs: zero persist failures, all runs green.

## 0.8.1 - 2026-07-19

### Sponsored submissions: instant callers

Two changes that let a sponsored caller wallet submit within seconds instead
of waiting out a full chain sync:

1. **`NIGHTGATE_SPONSORED_CALLER_SYNC=skip`** bypasses the CALLER's
   genuine-sync wait in the two-phase sponsored balancing. The caller only
   balances shielded/unshielded; a wallet that provably holds nothing (e.g. a
   public demo minting fresh identity wallets) has nothing to select, so the
   wait buys nothing. Default stays `genuine` (safe for callers that hold
   coins). The SPONSOR's sync is unconditional: it spends the dust.
2. **Submission jobs ensure the caller facade on demand.** WalletMaterial
   gains `ensureFacade()` (idempotent worker init, same call the
   connectWalletForSigning prewarm makes); every submission handler invokes
   it before dispatching. A session that was never prewarmed, or whose
   facade was evicted, no longer fails with "No facade for sessionId".
3. **`connectWalletForSigning(prewarm: false)`** skips scheduling the
   sync-to-tip prewarm job entirely. Pair it with the env skip above:
   without it, the background prewarm sync races the submission's on-demand
   facade init on the same account (observed live as an SQLITE_BUSY storm).

## 0.8.0 - 2026-07-18

### Feature: per-transaction fee sponsoring (`sponsorSessionId`)

A new optional `sponsorSessionId` parameter on the submission
actions lets a SECOND wallet session pay the dust fee for a transaction the
calling session builds and signs. The calling wallet needs neither NIGHT nor
dust, ever.

Actions: `deployContract`, `submitContractCall`, `anchorDocument`,
`issuePredicateAttestation`, `issueFieldPredicateAttestation`,
`grantDisclosure`, `revokeDisclosure`, and `deregisterFromDustGeneration`

Mechanics (wallet worker, two-phase balancing per the SDK contract):

1. Caller facade: `balanceUnboundTransaction` with `tokenKindsToBalance:
   ['shielded','unshielded']`, `signRecipe` for any unshielded inputs,
   `finalizeRecipe`. Result: a fully signed, fee-unpaid transaction.
2. Sponsor facade: `balanceFinalizedTransaction` with `tokenKindsToBalance:
   ['dust']` ONLY (re-balancing the caller's kinds would double-spend),
   `finalizeRecipe`, and the SPONSOR submits. Both phases share one TTL.
   The sponsor wallet is genuine-synced before balancing dust (117 guard).

Authorization guard: a caller may sponsor from its OWN sessions; cross-user
sponsoring requires the operator to list the sponsor session id(s) in
`NIGHTGATE_FEE_SPONSOR_SESSION` (comma separated) or cds config
`feeSponsorSessions`. Foreign non-listed session ids read back as 404.
The sponsor session must be signing-capable (`connectWalletForSigning`).
Job request and result carry `feeSponsor` for audit; worker logs name the
sponsor on every sponsored dispatch.

## 0.7.3 - 2026-07-18

### Feature: `deriveWalletInfo` returns the wallet's DUST address

New `dustAddress` field (`mn_dust_<network>...`) on the derivation result,
computed facade-free from the dust role seed
(`DustSecretKey.fromSeed(...).publicKey` + `DustAddress.encodePublicKey`).
This is the missing input for dust GENERATION DELEGATION (fee sponsoring):
register a funded wallet's NIGHT with another wallet's `dustAddress` as
`dustReceiverAddress` on `registerForDustGeneration`, and that wallet accrues
the dust and pays its own fees while holding zero NIGHT. Proven live on
preview: a zero-NIGHT wallet anchored a full attestation flow from sponsored
dust.

### Fix: `deregisterFromDustGeneration` works again (two bugs)

1. The worker read the full coin set from `synced.unshielded.allCoins`, which
   the current wallet SDK renamed to `totalCoins`; deregistration silently
   reported 0/0 with registered UTXOs present. Now
   `totalCoins ?? allCoins ?? coins`.
2. The SDK's deregistration recipe is fee-less by design (`allowFeePayment`
   0, no dust spends) and expects the CALLER to balance the fee via
   `balanceUnprovenTransaction(tx, keys, { ttl, tokenKindsToBalance:
   ['dust'] })`; submitting unbalanced is rejected by the node with
   `1010 Custom error: 138` (BalanceCheckOverspend). The worker now balances
   before finalizing. Note: the recipe is already fully signed; re-signing
   after balancing duplicates the offer signatures (`1010/192`), so it is
   balance -> finalize -> submit.

Receiver rotation (deregister, then register with a new
`dustReceiverAddress`) is thereby possible and live-verified. Inherent limit:
a wallet whose entire generation is delegated away has no dust to pay its own
deregistration fee.


## 0.7.2 - 2026-07-15

### Config: signing-key rate limit raised to 10/hour and made tunable

The limiter shared by `connectWalletForSigning` and `deriveWalletInfo` now
defaults to 10 requests/hour/IP (was 5) and can be overridden via
`NIGHTGATE_SIGNING_KEY_RATE_LIMIT`. Motivation: multi-wallet consumers that
prewarm every configured server wallet at login (one `connectWalletForSigning`
per wallet per server run) exhausted the old budget during demos. The bound
stays tight; the other limiters are unchanged.

## 0.7.1 - 2026-07-15

### Config: one indexer URL is enough (ws endpoint derived)

`NIGHTGATE_INDEXER_WS_URL` / `indexerWsUrl` is now optional: when only the
HTTP URL is overridden (env, config, or a `networks.<network>` entry of the
verify `network` override), the GraphQL subscription endpoint is derived from
it (`http -> ws` scheme plus `/ws` suffix, the pattern every known indexer
deployment follows, hosted and indexer-standalone alike). Previously,
overriding only the HTTP URL silently paired it with the built-in default WS
endpoint of the configured network: a mixed pair pointing at two different
indexers. An explicit WS URL still wins for setups that serve subscriptions
somewhere non-standard; configs that set both are unchanged. The wallet
worker's dust-stream probe reuses the same shared helper
(`srv/utils/indexer-url.ts`, cds-free so the worker thread does not pull in
`@sap/cds`).

### Docs: README consolidated

Highlights + service/write/read/browser surface merged into one "Services &
capabilities" table, a key-env-vars block added to the quick start,
`.env.example`s and `docs/reference.md` updated to the single-URL indexer
setup, stale test-runner facts refreshed (Vitest, 63 suites / 1104 tests).

## 0.7.0 - 2026-07-14

### Feature: optional `network` override on the crawler-free verify surface

`verifyAttestationState` and `verifyPredicateState` accept a new optional
`network` parameter (`preview` | `testnet` | `preprod` | `mainnet` |
`undeployed`). The live-state read is stateless and wallet-free, so a server
configured for one network can now verify an anchor on another network's
public indexer without a second NIGHTGATE process. Omitting the parameter, or
passing the configured network, keeps today's behavior bit-for-bit (top-level
config and `NIGHTGATE_INDEXER_*` env overrides keep winning for the configured
network); an unknown value is a 400, never a silent fallback. A different
valid network swaps ONLY the indexer endpoints: built-in public defaults, or
`cds.requires.nightgate.networks.<network>.indexerHttpUrl/indexerWsUrl` for
non-default indexers. Proof server, zkConfig and the compiled artifact stay as
configured (artifacts are network-agnostic; the read path never proves).

Deliberately NOT on `reindexDisclosures` (it writes `DisclosureGrants` rows
the read gate consumes; mixing networks there needs its own design), nor on
the DB-backed fallbacks of `verifyDocument` / `verifyPredicateAttestation`
(the local `Transactions` table is by definition the configured network), nor
on any submission path (wallet sessions are network-bound).

Requested by NIGHTPASS (Passport Explorer, cross-network verification);
replaces the per-network peer-instance workaround
(`docs/feature-requests/verify-state-network-override.md`).

### Config: `kind: "nightgate"` retired from the documented consumer config

The `kind` marker never did anything: NIGHTGATE registers no CAP kind preset,
and the configured-check always reduced to "is a network selected". Worse, the
docs' minimal config (`{ "kind": "nightgate" }` alone, "defaults to preprod")
did NOT actually start the crawler — without a `network` the plugin stays
idle by design (never auto-crawl a chain nobody chose). The documented minimal
consumer config is now the one that works:

```json
"nightgate": { "network": "preprod" }
```

Existing configs that still carry `"kind": "nightgate"` keep working — the
marker is inert and ignored. `isNightgatePluginConfigured` is simplified to
exactly that predicate, and the dead `kind`/empty-`kinds` entries are removed
from the plugin's own package.json.

### Internal: test suite migrated from Jest to Vitest

CAP 10 deprecated the Jest harness (Vitest is the successor), so the full
suite now runs under Vitest 4; jest/ts-jest/@types/jest are removed. No
runtime code changed. Full run drops from ~60s to ~14s (test files now run in
parallel fork processes; each fork has its own env, in-memory DB and ports).

A coverage review after the migration closed the largest unit-test gaps
(63 suites / 1097 tests total): the deriveWalletInfo handler + the
rejection ladders of every token-op/diagnostics action and the TTL-cleanup
facade eviction (wallet-sessions 77→92%), the parallel catch-up fetch
pipeline incl. batch de-interleaving (BlockProcessor 70→97%), every
CoercionError branch (arg-coercion 100%), and — newly possible because
Vitest imports the ESM SDK — the off-chain claim-key recomputation pinned
byte-exact against the spike-verified encoding with the REAL compact-runtime,
plus both crawler-free state-reader production wrappers (predicate-state
32→100%, attestation-state 100%). The wallet worker itself is now driven
in-thread with a mocked parentPort + stubbed SDK seam
(wallet-worker-dispatch.test.ts): RPC dispatch and error protocol, boot
guard, facade lifecycle incl. restore-vs-fresh and the dust cold-start
flag, the genuine-sync gate (dust stream tip vs appliedIndex, freshness),
and the periodic-save push/ack/unchanged-skip protocol (0→37%); the facade
OPERATION bodies (transfer/shield/unshield/dust/deploy) intentionally stay
covered by the live e2e scripts.

A follow-up sweep covered the remaining substantive gaps: the FULL
issueFieldPredicateAttestation handler (0.4.3's field-bound predicate —
validation ladder, witness-only value transport, optional content-root
anchoring), REAL-SDK HD-derivation regression tests pinning the live-verified
Lace per-role derivation byte-exact (wallet-hd 26→97%, wallet-info 41→100% —
the exact site of the 2026-05 wrong-account bug), the crawler's batch-retry
policy, MidnightNodeProvider's rpcBatch protocol (order-by-id, batch errors,
timeouts) and connect/subscription edges, plus rate-limiter capacity/sweep,
SCALE MultiAddress variants and contract-registry guards
(handlers.ts 81→96%; overall statements 87%, lines 89%). The worker's
Custom-error-117 guards are unit-tested too: `describeTxDust` (the intent
dust dump that makes a 117 attributable) and `buildWorkerWalletProvider`'s
balanceTx fail-fast on an empty DustActions section + submitTx pre-submit
warn (wallet-worker 0→51% overall; the remaining half is the SDK
choreography of the token/deploy op bodies, live-e2e territory).

Coverage attribution fix: cds.test() boots the services from the compiled
`srv/*.js` via native require, OUTSIDE vitest's module graph — handlers
exercised through the booted server were counted as uncovered on the `.ts`
sources (jest intercepted every require, so its numbers never showed this).
The in-place build now emits sourcemaps (`tsconfig.build.json`
`sourceMap: true`; maps are not published and `npm run clean` removes them)
and the coverage include also lists `srv/**/*.js`, so the v8 provider remaps
booted-server execution back onto the `.ts` sources
(nightgate-service.ts 26→98%, nightgate-indexer-service.ts 64→97%). Overall
statement coverage lands at 83% (lines 85%); statement/line are the robust
metrics — the function metric gets noisier through the merged maps.
Two behavioral notes for test authors, also recorded in CLAUDE.md: vi.mock
factories cannot read non-hoisted top-level variables (use `vi.hoisted`), and
mocks do NOT reach the CAP-booted service (cds.test() loads compiled `srv/*.js`
via native require; stub such collaborators with `vi.spyOn` on the natively
required module instead).

## 0.6.9 - 2026-07-13

### Fix: only the deploying wallet could call a contract

`submitContractCall` passed `findDeployedContract` a `privateStateId` but never
an `initialPrivateState`. The private-state store is per wallet and only
`deployContract` seeds it, so any OTHER wallet calling an existing contract
failed with `No private state found at private state ID '<id>'`. That blocked
the entire multi-caller case: several wallets acting on one shared contract
(N producers anchoring in one AttestationVault, N agents on one counter).

`submitContractCall` now scopes the store to the contract
(`setContractAddress`, required before the read or the store rejects it),
checks whether this wallet has a private state for the contract, and seeds one
ONLY when it is absent (default `{}`, what a stateless contract deploys with).
An existing private state is never handed to the SDK's `initialPrivateState`
variant, which would overwrite it. New optional `initialPrivateState` (JSON) on
the action for contracts whose private state is not empty.

Found and live-verified by NIGHTPASS: a programmatically created producer
wallet anchoring in the vault deployed by another wallet
(`docs/feature-requests/contract-call-private-state-seeding.md`).

## 0.6.8 - 2026-07-13

### Fix: unshielded token ops rejected with `1010 Custom error: 192`

`sendNight` (and the `shieldFunds` / `unshieldFunds` swap paths) built
transactions whose UNSHIELDED inputs carried no signatures: the facade's
`transferTransaction` / `initSwap` recipes must pass through
`facade.signRecipe(recipe, signFn)` before `finalizeRecipe`, since unshielded
inputs are signature-authorized (unlike proof-authorized zswap inputs). The
node rejected every such submission at the mempool with
`1010 Custom error: 192`, decoded from midnight-node source as
`MalformedError::InputsSignaturesLengthMismatch`. Register/deregister were
unaffected (their facade APIs take the sign function directly). All three ops
now sign the recipe with the session's unshielded keystore; a recipe without
unshielded inputs signs as a no-op. Found live while funding fresh producer
wallets from an existing preview wallet.

## 0.6.7 - 2026-07-13

### deriveWalletInfo: programmatic wallet creation without Lace

Implements FR `docs/feature-requests/derive-wallet-info.md` (requested by
NIGHTPASS for its one-instance-per-producer topology and by EQUINOX).

- **New action `deriveWalletInfo(mnemonic|seedHex, accountIndex?)`**: derives a
  wallet's connectable identity (`viewingKey`, `shieldedAddress`,
  `nightAddress`) as a pure function of the secret. No session, nothing
  persisted, the secret never logged; role seeds are zeroed and zswap secret
  keys cleared after use. Rate-limited like `connectWalletForSigning` (the
  request carries secret material). Derivation is identical to the signing
  path (per-role HD seeds, Lace-exact), so the derived identity IS the account
  `connectWalletForSigning` signs with for the same secret. Generating the
  mnemonic itself stays consumer-side by design (`bip39.generateMnemonic`);
  the service never returns private key material.
- **`deriveRoleSeeds` gains an optional `accountIndex`** (default 0,
  bit-identical to before): one phrase can host multiple independent wallet
  accounts (e.g. one per producer).
- New integration check `npm run integration:derive-wallet-info` verifies the
  derived shielded address against the live Lace reference account, the
  seedHex/mnemonic equivalence, account-index independence and per-network
  encoding. Validation paths are unit-tested (`test/unit/wallet-info.test.ts`).

## 0.6.6 - 2026-07-12

### Wallet persistence hardening (latent bugs from the error-117 review)

Four defects found during the Custom-error-117 investigation, none the cause
of that incident but each real. Two further review findings were verified and
closed as not-bugs: the missing save-after-submit (wallet state is provably
reconstructable from the public event stream, a lost 30s window only costs
seconds of replay) and the missing per-account submit mutex (the SDK's
`SubscriptionRef.modifyEffect` serializes concurrent balancing under a
semaphore, so parallel spends cannot double-select dust notes).

- **Evict final-save no longer dropped**: `evictWalletFacade` deleted the
  session registry entry BEFORE awaiting the worker evict, so the worker's
  final `state-save` push always arrived with no registered session and was
  discarded (every disconnect/expiry lost up to 30s of state). Order swapped;
  the registry entry now outlives the evict RPC.
- **Failed persists are retried**: the worker marked blobs as saved when it
  PUSHED them, not when the main thread persisted them; one transient
  "database is locked" during a save tick stranded the persisted row until
  the wallet state next changed. New `state-save-ack` protocol: the main
  thread acks a save only after `saveSyncState` succeeded (drops and failures
  do not ack), and the worker re-pushes unacked blobs on the next tick.
- **Cross-network restore guard**: `WalletSyncStates` gains a nullable
  `networkId` column, written with every save; `loadSyncState` refuses a row
  whose stored network differs from the running one (cold start instead of
  restoring another network's state). The accountId is network-agnostic, so
  this trap previously relied on operators wiping the table manually.
- **Cross-wallet restore guard**: `WalletSyncStates` gains a nullable
  `seedFingerprint` column (HMAC of the bip39 seed); `loadSyncState` refuses
  a row written by a different seed, so wallet A's blobs can no longer be
  restored into a facade running wallet B's keys via a shared viewing key.
  (A direct viewing-key-from-seed assertion is not implementable: the Lace
  viewing key is not derivable from the seed via the SDK's key derivation,
  verified empirically against a live wallet.)

**Consumer upgrade note**: the two new columns are ADDITIVE. Do not
`cds.deploy` over a live database (drop+create); run
`ALTER TABLE midnight_WalletSyncStates ADD COLUMN networkId TEXT;` and
`ALTER TABLE midnight_WalletSyncStates ADD COLUMN seedFingerprint TEXT;`
instead. Pre-existing rows have NULL in both and keep restoring as before;
the guards engage as soon as the first post-upgrade save stamps them.

## 0.6.2 - 2026-07-09

### SECURITY: AttestationVault attest() ownership takeover fixed

`attest()` inserted into `attestation_owners` with no guard, and Compact's `Map.insert` overwrites. `payload_hash` is public on-chain, so anyone could re-attest a known hash, become the recorded owner, and then pass every owner-gated assert (`grantDisclosure` / `revokeDisclosure` / `commitValue` / `bindPassport` / `anchorContentRoot`), e.g. self-grant an authority disclosure or revoke legitimate grants.

- **Fix**: `assert(!public_attestations.member(disclose(payload_hash)), "already attested")` at the top of `attest`; attestations are now first-come-first-served per payload_hash. There is deliberately no update path yet; re-anchoring the same document now fails with `already attested`.
- Recompiled `managed/` artifact committed (compactc 0.31.0, WSL; 8 circuits, attest prover/verifier keys and zkir changed). **Only newly deployed vaults get the guard**; vaults already on chain keep the vulnerable attest and should be redeployed if takeover matters for them.
- Regression check added to `scripts/integration-test-attestation-vault.mjs`: drives the real emitted circuits via compact-runtime; re-attest rejected, non-owner still fails owner-gated circuits, prior grants survive, fresh hashes attest. Also repaired the script's (and `spike-disclosure-indexer.mjs`') stale 3-field witness stubs, broken since the 0.4.3 field-predicate witnesses were added.
- Known remaining overwrite of the same class, NOT changed here: `bindPassport` lets the owner of ANY attestation re-bind an already-bound `passportId` to their own attestation (`passport_bindings.insert` overwrites, no current-binding ownership check).

## 0.6.1 - 2026-07-09

### Wallet SDK migrated to the @midnightntwrk scope (fixes the sync stall)

The wallet-sdk family moved upstream from `@midnight-ntwrk/*` (frozen) to `@midnightntwrk/*`; 0.6.0 still resolved the dead scope, whose packages lack the indexer-4.3.x-era fixes (WebSocket subscription leak, `DustGenerationDtimeUpdate` handling in the dust subscription, prover-client compatibility with undici >= 8.2) and starve server-side cold syncs under the indexer 4.3.3 per-connection subscription quotas. FR: `docs/feature-requests/migrate-wallet-sdk-scope.md`.

- **Deps** (pins per the `@midnightntwrk/wallet-sdk@1.2.0` barrel): facade ^4.1.0, shielded ^3.0.2, dust-wallet ^4.2.0, unshielded-wallet ^3.1.0, hd ^3.0.3, address-format ^3.1.2, abstractions ^2.1.0. `ledger-v8`, `compact-js`, `compact-runtime` and all `midnight-js-*` stay in the old scope (not migrated upstream). `npm ls --all` resolves every wallet-sdk package to `@midnightntwrk/*` code, so no dual-scope class-identity mixing.
- **Phantom-dep shim**: `midnight-js-utils@4.0.4` imports `@midnight-ntwrk/wallet-sdk-address-format` at runtime without declaring it (previously satisfied by our own hoisted old-scope dep). Satisfied via npm alias `"@midnight-ntwrk/wallet-sdk-address-format": "npm:@midnightntwrk/wallet-sdk-address-format@^3.1.2"`, i.e. the new-scope code under the old name; only strings cross that boundary (`parseCoinPublicKeyToHex` and friends). Drop the alias when `midnight-js-*` is bumped to >= 4.1.1, which declares the dep properly.
- **Import sweep**: `sdk-loader.ts`, `wallet-worker.ts`, `wallet-hd.ts`, integration scripts, test mocks.
- **`getWalletSdkVersion()`** (and the worker's twin) now locate the facade `package.json` by walking `require.resolve.paths()`, since the package's `exports` map exposes neither `./package.json` nor a `require` condition; the sync-state stamp reports the real version instead of `wallet-sdk-facade@unknown`.
- **Upgrade note**: persisted wallet sync-state blobs are stamped with the SDK version, so the version change discards pre-migration blobs and forces one cold re-sync per wallet. That is intended: blobs written by the frozen SDK predate the quota-aware subscription handling.
- Verification: typecheck, lint, 54/54 suites with 863/863 tests, smoke:sdk (8/8 SDK packages), integration:contract-registry, `npm audit` 0 findings.

## 0.6.0 - 2026-07-09

### CAP 10 toolchain + Int64/Decimal string coercions

Toolchain lifted to `@sap/cds` 10.0.3; code keeps running in both CAP 9 and CAP 10 hosts (peer stays `@sap/cds >=9.0.0`). Full notes: `docs/release-0.6.0.md`.

- **CAP 10 toolchain**: `@sap/cds ^10`, `@sap/cds-dk ^10`, `@cap-js/sqlite ^3` (better-sqlite3 12), `@cap-js/cds-test ^1`, `@cap-js/cds-types ^0.18`, `@cap-js/cds-typer ^0.40`, `eslint ^10`. Node >= 22 is required (CAP 10 minimum; engines field unchanged).
- **Int64/Decimal coercions**: CAP 10 returns Integer64/Decimal values from the DB as strings. All arithmetic read sites are coerced; this also fixes a catch-up bug that would have surfaced under CAP 10 (`"0" + 1 = "01"` as the start height). `getHealth`/`getMetrics` contractually keep returning numbers.
- **cds-typer workaround**: `cds:types` runs with `--outputDTsFiles false` because the new default emission (.d.ts + .js) crashes tsc 5.9.
- **Config**: sqlite credentials are now named `url` instead of the deprecated `database`.
- **Consumer note**: no schema delta, no API change. In a CAP 10 host, OData serializes Integer64/Decimal fields (heights, balances, amounts) as **strings**; coerce accordingly in client code. CAP 9 hosts are unaffected.
- Verification: typecheck, lint, 54/54 suites with 863/863 tests, smoke:sdk (8/8 SDK packages), integration:providers, integration:contract-registry, `npm audit` 0 findings.

## 0.5.2 - 2026-07-09

### Code hardening: admin-gated indexer ops, gapless catch-up, reorg-safe NightBalances, scoped reads

- **Admin gating**: `pauseCrawler` / `resumeCrawler` / `reindexFromHeight` now `@requires: 'admin'` (probes/status stay open for K8s/Prometheus).
- **Gapless catch-up**: a failed batch is re-queued once, then the crawler stops with syncStatus `error` instead of skipping heights; height-sequenced persists refuse orphan blocks (missing parent above genesis throws).
- **Reorg-safe NightBalances**: shared rollback utility (`srv/crawler/rollback.ts`) for reorg + manual reindex recomputes NightBalances per affected address from the remaining rows, so rollback + re-index can no longer double-count balances. `reindexFromHeight` runs its rollback in an explicit committed tx before the crawler restarts.
- **Reorg height guard**: replayed finalized heads are ignored, gaps trigger catch-up instead of rollback, genesis replays never roll back.
- **Scoped reads**: `WalletSessions` / `PendingSubmissions` entity READs are scoped to the requesting user (admins unfiltered); no schema change.
- `protocolVersion` is queried per batch/block; the cache is only an RPC-error fallback.
- Deps: `npm audit` clean (prod: path-to-regexp/undici/ws/qs chain; dev: cds-dk 9.9.3, tsx 4.23); package.json ranges unchanged. Tests: 863/863 (25 new).

## 0.5.1 - 2026-07-07

### verifyPredicateState: id-free crawler-free predicate verification

- Exposes `readPredicateStateForContract` as a first-class service function keyed by claim coordinates (`payloadHash`, `fieldKey?`, `predicate`, `threshold`), so wallet-submitted predicate proofs self-confirm without a `PredicateAttestations` row, a txHash, or the block crawler. Mirrors `verifyAttestationState`.

## 0.5.0 - 2026-07-07

### Crawler-free state verification + auth hardening

Adds crawler-independent on-chain state verification and fixes the review_001 P1-P3 security findings. A consumer whose transactions do not flow through NIGHTGATE's own submission pipeline (e.g. a browser wallet signs and submits, handing back only a txHash) can now confirm the on-chain **effect** directly against live contract state. Full notes: `docs/release-0.5.0.md`.

- **Crawler-free verification** (all read live contract state via `indexerPublicDataProvider.queryContractState`; clean negative, not a 5xx, when no live provider is configured):
  - `verifyAttestationState(contractAddress, payloadHash, contentRoot?)` confirms a payload hash is present in the vault's attestation map (and, when supplied, that the anchored content root matches).
  - `reindexDisclosures(contractAddress)` reconciles `DisclosureGrants` on demand from live state, for wallet-submitted grant/revoke that bypass the plugin pipeline.
  - `verifyDocument` / `verifyPredicateAttestation` fall back to live state when the local `Transactions` table has no matching row. `verifyDocument` gains optional `contractAddress` / `compiledArtifactRef` (non-breaking). Predicate claim keys are recomputed off-chain (`persistentHash` of `PredicateClaim` / `FieldPredicateClaim`, byte-exact per `scripts/spike-state-verification.mjs`) and looked up in `predicate_results` / `field_predicate_results`.
  - New readers `srv/submission/attestation-state.ts` and `predicate-state.ts`; live e2e via `npm run state-verify:e2e`.
- **Security hardening (review_001)**:
  - P1: sessions bound to the owning principal via new `WalletSessions.userId`; every session action, `buildWalletMaterialForSession` (`expectedUserId`), and `getJobStatus` scope to `req.user.id`. Foreign sessionId reads back as 404, unauthenticated callers get 401.
  - P1: **`allowSelfServiceGranteeRegistration` now defaults to `false`** (was `true`); NIGHTGATE cannot verify ownership of the binding input, so the safe default is off.
  - P2: admin `invalidateSession` / `invalidateAllSessions` and the TTL cleanup now null both encrypted keys and evict the cached `WalletFacade`.
  - P3: `jest.config.js` `testTimeout: 60000`.
- **Upgrade**: two new columns, `WalletSessions.userId` and `PredicateAttestations.fieldKey`. Fresh installs get them via `cds deploy`; on an **existing** DB run `scripts/apply-schema-delta.mjs` (now reconciles missing columns via `ALTER TABLE ADD COLUMN`) to avoid a data wipe. Legacy sessions without `userId` read back as 404, so users reconnect once. Tests: 827/827.

## 0.4.3 - 2026-07-02

### Field-bound predicate proofs

Binds a proven predicate value to a **specific passport field** via a Merkle content root, so a verifier knows the value came from *this* attestation, not an arbitrary committed number. Live-verified on Preview.

- **Compact** (`attestation-vault.compact`): new `anchorContentRoot(payload_hash, content_root)` + `proveFieldPredicate(payload_hash, field_key, threshold, op)` circuits. The circuit recomputes the field's Merkle leaf from the witnessed value + inclusion path, folds to a root (depth-4, unrolled), asserts it equals the anchored content root, then checks the predicate. Pure `leafHash` / `nodeHash` exported so the off-chain builder hashes identically.
- **Consolidation**: `bindPassport` (+ `passport_bindings`) folded in from the former NIGHTPASS passport-attestation contract; one contract now covers the full surface. Recompiled `managed/` (compactc 0.31.0): 8 circuits + prover/verifier keys.
- **Plugin wiring**: `merkleProof` threaded through both witness builders (browser + server, kept in lockstep) and the full wallet-worker RPC path. New `issueFieldPredicateAttestation` action + handler (anchors the root if needed, then proves); browser prepare helpers.

## 0.4.2 - 2026-07-01

### Preview network support

Adds the Midnight **Preview** network (the active public dev chain since 2026-01-07) as a first-class option, so both the server-side submission path and consumers can target it. Previously `network: "preview"` was rejected and silently fell back to preprod.

- **`preview` is now a valid `NightgateNetwork`** (`cds.requires.nightgate.network`), with default endpoints: indexer `https://indexer.preview.midnight.network/api/v4/graphql` (+ WS), node `wss://rpc.preview.midnight.network/`. Proof server via `--network preview` (docker-compose `NIGHTGATE_PROOF_NETWORK`).
- Replaced two hard-coded network unions in `TransactionSubmitter` (`TransactionSubmitterDeps.network`, `classifySubmissionError`) with the canonical `NightgateNetwork` type so they no longer drift.
- Live-validated: the browser connector (NIGHTPASS) ran a full deploy + attest + zero-knowledge predicate round-trip on Preview against the public indexer. Tests 779/779, typecheck clean.

## 0.4.1 - 2026-06-29

### Undeployed local network + connector-route tests

- **`networkId: 'undeployed'`** is now a first-class network, so the plugin can run against a local midnight-local-dev stack (node :9944, indexer :8088, proof-server :6300) without Preview funding or tDUST. Verified against a live `indexer-standalone:4.3.2`.
- `nightgate-config`: `undeployed` added to the valid networks + local node/indexer defaults; network unions widened; config schema enum extended.
- `/zk-config` + `/contract-manifest` routes extracted into `src/connector-routes.ts` so the real handlers are testable on a bare Express app (no cds lifecycle). Behavior unchanged.
- New `scripts/integration-test-connector-routes.mjs` (27 assertions: manifest, ETag/304 caching, registry 404 boundary).

## 0.4.0 - 2026-06-29

### Browser / connector surface for wallet-driven AttestationVault calls

Exposes NIGHTGATE building blocks so a browser dApp (NIGHTPASS via the Lace DApp-Connector) can attest / grant / revoke on the AttestationVault without the Compact toolchain or a copy of `managed/`. The headless server-side submission path is unchanged.

- **`@odatano/nightgate/browser` (ESM)**: attester-secret derivation + witnesses, `FetchZkConfigProvider`, `InMemoryPrivateStateProvider`, `createNightgateConnectorProviders`, and `prepareAttest` / `prepareGrantDisclosure` / `prepareRevokeDisclosure` call helpers. New `./browser` and `./browser/attestation-vault` subpath exports; `check:browser` script; optional `@midnight-ntwrk/dapp-connector-api` peer dep.
- **HTTP routes** (mounted in the security-header bootstrap hook): `GET /zk-config/<contract>/{keys,zkir}/<circuit>` (ETag / 304 / cache) serves a contract's proving artifacts, and `GET /contract-manifest` advertises network, zk-config base URL, and registered contracts. Only registered contracts are servable: `contract-registry.getContractRegistration()` is the security boundary.
- **Manifest address pinning**: optional `cds.requires.nightgate.contracts.<name>.address` is advertised in the manifest so connector consumers can self-configure.
- **Wallet sync-gate fix**: `waitForGenuineSync` reads `facade.state()` instead of blocking on `waitForSyncedState()`.
- **Tooling**: Node `>=22` (`engines`), CI matrix moved to 22.x / 24.x, eslint browser globals for `src/browser/**`.

Live-validated on preprod through prove + balance via Lace; submit is gated only by wallet DUST.

## 0.3.6 - 2026-06-09

### Disclosure-grants hardening and cleanup

- **No more orphan optimistic rows**: `grantDisclosure` now reuses an existing `DisclosureGrants` row for the same `(contractAddress, payloadHash, grantee)` (re-affirming `level` and clearing a stale `revokedTxHash`) instead of inserting a duplicate on every retry/re-grant.
- **Sweep grace window**: the post-submit reindexer no longer deactivates active rows modified within the last 10 minutes (`sweepGraceMs`, injectable). Protects just-submitted grants from being swept when the queried node/indexer view lags the chain; explicit revokes are unaffected (the revoke handler flips its own row directly).
- **Self-service grantee registration is now gateable**: new `cds.requires.nightgate.allowSelfServiceGranteeRegistration` config (env: `NIGHTGATE_ALLOW_SELF_SERVICE_GRANTEE_REGISTRATION`). Default `true` (shipped 0.3.4 behavior). Set `false` on deployments where identities must come from an operator proofing flow — NIGHTGATE does not verify that a caller *owns* the binding input it registers, so open self-registration allows squatting a grantee id under `wallet`/`did` binding.
- **`contractAddress` normalized to lowercase** at every write/read boundary (grant/revoke handlers, reindexer, on-chain role gate), so mixed-case caller input can no longer split one logical grant across case-variant rows or miss the lookup.
- **Cleanups**: removed a dead `try/catch` around `Number(level)`; the wallet-worker sync snapshot timeout timer is now cleared (no stray 30 s timers per poll iteration).

## 0.3.5 - 2026-06-09

### Wallet sync robustness 

- **`getWalletBalance` fix**: read the dust balance from the synced `FacadeState`'s `DustWalletState` (`synced.dust.balance(now)`), not `facade.dust` (a `DustWalletAPI` with no `balance()`). The latter threw `dust.balance is not a function` (HTTP 500).
- **Genuine-sync gate** (`waitForGenuineSync`): the SDK's `isSynced` flag is unreliable: when the wallet never receives a chain tip, `highestIndex` stays `0` and `isSynced` is trivially true (`appliedIndex >= 0`) while the wallet is 100k+ blocks behind. Balancing then spends dust whose merkle roots have pruned out of the node's ~1h `root_history`, so the node rejects the tx with `Custom error 117` (NotNormalized / empty dust actions). The worker now polls the dust `appliedIndex` against the indexer's **real** tip and refuses to submit with a clear `"wallet N blocks behind"` instead of building a doomed stale-dust tx. Wired into the prewarm sync + `balanceTx`. Known limit: the public preprod endpoints stall the dust catch-up, so a far-behind wallet needs a stable local indexer to reach the tip.

## 0.3.4 - 2026-06-07

### 2026-06-07: On-chain disclosure grants (for NIGHTPASS)

Surfaces the existing attester-gated `AttestationVault` tiered-disclosure ACL through the plugin so tier **entitlement** becomes on-chain source of truth. No Compact change: the `grantDisclosure` / `revokeDisclosure` circuits already existed. Live-validated on preprod through grant → chain index → `active=true` read-back (the live revoke is pending, blocked by a preprod indexer / dust-sync limitation, not the feature). FR: `docs/feature-requests/expose-disclosure-grants.md`.

- **Write side**: `grantDisclosure` / `revokeDisclosure` async-job OData actions on `NightgateService`. Attester-only (enforced in-circuit), idempotency-key dedupe, rate-limited, mainnet-gated.
- **Read side**: `DisclosureGrants` entity, chain-derived from the on-chain `disclosures` ledger Map via the artifact's `ledger()` decoder. The outer map is **not iterable** (member/lookup only), so grants are enumerated via the iterable `attestation_owners` then drilled into the inner per-payload map. Reconciled to on-chain state by a best-effort post-submit reindexer (`srv/submission/disclosure-indexer.ts`).
- **Grantee binding**: `cds.requires.nightgate.granteeBinding` (`wallet` | `did` | `custom`, default `wallet`) + `GranteeIdentities` entity + `registerGranteeIdentity` action + `deriveGranteeId` / `resolveGranteeId` (`srv/submission/grantee-identity.ts`).
- **Gate**: `attachDisclosureRole({ contractAddress, payloadHash? })` resolves the tier from the on-chain ACL (level `0/1/2` → `public_only` / `legitimate_interest` / `authority`) when a contract scope is given, and is authoritative there; without a scope it falls back to the off-chain `DisclosureRoles` table (unchanged behavior).
- **Tooling / migration**: `npm run disclosure:e2e` (live e2e) + `scripts/apply-schema-delta.mjs`, which additively creates the new tables (`DisclosureGrants`, `GranteeIdentities`) on an existing database. `cds-serve` does **not** auto-create them, so **existing consumers must run this (or `cds deploy`) on upgrade** or reads/writes fail with `no such table`. Tests: 767/767.

## 0.3.3 - 2026-06-05

### 2026-06-05: Code-quality cleanup

- Refactor + readability pass across multiple files; no functional or behavioral change.
- Removed the superseded `db/enhancements.md`, purged internal task references, and renamed the deploy e2e script.

## 0.3.2 - 2026-06-01

### 2026-06-01: Typed argument coercion for `submitContractCall`

The generic `submitContractCall` action can now pass `Bytes<N>` (and other non-JSON-native) circuit arguments. Previously only the built-in `attest` / `commitValue` / `provePredicate` wrappers (which encode internally) worked, so any consumer-registered circuit taking `Bytes<N>` was uncallable via the public OData surface. Reported by NIGHTPASS (T19); unblocks calls like `bindPassport(passportId: Bytes<32>, …)`. FR: `docs/feature-requests/submitcontractcall-bytes-args.md`.

- New `srv/submission/arg-coercion.ts`, wired into the `submitContractCall` handler. Two encodings supported: introspected convention (circuit arg types from the artifact's `contract-info.json`) and explicit tagged values. Invalid hex / wrong byte length / non-integer `Uint` surface as a clean `400`, not a deep circuit type error.
- Docs: `docs/actions.md` → *Encoding circuit args*. Tests: full suite 709/709 (+18).

## 0.3.1 - 2026-05-31

### 2026-05-31: Packaging, consumer subpath exports

- Added `./cds-plugin`, `./cds-plugin.js`, and `./package.json` subpath exports so consumers and CAP tooling resolve the plugin entry cleanly. `.gitignore` housekeeping. No runtime behavior change.

## 0.3.0 - 2026-05-29

### 2026-05-29: ZK predicate attestations (on-chain-verified)

Extends `AttestationVault` from commitment + disclosure-grant into **proving a predicate** (`value ≤ / ≥ threshold`) over a hidden numeric value, without revealing the value — NIGHTGATE's differentiator for Tractus-X / Battery Passport. Verified live on preprod: `47300 ≤ 50000` accepted on-chain; `51 ≤ 50` rejected by the circuit (`failed assert: predicate false`).

- Compact circuit (`contracts/attestation-vault`): new `commitValue` + `provePredicate` circuits, `value_commitments` / `predicate_results` ledger maps, `attested_value` / `value_salt` witnesses, `persistentCommit`-based numeric commitment. Existing `attest` / `grantDisclosure` / `revokeDisclosure` unchanged; recompiled `managed/` artifacts committed.
- New OData actions on `NightgateService`: `issuePredicateAttestation` (async job: `commitValue` → `provePredicate`) and `verifyPredicateAttestation` (confirms the proof tx resolves to a SUCCESS result, mirroring `verifyDocument`). New `PredicateAttestations` entity — it never stores the hidden value or salt.
- Per-call witnesses thread through `submitter.call` → wallet-worker → `withWitnesses`; the hidden value travels only as a circuit witness, never as a circuit arg.
- PAC envelope helper `toPredicateEnvelope` (`digestMultibase` / `claim` / `proof`) in `src/sdk/AttestationService.ts` for consumer apps.
- Verification model: Midnight exposes no standalone off-chain proof verifier, so verification is on-chain/indexer-trust — the ledger only includes the tx if the in-circuit predicate + commitment asserts held. VK-only portable verification is deferred.

### 2026-05-29: Private-state + sync robustness fixes

Both exposed by the first live deploy→call sequence (T15 was deploy-only; contract calls had only ever been mocked):

- `CapDbPrivateStateProvider` used a **random per-instance salt**, so a contract CALL could not decrypt private state a prior DEPLOY wrote (`Salt mismatch: data was encrypted with a different password/salt`). Now a **deterministic per-(account, password) salt** — cross-instance reads work while keeping the one-PBKDF2-per-instance optimization and the integrity check. Regression test added.
- The `balanceTx` pre-sync `waitForSyncedState()` net (added below) was **unbounded** → a dropped, non-retried indexer subscription hung submissions forever. Now bounded via `NIGHTGATE_BALANCE_SYNC_TIMEOUT_MS` (default 180s); a stalled sync fails cleanly instead of hanging.

### 2026-05-29: T15 — first live preprod contract deploy

The submission stack exercised end-to-end against preprod for the first time. Three fixes were required to reach green:

- **Per-role HD key derivation** (`srv/utils/wallet-hd.ts`): keys were derived from the raw BIP39 seed → a different Midnight account than Lace (an empty sibling) → `could not balance dust`. Now derives the zswap / dust / night keys from their respective HD roles (account 0, index 0) via `@midnight-ntwrk/wallet-sdk-hd`, matching Lace. `connectWalletForSigning` now takes the BIP39 mnemonic (or 128-hex seed). New deps: `wallet-sdk-hd`, `bip39`, `undici`.
- **Prewarm now blocks on `waitForSyncedState`** — it previously only kicked off the chain sync, so the deploy balanced against stale (restored) dust and the node rejected the tx with `1010 Invalid Transaction: Custom error: 170` (dust validity window). A safety `waitForSyncedState` was also added to `balanceTx`.
- **Indexer endpoint guidance**: the wallet reads block timestamps (the dust `ctime`) from the indexer, so the indexer must be at the chain tip — a lagging indexer reproduces the same error 170. `.env.example` updated accordingly. Known caveat: the public preprod indexer's graphql-ws subscription degrades over long multi-call sessions; use a caught-up local indexer for heavy use.

### 2026-05-20: Async-job migration for long-running actions

All nine long-running OData actions now return `{ jobId, status }` immediately and the caller polls `getJobStatus(jobId, sessionId)`, instead of blocking the HTTP request on multi-minute proof/submit work.

- New `BackgroundJobs` entity + `BackgroundJobStatus` / `BackgroundJobKind` types; new `srv/submission/background-jobs.ts` (per-kind semaphore — heavy=4, light=16 — plus idempotency and crash recovery that flips interrupted rows to `failed:PROCESS_RESTART` on boot).
- New `getJobStatus(jobId, sessionId)` action (declared `action`/POST, so clients poll with the same POST+body pattern as everything else).
- Migrated: `connectWalletForSigning` (returns `prewarmJobId`), `registerForDustGeneration`, `deregisterFromDustGeneration`, `sendNight`, `shieldFunds`, `unshieldFunds`, `deployContract`, `submitContractCall`, `anchorDocument`.
- Note: `issuePredicateAttestation` (added later with the ZK predicate-attestation feature) also uses the async-job model — it returns `{ jobId, status }` and is polled via `getJobStatus`, making it the tenth async/pollable action in 0.3.0.
- Auto-deploy removed: `ensureSchemaDeployed` is now probe-only (fail-fast); deploy explicitly with `npm run deploy`.
- Trip-hazard documented: never hold a CAP transaction open across a worker `await` — `@cap-js/sqlite` pools a single connection, so doing so starves every other query. Work runs via `runWithoutAmbientTx` (clears `cds.context`) with short per-write txs.

### 2026-05-20: Attestation / Documents / Disclosure surface (T11–T14)

The published consumer surface that `@odatano/passport` (and other apps) import on top of the plugin.

- **T11** — abstract `AttestationService` CDS mixin (`src/sdk/AttestationService.cds` / `.ts`) with `Public` / `Disclosed` / `Authority` role-tier projections over `Attestations`, wired by `registerAttestationServiceHandlers`. Exported as `@odatano/nightgate/sdk/AttestationService` (+ `.cds`).
- **T12** — `Documents` entity + `anchorDocument` action: anchors a content hash on-chain via the `attest` circuit. Caller-managed storage by design — NIGHTGATE stores only the `sha256` + a caller-supplied `storageRef` (`file://` / `s3://` / `ipfs://`), never the document bytes.
- **T13** — `verifyDocument(documentId, providedSha256)`: confirms the hash matches an anchored tx that resolves to a SUCCESS `TransactionResults` row.
- **T14** — `DisclosureRoles` entity + `DisclosureRole` enum (`public_only` / `legitimate_interest` / `authority`, mapped to EU Battery Regulation Annex XIII tiers), `attachDisclosureRole` request middleware, and an authority-gated admin `grantRole` action.

### 2026-05-19: Diagnostics tier

Read-only pre-flight functions complementing the Token-Ops Core write actions. Same worker-thread pattern, but using CDS `function` (GET) since these don't submit transactions.

- New OData functions on `NightgateService`:
  - `getWalletBalance(sessionId)` — snapshot of shielded NIGHT, unshielded NIGHT, current DUST, registered and total NIGHT UTXO counts. All amounts as decimal strings to preserve bigint precision.
  - `estimateSendNightFee(sessionId, receiverAddress, amount, ttlIso?)` — pre-flight DUST fee for `sendNight`. Builds the recipe in the worker (no proof generation, no submit) and calls `facade.estimateTransactionFee`.
  - `estimateShieldFee(sessionId, amount, ttlIso?)` / `estimateUnshieldFee(sessionId, amount, ttlIso?)` — symmetric pre-flight fees for the ledger-shift operations.
- New worker RPCs: `walletGetBalance`, `walletEstimateTransferFee`, `walletEstimateSwapFee`.
- Shared `loadSigningSessionAccountId` helper extracts the duplicated session-lookup + viewing-key-decrypt + accountId-derive block. New handlers use it; older handlers retain inlined logic (cleanup opportunity later).
- Shared `handleSwapEstimate` factored helper removes duplication between shield/unshield estimate handlers.
- Diagnostics rate limit: 60/min per client IP — generous since these inform UI and should be pollable.

### 2026-05-19: Token-Ops Core

Four new write actions on `NightgateService` covering the basic Midnight wallet operations beyond contract deploy/call. All follow the established one-shot pattern (build + balance + prove + submit in a single worker RPC; primitives back across the thread boundary).

- `sendNight(sessionId, receiverAddress, amount, ttlIso?)` — transfer NIGHT to any address. Destination ledger auto-detected from the Bech32m HRP prefix (`mn_shield-addr_` → shielded, `mn_addr_` → unshielded). Built via `facade.transferTransaction`.
- `shieldFunds(sessionId, amount, ttlIso?)` — move the wallet's own NIGHT from unshielded → shielded via `facade.initSwap`. Same NIGHT atom amount appears on both sides (1:1 ledger shift, not value swap).
- `unshieldFunds(sessionId, amount, ttlIso?)` — symmetric counterpart. Useful in practice for making NIGHT available to `registerForDustGeneration` (only unshielded NIGHT can be registered).
- `deregisterFromDustGeneration(sessionId)` — symmetric pair to existing `registerForDustGeneration`. Removes ALL the wallet's registered NIGHT UTXOs from dust generation, making them spendable again. Per-UTXO narrowing not yet exposed.
- New `parseReceiverAddress` helper in the worker handles Bech32m prefix detection.
- `encodeAddressString` extended with TypeScript overloads for `DustAddress` / `ShieldedAddress` / `UnshieldedAddress` (was DustAddress only). The library's invariant `HasCodec<T>` constraint forced this design.
- New `srv/submission/token-ops.ts` module collects the wrappers for the three transfer/swap actions. The dust deregister wrapper lives alongside the existing register in `dust-registration.ts`.
- Rate limits: `sendNight` 10/min, `shieldFunds`/`unshieldFunds` 5 per 5 min (heavier ZK work), `deregisterFromDustGeneration` 10/h.
- Shared validation helpers: `parseNightAmount` (bigint parse + sanity bound at 10^18 atoms), `validateOptionalTtl` (ISO-8601 future timestamp check).

### 2026-05-17: Phase 2b — `deployContract` / `submitContractCall` moved into the worker thread

Builds on Phase 1 (wallet SDK isolation) and Phase 2a (dust registration in worker). All contract submission paths now run entirely in the worker; no SDK objects cross the thread boundary.

- `TransactionSubmitter.deploy/.call` rewired:
  - Build a `CapDbPrivateStateProvider` on the main thread (where CAP DB lives), register it under a fresh ephemeral `proxyId`
  - RPC the worker via new `walletDeployContract` / `walletSubmitContractCall`
  - Worker re-imports the Compact artifact (cached by name), assembles publicData/zk/proof providers itself, uses the existing facade as walletProvider/midnightProvider
  - On return, unregister the proxy; classify any errors via existing `classifySubmissionError`
- New `private-state-rpc` message kind: worker proxies CRUD calls back to the main-side `CapDbPrivateStateProvider`. `setContractAddress` is fire-and-forget (sync per SDK contract; ordering on `parentPort` guarantees subsequent async set/get arrive after).
- Worker RPC error shape changed: `{ ok: false, error: { name, message } }` (was `{ error: string }`) so the main-thread `classifySubmissionError` sees the original `err.name` (e.g. `TxFailedError`).
- Old `TransactionSubmitterDeps` test seams `deployContractImpl` / `findDeployedContractImpl` removed; replaced by `walletDeployContractImpl` / `walletSubmitContractCallImpl` (default to the real worker-client exports).
- `DeployArgs` / `CallArgs` reshape: `{ contractName, registration: { artifactPath, privateStateId, zkConfigPath }, initialPrivateState, sessionId }`. `sessionId` now required (worker keys facade lookup on the derived accountId, but the audit row preserves the OData user-session UUID).
- `ResolvedContract` gained `artifactPath: string` field so handlers can forward it without re-doing path resolution.
- Legacy `level` private-state backend rejected on the worker-routed submission path with a clear error message — the SDK's bundled LevelDB provider doesn't cross thread boundaries.
- `buildFullProviderBundle` / `buildContractProviders` remain exported from `srv/midnight/providers.ts` for `test/unit/midnight-providers.test.ts` only; no longer the production path.

### 2026-05-18: Local Midnight indexer container

The hosted `indexer.preprod.midnight.network` was observed returning 503s. Added a self-hosted alternative.

- New `indexer` service in `docker/docker-compose.yml`: `midnightntwrk/indexer-standalone:4.3.2`, port 8088, named volume `indexer-data` for SQLite persistence.
- Container talks to the hosted preprod Substrate RPC by default (`wss://rpc.preprod.midnight.network/`) — we self-host the *flaky* GraphQL layer but keep the *reliable* RPC hosted. Switch to a local node via `INDEXER_UPSTREAM_NODE_URL=ws://node:9944`.
- New `npm run sync:probe` (`scripts/probe-indexer.mjs`) — verifies the container is up and returning data.
- NIGHTGATE flips to the local indexer via `NIGHTGATE_INDEXER_HTTP_URL` + `NIGHTGATE_INDEXER_WS_URL` env vars (already plumbed in `srv/utils/nightgate-config.ts:resolveNightgateRuntimeConfig`).
- Initial container catch-up: ~2-3 blocks/sec observed → ~2-3 days for full preprod sync. Don't flip NIGHTGATE to use it until `caught_up: true` shows in the container logs.
- Documentation: see [docs/operations.md#local-midnight-indexer](docs/operations.md#local-midnight-indexer-optional).

### Code-quality cleanup pass (2026-05-19)

Repo-wide audit found 15 sloppiness items (lazy `as any` casts, silent `catch {}` blocks, duck-typed fallback chains, etc.). All fixable findings cleaned up; one (Tier 3 `typeof timer.unref` guard) was reverted after tests showed it was a load-bearing contract, not laziness.

- `srv/utils/nightgate-config.ts:getNightgatePluginConfig()` — new typed accessor for `cds.requires.nightgate`. Consolidates 9 separate `(cds.env as any).requires?.nightgate || {}` callsites into one with a proper `NightgatePluginConfig` interface.
- `db` fields on service classes typed as `cds.DatabaseService` (was `any`). 8 sites cleaned.
- `(this.nodeProvider as any).rpcBatch(...)` → typed `MidnightNodeProvider.rpcBatch()` direct.
- `(provider as any)[method]` in worker-client → typed switch over the 8 known PrivateStateProvider methods.
- `signedBlock: null as any` placeholder → discriminated union `PreparedBlockSkipped | PreparedBlockFetched` on `alreadyIndexed`. `persistFromNode` now takes only the fetched variant; TypeScript enforces the contract.
- `(entry.saveTimer as any).unref?.()` → typed `entry.saveTimer.unref()` (NodeJS.Timeout always has unref).
- `network as any` casts dropped (narrower union assigns cleanly to wider).
- Worker `evict()` empty `catch {}` blocks now log via `formatErr()`.
- New `srv/utils/format-error.ts:formatErr()` — single shared helper for "stringify error for log without producing `[object Object]`". Replaces 5 sites of duplicated `err?.message ?? err` / `err?.message ?? String(err)`.
- `(cds as any).load` → typed `cds.load() + cds.linked()` (both typed in `@cap-js/cds-types`). Existence guards retained for tests with partial cds mocks.
- DB query results in `nightgate-indexer-service.ts` typed via small `IdRow` projection interface.
- Address parse/decode in worker uses proper `MidnightBech32m.parse(s).decode(DustAddress, networkId)` from `@midnight-ntwrk/wallet-sdk-address-format` (the previous code imported from the wrong package — `wallet-sdk-abstractions` — and silently dropped the conversion).
- Address encode uses proper `MidnightBech32m.encode<T>(networkId, addr).toString()` (was a 5-method-name try/catch fallback chain).
- Obsolete debug script `scripts/derive-addresses.mjs` deleted.
- `[deploy-debug]` console.log instrumentation in `srv/submission/handlers.ts` removed.

### 2026-05-17: T30 — wallet state persistence

- New `WalletSyncStates` entity per accountId, holding serialized shielded / unshielded / dust sub-wallet blobs.
- Periodic state-save (every 30 s) pushed from the worker thread to the main thread via `state-save` message; persisted via standard CAP `db.run`.
- Restore-first builder: on next `connectWalletForSigning`, the facade-builder loads prior blobs from `WalletSyncStates` and the SDK does a delta-sync from there. Saves ~5-6 h of cold-sync wall-clock on restart.
- Final state-save fired during `evict()` on session disconnect.
- Encryption: each blob encrypted with a per-session storage password derived from the viewing key (PBKDF2 + AES-256-GCM, wire-format compatible with the SDK's LevelDB exports).
- SDK-version gating on restore: the SDK can refuse blobs from incompatible versions; we record the version with each save.

### 2026-05-17: T30 Phase 1 — wallet SDK in a worker thread

The Midnight wallet SDK is built on Effect.ts. Its fiber scheduler monopolises the host's microtask queue during sync, freezing CAP request handlers and `db.run` for tens of seconds at a time. Phase 1 isolates the SDK in a `worker_threads` worker.

- New `srv/midnight/wallet-worker.ts` — worker entry holding the `WalletFacade` and the three sub-wallets.
- New `srv/midnight/wallet-worker-client.ts` — main-thread RPC client. Per-call `MessageChannel`; push events on `parentPort` for state-save + log forwarding.
- Original synchronous facade-builder rewritten as a thin glue layer that spawns the worker, wires the state-save sink, and returns stub objects to legacy callers (which throw a Phase-2 migration error if used directly).
- Diagnostic learnings (don't repeat): `_getActiveHandles()` doesn't count WebSocket subscriptions; `progress.appliedIndex` + `progress.highestRelevantWalletIndex` + `progress.isConnected` are the real fields (not `sourceGap` / `applyGap`); the two `RPC-CORE: subscribeRuntimeVersion ... 1000 Normal Closure` logs at sync start are NOT errors.

### 2026-05-17: T30 Phase 2a — dust registration in the worker

`facade.registerNightUtxosForDustGeneration` flows wholly through the worker. No SDK objects cross the thread boundary; the worker returns only primitives (`txId`, counts, addresses as strings).

- New worker RPC `walletRegisterDustGeneration({ sessionId, dustReceiverAddress?, syncTimeoutMs? })` wraps the entire flow inside the worker: `waitForSyncedState` → filter unregistered NIGHT UTXOs → `registerNightUtxosForDustGeneration` → `finalizeRecipe` → `submitTransaction`.
- `srv/submission/dust-registration.ts` is now a thin wrapper around the worker RPC.
- Tests rewritten to mock the worker-client (411 passing post-Phase-2a).

### Pre-Phase-2 baseline — Server-side submission stack (T1–T10, T29)

Tracking T1–T10 (and T29) from `db/enhancements.md`. Code-complete on main as of 2026-05-16; not yet exercised against a live preprod chain (T15).

#### Submission stack

- New `srv/midnight/` module containing the memoized dynamic-import SDK loader (`sdk-loader.ts`), provider bundle assembly (`providers.ts`), and CAP-DB-backed `PrivateStateProvider` (`CapDbPrivateStateProvider.ts`) replacing the SDK's LevelDB provider for production.
- New `srv/submission/` module containing `TransactionSubmitter` (deploy + call), OData action handlers, contract registry with cross-platform `file://` URL handling for ESM artifacts, wallet-material factory deriving deterministic `accountId` + storage password from viewing key, and `wallet-facade-builder` constructing real `WalletFacade` instances with per-account cache.
- New OData actions on `NightgateService`: `deployContract(compiledArtifactRef, sessionId, initialPrivateState)`, `submitContractCall(contractAddress, circuit, compiledArtifactRef, sessionId, args)`. Rate-limited per session (5 deploys/hour, 30 calls/min).
- New `WalletSessions.connectWalletForSigning(sessionId, seedHex)` action. Encrypts a 32-byte seed (via existing `ENCRYPTION_KEY` AES-256-GCM helpers) into `WalletSessions.encryptedSeedKey`. Required before submission flows. Rate-limited 5/hour/IP.
- `disconnectWallet` now also nukes `encryptedSeedKey` and evicts cached `WalletFacade` instances.

#### Schema

- Added `PendingSubmissions` entity tracking submission lifecycle (`pending` → `included` → `finalized` / `failed`) with `txHash`, `contractAddress`, `circuitName`, `actionType`, `submittedAt`, `finalizedAt`, `finalizedTxData`, `errorCode`, `errorMessage`, `sessionId`.
- Added `PrivateStates` entity: encrypted SDK private state keyed by `(accountId, contractAddress, privateStateId)`.
- Added `ContractSigningKeys` entity: encrypted SDK signing keys keyed by `(accountId, contractAddress)`.
- Added `WalletSessions.encryptedSeedKey` field (nullable). Existing read-only sessions still work.
- Added `PendingSubmissionStatus` enum to `db/types.cds`.

#### Crawler integration

- `BlockProcessor` now calls `reconcilePendingSubmission(tx, extrinsicHash, snapshot)` immediately after each transaction INSERT, flipping matching `PendingSubmissions` rows to `finalized` with a JSON snapshot of the indexed transaction. Atomic with persistence (runs on the same `tx` handle). No-op for transactions that didn't originate from NIGHTGATE's submission path.

#### Configuration

- New `cds.requires.nightgate` keys: `indexerHttpUrl`, `indexerWsUrl`, `proofServerUrl`, `zkConfigBasePath`, `privateStateBackend` (`'cap-db'` default | `'level'` opt-in), `contracts` (registry map), `allowMainnetSubmission` (default `false`).
- New env vars: `NIGHTGATE_INDEXER_HTTP_URL`, `NIGHTGATE_INDEXER_WS_URL`, `NIGHTGATE_PROOF_SERVER_URL`, `NIGHTGATE_PROOF_NETWORK`, `NIGHTGATE_ZK_CONFIG_BASE`, `NIGHTGATE_PRIVATE_STATE_BACKEND`.
- `src/index.ts` calls `loadRegistryFromConfig(nightgateConfig)` on startup and logs registered contract refs.

#### Compact contracts

- Added `contracts/` directory with the bundled `counter` contract (`contracts/counter/`). Source at `src/counter.compact`; compiled `managed/counter/` (contract JS + prover/verifier keys + ZK IR) committed to repo so consumers don't need a Compact toolchain.
- `cds.requires.nightgate.contracts.counter` registered in `package.json` for in-repo standalone runs.
- `contracts/README.md` covers Compact toolchain install (`compact-installer.sh`) and recompile instructions (Linux/macOS/WSL only; no native Windows binary as of compactc 0.31.0).

#### Docker

- `docker/docker-compose.yml` adds `proof-server` service (`midnightntwrk/proof-server:8.0.3`, port 6300). Network selectable via `NIGHTGATE_PROOF_NETWORK` (default `preprod`).

#### Dependencies

- Added: `@midnight-ntwrk/midnight-js-contracts@^4.0.4`, `@midnight-ntwrk/midnight-js-indexer-public-data-provider@^4.0.4`, `@midnight-ntwrk/midnight-js-http-client-proof-provider@^4.0.4`, `@midnight-ntwrk/midnight-js-node-zk-config-provider@^4.0.4`, `@midnight-ntwrk/midnight-js-level-private-state-provider@^4.0.4`, `@midnight-ntwrk/compact-runtime@^0.16.0`, `@midnight-ntwrk/ledger-v8@^8.1.0`, `@midnight-ntwrk/wallet-sdk-facade@^4.0.0`. Note: `ledger-v8`, not `ledger-v7`; the package name carries the version suffix.

#### Tooling

- New `srv/utils/storage-encryption.ts`, a PBKDF2-SHA256 (600k iter) + AES-256-GCM helper. SDK-wire-format-compatible (matches `@midnight-ntwrk/midnight-js-level-private-state-provider` export blob format byte-for-byte). Used by `CapDbPrivateStateProvider` for `exportPrivateStates`/`importPrivateStates`/`exportSigningKeys`/`importSigningKeys`.
- New integration scripts (native-ESM, exercise the real Midnight SDK): `npm run smoke:sdk`, `npm run integration:providers`, `npm run integration:wallet-keys`, `npm run integration:wallet-facade`, `npm run integration:contract-registry`.
- `jest.config.js` `diagnostics.ignoreCodes` extended with TS 2339 and 7016 (pre-existing CAP type friction, unblocks 16 previously-failing test suites).

#### Verified baseline

- `31` test suites passed
- `394` tests passed
- `0` failures
- All 5 integration scripts pass against the real Midnight SDK

## 0.1 - Midnight Indexer

### 0.1.2 - 2026-03-08

#### Preprod-First Readiness
- Added first-class Preprod support to the Nightgate runtime and plugin config.
- Added `NIGHTGATE_NETWORK`, `NIGHTGATE_NODE_URL`, and `NIGHTGATE_CRAWLER_NODE_URL` environment variable overrides for flexible runtime configuration.
- Switched repository defaults to the hosted Midnight Preprod RPC at `wss://rpc.preprod.midnight.network/` for a smoother out-of-the-box experience.
- Updated documentation to reflect the Preprod-first workflow and simplified configuration.

#### Simplified Configuration

- Code defaults to Preprod (`wss://rpc.preprod.midnight.network/`). No config needed for the common case.
- Removed `MIDNIGHT_*` env var aliases; only `NIGHTGATE_NETWORK`, `NIGHTGATE_NODE_URL`, and `NIGHTGATE_CRAWLER_NODE_URL` are supported.
- Removed unused `NIGHTGATE_DEFAULTS` export. Replaced by `DEFAULT_NETWORK` and `DEFAULT_NODE_URL`.
- `package.json` only needs `"nightgate": { "kind": "nightgate" }`; network and URL default in code.

### 0.1.1 - 2026-03-08

#### Reliability And Tooling

- Crawler startup now disconnects provider on startup failure to avoid leaked sockets.
- Crawler catch-up now guarantees `isCatchingUp` reset via `finally`.
- MidnightNodeProvider now guards async subscription callback rejections and logs them safely.
- Security middleware CORS allow-headers now includes `X-Correlation-ID`.

#### Service Capability Expansions

- Block ingestion now persists baseline `TransactionResults` and `TransactionFees` for every indexed transaction.
- Contract-classified transactions now persist `ContractActions` with deterministic address grouping and entry-point hints.
- Transaction metadata extraction now populates `size`, `hasProof`, `proofHash`, `contractAddress`, and `circuitName` fields.
- `NightgateIndexerService` now exposes operational actions: `pauseCrawler()`, `resumeCrawler()`, and `reindexFromHeight(height)`.
- `NightgateService` now exposes query primitives: `Blocks.range(startHeight, endHeight, limit)` and `Transactions.byType(txType, limit)`.

#### Validation Baseline

- `22` test suites passed
- `267` tests passed
- `0` failures
- coverage: `93.09%` statements, `81.77%` branches, `94.3%` functions, `93.62%` lines

### 0.1.0 - 2026-03-06

First public Nightgate package cut.

#### What This Release Delivers

- SAP CAP plugin bootstrap through `cds-plugin.js` and `src/plugin.ts`
- `cds.requires.nightgate` configuration model for Midnight node indexing
- Direct WebSocket connectivity to a Midnight node through `MidnightNodeProvider`
- Catch-up indexing, live subscription, transient retry handling, and reorg rollback in the crawler
- Local CAP-database persistence for blocks, transactions, sync state, and reorg history
- OData services for blockchain reads, indexer operations, analytics, and admin session management
- Wallet-session connect/disconnect flows with encrypted viewing-key storage, TTL cleanup, and admin invalidation
- Health, readiness, liveness, and Prometheus-style metrics endpoints
- Offline startup mode when the node is unavailable
- Auto-deploy attempt when the target schema is missing

#### Release Positioning

- This is a read-side first release.
- The package is already usable as an indexer and OData exposure layer for Midnight data.
- The package is not yet a full write-side blockchain interaction SDK.

#### Explicitly Out Of Scope In 0.1

- Transaction building
- Transaction signing
- Transaction submission
- Wallet execution flows beyond session registration/storage
- Built-in production authorization policy beyond CDS `@requires` annotations

#### Notes On Surface Area

- The schema and CDS services already expose a broader Midnight data model than the current extractor depth guarantees for every entity family.
- The strongest operational path in `0.1` is: node connectivity -> block ingest -> transaction ingest -> sync state -> health/metrics -> OData read access.
- Contract, balance, DUST, governance, and other higher-level projections are part of the public surface and will continue to deepen as extractor coverage expands.

#### Security Hardening

- CDS service auth annotations enabled: `@requires: 'authenticated-user'` on NightgateService and AnalyticsService, `@requires: 'admin'` on AdminService
- `ENCRYPTION_KEY` enforced in production (`NODE_ENV=production`); startup fails without it
- Read-only guard covers all entities including NightBalances, DustRegistrations, TokenTypes, WalletSessions
- Rate limiter hardened with periodic sweep, max key cap, and `destroy()` cleanup
- Crawler: live blocks queued instead of dropped during catch-up; start failure resets running state; reorg uses batched deletes
- MidnightNodeProvider: reconnect timer cleanup, subscription cleanup on close, NaN block number rejection
- BlockProcessor: tx-type validation with allow-list
- Removed unused `sessionToken` field from WalletSessions
- SyncState initialization extracted to shared `ensureSyncStateSingleton()` utility
- `getReorgHistory` limit clamped to max 100; `byCardanoAddresses` array capped at 100

#### Verified Baseline At Release Time

- `21` test suites passed
- `251` tests passed
- `0` failures
- coverage: `98.99%` statements, `90.9%` branches, `99.25%` functions, `99.28%` lines
