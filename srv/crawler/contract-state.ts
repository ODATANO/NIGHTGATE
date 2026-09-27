/**
 * How contract state is stored.
 *
 * A contract's state is hundreds of kilobytes and changes with every call, so a
 * full copy per action grows faster than everything else in the index. Every
 * action keeps a sha256 and the size of its state; the newest state per
 * contract lives in `ContractStates`; the full per-action state is kept only
 * for the history the operator asks for. Older states are read from the
 * indexer on demand and checked against the stored hash.
 */

import { createHash } from 'node:crypto';
import cds from '@sap/cds';
import { readCapBinary } from './cap-binary';
import { ContractActions, ContractStates, SyncState, type ContractAction } from '#cds-models/midnight';
import type { DbRunner, DbService, Row } from '../utils/db-types';

const { SELECT, INSERT, UPDATE } = cds.ql;

export const CONTRACT_STATE_HISTORY_MODES = ['none', 'watched', 'all'] as const;
export type ContractStateHistory = typeof CONTRACT_STATE_HISTORY_MODES[number];

export interface ContractStatePolicy {
    /** Which actions keep their full state: none, the watched contracts, or all. */
    history: ContractStateHistory;
    /** Normalized addresses (lowercase hex, no 0x) for `watched`. */
    watched: ReadonlySet<string>;
}

export const DEFAULT_CONTRACT_STATE_POLICY: ContractStatePolicy = { history: 'none', watched: new Set() };

export function normalizeContractAddress(address: string): string {
    return address.trim().toLowerCase().replace(/^0x/, '');
}

export function contractStatePolicy(history: string | undefined, watched: readonly string[] = []): ContractStatePolicy {
    const mode = (CONTRACT_STATE_HISTORY_MODES as readonly string[]).includes(history ?? '')
        ? history as ContractStateHistory
        : 'none';
    return { history: mode, watched: new Set(watched.map(normalizeContractAddress).filter(Boolean)) };
}

export function keepsStateHistory(policy: ContractStatePolicy, address: string | null | undefined): boolean {
    if (policy.history === 'all') return true;
    if (policy.history === 'watched' && address) return policy.watched.has(normalizeContractAddress(address));
    return false;
}

export interface StateDigest {
    hash: string | null;
    size: number | null;
}

export function digestOf(bytes: Buffer | null): StateDigest {
    if (!bytes) return { hash: null, size: null };
    return { hash: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
}

export function digestOfBase64(value: string | null | undefined): StateDigest {
    return digestOf(value == null ? null : Buffer.from(value, 'base64'));
}

export interface CurrentStateRow {
    address: string;
    height: number;
    state: string | null;
    zswapState: string | null;
    stateHash: string | null;
    zswapStateHash: string | null;
    contractActionId: string;
}

/**
 * Makes `row` the contract's current state unless a state from a higher block
 * is stored. The same height replaces: within a block the supplement applies
 * the transactions in order, so the last action wins, and a re-run is idempotent.
 */
export async function upsertCurrentState(tx: DbRunner, row: CurrentStateRow): Promise<boolean> {
    const address = normalizeContractAddress(row.address);
    const existing: any = await tx.run(
        SELECT.one.from(ContractStates).columns('height').where({ address })
    );
    if (existing && Number(existing.height) > row.height) return false;
    const values = {
        height: row.height,
        state: row.state as any,
        zswapState: row.zswapState as any,
        stateHash: row.stateHash,
        zswapStateHash: row.zswapStateHash,
        contractAction_ID: row.contractActionId
    };
    if (existing) {
        await tx.run(UPDATE.entity(ContractStates).set(values).where({ address }));
    } else {
        await tx.run(INSERT.into(ContractStates).entries({ address, ...values }));
    }
    return true;
}

export interface ContractStateSnapshot {
    address: string;
    /** Block of the action the state comes from. */
    height: number | null;
    /** base64 */
    state: string | null;
    zswapState: string | null;
    stateHash: string | null;
    zswapStateHash: string | null;
    /** `history` (stored per action), `current` (ContractStates) or `indexer`. */
    source: 'history' | 'current' | 'indexer';
    /** For `indexer`: the fetched bytes match the hash stored for that action. Null when there is none to compare. */
    verified: boolean | null;
}

export type ContractStateFetcher = (
    address: string,
    height: number | null
) => Promise<{ state: string | null; zswapState: string | null } | null>;

function base64Of(bytes: Buffer | null): string | null {
    return bytes ? bytes.toString('base64') : null;
}

/**
 * The contract's state as of `height` (its newest action at or below it), or
 * its current state when `height` is null. Served from the database when it
 * holds that state, otherwise fetched from the indexer and verified against
 * the stored hash. Null when neither knows an action of the contract.
 */
export async function contractStateAt(
    db: DbService,
    rawAddress: string,
    height: number | null,
    fetchState: ContractStateFetcher
): Promise<ContractStateSnapshot | null> {
    const address = normalizeContractAddress(rawAddress);
    const current: any = await db.run(
        SELECT.one.from(ContractStates)
            .columns('address', 'height', 'state', 'zswapState', 'stateHash', 'zswapStateHash', 'contractAction_ID')
            .where({ address })
    );

    const fromCurrent = async (): Promise<ContractStateSnapshot> => ({
        address,
        height: Number(current.height),
        state: base64Of(await readCapBinary(current.state)),
        zswapState: base64Of(await readCapBinary(current.zswapState)),
        stateHash: current.stateHash ?? null,
        zswapStateHash: current.zswapStateHash ?? null,
        source: 'current',
        verified: null
    });

    if (height == null && current) return fromCurrent();

    // The crawler records every action up to its tip, supplemented or not; above
    // it a newer action may be missing, so no local row speaks for that height.
    const sync: any = height == null ? null : await db.run(
        SELECT.one.from(SyncState).columns('lastIndexedHeight').where({ ID: 'SINGLETON' })
    );
    const covered = height != null && sync?.lastIndexedHeight != null && height <= Number(sync.lastIndexedHeight);

    let newest: any = null;
    if (covered) {
        newest = await db.run(
            SELECT.one.from(ContractActions)
                .columns('ID', 'state', 'zswapState', 'stateHash', 'zswapStateHash', 'transaction.block.height as height')
                .where({ address })
                .and({ 'transaction.block.height': { '<=': height } })
                .orderBy('transaction.block.height desc', 'transaction.transactionId desc', 'actionIndex desc')
        );
        if (newest) {
            const state = await readCapBinary(newest.state);
            if (state) {
                return {
                    address,
                    height: Number(newest.height),
                    state: state.toString('base64'),
                    zswapState: base64Of(await readCapBinary(newest.zswapState)),
                    stateHash: newest.stateHash ?? null,
                    zswapStateHash: newest.zswapStateHash ?? null,
                    source: 'history',
                    verified: null
                };
            }
            if (current && current.contractAction_ID === newest.ID) return fromCurrent();
        }
    }

    const fetched = await fetchState(address, height);
    if (!fetched) return null;
    const digest = digestOfBase64(fetched.state);
    const zswapDigest = digestOfBase64(fetched.zswapState);
    const expected = newest?.stateHash ?? null;
    return {
        address,
        height: newest ? Number(newest.height) : null,
        state: fetched.state,
        zswapState: fetched.zswapState,
        stateHash: digest.hash,
        zswapStateHash: zswapDigest.hash,
        source: 'indexer',
        verified: expected ? expected === digest.hash : null
    };
}

export interface CompactionReport {
    contracts: number;
    currentStatesWritten: number;
    actionsHashed: number;
    statesCleared: number;
}

/**
 * Moves stored per-action states to the layout above: the newest state per
 * contract into ContractStates, a hash and size onto every action, the full
 * state cleared unless the policy keeps it. Idempotent; run with the server
 * (or at least its supplement pass) stopped. The freed space returns to the
 * file system only after `VACUUM FULL` (PostgreSQL) or `VACUUM` (SQLite).
 */
export async function compactStoredContractState(
    db: DbService,
    opts: { policy: ContractStatePolicy; batchSize?: number; dryRun?: boolean; log?: (msg: string) => void }
): Promise<CompactionReport> {
    const batchSize = Math.max(1, opts.batchSize ?? 100);
    const log = opts.log ?? (() => undefined);
    const report: CompactionReport = { contracts: 0, currentStatesWritten: 0, actionsHashed: 0, statesCleared: 0 };

    const addresses: Pick<ContractAction, 'address'>[] = await db.run(
        SELECT.distinct.from(ContractActions).columns('address').where({ state: { '!=': null } })
    ) || [];
    report.contracts = addresses.length;
    log(`${addresses.length} contract(s) with stored per-action state`);

    for (const { address } of addresses) {
        if (!address) continue;
        const newest: (Row<ContractAction, 'ID'> & { height?: number | null }) | undefined = await db.run(
            SELECT.one.from(ContractActions)
                .columns('ID', 'state', 'zswapState', 'transaction.block.height as height')
                .where({ address, state: { '!=': null } })
                .orderBy('transaction.block.height desc', 'transaction.transactionId desc', 'actionIndex desc')
        );
        if (!newest || opts.dryRun) {
            if (newest) report.currentStatesWritten++;
            continue;
        }
        const state = await readCapBinary(newest.state);
        const zswapState = await readCapBinary(newest.zswapState);
        const written = await db.tx((tx) => upsertCurrentState(tx, {
            address,
            height: Number(newest.height),
            state: base64Of(state),
            zswapState: base64Of(zswapState),
            stateHash: digestOf(state).hash,
            zswapStateHash: digestOf(zswapState).hash,
            contractActionId: newest.ID
        }));
        if (written) report.currentStatesWritten++;
    }
    log(`${report.currentStatesWritten} current state(s) ${opts.dryRun ? 'to write' : 'written'}`);

    let last: string | undefined;
    for (;;) {
        // A dry run only counts: it need not pull every stored state through.
        const columns = opts.dryRun ? ['ID', 'address'] : ['ID', 'address', 'state', 'zswapState'];
        let query = SELECT.from(ContractActions)
            .columns(...columns)
            .where({ state: { '!=': null } })
            .orderBy('ID')
            .limit(batchSize);
        if (last !== undefined) query = query.and({ ID: { '>': last } });
        const rows: any[] = await db.run(query) || [];
        if (rows.length === 0) break;
        last = String(rows[rows.length - 1].ID);

        const updates: Array<{ id: string; values: Record<string, unknown> }> = [];
        for (const row of rows) {
            if (opts.dryRun) {
                report.actionsHashed++;
                if (!keepsStateHistory(opts.policy, row.address)) report.statesCleared++;
                continue;
            }
            const state = digestOf(await readCapBinary(row.state));
            const zswap = digestOf(await readCapBinary(row.zswapState));
            const keep = keepsStateHistory(opts.policy, row.address);
            updates.push({
                id: row.ID,
                values: {
                    stateHash: state.hash,
                    stateSize: state.size,
                    zswapStateHash: zswap.hash,
                    zswapStateSize: zswap.size,
                    ...(keep ? {} : { state: null, zswapState: null })
                }
            });
            report.actionsHashed++;
            if (!keep) report.statesCleared++;
        }
        if (!opts.dryRun) {
            await db.tx(async (tx) => {
                for (const u of updates) await tx.run(UPDATE.entity(ContractActions).set(u.values).where({ ID: u.id }));
            });
        }
        if (report.actionsHashed % (batchSize * 50) < batchSize) log(`${report.actionsHashed} action(s) hashed`);
    }
    log(`${report.actionsHashed} action(s) hashed, ${report.statesCleared} full state(s) ${opts.dryRun ? 'to clear' : 'cleared'}`);
    return report;
}
