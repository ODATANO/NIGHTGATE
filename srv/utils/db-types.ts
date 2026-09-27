/**
 * Structural database types: `cds.db`, a CAP transaction and a test stub all fit.
 * SPDX-License-Identifier: Apache-2.0
 */

/** Runs CQL statements; rows come back untyped. */
export interface DbRunner {
    run(query: unknown, args?: unknown): Promise<any>;
}

/** A runner that also opens transactions (commit on return, rollback on throw). */
export interface DbService extends DbRunner {
    tx<T>(fn: (tx: DbRunner) => Promise<T>): Promise<T>;
    /** Transaction bound to a context, e.g. `cds.context`. */
    tx(context: object): DbRunner;
}

/** `tx` optional: a test stub without it runs statements directly, without atomicity. */
export type TxCapableDb = DbRunner & Partial<Pick<DbService, 'tx'>>;

/** Entity row read with columns `K`: those are present (generated types mark every field optional). */
export type Row<T, K extends keyof T> = Omit<T, K> & { [P in K]-?: Exclude<T[P], undefined> };
