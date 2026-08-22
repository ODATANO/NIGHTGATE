# NIGHTGATE Registered Contracts

This directory holds Compact contracts that NIGHTGATE registers via
`cds.requires.nightgate.contracts`. Each subdirectory is one logical contract;
its compiled artifacts (under `src/managed/<name>/`) are committed to the repo
so consumers don't need a Compact toolchain to run NIGHTGATE.

Registered contracts:

- **`counter`**: minimal increment-only contract; first registered artifact
  and the deploy/call smoke-test target.
- **`attestation-vault`**: the tiered-disclosure attestation contract behind
  the attestation / predicate / disclosure actions (16 provable fields per
  document, depth-4 content tree).
- **`attestation-vault-32`**: the 32-slot width variant of the attestation
  vault (depth-5 content tree), for field panels of 17-32 provable fields
  that need ONE root (a global k-of-N diff claim only exists within one
  document). Same circuit set and semantics; a SECOND lineage, not a
  replacement: cross-root proofs only work between documents of the same
  width. Registration carries `slotWidth: 32`; deploy size and cost are
  identical to the 16er (every verifier key is 2119 B, though four verifier
  CONTENTS differ: comparison plus the content-tree circuits), the
  comparison prover doubles (72.9 MB, wasm-provable). Wider trees are not
  supported: the registry rejects `slotWidth: 64` because the mask path is
  32-bit, and a 64-wide comparison prover exceeds the wasm prover's memory
  anyway (proof-server-only).
- **`shielded-token`**: test token whose `mint()` sends the contract's own
  shielded token to the caller's zswap key; exists to exercise the zswap
  circuits (NIGHT is unshielded-only and can never touch them). Used by
  `npm run wasm-zswap:e2e`.

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

Paths are resolved relative to `cwd` at startup. `artifactPath` is dynamic-
imported by `srv/submission/contract-registry.ts:resolveContract`.

## Recompiling

Compact is Linux/macOS only (no native Windows binary as of compactc 0.31.0).

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

That regenerates everything under `managed/counter/`. Commit the result.

**Windows users:** run the install + compile commands inside WSL Ubuntu. The
`src/managed/` output works the same on any host because the emitted JS is
plain ESM.
