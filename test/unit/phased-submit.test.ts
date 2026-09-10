/**
 * The phased submit (srv/midnight/worker/phased-submit.ts) driven through a
 * fake node adapter: every failure shape the two lost broadcasts could have
 * had, and what the status, the error and the log say about each.
 */
import { describe, it, expect, vi } from 'vitest';
import { createPhasedSubmitService, SubmitPhaseError, submitPhaseOf, type SubmitNodeAdapter, type NodeSubmitEvent, type SocketEvent } from '../../srv/midnight/worker/phased-submit';
import { classifySubmitFailure } from '../../srv/midnight/submit-error-classification';
import { isPreInclusionReject, decideSponsorFailure } from '../../srv/submission/sponsor-pool';

vi.mock('../../srv/midnight/worker/context', () => ({ log: vi.fn() }));

type Script = {
    connect?: () => Promise<void>;
    /** Drives the subscription: return a promise that settles when the stream ends. */
    send?: (emit: (ev: NodeSubmitEvent) => void, signal: AbortSignal) => Promise<void>;
};

function fakeAdapter(script: Script) {
    const socket: Array<(ev: SocketEvent) => void> = [];
    const closed = vi.fn(async () => undefined);
    const adapter: SubmitNodeAdapter = {
        connect: script.connect ?? (async () => undefined),
        send: (_bytes, onEvent, signal) => (script.send ?? (async () => undefined))(onEvent, signal),
        onSocket: (cb) => { socket.push(cb); },
        close: closed
    };
    return { adapter, emitSocket: (ev: SocketEvent) => socket.forEach((cb) => cb(ev)), closed };
}

const tx = { serialize: () => new Uint8Array([1, 2, 3]) };
const T = { connectMs: 50, requestMs: 80, watchMs: 120, closeMs: 30, lateGraceMs: 60 };
const never = () => new Promise<void>(() => undefined);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** A stream that stays open until aborted (like the SDK's subscription). */
const untilAbort = (signal: AbortSignal) => new Promise<void>((r) => { if (signal.aborted) r(); else signal.addEventListener('abort', () => r()); });

function service(script: Script, logSink: string[] = []) {
    const f = fakeAdapter(script);
    const svc = createPhasedSubmitService({ adapter: async () => f.adapter, timeouts: T, log: (level, msg) => logSink.push(`${level} ${msg}`) });
    return { svc, ...f, logSink };
}

describe('phased submit', () => {
    it('happy path: Submitted then InBlock, one phase line with the durations, the stream is released after InBlock', async () => {
        let signal: AbortSignal | undefined;
        const { svc, logSink } = service({
            send: async (emit, s) => {
                signal = s;
                emit({ tag: 'Submitted', txHash: '0xh' });
                await sleep(10);
                emit({ tag: 'InBlock', txHash: '0xh', blockHeight: 42 });
                await untilAbort(s);
            }
        });
        const ev = await svc.submitTransaction(tx, 'InBlock', { identifier: '00abc', correlation: 'unit' });
        expect(ev).toMatchObject({ tag: 'InBlock', blockHeight: 42 });
        expect(signal?.aborted).toBe(true); // done watching: unsubscribe + disconnect
        expect(logSink.some((l) => /^info submit-phases unit 00abc phase=watch OK InBlock .*statuses=status-Submitted@\+\d+\.\ds status-InBlock@\+\d+\.\ds\(block 42\)/.test(l))).toBe(true);
        await sleep(5);
        expect(logSink.filter((l) => /submit-late/.test(l))).toEqual([]); // an abort is not a late result
    });

    it('slow connect: the connect phase times out, NOTHING is sent, the failure is transport/not-sent and pre-inclusion (safe to rebuild)', async () => {
        const send = vi.fn(never);
        const { svc, logSink } = service({ connect: never, send });
        const err = await svc.submitTransaction(tx, 'InBlock', { identifier: '00slow' }).catch((e) => e);
        expect(err).toBeInstanceOf(SubmitPhaseError);
        expect(err.phase).toBe('connect');
        expect(err.message).toMatch(/nothing was sent/);
        expect(send).not.toHaveBeenCalled();
        expect(classifySubmitFailure(err)).toEqual({ code: 'transport', ledgerCode: 'not-sent', retryable: true });
        expect(isPreInclusionReject(err)).toBe(true);
        expect(decideSponsorFailure(err)).toMatchObject({ decision: 'fail', preInclusion: true });
        expect(logSink.some((l) => /^warn submit-phases submit 00slow phase=connect FAILED/.test(l))).toBe(true);
    });

    it('a connect that rejects (the SDK gave up) is the same finding, with the cause kept', async () => {
        const { svc } = service({ connect: async () => { throw new Error('Could not connect within specified time range'); } });
        const err = await svc.submitTransaction(tx, 'InBlock').catch((e) => e);
        expect(submitPhaseOf(err)).toBe('connect');
        expect(String((err as Error).cause && ((err as Error).cause as Error).message)).toMatch(/Could not connect/);
    });

    it('no RPC answer: sent, no status within the request budget: ambiguous/no-reply; the subscription stays open for the grace, then is aborted', async () => {
        let signal: AbortSignal | undefined;
        const { svc, logSink } = service({ send: (_emit, s) => { signal = s; return untilAbort(s); } });
        const err = await svc.submitTransaction(tx, 'InBlock', { identifier: '00noreply' }).catch((e) => e);
        expect(err.phase).toBe('request');
        expect(err.message).toMatch(/no status from the node within 80ms after the send/);
        expect(signal?.aborted).toBe(false); // still listening
        expect(classifySubmitFailure(err)).toEqual({ code: 'ambiguous', ledgerCode: 'no-reply', retryable: false });
        expect(decideSponsorFailure(err).decision).toBe('ambiguous');
        expect(logSink.some((l) => /phase=request FAILED: no status from the node within 80ms after the send; listening 60ms more/.test(l))).toBe(true);
        await sleep(T.lateGraceMs + 30);
        expect(signal?.aborted).toBe(true);
    });

    it('socket dropped after the subscription was acknowledged: the stream fails in the watch phase, the timeline carries the socket close and the last status', async () => {
        const f = service({
            send: async (emit) => {
                emit({ tag: 'Submitted', txHash: '0xh' });
                await sleep(5);
                f.emitSocket({ kind: 'disconnected' });
                throw new Error('disconnected from wss://rpc: 1006:: Abnormal Closure');
            }
        });
        const err = await f.svc.submitTransaction(tx, 'InBlock', { identifier: '00drop' }).catch((e) => e);
        // the node's own failure keeps its text (classified by it), not a phase error
        expect(err).not.toBeInstanceOf(SubmitPhaseError);
        expect(err.message).toMatch(/Abnormal Closure/);
        expect(classifySubmitFailure(err).code).toBe('transport');
        const line = f.logSink.find((l) => /phase=watch FAILED/.test(l))!;
        expect(line).toMatch(/status-Submitted@/);
        expect(line).toMatch(/socket-disconnected@/);
    });

    it('Ready without InBlock: the watch phase times out naming the last status (ambiguous); a late InBlock is still logged under the identifier', async () => {
        let emitLate!: (ev: NodeSubmitEvent) => void;
        const { svc, logSink } = service({
            send: async (emit, s) => {
                emitLate = emit;
                emit({ tag: 'Submitted', txHash: '0xh' });
                await untilAbort(s);
            }
        });
        const err = await svc.submitTransaction(tx, 'InBlock', { identifier: '00ready' }).catch((e) => e);
        expect(err.phase).toBe('watch');
        expect(err.message).toMatch(/submit watch timed out after 120ms without a InBlock status \(the node acknowledged the request; last status Submitted\)/);
        expect(classifySubmitFailure(err)).toEqual({ code: 'ambiguous', retryable: false });
        expect(decideSponsorFailure(err).decision).toBe('ambiguous');
        expect(logSink.some((l) => /phase=watch FAILED: no InBlock within 120ms of the first status; listening 60ms more/.test(l))).toBe(true);
        emitLate({ tag: 'InBlock', txHash: '0xh', blockHeight: 77 });
        expect(logSink.some((l) => /^warn submit-late submit 00ready: status InBlock \(block 77\) at \+\d+\.\ds, after the attempt had given up/.test(l))).toBe(true);
    });

    it('a late reject after the request phase gave up is logged with the identifier, never lost', async () => {
        let fail!: (e: Error) => void;
        const { svc, logSink } = service({ send: () => new Promise<void>((_r, rej) => { fail = rej; }) });
        await expect(svc.submitTransaction(tx, 'InBlock', { identifier: '00late' })).rejects.toBeInstanceOf(SubmitPhaseError);
        fail(new Error('1010: Invalid Transaction: Custom error: 104'));
        await sleep(5);
        expect(logSink.some((l) => /^warn submit-late submit 00late: node reported after the attempt settled: 1010: Invalid Transaction: Custom error: 104/.test(l))).toBe(true);
    });

    it('a stream that ends by itself after the attempt (Finalized reached) logs the natural end', async () => {
        const { svc, logSink } = service({
            send: async (emit) => {
                emit({ tag: 'Submitted', txHash: '0xh' });
                emit({ tag: 'InBlock', txHash: '0xh', blockHeight: 1 });
                await sleep(5);
                emit({ tag: 'Finalized', txHash: '0xh', blockHeight: 1 });
            }
        });
        const ev = await svc.submitTransaction(tx, 'Finalized', { identifier: '00fin' });
        expect(ev.tag).toBe('Finalized');
        await sleep(10);
        expect(logSink.some((l) => /submit-late submit 00fin: subscription ended after the attempt settled/.test(l))).toBe(true);
    });

    it('close is bounded: a client whose close hangs does not hang the caller; an open late window is waited for first', async () => {
        const f = service({ send: (_e, s) => untilAbort(s) });
        f.closed.mockImplementation(never as any);
        await f.svc.submitTransaction(tx, 'InBlock').catch(() => undefined); // request-phase timeout: a late window is open
        const t0 = Date.now();
        await f.svc.close();
        const took = Date.now() - t0;
        expect(took).toBeGreaterThanOrEqual(T.lateGraceMs - 10); // the listener kept the socket
        expect(took).toBeLessThan(T.lateGraceMs + T.closeMs + 300);
        expect(f.closed).toHaveBeenCalled();
    });

    it('a failed adapter creation is retried by the next attempt', async () => {
        let n = 0;
        const good = fakeAdapter({ send: async (emit) => { emit({ tag: 'Submitted' }); emit({ tag: 'InBlock', blockHeight: 2 }); } });
        const svc = createPhasedSubmitService({
            adapter: async () => { if (n++ === 0) throw new Error('ApiPromise.create failed'); return good.adapter; },
            timeouts: T, log: () => undefined
        });
        await expect(svc.submitTransaction(tx, 'InBlock')).rejects.toMatchObject({ phase: 'connect' });
        await expect(svc.submitTransaction(tx, 'InBlock')).resolves.toMatchObject({ tag: 'InBlock' });
    });
});
