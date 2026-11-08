// The wasm prover's standard keys and BLS parameters: downloaded and checked by the wallet SDK, kept on disk.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

const sdk = vi.hoisted(() => {
    const bytes = (s: string) => new Uint8Array(Buffer.from(s));
    const lookupKey = vi.fn(async (loc: string) => loc === 'midnight/zswap/spend'
        ? { proverKey: bytes('PK'), verifierKey: bytes('VK'), ir: bytes('IR') }
        : undefined);
    const getParams = vi.fn(async (k: number) => bytes(`PARAMS${k}`));
    const makeV9KeyMaterialProvider = vi.fn(() => ({ lookupKey, getParams }));
    return { lookupKey, getParams, makeV9KeyMaterialProvider };
});
vi.mock('@midnightntwrk/wallet-sdk-prover-client/effect', () => ({ WasmProver: { makeV9KeyMaterialProvider: sdk.makeV9KeyMaterialProvider } }));

const importModule = () => import('../../src/txbuilder/prover-material.mjs' as string);
const LEDGER_VERSION = JSON.parse(readFileSync(join(process.cwd(), 'node_modules/@midnightntwrk/ledger-v9/package.json'), 'utf8')).version;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const text = (b: Uint8Array) => Buffer.from(b).toString();

describe('txbuilder: prover material on disk', () => {
    let dir: string;
    let line: string;
    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'ng-pm-'));
        line = join(dir, 'ledger-v9', LEDGER_VERSION);
        vi.clearAllMocks();
    });
    afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

    it('downloads through the SDK once, keeps the bytes with their sha256 and serves the next process from disk', async () => {
        const { createProverMaterialProvider } = await importModule();
        const events: Record<string, unknown>[] = [];
        const first = createProverMaterialProvider({ dir, baseUrl: 'https://mirror.example/keys', onProgress: (e: Record<string, unknown>) => events.push(e) });
        const material = await first.lookupKey('midnight/zswap/spend');
        expect(text(material!.proverKey)).toBe('PK');
        expect(text(await first.getParams(14))).toBe('PARAMS14');
        await Promise.all([first.getParams(14), first.lookupKey('midnight/zswap/spend')]);
        expect(sdk.makeV9KeyMaterialProvider).toHaveBeenCalledWith({ source: 'https://mirror.example/keys' });
        expect(sdk.lookupKey).toHaveBeenCalledTimes(1);
        expect(sdk.getParams).toHaveBeenCalledTimes(1);
        expect(await readFile(join(line, 'zswap-spend.bzkir'), 'utf8')).toBe('IR');
        expect(await readFile(join(line, 'bls_midnight_2p14.sha256'), 'utf8')).toBe(sha('PARAMS14') + '\n');
        expect(events.filter(e => e.source === 'remote').map(e => e.file).sort()).toEqual(['bls_midnight_2p14', 'zswap-spend']);

        const events2: Record<string, unknown>[] = [];
        const second = createProverMaterialProvider({ dir, onProgress: (e: Record<string, unknown>) => events2.push(e) });
        expect(text(await second.getParams(14))).toBe('PARAMS14');
        expect(text((await second.lookupKey('midnight/zswap/spend'))!.verifierKey)).toBe('VK');
        expect(sdk.lookupKey).toHaveBeenCalledTimes(1);
        expect(sdk.getParams).toHaveBeenCalledTimes(1);
        expect(events2.every(e => e.source === 'local')).toBe(true);
    });

    it('downloads again a file whose bytes no longer match the recorded sha256', async () => {
        const { createProverMaterialProvider } = await importModule();
        await mkdir(line, { recursive: true });
        await writeFile(join(line, 'bls_midnight_2p14'), 'DAMAGED');
        await writeFile(join(line, 'bls_midnight_2p14.sha256'), sha('PARAMS14') + '\n');
        expect(text(await createProverMaterialProvider({ dir }).getParams(14))).toBe('PARAMS14');
        expect(sdk.getParams).toHaveBeenCalledTimes(1);
        expect(await readFile(join(line, 'bls_midnight_2p14'), 'utf8')).toBe('PARAMS14');
    });

    it('leaves a hash without a body alone: another builder is writing that file', async () => {
        const { createProverMaterialProvider } = await importModule();
        await mkdir(line, { recursive: true });
        const hashFile = join(line, 'bls_midnight_2p16.sha256');
        await writeFile(hashFile, sha('PARAMS16') + '\n');
        let hashSeen: string | undefined;
        sdk.getParams.mockImplementationOnce(async (k: number) => {
            hashSeen = await readFile(hashFile, 'utf8').catch(() => undefined);
            return new Uint8Array(Buffer.from(`PARAMS${k}`));
        });
        expect(text(await createProverMaterialProvider({ dir }).getParams(16))).toBe('PARAMS16');
        expect(hashSeen).toBe(sha('PARAMS16') + '\n');
    });

    it('keeps no failure: the next call asks the SDK again', async () => {
        const { createProverMaterialProvider } = await importModule();
        const provider = createProverMaterialProvider({ dir });
        sdk.getParams.mockRejectedValueOnce(new Error('srs answered 503'));
        await expect(provider.getParams(14)).rejects.toThrow(/503/);
        expect(text(await provider.getParams(14))).toBe('PARAMS14');
        expect(sdk.getParams).toHaveBeenCalledTimes(2);
    });

    it('answers nothing for an unknown key location and stores nothing', async () => {
        const { createProverMaterialProvider } = await importModule();
        expect(await createProverMaterialProvider({ dir }).lookupKey('contract:abc/attest?vk=1')).toBeUndefined();
        expect(sdk.lookupKey).not.toHaveBeenCalled();
        expect(await readdir(dir)).toEqual([]);
    });
});
