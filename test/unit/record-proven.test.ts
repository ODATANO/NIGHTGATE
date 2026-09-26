import { describe, it, expect, vi, afterEach } from 'vitest';
import { recordProven } from '../../srv/submission/handlers';
import { WorkflowReconciliationRequiredError } from '../../srv/submission/background-jobs';
import { __setLockContentionBackoffForTests, __resetLockContentionBackoffForTests } from '../../srv/submission/db-write-retry';

describe('recordProven', () => {
    afterEach(() => __resetLockContentionBackoffForTests());

    it('retries a lock-contention failure and succeeds', async () => {
        __setLockContentionBackoffForTests([0, 0, 0, 0, 0]);
        const write = vi.fn()
            .mockRejectedValueOnce(Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' }))
            .mockResolvedValueOnce(1);
        await expect(recordProven('job-1', 'aa'.repeat(32), write)).resolves.toBeUndefined();
        expect(write).toHaveBeenCalledTimes(2);
    });

    it('parks the parent for reconciliation when the write still fails, instead of failing it', async () => {
        __setLockContentionBackoffForTests([0, 0, 0, 0, 0]);
        const write = vi.fn().mockRejectedValue(new Error('connection terminated'));
        const err = await recordProven('job-2', 'bb'.repeat(32), write).catch(e => e);
        expect(err).toBeInstanceOf(WorkflowReconciliationRequiredError);
        expect(err.message).toMatch(/job-2 is on chain \(b{64}\) but recording it failed: connection terminated/);
    });
});
