/**
 * Wallet session handler tests
 *
 * Verify disconnect flow consistently uses the public sessionId field.
 */

const mockDbRun = jest.fn();
const selectWhereSpy = jest.fn();
const updateWhereSpy = jest.fn();
const insertEntriesSpy = jest.fn();

jest.mock('@sap/cds', () => {
    const cds: any = {
        env: {
            requires: {
                nightgate: {}
            }
        },
        ql: {
            SELECT: {
                one: {
                    from: jest.fn().mockReturnValue({
                        where: selectWhereSpy
                    })
                }
            },
            INSERT: {
                into: jest.fn().mockReturnValue({
                    entries: insertEntriesSpy
                })
            },
            UPDATE: {
                entity: jest.fn().mockReturnValue({
                    set: jest.fn().mockReturnValue({
                        where: updateWhereSpy
                    })
                })
            }
        },
        utils: {
            uuid: jest.fn(() => 'generated-id')
        }
    };
    cds.default = cds;
    return cds;
});

import cds from '@sap/cds';
import { RateLimiter } from '../../srv/utils/rate-limiter';
import { registerWalletSessionHandlers, startSessionCleanup } from '../../srv/sessions/wallet-sessions';

function createMockRequest(data: Record<string, unknown>, ip: string | null = '127.0.0.1') {
    const req: any = {
        data,
        reject: jest.fn().mockImplementation((code: number, message: string) => ({
            __rejected: true,
            code,
            message
        }))
    };

    if (ip !== null) {
        req._ = {
            req: {
                ip
            }
        };
    } else {
        req._ = {};
    }

    return req;
}

describe('wallet session handlers', () => {
    const registeredHandlers: Record<string, Function> = {};
    const mockService = {
        on(event: string, entityOrHandler: string | Function, maybeHandler?: Function) {
            registeredHandlers[event] = typeof entityOrHandler === 'function'
                ? entityOrHandler
                : (maybeHandler as Function);
        }
    } as any;

    beforeEach(() => {
        jest.clearAllMocks();
        mockDbRun.mockReset();
        selectWhereSpy.mockReset();
        updateWhereSpy.mockReset();
        insertEntriesSpy.mockReset();
        Object.keys(registeredHandlers).forEach(k => delete registeredHandlers[k]);
        (cds.env as any).requires = { nightgate: {} };
        registerWalletSessionHandlers(mockService, { run: mockDbRun });
    });

    it('connectWallet rejects rate-limited clients before validating or inserting a session', async () => {
        const checkSpy = jest.spyOn(RateLimiter.prototype, 'check').mockReturnValue({
            allowed: false,
            retryAfterMs: 1500
        });

        try {
            const handler = registeredHandlers['connectWallet'];
            const req = createMockRequest({ viewingKey: 'not-even-validated' }, '10.0.0.1');

            await handler(req);

            expect(checkSpy).toHaveBeenCalledWith('10.0.0.1');
            expect(req.reject).toHaveBeenCalledWith(429, 'Rate limited. Retry after 2s');
            expect(insertEntriesSpy).not.toHaveBeenCalled();
        } finally {
            checkSpy.mockRestore();
        }
    });

    it('connectWallet creates a new active session for valid viewing keys', async () => {
        mockDbRun.mockResolvedValueOnce(1);

        const handler = registeredHandlers['connectWallet'];
        const req = createMockRequest({ viewingKey: 'a'.repeat(64) });
        const result = await handler(req);

        expect(req.reject).not.toHaveBeenCalled();
        expect(insertEntriesSpy).toHaveBeenCalledWith(expect.objectContaining({
            viewingKeyHash: expect.any(String),
            encryptedViewingKey: expect.any(String),
            sessionToken: 'generated-id',
            isActive: true
        }));
        expect(result).toEqual(expect.objectContaining({
            sessionId: 'generated-id',
            sessionToken: 'generated-id',
            isActive: true
        }));
    });

    it('connectWallet falls back to the global rate-limit key and default TTL when no config is present', async () => {
        const checkSpy = jest.spyOn(RateLimiter.prototype, 'check');
        const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
        (cds.env as any).requires = {};
        mockDbRun.mockResolvedValueOnce(1);

        try {
            const handler = registeredHandlers['connectWallet'];
            const req = createMockRequest({ viewingKey: 'a'.repeat(64) }, null);
            const result = await handler(req);

            expect(checkSpy).toHaveBeenCalledWith('global');
            expect(result.expiresAt).toBe(new Date(1_700_086_400_000).toISOString());
            expect(insertEntriesSpy).toHaveBeenCalledWith(expect.objectContaining({
                expiresAt: new Date(1_700_086_400_000).toISOString()
            }));
        } finally {
            nowSpy.mockRestore();
            checkSpy.mockRestore();
        }
    });

    it('connectWallet uses the configured session TTL from nightgate config', async () => {
        const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
        (cds.env as any).requires = {
            nightgate: {
                sessionTtlMs: 60_000
            }
        };
        mockDbRun.mockResolvedValueOnce(1);

        try {
            const handler = registeredHandlers['connectWallet'];
            const req = createMockRequest({ viewingKey: 'a'.repeat(64) });
            const result = await handler(req);

            expect(result.expiresAt).toBe(new Date(1_700_000_060_000).toISOString());
            expect(insertEntriesSpy).toHaveBeenCalledWith(expect.objectContaining({
                expiresAt: new Date(1_700_000_060_000).toISOString()
            }));
        } finally {
            nowSpy.mockRestore();
        }
    });

    it('connectWallet rejects invalid viewing keys before inserting a session', async () => {
        const handler = registeredHandlers['connectWallet'];
        const req = createMockRequest({ viewingKey: 'not-hex' });

        await handler(req);

        expect(req.reject).toHaveBeenCalledWith(400, 'viewingKey must be hex-encoded');
        expect(insertEntriesSpy).not.toHaveBeenCalled();
    });

    it('disconnectWallet rejects requests without a sessionId', async () => {
        const handler = registeredHandlers['disconnectWallet'];
        const req = createMockRequest({});

        await handler(req);

        expect(req.reject).toHaveBeenCalledWith(400, 'sessionId is required');
        expect(mockDbRun).not.toHaveBeenCalled();
    });

    it('disconnectWallet rejects unknown sessions', async () => {
        mockDbRun.mockResolvedValueOnce(null);

        const handler = registeredHandlers['disconnectWallet'];
        const req = createMockRequest({ sessionId: 'missing-session' });
        await handler(req);

        expect(selectWhereSpy).toHaveBeenCalledWith({ sessionId: 'missing-session' });
        expect(req.reject).toHaveBeenCalledWith(404, 'Session not found');
    });

    it('disconnectWallet looks sessions up by sessionId', async () => {
        mockDbRun.mockResolvedValueOnce({
            ID: 'db-row-1',
            sessionId: 'public-session-1',
            isActive: true,
            expiresAt: new Date(Date.now() + 60_000).toISOString()
        });
        mockDbRun.mockResolvedValueOnce(1);

        const handler = registeredHandlers['disconnectWallet'];
        const req = createMockRequest({ sessionId: 'public-session-1' });
        await handler(req);

        expect(req.reject).not.toHaveBeenCalled();
        expect(selectWhereSpy).toHaveBeenCalledWith({ sessionId: 'public-session-1' });
        expect(updateWhereSpy).toHaveBeenCalledWith({ sessionId: 'public-session-1' });
    });

    it('disconnectWallet marks expired sessions by sessionId before rejecting', async () => {
        mockDbRun.mockResolvedValueOnce({
            ID: 'db-row-2',
            sessionId: 'public-session-2',
            isActive: true,
            expiresAt: new Date(Date.now() - 60_000).toISOString()
        });
        mockDbRun.mockResolvedValueOnce(1);

        const handler = registeredHandlers['disconnectWallet'];
        const req = createMockRequest({ sessionId: 'public-session-2' });
        await handler(req);

        expect(updateWhereSpy).toHaveBeenCalledWith({ sessionId: 'public-session-2' });
        expect(req.reject).toHaveBeenCalledWith(410, 'Session expired');
    });

    it('startSessionCleanup deactivates expired sessions on the cleanup interval', async () => {
        jest.useFakeTimers();
        const db = { run: jest.fn().mockResolvedValue(2) };

        try {
            const timer = startSessionCleanup(db);
            await jest.advanceTimersByTimeAsync(15 * 60 * 1000);

            expect(db.run).toHaveBeenCalledTimes(1);
            clearInterval(timer);
        } finally {
            jest.useRealTimers();
        }
    });

    it('startSessionCleanup ignores cleanup errors and supports timers without unref', async () => {
        let callback: (() => Promise<void>) | undefined;
        const setIntervalSpy = jest.spyOn(global, 'setInterval').mockImplementation(((handler: TimerHandler) => {
            callback = handler as () => Promise<void>;
            return {} as ReturnType<typeof setInterval>;
        }) as any);
        const db = { run: jest.fn().mockRejectedValue(new Error('cleanup failed')) };

        try {
            const timer = startSessionCleanup(db);
            await expect(callback?.()).resolves.toBeUndefined();
            expect(timer).toEqual({});
        } finally {
            setIntervalSpy.mockRestore();
        }
    });
});