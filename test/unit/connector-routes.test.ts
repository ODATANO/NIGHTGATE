import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
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
});
