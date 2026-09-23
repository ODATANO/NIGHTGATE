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
 * and an explicit `nulls` on the term keep the clause. Installed once on the
 * driver's renderer class. SPDX-License-Identifier: Apache-2.0
 */
import cds from '@sap/cds';

const log = cds.log('nightgate:pg-order-nulls');
const INSTALLED = Symbol.for('nightgate.pgOrderNulls');

interface OrderTerm { nulls?: string; element?: { key?: boolean; notNull?: boolean } }
type OrderByFn = (this: unknown, orderBy: OrderTerm[], ...rest: unknown[]) => string[];

/** Strips the null placement from the rendered terms whose column cannot be NULL. */
export function stripNullsForNotNull(orderBy: OrderTerm[], rendered: string[]): string[] {
    return rendered.map((sql, i) => {
        const c = orderBy[i];
        if (!c || c.nulls) return sql;
        const el = c.element;
        if (el && (el.key === true || el.notNull === true)) return sql.replace(/ NULLS (FIRST|LAST)$/, '');
        return sql;
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
    proto._orderBy = function (this: unknown, orderBy: OrderTerm[], ...rest: unknown[]): string[] {
        return stripNullsForNotNull(orderBy, orig.call(this, orderBy, ...rest));
    };
    proto[INSTALLED] = true;
    log.info('ORDER BY on Postgres: NULLS clause dropped for key and NOT NULL columns');
    return true;
}
