/**
 * Tests for the diagnostics wrappers in srv/submission/token-ops.ts:
 * getWalletBalance, estimateSendNightFee.
 * Same mock pattern: stub wallet-worker-client exports, assert argument
 * shape + result pass-through.
 */

const walletGetBalance         = vi.hoisted(() => (vi.fn()));
const walletEstimateTransferFee = vi.hoisted(() => (vi.fn()));

vi.mock('../../srv/midnight/wallet-worker-client', () => ({
    walletGetBalance:           (...args: unknown[]) => walletGetBalance(...args),
    walletEstimateTransferFee:  (...args: unknown[]) => walletEstimateTransferFee(...args)
}));

import {
    getWalletBalance,
    estimateSendNightFee
} from '../../srv/submission/token-ops';

beforeEach(() => {
    walletGetBalance.mockReset();
    walletEstimateTransferFee.mockReset();
});

describe('getWalletBalance', () => {
    test('forwards cacheKey as sessionId, passes through worker result', async () => {
        const workerResult = {
            shieldedNight: '1000000000000',
            unshieldedNight: '0',
            dustBalance: '2098000',
            registeredNightUtxoCount: 1,
            totalNightUtxoCount: 1
        };
        walletGetBalance.mockResolvedValueOnce(workerResult);

        const result = await getWalletBalance({ cacheKey: 'acc-b1' });

        expect(walletGetBalance).toHaveBeenCalledWith({
            sessionId:     'acc-b1',
            syncTimeoutMs: undefined
        });
        expect(result).toStrictEqual(workerResult);
    });

    test('forwards syncTimeoutMs when supplied', async () => {
        walletGetBalance.mockResolvedValueOnce({
            shieldedNight: '0', unshieldedNight: '0', dustBalance: '0',
            registeredNightUtxoCount: 0, totalNightUtxoCount: 0
        });
        await getWalletBalance({ cacheKey: 'acc-b2', syncTimeoutMs: 5000 });
        expect(walletGetBalance.mock.calls[0][0].syncTimeoutMs).toBe(5000);
    });

    test('propagates worker errors', async () => {
        walletGetBalance.mockRejectedValueOnce(new Error('boom: no facade'));
        await expect(getWalletBalance({ cacheKey: 'acc-b3' })).rejects.toThrow('boom: no facade');
    });
});

describe('estimateSendNightFee', () => {
    test('forwards args and returns fee + toLedger', async () => {
        walletEstimateTransferFee.mockResolvedValueOnce({ fee: '12345', toLedger: 'unshielded' });

        const result = await estimateSendNightFee({
            cacheKey:        'acc-est-1',
            receiverAddress: 'mn_addr_preprod1abc',
            amount:          '1000000',
            ttlIso:          '2026-12-31T00:00:00Z'
        });

        expect(walletEstimateTransferFee).toHaveBeenCalledWith({
            sessionId:       'acc-est-1',
            receiverAddress: 'mn_addr_preprod1abc',
            amount:          '1000000',
            ttlIso:          '2026-12-31T00:00:00Z',
            syncTimeoutMs:   undefined
        });
        expect(result).toEqual({ fee: '12345', toLedger: 'unshielded' });
    });

    test('shielded ledger pass-through', async () => {
        walletEstimateTransferFee.mockResolvedValueOnce({ fee: '54321', toLedger: 'shielded' });
        const result = await estimateSendNightFee({
            cacheKey:        'acc-est-2',
            receiverAddress: 'mn_shield-addr_preprod1xyz',
            amount:          '100'
        });
        expect(result.toLedger).toBe('shielded');
    });
});
