// `syncedAtLedger9`: a wallet counts as synced once it caught up and reads the chain at ledger 9.
// A wallet catches up a moment before it learns which ledger the chain runs.

import { describe, it, expect } from 'vitest';

const importWalletTx = () => import('../../src/txbuilder/wallet-tx.mjs' as string);
const FORKS = { v9: 2_000_000n };

type Observer = { next: (state: unknown) => void; error: (e: unknown) => void };

/** A wallet whose state the test pushes. */
function fakeWallet() {
    const observers = new Set<Observer>();
    return {
        observers,
        wallet: { state: { subscribe: (o: Observer) => { observers.add(o); return { unsubscribe: () => { observers.delete(o); } }; } } },
        emit: (caughtUp: boolean, protocolVersion: bigint) => {
            for (const o of [...observers]) o.next({ protocolVersion, progress: { isCompleteWithin: () => caughtUp } });
        },
        fail: (e: Error) => { for (const o of [...observers]) o.error(e); }
    };
}
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const outcome = (p: Promise<unknown>) => Promise.race([
    p.then(() => 'resolved', (e: Error) => `rejected: ${e.message}`),
    new Promise<string>((resolve) => setTimeout(() => resolve('pending'), 20))
]);

describe('syncedAtLedger9', () => {
    it('waits until the wallet caught up and reads the chain at ledger 9', async () => {
        const { syncedAtLedger9 } = await importWalletTx();
        const w = fakeWallet();
        const synced = syncedAtLedger9(w.wallet, FORKS);
        await tick();
        w.emit(false, 1_000_000n);
        // Caught up, but the wallet has not learned yet that the chain runs ledger 9.
        w.emit(true, 1_000_000n);
        expect(await outcome(synced)).toBe('pending');
        // At ledger 9, but behind again.
        w.emit(false, 2_000_000n);
        expect(await outcome(synced)).toBe('pending');
        w.emit(true, 2_000_001n);
        expect(await outcome(synced)).toBe('resolved');
        await tick();
        expect(w.observers.size).toBe(0);
    });

    it('resolves at once for a wallet that already is there, and rejects with the error of the state stream', async () => {
        const { syncedAtLedger9 } = await importWalletTx();
        const ready = fakeWallet();
        ready.wallet.state.subscribe = (o: Observer) => { o.next({ protocolVersion: 2_000_000n, progress: { isCompleteWithin: () => true } }); return { unsubscribe() { /* nothing */ } }; };
        expect(await outcome(syncedAtLedger9(ready.wallet, FORKS))).toBe('resolved');

        const broken = fakeWallet();
        const synced = syncedAtLedger9(broken.wallet, FORKS);
        await tick();
        broken.fail(new Error('indexer gone'));
        expect(await outcome(synced)).toBe('rejected: indexer gone');
    });

    it('readsLedger9 compares the version a state stands on with the start of ledger 9', async () => {
        const { readsLedger9, ledger9Version } = await importWalletTx();
        expect(readsLedger9({ protocolVersion: 1_999_999n }, 2_000_000n)).toBe(false);
        expect(readsLedger9({ protocolVersion: 2_000_000n }, 2_000_000n)).toBe(true);
        expect(readsLedger9({}, 2_000_000n)).toBe(false);
        expect(await ledger9Version({ v9: 2_500_000n })).toBe(2_500_000n);
    });
});
