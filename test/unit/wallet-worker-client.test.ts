/**
 * Tests for srv/midnight/wallet-worker-client.ts.
 *
 * Mocks node:worker_threads with a fake Worker that immediately emits 'ready'
 * and routes postMessage'd RPC requests back through a synthetic reply on the
 * supplied MessageChannel. Lets us exercise lifecycle (start/stop), the RPC
 * helper success + error paths, push-event dispatch (state-save, log,
 * private-state-rpc), and the typed wrappers.
 */

import type { Mock, MockInstance } from 'vitest';
import cds from '@sap/cds';
import { WorkerSubmitError } from '../../srv/midnight/wallet-worker-protocol';
import { EventEmitter } from 'node:events';

type SentMessage = {
    msg: any;
    transfer?: ReadonlyArray<unknown>;
};

/** Responder a NEW fake worker starts with (a respawn happens inside the client, before a test can reach it). */
let defaultResponder: (msg: any) => any | undefined = () => undefined;

class FakeWorker extends EventEmitter {
    sent: SentMessage[] = [];
    terminated = false;
    /** Programmable: how to respond when the main thread posts an rpc message. */
    rpcResponder: (msg: any) => any | undefined = defaultResponder;

    constructor(_entry: string, _opts?: unknown) {
        super();
        // Emit `ready` on next tick so startWalletWorker can await it.
        setImmediate(() => this.emit('message', { kind: 'ready' }));
    }

    postMessage(msg: any, transfer?: ReadonlyArray<unknown>): void {
        this.sent.push({ msg, transfer });
        if (msg?.kind === 'rpc' && msg.port) {
            const reply = this.rpcResponder(msg);
            if (reply !== undefined) {
                // Reply on the next tick to model async worker handling.
                setImmediate(() => msg.port.postMessage(reply));
            }
        }
    }

    async terminate(): Promise<void> {
        this.terminated = true;
        this.emit('exit', 0);
    }

    off(event: string, listener: (...args: any[]) => void): this {
        return this.removeListener(event, listener);
    }
}

let latestWorker: FakeWorker | undefined;

vi.mock('node:worker_threads', async () => {
    const actual = await vi.importActual('node:worker_threads');
    return {
        ...actual,
        // Must be constructable (`new Worker(...)` in the client); a
        // constructor returning an object substitutes it for `this`.
        Worker: class {
            constructor(entry: string, opts?: unknown) {
                latestWorker = new FakeWorker(entry, opts);
                // eslint-disable-next-line no-constructor-return
                return latestWorker as any;
            }
        }
    };
});

import {
    startWalletWorker,
    stopWalletWorker,
    setStateSaveSink,
    registerPrivateStateProvider,
    unregisterPrivateStateProvider,
    walletInit,
    walletEvict,
    walletGetBalance,
    walletTransferNight,
    walletEstimateTransferFee,
    walletRegisterDustGeneration,
    walletDeregisterDustGeneration,
    walletDeployContract,
    walletSubmitContractCall,
    walletWaitForSyncedState,
    walletGetSyncProgress,
    getWalletWorkerStatus,
    __resetWalletWorkerForTests
} from '../../srv/midnight/wallet-worker-client';

async function startWithResponder(responder: (msg: any) => any | undefined): Promise<FakeWorker> {
    await startWalletWorker();
    const w = latestWorker!;
    w.rpcResponder = responder;
    return w;
}

describe('wallet-worker-client', () => {
    let logSpy: MockInstance;
    let warnSpy: MockInstance;

    beforeEach(() => {
        logSpy = vi.spyOn(cds.log('nightgate:worker-client'), 'info').mockImplementation(() => {});
        warnSpy = vi.spyOn(cds.log('nightgate:worker-client'), 'warn').mockImplementation(() => {});
        __resetWalletWorkerForTests();
        latestWorker = undefined;
        defaultResponder = () => undefined;
    });

    afterEach(async () => {
        await stopWalletWorker(10);
        logSpy.mockRestore();
        warnSpy.mockRestore();
    });

    describe('lifecycle', () => {
        it('rpc rejects before startWalletWorker has been called', async () => {
            await expect(walletEvict('s1')).rejects.toThrow(/wallet-worker not started/);
        });

        it('setStateSaveSink throws before startWalletWorker', () => {
            expect(() => setStateSaveSink(() => undefined)).toThrow(/wallet-worker not started/);
        });

        it('startWalletWorker is idempotent: second call reuses the existing worker', async () => {
            await startWalletWorker();
            const first = latestWorker;
            await startWalletWorker();
            expect(latestWorker).toBe(first);
        });

        it('stopWalletWorker is safe to call when no worker is running', async () => {
            await expect(stopWalletWorker(10)).resolves.toBeUndefined();
        });

        it('stopWalletWorker terminates the worker after the graceful window', async () => {
            await startWalletWorker();
            const w = latestWorker!;
            await stopWalletWorker(10);
            expect(w.terminated).toBe(true);
        });

        it('stopWalletWorker asks the worker to flush every facade (shutdown rpc) before terminating', async () => {
            const seen: string[] = [];
            const w = await startWithResponder((msg) => {
                seen.push(msg.method);
                return msg.method === 'shutdown' ? { ok: true, result: { evicted: 3, failed: 0 } } : undefined;
            });
            await stopWalletWorker(1000);
            expect(seen).toEqual(['shutdown']);
            expect(w.terminated).toBe(true);
            expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/worker shutdown: 3 facade\(s\) evicted, all saves confirmed/));
            // no respawn after an intentional stop
            await expect(walletEvict('s1')).rejects.toThrow(/wallet-worker not started/);
        });

        it('stopWalletWorker terminates anyway when the flush does not complete in time', async () => {
            const w = await startWithResponder(() => undefined); // never answers
            await stopWalletWorker(10);
            expect(w.terminated).toBe(true);
            expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/shutdown flush did not complete/));
        });
    });

    describe('rotation', () => {
        it('a WORKER_ROTATING refusal marks the worker draining; the call is retried on the respawn', async () => {
            defaultResponder = () => ({ ok: true, result: { evicted: true } });
            const w1 = await startWithResponder((msg) => {
                // the worker refuses on the call port; its `rotating` announcement and exit follow
                setImmediate(() => { w1.emit('message', { kind: 'rotating', generations: 32, inflight: 0 }); w1.emit('exit', 0); });
                return { ok: false, error: { name: 'WORKER_ROTATING', message: 'rotating' } };
            });
            await expect(walletEvict('s1')).resolves.toEqual({ evicted: true });
            expect(latestWorker).not.toBe(w1);
            expect(getWalletWorkerStatus().rotationCount).toBe(1);
        });

        it('rotation-done: the client terminates the worker; a read cut in flight is repeated once, a submit is not', async () => {
            defaultResponder = (msg) => ({ ok: true, result: msg.method === 'getBalance' ? { balance: 'fresh' } : { txId: 'never' } });
            const w1 = await startWithResponder(() => undefined); // never answers: both calls stay in flight
            const read = walletGetBalance({ sessionId: 's1' });
            // settle the rejection as it happens: an unobserved rejection between the
            // exit event and the assertion is reported as an unhandled promise
            const submit = walletTransferNight({ sessionId: 's1', receiverAddress: 'r', amount: '1' }).then(() => null, (e: Error) => e);
            await new Promise(r => setImmediate(r));
            w1.emit('message', { kind: 'rotation-done', generations: 32 });
            await expect(read).resolves.toEqual({ balance: 'fresh' });
            await expect(submit).resolves.toMatchObject({ name: 'WORKER_ROTATED' });
            expect(w1.terminated).toBe(true);
            expect(getWalletWorkerStatus().rotationCount).toBe(1);
            expect(getWalletWorkerStatus().exitCount ?? 0).toBe(0);
        });

        it('a drain that exceeds NIGHTGATE_WORKER_DRAIN_MAX_MS terminates the draining worker', async () => {
            process.env.NIGHTGATE_WORKER_DRAIN_MAX_MS = '20';
            try {
                defaultResponder = () => ({ ok: true, result: { evicted: false } });
                const w1 = await startWithResponder(() => undefined);
                w1.emit('message', { kind: 'rotating', generations: 32, inflight: 1 }); // announces, never exits
                await expect(walletEvict('s1')).resolves.toEqual({ evicted: false });
                expect(w1.terminated).toBe(true);
                expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/drain exceeded 20ms/));
            } finally {
                delete process.env.NIGHTGATE_WORKER_DRAIN_MAX_MS;
            }
        });

        it('a late exit event of a stopped worker does not orphan its replacement', async () => {
            const w1 = await startWithResponder(() => undefined);
            w1.terminate = async () => { w1.terminated = true; }; // exit event arrives LATER
            await stopWalletWorker(10);
            await startWalletWorker();
            const w2 = latestWorker!;
            expect(w2).not.toBe(w1);
            w2.rpcResponder = () => ({ ok: true, result: { evicted: true } });
            w1.emit('exit', 0); // the stopped worker's exit lands after the replacement started
            await expect(walletEvict('s1')).resolves.toEqual({ evicted: true });
            expect(latestWorker).toBe(w2); // no third worker was spawned
            expect(getWalletWorkerStatus().exitCount ?? 0).toBe(0); // a stop is not a crash
        });
    });

    describe('rpc helper', () => {
        it('resolves with msg.result on a successful reply', async () => {
            await startWithResponder(() => ({ ok: true, result: { evicted: false } }));
            await expect(walletEvict('s1')).resolves.toEqual({ evicted: false });
        });

        it('rejects with the named Error from a structured failure payload', async () => {
            await startWithResponder(() => ({ ok: false, error: { name: 'TxFailedError', message: 'reverted' } }));
            await expect(walletEvict('s1')).rejects.toMatchObject({ name: 'TxFailedError', message: 'reverted' });
        });

        it('rejects with a plain Error when the failure payload is a bare string', async () => {
            await startWithResponder(() => ({ ok: false, error: 'badness' }));
            await expect(walletEvict('s1')).rejects.toThrow('badness');
        });

        it('falls back to "worker rpc failed" for an unrecognised payload shape', async () => {
            await startWithResponder(() => ({ ok: false }));
            await expect(walletEvict('s1')).rejects.toThrow('worker rpc failed');
        });

        it('rebuilds a WorkerSubmitError from a classified failure payload (code and friends as data)', async () => {
            const calls = [{ name: 'attest', segId: 1158, stages: 'f' }];
            await startWithResponder(() => ({ ok: false, error: {
                name: 'Error', message: 'Transaction submission error <- 1010: Custom error: 196',
                code: 'dust-race', ledgerCode: '1010/196', retryable: true, causes: ['1010: Custom error: 196'], calls
            } }));
            const err: any = await walletEvict('s1').then(() => null, e => e);
            expect(err).toBeInstanceOf(WorkerSubmitError);
            expect(err).toMatchObject({ name: 'Error', code: 'dust-race', ledgerCode: '1010/196', retryable: true, causes: ['1010: Custom error: 196'], calls });
            expect(err.message).toMatch(/Custom error: 196/);
        });

        it('an unknown code is not a classification: plain Error as before', async () => {
            await startWithResponder(() => ({ ok: false, error: { name: 'X', message: 'm', code: 'made-up' } }));
            const err: any = await walletEvict('s1').then(() => null, e => e);
            expect(err).not.toBeInstanceOf(WorkerSubmitError);
            expect(err).toMatchObject({ name: 'X', message: 'm' });
        });
    });

    describe('typed RPC wrappers', () => {
        const captured: any[] = [];
        beforeEach(() => {
            captured.length = 0;
        });

        function captureResponder(result: unknown) {
            return (msg: any) => {
                captured.push(msg);
                return { ok: true, result };
            };
        }

        it('walletInit forwards args under method="init"', async () => {
            await startWithResponder(captureResponder({ facadeReady: true, alreadyExisted: false }));
            await walletInit({
                sessionId: 's1',
                seedHex: 'abc',
                networkId: 'preprod',
                indexerHttpUrl: 'http://i',
                indexerWsUrl: 'ws://i',
                proofServerUrl: 'http://p',
                relayUrl: 'wss://r'
            });
            expect(captured[0].method).toBe('init');
            expect(captured[0].args.sessionId).toBe('s1');
        });

        it.each([
            ['evict',          () => walletEvict('s1'),                                                'evict'],
            ['getBalance',     () => walletGetBalance({ sessionId: 's1' }),                            'getBalance'],
            ['transferNight',  () => walletTransferNight({ sessionId: 's1', receiverAddress: 'r', amount: '1' }), 'transferNight'],
            ['estimateTransferFee', () => walletEstimateTransferFee({ sessionId: 's1', receiverAddress: 'r', amount: '1' }), 'estimateTransferFee'],
            ['registerDust',   () => walletRegisterDustGeneration({ sessionId: 's1' }),                'registerDustGeneration'],
            ['deregisterDust', () => walletDeregisterDustGeneration({ sessionId: 's1' }),              'deregisterDustGeneration'],
            ['waitForSyncedState', () => walletWaitForSyncedState('s1'),                               'waitForSyncedState']
        ])('%s wrapper routes to the matching RPC method', async (_label, invoke, expectedMethod) => {
            await startWithResponder(captureResponder({}));
            await invoke();
            expect(captured[0].method).toBe(expectedMethod);
        });

        it('the bound wrappers forward onSubmitIntent: the intent is persisted, then acked, then the reply arrives', async () => {
            const acks: any[] = [];
            await startWithResponder((msg) => {
                // worker: announce first, reply only after the ack
                msg.port.on('message', (m: any) => { if (m?.kind === 'submit-intent-ack') { acks.push(m); msg.port.postMessage({ ok: true, result: { txHash: 'h1', onChainStatus: 'ok' } }); } });
                msg.port.postMessage({ kind: 'submit-intent', txHash: 'h1', contractAddress: 'c', circuits: ['increment'], ttl: '2026-09-10T06:31:34.000Z' });
                return undefined;
            });
            const persisted: any[] = [];
            const result = await walletSubmitContractCall({
                sessionId: 's1', proxyId: 'p', contractName: 'counter', contractAddress: 'c', circuit: 'increment', args: [],
                registration: { artifactPath: '/a', privateStateId: 'p', zkConfigPath: '/zk' },
                indexerHttpUrl: '', indexerWsUrl: '', proofServerUrl: '', networkId: 'preprod'
            } as any, async (txHash, intent) => { persisted.push({ txHash, intent }); });
            expect(result).toEqual({ txHash: 'h1', onChainStatus: 'ok' });
            // the ttl rides along: the confirmer's deadline for a broadcast that never lands
            expect(persisted).toEqual([{ txHash: 'h1', intent: expect.objectContaining({ txHash: 'h1', contractAddress: 'c', circuits: ['increment'], ttl: '2026-09-10T06:31:34.000Z' }) }]);
            expect(acks).toEqual([{ kind: 'submit-intent-ack', txHash: 'h1', ok: true }]);
        });

        it('walletDeployContract / walletSubmitContractCall route to their RPC methods', async () => {
            await startWithResponder(captureResponder({ txHash: 'tx', contractAddress: 'addr', onChainStatus: 'ok' }));
            await walletDeployContract({
                sessionId: 's1',
                proxyId: 'p',
                contractName: 'counter',
                registration: { artifactPath: '/a', privateStateId: 'p', zkConfigPath: '/zk' },
                indexerHttpUrl: '', indexerWsUrl: '', proofServerUrl: '',
                networkId: 'preprod',
                initialPrivateState: {}
            });
            expect(captured[0].method).toBe('deployContract');

            captured.length = 0;
            await startWithResponder(captureResponder({ txHash: 'tx', onChainStatus: 'ok' }));
            await walletSubmitContractCall({
                sessionId: 's1',
                proxyId: 'p',
                contractName: 'counter',
                registration: { artifactPath: '/a', privateStateId: 'p', zkConfigPath: '/zk' },
                contractAddress: 'addr',
                circuit: 'inc',
                args: [],
                indexerHttpUrl: '', indexerWsUrl: '', proofServerUrl: '',
                networkId: 'preprod'
            });
            expect(captured[0].method).toBe('submitContractCall');
        });
    });

    describe('push-event dispatch', () => {
        it('forwards state-save events to the registered sink and acks on success', async () => {
            await startWalletWorker();
            const w = latestWorker!;
            const sink = vi.fn().mockResolvedValue(undefined);
            setStateSaveSink(sink);
            const pmSpy = vi.spyOn(w, 'postMessage');

            w.emit('message', { kind: 'state-save', sessionId: 's1', sdkVersion: 'v', seq: 7, blobs: {} });
            // The sink runs on a microtask (its result gates the ack).
            await new Promise(r => setImmediate(r));
            expect(sink).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's1', seq: 7 }));
            expect(pmSpy).toHaveBeenCalledWith({ kind: 'state-save-ack', sessionId: 's1', seq: 7 });
        });

        it('does NOT ack a state-save whose sink rejects', async () => {
            await startWalletWorker();
            const w = latestWorker!;
            const sink = vi.fn().mockRejectedValue(new Error('persist down'));
            setStateSaveSink(sink);
            const pmSpy = vi.spyOn(w, 'postMessage');

            w.emit('message', { kind: 'state-save', sessionId: 's2', sdkVersion: 'v', seq: 8, blobs: {} });
            await new Promise(r => setImmediate(r));
            expect(sink).toHaveBeenCalled();
            expect(pmSpy).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'state-save-ack', seq: 8 }));
        });

        it('serializes state-save persists in arrival order (dust-restore push relies on last-sent-wins)', async () => {
            await startWalletWorker();
            const w = latestWorker!;
            const order: string[] = [];
            let releaseFirst!: () => void;
            const sink = vi.fn(async (ev: any) => {
                order.push(`start:${ev.seq}`);
                if (ev.seq === 10) await new Promise<void>(res => { releaseFirst = res; });
                order.push(`done:${ev.seq}`);
            });
            setStateSaveSink(sink);
            const pmSpy = vi.spyOn(w, 'postMessage');

            // Two saves in flight: the first (poisoned) hangs in the DB layer
            // while the second (the restore's clean snapshot) arrives.
            w.emit('message', { kind: 'state-save', sessionId: 's3', sdkVersion: 'v', seq: 10, blobs: { dust: 'POISON' } });
            w.emit('message', { kind: 'state-save', sessionId: 's3', sdkVersion: 'v', seq: 11, blobs: { dust: 'CLEAN' } });
            await new Promise(r => setImmediate(r));

            // The second persist must NOT start (and must not be acked) while
            // the first is still in flight, or it could commit before it.
            expect(order).toEqual(['start:10']);
            expect(pmSpy).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'state-save-ack', seq: 11 }));

            releaseFirst();
            await new Promise(r => setImmediate(r));
            expect(order).toEqual(['start:10', 'done:10', 'start:11', 'done:11']);
            expect(pmSpy).toHaveBeenCalledWith({ kind: 'state-save-ack', sessionId: 's3', seq: 10 });
            expect(pmSpy).toHaveBeenCalledWith({ kind: 'state-save-ack', sessionId: 's3', seq: 11 });
        });

        it('caches pushed sync-progress snapshots for synchronous reads', async () => {
            await startWalletWorker();
            const w = latestWorker!;
            const snapshot = {
                sessionId: 'acct-1', appliedIndex: '1200', streamTip: '1500',
                behindEvents: '300', eventsPerSecond: 12.5, etaSeconds: 24,
                blockHeight: '1951462', isConnected: true, indexerFresh: true,
                caughtUp: false, elapsedMs: 45_000, label: 'prewarm',
                updatedAt: '2026-08-04T09:00:00.000Z'
            };

            expect(walletGetSyncProgress('acct-1')).toBeNull();
            w.emit('message', { kind: 'sync-progress', sessionId: 'acct-1', snapshot });
            // No await: the whole point is that a saturated worker is not asked.
            expect(walletGetSyncProgress('acct-1')).toEqual(snapshot);

            w.emit('message', {
                kind: 'sync-progress', sessionId: 'acct-1',
                snapshot: { ...snapshot, appliedIndex: '1490', behindEvents: '10' }
            });
            expect(walletGetSyncProgress('acct-1')!.appliedIndex).toBe('1490');
        });

        it('drops the cached snapshot when the facade is evicted', async () => {
            const w = await startWithResponder(() => ({ ok: true, result: { evicted: true } }));
            w.emit('message', {
                kind: 'sync-progress', sessionId: 'acct-2',
                snapshot: { sessionId: 'acct-2', appliedIndex: '5', caughtUp: true }
            });
            expect(walletGetSyncProgress('acct-2')).not.toBeNull();

            await walletEvict('acct-2');
            expect(walletGetSyncProgress('acct-2')).toBeNull();
        });

        it('clears every snapshot when the worker exits', async () => {
            await startWalletWorker();
            const w = latestWorker!;
            w.emit('message', {
                kind: 'sync-progress', sessionId: 'acct-3',
                snapshot: { sessionId: 'acct-3', appliedIndex: '9', caughtUp: false }
            });
            expect(walletGetSyncProgress('acct-3')).not.toBeNull();

            w.emit('exit', 1);
            expect(walletGetSyncProgress('acct-3')).toBeNull();
        });

        it('relays "log" messages through the nightgate:worker CAP channel by level', async () => {
            await startWalletWorker();
            const w = latestWorker!;
            const infoSpy = vi.spyOn(cds.log('nightgate:worker'), 'info').mockImplementation(() => {});
            const wSpy = vi.spyOn(cds.log('nightgate:worker'), 'warn').mockImplementation(() => {});

            w.emit('message', { kind: 'log', level: 'info', message: 'hello' });
            w.emit('message', { kind: 'log', level: 'warn', message: 'careful' });

            expect(infoSpy).toHaveBeenCalledWith('hello');
            expect(wSpy).toHaveBeenCalledWith('careful');
            infoSpy.mockRestore();
            wSpy.mockRestore();
        });

        describe('private-state-rpc dispatch', () => {
            const fakeProvider: any = {
                setContractAddress: vi.fn(),
                set: vi.fn(async (k: string, v: any) => ({ k, v })),
                get: vi.fn(async (k: string) => ({ k })),
                remove: vi.fn(async () => undefined),
                clear: vi.fn(async () => undefined),
                setSigningKey: vi.fn(async () => undefined),
                getSigningKey: vi.fn(async () => 'key'),
                removeSigningKey: vi.fn(async () => undefined),
                clearSigningKeys: vi.fn(async () => undefined)
            };

            beforeEach(async () => {
                for (const fn of Object.values(fakeProvider) as Mock[]) fn.mockClear?.();
                registerPrivateStateProvider('proxy-1', fakeProvider);
                await startWalletWorker();
            });

            afterEach(() => {
                unregisterPrivateStateProvider('proxy-1');
                while (trackedPorts.length) {
                    try { trackedPorts.pop()?.close?.(); } catch { /* already closed */ }
                }
            });

            // Unreffed MessagePorts created here are tracked so afterEach can
            // close them. An unclosed MessagePort keeps Node's event loop open,
            // and across this describe block that would otherwise leak ~6 ports
            // and cause the test runner's worker pool to force-exit the worker.
            const trackedPorts: any[] = [];

            // worker_threads is mocked above; the RPC plumbing needs the REAL
            // MessageChannel, fetched once via importActual (async, so cached
            // here instead of inside the sync emitRpc helper).
            let RealMessageChannel: any;
            beforeAll(async () => {
                ({ MessageChannel: RealMessageChannel } =
                    await vi.importActual<any>('node:worker_threads'));
            });

            function emitRpc(method: string, args: unknown[], opts: { withPort?: boolean; proxyId?: string } = {}) {
                const { port1, port2 } = new RealMessageChannel();
                trackedPorts.push(port2);
                const proxyId = opts.proxyId ?? 'proxy-1';
                latestWorker!.emit('message', {
                    kind: 'private-state-rpc',
                    proxyId,
                    method,
                    args,
                    port: opts.withPort === false ? undefined : port1
                });
                return { port2 };
            }

            it('routes setContractAddress synchronously without requiring a port', () => {
                latestWorker!.emit('message', {
                    kind: 'private-state-rpc',
                    proxyId: 'proxy-1',
                    method: 'setContractAddress',
                    args: ['addr-aaaa']
                });
                expect(fakeProvider.setContractAddress).toHaveBeenCalledWith('addr-aaaa');
            });

            it('warns when setContractAddress targets an unknown proxyId', () => {
                latestWorker!.emit('message', {
                    kind: 'private-state-rpc',
                    proxyId: 'proxy-unknown',
                    method: 'setContractAddress',
                    args: ['addr']
                });
                expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('unknown proxyId'));
            });

            it('warns and continues when setContractAddress throws', () => {
                fakeProvider.setContractAddress.mockImplementationOnce(() => { throw new Error('boom'); });
                latestWorker!.emit('message', {
                    kind: 'private-state-rpc',
                    proxyId: 'proxy-1',
                    method: 'setContractAddress',
                    args: ['addr']
                });
                expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('setContractAddress failed'), expect.any(String));
            });

            it('replies with the provider result for known methods', async () => {
                const { port2 } = emitRpc('set', ['k', 'v']);
                const reply: any = await new Promise(resolve => port2.once('message', resolve));
                expect(reply.ok).toBe(true);
                expect(reply.result).toEqual({ k: 'k', v: 'v' });
                expect(fakeProvider.set).toHaveBeenCalledWith('k', 'v');
            });

            it('replies with PrivateStateProxyMissing for an unknown proxyId', async () => {
                const { port2 } = emitRpc('get', ['k'], { proxyId: 'no-such-proxy' });
                const reply: any = await new Promise(resolve => port2.once('message', resolve));
                expect(reply.ok).toBe(false);
                expect(reply.error.name).toBe('PrivateStateProxyMissing');
            });

            it('replies with the error name + message when the provider throws', async () => {
                fakeProvider.get.mockRejectedValueOnce(Object.assign(new Error('not found'), { name: 'NotFound' }));
                const { port2 } = emitRpc('get', ['k']);
                const reply: any = await new Promise(resolve => port2.once('message', resolve));
                expect(reply.ok).toBe(false);
                expect(reply.error).toEqual({ name: 'NotFound', message: 'not found' });
            });

            it('replies with an Unsupported error for an unknown method', async () => {
                const { port2 } = emitRpc('nope', []);
                const reply: any = await new Promise(resolve => port2.once('message', resolve));
                expect(reply.ok).toBe(false);
                expect(reply.error.message).toMatch(/Unsupported private-state RPC method/);
            });

            it('warns when a non-setContractAddress message arrives without a port', () => {
                latestWorker!.emit('message', {
                    kind: 'private-state-rpc',
                    proxyId: 'proxy-1',
                    method: 'get',
                    args: ['k']
                });
                expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('missing port for method=get'));
            });
        });
    });
});

describe('workerResourceLimits (young generation of the wallet worker)', () => {
    it('defaults to 128 MB, honours the env var within 16..2048, 0 disables, garbage falls back', async () => {
        const { workerResourceLimits } = await import('../../srv/midnight/wallet-worker-client.js');
        expect(workerResourceLimits({})).toEqual({ maxYoungGenerationSizeMb: 128 });
        expect(workerResourceLimits({ NIGHTGATE_WORKER_YOUNG_GEN_MB: '256' })).toEqual({ maxYoungGenerationSizeMb: 256 });
        expect(workerResourceLimits({ NIGHTGATE_WORKER_YOUNG_GEN_MB: '4' })).toEqual({ maxYoungGenerationSizeMb: 16 });
        expect(workerResourceLimits({ NIGHTGATE_WORKER_YOUNG_GEN_MB: '99999' })).toEqual({ maxYoungGenerationSizeMb: 2048 });
        expect(workerResourceLimits({ NIGHTGATE_WORKER_YOUNG_GEN_MB: '0' })).toBeUndefined();
        expect(workerResourceLimits({ NIGHTGATE_WORKER_YOUNG_GEN_MB: 'abc' })).toEqual({ maxYoungGenerationSizeMb: 128 });
    });
});
