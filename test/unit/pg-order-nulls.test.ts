/**
 * ORDER BY on PostgreSQL (srv/utils/pg-order-nulls.ts): rendered through the
 * real @cap-js/postgres renderer against a tiny model, so a driver that changes
 * its ordering terms fails here instead of silently sorting the table again.
 */
import { describe, it, expect } from 'vitest';
import cds from '@sap/cds';
import { installPostgresOrderNulls, stripNullsForNotNull } from '../../srv/utils/pg-order-nulls';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const PostgresService = require('@cap-js/postgres/lib/PostgresService');

function renderer() {
    const csn = cds.compile.to.csn(`namespace t; entity Blocks { key ID: UUID; height: Integer64 not null; note: String; parent: Association to Blocks; }`);
    cds.model = cds.linked(csn);
    const srv = new PostgresService('db', cds.model, { kind: 'postgres', credentials: {} });
    return (q: unknown) => String(srv.cqn2sql(q).sql).replace(/^.*FROM/, 'FROM');
}

describe('stripNullsForNotNull', () => {
    const select = { from: { ref: ['t.Blocks'], as: '$B' }, columns: [{ ref: ['$B', 'ID'] }, { ref: ['parent', 'height'], as: 'ph' }] };

    it('drops the clause for key and NOT NULL columns of the source, keeps it for nullable ones and for an explicit nulls', () => {
        const terms = [
            { ref: ['$B', 'ID'], element: { key: true } },
            { ref: ['$B', 'height'], element: { notNull: true } },
            { ref: ['$B', 'note'], element: {} },
            { ref: ['$B', 'ID'], nulls: 'first', element: { key: true } }
        ];
        const rendered = ['"$b".ID ASC NULLS FIRST', '"$b".height DESC NULLS LAST', '"$b".note ASC NULLS FIRST', '"$b".ID ASC NULLS FIRST'];
        expect(stripNullsForNotNull(terms, rendered, select)).toEqual(['"$b".ID ASC', '"$b".height DESC', '"$b".note ASC NULLS FIRST', '"$b".ID ASC NULLS FIRST']);
    });

    it('keeps the clause for a NOT NULL column behind a join, for an alias of one, and without the query', () => {
        const terms = [
            { ref: ['parent', 'height'], element: { notNull: true } },
            { ref: ['ph'], element: { notNull: true } },
            { ref: ['$B', 'ID'], element: { key: true } }
        ];
        const rendered = ['parent.height ASC NULLS FIRST', 'ph ASC NULLS FIRST', '"$b".ID ASC NULLS FIRST'];
        const joined = { ...select, from: { join: 'left', args: [select.from, { ref: ['t.Blocks'], as: 'parent' }] } };
        expect(stripNullsForNotNull(terms, rendered, joined)).toEqual(['parent.height ASC NULLS FIRST', 'ph ASC NULLS FIRST', '"$b".ID ASC']);
        expect(stripNullsForNotNull(terms, rendered)).toEqual(rendered);
        expect(stripNullsForNotNull(terms, rendered, { from: { SELECT: {} } as any })).toEqual(rendered);
    });
});

describe('installPostgresOrderNulls', () => {
    it('renders ORDER BY on the key and on a NOT NULL column without NULLS, a nullable column with it; installs once', () => {
        const { SELECT } = cds.ql;
        expect(installPostgresOrderNulls()).toBe(true);
        expect(installPostgresOrderNulls()).toBe(true);
        const render = renderer();
        expect(render(SELECT.from('t.Blocks').orderBy('ID').limit(1))).toBe('FROM t_Blocks as "$b" ORDER BY "$b".ID ASC LIMIT $1');
        expect(render(SELECT.from('t.Blocks').orderBy('height desc').limit(1))).toBe('FROM t_Blocks as "$b" ORDER BY "$b".height DESC LIMIT $1');
        expect(render(SELECT.from('t.Blocks').orderBy('note').limit(1))).toBe('FROM t_Blocks as "$b" ORDER BY "$b".note ASC NULLS FIRST LIMIT $1');
    });

    it('keeps NULLS for a NOT NULL column reached through a join: the outer join yields NULL where the parent is absent', () => {
        const { SELECT } = cds.ql;
        expect(installPostgresOrderNulls()).toBe(true);
        const render = renderer();
        expect(render(SELECT.from('t.Blocks').orderBy('parent.height').limit(1)))
            .toBe('FROM t_Blocks as "$b" left JOIN t_Blocks as parent ON parent.ID = "$b".parent_ID ORDER BY parent.height ASC NULLS FIRST LIMIT $1');
        expect(render(SELECT.from('t.Blocks').columns('ID', 'parent.height as ph').orderBy('ph').limit(1)))
            .toBe('FROM t_Blocks as "$b" left JOIN t_Blocks as parent ON parent.ID = "$b".parent_ID ORDER BY ph ASC NULLS FIRST LIMIT $1');
        // The source's own key still drops it next to a join (a selected column is ordered by its bare name).
        expect(render(SELECT.from('t.Blocks').columns('ID', 'parent.height as ph').orderBy('ID').limit(1)))
            .toBe('FROM t_Blocks as "$b" left JOIN t_Blocks as parent ON parent.ID = "$b".parent_ID ORDER BY ID ASC LIMIT $1');
    });
});
