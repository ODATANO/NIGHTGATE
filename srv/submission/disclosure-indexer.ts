/**
 * Materializes the vault's on-chain `disclosures` map into `DisclosureGrants`.
 * Snapshots are read at a block height and never overwrite a row with a newer
 * `changedAtHeight`, so a stale read cannot revive a revoke or roll a level back.
 */
import cds from '@sap/cds';
import { DisclosureGrants } from '#cds-models/midnight';
import { importArtifactByPath } from './contract-registry';

const { SELECT, INSERT, UPDATE } = cds.ql;

function hex(b: Uint8Array): string {
    return Buffer.from(b).toString('hex');
}

/** Minimal shape of the compiled artifact's `ledger(state)` return we rely on. */
export interface DisclosureLedger {
    attestations: Iterable<[Uint8Array, { payload_hash: Uint8Array; owner: Uint8Array }]>;
    disclosures: {
        member(key: Uint8Array): boolean;
        lookup(key: Uint8Array): Iterable<[Uint8Array, bigint]>;
    };
}

export interface DisclosureGrantRecord {
    attesterId: string;
    payloadHash: string;
    grantee: string;
    level: number;
}

/** Every active grant; enumerates keys via `attestations` since the outer `disclosures` map is not iterable. */
export function enumerateGrants(led: DisclosureLedger): DisclosureGrantRecord[] {
    const rows: DisclosureGrantRecord[] = [];
    for (const [recordKey, record] of led.attestations) {
        if (!led.disclosures.member(recordKey)) continue;
        for (const [granteeBytes, levelBig] of led.disclosures.lookup(recordKey)) {
            rows.push({
                attesterId: hex(record.owner),
                payloadHash: hex(record.payload_hash),
                grantee: hex(granteeBytes),
                level: Number(levelBig)
            });
        }
    }
    return rows;
}

export interface ReindexDeps {
    db: any;
    contractAddress: string;
    /** The compiled artifact's `ledger` decoder. */
    ledger: (state: any) => DisclosureLedger;
    /** publicDataProvider.queryContractState; with a height, the state as of that block. */
    queryContractState: (contractAddress: string, atHeight?: number) => Promise<any | null>;
    /** Landed height of the change that triggered this reindex; the state is read as of it. */
    atHeight?: number | null;
    /** Latest indexed block height; used when `atHeight` is not given. */
    queryTipHeight?: () => Promise<number | null>;
    /**
     * Rows without a recorded height modified within this window (default 10 min)
     * are not swept: the queried state may predate a just-submitted grant.
     */
    sweepGraceMs?: number;
}

export interface ReindexResult {
    /** Grants found on-chain for this contract. */
    indexed: number;
    /** Previously-active rows flipped to inactive (revoked on-chain). */
    deactivated: number;
    /** Block height the snapshot was read at; null when unknown. */
    snapshotHeight: number | null;
}

export const DEFAULT_SWEEP_GRACE_MS = 10 * 60 * 1000;

// One reindex per contract at a time: two interleaved passes could write
// each other's older snapshot last.
const reindexChains = new Map<string, Promise<unknown>>();

function heightOf(row: any): number | null {
    const h = row?.changedAtHeight;
    if (h === null || h === undefined || h === '') return null;
    const n = Number(h);
    return Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * Idempotent upsert of one contract's grants (keeps the handler's `grantedTxHash`);
 * active rows missing on-chain are swept inactive. Serialized per contract.
 */
export function reindexDisclosures(deps: ReindexDeps): Promise<ReindexResult> {
    const key = deps.contractAddress.toLowerCase();
    const previous = reindexChains.get(key) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(() => reindexOnce(deps));
    reindexChains.set(key, run);
    run.finally(() => { if (reindexChains.get(key) === run) reindexChains.delete(key); }).catch(() => undefined);
    return run;
}

async function reindexOnce(deps: ReindexDeps): Promise<ReindexResult> {
    const { db, ledger, queryContractState } = deps;
    const contractAddress = deps.contractAddress.toLowerCase();
    const sweepGraceMs = deps.sweepGraceMs ?? DEFAULT_SWEEP_GRACE_MS;

    let height: number | null = deps.atHeight ?? null;
    if (height === null && deps.queryTipHeight) {
        try { height = await deps.queryTipHeight(); } catch { height = null; }
    }
    const state = await queryContractState(contractAddress, height ?? undefined);
    if (!state) return { indexed: 0, deactivated: 0, snapshotHeight: height };

    // ContractState carries the ledger in `.data`; `ledger()` also takes a bare StateValue.
    const led = ledger(state.data ?? state);
    const onChain = enumerateGrants(led);

    const now = new Date().toISOString();
    const seen = new Set<string>();
    const stamp = height === null ? {} : { changedAtHeight: height };

    for (const g of onChain) {
        seen.add(`${g.attesterId}|${g.payloadHash}|${g.grantee}`);
        const existing: any = await db.run(
            SELECT.one.from(DisclosureGrants).where({
                contractAddress, attesterId: g.attesterId, payloadHash: g.payloadHash, grantee: g.grantee
            })
        );
        if (existing) {
            const rowHeight = heightOf(existing);
            // Newer than the snapshot: the row already reflects a later change.
            if (height !== null && rowHeight !== null && rowHeight > height) continue;
            // Unordered snapshot: a confirmed revoke is never revived by it.
            if (height === null && rowHeight !== null && existing.revokedTxHash) continue;
            // Compare-and-set on the height read above: a revoke confirmed in
            // between carries a newer height and must not be overwritten.
            await db.run(UPDATE.entity(DisclosureGrants)
                .set({ level: g.level, active: true, revokedTxHash: null, modifiedAt: now, ...stamp })
                .where({ ID: existing.ID, changedAtHeight: rowHeight }));
        } else {
            await db.run(INSERT.into(DisclosureGrants).entries({
                ID: cds.utils.uuid(),
                payloadHash: g.payloadHash,
                attesterId: g.attesterId,
                grantee: g.grantee,
                level: g.level,
                contractAddress,
                grantedTxHash: null,
                revokedTxHash: null,
                active: true,
                changedAtHeight: height,
                createdAt: now,
                modifiedAt: now
            }));
        }
    }

    // Rows with a height are ordered against the snapshot; without, the grace window applies.
    const activeRows: any[] = (await db.run(
        SELECT.from(DisclosureGrants).where({ contractAddress, active: true })
    )) || [];

    const cutoff = Date.now() - sweepGraceMs;
    let deactivated = 0;
    for (const r of activeRows) {
        if (seen.has(`${r.attesterId ?? ''}|${r.payloadHash}|${r.grantee}`)) continue;
        const rowHeight = heightOf(r);
        if (height !== null && rowHeight !== null) {
            if (rowHeight > height) continue;
        } else {
            const modifiedAtMs = r.modifiedAt ? Date.parse(r.modifiedAt) : NaN;
            if (Number.isFinite(modifiedAtMs) && modifiedAtMs > cutoff) continue;
        }
        await db.run(UPDATE.entity(DisclosureGrants)
            .set({ active: false, modifiedAt: now, ...stamp })
            .where({ ID: r.ID, changedAtHeight: rowHeight }));
        deactivated++;
    }

    return { indexed: onChain.length, deactivated, snapshotHeight: height };
}

/** Indexer tip height, or null: a failure leaves the reindex unordered rather than failing it. */
export async function queryIndexerTipHeight(indexerHttpUrl: string, fetchFn: typeof fetch = fetch): Promise<number | null> {
    try {
        const r = await fetchFn(indexerHttpUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ query: '{ block { height } }' })
        });
        if (!r.ok) return null;
        const j: any = await r.json();
        const h = Number(j?.data?.block?.height);
        return Number.isInteger(h) && h >= 0 ? h : null;
    } catch {
        return null;
    }
}

export interface ReindexForContractArgs {
    db: any;
    contractAddress: string;
    /** Compiled contract artifact (`.../contract/index.js`). */
    artifactPath: string;
    contractProvidersConfig: import('../midnight/providers').ContractProvidersConfig;
    /** Landed height of the change this reindex follows; the snapshot is read as of it. */
    atHeight?: number | null;
}

/**
 * Reindex with real providers and the artifact's `ledger`. Callers treat it as
 * best-effort: an indexing failure must not fail the grant/revoke submission.
 */
export async function reindexDisclosuresForContract(
    args: ReindexForContractArgs
): Promise<ReindexResult> {
    const { db, contractAddress, artifactPath, contractProvidersConfig } = args;

    const { buildContractProviders } = await import('../midnight/providers.js');
    const bundle = await buildContractProviders(contractProvidersConfig);
    const artifact: any = await importArtifactByPath(artifactPath);

    return reindexDisclosures({
        db,
        contractAddress,
        ledger: artifact.ledger,
        atHeight: args.atHeight ?? null,
        queryTipHeight: () => queryIndexerTipHeight(contractProvidersConfig.indexerHttpUrl),
        queryContractState: (addr: string, atHeight?: number) => bundle.publicDataProvider.queryContractState(
            addr, atHeight === undefined ? undefined : { type: 'blockHeight', blockHeight: atHeight })
    });
}
