/**
 * Tests for srv/submission/token-ops.ts::shieldFunds — the unshielded→
 * shielded ledger-shift wrapper. Symmetric to token-ops-unshield.test.ts.
 */

const walletShieldNight = vi.hoisted(() => (vi.fn()));

vi.mock('../../srv/midnight/wallet-worker-client', () => ({
    walletShieldNight: (...args: unknown[]) => walletShieldNight(...args)
}));

import { shieldFunds } from '../../srv/submission/token-ops';

beforeEach(() => { walletShieldNight.mockReset(); });

describe('shieldFunds', () => {
    test('forwards args with cacheKey remapped to sessionId', async () => {
        walletShieldNight.mockResolvedValueOnce({
            txId: 'tx-s-1',
            amount: '500000',
            shieldedReceiverAddress: 'mn_shield-addr_preprod1own'
        });

        const result = await shieldFunds({
            cacheKey:      'acc-s-A',
            amount:        '500000',
            ttlIso:        '2026-12-31T00:00:00Z',
            syncTimeoutMs: 90000
        });

        expect(walletShieldNight).toHaveBeenCalledWith({
            sessionId:     'acc-s-A',
            amount:        '500000',
            ttlIso:        '2026-12-31T00:00:00Z',
            syncTimeoutMs: 90000
        });
        expect(result).toEqual({
            txId: 'tx-s-1',
            amount: '500000',
            shieldedReceiverAddress: 'mn_shield-addr_preprod1own'
        });
    });

    test('omits ttlIso and syncTimeoutMs when not supplied', async () => {
        walletShieldNight.mockResolvedValueOnce({
            txId: 'tx-s-2',
            amount: '1',
            shieldedReceiverAddress: 'mn_shield-addr_preprod1minimal'
        });

        await shieldFunds({ cacheKey: 'acc-s-B', amount: '1' });

        expect(walletShieldNight).toHaveBeenCalledWith({
            sessionId:     'acc-s-B',
            amount:        '1',
            ttlIso:        undefined,
            syncTimeoutMs: undefined
        });
    });

    test('propagates worker errors', async () => {
        walletShieldNight.mockRejectedValueOnce(new Error('Wallet.InsufficientFunds'));

        await expect(shieldFunds({ cacheKey: 'acc-s-C', amount: '99999999' }))
            .rejects.toThrow('Wallet.InsufficientFunds');
    });
});
