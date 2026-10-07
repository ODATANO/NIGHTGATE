/**
 * srv/midnight/worker-rpc/client.ts: the parts the decode client test does not reach through its
 * wrappers: a timed-out call ends the thread when asked, unref, log forwarding, worker data per start.
 * The Worker is a fake; the real MessageChannel carries the replies.
 */

import { EventEmitter } from 'node:events';
import { describe, it, expect, beforeEach, vi } from 'vitest';

type Reply = { ok: true; result: unknown } | { ok: false; error: Record<string, unknown> };

class FakeWorker extends EventEmitter {
    sent: Array<{ method: string; args: unknown }> = [];
    terminated = false;
    unrefed = false;
    respond: (method: string, args: unknown) => Reply | undefined = () => undefined;

    constructor(public readonly entry: string, public readonly opts: { workerData?: unknown }) {
        super();
        setImmediate(() => this.emit('message', { kind: 'ready' }));
    }

    postMessage(msg: { kind: string; method: string; args: unknown; port: { postMessage: (m: unknown) => void } }): void {
        this.sent.push({ method: msg.method, args: msg.args });
        const reply = this.respond(msg.method, msg.args);
        if (reply !== undefined) setImmediate(() => msg.port.postMessage(reply));
    }

    unref(): void { this.unrefed = true; }

    async terminate(): Promise<void> {
        this.terminated = true;
        this.emit('exit', 0);
    }
}

let workers: FakeWorker[] = [];

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

import { WorkerRpcClient } from '../../srv/midnight/worker-rpc/client';

beforeEach(() => { workers = []; });

function clientWith(overrides: Partial<ConstructorParameters<typeof WorkerRpcClient>[0]> = {}) {
    const log = vi.fn();
    let starts = 0;
    const client = new WorkerRpcClient({
        name: 'helper',
        entry: '/x/helper.js',
        workerData: () => ({ start: ++starts }),
        log,
        timeoutMs: () => 50,
        ...overrides
    });
    return { client, log };
}

describe('WorkerRpcClient', () => {
    it('builds the worker data per start and unrefs the thread when asked', async () => {
        const { client } = clientWith({ unref: true });
        workers.length = 0;
        const started = client.start();
        await started;
        expect(workers[0].opts.workerData).toEqual({ start: 1 });
        expect(workers[0].unrefed).toBe(true);
        await client.stop();
        await client.start();
        expect(workers[1].opts.workerData).toEqual({ start: 2 });
    });

    it('forwards the worker log lines under its name', async () => {
        const { client, log } = clientWith();
        await client.start();
        workers[0].emit('message', { kind: 'log', level: 'warn', message: 'slow' });
        workers[0].emit('message', { kind: 'log', level: 'nonsense', message: 'x' });
        expect(log).toHaveBeenCalledWith('warn', '[helper] slow');
        expect(log).toHaveBeenCalledWith('info', '[helper] x');
    });

    it('a timed-out call ends the thread with terminateOnTimeout, and the next call starts a new one', async () => {
        const { client, log } = clientWith({ terminateOnTimeout: true });
        await expect(client.rpc('verify', { a: 1 })).rejects.toThrow(/timed out after 50ms/);
        await new Promise(r => setImmediate(r));
        expect(workers[0].terminated).toBe(true);
        expect(client.status()).toMatchObject({ running: false, exitCount: 0, inFlightRpcs: 0 });
        expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('ran past 50ms'));

        workers.length = 0;
        const ready = client.start();
        await ready;
        workers[0].respond = () => ({ ok: true, result: 'fresh' });
        await expect(client.rpc('verify', {})).resolves.toBe('fresh');
    });

    it('a timed-out call leaves the thread alone without terminateOnTimeout', async () => {
        const { client } = clientWith();
        await expect(client.rpc('verify', {})).rejects.toThrow(/timed out/);
        expect(workers[0].terminated).toBe(false);
        expect(client.status().running).toBe(true);
    });

    it('a crash rejects the calls in flight and counts as an exit; a stop does not', async () => {
        const { client } = clientWith({ timeoutMs: () => 5000 });
        const pending = client.rpc('verify', {});
        await new Promise(r => setImmediate(r));
        workers[0].emit('exit', 7);
        await expect(pending).rejects.toThrow(/exited with code 7/);
        expect(client.status()).toMatchObject({ running: false, exitCount: 1, lastExitCode: 7 });

        const again = client.rpc('verify', {});
        await new Promise(r => setImmediate(r));
        await client.stop();
        await expect(again).rejects.toThrow(/stopped/);
        expect(client.status().exitCount).toBe(1);
    });
});
