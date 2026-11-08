import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Writable } from 'stream';
import { mountZkConfigRoute } from '../../src/connector-routes';
import { registerContract, unregisterContract } from '../../srv/submission/contract-registry';

const NAME = 'route-test-vault';
let dir: string;

/** The handler registered for `route`, called with a fake request and response. */
function call(route: string, params: Record<string, string>): { status: number; body: any } {
    const handlers = new Map<string, (req: any, res: any) => void>();
    mountZkConfigRoute({ get: (paths: string | string[], fn: any) => { for (const p of [paths].flat()) handlers.set(p, fn); } });
    const out = { status: 200, body: undefined as any };
    const res = {
        setHeader: () => undefined,
        status(code: number) { out.status = code; return res; },
        end() { return res; },
        json(body: unknown) { out.body = body; return res; }
    };
    handlers.get(route)!({ params, headers: {} }, res);
    return out;
}

/** The file handler, with a response that collects the piped bytes. */
function serve(params: Record<string, string>): Promise<{ status: number; body: string; headers: Record<string, string> }> {
    const handlers = new Map<string, (req: any, res: any) => void>();
    mountZkConfigRoute({ get: (paths: string | string[], fn: any) => { for (const p of [paths].flat()) handlers.set(p, fn); } });
    return new Promise((resolve) => {
        const chunks: Buffer[] = [];
        const headers: Record<string, string> = {};
        let status = 200;
        let done = false;
        const finish = () => { if (!done) { done = true; resolve({ status, body: Buffer.concat(chunks).toString('utf8'), headers }); } };
        const res: any = new Writable({ write(chunk, _enc, cb) { chunks.push(Buffer.from(chunk)); cb(); } });
        res.setHeader = (k: string, v: string) => { headers[k] = v; };
        res.status = (code: number) => { status = code; return res; };
        res.json = () => res;
        res.on('finish', finish);
        handlers.get('/zk-config/:contract/:dir/:file')!({ params, headers: {} }, res);
    });
}

describe('zk-config contract index', () => {
    beforeAll(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zkcfg-'));
        fs.mkdirSync(path.join(dir, 'keys'));
        fs.mkdirSync(path.join(dir, 'zkir'));
        for (const f of ['attest.verifier', 'attest.prover', 'manifest.json', 'notes.txt']) fs.writeFileSync(path.join(dir, 'keys', f), 'x');
        fs.writeFileSync(path.join(dir, 'zkir', 'attest.bzkir'), 'x');
        registerContract(NAME, { artifactPath: path.join(dir, 'index.cjs'), privateStateId: 'ps', zkConfigPath: dir });
    });
    afterAll(() => {
        unregisterContract(NAME);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('lists the circuits and the served files of a registered contract', () => {
        const { status, body } = call('/zk-config/:contract', { contract: NAME });
        expect(status).toBe(200);
        expect(body).toEqual({
            contract: NAME,
            circuits: ['attest'],
            files: { keys: ['attest.prover', 'attest.verifier', 'manifest.json'], zkir: ['attest.bzkir'] }
        });
    });

    it('answers 404 for a contract that is not registered', () => {
        expect(call('/zk-config/:contract/', { contract: 'nope' }).status).toBe(404);
    });

    it('serves compiler/contract-manifest.json once the contract has one, and nothing else from compiler/', async () => {
        // midnight-js verifies every key against this file, so a builder that downloads keys needs it too.
        expect((await serve({ contract: NAME, dir: 'compiler', file: 'contract-manifest.json' })).status).toBe(404);
        fs.mkdirSync(path.join(dir, 'compiler'));
        fs.writeFileSync(path.join(dir, 'compiler', 'contract-manifest.json'), '{"manifest-version":"1"}');
        fs.writeFileSync(path.join(dir, 'compiler', 'contract-info.json'), '{}');
        expect(call('/zk-config/:contract', { contract: NAME }).body.files.compiler).toEqual(['contract-manifest.json']);
        const served = await serve({ contract: NAME, dir: 'compiler', file: 'contract-manifest.json' });
        expect(served).toMatchObject({ status: 200, body: '{"manifest-version":"1"}' });
        expect(served.headers['Content-Type']).toBe('application/json');
        expect((await serve({ contract: NAME, dir: 'compiler', file: 'contract-info.json' })).status).toBe(404);
        expect((await serve({ contract: NAME, dir: 'keys', file: 'contract-manifest.json' })).status).toBe(404);
        expect((await serve({ contract: NAME, dir: 'keys', file: 'attest.verifier' })).status).toBe(200);
    });
});
