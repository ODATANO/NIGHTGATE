/**
 * In-process keyed async mutex: callers with the same key run strictly one
 * after another, different keys run independently.
 *
 * An in-memory lock is sufficient cross-cutting serialization here because
 * NIGHTGATE enforces a single-instance runtime topology at boot
 * (srv/utils/runtime-topology.ts); there is no second process that could
 * race it. Used to serialize wallet-facade builds against shared-session
 * eviction decisions for the same account.
 */

const chains = new Map<string, Promise<unknown>>();

export function withKeyedLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = chains.get(key) ?? Promise.resolve();
    // Run after the previous holder settles, regardless of its outcome.
    const run = prev.then(fn, fn);
    const tail = run.then(() => undefined, () => undefined);
    chains.set(key, tail);
    void tail.then(() => {
        if (chains.get(key) === tail) chains.delete(key);
    });
    return run;
}
