/**
 * Tests for srv/submission/token-ops.ts — the thin wrapper layer that
 * orchestrates `sendNight` (and later shield/unshield) through the worker
 * RPC. Same mock pattern as dust-registration.test.ts: stub the
 * wallet-worker-client export, assert argument shape + result pass-through.
 *
 * Address-parsing + amount-validation live in the handler
 * (srv/sessions/wallet-sessions.ts) and on the worker; not exercised here.
 */

const walletTransferNight = jest.fn();

jest.mock('../../srv/midnight/wallet-worker-client', () => ({
    walletTransferNight: (...args: unknown[]) => walletTransferNight(...args)
}));

import { sendNight } from '../../srv/submission/token-ops';

beforeEach(() => {
    walletTransferNight.mockReset();
});

describe('sendNight', () => {
    test('forwards all args to walletTransferNight with cacheKey → sessionId remap', async () => {
        walletTransferNight.mockResolvedValueOnce({
            txId: 'tx-1',
            toLedger: 'unshielded',
            amount: '1000000',
            receiverAddress: 'mn_addr_preprod1xyz'
        });

        const result = await sendNight({
            cacheKey:        'acc-A',
            receiverAddress: 'mn_addr_preprod1xyz',
            amount:          '1000000',
            ttlIso:          '2026-12-31T00:00:00Z',
            syncTimeoutMs:   60000
        });

        expect(walletTransferNight).toHaveBeenCalledWith({
            sessionId:       'acc-A',
            receiverAddress: 'mn_addr_preprod1xyz',
            amount:          '1000000',
            ttlIso:          '2026-12-31T00:00:00Z',
            syncTimeoutMs:   60000
        });
        expect(result).toMatchObject({
            txId: 'tx-1',
            toLedger: 'unshielded',
            amount: '1000000',
            receiverAddress: 'mn_addr_preprod1xyz'
        });
    });

    test('omits ttlIso and syncTimeoutMs when not supplied', async () => {
        walletTransferNight.mockResolvedValueOnce({
            txId: 'tx-2',
            toLedger: 'shielded',
            amount: '500',
            receiverAddress: 'mn_shield-addr_preprod1abc'
        });

        await sendNight({
            cacheKey:        'acc-B',
            receiverAddress: 'mn_shield-addr_preprod1abc',
            amount:          '500'
        });

        expect(walletTransferNight).toHaveBeenCalledWith({
            sessionId:       'acc-B',
            receiverAddress: 'mn_shield-addr_preprod1abc',
            amount:          '500',
            ttlIso:          undefined,
            syncTimeoutMs:   undefined
        });
    });

    test('propagates worker errors to caller', async () => {
        walletTransferNight.mockRejectedValueOnce(new Error('Wallet.InsufficientFunds'));

        await expect(sendNight({
            cacheKey:        'acc-C',
            receiverAddress: 'mn_addr_preprod1abc',
            amount:          '999999999999'
        })).rejects.toThrow('Wallet.InsufficientFunds');
    });

    test('returns worker result unchanged for shielded transfer', async () => {
        const workerResult = {
            txId: 'tx-shielded-1',
            toLedger: 'shielded' as const,
            amount: '100',
            receiverAddress: 'mn_shield-addr_preprod1long...'
        };
        walletTransferNight.mockResolvedValueOnce(workerResult);

        const result = await sendNight({
            cacheKey:        'acc-D',
            receiverAddress: 'mn_shield-addr_preprod1long...',
            amount:          '100'
        });

        expect(result).toStrictEqual(workerResult);
    });
});
