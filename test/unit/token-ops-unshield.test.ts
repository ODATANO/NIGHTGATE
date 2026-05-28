/**
 * Tests for srv/submission/token-ops.ts::unshieldFunds — the shielded→
 * unshielded ledger-shift wrapper. Same mock pattern as the other
 * token-ops tests.
 */

const walletUnshieldNight = jest.fn();

jest.mock('../../srv/midnight/wallet-worker-client', () => ({
    walletUnshieldNight: (...args: unknown[]) => walletUnshieldNight(...args)
}));

import { unshieldFunds } from '../../srv/submission/token-ops';

beforeEach(() => { walletUnshieldNight.mockReset(); });

describe('unshieldFunds', () => {
    test('forwards args with cacheKey remapped to sessionId', async () => {
        walletUnshieldNight.mockResolvedValueOnce({
            txId: 'tx-u-1',
            amount: '500000',
            unshieldedReceiverAddress: 'mn_addr_preprod1own'
        });

        const result = await unshieldFunds({
            cacheKey:      'acc-u-A',
            amount:        '500000',
            ttlIso:        '2026-12-31T00:00:00Z',
            syncTimeoutMs: 90000
        });

        expect(walletUnshieldNight).toHaveBeenCalledWith({
            sessionId:     'acc-u-A',
            amount:        '500000',
            ttlIso:        '2026-12-31T00:00:00Z',
            syncTimeoutMs: 90000
        });
        expect(result).toEqual({
            txId: 'tx-u-1',
            amount: '500000',
            unshieldedReceiverAddress: 'mn_addr_preprod1own'
        });
    });

    test('omits ttlIso and syncTimeoutMs when not supplied', async () => {
        walletUnshieldNight.mockResolvedValueOnce({
            txId: 'tx-u-2',
            amount: '1',
            unshieldedReceiverAddress: 'mn_addr_preprod1minimal'
        });

        await unshieldFunds({ cacheKey: 'acc-u-B', amount: '1' });

        expect(walletUnshieldNight).toHaveBeenCalledWith({
            sessionId:     'acc-u-B',
            amount:        '1',
            ttlIso:        undefined,
            syncTimeoutMs: undefined
        });
    });

    test('propagates worker errors (e.g. InsufficientFunds)', async () => {
        walletUnshieldNight.mockRejectedValueOnce(new Error('Wallet.InsufficientFunds'));

        await expect(unshieldFunds({ cacheKey: 'acc-u-C', amount: '99999999' }))
            .rejects.toThrow('Wallet.InsufficientFunds');
    });
});
