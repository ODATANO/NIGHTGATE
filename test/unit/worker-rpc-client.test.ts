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
    /** Ports of the calls this worker received, in order; a test starts and answers them by hand. */
    ports: Array<{ postMessage: (m: unknown) => void }> = [];
    terminated = false;
    unrefed = false;
    respond: (method: string, args: unknown) => Reply | undefined = () => undefined;

    constructor(public readonly entry: string, public readonly opts: { workerData?: unknown }) {
        super();
        setImmediate(() => this.emit('message', { kind: 'ready' }));
    }

    postMessage(msg: { kind: string; method: string; args: unknown; port: { postMessage: (m: unknown) => void } }): void {
        this.sent.push({ method: msg.method, args: msg.args });
        this.ports.push(msg.port);
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

/** Settles either way, so a rejection that lands before the assertion is not an unhandled one. */
function outcome<T>(p: Promise<T>): Promise<{ value?: T; error?: Error }> {
    return p.then(value => ({ value }), (error: Error) => ({ error }));
}

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

    it('with budgetFromStart the timeout runs from the worker\'s start signal, not from the send', async () => {
        const { client } = clientWith({ budgetFromStart: true, timeoutMs: () => 60 });
        const first = outcome(client.rpc('verify', { n: 1 }));
        const second = client.rpc('verify', { n: 2 });
        await new Promise(r => setImmediate(r));
        expect(workers[0].sent.map(s => s.args)).toEqual([{ n: 1 }, { n: 2 }]);
        // Only the first call begins; the second waits in the helper's queue past the timeout unharmed.
        workers[0].ports[0].postMessage({ kind: 'started' });
        await new Promise(r => setTimeout(r, 100));
        expect(await first).toMatchObject({ error: expect.objectContaining({ message: expect.stringMatching(/timed out after 60ms/) }) });
        workers[0].ports[1].postMessage({ kind: 'started' });
        workers[0].ports[1].postMessage({ ok: true, result: 'second' });
        await expect(second).resolves.toBe('second');
    });

    it('a timeout restart sends the calls the worker had not begun to the new worker, once', async () => {
        const { client } = clientWith({ budgetFromStart: true, terminateOnTimeout: true, timeoutMs: () => 40 });
        const first = outcome(client.rpc('verify', { n: 1 }));
        const second = outcome(client.rpc('verify', { n: 2 }));
        const third = client.rpc('verify', { n: 3 });
        await new Promise(r => setImmediate(r));
        workers[0].ports[0].postMessage({ kind: 'started' });
        workers[0].ports[1].postMessage({ kind: 'started' });
        expect((await first).error?.message).toMatch(/timed out after 40ms/);
        // The second had begun too, so it dies with the thread; the third moves to the new worker.
        expect((await second).error?.message).toMatch(/stopped/);
        await new Promise(r => setImmediate(r));
        expect(workers).toHaveLength(2);
        expect(workers[1].sent.map(s => s.args)).toEqual([{ n: 3 }]);
        workers[1].ports[0].postMessage({ kind: 'started' });
        workers[1].ports[0].postMessage({ ok: true, result: 'third' });
        await expect(third).resolves.toBe('third');
        expect(client.status()).toMatchObject({ running: true, exitCount: 0, inFlightRpcs: 0 });
    });

    it('a call moved once is not moved again', async () => {
        const { client } = clientWith({ budgetFromStart: true, terminateOnTimeout: true, timeoutMs: () => 40 });
        const first = outcome(client.rpc('verify', { n: 1 }));
        const second = outcome(client.rpc('verify', { n: 2 }));
        await new Promise(r => setImmediate(r));
        workers[0].ports[0].postMessage({ kind: 'started' });
        expect((await first).error?.message).toMatch(/timed out/);
        await new Promise(r => setImmediate(r));
        expect(workers[1].sent.map(s => s.args)).toEqual([{ n: 2 }]);
        // Another call times out on the new worker before the moved one begins.
        const blocker = outcome(client.rpc('verify', { n: 9 }));
        await new Promise(r => setImmediate(r));
        workers[1].ports[1].postMessage({ kind: 'started' });
        expect((await blocker).error?.message).toMatch(/timed out/);
        expect((await second).error?.message).toMatch(/stopped/);
        expect(workers).toHaveLength(2);
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
