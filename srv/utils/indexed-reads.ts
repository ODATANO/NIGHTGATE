// SPDX-License-Identifier: Apache-2.0
import cds from '@sap/cds';
import type { Request, predicate, ordering_term } from '@sap/cds';
import { NIGHTGATE_INDEXES } from './db-indexes';
import { NightgateError } from './errors';

/** Operators a B-tree index can serve. */
const INDEX_OPERATORS = new Set(['=', '==', '<', '<=', '>', '>=', 'in', 'is', 'between']);

type Token = predicate[number];

const nameOf = (token: Token): string | undefined => {
    const ref = (token as { ref?: unknown[] })?.ref;
    if (!Array.isArray(ref) || !ref.every(s => typeof s === 'string')) return undefined;
    return (ref as string[]).join('_').toLowerCase();
};

function splitAt(tokens: predicate, keyword: string): predicate[] {
    const parts: predicate[] = [[]];
    for (const token of tokens) {
        if (typeof token === 'string' && token.toLowerCase() === keyword) parts.push([]);
        else parts[parts.length - 1].push(token);
    }
    return parts;
}

function conditionUsesIndex(tokens: predicate, indexed: ReadonlySet<string>): boolean {
    if (tokens.length === 1) {
        const inner = (tokens[0] as { xpr?: predicate }).xpr;
        return Array.isArray(inner) && whereUsesIndex(inner, indexed);
    }
    const [left, op, right] = tokens;
    if (typeof op !== 'string' || !INDEX_OPERATORS.has(op.toLowerCase())) return false;
    // `x is not null` reads every row that has a value.
    if (op.toLowerCase() === 'is' && typeof right === 'string' && right.toLowerCase() === 'not') return false;
    const column = nameOf(left) ?? (op.toLowerCase() === 'is' ? undefined : nameOf(right));
    return column !== undefined && indexed.has(column);
}

/** True when the database can find the rows through an index: one condition joined with `and` uses it, or every branch of an `or` does. */
export function whereUsesIndex(where: predicate, indexed: ReadonlySet<string>): boolean {
    const branches = splitAt(where, 'or');
    if (branches.length > 1) return branches.every(b => whereUsesIndex(b, indexed));
    return splitAt(where, 'and').some(c => conditionUsesIndex(c, indexed));
}

/** The first column of every index and unique constraint of a table, in lowercase. */
export function indexedColumns(entity: cds.entity): Set<string> {
    const table = entity.name.replace(/\./g, '_');
    const columns = new Set<string>();
    const add = (element: string): void => {
        // A managed association is stored as its foreign key, such as `block_ID`.
        const keys = (entity.elements[element] as { keys?: Array<{ $generatedFieldName?: string }> } | undefined)?.keys;
        columns.add((keys?.[0]?.$generatedFieldName ?? element).toLowerCase());
    };
    const firstKey = Object.keys(entity.keys ?? {})[0];
    if (firstKey) add(firstKey);
    for (const [name, value] of Object.entries(entity)) {
        if (!name.startsWith('@assert.unique') || !Array.isArray(value) || !value.length) continue;
        const first = value[0] as { '='?: string } | string;
        add(typeof first === 'string' ? first : String(first['=']));
    }
    for (const spec of NIGHTGATE_INDEXES) {
        // A partial index serves only reads that repeat its condition.
        if (spec.table === table && !spec.where) columns.add(spec.columns[0].split(' ')[0].toLowerCase());
    }
    return columns;
}

/** The database entity a service entity reads from. */
function baseEntity(served: cds.entity): cds.entity | undefined {
    const from = (served.query as { SELECT?: { from?: { ref?: unknown[] } } } | undefined)?.SELECT?.from?.ref?.[0];
    const name = typeof from === 'string' ? from : (from as { id?: string } | undefined)?.id;
    const base = name ? cds.model?.definitions?.[name] : undefined;
    return base && base.kind === 'entity' ? base as cds.entity : undefined;
}

/** Why the read cannot use an index, or null when it can. A read along a key or an association is narrowed by its path. */
export function unindexedReason(query: { SELECT?: { from?: unknown; where?: predicate; orderBy?: ordering_term[]; search?: unknown; groupBy?: unknown[]; having?: unknown } }, indexed: ReadonlySet<string>): string | null {
    const select = query.SELECT;
    if (!select) return null;
    if (select.search) return '$search is not supported';
    if (select.groupBy?.length || select.having) return '$apply with grouping is not supported';
    const path = (select.from as { ref?: unknown[] } | undefined)?.ref;
    if (path && (path.length > 1 || (path[0] as { where?: unknown })?.where)) return null;
    if (select.where?.length && !whereUsesIndex(select.where, indexed)) return '$filter needs a condition with =, <, <=, >, >=, in or eq null on an indexed column, joined with and';
    const first = select.orderBy?.[0];
    if (first) {
        const column = nameOf(first as Token);
        if (!column || !indexed.has(column)) return '$orderby must start with an indexed column';
    }
    return null;
}

/** Refuses a read of a large table with 400 when its filter or sort would read the whole table. */
export function attachIndexedReads(srv: cds.ApplicationService, entities: readonly string[]): void {
    const indexedOf = new Map<string, Set<string>>();
    for (const name of entities) {
        const served = srv.entities[name];
        const base = served ? baseEntity(served) : undefined;
        if (!base) throw new Error(`attachIndexedReads: ${srv.name}.${name} reads from no database entity`);
        indexedOf.set(name, new Set([...indexedColumns(base)].filter(c => Object.keys(served.elements).some(e => e.toLowerCase() === c))));
    }
    srv.before('READ', [...entities], (req: Request) => {
        const name = String(req.target?.name ?? '').slice(srv.name.length + 1);
        const indexed = indexedOf.get(name);
        if (!indexed) return;
        const reason = unindexedReason(req.query as Parameters<typeof unindexedReason>[0], indexed);
        if (!reason) return;
        const elements = Object.keys(srv.entities[name].elements);
        const columns = [...indexed].map(c => elements.find(e => e.toLowerCase() === c) ?? c).join(', ');
        return req.reject(new NightgateError('QUERY_NOT_INDEXED', `${name}: ${reason}. Indexed columns: ${columns}`));
    });
}
