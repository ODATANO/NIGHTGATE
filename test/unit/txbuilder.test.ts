// `@odatano/nightgate/txbuilder`: the parts that do NOT need the SDK.
// The live path (build + prove + sponsor) is covered by scripts/run-txbuilder-e2e.mjs.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// The wallet's sealed handles are replaced by plain records, so a test sees what went in and what came out.
vi.mock('../../src/txbuilder/wallet-tx.mjs', () => ({
    sealTx: async (stage: string, tx: unknown, forks: unknown) => ({ sealed: stage, tx, forks }),
    openTx: async (handle: unknown) => ({ opened: handle })
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const importTxBuilder = () => import('../../src/txbuilder/index.mjs' as string);

const COMPILER_MANIFEST = 'compiler/contract-manifest.json';

describe('txbuilder: ensureZkAssets', () => {
    let dir: string;
    beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'ng-txb-')); });
    afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

    const okFetch = (body = 'x') => async (url: string) => ({
        ok: true, status: 200, arrayBuffer: async () => Buffer.from(body + ':' + url)
    }) as any;

    it('downloads prover, verifier and zkir per circuit', async () => {
        const { ensureZkAssets } = await importTxBuilder();
        const seen: string[] = [];
        const res = await ensureZkAssets({
            zkConfigBaseUrl: 'https://sponsor.example/zk-config/attestation-vault/',
            cacheDir: dir, circuits: ['attest'],
            fetchFn: (async (u: string) => { seen.push(u); return (await okFetch()(u)); }) as any
        });
        expect(res.fetched).toBe(4);
        expect(res.cached).toBe(0);
        // The compiler manifest comes first, then the served key manifest (best effort), then the files.
        expect(seen).toEqual([
            'https://sponsor.example/zk-config/attestation-vault/compiler/contract-manifest.json',
            'https://sponsor.example/zk-config/attestation-vault/keys/manifest.json',
            'https://sponsor.example/zk-config/attestation-vault/keys/attest.prover',
            'https://sponsor.example/zk-config/attestation-vault/zkir/attest.bzkir',
            'https://sponsor.example/zk-config/attestation-vault/keys/attest.verifier'
        ]);
        expect((await readFile(join(dir, 'keys', 'attest.prover'), 'utf8')).startsWith('x:')).toBe(true);
        expect((await readFile(join(dir, COMPILER_MANIFEST), 'utf8')).startsWith('x:')).toBe(true);
    });

    it('refuses a server without the compiler manifest before any key is downloaded', async () => {
        // midnight-js verifies every key and zkir against compiler/contract-manifest.json and proves nothing without it.
        const { ensureZkAssets } = await importTxBuilder();
        const seen: string[] = [];
        await expect(ensureZkAssets({
            zkConfigBaseUrl: 'https://s/x', cacheDir: dir, circuits: ['attest'],
            fetchFn: (async (u: string) => { seen.push(u); return u.endsWith(COMPILER_MANIFEST) ? { ok: false, status: 404 } : okFetch()(u); }) as any
        })).rejects.toThrow(/serves no compiler\/contract-manifest\.json/);
        expect(seen).toEqual(['https://s/x/' + COMPILER_MANIFEST]);
    });

    it('replaces a cached compiler manifest the server changed and keeps one it did not', async () => {
        const { ensureZkAssets } = await importTxBuilder();
        const serve = (manifest: string) => (async (u: string) => ({
            ok: true, status: 200, arrayBuffer: async () => Buffer.from(u.endsWith(COMPILER_MANIFEST) ? manifest : 'k:' + u)
        })) as any;
        await ensureZkAssets({ zkConfigBaseUrl: 'https://s/x', cacheDir: dir, circuits: ['attest'], fetchFn: serve('m1') });
        expect(await ensureZkAssets({ zkConfigBaseUrl: 'https://s/x', cacheDir: dir, circuits: ['attest'], fetchFn: serve('m1') })).toMatchObject({ fetched: 0, cached: 4, refreshed: 0 });
        expect(await ensureZkAssets({ zkConfigBaseUrl: 'https://s/x', cacheDir: dir, circuits: ['attest'], fetchFn: serve('m2') })).toMatchObject({ fetched: 1, cached: 3, refreshed: 1 });
        expect(await readFile(join(dir, COMPILER_MANIFEST), 'utf8')).toBe('m2');
    });

    it('restricting circuits still fetches VERIFIER keys for the whole contract', async () => {
        // findDeployedContract reads every circuit's verifier key; only the
        // heavy prover keys may be restricted; restricting the verifier keys
        // too would fail the first build with ENOENT on attestGuarded.verifier.
        const { ensureZkAssets } = await importTxBuilder();
        const seen: string[] = [];
        const res = await ensureZkAssets({
            zkConfigBaseUrl: 'https://s/x', cacheDir: dir,
            circuits: ['attest'], verifierCircuits: ['attest', 'attestGuarded', 'bindPassport'],
            fetchFn: (async (u: string) => { seen.push(u); return (await okFetch()(u)); }) as any
        });
        expect(res.fetched).toBe(6); // compiler manifest + 1 prover + 1 zkir + 3 verifiers
        expect(seen.filter(u => u.endsWith('.prover'))).toHaveLength(1);
        expect(seen.filter(u => u.endsWith('.verifier')).sort()).toEqual([
            'https://s/x/keys/attest.verifier',
            'https://s/x/keys/attestGuarded.verifier',
            'https://s/x/keys/bindPassport.verifier'
        ]);
    });

    it('replaces cached files that do not match the served manifest and keeps the ones that do', async () => {
        // A contract upgrade serves DIFFERENT keys under the same URLs. The
        // manifest names the current sha256 per file; a cached file of a former
        // generation is re-downloaded, a matching one stays.
        const { createHash } = await import('node:crypto');
        const sha = (t: string) => createHash('sha256').update(t).digest('hex');
        const { ensureZkAssets } = await importTxBuilder();
        const bodies: Record<string, string> = {
            '/keys/attest.prover': 'prover-v2', '/keys/attest.verifier': 'verifier-v1', '/zkir/attest.bzkir': 'zkir-v2'
        };
        const manifest = { version: 1, prover: { attest: { sha256: sha('prover-v2') } }, verifier: { attest: { sha256: sha('verifier-v1') } }, zkir: { attest: { sha256: sha('zkir-v2') } } };
        // Warm cache of the FORMER generation for prover + zkir, current verifier.
        await mkdir(join(dir, 'keys'), { recursive: true });
        await mkdir(join(dir, 'zkir'), { recursive: true });
        await writeFile(join(dir, 'keys', 'attest.prover'), 'prover-v1');
        await writeFile(join(dir, 'keys', 'attest.verifier'), 'verifier-v1');
        await writeFile(join(dir, 'zkir', 'attest.bzkir'), 'zkir-v1');
        const seen: string[] = [];
        const res = await ensureZkAssets({
            zkConfigBaseUrl: 'https://s/x', cacheDir: dir, circuits: ['attest'],
            fetchFn: (async (u: string) => {
                seen.push(u);
                if (u.endsWith('/keys/manifest.json')) return { ok: true, status: 200, arrayBuffer: async () => Buffer.from(JSON.stringify(manifest)) };
                if (u.endsWith(COMPILER_MANIFEST)) return { ok: true, status: 200, arrayBuffer: async () => Buffer.from('m') };
                const key = Object.keys(bodies).find(k => u.endsWith(k))!;
                return { ok: true, status: 200, arrayBuffer: async () => Buffer.from(bodies[key]) };
            }) as any
        });
        expect(res).toMatchObject({ fetched: 3, cached: 1, refreshed: 2, verified: true });
        expect(seen.filter(u => !u.endsWith('manifest.json')).sort()).toEqual(['https://s/x/keys/attest.prover', 'https://s/x/zkir/attest.bzkir']);
        expect(await readFile(join(dir, 'keys', 'attest.prover'), 'utf8')).toBe('prover-v2');
        expect(await readFile(join(dir, 'zkir', 'attest.bzkir'), 'utf8')).toBe('zkir-v2');
        expect(await readFile(join(dir, 'keys', 'attest.verifier'), 'utf8')).toBe('verifier-v1');
    });

    it('refuses a downloaded file whose sha256 does not match the served manifest', async () => {
        const { createHash } = await import('node:crypto');
        const { ensureZkAssets } = await importTxBuilder();
        const manifest = { version: 1, prover: { attest: { sha256: createHash('sha256').update('the real key').digest('hex') } }, verifier: {}, zkir: {} };
        await expect(ensureZkAssets({
            zkConfigBaseUrl: 'https://s/x', cacheDir: dir, circuits: ['attest'],
            fetchFn: (async (u: string) => u.endsWith('/keys/manifest.json')
                ? { ok: true, status: 200, arrayBuffer: async () => Buffer.from(JSON.stringify(manifest)) }
                : { ok: true, status: 200, arrayBuffer: async () => Buffer.from(u.endsWith(COMPILER_MANIFEST) ? 'm' : 'a tampered key') }) as any
        })).rejects.toThrow(/does not match the sha256 in the served keys\/manifest\.json/);
        expect(await readFile(join(dir, 'keys', 'attest.prover'), 'utf8').catch(() => 'absent')).toBe('absent');
    });

    it('serves a second run entirely from the cache (offline after the first build)', async () => {
        const { ensureZkAssets } = await importTxBuilder();
        await ensureZkAssets({ zkConfigBaseUrl: 'https://s/x', cacheDir: dir, circuits: ['attest'], fetchFn: okFetch() as any });
        const res = await ensureZkAssets({
            zkConfigBaseUrl: 'https://s/x', cacheDir: dir, circuits: ['attest'],
            fetchFn: (async () => { throw new Error('must not fetch'); }) as any
        });
        expect(res).toMatchObject({ fetched: 0, cached: 4 });
    });

    it('tolerates a 404 (a circuit this contract does not expose) but not a 500', async () => {
        const { ensureZkAssets } = await importTxBuilder();
        const res = await ensureZkAssets({
            zkConfigBaseUrl: 'https://s/x', cacheDir: dir, circuits: ['ghost'],
            fetchFn: (async (u: string) => u.endsWith(COMPILER_MANIFEST) ? okFetch()(u) : { ok: false, status: 404 }) as any
        });
        expect(res).toMatchObject({ fetched: 1, cached: 0 });

        await expect(ensureZkAssets({
            zkConfigBaseUrl: 'https://s/x', cacheDir: dir, circuits: ['attest'],
            fetchFn: (async () => ({ ok: false, status: 500 })) as any
        })).rejects.toThrow(/HTTP 500/);
    });

    it('never leaves a partial file at the destination (atomic rename)', async () => {
        // A file at the destination counts as complete forever after, so a write
        // that dies mid-way must not land there.
        const { ensureZkAssets } = await importTxBuilder();
        await expect(ensureZkAssets({
            zkConfigBaseUrl: 'https://s/x', cacheDir: dir, circuits: ['attest'],
            fetchFn: (async () => ({
                ok: true, status: 200,
                headers: { get: (h: string) => (h === 'content-length' ? '999999' : null) },
                arrayBuffer: async () => Buffer.from('truncated')
            })) as any
        })).rejects.toThrow(/truncated/);

        await expect(readFile(join(dir, 'keys', 'attest.prover'), 'utf8')).rejects.toThrow();
        expect(await readdir(join(dir, 'keys'))).toEqual([]);
    });

    it('re-downloads when only a leftover .part file is present', async () => {
        const { ensureZkAssets } = await importTxBuilder();
        await mkdir(join(dir, 'keys'), { recursive: true });
        await writeFile(join(dir, 'keys', 'attest.prover.part'), 'half a key');
        const res = await ensureZkAssets({ zkConfigBaseUrl: 'https://s/x', cacheDir: dir, circuits: ['attest'], fetchFn: okFetch() as any });
        expect(res.fetched).toBe(4);
        expect((await readFile(join(dir, 'keys', 'attest.prover'), 'utf8')).startsWith('x:')).toBe(true);
    });

    it('does not re-download a partially populated cache', async () => {
        const { ensureZkAssets } = await importTxBuilder();
        await mkdir(join(dir, 'keys'), { recursive: true });
        await writeFile(join(dir, 'keys', 'attest.prover'), 'already-here');
        const res = await ensureZkAssets({ zkConfigBaseUrl: 'https://s/x', cacheDir: dir, circuits: ['attest'], fetchFn: okFetch() as any });
        expect(res).toMatchObject({ fetched: 3, cached: 1 });
        expect(await readFile(join(dir, 'keys', 'attest.prover'), 'utf8')).toBe('already-here');
    });
});

describe('txbuilder: ensureZkAssets input', () => {
    it('names the missing cacheDir instead of failing inside path.join', async () => {
        const { ensureZkAssets } = await importTxBuilder();
        await expect(ensureZkAssets({ zkConfigBaseUrl: 'https://s/zk-config/x' } as any)).rejects.toThrow(/cacheDir is required/);
    });
});

describe('txbuilder: zkConfigDir assets keep the public ZkAssetResult shape', () => {
    let dir: string;
    beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'ng-txb-local-')); });
    afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

    it('ensureZkAssets says where its assets came from', async () => {
        const { ensureZkAssets } = await importTxBuilder();
        const fetchFn = async (url: string) => ({ ok: true, status: 200, arrayBuffer: async () => Buffer.from('k:' + url) }) as any;
        const out = await ensureZkAssets({ zkConfigBaseUrl: 'http://zk/attestation-vault', cacheDir: dir, circuits: ['attest'], verifierCircuits: ['attest'], fetchFn });
        expect(out).toMatchObject({ cacheDir: dir, cached: 0, source: 'remote' });
        expect(typeof out.fetched).toBe('number');
    });

    it('createTxBuilder with zkConfigDir falls back to the vault circuit set when the class cannot be introspected (empty asset dirs do not pass)', async () => {
        const { createTxBuilder } = await importTxBuilder();
        await mkdir(join(dir, 'keys'), { recursive: true });
        await mkdir(join(dir, 'zkir'), { recursive: true });
        await mkdir(join(dir, 'compiler'), { recursive: true });
        await writeFile(join(dir, COMPILER_MANIFEST), '{}');
        class Throws { constructor() { throw new Error('not introspectable'); } }
        await expect(createTxBuilder({
            seedHex: 'ab'.repeat(64), indexerHttpUrl: 'http://i', indexerWsUrl: 'ws://i', nodeUrl: 'ws://n',
            zkConfigDir: dir, contractClass: Throws as any
        })).rejects.toThrow(/lacks verifier keys for attest/);
    });

    it('a local directory is described with fetched: 0 (not `downloaded`), cached = key files, source local', async () => {
        const { describeLocalZkAssets } = await importTxBuilder();
        await mkdir(join(dir, 'keys'), { recursive: true });
        await mkdir(join(dir, 'zkir'), { recursive: true });
        await writeFile(join(dir, 'keys', 'attest.verifier'), 'v');
        await writeFile(join(dir, 'keys', 'attest.prover'), 'p');
        await writeFile(join(dir, 'zkir', 'attest.bzkir'), 'z');
        await mkdir(join(dir, 'compiler'), { recursive: true });
        await writeFile(join(dir, COMPILER_MANIFEST), '{}');
        const out = await describeLocalZkAssets(dir, ['attest']);
        expect(out).toEqual({ cacheDir: dir, fetched: 0, cached: 3, source: 'local' });
        expect((out as any).downloaded).toBeUndefined();
    });

    it('refuses a directory without keys/ + zkir/ DIRECTORIES, one lacking a verifier key of the contract, and one lacking the prover key or bzkir of a circuit to prove', async () => {
        const { describeLocalZkAssets } = await importTxBuilder();
        await expect(describeLocalZkAssets(dir, [])).rejects.toThrow(/must hold keys\/ and zkir\/ directories/);
        await mkdir(join(dir, 'keys'), { recursive: true });
        await writeFile(join(dir, 'zkir'), 'not a directory');
        await expect(describeLocalZkAssets(dir, [])).rejects.toThrow(/must hold keys\/ and zkir\/ directories/);
        await rm(join(dir, 'zkir'));
        await mkdir(join(dir, 'zkir'), { recursive: true });
        await expect(describeLocalZkAssets(dir, [])).rejects.toThrow(/lacks compiler\/contract-manifest\.json/);
        await mkdir(join(dir, 'compiler'), { recursive: true });
        await writeFile(join(dir, COMPILER_MANIFEST), '{}');
        await writeFile(join(dir, 'keys', 'attest.verifier'), 'v');
        await expect(describeLocalZkAssets(dir, ['attest', 'anchorContentRoot'])).rejects.toThrow(/lacks verifier keys for anchorContentRoot/);
        // verifier present, but nothing to PROVE attest with
        await expect(describeLocalZkAssets(dir, ['attest'], ['attest'])).rejects.toThrow(/lacks prover keys for attest/);
        await writeFile(join(dir, 'keys', 'attest.prover'), 'p');
        await expect(describeLocalZkAssets(dir, ['attest'], ['attest'])).rejects.toThrow(/lacks zkir for attest/);
        await writeFile(join(dir, 'zkir', 'attest.bzkir'), 'z');
        expect(await describeLocalZkAssets(dir, ['attest'], ['attest'])).toEqual({ cacheDir: dir, fetched: 0, cached: 3, source: 'local' });
        // a stray extra file in zkir/ is not "cached": only the verified set counts
        await writeFile(join(dir, 'zkir', 'attest.zkir'), 'text form');
        expect((await describeLocalZkAssets(dir, ['attest'], ['attest'])).cached).toBe(3);
        // circuits not proven here need only their verifier key
        await writeFile(join(dir, 'keys', 'anchorContentRoot.verifier'), 'v');
        expect((await describeLocalZkAssets(dir, ['attest', 'anchorContentRoot'], ['attest'])).source).toBe('local');
    });
});

describe('txbuilder: a lineage package as the asset source', () => {
    // A fake lineage package in a node_modules layout: compiled class, verifier
    // keys, zkir and keys/manifest.json ship; the prover keys are "release assets".
    const PKG = '@odatano/contract-fake';
    const ASSETS = 'https://assets.example/fake-v0.0.1';
    const proverBody = (circuit: string) => Buffer.from(`prover-key-of-${circuit}`);
    let root: string;
    let pkgRoot: string;

    async function writePackage(opts: { digest?: string } = {}) {
        const { createHash } = await import('node:crypto');
        const { computeArtifactGenerationDigest } = await import('@odatano/contract-kit/node' as string);
        pkgRoot = join(root, 'node_modules', '@odatano', 'contract-fake');
        const zk = join(pkgRoot, 'managed', 'fake');
        await mkdir(join(zk, 'contract'), { recursive: true });
        await mkdir(join(zk, 'keys'), { recursive: true });
        await mkdir(join(zk, 'zkir'), { recursive: true });
        await mkdir(join(zk, 'compiler'), { recursive: true });
        await writeFile(join(zk, COMPILER_MANIFEST), '{"manifest-version":"1"}');
        await writeFile(join(pkgRoot, 'package.json'), JSON.stringify({ name: PKG, version: '0.0.1', type: 'module' }));
        await writeFile(join(zk, 'contract', 'index.js'), 'export class Contract { constructor(w) { this.witnesses = w; this.impureCircuits = { mint() {}, burn() {} }; } }\n');
        const sha = (b: Buffer) => ({ sha256: createHash('sha256').update(b).digest('hex'), bytes: b.length });
        const manifest: any = { version: 1, prover: {}, verifier: {}, zkir: {} };
        for (const c of ['burn', 'mint']) {
            const v = Buffer.from(`verifier-${c}`); const z = Buffer.from(`zkir-${c}`);
            await writeFile(join(zk, 'keys', `${c}.verifier`), v);
            await writeFile(join(zk, 'zkir', `${c}.bzkir`), z);
            manifest.prover[c] = sha(proverBody(c)); manifest.verifier[c] = sha(v); manifest.zkir[c] = sha(z);
        }
        await writeFile(join(zk, 'keys', 'manifest.json'), JSON.stringify(manifest, null, 2));
        const digest = opts.digest ?? computeArtifactGenerationDigest({ artifactPath: join(zk, 'contract', 'index.js'), privateStateId: 'fakePrivateState', zkConfigPath: zk });
        await writeFile(join(pkgRoot, 'contract.json'), JSON.stringify({
            name: 'fake', role: 'example', privateStateId: 'fakePrivateState', artifactPath: 'managed/fake/contract/index.js', zkConfigPath: 'managed/fake',
            circuits: ['burn', 'mint'], compactCompiler: '0.36.0', compactRuntime: '0.21.0', digest, zkAssetUrl: ASSETS, zkAssetLayout: 'flat'
        }));
        return zk;
    }
    const assetFetch = (seen: string[], bodies: Record<string, Buffer> = {}) => (async (url: string) => {
        seen.push(url);
        const circuit = url.slice(url.lastIndexOf('/') + 1).replace(/\.prover$/, '');
        return { ok: true, status: 200, arrayBuffer: async () => bodies[circuit] ?? proverBody(circuit) };
    }) as any;

    beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'ng-txb-pkg-')); });
    afterEach(async () => { await rm(root, { recursive: true, force: true }); });

    it('ensureZkAssets({ package }) fetches the missing prover keys from the release assets into the package, verified against its manifest', async () => {
        const { ensureZkAssets } = await importTxBuilder();
        const zk = await writePackage();
        const seen: string[] = [];
        const first = await ensureZkAssets({ package: PKG, from: root, fetchFn: assetFetch(seen) });
        expect(seen.sort()).toEqual([`${ASSETS}/burn.prover`, `${ASSETS}/mint.prover`]);
        expect(first).toMatchObject({ cacheDir: zk, fetched: 2, cached: 4, refreshed: 0, source: 'package' });
        expect((await readFile(join(zk, 'keys', 'mint.prover'))).equals(proverBody('mint'))).toBe(true);
        // second run: nothing to fetch
        const again: string[] = [];
        const second = await ensureZkAssets({ package: PKG, from: root, fetchFn: assetFetch(again) });
        expect(again).toEqual([]);
        expect(second).toMatchObject({ fetched: 0, cached: 6, source: 'package' });
    });

    it('a lost connection during a key download gets another try', async () => {
        const { ensureZkAssets } = await importTxBuilder();
        await writePackage();
        const good = assetFetch([]);
        const flaky = vi.fn(good).mockRejectedValueOnce(Object.assign(new TypeError('fetch failed'), { cause: new Error('other side closed') }));
        const done = await ensureZkAssets({ package: PKG, from: root, fetchFn: flaky, retryDelaysMs: [0] });
        expect(done).toMatchObject({ fetched: 2 });
        expect(flaky).toHaveBeenCalledTimes(3);
    });

    it('a key that does not match the manifest is refused and leaves no file; circuits restricts the fetch, an unknown circuit is an error', async () => {
        const { ensureZkAssets } = await importTxBuilder();
        const zk = await writePackage();
        await expect(ensureZkAssets({ package: PKG, from: root, fetchFn: assetFetch([], { burn: Buffer.from('tampered') }) }))
            .rejects.toThrow(/burn\.prover .* does not match keys\/manifest\.json/);
        const files = await readdir(join(zk, 'keys'));
        expect(files.some(f => f.startsWith('burn.prover'))).toBe(false);
        const seen: string[] = [];
        expect((await ensureZkAssets({ package: PKG, from: root, circuits: ['burn'], fetchFn: assetFetch(seen) })).fetched).toBe(1);
        expect(seen).toEqual([`${ASSETS}/burn.prover`]);
        await expect(ensureZkAssets({ package: PKG, from: root, circuits: ['transfer'], fetchFn: assetFetch([]) })).rejects.toThrow(/no circuit transfer/);
        await expect(ensureZkAssets({ package: '@odatano/contract-missing', from: root, fetchFn: assetFetch([]) })).rejects.toThrow(/not installed/);
    });

    it('resolveBuilderPackage reads class, name, private-state id, keys directory and circuits; a package whose files are not its digest is refused', async () => {
        const { resolveBuilderPackage } = await importTxBuilder();
        const zk = await writePackage();
        const out = await resolveBuilderPackage({ package: PKG, from: root });
        expect(out).toMatchObject({ package: { name: PKG, version: '0.0.1' }, contractName: 'fake', privateStateId: 'fakePrivateState', zkConfigDir: zk, circuits: ['burn', 'mint'] });
        expect(typeof out.contractClass).toBe('function');
        await rm(root, { recursive: true, force: true });
        root = await mkdtemp(join(tmpdir(), 'ng-txb-pkg-'));
        await writePackage({ digest: 'f'.repeat(64) });
        await expect(resolveBuilderPackage({ package: PKG, from: root })).rejects.toThrow(/not the generation its contract\.json describes/);
    });

    it('an explicit zkConfigBaseUrl next to package wins: keys come from that server into cacheDir, not from the release assets', async () => {
        const { createTxBuilder } = await importTxBuilder();
        await writePackage();
        const seen: string[] = [];
        const stop = new Error('stop-at-assets');
        const fetchFn = (async (url: string) => { seen.push(url); throw stop; }) as any;
        const cacheDir = join(root, 'cache');
        await expect(createTxBuilder({
            seedHex: 'ab'.repeat(64), indexerHttpUrl: 'http://i', indexerWsUrl: 'ws://i', nodeUrl: 'ws://n',
            package: PKG, from: root, zkConfigBaseUrl: 'http://s/zk-config/fake', cacheDir, fetchFn
        } as any)).rejects.toBe(stop);
        expect(seen.every(u => u.startsWith('http://s/zk-config/fake/'))).toBe(true);
        expect(seen.some(u => u.includes('assets.example'))).toBe(false);
        expect((await readdir(cacheDir)).sort()).toEqual(['compiler', 'keys', 'zkir']);
    });

    it('createTxBuilder({ package }) needs neither zkConfigBaseUrl nor contractClass and warms the package keys before anything else', async () => {
        const { createTxBuilder } = await importTxBuilder();
        await writePackage();
        const seen: string[] = [];
        const stop = new Error('stop-at-assets');
        const fetchFn = (async (url: string) => { seen.push(url); throw stop; }) as any;
        await expect(createTxBuilder({
            seedHex: 'ab'.repeat(64), indexerHttpUrl: 'http://i', indexerWsUrl: 'ws://i', nodeUrl: 'ws://n',
            package: PKG, from: root, fetchFn
        } as any)).rejects.toBe(stop);
        expect(seen).toEqual([`${ASSETS}/burn.prover`]);
    });
});

describe('txbuilder: createTxBuilder input validation', () => {
    // These all reject BEFORE any SDK import or network access, which is what
    // keeps a misconfigured caller from downloading 80 MB of prover keys first.
    const base = {
        seedHex: 'a'.repeat(128),
        indexerHttpUrl: 'http://i/graphql', indexerWsUrl: 'ws://i/graphql/ws',
        nodeUrl: 'wss://rpc.example/',
        zkConfigBaseUrl: 'http://s/zk-config/attestation-vault',
        contractClass: function Contract() { /* stub */ }
    };

    it('requires a 64-byte seed', async () => {
        const { createTxBuilder } = await importTxBuilder();
        for (const seedHex of ['', 'abc', 'a'.repeat(127), 'z'.repeat(128)]) {
            await expect(createTxBuilder({ ...base, seedHex })).rejects.toThrow(/128 hex chars/);
        }
    });

    it('requires both indexer URLs, the node URL, the zk-config base and the contract class', async () => {
        const { createTxBuilder } = await importTxBuilder();
        await expect(createTxBuilder({ ...base, indexerWsUrl: '' })).rejects.toThrow(/indexerHttpUrl and indexerWsUrl/);
        await expect(createTxBuilder({ ...base, nodeUrl: '' })).rejects.toThrow(/nodeUrl is required/);
        await expect(createTxBuilder({ ...base, zkConfigBaseUrl: '' })).rejects.toThrow(/zkConfigBaseUrl is required/);
        await expect(createTxBuilder({ ...base, contractClass: undefined })).rejects.toThrow(/contractClass is required/);
    });

    it('api replaces the indexer and the node, but not a wallet sync', async () => {
        const { createTxBuilder } = await importTxBuilder();
        const api = { baseUrl: 'https://ng.example', agentToken: 'ngat_x' };
        // The URLs may be absent with api; the next check in line is the one for the proving files.
        await expect(createTxBuilder({ ...base, api, indexerHttpUrl: '', indexerWsUrl: '', nodeUrl: '', zkConfigBaseUrl: '', walletSync: false })).rejects.toThrow(/zkConfigBaseUrl is required/);
        await expect(createTxBuilder({ ...base, api, indexerHttpUrl: '', indexerWsUrl: '', nodeUrl: '' })).rejects.toThrow(/walletSync: false/);
        await expect(createTxBuilder({ ...base, api: { token: 'no-base-url' } as any })).rejects.toThrow(/options for connect/);
    });

    it('shieldedWallet must be a started wallet, excludes a saved shielded state and needs no indexer with api', async () => {
        const { createTxBuilder } = await importTxBuilder();
        const api = { baseUrl: 'https://ng.example', agentToken: 'ngat_x' };
        const noIndexer = { ...base, api, indexerHttpUrl: '', indexerWsUrl: '', nodeUrl: '' };
        const wallet: any = { state: { subscribe() { /* observable stand-in */ } }, async start() { /* owner */ }, async stop() { /* owner */ }, async balanceTransaction() { /* balancing */ }, async revertTransaction() { /* revert */ }, async waitForSyncedState() { /* sync */ }, async serializeState() { /* state */ } };
        await expect(createTxBuilder({ ...base, shieldedWallet: { state: {} } as any })).rejects.toThrow(/shieldedWallet must be a started shielded wallet/);
        // the shared wallet is synced by its owner, so 'shielded' starts nothing here: the sync check passes and the next one fails
        await expect(createTxBuilder({ ...noIndexer, walletSync: 'shielded', walletState: 'bad' as any })).rejects.toThrow(/walletSync: false/);
        await expect(createTxBuilder({ ...noIndexer, walletSync: 'shielded', walletState: 'bad' as any, shieldedWallet: wallet })).rejects.toThrow(/walletState must be the object/);
        await expect(createTxBuilder({ ...noIndexer, walletSync: 'coins', shieldedWallet: wallet })).rejects.toThrow(/walletSync: false/);
        await expect(createTxBuilder({ ...base, shieldedWallet: wallet, walletState: { shielded: 'saved' } })).rejects.toThrow(/exclude each other/);
    });

    it("server proving is an EXPLICIT opt-in: a bare proofServerUrl does not select it, and 'server' without a URL rejects", async () => {
        const { createTxBuilder } = await importTxBuilder();
        await expect(createTxBuilder({ ...base, provingMode: 'tpu' })).rejects.toThrow(/provingMode must be 'wasm' or 'server'/);
        await expect(createTxBuilder({ ...base, provingMode: 'server' })).rejects.toThrow(/requires proofServerUrl/);
        // (a proofServerUrl alone keeps wasm: no rejection here; the build path is exercised live)
    });

    it('proofTimeoutMs reaches the SDK proof provider as { timeout }; unset keeps the SDK default', async () => {
        const { proofProviderConfig } = await importTxBuilder();
        expect(proofProviderConfig({ proofTimeoutMs: 900_000 })).toEqual({ timeout: 900_000 });
        expect(proofProviderConfig({})).toBeUndefined();
        expect(proofProviderConfig(undefined)).toBeUndefined();
    });

    it('proofTimeoutMs must be a positive integer', async () => {
        const { createTxBuilder } = await importTxBuilder();
        for (const bad of [0, -1, 1.5, 'soon', NaN]) {
            await expect(createTxBuilder({ ...base, provingMode: 'server', proofServerUrl: 'http://127.0.0.1:6300', proofTimeoutMs: bad as any }))
                .rejects.toThrow(/proofTimeoutMs must be a positive integer/);
        }
    });

    it('exposes the vault circuit set', async () => {
        const { ATTESTATION_VAULT_CIRCUITS } = await importTxBuilder();
        expect(ATTESTATION_VAULT_CIRCUITS).toContain('attest');
        expect(ATTESTATION_VAULT_CIRCUITS).toContain('proveDocumentComparison');
        expect(new Set(ATTESTATION_VAULT_CIRCUITS).size).toBe(ATTESTATION_VAULT_CIRCUITS.length);
    });
});

describe('txbuilder: unbound handover refuses a recipe that carries a balancing transaction', () => {
    const FORKS = { v9: 2_000_000n };
    it('bind:false releases the reserved coins and throws when signRecipe returns a balancingTransaction; bind:true finalizes it', async () => {
        const { buildOnlyWalletProvider } = await importTxBuilder();
        const recipe: any = { type: 'UNBOUND_TRANSACTION', baseTransaction: { base: true }, balancingTransaction: { balancing: true } };
        const facade = {
            balanceUnboundTransaction: vi.fn(async (): Promise<any> => recipe),
            signRecipe: vi.fn(async (r: any) => r),
            finalizeRecipe: vi.fn(async () => ({ finalized: true })),
            revert: vi.fn(async () => { throw new Error('revert failed'); })
        };
        const keystore = { signData: vi.fn(() => new Uint8Array(64)) };
        const holder: any = {};
        const unbound = buildOnlyWalletProvider(facade, { coinPublicKey: 'c', encryptionPublicKey: 'e' }, keystore, holder, 30, false, FORKS);
        await expect(unbound.balanceTx({ tx: true })).rejects.toThrow(/needs a balancing transaction.*bound handover/);
        expect((facade.balanceUnboundTransaction.mock.calls[0] as any[])[0]).toEqual({ sealed: 'Unbound', tx: { tx: true }, forks: FORKS });
        expect(facade.revert).toHaveBeenCalledWith(recipe);
        expect(holder.captured).toBeUndefined();
        const bound = buildOnlyWalletProvider(facade, { coinPublicKey: 'c', encryptionPublicKey: 'e' }, keystore, {}, 30, true, FORKS);
        await expect(bound.balanceTx({ tx: true })).resolves.toEqual({ opened: { finalized: true } });
        // and a recipe WITHOUT balancing hands over the base unbound
        facade.balanceUnboundTransaction.mockResolvedValueOnce({ type: 'UNBOUND_TRANSACTION', baseTransaction: { base: true } });
        const holder2: any = {};
        const unbound2 = buildOnlyWalletProvider(facade, { coinPublicKey: 'c', encryptionPublicKey: 'e' }, keystore, holder2, 30, false, FORKS);
        await expect(unbound2.balanceTx({ tx: true })).rejects.toThrow('BUILD_ONLY_STOP');
        expect(holder2.captured).toEqual({ opened: { base: true } });
    });
});

// A deploy build names the contract it creates, or fails.
describe('txbuilder: readDeployAddress requires exactly one deploy action', () => {
    const tx = (intents: Array<Record<string, unknown>>) => ({ intents: new Map(intents.map((i, n) => [n, i])) });
    const DEPLOY = (address: string) => ({ address, initialState: {} });
    const CALL = () => ({ address: 'aa'.repeat(32), entryPoint: 'attest' });

    it('returns the single deploy address, ignoring call actions', async () => {
        const { readDeployAddress } = await importTxBuilder();
        expect(readDeployAddress(tx([{ actions: [CALL(), DEPLOY('bb'.repeat(32))] }]))).toBe('bb'.repeat(32));
    });
    it('throws on no deploy, two deploys, an empty address, an uninspectable tx or a maintenance update', async () => {
        const { readDeployAddress } = await importTxBuilder();
        expect(() => readDeployAddress(tx([{ actions: [CALL()] }]))).toThrow(/expected exactly one contract deploy action.*found 0/);
        expect(() => readDeployAddress(tx([{ actions: [DEPLOY('bb'.repeat(32))] }, { actions: [DEPLOY('cc'.repeat(32))] }]))).toThrow(/found 2/);
        expect(() => readDeployAddress(tx([{ actions: [DEPLOY('')] }]))).toThrow(/expected exactly one/);
        expect(() => readDeployAddress({})).toThrow(/not inspectable/);
        expect(() => readDeployAddress(tx([{ actions: [{ address: 'bb'.repeat(32), updates: [] }] }]))).toThrow(/maintenance update/);
    });
});

// A call can declare more gas than measured so it still fits after a parallel caller grew a map.
describe('txbuilder: gasHeadroom raises the declared gas of a single call before proving', () => {
    const gas = { readTime: 1000n, computeTime: 10n, bytesWritten: 3n, bytesDeleted: 7n };

    it('validates the factor and scales every field but bytesDeleted, rounding up', async () => {
        const { gasHeadroomFactor, scaleTranscriptGas } = await importTxBuilder();
        expect(gasHeadroomFactor(undefined)).toBeUndefined();
        expect(gasHeadroomFactor(1.5)).toBe(1.5);
        for (const bad of [0.9, 11, 'x', NaN]) expect(() => gasHeadroomFactor(bad)).toThrow(/gasHeadroom must be a number from 1 to 10/);
        const effects = { tag: 'effects' };
        const scaled = scaleTranscriptGas({ gas, effects, program: ['op'] }, 1.5);
        expect(scaled.gas).toEqual({ readTime: 1500n, computeTime: 15n, bytesWritten: 5n, bytesDeleted: 7n });
        expect(scaled.effects).toBe(effects);
        expect(scaled.program).toEqual(['op']);
        expect(scaleTranscriptGas({ gas }, 1).gas).toEqual(gas);
    });

    function fakes() {
        const protos: any[] = [];
        class ContractCallPrototype {
            args: unknown[];
            constructor(...args: unknown[]) { this.args = args; protos.push(this); }
        }
        // Like the ledger: addCall returns a new intent with the call appended to the actions it has at that moment.
        const intent = (fields: Record<string, unknown>) => ({
            actions: [] as unknown[], binding: 'pre-binding', ...fields,
            addCall(prototype: unknown) { return intent({ ...this, actions: [...this.actions, { call: true, prototype }] }); }
        });
        const ledger = {
            ContractState: { deserialize: (raw: Uint8Array) => ({ operation: (id: string) => (raw.length && id === 'approve' ? { verifierKey: new Uint8Array([9, 9]) } : undefined) }) },
            ContractCallPrototype,
            communicationCommitmentRandomness: () => 'fresh-rand'
        };
        const mjTypes = {
            encodeContractKeyLocation: (x: any) => `loc:${x.contractAddress}/${x.circuitId}?vk=${x.verifierKeyHash}`,
            hashVerifierKey: (vk: Uint8Array) => `h${vk.length}`,
            LedgerTransaction: { seal: (era: string, stage: string, tx: any) => ({ era, stage, tx }) }
        };
        const data = (calls: unknown[], intents: Map<number, any>) => ({ calls, public: {}, private: { unprovenTx: { deserialize: () => ({ intents }) } } });
        const contractState = { contractState: { serialize: () => new Uint8Array(1) } };
        const call = (commitment: unknown = { _tag: 'None' }) => ({
            public: { partitionedTranscript: [{ gas, program: ['g'] }, undefined] },
            private: { privateTranscriptOutputs: ['pto'], input: 'in', output: 'out' },
            communicationCommitment: commitment
        });
        return { protos, ledger, mjTypes, data, call, contractState, intent };
    }

    it('rebuilds the one call with scaled gas, the chain state\'s verifier key and the SDK key location, and writes the intent back', async () => {
        const { applyGasHeadroom } = await importTxBuilder();
        const { protos, ledger, mjTypes, data, call, contractState, intent } = fakes();
        const d = data([call()], new Map([[7, intent({ actions: [{ old: true }], ttl: 't' })]]));
        const { unprovenTx, declared } = applyGasHeadroom({ ledger, mjTypes }, d, 1.5, { contractAddress: 'ab'.repeat(32), circuitId: 'approve', contractState });
        expect(declared).toEqual({ guaranteed: { readTime: '1000', computeTime: '10', bytesWritten: '3', bytesDeleted: '7' }, fallible: undefined });
        expect(protos).toHaveLength(1);
        const [address, entryPoint, op, g, f, pto, input, output, rand, keyLocation] = protos[0].args;
        expect([address, entryPoint, op.verifierKey.length, f, pto, input, output, rand]).toEqual(['ab'.repeat(32), 'approve', 2, undefined, ['pto'], 'in', 'out', 'fresh-rand']);
        expect(g.gas).toEqual({ readTime: 1500n, computeTime: 15n, bytesWritten: 5n, bytesDeleted: 7n });
        expect(keyLocation).toBe(`loc:${'ab'.repeat(32)}/approve?vk=h2`);
        expect([unprovenTx.era, unprovenTx.stage]).toEqual(['v9', 'Unproven']);
        const rebuilt = unprovenTx.tx.intents;
        expect([...rebuilt.keys()]).toEqual([7]);
        // The old call is gone, the intent's other fields stay.
        expect(rebuilt.get(7).actions).toEqual([{ call: true, prototype: protos[0] }]);
        expect(rebuilt.get(7)).toMatchObject({ ttl: 't', binding: 'pre-binding' });
    });

    it('keeps the runtime\'s communication commitment randomness when the call has one', async () => {
        const { applyGasHeadroom } = await importTxBuilder();
        const { protos, ledger, mjTypes, data, call, contractState, intent } = fakes();
        const d = data([call({ _tag: 'Some', value: { commCommRand: 'bound-rand' } })], new Map([[1, intent({})]]));
        applyGasHeadroom({ ledger, mjTypes }, d, 2, { contractAddress: 'cd'.repeat(32), circuitId: 'approve', contractState });
        expect(protos[0].args[8]).toBe('bound-rand');
    });

    it('refuses a call tree with several contracts, a missing or keyless chain state and a transaction without one intent', async () => {
        const { applyGasHeadroom } = await importTxBuilder();
        const { ledger, mjTypes, data, call, contractState, intent } = fakes();
        const at = { contractAddress: 'ab'.repeat(32), circuitId: 'approve', contractState };
        expect(() => applyGasHeadroom({ ledger, mjTypes }, data([call(), call()], new Map([[1, intent({})]])), 1.5, at)).toThrow(/one contract.*has 2 calls/);
        expect(() => applyGasHeadroom({ ledger, mjTypes }, data([call()], new Map([[1, intent({})]])), 1.5, { ...at, contractState: null })).toThrow(/no contract state found/);
        expect(() => applyGasHeadroom({ ledger, mjTypes }, data([call()], new Map([[1, intent({})]])), 1.5, { ...at, circuitId: 'other' })).toThrow(/no verifier key for 'other'/);
        expect(() => applyGasHeadroom({ ledger, mjTypes }, data([call()], new Map()), 1.5, at)).toThrow(/expects one intent.*found 0/);
    });
});

describe('txbuilder: trackingWebSocket lets close() end the indexer sockets the SDK provider hides', () => {
    // graphql-ws accepts a WebSocket implementation only when it looks like one
    // (a function carrying the CONNECTING/OPEN/CLOSING/CLOSED statics); the
    // subclass must keep passing that check.
    class FakeWs {
        static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
        handlers: Record<string, Array<() => void>> = {};
        terminated = false;
        constructor(public url: string) { /* no I/O */ }
        once(ev: string, fn: () => void) { (this.handlers[ev] ??= []).push(fn); }
        emit(ev: string) { for (const fn of this.handlers[ev] ?? []) fn(); }
        terminate() { this.terminated = true; }
    }

    it('subclass passes the graphql-ws implementation check and tracks open sockets until they close', async () => {
        const { trackingWebSocket } = await importTxBuilder();
        const tracked = trackingWebSocket(FakeWs);
        const W: any = tracked.WebSocket;
        expect(typeof W).toBe('function');
        for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) expect(k in W).toBe(true);
        const a = new W('ws://i/graphql/ws');
        const b = new W('ws://i/graphql/ws');
        expect(tracked.size).toBe(2);
        a.emit('close');
        expect(tracked.size).toBe(1);
        tracked.closeAll();
        expect(b.terminated).toBe(true);
        expect(a.terminated).toBe(false);
        expect(tracked.size).toBe(0);
    });

    it('closeAll falls back to close() and survives a socket that throws', async () => {
        const { trackingWebSocket } = await importTxBuilder();
        class NoTerminate { static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3; closed = false; close() { this.closed = true; } }
        class Throws { static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3; terminate() { throw new Error('gone'); } }
        const t1 = trackingWebSocket(NoTerminate);
        const s1: any = new (t1.WebSocket as any)();
        t1.closeAll();
        expect(s1.closed).toBe(true);
        const t2 = trackingWebSocket(Throws);
        new (t2.WebSocket as any)();
        expect(() => t2.closeAll()).not.toThrow();
        expect(t2.size).toBe(0);
    });
});

describe('txbuilder: deriveIdentity validates the seed before touching the SDK', () => {
    it('rejects a malformed seed', async () => {
        const { deriveIdentity } = await importTxBuilder();
        for (const seedHex of ['', 'abc', 'a'.repeat(127), 'z'.repeat(128)]) {
            await expect(deriveIdentity({ seedHex })).rejects.toThrow(/128 hex chars/);
        }
        await expect(deriveIdentity(undefined as any)).rejects.toThrow(/128 hex chars/);
    });
});

describe('txbuilder: wallet sync modes', () => {
    it('only a wallet that does not sync gets a fixed start version, so a synced one can read the history before the fork', async () => {
        const { walletConfiguration, syncedWallets } = await importTxBuilder();
        const configuration = { networkId: 'preview' };
        const of = (wallet: string, mode: string) => walletConfiguration(wallet, syncedWallets(mode), configuration, 9n);
        for (const wallet of ['shielded', 'unshielded', 'dust']) {
            expect(of(wallet, 'all')).toBe(configuration);
            expect(await of(wallet, 'none').chainVersionProbe()).toBe(9n);
        }
        expect(of('shielded', 'coins')).toBe(configuration);
        expect(of('unshielded', 'coins')).toBe(configuration);
        expect(await of('dust', 'coins').chainVersionProbe()).toBe(9n);
        expect(of('shielded', 'shielded')).toBe(configuration);
        expect(await of('unshielded', 'shielded').chainVersionProbe()).toBe(9n);
        expect(await of('dust', 'shielded').chainVersionProbe()).toBe(9n);
    });

    it('walletSyncMode accepts true, false, shielded and coins; syncedWallets names the sub-wallets each starts', async () => {
        const { walletSyncMode, syncedWallets } = await importTxBuilder();
        expect(walletSyncMode(undefined)).toBe('all');
        expect(walletSyncMode(true)).toBe('all');
        expect(walletSyncMode(false)).toBe('none');
        expect(walletSyncMode('shielded')).toBe('shielded');
        expect(walletSyncMode('coins')).toBe('coins');
        expect(() => walletSyncMode('dust')).toThrow(/true, false, 'shielded' or 'coins'/);
        expect(syncedWallets('all')).toEqual(['shielded', 'unshielded', 'dust']);
        expect(syncedWallets('coins')).toEqual(['shielded', 'unshielded']);
        expect(syncedWallets('shielded')).toEqual(['shielded']);
        expect(syncedWallets('none')).toEqual([]);
    });

    it("sharedShieldedWallet: start and stop leave the owner's wallet alone, the rest reaches it bound", async () => {
        const { sharedShieldedWallet, isShieldedWallet } = await importTxBuilder();
        const calls: string[] = [];
        class Wallet {
            #secret = 'inside';
            state = { subscribe: () => ({ unsubscribe() { /* nothing to release */ } }) };
            async start() { calls.push('start'); }
            async stop() { calls.push('stop'); }
            async balanceTransaction() { return this.#secret; }
            async revertTransaction() { calls.push('revert'); }
            async waitForSyncedState() { return this.#secret; }
            async serializeState() { return 'state'; }
        }
        const wallet = new Wallet();
        expect(isShieldedWallet(wallet)).toBe(true);
        expect(isShieldedWallet({ state: {} })).toBe(false);
        expect(isShieldedWallet(null)).toBe(false);
        const shared = sharedShieldedWallet(wallet);
        await shared.start({ keys: true });
        await shared.stop();
        expect(calls).toEqual([]);
        // a private field needs the real instance as `this`
        expect(await shared.balanceTransaction()).toBe('inside');
        expect(await shared.waitForSyncedState()).toBe('inside');
        expect(shared.state).toBe(wallet.state);
        await shared.revertTransaction();
        expect(calls).toEqual(['revert']);
    });

    it('syncProgressEvent reads ledger-event and transaction counters alike, null when unreadable', async () => {
        const { syncProgressEvent } = await importTxBuilder();
        expect(syncProgressEvent('shielded', { progress: { appliedIndex: 10n, highestIndex: 25n, isConnected: true } }))
            .toEqual({ phase: 'sync', wallet: 'shielded', appliedIndex: '10', highestIndex: '25', isConnected: true });
        expect(syncProgressEvent('unshielded', { progress: { appliedId: 3n, highestTransactionId: 3n } }))
            .toEqual({ phase: 'sync', wallet: 'unshielded', appliedIndex: '3', highestIndex: '3', isConnected: false });
        expect(syncProgressEvent('dust', { progress: { appliedIndex: 'x' } })).toBeNull();
        expect(syncProgressEvent('dust', {})).toBeNull();
    });

    it('watchSync reports a change at most once a second per wallet and the tip always; unsubscribes on stop', async () => {
        const { watchSync } = await importTxBuilder();
        let t = 0;
        const listeners: Array<(s: unknown) => void> = [];
        const unsubscribed: string[] = [];
        const wallet = (name: string) => ({ state: { subscribe: (o: { next: (s: unknown) => void }) => { listeners.push(o.next); return { unsubscribe: () => unsubscribed.push(name) }; } } });
        const facade = { shielded: wallet('shielded'), unshielded: wallet('unshielded') };
        const events: Array<Record<string, unknown>> = [];
        const stop = watchSync(facade, ['shielded', 'unshielded', 'dust'], (e: Record<string, unknown>) => events.push(e), 1000, () => t);
        const [shielded] = listeners;
        shielded({ progress: { appliedIndex: 1n, highestIndex: 100n } });
        shielded({ progress: { appliedIndex: 2n, highestIndex: 100n } });   // within the second
        t = 1000;
        shielded({ progress: { appliedIndex: 3n, highestIndex: 100n } });
        shielded({ progress: { appliedIndex: 3n, highestIndex: 100n } });   // unchanged
        shielded({ progress: { appliedIndex: 100n, highestIndex: 100n } }); // the tip, within the second
        expect(events.map(e => e.appliedIndex)).toEqual(['1', '3', '100']);
        stop();
        expect(unsubscribed.sort()).toEqual(['shielded', 'unshielded']);
    });
});
