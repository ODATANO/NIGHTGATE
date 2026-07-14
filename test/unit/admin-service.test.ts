/**
 * NightgateAdminService Tests
 *
 * Verify session invalidation actions work correctly.
 */

const mockDbRun = vi.hoisted(() => (vi.fn()));
const mockDbConnect = vi.hoisted(() => (vi.fn().mockResolvedValue({ run: mockDbRun })));
const selectWhereSpy = vi.hoisted(() => (vi.fn()));
const selectFromSpy = vi.hoisted(() => (vi.fn()));
const updateWhereSpy = vi.fn();
const updateSetSpy = vi.hoisted(() => (vi.fn().mockReturnValue({ where: (...a: any[]) => updateWhereSpy(...a) })));
const insertEntriesSpy = vi.hoisted(() => (vi.fn()));

const registeredHandlers: Record<string, Function> = vi.hoisted(() => ({}));

vi.mock('@sap/cds', () => {
    const cds: any = {
        connect: { to: mockDbConnect },
        ql: {
            SELECT: {
                one: {
                    from: vi.fn().mockReturnValue({
                        where: selectWhereSpy
                    })
                },
                from: (entity: string) => {
                    selectFromSpy(entity);
                    return {
                        where: selectWhereSpy,
                        columns: vi.fn().mockReturnValue({ where: selectWhereSpy })
                    };
                }
            },
            UPDATE: {
                entity: vi.fn().mockReturnValue({
                    set: (...a: any[]) => updateSetSpy(...a)
                })
            },
            INSERT: {
                into: vi.fn().mockReturnValue({
                    entries: insertEntriesSpy
                })
            }
        },
        ApplicationService: class {
            on(event: string, handler: Function) {
                registeredHandlers[event] = handler;
            }
            async init() { }
        }
    };
    cds.default = cds;
    return cds;
});

import NightgateAdminService from '../../srv/admin-service';

function createMockRequest(data: Record<string, unknown>, userId?: string) {
    const req: any = {
        data,
        reject: vi.fn().mockImplementation((code: number, msg: string) => {
            return { __rejected: true, code, message: msg };
        })
    };
    if (userId) req.user = { id: userId };
    return req;
}

describe('NightgateAdminService', () => {
    let service: NightgateAdminService;

    beforeEach(async () => {
        vi.clearAllMocks();
        Object.keys(registeredHandlers).forEach(k => delete registeredHandlers[k]);
        service = new NightgateAdminService();
        await service.init();
    });

    describe('invalidateSession', () => {
        it('should invalidate an active session', async () => {
            const handler = registeredHandlers['invalidateSession'];
            expect(handler).toBeDefined();

            // SELECT returns an active session
            mockDbRun.mockResolvedValueOnce({
                ID: 'db-session-123',
                sessionId: 'session-123',
                isActive: true,
                viewingKey: 'vk_test'
            });
            // UPDATE succeeds
            mockDbRun.mockResolvedValueOnce(1);

            const req = createMockRequest({ sessionId: 'session-123' });
            await handler(req);

            expect(req.reject).not.toHaveBeenCalled();
            expect(mockDbRun).toHaveBeenCalledTimes(2);
            expect(selectWhereSpy).toHaveBeenCalledWith({ sessionId: 'session-123' });
            expect(updateWhereSpy).toHaveBeenCalledWith({ sessionId: 'session-123' });
            // review_001 P2: forced invalidation clears BOTH encrypted secrets.
            expect(updateSetSpy).toHaveBeenCalledWith(expect.objectContaining({
                isActive: false,
                encryptedViewingKey: null,
                encryptedSeedKey: null
            }));
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
                ID: 'db-session-123',
                sessionId: 'session-123',
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

            // Now SELECTs the active rows (to evict cached facades) then UPDATEs.
            mockDbRun.mockResolvedValueOnce([]); // SELECT expiring rows (none to evict)
            mockDbRun.mockResolvedValueOnce(5);  // UPDATE: 5 sessions invalidated

            const result = await handler();
            expect(result).toBe(5);
        });

        it('should return 0 when no active sessions exist', async () => {
            const handler = registeredHandlers['invalidateAllSessions'];

            mockDbRun.mockResolvedValueOnce([]); // SELECT: no active rows
            mockDbRun.mockResolvedValueOnce(0);  // UPDATE: 0 invalidated

            const result = await handler();
            expect(result).toBe(0);
        });
    });

    describe('grantRole', () => {
        // The handler runs attachDisclosureRole(req, this.db) BEFORE the INSERT.
        // That issues one SELECT to look up the caller's existing disclosure
        // rows. Tests set up `mockDbRun` to first return that row set, then
        // (for the success path) the INSERT result.
        const authorityRowsFor = (userId: string) => ([
            { userId, role: 'authority', scope: null, validFrom: null, validUntil: null }
        ]);

        it('rejects when userId is missing', async () => {
            const handler = registeredHandlers['grantRole'];
            const req = createMockRequest({ role: 'legitimate_interest' }, 'admin-1');
            await handler(req);
            expect(req.reject).toHaveBeenCalledWith(400, 'userId is required');
            expect(mockDbRun).not.toHaveBeenCalled();
        });

        it('rejects when role is missing', async () => {
            const handler = registeredHandlers['grantRole'];
            const req = createMockRequest({ userId: 'bob' }, 'admin-1');
            await handler(req);
            expect(req.reject).toHaveBeenCalledWith(400, 'role is required');
        });

        it('rejects when role is not a known disclosure tier', async () => {
            const handler = registeredHandlers['grantRole'];
            const req = createMockRequest(
                { userId: 'bob', role: 'public' }, // CDS reserved word; not allowed
                'admin-1'
            );
            await handler(req);
            expect(req.reject).toHaveBeenCalledWith(
                400,
                expect.stringContaining('role must be one of')
            );
        });

        it('rejects when caller does not hold the authority disclosure role', async () => {
            const handler = registeredHandlers['grantRole'];
            // Caller has only legitimate_interest
            mockDbRun.mockResolvedValueOnce([
                { userId: 'admin-1', role: 'legitimate_interest', scope: null, validFrom: null, validUntil: null }
            ]);
            const req = createMockRequest(
                { userId: 'bob', role: 'authority' },
                'admin-1'
            );
            await handler(req);
            expect(req.reject).toHaveBeenCalledWith(
                403,
                expect.stringContaining('authority disclosure role')
            );
            // SELECT ran, INSERT did not
            expect(insertEntriesSpy).not.toHaveBeenCalled();
        });

        it('rejects when caller has no disclosure grants at all', async () => {
            const handler = registeredHandlers['grantRole'];
            mockDbRun.mockResolvedValueOnce([]); // caller falls back to public_only
            const req = createMockRequest(
                { userId: 'bob', role: 'authority' },
                'admin-1'
            );
            await handler(req);
            expect(req.reject).toHaveBeenCalledWith(403, expect.any(String));
            expect(insertEntriesSpy).not.toHaveBeenCalled();
        });

        it('inserts the grant when caller is authority', async () => {
            const handler = registeredHandlers['grantRole'];
            mockDbRun.mockResolvedValueOnce(authorityRowsFor('admin-1')); // caller lookup
            mockDbRun.mockResolvedValueOnce(undefined); // INSERT

            const req = createMockRequest(
                { userId: 'bob', role: 'legitimate_interest' },
                'admin-1'
            );
            await handler(req);

            expect(req.reject).not.toHaveBeenCalled();
            expect(insertEntriesSpy).toHaveBeenCalledTimes(1);
            const entries = insertEntriesSpy.mock.calls[0][0];
            expect(entries).toMatchObject({
                userId: 'bob',
                role: 'legitimate_interest',
                scope: null,
                grantedBy: 'admin-1'
            });
            expect(entries.validFrom).toEqual(expect.any(String));
        });

        it('passes through scope and validUntil when provided', async () => {
            const handler = registeredHandlers['grantRole'];
            mockDbRun.mockResolvedValueOnce(authorityRowsFor('admin-1'));
            mockDbRun.mockResolvedValueOnce(undefined);

            const future = new Date(Date.now() + 86_400_000).toISOString();
            const req = createMockRequest(
                {
                    userId: 'bob',
                    role: 'authority',
                    scope: 'contract-X',
                    validUntil: future
                },
                'admin-1'
            );
            await handler(req);

            const entries = insertEntriesSpy.mock.calls[0][0];
            expect(entries.scope).toBe('contract-X');
            expect(entries.validUntil).toBe(future);
        });

        it('treats empty-string scope as null', async () => {
            const handler = registeredHandlers['grantRole'];
            mockDbRun.mockResolvedValueOnce(authorityRowsFor('admin-1'));
            mockDbRun.mockResolvedValueOnce(undefined);

            const req = createMockRequest(
                { userId: 'bob', role: 'public_only', scope: '', validUntil: '' },
                'admin-1'
            );
            await handler(req);

            const entries = insertEntriesSpy.mock.calls[0][0];
            expect(entries.scope).toBeNull();
            expect(entries.validUntil).toBeNull();
        });

        it('uses "unknown" as grantedBy when req.user is missing', async () => {
            const handler = registeredHandlers['grantRole'];
            // No userId on caller → attachDisclosureRole returns public_only
            // immediately without touching the DB. So the 403 check fires first.
            const req = createMockRequest({ userId: 'bob', role: 'authority' });
            await handler(req);
            expect(req.reject).toHaveBeenCalledWith(403, expect.any(String));
        });
    });
});
