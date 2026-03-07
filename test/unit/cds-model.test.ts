const loadMock = jest.fn();

jest.mock('@sap/cds', () => {
    const cds: any = {
        model: undefined,
        load: loadMock
    };
    cds.default = cds;
    return cds;
});

import cds from '@sap/cds';
import { ensureNightgateModelLoaded } from '../../srv/utils/cds-model';

describe('ensureNightgateModelLoaded', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        (cds as any).model = undefined;
    });

    it('loads and assigns the CDS model when it is missing', async () => {
        const model = { definitions: { 'midnight.SyncState': {} } };
        loadMock.mockResolvedValue(model);

        await ensureNightgateModelLoaded();

        expect(loadMock).toHaveBeenCalledWith('*');
        expect((cds as any).model).toBe(model);
    });

    it('does not reload the CDS model when it already exists', async () => {
        const model = { definitions: { existing: true } };
        (cds as any).model = model;

        await ensureNightgateModelLoaded();

        expect(loadMock).not.toHaveBeenCalled();
        expect((cds as any).model).toBe(model);
    });
});