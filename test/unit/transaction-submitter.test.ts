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
const walletSubmitContractCallBatch = vi.hoisted(() => (vi.fn()));
const registerPrivateStateProvider   = vi.hoisted(() => (vi.fn()));
const unregisterPrivateStateProvider = vi.hoisted(() => (vi.fn()));

vi.mock('../../srv/midnight/wallet-worker-client', () => ({
    walletDeployContract:           (...args: unknown[]) => walletDeployContract(...args),
    walletSubmitContractCall:       (...args: unknown[]) => walletSubmitContractCall(...args),
    walletSubmitContractCallBatch:  (...args: unknown[]) => walletSubmitContractCallBatch(...args),
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
    walletSubmitContractCallBatch.mockReset();
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
        // UUID; that one is preserved on the PendingSubmissions row only.
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
        // "invalid transaction" is a Substrate 1010 VALIDITY reject; the
        // literal 1014 in the message loses against that (see classify).
        expect(row.errorCode).toBe('1010');
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

describe('TransactionSubmitter.callBatch', () => {
    const CALLS = [
        { circuit: 'attest', args: ['0xPH', '0xMH'] },
        { circuit: 'bindPassport', args: ['0xID', '0xPH'] },
        { circuit: 'anchorContentRoot', args: ['0xPH', '0xROOT'] }
    ];

    test('one pending row for the whole batch; ONE worker RPC; result carries circuits', async () => {
        walletSubmitContractCallBatch.mockResolvedValueOnce({
            txHash: '0xbatch', onChainStatus: 'SucceedEntirely',
            circuits: ['attest', 'bindPassport', 'anchorContentRoot']
        });
        const { submitter, db } = newSubmitter();

        const result = await submitter.callBatch({
            contractAddress: '0xCONTRACT',
            calls: CALLS,
            contractName: 'attestation-vault',
            registration: REGISTRATION,
            sessionId: 'session-1'
        });

        expect(result).toMatchObject({
            txHash: '0xbatch', contractAddress: '0xCONTRACT', status: 'included',
            circuits: ['attest', 'bindPassport', 'anchorContentRoot']
        });
        const rows = db.tables['midnight.PendingSubmissions'];
        expect(rows).toHaveLength(1); // one row for the batch, not one per call
        expect(rows[0]).toMatchObject({
            actionType: 'CALL',
            circuitName: 'attest+bindPassport+anchorContentRoot',
            txHash: '0xbatch',
            status: 'included'
        });
        expect(walletSubmitContractCallBatch).toHaveBeenCalledTimes(1);
        expect(walletSubmitContractCall).not.toHaveBeenCalled();
        const sentArgs = walletSubmitContractCallBatch.mock.calls[0][0];
        expect(sentArgs).toMatchObject({
            sessionId: wallet.accountId,
            contractAddress: '0xCONTRACT',
            calls: CALLS,
            contractName: 'attestation-vault',
            registration: REGISTRATION
        });
    });

    test('worker error marks the single batch row failed (one row, no partial rows)', async () => {
        walletSubmitContractCallBatch.mockRejectedValueOnce(
            new Error("Circuit 'nope' not found on contract at 0xCONTRACT")
        );
        const { submitter, db } = newSubmitter();

        await expect(submitter.callBatch({
            contractAddress: '0xCONTRACT',
            calls: [{ circuit: 'nope', args: [] }],
            contractName: 'attestation-vault',
            registration: REGISTRATION,
            sessionId: 'session-1'
        })).rejects.toBeInstanceOf(SubmissionError);
        expect(db.tables['midnight.PendingSubmissions']).toHaveLength(1);
        expect(db.tables['midnight.PendingSubmissions'][0].status).toBe('failed');
    });

    test('missing txHash from the worker is a MalformedResult failure', async () => {
        walletSubmitContractCallBatch.mockResolvedValueOnce({
            txHash: '', onChainStatus: 'SucceedEntirely', circuits: ['attest']
        });
        const { submitter, db } = newSubmitter();

        await expect(submitter.callBatch({
            contractAddress: '0xCONTRACT',
            calls: [{ circuit: 'attest', args: [] }],
            contractName: 'attestation-vault',
            registration: REGISTRATION,
            sessionId: 'session-1'
        })).rejects.toBeInstanceOf(SubmissionError);
        expect(db.tables['midnight.PendingSubmissions'][0]).toMatchObject({
            status: 'failed', errorCode: 'MalformedResult'
        });
    });

    test('non-SucceedEntirely on-chain status fails the batch row', async () => {
        walletSubmitContractCallBatch.mockResolvedValueOnce({
            txHash: '0xdead', onChainStatus: 'FailEntirely', circuits: ['attest']
        });
        const { submitter, db } = newSubmitter();

        await expect(submitter.callBatch({
            contractAddress: '0xCONTRACT',
            calls: [{ circuit: 'attest', args: [] }],
            contractName: 'attestation-vault',
            registration: REGISTRATION,
            sessionId: 'session-1'
        })).rejects.toBeInstanceOf(SubmissionError);
        expect(db.tables['midnight.PendingSubmissions'][0]).toMatchObject({
            status: 'failed', txHash: '0xdead', errorCode: 'OnChainStatus:FailEntirely'
        });
    });

    test('circuitName is truncated to the 100-char column', async () => {
        walletSubmitContractCallBatch.mockResolvedValueOnce({
            txHash: '0xlong', onChainStatus: 'SucceedEntirely', circuits: []
        });
        const { submitter, db } = newSubmitter();
        const longCalls = Array.from({ length: 8 }, (_, i) => ({ circuit: `veryLongCircuitName_${i}_${'x'.repeat(20)}`, args: [] }));

        await submitter.callBatch({
            contractAddress: '0xCONTRACT',
            calls: longCalls,
            contractName: 'attestation-vault',
            registration: REGISTRATION,
            sessionId: 'session-1'
        });
        expect(db.tables['midnight.PendingSubmissions'][0].circuitName.length).toBeLessThanOrEqual(100);
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
    test('"invalid transaction" is a 1010 validity reject (permanent), even when 1014 appears in the text', () => {
        const c = classifySubmissionError(new Error('Substrate error 1014: invalid transaction'), 'preprod');
        expect(c).toMatchObject({ code: '1010', retryable: false });
    });

    test('1010 with a ledger custom error carries it in the code (rebind repro shape)', () => {
        const c = classifySubmissionError(
            new Error('1010: Invalid Transaction: Custom error: 188'), 'preprod');
        expect(c).toMatchObject({ code: '1010/188', retryable: false });
        expect(c.message).toMatch(/ledger error 188/);
    });

    test('the custom error is found in the nested cause (SDK wrapper shape)', () => {
        const wrapped: any = new Error('Transaction submission error');
        wrapped.cause = new Error('1010: Invalid Transaction: Custom error: 170');
        const c = classifySubmissionError(wrapped, 'preprod');
        expect(c).toMatchObject({ code: '1010/170', retryable: false });
    });

    test('a stack frame like proof-provider.js:1010:27 is not read as a Substrate code', () => {
        const err = new Error('totally harmless failure');
        err.stack = 'Error: totally harmless failure\n    at prove (C:/app/proof-provider.js:1010:27)\n    at run (C:/app/worker.js:1014:5)';
        const c = classifySubmissionError(err, 'preprod');
        expect(c.code).not.toBe('1010');
        expect(c.code).not.toBe('1014');
    });

    test('a SubmissionError keeps its original classification on re-classification (background-job path)', () => {
        const wrapped: any = new Error('Transaction submission error');
        wrapped.cause = new Error('1010: Invalid Transaction: Custom error: 188');
        const first = classifySubmissionError(wrapped, 'preprod');
        expect(first.code).toBe('1010/188');
        // The submitter wraps the classification in a SubmissionError; the
        // background job classifies THAT. The wrapper text only says "ledger
        // error 188", so re-deriving would degrade the code to plain 1010.
        const rethrown = new SubmissionError('sub-1', first, wrapped);
        expect(classifySubmissionError(rethrown, 'preprod')).toEqual(first);
    });

    test('a throwing [util.inspect.custom] never breaks classification', () => {
        const err: any = new Error('1010: Invalid Transaction: Custom error: 188');
        err[Symbol.for('nodejs.util.inspect.custom')] = () => { throw new Error('inspector boom'); };
        const c = classifySubmissionError(err, 'preprod');
        expect(c).toMatchObject({ code: '1010/188', retryable: false });
    });

    test('a genuine 1014 priority reject keeps its own code (priority values must not be misread as 1010)', () => {
        const c = classifySubmissionError(new Error('1014: Priority is too low: (1010 vs 1010)'), 'preprod');
        expect(c).toMatchObject({ code: '1014', retryable: false });
    });

    test('1016 on preprod is retryable', () => {
        const c = classifySubmissionError(new Error('1016 Immediately Dropped'), 'preprod');
        expect(c).toMatchObject({ code: '1016', retryable: true });
    });

    test('1016 buried in a nested cause is still classified (SDK wrapper shape)', () => {
        const wrapped: any = new Error('Transaction submission error');
        wrapped.cause = new Error('1016: Immediately Dropped');
        expect(classifySubmissionError(wrapped, 'preprod')).toMatchObject({ code: '1016', retryable: true });
        const onMainnet = classifySubmissionError(wrapped, 'mainnet');
        expect(onMainnet).toMatchObject({ code: '1016', retryable: false });
        expect(onMainnet.knownIssueRef).toMatch(/forum\.midnight\.network/);
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
