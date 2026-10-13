/**
 * The midnight-js PublicDataProvider over the NIGHTGATE API (`src/txbuilder/api-provider.mjs`).
 * The server client and the ledger module are stubs; what is asserted is which read answers which SDK call.
 */

import { describe, it, expect, vi } from 'vitest';

const importProvider = () => import('../../src/txbuilder/api-provider.mjs' as string);

const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');
const ADDRESS = 'ab'.repeat(32);

/** A ledger whose deserialize returns the bytes as text, so the test can see what was fed in. */
const ledger = {
    ContractState: { deserialize: (raw: Uint8Array) => ({ kind: 'contract', text: Buffer.from(raw).toString('utf8') }) },
    ZswapChainState: { deserialize: (raw: Uint8Array) => ({ kind: 'zswap', text: Buffer.from(raw).toString('utf8') }) },
    LedgerParameters: { deserialize: (raw: Uint8Array) => ({ kind: 'params', text: Buffer.from(raw).toString('utf8') }) }
};

function fakeClient(over: Record<string, any> = {}) {
    return {
        contractStateAt: vi.fn(async () => ({ address: ADDRESS, height: 12, state: b64('s12'), zswapState: b64('z12'), ledgerParameters: b64('p12'), blockHash: '0xb12' })),
        transactionByIdentifier: vi.fn(async () => null),
        contractDeploy: vi.fn(async () => ({ txHash: '0xdeploy', blockHeight: 7, blockHash: '0xb7', status: 'SUCCESS', failedSegments: [], identifiers: ['id0', 'id1'], txId: 'id1' })),
        ...over
    };
}

describe('apiPublicDataProvider: contract state', () => {
    it('queryContractState asks for the newest state, or the state at a block height', async () => {
        const { apiPublicDataProvider } = await importProvider();
        const client = fakeClient();
        const provider: any = apiPublicDataProvider({ client, ledger });

        expect(await provider.queryContractState(ADDRESS)).toEqual({ kind: 'contract', text: 's12' });
        expect(client.contractStateAt).toHaveBeenLastCalledWith({ address: ADDRESS, height: null });

        await provider.queryContractState(ADDRESS, { type: 'blockHeight', blockHeight: 9 });
        expect(client.contractStateAt).toHaveBeenLastCalledWith({ address: ADDRESS, height: 9 });
    });

    it('answers null for a contract the server does not know', async () => {
        const { apiPublicDataProvider } = await importProvider();
        const provider: any = apiPublicDataProvider({ client: fakeClient({ contractStateAt: vi.fn(async () => null) }), ledger });
        expect(await provider.queryContractState(ADDRESS)).toBeNull();
        expect(await provider.queryZSwapAndContractState(ADDRESS)).toBeNull();
    });

    it('queryZSwapAndContractState returns zswap state, contract state and the block\'s ledger parameters, in the SDK\'s order', async () => {
        const { apiPublicDataProvider } = await importProvider();
        const provider: any = apiPublicDataProvider({ client: fakeClient(), ledger });
        expect(await provider.queryZSwapAndContractState(ADDRESS)).toEqual([
            { kind: 'zswap', text: 'z12' }, { kind: 'contract', text: 's12' }, { kind: 'params', text: 'p12' }
        ]);
    });

    it('refuses a snapshot without ledger parameters instead of building with the wrong ones', async () => {
        const { apiPublicDataProvider } = await importProvider();
        const client = fakeClient({ contractStateAt: vi.fn(async () => ({ height: 12, state: b64('s'), zswapState: b64('z'), ledgerParameters: null })) });
        const provider: any = apiPublicDataProvider({ client, ledger });
        await expect(provider.queryZSwapAndContractState(ADDRESS)).rejects.toThrow(/knows no ledgerParameters/);
    });

    it('only block heights are supported as a query offset', async () => {
        const { apiPublicDataProvider } = await importProvider();
        const provider: any = apiPublicDataProvider({ client: fakeClient(), ledger });
        await expect(provider.queryContractState(ADDRESS, { type: 'blockHash', blockHash: '0x1' })).rejects.toThrow(/by block height/);
    });
});

describe('apiPublicDataProvider: the deploy', () => {
    it('queryDeployContractState reads the state at the deploy\'s block', async () => {
        const { apiPublicDataProvider } = await importProvider();
        const client = fakeClient();
        const provider: any = apiPublicDataProvider({ client, ledger });
        expect(await provider.queryDeployContractState(ADDRESS)).toEqual({ kind: 'contract', text: 's12' });
        expect(client.contractStateAt).toHaveBeenLastCalledWith({ address: ADDRESS, height: 7 });
    });

    it('watchForDeployTxData maps the server\'s result status to the SDK\'s names and waits for an unindexed deploy', async () => {
        const { apiPublicDataProvider } = await importProvider();
        const deploy = { txHash: '0xdeploy', blockHeight: 7, blockHash: '0xb7', status: 'PARTIAL_SUCCESS', failedSegments: [1], identifiers: ['id0'], txId: 'id0' };
        const contractDeploy = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(deploy);
        const provider: any = apiPublicDataProvider({ client: fakeClient({ contractDeploy }), ledger, pollMs: 1 });
        const data = await provider.watchForDeployTxData(ADDRESS);
        expect(contractDeploy).toHaveBeenCalledTimes(2);
        expect(data).toEqual(expect.objectContaining({ status: 'FailFallible', txId: 'id0', txHash: '0xdeploy', blockHeight: 7, blockHash: '0xb7' }));
    });

    it('gives up waiting after watchTimeoutMs', async () => {
        const { apiPublicDataProvider } = await importProvider();
        const provider: any = apiPublicDataProvider({ client: fakeClient({ contractDeploy: vi.fn(async () => null) }), ledger, pollMs: 1, watchTimeoutMs: 5 });
        await expect(provider.watchForDeployTxData(ADDRESS)).rejects.toThrow(/not indexed by the NIGHTGATE server within 5ms/);
    });
});

describe('apiPublicDataProvider: what a build-only provider does not do', () => {
    it('the submit-side methods throw, with the reason', async () => {
        const { apiPublicDataProvider } = await importProvider();
        const provider: any = apiPublicDataProvider({ client: fakeClient(), ledger });
        for (const method of ['watchForTxData', 'queryUnshieldedBalances', 'watchForUnshieldedBalances', 'contractStateObservable', 'unshieldedBalancesObservable']) {
            expect(() => provider[method]()).toThrow(/never submits itself/);
        }
    });

    it('requires a client and a ledger module', async () => {
        const { apiPublicDataProvider } = await importProvider();
        expect(() => apiPublicDataProvider({ ledger } as any)).toThrow(/client is required/);
        expect(() => apiPublicDataProvider({ client: fakeClient() } as any)).toThrow(/ledger module is required/);
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
        const provider: any = apiPublicDataProvider({ client: stale, ledger, maxLagBlocks: 30 });
        await expect(provider.queryZSwapAndContractState(ADDRESS)).rejects.toThrow(/31 blocks behind, allowed 30/);
        const within: any = apiPublicDataProvider({ client: stale, ledger, maxLagBlocks: 31 });
        await expect(within.queryContractState(ADDRESS)).resolves.toEqual({ kind: 'contract', text: 's' });
    });

    it('allows 60 blocks by default, the normal trailing distance with a margin', async () => {
        const { apiPublicDataProvider } = await importProvider();
        const at = (chainHeight: number) => fakeClient({ contractStateAt: vi.fn(async () => ({ height: 12, state: b64('s'), zswapState: b64('z'), ledgerParameters: b64('p'), coveredHeight: 100, chainHeight })) });
        await expect((apiPublicDataProvider({ client: at(160), ledger }) as any).queryContractState(ADDRESS)).resolves.toEqual({ kind: 'contract', text: 's' });
        await expect((apiPublicDataProvider({ client: at(161), ledger }) as any).queryContractState(ADDRESS)).rejects.toThrow(/61 blocks behind, allowed 60/);
    });

    it('a snapshot without coverage figures is served as it is', async () => {
        const { apiPublicDataProvider } = await importProvider();
        const provider: any = apiPublicDataProvider({ client: fakeClient(), ledger, maxLagBlocks: 0 });
        await expect(provider.queryContractState(ADDRESS)).resolves.toEqual({ kind: 'contract', text: 's12' });
    });

    it('maxLagBlocks must be a non-negative integer', async () => {
        const { apiPublicDataProvider } = await importProvider();
        expect(() => apiPublicDataProvider({ client: fakeClient(), ledger, maxLagBlocks: -1 })).toThrow(/non-negative integer/);
    });
});
