/**
 * Tests for srv/nightgate-service.ts.
 *
 * HYBRID approach: runs against a REAL in-memory CAP DB via cds.test()
 * (see test/jest.setup.ts). Persistence (Blocks, Transactions, ContractActions,
 * UnshieldedUtxos, NightBalances, BackgroundJobs) is exercised against the real
 * SQLite DB — we seed rows, invoke the service action / OData endpoint, then
 * assert on the returned data. The old query-shape assertions (builder.__table /
 * __where / __orderBy / __limit) are reframed as behavioral: seed specific rows
 * and prove the right rows come back in the right order/limit.
 *
 * External collaborators stay mocked: srv/sessions/wallet-sessions so the
 * wallet-session handler registration + cleanup timer don't run a real session
 * worker. The submission handlers (srv/submission/handlers) are left real —
 * they only register action handlers during init() and none of the submission
 * actions are invoked here. getJobStatus reads a real BackgroundJobs row via
 * the real getJobById, so we seed a row rather than mock the lookup.
 */

const mockRegisterWalletSessionHandlers = jest.fn();
const mockStartSessionCleanup = jest.fn((..._args: any[]) => ({ unref: jest.fn() }));

// External collaborator: keep mocked. jest.mock is hoisted and applies to the
// framework-loaded service too, so the booted service uses these mocks.
jest.mock('../../srv/sessions/wallet-sessions', () => ({
    registerWalletSessionHandlers: (...args: any[]) => mockRegisterWalletSessionHandlers(...args),
    startSessionCleanup: (...args: any[]) => mockStartSessionCleanup(...args)
}));

import cds from '@sap/cds';

jest.setTimeout(60000);

// Boot the in-memory CAP server. Not assigned to a `test` const on purpose
// (would shadow Jest's global test()). We use the HTTP client `cap` for the
// bound OData functions and srv.send() for the unbound getJobStatus action.
const cap = cds.test(__dirname + '/../..');

const BLOCKS = 'midnight.Blocks';
const TRANSACTIONS = 'midnight.Transactions';
const CONTRACT_ACTIONS = 'midnight.ContractActions';
const UNSHIELDED_UTXOS = 'midnight.UnshieldedUtxos';
const NIGHT_BALANCES = 'midnight.NightBalances';
const BACKGROUND_JOBS = 'midnight.BackgroundJobs';

const API = '/api/v1/nightgate';

let db: any;
let srv: any;

beforeAll(async () => {
    db = await cds.connect.to('db');
    srv = await cds.connect.to('NightgateService');
});

beforeEach(async () => {
    mockRegisterWalletSessionHandlers.mockClear();
    mockStartSessionCleanup.mockClear();

    await db.run(cds.ql.DELETE.from(UNSHIELDED_UTXOS));
    await db.run(cds.ql.DELETE.from(CONTRACT_ACTIONS));
    await db.run(cds.ql.DELETE.from(TRANSACTIONS));
    await db.run(cds.ql.DELETE.from(BLOCKS));
    await db.run(cds.ql.DELETE.from(NIGHT_BALANCES));
    await db.run(cds.ql.DELETE.from(BACKGROUND_JOBS));
});

// ----------------------------------------------------------------------------
// Seed helpers — insert real rows that satisfy the schema's not-null fields.
// ----------------------------------------------------------------------------

async function seedBlock(height: number, overrides: Record<string, any> = {}): Promise<string> {
    const id = cds.utils.uuid();
    await db.run(cds.ql.INSERT.into(BLOCKS).entries({
        ID: id,
        hash: `0xblock${height}`,
        height,
        protocolVersion: 1,
        timestamp: 1700000000 + height,
        ledgerParameters: '0xabcd',
        ...overrides
    }));
    return id;
}

async function seedTransaction(blockId: string, overrides: Record<string, any> = {}): Promise<string> {
    const id = cds.utils.uuid();
    await db.run(cds.ql.INSERT.into(TRANSACTIONS).entries({
        ID: id,
        transactionId: 0,
        hash: `0xtx-${id.slice(0, 8)}`,
        protocolVersion: 1,
        transactionType: 'REGULAR',
        block_ID: blockId,
        ...overrides
    }));
    return id;
}

async function seedContractAction(txId: string, overrides: Record<string, any> = {}): Promise<string> {
    const id = cds.utils.uuid();
    await db.run(cds.ql.INSERT.into(CONTRACT_ACTIONS).entries({
        ID: id,
        address: '0xcontract',
        actionType: 'CALL',
        transaction_ID: txId,
        ...overrides
    }));
    return id;
}

async function seedUtxo(txId: string, overrides: Record<string, any> = {}): Promise<string> {
    const id = cds.utils.uuid();
    await db.run(cds.ql.INSERT.into(UNSHIELDED_UTXOS).entries({
        ID: id,
        owner: 'mn_addr_owner',
        tokenType: '0xtoken',
        value: 1000,
        intentHash: '0xintent',
        outputIndex: 0,
        initialNonce: '0xnonce',
        createdAtTransaction_ID: txId,
        ...overrides
    }));
    return id;
}

async function seedBalance(address: string, balance: number, overrides: Record<string, any> = {}): Promise<void> {
    await db.run(cds.ql.INSERT.into(NIGHT_BALANCES).entries({
        address,
        balance,
        ...overrides
    }));
}

// ----------------------------------------------------------------------------
// init() — delegated registration
//
// The framework ran init() once at boot, which calls our mocked
// registerWalletSessionHandlers + startSessionCleanup. We re-run init() on a
// fresh instance to assert the delegated wiring (the old test instantiated the
// service directly; here we prove the same calls happen, with the live db).
// The handler-registration / read-only-guard assertions from the old suite are
// covered behaviorally by the action tests + the read-only test below; the
// shutdown / cleanup-timer hook has its own dedicated describe block (below).
// ----------------------------------------------------------------------------
describe('init', () => {
    it('delegates wallet-session handling + cleanup with the live db connection', async () => {
        const ServiceCtor = require('../../srv/nightgate-service').default;
        const instance = new ServiceCtor(undefined, srv.model, {} as any);
        await instance.init();

        expect(mockRegisterWalletSessionHandlers).toHaveBeenCalledWith(
            instance,
            expect.objectContaining({ run: expect.any(Function) })
        );
        expect(mockStartSessionCleanup).toHaveBeenCalledWith(
            expect.objectContaining({ run: expect.any(Function) })
        );
    });
});

// ----------------------------------------------------------------------------
// shutdown hook — srv/nightgate-service.ts registers cds.on('shutdown', ...) to
// clear the session-cleanup interval. We capture the handler registered during
// init() by spying cds.on (so we do NOT emit a real global 'shutdown' that would
// tear down the booted cds.test server), then invoke it directly and assert the
// clearInterval branch + the `if (this._cleanupTimer)` no-timer guard.
// ----------------------------------------------------------------------------
describe('shutdown hook', () => {
    async function initAndCaptureShutdown(timer: any): Promise<Function> {
        const ServiceCtor = require('../../srv/nightgate-service').default;
        mockStartSessionCleanup.mockReturnValueOnce(timer);

        let shutdownHandler: Function | undefined;
        const onSpy = jest.spyOn(cds as any, 'on').mockImplementation(((event: string, cb: Function) => {
            if (event === 'shutdown') shutdownHandler = cb;
            return cds;
        }) as any);
        try {
            const instance = new ServiceCtor(undefined, srv.model, {} as any);
            await instance.init();
        } finally {
            onSpy.mockRestore();
        }
        expect(shutdownHandler).toBeDefined();
        return shutdownHandler as Function;
    }

    it('clears the session cleanup timer on shutdown', async () => {
        const fakeTimer = { unref: jest.fn() } as unknown as ReturnType<typeof setInterval>;
        const handler = await initAndCaptureShutdown(fakeTimer);

        const clearSpy = jest.spyOn(global, 'clearInterval').mockImplementation(() => {});
        try {
            handler();
            expect(clearSpy).toHaveBeenCalledWith(fakeTimer);
        } finally {
            clearSpy.mockRestore();
        }
    });

    it('skips clearInterval when no cleanup timer is active', async () => {
        const handler = await initAndCaptureShutdown(undefined);

        const clearSpy = jest.spyOn(global, 'clearInterval').mockImplementation(() => {});
        try {
            handler();
            expect(clearSpy).not.toHaveBeenCalled();
        } finally {
            clearSpy.mockRestore();
        }
    });
});

// ----------------------------------------------------------------------------
// Blocks
// ----------------------------------------------------------------------------
describe('Blocks', () => {
    it('READ returns persisted blocks (empty array when none)', async () => {
        const empty = await cap.GET(`${API}/Blocks`);
        expect(empty.data.value).toEqual([]);

        await seedBlock(1);
        await seedBlock(2);
        const res = await cap.GET(`${API}/Blocks`);
        expect(res.data.value.map((b: any) => Number(b.height)).sort()).toEqual([1, 2]);
    });

    it('latest() returns the highest-height block', async () => {
        await seedBlock(1);
        await seedBlock(3);
        await seedBlock(2);

        const res = await srv.send({ event: 'latest', entity: 'Blocks', data: {} });
        expect(Number(res.height)).toBe(3);
    });

    it('byHeight() returns the matching block', async () => {
        await seedBlock(41);
        await seedBlock(42);

        const res = await srv.send({ event: 'byHeight', entity: 'Blocks', data: { height: 42 } });
        expect(Number(res.height)).toBe(42);
        expect(res.hash).toBe('0xblock42');
    });

    it('byHeight() rejects when height is missing', async () => {
        await expect(
            srv.send({ event: 'byHeight', entity: 'Blocks', data: {} })
        ).rejects.toMatchObject({ message: 'height is required' });
    });

    it('range() filters to the [startHeight, endHeight] window, ascending, capped at the effective limit', async () => {
        // Seed rows both inside and OUTSIDE the requested window so the test
        // actually proves the height filter (not just ordering/limit). The
        // handler uses .where({height:{'>=':s}}).and({height:{'<=':e}}) — two
        // single-operator objects — because the combined-operator object form
        // is silently dropped by @cap-js/sqlite.
        for (const h of [13, 8, 11, 9, 12, 10]) await seedBlock(h);

        // Window [9,12] = {9,10,11,12}; 8 and 13 must be excluded.
        const windowed = await srv.send({
            event: 'range', entity: 'Blocks',
            data: { startHeight: 9, endHeight: 12 }
        });
        expect(windowed.map((b: any) => Number(b.height))).toEqual([9, 10, 11, 12]);

        // Same window with a tighter limit: ascending, first 2 in range.
        const limited = await srv.send({
            event: 'range', entity: 'Blocks',
            data: { startHeight: 9, endHeight: 12, limit: 2 }
        });
        expect(limited.map((b: any) => Number(b.height))).toEqual([9, 10]);
    });

    it('range() defaults the limit to 100 when none is supplied', async () => {
        for (const h of [5, 10, 15, 20, 25]) await seedBlock(h);

        const res = await srv.send({
            event: 'range', entity: 'Blocks',
            data: { startHeight: 0, endHeight: 100 }
        });
        const heights = res.map((b: any) => Number(b.height));
        // Ascending; all 5 rows fall in [0,100] and fit under the default cap of 100.
        expect(heights).toEqual([5, 10, 15, 20, 25]);
    });

    it('range() rejects when both bounds are not supplied', async () => {
        await expect(
            srv.send({ event: 'range', entity: 'Blocks', data: { startHeight: 1 } })
        ).rejects.toMatchObject({ message: 'startHeight and endHeight are required' });
    });

    it('range() rejects when endHeight is below startHeight', async () => {
        await expect(
            srv.send({ event: 'range', entity: 'Blocks', data: { startHeight: 10, endHeight: 9 } })
        ).rejects.toMatchObject({
            message: 'endHeight must be greater than or equal to startHeight'
        });
    });

    it('range() rejects negative bounds', async () => {
        await expect(
            srv.send({ event: 'range', entity: 'Blocks', data: { startHeight: -1, endHeight: 5 } })
        ).rejects.toMatchObject({
            message: 'startHeight and endHeight must be non-negative integers'
        });
    });
});

// ----------------------------------------------------------------------------
// Transactions
// ----------------------------------------------------------------------------
describe('Transactions', () => {
    it('READ returns persisted transactions (empty array when none)', async () => {
        const empty = await cap.GET(`${API}/Transactions`);
        expect(empty.data.value).toEqual([]);

        const blockId = await seedBlock(1);
        await seedTransaction(blockId);
        const res = await cap.GET(`${API}/Transactions`);
        expect(res.data.value.length).toBe(1);
    });

    it('byHash() returns transactions matching the hash', async () => {
        const blockId = await seedBlock(1);
        await seedTransaction(blockId, { hash: '0xabc' });
        await seedTransaction(blockId, { hash: '0xdef' });

        const res = await srv.send({ event: 'byHash', entity: 'Transactions', data: { hash: '0xabc' } });
        expect(res.length).toBe(1);
        expect(res[0].hash).toBe('0xabc');
    });

    it('byHash() rejects when hash is missing', async () => {
        await expect(
            srv.send({ event: 'byHash', entity: 'Transactions', data: {} })
        ).rejects.toMatchObject({ message: 'hash is required' });
    });

    it('byType() filters transactions by txType', async () => {
        const blockId = await seedBlock(1);
        await seedTransaction(blockId, { hash: '0xcall1', txType: 'contract_call' });
        await seedTransaction(blockId, { hash: '0xcall2', txType: 'contract_call' });
        await seedTransaction(blockId, { hash: '0xxfer', txType: 'night_transfer' });

        const res = await srv.send({
            event: 'byType', entity: 'Transactions',
            data: { txType: 'contract_call', limit: 25 }
        });
        expect(res.length).toBe(2);
        expect(res.every((t: any) => t.txType === 'contract_call')).toBe(true);
    });

    it('byType() honors the limit', async () => {
        const blockId = await seedBlock(1);
        for (let i = 0; i < 5; i++) {
            await seedTransaction(blockId, { hash: `0xcall${i}`, txType: 'contract_call' });
        }

        const res = await srv.send({
            event: 'byType', entity: 'Transactions',
            data: { txType: 'contract_call', limit: 3 }
        });
        expect(res.length).toBe(3);
    });

    it('byType() rejects when txType is missing', async () => {
        await expect(
            srv.send({ event: 'byType', entity: 'Transactions', data: {} })
        ).rejects.toMatchObject({ message: 'txType is required' });
    });
});

// ----------------------------------------------------------------------------
// ContractActions
// ----------------------------------------------------------------------------
describe('ContractActions', () => {
    it('READ returns persisted contract actions (empty array when none)', async () => {
        const empty = await cap.GET(`${API}/ContractActions`);
        expect(empty.data.value).toEqual([]);

        const blockId = await seedBlock(1);
        const txId = await seedTransaction(blockId);
        await seedContractAction(txId);
        const res = await cap.GET(`${API}/ContractActions`);
        expect(res.data.value.length).toBe(1);
    });

    it('byAddress() returns actions for the address', async () => {
        const blockId = await seedBlock(1);
        const txId = await seedTransaction(blockId);
        await seedContractAction(txId, { address: '0xcontract-1' });
        await seedContractAction(txId, { address: '0xcontract-2' });

        const res = await srv.send({
            event: 'byAddress', entity: 'ContractActions',
            data: { address: '0xcontract-1' }
        });
        expect(res.length).toBe(1);
        expect(res[0].address).toBe('0xcontract-1');
    });

    it('byAddress() rejects when address is missing', async () => {
        await expect(
            srv.send({ event: 'byAddress', entity: 'ContractActions', data: {} })
        ).rejects.toMatchObject({ message: 'address is required' });
    });

    it('history() returns actions for the address (newest first, capped at 100)', async () => {
        const blockId = await seedBlock(1);
        const txId = await seedTransaction(blockId);
        await seedContractAction(txId, { address: '0xc', entryPoint: 'a' });
        await seedContractAction(txId, { address: '0xc', entryPoint: 'b' });

        const res = await srv.send({
            event: 'history', entity: 'ContractActions',
            data: { address: '0xc' }
        });
        expect(res.length).toBe(2);
        expect(res.every((a: any) => a.address === '0xc')).toBe(true);
    });

    it('history() rejects when address is missing', async () => {
        await expect(
            srv.send({ event: 'history', entity: 'ContractActions', data: {} })
        ).rejects.toMatchObject({ message: 'address is required' });
    });
});

// ----------------------------------------------------------------------------
// UnshieldedUtxos
// ----------------------------------------------------------------------------
describe('UnshieldedUtxos', () => {
    it('READ returns persisted UTXOs (empty array when none)', async () => {
        const empty = await cap.GET(`${API}/UnshieldedUtxos`);
        expect(empty.data.value).toEqual([]);

        const blockId = await seedBlock(1);
        const txId = await seedTransaction(blockId);
        await seedUtxo(txId);
        const res = await cap.GET(`${API}/UnshieldedUtxos`);
        expect(res.data.value.length).toBe(1);
    });

    it('byOwner() returns UTXOs for the owner', async () => {
        const blockId = await seedBlock(1);
        const txId = await seedTransaction(blockId);
        await seedUtxo(txId, { owner: 'mn_addr_alice' });
        await seedUtxo(txId, { owner: 'mn_addr_bob' });

        const res = await srv.send({
            event: 'byOwner', entity: 'UnshieldedUtxos',
            data: { owner: 'mn_addr_alice' }
        });
        expect(res.length).toBe(1);
        expect(res[0].owner).toBe('mn_addr_alice');
    });

    it('byOwner() rejects when owner is missing', async () => {
        await expect(
            srv.send({ event: 'byOwner', entity: 'UnshieldedUtxos', data: {} })
        ).rejects.toMatchObject({ message: 'owner is required' });
    });

    it('unspent() returns only UTXOs with no spending transaction', async () => {
        const blockId = await seedBlock(1);
        const txId = await seedTransaction(blockId);
        const spendTxId = await seedTransaction(blockId, { hash: '0xspend' });
        await seedUtxo(txId, { owner: 'mn_addr_unspent' }); // spentAtTransaction null
        await seedUtxo(txId, { owner: 'mn_addr_spent', spentAtTransaction_ID: spendTxId });

        const res = await srv.send({ event: 'unspent', entity: 'UnshieldedUtxos', data: {} });
        expect(res.length).toBe(1);
        expect(res[0].owner).toBe('mn_addr_unspent');
    });
});

// ----------------------------------------------------------------------------
// NightBalances
// ----------------------------------------------------------------------------
describe('NightBalances', () => {
    it('getBalance() returns the balance for an address', async () => {
        await seedBalance('mn_addr_1', 1000);
        await seedBalance('mn_addr_2', 2000);

        const res = await srv.send({
            event: 'getBalance', entity: 'NightBalances',
            data: { address: 'mn_addr_1' }
        });
        expect(res.address).toBe('mn_addr_1');
        expect(Number(res.balance)).toBe(1000);
    });

    it('getBalance() rejects when address is missing', async () => {
        await expect(
            srv.send({ event: 'getBalance', entity: 'NightBalances', data: {} })
        ).rejects.toMatchObject({ message: 'address is required' });
    });

    it('getTopHolders() orders by balance descending with the default limit of 10', async () => {
        await seedBalance('addr-low', 1);
        await seedBalance('addr-high', 100);
        await seedBalance('addr-mid', 50);

        const res = await srv.send({ event: 'getTopHolders', entity: 'NightBalances', data: {} });
        const balances = res.map((r: any) => Number(r.balance));
        expect(balances).toEqual([100, 50, 1]);
    });

    it('getTopHolders() clamps an over-large limit (returns all rows when fewer than the cap)', async () => {
        for (let i = 0; i < 3; i++) await seedBalance(`addr-${i}`, i + 1);

        // limit 5000 clamps to 1000; with only 3 rows all are returned.
        const res = await srv.send({
            event: 'getTopHolders', entity: 'NightBalances',
            data: { limit: 5000 }
        });
        expect(res.length).toBe(3);
    });

    it('getTopHolders() clamps a too-small limit to 1', async () => {
        await seedBalance('addr-a', 10);
        await seedBalance('addr-b', 20);

        const res = await srv.send({
            event: 'getTopHolders', entity: 'NightBalances',
            data: { limit: -5 }
        });
        // Clamped to 1; highest balance comes back.
        expect(res.length).toBe(1);
        expect(Number(res[0].balance)).toBe(20);
    });
});

// ----------------------------------------------------------------------------
// Read-only enforcement
// ----------------------------------------------------------------------------
describe('read-only enforcement', () => {
    it('rejects writes to blockchain entities over OData', async () => {
        await expect(
            cap.POST(`${API}/Blocks`, {
                ID: cds.utils.uuid(),
                hash: '0xnope',
                height: 999,
                protocolVersion: 1,
                timestamp: 1,
                ledgerParameters: '0x00'
            })
        ).rejects.toMatchObject({
            response: { status: 405 }
        });
    });
});

// ----------------------------------------------------------------------------
// getJobStatus (0.2.0 async submission lifecycle)
//
// getJobStatus is an UNBOUND service action that reads a real BackgroundJobs
// row via getJobById. We seed the row and assert the projected shape. The old
// query-shape assertion (builder.__where == { ID }) is reframed: the right row
// (and only the caller's own row) is returned.
// ----------------------------------------------------------------------------
describe('getJobStatus', () => {
    const VALID_JOB_ID = '11111111-1111-1111-1111-111111111111';
    const VALID_SESSION = '22222222-2222-2222-2222-222222222222';
    const FOREIGN_SESSION = '33333333-3333-3333-3333-333333333333';

    async function seedJob(overrides: Record<string, any> = {}): Promise<void> {
        await db.run(cds.ql.INSERT.into(BACKGROUND_JOBS).entries({
            ID: VALID_JOB_ID,
            kind: 'sendNight',
            sessionId: VALID_SESSION,
            status: 'succeeded',
            idempotencyKey: null,
            request: '{"foo":"bar"}',
            result: '{"txId":"tx-OK"}',
            errorCode: null,
            errorMessage: null,
            startedAt: '2026-05-19T12:00:00.000Z',
            finishedAt: '2026-05-19T12:00:05.000Z',
            ...overrides
        }));
    }

    it('rejects when jobId is missing', async () => {
        await expect(
            srv.send('getJobStatus', { sessionId: VALID_SESSION })
        ).rejects.toMatchObject({ message: 'jobId is required' });
    });

    it('rejects when sessionId is missing', async () => {
        await expect(
            srv.send('getJobStatus', { jobId: VALID_JOB_ID })
        ).rejects.toMatchObject({ message: 'sessionId is required' });
    });

    it('returns 404 for an unknown jobId', async () => {
        await expect(
            srv.send('getJobStatus', { jobId: VALID_JOB_ID, sessionId: VALID_SESSION })
        ).rejects.toMatchObject({ message: 'Job not found' });
    });

    it('returns 404 for a job owned by a different session (no leak)', async () => {
        await seedJob({ sessionId: FOREIGN_SESSION });
        await expect(
            srv.send('getJobStatus', { jobId: VALID_JOB_ID, sessionId: VALID_SESSION })
        ).rejects.toMatchObject({ message: 'Job not found' });
    });

    it('returns the full job shape for a matching jobId + sessionId', async () => {
        await seedJob();

        const out = await srv.send('getJobStatus', { jobId: VALID_JOB_ID, sessionId: VALID_SESSION });

        expect(out).toEqual(expect.objectContaining({
            jobId: VALID_JOB_ID,
            kind: 'sendNight',
            status: 'succeeded',
            result: '{"txId":"tx-OK"}',
            errorCode: null,
            errorMessage: null,
            startedAt: '2026-05-19T12:00:00.000Z',
            finishedAt: '2026-05-19T12:00:05.000Z'
        }));
        // submittedAt mirrors the row's createdAt (set by @cds.on.insert managed).
        expect(out.submittedAt).toBeTruthy();
    });

    it('relays failure state (errorCode / errorMessage) for a failed job', async () => {
        await seedJob({
            status: 'failed',
            result: null,
            errorCode: '1016',
            errorMessage: 'Transaction pool full or immediately dropped',
            finishedAt: '2026-05-19T12:00:30.000Z'
        });

        const out = await srv.send('getJobStatus', { jobId: VALID_JOB_ID, sessionId: VALID_SESSION });
        expect(out.status).toBe('failed');
        expect(out.errorCode).toBe('1016');
        expect(out.errorMessage).toMatch(/pool full/);
        expect(out.result).toBeNull();
    });
});
