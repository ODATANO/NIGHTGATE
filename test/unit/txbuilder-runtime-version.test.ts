/** `runtimeVersionProblem`: a lineage package built for another compact-runtime fails before proving (`src/txbuilder/index.mjs`). */

import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const importBuilder = () => import('../../src/txbuilder/index.mjs' as string);

describe('describeLocalZkAssets', () => {
    it('asks a ledger 8 package for no compiler manifest, and every other directory for one', async () => {
        const { describeLocalZkAssets } = await importBuilder();
        const dir = mkdtempSync(join(tmpdir(), 'zk-assets-'));
        try {
            mkdirSync(join(dir, 'keys'));
            mkdirSync(join(dir, 'zkir'));
            for (const file of ['keys/attest.verifier', 'keys/attest.prover', 'zkir/attest.bzkir']) writeFileSync(join(dir, file), '');
            await expect(describeLocalZkAssets(dir, ['attest'])).rejects.toThrow(/lacks compiler\/contract-manifest\.json/);
            await expect(describeLocalZkAssets(dir, ['attest'], ['attest'], { ledger8: true })).resolves.toMatchObject({ source: 'local' });
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('isLedger8ZkDir', () => {
    it('reads the runtime the compiler wrote, and takes a directory without one as not ledger 8', async () => {
        const { isLedger8ZkDir } = await importBuilder();
        const dir = mkdtempSync(join(tmpdir(), 'zk-era-'));
        try {
            expect(await isLedger8ZkDir(dir)).toBe(false);
            mkdirSync(join(dir, 'compiler'));
            writeFileSync(join(dir, 'compiler', 'contract-info.json'), JSON.stringify({ 'runtime-version': '0.21.0' }));
            expect(await isLedger8ZkDir(dir)).toBe(false);
            writeFileSync(join(dir, 'compiler', 'contract-info.json'), JSON.stringify({ 'runtime-version': '0.16.0' }));
            expect(await isLedger8ZkDir(dir)).toBe(true);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('explainPreForkMismatch', () => {
    class ContractTypeError extends Error {}
    const provider = (era: string | null) => ({ watchForDeployTxData: async () => { if (!era) throw new Error('down'); return { era }; } });

    it('names the cause when the keys of a contract from before the fork do not match', async () => {
        const { explainPreForkMismatch } = await importBuilder();
        const original = new ContractTypeError('mismatched');
        const explained = await explainPreForkMismatch(original, ContractTypeError, provider('v8'), 'ab');
        expect(explained.message).toMatch(/deployed before ledger 9/);
        expect(explained.cause).toBe(original);
    });

    it('keeps the error for a newer contract, another error and a failed read', async () => {
        const { explainPreForkMismatch } = await importBuilder();
        const mismatch = new ContractTypeError('mismatched');
        expect(await explainPreForkMismatch(mismatch, ContractTypeError, provider('v9'), 'ab')).toBe(mismatch);
        expect(await explainPreForkMismatch(mismatch, ContractTypeError, provider(null), 'ab')).toBe(mismatch);
        const other = new Error('other');
        expect(await explainPreForkMismatch(other, ContractTypeError, provider('v8'), 'ab')).toBe(other);
    });
});

describe('runtimeVersionProblem', () => {
    it('passes a package of the same major.minor and one that says nothing', async () => {
        const { runtimeVersionProblem } = await importBuilder();
        expect(runtimeVersionProblem({ compactRuntime: '0.16.0' }, '0.16.3')).toBeNull();
        expect(runtimeVersionProblem({ compactRuntime: '0.16.0' }, '0.16.0-rc.1')).toBeNull();
        expect(runtimeVersionProblem({}, '0.16.0')).toBeNull();
        expect(runtimeVersionProblem(undefined, '0.16.0')).toBeNull();
    });

    it('names both versions when the minor differs', async () => {
        const { runtimeVersionProblem } = await importBuilder();
        const problem = runtimeVersionProblem({ compactRuntime: '0.17.0' }, '0.16.0');
        expect(problem).toMatch(/compiled for compact-runtime 0\.17\.0/);
        expect(problem).toMatch(/runtime is 0\.16\.0/);
        expect(runtimeVersionProblem({ compactRuntime: '1.0.0' }, '0.16.0')).not.toBeNull();
    });

    it('defaults to the runtime this builder loaded', async () => {
        const { runtimeVersionProblem } = await importBuilder();
        const { versionString } = await import('@midnight-ntwrk/compact-runtime' as string);
        expect(runtimeVersionProblem({ compactRuntime: versionString })).toBeNull();
    });
});
