// Proving material of the standard circuits (zswap, dust) and the BLS parameters, kept on disk.
// The wallet SDK's provider downloads each file and checks it against the hash its ledger release declares.
// This keeps the checked bytes, so a later process reads them from disk instead of downloading again.
import { mkdir, writeFile, readFile, rename, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// One directory per ledger release: another release's files can have the same names and other bytes.
// The package exports no package.json, so it is read next to the module.
const ledgerReleaseDir = () => {
    const { version } = JSON.parse(readFileSync(join(dirname(require.resolve('@midnightntwrk/ledger-v9')), 'package.json'), 'utf8'));
    return join('ledger-v9', version);
};
const CIRCUIT_FILES = {
    'midnight/zswap/spend': 'zswap-spend',
    'midnight/zswap/output': 'zswap-output',
    'midnight/zswap/sign': 'zswap-sign',
    'midnight/dust/spend': 'dust-spend'
};
const KEY_PARTS = [['proverKey', 'prover'], ['verifierKey', 'verifier'], ['ir', 'bzkir']];
const HASH_SUFFIX = '.sha256';

export const defaultProverMaterialDir = () => join(homedir(), '.cache', 'nightgate-txbuilder', 'prover-material');

export function sha256Hex(body) {
    return createHash('sha256').update(body).digest('hex');
}

const partFileFor = (dest) => `${dest}.${process.pid}.${randomUUID()}.part`;

/** Writes to a temporary file, then renames it. A file in the cache counts as complete, so a half-written one must never appear there. */
export async function writeAtomically(dest, body) {
    const tmp = partFileFor(dest);
    try {
        await writeFile(tmp, body);
        await rename(tmp, dest);
    } catch (e) {
        await rm(tmp, { force: true }).catch(() => { /* best effort */ });
        throw e;
    }
}

/** The cached file's bytes when they match the recorded sha256, else nothing. A damaged pair is removed.
 *  The hash is written before the body, so a hash without a body is a download in progress and stays. */
async function readVerified(dest) {
    const [body, recorded] = await Promise.all([
        readFile(dest).catch(() => undefined),
        readFile(dest + HASH_SUFFIX, 'utf8').catch(() => undefined)
    ]);
    if (body === undefined) return undefined;
    if (recorded !== undefined && sha256Hex(body) === recorded.trim()) return body;
    await Promise.all([rm(dest, { force: true }), rm(dest + HASH_SUFFIX, { force: true })]);
    return undefined;
}

async function store(dest, bytes) {
    await writeAtomically(dest + HASH_SUFFIX, sha256Hex(bytes) + '\n');
    await writeAtomically(dest, bytes);
}

const asUint8Array = (buf) => new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);

/** A key material provider for the wallet SDK's wasm prover and the contract proof provider.
 *  Files are read from `dir`, else downloaded and checked by the SDK, then kept. Every caller of this process shares them. */
export function createProverMaterialProvider({ dir, baseUrl, onProgress } = {}) {
    const root = join(dir ?? defaultProverMaterialDir(), ledgerReleaseDir());
    let remote;
    const sdkProvider = () => (remote ??= import('@midnightntwrk/wallet-sdk-prover-client/effect')
        .then(({ WasmProver }) => WasmProver.makeV9KeyMaterialProvider(baseUrl ? { source: baseUrl } : undefined)));
    const loading = new Map();
    // One read or download per file and process, however many provers ask for it at once. A failure is not kept.
    const once = (key, load) => {
        let p = loading.get(key);
        if (!p) {
            p = load();
            p.catch(() => loading.delete(key));
            loading.set(key, p);
        }
        return p;
    };
    const report = (file, source, bytes) => onProgress?.({ phase: 'prover-material', file, source, bytes });

    async function keysOf(keyLocation, stem) {
        const paths = KEY_PARTS.map(([, ext]) => join(root, `${stem}.${ext}`));
        const local = await Promise.all(paths.map(readVerified));
        if (local.every(Boolean)) {
            report(stem, 'local', local.reduce((n, b) => n + b.length, 0));
            return Object.fromEntries(KEY_PARTS.map(([field], i) => [field, asUint8Array(local[i])]));
        }
        const fetched = await (await sdkProvider()).lookupKey(keyLocation);
        if (!fetched) throw new Error(`the wallet SDK has no key material for ${keyLocation}`);
        await mkdir(root, { recursive: true });
        await Promise.all(KEY_PARTS.map(([field], i) => store(paths[i], fetched[field])));
        report(stem, 'remote', KEY_PARTS.reduce((n, [field]) => n + fetched[field].length, 0));
        return fetched;
    }

    async function paramsOf(k) {
        const file = `bls_midnight_2p${k}`;
        const dest = join(root, file);
        const local = await readVerified(dest);
        if (local) {
            report(file, 'local', local.length);
            return asUint8Array(local);
        }
        const fetched = await (await sdkProvider()).getParams(k);
        await mkdir(root, { recursive: true });
        await store(dest, fetched);
        report(file, 'remote', fetched.length);
        return fetched;
    }

    return {
        dir: root,
        lookupKey: async (keyLocation) => {
            const stem = CIRCUIT_FILES[keyLocation];
            return stem === undefined ? undefined : once(`key:${stem}`, () => keysOf(keyLocation, stem));
        },
        getParams: (k) => once(`params:${k}`, () => paramsOf(k))
    };
}
