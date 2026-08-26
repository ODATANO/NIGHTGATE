/**
 * Runtime contract registration: validation, path containment, config-floor
 * protection, persistence, boot-time load. A tiny real artifact fixture in a
 * temp root drives the module import and the generation digest; the DB is a fake capturing CQN.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('@sap/cds', () => {
    const cds: any = {
        log: vi.fn(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() })),
        ql: {
            UPSERT: { into: (entity: string) => ({ entries: (row: any) => ({ UPSERT: { into: entity, entries: [row] } }) }) },
            DELETE: { from: (entity: string) => ({ where: (w: any) => ({ DELETE: { from: entity, where: w } }) }) },
            SELECT: { from: (entity: string) => ({ SELECT: { from: entity } }) }
        }
    };
    cds.default = cds;
    return cds;
});

import { clearRegistry, loadRegistryFromConfig, getContractRegistration, listRegisteredContracts, getArtifactGenerationDigest } from '../../srv/submission/contract-registry';
import {
    registerContractAtRuntime,
    unregisterContractAtRuntime,
    probeArtifactModule,
    loadPersistedRegistrations,
    validateRuntimeRegistration,
    listContracts,
    allowedContractRoots,
    ContractRegistrationError
} from '../../srv/submission/contract-registrations';

let root: string;
let outside: string;

function writeArtifact(dir: string, opts: { prover?: boolean; noVerifier?: boolean; body?: string } = {}) {
    fs.mkdirSync(path.join(dir, 'keys'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'zkir'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'contract'), { recursive: true });
    if (!opts.noVerifier) fs.writeFileSync(path.join(dir, 'keys', 'attest.verifier'), 'vk-bytes');
    if (opts.prover) fs.writeFileSync(path.join(dir, 'keys', 'attest.prover'), 'pk-bytes');
    fs.writeFileSync(path.join(dir, 'zkir', 'attest.zkir'), 'zkir');
    fs.writeFileSync(path.join(dir, 'contract', 'index.cjs'), opts.body ?? 'exports.Contract = class Contract {};\n');
    return { artifactPath: path.join(dir, 'contract', 'index.cjs'), zkConfigPath: dir };
}

function fakeDb() {
    const queries: any[] = [];
    let rows: any[] = [];
    return {
        queries,
        setRows(r: any[]) { rows = r; },
        run: vi.fn(async (q: any) => {
            queries.push(q);
            if (q?.SELECT) return rows;
            if (q?.DELETE) return 1;
            return 1;
        })
    };
}

beforeEach(() => {
    clearRegistry();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ng-contracts-'));
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ng-outside-'));
    process.env.NIGHTGATE_CONTRACTS_DIR = root;
});
afterEach(() => {
    delete process.env.NIGHTGATE_CONTRACTS_DIR;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
});

describe('allowedContractRoots', () => {
    it('reads NIGHTGATE_CONTRACTS_DIR (path-delimited) and defaults to the package and cwd contracts/', () => {
        expect(allowedContractRoots()).toEqual([path.resolve(root)]);
        process.env.NIGHTGATE_CONTRACTS_DIR = `${root}${path.delimiter}${outside}`;
        expect(allowedContractRoots()).toEqual([path.resolve(root), path.resolve(outside)]);
        delete process.env.NIGHTGATE_CONTRACTS_DIR;
        expect(allowedContractRoots().every(r => r.endsWith('contracts'))).toBe(true);
    });
});

describe('validateRuntimeRegistration', () => {
    it('accepts a real artifact inside the root and reports prover-key presence', async () => {
        const a = writeArtifact(path.join(root, 'vault'), { prover: true });
        const v = await validateRuntimeRegistration({ name: 'customer-vault', privateStateId: 'ps', ...a });
        expect(v.artifactPath).toBe(fs.realpathSync(a.artifactPath));
        expect(v.hasProverKeys).toBe(true);
        const b = writeArtifact(path.join(root, 'vk-only'));
        expect((await validateRuntimeRegistration({ name: 'x', privateStateId: 'ps', ...b })).hasProverKeys).toBe(false);
    });

    it('relative paths resolve against the first root', async () => {
        writeArtifact(path.join(root, 'rel'));
        const v = await validateRuntimeRegistration({ name: 'rel', privateStateId: 'ps', artifactPath: 'rel/contract/index.cjs', zkConfigPath: 'rel' });
        expect(v.zkConfigPath).toBe(fs.realpathSync(path.join(root, 'rel')));
    });

    it('refuses a path outside NIGHTGATE_CONTRACTS_DIR (importing an artifact executes it)', async () => {
        const a = writeArtifact(path.join(outside, 'evil'));
        await expect(validateRuntimeRegistration({ name: 'evil', privateStateId: 'ps', ...a }))
            .rejects.toMatchObject({ httpStatus: 400, message: expect.stringMatching(/inside NIGHTGATE_CONTRACTS_DIR/) });
        // Traversal out of the root is the same refusal.
        await expect(validateRuntimeRegistration({ name: 'evil', privateStateId: 'ps', artifactPath: `../${path.basename(outside)}/evil/contract/index.cjs`, zkConfigPath: `../${path.basename(outside)}/evil` }))
            .rejects.toMatchObject({ httpStatus: 400 });
    });

    it('refuses bad names, widths, missing assets, and a module without a Contract class', async () => {
        const a = writeArtifact(path.join(root, 'ok'));
        await expect(validateRuntimeRegistration({ name: 'Bad Name', privateStateId: 'ps', ...a })).rejects.toThrow(/name must match/);
        await expect(validateRuntimeRegistration({ name: 'ok', privateStateId: '', ...a })).rejects.toThrow(/privateStateId/);
        await expect(validateRuntimeRegistration({ name: 'ok', privateStateId: 'ps', slotWidth: 64, ...a })).rejects.toThrow(/slotWidth/);
        await expect(validateRuntimeRegistration({ name: 'ok', privateStateId: 'ps', artifactPath: a.artifactPath, zkConfigPath: path.join(root, 'nope') })).rejects.toThrow(/does not exist/);
        const noVk = writeArtifact(path.join(root, 'novk'), { noVerifier: true });
        await expect(validateRuntimeRegistration({ name: 'novk', privateStateId: 'ps', ...noVk })).rejects.toThrow(/verifier keys/);
        const noClass = writeArtifact(path.join(root, 'noclass'), { body: 'exports.nothing = 1;\n' });
        await expect(validateRuntimeRegistration({ name: 'noclass', privateStateId: 'ps', ...noClass })).rejects.toThrow(/Contract/);
        const broken = writeArtifact(path.join(root, 'broken'), { body: 'throw new Error("boom at import");\n' });
        await expect(validateRuntimeRegistration({ name: 'broken', privateStateId: 'ps', ...broken })).rejects.toThrow(/does not import/);
    });
});

describe('registerContractAtRuntime / unregisterContractAtRuntime', () => {
    it('registers in memory with a generation digest and persists the row', async () => {
        const a = writeArtifact(path.join(root, 'vault'), { prover: true });
        const db = fakeDb();
        const out = await registerContractAtRuntime(db, { name: 'customer-vault', privateStateId: 'ps', slotWidth: 32, ...a }, { registeredBy: 'admin-1', networkId: 'preprod' });
        expect(out).toMatchObject({ name: 'customer-vault', source: 'runtime', slotWidth: 32, hasProverKeys: true });
        expect(out.artifactDigest).toBe(getArtifactGenerationDigest('customer-vault'));
        expect(getContractRegistration('customer-vault')?.slotWidth).toBe(32);
        const upsert = db.queries.find(q => q.UPSERT);
        expect(upsert.UPSERT.into).toBe('midnight.ContractRegistrations');
        expect(upsert.UPSERT.entries[0]).toMatchObject({ name: 'customer-vault', slotWidth: 32, registeredBy: 'admin-1', networkId: 'preprod' });
        expect(listContracts()).toEqual([expect.objectContaining({ name: 'customer-vault', source: 'runtime' })]);
    });

    it('refuses to shadow a config contract (409): the config is the immutable floor', async () => {
        const cfg = writeArtifact(path.join(root, 'floor'));
        loadRegistryFromConfig({ contracts: { floor: { artifactPath: cfg.artifactPath, zkConfigPath: cfg.zkConfigPath, privateStateId: 'p' } } });
        const db = fakeDb();
        const a = writeArtifact(path.join(root, 'other'));
        await expect(registerContractAtRuntime(db, { name: 'floor', privateStateId: 'ps', ...a })).rejects.toMatchObject({ httpStatus: 409 });
        await expect(unregisterContractAtRuntime(db, 'floor')).rejects.toMatchObject({ httpStatus: 409 });
        expect(db.queries).toHaveLength(0);
        expect(listContracts()).toEqual([expect.objectContaining({ name: 'floor', source: 'config' })]);
    });

    it('a failed validation changes nothing; a failed persist rolls the registry back', async () => {
        const db = fakeDb();
        await expect(registerContractAtRuntime(db, { name: 'ghost', privateStateId: 'ps', artifactPath: 'ghost/contract/index.cjs', zkConfigPath: 'ghost' }))
            .rejects.toBeInstanceOf(ContractRegistrationError);
        expect(listRegisteredContracts()).toEqual([]);

        const a = writeArtifact(path.join(root, 'v1'));
        db.run.mockRejectedValueOnce(new Error('disk full'));
        await expect(registerContractAtRuntime(db, { name: 'v', privateStateId: 'ps', ...a })).rejects.toThrow(/disk full/);
        expect(listRegisteredContracts()).toEqual([]);
    });

    it('re-registering a runtime name under a new artifact is a NEW generation', async () => {
        const db = fakeDb();
        const a = writeArtifact(path.join(root, 'v1'));
        const first = await registerContractAtRuntime(db, { name: 'v', privateStateId: 'ps', ...a });
        const b = writeArtifact(path.join(root, 'v2'), { body: 'exports.Contract = class Contract { v2() {} };\n' });
        const second = await registerContractAtRuntime(db, { name: 'v', privateStateId: 'ps', ...b });
        expect(second.artifactDigest).not.toBe(first.artifactDigest);
        expect(getContractRegistration('v')?.artifactPath).toBe(fs.realpathSync(b.artifactPath));
    });

    // Two requests on one alias run serialized; a failed request's rollback leaves the other's registration in place.
    it('serializes concurrent registrations of one name: a failed request cannot roll back the other', async () => {
        const db = fakeDb();
        const a = writeArtifact(path.join(root, 'v1'));
        const b = writeArtifact(path.join(root, 'v2'), { body: 'exports.Contract = class Contract { v2() {} };\n' });
        // first UPSERT fails slowly, the second one succeeds
        db.run.mockImplementationOnce((q: any) => new Promise<any>((_, rej) => { db.queries.push(q); setTimeout(() => rej(new Error("disk full")), 30); }));
        const [first, second] = await Promise.allSettled([
            registerContractAtRuntime(db, { name: 'v', privateStateId: 'ps', ...a }),
            registerContractAtRuntime(db, { name: 'v', privateStateId: 'ps', ...b })
        ]);
        expect(first.status).toBe('rejected');
        expect(second.status).toBe('fulfilled');
        expect(getContractRegistration('v')?.artifactPath).toBe(fs.realpathSync(b.artifactPath));
        expect(listRegisteredContracts()).toEqual(['v']);
        expect(getArtifactGenerationDigest('v')).toBe((second as PromiseFulfilledResult<any>).value.artifactDigest);
    });

    it('an in-place revision under the SAME path is validated as itself, not as the cached module', async () => {
        const db = fakeDb();
        const a = writeArtifact(path.join(root, 'same'));
        await registerContractAtRuntime(db, { name: 's', privateStateId: 'ps', ...a });
        // overwrite the module in place with one that no longer exports a Contract class
        fs.writeFileSync(a.artifactPath, 'exports.NotAContract = 1;\n');
        await expect(registerContractAtRuntime(db, { name: 's', privateStateId: 'ps', ...a })).rejects.toThrow(/does not export a Compact `Contract` class/);
    });

    // Relative paths are tried under every allowed root; roots are canonicalized, so a junction/symlink root works.
    it('a relative artifact path under the SECOND root registers; roots through a symlink are accepted', async () => {
        const rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'ng-roots-a-'));
        const rootB = fs.mkdtempSync(path.join(os.tmpdir(), 'ng-roots-b-'));
        const linkToB = path.join(os.tmpdir(), `ng-roots-link-${process.pid}-${Date.now()}`);
        fs.symlinkSync(rootB, linkToB, process.platform === 'win32' ? 'junction' : 'dir');
        const saved = process.env.NIGHTGATE_CONTRACTS_DIR;
        try {
            const b = writeArtifact(path.join(rootB, 'second'), { prover: true });
            // rootB is only reachable through the link: canonical roots still contain the real path
            process.env.NIGHTGATE_CONTRACTS_DIR = [rootA, linkToB].join(path.delimiter);
            const db = fakeDb();
            const out = await registerContractAtRuntime(db, { name: 'in-second-root', privateStateId: 'ps', artifactPath: 'second/contract/index.cjs', zkConfigPath: 'second' });
            expect(out.artifactPath).toBe(fs.realpathSync(b.artifactPath));
            expect(out.source).toBe('runtime');
        } finally {
            if (saved === undefined) delete process.env.NIGHTGATE_CONTRACTS_DIR; else process.env.NIGHTGATE_CONTRACTS_DIR = saved;
            fs.rmSync(linkToB, { recursive: true, force: true });
            fs.rmSync(rootA, { recursive: true, force: true });
            fs.rmSync(rootB, { recursive: true, force: true });
        }
    });

    it('a regular FILE named zkir does not pass validation', async () => {
        const a = writeArtifact(path.join(root, 'zkir-file'));
        fs.rmSync(path.join(a.zkConfigPath, 'zkir'), { recursive: true, force: true });
        fs.writeFileSync(path.join(a.zkConfigPath, 'zkir'), 'not a directory');
        await expect(validateRuntimeRegistration({ name: 'zkir-file', privateStateId: 'ps', ...a })).rejects.toMatchObject({ httpStatus: 400, message: expect.stringMatching(/no zkir\/ directory/) });
    });

    it('a worker that cannot even be constructed reports the error instead of a ReferenceError from the timer', async () => {
        // a function in workerData is not structured-cloneable: the Worker constructor throws synchronously
        const out = await probeArtifactModule({ toString() { return 'x'; }, fn() { /* not cloneable */ } } as any);
        expect(out.ok).toBe(false);
        expect(String(out.error)).not.toMatch(/ReferenceError|before initialization/);
    });

    it('validation imports the artifact in a disposable worker: no module of it stays in this process', async () => {
        const a = writeArtifact(path.join(root, 'probe'));
        const probe = await probeArtifactModule(a.artifactPath);
        expect(probe).toEqual({ ok: true, hasContract: true, error: undefined });
        fs.writeFileSync(a.artifactPath, 'exports.NotAContract = 1;\n');
        expect(await probeArtifactModule(a.artifactPath)).toMatchObject({ ok: true, hasContract: false });
        fs.writeFileSync(a.artifactPath, 'this is not javascript (\n');
        expect(await probeArtifactModule(a.artifactPath)).toMatchObject({ ok: false, hasContract: false });
        expect(await probeArtifactModule(path.join(root, 'missing.cjs'))).toMatchObject({ ok: false });
    });

    it('unregister removes memory + row', async () => {
        const db = fakeDb();
        const a = writeArtifact(path.join(root, 'v1'));
        await registerContractAtRuntime(db, { name: 'v', privateStateId: 'ps', ...a });
        expect(await unregisterContractAtRuntime(db, 'v')).toEqual({ removed: true });
        expect(listRegisteredContracts()).toEqual([]);
        expect(db.queries.find(q => q.DELETE).DELETE).toMatchObject({ from: 'midnight.ContractRegistrations', where: { name: 'v' } });
    });
});

describe('loadPersistedRegistrations (boot)', () => {
    it('loads valid rows after the config, skips shadowing and broken rows, never throws', async () => {
        const cfg = writeArtifact(path.join(root, 'floor'));
        loadRegistryFromConfig({ contracts: { floor: { artifactPath: cfg.artifactPath, zkConfigPath: cfg.zkConfigPath, privateStateId: 'p' } } });
        const good = writeArtifact(path.join(root, 'good'));
        const db = fakeDb();
        db.setRows([
            { name: 'good', artifactPath: good.artifactPath, zkConfigPath: good.zkConfigPath, privateStateId: 'ps', slotWidth: 16 },
            { name: 'floor', artifactPath: good.artifactPath, zkConfigPath: good.zkConfigPath, privateStateId: 'ps' },
            { name: 'gone', artifactPath: path.join(root, 'gone', 'contract', 'index.cjs'), zkConfigPath: path.join(root, 'gone'), privateStateId: 'ps' }
        ]);
        expect(await loadPersistedRegistrations(db)).toEqual(['good']);
        expect(listContracts().map(c => `${c.name}:${c.source}`).sort()).toEqual(['floor:config', 'good:runtime']);
        expect(getContractRegistration('floor')?.artifactPath).toBe(cfg.artifactPath);

        const failing = fakeDb();
        failing.run.mockRejectedValueOnce(new Error('no such table'));
        expect(await loadPersistedRegistrations(failing)).toEqual([]);
    });
});
