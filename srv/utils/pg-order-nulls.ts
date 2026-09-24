/**
 * ORDER BY on PostgreSQL: no NULLS clause for columns that cannot be NULL.
 *
 * @cap-js/postgres renders every ordering term as `ASC NULLS FIRST` /
 * `DESC NULLS LAST` (SQLite's and HANA's null order). A Postgres btree index
 * is `ASC NULLS LAST` (backwards `DESC NULLS FIRST`), so the planner cannot
 * walk an index for such an ORDER BY and sorts the table before the LIMIT;
 * CAP orders every `$top` read by the entity key. For a key or `not null`
 * column the placement is meaningless, so it is dropped and the plain `ASC` /
 * `DESC` matches the primary key and the secondary indexes. Nullable columns
 * and an explicit `nulls` on the term keep the clause, as does a column
 * reached through a join (an outer join yields NULL). Installed once on the
 * driver's renderer class. SPDX-License-Identifier: Apache-2.0
 */
import cds from '@sap/cds';

const log = cds.log('nightgate:pg-order-nulls');
const INSTALLED = Symbol.for('nightgate.pgOrderNulls');

interface OrderTerm { ref?: string[]; nulls?: string; element?: { key?: boolean; notNull?: boolean } }
interface FromShape { ref?: unknown[]; as?: string; join?: string; args?: FromShape[] }
interface SelectShape { from?: FromShape; columns?: Array<{ ref?: string[]; as?: string }> }
type OrderByFn = (this: { cqn?: { SELECT?: SelectShape } }, orderBy: OrderTerm[], ...rest: unknown[]) => string[];

/** Alias of the query's own table, the one every result row comes from; undefined for a subselect source. */
function sourceAlias(from: FromShape | undefined): string | undefined {
    if (!from) return undefined;
    if (from.ref) return from.as;
    if ((from.join === 'left' || from.join === 'inner') && from.args?.length) return sourceAlias(from.args[0]);
    return undefined;
}

/** The column ref an ordering term stands for: its own, or the one behind a column alias. */
function termRef(term: OrderTerm, columns: SelectShape['columns']): string[] | undefined {
    const ref = term.ref;
    if (ref?.length === 1 && columns) {
        const col = columns.find(c => (c.as ?? c.ref?.[c.ref.length - 1]) === ref[0]);
        if (col?.ref) return col.ref;
    }
    return ref;
}

/**
 * Strips the null placement from the rendered terms whose column cannot be
 * NULL: a key or NOT NULL column of the query's own table. The same column
 * reached through a join (`parent.height`, an outer join) can be NULL and
 * keeps the clause.
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

/** Wraps the driver's `_orderBy` once; returns false when the driver or the hook is missing. */
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
