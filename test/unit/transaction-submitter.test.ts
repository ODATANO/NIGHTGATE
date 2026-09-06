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
    type TransactionSubmitterDeps, dustRaceLedgerCode
} from '../../srv/submission/TransactionSubmitter';
import { WorkerSubmitError } from '../../srv/midnight/wallet-worker-protocol';
import type { ContractProvidersConfig, WalletMaterial } from '../../srv/midnight/providers';
import { runInJobExecutionContext, SponsorAttemptBookkeepingPendingError } from '../../srv/submission/job-execution-context';

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

// The bound deploy/call/batch paths rebuild-retry a 1010/170|196 inside the worker call, before any txHash exists.
describe('TransactionSubmitter dust-race rebuild-retry', () => {
    const dustRace = () => {
        const wrapped: any = new Error('Transaction submission error');
        wrapped.cause = new Error('1010: Invalid Transaction: Custom error: 170');
        return wrapped;
    };
    beforeEach(() => { process.env.NIGHTGATE_DUST_RACE_BACKOFF_MS = '0'; });
    afterEach(() => { delete process.env.NIGHTGATE_DUST_RACE_BACKOFF_MS; delete process.env.NIGHTGATE_DUST_RACE_RETRIES; });

    test('deploy: a 1010/170 is rebuilt and resubmitted; the second attempt lands on the SAME submission row', async () => {
        walletDeployContract
            .mockRejectedValueOnce(dustRace())
            .mockResolvedValueOnce({ txHash: '0xsecond', contractAddress: '0xCONTRACT', onChainStatus: 'SucceedEntirely' });
        const { submitter, db } = newSubmitter();
        const result = await submitter.deploy({ contractName: 'counter', registration: REGISTRATION, initialPrivateState: {}, sessionId: 'session-race' });
        expect(result).toMatchObject({ txHash: '0xsecond', status: 'included' });
        expect(walletDeployContract).toHaveBeenCalledTimes(2);
        const rows = db.tables['midnight.PendingSubmissions'];
        expect(rows.length).toBe(1);
        expect(rows[0]).toMatchObject({ txHash: '0xsecond', status: 'included' });
    });

    test('call and batch retry the same way', async () => {
        walletSubmitContractCall
            .mockRejectedValueOnce(dustRace())
            .mockResolvedValueOnce({ txHash: '0xcall', onChainStatus: 'SucceedEntirely' });
        walletSubmitContractCallBatch
            .mockRejectedValueOnce(dustRace())
            .mockResolvedValueOnce({ txHash: '0xbatch', onChainStatus: 'SucceedEntirely', circuits: ['a', 'b'] });
        const { submitter } = newSubmitter();
        const call = await submitter.call({ contractAddress: '0xC', circuit: 'increment', args: [], contractName: 'counter', registration: REGISTRATION, sessionId: 's' });
        expect(call.txHash).toBe('0xcall');
        expect(walletSubmitContractCall).toHaveBeenCalledTimes(2);
        const batch = await submitter.callBatch({ contractAddress: '0xC', calls: [{ circuit: 'a', args: [] }, { circuit: 'b', args: [] }], contractName: 'counter', registration: REGISTRATION, sessionId: 's' } as any);
        expect(batch.txHash).toBe('0xbatch');
        expect(walletSubmitContractCallBatch).toHaveBeenCalledTimes(2);
    });

    test('budget exhausted: fails with the retryable dust-race classification, not a generic 1010', async () => {
        process.env.NIGHTGATE_DUST_RACE_RETRIES = '1';
        walletDeployContract.mockRejectedValue(dustRace());
        const { submitter, db } = newSubmitter();
        await expect(submitter.deploy({ contractName: 'counter', registration: REGISTRATION, initialPrivateState: {}, sessionId: 's' }))
            .rejects.toMatchObject({ classification: { code: '1010/170', retryable: true, transient: 'dust-race' } });
        expect(walletDeployContract).toHaveBeenCalledTimes(2); // 1 + 1 retry
        expect(db.tables['midnight.PendingSubmissions'][0]).toMatchObject({ status: 'failed', errorCode: '1010/170' });
    });

    test('any other failure is NOT retried', async () => {
        walletDeployContract.mockRejectedValue(new Error('1010: Invalid Transaction: Custom error: 188'));
        const { submitter } = newSubmitter();
        await expect(submitter.deploy({ contractName: 'counter', registration: REGISTRATION, initialPrivateState: {}, sessionId: 's' }))
            .rejects.toMatchObject({ classification: { code: '1010/188', retryable: false } });
        expect(walletDeployContract).toHaveBeenCalledTimes(1);
    });
});

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
    const coded = (code: any, extra: Record<string, unknown> = {}, message = 'worker message') =>
        new WorkerSubmitError({ name: 'Error', message, code, retryable: false, ...extra } as any);

    test('a worker-classified failure maps by code, whatever its text says', () => {
        expect(classifySubmissionError(coded('dust-race', { ledgerCode: '1010/196', retryable: true }, 'no digits here'), 'preprod'))
            .toMatchObject({ code: '1010/196', retryable: true, transient: 'dust-race' });
        expect(classifySubmissionError(coded('dust-race', { ledgerCode: 'pool-invalid', retryable: true }), 'preprod'))
            .toMatchObject({ code: 'PoolInvalid', retryable: true, transient: 'dust-race' });
        expect(classifySubmissionError(coded('pre-mempool-reject', { ledgerCode: '1010/188' }), 'preprod')).toMatchObject({ code: '1010/188', retryable: false });
        expect(classifySubmissionError(coded('pre-mempool-reject', { ledgerCode: '1014' }), 'preprod')).toMatchObject({ code: '1014', retryable: false });
        expect(classifySubmissionError(coded('pre-mempool-reject', { ledgerCode: '1016', retryable: true }), 'preprod')).toMatchObject({ code: '1016', retryable: true });
        expect(classifySubmissionError(coded('pre-mempool-reject', { ledgerCode: '1016', retryable: true }), 'mainnet')).toMatchObject({ code: '1016', retryable: false, knownIssueRef: expect.stringContaining('forum') });
        expect(classifySubmissionError(coded('pre-mempool-reject', { ledgerCode: 'intent-rejected' }), 'preprod')).toMatchObject({ code: 'SubmitIntentRejected', retryable: false });
        expect(classifySubmissionError(coded('transport', { retryable: true }), 'preprod')).toMatchObject({ code: 'NetworkOrTimeout', retryable: true });
        // Ambiguous is NOT retried by rebuilding: the identifier may land.
        expect(classifySubmissionError(coded('ambiguous', {}, 'submit watch timed out after 60000ms'), 'preprod')).toMatchObject({ code: 'SubmitAmbiguous', retryable: false });
        expect(classifySubmissionError(coded('landed-not-applied'), 'preprod')).toMatchObject({ code: 'TxFailed', retryable: false });
        expect(classifySubmissionError(coded('policy'), 'preprod')).toMatchObject({ code: 'SponsorPolicyRefused', retryable: false });
        expect(classifySubmissionError(coded('internal'), 'preprod')).toMatchObject({ code: 'UnknownError', retryable: false });
    });

    test('a causality refusal keeps every call\'s apply position on the classification and in the message', () => {
        const calls = [{ name: 'attest', segId: 1158, stages: 'f' }, { name: 'anchorContentRoot', segId: 1159, stages: 'g' }];
        const c = classifySubmissionError(coded('causality', { calls }, "batch violates the ledger's causality constraint. Stages in apply order: attest=1158[f] anchorContentRoot=1159[g]"), 'preprod');
        expect(c).toMatchObject({ code: 'BatchCausalityViolation', retryable: false, calls });
        expect(c.message).toMatch(/attest=1158\[f\] anchorContentRoot=1159\[g\]/);
    });

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

    test('our pre-proving causality abort gets a stable code, not a 1010 reject', () => {
        // Real shape: midnight-js wraps the thrown error, discarding its name,
        // and our explanatory text mentions 1010/188 - which must NOT be read
        // as a node reject, because nothing was ever submitted.
        const wrapped = new Error(
            "Unexpected error submitting scoped transaction 'batch:attest+anchorContentRoot': " +
            "Error: batch [attest+anchorContentRoot] violates the ledger's causality constraint: " +
            "'attest' (segment 48404) carries a FALLIBLE transcript while 'anchorContentRoot' " +
            '(segment 49135) behind it carries a GUARANTEED one. ... the node rejects the ' +
            'transaction as 1010/188. ... Aborted before proving; nothing was submitted.'
        );
        const c = classifySubmissionError(wrapped, 'preprod');
        expect(c).toMatchObject({ code: 'BatchCausalityViolation', retryable: false });
    });

    test('the custom error is found in the nested cause (SDK wrapper shape)', () => {
        const wrapped: any = new Error('Transaction submission error');
        wrapped.cause = new Error('1010: Invalid Transaction: Custom error: 170');
        const c = classifySubmissionError(wrapped, 'preprod');
        // a coded dust race is retryable (rebuild + resubmit) on every submitting path
        expect(c).toMatchObject({ code: '1010/170', retryable: true, transient: 'dust-race' });
        expect(c.message).toMatch(/rebuild and resubmit/);
    });

    test('1010/196 is the same transient dust race; other 1010 codes stay terminal', () => {
        expect(classifySubmissionError(new Error('1010: Invalid Transaction: Custom error: 196'), 'preprod'))
            .toMatchObject({ code: '1010/196', retryable: true, transient: 'dust-race' });
        for (const n of ['117', '138', '182', '188', '192']) {
            const c = classifySubmissionError(new Error(`1010: Invalid Transaction: Custom error: ${n}`), 'preprod');
            expect(c, n).toMatchObject({ code: `1010/${n}`, retryable: false });
            expect(c.transient, n).toBeUndefined();
        }
        expect(dustRaceLedgerCode(new Error('1010: Invalid Transaction: Custom error: 170'))).toBe('1010/170');
        expect(dustRaceLedgerCode(new Error('Priority is too low: (170 vs 196)'))).toBeNull();
        expect(dustRaceLedgerCode(new Error('harmless'))).toBeNull();
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

describe('bound channel submit-intent bookkeeping', () => {
    const dustRace = () => {
        const wrapped: any = new Error('Transaction submission error');
        wrapped.cause = new Error('1010: Invalid Transaction: Custom error: 170');
        return wrapped;
    };
    /** Run `fn` as a background job would: the boundary hooks record into `calls`. */
    function inJob<T>(calls: any[], fn: () => Promise<T>, opts: { rejectFails?: boolean } = {}): Promise<T> {
        return runInJobExecutionContext({
            reportExternalExecution: async (h) => { calls.push(['externalExecution', h]); },
            reportSubmitted: async (h) => { calls.push(['submitted', h]); },
            markBroadcastOn: async (_runner, h) => { calls.push(['broadcastOn', h]); },
            markSubmissionRejectedOn: async (_runner, h) => {
                if (opts.rejectFails) throw new Error('Lease lost (or hash already moved)');
                calls.push(['rejectedOn', h]);
            }
        }, fn);
    }
    beforeEach(() => { process.env.NIGHTGATE_DUST_RACE_BACKOFF_MS = '0'; });
    afterEach(() => { delete process.env.NIGHTGATE_DUST_RACE_BACKOFF_MS; delete process.env.NIGHTGATE_DUST_RACE_RETRIES; });

    test('the announced identifier lands on the attempt row and crosses the job boundary BEFORE the worker sends', async () => {
        const order: string[] = [];
        walletDeployContract.mockImplementationOnce(async (_args: unknown, onSubmitIntent: any) => {
            await onSubmitIntent('0xannounced', { circuits: ['<deploy>'], note: 'deploy' });
            order.push('sent');
            return { txHash: '0xannounced', contractAddress: '0xCONTRACT', onChainStatus: 'SucceedEntirely' };
        });
        const { submitter, db } = newSubmitter();
        const calls: any[] = [];
        const result = await inJob(calls, () => submitter.deploy({ contractName: 'counter', registration: REGISTRATION, initialPrivateState: {}, sessionId: 's' }));
        const rows = db.tables['midnight.PendingSubmissions'];
        expect(rows.length).toBe(1);
        expect(result.submissionId).toBe(rows[0].ID);
        expect(rows[0]).toMatchObject({ txHash: '0xannounced', status: 'included' });
        expect(JSON.parse(rows[0].submitIntentData)).toMatchObject({ channel: 'bound', circuits: ['<deploy>'], note: 'deploy' });
        const broadcast = calls.find(c => c[0] === 'broadcastOn');
        expect(broadcast[1]).toEqual({ submissionId: rows[0].ID, txHash: '0xannounced', firstBoundary: false });
        // boundary crossed before the send, submitted (same hash) after
        expect(calls.map(c => c[0])).toEqual(['externalExecution', 'broadcastOn', 'submitted']);
        expect(order).toEqual(['sent']);
    });

    test('a dust-race rebuild after an announced hash closes that attempt REJECTED, takes the hash off the job, and the rebuild opens a new row', async () => {
        walletDeployContract
            .mockImplementationOnce(async (_a: unknown, onSubmitIntent: any) => { await onSubmitIntent('0xfirst', { note: 'deploy' }); throw dustRace(); })
            .mockImplementationOnce(async (_a: unknown, onSubmitIntent: any) => { await onSubmitIntent('0xsecond', { note: 'deploy' }); return { txHash: '0xsecond', contractAddress: '0xC', onChainStatus: 'SucceedEntirely' }; });
        const { submitter, db } = newSubmitter();
        const calls: any[] = [];
        const result = await inJob(calls, () => submitter.deploy({ contractName: 'counter', registration: REGISTRATION, initialPrivateState: {}, sessionId: 's' }));
        const rows = db.tables['midnight.PendingSubmissions'];
        expect(rows.length).toBe(2);
        expect(rows[0]).toMatchObject({ txHash: '0xfirst', status: 'failed', errorCode: 'REJECTED' });
        expect(rows[1]).toMatchObject({ txHash: '0xsecond', status: 'included', actionType: 'DEPLOY', sessionId: 's' });
        expect(result.submissionId).toBe(rows[1].ID);
        expect(calls.map(c => c[0])).toEqual(['externalExecution', 'broadcastOn', 'rejectedOn', 'broadcastOn', 'submitted']);
        expect(calls[2][1]).toEqual({ submissionId: rows[0].ID, txHash: '0xfirst' });
        expect(calls[3][1]).toEqual({ submissionId: rows[1].ID, txHash: '0xsecond', firstBoundary: false });
    });

    test('a final pre-inclusion reject of an announced attempt fails plainly: row REJECTED, hash off the job', async () => {
        walletSubmitContractCall.mockImplementationOnce(async (_a: unknown, onSubmitIntent: any) => {
            await onSubmitIntent('0xlast', { contractAddress: '0xC', circuits: ['increment'] });
            throw new Error('1010: Invalid Transaction: Custom error: 188');
        });
        const { submitter, db } = newSubmitter();
        const calls: any[] = [];
        const err = await inJob(calls, () => submitter.call({ contractAddress: '0xC', circuit: 'increment', args: [], contractName: 'counter', registration: REGISTRATION, sessionId: 's' })).catch(e => e);
        expect(err).toBeInstanceOf(SubmissionError);
        const rows = db.tables['midnight.PendingSubmissions'];
        expect(rows[0]).toMatchObject({ txHash: '0xlast', status: 'failed', errorCode: 'REJECTED' });
        expect(err.submissionId).toBe(rows[0].ID);
        expect(calls.map(c => c[0])).toEqual(['externalExecution', 'broadcastOn', 'rejectedOn']);
    });

    test('an ambiguous failure after the announcement keeps the hash on the job (reconciliation, not a plain failure)', async () => {
        walletSubmitContractCallBatch.mockImplementationOnce(async (_a: unknown, onSubmitIntent: any) => {
            await onSubmitIntent('0xmaybe', { contractAddress: '0xC', circuits: ['a', 'b'] });
            throw new Error('submit watch timed out after 240000ms without a Finalized status');
        });
        const { submitter, db } = newSubmitter();
        const calls: any[] = [];
        await expect(inJob(calls, () => submitter.callBatch({ contractAddress: '0xC', calls: [{ circuit: 'a', args: [] }, { circuit: 'b', args: [] }], contractName: 'counter', registration: REGISTRATION, sessionId: 's' } as any)))
            .rejects.toBeInstanceOf(SubmissionError);
        // the row stays pending (reconciliation can still finalize it), the reason is recorded
        expect(db.tables['midnight.PendingSubmissions'][0]).toMatchObject({ txHash: '0xmaybe', status: 'pending', errorCode: expect.any(String) });
        expect(db.tables['midnight.PendingSubmissions'][0].errorMessage).toMatch(/outcome unknown after broadcast/);
        expect(calls.map(c => c[0])).toEqual(['externalExecution', 'broadcastOn']); // no rejectedOn: the hash may land
    });

    test('bookkeeping that cannot commit parks the job instead of rebuilding on an open attempt', async () => {
        walletDeployContract.mockImplementationOnce(async (_a: unknown, onSubmitIntent: any) => { await onSubmitIntent('0xfirst', { note: 'deploy' }); throw dustRace(); });
        const { submitter } = newSubmitter();
        const calls: any[] = [];
        const err = await inJob(calls, () => submitter.deploy({ contractName: 'counter', registration: REGISTRATION, initialPrivateState: {}, sessionId: 's' }), { rejectFails: true }).catch(e => e);
        expect(err).toBeInstanceOf(SponsorAttemptBookkeepingPendingError);
        expect(err.details).toMatchObject({ txHash: '0xfirst', refund: 0 });
        expect(walletDeployContract).toHaveBeenCalledTimes(1); // no rebuild
    });

    test('outside a background job the hook still records the identifier on the row (boundary hooks are no-ops)', async () => {
        walletDeployContract.mockImplementationOnce(async (_a: unknown, onSubmitIntent: any) => {
            await onSubmitIntent('0xplain', { note: 'deploy' });
            return { txHash: '0xplain', contractAddress: '0xC', onChainStatus: 'SucceedEntirely' };
        });
        const { submitter, db } = newSubmitter();
        await submitter.deploy({ contractName: 'counter', registration: REGISTRATION, initialPrivateState: {}, sessionId: 's' });
        expect(db.tables['midnight.PendingSubmissions'][0]).toMatchObject({ txHash: '0xplain', status: 'included' });
    });
});
