import cds from '@sap/cds';

interface Db { run(query: unknown): Promise<unknown> }

/** The position column of a transaction row in a test: the height of its block, as the crawler sets it. */
export async function inBlock(db: Db, blockId: string): Promise<{ blockHeight: number }> {
    const block = await db.run(cds.ql.SELECT.one.from('midnight.Blocks').columns('height').where({ ID: blockId })) as { height?: number | string } | undefined;
    return { blockHeight: Number(block?.height ?? 0) };
}

/** The position columns of an action or UTXO row in a test: those of its transaction, as the crawler sets them. */
export async function inTransaction(db: Db, txId: string): Promise<{ blockHeight: number; indexInBlock: number }> {
    const tx = await db.run(
        cds.ql.SELECT.one.from('midnight.Transactions').columns('blockHeight', 'indexInBlock').where({ ID: txId })
    ) as { blockHeight?: number | string; indexInBlock?: number } | undefined;
    return { blockHeight: Number(tx?.blockHeight ?? 0), indexInBlock: Number(tx?.indexInBlock ?? 0) };
}
