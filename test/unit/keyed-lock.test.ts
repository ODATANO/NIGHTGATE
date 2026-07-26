/**
 * Tests for srv/utils/keyed-lock.ts: per-key serialization, error
 * propagation without poisoning the chain, key independence.
 */

import { withKeyedLock } from '../../srv/utils/keyed-lock';

describe('withKeyedLock', () => {
    it('serializes same-key work in call order', async () => {
        const order: string[] = [];
        let releaseA!: () => void;
        const gateA = new Promise<void>(resolve => { releaseA = resolve; });

        const a = withKeyedLock('k1', async () => { order.push('a-start'); await gateA; order.push('a-end'); });
        const b = withKeyedLock('k1', async () => { order.push('b'); });

        await new Promise(resolve => setImmediate(resolve));
        expect(order).toEqual(['a-start']); // b must wait for a

        releaseA();
        await Promise.all([a, b]);
        expect(order).toEqual(['a-start', 'a-end', 'b']);
    });

    it('a rejected holder does not block the next caller and propagates its error', async () => {
        const first = withKeyedLock('k2', async () => { throw new Error('boom'); });
        const second = withKeyedLock('k2', async () => 'ok');

        await expect(first).rejects.toThrow('boom');
        await expect(second).resolves.toBe('ok');
    });

    it('different keys run independently', async () => {
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });

        const slow = withKeyedLock('k3', async () => { await gate; return 'slow'; });
        const fast = await withKeyedLock('k4', async () => 'fast');

        expect(fast).toBe('fast'); // not blocked by k3's holder
        release();
        await expect(slow).resolves.toBe('slow');
    });
});
