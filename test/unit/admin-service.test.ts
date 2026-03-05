/**
 * MidnightAdminService Tests
 *
 * Verify session invalidation actions work correctly.
 */

const mockDbRun = jest.fn();
const mockDbConnect = jest.fn().mockResolvedValue({ run: mockDbRun });

const registeredHandlers: Record<string, Function> = {};

jest.mock('@sap/cds', () => {
    const cds: any = {
        connect: { to: mockDbConnect },
        ql: {
            SELECT: {
                one: {
                    from: jest.fn().mockReturnValue({
                        where: jest.fn()
                    })
                }
            },
            UPDATE: {
                entity: jest.fn().mockReturnValue({
                    set: jest.fn().mockReturnValue({
                        where: jest.fn()
                    })
                })
            }
        },
        ApplicationService: class {
            on(event: string, handler: Function) {
                registeredHandlers[event] = handler;
            }
            async init() {}
        }
    };
    cds.default = cds;
    return cds;
});

import MidnightAdminService from '../../srv/admin-service';

function createMockRequest(data: Record<string, unknown>) {
    return {
        data,
        reject: jest.fn().mockImplementation((code: number, msg: string) => {
            return { __rejected: true, code, message: msg };
        })
    };
}

describe('MidnightAdminService', () => {
    let service: MidnightAdminService;

    beforeEach(async () => {
        jest.clearAllMocks();
        Object.keys(registeredHandlers).forEach(k => delete registeredHandlers[k]);
        service = new MidnightAdminService();
        await service.init();
    });

    describe('invalidateSession', () => {
        it('should invalidate an active session', async () => {
            const handler = registeredHandlers['invalidateSession'];
            expect(handler).toBeDefined();

            // SELECT returns an active session
            mockDbRun.mockResolvedValueOnce({
                ID: 'session-123',
                isActive: true,
                viewingKey: 'vk_test'
            });
            // UPDATE succeeds
            mockDbRun.mockResolvedValueOnce(1);

            const req = createMockRequest({ sessionId: 'session-123' });
            await handler(req);

            expect(req.reject).not.toHaveBeenCalled();
            expect(mockDbRun).toHaveBeenCalledTimes(2);
        });

        it('should reject when sessionId is missing', async () => {
            const handler = registeredHandlers['invalidateSession'];

            const req = createMockRequest({});
            await handler(req);

            expect(req.reject).toHaveBeenCalledWith(400, 'sessionId is required');
        });

        it('should reject when session not found', async () => {
            const handler = registeredHandlers['invalidateSession'];

            mockDbRun.mockResolvedValueOnce(null);

            const req = createMockRequest({ sessionId: 'nonexistent' });
            await handler(req);

            expect(req.reject).toHaveBeenCalledWith(404, expect.stringContaining('not found'));
        });

        it('should reject when session already inactive', async () => {
            const handler = registeredHandlers['invalidateSession'];

            mockDbRun.mockResolvedValueOnce({
                ID: 'session-123',
                isActive: false
            });

            const req = createMockRequest({ sessionId: 'session-123' });
            await handler(req);

            expect(req.reject).toHaveBeenCalledWith(409, expect.stringContaining('already inactive'));
        });
    });

    describe('invalidateAllSessions', () => {
        it('should invalidate all active sessions', async () => {
            const handler = registeredHandlers['invalidateAllSessions'];
            expect(handler).toBeDefined();

            mockDbRun.mockResolvedValueOnce(5); // 5 sessions updated

            const result = await handler();
            expect(result).toBe(5);
        });

        it('should return 0 when no active sessions exist', async () => {
            const handler = registeredHandlers['invalidateAllSessions'];

            mockDbRun.mockResolvedValueOnce(0);

            const result = await handler();
            expect(result).toBe(0);
        });
    });
});
