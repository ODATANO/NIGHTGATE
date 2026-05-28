import { applySqliteTuning } from '../../srv/utils/sqlite-tuning';

describe('applySqliteTuning', () => {
    it('is a no-op when the db service has no .pragma function (HANA / mocked db)', async () => {
        await expect(applySqliteTuning({ run: jest.fn() } as any)).resolves.toBeUndefined();
        await expect(applySqliteTuning(undefined as any)).resolves.toBeUndefined();
    });

    it('applies every tuning pragma and logs the resulting journal/sync mode', async () => {
        const logSpy = jest.spyOn(console, 'log').mockImplementation();
        const pragma = jest.fn()
            .mockResolvedValueOnce(undefined)  // synchronous = NORMAL
            .mockResolvedValueOnce(undefined)  // cache_size
            .mockResolvedValueOnce(undefined)  // temp_store
            .mockResolvedValueOnce(undefined)  // mmap_size
            .mockResolvedValueOnce(undefined)  // wal_autocheckpoint
            .mockResolvedValueOnce('wal')      // diagnostic read: journal_mode
            .mockResolvedValueOnce('normal');  // diagnostic read: synchronous

        try {
            await applySqliteTuning({ pragma } as any);

            expect(pragma).toHaveBeenCalledWith('synchronous = NORMAL');
            expect(pragma).toHaveBeenCalledWith('cache_size = -65536');
            expect(pragma).toHaveBeenCalledWith('temp_store = MEMORY');
            expect(pragma).toHaveBeenCalledWith('mmap_size = 268435456');
            expect(pragma).toHaveBeenCalledWith('wal_autocheckpoint = 1000');
            expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('journal_mode=wal'));
        } finally {
            logSpy.mockRestore();
        }
    });

    it('warns but continues when an individual pragma fails', async () => {
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
        const logSpy = jest.spyOn(console, 'log').mockImplementation();
        const pragma = jest.fn()
            .mockRejectedValueOnce(new Error('synchronous not supported'))
            .mockResolvedValue(undefined);

        try {
            await applySqliteTuning({ pragma } as any);

            expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('failed to set synchronous=NORMAL'));
            // Subsequent pragmas still attempted: 5 set calls + 2 diagnostic reads.
            expect(pragma).toHaveBeenCalledTimes(7);
        } finally {
            warnSpy.mockRestore();
            logSpy.mockRestore();
        }
    });

    it('silently skips the diagnostic log when pragma reads are not supported', async () => {
        const logSpy = jest.spyOn(console, 'log').mockImplementation();
        const pragma = jest.fn().mockImplementation((arg: string) => {
            if (arg === 'journal_mode' || arg === 'synchronous') {
                throw new Error('pragma read not supported');
            }
            return undefined;
        });

        try {
            await applySqliteTuning({ pragma } as any);
            // No "[sqlite-tuning] journal_mode=..." log expected when read fails.
            const tuningLogs = logSpy.mock.calls
                .map((call) => String(call[0]))
                .filter((msg) => msg.includes('[sqlite-tuning]'));
            expect(tuningLogs).toHaveLength(0);
        } finally {
            logSpy.mockRestore();
        }
    });
});
