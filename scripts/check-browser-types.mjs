// Typechecks the browser declarations as a consumer does: skipLibCheck off, resolved by package name through exports.
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

// Width variant (0.19): slotWidth must be typeable on the witness builder,
// the proof-prepare helpers, the PreparedCall passthrough and the CONTRACTS
// metadata; a consumer targeting attestation-vault-32 writes exactly this.
import { prepareProveFieldEquality, prepareProveFieldsUnchangedExcept, CONTRACTS } from '@odatano/nightgate/browser';
void buildAttestationVaultWitnesses({ merkleProof: proof, slotWidth: 32 });
const eq = prepareProveFieldEquality({ recordKey: 'p', fieldKey: 'f', expectedDigest: 'd', merkleProof: proof, slotWidth: 32 });
const rebound: MerkleProof | undefined = eq.merkleProof;
const w: number | undefined = eq.slotWidth;
void [rebound, w];
void prepareProveFieldsUnchangedExcept({ recordKeyA: 'a', recordKeyB: 'b', allowedMask: 0x80000001, docPair: {}, slotWidth: 32 });
const meta = CONTRACTS['attestation-vault-32'];
const dims: [number, number] = [meta.slotWidth, meta.merkleDepth];
void dims;

// The default bound build keeps finalizedTxB64 a plain string; bind:false narrows to unboundTxB64.
import type { TxBuilder } from '@odatano/nightgate/txbuilder';
async function txb(b: TxBuilder, call: PreparedCall) {
    const bound = await b.buildSponsorable({ contractAddress: 'c', call });
    const s1: string = bound.finalizedTxB64;
    const unbound = await b.buildSponsorable({ contractAddress: 'c', call, bind: false });
    const s2: string = unbound.unboundTxB64;
    const either = await b.buildSponsorable({ contractAddress: 'c', call, bind: Math.random() > 0.5 });
    const s3: string = either.bound ? either.finalizedTxB64 : either.unboundTxB64;
    void [s1, s2, s3];
}
void txb;
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
