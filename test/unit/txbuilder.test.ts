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

    it('exposes the vault circuit set', async () => {
        const { ATTESTATION_VAULT_CIRCUITS } = await importTxBuilder();
        expect(ATTESTATION_VAULT_CIRCUITS).toContain('attest');
        expect(ATTESTATION_VAULT_CIRCUITS).toContain('proveDocumentComparison');
        expect(new Set(ATTESTATION_VAULT_CIRCUITS).size).toBe(ATTESTATION_VAULT_CIRCUITS.length);
    });
});
