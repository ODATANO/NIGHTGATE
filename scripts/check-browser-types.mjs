// Typecheck the browser declarations the way a CONSUMER does: skipLibCheck OFF, resolved through
// package.json#exports.
//
// Why: the repo's tsconfig has `skipLibCheck: true`, which does not typecheck `.d.ts`/`.d.mts`
// contents at all. Every consumer that leaves skipLibCheck at its default (false) does. Two real
// bugs shipped invisibly through that gap and were only caught by installing the tarball:
//   - `providers.d.mts` imported a type from the declaration-less `./zk-config.mjs` (TS7016);
//   - `index.d.ts` referenced `AttestationVaultWitnesses`, which `export { … } from` re-exports
//     but does NOT bind locally (TS2304).
// A full pack+install round trip catches these but takes minutes. This does it in seconds.
//
// The probe lives INSIDE the repo and imports by PACKAGE NAME, using Node/TS self-referencing, so
// resolution goes through `exports` exactly as a consumer's does. That matters: the browser entry
// ships `.mjs` with a `.d.ts` sibling, which NodeNext resolves ONLY via the exports map's `types`
// condition and never from a file path.
//
// Run: npm run check:browser-types
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const dir = resolve('.ng-types-probe');
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir);

// Exercises the public surface a TS consumer actually touches: witnesses (single + BATCH mode),
// the provider assembly, and the deep providers path.
writeFileSync(
    join(dir, 'probe.ts'),
    `import { buildAttestationVaultWitnesses, createNightgateConnectorProviders } from '@odatano/nightgate/browser';
import type { MerkleProof, MerkleProofHolder, PreparedCall } from '@odatano/nightgate/browser';
import { buildProofProvider } from '@odatano/nightgate/browser/providers.mjs';

const proof: MerkleProof = { fieldValue: '1', siblings: [], dirs: [] };
const holder: MerkleProofHolder = { current: proof };
void buildAttestationVaultWitnesses({ attestationSecret: new Uint8Array(32), merkleProofHolder: holder });
void buildAttestationVaultWitnesses({ attestationSecret: new Uint8Array(32), merkleProof: proof });
// Holder/attester separation MUST stay typeable: a holder proving against an
// anchored root builds witnesses WITHOUT the owner secret. The argument-less
// form matches the runtime's default parameter.
void buildAttestationVaultWitnesses({ merkleProof: proof });
void buildAttestationVaultWitnesses();
void ((c: PreparedCall) => c);
void createNightgateConnectorProviders;
void buildProofProvider;
`,
);
writeFileSync(
    join(dir, 'tsconfig.json'),
    JSON.stringify({
        compilerOptions: {
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            target: 'ES2022',
            strict: true,
            noEmit: true,
            // The whole point: consumer defaults, so declarations are really checked.
            skipLibCheck: false,
            types: [],
        },
        files: ['probe.ts'],
    }),
);

try {
    execFileSync(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '-p', join(dir, 'tsconfig.json')], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    console.log('check-browser-types: ok (declarations typecheck for a consumer, skipLibCheck OFF)');
} catch (e) {
    console.error('check-browser-types: the browser declarations do NOT typecheck for a consumer:');
    console.error(`${e.stdout ?? ''}${e.stderr ?? ''}`.trim());
    process.exitCode = 1;
} finally {
    rmSync(dir, { recursive: true, force: true });
}
