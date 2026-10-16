/**
 * The worker pool of srv/midnight/wallet-worker-client.ts: a wallet always lands in the same
 * worker, a pool sponsor can get a worker of its own, a call that needs two wallets in two
 * workers is refused before any work, and one worker's crash takes only its own wallets with it.
 */

import { EventEmitter } from 'node:events';

class FakeWorker extends EventEmitter {
    sent: any[] = [];
    terminated = false;
    constructor(public readonly entry: string, public readonly opts?: any) {
        super();
        setImmediate(() => this.emit('message', { kind: 'ready' }));
    }
    postMessage(msg: any): void {
        this.sent.push(msg);
        if (msg?.kind === 'rpc' && msg.port) {
            // answers every call with the worker id it ran in, unless a test holds the port
            if (!held.has(msg.method)) setImmediate(() => msg.port.postMessage({ ok: true, result: { ranIn: this.opts?.workerData?.workerId, method: msg.method } }));
        }
    }
    async terminate(): Promise<void> { this.terminated = true; this.emit('exit', 0); }
    off(event: string, listener: (...args: any[]) => void): this { return this.removeListener(event, listener); }
}
const held = new Set<string>();
const workers: FakeWorker[] = [];

vi.mock('node:worker_threads', async () => {
    const actual = await vi.importActual('node:worker_threads');
    return {
        ...actual,
        Worker: class {
            constructor(entry: string, opts?: unknown) {
                const w = new FakeWorker(entry, opts);
                workers.push(w);
                // eslint-disable-next-line no-constructor-return
                return w as any;
            }
        }
    };
});

import {
    __resetWalletWorkerForTests, assignDedicatedWorker, getWalletWorkerStatus, onWorkerGone, setStateSaveSink,
    startWalletWorker, walletGetBalance, walletGetSyncProgress, walletInit, walletSponsorUnboundTx, walletSubmitContractCall,
    walletWorkerPoolConfig, workerIdFor
} from '../../srv/midnight/wallet-worker-client';
import { isNightgateError } from '../../srv/utils/errors';

const byId = (id: string) => workers.find(w => w.opts?.workerData?.workerId === id);
const flush = () => new Promise(r => setImmediate(r));

describe('wallet worker pool', () => {
    beforeEach(() => {
        __resetWalletWorkerForTests();
        workers.length = 0;
        held.clear();
        delete process.env.NIGHTGATE_WALLET_WORKERS;
        delete process.env.NIGHTGATE_SPONSOR_WORKERS;
    });
    afterEach(() => {
        delete process.env.NIGHTGATE_WALLET_WORKERS;
        delete process.env.NIGHTGATE_SPONSOR_WORKERS;
    });

    it('defaults to one shared worker: every wallet routes to user-0', () => {
        expect(walletWorkerPoolConfig()).toEqual({ walletWorkers: 1, sponsorWorkers: 'shared' });
        expect(workerIdFor('acct-a')).toBe('user-0');
        expect(workerIdFor('acct-b')).toBe('user-0');
        expect(workerIdFor()).toBe('user-0');
        assignDedicatedWorker('sponsor-1');
        expect(workerIdFor('sponsor-1')).toBe('user-0');
    });

    it('with several user workers a wallet always lands in the same one, and calls without a wallet in the first', () => {
        process.env.NIGHTGATE_WALLET_WORKERS = '3';
        const keys = Array.from({ length: 40 }, (_, i) => `acct-${i}`);
        const first = keys.map(workerIdFor);
        expect(keys.map(workerIdFor)).toEqual(first);
        expect(new Set(first).size).toBeGreaterThan(1);
        for (const id of first) expect(id).toMatch(/^user-[0-2]$/);
        expect(workerIdFor()).toBe('user-0');
    });

    it('a dedicated sponsor gets a worker of its own; a wallet that already lives somewhere keeps its worker', async () => {
        process.env.NIGHTGATE_SPONSOR_WORKERS = 'dedicated';
        await startWalletWorker();
        // the first user worker reports a wallet; it is not moved afterwards
        byId('user-0')!.emit('message', { kind: 'sync-progress', sessionId: 'acct-resident', snapshot: { sessionId: 'acct-resident', caughtUp: true, label: 'r', updatedAt: 'now' } });
        assignDedicatedWorker('acct-resident');
        expect(workerIdFor('acct-resident')).toBe('user-0');

        assignDedicatedWorker('sponsor-aaaaaaaaaaaaaaaaaaaa');
        expect(workerIdFor('sponsor-aaaaaaaaaaaaaaaaaaaa')).toBe('sponsor-sponsor-aaaaaaaa');
        // the sponsor worker starts on its first call, and pool jobs reach it by the sponsor's key alone
        const r: any = await walletSponsorUnboundTx({ sponsorSessionId: 'sponsor-aaaaaaaaaaaaaaaaaaaa', unboundTxB64: 'AAAA', networkId: 'preprod' });
        expect(r.ranIn).toBe('sponsor-sponsor-aaaaaaaa');
        expect(workers.map(w => w.opts.workerData.workerId)).toEqual(['user-0', 'sponsor-sponsor-aaaaaaaa']);
        const status = getWalletWorkerStatus();
        expect(status.pool.sponsorWorkers).toBe('dedicated');
        expect(status.workers.map(w => w.id)).toEqual(['user-0', 'sponsor-sponsor-aaaaaaaa']);
        expect(status.running).toBe(true);
    });

    it('a bound call whose sponsor lives in another worker is refused with 412 before anything runs', async () => {
        process.env.NIGHTGATE_SPONSOR_WORKERS = 'dedicated';
        await startWalletWorker();
        assignDedicatedWorker('sponsor-b');
        const call = walletSubmitContractCall({
            sessionId: 'acct-user', proxyId: 'p', contractName: 'c', registration: { artifactPath: 'a', privateStateId: 'ps', zkConfigPath: 'z' },
            contractAddress: 'addr', circuit: 'x', args: [], indexerHttpUrl: 'h', indexerWsUrl: 'w', proofServerUrl: 'p', networkId: 'preprod',
            sponsorSessionId: 'sponsor-b'
        } as any);
        await expect(call).rejects.toSatisfy((e: unknown) => isNightgateError(e) && e.code === 'PRECONDITION_FAILED' && /NIGHTGATE_SPONSOR_WORKERS=shared/.test(e.message));
        expect(workers).toHaveLength(1);
        expect(byId('user-0')!.sent.filter(m => m.kind === 'rpc')).toHaveLength(0);
    });

    it('with two user workers, two wallets in different workers run side by side', async () => {
        process.env.NIGHTGATE_WALLET_WORKERS = '2';
        await startWalletWorker();
        const keys = ['acct-1', 'acct-2', 'acct-3', 'acct-4', 'acct-5'];
        const other = keys.find(k => workerIdFor(k) === 'user-1')!;
        const mine = keys.find(k => workerIdFor(k) === 'user-0')!;
        const [a, b]: any[] = await Promise.all([
            walletGetBalance({ sessionId: mine }),
            walletGetBalance({ sessionId: other })
        ]);
        expect(a.ranIn).toBe('user-0');
        expect(b.ranIn).toBe('user-1');
        expect(workers).toHaveLength(2);
    });

    it("one worker's crash clears only its wallets and rejects only its calls", async () => {
        process.env.NIGHTGATE_WALLET_WORKERS = '2';
        await startWalletWorker();
        const keys = ['acct-1', 'acct-2', 'acct-3', 'acct-4', 'acct-5'];
        const inZero = keys.find(k => workerIdFor(k) === 'user-0')!;
        const inOne = keys.find(k => workerIdFor(k) === 'user-1')!;
        await walletGetBalance({ sessionId: inOne }); // starts user-1
        const gone: Array<{ reason: string; workerId: string; facades: string[] }> = [];
        onWorkerGone((reason, info) => { gone.push({ reason, ...info }); });
        byId('user-0')!.emit('message', { kind: 'sync-progress', sessionId: inZero, snapshot: { sessionId: inZero, caughtUp: true, label: 'z', updatedAt: 'now' } });
        byId('user-1')!.emit('message', { kind: 'sync-progress', sessionId: inOne, snapshot: { sessionId: inOne, caughtUp: true, label: 'o', updatedAt: 'now' } });

        held.add('waitForSyncedState');
        const stuckInOne = walletInit({ sessionId: inOne } as any).catch(e => e);
        const stuckInZero = walletGetBalance({ sessionId: inZero }).then(() => 'answered');
        await flush();
        byId('user-1')!.emit('exit', 1);

        const e = await stuckInOne;
        expect(e).toBeInstanceOf(Error);
        expect(String((e as Error).message)).toMatch(/exited \(code=1\)/);
        expect(await stuckInZero).toBe('answered');
        expect(walletGetSyncProgress(inOne)).toBeNull();
        expect(walletGetSyncProgress(inZero)).not.toBeNull();
        expect(gone).toEqual([{ reason: 'exit', workerId: 'user-1', facades: [inOne] }]);
        const status = getWalletWorkerStatus();
        expect(status.exitCount).toBe(1);
        expect(status.running).toBe(false);
        expect(status.workers.find(w => w.id === 'user-1')).toMatchObject({ running: false });
        // the next call to a wallet of the crashed worker respawns it
        const again: any = await walletGetBalance({ sessionId: inOne });
        expect(again.ranIn).toBe('user-1');
        expect(getWalletWorkerStatus().running).toBe(true);
    });

    it('saves of different wallets do not wait for each other, saves of one wallet stay in order', async () => {
        await startWalletWorker();
        const w = byId('user-0')!;
        const order: string[] = [];
        let releaseA!: () => void;
        setStateSaveSink(async (ev) => {
            order.push(`start:${ev.sessionId}:${ev.seq}`);
            if (ev.sessionId === 'A' && ev.seq === 1) await new Promise<void>(r => { releaseA = r; });
            order.push(`done:${ev.sessionId}:${ev.seq}`);
        });
        w.emit('message', { kind: 'state-save', sessionId: 'A', sdkVersion: 'v', seq: 1, blobs: {} });
        w.emit('message', { kind: 'state-save', sessionId: 'A', sdkVersion: 'v', seq: 2, blobs: {} });
        w.emit('message', { kind: 'state-save', sessionId: 'B', sdkVersion: 'v', seq: 7, blobs: {} });
        await flush(); await flush();
        // B stored while A's first save still hangs; A's second waits for A's first
        expect(order).toEqual(['start:A:1', 'start:B:7', 'done:B:7']);
        releaseA();
        await flush(); await flush(); await flush();
        expect(order).toEqual(['start:A:1', 'start:B:7', 'done:B:7', 'done:A:1', 'start:A:2', 'done:A:2']);
        const acks = w.sent.filter(m => m.kind === 'state-save-ack').map(m => `${m.sessionId}:${m.seq}`);
        expect(acks).toEqual(['B:7', 'A:1', 'A:2']);
    });
});
