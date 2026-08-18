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
            "https://ng.example/api/v1/nightgate/verifyPredicateState(contractAddress='o''hara',payloadHash='ab',threshold=9007199254740993,k=3)"
        );
        expect(calls[0].init.method).toBe('GET');
    });

    test('actions POST a JSON body; bigint becomes a string; undefined dropped', async () => {
        const { connect } = await importClient();
        const { fn, calls } = fakeFetch([{ body: { jobId: null } }]);
        const ng = connect({ baseUrl: 'https://ng.example', fetchFn: fn as any });
        await ng.callAction('sendNight', { amount: 5n, receiverAddress: 'addr', ttlIso: undefined });
        expect(calls[0].url).toBe('https://ng.example/api/v1/nightgate/sendNight');
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

describe('connect: jobs', () => {
    test('write actions submit, poll and return the PARSED job result with txHash', async () => {
        const { connect } = await importClient();
        const { fn, calls } = fakeFetch([
            { body: { jobId: 'j1', status: 'pending' } },
            { body: { status: 'processing' } },
            { body: { status: 'succeeded', result: JSON.stringify({ txHash: '00ab', documentId: 'd1' }) } }
        ]);
        const ng = connect({ baseUrl: 'https://ng.example', fetchFn: fn as any, pollMs: 1 });
        const out = await ng.anchorDocument({ sha256: 'x', sessionId: 's1', contractAddress: 'c' });
        expect(out).toMatchObject({ jobId: 'j1', txHash: '00ab', documentId: 'd1' });
        // the polls carry the SESSION the job was started under
        expect(JSON.parse(calls[1].init.body)).toEqual({ jobId: 'j1', sessionId: 's1' });
    });

    test('sponsorFinalized polls under the SPONSOR session', async () => {
        const { connect } = await importClient();
        const { fn, calls } = fakeFetch([
            { body: { jobId: 'j2', status: 'pending' } },
            { body: { status: 'succeeded', result: JSON.stringify({ txHash: '00cd' }) } }
        ]);
        const ng = connect({ baseUrl: 'https://ng.example', fetchFn: fn as any, pollMs: 1 });
        const out = await ng.sponsorFinalized({ finalizedTxB64: 'AAAA', sponsorSessionId: 'sponsor-1' });
        expect(out.txHash).toBe('00cd');
        expect(JSON.parse(calls[1].init.body)).toEqual({ jobId: 'j2', sessionId: 'sponsor-1' });
    });

    test('a failed job throws NightgateJobError carrying the job row', async () => {
        const { connect, NightgateJobError } = await importClient();
        const { fn } = fakeFetch([
            { body: { jobId: 'j3', status: 'pending' } },
            { body: { status: 'failed', errorCode: 'BatchCausalityViolation', errorMessage: 'split the batch' } }
        ]);
        const ng = connect({ baseUrl: 'https://ng.example', fetchFn: fn as any, pollMs: 1 });
        const err = await ng.proveFieldPredicate({ sessionId: 's' }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(NightgateJobError);
        expect((err as any).job).toMatchObject({ jobId: 'j3', errorCode: 'BatchCausalityViolation' });
    });

    test('sendNight is submit-and-wait like every other write action', async () => {
        const { connect } = await importClient();
        const { fn, calls } = fakeFetch([
            { body: { jobId: 'j5', status: 'pending' } },
            { body: { status: 'succeeded', result: JSON.stringify({ txId: '00ef', toLedger: 'unshielded' }) } }
        ]);
        const ng = connect({ baseUrl: 'https://ng.example', fetchFn: fn as any, pollMs: 1 });
        const out = await ng.sendNight({ sessionId: 's1', receiverAddress: 'addr', amount: '5' });
        expect(out).toMatchObject({ jobId: 'j5', txId: '00ef' });
        expect(calls[1].url).toContain('/getJobStatus');
    });

    test('act polls under the session the SERVER returns (agent-grant sponsor injection)', async () => {
        // Under an agent grant the caller may omit sponsorSessionId entirely;
        // the server injects the pinned sponsor and RETURNS the job session.
        const { connect } = await importClient();
        const { fn, calls } = fakeFetch([
            { body: { jobId: 'j6', status: 'pending', sessionId: 'server-side-sponsor' } },
            { body: { status: 'succeeded', result: JSON.stringify({ txHash: '0011' }) } }
        ]);
        const ng = connect({ baseUrl: 'https://ng.example', fetchFn: fn as any, pollMs: 1 });
        const out = await ng.sponsorFinalized({ finalizedTxB64: 'AAAA' });
        expect(out.txHash).toBe('0011');
        expect(JSON.parse(calls[1].init.body)).toEqual({ jobId: 'j6', sessionId: 'server-side-sponsor' });
    });

    test('an action without a jobId returns as-is (sync surface)', async () => {
        const { connect } = await importClient();
        const { fn } = fakeFetch([{ body: { txId: 'direct', toLedger: 'unshielded' } }]);
        const ng = connect({ baseUrl: 'https://ng.example', fetchFn: fn as any });
        expect(await ng.deployContract({ sessionId: 's' })).toEqual({ txId: 'direct', toLedger: 'unshielded' });
    });

    test('waitForJob times out rather than spinning forever', async () => {
        const { connect } = await importClient();
        const { fn } = fakeFetch([{ body: { status: 'processing' } }]);
        const ng = connect({ baseUrl: 'https://ng.example', fetchFn: fn as any, pollMs: 1 });
        await expect(ng.waitForJob({ jobId: 'j4', timeoutMs: 5 })).rejects.toThrow(/still processing/);
    });

    test('int64 rejects non-integers', async () => {
        const { int64 } = await importClient();
        expect(() => int64('1.5')).toThrow(/not an integer/);
        expect(int64('12').$int64).toBe('12');
    });
});
