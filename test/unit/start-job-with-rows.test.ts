import { beforeAll, describe, expect, it, vi } from 'vitest';
import cds from '@sap/cds';
import { startJobWithRows } from '../../srv/submission/actions/common';
import { Documents } from '#cds-models/midnight';

let insert: unknown;

beforeAll(async () => {
    cds.model = cds.linked(await cds.load('db'));
    insert = cds.ql.INSERT.into(Documents).entries({ ID: 'doc-1' });
});
const isDelete = (q: any) => Boolean(q?.DELETE);

describe('startJobWithRows', () => {
    it('writes the rows before the job starts and keeps them for a new job', async () => {
        const order: string[] = [];
        const db = { run: vi.fn(async (q: any) => { order.push(isDelete(q) ? 'delete' : 'insert'); }) };
        const job = await startJobWithRows(db, Documents, ['doc-1'], insert, async () => {
            order.push('start');
            return { jobId: 'j', status: 'pending' as const, deduplicated: false };
        });
        expect(job.jobId).toBe('j');
        expect(order).toEqual(['insert', 'start']);
    });

    it('removes the rows when the job does not start', async () => {
        const db = { run: vi.fn(async (_q: unknown) => undefined) };
        await expect(startJobWithRows(db, Documents, ['doc-1'], insert, async () => { throw new Error('admission busy'); }))
            .rejects.toThrow('admission busy');
        expect(db.run.mock.calls.filter(([q]) => isDelete(q))).toHaveLength(1);
    });

    it('removes the rows when a repeated request reuses an earlier job', async () => {
        const db = { run: vi.fn(async (_q: unknown) => undefined) };
        await startJobWithRows(db, Documents, ['doc-1'], insert, async () => ({ jobId: 'old', status: 'succeeded' as const, deduplicated: true }));
        expect(db.run.mock.calls.filter(([q]) => isDelete(q))).toHaveLength(1);
    });
});
