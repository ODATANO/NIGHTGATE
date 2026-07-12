/**
 * Tests for srv/midnight/wallet-worker-client.ts.
 *
 * Mocks node:worker_threads with a fake Worker that immediately emits 'ready'
 * and routes postMessage'd RPC requests back through a synthetic reply on the
 * supplied MessageChannel. Lets us exercise lifecycle (start/stop), the RPC
 * helper success + error paths, push-event dispatch (state-save, log,
 * private-state-rpc), and the typed wrappers.
 */

import { EventEmitter } from 'node:events';

type SentMessage = {
    msg: any;
    transfer?: ReadonlyArray<unknown>;
};

class FakeWorker extends EventEmitter {
    sent: SentMessage[] = [];
    terminated = false;
    /** Programmable: how to respond when the main thread posts an rpc message. */
    rpcResponder: (msg: any) => any | undefined = () => undefined;

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

jest.mock('node:worker_threads', () => {
    const actual = jest.requireActual('node:worker_threads');
    return {
        ...actual,
        Worker: jest.fn().mockImplementation((entry: string, opts?: unknown) => {
            latestWorker = new FakeWorker(entry, opts);
            return latestWorker;
        })
    };
});

import {
    startWalletWorker,
    stopWalletWorker,
    setStateSaveSink,
    registerPrivateStateProvider,
    unregisterPrivateStateProvider,
    walletPing,
    walletInit,
    walletEvict,
    walletSerializeState,
    walletGetBalance,
    walletTransferNight,
    walletUnshieldNight,
    walletShieldNight,
    walletEstimateTransferFee,
    walletEstimateSwapFee,
    walletRegisterDustGeneration,
    walletDeregisterDustGeneration,
    walletDeployContract,
    walletSubmitContractCall,
    walletWaitForSyncedState,
    __resetWalletWorkerForTests
} from '../../srv/midnight/wallet-worker-client';

async function startWithResponder(responder: (msg: any) => any | undefined): Promise<FakeWorker> {
    await startWalletWorker();
    const w = latestWorker!;
    w.rpcResponder = responder;
    return w;
}

describe('wallet-worker-client', () => {
    let logSpy: jest.SpyInstance;
    let warnSpy: jest.SpyInstance;

    beforeEach(() => {
        logSpy = jest.spyOn(console, 'log').mockImplementation();
        warnSpy = jest.spyOn(console, 'warn').mockImplementation();
        __resetWalletWorkerForTests();
        latestWorker = undefined;
    });

    afterEach(async () => {
        await stopWalletWorker(10);
        logSpy.mockRestore();
        warnSpy.mockRestore();
    });

    describe('lifecycle', () => {
        it('rpc rejects before startWalletWorker has been called', async () => {
            await expect(walletPing()).rejects.toThrow(/wallet-worker not started/);
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
    });

    describe('rpc helper', () => {
        it('resolves with msg.result on a successful reply', async () => {
            await startWithResponder(() => ({ ok: true, result: { ok: true, ts: 42 } }));
            await expect(walletPing()).resolves.toEqual({ ok: true, ts: 42 });
        });

        it('rejects with the named Error from a structured failure payload', async () => {
            await startWithResponder(() => ({ ok: false, error: { name: 'TxFailedError', message: 'reverted' } }));
            await expect(walletPing()).rejects.toMatchObject({ name: 'TxFailedError', message: 'reverted' });
        });

        it('rejects with a plain Error when the failure payload is a bare string', async () => {
            await startWithResponder(() => ({ ok: false, error: 'badness' }));
            await expect(walletPing()).rejects.toThrow('badness');
        });

        it('falls back to "worker rpc failed" for an unrecognised payload shape', async () => {
            await startWithResponder(() => ({ ok: false }));
            await expect(walletPing()).rejects.toThrow('worker rpc failed');
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
            ['serializeState', () => walletSerializeState('s1'),                                       'serializeState'],
            ['getBalance',     () => walletGetBalance({ sessionId: 's1' }),                            'getBalance'],
            ['transferNight',  () => walletTransferNight({ sessionId: 's1', receiverAddress: 'r', amount: '1' }), 'transferNight'],
            ['unshieldNight',  () => walletUnshieldNight({ sessionId: 's1', amount: '1' }),            'unshieldNight'],
            ['shieldNight',    () => walletShieldNight({ sessionId: 's1', amount: '1' }),              'shieldNight'],
            ['estimateTransferFee', () => walletEstimateTransferFee({ sessionId: 's1', receiverAddress: 'r', amount: '1' }), 'estimateTransferFee'],
            ['estimateSwapFee', () => walletEstimateSwapFee({ sessionId: 's1', direction: 'shield', amount: '1' }), 'estimateSwapFee'],
            ['registerDust',   () => walletRegisterDustGeneration({ sessionId: 's1' }),                'registerDustGeneration'],
            ['deregisterDust', () => walletDeregisterDustGeneration({ sessionId: 's1' }),              'deregisterDustGeneration'],
            ['waitForSyncedState', () => walletWaitForSyncedState('s1'),                               'waitForSyncedState']
        ])('%s wrapper routes to the matching RPC method', async (_label, invoke, expectedMethod) => {
            await startWithResponder(captureResponder({}));
            await invoke();
            expect(captured[0].method).toBe(expectedMethod);
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
            const sink = jest.fn().mockResolvedValue(undefined);
            setStateSaveSink(sink);
            const pmSpy = jest.spyOn(w, 'postMessage');

            w.emit('message', { kind: 'state-save', sessionId: 's1', sdkVersion: 'v', seq: 7, blobs: {} });
            // v0.6.6: the sink runs on a microtask (its result gates the ack).
            await new Promise(r => setImmediate(r));
            expect(sink).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's1', seq: 7 }));
            expect(pmSpy).toHaveBeenCalledWith({ kind: 'state-save-ack', sessionId: 's1', seq: 7 });
        });

        it('does NOT ack a state-save whose sink rejects', async () => {
            await startWalletWorker();
            const w = latestWorker!;
            const sink = jest.fn().mockRejectedValue(new Error('persist down'));
            setStateSaveSink(sink);
            const pmSpy = jest.spyOn(w, 'postMessage');

            w.emit('message', { kind: 'state-save', sessionId: 's2', sdkVersion: 'v', seq: 8, blobs: {} });
            await new Promise(r => setImmediate(r));
            expect(sink).toHaveBeenCalled();
            expect(pmSpy).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'state-save-ack', seq: 8 }));
        });

        it('relays "log" messages to console.log / console.warn by level', async () => {
            await startWalletWorker();
            const w = latestWorker!;

            w.emit('message', { kind: 'log', level: 'info', message: 'hello' });
            w.emit('message', { kind: 'log', level: 'warn', message: 'careful' });

            expect(logSpy).toHaveBeenCalledWith('hello');
            expect(warnSpy).toHaveBeenCalledWith('careful');
        });

        describe('private-state-rpc dispatch', () => {
            const fakeProvider: any = {
                setContractAddress: jest.fn(),
                set: jest.fn(async (k: string, v: any) => ({ k, v })),
                get: jest.fn(async (k: string) => ({ k })),
                remove: jest.fn(async () => undefined),
                clear: jest.fn(async () => undefined),
                setSigningKey: jest.fn(async () => undefined),
                getSigningKey: jest.fn(async () => 'key'),
                removeSigningKey: jest.fn(async () => undefined),
                clearSigningKeys: jest.fn(async () => undefined)
            };

            beforeEach(async () => {
                for (const fn of Object.values(fakeProvider) as jest.Mock[]) fn.mockClear?.();
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
            // and cause Jest's worker pool to force-exit the worker.
            const trackedPorts: any[] = [];

            function emitRpc(method: string, args: unknown[], opts: { withPort?: boolean; proxyId?: string } = {}) {
                const { port1, port2 } = new (jest.requireActual('node:worker_threads').MessageChannel)();
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
