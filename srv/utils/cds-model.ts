import cds from '@sap/cds';

/**
 * CAP can expose a DB service before its model is attached. String-based
 * INSERT/UPDATE/DELETE queries then fail during view resolution. Ensure the
 * shared CDS model is loaded before connecting write-heavy runtime services.
 */
export async function ensureNightgateModelLoaded(): Promise<void> {
    if (cds.model) {
        return;
    }

    const load = (cds as any).load;
    if (typeof load !== 'function') {
        return;
    }

    const model = await load.call(cds, '*');
    if (model) {
        cds.model = model;
    }
}