/**
 * The wallet worker's private-state proxy (`srv/midnight/worker/private-state.ts`): every call goes to the main thread
 * over a fresh port, answers and failures come back, and the export and import methods never leave the main thread.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MessagePort } from 'node:worker_threads';

type Posted = { kind: string; proxyId: string; method: string; args: unknown[]; port: MessagePort };
const posted = vi.hoisted(() => [] as Posted[]);
const reply = vi.hoisted(() => ({ fn: undefined as undefined | ((msg: Posted) => void) }));

vi.mock('node:worker_threads', async (importActual) => {
    const actual = await importActual<typeof import('node:worker_threads')>();
    return {
        ...actual,
        parentPort: {
            postMessage: (msg: Posted) => {
                posted.push(msg);
                reply.fn?.(msg);
            }
        }
    };
});

import { createPrivateStateProxy, privateStateRpc, PRIVATE_STATE_RPC_TIMEOUT_MS } from '../../srv/midnight/worker/private-state';

beforeEach(() => {
    posted.length = 0;
    reply.fn = undefined;
});
afterEach(() => vi.useRealTimers());

describe('private-state proxy', () => {
    it('sends each call with the proxy id, the method and the contract address, and returns the answer', async () => {
        reply.fn = (msg) => msg.port.postMessage({ ok: true, result: { method: msg.method } });
        const states = createPrivateStateProxy('proxy-1').forContract('AB12');
        expect(await states.get('ps')).toEqual({ method: 'get' });
        await states.set('ps', { n: 1 });
        expect(posted.map(p => [p.kind, p.proxyId, p.method, p.args])).toEqual([
            ['private-state-rpc', 'proxy-1', 'get', ['AB12', 'ps']],
            ['private-state-rpc', 'proxy-1', 'set', ['AB12', 'ps', { n: 1 }]]
        ]);
        expect(states.contractAddress).toBe('ab12');
    });

    it('the signing-key calls carry their address and nothing else', async () => {
        reply.fn = (msg) => msg.port.postMessage({ ok: true, result: null });
        const provider = createPrivateStateProxy('proxy-2');
        await provider.getSigningKey('cc');
        await provider.clearAll();
        expect(posted.map(p => [p.method, p.args])).toEqual([['getSigningKey', ['cc']], ['clearAll', []]]);
    });

    it('a failure on the main thread arrives with its name and message', async () => {
        reply.fn = (msg) => msg.port.postMessage({ ok: false, error: { name: 'ImportConflictError', message: '2 keys already stored' } });
        const err = await createPrivateStateProxy('p').forContract('aa').remove('ps').catch((e: Error) => e);
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).name).toBe('ImportConflictError');
        expect((err as Error).message).toBe('2 keys already stored');
    });

    it('an empty failure still rejects', async () => {
        reply.fn = (msg) => msg.port.postMessage(null);
        await expect(privateStateRpc('p', 'get', [])).rejects.toThrow('private-state rpc failed');
    });

    it('export and import are refused in the worker and never reach the main thread', () => {
        const provider = createPrivateStateProxy('p');
        const states = provider.forContract('aa');
        expect(() => states.exportPrivateStates()).toThrow(/exportPrivateStates' is not available from the wallet worker/);
        expect(() => states.importPrivateStates({} as never)).toThrow(/importPrivateStates/);
        expect(() => provider.exportSigningKeys()).toThrow(/exportSigningKeys/);
        expect(() => provider.importSigningKeys({} as never)).toThrow(/importSigningKeys/);
        expect(posted).toHaveLength(0);
    });

    it('an empty contract address is refused before anything is sent', () => {
        expect(() => createPrivateStateProxy('p').forContract('')).toThrow('Contract address must not be empty');
        expect(posted).toHaveLength(0);
    });

    it('a call the main thread never answers fails after the time limit', async () => {
        vi.useFakeTimers();
        const pending = privateStateRpc('p', 'get', ['aa', 'ps']).catch((e: Error) => e);
        await vi.advanceTimersByTimeAsync(PRIVATE_STATE_RPC_TIMEOUT_MS + 1);
        const err = await pending;
        expect((err as Error).message).toMatch(/'get' was not answered by the main thread within 60000ms/);
    });
});
