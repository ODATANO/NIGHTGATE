/**
 * Removes indexed blocks from a given height upwards, after a reorg or for a manual reindex.
 * `NightBalances` is updated step by step during indexing, so affected addresses are recomputed from the remaining rows.
 */

import cds from '@sap/cds';
const { SELECT, INSERT, UPDATE, DELETE } = cds.ql;
import { Blocks, Transactions, ContractActions, ContractBalances, ContractStates, UnshieldedUtxos, ZswapLedgerEvents, DustLedgerEvents, TransactionFees, TransactionResults, TransactionSegments, NightBalances, SyncState, PendingSubmissions, BackgroundJobs, type Block, type Transaction } from '#cds-models/midnight';
import { bumpReorgGeneration } from '../submission/reorg-generation';
import { NIGHT_RAW_TOKEN_TYPE } from './block-events';
import type { DbRunner } from '../utils/db-types';

// PostgreSQL allows at most 65535 parameters per statement, so long ID lists are split.
const IN_CHUNK = 5000;

async function chunked(ids: unknown[], query: (chunk: unknown[]) => Promise<any>): Promise<any[]> {
    const rows: any[] = [];
    for (let i = 0; i < ids.length; i += IN_CHUNK) {
        const result = await query(ids.slice(i, i + IN_CHUNK));
        if (Array.isArray(result)) for (const row of result) rows.push(row);
    }
    return rows;
}

export interface RollbackResult {
    reorgGeneration: number;
    blocksRolledBack: number;
    transactionsRolledBack: number;
    /** Highest remaining block below `fromHeight`, if any. */
    forkBlock: { ID: string; height: number; hash: string } | null;
    affectedAddresses: string[];
    submissionsReverted: number;
    jobsReverted: number;
}

export interface RollbackOptions {
    syncStatus: 'syncing' | 'stopped';
    extraSyncState?: Record<string, unknown>;
}

/** Deletes all indexed data from `fromHeight` upwards and repairs the tables derived from it. */
export async function rollbackIndexedDataFromHeight(
    tx: DbRunner,
    fromHeight: number,
    opts: RollbackOptions
): Promise<RollbackResult> {
    // Must stay the first write in this transaction. bumpReorgGeneration explains why.
    const reorgGeneration = await bumpReorgGeneration(tx);
    const blocksToRollback: Block[] = await tx.run(
        SELECT.from(Blocks).columns('ID', 'height')
            .where({ height: { '>=': fromHeight } })
    ) || [];
    const blockIds = blocksToRollback.map((b: { ID?: string }) => b.ID).filter(Boolean);

    if (blockIds.length === 0) {
        // Inclusion data recorded on jobs from this height upwards is invalid, even if no local blocks exist.
        const evidence = await revertSubmissionEvidence(tx, fromHeight);
        return {
            blocksRolledBack: 0,
            transactionsRolledBack: 0,
            forkBlock: await selectForkBlock(tx, fromHeight),
            affectedAddresses: [],
            reorgGeneration,
            ...evidence
        };
    }

    const txsToDelete = await chunked(blockIds, ids => tx.run(
        SELECT.from(Transactions).columns('ID', 'hash', 'senderAddress', 'receiverAddress')
            .where({ block_ID: { in: ids } })
    ));
    const txIds = txsToDelete.map((t: { ID?: string }) => t.ID).filter(Boolean);

    // Collect the affected addresses before anything is deleted.
    const affected = new Set<string>();
    for (const t of txsToDelete) {
        if (t.senderAddress) affected.add(t.senderAddress);
        if (t.receiverAddress) affected.add(t.receiverAddress);
    }

    if (txIds.length > 0) {
        const utxoOwners = await chunked(txIds, ids => tx.run(
            SELECT.from(UnshieldedUtxos).columns('owner').where({ createdAtTransaction_ID: { in: ids } })
        ));
        for (const u of utxoOwners) if (u.owner) affected.add(u.owner);
        const spentOwners = await chunked(txIds, ids => tx.run(
            SELECT.from(UnshieldedUtxos).columns('owner').where({ spentAtTransaction_ID: { in: ids } })
        ));
        for (const u of spentOwners) if (u.owner) affected.add(u.owner);

        const actionIds = (await chunked(txIds, ids => tx.run(
            SELECT.from(ContractActions).columns('ID').where({ transaction_ID: { in: ids } })
        ))).map((a: { ID: string }) => a.ID);
        await chunked(actionIds, ids => tx.run(DELETE.from(ContractBalances).where({ contractAction_ID: { in: ids } })));

        const resultIds = (await chunked(txIds, ids => tx.run(
            SELECT.from(TransactionResults).columns('ID').where({ transaction_ID: { in: ids } })
        ))).map((r: { ID: string }) => r.ID);
        await chunked(resultIds, ids => tx.run(DELETE.from(TransactionSegments).where({ transactionResult_ID: { in: ids } })));

        await chunked(txIds, async ids => {
            await tx.run(DELETE.from(ContractActions).where({ transaction_ID: { in: ids } }));
            await tx.run(DELETE.from(UnshieldedUtxos).where({ createdAtTransaction_ID: { in: ids } }));
            await tx.run(DELETE.from(ZswapLedgerEvents).where({ transaction_ID: { in: ids } }));
            await tx.run(DELETE.from(DustLedgerEvents).where({ transaction_ID: { in: ids } }));
            await tx.run(DELETE.from(TransactionFees).where({ transaction_ID: { in: ids } }));
            await tx.run(DELETE.from(TransactionResults).where({ transaction_ID: { in: ids } }));
        });
        // Runs after all deletes, because a spend in one chunk may point at a UTXO created in another.
        await chunked(txIds, ids => tx.run(
            UPDATE.entity(UnshieldedUtxos).set({ spentAtTransaction_ID: null }).where({ spentAtTransaction_ID: { in: ids } })
        ));
    }

    await chunked(blockIds, async ids => {
        await tx.run(DELETE.from(Transactions).where({ block_ID: { in: ids } }));
        await tx.run(DELETE.from(Blocks).where({ ID: { in: ids } }));
    });
    // A current contract state from a removed block is invalid. The older state is not stored,
    // so the contract has no stored state until the indexer pass or a new action fills it again.
    // Until then, state reads go to the indexer.
    await tx.run(DELETE.from(ContractStates).where({ height: { '>=': fromHeight } }));

    for (const address of affected) {
        await recomputeNightBalance(tx, address);
    }

    const evidence = await revertSubmissionEvidence(tx, fromHeight);

    const forkBlock = await selectForkBlock(tx, fromHeight);
    const forkHeight = forkBlock?.height ?? 0;
    // The decode and indexer passes must not stay above the new tip.
    // Their results for the removed blocks were deleted with the rows.
    const current: any = await tx.run(
        SELECT.one.from(SyncState).columns('lastDecodedHeight', 'lastSupplementedHeight').where({ ID: 'SINGLETON' })
    );
    const clampCursor = (value: unknown): number | null => {
        if (value == null) return null;
        return Math.min(Number(value), forkHeight);
    };
    await tx.run(
        UPDATE.entity(SyncState).set({
            lastIndexedHeight: forkHeight,
            lastIndexedHash: forkBlock?.hash ?? null,
            lastIndexedAt: new Date().toISOString(),
            lastDecodedHeight: clampCursor(current?.lastDecodedHeight),
            lastSupplementedHeight: clampCursor(current?.lastSupplementedHeight),
            syncStatus: opts.syncStatus,
            ...(opts.extraSyncState || {})
        }).where({ ID: 'SINGLETON' })
    );

    return {
        blocksRolledBack: blockIds.length,
        transactionsRolledBack: txIds.length,
        forkBlock,
        affectedAddresses: [...affected],
        reorgGeneration,
        ...evidence
    };
}

/**
 * Clears the inclusion data that submissions and jobs recorded from `fromHeight` upwards.
 * They are matched by block height, because the crawler and the submission side share no common hash.
 * Jobs that failed on-chain are checked again, because the transaction may apply differently when it lands again.
 * Anchor hashes recorded on documents are not cleared.
 */
async function revertSubmissionEvidence(
    tx: DbRunner,
    fromHeight: number
): Promise<{ submissionsReverted: number; jobsReverted: number }> {
    const clearedEvidence = { chainBlockHeight: null, chainBlockHash: null, indexerTxHash: null };
    const submissionsReverted = affectedRows(await tx.run(
        UPDATE.entity(PendingSubmissions)
            .set({ status: 'pending', finalizedAt: null, finalizedTxData: null, ...clearedEvidence })
            .where({ chainBlockHeight: { '>=': fromHeight }, status: { in: ['included', 'finalized'] } })
    ));

    const failedAttemptsReverted = affectedRows(await tx.run(
        UPDATE.entity(PendingSubmissions)
            .set({ status: 'pending', finalizedAt: null, finalizedTxData: null, errorCode: null, errorMessage: null, ...clearedEvidence })
            .where({ chainBlockHeight: { '>=': fromHeight }, status: 'failed', errorCode: 'CHAIN_EXECUTION_FAILED' })
    ));
    const failedReverted = affectedRows(await tx.run(
        UPDATE.entity(BackgroundJobs)
            .set({
                status: 'reconciliation_required', chainStatus: 'pending', chainFinalizedAt: null,
                errorCode: null, errorMessage: null, finishedAt: null, chainSegments: null, ...clearedEvidence
            })
            .where({ chainBlockHeight: { '>=': fromHeight }, status: 'failed', errorCode: 'CHAIN_EXECUTION_FAILED' })
    ));
    const outcomesReverted = affectedRows(await tx.run(
        UPDATE.entity(BackgroundJobs)
            .set({ chainStatus: 'pending', chainFinalizedAt: null, chainSegments: null, ...clearedEvidence })
            .where({ chainBlockHeight: { '>=': fromHeight }, chainStatus: { in: ['success', 'failure'] } })
    ));
    return { submissionsReverted: submissionsReverted + failedAttemptsReverted, jobsReverted: failedReverted + outcomesReverted };
}

function affectedRows(result: unknown): number {
    if (typeof result === 'number') return result;
    if (result && typeof result === 'object' && typeof (result as any).changes === 'number') return (result as any).changes;
    return 0;
}

async function selectForkBlock(
    tx: DbRunner,
    fromHeight: number
): Promise<{ ID: string; height: number; hash: string } | null> {
    const forkBlock = await tx.run(
        SELECT.one.from(Blocks).columns('ID', 'height', 'hash')
            .where({ height: { '<': fromHeight } })
            .orderBy('height desc')
    );
    return forkBlock || null;
}

export interface NightBalanceFigures {
    balance: bigint;
    utxoCount: number;
    txSentCount: number;
    txReceivedCount: number;
    totalSent: bigint;
    totalReceived: bigint;
    firstSeenHeight: number | null;
    lastActivityHeight: number | null;
}

/**
 * Computes the balance values of one address from the indexed rows. Null if the address has no NIGHT activity.
 * Must give the same result as `applyBalanceDelta` in BlockProcessor, which updates them block by block.
 */
export async function computeNightBalance(tx: DbRunner, address: string): Promise<NightBalanceFigures | null> {
    // Only NIGHT counts. Other tokens of the same address are ignored.
    const utxos: any[] = await tx.run(
        SELECT.from(UnshieldedUtxos)
            .columns('value', 'spentAtTransaction_ID', 'createdAtTransaction_ID')
            .where({ owner: address, tokenType: NIGHT_RAW_TOKEN_TYPE })
    ) || [];

    const sentCandidates: Transaction[] = await tx.run(
        SELECT.from(Transactions)
            .columns('ID', 'nightAmount', 'receiverAddress', 'block_ID')
            .where({ senderAddress: address })
    ) || [];
    const sentTxs = sentCandidates.filter(t =>
        t.receiverAddress && t.receiverAddress !== address && toBigInt(t.nightAmount) > 0n
    );

    if (utxos.length === 0 && sentTxs.length === 0) return null;

    // Spending also counts as activity, so spending transactions are included in the height range.
    const activityTxIds = [...new Set([
        ...utxos.map(u => u.createdAtTransaction_ID),
        ...utxos.map(u => u.spentAtTransaction_ID)
    ].filter(Boolean))];
    const activityTxs = await chunked(activityTxIds, ids => tx.run(
        SELECT.from(Transactions).columns('ID', 'block_ID').where({ ID: { in: ids } })
    ));
    const blockIds = [...new Set(
        [...activityTxs.map(t => t.block_ID), ...sentTxs.map(t => t.block_ID)].filter(Boolean)
    )];
    const blocks = await chunked(blockIds, ids => tx.run(
        SELECT.from(Blocks).columns('ID', 'height').where({ ID: { in: ids } })
    ));
    const heights = blocks.map(b => Number(b.height)).filter(Number.isFinite);
    // Uses reduce, because Math.min(...) with a very large array can overflow the call stack.
    const firstSeenHeight = heights.length ? heights.reduce((a, b) => Math.min(a, b)) : null;
    const lastActivityHeight = heights.length ? heights.reduce((a, b) => Math.max(a, b)) : null;

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

    return {
        balance, utxoCount, txSentCount: sentTxs.length, txReceivedCount: utxos.length,
        totalSent, totalReceived, firstSeenHeight, lastActivityHeight
    };
}

export async function recomputeNightBalance(tx: DbRunner, address: string): Promise<void> {
    const figures = await computeNightBalance(tx, address);
    if (!figures) {
        const existing = await tx.run(
            SELECT.one.from(NightBalances)
                .columns('address', 'dustAddress', 'isDustRegistered')
                .where({ address })
        );
        if (!existing) return;
        if (existing.dustAddress || existing.isDustRegistered) {
            await tx.run(
                UPDATE.entity(NightBalances).set({
                    balance: '0',
                    utxoCount: 0,
                    txSentCount: 0,
                    txReceivedCount: 0,
                    totalSent: '0',
                    totalReceived: '0',
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

    const nowIso = new Date().toISOString();
    const computed = {
        balance: figures.balance.toString(),
        utxoCount: figures.utxoCount,
        txSentCount: figures.txSentCount,
        txReceivedCount: figures.txReceivedCount,
        totalSent: figures.totalSent.toString(),
        totalReceived: figures.totalReceived.toString(),
        firstSeenHeight: figures.firstSeenHeight,
        lastActivityHeight: figures.lastActivityHeight,
        lastActivityAt: nowIso,
        lastUpdatedHeight: figures.lastActivityHeight,
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
