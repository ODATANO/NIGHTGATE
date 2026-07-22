const loadMock = vi.hoisted(() => (vi.fn()));
const linkedMock = vi.hoisted(() => (vi.fn()));

vi.mock('@sap/cds', () => {
    const cds: any = {
        log: (() => {
            const _c: Record<string, any> = {};
            return (name: string) => (_c[name] ??= {
                info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn()
            });
        })(),
        model: undefined,
        load: loadMock,
        linked: linkedMock
    };
    cds.default = cds;
    return cds;
});

import cds from '@sap/cds';
import { ensureNightgateModelLoaded } from '../../srv/utils/cds-model';

describe('ensureNightgateModelLoaded', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        (cds as any).model = undefined;
    });

    it('loads and assigns the CDS model when it is missing', async () => {
        const csn = { definitions: { 'midnight.SyncState': {} } };
        const linkedCsn = { definitions: { 'midnight.SyncState': {} }, __linked: true };
        loadMock.mockResolvedValue(csn);
        linkedMock.mockReturnValue(linkedCsn);

        await ensureNightgateModelLoaded();

        expect(loadMock).toHaveBeenCalledWith('*');
        expect(linkedMock).toHaveBeenCalledWith(csn);
        expect((cds as any).model).toBe(linkedCsn);
    });

    it('does not reload the CDS model when it already exists', async () => {
        const model = { definitions: { existing: true } };
        (cds as any).model = model;

        await ensureNightgateModelLoaded();

        expect(loadMock).not.toHaveBeenCalled();
        expect(linkedMock).not.toHaveBeenCalled();
        expect((cds as any).model).toBe(model);
    });

    it('returns silently when cds.load is unavailable (partial test mocks)', async () => {
        const originalLoad = (cds as any).load;
        (cds as any).load = undefined;
        try {
            await ensureNightgateModelLoaded();
            expect((cds as any).model).toBeUndefined();
            expect(linkedMock).not.toHaveBeenCalled();
        } finally {
            (cds as any).load = originalLoad;
        }
    });

    it('returns silently when cds.load resolves to a falsy CSN', async () => {
        loadMock.mockResolvedValue(undefined);
        await ensureNightgateModelLoaded();
        expect(linkedMock).not.toHaveBeenCalled();
        expect((cds as any).model).toBeUndefined();
    });

    it('assigns the raw CSN when cds.linked is not a function', async () => {
        const csn = { definitions: { 'midnight.SyncState': {} }, __raw: true };
        const originalLinked = (cds as any).linked;
        loadMock.mockResolvedValue(csn);
        (cds as any).linked = undefined;
        try {
            await ensureNightgateModelLoaded();
            expect((cds as any).model).toBe(csn);
        } finally {
            (cds as any).linked = originalLinked;
        }
    });
});