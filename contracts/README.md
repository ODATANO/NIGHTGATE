# NIGHTGATE Registered Contracts

This directory holds Compact contracts that NIGHTGATE registers via
`cds.requires.nightgate.contracts`. Each subdirectory is one logical contract;
its compiled artifacts (under `src/managed/<name>/`) are committed to the repo
so consumers don't need a Compact toolchain to run NIGHTGATE.

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
