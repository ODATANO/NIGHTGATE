/** Calls a reconciliation finalizer like the reconciler does: `tx` for its writes, deferred work after it returns. */
export async function runFinalizer(finalizer: any, command: unknown, job: unknown, evidence: unknown, tx: unknown): Promise<any> {
    const later: Array<() => Promise<void>> = [];
    const result = await finalizer(command, job, evidence, tx, (work: () => Promise<void>) => { later.push(work); });
    for (const work of later) await work();
    return result;
}
