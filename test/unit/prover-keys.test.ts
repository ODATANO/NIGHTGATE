/**
 * Prover keys on demand (srv/submission/prover-keys.ts) and their place in
 * the artifact generation digest (srv/submission/artifact-digest.ts): a
 * missing key is fetched from the resolved source and verified against
 * keys/manifest.json; the digest pins the manifest where one exists and the
 * key bytes otherwise, and still recognises the pre-manifest form.
 */

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
    ensureProverKeys, missingProverKeys, hasAllProverKeys, readProverKeyManifest, resolveZkAssetSource,
    buildProverKeyManifest, ProverKeysUnavailableError, ZK_ASSET_URL_ENV
} from '../../srv/submission/prover-keys';
import { computeArtifactGenerationDigest, artifactGenerationMatch, proverKeyManifestProblems } from '../../srv/submission/artifact-digest';

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
        expect(buildProverKeyManifest(path.join(artifact({ provers: { attest: 'x' } }).zkConfigPath, 'keys'))).toEqual({
            version: 1, prover: { attest: { sha256: crypto.createHash('sha256').update('x').digest('hex'), bytes: 1 } }
        });
    });

    it('resolves the source: env URL per contract, none/off disables, shipped contracts default to the release tag', () => {
        const pkgRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ng-pkg-'));
        dirs.push(pkgRoot);
        fs.writeFileSync(path.join(pkgRoot, 'package.json'), JSON.stringify({ version: '9.9.9' }));
        const shipped = path.join(pkgRoot, 'contracts', 'vault', 'src', 'managed', 'vault');
        fs.mkdirSync(shipped, { recursive: true });
        expect(resolveZkAssetSource('vault', shipped, { [ZK_ASSET_URL_ENV]: 'https://host/zk-config/' }, pkgRoot)).toBe('https://host/zk-config/vault');
        expect(resolveZkAssetSource('vault', shipped, { [ZK_ASSET_URL_ENV]: 'none' }, pkgRoot)).toBeNull();
        expect(resolveZkAssetSource('vault', shipped, { [ZK_ASSET_URL_ENV]: 'off' }, pkgRoot)).toBeNull();
        expect(resolveZkAssetSource('vault', shipped, {}, pkgRoot)).toBe('https://raw.githubusercontent.com/ODATANO/NIGHTGATE/v9.9.9/contracts/vault/src/managed/vault');
        expect(resolveZkAssetSource('vault', path.join(pkgRoot, 'elsewhere'), {}, pkgRoot)).toBeNull();
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
        const down = await ensureProverKeys('vault', reg, { env: { [ZK_ASSET_URL_ENV]: 'https://h' }, fetchFn: fetchOf({}, 503) }).catch(e => e);
        expect(down.retryable).toBe(true);
        const boom = await ensureProverKeys('vault', reg, { env: { [ZK_ASSET_URL_ENV]: 'https://h' }, fetchFn: (async () => { throw new Error('ECONNRESET'); }) as unknown as typeof fetch }).catch(e => e);
        expect(boom.message).toMatch(/ECONNRESET/);
        expect(boom.retryable).toBe(true);
    });

    it('an artifact without a manifest cannot fetch at all', async () => {
        const reg = artifact({ provers: { attest: 'pk-attest' } });
        await expect(ensureProverKeys('own', reg, { env: { [ZK_ASSET_URL_ENV]: 'https://h' }, fetchFn: fetchOf({ 'grant.prover': 'pk-grant' }) }))
            .rejects.toThrow(/no keys\/manifest\.json/);
    });
});

describe('artifact digest and prover keys', () => {
    it('with a manifest the digest ignores which prover keys are on disk and pins the manifest', () => {
        const reg = artifact({ provers: { attest: 'pk-attest' }, manifest: true });
        const before = computeArtifactGenerationDigest(reg);
        fs.writeFileSync(path.join(reg.zkConfigPath, 'keys', 'grant.prover'), 'pk-grant');
        expect(computeArtifactGenerationDigest(reg)).toBe(before);
        fs.rmSync(path.join(reg.zkConfigPath, 'keys', 'attest.prover'));
        expect(computeArtifactGenerationDigest(reg)).toBe(before);
        const manifestPath = path.join(reg.zkConfigPath, 'keys', 'manifest.json');
        fs.writeFileSync(manifestPath, fs.readFileSync(manifestPath, 'utf8').replace('"bytes": 9', '"bytes": 10'));
        expect(computeArtifactGenerationDigest(reg)).not.toBe(before);
    });

    it('without a manifest the prover bytes stay in the digest', () => {
        const reg = artifact({ provers: { attest: 'pk-attest', grant: 'pk-grant' } });
        const before = computeArtifactGenerationDigest(reg);
        fs.writeFileSync(path.join(reg.zkConfigPath, 'keys', 'grant.prover'), 'pk-grant-2');
        expect(computeArtifactGenerationDigest(reg)).not.toBe(before);
    });

    it('a digest recorded before the manifest existed still matches as legacy', () => {
        const reg = artifact({ provers: { attest: 'pk-attest', grant: 'pk-grant' } });
        const recorded = computeArtifactGenerationDigest(reg);
        fs.writeFileSync(path.join(reg.zkConfigPath, 'keys', 'manifest.json'), JSON.stringify(buildProverKeyManifest(path.join(reg.zkConfigPath, 'keys'))));
        expect(computeArtifactGenerationDigest(reg)).not.toBe(recorded);
        expect(artifactGenerationMatch(reg, recorded)).toBe('legacy');
        expect(artifactGenerationMatch(reg, computeArtifactGenerationDigest(reg))).toBe('current');
        expect(artifactGenerationMatch(reg, 'ff'.repeat(32))).toBeNull();
    });

    it('proverKeyManifestProblems finds a key that drifted from the manifest, is silent without one', () => {
        const reg = artifact({ provers: { attest: 'pk-attest', grant: 'pk-grant' }, manifest: true });
        const keys = path.join(reg.zkConfigPath, 'keys');
        expect(proverKeyManifestProblems(keys)).toEqual([]);
        fs.writeFileSync(path.join(keys, 'grant.prover'), 'pk-grant-x');
        expect(proverKeyManifestProblems(keys)).toEqual([expect.stringMatching(/^grant: 10 bytes/)]);
        fs.writeFileSync(path.join(keys, 'extra.prover'), 'x');
        expect(proverKeyManifestProblems(keys)).toContain('extra: not listed in the manifest');
        expect(proverKeyManifestProblems(artifact({ provers: { attest: 'a' } }).zkConfigPath + '/keys')).toEqual([]);
    });
});
