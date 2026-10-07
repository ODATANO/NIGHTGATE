/**
 * srv/midnight/decode-worker-client.ts: lazy start, one channel per call, timeouts, crash recovery.
 * The Worker is a fake; the real MessageChannel carries the replies.
 */

import { EventEmitter } from 'node:events';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@sap/cds', () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const cds: Record<string, unknown> = { log: () => logger };
    cds.default = cds;
    return cds;
});

type Reply = { ok: true; result: unknown } | { ok: false; error: Record<string, unknown> };

class FakeWorker extends EventEmitter {
    sent: Array<{ method: string; args: unknown }> = [];
    terminated = false;
    respond: (method: string, args: unknown) => Reply | undefined = defaultRespond;

    constructor(public readonly entry: string, public readonly opts: { workerData?: unknown }) {
        super();
        setImmediate(() => this.emit('message', { kind: 'ready' }));
    }

    postMessage(msg: { kind: string; method: string; args: unknown; port: { postMessage: (m: unknown) => void } }): void {
        this.sent.push({ method: msg.method, args: msg.args });
        const reply = this.respond(msg.method, msg.args);
        if (reply !== undefined) setImmediate(() => msg.port.postMessage(reply));
    }

    async terminate(): Promise<void> {
        this.terminated = true;
        this.emit('exit', 0);
    }
}

let workers: FakeWorker[] = [];
/** How a new fake worker answers; set before the call that starts it. */
let defaultRespond: FakeWorker['respond'] = () => undefined;

vi.mock('node:worker_threads', async () => {
    const actual = await vi.importActual<typeof import('node:worker_threads')>('node:worker_threads');
    return {
        ...actual,
        Worker: class {
            constructor(entry: string, opts: { workerData?: unknown }) {
                const w = new FakeWorker(entry, opts);
                workers.push(w);
                // eslint-disable-next-line no-constructor-return
                return w;
            }
        }
    };
});

import {
    readAttestationStateInWorker,
    decodeLedgerPayloadInWorker,
    getDecodeWorkerStatus,
    stopDecodeWorker,
    __resetDecodeWorkerForTests
} from '../../srv/midnight/decode-worker-client';
import { __resetConfigForTests } from '../../srv/utils/config';
import { isNightgateError } from '../../srv/utils/errors';

const ATTEST_ARGS = {
    contractAddress: '0xvault', attesterId: 'aa'.repeat(32), payloadHash: 'bb'.repeat(32),
    artifactPath: '/a/artifact.mjs', artifactDigest: 'd1',
    contractProvidersConfig: { indexerHttpUrl: 'http://i', indexerWsUrl: 'ws://i', proofServerUrl: 'http://p', zkConfigPath: '/z' }
};

beforeEach(async () => {
    workers = [];
    defaultRespond = () => undefined;
    await __resetDecodeWorkerForTests();
    process.env.NIGHTGATE_DECODE_WORKER_RPC_TIMEOUT_MS = '2000';
    __resetConfigForTests();
});
afterEach(async () => {
    await __resetDecodeWorkerForTests();
    delete process.env.NIGHTGATE_DECODE_WORKER_RPC_TIMEOUT_MS;
    __resetConfigForTests();
});

describe('decode worker client', () => {
    it('starts the worker on the first call, hands it the config, and returns the result', async () => {
        expect(getDecodeWorkerStatus().running).toBe(false);
        defaultRespond = () => ({ ok: true, result: { attested: true } });
        await expect(readAttestationStateInWorker(ATTEST_ARGS)).resolves.toEqual({ attested: true });
        expect(workers).toHaveLength(1);
        expect(workers[0].entry).toMatch(/decode-worker\.js$/);
        expect(workers[0].opts.workerData).toHaveProperty('config');
        expect(workers[0].sent.at(-1)).toEqual({ method: 'readAttestationState', args: ATTEST_ARGS });
        expect(getDecodeWorkerStatus().running).toBe(true);
    });

    it('rebuilds a coded error and keeps the name of a plain one', async () => {
        defaultRespond = () => ({ ok: false, error: { name: 'DeserializeError', message: 'no marker fits', causes: [] } });
        await expect(decodeLedgerPayloadInWorker(new Uint8Array([1]))).rejects.toMatchObject({ name: 'DeserializeError', message: 'no marker fits' });
        workers[0].respond = () => ({ ok: false, error: { name: 'NightgateError', message: 'gone', causes: [], nightgate: { code: 'NOT_FOUND', status: 404, message: 'gone', name: 'NightgateError' } } });
        const err = await decodeLedgerPayloadInWorker(new Uint8Array([1])).catch(e => e);
        expect(isNightgateError(err)).toBe(true);
        expect(err.code).toBe('NOT_FOUND');
    });

    it('times out a call the worker never answers', async () => {
        process.env.NIGHTGATE_DECODE_WORKER_RPC_TIMEOUT_MS = '1000';
        __resetConfigForTests();
        await expect(decodeLedgerPayloadInWorker(new Uint8Array([1]))).rejects.toThrow(/timed out after 1000ms/);
        expect(getDecodeWorkerStatus().inFlightRpcs).toBe(0);
    });

    it('rejects the calls in flight when the worker crashes and starts a new one on the next call', async () => {
        const pending = decodeLedgerPayloadInWorker(new Uint8Array([1]));
        await new Promise(r => setImmediate(r));
        workers[0].emit('exit', 1);
        await expect(pending).rejects.toThrow(/exited with code 1/);
        expect(getDecodeWorkerStatus()).toMatchObject({ running: false, exitCount: 1, lastExitCode: 1 });

        defaultRespond = () => ({ ok: true, result: { identifiers: [] } });
        await expect(decodeLedgerPayloadInWorker(new Uint8Array([2]))).resolves.toEqual({ identifiers: [] });
        expect(workers).toHaveLength(2);
    });

    it('a planned stop is not a crash', async () => {
        const pending = decodeLedgerPayloadInWorker(new Uint8Array([1]));
        await new Promise(r => setImmediate(r));
        await stopDecodeWorker();
        await expect(pending).rejects.toThrow(/stopped/);
        expect(getDecodeWorkerStatus()).toMatchObject({ running: false, exitCount: 0 });
        expect(workers[0].terminated).toBe(true);
    });
});
