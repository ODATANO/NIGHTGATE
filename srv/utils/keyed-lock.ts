/**
 * Async lock per key. Callers with the same key run one after another. Different keys run in parallel.
 * An in-memory lock is enough because only one NIGHTGATE process may run (see runtime-topology.ts).
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
