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
                midnight: {}
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

import { registerWalletSessionHandlers, startSessionCleanup } from '../../srv/sessions/wallet-sessions';

function createMockRequest(data: Record<string, unknown>) {
    return {
        data,
        _: {
            req: {
                ip: '127.0.0.1'
            }
        },
        reject: jest.fn().mockImplementation((code: number, message: string) => ({
            __rejected: true,
            code,
            message
        }))
    };
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
        Object.keys(registeredHandlers).forEach(k => delete registeredHandlers[k]);
        registerWalletSessionHandlers(mockService, { run: mockDbRun });
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

    it('connectWallet rejects invalid viewing keys before inserting a session', async () => {
        const handler = registeredHandlers['connectWallet'];
        const req = createMockRequest({ viewingKey: 'not-hex' });

        await handler(req);

        expect(req.reject).toHaveBeenCalledWith(400, 'viewingKey must be hex-encoded');
        expect(insertEntriesSpy).not.toHaveBeenCalled();
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
});