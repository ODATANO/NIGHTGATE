/**
 * Tests for srv/nightgate-service.ts.
 *
 * HYBRID approach: runs against a REAL in-memory CAP DB via cds.test()
 * (see test/vitest.setup.ts). Persistence (Blocks, Transactions, ContractActions,
 * UnshieldedUtxos, NightBalances, BackgroundJobs) is exercised against the real
 * SQLite DB: we seed rows, invoke the service action / OData endpoint, then
 * assert on the returned data (the right rows in the right order/limit).
 *
 * External collaborators stay mocked: srv/sessions/wallet-sessions so the
 * wallet-session handler registration + cleanup timer don't run a real session
 * worker. The submission handlers (srv/submission/handlers) are left real;
 * they only register action handlers during init() and none of the submission
 * actions are invoked here. getJobStatus reads a real BackgroundJobs row via
 * the real getJobById, so we seed a row rather than mock the lookup.
 */

const mockRegisterWalletSessionHandlers = vi.hoisted(() => (vi.fn()));
const mockStartSessionCleanup = vi.hoisted(() => (vi.fn((..._args: any[]) => ({ unref: vi.fn() }))));

// External collaborator: keep mocked. vi.mock is hoisted and applies to the
// framework-loaded service too, so the booted service uses these mocks.
vi.mock('../../srv/sessions/wallet-sessions', () => ({
    registerWalletSessionHandlers: (...args: any[]) => mockRegisterWalletSessionHandlers(...args),
    startSessionCleanup: (...args: any[]) => mockStartSessionCleanup(...args)
}));

import { networkInterfaces } from 'node:os';
import cds from '@sap/cds';
import { inBlock, inTransaction } from '../fixtures/chain-position';
import { pinEnv } from '../fixtures/pin-env';
import { encrypt, getEncryptionKey } from '../../srv/utils/crypto';
import { jobCommandBinding } from '../../srv/utils/envelope-bindings';

// Boot the in-memory CAP server. Not assigned to a `test` const on purpose
// (would shadow Vitest's global test()). We use the HTTP client `cap` for the
// bound OData functions and srv.send() for the unbound getJobStatus action.
const cap = cds.test(__dirname + '/../..');

const BLOCKS = 'midnight.Blocks';
const TRANSACTIONS = 'midnight.Transactions';
const CONTRACT_ACTIONS = 'midnight.ContractActions';
const CONTRACT_STATES = 'midnight.ContractStates';
const TX_IDENTIFIERS = 'midnight.TransactionIdentifiers';
const TX_RESULTS = 'midnight.TransactionResults';
const TX_SEGMENTS = 'midnight.TransactionSegments';
const UNSHIELDED_UTXOS = 'midnight.UnshieldedUtxos';
const NIGHT_BALANCES = 'midnight.NightBalances';
const BACKGROUND_JOBS = 'midnight.BackgroundJobs';

const API = '/odata/v4/midnight';

/** An entity read with OData query options, as a caller writes them. */
const read = (entity: string, options: string) => cap.GET(`${API}/${entity}?${encodeURI(options)}`);
/** A time one second after another, for rows that must come in a known order. */
const second = (n: number) => `2026-01-01T00:00:${String(n).padStart(2, '0')}.000Z`;

let db: any;
let srv: any;
let nextTransactionPosition = 0;
const nextOutputPosition = new Map<string, number>();

beforeAll(async () => {
    db = await cds.connect.to('db');
    srv = await cds.connect.to('NightgateService');
});

beforeEach(async () => {
    mockRegisterWalletSessionHandlers.mockClear();
    mockStartSessionCleanup.mockClear();
    nextTransactionPosition = 0;
    nextOutputPosition.clear();

    await db.run(cds.ql.DELETE.from(UNSHIELDED_UTXOS));
    await db.run(cds.ql.DELETE.from(CONTRACT_ACTIONS));
    await db.run(cds.ql.DELETE.from(TX_IDENTIFIERS));
    await db.run(cds.ql.DELETE.from(TX_SEGMENTS));
    await db.run(cds.ql.DELETE.from(TX_RESULTS));
    await db.run(cds.ql.DELETE.from(TRANSACTIONS));
    await db.run(cds.ql.DELETE.from(BLOCKS));
    await db.run(cds.ql.DELETE.from(NIGHT_BALANCES));
    await db.run(cds.ql.DELETE.from(BACKGROUND_JOBS));
});

// ----------------------------------------------------------------------------
// Seed helpers: insert real rows that satisfy the schema's not-null fields.
// ----------------------------------------------------------------------------

async function seedBlock(height: number, overrides: Record<string, any> = {}): Promise<string> {
    const id = cds.utils.uuid();
    await db.run(cds.ql.INSERT.into(BLOCKS).entries({
        ID: id,
        hash: `block${height}`,
        height,
        protocolVersion: 1,
        timestamp: 1700000000 + height,
        stateRoot: 'abcd',
        ...overrides
    }));
    return id;
}

async function seedTransaction(blockId: string, overrides: Record<string, any> = {}): Promise<string> {
    const id = cds.utils.uuid();
    await db.run(cds.ql.INSERT.into(TRANSACTIONS).entries({
        ID: id,
        ...(await inBlock(db, blockId)),
        indexInBlock: nextTransactionPosition++,
        extrinsicHash: `tx-${id.slice(0, 8)}`,
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
        ...(await inTransaction(db, txId)),
        actionIndex: 0,
        contractAddress: 'c0',
        actionType: 'CALL',
        transaction_ID: txId,
        ...overrides
    }));
    return id;
}

async function seedUtxo(txId: string, overrides: Record<string, any> = {}): Promise<string> {
    const id = cds.utils.uuid();
    const outputIndex = nextOutputPosition.get(txId) ?? 0;
    nextOutputPosition.set(txId, outputIndex + 1);
    await db.run(cds.ql.INSERT.into(UNSHIELDED_UTXOS).entries({
        ID: id,
        ...(await inTransaction(db, txId)),
        owner: 'mn_addr_owner',
        tokenType: 'token',
        value: 1000,
        intentHash: 'intent',
        outputIndex,
        initialNonce: 'nonce',
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
// init(): delegated registration
//
// The framework ran init() once at boot, which calls our mocked
// registerWalletSessionHandlers + startSessionCleanup. We re-run init() on a
// fresh instance to assert the delegated wiring with the live db.
// Handler registration / read-only guards are covered behaviorally by the
// action tests + the read-only test below; the shutdown / cleanup-timer hook
// has its own dedicated describe block (below).
// ----------------------------------------------------------------------------
describe('init', () => {
    it('delegates wallet-session handling + cleanup with the live db connection', async () => {
        const ServiceCtor: any = (await import('../../srv/nightgate-service.js')).default;
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
// shutdown hook: srv/nightgate-service.ts registers cds.on('shutdown', ...) to
// clear the session-cleanup interval. We capture the handler registered during
// init() by spying cds.on (so we do NOT emit a real global 'shutdown' that would
// tear down the booted cds.test server), then invoke it directly and assert the
// clearInterval branch + the `if (this._cleanupTimer)` no-timer guard.
// ----------------------------------------------------------------------------
describe('shutdown hook', () => {
    async function initAndCaptureShutdown(timer: any): Promise<Function> {
        const ServiceCtor: any = (await import('../../srv/nightgate-service.js')).default;
        mockStartSessionCleanup.mockReturnValueOnce(timer);

        let shutdownHandler: Function | undefined;
        const onSpy = vi.spyOn(cds as any, 'on').mockImplementation(((event: string, cb: Function) => {
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
        const fakeTimer = { unref: vi.fn() } as unknown as ReturnType<typeof setInterval>;
        const handler = await initAndCaptureShutdown(fakeTimer);

        const clearSpy = vi.spyOn(global, 'clearInterval').mockImplementation(() => {});
        try {
            handler();
            expect(clearSpy).toHaveBeenCalledWith(fakeTimer);
        } finally {
            clearSpy.mockRestore();
        }
    });

    it('skips clearInterval when no cleanup timer is active', async () => {
        const handler = await initAndCaptureShutdown(undefined);

        const clearSpy = vi.spyOn(global, 'clearInterval').mockImplementation(() => {});
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

    it('the newest block is the first of a read ordered by height', async () => {
        await seedBlock(1);
        await seedBlock(3);
        await seedBlock(2);

        const res = await read('Blocks', '$orderby=height desc&$top=1');
        expect(res.data.value.map((b: any) => Number(b.height))).toEqual([3]);
    });

    it('a filter on the height reads one block', async () => {
        await seedBlock(41);
        await seedBlock(42);

        const res = await read('Blocks', '$filter=height eq 42');
        expect(res.data.value.map((b: any) => b.hash)).toEqual(['block42']);
        const none = await read('Blocks', '$filter=height eq 43');
        expect(none.data.value).toEqual([]);
    });

    it('a filter on two heights reads the blocks between them, in pages', async () => {
        for (const h of [13, 8, 11, 9, 12, 10]) await seedBlock(h);

        const between = '$filter=height ge 9 and height le 12&$orderby=height';
        const all = await read('Blocks', between);
        expect(all.data.value.map((b: any) => Number(b.height))).toEqual([9, 10, 11, 12]);
        const page = await read('Blocks', `${between}&$top=2&$skip=2`);
        expect(page.data.value.map((b: any) => Number(b.height))).toEqual([11, 12]);
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
        await seedTransaction(blockId, { extrinsicHash: 'abc1' });
        await seedTransaction(blockId, { extrinsicHash: 'def2' });

        const res = await srv.send({ event: 'byHash', entity: 'Transactions', data: { hash: '0xABC1' } });
        expect(res.length).toBe(1);
        expect(res[0].extrinsicHash).toBe('abc1');
    });

    it('allows the same extrinsic hash in different blocks', async () => {
        const firstBlock = await seedBlock(1);
        const secondBlock = await seedBlock(2);
        await seedTransaction(firstBlock, { indexInBlock: 0, extrinsicHash: 'feed01' });
        await seedTransaction(secondBlock, { indexInBlock: 0, extrinsicHash: 'feed01' });

        const res = await srv.send({
            event: 'byHash', entity: 'Transactions', data: { hash: 'feed01' }
        });
        expect(res).toHaveLength(2);
        expect(new Set(res.map((tx: any) => tx.block_ID))).toEqual(new Set([firstBlock, secondBlock]));
    });

    it('byTxId() tells where the transaction landed and which segments failed', async () => {
        const blockId = await seedBlock(5);
        const txId = await seedTransaction(blockId, { extrinsicHash: 'a5', txHash: 'b5' });
        await db.run(cds.ql.INSERT.into(TX_IDENTIFIERS).entries({ txId: 'cafe01', transaction_ID: txId }));
        const resultId = cds.utils.uuid();
        await db.run(cds.ql.INSERT.into(TX_RESULTS).entries({ ID: resultId, status: 'PARTIAL_SUCCESS', outcomeSource: 'substrate-system-events', transaction_ID: txId }));
        await db.run(cds.ql.INSERT.into(TX_SEGMENTS).entries([
            { ID: cds.utils.uuid(), segmentId: 0, success: true, transactionResult_ID: resultId },
            { ID: cds.utils.uuid(), segmentId: 1, success: false, transactionResult_ID: resultId }
        ]));

        const res = await cap.GET(`${API}/Transactions/byTxId(txId='0xCAFE01')`);
        expect(res.data).toEqual(expect.objectContaining({
            txId: 'cafe01', extrinsicHash: 'a5', txHash: 'b5', blockHeight: '5', blockHash: 'block5',
            status: 'PARTIAL_SUCCESS', failedSegments: [1]
        }));
    });

    it('byTxId() reports a null status while the result is not indexed', async () => {
        const txId = await seedTransaction(await seedBlock(6), { extrinsicHash: 'a6' });
        await db.run(cds.ql.INSERT.into(TX_IDENTIFIERS).entries({ txId: 'beef', transaction_ID: txId }));
        const res = await srv.send({ event: 'byTxId', entity: 'Transactions', data: { txId: 'beef' } });
        expect(res).toEqual(expect.objectContaining({ extrinsicHash: 'a6', blockHeight: '6', status: null, failedSegments: [] }));
    });

    it('byTxId() answers 404 for an identifier the index has not seen and 400 for a bad one', async () => {
        await expect(srv.send({ event: 'byTxId', entity: 'Transactions', data: { txId: 'ffff' } }))
            .rejects.toMatchObject({ status: 404 });
        await expect(srv.send({ event: 'byTxId', entity: 'Transactions', data: {} }))
            .rejects.toMatchObject({ status: 400 });
        await expect(srv.send({ event: 'byTxId', entity: 'Transactions', data: { txId: 'not-hex' } }))
            .rejects.toMatchObject({ status: 400 });
    });

    it('ledgerTransaction() reads the ledger transaction out of the stored extrinsic', async () => {
        const blockId = await seedBlock(8);
        const ledgerBytes = Buffer.from('ledger bytes');
        // Unsigned extrinsic: compact length, version, pallet, call, then the bytes behind their compact length.
        const body = Buffer.concat([Buffer.from([0x04, 5, 0, ledgerBytes.length << 2]), ledgerBytes]);
        const raw = Buffer.concat([Buffer.from([body.length << 2]), body]).toString('base64');
        await seedTransaction(blockId, { extrinsicHash: 'a8', txHash: 'b8', raw });
        await seedTransaction(blockId, { extrinsicHash: 'a8b', raw: null });

        const res = await srv.send({ event: 'ledgerTransaction', entity: 'Transactions', data: { hash: '0xA8' } });
        expect(res).toEqual({ extrinsicHash: 'a8', ledgerTransaction: ledgerBytes.toString('base64') });
        const byLedgerHash = await srv.send({ event: 'ledgerTransaction', entity: 'Transactions', data: { hash: 'b8' } });
        expect(byLedgerHash.ledgerTransaction).toBe(ledgerBytes.toString('base64'));
        await expect(srv.send({ event: 'ledgerTransaction', entity: 'Transactions', data: { hash: '0xa8b' } })).rejects.toMatchObject({ status: 404 });
        await expect(srv.send({ event: 'ledgerTransaction', entity: 'Transactions', data: { hash: '0xdead' } })).rejects.toMatchObject({ status: 404 });
        await expect(srv.send({ event: 'ledgerTransaction', entity: 'Transactions', data: {} })).rejects.toMatchObject({ status: 400 });
    });

    it('byHash() rejects when hash is missing', async () => {
        await expect(
            srv.send({ event: 'byHash', entity: 'Transactions', data: {} })
        ).rejects.toMatchObject({ message: 'hash is required' });
    });

    it('a filter on the type reads the transactions of that type, newest first', async () => {
        // One block, one insert time, as the crawler writes it. The place in the block decides.
        const blockId = await seedBlock(1);
        await seedTransaction(blockId, { extrinsicHash: 'ca12', txType: 'contract_call', indexInBlock: 2, createdAt: second(1) });
        await seedTransaction(blockId, { extrinsicHash: 'ca11', txType: 'contract_call', indexInBlock: 0, createdAt: second(1) });
        await seedTransaction(blockId, { extrinsicHash: 'fe01', txType: 'night_transfer', indexInBlock: 1, createdAt: second(1) });

        const ofType = "$filter=txType eq 'contract_call'&$orderby=blockHeight desc,indexInBlock desc";
        const res = await read('Transactions', ofType);
        expect(res.data.value.map((t: any) => t.extrinsicHash)).toEqual(['ca12', 'ca11']);
        const first = await read('Transactions', `${ofType}&$top=1`);
        expect(first.data.value.map((t: any) => t.extrinsicHash)).toEqual(['ca12']);
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

    it('a filter on the address reads the actions of one contract in the order of the chain, also within one block', async () => {
        // Stored in one go with one insert time, and with IDs that sort against the chain: only the position tells the order.
        const first = await seedBlock(1);
        const second2 = await seedBlock(2);
        const tx10 = await seedTransaction(first, { indexInBlock: 0 });
        const tx11 = await seedTransaction(first, { indexInBlock: 1 });
        const tx20 = await seedTransaction(second2, { indexInBlock: 0 });
        const id = (n: number) => `a0000000-0000-4000-8000-00000000000${n}`;
        await seedContractAction(tx20, { ID: id(1), contractAddress: 'c1', circuit: 'fifth', createdAt: second(1) });
        await seedContractAction(tx11, { ID: id(2), contractAddress: 'c1', circuit: 'fourth', actionIndex: 1, createdAt: second(1) });
        await seedContractAction(tx11, { ID: id(3), contractAddress: 'c1', circuit: 'third', actionIndex: 0, createdAt: second(1) });
        await seedContractAction(tx10, { ID: id(4), contractAddress: 'c1', circuit: 'second', actionIndex: 1, createdAt: second(1) });
        await seedContractAction(tx10, { ID: id(5), contractAddress: 'c1', circuit: 'first', actionIndex: 0, createdAt: second(1) });
        await seedContractAction(tx10, { ID: id(6), contractAddress: 'c2', circuit: 'other', actionIndex: 2, createdAt: second(1) });

        const oldest = await read('ContractActions', "$filter=contractAddress eq '0xC1'&$orderby=blockHeight,indexInBlock,actionIndex");
        expect(oldest.data.value.map((a: any) => a.circuit)).toEqual(['first', 'second', 'third', 'fourth', 'fifth']);
        expect(oldest.data.value.map((a: any) => [Number(a.blockHeight), a.indexInBlock, a.actionIndex])).toEqual([[1, 0, 0], [1, 0, 1], [1, 1, 0], [1, 1, 1], [2, 0, 0]]);
        const newest = await read('ContractActions', "$filter=contractAddress eq 'c1'&$orderby=blockHeight desc,indexInBlock desc,actionIndex desc&$top=2");
        expect(newest.data.value.map((a: any) => a.circuit)).toEqual(['fifth', 'fourth']);
        const fromBlock2 = await read('ContractActions', "$filter=contractAddress eq 'c1' and blockHeight ge 2&$orderby=blockHeight,indexInBlock,actionIndex");
        expect(fromBlock2.data.value.map((a: any) => a.circuit)).toEqual(['fifth']);
        // The insert time gives no order within the block: the same read by createdAt follows the row IDs.
        const byInsertTime = await read('ContractActions', "$filter=contractAddress eq 'c1'&$orderby=createdAt");
        expect(byInsertTime.data.value.map((a: any) => a.circuit)).toEqual(['fifth', 'fourth', 'third', 'second', 'first']);
    });
});

// ----------------------------------------------------------------------------
// ContractStates
// ----------------------------------------------------------------------------
describe('ContractStates', () => {
    // Preview has a built-in indexer, so the state lookup has one without local config.
    pinEnv({ NIGHTGATE_NETWORK: 'preview' });
    const ADDRESS = 'ab'.repeat(32);

    beforeEach(async () => {
        await db.run(cds.ql.DELETE.from(CONTRACT_STATES));
    });

    it('READ and stateAt() serve the stored current state over OData', async () => {
        await db.run(cds.ql.UPDATE.entity('midnight.SyncState').set({ lastSupplementedHeight: 9, chainHeight: 12 }).where({ ID: 'SINGLETON' }));
        const blockId = await seedBlock(7, { ledgerParameters: Buffer.from('lp7').toString('base64') });
        const txId = await seedTransaction(blockId);
        const actionId = await seedContractAction(txId, { contractAddress: ADDRESS, stateHash: 'h1' });
        await db.run(cds.ql.INSERT.into(CONTRACT_STATES).entries({
            contractAddress: ADDRESS, height: 7, state: Buffer.from('st').toString('base64'), stateHash: 'h1', contractAction_ID: actionId
        }));

        const list = await cap.GET(`${API}/ContractStates`);
        expect(list.data.value.map((r: any) => r.contractAddress)).toEqual([ADDRESS]);

        const res = await cap.GET(`${API}/ContractStates/stateAt(contractAddress='0x${ADDRESS}',height=null)`);
        expect(res.data).toEqual(expect.objectContaining({ contractAddress: ADDRESS, height: '7', source: 'current', stateHash: 'h1', blockHash: 'block7', coveredHeight: '9', chainHeight: '12' }));
        expect(Buffer.from(res.data.state, 'base64').toString()).toBe('st');
        expect(Buffer.from(res.data.ledgerParameters, 'base64').toString()).toBe('lp7');
    });

    it('stateAt() rejects an address that is not hex', async () => {
        await expect(
            srv.send({ event: 'stateAt', entity: 'ContractStates', data: { contractAddress: 'not-hex' } })
        ).rejects.toMatchObject({ code: 'ASSERT_FORMAT', target: 'contractAddress' });
    });

    it('stateAt() caps its indexer reads across callers', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
            new Response(JSON.stringify({ data: { contractAction: null } }), { status: 200 }));
        try {
            const ask = () => srv.send({ event: 'stateAt', entity: 'ContractStates', data: { contractAddress: 'cd'.repeat(32) } })
                .then(() => 200, (err: any) => err.status);
            const codes = [await ask(), await ask(), await ask()];
            expect(codes).toContain(429);
            expect(fetchSpy.mock.calls.length).toBeLessThanOrEqual(2);
        } finally {
            fetchSpy.mockRestore();
        }
    });

    it('stateAt() asks the indexer once for parameters the database does not hold', async () => {
        const address = 'ee'.repeat(32);
        const actionId = await seedContractAction(await seedTransaction(await seedBlock(510)), { contractAddress: address });
        await db.run(cds.ql.INSERT.into(CONTRACT_STATES).entries({
            contractAddress: address, height: 510, state: Buffer.from('st').toString('base64'), contractAction_ID: actionId
        }));
        await db.run(cds.ql.UPDATE.entity('midnight.Blocks').set({ ledgerParameters: null }).where({ ledgerParameters: { '!=': null } }));
        await new Promise(r => setTimeout(r, 1100));
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ data: { block: { ledgerParameters: '0a0b' } } }), { status: 200 }));
        try {
            const ask = () => srv.send({ event: 'stateAt', entity: 'ContractStates', data: { contractAddress: address } });
            const expected = Buffer.from('0a0b', 'hex').toString('base64');
            expect(await ask()).toEqual(expect.objectContaining({ source: 'current', height: '510', ledgerParameters: expected }));
            expect(await ask()).toEqual(expect.objectContaining({ ledgerParameters: expected }));
            expect(fetchSpy).toHaveBeenCalledTimes(1);
        } finally {
            fetchSpy.mockRestore();
        }
    });

    it('stateAt() asks the indexer again after it answered from behind the newest action', async () => {
        const address = 'ef'.repeat(32);
        const old = await seedContractAction(await seedTransaction(await seedBlock(520, { ledgerParameters: Buffer.from('lp520').toString('base64') })), { contractAddress: address });
        await seedContractAction(await seedTransaction(await seedBlock(522)), { contractAddress: address });
        await db.run(cds.ql.INSERT.into(CONTRACT_STATES).entries({
            contractAddress: address, height: 520, state: Buffer.from('st').toString('base64'), contractAction_ID: old
        }));
        const answer = (blockHash: string) => new Response(JSON.stringify({ data: { contractAction: {
            state: '0a0b', zswapState: null, transaction: { block: { hash: blockHash, ledgerParameters: null } }
        } } }), { status: 200 });
        // The limiter allows two indexer reads per second; the test before used them up.
        await new Promise(r => setTimeout(r, 1100));
        const fetchSpy = vi.spyOn(globalThis, 'fetch')
            .mockImplementationOnce(async () => answer('0xblock520'))
            .mockImplementationOnce(async () => answer('0xblock522'));
        try {
            const ask = () => srv.send({ event: 'stateAt', entity: 'ContractStates', data: { contractAddress: address } });
            await expect(ask()).rejects.toMatchObject({ status: 503 });
            expect(await ask()).toEqual(expect.objectContaining({ source: 'indexer', height: '522', blockHash: 'block522' }));
            expect(fetchSpy).toHaveBeenCalledTimes(2);
        } finally {
            fetchSpy.mockRestore();
        }
    });

    it('stateAt() keeps the state at a finalized action block and asks again for an answer from another block', async () => {
        const address = 'f1'.repeat(32);
        const other = 'f2'.repeat(32);
        for (const [contract, base] of [[address, 530], [other, 540]] as const) {
            await seedContractAction(await seedTransaction(await seedBlock(base, { ledgerParameters: Buffer.from('lp').toString('base64') })), { contractAddress: contract });
            const latest = await seedContractAction(await seedTransaction(await seedBlock(base + 4)), { contractAddress: contract });
            await db.run(cds.ql.INSERT.into(CONTRACT_STATES).entries({
                contractAddress: contract, height: base + 4, state: Buffer.from('st').toString('base64'), contractAction_ID: latest
            }));
        }
        await db.run(cds.ql.UPDATE.entity('midnight.SyncState').set({ lastIndexedHeight: 600 }).where({ ID: 'SINGLETON' }));
        const answer = (hash: string, height: number) => new Response(JSON.stringify({ data: { contractAction: {
            state: '0a0b', zswapState: null, transaction: { block: { hash, height, ledgerParameters: null } }
        } } }), { status: 200 });
        await new Promise(r => setTimeout(r, 1100));
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
            const { variables } = JSON.parse(String(init?.body));
            return variables.address === address ? answer('0xblock530', 530) : answer('0xforked', 540);
        });
        const now = Date.now();
        const clock = vi.spyOn(Date, 'now');
        try {
            const ask = (contract: string, height: number) => srv.send({ event: 'stateAt', entity: 'ContractStates', data: { contractAddress: contract, height } });
            clock.mockReturnValue(now);
            expect(await ask(address, 530)).toEqual(expect.objectContaining({ source: 'indexer', height: '530' }));
            await ask(other, 540);
            clock.mockReturnValue(now + 60_000);
            expect(await ask(address, 530)).toEqual(expect.objectContaining({ source: 'indexer', height: '530' }));
            await ask(other, 540);
            const asked = fetchSpy.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).variables.address);
            expect(asked.filter(a => a === address)).toHaveLength(1);
            expect(asked.filter(a => a === other)).toHaveLength(2);
        } finally {
            clock.mockRestore();
            fetchSpy.mockRestore();
        }
    });

    it('stateAt() names the cause of an indexer failure without its URL', async () => {
        await new Promise(r => setTimeout(r, 1100));
        const fetchSpy = vi.spyOn(globalThis, 'fetch')
            .mockImplementation(async () => { throw new Error('connect ECONNREFUSED https://indexer.example/api?key=secret'); });
        try {
            const err: any = await srv.send({ event: 'stateAt', entity: 'ContractStates', data: { contractAddress: '12'.repeat(32), height: 40 } })
                .catch((e: unknown) => e);
            expect(err).toMatchObject({ status: 502, code: 'BAD_GATEWAY', $sanitize: false });
            expect(err.message).toMatch(/at height 40: .*ECONNREFUSED <indexer>/);
            expect(err.message).not.toMatch(/secret/);
        } finally {
            fetchSpy.mockRestore();
        }
    });

    it('stateAt() leaves the text of an error outside the indexer to CAP, which hides it in production', async () => {
        const contractState = require('../../srv/crawler/contract-state');
        const spy = vi.spyOn(contractState, 'contractStateAt').mockRejectedValueOnce(new Error('SQLITE_ERROR: no such column x'));
        try {
            const err: any = await srv.send({ event: 'stateAt', entity: 'ContractStates', data: { contractAddress: '13'.repeat(32), height: 40 } })
                .catch((e: unknown) => e);
            expect(err.message).toMatch(/SQLITE_ERROR/);
            expect(err.$sanitize).toBeUndefined();
            expect(err.code).not.toBe('BAD_GATEWAY');
        } finally {
            spy.mockRestore();
        }
    });

    it('Blocks/ledgerParametersAt() serves the stored parameters in effect at a height or at the tip', async () => {
        await seedBlock(700, { ledgerParameters: Buffer.from('lp700').toString('base64') });
        await seedBlock(704, { ledgerParameters: Buffer.from('lp704').toString('base64') });
        const tip = await cap.GET(`${API}/Blocks/ledgerParametersAt(height=null)`);
        expect(tip.data).toEqual(expect.objectContaining({ height: null }));
        expect(Buffer.from(tip.data.ledgerParameters, 'base64').toString()).toBe('lp704');
        const at = await cap.GET(`${API}/Blocks/ledgerParametersAt(height=703)`);
        expect(at.data).toEqual(expect.objectContaining({ height: '703' }));
        expect(Buffer.from(at.data.ledgerParameters, 'base64').toString()).toBe('lp700');
    });

    it('Blocks/ledgerParametersAt() answers 404 when neither the database nor the indexer knows them', async () => {
        await new Promise(r => setTimeout(r, 1100));
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ data: { block: null } }), { status: 200 }));
        try {
            await expect(srv.send({ event: 'ledgerParametersAt', entity: 'Blocks', data: { height: 1 } })).rejects.toMatchObject({ status: 404 });
            expect(fetchSpy).toHaveBeenCalledTimes(1);
        } finally {
            fetchSpy.mockRestore();
        }
    });

    it('Blocks/ledgerParametersAt() names the cause of an indexer failure without its URL', async () => {
        await new Promise(r => setTimeout(r, 1100));
        const fetchSpy = vi.spyOn(globalThis, 'fetch')
            .mockImplementation(async () => { throw new Error('connect ECONNREFUSED https://indexer.example/api?key=secret'); });
        try {
            const err: any = await srv.send({ event: 'ledgerParametersAt', entity: 'Blocks', data: { height: 2 } }).catch((e: unknown) => e);
            expect(err).toMatchObject({ status: 502, code: 'BAD_GATEWAY', $sanitize: false });
            expect(err.message).toMatch(/ledger parameters at height 2: .*ECONNREFUSED <indexer>/);
            expect(err.message).not.toMatch(/secret/);
        } finally {
            fetchSpy.mockRestore();
        }
    });

    it('getGrantUsage() takes a grant id and timestamps in the form the client sends them', async () => {
        const url = `${API}/getGrantUsage(grantId='00000000-0000-4000-8000-000000000000',since='2026-11-01T00:00:00Z',until='2026-11-02T00:00:00Z')`;
        await expect(cap.GET(url)).rejects.toMatchObject({ response: { status: 404 } });
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

    it('a filter on the owner reads the UTXOs of one address, newest first', async () => {
        const older = await seedTransaction(await seedBlock(1));
        const newer = await seedTransaction(await seedBlock(2));
        await seedUtxo(newer, { owner: 'mn_addr_alice', value: 3, intentHash: 'later', createdAt: second(1) });
        await seedUtxo(older, { owner: 'mn_addr_alice', value: 1, createdAt: second(1) });
        await seedUtxo(older, { owner: 'mn_addr_alice', value: 2, createdAt: second(1) });
        await seedUtxo(older, { owner: 'mn_addr_bob', value: 4, createdAt: second(1) });

        const res = await read('UnshieldedUtxos', "$filter=owner eq 'mn_addr_alice'&$orderby=blockHeight desc,indexInBlock desc,outputIndex desc");
        expect(res.data.value.map((u: any) => Number(u.value))).toEqual([3, 2, 1]);
    });

    it('a filter on the spending transaction reads the unspent UTXOs', async () => {
        const blockId = await seedBlock(1);
        const txId = await seedTransaction(blockId);
        const spendTxId = await seedTransaction(blockId, { extrinsicHash: 'spend' });
        await seedUtxo(txId, { owner: 'mn_addr_unspent' });
        await seedUtxo(txId, { owner: 'mn_addr_spent', spentAtTransaction_ID: spendTxId });

        const res = await read('UnshieldedUtxos', '$filter=spentAtTransaction_ID eq null&$orderby=blockHeight desc,indexInBlock desc,outputIndex desc');
        expect(res.data.value.map((u: any) => u.owner)).toEqual(['mn_addr_unspent']);
    });
});

// ----------------------------------------------------------------------------
// NightBalances
// ----------------------------------------------------------------------------
describe('NightBalances', () => {
    it('the balance of an address is read by its key', async () => {
        await seedBalance('mn_addr_1', 1000);
        await seedBalance('mn_addr_2', 2000);

        const res = await cap.GET(`${API}/NightBalances('mn_addr_1')`);
        expect(res.data.address).toBe('mn_addr_1');
        expect(Number(res.data.balance)).toBe(1000);
        await expect(cap.GET(`${API}/NightBalances('mn_addr_3')`)).rejects.toMatchObject({ response: { status: 404 } });
    });

    it('the highest balances are the first of a read ordered by balance', async () => {
        await seedBalance('addr-low', 1);
        await seedBalance('addr-high', 100);
        await seedBalance('addr-mid', 50);

        const top = await read('NightBalances', '$orderby=balance desc&$top=2');
        expect(top.data.value.map((r: any) => Number(r.balance))).toEqual([100, 50]);
        const rest = await read('NightBalances', '$orderby=balance desc&$top=2&$skip=2');
        expect(rest.data.value.map((r: any) => Number(r.balance))).toEqual([1]);
    });
});

describe('paging of an entity read', () => {
    it('a read returns at most 1000 rows and links to the next page', async () => {
        await db.run(cds.ql.INSERT.into(NIGHT_BALANCES).entries(
            Array.from({ length: 1001 }, (_, i) => ({ address: `addr-${String(i).padStart(4, '0')}`, balance: i }))
        ));

        const first = await read('NightBalances', '$orderby=balance desc&$count=true');
        expect(first.data.value).toHaveLength(1000);
        expect(first.data['@odata.count']).toBe(1001);
        const next = await cap.GET(`${API}/${first.data['@odata.nextLink']}`);
        expect(next.data.value.map((r: any) => r.address)).toEqual(['addr-0000']);
        expect(next.data['@odata.nextLink']).toBeUndefined();

        const asked = await read('NightBalances', '$orderby=balance desc&$top=5000');
        expect(asked.data.value).toHaveLength(1000);
        expect(asked.data['@odata.nextLink']).toBeDefined();
    });
});

describe('the address the server listens on', () => {
    it('a server that checks no credentials answers this machine only', () => {
        expect((cds as any).env.requires.auth.kind).toBe('dummy');
        expect((cds as any).app.server.address()).toMatchObject({ address: '127.0.0.1', family: 'IPv4' });
    });

    it('a connection over another address of this machine is refused', async () => {
        const other = Object.values(networkInterfaces()).flat().find(i => i?.family === 'IPv4' && !i.internal)?.address;
        // A machine without a network has no other address to try.
        if (!other) return;
        const { port } = (cds as any).app.server.address();
        await expect(fetch(`http://${other}:${port}/odata/v4/midnight-indexer/getLiveness()`)).rejects.toThrow();
        expect((await fetch(`http://127.0.0.1:${port}/odata/v4/midnight-indexer/getLiveness()`)).status).toBe(200);
    });
});

describe('read limits', () => {
    pinEnv({ NIGHTGATE_QUERY_RATE_LIMIT: '3' });
    // The booted server counts in its own copy of the module.
    const rateClasses = require('../../srv/utils/rate-classes');
    beforeEach(() => rateClasses.__resetRateLimitersForTests());
    afterEach(() => rateClasses.__resetRateLimitersForTests());
    const answer = (p: Promise<any>) => p.then((r: any) => r, (e: any) => e.response ?? e);

    it('the read over the limit answers 429 and says when to retry', async () => {
        for (let i = 0; i < 3; i++) expect((await answer(cap.GET(`${API}/Blocks?$top=1`))).status).toBe(200);
        const refused = await answer(cap.GET(`${API}/Blocks?$top=1`));
        expect(refused.status).toBe(429);
        expect(refused.data.error).toMatchObject({ code: 'RATE_LIMITED', message: expect.stringMatching(/query: 3 per minute/) });
        expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
    });

    it('a bound read function and getJobStatus count as reads', async () => {
        expect((await answer(cap.GET(`${API}/Transactions/byHash(hash='ab')`))).status).toBe(200);
        expect((await answer(cap.GET(`${API}/getJobStatus(jobId='00000000-0000-4000-8000-000000000009')`))).status).toBe(404);
        expect((await answer(cap.GET(`${API}/NightBalances?$top=1`))).status).toBe(200);
        expect((await answer(cap.GET(`${API}/Blocks?$top=1`))).status).toBe(429);
    });

    it('an analytics function counts as a read', async () => {
        const ANALYTICS = '/odata/v4/midnight-analytics';
        for (let i = 0; i < 3; i++) expect((await answer(cap.GET(`${ANALYTICS}/getBlockCount()`))).status).toBe(200);
        expect((await answer(cap.GET(`${ANALYTICS}/getBlockCount()`))).status).toBe(429);
    });

    it('each part of a $batch counts on its own', async () => {
        const requests = ['1', '2', '3', '4'].map(id => ({ id, method: 'GET', url: '/Blocks?$top=1', headers: { accept: 'application/json' } }));
        const res = await cap.POST(`${API}/$batch`, { requests });
        expect(res.data.responses.map((r: any) => r.status)).toEqual([200, 200, 200, 429]);
    });
});

describe('the size of a $batch', () => {
    const batchOf = (parts: number) => cap.POST(`${API}/$batch`, {
        requests: Array.from({ length: parts }, (_, i) => ({ id: String(i), method: 'GET', url: '/Blocks?$top=1', headers: { accept: 'application/json' } }))
    }).then((r: any) => r, (e: any) => e.response ?? e);

    it('carries at most 20 requests', async () => {
        expect((await batchOf(20)).status).toBe(200);
        const refused = await batchOf(21);
        expect(refused.status).toBe(429);
        expect(refused.data.error).toMatchObject({ code: 'BATCH_TOO_MANY_REQ', message: 'Batch request contains too many requests' });
    });
});

describe('a read function a query replaces', () => {
    it.each([
        'Blocks/latest()',
        'Blocks/byHeight(height=1)',
        'Blocks/range(startHeight=1,endHeight=2)',
        "Transactions/byType(txType='contract_call')",
        "ContractActions/byAddress(contractAddress='c1')",
        "ContractActions/history(contractAddress='c1')",
        "UnshieldedUtxos/byOwner(owner='mn_addr_alice')",
        'UnshieldedUtxos/unspent()',
        "NightBalances/getBalance(address='mn_addr_1')",
        'NightBalances/getTopHolders()'
    ])('%s is not part of the service', async (path) => {
        const res = await cap.GET(`${API}/${path}`).catch((e: any) => e.response ?? e);
        expect(res.status).toBe(404);
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
                stateRoot: '0x00'
            })
        ).rejects.toMatchObject({
            response: { status: 405 }
        });
    });
});

// ----------------------------------------------------------------------------
// getJobStatus (async submission lifecycle)
//
// getJobStatus is an unbound service function that reads a real BackgroundJobs
// row via getJobById. We seed the row and assert the projected shape: the
// right row (and only the caller's own row) is returned.
// ----------------------------------------------------------------------------
describe('BackgroundJobs idempotency constraint', () => {
    it('rejects two rows with the same session, kind and idempotency key', async () => {
        const base = {
            kind: 'sendToken',
            sessionId: 'idem-session',
            status: 'pending',
            idempotencyKey: 'same-command'
        };
        await db.run(cds.ql.INSERT.into(BACKGROUND_JOBS).entries({ ID: cds.utils.uuid(), ...base }));
        await expect(
            db.run(cds.ql.INSERT.into(BACKGROUND_JOBS).entries({ ID: cds.utils.uuid(), ...base, status: 'failed' }))
        ).rejects.toBeTruthy();
    });

    it('still permits multiple jobs without an idempotency key', async () => {
        const base = { kind: 'sendToken', sessionId: 'no-key-session', status: 'pending', idempotencyKey: null };
        await db.run(cds.ql.INSERT.into(BACKGROUND_JOBS).entries({ ID: cds.utils.uuid(), ...base }));
        await db.run(cds.ql.INSERT.into(BACKGROUND_JOBS).entries({ ID: cds.utils.uuid(), ...base }));
        const rows = await db.run(cds.ql.SELECT.from(BACKGROUND_JOBS).where({ sessionId: 'no-key-session' }));
        expect(rows).toHaveLength(2);
    });

    // Exercises the exact mechanism startJob uses for a concurrent-insert loser:
    // on the pinned runner (db.tx(cds.context), the same connection backing the
    // handler's writes) a colliding INSERT raises the unique violation INSIDE a
    // savepoint, ROLLBACK TO undoes only that insert, and the surrounding tx
    // stays usable - it can still read the winner and commit a further write.
    // (The two-concurrent-transaction / Postgres "transaction aborted" variant
    // lives in scripts/test-postgres-idempotency.mjs; SQLite does not abort a tx
    // on a constraint error, so only Postgres proves the savepoint is required.)
    it('isolates a unique violation inside the pinned savepoint and keeps the tx usable', async () => {
        const key = 'pin-collision';
        const winnerId = cds.utils.uuid();
        // Winner committed by a prior transaction.
        await db.run(cds.ql.INSERT.into(BACKGROUND_JOBS).entries({
            ID: winnerId, kind: 'sendToken', sessionId: 'pin-session', status: 'pending', idempotencyKey: key
        }));

        await cds.tx(async () => {
            const runner: any = (db as any).tx(cds.context);
            await runner.run(`SAVEPOINT nightgate_job_insert`);
            let violated = false;
            try {
                await runner.run(cds.ql.INSERT.into(BACKGROUND_JOBS).entries({
                    ID: cds.utils.uuid(), kind: 'sendToken', sessionId: 'pin-session', status: 'pending', idempotencyKey: key
                }));
            } catch (e: any) {
                violated = true;
                expect(String(e?.message ?? e)).toMatch(/unique/i);
            }
            expect(violated).toBe(true);
            await runner.run(`ROLLBACK TO SAVEPOINT nightgate_job_insert`);
            await runner.run(`RELEASE SAVEPOINT nightgate_job_insert`);

            // The outer tx is still usable: it reads the winner and commits a write.
            const winner = await runner.run(
                cds.ql.SELECT.one.from(BACKGROUND_JOBS).where({ sessionId: 'pin-session', idempotencyKey: key })
            );
            expect(winner?.ID).toBe(winnerId);
            await runner.run(cds.ql.UPDATE.entity(BACKGROUND_JOBS).set({ status: 'running' }).where({ ID: winnerId }));
        });

        const rows = await db.run(cds.ql.SELECT.from(BACKGROUND_JOBS).where({ sessionId: 'pin-session' }));
        expect(rows).toHaveLength(1);            // loser's insert rolled back; only the winner remains
        expect(rows[0].status).toBe('running');  // the post-rollback write committed
    });
});

describe('getJobStatus', () => {
    const VALID_JOB_ID = '11111111-1111-1111-1111-111111111111';
    const VALID_SESSION = '22222222-2222-2222-2222-222222222222';
    const FOREIGN_SESSION = '33333333-3333-3333-3333-333333333333';

    async function seedJob(overrides: Record<string, any> = {}): Promise<void> {
        await db.run(cds.ql.INSERT.into(BACKGROUND_JOBS).entries({
            ID: VALID_JOB_ID,
            kind: 'sendToken',
            sessionId: VALID_SESSION,
            status: 'succeeded',
            idempotencyKey: null,
            request: '{"foo":"bar"}',
            result: '{"txId":"tx-OK"}',
            errorCode: null,
            errorMessage: null,
            queuedAt: '2026-05-19T11:59:59.000Z',
            externalExecutionAt: '2026-05-19T12:00:01.000Z',
            submittedAt: '2026-05-19T12:00:03.000Z',
            startedAt: '2026-05-19T12:00:00.000Z',
            finishedAt: '2026-05-19T12:00:05.000Z',
            chainStatus: 'success',
            chainFinalizedAt: '2026-05-19T12:00:10.000Z',
            ...overrides
        }));
    }

    it('rejects when jobId is missing', async () => {
        await expect(
            srv.send('getJobStatus', { sessionId: VALID_SESSION })
        ).rejects.toMatchObject({ message: 'jobId is required' });
    });

    it('finds a job by its id alone, for the caller that started it only', async () => {
        await seedJob({ requestedBy: 'alice' });
        const byId = (userId: string) => cds.tx({ user: new (cds as any).User({ id: userId, roles: [] }) } as any, () =>
            srv.send('getJobStatus', { jobId: VALID_JOB_ID }));
        expect(await byId('alice')).toMatchObject({ jobId: VALID_JOB_ID, status: 'succeeded' });
        await expect(byId('mallory')).rejects.toMatchObject({ message: 'Job not found' });
    });

    it('by its id alone, a job without requestedBy stays closed to a caller who does not own its session', async () => {
        await seedJob();
        const user = new (cds as any).User({ id: 'mallory', roles: [] });
        await expect(cds.tx({ user } as any, () => srv.send('getJobStatus', { jobId: VALID_JOB_ID })))
            .rejects.toMatchObject({ message: 'Job not found' });
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
        await seedJob({ requestedBy: 'alice' });

        const out = await sendAs('alice');

        expect(out).toEqual(expect.objectContaining({
            jobId: VALID_JOB_ID,
            kind: 'sendToken',
            status: 'succeeded',
            result: { txId: 'tx-OK' },
            chainSegments: [],
            errorCode: null,
            errorMessage: null,
            queuedAt: '2026-05-19T11:59:59.000Z',
            externalExecutionAt: '2026-05-19T12:00:01.000Z',
            submittedAt: '2026-05-19T12:00:03.000Z',
            startedAt: '2026-05-19T12:00:00.000Z',
            finishedAt: '2026-05-19T12:00:05.000Z',
            chainStatus: 'success',
            chainFinalizedAt: '2026-05-19T12:00:10.000Z'
        }));
    });

    it('a result and the parts of a batch arrive as JSON, not as text that holds JSON', async () => {
        const segments = [{ segment: 1, calls: ['attest', 'anchorContentRoot'], applied: true }, { segment: 2, calls: ['registerDocument'], applied: false }];
        await seedJob({ requestedBy: 'alice', result: JSON.stringify({ txId: 'tx-OK', circuits: ['attest'], nested: { n: 1 } }), chainSegments: JSON.stringify(segments) });
        const res = await cap.GET(`${API}/getJobStatus(jobId='${VALID_JOB_ID}')`);
        expect(res.status).toBe(200);
        expect(res.data.result).toEqual({ txId: 'tx-OK', circuits: ['attest'], nested: { n: 1 } });
        expect(res.data.chainSegments).toEqual(segments);
    });

    it('a stored result that is no object comes back under raw, never as a second form', async () => {
        await seedJob({ requestedBy: 'alice', result: '[1,2]' });
        expect((await sendAs('alice')).result).toEqual({ raw: '[1,2]' });
        await db.run(cds.ql.UPDATE.entity(BACKGROUND_JOBS).set({ result: 'not json' }).where({ ID: VALID_JOB_ID }));
        expect((await sendAs('alice')).result).toEqual({ raw: 'not json' });
    });

    it('relays failure state (errorCode / errorMessage) for a failed job', async () => {
        await seedJob({
            status: 'failed',
            result: null,
            errorCode: '1016',
            errorMessage: 'Transaction pool full or immediately dropped',
            finishedAt: '2026-05-19T12:00:30.000Z',
            requestedBy: 'alice'
        });

        const out = await sendAs('alice');
        expect(out.status).toBe('failed');
        expect(out.errorCode).toBe('1016');
        expect(out.errorMessage).toMatch(/pool full/);
        expect(out.result).toBeNull();
    });

    // Ownership is FAIL-CLOSED for non-admin callers: a missing
    // session row (e.g. closed after a restart) must not open the job up.
    function sendAs(userId: string, extra: Record<string, unknown> = {}): Promise<any> {
        const user = new (cds as any).User({ id: userId, roles: [] });
        return cds.tx({ user } as any, () =>
            srv.send('getJobStatus', { jobId: VALID_JOB_ID, sessionId: VALID_SESSION, ...extra }));
    }

    it('names the identifier and the hash explorers show, the stored one or the indexed one', async () => {
        await seedJob({ requestedBy: 'alice', txId: '0xCAFE77' });
        const before = await sendAs('alice');
        expect(before).toEqual(expect.objectContaining({ txId: '0xCAFE77', txHash: null }));
        expect(before).not.toHaveProperty('transactionId');
        expect(before).not.toHaveProperty('transactionHash');
        const txRow = await seedTransaction(await seedBlock(77), { extrinsicHash: 'tx77', txHash: 'ab77' });
        await db.run(cds.ql.INSERT.into(TX_IDENTIFIERS).entries({ txId: 'cafe77', transaction_ID: txRow }));
        expect((await sendAs('alice')).txHash).toBe('ab77');
    });

    it('a job that stored its hash answers it without the index', async () => {
        await seedJob({ requestedBy: 'alice', txId: '0xCAFE7A', txHash: 'ab7a' });
        expect(await sendAs('alice')).toEqual(expect.objectContaining({ txId: '0xCAFE7A', txHash: 'ab7a' }));
    });

    it('a job stored with its hash alone names the last identifier the indexed transaction lists', async () => {
        await seedJob({ requestedBy: 'alice', txHash: 'ab78' });
        expect(await sendAs('alice')).toEqual(expect.objectContaining({ txId: null, txHash: 'ab78' }));
        await seedTransaction(await seedBlock(78), { extrinsicHash: 'tx78', txHash: 'ab78', identifiers: JSON.stringify(['00aa', '00bb']) });
        const listed = (await srv.run(cds.ql.SELECT.from('NightgateService.Transactions')) as any[]).find(row => row.txHash === 'ab78');
        expect(listed).toMatchObject({ extrinsicHash: 'tx78', txHash: 'ab78' });
        expect(listed).not.toHaveProperty('identifiers');
        expect(await sendAs('alice')).toEqual(expect.objectContaining({ txId: '00bb', txHash: 'ab78' }));
    });

    it('waits with waitMs until the job settles', async () => {
        await seedJob({ requestedBy: 'alice', status: 'running' });
        setTimeout(() => { void db.run(cds.ql.UPDATE.entity(BACKGROUND_JOBS).set({ status: 'succeeded' }).where({ ID: VALID_JOB_ID })); }, 300);
        const t0 = Date.now();
        const out = await sendAs('alice', { waitMs: 5000 });
        expect(out.status).toBe('succeeded');
        expect(Date.now() - t0).toBeLessThan(4000);
    });

    it('with untilChain holds a succeeded job until the chain has decided', async () => {
        await seedJob({ requestedBy: 'alice', status: 'succeeded', chainStatus: 'pending', txId: '0xCAFE78' });
        expect((await sendAs('alice', { waitMs: 400 })).chainStatus).toBe('pending');
        setTimeout(() => { void db.run(cds.ql.UPDATE.entity(BACKGROUND_JOBS).set({ chainStatus: 'success' }).where({ ID: VALID_JOB_ID })); }, 300);
        const t0 = Date.now();
        const out = await sendAs('alice', { waitMs: 5000, untilChain: true });
        expect(out.chainStatus).toBe('success');
        expect(Date.now() - t0).toBeLessThan(4000);
    });

    it('with untilChain gives a pending job back when the time is up, and a failed job at once', async () => {
        await seedJob({ requestedBy: 'alice', status: 'succeeded', chainStatus: 'pending', txId: '0xCAFE79' });
        expect((await sendAs('alice', { waitMs: 600, untilChain: true })).chainStatus).toBe('pending');
        await db.run(cds.ql.UPDATE.entity(BACKGROUND_JOBS).set({ status: 'failed', chainStatus: 'failure' }).where({ ID: VALID_JOB_ID }));
        const t0 = Date.now();
        expect((await sendAs('alice', { waitMs: 5000, untilChain: true })).status).toBe('failed');
        expect(Date.now() - t0).toBeLessThan(4000);
    });

    it('returns the unsettled job when waitMs runs out, and refuses a waitMs out of range', async () => {
        await seedJob({ requestedBy: 'alice', status: 'running' });
        expect((await sendAs('alice', { waitMs: 600 })).status).toBe('running');
        await expect(sendAs('alice', { waitMs: 25_001 })).rejects.toMatchObject({ message: 'waitMs must be an integer from 0 to 25000' });
    });

    it('404s for a non-admin caller when the job has no requestedBy and no session row (fail-closed)', async () => {
        await seedJob();
        await expect(sendAs('mallory')).rejects.toMatchObject({ message: 'Job not found' });
    });

    it('404s for a non-admin caller whose id differs from the recorded requestedBy', async () => {
        await seedJob({ requestedBy: 'alice' });
        await expect(sendAs('mallory')).rejects.toMatchObject({ message: 'Job not found' });
    });

    it('returns the job for the non-admin caller recorded as requestedBy', async () => {
        await seedJob({ requestedBy: 'alice' });
        const out = await sendAs('alice');
        expect(out.status).toBe('succeeded');
        expect(out.jobId).toBe(VALID_JOB_ID);
    });
});

// ----------------------------------------------------------------------------
// Owner-scoped entity reads (WalletSessions / PendingSubmissions)
//
// The raw entity READ surface is scoped to the requesting principal; admins
// (and the privileged default test user) read unfiltered. The scoping runs in
// custom before/on handlers, so it is exercised programmatically with
// explicit cds.User contexts via cds.tx.
// ----------------------------------------------------------------------------
describe('sponsorFinalized over REAL OData: the pool sentinel', () => {
    // The pool sentinel travels through fields DECLARED Edm.Guid (the returned
    // sessionId, getJobStatus.sessionId). A non-UUID string sentinel would be
    // rejected by OData deserialization; this pins that the reserved UUID passes.
    const SENTINEL = '00000000-0000-0000-0000-706f6f6c0000';

    it('the sentinel passes Edm.Guid validation on getJobStatus', async () => {
        const res: any = await cap.GET(`${API}/getJobStatus(jobId='00000000-0000-4000-8000-000000000009',sessionId='${SENTINEL}')`)
            .catch((e: any) => e.response ?? e);
        expect(res.status).toBe(404);
        expect(JSON.stringify(res?.data ?? '')).not.toMatch(/Deserialization|Invalid value.*Guid|not a valid UUID/i);
    });

    it('getJobStatus is a read: a POST is refused', async () => {
        const res: any = await cap.POST(`${API}/getJobStatus`, { jobId: '00000000-0000-4000-8000-000000000009' })
            .catch((e: any) => e.response ?? e);
        expect(res.status).toBe(405);
    });

    it('the request names no payer', async () => {
        process.env.NIGHTGATE_FEE_SPONSOR_SESSIONS = 'a4f1c8ee-0000-4000-8000-000000000001';
        try {
            const res: any = await cap.POST(`${API}/sponsorFinalized`, {
                finalizedTxB64: Buffer.from('probe').toString('base64'),
                sponsorSessionId: SENTINEL
            }).catch((e: any) => e.response ?? e);
            expect(res.status).toBe(400);
            expect(JSON.stringify(res?.data ?? '')).toMatch(/sponsorSessionId/);
        } finally {
            delete process.env.NIGHTGATE_FEE_SPONSOR_SESSIONS;
        }
    });

    // CAP strips every 5xx message under NODE_ENV=production; the busy 503 opts out. Pins the wire for one production request.
    it('a busy admission keeps code + message on the wire in production, with Retry-After', async () => {
        const bg = require('../../srv/submission/background-jobs');
        const spy = vi.spyOn(bg, 'startJob').mockRejectedValueOnce(new bg.JobAdmissionBusyError('sponsorFinalized'));
        // the request-path byte check runs in the wallet worker, which this test does not start
        const workerClient = require('../../srv/midnight/wallet-worker-client');
        const described = vi.spyOn(workerClient, 'walletDescribeTransaction').mockResolvedValueOnce({ bytes: 5, bound: true });
        const prevNodeEnv = process.env.NODE_ENV;
        process.env.NIGHTGATE_FEE_SPONSOR_SESSIONS = 'a4f1c8ee-0000-4000-8000-000000000001';
        process.env.NODE_ENV = 'production';
        try {
            const res: any = await cap.POST(`${API}/sponsorFinalized`, {
                finalizedTxB64: Buffer.from('probe').toString('base64')
            }).catch((e: any) => e.response ?? e);
            expect(described).toHaveBeenCalled();
            expect(spy).toHaveBeenCalled();
            expect(res.status).toBe(503);
            expect(res.headers?.['retry-after']).toBe('2');
            expect(res.data?.error?.code).toBe('JOB_ADMISSION_BUSY');
            expect(res.data?.error?.message).toMatch(/nothing was submitted, retry/);
        } finally {
            if (prevNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prevNodeEnv;
            delete process.env.NIGHTGATE_FEE_SPONSOR_SESSIONS;
            spy.mockRestore();
        }
    });

    it('without a configured pool nothing can pay: 503, no job', async () => {
        delete process.env.NIGHTGATE_FEE_SPONSOR_SESSIONS;
        const res: any = await cap.POST(`${API}/sponsorFinalized`, {
            finalizedTxB64: Buffer.from('probe').toString('base64')
        }).catch((e: any) => e.response ?? e);
        expect(res.status).toBe(503);
        expect(res.data?.jobId).toBeUndefined();
        expect(JSON.stringify(res?.data ?? '')).toMatch(/no fee sponsor is configured/);
    });
});

describe('owner-scoped entity reads', () => {
    const WALLET_SESSIONS = 'midnight.WalletSessions';
    const PENDING_SUBMISSIONS = 'midnight.PendingSubmissions';

    async function seedSession(userId: string, sessionId: string): Promise<void> {
        await db.run(cds.ql.INSERT.into(WALLET_SESSIONS).entries({
            userId,
            sessionId,
            connectedAt: new Date().toISOString(),
            isActive: true
        }));
    }

    async function seedSubmission(sessionId: string | null, txId: string): Promise<void> {
        await db.run(cds.ql.INSERT.into(PENDING_SUBMISSIONS).entries({
            ID: cds.utils.uuid(),
            txId,
            actionType: 'DEPLOY',
            submittedAt: new Date().toISOString(),
            status: 'pending',
            sessionId
        }));
    }

    function readAs(userId: string, roles: string[], entity: string): Promise<any[]> {
        const user = new (cds as any).User({ id: userId, roles });
        return cds.tx({ user } as any, () =>
            srv.run(cds.ql.SELECT.from(`NightgateService.${entity}`))
        );
    }

    const ALICE_SESSION = '11111111-1111-4111-8111-111111111111';
    const BOB_SESSION = '22222222-2222-4222-8222-222222222222';

    beforeEach(async () => {
        await db.run(cds.ql.DELETE.from(PENDING_SUBMISSIONS));
        await db.run(cds.ql.DELETE.from(WALLET_SESSIONS));
        await seedSession('alice', ALICE_SESSION);
        await seedSession('bob', BOB_SESSION);
        await seedSubmission(ALICE_SESSION, '0xalice-tx');
        await seedSubmission(BOB_SESSION, '0xbob-tx');
        await seedSubmission(null, '0xownerless-tx');
    });

    afterAll(async () => {
        await db.run(cds.ql.DELETE.from(PENDING_SUBMISSIONS));
        await db.run(cds.ql.DELETE.from(WALLET_SESSIONS));
    });

    it('WalletSessions READ returns only the requesting user\'s sessions', async () => {
        const rows = await readAs('alice', [], 'WalletSessions');
        expect(rows.map((r: any) => r.sessionId)).toEqual([ALICE_SESSION]);
    });

    it('WalletSessions READ returns everything for admins', async () => {
        const rows = await readAs('ops', ['admin'], 'WalletSessions');
        expect(rows.map((r: any) => r.sessionId).sort()).toEqual([ALICE_SESSION, BOB_SESSION]);
    });

    it('the list of sends is the operator\'s: the main service has no PendingSubmissions, the admin service shows all rows', async () => {
        expect(srv.entities.PendingSubmissions).toBeUndefined();
        const admin = await cds.connect.to('NightgateAdminService');
        const ops = new (cds as any).User({ id: 'ops', roles: ['admin'] });
        const rows: any[] = await cds.tx({ user: ops } as any, () => admin.run(cds.ql.SELECT.from('NightgateAdminService.PendingSubmissions')));
        expect(rows.map(r => r.txId).sort()).toEqual(['0xalice-tx', '0xbob-tx', '0xownerless-tx']);
        expect(rows[0]).not.toHaveProperty('submitIntentData');
    });

    it('a caller\'s grants come without lists as JSON text and without counters, the admin service shows them', async () => {
        const GRANTS_TABLE = 'midnight.AgentGrants';
        await db.run(cds.ql.DELETE.from(GRANTS_TABLE));
        await db.run(cds.ql.INSERT.into(GRANTS_TABLE).entries({
            ID: '33333333-3333-4333-8333-333333333333', userId: 'alice', sessionId: ALICE_SESSION, tokenHash: 'ab'.repeat(32),
            allowedActions: '["sponsorUnbound"]', allowedContracts: '["aa"]', maxJobsPerDay: 5, jobsUsedToday: 3, budgetWindow: '2026-11-22',
            valueUsedToday: '{}', deploysUsed: 1, maxDeploys: 2, allowDeploy: true, isActive: true, label: 'mine'
        }));
        const [own] = await readAs('alice', [], 'AgentGrants');
        expect(own).toMatchObject({ label: 'mine', sessionId: ALICE_SESSION, maxJobsPerDay: 5, allowDeploy: true, maxDeploys: 2, isActive: true });
        for (const hidden of ['tokenHash', 'allowedActions', 'allowedContracts', 'jobsUsedToday', 'budgetWindow', 'valueUsedToday', 'deploysUsed']) {
            expect(own, hidden).not.toHaveProperty(hidden);
        }
        const admin = await cds.connect.to('NightgateAdminService');
        const ops = new (cds as any).User({ id: 'ops', roles: ['admin'] });
        const [full]: any[] = await cds.tx({ user: ops } as any, () => admin.run(cds.ql.SELECT.from('NightgateAdminService.AgentGrants')));
        expect(full).toMatchObject({ allowedActions: '["sponsorUnbound"]', jobsUsedToday: 3, budgetWindow: '2026-11-22', deploysUsed: 1 });
        expect(full).not.toHaveProperty('tokenHash');
        await db.run(cds.ql.DELETE.from(GRANTS_TABLE));
    });

    // Documents / GranteeIdentities are owner-scoped too: storageRef
    // and userId->granteeId bindings are nobody else's business. Legacy rows
    // without a userId stay admin-only.
    it('Documents READ is limited to the requesting user\'s rows (legacy null-userId rows admin-only)', async () => {
        const DOCUMENTS = 'midnight.Documents';
        await db.run(cds.ql.DELETE.from(DOCUMENTS));
        const mk = (userId: string | null, tag: string) => db.run(cds.ql.INSERT.into(DOCUMENTS).entries({
            ID: cds.utils.uuid(), payloadHash: tag.repeat(32), storageRef: `s3://internal/${tag}`, userId
        }));
        await mk('alice', 'aa');
        await mk('bob', 'bb');
        await mk(null, 'cc');

        const aliceRows = await readAs('alice', [], 'Documents');
        expect(aliceRows.map((r: any) => r.payloadHash)).toEqual(['aa'.repeat(32)]);
        const adminRows = await readAs('ops', ['admin'], 'Documents');
        expect(adminRows).toHaveLength(3);
        await db.run(cds.ql.DELETE.from(DOCUMENTS));
    });

    const PREDICATES = 'midnight.PredicateAttestations';
    const GRANTS = 'midnight.DisclosureGrants';
    const proofRow = (ID: string, userId: string | null, sessionId: string | null, at: string) => ({
        ID, payloadHash: 'ab'.repeat(32), contractAddress: 'cd'.repeat(32), predicate: 'greaterOrEqual', op: 1, threshold: 50000,
        userId, sessionId, createdAt: at, modifiedAt: at
    });
    const grantRow = (ID: string, userId: string | null, sessionId: string | null, at: string, grantee = 'ee'.repeat(32)) => ({
        ID, payloadHash: 'ab'.repeat(32), contractAddress: 'cd'.repeat(32), grantee, level: 1, isActive: true,
        userId, sessionId, createdAt: at, modifiedAt: at
    });

    it('PredicateAttestations and DisclosureGrants READ return the caller\'s own rows; rows without an owner are for admins', async () => {
        const at = new Date().toISOString();
        for (const [entity, row] of [[PREDICATES, proofRow], [GRANTS, grantRow]] as const) {
            await db.run(cds.ql.DELETE.from(entity));
            await db.run(cds.ql.INSERT.into(entity).entries([
                row('a0000000-0000-4000-8000-000000000001', 'alice', ALICE_SESSION, at),
                row('a0000000-0000-4000-8000-000000000002', 'bob', BOB_SESSION, at),
                row('a0000000-0000-4000-8000-000000000003', null, null, at)
            ]));
        }
        for (const entity of ['PredicateAttestations', 'DisclosureGrants']) {
            expect((await readAs('alice', [], entity)).map((r: any) => r.ID)).toEqual(['a0000000-0000-4000-8000-000000000001']);
            expect(await readAs('mallory', [], entity)).toEqual([]);
            expect(await readAs('ops', ['admin'], entity)).toHaveLength(3);
        }
        await db.run(cds.ql.DELETE.from(PREDICATES));
        await db.run(cds.ql.DELETE.from(GRANTS));
    });

    it('rows without an owner get the user and session of the job that wrote them, and keep their change time', async () => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { backfillRowOwners } = require('../../srv/submission/job-store');
        // The required job store holds its own key ring; without a set key each copy would draw its own random one.
        const keyBefore = process.env.ENCRYPTION_KEY;
        process.env.ENCRYPTION_KEY = '7'.repeat(64);
        onTestFinished(() => { if (keyBefore === undefined) delete process.env.ENCRYPTION_KEY; else process.env.ENCRYPTION_KEY = keyBefore; });
        const old = '2026-01-10T10:00:00.000Z';
        const id = (n: number) => `b0000000-0000-4000-8000-00000000000${n}`;
        await db.run(cds.ql.DELETE.from(PREDICATES));
        await db.run(cds.ql.DELETE.from(GRANTS));
        await db.run(cds.ql.DELETE.from(BACKGROUND_JOBS));
        await db.run(cds.ql.INSERT.into(PREDICATES).entries([
            proofRow(id(1), null, null, old), proofRow(id(2), null, null, old), proofRow(id(3), null, null, old),
            proofRow(id(4), 'carol', null, old), proofRow(id(5), null, null, old), proofRow(id(8), null, null, old), proofRow(id(9), null, null, old)
        ]));
        await db.run(cds.ql.INSERT.into(GRANTS).entries([
            grantRow(id(6), null, null, old), grantRow(id(7), null, null, old, 'ff'.repeat(32))
        ]));
        const job = (n: number, kind: string, requestedBy: string | null, sessionId: string, request: unknown, at = old) => ({
            ID: `c0000000-0000-4000-8000-00000000000${n}`, kind, status: 'succeeded', requestedBy, sessionId,
            request: typeof request === 'string' ? request : JSON.stringify(request), createdAt: at, modifiedAt: at
        });
        await db.run(cds.ql.INSERT.into(BACKGROUND_JOBS).entries([
            job(1, 'proveFieldPredicate', 'alice', ALICE_SESSION, { predicateAttestationId: id(1) }),
            job(2, 'proveClaims', 'bob', BOB_SESSION, { claims: [{ predicateAttestationId: id(2) }, null, { predicateAttestationId: id(3) }] }),
            job(3, 'proveFieldEquality', 'bob', BOB_SESSION, { predicateAttestationId: id(4) }),
            job(4, 'proveFieldEquality', 'bob', BOB_SESSION, 'not json'),
            job(5, 'proveFieldEquality', null, BOB_SESSION, { predicateAttestationId: id(5) }),
            job(6, 'grantDisclosure', 'alice', ALICE_SESSION, { disclosureGrantId: id(6) }),
            job(7, 'grantDisclosure', 'bob', BOB_SESSION, { disclosureGrantId: id(7) }, '2026-01-11T10:00:00.000Z'),
            // A single proof names its row only in the command, in plain JSON or encrypted.
            { ...job(8, 'proveFieldPredicate', 'alice', ALICE_SESSION, { payloadHash: 'ab' }), commandVersion: 1, commandEncoding: 'json-v1',
                command: JSON.stringify({ op: 'fieldPredicateWorkflow', predicateAttestationId: id(8) }) },
            { ...job(9, 'proveFieldPredicate', 'bob', BOB_SESSION, { payloadHash: 'ab' }), commandVersion: 1, commandEncoding: 'aes-gcm-v1',
                command: encrypt(JSON.stringify({ op: 'fieldPredicateWorkflow', predicateAttestationId: id(9) }), getEncryptionKey(), jobCommandBinding('c0000000-0000-4000-8000-000000000009')) }
        ]));

        expect(await backfillRowOwners(db)).toBe(6);
        const owners = async (entity: string) => Object.fromEntries((await db.run(cds.ql.SELECT.from(entity).columns('ID', 'userId', 'sessionId', 'modifiedAt')))
            .map((r: any) => [r.ID.slice(-1), [r.userId, r.sessionId, r.modifiedAt]]));
        expect(await owners(PREDICATES)).toEqual({
            1: ['alice', ALICE_SESSION, old], 2: ['bob', BOB_SESSION, old], 3: ['bob', BOB_SESSION, old],
            4: ['carol', null, old], 5: [null, null, old], 8: ['alice', ALICE_SESSION, old], 9: ['bob', BOB_SESSION, old]
        });
        // The grant job stored a day after the newest row without an owner cannot have written it.
        expect(await owners(GRANTS)).toEqual({ 6: ['alice', ALICE_SESSION, old], 7: [null, null, old] });
        expect(await backfillRowOwners(db)).toBe(0);

        await db.run(cds.ql.DELETE.from(PREDICATES));
        await db.run(cds.ql.DELETE.from(GRANTS));
        await db.run(cds.ql.DELETE.from(BACKGROUND_JOBS));
    });

    it('GranteeIdentities READ is limited to the requesting user\'s bindings', async () => {
        const GRANTEES = 'midnight.GranteeIdentities';
        await db.run(cds.ql.DELETE.from(GRANTEES));
        const mk = (userId: string, tag: string) => db.run(cds.ql.INSERT.into(GRANTEES).entries({
            ID: cds.utils.uuid(), userId, granteeId: tag.repeat(32), bindingKind: 'wallet'
        }));
        await mk('alice', 'aa');
        await mk('bob', 'bb');

        const aliceRows = await readAs('alice', [], 'GranteeIdentities');
        expect(aliceRows.map((r: any) => r.granteeId)).toEqual(['aa'.repeat(32)]);
        const adminRows = await readAs('ops', ['admin'], 'GranteeIdentities');
        expect(adminRows).toHaveLength(2);
        await db.run(cds.ql.DELETE.from(GRANTEES));
    });
});
