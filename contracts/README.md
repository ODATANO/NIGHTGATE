# NIGHTGATE Registered Contracts

Compact contracts registered via `cds.requires.nightgate.contracts`, one per
directory. Compiled artifacts (`src/managed/<name>/`) are committed, so no
Compact toolchain is needed to run NIGHTGATE.

- **`counter`**: increment-only; deploy/call smoke test.
- **`attestation-vault`**: attestation, predicate and disclosure contract; 16
  fields per document (depth-4 content tree), eleven circuits. Records keyed by
  `recordKey(attester, payload)`; every entry removable (`retract`, claim
  expiry, registrar transfer); claim keys bound to the anchored content root,
  a claim's expiry is extend-only; document ids via `registerDocument` /
  `bindDocument`. Constructor `(registrar, recovery)`, both attester ids; the
  recovery identity can only re-point the registrar (zero = none). Deploys of
  earlier layouts are incompatible.
- **`attestation-vault-32`**: same contract with 32 fields (depth 5),
  `slotWidth: 32`. Cross-document proofs work only within one width. Prover
  keys are not in the npm package: `npx nightgate-fetch-keys attestation-vault-32`.
  `slotWidth: 64` is rejected.
- **`shielded-token`**: test token; `mint()` sends a shielded token to the
  caller's zswap key. Exercises the zswap circuits (`npm run wasm-zswap:e2e`).

## Layout

```
contracts/
└── counter/                          # one contract per directory
    ├── package.json                  # { "type": "module" } so managed/ JS loads as ESM
    └── src/
        ├── counter.compact            # source
        └── managed/
            └── counter/
                ├── compiler/         # JSON contract metadata
                ├── contract/         # JS impl (entry point: index.js)
                ├── keys/             # prover + verifier keys per circuit
                └── zkir/             # ZK IR
```

## Registration

In `cds.requires.nightgate.contracts`:

```jsonc
{
  "counter": {
    "artifactPath":   "contracts/counter/src/managed/counter/contract/index.js",
    "privateStateId": "counterPrivateState",
    "zkConfigPath":   "contracts/counter/src/managed/counter"
  }
}
```

Paths resolve relative to `cwd` at startup.

## Recompiling

Compact runs on Linux and macOS; on Windows use WSL.

**Install (once):**
```bash
# Linux / macOS / WSL
curl -fsSL https://github.com/midnightntwrk/compact/releases/latest/download/compact-installer.sh | sh
export PATH="$HOME/.local/bin:$PATH"
compact update          # installs the latest compiler version
```

**Compile a contract:**
```bash
cd contracts/counter
compact compile src/counter.compact src/managed/counter
```

Regenerates `managed/counter/`; commit the result. The output is plain ESM and runs on any host.
