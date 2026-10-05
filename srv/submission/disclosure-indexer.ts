/**
 * Copies the vault contract's on-chain disclosure grants into `DisclosureGrants`.
 * The chain state is read at a block height. A row changed at a later height is
 * never overwritten, so an old read cannot undo a revoke or lower a level.
 */
import cds from '@sap/cds';
import { DisclosureGrants, type DisclosureGrant } from '#cds-models/midnight';
import { importArtifactByPath } from './contract-registry';
import type { DbRunner } from '../utils/db-types';

const { SELECT, INSERT, UPDATE } = cds.ql;

function hex(b: Uint8Array): string {
    return Buffer.from(b).toString('hex');
}

/** The part of the contract's decoded state that this module reads. */
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

/** All active grants. The `disclosures` map cannot be iterated, so its keys come from `attestations`. */
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
    db: DbRunner;
    contractAddress: string;
    ledger: (state: any) => DisclosureLedger;
    queryContractState: (contractAddress: string, atHeight?: number) => Promise<any | null>;
    /** Block height where the triggering change landed. The state is read at this height. */
    atHeight?: number | null;
    /** Latest indexed block height. Used when `atHeight` is not given. */
    queryTipHeight?: () => Promise<number | null>;
    /**
     * Rows without a height that changed within this window (default 10 min) stay active.
     * The chain state read may be older than a grant that was just submitted.
     */
    sweepGraceMs?: number;
}

export interface ReindexResult {
    indexed: number;
    /** Active rows set inactive because the grant is gone on-chain. */
    deactivated: number;
    snapshotHeight: number | null;
}

export const DEFAULT_SWEEP_GRACE_MS = 10 * 60 * 1000;

// One reindex per contract at a time. Two parallel runs could let the older state win.
const reindexChains = new Map<string, Promise<unknown>>();

function heightOf(row: any): number | null {
    const h = row?.changedAtHeight;
    if (h === null || h === undefined || h === '') return null;
    const n = Number(h);
    return Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * Writes one contract's grants into the table and marks active rows that are gone on-chain inactive.
 * Safe to repeat. Keeps an existing `grantedTxHash`.
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

    // The state may come wrapped with the ledger in `.data`, or bare.
    const led = ledger(state.data ?? state);
    const onChain = enumerateGrants(led);

    const now = new Date().toISOString();
    const seen = new Set<string>();
    const stamp = height === null ? {} : { changedAtHeight: height };

    for (const g of onChain) {
        seen.add(`${g.attesterId}|${g.payloadHash}|${g.grantee}`);
        const existing: DisclosureGrant | undefined = await db.run(
            SELECT.one.from(DisclosureGrants).where({
                contractAddress, attesterId: g.attesterId, payloadHash: g.payloadHash, grantee: g.grantee
            })
        );
        if (existing) {
            const rowHeight = heightOf(existing);
            // The row already holds a later change than this state.
            if (height !== null && rowHeight !== null && rowHeight > height) continue;
            // Without a height we cannot order this state, so it never undoes a confirmed revoke.
            if (height === null && rowHeight !== null && existing.revokedTxHash) continue;
            // Only update if the height is unchanged. A revoke confirmed meanwhile has a newer height.
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

    // Rows with a height are compared by height. Rows without one use the grace window.
    const activeRows: DisclosureGrant[] = (await db.run(
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

/** Latest indexer block height, or null on failure. The reindex then runs without a height. */
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
    db: DbRunner;
    contractAddress: string;
    artifactPath: string;
    contractProvidersConfig: import('../midnight/providers').ContractProvidersConfig;
    atHeight?: number | null;
}

/**
 * Reindexes one contract using the real providers.
 * Callers treat a failure as non-fatal, it must not fail the grant or revoke.
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
