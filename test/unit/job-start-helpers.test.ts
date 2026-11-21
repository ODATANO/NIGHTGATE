/**
 * What a handler does around a job start: the value budget of a request that
 * only repeated an earlier one goes back, and rows written ahead of a job are
 * removed when no job starts.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const grants = vi.hoisted(() => ({
    consumeValueBudget: vi.fn(async () => true),
    refundValueBudget: vi.fn(async () => undefined),
    currentGrantPolicy: vi.fn()
}));
vi.mock('../../srv/sessions/agent-grants', () => grants);

import { runSubmission, startJobWithRows, takeValueBudget } from '../../srv/submission/actions/common';

const TYPE = 'AB'.repeat(32);
const db = { run: vi.fn() };
const request = (grant: boolean) => ({ agentGrant: grant ? { ID: 'grant-1' } : undefined, reject: vi.fn() }) as any;

describe('the value budget of a repeated request', () => {
    beforeEach(() => {
        grants.consumeValueBudget.mockClear().mockResolvedValue(true);
        grants.refundValueBudget.mockClear();
    });

    it('goes back when the job start only found the earlier job', async () => {
        const req = request(true);
        expect(await takeValueBudget(req, db, TYPE, 500n)).toBe(true);
        const result = await runSubmission(req, async () => ({ jobId: 'j1', status: 'pending', deduplicated: true }));
        expect(result).toMatchObject({ jobId: 'j1', deduplicated: true });
        expect(grants.refundValueBudget).toHaveBeenCalledWith(db, 'grant-1', TYPE.toLowerCase(), 500n);
    });

    it('stays taken when the request started a job', async () => {
        const req = request(true);
        await takeValueBudget(req, db, TYPE, 500n);
        await runSubmission(req, async () => ({ jobId: 'j2', status: 'pending' }));
        expect(grants.refundValueBudget).not.toHaveBeenCalled();
    });

    it('returns nothing for a call without a grant or when the budget refused', async () => {
        await takeValueBudget(request(false), db, TYPE, 500n);
        const refused = request(true);
        grants.consumeValueBudget.mockResolvedValueOnce(false);
        expect(await takeValueBudget(refused, db, TYPE, 500n)).toBe(false);
        await runSubmission(refused, async () => ({ deduplicated: true }));
        expect(grants.refundValueBudget).not.toHaveBeenCalled();
    });

    it('a failed return does not fail the request', async () => {
        const req = request(true);
        await takeValueBudget(req, db, TYPE, 500n);
        grants.refundValueBudget.mockRejectedValueOnce(new Error('database is locked'));
        await expect(runSubmission(req, async () => ({ jobId: 'j3', deduplicated: true }))).resolves.toMatchObject({ jobId: 'j3' });
        expect(req.reject).not.toHaveBeenCalled();
    });
});

describe('rows written ahead of a job', () => {
    const rowsDb = (dropFails: boolean) => ({
        run: vi.fn(async (q: any) => { if (q?.DELETE && dropFails) throw new Error('database is locked'); })
    });

    it('a failed cleanup does not replace the reason no job started', async () => {
        const store = rowsDb(true);
        const reason = new Error('idempotency key was used with a different payload');
        await expect(startJobWithRows(store as any, 'midnight.Documents' as any, ['d1'], { INSERT: {} }, async () => { throw reason; })).rejects.toBe(reason);
        expect(store.run).toHaveBeenCalledTimes(2);
    });

    it('a failed cleanup does not fail a repeated request', async () => {
        const store = rowsDb(true);
        const earlier = { jobId: 'j1', status: 'pending', deduplicated: true };
        await expect(startJobWithRows(store as any, 'midnight.Documents' as any, ['d1'], { INSERT: {} }, async () => earlier as any)).resolves.toBe(earlier);
    });

    it('a started job keeps its rows', async () => {
        const store = rowsDb(false);
        await startJobWithRows(store as any, 'midnight.Documents' as any, ['d1'], { INSERT: {} }, async () => ({ jobId: 'j2', status: 'pending' }) as any);
        expect(store.run).toHaveBeenCalledTimes(1);
    });
});
