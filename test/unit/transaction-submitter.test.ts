/**
 * Tests for srv/submission/TransactionSubmitter (Phase 2b).
 *
 * Post-Phase-2b, TransactionSubmitter is a thin orchestrator around two
 * worker-thread RPCs (`walletDeployContract`, `walletSubmitContractCall`).
 * The SDK no longer runs on the main thread, so the old `deployContractImpl`
 * / `findDeployedContractImpl` seams are gone. Tests mock the worker-client
 * module exactly the way `dust-registration.test.ts` does.
 *
 * Uses the same in-memory fake DB pattern as before so PendingSubmissions
 * row transitions are exercised end-to-end.
 */

const walletDeployContract     = vi.hoisted(() => (vi.fn()));
const walletSubmitContractCall = vi.hoisted(() => (vi.fn()));
const registerPrivateStateProvider   = vi.hoisted(() => (vi.fn()));
const unregisterPrivateStateProvider = vi.hoisted(() => (vi.fn()));

vi.mock('../../srv/midnight/wallet-worker-client', () => ({
    walletDeployContract:           (...args: unknown[]) => walletDeployContract(...args),
    walletSubmitContractCall:       (...args: unknown[]) => walletSubmitContractCall(...args),
    registerPrivateStateProvider:   (...args: unknown[]) => registerPrivateStateProvider(...args),
    unregisterPrivateStateProvider: (...args: unknown[]) => unregisterPrivateStateProvider(...args)
}));

import {
    TransactionSubmitter,
    SubmissionError,
    classifySubmissionError,
    reconcilePendingSubmission,
    type TransactionSubmitterDeps
} from '../../srv/submission/TransactionSubmitter';
import type { ContractProvidersConfig, WalletMaterial } from '../../srv/midnight/providers';

// ---- In-memory fake DB ----------------------------------------------------

interface Row { [k: string]: any }
function makeFakeDb() {
    const tables: Record<string, Row[]> = { 'midnight.PendingSubmissions': [] };
    return {
        tables,
        run: vi.fn(async (q: any) => {
            const cqn = q.cqn || q;
            if (cqn.SELECT) {
                const entity = cqn.SELECT.from.ref?.[0] || cqn.SELECT.from;
                const rows = tables[entity] || [];
                const where = whereFromCqn(cqn.SELECT.where);
                const filtered = where ? rows.filter((r: Row) => matchRow(r, where)) : rows;
                return cqn.SELECT.one ? (filtered[0] ?? null) : filtered;
            }
            if (cqn.INSERT) {
                const entity = cqn.INSERT.into.ref?.[0] || cqn.INSERT.into;
                const entries = Array.isArray(cqn.INSERT.entries) ? cqn.INSERT.entries : [cqn.INSERT.entries];
                (tables[entity] ??= []).push(...entries);
                return entries.length;
            }
            if (cqn.UPDATE) {
                const entity = cqn.UPDATE.entity.ref?.[0] || cqn.UPDATE.entity;
                const rows = tables[entity] || [];
                const where = whereFromCqn(cqn.UPDATE.where);
                let count = 0;
                for (const r of rows) {
                    if (!where || matchRow(r, where)) { Object.assign(r, cqn.UPDATE.data); count++; }
                }
                return count;
            }
            if (cqn.DELETE) {
                const entity = cqn.DELETE.from.ref?.[0] || cqn.DELETE.from;
                const where = whereFromCqn(cqn.DELETE.where);
                const before = tables[entity]?.length ?? 0;
                tables[entity] = (tables[entity] || []).filter((r: Row) => where ? !matchRow(r, where) : false);
                return before - tables[entity].length;
            }
            throw new Error(`unsupported query: ${JSON.stringify(cqn)}`);
        })
    };
}

function matchRow(row: Row, where: Row): boolean {
    return Object.keys(where).every(k => {
        const expected = where[k];
        if (expected && typeof expected === 'object' && 'in' in expected) {
            return (expected.in as any[]).includes(row[k]);
        }
        return row[k] === expected;
    });
}

function whereFromCqn(where: any): Row | null {
    if (!where) return null;
    if (Array.isArray(where)) {
        const out: Row = {};
        for (let i = 0; i < where.length; i++) {
            const t = where[i];
            if (t?.ref && where[i + 1] === '=' && where[i + 2]?.val !== undefined) {
                out[t.ref[0]] = where[i + 2].val;
            } else if (t?.ref && where[i + 1] === 'in' && Array.isArray(where[i + 2]?.list)) {
                out[t.ref[0]] = { in: where[i + 2].list.map((x: any) => x.val) };
            }
        }
        return out;
    }
    return where;
}

// ---- Common deps ----------------------------------------------------------

const cfg: ContractProvidersConfig = {
    indexerHttpUrl: 'https://indexer.preprod.midnight.network/api/v4/graphql',
    indexerWsUrl:   'wss://indexer.preprod.midnight.network/api/v4/graphql/ws',
    proofServerUrl: 'http://localhost:6300',
    zkConfigPath:   '/tmp/managed/test'
};

const wallet: WalletMaterial = vi.hoisted(() => ({
    accountId: 'addr_test1q...wallet',
    privateStoragePasswordProvider: () => 'a-test-passphrase-of-sufficient-length',
    walletAndMidnightProvider: { stub: true },
    privateStateBackend: 'cap-db'
}));

const REGISTRATION = {
    artifactPath:   '/tmp/managed/test/contract/index.js',
    privateStateId: 'demo-state',
    zkConfigPath:   '/tmp/managed/test'
};

function newSubmitter(opts: Partial<TransactionSubmitterDeps> = {}) {
    const db = makeFakeDb();
    const submitter = new TransactionSubmitter({
        contractProvidersConfig: cfg,
        walletMaterial: wallet,
        db,
        network: 'preprod',
        ...opts
    });
    return { submitter, db };
}

beforeEach(() => {
    walletDeployContract.mockReset();
    walletSubmitContractCall.mockReset();
    registerPrivateStateProvider.mockReset();
    unregisterPrivateStateProvider.mockReset();
});

// ---- Tests ----------------------------------------------------------------

describe('TransactionSubmitter.deploy', () => {
    test('inserts pending row, then transitions to included on success', async () => {
        walletDeployContract.mockResolvedValueOnce({
            txHash:          '0xdeadbeef',
            contractAddress: '0xCONTRACT',
            onChainStatus:   'SucceedEntirely'
        });
        const { submitter, db } = newSubmitter();

        const result = await submitter.deploy({
            contractName: 'counter',
            registration: REGISTRATION,
            initialPrivateState: { value: 0 },
            sessionId: 'session-1'
        });

        expect(result).toMatchObject({
            txHash: '0xdeadbeef',
            contractAddress: '0xCONTRACT',
            status: 'included'
        });
        const rows = db.tables['midnight.PendingSubmissions'];
        expect(rows.length).toBe(1);
        expect(rows[0]).toMatchObject({
            actionType: 'DEPLOY',
            txHash: '0xdeadbeef',
            contractAddress: '0xCONTRACT',
            status: 'included',
            sessionId: 'session-1'
        });

        // Worker was invoked exactly once with the right shape.
        // sessionId on the RPC = walletMaterial.accountId (deterministic key
        // the worker uses to look up the facade), NOT the OData user-session
        // UUID — that one is preserved on the PendingSubmissions row only.
        expect(walletDeployContract).toHaveBeenCalledTimes(1);
        const sentArgs = walletDeployContract.mock.calls[0][0];
        expect(sentArgs).toMatchObject({
            sessionId: wallet.accountId,
            contractName: 'counter',
            registration: REGISTRATION,
            indexerHttpUrl: cfg.indexerHttpUrl,
            indexerWsUrl:   cfg.indexerWsUrl,
            proofServerUrl: cfg.proofServerUrl,
            networkId: 'preprod',
            initialPrivateState: { value: 0 }
        });
        expect(typeof sentArgs.proxyId).toBe('string');

        // PS proxy was registered before the worker call and unregistered after.
        expect(registerPrivateStateProvider).toHaveBeenCalledTimes(1);
        expect(unregisterPrivateStateProvider).toHaveBeenCalledTimes(1);
        expect(registerPrivateStateProvider.mock.calls[0][0]).toBe(sentArgs.proxyId);
        expect(unregisterPrivateStateProvider.mock.calls[0][0]).toBe(sentArgs.proxyId);
    });

    test('marks row failed and throws SubmissionError on worker error', async () => {
        walletDeployContract.mockRejectedValueOnce(new Error('Substrate error 1014: invalid transaction'));
        const { submitter, db } = newSubmitter();

        await expect(submitter.deploy({
            contractName: 'counter',
            registration: REGISTRATION,
            initialPrivateState: {},
            sessionId: 'session-1'
        })).rejects.toBeInstanceOf(SubmissionError);

        const row = db.tables['midnight.PendingSubmissions'][0];
        expect(row.status).toBe('failed');
        expect(row.errorCode).toBe('1014');
        expect(row.errorMessage).toMatch(/Invalid transaction/);
        // Even on failure the proxy is released.
        expect(unregisterPrivateStateProvider).toHaveBeenCalledTimes(1);
    });

    test('marks row failed when on-chain status is not SucceedEntirely', async () => {
        walletDeployContract.mockResolvedValueOnce({
            txHash:          '0x1',
            contractAddress: '0xC',
            onChainStatus:   'FailEntirely'
        });
        const { submitter, db } = newSubmitter();

        await expect(submitter.deploy({
            contractName: 'counter',
            registration: REGISTRATION,
            initialPrivateState: {},
            sessionId: 'session-1'
        })).rejects.toBeInstanceOf(SubmissionError);

        const row = db.tables['midnight.PendingSubmissions'][0];
        expect(row.status).toBe('failed');
        expect(row.errorCode).toBe('OnChainStatus:FailEntirely');
    });

    test('rejects malformed worker result (missing txHash)', async () => {
        walletDeployContract.mockResolvedValueOnce({
            txHash: '',
            contractAddress: '0xC',
            onChainStatus: 'SucceedEntirely'
        });
        const { submitter, db } = newSubmitter();

        await expect(submitter.deploy({
            contractName: 'counter',
            registration: REGISTRATION,
            initialPrivateState: {},
            sessionId: 'session-1'
        })).rejects.toBeInstanceOf(SubmissionError);
        expect(db.tables['midnight.PendingSubmissions'][0].errorCode).toBe('MalformedResult');
    });

    test('preserves err.name across the worker boundary for classification', async () => {
        const err = new Error('on-chain reverted');
        err.name = 'TxFailedError';
        walletDeployContract.mockRejectedValueOnce(err);

        const { submitter, db } = newSubmitter();
        await expect(submitter.deploy({
            contractName: 'counter',
            registration: REGISTRATION,
            initialPrivateState: {},
            sessionId: 'session-1'
        })).rejects.toBeInstanceOf(SubmissionError);

        // The TxFailedError name should drive classifySubmissionError, NOT
        // the substring match. Row carries the 'TxFailed' code.
        expect(db.tables['midnight.PendingSubmissions'][0].errorCode).toBe('TxFailed');
    });
});

describe('TransactionSubmitter.call', () => {
    test('inserts pending row, calls worker, transitions to included', async () => {
        walletSubmitContractCall.mockResolvedValueOnce({
            txHash:        '0xcafe',
            onChainStatus: 'SucceedEntirely'
        });
        const { submitter, db } = newSubmitter();

        const result = await submitter.call({
            contractAddress: '0xCONTRACT',
            circuit: 'increment',
            args: [],
            contractName: 'counter',
            registration: REGISTRATION,
            sessionId: 'session-1'
        });

        expect(result).toMatchObject({ txHash: '0xcafe', contractAddress: '0xCONTRACT', status: 'included' });
        const rows = db.tables['midnight.PendingSubmissions'];
        expect(rows[0]).toMatchObject({ actionType: 'CALL', circuitName: 'increment', txHash: '0xcafe' });
        expect(walletSubmitContractCall).toHaveBeenCalledTimes(1);
        const sentArgs = walletSubmitContractCall.mock.calls[0][0];
        expect(sentArgs).toMatchObject({
            sessionId: wallet.accountId,
            contractAddress: '0xCONTRACT',
            circuit: 'increment',
            args: [],
            contractName: 'counter',
            registration: REGISTRATION
        });
    });

    test('propagates worker errors and marks row failed', async () => {
        walletSubmitContractCall.mockRejectedValueOnce(
            new Error("Circuit 'noSuchCircuit' not found on contract at 0xCONTRACT")
        );
        const { submitter, db } = newSubmitter();

        await expect(submitter.call({
            contractAddress: '0xCONTRACT',
            circuit: 'noSuchCircuit',
            args: [],
            contractName: 'counter',
            registration: REGISTRATION,
            sessionId: 'session-1'
        })).rejects.toBeInstanceOf(SubmissionError);
        expect(db.tables['midnight.PendingSubmissions'][0].status).toBe('failed');
    });
});

describe('TransactionSubmitter private-state backend guard', () => {
    test('refuses the legacy LevelDB backend', async () => {
        const db = makeFakeDb();
        const submitter = new TransactionSubmitter({
            contractProvidersConfig: cfg,
            walletMaterial: { ...wallet, privateStateBackend: 'level' },
            db,
            network: 'preprod'
        });

        await expect(submitter.deploy({
            contractName: 'counter',
            registration: REGISTRATION,
            initialPrivateState: {},
            sessionId: 'session-1'
        })).rejects.toBeInstanceOf(SubmissionError);

        // Row was inserted before the guard tripped, then marked failed.
        const row = db.tables['midnight.PendingSubmissions'][0];
        expect(row.status).toBe('failed');
        expect(row.errorMessage).toMatch(/privateStateBackend='level' is not supported/);
        // No worker call.
        expect(walletDeployContract).not.toHaveBeenCalled();
    });
});

describe('classifySubmissionError', () => {
    test('1014 is permanent', () => {
        const c = classifySubmissionError(new Error('Substrate error 1014: invalid transaction'), 'preprod');
        expect(c).toMatchObject({ code: '1014', retryable: false });
    });

    test('1016 on preprod is retryable', () => {
        const c = classifySubmissionError(new Error('1016 Immediately Dropped'), 'preprod');
        expect(c).toMatchObject({ code: '1016', retryable: true });
    });

    test('1016 on mainnet is fail-fast with known-issue ref (forum 1190)', () => {
        const c = classifySubmissionError(new Error('1016 Immediately Dropped'), 'mainnet');
        expect(c.code).toBe('1016');
        expect(c.retryable).toBe(false);
        expect(c.knownIssueRef).toMatch(/forum\.midnight\.network/);
        expect(c.knownIssueRef).toMatch(/1190/);
    });

    test('network/timeout errors are retryable', () => {
        for (const m of ['ECONNREFUSED', 'ETIMEDOUT', 'socket hang up', 'request timeout']) {
            expect(classifySubmissionError(new Error(m), 'preprod').retryable).toBe(true);
        }
    });

    test('SDK TxFailedError is not retryable', () => {
        const err = new Error('Tx failed'); err.name = 'TxFailedError';
        expect(classifySubmissionError(err, 'preprod')).toMatchObject({ code: 'TxFailed', retryable: false });
    });

    test('unknown errors default to non-retryable', () => {
        const err = new Error('totally novel error');
        const c = classifySubmissionError(err, 'preprod');
        expect(c.retryable).toBe(false);
    });
});

describe('reconcilePendingSubmission', () => {
    test('updates pending row to finalized with snapshot', async () => {
        const db = makeFakeDb();
        db.tables['midnight.PendingSubmissions'].push({
            ID: 'sub-1', txHash: '0xMATCH', status: 'included',
            actionType: 'DEPLOY', submittedAt: new Date().toISOString()
        });
        await reconcilePendingSubmission(db, '0xMATCH', { blockHeight: 42 });
        const row = db.tables['midnight.PendingSubmissions'][0];
        expect(row.status).toBe('finalized');
        expect(row.finalizedAt).toBeDefined();
        expect(JSON.parse(row.finalizedTxData)).toEqual({ blockHeight: 42 });
    });

    test('also updates pending (no SDK return) → finalized', async () => {
        const db = makeFakeDb();
        db.tables['midnight.PendingSubmissions'].push({
            ID: 'sub-2', txHash: '0xMATCH', status: 'pending',
            actionType: 'CALL', submittedAt: new Date().toISOString()
        });
        await reconcilePendingSubmission(db, '0xMATCH', { blockHeight: 100 });
        expect(db.tables['midnight.PendingSubmissions'][0].status).toBe('finalized');
    });

    test('is a no-op when no row matches the txHash', async () => {
        const db = makeFakeDb();
        db.tables['midnight.PendingSubmissions'].push({
            ID: 'sub-3', txHash: '0xOTHER', status: 'included',
            actionType: 'CALL', submittedAt: new Date().toISOString()
        });
        await reconcilePendingSubmission(db, '0xNOMATCH', { blockHeight: 1 });
        expect(db.tables['midnight.PendingSubmissions'][0].status).toBe('included');
    });

    test('does not touch already-finalized rows', async () => {
        const db = makeFakeDb();
        db.tables['midnight.PendingSubmissions'].push({
            ID: 'sub-4', txHash: '0xDONE', status: 'finalized',
            finalizedAt: '2026-01-01T00:00:00Z', actionType: 'CALL', submittedAt: '2026-01-01T00:00:00Z'
        });
        await reconcilePendingSubmission(db, '0xDONE', { blockHeight: 2 });
        // finalizedAt unchanged
        expect(db.tables['midnight.PendingSubmissions'][0].finalizedAt).toBe('2026-01-01T00:00:00Z');
    });

    test('is a no-op on empty txHash', async () => {
        const db = makeFakeDb();
        db.tables['midnight.PendingSubmissions'].push({
            ID: 'sub-5', txHash: null, status: 'pending', actionType: 'CALL', submittedAt: new Date().toISOString()
        });
        await reconcilePendingSubmission(db, '', { blockHeight: 1 });
        expect(db.tables['midnight.PendingSubmissions'][0].status).toBe('pending');
    });
});
