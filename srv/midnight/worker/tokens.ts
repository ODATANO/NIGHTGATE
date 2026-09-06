/**
 * NIGHT and custom-token operations: transfers, balances, fee estimates,
 * dust-generation registration.
 */

// First import on purpose: the worker modules import each other in cycles,
// and a value read at module level must come from an import that is
// resolved before the cycle re-enters this module.
import { configMs } from '../../utils/config';
import path from 'node:path';
import type * as AddressFormat from '@midnightntwrk/wallet-sdk-address-format';
import { type MessagePort } from 'node:worker_threads';
import { encodeAddressString, ensureNetworkId, facades, loadAddressFormat, loadSdk, log, parseReceiverAddress } from './context';
import { BALANCE_SYNC_TIMEOUT_MS, SYNC_POLL_MS, countAllNightUtxos, countRegisteredNightUtxos, peekFacadeState, waitForGenuineSync, waitForSyncedState, waitForSyncedStateBounded, wsleep } from './facades';
import { captureDustSnapshot, feeOfDiscardedRecipe, submitWithDustGuard } from './submit';
import { resolveSponsorEntry } from './sponsor';

/**
 * End-to-end NIGHT-UTXO registration for DUST generation. Wraps:
 *   waitForSyncedState → filter unregistered → register/finalize/submit.
 * Runs entirely in the worker so no SDK objects cross the thread boundary.
 */
export async function registerDustGeneration({ sessionId, dustReceiverAddress, syncTimeoutMs, __replyPort }: {
    sessionId: string;
    dustReceiverAddress?: string;
    syncTimeoutMs?: number;
    /** Set by the dispatcher: the pre-broadcast submit-intent handshake. */
    __replyPort?: MessagePort;
}) {
    const entry = facades.get(sessionId);
    if (!entry) throw new Error(`No facade for sessionId=${sessionId.slice(0, 16)}`);

    // 1. Block until the wallet is synced enough to see its NIGHT UTXOs.
    log('info', `dust-register: waiting for synced state...`);
    const synced = await waitForSyncedStateBounded(entry, 'dust-register', syncTimeoutMs);
    log('info', `dust-register: synced.`);

    // `availableCoins` excludes UTXOs already registered for dust generation (SDK
    // contract); registered ones are counted off the full coin set.
    const availableCoins: any[] = synced?.unshielded?.availableCoins ?? [];
    const unregistered = availableCoins.filter(
        (c: any) => c?.meta?.registeredForDustGeneration !== true
    );
    const registeredUtxosBefore = countRegisteredNightUtxos(synced);
    // Without a full coin set the total is the available set plus the
    // registered UTXOs it does not already list.
    const registeredInAvailable = availableCoins.filter((c: any) => c?.meta?.registeredForDustGeneration === true).length;
    const totalNightUtxos = countAllNightUtxos(synced, availableCoins.length + registeredUtxosBefore - registeredInAvailable);

    const myDustAddr = await entry.facade.dust.getAddress();
    const receiverRaw = dustReceiverAddress || myDustAddr;
    const dustAddrStr = await encodeAddressString(receiverRaw, entry.networkId);

    if (unregistered.length === 0) {
        // Registration binds the address, so a call naming a different receiver
        // changes nothing. The standing receiver is not readable from the SDK
        // (only a boolean per UTXO): answer "unchanged, receiver not applied".
        const reason = registeredUtxosBefore > 0 ? 'already-registered' : 'no-night-utxos';
        const message = reason === 'no-night-utxos'
            ? 'no unshielded NIGHT UTXOs visible to this wallet (all NIGHT is held shielded, or the wallet is ' +
              'unfunded); nothing was registered and no receiver was applied'
            : `all ${totalNightUtxos} NIGHT UTXO(s) are already registered to their standing receiver; ` +
              'nothing was registered and the requested receiver was NOT applied. To move generation to a ' +
              'different receiver, deregisterFromDustGeneration first, then register again naming it';
        log(dustReceiverAddress ? 'warn' : 'info', `dust-register: ${message}`);
        return {
            txId: null,
            changed: false,
            reason,
            registeredCount: 0,
            totalNightUtxos,
            // Never echo a receiver that was not applied.
            dustReceiverAddress: null,
            requestedReceiver: dustAddrStr,
            registeredUtxosBefore,
            registeredUtxosAfter: registeredUtxosBefore,
            settled: true,
            consolidated: null,
            message
        };
    }

    // 2. Parse Bech32m receiver string into a DustAddress, which is what
    //    `registerNightUtxosForDustGeneration` expects on the wire.
    let receiverParsed: AddressFormat.DustAddress | string = receiverRaw;
    if (typeof receiverRaw === 'string') {
        const af = await loadAddressFormat();
        receiverParsed = af.MidnightBech32m
            .parse(receiverRaw)
            .decode(af.DustAddress, entry.networkId);
    }

    // 3. Build registration recipe + finalize + submit. All in-process.
    const verifyingKey = entry.unshieldedKeystore.getPublicKey();
    const signFn = (payload: Uint8Array) => entry.unshieldedKeystore.signData(payload);

    await captureDustSnapshot(entry, 'dust-register');
    const recipe = await entry.facade.registerNightUtxosForDustGeneration(
        unregistered,
        verifyingKey,
        signFn,
        receiverParsed
    );
    const finalized = await entry.facade.finalizeRecipe(recipe);
    const txId = await submitWithDustGuard(entry, finalized, 'dust-register', { replyPort: __replyPort, note: 'dust-register' });

    log('info', `dust-register: submitted ${unregistered.length} UTXO(s), txId=${String(txId).slice(0, 16)}...`);

    // Report the resulting shape: one registration over several UTXOs consolidates
    // them, and one registered UTXO yields one dust note. Bounded observation;
    // `settled: false` with a null count if the tx is not applied locally in time.
    const settleMs = configMs('NIGHTGATE_DUST_REGISTER_SETTLE_MS');
    const settleStartedAt = Date.now();
    let registeredUtxosAfter: number | null = null;
    while (settleMs > 0 && Date.now() - settleStartedAt < settleMs) {
        const state = await peekFacadeState(entry.facade, 10_000);
        const n = state ? countRegisteredNightUtxos(state) : null;
        if (n != null && n > registeredUtxosBefore) { registeredUtxosAfter = n; break; }
        await wsleep(SYNC_POLL_MS);
    }
    const settled = registeredUtxosAfter != null;
    const consolidated = settled ? (registeredUtxosAfter! - registeredUtxosBefore) < unregistered.length : null;
    if (settled) {
        log('info', `dust-register: settled, registered NIGHT UTXOs ${registeredUtxosBefore} -> ${registeredUtxosAfter} (${unregistered.length} input(s)${consolidated ? ', CONSOLIDATED' : ''})`);
    } else {
        log('info', `dust-register: not yet applied locally after ${Math.round((Date.now() - settleStartedAt) / 1000)}s; resulting UTXO count unknown`);
    }

    return {
        txId: String(txId),
        changed: true,
        reason: null,
        registeredCount: unregistered.length,
        totalNightUtxos,
        dustReceiverAddress: dustAddrStr,
        requestedReceiver: dustAddrStr,
        registeredUtxosBefore,
        registeredUtxosAfter,
        settled,
        consolidated,
        message: settled
            ? `${unregistered.length} UTXO(s) registered; the wallet now holds ${registeredUtxosAfter} registered NIGHT UTXO(s)` +
              (consolidated ? ' (inputs were consolidated: register first, fund in separate payments afterwards to keep them split)' : '')
            : `${unregistered.length} UTXO(s) registered; the resulting UTXO count was not observable within ${settleMs}ms`
    };
}

/**
 * Symmetric pair to `registerDustGeneration`. Removes NIGHT UTXOs from
 * dust generation so they become spendable again (registered UTXOs are
 * committed to dust accrual and excluded from `availableCoins`).
 *
 * The SDK's `synced.unshielded.availableCoins` only lists *unregistered*
 * UTXOs, so we read registered ones from the full set the wallet tracks.
 * This action deregisters ALL registered UTXOs; per-UTXO
 * narrowing is a follow-up once we have a stable UTXO-id surface.
 */
export async function deregisterDustGeneration({ sessionId, syncTimeoutMs, sponsorSessionId, __replyPort }: {
    sessionId: string;
    syncTimeoutMs?: number;
    /** Set by the dispatcher: the pre-broadcast submit-intent handshake. */
    __replyPort?: MessagePort;
    /**
     * Optional fee sponsor: that facade balances the deregistration fee
     * from ITS dust and submits. This is the escape hatch for a wallet
     * whose entire generation is delegated away (dust balance 0 forever),
     * which otherwise cannot pay its own deregistration.
     */
    sponsorSessionId?: string;
}) {
    const entry = facades.get(sessionId);
    if (!entry) throw new Error(`No facade for sessionId=${sessionId.slice(0, 16)}`);
    const sponsorEntry = resolveSponsorEntry(sponsorSessionId);

    log('info', `dust-deregister: waiting for synced state...`);
    const synced = await waitForSyncedStateBounded(entry, 'dust-deregister', syncTimeoutMs);
    log('info', `dust-deregister: synced.`);

    // The full coin set is `totalCoins` on the unshielded state
    // (UnshieldedWalletState, wallet-sdk-unshielded-wallet 3.1). Registered
    // UTXOs only surface in the full set, and deregistration needs exactly those.
    const allCoins: any[] = synced?.unshielded?.totalCoins ?? [];
    const registered = allCoins.filter(
        (c: any) => c?.meta?.registeredForDustGeneration === true
    );

    if (registered.length === 0) {
        log('info', `dust-deregister: no registered NIGHT UTXOs to deregister.`);
        return {
            txId: null,
            deregisteredCount: 0,
            totalNightUtxos: allCoins.length
        };
    }

    const verifyingKey = entry.unshieldedKeystore.getPublicKey();
    const signFn = (payload: Uint8Array) => entry.unshieldedKeystore.signData(payload);

    const recipe = await entry.facade.deregisterFromDustGeneration(
        registered,
        verifyingKey,
        signFn
    );
    // The deregistration recipe is fee-less by design (allowFeePayment 0,
    // no dust spends): the SDK expects THE CALLER to balance the fee via
    // balanceUnprovenTransaction with tokenKindsToBalance ['dust'] (stated
    // in the facade's createDustActionTransaction step-4 comment).
    // Without it the node rejects 1010/138 BalanceCheckOverspend. The tx
    // is already fully signed by the facade; an extra signRecipe pass
    // DUPLICATES the offer signatures (1010/192). So: balance, then
    // finalize, no re-signing.
    //
    // With a sponsor, the SPONSOR's facade balances the fee from ITS dust
    // and submits. The dust spender must be genuinely synced first (stale
    // dust merkle roots are the Custom error 117 site); the unsponsored
    // path gets that freshness from the caller's own sync above.
    const payer = sponsorEntry ?? entry;
    if (sponsorEntry) {
        log('info', `dust-deregister: fee sponsored by ${sponsorEntry === entry ? 'self' : String(sponsorSessionId).slice(0, 16)}`);
        await waitForGenuineSync(sponsorEntry, BALANCE_SYNC_TIMEOUT_MS, 'deregister sponsor');
    }
    await captureDustSnapshot(payer, 'dust-deregister');
    const balanced = await payer.facade.balanceUnprovenTransaction(
        recipe.transaction,
        { shieldedSecretKeys: payer.zswapKeys, dustSecretKey: payer.dustKey },
        { ttl: new Date(Date.now() + 10 * 60000), tokenKindsToBalance: ['dust'] }
    );
    const finalized = await payer.facade.finalizeRecipe(balanced);
    const txId = await submitWithDustGuard(payer, finalized, 'dust-deregister', { replyPort: __replyPort, note: 'dust-deregister' });

    log('info', `dust-deregister: submitted ${registered.length} UTXO(s), txId=${String(txId).slice(0, 16)}...`);

    return {
        txId: String(txId),
        deregisteredCount: registered.length,
        totalNightUtxos: allCoins.length
    };
}

/**
 * Send NIGHT to any Midnight address. The receiver's Bech32m prefix
 * decides the destination ledger (`mn_shield-addr_` → shielded,
 * `mn_addr_` → unshielded). Source funds are selected by the SDK's
 * balancer from the wallet's available UTXOs on the target ledger;
 * cross-ledger funding is not attempted (NIGHT is unshielded-only,
 * there is no shield/unshield conversion in the protocol).
 *
 * Build + balance + prove + submit all in-worker via `facade.transferTransaction`.
 * Returns primitives only; no SDK objects cross the thread boundary.
 */
export async function transferNight({ sessionId, receiverAddress, amount, ttlIso, syncTimeoutMs, tokenTypeHex, __replyPort }: {
    sessionId: string;
    receiverAddress: string;
    amount: string;          // bigint atoms as decimal string
    ttlIso?: string;          // ISO-8601 future timestamp; defaults to +10min
    syncTimeoutMs?: number;
    /** Raw token type (64 hex) to send instead of NIGHT; e.g. a contract-minted shielded token. */
    tokenTypeHex?: string;
    /** Set by the dispatcher: the pre-broadcast submit-intent handshake. */
    __replyPort?: MessagePort;
}) {
    const entry = facades.get(sessionId);
    if (!entry) throw new Error(`No facade for sessionId=${sessionId.slice(0, 16)}`);
    const sdk = await loadSdk();
    await ensureNetworkId(entry.networkId, sdk);

    log('info', `transfer: waiting for synced state...`);
    await waitForSyncedStateBounded(entry, 'transfer', syncTimeoutMs);
    log('info', `transfer: synced.`);

    const receiver = await parseReceiverAddress(receiverAddress, entry.networkId);
    const amountBig = BigInt(amount);
    const rawType = tokenTypeHex || sdk.ledger.nativeToken().raw;
    const ttl = ttlIso ? new Date(ttlIso) : new Date(Date.now() + 10 * 60 * 1000);

    const outputs: any[] = receiver.kind === 'shielded'
        ? [{ type: 'shielded', outputs: [{ type: rawType, receiverAddress: receiver.addr, amount: amountBig }] }]
        : [{ type: 'unshielded', outputs: [{ type: rawType, receiverAddress: receiver.addr, amount: amountBig }] }];

    log('info', `transfer: ${amount} ${tokenTypeHex ? `token ${tokenTypeHex.slice(0, 12)}...` : 'NIGHT'} to ${receiver.kind} addr ${receiverAddress.slice(0, 24)}...`);

    await captureDustSnapshot(entry, 'transfer');
    const recipe = await entry.facade.transferTransaction(
        outputs,
        { shieldedSecretKeys: entry.zswapKeys, dustSecretKey: entry.dustKey },
        { ttl }
    );
    // UNSHIELDED inputs are signature-authorized (not proof-authorized like
    // zswap): the recipe must pass through signRecipe with the keystore's
    // sign function, or the intent ships inputs with an empty signature
    // list and the node rejects it at the mempool with
    // `1010 Custom error: 192` (MalformedError::InputsSignaturesLengthMismatch).
    // No-op when the balancer selected no unshielded inputs.
    const signFn = (payload: Uint8Array) => entry.unshieldedKeystore.signData(payload);
    const signed = await entry.facade.signRecipe(recipe, signFn);
    const finalized = await entry.facade.finalizeRecipe(signed);
    const txId = await submitWithDustGuard(entry, finalized, 'transfer', { replyPort: __replyPort, note: 'transfer' });

    log('info', `transfer: submitted, txId=${String(txId).slice(0, 16)}...`);

    return {
        txId: String(txId),
        toLedger: receiver.kind,
        amount: amount,
        receiverAddress: receiverAddress
    };
}

/**
 * Read-only snapshot of the wallet's current balances and dust state.
 *
 * Pulls from the cached synced state via `waitForSyncedState()` (which
 * resolves immediately when at tip, blocks during initial catch-up).
 * No transaction is built or submitted.
 *
 * Returns only NIGHT for shielded/unshielded in this first version
 * (other custom tokens omitted; add a `tokensJson` field later if a
 * consumer needs them).
 */
export async function getBalance({ sessionId, syncTimeoutMs }: {
    sessionId: string;
    syncTimeoutMs?: number;
}) {
    const entry = facades.get(sessionId);
    if (!entry) throw new Error(`No facade for sessionId=${sessionId.slice(0, 16)}`);
    const sdk = await loadSdk();
    await ensureNetworkId(entry.networkId, sdk);

    const synced = await waitForSyncedStateBounded(entry, 'getBalance', syncTimeoutMs);

    const nightRawType: string = sdk.ledger.nativeToken().raw;
    const shieldedBalances: Record<string, bigint> = synced?.shielded?.balances ?? {};
    const unshieldedBalances: Record<string, bigint> = synced?.unshielded?.balances ?? {};
    const totalNightCoins: any[] = synced?.unshielded?.totalCoins ?? [];

    const shieldedNight = shieldedBalances[nightRawType] ?? 0n;
    const unshieldedNight = unshieldedBalances[nightRawType] ?? 0n;
    // dust.balance(time) is synchronous and returns Balance (= bigint). It
    // lives on the DustWalletState carried by the synced FacadeState, NOT
    // on facade.dust (which is a DustWalletAPI with no balance() method).
    const dustBalance: bigint = synced?.dust ? synced.dust.balance(new Date()) : 0n;
    // DIAGNOSTIC: real sync distance to tip + whether 'synced' is genuine.
    try {
        const p: any = (synced as any)?.dust?.progress;
        log('debug', `SYNC-PROGRESS isSynced=${(synced as any)?.isSynced} isConnected=${p?.isConnected} appliedIndex=${p?.appliedIndex} highestIndex=${p?.highestIndex} highestRelevantIndex=${p?.highestRelevantIndex}`);
    } catch (e: any) { log('debug', `SYNC-PROGRESS read failed: ${e?.message}`); }
    const registeredCount = totalNightCoins.filter(
        (c: any) => c?.meta?.registeredForDustGeneration === true
    ).length;
    // Dust-side diagnosability (dust-pending-note-leak FR): a wedged
    // wallet (in-flight spend leaked by a pre-mempool abort) shows
    // registered NIGHT but ZERO dust utxos and ZERO pending, which is
    // otherwise indistinguishable from "genuinely empty" without logs.
    const dustUtxos: any[] = synced?.dust?.totalCoins ?? [];
    const dustPending: any[] = synced?.dust?.pendingCoins ?? [];
    // `totalCoins` is available PLUS pending, so it is not the number of
    // notes you can spend right now; unbound sponsoring locks one FREE
    // note per in-flight transaction, and reading the total as capacity
    // counts notes that are already committed to a spend. Take the SDK's
    // own available list when it has one, and fall back to the difference.
    const dustAvailable: any[] | undefined = synced?.dust?.availableCoins;
    const dustPendingValue = dustPending.reduce(
        (sum: bigint, c: any) => sum + (typeof c?.generatedNow === 'bigint' ? c.generatedNow : 0n), 0n
    );

    // Every OTHER shielded token type the wallet holds (contract-minted
    // custom tokens, e.g. a wrapped asset): raw token type hex -> atoms.
    const shieldedTokens = Object.entries(shieldedBalances)
        .filter(([tokenType, amount]) => tokenType !== nightRawType && amount > 0n)
        .map(([tokenType, amount]) => ({ tokenType, amount: amount.toString() }));

    return {
        shieldedNight: shieldedNight.toString(),
        unshieldedNight: unshieldedNight.toString(),
        shieldedTokens,
        dustBalance: dustBalance.toString(),
        registeredNightUtxoCount: registeredCount,
        totalNightUtxoCount: totalNightCoins.length,
        dustUtxoCount: dustUtxos.length,
        dustAvailableCount: Array.isArray(dustAvailable)
            ? dustAvailable.length
            : Math.max(0, dustUtxos.length - dustPending.length),
        dustPendingCount: dustPending.length,
        dustPendingValue: dustPendingValue.toString(),
        // Persist-CONFIRMED snapshot restores (bumped only after the
        // main thread acked the restore's re-persist). Exposed so the
        // live e2e can ASSERT the whole guard lane ran, including
        // durability (the SDK's own fast-path revert heals some aborts
        // without it, and a fire-and-forget push could green-light a
        // gate while the DB still holds the poisoned state).
        dustRestoreCount: entry.dustRestoresPersisted ?? 0
    };
}

/**
 * Pre-flight fee estimate for a NIGHT transfer. Builds the
 * `transferTransaction` recipe in the worker (which runs balancing
 * (lightweight) but NOT proof generation (heavy)), then prices the
 * balanced recipe via `calculateTransactionFee`. No submit. The recipe
 * is discarded AND reverted, so the coins the build moved into
 * `pendingUtxos` become spendable again (bug_002).
 */
export async function estimateTransferFee({ sessionId, receiverAddress, amount, ttlIso, syncTimeoutMs, tokenTypeHex }: {
    sessionId: string;
    receiverAddress: string;
    amount: string;
    ttlIso?: string;
    syncTimeoutMs?: number;
    tokenTypeHex?: string;
}) {
    const entry = facades.get(sessionId);
    if (!entry) throw new Error(`No facade for sessionId=${sessionId.slice(0, 16)}`);
    const sdk = await loadSdk();
    await ensureNetworkId(entry.networkId, sdk);

    await waitForSyncedStateBounded(entry, 'estimateTransferFee', syncTimeoutMs);

    const receiver = await parseReceiverAddress(receiverAddress, entry.networkId);
    const amountBig = BigInt(amount);
    // Same output shape as transferNight: the estimate must price the
    // token that will be sent, not NIGHT regardless.
    const rawType: string = tokenTypeHex || sdk.ledger.nativeToken().raw;
    const ttl = ttlIso ? new Date(ttlIso) : new Date(Date.now() + 10 * 60 * 1000);

    const outputs: any[] = receiver.kind === 'shielded'
        ? [{ type: 'shielded', outputs: [{ type: rawType, receiverAddress: receiver.addr, amount: amountBig }] }]
        : [{ type: 'unshielded', outputs: [{ type: rawType, receiverAddress: receiver.addr, amount: amountBig }] }];

    const recipe = await entry.facade.transferTransaction(
        outputs,
        { shieldedSecretKeys: entry.zswapKeys, dustSecretKey: entry.dustKey },
        { ttl }
    );
    // recipe is UnprovenTransactionRecipe: { type: 'UNPROVEN_TRANSACTION', transaction }
    const fee = await feeOfDiscardedRecipe(entry.facade, recipe, 'estimateTransferFee');
    return { fee: fee.toString(), toLedger: receiver.kind };
}

export const tokenHandlers = { registerDustGeneration, deregisterDustGeneration, transferNight, getBalance, estimateTransferFee };
