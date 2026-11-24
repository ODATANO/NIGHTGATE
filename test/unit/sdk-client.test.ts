/**
 * The NIGHTGATE client SDK (`src/sdk/client.mjs`): URL/body encoding, auth
 * header selection, job polling. All through an injected fetchFn; no network.
 */

import { describe, test, expect, vi } from 'vitest';

const importClient = () => import('../../src/sdk/client.mjs' as string);

function fakeFetch(responses: Array<{ status?: number; body?: unknown }>) {
    const calls: Array<{ url: string; init: any }> = [];
    const fn = vi.fn(async (url: string, init: any) => {
        calls.push({ url, init });
        const next = responses.length > 1 ? responses.shift()! : responses[0];
        return {
            ok: (next.status ?? 200) < 400,
            status: next.status ?? 200,
            text: async () => JSON.stringify(next.body ?? {})
        };
    });
    return { fn, calls };
}

/** The parameters of a getJobStatus call, as they stand in its URL. */
const pollOf = (call: { url: string }) => decodeURIComponent(call.url).split('/getJobStatus')[1];

describe('connect: encoding', () => {
    test('requires baseUrl', async () => {
        const { connect } = await importClient();
        expect(() => connect({})).toThrow(/baseUrl/);
    });

    test('functions GET with OData literals; undefined/empty params dropped, quotes escaped', async () => {
        const { connect, int64 } = await importClient();
        const { fn, calls } = fakeFetch([{ body: { verified: true } }]);
        const ng = connect({ baseUrl: 'https://ng.example/', fetchFn: fn as any });
        await ng.verifyPredicate({
            contractAddress: "o'hara", payloadHash: 'ab', threshold: int64('9007199254740993'),
            k: 3, network: undefined, fieldKey: ''
        });
        expect(calls[0].url).toBe(
            "https://ng.example/odata/v4/midnight/verifyPredicate(contractAddress='o''hara',payloadHash='ab',threshold=9007199254740993,k=3)"
        );
        expect(calls[0].init.method).toBe('GET');
    });

    test('verifyDisclosure reads verifyDisclosure', async () => {
        const { connect } = await importClient();
        const { fn, calls } = fakeFetch([{ body: { verified: true, granted: true, level: 1 } }]);
        const ng = connect({ baseUrl: 'https://ng.example/', fetchFn: fn as any });
        expect(await ng.verifyDisclosure({ contractAddress: 'c', attesterId: 'a', payloadHash: 'p', grantee: 'g', minLevel: 1 })).toEqual({ verified: true, granted: true, level: 1 });
        expect(calls[0].url).toBe("https://ng.example/odata/v4/midnight/verifyDisclosure(contractAddress='c',attesterId='a',payloadHash='p',grantee='g',minLevel=1)");
    });

    test('actions POST a JSON body; bigint becomes a string; undefined dropped', async () => {
        const { connect } = await importClient();
        const { fn, calls } = fakeFetch([{ body: { jobId: null } }]);
        const ng = connect({ baseUrl: 'https://ng.example', fetchFn: fn as any });
        await ng.callAction('sendToken', { amount: 5n, receiverAddress: 'addr', expiresAt: undefined });
        expect(calls[0].url).toBe('https://ng.example/odata/v4/midnight/sendToken');
        expect(JSON.parse(calls[0].init.body)).toEqual({ amount: '5', receiverAddress: 'addr' });
    });

    test('strips @odata noise and surfaces the OData error body', async () => {
        const { connect, NightgateApiError } = await importClient();
        const { fn } = fakeFetch([
            { body: { '@odata.context': 'x', verified: false } }
        ]);
        const ng = connect({ baseUrl: 'https://ng.example', fetchFn: fn as any });
        expect(await ng.verifyAttestation({ contractAddress: 'c', payloadHash: 'p' })).toEqual({ verified: false });

        const { fn: failFn } = fakeFetch([{ status: 400, body: { error: { code: 'BadThing', message: 'nope' } } }]);
        const ng2 = connect({ baseUrl: 'https://ng.example', fetchFn: failFn as any });
        await expect(ng2.verifyAttestation({ contractAddress: 'c', payloadHash: 'p' }))
            .rejects.toMatchObject({ name: 'NightgateApiError', status: 400, code: 'BadThing', message: 'nope' });
        expect(new NightgateApiError(1, 'x', 'y')).toBeInstanceOf(Error);
    });

    test('a key conflict names the job that holds the key, when the server sends it', async () => {
        const { connect } = await importClient();
        const holder = { jobId: 'j7', status: 'succeeded', chainStatus: 'success' };
        const conflict = { code: 'IDEMPOTENCY_KEY_CONFLICT', message: 'used with a different request payload' };
        const { fn } = fakeFetch([
            { status: 409, body: { error: { ...conflict, '@nightgate.job': holder } } },
            { status: 409, body: { error: conflict } }
        ]);
        const ng = connect({ baseUrl: 'https://ng.example', fetchFn: fn as any });
        const first = await ng.callAction('anchorDocument', { idempotencyKey: 'k' }).catch((e: unknown) => e) as { code: string; job?: unknown };
        expect(first).toMatchObject({ name: 'NightgateApiError', status: 409, code: 'IDEMPOTENCY_KEY_CONFLICT', job: holder });
        // Another caller gets the conflict without the job.
        const second = await ng.callAction('anchorDocument', { idempotencyKey: 'k' }).catch((e: unknown) => e) as { job?: unknown };
        expect(second).toMatchObject({ status: 409 });
        expect('job' in second).toBe(false);
    });
});

describe('connect: service paths', () => {
    test('defaults to the midnight paths; servicePath and indexerServicePath override them', async () => {
        const { connect } = await importClient();
        const { fn, calls } = fakeFetch([{ body: {} }]);
        const ng = connect({ baseUrl: 'https://ng.example/', fetchFn: fn as any });
        await ng.getHealth();
        await ng.verifyAttestation({ contractAddress: 'c', payloadHash: 'p' });
        expect(calls[0].url).toBe('https://ng.example/odata/v4/midnight-indexer/getHealth()');
        expect(calls[1].url.startsWith('https://ng.example/odata/v4/midnight/verifyAttestation(')).toBe(true);

        const old = fakeFetch([{ body: {} }]);
        const ngOld = connect({
            baseUrl: 'https://ng.example', fetchFn: old.fn as any,
            servicePath: '/gateway/midnight', indexerServicePath: '/gateway/midnight-indexer'
        });
        await ngOld.getHealth();
        await ngOld.verifyAttestation({ contractAddress: 'c', payloadHash: 'p' });
        expect(old.calls[0].url).toBe('https://ng.example/gateway/midnight-indexer/getHealth()');
        expect(old.calls[1].url.startsWith('https://ng.example/gateway/midnight/verifyAttestation(')).toBe(true);
    });
});

describe('connect: auth headers', () => {
    async function headersFor(opts: Record<string, unknown>) {
        const { connect } = await importClient();
        const { fn, calls } = fakeFetch([{ body: {} }]);
        const ng = connect({ baseUrl: 'https://ng.example', fetchFn: fn as any, ...opts });
        await ng.getHealth();
        return calls[0].init.headers as Record<string, string>;
    }

    test('agentToken travels in x-agent-token, optionally alongside Basic', async () => {
        const h1 = await headersFor({ agentToken: 'ngat_abc' });
        expect(h1['x-agent-token']).toBe('ngat_abc');
        expect(h1.Authorization).toBeUndefined();

        const h2 = await headersFor({ agentToken: 'ngat_abc', username: 'u', password: 'p' });
        expect(h2['x-agent-token']).toBe('ngat_abc');
        expect(h2.Authorization).toBe('Basic ' + Buffer.from('u:p').toString('base64'));
    });

    test('token is Bearer; username/password alone is Basic; nothing means no auth header', async () => {
        expect((await headersFor({ token: 't0k' })).Authorization).toBe('Bearer t0k');
        expect((await headersFor({ username: 'u', password: 'p' })).Authorization)
            .toBe('Basic ' + Buffer.from('u:p').toString('base64'));
        expect((await headersFor({})).Authorization).toBeUndefined();
    });
});

describe('connect: reading a table', () => {
    test('sends one OData read with the query encoded and returns the rows', async () => {
        const { connect } = await importClient();
        const rows = [{ ID: 't1', blockHeight: 5 }, { ID: 't2', blockHeight: 5 }];
        const { fn, calls } = fakeFetch([{ body: { '@odata.context': 'x', value: rows } }, { body: { value: [] } }, { body: { value: [{ ID: 'SINGLETON' }] } }]);
        const ng = connect({ baseUrl: 'https://ng.example/', fetchFn: fn as any, agentToken: 'ngat_x' });
        const out = await ng.read('Transactions', { filter: "txType eq 'contract_call' and blockHeight ge 5", orderby: 'blockHeight desc,indexInBlock desc', top: 50, skip: 100, select: ['ID', 'blockHeight'] });
        expect(out).toEqual(rows);
        expect(calls[0].init.method).toBe('GET');
        expect(calls[0].init.headers['x-agent-token']).toBe('ngat_x');
        expect(calls[0].url).toBe("https://ng.example/odata/v4/midnight/Transactions?$filter=txType%20eq%20'contract_call'%20and%20blockHeight%20ge%205"
            + '&$orderby=blockHeight%20desc%2CindexInBlock%20desc&$select=ID%2CblockHeight&$top=50&$skip=100');

        // No query reads the first page; an empty page is an empty list.
        expect(await ng.read('Blocks')).toEqual([]);
        expect(calls[1].url).toBe('https://ng.example/odata/v4/midnight/Blocks');
        expect(await ng.read('SyncState', { service: 'indexer', top: 1 })).toEqual([{ ID: 'SINGLETON' }]);
        expect(calls[2].url).toBe('https://ng.example/odata/v4/midnight-indexer/SyncState?$top=1');
    });

    test('refuses what is no table name, no page position or no service, before any request', async () => {
        const { connect } = await importClient();
        const { fn, calls } = fakeFetch([]);
        const ng = connect({ baseUrl: 'https://ng.example', fetchFn: fn as any });
        for (const entity of ['', 'Blocks?$top=1', '../admin/AgentGrants', "Blocks('x')", 42]) {
            await expect(ng.read(entity as string)).rejects.toThrow('read: entity must be the name of a table, such as Blocks');
        }
        await expect(ng.read('Blocks', { top: -1 })).rejects.toThrow('read: top must be a non-negative integer');
        await expect(ng.read('Blocks', { skip: 1.5 })).rejects.toThrow('read: skip must be a non-negative integer');
        await expect(ng.read('Blocks', { service: 'admin' as never })).rejects.toThrow("read: service must be 'main' or 'indexer'");
        expect(calls).toHaveLength(0);
    });
});

describe('connect: jobs', () => {
    test('write actions submit, poll and return the PARSED job result with txId and txHash', async () => {
        const { connect } = await importClient();
        const { fn, calls } = fakeFetch([
            { body: { jobId: 'j1', status: 'pending' } },
            { body: { status: 'processing' } },
            { body: { status: 'succeeded', result: { txId: '00ab', txHash: 'cd01', anchorId: 'd1' } } }
        ]);
        const ng = connect({ baseUrl: 'https://ng.example', fetchFn: fn as any, pollMs: 1 });
        const out = await ng.anchorDocument({ payloadHash: 'x', sessionId: 's1', contractAddress: 'c' });
        expect(out).toMatchObject({ jobId: 'j1', txId: '00ab', txHash: 'cd01', anchorId: 'd1' });
        // A job answer without a chain verdict gives null, never a missing field.
        expect(out).toMatchObject({ chainStatus: null, blockHeight: null });
        // the polls carry the SESSION the job was started under
        expect(pollOf(calls[1])).toBe("(jobId='j1',sessionId='s1',waitMs=20000)");
    });

    test('sponsorFinalized polls under the SPONSOR session the server returns', async () => {
        const { connect } = await importClient();
        const { fn, calls } = fakeFetch([
            { body: { jobId: 'j2', status: 'pending', sessionId: 'sponsor-1' } },
            { body: { status: 'succeeded', result: { txHash: '00cd' } } }
        ]);
        const ng = connect({ baseUrl: 'https://ng.example', fetchFn: fn as any, pollMs: 1 });
        const out = await ng.sponsorFinalized({ finalizedTxB64: 'AAAA' });
        expect(out.txHash).toBe('00cd');
        expect(JSON.parse(calls[0].init.body)).toMatchObject({ finalizedTxB64: 'AAAA' });
        expect(pollOf(calls[1])).toBe("(jobId='j2',sessionId='sponsor-1',waitMs=20000)");
    });

    test('sponsorSwap posts both halves and polls under the SPONSOR session', async () => {
        const { connect } = await importClient();
        const { fn, calls } = fakeFetch([
            { body: { jobId: 'job-9', status: 'pending', sessionId: 'sponsor-1' } },
            { body: { status: 'succeeded', result: { txHash: '00aa', swap: { gives: { tokenType: 'a', amount: '10' }, wants: { tokenType: 'b', amount: '3' } } } } }
        ]);
        const ng = connect({ baseUrl: 'https://ng.example', fetchFn: fn as any, pollMs: 1 });
        const out = await ng.sponsorSwap({ makerHalfB64: 'swapoffer1xyz', takerHalfB64: 'AAEC' });
        expect(calls[0].url).toBe('https://ng.example/odata/v4/midnight/sponsorSwap');
        expect(JSON.parse(calls[0].init.body)).toMatchObject({ makerHalfB64: 'swapoffer1xyz', takerHalfB64: 'AAEC' });
        expect(pollOf(calls[1])).toContain("jobId='job-9',sessionId='sponsor-1'");
        expect(out).toMatchObject({ txHash: '00aa', swap: { gives: { amount: '10' } } });
    });

    test('a failed job throws NightgateJobError carrying the job row', async () => {
        const { connect, NightgateJobError } = await importClient();
        const { fn } = fakeFetch([
            { body: { jobId: 'j3', status: 'pending' } },
            { body: { status: 'failed', errorCode: 'BATCH_CAUSALITY_VIOLATION', errorMessage: 'split the batch' } }
        ]);
        const ng = connect({ baseUrl: 'https://ng.example', fetchFn: fn as any, pollMs: 1 });
        const err = await ng.proveFieldPredicate({ sessionId: 's' }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(NightgateJobError);
        expect((err as any).job).toMatchObject({ jobId: 'j3', errorCode: 'BATCH_CAUSALITY_VIOLATION' });
    });

    test('sendToken is submit-and-wait like every other write action', async () => {
        const { connect } = await importClient();
        const { fn, calls } = fakeFetch([
            { body: { jobId: 'j5', status: 'pending' } },
            { body: { status: 'succeeded', result: { txId: '00ef', toLedger: 'unshielded' } } }
        ]);
        const ng = connect({ baseUrl: 'https://ng.example', fetchFn: fn as any, pollMs: 1 });
        const out = await ng.sendToken({ sessionId: 's1', receiverAddress: 'addr', amount: '5' });
        expect(out).toMatchObject({ jobId: 'j5', txId: '00ef' });
        expect(calls[1].url).toContain('/getJobStatus');
    });

    test('act polls under the session the SERVER returns', async () => {
        // The server picks the paying session and RETURNS the job session.
        const { connect } = await importClient();
        const { fn, calls } = fakeFetch([
            { body: { jobId: 'j6', status: 'pending', sessionId: 'server-side-sponsor' } },
            { body: { status: 'succeeded', result: { txHash: '0011' } } }
        ]);
        const ng = connect({ baseUrl: 'https://ng.example', fetchFn: fn as any, pollMs: 1 });
        const out = await ng.sponsorFinalized({ finalizedTxB64: 'AAAA' });
        expect(out.txHash).toBe('0011');
        expect(pollOf(calls[1])).toBe("(jobId='j6',sessionId='server-side-sponsor',waitMs=20000)");
    });

    test('an action without a jobId returns as-is (sync surface)', async () => {
        const { connect } = await importClient();
        const { fn } = fakeFetch([{ body: { txId: 'direct', toLedger: 'unshielded' } }]);
        const ng = connect({ baseUrl: 'https://ng.example', fetchFn: fn as any });
        expect(await ng.deployContract({ sessionId: 's' })).toEqual({ txId: 'direct', toLedger: 'unshielded' });
    });

    test('waitForJob long-polls with waitMs and returns the explorer hash', async () => {
        const { connect } = await importClient();
        const { fn, calls } = fakeFetch([
            { body: { status: 'running' } },
            { body: { status: 'succeeded', txId: '00ab', txHash: 'cd01', chainStatus: 'pending', blockHeight: null, result: {} } }
        ]);
        const ng = connect({ baseUrl: 'https://ng.example', fetchFn: fn as any, pollMs: 1, longPollMs: 15_000 });
        const out = await ng.waitForJob({ jobId: 'j1', sessionId: 's', timeoutMs: 60_000 });
        expect(out).toEqual(expect.objectContaining({ txId: '00ab', txHash: 'cd01' }));
        // The job succeeded before the chain answered, and the result says so.
        expect(out).toMatchObject({ chainStatus: 'pending', blockHeight: null });
        expect(pollOf(calls[0])).toBe("(jobId='j1',sessionId='s',waitMs=15000)");
        expect(calls[0].init.method).toBe('GET');
    });

    const RECEIPT = { payload: '{}', signature: 'ab', publicKey: 'cd', algorithm: 'ed25519' };

    test('waitForReceipt holds the call until the chain decided and returns the receipt', async () => {
        const { connect } = await importClient();
        const { fn, calls } = fakeFetch([
            { body: { status: 'succeeded', chainStatus: 'pending', receipt: null } },
            { body: { status: 'succeeded', chainStatus: 'success', receipt: RECEIPT } }
        ]);
        const ng = connect({ baseUrl: 'https://ng.example', fetchFn: fn as any, longPollMs: 15_000 });
        expect(await ng.waitForReceipt({ jobId: 'j1', sessionId: 's', pollMs: 1 })).toEqual(RECEIPT);
        expect(pollOf(calls[0])).toBe("(jobId='j1',sessionId='s',waitMs=15000,untilChain=true)");
    });

    test('waitForReceipt throws for a failed job and for a job that gets no receipt', async () => {
        const { connect, NightgateJobError } = await importClient();
        const failed = fakeFetch([{ body: { status: 'failed', chainStatus: 'failure', errorCode: 'X', receipt: null } }]);
        await expect(connect({ baseUrl: 'https://ng.example', fetchFn: failed.fn as any }).waitForReceipt({ jobId: 'j3', sessionId: 's' })).rejects.toBeInstanceOf(NightgateJobError);
        const other = fakeFetch([{ body: { status: 'succeeded', kind: 'deployContract', chainStatus: 'success', receipt: null } }]);
        await expect(connect({ baseUrl: 'https://ng.example', fetchFn: other.fn as any }).waitForReceipt({ jobId: 'j4', sessionId: 's' })).rejects.toThrow(/deployContract\) has no receipt/);
    });

    test('waitForReceipt times out, and backs off while it polls', async () => {
        const { connect } = await importClient();
        const { fn, calls } = fakeFetch([{ body: { status: 'succeeded', chainStatus: 'pending', receipt: null } }]);
        const ng = connect({ baseUrl: 'https://ng.example', fetchFn: fn as any, longPollMs: 0 });
        await expect(ng.waitForReceipt({ jobId: 'j5', sessionId: 's', pollMs: 40, timeoutMs: 100 })).rejects.toThrow(/no receipt after 100ms/);
        // 40, 80 and 160 ms apart: a fixed interval would have asked more often.
        expect(calls.length).toBeLessThanOrEqual(3);
    });

    test('waitForJob keeps waitMs inside the server maximum and the request timeout', async () => {
        const { connect } = await importClient();
        const { fn, calls } = fakeFetch([{ body: { status: 'succeeded', result: {} } }]);
        await connect({ baseUrl: 'https://ng.example', fetchFn: fn as any, longPollMs: 30_000.5 }).waitForJob({ jobId: 'a', sessionId: 's' });
        expect(pollOf(calls[0])).toContain('waitMs=25000');
        await connect({ baseUrl: 'https://ng.example', fetchFn: fn as any, timeoutMs: 15_000 }).waitForJob({ jobId: 'b', sessionId: 's' });
        expect(pollOf(calls[1])).toContain('waitMs=10000');
        await connect({ baseUrl: 'https://ng.example', fetchFn: fn as any, timeoutMs: 4_000 }).waitForJob({ jobId: 'c', sessionId: 's' });
        expect(pollOf(calls[2])).toBe("(jobId='c',sessionId='s')");
    });

    test('waitForJob with longPollMs 0 never sends waitMs', async () => {
        const { connect } = await importClient();
        const { fn, calls } = fakeFetch([{ body: { status: 'succeeded', result: {} } }]);
        const ng = connect({ baseUrl: 'https://ng.example', fetchFn: fn as any, longPollMs: 0 });
        await ng.waitForJob({ jobId: 'j3', sessionId: 's' });
        expect(pollOf(calls[0])).toBe("(jobId='j3',sessionId='s')");
    });

    test('waitForJob times out rather than spinning forever', async () => {
        const { connect } = await importClient();
        const { fn } = fakeFetch([{ body: { status: 'processing' } }]);
        const ng = connect({ baseUrl: 'https://ng.example', fetchFn: fn as any, pollMs: 1 });
        await expect(ng.waitForJob({ jobId: 'j4', timeoutMs: 5 })).rejects.toThrow(/still processing/);
    });

    test('waitForJob survives transient poll failures (proxy 502, network) and keeps the job handle', async () => {
        // A reverse proxy may answer a poll with 502 while the server is busy
        // although the job itself landed.
        const { connect } = await importClient();
        const { fn, calls } = fakeFetch([
            { status: 502, body: { error: { message: 'Bad Gateway' } } },
            { status: 503, body: {} },
            { body: { status: 'processing' } },
            { body: { status: 'succeeded', result: { txHash: 'tx-after-502' } } }
        ]);
        const ng = connect({ baseUrl: 'https://ng.example', fetchFn: fn as any, pollMs: 1 });
        const out = await ng.waitForJob({ jobId: 'j5', sessionId: 's' });
        expect(out.txHash).toBe('tx-after-502');
        expect(calls.length).toBe(4);
    });

    test('waitForJob honours timeoutMs even while every poll fails transiently', async () => {
        const { connect, NightgateApiError } = await importClient();
        const always503 = fakeFetch([{ status: 503, body: {} }]);
        const ng = connect({ baseUrl: 'https://ng.example', fetchFn: always503.fn as any, pollMs: 1 });
        const t0 = Date.now();
        await expect(ng.waitForJob({ jobId: 'j8', timeoutMs: 10, pollGraceMs: 60_000 })).rejects.toBeInstanceOf(NightgateApiError);
        expect(Date.now() - t0).toBeLessThan(2_000); // bounded by timeoutMs, not by the 60 s grace
    });

    test('waitForJob gives up on transient poll failures after pollGraceMs, and never retries a 4xx', async () => {
        const { connect, NightgateApiError } = await importClient();
        const always502 = fakeFetch([{ status: 502, body: {} }]);
        const ng = connect({ baseUrl: 'https://ng.example', fetchFn: always502.fn as any, pollMs: 1 });
        await expect(ng.waitForJob({ jobId: 'j6', pollGraceMs: 20 })).rejects.toBeInstanceOf(NightgateApiError);
        expect(always502.calls.length).toBeGreaterThan(1);

        const forbidden = fakeFetch([{ status: 403, body: { error: { message: 'nope' } } }]);
        const ng2 = connect({ baseUrl: 'https://ng.example', fetchFn: forbidden.fn as any, pollMs: 1 });
        await expect(ng2.waitForJob({ jobId: 'j7' })).rejects.toThrow(/nope/);
        expect(forbidden.calls.length).toBe(1);
    });

    test('int64 rejects non-integers', async () => {
        const { int64 } = await importClient();
        expect(() => int64('1.5')).toThrow(/not an integer/);
        expect(int64('12').$int64).toBe('12');
    });
});

describe('connect: stale keep-alive socket', () => {
    const staleSocket = () => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) });

    test('retries a GET and a POST that carries an idempotencyKey once on a fresh connection', async () => {
        const { connect } = await importClient();
        const fn = vi.fn()
            .mockRejectedValueOnce(staleSocket())
            .mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify({ jobId: 'j1' }) });
        const ng = connect({ baseUrl: 'https://ng.example', fetchFn: fn as any });
        await expect(ng.callAction('sendToken', { amount: '1', receiverAddress: 'addr', idempotencyKey: 'k-1' })).resolves.toMatchObject({ jobId: 'j1' });
        expect(fn).toHaveBeenCalledTimes(2);
        expect(JSON.parse(fn.mock.calls[1][1].body)).toMatchObject({ idempotencyKey: 'k-1' });

        const get = vi.fn()
            .mockRejectedValueOnce(staleSocket())
            .mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) });
        const ng2 = connect({ baseUrl: 'https://ng.example', fetchFn: get as any });
        await expect(ng2.callFunction('getWalletBalance', { sessionId: 's' })).resolves.toMatchObject({ ok: true });
        expect(get).toHaveBeenCalledTimes(2);
    });

    test('a finished job names its session and carries a receipt once there is one', async () => {
        const { connect } = await importClient();
        const receipt = { payload: '{}', signature: 'aa', publicKey: 'bb', algorithm: 'ed25519' };
        const answers = [
            { jobId: 'j1', status: 'pending', sessionId: 'pool' }, { status: 'succeeded', txId: '00aa', result: {} },
            { jobId: 'j2', status: 'pending', sessionId: 'pool' }, { status: 'succeeded', txId: '00bb', result: {}, receipt }
        ];
        const fn = vi.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify(answers.shift()) }));
        const ng = connect({ baseUrl: 'https://ng.example', fetchFn: fn as any });
        const first = await ng.sponsorTransfer({ transferTxB64: 'AA==', tokenType: 'ab', amount: '1' });
        expect(first).toMatchObject({ jobId: 'j1', sessionId: 'pool' });
        expect(first).not.toHaveProperty('receipt');
        expect(await ng.sponsorTransfer({ transferTxB64: 'AA==', tokenType: 'ab', amount: '1' })).toMatchObject({ jobId: 'j2', sessionId: 'pool', receipt });
    });

    test('a job call gets its own key and goes out again on a dead connection with the same key', async () => {
        const { connect } = await importClient();
        const fn = vi.fn()
            .mockRejectedValueOnce(staleSocket())
            .mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify({ txHash: '0xabc' }) });
        const ng = connect({ baseUrl: 'https://ng.example', fetchFn: fn as any });
        await expect(ng.sponsorUnbound({ unboundTxB64: 'AA==' })).resolves.toMatchObject({ txHash: '0xabc' });
        expect(fn).toHaveBeenCalledTimes(2);
        const [first, second] = fn.mock.calls.map(([, init]) => JSON.parse(init.body));
        expect(first.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
        expect(second.idempotencyKey).toBe(first.idempotencyKey);
    });

    test('two job calls get different keys, and a key from the caller is kept', async () => {
        const { connect } = await importClient();
        const fn = vi.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ txHash: '0xabc' }) }));
        const ng = connect({ baseUrl: 'https://ng.example', fetchFn: fn as any });
        await ng.sponsorUnbound({ unboundTxB64: 'AA==' });
        await ng.sponsorUnbound({ unboundTxB64: 'AA==' });
        await ng.sponsorUnbound({ unboundTxB64: 'AA==', idempotencyKey: 'mine' });
        await ng.sponsorUnbound({ unboundTxB64: 'AA==', idempotencyKey: undefined });
        const keys = (fn.mock.calls as unknown as [string, { body: string }][]).map(([, init]) => JSON.parse(init.body).idempotencyKey);
        expect(keys[0]).not.toBe(keys[1]);
        expect(keys[2]).toBe('mine');
        expect(keys[3]).toMatch(/^[0-9a-f-]{36}$/);
    });

    test('buildSponsorable sends no key, because the action does not declare one', async () => {
        const { connect } = await importClient();
        const fn = vi.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ finalizedTxB64: 'AA==' }) }));
        const ng = connect({ baseUrl: 'https://ng.example', fetchFn: fn as any });
        await ng.buildSponsorable({ sessionId: 's' });
        const [[, init]] = fn.mock.calls as unknown as [string, { body: string }][];
        expect(JSON.parse(init.body)).toEqual({ sessionId: 's' });
    });

    test('a write without an idempotencyKey is never sent twice: the error surfaces after one attempt', async () => {
        const { connect } = await importClient();
        const once = vi.fn().mockRejectedValue(staleSocket());
        const ng = connect({ baseUrl: 'https://ng.example', fetchFn: once as any });
        await expect(ng.callAction('sendToken', { amount: '1', receiverAddress: 'addr' })).rejects.toThrow(/fetch failed/);
        expect(once).toHaveBeenCalledTimes(1);
    });

    test('a response lost after the server accepted a keyless write reaches the server exactly once (loopback)', async () => {
        const http = await import('node:http');
        const { connect } = await importClient();
        let received = 0;
        const server = http.createServer((req, res) => {
            req.resume();
            req.on('end', () => {
                received++;
                if (received === 1) { req.socket.destroy(); return; }
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ jobId: `job-${received}` }));
            });
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
        try {
            const port = (server.address() as any).port;
            const ng = connect({ baseUrl: `http://127.0.0.1:${port}`, timeoutMs: 5000 });
            await expect(ng.callAction('sendToken', { sessionId: 's', receiverAddress: 'addr', amount: '1' })).rejects.toThrow();
            expect(received).toBe(1);
        } finally {
            server.closeAllConnections();
            await new Promise<void>(resolve => server.close(() => resolve()));
        }
    });

    test('a second stale-socket failure and every other network error surface unchanged', async () => {
        const { connect } = await importClient();
        const twice = vi.fn().mockRejectedValue(staleSocket());
        const ng = connect({ baseUrl: 'https://ng.example', fetchFn: twice as any });
        await expect(ng.callAction('anchorDocument', { payloadHash: 'ab', idempotencyKey: 'k' })).rejects.toThrow(/fetch failed/);
        expect(twice).toHaveBeenCalledTimes(2);
        const refused = vi.fn().mockRejectedValue(Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) }));
        const ng2 = connect({ baseUrl: 'https://ng.example', fetchFn: refused as any });
        await expect(ng2.callAction('anchorDocument', { payloadHash: 'ab' })).rejects.toThrow(/fetch failed/);
        expect(refused).toHaveBeenCalledTimes(1);
    });
});

describe('isRetryable', () => {
    test('the client list is exactly the retryable codes of the server registry', async () => {
        const { RETRYABLE_ERROR_CODES } = await importClient();
        const { retryableErrorCodes } = await import('../../srv/utils/errors.js');
        expect([...RETRYABLE_ERROR_CODES].sort()).toEqual(retryableErrorCodes());
    });

    test('decides on the code first, then the status, then network errors', async () => {
        const { isRetryable, NightgateApiError, NightgateJobError } = await importClient();
        expect(isRetryable(new NightgateApiError(503, 'WALLET_SYNCING', 'x'))).toBe(true);
        // A 503 whose code says the database needs an operator is not worth a retry.
        expect(isRetryable(new NightgateApiError(503, 'SCHEMA_NOT_DEPLOYED', 'x'))).toBe(false);
        expect(isRetryable(new NightgateApiError(400, 'INVALID_ARGUMENT', 'x'))).toBe(false);
        // A proxy's or CAP's numeric code falls back to the status.
        expect(isRetryable(new NightgateApiError(504, '504', 'x'))).toBe(true);
        expect(isRetryable(new NightgateApiError(404, '404', 'x'))).toBe(false);
        expect(isRetryable(new NightgateJobError({ jobId: 'j', status: 'failed' }))).toBe(false);
        expect(isRetryable(new TypeError('fetch failed'))).toBe(true);
    });
});

describe('a write that failed to start', () => {
    const timedOut = () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });

    test('names the key this client made, and is not to be repeated unchanged', async () => {
        const { connect, isRetryable } = await importClient();
        const fn = vi.fn().mockRejectedValue(timedOut());
        const ng = connect({ baseUrl: 'https://ng.example', fetchFn: fn as any });
        const failure = await ng.sponsorUnbound({ unboundTxB64: 'AA==' }).catch((e: unknown) => e) as any;
        const sent = JSON.parse(fn.mock.calls[0][1].body);
        expect(failure.name).toBe('TimeoutError');
        expect(failure.idempotencyKey).toBe(sent.idempotencyKey);
        // The client tried once more under the same key before it gave up.
        expect(fn).toHaveBeenCalledTimes(2);
        expect(JSON.parse(fn.mock.calls[1][1].body).idempotencyKey).toBe(sent.idempotencyKey);
        // The server may have started the job. A repeat without the key would start a second one.
        expect(isRetryable(failure)).toBe(false);

        // Repeated with the key, the server answers with the first job.
        const again = vi.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ txHash: '0xabc' }) }));
        const retry = connect({ baseUrl: 'https://ng.example', fetchFn: again as any });
        await retry.sponsorUnbound({ unboundTxB64: 'AA==', idempotencyKey: failure.idempotencyKey });
        expect(JSON.parse((again.mock.calls as any)[0][1].body).idempotencyKey).toBe(sent.idempotencyKey);
    });

    test('a start that got no answer goes out once more under the same key, and the caller notices nothing', async () => {
        const { connect } = await importClient();
        const answer = { ok: true, status: 200, text: async () => JSON.stringify({ txHash: '0xabc' }) };
        const gateway = { ok: false, status: 504, headers: { get: () => null }, text: async () => JSON.stringify({ error: { code: '504', message: 'Gateway Timeout' } }) };
        for (const first of [() => Promise.reject(timedOut()), () => Promise.resolve(gateway)]) {
            const fn = vi.fn().mockImplementationOnce(first).mockResolvedValueOnce(answer);
            const ng = connect({ baseUrl: 'https://ng.example', fetchFn: fn as any });
            await expect(ng.sponsorUnbound({ unboundTxB64: 'AA==' })).resolves.toMatchObject({ txHash: '0xabc' });
            expect(fn).toHaveBeenCalledTimes(2);
            const [one, two] = fn.mock.calls.map(([, init]) => JSON.parse(init.body).idempotencyKey);
            expect(two).toBe(one);
        }
    });

    test('a refusal of the server itself is not repeated by the client', async () => {
        const { connect } = await importClient();
        const fn = vi.fn(async () => ({ ok: false, status: 503, headers: { get: () => '15' }, text: async () => JSON.stringify({ error: { code: 'WALLET_SYNCING', message: 'wallet is still syncing' } }) }));
        const ng = connect({ baseUrl: 'https://ng.example', fetchFn: fn as any });
        await expect(ng.sponsorUnbound({ unboundTxB64: 'AA==' })).rejects.toMatchObject({ code: 'WALLET_SYNCING', retryAfterSeconds: 15 });
        expect(fn).toHaveBeenCalledTimes(1);
    });

    test('with a key from the caller nothing is added, and a repeat unchanged is safe', async () => {
        const { connect, isRetryable } = await importClient();
        const ng = connect({ baseUrl: 'https://ng.example', fetchFn: vi.fn().mockRejectedValue(timedOut()) as any });
        const failure = await ng.sponsorUnbound({ unboundTxB64: 'AA==', idempotencyKey: 'mine' }).catch((e: unknown) => e) as any;
        expect(failure.idempotencyKey).toBeUndefined();
        expect(isRetryable(failure)).toBe(true);
    });

    test('a refusal of the server itself started no job and stays retryable; an answer from in between does not', async () => {
        const { connect, isRetryable } = await importClient();
        const refuse = (status: number, error: unknown) => connect({
            baseUrl: 'https://ng.example',
            fetchFn: vi.fn(async () => ({ ok: false, status, headers: { get: () => null }, text: async () => JSON.stringify({ error }) })) as any
        }).sponsorUnbound({ unboundTxB64: 'AA==' }).catch((e: unknown) => e) as Promise<any>;

        const syncing = await refuse(503, { code: 'WALLET_SYNCING', message: 'wallet is still syncing' });
        expect(syncing.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
        expect(isRetryable(syncing)).toBe(true);

        // A gateway timeout carries no server code. The request may have gone through.
        const gateway = await refuse(504, { code: '504', message: 'Gateway Timeout' });
        expect(isRetryable(gateway)).toBe(false);
        expect(isRetryable(await refuse(429, { code: '429', message: 'Too Many Requests' }))).toBe(true);
    });

    test('a wait that ran out of time names the job, so it can be picked up again', async () => {
        const { connect } = await importClient();
        const { fn } = fakeFetch([{ body: { status: 'processing' } }]);
        const ng = connect({ baseUrl: 'https://ng.example', fetchFn: fn as any, pollMs: 1 });
        const failure = await ng.waitForJob({ jobId: 'j9', sessionId: 's9', timeoutMs: 5 }).catch((e: unknown) => e) as any;
        expect(failure).toMatchObject({ jobId: 'j9', sessionId: 's9' });
    });

    test('verifyReceipt comes from the client entry too, as its types say', async () => {
        const client = await importClient();
        const index = await import('../../src/sdk/index.mjs' as string);
        expect(typeof client.verifyReceipt).toBe('function');
        expect(client.verifyReceipt).toBe(index.verifyReceipt);
    });
});

describe('connect: the chain reads a transaction builder needs', () => {
    test('contractStateAt asks stateAt with a null height, lowercases the address and drops a 0x prefix', async () => {
        const { connect } = await importClient();
        const { fn, calls } = fakeFetch([{ body: { contractAddress: 'ab', height: 7, state: 'c3Q=', ledgerParameters: null } }]);
        const ng = connect({ baseUrl: 'https://ng.example', agentToken: 'ngat_x', fetchFn: fn as any });
        const snap = await ng.contractStateAt({ contractAddress: '0xAB' });
        expect(calls[0].url).toBe("https://ng.example/odata/v4/midnight/ContractStates/stateAt(contractAddress='ab',height=null)");
        expect(snap).toEqual(expect.objectContaining({ height: 7, state: 'c3Q=' }));
        await ng.contractStateAt({ contractAddress: 'ab', height: 12 });
        expect(calls[1].url).toMatch(/height=12\)$/);
    });

    test('transactionByTxId is null on 404 and the inclusion otherwise', async () => {
        const { connect } = await importClient();
        const { fn, calls } = fakeFetch([{ status: 404, body: { error: { message: 'no indexed transaction carries identifier ffff' } } }]);
        const ng = connect({ baseUrl: 'https://ng.example', fetchFn: fn as any });
        expect(await ng.transactionByTxId('0xFFFF')).toBeNull();
        expect(calls[0].url).toBe("https://ng.example/odata/v4/midnight/Transactions/byTxId(txId='ffff')");

        const found = fakeFetch([{ body: { txId: 'ffff', extrinsicHash: '0xtx', blockHeight: 5, status: 'SUCCESS', failedSegments: [] } }]);
        const ng2 = connect({ baseUrl: 'https://ng.example', fetchFn: found.fn as any });
        expect(await ng2.transactionByTxId('ffff')).toEqual(expect.objectContaining({ extrinsicHash: '0xtx', blockHeight: 5, status: 'SUCCESS' }));
    });

    test('contractDeploy filters the deploy action with its transaction, block and result, and names the deploy identifier', async () => {
        const { connect } = await importClient();
        const page = {
            value: [{
                actionIndex: 1,
                transaction: {
                    extrinsicHash: '0xdeploy', txHash: '0xledger', identifiers: JSON.stringify(['id0', 'id1']),
                    block: { height: 7, hash: '0xb7', timestamp: 1700, protocolVersion: 2001000 },
                    transactionResult: { status: 'PARTIAL_SUCCESS', segments: [{ segmentId: 0, success: true }, { segmentId: 1, success: false }] }
                }
            }]
        };
        const { fn, calls } = fakeFetch([{ body: page }]);
        const ng = connect({ baseUrl: 'https://ng.example', fetchFn: fn as any });
        const deploy = await ng.contractDeploy('0x' + 'AB'.repeat(32));
        const url = decodeURIComponent(calls[0].url);
        expect(url).toContain(`/ContractActions?$filter=contractAddress eq '${'ab'.repeat(32)}' and actionType eq 'DEPLOY'`);
        expect(url).toContain('$expand=transaction($expand=block,transactionResult($expand=segments))');
        expect(deploy).toEqual({
            extrinsicHash: '0xdeploy', txHash: '0xledger', blockHeight: 7, blockHash: '0xb7', blockTimestamp: 1700, protocolVersion: 2001000, status: 'PARTIAL_SUCCESS',
            failedSegments: [1], identifiers: ['id0', 'id1'], txId: 'id1'
        });
    });

    test('ledgerTransaction returns the base64 bytes, and null while the server has not indexed them', async () => {
        const { connect } = await importClient();
        const { fn, calls } = fakeFetch([{ body: { extrinsicHash: '0xdeploy', ledgerTransaction: 'dHg=' } }, { status: 404, body: { error: { message: 'none' } } }]);
        const ng = connect({ baseUrl: 'https://ng.example', fetchFn: fn as any });
        expect(await ng.ledgerTransaction('0xdeploy')).toBe('dHg=');
        expect(decodeURIComponent(calls[0].url)).toContain('/Transactions/ledgerTransaction(');
        expect(await ng.ledgerTransaction('0xother')).toBeNull();
    });

    test('blockAt reads the newest block or the one at a height from the Blocks entity', async () => {
        const { connect } = await importClient();
        const row = { ID: 'b-1', hash: 'ab20', height: 20, protocolVersion: 2001000, timestamp: 1700 };
        const { fn, calls } = fakeFetch([{ body: { value: [row] } }, { body: { value: [{ ...row, hash: 'ab9', height: '9' }] } }, { body: { value: [] } }]);
        const ng = connect({ baseUrl: 'https://ng.example', fetchFn: fn as any });
        expect(await ng.blockAt()).toEqual({ hash: 'ab20', height: 20, protocolVersion: 2001000, timestamp: 1700 });
        expect(decodeURIComponent(calls[0].url)).toBe('https://ng.example/odata/v4/midnight/Blocks?$orderby=height desc&$top=1&$select=hash,height,protocolVersion,timestamp');
        expect(await ng.blockAt(9)).toEqual(expect.objectContaining({ hash: 'ab9', height: 9 }));
        expect(decodeURIComponent(calls[1].url)).toContain('/Blocks?$filter=height eq 9&$top=1');
        expect(await ng.blockAt(4)).toBeNull();
    });

    test('contractDeploy is null while the server has no deploy action', async () => {
        const { connect } = await importClient();
        const { fn } = fakeFetch([{ body: { value: [] } }]);
        const ng = connect({ baseUrl: 'https://ng.example', fetchFn: fn as any });
        expect(await ng.contractDeploy('ab'.repeat(32))).toBeNull();
    });
});
