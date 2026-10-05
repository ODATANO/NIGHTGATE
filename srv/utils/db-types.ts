/**
 * Minimal database types that fit `cds.db`, a CAP transaction and a test stub.
 * SPDX-License-Identifier: Apache-2.0
 */

export interface DbRunner {
    run(query: unknown, args?: unknown): Promise<any>;
}

/** A runner that also opens transactions (commit on return, rollback on throw). */
export interface DbService extends DbRunner {
    tx<T>(fn: (tx: DbRunner) => Promise<T>): Promise<T>;
    tx(context: object): DbRunner;
}

/** `tx` is optional. A test stub without it runs statements one by one, not in a transaction. */
export type TxCapableDb = DbRunner & Partial<Pick<DbService, 'tx'>>;

/** An entity row where the columns `K` are known to be set. Generated types mark every field optional. */
export type Row<T, K extends keyof T> = Omit<T, K> & { [P in K]-?: Exclude<T[P], undefined> };
