// SPDX-License-Identifier: Apache-2.0
// The wallet SDK takes and returns transactions as handles, stamped with the protocol version they were built at.
// midnight-js and our own submit path work on the bare ledger transaction. These helpers convert between the two.

import type * as LedgerV9 from '@midnightntwrk/ledger-v9';
import type { AnyTx, TransactionStage, WalletTransaction } from '@midnightntwrk/wallet-sdk-abstractions';
import type { BalancingRecipe, ResolvedConfiguration } from '@midnightntwrk/wallet-sdk-facade';
import type { DustKeysByEpoch } from '@midnightntwrk/wallet-sdk-dust-wallet';
import type { ShieldedKeysByEpoch } from '@midnightntwrk/wallet-sdk-shielded';
import { loadLedger, loadSdk } from './context';

export type UnprovenLedgerTx = LedgerV9.Transaction<LedgerV9.SignatureEnabled, LedgerV9.PreProof, LedgerV9.PreBinding>;
export type UnboundLedgerTx = LedgerV9.Transaction<LedgerV9.SignatureEnabled, LedgerV9.Proof, LedgerV9.PreBinding>;
export type FinalizedLedgerTx = LedgerV9.Transaction<LedgerV9.SignatureEnabled, LedgerV9.Proof, LedgerV9.Binding>;

/** The ledger transaction a stage carries. */
export interface LedgerTxByStage {
    Unproven: UnprovenLedgerTx;
    Unbound: UnboundLedgerTx;
    Finalized: FinalizedLedgerTx;
}

/** Seals a ledger 9 transaction for the wallet, stamped with the version at which ledger 9 starts on the chain. */
export async function sealTx<S extends TransactionStage>(stage: S, tx: LedgerTxByStage[S], configuration: Pick<ResolvedConfiguration, 'forks'>): Promise<WalletTransaction<S>> {
    const { abstractions } = await loadSdk();
    return abstractions.WalletTransaction.adopt(stage, tx, configuration.forks.v9);
}

/** Reads the ledger transaction out of a handle, in the form its stage names. */
export async function openTx<S extends TransactionStage>(handle: WalletTransaction<S>): Promise<LedgerTxByStage[S]> {
    const ledger = await loadLedger();
    const proof = handle.stage === 'Unproven' ? 'pre-proof' : 'proof';
    const binding = handle.stage === 'Finalized' ? 'binding' : 'pre-binding';
    return ledger.Transaction.deserialize('signature', proof, binding, handle.serialize()) as LedgerTxByStage[S];
}

/** What a revert takes: a recipe, a handle, or a finalized ledger transaction that the facade built. */
export type Revertible = BalancingRecipe | AnyTx | FinalizedLedgerTx;

/** The facade reverts recipes and handles. A bare finalized transaction is sealed first. */
export async function asRevertible(value: Revertible, configuration: Pick<ResolvedConfiguration, 'forks'>): Promise<BalancingRecipe | AnyTx> {
    const { abstractions, facade } = await loadSdk();
    if (facade.BalancingRecipe.isRecipe(value) || abstractions.WalletTransaction.is(value)) return value;
    return sealTx('Finalized', value as FinalizedLedgerTx, configuration);
}

/** The shielded keys of one seed for both ledger generations, as a shielded wallet's `start` takes them. */
export async function shieldedKeysByEpoch(seed: Uint8Array): Promise<ShieldedKeysByEpoch> {
    const [ledgerV8, ledger] = await Promise.all([import('@midnightntwrk/ledger-v8'), loadLedger()]);
    return { v8: ledgerV8.ZswapSecretKeys.fromSeed(seed), v9: ledger.ZswapSecretKeys.fromSeed(seed) };
}

/** The dust keys of one seed for both ledger generations, as a dust wallet's `start` takes them. */
export async function dustKeysByEpoch(seed: Uint8Array): Promise<DustKeysByEpoch> {
    const [ledgerV8, ledger] = await Promise.all([import('@midnightntwrk/ledger-v8'), loadLedger()]);
    return { v8: ledgerV8.DustSecretKey.fromSeed(seed), v9: ledger.DustSecretKey.fromSeed(seed) };
}
