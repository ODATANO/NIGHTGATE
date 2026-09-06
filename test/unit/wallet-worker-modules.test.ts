/**
 * The worker's concurrency logic, exercised through the module boundaries
 * (`srv/midnight/worker/*`) rather than the thread entry: rotation drain and
 * refusal, an evict that waits behind an in-flight submit, session lock
 * chains of evicted sessions, the private-state RPC bound.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const fakeParentPort = vi.hoisted(() => {
    const posted: any[] = [];
    return {
        posted,
        postMessage: vi.fn((m: any) => { posted.push(m); }),
        on: vi.fn(),
        once: vi.fn()
    };
});

vi.mock('node:worker_threads', async () => {
    const actual = await vi.importActual<any>('node:worker_threads');
    return { ...actual, parentPort: fakeParentPort };
});

import { facades, type FacadeEntry } from '../../srv/midnight/worker/context';
import { withSessionLocks, sessionChains, evict } from '../../srv/midnight/worker/facades';
import { rotationState, noteGenerationImported, rotateIfDue, __resetRotationForTests, shutdown } from '../../srv/midnight/worker/rotation';
import { handleMessage } from '../../srv/midnight/worker/rpc';
import { privateStateRpc, PRIVATE_STATE_RPC_TIMEOUT_MS } from '../../srv/midnight/worker/private-state';
import { WORKER_ROTATING } from '../../srv/midnight/wallet-worker-protocol';

function fakePort() {
    return { postMessage: vi.fn(), close: vi.fn() };
}

function entryFor(sessionId: string): FacadeEntry {
    return {
        sessionId,
        facade: {
            stop: vi.fn(async () => undefined),
            shielded: { serializeState: vi.fn(async () => `sh-${sessionId}`) },
            unshielded: { serializeState: vi.fn(async () => `un-${sessionId}`) },
            dust: { serializeState: vi.fn(async () => `du-${sessionId}`) }
        },
        sdkVersion: 'test',
        zswapKeys: { clear: vi.fn() },
        dustKey: { clear: vi.fn() },
        unshieldedKeystore: { clear: vi.fn() },
        networkId: 'preprod',
        indexerHttpUrl: 'http://indexer.test',
        walletConfiguration: {},
        attestationSecret: new Uint8Array(32).fill(7)
    };
}

beforeEach(() => {
    __resetRotationForTests();
    facades.clear();
    sessionChains.clear();
    fakeParentPort.posted.length = 0;
    fakeParentPort.postMessage.mockClear();
    delete process.env.NIGHTGATE_WORKER_MAX_GENERATIONS;
});

afterEach(() => {
    vi.useRealTimers();
});

describe('rotation drain', () => {
    it('closes admission once the generation budget is reached and finalizes only at zero in-flight submits', async () => {
        process.env.NIGHTGATE_WORKER_MAX_GENERATIONS = '2';
        expect(noteGenerationImported('gen-a')).toBe(false);
        expect(noteGenerationImported('gen-b')).toBe(true);
        expect(rotationState.pending).toBe(true);

        // a submit is in flight: admission closes, the thread does not finalize
        rotationState.inflight = 1;
        rotateIfDue();
        expect(rotationState.draining).toBe(true);
        expect(rotationState.finalizing).toBe(false);
        expect(fakeParentPort.posted.find(m => m.kind === 'rotating')).toMatchObject({ generations: 2, inflight: 1 });

        // a new RPC is refused with WORKER_ROTATING while draining
        const port = fakePort();
        await handleMessage({ kind: 'rpc', method: 'getBalance', args: { sessionId: 'x' }, port });
        expect(port.postMessage).toHaveBeenCalledWith({ ok: false, error: expect.objectContaining({ name: WORKER_ROTATING }) });
        expect(port.close).toHaveBeenCalled();

        // the in-flight submit completes: evict-all runs and rotation-done is announced
        rotationState.inflight = 0;
        rotateIfDue();
        expect(rotationState.finalizing).toBe(true);
        await new Promise(r => setImmediate(r));
        expect(fakeParentPort.posted.find(m => m.kind === 'rotation-done')).toMatchObject({ generations: 2, evicted: 0, failed: 0 });
    });

    it('shutdown closes admission and evicts every facade with an acked final save', async () => {
        facades.set('s-shutdown', entryFor('s-shutdown'));
        // the main thread acks every save it is pushed, like the persist sink does
        const base = fakeParentPort.postMessage.getMockImplementation()!;
        fakeParentPort.postMessage.mockImplementation((m: any) => {
            base(m);
            if (m?.kind === 'state-save') void handleMessage({ kind: 'state-save-ack', sessionId: m.sessionId, seq: m.seq });
        });
        const out = await shutdown();
        expect(out).toEqual({ evicted: 1, failed: 0 });
        expect(rotationState.draining).toBe(true);
        expect(facades.size).toBe(0);
        expect(fakeParentPort.posted.some(m => m.kind === 'state-save' && m.sessionId === 's-shutdown')).toBe(true);
    });
});

describe('evict during an in-flight submit', () => {
    it('removes the facade from the registry at once but zeroes the keys only after the submit released the session lock', async () => {
        const entry = entryFor('s-evict');
        facades.set('s-evict', entry);
        let releaseSubmit!: () => void;
        const submitDone = new Promise<void>(r => { releaseSubmit = r; });
        const submit = withSessionLocks(['s-evict'], () => submitDone);

        const eviction = evict({ sessionId: 's-evict' });
        await new Promise(r => setImmediate(r));
        // no NEW submit resolves the facade, the in-flight one keeps its keys
        expect(facades.has('s-evict')).toBe(false);
        expect(entry.zswapKeys.clear).not.toHaveBeenCalled();
        expect(entry.facade.stop).not.toHaveBeenCalled();

        releaseSubmit();
        await submit;
        await expect(eviction).resolves.toEqual({ evicted: true, saved: true });
        expect(entry.zswapKeys.clear).toHaveBeenCalledTimes(1);
        expect(entry.dustKey.clear).toHaveBeenCalledTimes(1);
        expect(entry.unshieldedKeystore.clear).toHaveBeenCalledTimes(1);
        expect(entry.attestationSecret.every(b => b === 0)).toBe(true);
        expect(entry.facade.stop).toHaveBeenCalledTimes(1);
        const save = fakeParentPort.posted.find(m => m.kind === 'state-save' && m.sessionId === 's-evict');
        expect(save?.blobs).toEqual({ shielded: 'sh-s-evict', unshielded: 'un-s-evict', dust: 'du-s-evict' });
    });

    it('evict of an unknown session is a no-op', async () => {
        await expect(evict({ sessionId: 'ghost' })).resolves.toEqual({ evicted: false });
        expect(sessionChains.has('ghost')).toBe(false);
    });
});

describe('session lock chains', () => {
    it('drops the chain of an evicted session once its last holder released, never the gate of a later locker', async () => {
        facades.set('s-chain', entryFor('s-chain'));
        let releaseFirst!: () => void;
        const first = withSessionLocks(['s-chain'], () => new Promise<void>(r => { releaseFirst = r; }));
        let releaseSecond!: () => void;
        let secondStarted = false;
        const second = withSessionLocks(['s-chain'], () => { secondStarted = true; return new Promise<void>(r => { releaseSecond = r; }); });
        await new Promise(r => setImmediate(r));
        expect(secondStarted).toBe(false);
        const gateOfSecond = sessionChains.get('s-chain');
        expect(gateOfSecond).toBeDefined();

        // the session goes away while both are queued
        facades.delete('s-chain');
        releaseFirst();
        await first;
        await new Promise(r => setImmediate(r));
        // the first holder's release did not delete the second locker's gate
        expect(sessionChains.get('s-chain')).toBe(gateOfSecond);
        expect(secondStarted).toBe(true);

        releaseSecond();
        await second;
        // the last holder of a session without a facade drops the chain
        expect(sessionChains.has('s-chain')).toBe(false);
    });

    it('keeps the chain of a session that still has a facade', async () => {
        facades.set('s-keep', entryFor('s-keep'));
        await withSessionLocks(['s-keep'], async () => undefined);
        expect(sessionChains.has('s-keep')).toBe(true);
    });

    it('multi-key locks never hold one slot while waiting for another', async () => {
        const order: string[] = [];
        let releaseA!: () => void;
        const a = withSessionLocks(['a'], () => new Promise<void>(r => { releaseA = r; }).then(() => { order.push('a'); }));
        const ab = withSessionLocks(['b', 'a'], async () => { order.push('ab'); });
        const b = withSessionLocks(['b'], async () => { order.push('b'); });
        await new Promise(r => setImmediate(r));
        // `ab` waits for `a`; `b` queued behind `ab` on key b is not run early
        expect(order).toEqual([]);
        releaseA();
        await Promise.all([a, ab, b]);
        expect(order).toEqual(['a', 'ab', 'b']);
    });
});

describe('private-state RPC bound', () => {
    it('rejects when the main thread does not answer within the bound', async () => {
        vi.useFakeTimers();
        const pending = privateStateRpc('proxy-1', 'get', ['key']);
        const posted = fakeParentPort.posted.find(m => m.kind === 'private-state-rpc');
        expect(posted).toMatchObject({ proxyId: 'proxy-1', method: 'get', args: ['key'] });
        const settled = pending.then(() => 'resolved', (e: Error) => e.message);
        await vi.advanceTimersByTimeAsync(PRIVATE_STATE_RPC_TIMEOUT_MS + 1);
        await expect(settled).resolves.toMatch(/'get' was not answered by the main thread within 60000ms/);
        posted.port?.close?.();
    });
});
