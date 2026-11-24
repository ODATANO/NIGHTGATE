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
        log: (() => {
            const _c: Record<string, any> = {};
            return (name: string) => (_c[name] ??= {
                info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn()
            });
        })(),
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
                    // getJobStats aggregates in SQL: .columns().where().groupBy()
                    const withGroupBy = (...args: any[]) => {
                        selectWhereSpy(...args);
                        return { groupBy: vi.fn() };
                    };
                    return {
                        where: selectWhereSpy,
                        columns: vi.fn().mockReturnValue({ where: withGroupBy })
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
            before() { /* the hex input hook; its own tests boot the services */ }
            after() { /* the 64-bit result form; its own tests boot the services */ }
            on(event: string, handler: Function) {
                registeredHandlers[event] = handler;
            }
            async init() { }
        }
    };
    cds.default = cds;
    return cds;
});

const mockRegisterAtRuntime = vi.hoisted(() => vi.fn());
const mockUnregisterAtRuntime = vi.hoisted(() => vi.fn());
const mockListContracts = vi.hoisted(() => vi.fn(() => []));
vi.mock('../../srv/submission/contract-registrations', () => {
    class ContractRegistrationError extends Error {
        constructor(public readonly status: number, message: string) { super(message); this.name = 'ContractRegistrationError'; }
    }
    return {
        ContractRegistrationError,
        listContracts: (...a: unknown[]) => (mockListContracts as any)(...a),
        registerContractAtRuntime: (...a: unknown[]) => (mockRegisterAtRuntime as any)(...a),
        unregisterContractAtRuntime: (...a: unknown[]) => (mockUnregisterAtRuntime as any)(...a)
    };
});

const evictOrder = vi.hoisted(() => [] as string[]);
const mockRedecode = vi.hoisted(() => vi.fn());
vi.mock('../../srv/crawler/redecode', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../srv/crawler/redecode')>()),
    redecodeFromHeight: mockRedecode
}));
vi.mock('../../srv/submission/wallet-facade-builder', () => ({
    evictWalletFacade: vi.fn(async (accountId: string) => { evictOrder.push(`evict:${accountId}`); })
}));
vi.mock('../../srv/utils/keyed-lock', () => ({
    withKeyedLock: vi.fn(async (key: string, fn: () => Promise<unknown>) => {
        evictOrder.push(`lock:${key}`);
        try { return await fn(); } finally { evictOrder.push(`unlock:${key}`); }
    })
}));
vi.mock('../../srv/utils/crypto', async (importOriginal) => ({
    ...(await importOriginal<any>()),
    decrypt: vi.fn(() => 'vk-plain'),
    getEncryptionKey: vi.fn(() => Buffer.alloc(32))
}));
vi.mock('../../srv/submission/wallet-material-factory', async (importOriginal) => ({
    ...(await importOriginal<any>()),
    deriveAccountId: vi.fn(() => 'acct-1')
}));

import NightgateAdminService from '../../srv/admin-service';
import { ContractRegistrationError } from '../../srv/submission/contract-registrations';
import { RedecodeError } from '../../srv/crawler/redecode';

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

    // Runtime contract registration through the admin service.
    describe('registerContract / unregisterContract / listContracts', () => {
        const INPUT = { name: 'customer-vault', artifactPath: 'customer/contract/index.cjs', zkConfigPath: 'customer', privateStateId: 'ps' };

        it('rejects 400 when a required field is missing, before touching the registry', async () => {
            const req = createMockRequest({ ...INPUT, zkConfigPath: '' }, 'admin-1');
            await registeredHandlers['registerContract'](req);
            expect(req.reject).toHaveBeenCalledWith(400, expect.stringContaining('zkConfigPath'));
            expect(mockRegisterAtRuntime).not.toHaveBeenCalled();
        });

        it('delegates with the admin principal and network, returning the listing', async () => {
            process.env.NIGHTGATE_NETWORK = 'preprod';
            try {
                mockRegisterAtRuntime.mockResolvedValueOnce({ name: 'customer-vault', source: 'runtime', slotWidth: 16, artifactDigest: 'd'.repeat(64), hasProverKeys: true });
                const req = createMockRequest({ ...INPUT, slotWidth: 16 }, 'admin-1');
                const out = await registeredHandlers['registerContract'](req);
                expect(mockRegisterAtRuntime).toHaveBeenCalledWith(expect.anything(),
                    expect.objectContaining({ name: 'customer-vault', slotWidth: 16 }),
                    { registeredBy: 'admin-1', network: 'preprod' });
                expect(out).toMatchObject({ name: 'customer-vault', source: 'runtime' });
            } finally {
                delete process.env.NIGHTGATE_NETWORK;
            }
        });

        it('maps ContractRegistrationError to its status (409 for a config name, 400 for a bad path)', async () => {
            mockRegisterAtRuntime.mockRejectedValueOnce(new ContractRegistrationError(409, 'the config is the immutable floor'));
            const req = createMockRequest(INPUT, 'admin-1');
            await registeredHandlers['registerContract'](req);
            expect(req.reject).toHaveBeenCalledWith(409, expect.stringContaining('floor'));

            mockUnregisterAtRuntime.mockRejectedValueOnce(new ContractRegistrationError(409, 'cannot be removed at runtime'));
            const req2 = createMockRequest({ name: 'floor' }, 'admin-1');
            await registeredHandlers['unregisterContract'](req2);
            expect(req2.reject).toHaveBeenCalledWith(409, expect.stringContaining('removed'));
        });
    });

    describe('invalidateSession', () => {
        it('should invalidate an active session', async () => {
            const handler = registeredHandlers['invalidateSession'];
            expect(handler).toBeDefined();

            // SELECT returns an active session
            mockDbRun.mockResolvedValueOnce({
                sessionId: 'session-123',
                isActive: true,
                viewingKey: 'vk_test'
            });
            // UPDATE succeeds
            mockDbRun.mockResolvedValueOnce(1);

            const req = createMockRequest({ sessionId: 'session-123' });
            const result = await handler(req);

            expect(req.reject).not.toHaveBeenCalled();
            expect(result).toEqual({ sessionId: 'session-123', isActive: false });
            expect(mockDbRun).toHaveBeenCalledTimes(2);
            expect(selectWhereSpy).toHaveBeenCalledWith({ sessionId: 'session-123' });
            expect(updateWhereSpy).toHaveBeenCalledWith({ sessionId: 'session-123' });
            // Forced invalidation clears BOTH encrypted secrets.
            expect(updateSetSpy).toHaveBeenCalledWith(expect.objectContaining({
                isActive: false,
                encryptedViewingKey: null,
                encryptedSeedKey: null
            }));
        });

        it('evicts the facade under the build lock, after the session is deactivated', async () => {
            const handler = registeredHandlers['invalidateSession'];
            evictOrder.length = 0;
            mockDbRun.mockResolvedValueOnce({ sessionId: 'session-9', isActive: true, encryptedViewingKey: 'enc' });
            mockDbRun.mockImplementationOnce(async () => { evictOrder.push('update'); return 1; });

            const req = createMockRequest({ sessionId: 'session-9' });
            await handler(req);

            expect(req.reject).not.toHaveBeenCalled();
            expect(evictOrder).toEqual(['update', 'lock:acct-1', 'evict:acct-1', 'unlock:acct-1']);
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

            expect(req.reject).toHaveBeenCalledWith(expect.objectContaining({ status: 404, code: 'SESSION_NOT_FOUND' }));
        });

        it('should reject when session already inactive', async () => {
            const handler = registeredHandlers['invalidateSession'];

            mockDbRun.mockResolvedValueOnce({
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
            expect(result).toEqual({ invalidated: 5 });
        });

        it('evicts every active facade after the bulk deactivation', async () => {
            const handler = registeredHandlers['invalidateAllSessions'];
            evictOrder.length = 0;
            mockDbRun.mockResolvedValueOnce([{ sessionId: 's1', encryptedViewingKey: 'e1' }, { sessionId: 's2', encryptedViewingKey: 'e2' }]);
            mockDbRun.mockImplementationOnce(async () => { evictOrder.push('update'); return 2; });

            expect(await handler()).toEqual({ invalidated: 2 });
            expect(evictOrder[0]).toBe('update');
            expect(evictOrder.filter(e => e.startsWith('evict:'))).toHaveLength(2);
        });

        it('should return 0 when no active sessions exist', async () => {
            const handler = registeredHandlers['invalidateAllSessions'];

            mockDbRun.mockResolvedValueOnce([]); // SELECT: no active rows
            mockDbRun.mockResolvedValueOnce(0);  // UPDATE: 0 invalidated

            const result = await handler();
            expect(result).toEqual({ invalidated: 0 });
        });
    });

    describe('getSponsorPolicy', () => {
        const ENV = ['NIGHTGATE_SPONSOR_ALLOWED_CONTRACTS', 'NIGHTGATE_SPONSOR_ALLOWED_CIRCUITS', 'NIGHTGATE_SPONSOR_ALLOWED_TOKEN_TYPES',
            'NIGHTGATE_SPONSOR_POLICY_FILE', 'NIGHTGATE_SPONSOR_ALLOW_CONTRACT_MINTS', 'NIGHTGATE_SPONSOR_ALLOW_DEPLOY'];
        const T = 'ab'.repeat(32);
        const grant = (over: Record<string, unknown> = {}) => ({
            ID: 'grant-1', userId: 'operator-1', sessionId: 'sess-1', allowedActions: '["sponsorUnbound"]',
            isActive: true, revokedAt: null, validUntil: null,
            allowedContracts: JSON.stringify(['A']), allowedCircuits: null, allowedTokenTypes: JSON.stringify([T]),
            deployedContracts: JSON.stringify(['D']), allowDeploy: true, maxDeploys: 2, deploysUsed: 1, ...over
        });
        beforeEach(() => {
            for (const k of ENV) delete process.env[k];
            process.env.NIGHTGATE_SPONSOR_ALLOWED_CONTRACTS = 'A,B';
            process.env.NIGHTGATE_SPONSOR_ALLOWED_TOKEN_TYPES = T;
            process.env.NIGHTGATE_SPONSOR_ALLOW_DEPLOY = 'true';
            process.env.NIGHTGATE_SPONSOR_ALLOW_CONTRACT_MINTS = 'true';
        });
        afterEach(() => { for (const k of ENV) delete process.env[k]; });

        it('without a grant: the platform policy and its source', async () => {
            const req = createMockRequest({}, 'admin-1');
            const result = await registeredHandlers['getSponsorPolicy'](req);
            expect(req.reject).not.toHaveBeenCalled();
            expect(mockDbRun).not.toHaveBeenCalled();
            expect(result).toMatchObject({
                source: 'env', path: null, loadedAt: null, ignoredEnv: [], floorError: null, grant: null, effectiveError: null,
                floor: { allowedContracts: ['A', 'B'], allowedCircuits: [], allowedTokenTypes: [T], allowContractMints: true },
                effective: { allowedContracts: ['A', 'B'], allowedTokenTypes: [T], allowDeploy: true, allowContractMints: true }
            });
            expect(result.floor).not.toHaveProperty('allowDeploy');
        });

        it('with a grant: its lists and what the platform policy leaves of them', async () => {
            mockDbRun.mockResolvedValueOnce(grant());
            const result = await registeredHandlers['getSponsorPolicy'](createMockRequest({ grantId: 'grant-1' }, 'admin-1'));
            expect(selectWhereSpy).toHaveBeenCalledWith({ ID: 'grant-1' });
            expect(result).toMatchObject({
                grant: { grantId: 'grant-1', isActive: true, allowedContracts: ['A'], allowedTokenTypes: [T], deployedContracts: ['D'], allowDeploy: true, maxDeploys: 2, deploysUsed: 1 },
                effective: { allowedContracts: ['A', 'D'], ownContracts: ['D'], allowedTokenTypes: [T], allowDeploy: true, allowContractMints: true },
                effectiveError: null
            });
        });

        it('a used-up deploy budget closes allowDeploy in the effective policy', async () => {
            mockDbRun.mockResolvedValueOnce(grant({ deploysUsed: 2 }));
            const result = await registeredHandlers['getSponsorPolicy'](createMockRequest({ grantId: 'grant-1' }, 'admin-1'));
            expect(result.effective.allowDeploy).toBe(false);
        });

        it('says why nothing is left: lists that share nothing, a revoked grant', async () => {
            mockDbRun.mockResolvedValueOnce(grant({ allowedContracts: JSON.stringify(['C']) }));
            const empty = await registeredHandlers['getSponsorPolicy'](createMockRequest({ grantId: 'grant-1' }, 'admin-1'));
            expect(empty).toMatchObject({ effective: null, effectiveError: expect.stringMatching(/allowedContracts \(C\) share nothing/) });

            mockDbRun.mockResolvedValueOnce(grant({ isActive: false }));
            const revoked = await registeredHandlers['getSponsorPolicy'](createMockRequest({ grantId: 'grant-1' }, 'admin-1'));
            expect(revoked).toMatchObject({ grant: { isActive: false }, effective: null, effectiveError: 'the grant is revoked or expired' });
        });

        it('an unknown grant is 404', async () => {
            mockDbRun.mockResolvedValueOnce(null);
            const req = createMockRequest({ grantId: 'grant-x' }, 'admin-1');
            await registeredHandlers['getSponsorPolicy'](req);
            expect(req.reject).toHaveBeenCalledWith(404, 'Grant not found');
        });
    });

    describe('redecodeFromHeight', () => {
        it('hands the height to the cursor reset and returns its result', async () => {
            mockRedecode.mockResolvedValueOnce({ fromHeight: 100, previousDecodedHeight: 250, blocks: 151, changed: true });
            const req = createMockRequest({ height: 100 }, 'admin-1');
            const result = await registeredHandlers['redecodeFromHeight'](req);
            expect(mockRedecode).toHaveBeenCalledWith(expect.anything(), 100);
            expect(result).toEqual({ fromHeight: 100, previousDecodedHeight: 250, blocks: 151, changed: true });
            expect(req.reject).not.toHaveBeenCalled();
        });

        it('a refused height is a 400 with the reason', async () => {
            mockRedecode.mockRejectedValueOnce(new RedecodeError('height must be a non-negative integer'));
            const req = createMockRequest({ height: -1 }, 'admin-1');
            await registeredHandlers['redecodeFromHeight'](req);
            expect(req.reject).toHaveBeenCalledWith(400, 'height must be a non-negative integer');
        });

        it('anything else stays an error', async () => {
            mockRedecode.mockRejectedValueOnce(new Error('database gone'));
            const req = createMockRequest({ height: 1 }, 'admin-1');
            await expect(registeredHandlers['redecodeFromHeight'](req)).rejects.toThrow('database gone');
            expect(req.reject).not.toHaveBeenCalled();
        });
    });

    describe('getJobStats', () => {
        /**
         * The three aggregates the handler issues, in order: counts per status,
         * counts per error code, oldest pending timestamp. They are computed in
         * SQL rather than by pulling the window's rows into the process, which
         * at a high job rate would be millions of records per poll.
         */
        function aggregates(oldestPendingAgeMs: number | null = 300_000) {
            mockDbRun
                .mockResolvedValueOnce([
                    { status: 'succeeded', count: 2 },
                    { status: 'failed', count: 3 },
                    { status: 'pending', count: 2 }
                ])
                .mockResolvedValueOnce([
                    { errorCode: 'SubmissionError', count: 1 },
                    { errorCode: '1010/188', count: 2 }
                ])
                .mockResolvedValueOnce([
                    { oldest: oldestPendingAgeMs === null ? null : new Date(Date.now() - oldestPendingAgeMs).toISOString() }
                ]);
        }

        it('counts by status and ranks the error codes that are piling up', async () => {
            aggregates();
            const result: any = await registeredHandlers['getJobStats'](createMockRequest({}, 'admin-1'));

            expect(result.total).toBe(7);
            expect(result.byStatus).toEqual([
                { status: 'failed', count: 3 },
                { status: 'succeeded', count: 2 },
                { status: 'pending', count: 2 }
            ]);
            // The ranking is the point: it turns "many jobs failed" into a
            // diagnosis, here batched calls crossing the fallible boundary.
            expect(result.topErrors[0]).toEqual({ errorCode: '1010/188', count: 2 });
        });

        it('aggregates in the database instead of loading the window', async () => {
            aggregates();
            await registeredHandlers['getJobStats'](createMockRequest({}, 'admin-1'));
            // Three grouped queries, not one row-by-row read.
            expect(mockDbRun).toHaveBeenCalledTimes(3);
        });

        it('ages the OLDEST queued job', async () => {
            aggregates(300_000);
            const result: any = await registeredHandlers['getJobStats'](createMockRequest({}, 'admin-1'));
            expect(result.oldestQueuedSeconds).toBeGreaterThanOrEqual(290);
            expect(result.oldestQueuedSeconds).toBeLessThan(320);
            // A job queued before the window is the one that matters, so this read has no window.
            expect(selectWhereSpy).toHaveBeenCalledWith({ status: 'pending' });
        });

        it('reports zero queue age when nothing is pending', async () => {
            aggregates(null);
            const result: any = await registeredHandlers['getJobStats'](createMockRequest({}, 'admin-1'));
            expect(result.oldestQueuedSeconds).toBe(0);
        });

        it('defaults to 24 hours and clamps the window at both ends', async () => {
            mockDbRun.mockResolvedValue([]);
            const call = async (windowHours?: number) =>
                (await registeredHandlers['getJobStats'](createMockRequest({ windowHours }, 'admin-1'))) as any;

            expect((await call()).windowHours).toBe(24);
            expect((await call(0)).windowHours).toBe(24);   // 0 is falsy → default
            expect((await call(-5)).windowHours).toBe(1);
            expect((await call(10_000)).windowHours).toBe(720);
        });

        it('survives an empty queue', async () => {
            mockDbRun.mockResolvedValue([]);
            const result: any = await registeredHandlers['getJobStats'](createMockRequest({}, 'admin-1'));
            expect(result).toMatchObject({ total: 0, byStatus: [], topErrors: [] });
        });
    });
});
