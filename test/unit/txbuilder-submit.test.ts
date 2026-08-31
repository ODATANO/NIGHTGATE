// `@odatano/nightgate/txbuilder` self-funded submission helpers: reject
// classification, one-shot submit, indexer probe, dust guard. The live path
// is a consumer concern (own wallet, own node); everything here is pure or
// runs against injected seams.

import { describe, it, expect } from 'vitest';

const importTxBuilder = () => import('../../src/txbuilder/index.mjs' as string);
const importSubmit = () => import('../../src/txbuilder/submit.mjs' as string);

describe('txbuilder: runSingleCall honors the before hook like a batch entry', () => {
    it('runs the hook, then the circuit, with the call args', async () => {
        const { runSingleCall } = await importTxBuilder();
        const order: string[] = [];
        const call = { circuitId: 'attest', args: [1n, 2n], before: () => order.push('before') };
        const fn = (...args: unknown[]) => { order.push('fn:' + args.join(',')); return 'built'; };
        await expect(runSingleCall(call, fn)).resolves.toBe('built');
        expect(order).toEqual(['before', 'fn:1,2']);
    });

    it('works without a hook and with missing args', async () => {
        const { runSingleCall } = await importTxBuilder();
        const fn = (...args: unknown[]) => args.length;
        await expect(runSingleCall({ circuitId: 'attest' }, fn)).resolves.toBe(0);
    });

    it('a throwing hook aborts before the circuit runs', async () => {
        const { runSingleCall } = await importTxBuilder();
        let ran = false;
        const call = { circuitId: 'attest', args: [], before: () => { throw new Error('unarmed'); } };
        await expect(runSingleCall(call, () => { ran = true; })).rejects.toThrow('unarmed');
        expect(ran).toBe(false);
    });
});

describe('txbuilder submit: classifyNodeReject', () => {
    const classify = async (err: unknown) => (await importSubmit()).classifyNodeReject(err);

    it.each([
        ['1010: Invalid Transaction: Custom error: 170', 'stale-dust-proof', 170],
        ['1010: Invalid Transaction: Custom error: 171', 'stale-dust-proof', 171],
        ['1010: Invalid Transaction: Custom error: 196', 'stale-dust-proof', 196],
        ['1010: Invalid Transaction: Custom error: 138', 'funds', 138],
        ['1010: Invalid Transaction: Custom error: 173', 'funds', 173],
        ['1010: Invalid Transaction: Custom error: 219', 'sequencing', 219],
        ['1010: Invalid Transaction: Custom error: 224', 'sequencing', 224],
        ['1010: Invalid Transaction: Custom error: 188', 'sequencing', 188],
        ['1010: Invalid Transaction: Custom error: 117', 'malformed', 117],
        ['1010: Invalid Transaction: Custom error: 182', 'unknown', 182]
    ])('%s -> %s', async (msg, kind, subCode) => {
        expect(await classify(new Error(msg))).toEqual({ kind, subCode });
    });

    it('reads the sub-code out of the CAUSE CHAIN (the SDK buries the node reject)', async () => {
        const inner = new Error('1010: Invalid Transaction: Custom error: 170');
        const outer = new Error('(FiberFailure) SubmissionError: Transaction submission error');
        (outer as { cause?: unknown }).cause = inner;
        expect(await classify(outer)).toEqual({ kind: 'stale-dust-proof', subCode: 170 });
    });

    it('the balancer\'s own funds message counts as funds without a sub-code', async () => {
        expect(await classify(new Error('Insufficient Funds: could not balance dust'))).toEqual({ kind: 'funds', subCode: null });
        expect(await classify(new Error('BatchCausalityViolation: causality constraint'))).toEqual({ kind: 'sequencing', subCode: null });
    });

    it('anything else is unknown', async () => {
        expect(await classify(new Error('ECONNRESET'))).toEqual({ kind: 'unknown', subCode: null });
    });
});

describe('txbuilder submit: reject vs transport classification', () => {
    it('1010/1014/1016 are pre-mempool rejects, 1013 is not', async () => {
        const { isPreMempoolReject } = await importSubmit();
        expect(isPreMempoolReject(new Error('1010: Invalid Transaction: Custom error: 170'))).toBe(true);
        expect(isPreMempoolReject(new Error('1014: Priority is too low'))).toBe(true);
        expect(isPreMempoolReject(new Error('1016: immediately dropped'))).toBe(true);
        expect(isPreMempoolReject(new Error('1013: Transaction Already Imported'))).toBe(false);
    });

    it('1013 Already Imported means the first send reached the pool, never a failure', async () => {
        const { isAlreadyImported, isTransportFailure, isPreMempoolReject } = await importSubmit();
        const e = new Error('node rejected: 1013 Transaction Already Imported');
        expect(isAlreadyImported(e)).toBe(true);
        expect(isTransportFailure(e)).toBe(false);
        expect(isPreMempoolReject(e)).toBe(false);
        const wrapped = new Error('SubmissionError');
        (wrapped as { cause?: unknown }).cause = new Error('1013: Transaction Already Imported');
        expect(isAlreadyImported(wrapped)).toBe(true);
        expect(isAlreadyImported(new Error('1010: Invalid Transaction: Custom error: 170'))).toBe(false);
        expect(isAlreadyImported(new Error('at pool.js:1013:5'))).toBe(false);
    });

    it('a source position like wallet.js:1010:27 is not a reject code', async () => {
        const { isPreMempoolReject } = await importSubmit();
        expect(isPreMempoolReject(new Error('TypeError at wallet.js:1010:27'))).toBe(false);
    });

    it('transport failures are sockets and timeouts, never rejects', async () => {
        const { isTransportFailure } = await importSubmit();
        expect(isTransportFailure(new Error('read ECONNRESET'))).toBe(true);
        expect(isTransportFailure(new Error('disconnected from wss://node: 1000:: Normal Closure'))).toBe(true);
        expect(isTransportFailure(new Error('submit timed out after 30000ms'))).toBe(true);
        expect(isTransportFailure(new Error('1010: Invalid Transaction: Custom error: 170'))).toBe(false);
        expect(isTransportFailure(new Error('all good'))).toBe(false);
    });
});

describe('txbuilder submit: nodeHttpUrlFor', () => {
    it('swaps ws(s) for http(s) and strips the trailing slash', async () => {
        const { nodeHttpUrlFor } = await importSubmit();
        expect(nodeHttpUrlFor('wss://rpc.preprod.midnight.network/')).toBe('https://rpc.preprod.midnight.network');
        expect(nodeHttpUrlFor('ws://localhost:9944')).toBe('http://localhost:9944');
        expect(nodeHttpUrlFor('https://rpc.example/x')).toBe('https://rpc.example/x');
        expect(() => nodeHttpUrlFor('ftp://x')).toThrow(/ws\(s\)/);
    });
});

describe('txbuilder submit: txIdentifiers', () => {
    it('returns every identifier as a string', async () => {
        const { txIdentifiers } = await importSubmit();
        expect(txIdentifiers({ identifiers: () => ['aa', 'bb'] })).toEqual(['aa', 'bb']);
        expect(() => txIdentifiers({} as never)).toThrow(/deserializeTransaction/);
    });
});

describe('txbuilder submit: submitExtrinsic over a one-shot socket', () => {
    type Handler = ((ev: { data: string }) => void) | null;
    const fakeWs = (reply: (sent: string) => object) => {
        const seen: string[] = [];
        class FakeWebSocket {
            onopen: (() => void) | null = null;
            onmessage: Handler = null;
            onerror: ((ev: unknown) => void) | null = null;
            closed = false;
            constructor(public url: string) {
                setTimeout(() => this.onopen?.(), 0);
            }
            send(data: string) {
                seen.push(data);
                setTimeout(() => this.onmessage?.({ data: JSON.stringify(reply(data)) }), 0);
            }
            close() { this.closed = true; }
        }
        return { FakeWebSocket, seen };
    };

    it('resolves with the extrinsic hash on success', async () => {
        const { submitExtrinsic } = await importSubmit();
        const { FakeWebSocket, seen } = fakeWs(() => ({ jsonrpc: '2.0', id: 1, result: '0xhash' }));
        await expect(submitExtrinsic('0xdead', { nodeUrl: 'wss://n/', WebSocketImpl: FakeWebSocket })).resolves.toBe('0xhash');
        const sent = JSON.parse(seen[0]);
        expect(sent).toMatchObject({ method: 'author_submitExtrinsic', params: ['0xdead'] });
    });

    it('a node reject carries code, message and the ledger sub-code data', async () => {
        const { submitExtrinsic, classifyNodeReject } = await importSubmit();
        const { FakeWebSocket } = fakeWs(() => ({
            jsonrpc: '2.0', id: 1,
            error: { code: 1010, message: 'Invalid Transaction', data: 'Custom error: 170' }
        }));
        const err = await submitExtrinsic('0xdead', { nodeUrl: 'wss://n/', WebSocketImpl: FakeWebSocket }).catch((e: Error & { dustRestored?: boolean; transport?: boolean; code?: number }) => e);
        expect(err.message).toContain('1010');
        expect(err.message).toContain('Custom error: 170');
        expect(err.code).toBe(1010);
        expect(classifyNodeReject(err)).toEqual({ kind: 'stale-dust-proof', subCode: 170 });
    });

    it('a silent node times out as a transport failure (the tx MAY be in the mempool)', async () => {
        const { submitExtrinsic, isTransportFailure } = await importSubmit();
        class SilentWebSocket {
            onopen: (() => void) | null = null;
            constructor() { setTimeout(() => this.onopen?.(), 0); }
            send() { /* never answers */ }
            close() { /* noop */ }
        }
        const err = await submitExtrinsic('0xdead', { nodeUrl: 'wss://n/', timeoutMs: 30, WebSocketImpl: SilentWebSocket }).catch((e: Error & { dustRestored?: boolean; transport?: boolean; code?: number }) => e);
        expect(err.message).toMatch(/timed out .* probe the indexer/);
        expect(err.transport).toBe(true);
        expect(isTransportFailure(err)).toBe(true);
    });

    it('a close before the reply fails NOW as transport, not at the timeout', async () => {
        const { submitExtrinsic, isTransportFailure } = await importSubmit();
        class ClosingWebSocket {
            onopen: (() => void) | null = null;
            onclose: ((ev: { code: number, reason: string }) => void) | null = null;
            constructor() { setTimeout(() => this.onopen?.(), 0); }
            send() { setTimeout(() => this.onclose?.({ code: 1000, reason: '' }), 0); }
            close() { /* noop */ }
        }
        const t0 = Date.now();
        const err = await submitExtrinsic('0xdead', { nodeUrl: 'wss://n/', timeoutMs: 30_000, WebSocketImpl: ClosingWebSocket })
            .catch((e: Error & { transport?: boolean }) => e);
        expect(Date.now() - t0).toBeLessThan(5_000);
        expect(err.message).toContain('1000');
        expect(err.transport).toBe(true);
        expect(isTransportFailure(err)).toBe(true);
    });

    it('the close after a successful reply does not double-settle', async () => {
        const { submitExtrinsic } = await importSubmit();
        class ReplyThenClose {
            onopen: (() => void) | null = null;
            onmessage: ((ev: { data: string }) => void) | null = null;
            onclose: ((ev: { code: number, reason: string }) => void) | null = null;
            send() { setTimeout(() => this.onmessage?.({ data: JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0xhash' }) }), 0); }
            constructor() { setTimeout(() => this.onopen?.(), 0); }
            close() { setTimeout(() => this.onclose?.({ code: 1000, reason: '' }), 0); }
        }
        await expect(submitExtrinsic('0xdead', { nodeUrl: 'wss://n/', WebSocketImpl: ReplyThenClose })).resolves.toBe('0xhash');
    });

    it('replies to other request ids are ignored', async () => {
        const { submitExtrinsic } = await importSubmit();
        let first = true;
        const { FakeWebSocket } = fakeWs(() => {
            if (first) { first = false; return { jsonrpc: '2.0', id: 7, result: 'someone elses' }; }
            return { jsonrpc: '2.0', id: 1, result: '0xmine' };
        });
        class TwoReplies extends FakeWebSocket {
            send(data: string) {
                super.send(data);
                super.send(data);
            }
        }
        await expect(submitExtrinsic('0xdead', { nodeUrl: 'wss://n/', WebSocketImpl: TwoReplies })).resolves.toBe('0xmine');
    });
});

describe('txbuilder submit: probeLanded confirms by identifier', () => {
    const fetchWith = (transactions: unknown[]) => (async () => ({
        ok: true,
        json: async () => ({ data: { transactions } })
    })) as unknown as typeof fetch;

    it('null while the indexer does not know the identifier', async () => {
        const { probeLanded } = await importSubmit();
        await expect(probeLanded('id1', { indexerHttpUrl: 'http://i', fetchFn: fetchWith([]) })).resolves.toBeNull();
    });

    it('applied on SUCCESS', async () => {
        const { probeLanded } = await importSubmit();
        const found = await probeLanded('id1', {
            indexerHttpUrl: 'http://i',
            fetchFn: fetchWith([{ block: { height: 42 }, transactionResult: { status: 'SUCCESS', segments: [] } }])
        });
        expect(found).toEqual({ height: '42', status: 'SUCCESS', failedSegments: [], applied: true });
    });

    it('in a block but NOT applied: fee spent, rebuild', async () => {
        const { probeLanded } = await importSubmit();
        const found = await probeLanded('id1', {
            indexerHttpUrl: 'http://i',
            fetchFn: fetchWith([{ block: { height: 43 }, transactionResult: { status: 'FAILURE', segments: [{ id: 1, success: false }, { id: 0, success: true }] } }])
        });
        expect(found).toEqual({ height: '43', status: 'FAILURE', failedSegments: [1], applied: false });
    });

    it('an indexer error reads as unknown, never as landed', async () => {
        const { probeLanded } = await importSubmit();
        const failing = (async () => { throw new Error('down'); }) as unknown as typeof fetch;
        await expect(probeLanded('id1', { indexerHttpUrl: 'http://i', fetchFn: failing })).resolves.toBeNull();
    });

    it('a block height WITHOUT a transaction result is unknown, never applied', async () => {
        // A partial GraphQL answer used to read as { status: null, applied: true }.
        const { probeLanded } = await importSubmit();
        await expect(probeLanded('id1', {
            indexerHttpUrl: 'http://i',
            fetchFn: fetchWith([{ block: { height: 44 }, transactionResult: null }])
        })).resolves.toBeNull();
        await expect(probeLanded('id1', {
            indexerHttpUrl: 'http://i',
            fetchFn: fetchWith([{ block: { height: 44 } }])
        })).resolves.toBeNull();
    });

    it('an HTTP failure or a GraphQL error reads as unknown', async () => {
        const { probeLanded } = await importSubmit();
        const http500 = (async () => ({ ok: false, json: async () => ({}) })) as unknown as typeof fetch;
        await expect(probeLanded('id1', { indexerHttpUrl: 'http://i', fetchFn: http500 })).resolves.toBeNull();
        const gqlError = (async () => ({
            ok: true,
            json: async () => ({ errors: [{ message: 'boom' }], data: { transactions: [{ block: { height: 45 }, transactionResult: { status: 'SUCCESS', segments: [] } }] } })
        })) as unknown as typeof fetch;
        await expect(probeLanded('id1', { indexerHttpUrl: 'http://i', fetchFn: gqlError })).resolves.toBeNull();
    });

    it('waitLanded probes at least once and polls until the deadline', async () => {
        const { waitLanded } = await importSubmit();
        // timeoutMs 0: exactly one probe, then unknown.
        let probes = 0;
        const never = (async () => { probes++; return { ok: true, json: async () => ({ data: { transactions: [] } }) }; }) as unknown as typeof fetch;
        await expect(waitLanded('id1', { indexerHttpUrl: 'http://i', timeoutMs: 0, fetchFn: never })).resolves.toBeNull();
        expect(probes).toBe(1);
        // Known on the second poll: the refused-resend case where the first
        // send landed but the indexer lagged behind the immediate probe.
        let n = 0;
        const lateFound = (async () => ({
            ok: true,
            json: async () => (++n < 2
                ? { data: { transactions: [] } }
                : { data: { transactions: [{ block: { height: 7 }, transactionResult: { status: 'SUCCESS', segments: [] } }] } })
        })) as unknown as typeof fetch;
        const found = await waitLanded('id1', { indexerHttpUrl: 'http://i', timeoutMs: 2_000, pollMs: 10, fetchFn: lateFound });
        expect(found).toMatchObject({ height: '7', applied: true });
    });

    it('sends the identifier-offset query', async () => {
        const { probeLanded } = await importSubmit();
        let body = '';
        const capture = (async (_url: string, init: { body: string }) => {
            body = init.body;
            return { json: async () => ({ data: { transactions: [] } }) };
        }) as unknown as typeof fetch;
        await probeLanded('abc123', { indexerHttpUrl: 'http://i', fetchFn: capture });
        expect(JSON.parse(body).query).toContain('transactions(offset:{identifier:"abc123"})');
    });
});

describe('txbuilder submit: withDustGuard', () => {
    const makeFacade = (snapshot: unknown = 'snap') => {
        const stopped: unknown[] = [];
        const facade = {
            dust: {
                serializeState: async () => { if (snapshot instanceof Error) throw snapshot; return snapshot; },
                stop: async function () { stopped.push(this); }
            }
        };
        return { facade, stopped, originalDust: facade.dust };
    };
    const makeFactory = () => {
        const calls: unknown[] = [];
        const fresh = { started: null as unknown, start: async function (key: unknown) { this.started = key; } };
        const factory = (configuration: unknown) => ({
            restore: (snapshot: unknown) => { calls.push({ configuration, snapshot }); return fresh; }
        });
        return { factory, fresh, calls };
    };

    it('passes the result through untouched on success', async () => {
        const { withDustGuard } = await importSubmit();
        const { facade } = makeFacade();
        const { factory } = makeFactory();
        await expect(withDustGuard(facade, { configuration: {}, dustKey: 'k', dustWalletFactory: factory }, async () => 'ok')).resolves.toBe('ok');
        expect(facade.dust.stop).toBeDefined();
    });

    it('a pre-mempool reject swaps in the restored dust wallet and marks the error', async () => {
        const { withDustGuard } = await importSubmit();
        const { facade, stopped, originalDust } = makeFacade('snap');
        const { factory, fresh, calls } = makeFactory();
        const cfg = { networkId: 'preprod' };
        const err = await withDustGuard(facade, { configuration: cfg, dustKey: 'dk', dustWalletFactory: factory }, async () => {
            throw new Error('1010: Invalid Transaction: Custom error: 170');
        }).catch((e: Error & { dustRestored?: boolean; transport?: boolean; code?: number }) => e);
        expect(err.message).toContain('170');
        expect(err.dustRestored).toBe(true);
        expect(calls).toEqual([{ configuration: cfg, snapshot: 'snap' }]);
        expect(fresh.started).toBe('dk');
        expect(facade.dust).toBe(fresh);
        expect(stopped).toEqual([originalDust]);
    });

    it('a transport failure or plain error restores nothing (the spend may be in flight)', async () => {
        const { withDustGuard } = await importSubmit();
        const { facade, originalDust } = makeFacade();
        const { factory, calls } = makeFactory();
        const err = await withDustGuard(facade, { configuration: {}, dustKey: 'k', dustWalletFactory: factory }, async () => {
            throw new Error('read ECONNRESET');
        }).catch((e: Error & { dustRestored?: boolean; transport?: boolean; code?: number }) => e);
        expect(err.dustRestored).toBeUndefined();
        expect(calls).toEqual([]);
        expect(facade.dust).toBe(originalDust);
    });

    it('a failed snapshot only disarms the guard, the build still runs', async () => {
        const { withDustGuard } = await importSubmit();
        const { facade, originalDust } = makeFacade(new Error('serialize broken'));
        const { factory, calls } = makeFactory();
        const err = await withDustGuard(facade, { configuration: {}, dustKey: 'k', dustWalletFactory: factory }, async () => {
            throw new Error('1010: Invalid Transaction: Custom error: 170');
        }).catch((e: Error & { dustRestored?: boolean; transport?: boolean; code?: number }) => e);
        expect(err.message).toContain('170');
        expect(err.dustRestored).toBeUndefined();
        expect(calls).toEqual([]);
        expect(facade.dust).toBe(originalDust);
    });

    it('a failing restore keeps the old wallet (no worse than without the guard)', async () => {
        const { withDustGuard } = await importSubmit();
        const { facade, originalDust } = makeFacade();
        const factory = () => ({ restore: () => { throw new Error('restore broken'); } });
        const err = await withDustGuard(facade, { configuration: {}, dustKey: 'k', dustWalletFactory: factory }, async () => {
            throw new Error('1010: Invalid Transaction: Custom error: 170');
        }).catch((e: Error & { dustRestored?: boolean; transport?: boolean; code?: number }) => e);
        expect(err.message).toContain('170');
        expect(facade.dust).toBe(originalDust);
    });
});
