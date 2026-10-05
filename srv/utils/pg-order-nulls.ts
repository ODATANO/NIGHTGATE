/**
 * Removes the NULLS FIRST or NULLS LAST clause from ORDER BY on PostgreSQL for columns that cannot be NULL.
 * The CAP Postgres driver always adds such a clause, and it does not match the order of a normal Postgres index.
 * So Postgres would sort the whole table instead of reading the index. For non-null columns the clause has no effect anyway.
 * SPDX-License-Identifier: Apache-2.0
 */
import cds from '@sap/cds';

const log = cds.log('nightgate:pg-order-nulls');
const INSTALLED = Symbol.for('nightgate.pgOrderNulls');

interface OrderTerm { ref?: string[]; nulls?: string; element?: { key?: boolean; notNull?: boolean } }
interface FromShape { ref?: unknown[]; as?: string; join?: string; args?: FromShape[] }
interface SelectShape { from?: FromShape; columns?: Array<{ ref?: string[]; as?: string }> }
type OrderByFn = (this: { cqn?: { SELECT?: SelectShape } }, orderBy: OrderTerm[], ...rest: unknown[]) => string[];

/** Alias of the query's main table. Undefined when the query reads from a subselect. */
function sourceAlias(from: FromShape | undefined): string | undefined {
    if (!from) return undefined;
    if (from.ref) return from.as;
    if ((from.join === 'left' || from.join === 'inner') && from.args?.length) return sourceAlias(from.args[0]);
    return undefined;
}

/** The column an ORDER BY term refers to, resolving a column alias. */
function termRef(term: OrderTerm, columns: SelectShape['columns']): string[] | undefined {
    const ref = term.ref;
    if (ref?.length === 1 && columns) {
        const col = columns.find(c => (c.as ?? c.ref?.[c.ref.length - 1]) === ref[0]);
        if (col?.ref) return col.ref;
    }
    return ref;
}

/**
 * Removes the NULLS clause for key and NOT NULL columns of the main table.
 * A column reached through a join keeps it, because an outer join can produce NULL.
 */
export function stripNullsForNotNull(orderBy: OrderTerm[], rendered: string[], select?: SelectShape): string[] {
    const alias = sourceAlias(select?.from);
    if (alias === undefined) return rendered;
    return rendered.map((sql, i) => {
        const c = orderBy[i];
        if (!c || c.nulls) return sql;
        const el = c.element;
        if (!el || (el.key !== true && el.notNull !== true)) return sql;
        const ref = termRef(c, select?.columns);
        if (!ref || ref.length !== 2 || ref[0] !== alias) return sql;
        return sql.replace(/ NULLS (FIRST|LAST)$/, '');
    });
}

/** Patches the driver's `_orderBy` once. Returns false when the driver or the method is missing. */
export function installPostgresOrderNulls(): boolean {
    let PostgresService: { CQN2SQL?: { prototype: Record<string | symbol, unknown> } };
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        PostgresService = require('@cap-js/postgres/lib/PostgresService');
    } catch {
        log.warn('@cap-js/postgres not installed; ORDER BY keeps the NULLS clause (indexes will not serve ordered reads)');
        return false;
    }
    const proto = PostgresService.CQN2SQL?.prototype;
    const orig = proto?._orderBy as OrderByFn | undefined;
    if (!proto || typeof orig !== 'function') {
        log.warn('@cap-js/postgres has no _orderBy hook; ORDER BY keeps the NULLS clause (indexes will not serve ordered reads)');
        return false;
    }
    if (proto[INSTALLED]) return true;
    proto._orderBy = function (this: { cqn?: { SELECT?: SelectShape } }, orderBy: OrderTerm[], ...rest: unknown[]): string[] {
        return stripNullsForNotNull(orderBy, orig.call(this, orderBy, ...rest), this.cqn?.SELECT);
    };
    proto[INSTALLED] = true;
    log.info('ORDER BY on Postgres: NULLS clause dropped for key and NOT NULL columns');
    return true;
}
