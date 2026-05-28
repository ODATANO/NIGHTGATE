import cds from '@sap/cds';

/**
 * CAP can expose a DB service before its model is attached. String-based
 * INSERT/UPDATE/DELETE queries then fail during view resolution. Ensure the
 * shared CDS model is loaded before connecting write-heavy runtime services.
 *
 * Runtime function-existence checks are kept on purpose: many unit tests
 * provide a partial `cds` mock (just the methods they exercise). Without
 * the guards, the bare load/linked call would throw during test setup even
 * though the production runtime has both methods. Type-wise `cds.load` /
 * `cds.linked` are guaranteed by @cap-js/cds-types; the guards are runtime
 * insurance only.
 */
export async function ensureNightgateModelLoaded(): Promise<void> {
    if (cds.model) return;
    if (typeof cds.load !== 'function') return;
    const csn = await cds.load('*');
    if (!csn) return;
    if (typeof cds.linked === 'function') {
        cds.model = cds.linked(csn);
    } else {
        // Tests with partial cds mocks: assign raw CSN. They don't validate
        // the linked shape, only that `cds.model` was populated. The cast
        // narrows to `unknown` first so we're explicit about leaving the
        // type system here.
        (cds as unknown as { model: unknown }).model = csn;
    }
}