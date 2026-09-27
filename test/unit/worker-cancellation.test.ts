/**
 * Caller cancellation inside the wallet worker: wait points stop once the caller
 * cancelled, never after the submit intent, and never outside an RPC.
 */
import { describe, it, expect } from 'vitest';
import {
    runInRpcScope, throwIfRpcCancelled, rpcCancellation, markIntentAnnounced, RpcCancelledError
} from '../../srv/midnight/worker/cancellation';

describe('worker cancellation', () => {
    it('is a no-op outside an RPC', () => {
        expect(() => throwIfRpcCancelled('anywhere')).not.toThrow();
    });

    it('stops a wait point once the caller cancelled', async () => {
        const ctl = new AbortController();
        await runInRpcScope('submitContractCall', ctl.signal, async () => {
            expect(() => throwIfRpcCancelled('sync wait')).not.toThrow();
            ctl.abort();
            expect(() => throwIfRpcCancelled('sync wait')).toThrow(RpcCancelledError);
        });
    });

    it('never stops the call after its submit intent', async () => {
        const ctl = new AbortController();
        await runInRpcScope('submitContractCall', ctl.signal, async () => {
            markIntentAnnounced();
            ctl.abort();
            expect(() => throwIfRpcCancelled('after intent')).not.toThrow();
            const c = rpcCancellation('after intent');
            const settled = await Promise.race([c.promise.then(() => 'rejected', () => 'rejected'), new Promise(r => setTimeout(() => r('open'), 20))]);
            c.dispose();
            expect(settled).toBe('open');
        });
    });

    it('rejects a raced wait when the caller cancels', async () => {
        const ctl = new AbortController();
        await runInRpcScope('getBalance', ctl.signal, async () => {
            const c = rpcCancellation('getBalance sync wait');
            const never = new Promise(() => undefined);
            setTimeout(() => ctl.abort(), 5);
            await expect(Promise.race([never, c.promise])).rejects.toBeInstanceOf(RpcCancelledError);
            c.dispose();
        });
    });

    it('keeps one call\'s cancel away from another call', async () => {
        const a = new AbortController();
        const b = new AbortController();
        a.abort();
        await runInRpcScope('a', a.signal, async () => expect(() => throwIfRpcCancelled('x')).toThrow());
        await runInRpcScope('b', b.signal, async () => expect(() => throwIfRpcCancelled('x')).not.toThrow());
    });
});
