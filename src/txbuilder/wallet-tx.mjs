// The wallet SDK takes and returns transactions as handles, sealed with the protocol version they were built at.
// This builder builds for ledger 9 only, so a handle carries the version at which ledger 9 starts on the chain.
// SPDX-License-Identifier: Apache-2.0

const loadAbstractions = () => import('@midnightntwrk/wallet-sdk-abstractions');
const loadLedger = () => import('@midnightntwrk/ledger-v9');

/** The protocol version at which ledger 9 starts on the chain; `forks` comes from the wallet configuration. */
export async function ledger9Version(forks) {
    return forks?.v9 ?? (await loadAbstractions()).ProtocolVersion.V9NativeForkVersion;
}

/** Seals a ledger transaction for the wallet. `stage` is 'Unproven', 'Unbound' or 'Finalized'; `forks` comes from the wallet configuration. */
export async function sealTx(stage, tx, forks) {
    const { WalletTransaction } = await loadAbstractions();
    return WalletTransaction.adopt(stage, tx, await ledger9Version(forks));
}

/** True when a wallet state reads the chain at ledger 9. Below `version` the wallet builds for the ledger before it. */
export const readsLedger9 = (state, version) => BigInt(state?.protocolVersion ?? 0n) >= BigInt(version);

/**
 * Resolves once the wallet caught up and reads the chain at ledger 9. A wallet catches up a moment before it learns which ledger the chain runs.
 */
export async function syncedAtLedger9(wallet, forks) {
    const version = await ledger9Version(forks);
    return new Promise((resolve, reject) => {
        let done = false;
        const finish = (settle, value) => {
            if (done) return;
            done = true;
            setImmediate(() => sub?.unsubscribe?.());
            settle(value);
        };
        const sub = wallet.state.subscribe({
            next: (state) => { if (state.progress.isCompleteWithin(0n) && readsLedger9(state, version)) finish(resolve, state); },
            error: (e) => finish(reject, e)
        });
    });
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
