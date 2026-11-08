/**
 * Prover keys on demand: a missing key is fetched from the resolved source
 * (env override or the installed package's release assets) and verified
 * against keys/manifest.json.
 */

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
    ensureProverKeys, missingProverKeys, hasAllProverKeys, readProverKeyManifest, resolveZkAssetSource,
    ProverKeysUnavailableError, ZK_ASSET_URL_ENV
} from '../../srv/submission/prover-keys';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

function artifact(opts: { provers?: Record<string, string>; manifest?: boolean; circuits?: string[] } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ng-pk-'));
    dirs.push(root);
    const zk = path.join(root, 'managed');
    fs.mkdirSync(path.join(zk, 'keys'), { recursive: true });
    fs.mkdirSync(path.join(zk, 'zkir'), { recursive: true });
    for (const c of opts.circuits ?? ['attest', 'grant']) {
        fs.writeFileSync(path.join(zk, 'keys', `${c}.verifier`), `vk-${c}`);
        fs.writeFileSync(path.join(zk, 'zkir', `${c}.bzkir`), `ir-${c}`);
    }
    for (const [c, body] of Object.entries(opts.provers ?? {})) fs.writeFileSync(path.join(zk, 'keys', `${c}.prover`), body);
    const artifactPath = path.join(root, 'artifact.mjs');
    fs.writeFileSync(artifactPath, 'export class Contract {}\n');
    if (opts.manifest) {
        // the manifest describes the FULL set, whether or not every key is on disk
        const full: Record<string, string> = { attest: 'pk-attest', grant: 'pk-grant', ...(opts.provers ?? {}) };
        const prover: Record<string, { sha256: string; bytes: number }> = {};
        for (const c of opts.circuits ?? ['attest', 'grant']) {
            const body = Buffer.from(full[c]);
            prover[c] = { sha256: crypto.createHash('sha256').update(body).digest('hex'), bytes: body.length };
        }
        fs.writeFileSync(path.join(zk, 'keys', 'manifest.json'), JSON.stringify({ version: 1, prover }, null, 2));
    }
    return { artifactPath, zkConfigPath: zk, privateStateId: 'ps' };
}

const fetchOf = (files: Record<string, string>, status = 404) => (async (url: string) => {
    const name = String(url).split('/').pop()!;
    if (files[name] !== undefined) return new Response(Buffer.from(files[name]), { status: 200 });
    return new Response('nope', { status });
}) as unknown as typeof fetch;

describe('prover keys on demand', () => {
    it('reports the circuits without a prover key; hasAllProverKeys needs every one', () => {
        const reg = artifact({ provers: { attest: 'pk-attest' } });
        expect(missingProverKeys(reg.zkConfigPath)).toEqual(['grant']);
        expect(hasAllProverKeys(reg.zkConfigPath)).toBe(false);
        fs.writeFileSync(path.join(reg.zkConfigPath, 'keys', 'grant.prover'), 'pk-grant');
        expect(hasAllProverKeys(reg.zkConfigPath)).toBe(true);
        expect(hasAllProverKeys(path.join(reg.zkConfigPath, 'nowhere'))).toBe(false);
    });

    it('reads a well-formed manifest and rejects a malformed one', () => {
        const reg = artifact({ manifest: true });
        expect(Object.keys(readProverKeyManifest(reg.zkConfigPath)!.prover).sort()).toEqual(['attest', 'grant']);
        fs.writeFileSync(path.join(reg.zkConfigPath, 'keys', 'manifest.json'), JSON.stringify({ version: 1, prover: { attest: { sha256: 'zz', bytes: 1 } } }));
        expect(readProverKeyManifest(reg.zkConfigPath)).toBeNull();
    });

    it('resolves the source: env URL per contract, none/off disables, a lineage package names its release assets', () => {
        const foreign = { zkConfigPath: '/x' };
        const packaged = { zkConfigPath: '/x', package: { zkAssetUrl: 'https://github.com/o/r/releases/download/vault-v1.0.0', zkAssetLayout: 'flat' as const } };
        expect(resolveZkAssetSource('vault', foreign, { [ZK_ASSET_URL_ENV]: 'https://host/zk-config/' })).toEqual({ base: 'https://host/zk-config/vault', layout: 'zk-config' });
        expect(resolveZkAssetSource('vault', packaged, { [ZK_ASSET_URL_ENV]: 'https://host/zk-config' })).toEqual({ base: 'https://host/zk-config/vault', layout: 'zk-config' });
        expect(resolveZkAssetSource('vault', packaged, { [ZK_ASSET_URL_ENV]: 'none' })).toBeNull();
        expect(resolveZkAssetSource('vault', packaged, { [ZK_ASSET_URL_ENV]: 'off' })).toBeNull();
        expect(resolveZkAssetSource('vault', packaged, {})).toEqual({ base: 'https://github.com/o/r/releases/download/vault-v1.0.0', layout: 'flat' });
        expect(resolveZkAssetSource('vault', foreign, {})).toBeNull();
    });

    it('fetches flat release assets of a lineage package without an env override', async () => {
        const reg = { ...artifact({ provers: { attest: 'pk-attest' }, manifest: true }), package: { zkAssetUrl: 'https://gh/releases/download/vault-v1.0.0', zkAssetLayout: 'flat' as const } };
        const urls: string[] = [];
        const fetchFn = (async (url: string) => { urls.push(url); return fetchOf({ 'grant.prover': 'pk-grant' })(url); }) as unknown as typeof fetch;
        expect(await ensureProverKeys('vault', reg, { fetchFn, env: {} })).toEqual({ fetched: ['grant'], source: 'https://gh/releases/download/vault-v1.0.0' });
        expect(urls).toEqual(['https://gh/releases/download/vault-v1.0.0/grant.prover']);
    });

    it('fetches the missing keys, verifies each against the manifest, writes them and dedupes concurrent callers', async () => {
        const reg = artifact({ provers: { attest: 'pk-attest' }, manifest: true });
        let calls = 0;
        const fetchFn = (async (url: string) => { calls++; return fetchOf({ 'grant.prover': 'pk-grant' })(url); }) as unknown as typeof fetch;
        const log: string[] = [];
        const opts = { fetchFn, env: { [ZK_ASSET_URL_ENV]: 'https://host/zk-config' }, log: (m: string) => log.push(m) };
        const [a, b] = await Promise.all([ensureProverKeys('vault', reg, opts), ensureProverKeys('vault', reg, opts)]);
        expect(a).toEqual({ fetched: ['grant'], source: 'https://host/zk-config/vault' });
        expect(b).toBe(a);
        expect(calls).toBe(1);
        expect(fs.readFileSync(path.join(reg.zkConfigPath, 'keys', 'grant.prover'), 'utf8')).toBe('pk-grant');
        expect(fs.readdirSync(path.join(reg.zkConfigPath, 'keys')).some(f => f.includes('.part'))).toBe(false);
        expect(log.some(m => /fetching 1 prover key/.test(m))).toBe(true);
        // nothing left to do
        expect(await ensureProverKeys('vault', reg, opts)).toEqual({ fetched: [], source: null });
    });

    it('refuses a download that does not match the manifest and writes nothing', async () => {
        const reg = artifact({ provers: { attest: 'pk-attest' }, manifest: true });
        const opts = { fetchFn: fetchOf({ 'grant.prover': 'pk-grant-tampered' }), env: { [ZK_ASSET_URL_ENV]: 'https://host/zk-config' } };
        await expect(ensureProverKeys('vault', reg, opts)).rejects.toThrow(/does not match keys\/manifest\.json/);
        expect(fs.existsSync(path.join(reg.zkConfigPath, 'keys', 'grant.prover'))).toBe(false);
    });

    it('fails closed, naming the variable, without a source; a 404 and a transport failure carry retryability', async () => {
        const reg = artifact({ provers: { attest: 'pk-attest' }, manifest: true });
        const none = await ensureProverKeys('vault', reg, { env: { [ZK_ASSET_URL_ENV]: 'none' }, fetchFn: fetchOf({}) }).catch(e => e);
        expect(none).toBeInstanceOf(ProverKeysUnavailableError);
        expect(none.message).toMatch(new RegExp(ZK_ASSET_URL_ENV));
        expect(none.message).toMatch(/nightgate-fetch-keys vault/);
        expect(none.retryable).toBe(false);
        const missing404 = await ensureProverKeys('vault', reg, { env: { [ZK_ASSET_URL_ENV]: 'https://h' }, fetchFn: fetchOf({}) }).catch(e => e);
        expect(missing404.message).toMatch(/HTTP 404/);
        expect(missing404.retryable).toBe(false);
        const down = await ensureProverKeys('vault', reg, { env: { [ZK_ASSET_URL_ENV]: 'https://h' }, fetchFn: fetchOf({}, 503), retryDelaysMs: [] }).catch(e => e);
        expect(down.retryable).toBe(true);
        const boom = await ensureProverKeys('vault', reg, { env: { [ZK_ASSET_URL_ENV]: 'https://h' }, fetchFn: (async () => { throw new Error('ECONNRESET'); }) as unknown as typeof fetch, retryDelaysMs: [] }).catch(e => e);
        expect(boom.message).toMatch(/ECONNRESET/);
        expect(boom.retryable).toBe(true);
    });

    it('a lost connection, a torn body and a 503 get another try; a 404 and wrong bytes do not', async () => {
        const reg = () => artifact({ manifest: true });
        const env = { [ZK_ASSET_URL_ENV]: 'https://h' };
        const good = fetchOf({ 'attest.prover': 'pk-attest', 'grant.prover': 'pk-grant' });
        const notFound = fetchOf({});
        const lost = vi.fn<(u: string) => Promise<unknown>>()
            .mockRejectedValueOnce(Object.assign(new TypeError('fetch failed'), { cause: new Error('other side closed') }))
            .mockResolvedValueOnce({ ok: true, status: 200, arrayBuffer: async () => { throw new TypeError('terminated'); } })
            .mockResolvedValueOnce({ ok: false, status: 503 })
            .mockImplementation(async (u) => (good as unknown as (u: string) => Promise<unknown>)(u));
        const lines: string[] = [];
        const done = await ensureProverKeys('vault', reg(), { env, fetchFn: lost as unknown as typeof fetch, retryDelaysMs: [0, 0, 0], log: (m) => lines.push(m) });
        expect(done.fetched.sort()).toEqual(['attest', 'grant']);
        expect(lost).toHaveBeenCalledTimes(5);
        expect(lines.join()).toMatch(/other side closed/);

        const gone = vi.fn(notFound);
        await expect(ensureProverKeys('vault', reg(), { env, fetchFn: gone as unknown as typeof fetch, retryDelaysMs: [0, 0, 0] })).rejects.toThrow(/HTTP 404/);
        expect(gone).toHaveBeenCalledTimes(1);

        const wrong = vi.fn(fetchOf({ 'attest.prover': 'tampered', 'grant.prover': 'tampered' }));
        await expect(ensureProverKeys('vault', reg(), { env, fetchFn: wrong as unknown as typeof fetch, retryDelaysMs: [0, 0, 0] })).rejects.toThrow(/does not match/);
        expect(wrong).toHaveBeenCalledTimes(1);
    });

    it('an error that is no network failure is not tried again', async () => {
        const reg = artifact({ provers: { attest: 'pk-attest' }, manifest: true });
        const refused = vi.fn(async () => { throw new Error('refused by the caller'); });
        const err = await ensureProverKeys('vault', reg, { env: { [ZK_ASSET_URL_ENV]: 'https://h' }, fetchFn: refused as unknown as typeof fetch, retryDelaysMs: [0, 0] }).catch(e => e);
        expect(err.message).toMatch(/refused by the caller/);
        expect(refused).toHaveBeenCalledTimes(1);
    });

    it('the last failure names its cause and the number of tries', async () => {
        const reg = artifact({ provers: { attest: 'pk-attest' }, manifest: true });
        const down = vi.fn(async () => { throw Object.assign(new TypeError('fetch failed'), { cause: new Error('other side closed') }); });
        const err = await ensureProverKeys('vault', reg, { env: { [ZK_ASSET_URL_ENV]: 'https://h' }, fetchFn: down as unknown as typeof fetch, retryDelaysMs: [0] }).catch(e => e);
        expect(err.message).toMatch(/fetch failed: other side closed \(2 tries\)/);
        expect(err.retryable).toBe(true);
        expect(down).toHaveBeenCalledTimes(2);
    });

    it('an artifact without a manifest cannot fetch at all', async () => {
        const reg = artifact({ provers: { attest: 'pk-attest' } });
        await expect(ensureProverKeys('own', reg, { env: { [ZK_ASSET_URL_ENV]: 'https://h' }, fetchFn: fetchOf({ 'grant.prover': 'pk-grant' }) }))
            .rejects.toThrow(/no keys\/manifest\.json/);
    });
});
