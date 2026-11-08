// Applies an unproven batch to a local ledger before proving, the way the node will.
// Only a gas failure stops the build. Any other failure, or a state that cannot be read, lets it go on.
import { errorMessage } from '../utils/errors';
import { describeBatchSegments } from './batch-segment-order';
import type * as LedgerV9 from '@midnightntwrk/ledger-v9';
import type { PublicDataProvider } from '@midnight-ntwrk/midnight-js-types';

const GAS_FAILURE = /out of gas|OutOfGas/;

/** The message names the calls because the SDK may pass on only the message. */
export class BatchGasBudgetError extends Error {
    readonly code = 'BatchGasBudgetExceeded';
    constructor(message: string) {
        super(message);
        this.name = 'BatchGasBudgetError';
    }
}

/** Throws a `BatchGasBudgetError` when a call of `tx` runs out of gas against the contract's current state. */
export async function checkBatchGas(
    tx: LedgerV9.UnprovenTransaction, publicDataProvider: Partial<Pick<PublicDataProvider, 'queryZSwapAndContractState'>> | undefined,
    networkId: string, contractAddress: string, circuits: string[]
): Promise<void> {
    let error: string | undefined;
    try {
        const L = await import('@midnightntwrk/ledger-v9');
        const snapshot = await publicDataProvider?.queryZSwapAndContractState?.(contractAddress);
        if (!snapshot) return;
        const { zswapChainState, contractState, ledgerParameters } = snapshot;
        // A state written by an older ledger cannot be applied with this one.
        if (zswapChainState.era !== 'v9' || contractState.era !== 'v9' || ledgerParameters.era !== 'v9') return;
        // The provider hands over serialized states, which this ledger module decodes.
        const ledger = new L.LedgerState(networkId, L.ZswapChainState.deserialize(zswapChainState.serialize()))
            .updateIndex(contractAddress, L.ContractState.deserialize(contractState.serialize()).data, new Map());
        // Gas is measured with the chain's cost model, which differs from the ledger's initial one.
        ledger.parameters = L.LedgerParameters.deserialize(ledgerParameters.serialize());
        const strict = new L.WellFormedStrictness();
        strict.enforceBalancing = false;
        strict.enforceLimits = false;
        strict.verifyNativeProofs = false;
        strict.verifyContractProofs = false;
        strict.verifySignatures = false;
        const now = new Date();
        const own = L.Transaction.deserialize('signature', 'pre-proof', 'pre-binding', tx.serialize());
        const verified = own.eraseProofs().wellFormed(ledger, strict, now);
        const seconds = BigInt(Math.floor(now.getTime() / 1000));
        const block = { secondsSinceEpoch: seconds, secondsSinceEpochErr: 30, parentBlockHash: '00'.repeat(32), lastBlockTime: seconds - 6n };
        const [, result] = ledger.apply(verified, new L.TransactionContext(ledger, block));
        if (result.type !== 'success') error = String(result.error ?? result.type);
    } catch (e) {
        // eslint-disable-next-line no-console -- shipped in the slim txbuilder, which has no logger
        console.log(`[nightgate:batch-preflight] skipped for [${circuits.join('+')}]: ${errorMessage(e)}`);
        return;
    }
    if (!error) return;
    if (!GAS_FAILURE.test(error)) {
        // eslint-disable-next-line no-console -- shipped in the slim txbuilder, which has no logger
        console.log(`[nightgate:batch-preflight] not a gas failure, going on for [${circuits.join('+')}]: ${error}`);
        return;
    }
    throw new BatchGasBudgetError(
        `batch [${circuits.join('+')}] runs out of gas on the ledger: ${error}. ` +
        'Aborted before proving; nothing was submitted. Send fewer calls per transaction. ' +
        `Calls in apply order: ${describeBatchSegments(tx)}`
    );
}
