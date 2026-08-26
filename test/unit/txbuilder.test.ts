// `@odatano/nightgate/txbuilder`: the parts that do NOT need the SDK.
// The live path (build + prove + sponsor) is proven by scripts/run-txbuilder-e2e.mjs.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const importTxBuilder = () => import('../../src/txbuilder/index.mjs' as string);

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
        expect(res.fetched).toBe(3);
        expect(res.cached).toBe(0);
        expect(seen.sort()).toEqual([
            'https://sponsor.example/zk-config/attestation-vault/keys/attest.prover',
            'https://sponsor.example/zk-config/attestation-vault/keys/attest.verifier',
            'https://sponsor.example/zk-config/attestation-vault/zkir/attest.bzkir'
        ]);
        expect((await readFile(join(dir, 'keys', 'attest.prover'), 'utf8')).startsWith('x:')).toBe(true);
    });

    it('restricting circuits still fetches VERIFIER keys for the whole contract', async () => {
        // findDeployedContract reads every circuit's verifier key; only the
        // heavy prover keys may be restricted. 0.1.1's `circuits: ['attest']`
        // broke the first build with ENOENT on attestGuarded.verifier.
        const { ensureZkAssets } = await importTxBuilder();
        const seen: string[] = [];
        const res = await ensureZkAssets({
            zkConfigBaseUrl: 'https://s/x', cacheDir: dir,
            circuits: ['attest'], verifierCircuits: ['attest', 'attestGuarded', 'bindPassport'],
            fetchFn: (async (u: string) => { seen.push(u); return (await okFetch()(u)); }) as any
        });
        expect(res.fetched).toBe(5); // 1 prover + 1 zkir + 3 verifiers
        expect(seen.filter(u => u.endsWith('.prover'))).toHaveLength(1);
        expect(seen.filter(u => u.endsWith('.verifier')).sort()).toEqual([
            'https://s/x/keys/attest.verifier',
            'https://s/x/keys/attestGuarded.verifier',
            'https://s/x/keys/bindPassport.verifier'
        ]);
    });

    it('serves a second run entirely from the cache (offline after the first build)', async () => {
        const { ensureZkAssets } = await importTxBuilder();
        await ensureZkAssets({ zkConfigBaseUrl: 'https://s/x', cacheDir: dir, circuits: ['attest'], fetchFn: okFetch() as any });
        const res = await ensureZkAssets({
            zkConfigBaseUrl: 'https://s/x', cacheDir: dir, circuits: ['attest'],
            fetchFn: (async () => { throw new Error('must not fetch'); }) as any
        });
        expect(res).toMatchObject({ fetched: 0, cached: 3 });
    });

    it('tolerates a 404 (a circuit this contract does not expose) but not a 500', async () => {
        const { ensureZkAssets } = await importTxBuilder();
        const res = await ensureZkAssets({
            zkConfigBaseUrl: 'https://s/x', cacheDir: dir, circuits: ['ghost'],
            fetchFn: (async () => ({ ok: false, status: 404 })) as any
        });
        expect(res.fetched).toBe(0);

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
        expect(res.fetched).toBe(3);
        expect((await readFile(join(dir, 'keys', 'attest.prover'), 'utf8')).startsWith('x:')).toBe(true);
    });

    it('does not re-download a partially populated cache', async () => {
        const { ensureZkAssets } = await importTxBuilder();
        await mkdir(join(dir, 'keys'), { recursive: true });
        await writeFile(join(dir, 'keys', 'attest.prover'), 'already-here');
        const res = await ensureZkAssets({ zkConfigBaseUrl: 'https://s/x', cacheDir: dir, circuits: ['attest'], fetchFn: okFetch() as any });
        expect(res).toMatchObject({ fetched: 2, cached: 1 });
        expect(await readFile(join(dir, 'keys', 'attest.prover'), 'utf8')).toBe('already-here');
    });
});

describe('txbuilder: zkConfigDir assets (0.21.0) keep the public ZkAssetResult shape', () => {
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

    it("server proving is an EXPLICIT opt-in: a bare proofServerUrl (documented unused in 0.17) does not select it, and 'server' without a URL rejects", async () => {
        const { createTxBuilder } = await importTxBuilder();
        await expect(createTxBuilder({ ...base, provingMode: 'tpu' })).rejects.toThrow(/provingMode must be 'wasm' or 'server'/);
        await expect(createTxBuilder({ ...base, provingMode: 'server' })).rejects.toThrow(/requires proofServerUrl/);
        // (a proofServerUrl alone keeps wasm: no rejection here; the build path is exercised live)
    });

    it('exposes the vault circuit set', async () => {
        const { ATTESTATION_VAULT_CIRCUITS } = await importTxBuilder();
        expect(ATTESTATION_VAULT_CIRCUITS).toContain('attest');
        expect(ATTESTATION_VAULT_CIRCUITS).toContain('proveDocumentComparison');
        expect(new Set(ATTESTATION_VAULT_CIRCUITS).size).toBe(ATTESTATION_VAULT_CIRCUITS.length);
    });
});

describe('txbuilder: unbound handover refuses a recipe that carries a balancing transaction', () => {
    it('bind:false throws when signRecipe returns a balancingTransaction; bind:true finalizes it', async () => {
        const { buildOnlyWalletProvider } = await importTxBuilder();
        const recipe: any = { type: 'UNBOUND_TRANSACTION', baseTransaction: { base: true }, balancingTransaction: { balancing: true } };
        const facade = {
            balanceUnboundTransaction: vi.fn(async (): Promise<any> => recipe),
            signRecipe: vi.fn(async (r: any) => r),
            finalizeRecipe: vi.fn(async () => ({ finalized: true }))
        };
        const keystore = { signData: vi.fn(() => new Uint8Array(64)) };
        const holder: any = {};
        const unbound = buildOnlyWalletProvider(facade, { coinPublicKey: 'c', encryptionPublicKey: 'e' }, { dust: true }, keystore, holder, 30, false);
        await expect(unbound.balanceTx({ tx: true })).rejects.toThrow(/needs a balancing transaction.*bound handover/);
        expect(holder.unbound).toBeUndefined();
        const bound = buildOnlyWalletProvider(facade, { coinPublicKey: 'c', encryptionPublicKey: 'e' }, { dust: true }, keystore, {}, 30, true);
        await expect(bound.balanceTx({ tx: true })).resolves.toEqual({ finalized: true });
        // and a recipe WITHOUT balancing hands over the base unbound
        facade.balanceUnboundTransaction.mockResolvedValueOnce({ type: 'UNBOUND_TRANSACTION', baseTransaction: { base: true } });
        const holder2: any = {};
        const unbound2 = buildOnlyWalletProvider(facade, { coinPublicKey: 'c', encryptionPublicKey: 'e' }, { dust: true }, keystore, holder2, 30, false);
        await expect(unbound2.balanceTx({ tx: true })).resolves.toEqual({ base: true });
        expect(holder2.unbound).toBe(true);
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
