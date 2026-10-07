/** srv/midnight/worker-rpc/dispatch.ts: one reply per call on the call's port, errors carried with their causes. */

import { describe, it, expect, vi } from 'vitest';
import { MessageChannel } from 'node:worker_threads';
import { createDispatcher, type WorkerRpcReply } from '../../srv/midnight/worker-rpc/dispatch';
import { NightgateError } from '../../srv/utils/errors';

function call(dispatch: (msg: unknown) => Promise<void>, method: string, args: unknown): Promise<WorkerRpcReply> {
    const { port1, port2 } = new MessageChannel();
    const reply = new Promise<WorkerRpcReply>((resolve) => {
        port2.once('message', (m: WorkerRpcReply) => { port2.close(); resolve(m); });
    });
    void dispatch({ kind: 'rpc', method, args, port: port1 });
    return reply;
}

describe('createDispatcher', () => {
    const warn = vi.fn();
    const dispatch = createDispatcher({
        echo: async (args) => ({ got: args }),
        fail: async () => { throw new Error('outer', { cause: new Error('inner') }); },
        coded: async () => { throw new NightgateError('NOT_FOUND', 'no such contract'); }
    }, warn);

    it('answers a known method with its result', async () => {
        await expect(call(dispatch, 'echo', { a: 1n })).resolves.toEqual({ ok: true, result: { got: { a: 1n } } });
    });

    it('answers an unknown method with an error reply, never with silence', async () => {
        const reply = await call(dispatch, 'nope', {});
        expect(reply.ok).toBe(false);
        if (!reply.ok) expect(reply.error.message).toContain('Unknown method: nope');
    });

    it('flattens the cause chain into the error reply', async () => {
        const reply = await call(dispatch, 'fail', {});
        expect(reply.ok).toBe(false);
        if (!reply.ok) {
            expect(reply.error.name).toBe('Error');
            expect(reply.error.message).toContain('inner');
            expect(reply.error.causes).toEqual(['inner']);
        }
    });

    it('carries a coded error so the main thread rebuilds it', async () => {
        const reply = await call(dispatch, 'coded', {});
        expect(reply.ok).toBe(false);
        if (!reply.ok) expect(reply.error.nightgate).toMatchObject({ code: 'NOT_FOUND', message: 'no such contract' });
    });

    it('logs and ignores a message that is not a call', async () => {
        await dispatch({ kind: 'something' });
        expect(warn).toHaveBeenCalledWith('warn', expect.stringContaining('unexpected message'));
    });
});
