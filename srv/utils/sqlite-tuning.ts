/**
 * Apply SQLite performance pragmas to the CAP db service.
 *
 * Default SQLite settings prioritise crash-safety over throughput. For an
 * indexer doing many small write transactions during catch-up, these
 * defaults bottleneck on per-commit fsync. The pragmas below are the
 * standard "warm read-heavy / write-once-then-reindex" tuning used by
 * Substrate indexers, btc explorers, etc.
 *
 * Safety: with `journal_mode=WAL` (already set by @cap-js/sqlite for
 * file-based DBs) and `synchronous=NORMAL`, the WAL is durable on commit
 * but the WAL header isn't fsynced per transaction. The risk window is
 * a power loss between commit and the periodic checkpoint, in which case
 * the last few uncommitted-to-disk transactions are lost. An indexer
 * tolerates this trivially: it just re-fetches the missing blocks from
 * the node on next start.
 *
 * No-op for non-SQLite databases (HANA in prod doesn't expose `.pragma`).
 */
export async function applySqliteTuning(db: any): Promise<void> {
    if (!db || typeof db.pragma !== 'function') return;

    const pragmas: Array<[string, string]> = [
        ['synchronous',  'NORMAL'],      // was FULL, ~3-5x fewer fsyncs
        ['cache_size',   '-65536'],      // 64 MB page cache (negative = KB)
        ['temp_store',   'MEMORY'],      // in-memory temp tables/indexes
        ['mmap_size',    '268435456'],   // 256 MB mmap for big reads
        ['wal_autocheckpoint', '1000']   // checkpoint every 1000 pages, not 1000 frames-since-open
    ];

    for (const [name, value] of pragmas) {
        try {
            // CAP's db.pragma() may be sync (raw better-sqlite3) or async
            // (CAP-wrapped). `await` works on both — promise resolves; raw
            // value is awaited harmlessly.
            await db.pragma(`${name} = ${value}`);
        } catch (err) {
            console.warn(`[sqlite-tuning] failed to set ${name}=${value}: ${(err as Error).message}`);
        }
    }

    try {
        const journal = await db.pragma('journal_mode', { simple: true });
        const sync    = await db.pragma('synchronous',  { simple: true });
        console.log(`[sqlite-tuning] journal_mode=${journal}, synchronous=${sync}, cache=64MB, mmap=256MB`);
    } catch {
        // pragma read may not be supported; skip the diagnostic
    }
}
