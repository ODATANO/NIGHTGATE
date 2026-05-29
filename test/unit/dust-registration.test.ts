/**
 * Tests for srv/submission/dust-registration.ts (Phase 2a).
 *
 * Post-Phase-2a, dust-registration is a thin wrapper around a single
 * `walletRegisterDustGeneration(...)` RPC to the wallet worker. The worker
 * owns the SDK and executes the full flow (wait-sync, filter, register,
 * finalize, submit) without crossing thread boundaries with SDK objects.
 * Tests here just verify the argument mapping + result pass-through.
 */

const walletRegisterDustGeneration = jest.fn();
const walletDeregisterDustGeneration = jest.fn();

jest.mock('../../srv/midnight/wallet-worker-client', () => ({
    walletRegisterDustGeneration:   (...args: unknown[]) => walletRegisterDustGeneration(...args),
    walletDeregisterDustGeneration: (...args: unknown[]) => walletDeregisterDustGeneration(...args)
}));

import { registerNightUtxosForDust, deregisterNightUtxosFromDust } from '../../srv/submission/dust-registration';

const FACADE_CONFIG = {
    networkId: 'preprod' as const,
    indexerHttpUrl: 'https://indexer.preprod.midnight.network/api/v4/graphql',
    indexerWsUrl:   'wss://indexer.preprod.midnight.network/api/v4/graphql/ws',
    proofServerUrl: 'http://localhost:6300',
    relayUrl:       'wss://rpc.preprod.midnight.network/'
};

const SEED_HEX = 'a'.repeat(64);

beforeEach(() => {
    walletRegisterDustGeneration.mockReset();
    walletDeregisterDustGeneration.mockReset();
});

describe('registerNightUtxosForDust', () => {
    test('passes cacheKey + dustReceiverAddress through to worker RPC', async () => {
        walletRegisterDustGeneration.mockResolvedValueOnce({
            txId: null,
            registeredCount: 0,
            totalNightUtxos: 2,
            dustReceiverAddress: 'dust1-self'
        });

        const result = await registerNightUtxosForDust({
            cacheKey: 'acc-1',
            seedHex: SEED_HEX,
            facadeConfig: FACADE_CONFIG,
            dustReceiverAddress: 'dust1-custom'
        });

        expect(walletRegisterDustGeneration).toHaveBeenCalledWith({
            sessionId:           'acc-1',
            dustReceiverAddress: 'dust1-custom',
            syncTimeoutMs:       undefined
        });
        expect(result).toEqual({
            txId: null,
            registeredCount: 0,
            totalNightUtxos: 2,
            dustReceiverAddress: 'dust1-self'
        });
    });

    test('forwards syncTimeoutMs when supplied', async () => {
        walletRegisterDustGeneration.mockResolvedValueOnce({
            txId: 'tx-abc',
            registeredCount: 3,
            totalNightUtxos: 3,
            dustReceiverAddress: 'dust1-self'
        });

        const result = await registerNightUtxosForDust({
            cacheKey: 'acc-2',
            seedHex: SEED_HEX,
            facadeConfig: FACADE_CONFIG,
            syncTimeoutMs: 90_000
        });

        expect(walletRegisterDustGeneration).toHaveBeenCalledWith({
            sessionId:           'acc-2',
            dustReceiverAddress: undefined,
            syncTimeoutMs:       90_000
        });
        expect(result.txId).toBe('tx-abc');
        expect(result.registeredCount).toBe(3);
    });

    test('propagates worker errors to caller', async () => {
        walletRegisterDustGeneration.mockRejectedValueOnce(new Error('boom: sync timeout'));

        await expect(registerNightUtxosForDust({
            cacheKey: 'acc-3',
            seedHex: SEED_HEX,
            facadeConfig: FACADE_CONFIG
        })).rejects.toThrow('boom: sync timeout');
    });

    test('returns worker result unchanged', async () => {
        const workerResult = {
            txId: 'tx-xyz-789',
            registeredCount: 2,
            totalNightUtxos: 5,
            dustReceiverAddress: 'dust1-relayed-elsewhere'
        };
        walletRegisterDustGeneration.mockResolvedValueOnce(workerResult);

        const result = await registerNightUtxosForDust({
            cacheKey: 'acc-4',
            seedHex: SEED_HEX,
            facadeConfig: FACADE_CONFIG,
            dustReceiverAddress: 'dust1-relayed-elsewhere'
        });

        expect(result).toStrictEqual(workerResult);
    });
});

describe('deregisterNightUtxosFromDust', () => {
    test('forwards cacheKey as sessionId to the worker RPC', async () => {
        walletDeregisterDustGeneration.mockResolvedValueOnce({
            txId: 'tx-de-1',
            deregisteredCount: 3,
            totalNightUtxos: 3
        });

        const result = await deregisterNightUtxosFromDust({ cacheKey: 'acc-d-1' });

        expect(walletDeregisterDustGeneration).toHaveBeenCalledWith({
            sessionId:     'acc-d-1',
            syncTimeoutMs: undefined
        });
        expect(result).toEqual({
            txId: 'tx-de-1',
            deregisteredCount: 3,
            totalNightUtxos: 3
        });
    });

    test('forwards syncTimeoutMs when supplied', async () => {
        walletDeregisterDustGeneration.mockResolvedValueOnce({
            txId: null,
            deregisteredCount: 0,
            totalNightUtxos: 0
        });

        const result = await deregisterNightUtxosFromDust({
            cacheKey:      'acc-d-2',
            syncTimeoutMs: 30_000
        });

        expect(walletDeregisterDustGeneration).toHaveBeenCalledWith({
            sessionId:     'acc-d-2',
            syncTimeoutMs: 30_000
        });
        expect(result.txId).toBeNull();
    });

    test('propagates worker errors to caller', async () => {
        walletDeregisterDustGeneration.mockRejectedValueOnce(new Error('boom: no facade'));

        await expect(deregisterNightUtxosFromDust({ cacheKey: 'acc-d-3' }))
            .rejects.toThrow('boom: no facade');
    });

    test('passes through txId:null no-op when nothing to deregister', async () => {
        const workerResult = {
            txId: null,
            deregisteredCount: 0,
            totalNightUtxos: 0
        };
        walletDeregisterDustGeneration.mockResolvedValueOnce(workerResult);

        const result = await deregisterNightUtxosFromDust({ cacheKey: 'acc-d-4' });
        expect(result).toStrictEqual(workerResult);
    });
});
