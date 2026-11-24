/**
 * The main-thread functions that hand token sends, wallet diagnostics and dust registration to the wallet worker:
 * each renames the account key to the worker's `sessionId` and passes the rest on.
 */

const worker = vi.hoisted(() => ({
    walletTransferToken: vi.fn(), walletGetBalance: vi.fn(), walletEstimateTransferFee: vi.fn(),
    walletRegisterDustGeneration: vi.fn(), walletDeregisterDustGeneration: vi.fn()
}));
vi.mock('../../srv/midnight/wallet-worker-client', () => worker);

import { sendToken, getWalletBalance, estimateSendTokenFee } from '../../srv/submission/token-ops';
import { registerNightUtxosForDust, deregisterNightUtxosFromDust } from '../../srv/submission/dust-registration';

const hook = async () => undefined;

beforeEach(() => { for (const fn of Object.values(worker)) fn.mockReset(); });

describe('worker forwarders', () => {
    it('sendToken names the account as the session and passes the submit hook', async () => {
        worker.walletTransferToken.mockResolvedValueOnce({ txId: 't' });
        await sendToken({ cacheKey: 'acc', receiverAddress: 'mn_addr_x', amount: '5', ttlIso: 'T', syncTimeoutMs: 9, tokenType: 'ab', onSubmitIntent: hook });
        expect(worker.walletTransferToken).toHaveBeenCalledWith(
            { sessionId: 'acc', receiverAddress: 'mn_addr_x', amount: '5', ttlIso: 'T', syncTimeoutMs: 9, tokenType: 'ab' }, hook);
    });

    it('the diagnostics name the account as the session', async () => {
        await getWalletBalance({ cacheKey: 'acc', syncTimeoutMs: 9, rpcTimeoutMs: 8 });
        expect(worker.walletGetBalance).toHaveBeenCalledWith({ sessionId: 'acc', syncTimeoutMs: 9, rpcTimeoutMs: 8 });
        await estimateSendTokenFee({ cacheKey: 'acc', receiverAddress: 'mn_addr_x', amount: '5', tokenType: 'ab' });
        expect(worker.walletEstimateTransferFee).toHaveBeenCalledWith(
            { sessionId: 'acc', receiverAddress: 'mn_addr_x', amount: '5', ttlIso: undefined, syncTimeoutMs: undefined, tokenType: 'ab' });
    });

    it('dust registration names the account as the session, and the fee payer as the sponsor session', async () => {
        await registerNightUtxosForDust({ cacheKey: 'acc', dustReceiverAddress: 'mn_dust_x', syncTimeoutMs: 9, onSubmitIntent: hook });
        expect(worker.walletRegisterDustGeneration).toHaveBeenCalledWith({ sessionId: 'acc', dustReceiverAddress: 'mn_dust_x', syncTimeoutMs: 9 }, hook);
        await deregisterNightUtxosFromDust({ cacheKey: 'acc', sponsorCacheKey: 'payer', onSubmitIntent: hook });
        expect(worker.walletDeregisterDustGeneration).toHaveBeenCalledWith({ sessionId: 'acc', syncTimeoutMs: undefined, sponsorSessionId: 'payer' }, hook);
    });
});
