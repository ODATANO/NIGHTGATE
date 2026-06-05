# NIGHTGATE Follow-ups

Optional / deferred work items. **None of these block a release** of the submission stack — the server is feature-complete (T1–T15 + T29), 49/49 suites and 688/688 tests green. These are extensions and hardening tasks, self-contained here so the old `enhancements.md` implementation plan can be deleted.

Status as of 2026-06-05.

---

## 1. Live AttestationVault e2e

The live deploy path is already proven: the toy `counter` contract was deployed to preprod through the full stack (`connectWallet → connectWalletForSigning → deployContract`):
- tx `01ed30c5c5c17bf44c02929d24175da6b257073854ed5ec97d5ebeac55188922`
- contract `5c2036fe7f67af136b9ad112778308ae6433b6e826e12b4b9f1c6484d929bbe9`

The real `AttestationVault` disclosure flow (`attest` → `grantDisclosure` → 3-role query) is covered at unit level only (the T11–T14 suites). It has **not** been run live against a deployed vault.

**Scope — new file `test/integration/attestation-vault.e2e.test.ts`** (use a separate `npm run test:e2e` script so the unit suite stays fast):

1. `beforeAll`: ensure the preprod proof server is running; ensure DUST balance via the faucet (manual prereq — document the steps in the test README).
2. Deploy `AttestationVault` via `NightgateService.deployContract(...)`.
3. `attest` a payload — alice's pubkey, payload hash X, `public_metadata = { type: "demo" }`.
4. `grantDisclosure(X, bob.pub, 1)` → grants bob `legitimate_interest`.
5. Three queries against the same `Attestations` endpoint:
   - `carol` (role `public_only`) → public metadata only.
   - `bob` (role `legitimate_interest`) → disclosed fields.
   - `admin` (role `authority`) → full payload.
6. `afterAll`: leave the contract on preprod (no cleanup; preprod is ephemeral enough).

**Prereq:** a funded preprod key. Gate the suite behind `NIGHTGATE_E2E_FUNDED_KEY` — `describe.skip` if the env var is missing so CI doesn't fail. The contract circuits are `attest` / `grantDisclosure` / `revokeDisclosure` over `disclosures: Map<Bytes<32>, Map<Bytes<32>, Uint<8>>>`, levels `0=public / 1=legitimate_interest / 2=authority` (compiled artifact in `contracts/attestation-vault/src/managed/`).

---

## 2. T12 server-side storage backends

Deliberately **not built**, recorded here so nobody re-opens it without cause.

NIGHTGATE never handles document bytes. `anchorDocument` (`srv/submission/handlers.ts`) takes a caller-provided `storageRef` (`s3://…` | `ipfs://…` | `file:///…`) and anchors only the hash commitment on-chain (`payload_hash = sha256(doc)`, `metadata_hash = sha256(metadata)`). This keeps the plugin storage-agnostic and mirrors how it delegates transaction signing to the caller — the consumer app owns document storage.

The originally-planned `srv/storage/StorageBackend.ts` interface plus `LocalFsStorage` / `S3Storage` / `IpfsStorage` impls (wired via `cds.requires.nightgate.storage.kind`) were intentionally skipped.

**Revisit only if** a consumer genuinely needs server-side upload+store in one call.

---

## 3. AttestationService row-level visibility

Per-attestation on-chain disclosure joins are **deferred past v1.**

Today the tier gates are entity-level: the `AttestationService` mixin (`src/sdk/AttestationService.cds`/`.ts`) exposes three projections on `midnight.Attestations` — `Public` / `Disclosed` / `Authority` — and `attachDisclosureRole` (`srv/middleware/disclosure-role.ts`) sets the requester's tier as a `before('*')` hook, gating each projection (403 on insufficient tier).

Row-level visibility would refine this to per-attestation: filter individual rows by whether the caller holds a grant for that specific attestation. That requires **indexing the on-chain `disclosures` map** (the `Map<Bytes<32>, Map<Bytes<32>, Uint<8>>>` in the vault) so the service can join each attestation against the caller's pubkey + granted level.

---

## 4. Live SDK round-trip test for the CAP-DB private-state provider

The Jest suite mocks the SDK loader and tests `CapDbPrivateStateProvider` (`srv/midnight/CapDbPrivateStateProvider.ts`) wire format internally only. A future integration test should prove on-disk format compliance against the **real** SDK:

1. Export from `CapDbPrivateStateProvider` (`exportPrivateStates(password)`).
2. Import into the real `levelPrivateStateProvider` from `@midnight-ntwrk/midnight-js-level-private-state-provider`.
3. Round-trip back into the CAP-DB provider.

Doable via the `scripts/integration-test-providers.mjs` pattern, but needs the level provider's `setContractAddress` + a temp filesystem path. The export format is already byte-compatible with the SDK (V2: `[1B version=2][32B salt][12B IV][16B authTag][ciphertext]`, PBKDF2-SHA256 600k iter); this test would confirm it end-to-end against a live SDK install rather than the internal round-trip the unit tests use.

---

## 5. Dependency hygiene

- **`npm audit`** shows 8 vulnerabilities (1 critical, 4 high, 3 moderate) in the Midnight SDK transitive tree. Review individually — **do not** blanket `npm audit fix`, as it may break SDK version pins.
- **Pre-existing `TS7016`** on `@sap/cds` (the package ships no declaration file). Currently suppressed via `jest.config.js` `diagnostics.ignoreCodes` (alongside `TS2339` for CAP's dynamic `this.on()`). There is **no** `@types/sap__cds` package — don't try to install one. A real cleanup would need an ambient `.d.ts` shim. This is a known trip-hazard, not a bug.
