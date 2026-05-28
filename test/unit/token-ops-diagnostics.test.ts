/**
 * Tests for the diagnostics wrappers in srv/submission/token-ops.ts:
 * getWalletBalance, estimateSendNightFee, estimateShieldFee, estimateUnshieldFee.
 * Same mock pattern: stub wallet-worker-client exports, assert argument
 * shape + result pass-through.
 */

const walletGetBalance         = jest.fn();
const walletEstimateTransferFee = jest.fn();
const walletEstimateSwapFee    = jest.fn();

jest.mock('../../srv/midnight/wallet-worker-client', () => ({
    walletGetBalance:           (...args: unknown[]) => walletGetBalance(...args),
    walletEstimateTransferFee:  (...args: unknown[]) => walletEstimateTransferFee(...args),
    walletEstimateSwapFee:      (...args: unknown[]) => walletEstimateSwapFee(...args)
}));

import {
    getWalletBalance,
    estimateSendNightFee,
    estimateShieldFee,
    estimateUnshieldFee
} from '../../srv/submission/token-ops';

beforeEach(() => {
    walletGetBalance.mockReset();
    walletEstimateTransferFee.mockReset();
    walletEstimateSwapFee.mockReset();
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

describe('estimateUnshieldFee / estimateShieldFee', () => {
    test('estimateUnshieldFee forwards direction="unshield"', async () => {
        walletEstimateSwapFee.mockResolvedValueOnce({ fee: '7777', direction: 'unshield' });

        const result = await estimateUnshieldFee({ cacheKey: 'acc-est-u', amount: '50000' });

        expect(walletEstimateSwapFee).toHaveBeenCalledWith({
            sessionId:     'acc-est-u',
            direction:     'unshield',
            amount:        '50000',
            ttlIso:        undefined,
            syncTimeoutMs: undefined
        });
        expect(result).toEqual({ fee: '7777', direction: 'unshield' });
    });

    test('estimateShieldFee forwards direction="shield"', async () => {
        walletEstimateSwapFee.mockResolvedValueOnce({ fee: '8888', direction: 'shield' });

        const result = await estimateShieldFee({
            cacheKey:      'acc-est-s',
            amount:        '50000',
            ttlIso:        '2026-12-31T00:00:00Z',
            syncTimeoutMs: 30000
        });

        expect(walletEstimateSwapFee).toHaveBeenCalledWith({
            sessionId:     'acc-est-s',
            direction:     'shield',
            amount:        '50000',
            ttlIso:        '2026-12-31T00:00:00Z',
            syncTimeoutMs: 30000
        });
        expect(result.direction).toBe('shield');
    });

    test('propagates worker errors (InsufficientFunds, etc.)', async () => {
        walletEstimateSwapFee.mockRejectedValueOnce(new Error('Wallet.InsufficientFunds'));
        await expect(estimateUnshieldFee({ cacheKey: 'acc-fail', amount: '999999999999' }))
            .rejects.toThrow('Wallet.InsufficientFunds');
    });
});
