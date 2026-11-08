// The wallet SDK takes and returns transactions as handles, sealed with the protocol version they were built at.
// This builder builds for ledger 9 only, so a handle carries the version at which ledger 9 starts on the chain.
// SPDX-License-Identifier: Apache-2.0

const loadAbstractions = () => import('@midnightntwrk/wallet-sdk-abstractions');
const loadLedger = () => import('@midnightntwrk/ledger-v9');

/** Seals a ledger transaction for the wallet. `stage` is 'Unproven', 'Unbound' or 'Finalized'; `forks` comes from the wallet configuration. */
export async function sealTx(stage, tx, forks) {
    const { WalletTransaction, ProtocolVersion } = await loadAbstractions();
    return WalletTransaction.adopt(stage, tx, forks?.v9 ?? ProtocolVersion.V9NativeForkVersion);
}

/** Reads the ledger transaction out of a handle, in the form its stage names: unproven, proven or sealed. */
export async function openTx(handle) {
    const ledger = await loadLedger();
    const proof = handle.stage === 'Unproven' ? 'pre-proof' : 'proof';
    return ledger.Transaction.deserialize('signature', proof, handle.stage === 'Finalized' ? 'binding' : 'pre-binding', handle.serialize());
}

/** The shielded keys of one seed for both sides of the change to ledger 9, as a shielded wallet's `start` takes them. */
export async function shieldedKeysByEpoch(seed) {
    const [ledgerV8, ledger] = await Promise.all([import('@midnightntwrk/ledger-v8'), loadLedger()]);
    return { v8: ledgerV8.ZswapSecretKeys.fromSeed(seed), v9: ledger.ZswapSecretKeys.fromSeed(seed) };
}
