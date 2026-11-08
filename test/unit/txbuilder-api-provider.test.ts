/**
 * The midnight-js PublicDataProvider over the NIGHTGATE API (`src/txbuilder/api-provider.mjs`).
 * The server client and the sealed record types are stubs; what is asserted is which read answers which SDK call.
 * The record shapes against the real SDK are pinned in txbuilder-real-sdk.test.ts.
 */

import { describe, it, expect, vi } from 'vitest';

const importProvider = () => import('../../src/txbuilder/api-provider.mjs' as string);

const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');
const ADDRESS = 'ab'.repeat(32);

/** Sealed records as plain objects, so the test can see which bytes went into which type. */
const sealed = (kind: string) => ({ fromBytes: (era: string, raw: Uint8Array) => ({ kind, era, text: Buffer.from(raw).toString('utf8') }) });
const mjTypes = {
    SerializedContractState: sealed('contract'),
    SerializedZswapChainState: sealed('zswap'),
    SerializedLedgerParameters: sealed('params'),
    LedgerTransaction: { fromBytes: (era: string, stage: string, raw: Uint8Array) => ({ era, stage, text: Buffer.from(raw).toString('utf8') }) }
};
const V9 = 2_000_000;
const stateRead = (state: string, params: string) => ({ protocolVersion: V9, contractState: { kind: 'contract', era: 'v9', text: state }, ledgerParameters: { kind: 'params', era: 'v9', text: params } });

function fakeClient(over: Record<string, any> = {}) {
    return {
        contractStateAt: vi.fn(async () => ({ address: ADDRESS, height: 12, state: b64('s12'), zswapState: b64('z12'), ledgerParameters: b64('p12'), blockHash: '0xb12' })),
        transactionByIdentifier: vi.fn(async () => null),
        contractDeploy: vi.fn(async () => ({ txHash: '0xdeploy', blockHeight: 7, blockHash: '0xb7', status: 'SUCCESS', failedSegments: [], identifiers: ['id0', 'id1'], txId: 'id1' })),
        ledgerTransaction: vi.fn(async () => b64('tx')),
        ...over
    };
}

describe('apiPublicDataProvider: contract state', () => {
    it('retries a 503 or 429 of stateAt and gives up after stateRetryMs', async () => {
        const { apiPublicDataProvider } = await importProvider();
        const behind = Object.assign(new Error('the indexer has not reached the action'), { status: 503 });
        const budget = Object.assign(new Error('indexer budget'), { status: 429, retryAfterSeconds: 0 });
        const ok = { address: ADDRESS, height: 12, state: b64('s12'), zswapState: b64('z12'), ledgerParameters: b64('p12'), blockHash: '0xb12' };
        const contractStateAt = vi.fn().mockRejectedValueOnce(behind).mockRejectedValueOnce(budget).mockResolvedValueOnce(ok);
        const provider: any = apiPublicDataProvider({ client: fakeClient({ contractStateAt }), mjTypes, protocolVersion: V9, pollMs: 1 });
        expect(await provider.queryContractState(ADDRESS)).toEqual(stateRead('s12', 'p12'));
        expect(contractStateAt).toHaveBeenCalledTimes(3);

        const always = vi.fn(async () => { throw behind; });
        const impatient: any = apiPublicDataProvider({ client: fakeClient({ contractStateAt: always }), mjTypes, protocolVersion: V9, pollMs: 1, stateRetryMs: 20 });
        await expect(impatient.queryContractState(ADDRESS)).rejects.toBe(behind);
        const refused = Object.assign(new Error('forbidden'), { status: 403 });
        const once = vi.fn(async () => { throw refused; });
        await expect((apiPublicDataProvider({ client: fakeClient({ contractStateAt: once }), mjTypes, protocolVersion: V9, pollMs: 1 }) as any).queryContractState(ADDRESS)).rejects.toBe(refused);
        expect(once).toHaveBeenCalledTimes(1);
    });

    it('watchForContractState retries a 503 for its whole timeout, past stateRetryMs', async () => {
        const { apiPublicDataProvider } = await importProvider();
        const behind = Object.assign(new Error('the indexer has not reached the action'), { status: 503 });
        const ok = { address: ADDRESS, height: 12, state: b64('s12'), zswapState: b64('z12'), ledgerParameters: b64('p12'), blockHash: '0xb12' };
        let calls = 0;
        const started = Date.now();
        const contractStateAt = vi.fn(async () => {
            calls++;
            if (Date.now() - started < 60) throw behind;
            return ok;
        });
        const provider: any = apiPublicDataProvider({ client: fakeClient({ contractStateAt }), mjTypes, protocolVersion: V9, pollMs: 5, stateRetryMs: 10, watchTimeoutMs: 5_000 });
        expect(await provider.watchForContractState(ADDRESS)).toEqual(stateRead('s12', 'p12'));
        expect(calls).toBeGreaterThan(1);
    });

    it('queryContractState asks for the newest state, or the state at a block height', async () => {
        const { apiPublicDataProvider } = await importProvider();
        const client = fakeClient();
        const provider: any = apiPublicDataProvider({ client, mjTypes, protocolVersion: V9 });

        expect(await provider.queryContractState(ADDRESS)).toEqual(stateRead('s12', 'p12'));
        expect(client.contractStateAt).toHaveBeenLastCalledWith({ address: ADDRESS, height: null });

        await provider.queryContractState(ADDRESS, { type: 'blockHeight', blockHeight: 9 });
        expect(client.contractStateAt).toHaveBeenLastCalledWith({ address: ADDRESS, height: 9 });
    });

    it('answers null for a contract the server does not know', async () => {
        const { apiPublicDataProvider } = await importProvider();
        const provider: any = apiPublicDataProvider({ client: fakeClient({ contractStateAt: vi.fn(async () => null) }), mjTypes, protocolVersion: V9 });
        expect(await provider.queryContractState(ADDRESS)).toBeNull();
        expect(await provider.queryZSwapAndContractState(ADDRESS)).toBeNull();
    });

    it('queryZSwapAndContractState returns zswap state, contract state and the block\'s ledger parameters, in the SDK\'s order', async () => {
        const { apiPublicDataProvider } = await importProvider();
        const provider: any = apiPublicDataProvider({ client: fakeClient(), mjTypes, protocolVersion: V9 });
        expect(await provider.queryZSwapAndContractState(ADDRESS)).toEqual({
            protocolVersion: V9,
            zswapChainState: { kind: 'zswap', era: 'v9', text: 'z12' },
            contractState: { kind: 'contract', era: 'v9', text: 's12' },
            ledgerParameters: { kind: 'params', era: 'v9', text: 'p12' }
        });
    });

    it('refuses a snapshot without ledger parameters instead of building with the wrong ones', async () => {
        const { apiPublicDataProvider } = await importProvider();
        const client = fakeClient({ contractStateAt: vi.fn(async () => ({ height: 12, state: b64('s'), zswapState: b64('z'), ledgerParameters: null })) });
        const provider: any = apiPublicDataProvider({ client, mjTypes, protocolVersion: V9 });
        await expect(provider.queryZSwapAndContractState(ADDRESS)).rejects.toThrow(/knows no ledgerParameters/);
    });

    it('a block hash is only read when queryBlock handed it out', async () => {
        const { apiPublicDataProvider } = await importProvider();
        const provider: any = apiPublicDataProvider({ client: fakeClient(), mjTypes, protocolVersion: V9 });
        await expect(provider.queryContractState(ADDRESS, { type: 'blockHash', blockHash: '0x1' })).rejects.toThrow(/not handed out by queryBlock/);
    });

    it('queryBlock pins the newest block and a state read by its hash asks for that height', async () => {
        const { apiPublicDataProvider } = await importProvider();
        const callFunction = vi.fn(async (name: string, params?: any) =>
            name === 'Blocks/latest' ? { hash: '0xAB20', height: 20 } : { hash: `ab${params.height}`, height: params.height });
        const client = fakeClient({ callFunction });
        const provider: any = apiPublicDataProvider({ client, mjTypes, protocolVersion: V9 });

        // The server answers 0x-prefixed upper or lower case. midnight-js needs the bare hex.
        expect(await provider.queryBlock()).toEqual({ hash: 'ab20', height: 20, protocolVersion: V9 });
        expect(await provider.queryBlock({ type: 'blockHash', blockHash: '0xAB20' })).toEqual({ hash: 'ab20', height: 20, protocolVersion: V9 });
        expect(await provider.queryBlock({ type: 'blockHash', blockHash: 'ab20' })).toEqual({ hash: 'ab20', height: 20, protocolVersion: V9 });
        // The newest pin reads the current state, so the server needs no indexer for it.
        await provider.queryZSwapAndContractState(ADDRESS, { type: 'blockHash', blockHash: 'ab20' });
        expect(client.contractStateAt).toHaveBeenLastCalledWith({ address: ADDRESS, height: null });

        expect(await provider.queryBlock({ type: 'blockHeight', blockHeight: 9 })).toEqual({ hash: 'ab9', height: 9, protocolVersion: V9 });
        expect(callFunction).toHaveBeenLastCalledWith('Blocks/byHeight', { height: 9 });
        expect(await provider.queryBlock({ type: 'blockHash', blockHash: 'ab9' })).toEqual({ hash: 'ab9', height: 9, protocolVersion: V9 });
        await provider.queryContractState(ADDRESS, { type: 'blockHash', blockHash: 'ab9' });
        expect(client.contractStateAt).toHaveBeenLastCalledWith({ address: ADDRESS, height: 9 });

        // A newer pin replaces the old one, which then reads at its own height.
        callFunction.mockImplementationOnce(async () => ({ hash: 'ab21', height: 21 }));
        await provider.queryBlock();
        await provider.queryContractState(ADDRESS, { type: 'blockHash', blockHash: 'ab20' });
        expect(client.contractStateAt).toHaveBeenLastCalledWith({ address: ADDRESS, height: 20 });
    });

    it('queryBlock answers null for an unknown height and names the missing crawler when the server has no block at all', async () => {
        const { apiPublicDataProvider } = await importProvider();
        const missing = Object.assign(new Error('not found'), { status: 404 });
        const provider: any = apiPublicDataProvider({ client: fakeClient({ callFunction: vi.fn(async () => { throw missing; }) }), mjTypes, protocolVersion: V9 });
        expect(await provider.queryBlock({ type: 'blockHeight', blockHeight: 9 })).toBeNull();
        await expect(provider.queryBlock()).rejects.toThrow(/no indexed block yet.*crawler runs/);
    });
});

describe('apiPublicDataProvider: the deploy', () => {
    it('queryDeployContractState reads the state at the deploy\'s block', async () => {
        const { apiPublicDataProvider } = await importProvider();
        const client = fakeClient();
        const provider: any = apiPublicDataProvider({ client, mjTypes, protocolVersion: V9 });
        expect(await provider.queryDeployContractState(ADDRESS)).toEqual(stateRead('s12', 'p12'));
        expect(client.contractStateAt).toHaveBeenLastCalledWith({ address: ADDRESS, height: 7 });
    });

    it('watchForDeployTxData maps the server\'s result status to the SDK\'s names and waits for an unindexed deploy', async () => {
        const { apiPublicDataProvider } = await importProvider();
        const deploy = { txHash: '0xdeploy', ledgerTxHash: 'de01', blockHeight: 7, blockHash: '0xb7', status: 'PARTIAL_SUCCESS', failedSegments: [1], identifiers: ['id0'], txId: 'id0' };
        const contractDeploy = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(deploy);
        const provider: any = apiPublicDataProvider({ client: fakeClient({ contractDeploy }), mjTypes, protocolVersion: V9, pollMs: 1 });
        const data = await provider.watchForDeployTxData(ADDRESS);
        expect(contractDeploy).toHaveBeenCalledTimes(2);
        expect(data).toEqual(expect.objectContaining({ era: 'v9', status: 'FailFallible', txId: 'id0', txHash: 'de01', blockHeight: 7, blockHash: '0xb7', tx: { era: 'v9', stage: 'Finalized', text: 'tx' } }));
    });

    it('watchForDeployTxData falls back to the stored hash while the ledger hash is unknown', async () => {
        const { apiPublicDataProvider } = await importProvider();
        const deploy = { txHash: '0xdeploy', ledgerTxHash: null, blockHeight: 7, blockHash: '0xb7', status: 'SUCCESS', failedSegments: [], identifiers: ['id0'], txId: 'id0' };
        const provider: any = apiPublicDataProvider({ client: fakeClient({ contractDeploy: vi.fn(async () => deploy) }), mjTypes, protocolVersion: V9, pollMs: 1 });
        expect(await provider.watchForDeployTxData(ADDRESS)).toEqual(expect.objectContaining({ txHash: '0xdeploy' }));
    });

    it('a deploy without a ledger transaction on the server is an error, not a record', async () => {
        const { apiPublicDataProvider } = await importProvider();
        const provider: any = apiPublicDataProvider({ client: fakeClient({ ledgerTransaction: vi.fn(async () => null) }), mjTypes, protocolVersion: V9, pollMs: 1 });
        await expect(provider.watchForDeployTxData(ADDRESS)).rejects.toThrow(/holds no ledger transaction/);
    });

    it('gives up waiting after watchTimeoutMs', async () => {
        const { apiPublicDataProvider } = await importProvider();
        const provider: any = apiPublicDataProvider({ client: fakeClient({ contractDeploy: vi.fn(async () => null) }), mjTypes, protocolVersion: V9, pollMs: 1, watchTimeoutMs: 5 });
        await expect(provider.watchForDeployTxData(ADDRESS)).rejects.toThrow(/not indexed by the NIGHTGATE server within 5ms/);
    });
});

describe('apiPublicDataProvider: what a build-only provider does not do', () => {
    it('the submit-side methods throw, with the reason', async () => {
        const { apiPublicDataProvider } = await importProvider();
        const provider: any = apiPublicDataProvider({ client: fakeClient(), mjTypes, protocolVersion: V9 });
        for (const method of ['watchForTxData', 'queryUnshieldedBalances', 'watchForUnshieldedBalances', 'contractStateObservable', 'unshieldedBalancesObservable']) {
            expect(() => provider[method]()).toThrow(/never submits itself/);
        }
    });

    it('requires a client, the record types and a protocol version', async () => {
        const { apiPublicDataProvider } = await importProvider();
        expect(() => apiPublicDataProvider({ mjTypes, protocolVersion: V9 } as any)).toThrow(/client is required/);
        expect(() => apiPublicDataProvider({ client: fakeClient() } as any)).toThrow(/mjTypes module/);
        expect(() => apiPublicDataProvider({ client: fakeClient(), mjTypes } as any)).toThrow(/protocolVersion must be/);
    });
});

describe('apiClientFor and buildOnlySubmissionService', () => {
    it('takes a connected client as it is and builds one from connect() options', async () => {
        const { apiClientFor } = await importProvider();
        const client = fakeClient();
        expect(apiClientFor(client)).toBe(client);
        const built: any = apiClientFor({ baseUrl: 'https://ng.example' });
        expect(typeof built.contractStateAt).toBe('function');
        expect(typeof built.sponsorUnbound).toBe('function');
        expect(() => apiClientFor({} as any)).toThrow(/options for connect\(\)/);
    });

    it('the build-only submission service refuses to submit and closes without a connection', async () => {
        const { buildOnlySubmissionService } = await importProvider();
        const service = buildOnlySubmissionService()({});
        await expect(service.submitTransaction()).rejects.toThrow(/never submits/);
        await expect(service.close()).resolves.toBeUndefined();
    });
});

describe('apiPublicDataProvider: a stale database is refused', () => {
    it('refuses a state when the server is more than maxLagBlocks behind the chain, and serves it within the allowance', async () => {
        const { apiPublicDataProvider } = await importProvider();
        const stale = fakeClient({ contractStateAt: vi.fn(async () => ({ height: 12, state: b64('s'), zswapState: b64('z'), ledgerParameters: b64('p'), coveredHeight: 100, chainHeight: 131 })) });
        const provider: any = apiPublicDataProvider({ client: stale, mjTypes, protocolVersion: V9, maxLagBlocks: 30 });
        await expect(provider.queryZSwapAndContractState(ADDRESS)).rejects.toThrow(/31 blocks behind, allowed 30/);
        const within: any = apiPublicDataProvider({ client: stale, mjTypes, protocolVersion: V9, maxLagBlocks: 31 });
        await expect(within.queryContractState(ADDRESS)).resolves.toEqual(stateRead('s', 'p'));
    });

    it('allows 60 blocks by default, the normal trailing distance with a margin', async () => {
        const { apiPublicDataProvider } = await importProvider();
        const at = (chainHeight: number) => fakeClient({ contractStateAt: vi.fn(async () => ({ height: 12, state: b64('s'), zswapState: b64('z'), ledgerParameters: b64('p'), coveredHeight: 100, chainHeight })) });
        await expect((apiPublicDataProvider({ client: at(160), mjTypes, protocolVersion: V9 }) as any).queryContractState(ADDRESS)).resolves.toEqual(stateRead('s', 'p'));
        await expect((apiPublicDataProvider({ client: at(161), mjTypes, protocolVersion: V9 }) as any).queryContractState(ADDRESS)).rejects.toThrow(/61 blocks behind, allowed 60/);
    });

    it('a snapshot without coverage figures is served as it is', async () => {
        const { apiPublicDataProvider } = await importProvider();
        const provider: any = apiPublicDataProvider({ client: fakeClient(), mjTypes, protocolVersion: V9, maxLagBlocks: 0 });
        await expect(provider.queryContractState(ADDRESS)).resolves.toEqual(stateRead('s12', 'p12'));
    });

    it('maxLagBlocks must be a non-negative integer', async () => {
        const { apiPublicDataProvider } = await importProvider();
        expect(() => apiPublicDataProvider({ client: fakeClient(), mjTypes, protocolVersion: V9, maxLagBlocks: -1 })).toThrow(/non-negative integer/);
    });
});
