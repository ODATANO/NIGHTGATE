const mockDbRun = jest.fn();
const mockDbConnect = jest.fn().mockResolvedValue({ run: mockDbRun });
const shutdownHandlers: Function[] = [];
const registeredHandlers = new Map<string, Function>();
const registeredBeforeHandlers: Array<{ events: string[]; entities: string[]; handler: Function }> = [];

function createBuilder(kind: 'one' | 'many', table: string) {
    const builder: any = {
        __kind: kind,
        __table: table
    };

    builder.where = jest.fn().mockImplementation((value: unknown) => {
        builder.__where = value;
        return builder;
    });
    builder.orderBy = jest.fn().mockImplementation((value: unknown) => {
        builder.__orderBy = value;
        return builder;
    });
    builder.limit = jest.fn().mockImplementation((value: unknown) => {
        builder.__limit = value;
        return builder;
    });

    return builder;
}

function handlerKey(event: string, entity?: string): string {
    return entity ? `${event}:${entity}` : event;
}

const registerWalletSessionHandlers = jest.fn();
const startSessionCleanup = jest.fn(() => ({
    unref: jest.fn()
}));

jest.mock('./../../srv/sessions/wallet-sessions', () => ({
    registerWalletSessionHandlers,
    startSessionCleanup
}));

jest.mock('@sap/cds', () => {
    const cds: any = {
        connect: { to: mockDbConnect },
        ql: {
            SELECT: {
                one: {
                    from: jest.fn().mockImplementation((table: string) => createBuilder('one', table))
                },
                from: jest.fn().mockImplementation((table: string) => createBuilder('many', table))
            }
        },
        on: jest.fn((event: string, handler: Function) => {
            if (event === 'shutdown') {
                shutdownHandlers.push(handler);
            }
        }),
        ApplicationService: class {
            on(event: string, entityOrHandler: string | Function, maybeHandler?: Function) {
                if (typeof entityOrHandler === 'function') {
                    registeredHandlers.set(handlerKey(event), entityOrHandler);
                    return;
                }

                registeredHandlers.set(handlerKey(event, entityOrHandler), maybeHandler as Function);
            }

            before(events: string[], entities: string[], handler: Function) {
                registeredBeforeHandlers.push({ events, entities, handler });
            }

            async init() { }
        }
    };
    cds.default = cds;
    return cds;
});

import NightgateService from '../../srv/nightgate-service';

function createMockRequest(data: Record<string, unknown> = {}, query?: unknown) {
    return {
        data,
        query,
        reject: jest.fn().mockImplementation((code: number, message: string) => ({
            __rejected: true,
            code,
            message
        }))
    };
}

function getHandler(event: string, entity?: string): Function {
    const handler = registeredHandlers.get(handlerKey(event, entity));
    expect(handler).toBeDefined();
    return handler as Function;
}

function getLastBuilder(): any {
    const builder = mockDbRun.mock.calls.at(-1)?.[0];
    expect(builder).toBeDefined();
    return builder;
}

describe('NightgateService', () => {
    let service: NightgateService;

    beforeEach(async () => {
        mockDbRun.mockReset();
        mockDbConnect.mockClear();
        registerWalletSessionHandlers.mockClear();
        startSessionCleanup.mockClear();
        registeredHandlers.clear();
        registeredBeforeHandlers.length = 0;
        shutdownHandlers.length = 0;

        service = new NightgateService();
        await service.init();
    });

    it('registers delegated session handling, cleanup, and all main handler groups during init', () => {
        expect(registerWalletSessionHandlers).toHaveBeenCalledWith(service, expect.objectContaining({ run: mockDbRun }));
        expect(startSessionCleanup).toHaveBeenCalledWith(expect.objectContaining({ run: mockDbRun }));
        expect(getHandler('READ', 'Blocks')).toBeDefined();
        expect(getHandler('range', 'Blocks')).toBeDefined();
        expect(getHandler('READ', 'Transactions')).toBeDefined();
        expect(getHandler('byType', 'Transactions')).toBeDefined();
        expect(getHandler('READ', 'ContractActions')).toBeDefined();
        expect(getHandler('READ', 'UnshieldedUtxos')).toBeDefined();
        expect(getHandler('getTopHolders', 'NightBalances')).toBeDefined();
        expect(registeredBeforeHandlers).toHaveLength(1);
        expect(shutdownHandlers).toHaveLength(1);
    });

    describe.each([
        'Blocks',
        'Transactions',
        'ContractActions',
        'UnshieldedUtxos'
    ])('READ %s', (entity) => {
        it('runs the incoming CDS query and normalizes null results to an empty array', async () => {
            const handler = getHandler('READ', entity);
            const query = { SELECT: { from: entity } };
            mockDbRun.mockResolvedValueOnce(null);

            await expect(handler(createMockRequest({}, query))).resolves.toEqual([]);
            expect(mockDbRun).toHaveBeenCalledWith(query);
        });
    });

    it('returns the latest block via the Blocks.latest action', async () => {
        const handler = getHandler('latest', 'Blocks');
        mockDbRun.mockResolvedValueOnce({ ID: 'block-1' });

        await expect(handler()).resolves.toEqual({ ID: 'block-1' });

        const builder = getLastBuilder();
        expect(builder.__table).toBe('midnight.Blocks');
        expect(builder.orderBy).toHaveBeenCalledWith('height desc');
    });

    it('rejects byHeight requests without a height', async () => {
        const handler = getHandler('byHeight', 'Blocks');
        const req = createMockRequest();

        await handler(req);

        expect(req.reject).toHaveBeenCalledWith(400, 'height is required');
    });

    it('looks up blocks by height', async () => {
        const handler = getHandler('byHeight', 'Blocks');
        const req = createMockRequest({ height: 42 });
        mockDbRun.mockResolvedValueOnce({ ID: 'block-42' });

        await expect(handler(req)).resolves.toEqual({ ID: 'block-42' });

        const builder = getLastBuilder();
        expect(builder.__table).toBe('midnight.Blocks');
        expect(builder.where).toHaveBeenCalledWith({ height: 42 });
    });

    it('rejects block range queries without both bounds', async () => {
        const handler = getHandler('range', 'Blocks');
        const req = createMockRequest({ startHeight: 1 });

        await handler(req);

        expect(req.reject).toHaveBeenCalledWith(400, 'startHeight and endHeight are required');
    });

    it('returns blocks within a validated height range', async () => {
        const handler = getHandler('range', 'Blocks');
        const req = createMockRequest({ startHeight: 10, endHeight: 20, limit: 50 });
        mockDbRun.mockResolvedValueOnce([{ ID: 'block-10' }]);

        await expect(handler(req)).resolves.toEqual([{ ID: 'block-10' }]);

        const builder = getLastBuilder();
        expect(builder.__table).toBe('midnight.Blocks');
        expect(builder.where).toHaveBeenCalledWith({ height: { '>=': 10, '<=': 20 } });
        expect(builder.orderBy).toHaveBeenCalledWith('height asc');
        expect(builder.limit).toHaveBeenCalledWith(50);
    });

    it('rejects block ranges where endHeight is below startHeight', async () => {
        const handler = getHandler('range', 'Blocks');
        const req = createMockRequest({ startHeight: 10, endHeight: 9 });

        await handler(req);

        expect(req.reject).toHaveBeenCalledWith(400, 'endHeight must be greater than or equal to startHeight');
    });

    it('rejects byHash requests without a hash', async () => {
        const handler = getHandler('byHash', 'Transactions');
        const req = createMockRequest();

        await handler(req);

        expect(req.reject).toHaveBeenCalledWith(400, 'hash is required');
    });

    it('looks up transactions by hash', async () => {
        const handler = getHandler('byHash', 'Transactions');
        const req = createMockRequest({ hash: '0xabc' });
        mockDbRun.mockResolvedValueOnce([{ ID: 'tx-1' }]);

        await expect(handler(req)).resolves.toEqual([{ ID: 'tx-1' }]);

        const builder = getLastBuilder();
        expect(builder.__table).toBe('midnight.Transactions');
        expect(builder.where).toHaveBeenCalledWith({ hash: '0xabc' });
    });

    it('rejects transaction type queries without txType', async () => {
        const handler = getHandler('byType', 'Transactions');
        const req = createMockRequest({});

        await handler(req);

        expect(req.reject).toHaveBeenCalledWith(400, 'txType is required');
    });

    it('filters transactions by txType with a bounded limit', async () => {
        const handler = getHandler('byType', 'Transactions');
        const req = createMockRequest({ txType: 'contract_call', limit: 25 });
        mockDbRun.mockResolvedValueOnce([{ ID: 'tx-2' }]);

        await expect(handler(req)).resolves.toEqual([{ ID: 'tx-2' }]);

        const builder = getLastBuilder();
        expect(builder.__table).toBe('midnight.Transactions');
        expect(builder.where).toHaveBeenCalledWith({ txType: 'contract_call' });
        expect(builder.orderBy).toHaveBeenCalledWith('createdAt desc');
        expect(builder.limit).toHaveBeenCalledWith(25);
    });

    it('rejects byAddress requests without an address', async () => {
        const handler = getHandler('byAddress', 'ContractActions');
        const req = createMockRequest();

        await handler(req);

        expect(req.reject).toHaveBeenCalledWith(400, 'address is required');
    });

    it('looks up contract actions by address', async () => {
        const handler = getHandler('byAddress', 'ContractActions');
        const req = createMockRequest({ address: 'contract-1' });
        mockDbRun.mockResolvedValueOnce([{ ID: 'action-1' }]);

        await expect(handler(req)).resolves.toEqual([{ ID: 'action-1' }]);

        const builder = getLastBuilder();
        expect(builder.__table).toBe('midnight.ContractActions');
        expect(builder.where).toHaveBeenCalledWith({ address: 'contract-1' });
    });

    it('rejects contract history requests without an address', async () => {
        const handler = getHandler('history', 'ContractActions');
        const req = createMockRequest();

        await handler(req);

        expect(req.reject).toHaveBeenCalledWith(400, 'address is required');
    });

    it('returns contract history ordered by newest entries first', async () => {
        const handler = getHandler('history', 'ContractActions');
        const req = createMockRequest({ address: 'contract-1' });
        mockDbRun.mockResolvedValueOnce([{ ID: 'action-1' }]);

        await expect(handler(req)).resolves.toEqual([{ ID: 'action-1' }]);

        const builder = getLastBuilder();
        expect(builder.__table).toBe('midnight.ContractActions');
        expect(builder.where).toHaveBeenCalledWith({ address: 'contract-1' });
        expect(builder.orderBy).toHaveBeenCalledWith('createdAt desc');
        expect(builder.limit).toHaveBeenCalledWith(100);
    });

    it('rejects byOwner requests without an owner', async () => {
        const handler = getHandler('byOwner', 'UnshieldedUtxos');
        const req = createMockRequest();

        await handler(req);

        expect(req.reject).toHaveBeenCalledWith(400, 'owner is required');
    });

    it('looks up UTXOs by owner', async () => {
        const handler = getHandler('byOwner', 'UnshieldedUtxos');
        const req = createMockRequest({ owner: 'owner-1' });
        mockDbRun.mockResolvedValueOnce([{ ID: 'utxo-1' }]);

        await expect(handler(req)).resolves.toEqual([{ ID: 'utxo-1' }]);

        const builder = getLastBuilder();
        expect(builder.__table).toBe('midnight.UnshieldedUtxos');
        expect(builder.where).toHaveBeenCalledWith({ owner: 'owner-1' });
    });

    it('returns unspent UTXOs only', async () => {
        const handler = getHandler('unspent', 'UnshieldedUtxos');
        mockDbRun.mockResolvedValueOnce([{ ID: 'utxo-1' }]);

        await expect(handler()).resolves.toEqual([{ ID: 'utxo-1' }]);

        const builder = getLastBuilder();
        expect(builder.__table).toBe('midnight.UnshieldedUtxos');
        expect(builder.where).toHaveBeenCalledWith({ spentAtTransaction_ID: null });
    });

    it('rejects getBalance requests without an address', async () => {
        const handler = getHandler('getBalance', 'NightBalances');
        const req = createMockRequest();

        await handler(req);

        expect(req.reject).toHaveBeenCalledWith(400, 'address is required');
    });

    it('returns the current balance for an address', async () => {
        const handler = getHandler('getBalance', 'NightBalances');
        const req = createMockRequest({ address: 'midnight-addr-1' });
        mockDbRun.mockResolvedValueOnce({ address: 'midnight-addr-1', balance: '1000' });

        await expect(handler(req)).resolves.toEqual({ address: 'midnight-addr-1', balance: '1000' });

        const builder = getLastBuilder();
        expect(builder.__table).toBe('midnight.NightBalances');
        expect(builder.where).toHaveBeenCalledWith({ address: 'midnight-addr-1' });
    });

    it('clamps getTopHolders limits to the configured bounds', async () => {
        const handler = getHandler('getTopHolders', 'NightBalances');
        mockDbRun.mockResolvedValueOnce([{ address: 'addr', balance: 10 }]);
        mockDbRun.mockResolvedValueOnce([{ address: 'addr', balance: 10 }]);
        mockDbRun.mockResolvedValueOnce([{ address: 'addr', balance: 10 }]);

        await expect(handler(createMockRequest({ limit: 5000 }))).resolves.toEqual([{ address: 'addr', balance: 10 }]);
        expect(getLastBuilder().limit).toHaveBeenCalledWith(1000);

        await expect(handler(createMockRequest({ limit: -5 }))).resolves.toEqual([{ address: 'addr', balance: 10 }]);
        expect(getLastBuilder().limit).toHaveBeenCalledWith(1);

        await expect(handler(createMockRequest())).resolves.toEqual([{ address: 'addr', balance: 10 }]);
        const builder = getLastBuilder();
        expect(builder.__table).toBe('midnight.NightBalances');
        expect(builder.orderBy).toHaveBeenCalledWith('balance desc');
        expect(builder.limit).toHaveBeenCalledWith(10);
    });

    it('rejects write attempts through the read-only guard', () => {
        const req = createMockRequest();

        registeredBeforeHandlers[0].handler(req);

        expect(registeredBeforeHandlers[0].events).toEqual(['CREATE', 'UPDATE', 'DELETE']);
        expect(registeredBeforeHandlers[0].entities).toContain('Blocks');
        expect(req.reject).toHaveBeenCalledWith(405, 'Blockchain data is read-only');
    });

    it('clears the session cleanup timer on shutdown', () => {
        const clearIntervalSpy = jest.spyOn(global, 'clearInterval').mockImplementation(() => undefined as unknown as NodeJS.Timeout);
        const timer = startSessionCleanup.mock.results[0].value;

        try {
            shutdownHandlers[0]();
            expect(clearIntervalSpy).toHaveBeenCalledWith(timer);
        } finally {
            clearIntervalSpy.mockRestore();
        }
    });

    it('skips clearInterval when no cleanup timer is active', () => {
        const clearIntervalSpy = jest.spyOn(global, 'clearInterval').mockImplementation(() => undefined as unknown as NodeJS.Timeout);
        (service as any)._cleanupTimer = undefined;

        try {
            shutdownHandlers[0]();
            expect(clearIntervalSpy).not.toHaveBeenCalled();
        } finally {
            clearIntervalSpy.mockRestore();
        }
    });
});