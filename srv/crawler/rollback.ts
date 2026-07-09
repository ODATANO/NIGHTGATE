/**
 * Shared rollback for indexed chain data.
 *
 * Used by both rollback paths (reorg recovery in `Crawler.handleReorg` and
 * the manual `reindexFromHeight` in `NightgateIndexerService`) so the delete
 * cascade and the projection repair cannot drift apart.
 *
 * Beyond the raw delete cascade this also repairs `NightBalances`: the ingest
 * maintains that projection with DELTAS (`upsertNightBalance`), so simply
 * deleting blocks/transactions and re-indexing them would apply every delta a
 * second time. After the cascade, every affected address is recomputed from
 * the REMAINING rows, which makes rollback + re-index idempotent.
 */

import cds from '@sap/cds';
const { SELECT, INSERT, UPDATE, DELETE } = cds.ql;
import {
    Blocks, Transactions, ContractActions, ContractBalances, UnshieldedUtxos,
    ZswapLedgerEvents, DustLedgerEvents, TransactionFees, TransactionResults,
    TransactionSegments, NightBalances, SyncState
} from '#cds-models/midnight';

export interface RollbackResult {
    blocksRolledBack: number;
    transactionsRolledBack: number;
    /** Highest surviving block below `fromHeight`, if any. */
    forkBlock: { ID: string; height: number; hash: string } | null;
    /** Addresses whose NightBalances row was recomputed. */
    affectedAddresses: string[];
}

export interface RollbackOptions {
    /** `syncStatus` written to SyncState when blocks were rolled back. */
    syncStatus: 'syncing' | 'stopped';
    /** Additional SyncState fields to set in the same UPDATE. */
    extraSyncState?: Record<string, unknown>;
}

/**
 * Delete all indexed data at/above `fromHeight` and repair derived
 * projections. Must run inside an open transaction (`tx`); the caller owns
 * commit/rollback. When nothing is at/above `fromHeight`, SyncState is left
 * untouched (mirrors the previous behavior of both call sites).
 */
export async function rollbackIndexedDataFromHeight(
    tx: any,
    fromHeight: number,
    opts: RollbackOptions
): Promise<RollbackResult> {
    const blocksToRollback: any[] = await tx.run(
        SELECT.from(Blocks).columns('ID', 'height')
            .where({ height: { '>=': fromHeight } })
    ) || [];
    const blockIds = blocksToRollback.map((b: any) => b.ID).filter(Boolean);

    if (blockIds.length === 0) {
        return {
            blocksRolledBack: 0,
            transactionsRolledBack: 0,
            forkBlock: await selectForkBlock(tx, fromHeight),
            affectedAddresses: []
        };
    }

    const txsToDelete: any[] = await tx.run(
        SELECT.from(Transactions).columns('ID', 'senderAddress', 'receiverAddress')
            .where({ block_ID: { in: blockIds } })
    ) || [];
    const txIds = txsToDelete.map((t: any) => t.ID).filter(Boolean);

    // Collect affected addresses BEFORE deleting anything: senders/receivers
    // of the deleted transactions plus owners of UTXOs those transactions
    // created or spent.
    const affected = new Set<string>();
    for (const t of txsToDelete) {
        if (t.senderAddress) affected.add(t.senderAddress);
        if (t.receiverAddress) affected.add(t.receiverAddress);
    }

    if (txIds.length > 0) {
        const utxoOwners: any[] = await tx.run(
            SELECT.from(UnshieldedUtxos).columns('owner')
                .where({ createdAtTransaction_ID: { in: txIds } })
        ) || [];
        for (const u of utxoOwners) if (u.owner) affected.add(u.owner);
        const spentOwners: any[] = await tx.run(
            SELECT.from(UnshieldedUtxos).columns('owner')
                .where({ spentAtTransaction_ID: { in: txIds } })
        ) || [];
        for (const u of spentOwners) if (u.owner) affected.add(u.owner);

        // Batch delete contract balances via action IDs
        const actionsToDelete: any[] = await tx.run(
            SELECT.from(ContractActions).columns('ID')
                .where({ transaction_ID: { in: txIds } })
        ) || [];
        if (actionsToDelete.length > 0) {
            const actionIds = actionsToDelete.map((a: any) => a.ID);
            await tx.run(DELETE.from(ContractBalances).where({ contractAction_ID: { in: actionIds } }));
        }

        // Batch delete all tx-child tables
        await tx.run(DELETE.from(ContractActions).where({ transaction_ID: { in: txIds } }));
        await tx.run(DELETE.from(UnshieldedUtxos).where({ createdAtTransaction_ID: { in: txIds } }));
        await tx.run(DELETE.from(ZswapLedgerEvents).where({ transaction_ID: { in: txIds } }));
        await tx.run(DELETE.from(DustLedgerEvents).where({ transaction_ID: { in: txIds } }));
        await tx.run(DELETE.from(TransactionFees).where({ transaction_ID: { in: txIds } }));

        // Batch delete transaction segments via result IDs
        const resultsToDelete: any[] = await tx.run(
            SELECT.from(TransactionResults).columns('ID').where({ transaction_ID: { in: txIds } })
        ) || [];
        if (resultsToDelete.length > 0) {
            const resultIds = resultsToDelete.map((r: any) => r.ID);
            await tx.run(DELETE.from(TransactionSegments).where({ transactionResult_ID: { in: resultIds } }));
        }
        await tx.run(DELETE.from(TransactionResults).where({ transaction_ID: { in: txIds } }));

        // Unlink spent UTXOs
        await tx.run(
            UPDATE.entity(UnshieldedUtxos)
                .set({ spentAtTransaction_ID: null })
                .where({ spentAtTransaction_ID: { in: txIds } })
        );
    }

    // Batch delete transactions and blocks
    await tx.run(DELETE.from(Transactions).where({ block_ID: { in: blockIds } }));
    await tx.run(DELETE.from(Blocks).where({ ID: { in: blockIds } }));

    // Repair the delta-maintained NightBalances projection from what remains.
    for (const address of affected) {
        await recomputeNightBalance(tx, address);
    }

    const forkBlock = await selectForkBlock(tx, fromHeight);
    await tx.run(
        UPDATE.entity(SyncState).set({
            lastIndexedHeight: forkBlock?.height ?? 0,
            lastIndexedHash: forkBlock?.hash ?? null,
            lastIndexedAt: new Date().toISOString(),
            syncStatus: opts.syncStatus,
            ...(opts.extraSyncState || {})
        }).where({ ID: 'SINGLETON' })
    );

    return {
        blocksRolledBack: blockIds.length,
        transactionsRolledBack: txIds.length,
        forkBlock,
        affectedAddresses: [...affected]
    };
}

async function selectForkBlock(
    tx: any,
    fromHeight: number
): Promise<{ ID: string; height: number; hash: string } | null> {
    const forkBlock = await tx.run(
        SELECT.one.from(Blocks).columns('ID', 'height', 'hash')
            .where({ height: { '<': fromHeight } })
            .orderBy('height desc')
    );
    return forkBlock || null;
}

/**
 * Rebuild one address's NightBalances row from the remaining UTXOs and
 * transactions, mirroring the ingest semantics of `upsertNightBalance` /
 * `persistTransferProjections` in BlockProcessor:
 *  - every persisted transfer creates exactly one UTXO for the receiver
 *    (received stats derive from the owner's remaining UTXOs),
 *  - the sender is counted only when set, different from the receiver, and
 *    the amount is positive,
 *  - balance is the sum of the owner's unspent UTXO values.
 * A row with no remaining activity is deleted, unless it carries DUST
 * linkage (dustAddress / isDustRegistered), which is not derivable from
 * chain rows and must survive.
 */
async function recomputeNightBalance(tx: any, address: string): Promise<void> {
    const utxos: any[] = await tx.run(
        SELECT.from(UnshieldedUtxos)
            .columns('value', 'spentAtTransaction_ID', 'createdAtTransaction_ID')
            .where({ owner: address })
    ) || [];

    const sentCandidates: any[] = await tx.run(
        SELECT.from(Transactions)
            .columns('ID', 'nightAmount', 'receiverAddress', 'block_ID')
            .where({ senderAddress: address })
    ) || [];
    const sentTxs = sentCandidates.filter(t =>
        t.receiverAddress && t.receiverAddress !== address && toBigInt(t.nightAmount) > 0n
    );

    if (utxos.length === 0 && sentTxs.length === 0) {
        const existing = await tx.run(
            SELECT.one.from(NightBalances)
                .columns('address', 'dustAddress', 'isDustRegistered')
                .where({ address })
        );
        if (!existing) return;
        if (existing.dustAddress || existing.isDustRegistered) {
            await tx.run(
                UPDATE.entity(NightBalances).set({
                    balance: '0' as any,
                    utxoCount: 0,
                    txSentCount: 0,
                    txReceivedCount: 0,
                    totalSent: '0' as any,
                    totalReceived: '0' as any,
                    firstSeenHeight: null,
                    lastActivityHeight: null,
                    lastUpdatedAt: new Date().toISOString()
                }).where({ address })
            );
        } else {
            await tx.run(DELETE.from(NightBalances).where({ address }));
        }
        return;
    }

    // Resolve block heights of the remaining activity for the height fields.
    const createdTxIds = [...new Set(utxos.map(u => u.createdAtTransaction_ID).filter(Boolean))];
    const createdTxs: any[] = createdTxIds.length
        ? await tx.run(
            SELECT.from(Transactions).columns('ID', 'block_ID').where({ ID: { in: createdTxIds } })
        ) || []
        : [];
    const blockIds = [...new Set(
        [...createdTxs.map(t => t.block_ID), ...sentTxs.map(t => t.block_ID)].filter(Boolean)
    )];
    const blocks: any[] = blockIds.length
        ? await tx.run(
            SELECT.from(Blocks).columns('ID', 'height').where({ ID: { in: blockIds } })
        ) || []
        : [];
    const heights = blocks.map(b => Number(b.height)).filter(Number.isFinite);
    const firstSeenHeight = heights.length ? Math.min(...heights) : null;
    const lastActivityHeight = heights.length ? Math.max(...heights) : null;

    let balance = 0n;
    let utxoCount = 0;
    let totalReceived = 0n;
    for (const u of utxos) {
        const value = toBigInt(u.value);
        totalReceived += value;
        if (!u.spentAtTransaction_ID) {
            balance += value;
            utxoCount++;
        }
    }
    let totalSent = 0n;
    for (const t of sentTxs) totalSent += toBigInt(t.nightAmount);

    const nowIso = new Date().toISOString();
    const computed = {
        // Decimal(20,0) columns carrying u128 amounts as strings — same
        // convention as the ingest (see BlockProcessor.upsertNightBalance).
        balance: balance.toString() as any,
        utxoCount,
        txSentCount: sentTxs.length,
        txReceivedCount: utxos.length,
        totalSent: totalSent.toString() as any,
        totalReceived: totalReceived.toString() as any,
        firstSeenHeight,
        lastActivityHeight,
        lastActivityAt: nowIso,
        lastUpdatedHeight: lastActivityHeight,
        lastUpdatedAt: nowIso
    };

    const existing = await tx.run(
        SELECT.one.from(NightBalances).columns('address').where({ address })
    );
    if (existing) {
        await tx.run(UPDATE.entity(NightBalances).set(computed).where({ address }));
    } else {
        await tx.run(INSERT.into(NightBalances).entries({
            address,
            firstSeenAt: nowIso,
            ...computed
        }));
    }
}

function toBigInt(value: unknown): bigint {
    if (typeof value === 'bigint') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.trunc(value));
    if (typeof value === 'string' && value.trim() !== '') {
        try {
            return BigInt(value.trim());
        } catch {
            return 0n;
        }
    }
    return 0n;
}
