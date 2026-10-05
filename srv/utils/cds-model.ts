import cds from '@sap/cds';

/**
 * Loads the CDS model if CAP has not attached it yet.
 * Without a model, INSERT, UPDATE and DELETE queries that name an entity by string fail.
 * The `typeof` checks exist because unit tests often mock only part of `cds`.
 */
export async function ensureNightgateModelLoaded(): Promise<void> {
    if (cds.model) return;
    if (typeof cds.load !== 'function') return;
    const csn = await cds.load('*');
    if (!csn) return;
    if (typeof cds.linked === 'function') {
        cds.model = cds.linked(csn);
    } else {
        // Only partial test mocks get here. They just check that `cds.model` is set.
        (cds as unknown as { model: unknown }).model = csn;
    }
}