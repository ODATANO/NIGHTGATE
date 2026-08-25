/**
 * Wallet session handler tests
 *
 * Verify disconnect flow consistently uses the public sessionId field.
 */

import type { MockInstance } from 'vitest';
const mockDbRun = vi.fn();
const selectWhereSpy = vi.hoisted(() => (vi.fn()));
const selectFromWhereSpy = vi.hoisted(() => (vi.fn()));
const updateWhereSpy = vi.hoisted(() => (vi.fn()));
const updateSetSpy = vi.hoisted(() => (vi.fn()));
const insertEntriesSpy = vi.hoisted(() => (vi.fn()));

vi.mock('@sap/cds', () => {
    const cds: any = {
        env: {
            requires: {
                nightgate: {}
            }
        },
        ql: {
            SELECT: {
                one: {
                    from: vi.fn().mockReturnValue({
                        where: selectWhereSpy
                    })
                },
                from: vi.fn().mockReturnValue({
                    columns: vi.fn().mockReturnValue({ where: selectFromWhereSpy })
                })
            },
            INSERT: {
                into: vi.fn().mockReturnValue({
                    entries: insertEntriesSpy
                })
            },
            UPDATE: {
                entity: vi.fn().mockReturnValue({
                    set: updateSetSpy.mockReturnValue({
                        where: updateWhereSpy
                    })
                })
            }
        },
        utils: {
            uuid: vi.fn(() => 'generated-id')
        },
        log: (() => {
            const channels: Record<string, any> = {};
            return (name: string) => (channels[name] ??= {
                info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn()
            });
        })()
    };
    cds.default = cds;
    return cds;
});

const mockEvictWalletFacade = vi.hoisted(() => (vi.fn()));
const mockGetOrBuildWalletFacade = vi.hoisted(() => (vi.fn()));
const mockDeriveAccountId = vi.hoisted(() => (vi.fn()));
const mockDeriveStoragePassword = vi.hoisted(() => (vi.fn()));
const mockRegisterNightUtxosForDust = vi.hoisted(() => (vi.fn()));
const mockDeregisterNightUtxosFromDust = vi.hoisted(() => (vi.fn()));
const mockSendNight = vi.hoisted(() => (vi.fn()));
const mockGetWalletBalance = vi.hoisted(() => (vi.fn()));
const mockEstimateSendNightFee = vi.hoisted(() => (vi.fn()));
const mockEnsureNetworkId = vi.hoisted(() => (vi.fn()));
const mockWalletWaitForSyncedState = vi.hoisted(() => (vi.fn()));
const mockWalletGetSyncProgress = vi.hoisted(() => (vi.fn()));

vi.mock('../../srv/midnight/wallet-worker-client', () => ({
    walletWaitForSyncedState: mockWalletWaitForSyncedState,
    walletGetSyncProgress: mockWalletGetSyncProgress
}));

const mockHasWalletFacade = vi.hoisted(() => (vi.fn(() => false)));
vi.mock('../../srv/submission/wallet-facade-builder', () => ({
    evictWalletFacade: mockEvictWalletFacade,
    getOrBuildWalletFacade: mockGetOrBuildWalletFacade,
    hasWalletFacade: mockHasWalletFacade
}));

vi.mock('../../srv/submission/wallet-material-factory', () => ({
    deriveAccountId: mockDeriveAccountId,
    deriveStoragePassword: mockDeriveStoragePassword
}));

vi.mock('../../srv/submission/dust-registration', () => ({
    registerNightUtxosForDust: mockRegisterNightUtxosForDust,
    deregisterNightUtxosFromDust: mockDeregisterNightUtxosFromDust
}));

vi.mock('../../srv/submission/token-ops', () => ({
    sendNight: mockSendNight,
    getWalletBalance: mockGetWalletBalance,
    estimateSendNightFee: mockEstimateSendNightFee
}));

vi.mock('../../srv/midnight/providers', () => ({
    ensureNetworkId: mockEnsureNetworkId
}));

// connectWalletForSigning's fail-closed check derives the seed's viewing key
// via the real ESM SDK; stub it to activeSessionRow()'s viewing key so the
// happy paths pass. Real derivation: wallet-derivation-real-sdk.test.ts.
const mockDeriveViewingKeyForAccount = vi.hoisted(() => (vi.fn(async () => 'a'.repeat(64))));
vi.mock('../../srv/utils/wallet-info', async () => {
    const actual: any = await vi.importActual('../../srv/utils/wallet-info');
    return {
        ...actual,
        deriveViewingKeyForAccount: (...args: unknown[]) => (mockDeriveViewingKeyForAccount as any)(...args)
    };
});

// Phase 2: dust handlers + connectWalletForSigning hand long work to startJob
// and return { jobId, status }. The stub here returns a predictable jobId so
// handler-level assertions can be deterministic; the work fn is captured for
// the few cases that drive it explicitly (idempotency, failure classification).
const mockStartJob = vi.hoisted(() => (vi.fn(async (args: any) => ({ jobId: `job-${args.kind}-test`, status: 'pending' as const }))));
const registeredProcessors = vi.hoisted(() => new Map<string, (command: unknown, row: any) => Promise<unknown>>());
// Pass-through spy: the ambient-tx detach is an integration concern; handler
// logic under test must behave identically inside and outside the scope, but
// tests assert the read handlers actually route their session reads through it.
const mockRunWithoutAmbientTx = vi.hoisted(() => (vi.fn((fn: () => Promise<unknown>) => fn())));
const mockSupersedeQueuedJobs = vi.hoisted(() => (vi.fn(async () => 0)));
vi.mock('../../srv/submission/background-jobs', () => ({
    startJob: (...args: unknown[]) => (mockStartJob as any)(...args),
    registerBackgroundJobProcessor: (kind: string, _version: number, processor: (command: unknown, row: any) => Promise<unknown>) => registeredProcessors.set(kind, processor),
    runWithoutAmbientTx: (fn: () => Promise<unknown>) => (mockRunWithoutAmbientTx as any)(fn),
    supersedeQueuedJobs: (...args: unknown[]) => (mockSupersedeQueuedJobs as any)(...args)
}));

import cds from '@sap/cds';
import { encrypt, getEncryptionKey } from '../../srv/utils/crypto';
import { RateLimiter } from '../../srv/utils/rate-limiter';
import { registerWalletSessionHandlers, startSessionCleanup, closeSessionsFromPreviousProcess } from '../../srv/sessions/wallet-sessions';

async function runPersistedCommand(args: any): Promise<unknown> {
    const processor = registeredProcessors.get(args.kind);
    if (!processor) throw new Error(`No test processor registered for ${args.kind}`);
    const encKey = getEncryptionKey();
    mockDbRun.mockResolvedValueOnce({
        ID: 'row-command', sessionId: args.sessionId, isActive: true,
        encryptedViewingKey: encrypt('a'.repeat(64), encKey),
        encryptedSeedKey: encrypt('a'.repeat(128), encKey),
        expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    return processor(args.command, {
        ID: 'job-test', kind: args.kind, sessionId: args.sessionId,
        requestedBy: args.requestedBy, commandVersion: args.commandVersion,
        command: JSON.stringify(args.command)
    });
}

// Unique IP per call so rate-limit buckets never collide across tests within
// a file (the per-IP "5 per hour" buckets would otherwise be exhausted by
// the first few cases). Tests that need a specific IP pass one explicitly.
let __ipCounter = 0;
function defaultIp(): string {
    // 192.168.x.x range, kept distinct from explicit IPs like 10.0.0.1 used
    // by rate-limit-specific tests so the two buckets can't collide.
    __ipCounter += 1;
    return `192.168.${(__ipCounter >> 8) & 0xff}.${__ipCounter & 0xff}`;
}

const TEST_USER_ID = 'test-user';

function createMockRequest(data: Record<string, unknown>, ip: string | null | undefined = undefined) {
    const req: any = {
        data,
        // Sessions are user-bound; every session action reads
        // req.user.id. Default to a fixed principal so handlers pass the auth gate.
        user: { id: TEST_USER_ID },
        reject: vi.fn().mockImplementation((code: number, message: string) => ({
            __rejected: true,
            code,
            message
        }))
    };

    const resolvedIp = ip === undefined ? defaultIp() : ip;
    if (resolvedIp !== null) {
        req._ = {
            req: {
                ip: resolvedIp
            }
        };
    } else {
        req._ = {};
    }

    return req;
}

// The project's .env sets NIGHTGATE_NETWORK / NODE_URL for live runs, and
// an IDE test runner propagates them into the test process. nightgate-
// config.ts reads env vars BEFORE falling back to the mocked cds.env.requires,
// so without this scrub the env-var wins and assertions on the resolved
// network / nodeUrl break.
const NIGHTGATE_ENV_KEYS = [
    'NIGHTGATE_NETWORK',
    'NIGHTGATE_NODE_URL',
    'NIGHTGATE_CRAWLER_NODE_URL',
    'NIGHTGATE_CRAWLER_ENABLED',
    'NIGHTGATE_INDEXER_HTTP_URL',
    'NIGHTGATE_INDEXER_WS_URL',
    'NIGHTGATE_PROOF_SERVER_URL',
    'NIGHTGATE_ZK_CONFIG_BASE'
] as const;
const originalNightgateEnv = Object.fromEntries(
    NIGHTGATE_ENV_KEYS.map((key) => [key, process.env[key]])
) as Record<(typeof NIGHTGATE_ENV_KEYS)[number], string | undefined>;

describe('wallet session handlers', () => {
    const registeredHandlers: Record<string, Function> = {};
    const mockService = {
        on(event: string, entityOrHandler: string | Function, maybeHandler?: Function) {
            registeredHandlers[event] = typeof entityOrHandler === 'function'
                ? entityOrHandler
                : (maybeHandler as Function);
        }
    } as any;

    afterAll(() => {
        for (const key of NIGHTGATE_ENV_KEYS) {
            const value = originalNightgateEnv[key];
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    });

    beforeEach(() => {
        vi.clearAllMocks();
        for (const key of NIGHTGATE_ENV_KEYS) delete process.env[key];
        mockDbRun.mockReset();
        selectWhereSpy.mockReset();
        updateWhereSpy.mockReset();
        updateSetSpy.mockClear();
        insertEntriesSpy.mockReset();
        Object.keys(registeredHandlers).forEach(k => delete registeredHandlers[k]);
        (cds.env as any).requires = { nightgate: {} };
        mockDeriveAccountId.mockReturnValue('acct-derived');
        mockDeriveStoragePassword.mockReturnValue('storage-pass-derived');
        mockEnsureNetworkId.mockResolvedValue(undefined);
        mockGetOrBuildWalletFacade.mockResolvedValue({ facade: {} });
        mockWalletWaitForSyncedState.mockResolvedValue({ synced: true });
        mockEvictWalletFacade.mockResolvedValue(undefined);
        registerWalletSessionHandlers(mockService, { run: mockDbRun });
    });

    /** Build an active session row whose encrypted fields decrypt back to known values. */
    function activeSessionRow(opts: { withSeed?: boolean; expiresInMs?: number } = {}) {
        const encKey = getEncryptionKey();
        const future = opts.expiresInMs ?? 60_000;
        return {
            ID: 'row-1',
            sessionId: 'sess-1',
            isActive: true,
            encryptedViewingKey: encrypt('a'.repeat(64), encKey),
            encryptedSeedKey: opts.withSeed === false ? null : encrypt('b'.repeat(128), encKey),
            expiresAt: new Date(Date.now() + future).toISOString()
        };
    }

    it('connectWallet rejects rate-limited clients before validating or inserting a session', async () => {
        const checkSpy = vi.spyOn(RateLimiter.prototype, 'check').mockReturnValue({
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
            isActive: true
        }));
        expect(result).toEqual(expect.objectContaining({
            sessionId: 'generated-id',
            isActive: true
        }));
        expect(result.sessionToken).toBeUndefined();
    });

    it('connectWallet falls back to the global rate-limit key and default TTL when no config is present', async () => {
        const checkSpy = vi.spyOn(RateLimiter.prototype, 'check');
        const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
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
        const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
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

        expect(selectWhereSpy).toHaveBeenCalledWith({ sessionId: 'missing-session', userId: TEST_USER_ID });
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
        expect(selectWhereSpy).toHaveBeenCalledWith({ sessionId: 'public-session-1', userId: TEST_USER_ID });
        expect(updateWhereSpy).toHaveBeenCalledWith({ sessionId: 'public-session-1', userId: TEST_USER_ID });
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

        expect(updateWhereSpy).toHaveBeenCalledWith({ sessionId: 'public-session-2', userId: TEST_USER_ID });
        expect(req.reject).toHaveBeenCalledWith(410, 'Session expired');
    });

    // Boot hygiene: a session is a per-connect handle owned by a caller in a
    // specific process, so an ungraceful stop leaks it for the full 24h TTL.
    // Live-observed: 12 simultaneously active rows for one wallet.
    describe('closeSessionsFromPreviousProcess', () => {
        const previousSponsorEnv = process.env.NIGHTGATE_FEE_SPONSOR_SESSION;
        afterEach(() => {
            if (previousSponsorEnv == null) delete process.env.NIGHTGATE_FEE_SPONSOR_SESSION;
            else process.env.NIGHTGATE_FEE_SPONSOR_SESSION = previousSponsorEnv;
        });

        it('closes every active session and clears its key material', async () => {
            delete process.env.NIGHTGATE_FEE_SPONSOR_SESSION;
            const db = {
                run: vi.fn()
                    .mockResolvedValueOnce([{ sessionId: 'a' }, { sessionId: 'b' }])
                    .mockResolvedValueOnce(2)
            };

            expect(await closeSessionsFromPreviousProcess(db)).toEqual(['a', 'b']);
            expect(updateSetSpy).toHaveBeenCalledWith(expect.objectContaining({
                isActive: false,
                encryptedViewingKey: null,
                encryptedSeedKey: null
            }));
            expect(updateWhereSpy).toHaveBeenCalledWith({ sessionId: { in: ['a', 'b'] } });
        });

        // Their ids are pinned in the deployment config and usable by ANY
        // caller, so they are deliberately process-independent. Closing one
        // would break sponsored submissions until an operator pinned a new id.
        it('exempts configured fee-sponsor sessions', async () => {
            process.env.NIGHTGATE_FEE_SPONSOR_SESSION = 'sponsor-1';
            const db = {
                run: vi.fn()
                    .mockResolvedValueOnce([{ sessionId: 'a' }, { sessionId: 'sponsor-1' }])
                    .mockResolvedValueOnce(1)
            };

            expect(await closeSessionsFromPreviousProcess(db)).toEqual(['a']);
            expect(updateWhereSpy).toHaveBeenCalledWith({ sessionId: { in: ['a'] } });
        });

        it('does not write when only exempt sessions are active', async () => {
            process.env.NIGHTGATE_FEE_SPONSOR_SESSION = 'sponsor-1';
            const db = { run: vi.fn().mockResolvedValueOnce([{ sessionId: 'sponsor-1' }]) };

            expect(await closeSessionsFromPreviousProcess(db)).toEqual([]);
            expect(db.run).toHaveBeenCalledTimes(1);
        });

        it('chunks the UPDATE so a large backlog stays within driver limits', async () => {
            delete process.env.NIGHTGATE_FEE_SPONSOR_SESSION;
            const many = Array.from({ length: 450 }, (_, i) => ({ sessionId: `s${i}` }));
            const db = { run: vi.fn().mockResolvedValueOnce(many).mockResolvedValue(200) };

            expect(await closeSessionsFromPreviousProcess(db)).toHaveLength(450);
            // 1 SELECT + 3 UPDATEs (200 + 200 + 50).
            expect(db.run).toHaveBeenCalledTimes(4);
        });
    });

    it('startSessionCleanup is a no-op when nothing is expiring', async () => {
        vi.useFakeTimers();
        // Cleanup SELECTs the expiring rows first; with none, it neither
        // UPDATEs nor evicts.
        const db = { run: vi.fn().mockResolvedValueOnce([]) };

        try {
            const timer = startSessionCleanup(db);
            await vi.advanceTimersByTimeAsync(15 * 60 * 1000);

            expect(db.run).toHaveBeenCalledTimes(1);
            expect(mockEvictWalletFacade).not.toHaveBeenCalled();
            clearInterval(timer);
        } finally {
            vi.useRealTimers();
        }
    });

    // session-sweep-evicts-live-facade FR: the sweep must not evict a facade
    // that another active session of the same wallet still uses.

    it('session cleanup keeps the facade when another active session uses the same wallet', async () => {
        let callback: (() => Promise<void>) | undefined;
        const setIntervalSpy = vi.spyOn(global, 'setInterval').mockImplementation(((handler: TimerHandler) => {
            callback = handler as () => Promise<void>;
            return {} as ReturnType<typeof setInterval>;
        }) as any);
        const encKey = getEncryptionKey();
        const db = {
            run: vi.fn()
                .mockResolvedValueOnce([{ sessionId: 'old-1', viewingKeyHash: 'hash-a', encryptedViewingKey: encrypt('a'.repeat(64), encKey) }])
                .mockResolvedValueOnce(1)                          // deactivate UPDATE (runs FIRST)
                .mockResolvedValueOnce([{ sessionId: 'live-1' }]) // guard: live sibling remains
        };
        try {
            startSessionCleanup(db);
            await callback?.();
            expect(mockEvictWalletFacade).not.toHaveBeenCalled();
            expect(db.run).toHaveBeenCalledTimes(3);
        } finally {
            setIntervalSpy.mockRestore();
        }
    });

    it('session cleanup skips configured platform sponsor sessions (they do not expire, their keys stay)', async () => {
        let callback: (() => Promise<void>) | undefined;
        const setIntervalSpy = vi.spyOn(global, 'setInterval').mockImplementation(((handler: TimerHandler) => {
            callback = handler as () => Promise<void>;
            return {} as ReturnType<typeof setInterval>;
        }) as any);
        const encKey = getEncryptionKey();
        const row = (id: string, hash: string) => ({ sessionId: id, viewingKeyHash: hash, encryptedViewingKey: encrypt('a'.repeat(64), encKey) });
        process.env.NIGHTGATE_FEE_SPONSOR_SESSION = 'pool-sponsor-1';
        const db = {
            run: vi.fn()
                .mockResolvedValueOnce([row('pool-sponsor-1', 'hash-pool'), row('caller-1', 'hash-c')])
                .mockResolvedValueOnce(1)   // deactivate UPDATE: ONLY the caller row
                .mockResolvedValueOnce([])  // guard for the caller's wallet
        };
        try {
            startSessionCleanup(db);
            await callback?.();
            // The deactivating UPDATE names ONLY the caller row (the cds mock's
            // updateWhereSpy records the where clause).
            expect(updateWhereSpy).toHaveBeenCalledWith({ sessionId: { in: ['caller-1'] } });
            expect(mockEvictWalletFacade).toHaveBeenCalledTimes(1); // the caller's wallet only
        } finally {
            delete process.env.NIGHTGATE_FEE_SPONSOR_SESSION;
            setIntervalSpy.mockRestore();
        }
    });

    it('session cleanup keeps the facade when the surviving sibling is an EXPIRED platform sponsor', async () => {
        // The guard used to ask SQL for `expiresAt > now`, which does not know
        // that a configured platform sponsor never expires. Its row therefore
        // looked dead to this one check while staying alive everywhere else,
        // and disconnecting any sibling session of the same wallet evicted the
        // facade the pool was still sponsoring from.
        let callback: (() => Promise<void>) | undefined;
        const setIntervalSpy = vi.spyOn(global, 'setInterval').mockImplementation(((handler: TimerHandler) => {
            callback = handler as () => Promise<void>;
            return {} as ReturnType<typeof setInterval>;
        }) as any);
        const encKey = getEncryptionKey();
        process.env.NIGHTGATE_FEE_SPONSOR_SESSION = 'pool-sponsor-9';
        const longAgo = new Date(Date.now() - 86_400_000).toISOString();
        const db = {
            run: vi.fn()
                .mockResolvedValueOnce([{ sessionId: 'caller-9', viewingKeyHash: 'hash-shared', encryptedViewingKey: encrypt('a'.repeat(64), encKey) }])
                .mockResolvedValueOnce(1)
                // The guard now reads active rows WITH their expiry and judges
                // them itself: the sponsor row is long past its TTL and still counts.
                .mockResolvedValueOnce([{ sessionId: 'pool-sponsor-9', expiresAt: longAgo }])
        };
        try {
            startSessionCleanup(db);
            await callback?.();
            expect(mockEvictWalletFacade).not.toHaveBeenCalled();
        } finally {
            delete process.env.NIGHTGATE_FEE_SPONSOR_SESSION;
            setIntervalSpy.mockRestore();
        }
    });

    it('session cleanup evicts once per wallet when only expiring rows reference it', async () => {
        let callback: (() => Promise<void>) | undefined;
        const setIntervalSpy = vi.spyOn(global, 'setInterval').mockImplementation(((handler: TimerHandler) => {
            callback = handler as () => Promise<void>;
            return {} as ReturnType<typeof setInterval>;
        }) as any);
        const encKey = getEncryptionKey();
        const expiringRow = (id: string) => ({ sessionId: id, viewingKeyHash: 'hash-a', encryptedViewingKey: encrypt('a'.repeat(64), encKey) });
        const db = {
            run: vi.fn()
                .mockResolvedValueOnce([expiringRow('old-1'), expiringRow('old-2')])
                .mockResolvedValueOnce(2)   // deactivate UPDATE first (both rows)
                .mockResolvedValueOnce([])  // guard: no live session left for this wallet
        };
        try {
            startSessionCleanup(db);
            await callback?.();
            // One wallet -> one guard lookup -> one eviction, despite two rows.
            expect(mockEvictWalletFacade).toHaveBeenCalledTimes(1);
            expect(mockEvictWalletFacade).toHaveBeenCalledWith('acct-derived');
            expect(db.run).toHaveBeenCalledTimes(3);
        } finally {
            setIntervalSpy.mockRestore();
        }
    });

    it('session cleanup still evicts legacy rows without a viewingKeyHash (secure default)', async () => {
        let callback: (() => Promise<void>) | undefined;
        const setIntervalSpy = vi.spyOn(global, 'setInterval').mockImplementation(((handler: TimerHandler) => {
            callback = handler as () => Promise<void>;
            return {} as ReturnType<typeof setInterval>;
        }) as any);
        const encKey = getEncryptionKey();
        const db = {
            run: vi.fn()
                .mockResolvedValueOnce([{ sessionId: 'old-legacy', encryptedViewingKey: encrypt('a'.repeat(64), encKey) }])
                .mockResolvedValueOnce(1)   // deactivate UPDATE
        };
        try {
            startSessionCleanup(db);
            await callback?.();
            expect(mockEvictWalletFacade).toHaveBeenCalledWith('acct-derived');
            expect(db.run).toHaveBeenCalledTimes(2); // no guard SELECT without a hash
        } finally {
            setIntervalSpy.mockRestore();
        }
    });

    it('startSessionCleanup ignores cleanup errors and supports timers without unref', async () => {
        let callback: (() => Promise<void>) | undefined;
        const setIntervalSpy = vi.spyOn(global, 'setInterval').mockImplementation(((handler: TimerHandler) => {
            callback = handler as () => Promise<void>;
            return {} as ReturnType<typeof setInterval>;
        }) as any);
        const db = { run: vi.fn().mockRejectedValue(new Error('cleanup failed')) };

        try {
            const timer = startSessionCleanup(db);
            await expect(callback?.()).resolves.toBeUndefined();
            expect(timer).toEqual({});
        } finally {
            setIntervalSpy.mockRestore();
        }
    });

    // ------------------------------------------------------------------
    // connectWalletForSigning
    // ------------------------------------------------------------------

    describe('connectWalletForSigning', () => {
        const VALID_SEED = 'a'.repeat(128); // 64-byte BIP39 seed (128 hex chars)
        const consoleSpies: MockInstance[] = [];

        beforeEach(() => {
            consoleSpies.push(vi.spyOn(cds.log('nightgate:sessions'), 'info').mockImplementation(() => {}));
            consoleSpies.push(vi.spyOn(cds.log('nightgate:sessions'), 'warn').mockImplementation(() => {}));
            consoleSpies.push(vi.spyOn(cds.log('nightgate:sessions'), 'error').mockImplementation(() => {}));
        });

        afterEach(() => {
            while (consoleSpies.length) consoleSpies.pop()?.mockRestore();
        });

        it('rejects rate-limited clients', async () => {
            const checkSpy = vi.spyOn(RateLimiter.prototype, 'check').mockReturnValue({ allowed: false, retryAfterMs: 1000 });
            try {
                const req = createMockRequest({ sessionId: 's1', seedHex: VALID_SEED });
                await registeredHandlers['connectWalletForSigning'](req);
                expect(req.reject).toHaveBeenCalledWith(429, expect.stringContaining('Rate limited'));
            } finally {
                checkSpy.mockRestore();
            }
        });

        it('validates required fields and seed format', async () => {
            const noSession = createMockRequest({ seedHex: VALID_SEED });
            await registeredHandlers['connectWalletForSigning'](noSession);
            expect(noSession.reject).toHaveBeenCalledWith(400, 'sessionId is required');

            const noSeed = createMockRequest({ sessionId: 's1' });
            await registeredHandlers['connectWalletForSigning'](noSeed);
            expect(noSeed.reject).toHaveBeenCalledWith(400, expect.stringContaining('mnemonic or seedHex'));

            const badHex = createMockRequest({ sessionId: 's1', seedHex: 'not-hex' });
            await registeredHandlers['connectWalletForSigning'](badHex);
            expect(badHex.reject).toHaveBeenCalledWith(400, expect.stringContaining('128 hex characters'));
        });

        it('rejects 404 when the session row is missing', async () => {
            mockDbRun.mockResolvedValueOnce(null);
            const req = createMockRequest({ sessionId: 's1', seedHex: VALID_SEED });
            await registeredHandlers['connectWalletForSigning'](req);
            expect(req.reject).toHaveBeenCalledWith(404, 'Session not found or inactive');
        });

        it('rejects 410 when the session has expired', async () => {
            mockDbRun.mockResolvedValueOnce(activeSessionRow({ expiresInMs: -1000 }));
            const req = createMockRequest({ sessionId: 's1', seedHex: VALID_SEED });
            await registeredHandlers['connectWalletForSigning'](req);
            expect(req.reject).toHaveBeenCalledWith(410, 'Session expired');
        });

        it('persists encryptedSeedKey, schedules the pre-warm job, and returns its jobId', async () => {
            const session = activeSessionRow();
            mockDbRun.mockResolvedValueOnce(session).mockResolvedValueOnce(1);
            (cds.env as any).requires = { nightgate: { network: 'preprod', nodeUrl: 'wss://node' } };

            const req = createMockRequest({ sessionId: 's1', seedHex: VALID_SEED });
            const result = await registeredHandlers['connectWalletForSigning'](req);

            expect(req.reject).not.toHaveBeenCalled();
            expect(updateWhereSpy).toHaveBeenCalledWith({ sessionId: 's1', userId: TEST_USER_ID });
            // The pre-warm call moves into startJob's `work` closure, not
            // called synchronously by the handler.
            expect(mockEnsureNetworkId).not.toHaveBeenCalled();
            expect(mockGetOrBuildWalletFacade).not.toHaveBeenCalled();

            expect(result).toEqual({
                sessionId:      's1',
                signingEnabled: true,
                prewarmJobId:   'job-connectWalletForSigning-test',
                prewarmStatus:  'pending'
            });

            // startJob was called with the right kind + a seed-less request.
            const args = mockStartJob.mock.calls[0][0];
            expect(args.kind).toBe('connectWalletForSigning');
            expect(args.sessionId).toBe('s1');
            expect(args.request).not.toHaveProperty('seedHex');

            // Drive work() to confirm it dispatches the actual pre-warm call.
            await runPersistedCommand(args);
            expect(mockEnsureNetworkId).toHaveBeenCalledWith('preprod');
            expect(mockGetOrBuildWalletFacade).toHaveBeenCalledWith('acct-derived', expect.objectContaining({
                seedHex:   VALID_SEED,
                networkId: 'preprod',
                relayUrl:  'wss://node'
            }));
            // The prewarm must block on sync-to-tip before returning, so the
            // deploy path doesn't balance against stale dust (Custom error 170).
            expect(mockWalletWaitForSyncedState).toHaveBeenCalledWith('acct-derived', expect.any(Number));
        });

        it('supersedes older prewarm jobs of the session, excluding the fresh one', async () => {
            mockSupersedeQueuedJobs.mockClear();
            mockDbRun.mockResolvedValueOnce(activeSessionRow()).mockResolvedValueOnce(1);
            const req = createMockRequest({ sessionId: 's1', seedHex: VALID_SEED });
            await registeredHandlers['connectWalletForSigning'](req);
            expect(mockSupersedeQueuedJobs).toHaveBeenCalledWith(
                'connectWalletForSigning', 's1', 'job-connectWalletForSigning-test'
            );
        });

        it('a failed supersede sweep does not fail the connect', async () => {
            mockSupersedeQueuedJobs.mockRejectedValueOnce(new Error('db busy'));
            mockDbRun.mockResolvedValueOnce(activeSessionRow()).mockResolvedValueOnce(1);
            const req = createMockRequest({ sessionId: 's1', seedHex: VALID_SEED });
            const result = await registeredHandlers['connectWalletForSigning'](req);
            expect(req.reject).not.toHaveBeenCalled();
            expect(result).toMatchObject({
                signingEnabled: true,
                prewarmJobId: 'job-connectWalletForSigning-test'
            });
        });

        it('returns signingEnabled:true with null prewarmJobId if startJob scheduling fails', async () => {
            const session = activeSessionRow();
            mockDbRun.mockResolvedValueOnce(session).mockResolvedValueOnce(1);
            mockStartJob.mockRejectedValueOnce(new Error('worker offline'));

            const warn = vi.spyOn(cds.log('nightgate:sessions'), 'warn').mockImplementation(() => {});
            try {
                const req = createMockRequest({ sessionId: 's1', seedHex: VALID_SEED });
                const result = await registeredHandlers['connectWalletForSigning'](req);
                expect(result).toEqual({
                    sessionId:      's1',
                    signingEnabled: true,
                    prewarmJobId:   null,
                    prewarmStatus:  null
                });
                // The session UPDATE still committed; signing is enabled.
                expect(updateWhereSpy).toHaveBeenCalledWith({ sessionId: 's1', userId: TEST_USER_ID });
            } finally {
                warn.mockRestore();
            }
        });
    });

    // ------------------------------------------------------------------
    // registerForDustGeneration / deregisterFromDustGeneration
    // ------------------------------------------------------------------

    describe('dust-registration handlers', () => {
        const logSpies: MockInstance[] = [];

        beforeEach(() => {
            logSpies.push(vi.spyOn(cds.log('nightgate:sessions'), 'info').mockImplementation(() => {}));
            logSpies.push(vi.spyOn(cds.log('nightgate:sessions'), 'warn').mockImplementation(() => {}));
        });

        afterEach(() => {
            while (logSpies.length) logSpies.pop()?.mockRestore();
        });

        it('rejects 412 when the session lacks a signing key', async () => {
            mockDbRun.mockResolvedValueOnce(activeSessionRow({ withSeed: false }));
            const req = createMockRequest({ sessionId: 's1' });
            await registeredHandlers['registerForDustGeneration'](req);
            expect(req.reject).toHaveBeenCalledWith(412, expect.stringContaining('connectWalletForSigning first'));
        });

        it('returns { jobId, status } and defers registerNightUtxosForDust to the job runner', async () => {
            mockDbRun.mockResolvedValueOnce(activeSessionRow());
            mockRegisterNightUtxosForDust.mockResolvedValueOnce({
                txId: 'tx-1',
                registeredCount: 3,
                totalNightUtxos: 5,
                dustReceiverAddress: 'mn_addr_dust'
            });
            const req = createMockRequest({ sessionId: 's1', dustReceiverAddress: 'mn_addr_x' });
            const result = await registeredHandlers['registerForDustGeneration'](req);

            expect(result).toEqual({
                jobId:  'job-registerForDustGeneration-test',
                status: 'pending'
            });
            // The inner worker call should NOT have happened synchronously;
            // it lives inside startJob's `work` closure now.
            expect(mockRegisterNightUtxosForDust).not.toHaveBeenCalled();

            // startJob receives the right shape: kind, sessionId, request snapshot
            // (no secrets), and a callable `work` that wraps the actual call.
            const args = mockStartJob.mock.calls[0][0];
            expect(args.kind).toBe('registerForDustGeneration');
            expect(args.sessionId).toBe('s1');
            expect(args.request).toEqual({ sessionId: 's1', dustReceiverAddress: 'mn_addr_x' });
            expect(args).toMatchObject({ commandVersion: 1, command: { op: 'registerDust' } });

            // Drive `work` directly and confirm it forwards cacheKey +
            // dustReceiverAddress through to the underlying call.
            await runPersistedCommand(args);
            expect(mockRegisterNightUtxosForDust).toHaveBeenCalledWith(expect.objectContaining({
                cacheKey:            'acct-derived',
                dustReceiverAddress: 'mn_addr_x'
            }));
        });

        it('forwards idempotencyKey to startJob when supplied', async () => {
            mockDbRun.mockResolvedValueOnce(activeSessionRow());
            const req = createMockRequest({ sessionId: 's1', idempotencyKey: 'idem-dust-1' });
            await registeredHandlers['registerForDustGeneration'](req);
            expect(mockStartJob.mock.calls[0][0].idempotencyKey).toBe('idem-dust-1');
        });

        it('synchronous setup errors (before startJob) still surface as 500', async () => {
            // Force the session SELECT to throw; this happens before the
            // handler hands off to startJob, so the request rejects directly.
            mockDbRun.mockRejectedValueOnce(new Error('db unreachable'));
            const req = createMockRequest({ sessionId: 's1' });
            await expect(registeredHandlers['registerForDustGeneration'](req)).rejects.toThrow('db unreachable');
        });

        it('rejects 429 when rate-limited', async () => {
            const checkSpy = vi.spyOn(RateLimiter.prototype, 'check').mockReturnValue({ allowed: false, retryAfterMs: 1000 });
            try {
                const req = createMockRequest({ sessionId: 's1' });
                await registeredHandlers['registerForDustGeneration'](req);
                expect(req.reject).toHaveBeenCalledWith(429, expect.stringContaining('Rate limited'));
            } finally {
                checkSpy.mockRestore();
            }
        });

        it('deregisterFromDustGeneration returns { jobId, status } and defers the inner call to startJob', async () => {
            mockDbRun.mockResolvedValueOnce(activeSessionRow());
            mockDeregisterNightUtxosFromDust.mockResolvedValueOnce({
                txId: 'tx-d',
                deregisteredCount: 2,
                totalNightUtxos: 4
            });
            const req = createMockRequest({ sessionId: 's1' });
            const result = await registeredHandlers['deregisterFromDustGeneration'](req);

            expect(result).toEqual({
                jobId:  'job-deregisterFromDustGeneration-test',
                status: 'pending'
            });
            expect(mockDeregisterNightUtxosFromDust).not.toHaveBeenCalled();

            // Drive the captured work fn and check it dispatches with the
            // session's derived accountId.
            const args = mockStartJob.mock.calls[0][0];
            expect(args.kind).toBe('deregisterFromDustGeneration');
            expect(args.sessionId).toBe('s1');
            await runPersistedCommand(args);
            expect(mockDeregisterNightUtxosFromDust).toHaveBeenCalledWith({ cacheKey: 'acct-derived' });
        });

        it('deregisterFromDustGeneration forwards idempotencyKey to startJob', async () => {
            mockDbRun.mockResolvedValueOnce(activeSessionRow());
            const req = createMockRequest({ sessionId: 's1', idempotencyKey: 'idem-d-1' });
            await registeredHandlers['deregisterFromDustGeneration'](req);
            expect(mockStartJob.mock.calls[0][0].idempotencyKey).toBe('idem-d-1');
        });
    });

    // ------------------------------------------------------------------
    // sendNight (covers parseNightAmount + validateOptionalTtl helpers)
    // ------------------------------------------------------------------

    describe('sendNight', () => {
        beforeEach(() => {
            vi.spyOn(cds.log('nightgate:sessions'), 'info').mockImplementation(() => {});
            vi.spyOn(cds.log('nightgate:sessions'), 'warn').mockImplementation(() => {});
        });

        afterEach(() => {
            vi.restoreAllMocks();
        });

        it('rejects 400 for missing or malformed inputs', async () => {
            const tests: Array<[Record<string, unknown>, string | RegExp]> = [
                [{},                                                            'sessionId is required'],
                [{ sessionId: 's' },                                            'receiverAddress is required'],
                [{ sessionId: 's', receiverAddress: 'mn_addr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }, 'amount is required'],
                [{ sessionId: 's', receiverAddress: 'unrecognised_prefix_abcdef0123456789abcdef01234567', amount: '1' }, /must start with/],
                [{ sessionId: 's', receiverAddress: 'mn_addr_too-short', amount: '1' }, /receiverAddress too short/],
                [{ sessionId: 's', receiverAddress: 'mn_addr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', amount: 'NaN' }, /decimal integer/],
                [{ sessionId: 's', receiverAddress: 'mn_addr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', amount: '0' }, 'amount must be > 0'],
                [{ sessionId: 's', receiverAddress: 'mn_addr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', amount: '1000000000000000000000' }, /sanity bound/],
                [{ sessionId: 's', receiverAddress: 'mn_addr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', amount: '1', ttlIso: 'not-a-date' }, /valid ISO-8601/],
                [{ sessionId: 's', receiverAddress: 'mn_addr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', amount: '1', ttlIso: new Date(Date.now() - 10_000).toISOString() }, /must be in the future/]
            ];

            for (const [data, matcher] of tests) {
                const req = createMockRequest(data);
                await registeredHandlers['sendNight'](req);
                expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(matcher as any));
            }
        });

        it('lowercases tokenTypeHex before persisting the command (SDK matches exact lowercase)', async () => {
            mockDbRun.mockResolvedValueOnce(activeSessionRow());
            const req = createMockRequest({
                sessionId: 's1',
                receiverAddress: 'mn_shield-addr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                amount: '1',
                tokenTypeHex: 'AB'.repeat(32)
            });
            await registeredHandlers['sendNight'](req);
            const args = mockStartJob.mock.calls[0][0];
            expect(args.command.tokenTypeHex).toBe('ab'.repeat(32));
            expect(args.request.tokenTypeHex).toBe('ab'.repeat(32));
        });

        it('returns { jobId, status } and defers sendNight to the job runner', async () => {
            mockDbRun.mockResolvedValueOnce(activeSessionRow());
            const req = createMockRequest({
                sessionId: 's1',
                receiverAddress: 'mn_shield-addr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                amount: '1'
            });
            const result = await registeredHandlers['sendNight'](req);

            expect(result).toEqual({ jobId: 'job-sendNight-test', status: 'pending' });
            expect(mockSendNight).not.toHaveBeenCalled();
            // Funds-moving command: must persist encrypted (review_002 P-low).
            expect(mockStartJob.mock.calls[0][0].encryptCommand).toBe(true);

            // Drive the captured work fn and confirm it dispatches with the
            // session's derived accountId + caller args.
            const args = mockStartJob.mock.calls[0][0];
            expect(args.kind).toBe('sendNight');
            expect(args.sessionId).toBe('s1');
            expect(args.request).toEqual({
                sessionId: 's1',
                receiverAddress: 'mn_shield-addr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                amount: '1',
                ttlIso: null,
                tokenTypeHex: null
            });
            mockSendNight.mockResolvedValueOnce({
                txId: 'tx-send', toLedger: 'shielded', amount: '1', receiverAddress: 'mn_shield-addr_x'
            });
            const workResult = await runPersistedCommand(args);
            expect(mockSendNight).toHaveBeenCalledWith(expect.objectContaining({
                cacheKey: 'acct-derived',
                amount: '1'
            }));
            expect(workResult).toMatchObject({ txId: 'tx-send', toLedger: 'shielded' });
        });

        it('forwards idempotencyKey through to startJob', async () => {
            mockDbRun.mockResolvedValueOnce(activeSessionRow());
            const req = createMockRequest({
                sessionId: 's1',
                receiverAddress: 'mn_shield-addr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                amount: '1',
                idempotencyKey: 'idem-send-1'
            });
            await registeredHandlers['sendNight'](req);
            expect(mockStartJob.mock.calls[0][0].idempotencyKey).toBe('idem-send-1');
        });
    });

    // ------------------------------------------------------------------
    // getWalletBalance + estimateSendNightFee
    // ------------------------------------------------------------------

    describe('diagnostics handlers', () => {
        beforeEach(() => {
            vi.spyOn(cds.log('nightgate:sessions'), 'info').mockImplementation(() => {});
        });
        afterEach(() => {
            vi.restoreAllMocks();
        });

        it('getWalletBalance returns the inner helper result', async () => {
            mockDbRun.mockResolvedValueOnce(activeSessionRow());
            mockGetWalletBalance.mockResolvedValueOnce({
                shieldedNight: '1', unshieldedNight: '2', dustBalance: '0',
                registeredNightUtxoCount: 0, totalNightUtxoCount: 0
            });
            const req = createMockRequest({ sessionId: 's1' });
            const result = await registeredHandlers['getWalletBalance'](req);
            expect(result.shieldedNight).toBe('1');
        });

        it('getWalletSyncProgress reports the worker snapshot without calling the worker', async () => {
            mockDbRun.mockResolvedValueOnce(activeSessionRow());
            mockWalletGetSyncProgress.mockReturnValueOnce({
                sessionId: 'acct-1', appliedIndex: '1200', streamTip: '1500',
                behindEvents: '300', eventsPerSecond: 12.5, etaSeconds: 24,
                blockHeight: '1951462', isConnected: true, indexerFresh: true,
                caughtUp: false, elapsedMs: 45_000, label: 'prewarm',
                updatedAt: '2026-08-04T09:00:00.000Z'
            });
            const req = createMockRequest({ sessionId: 's1' });
            const result = await registeredHandlers['getWalletSyncProgress'](req);

            expect(result).toMatchObject({
                known: true, caughtUp: false, appliedIndex: '1200',
                behindEvents: '300', eventsPerSecond: 12.5, etaSeconds: 24,
                phase: 'prewarm'
            });
            expect(req.reject).not.toHaveBeenCalled();
        });

        it('getWalletSyncProgress reports known=false when no snapshot exists yet', async () => {
            mockDbRun.mockResolvedValueOnce(activeSessionRow());
            mockWalletGetSyncProgress.mockReturnValueOnce(null);
            const req = createMockRequest({ sessionId: 's1' });
            const result = await registeredHandlers['getWalletSyncProgress'](req);

            expect(result.known).toBe(false);
            expect(result.appliedIndex).toBeNull();
            expect(req.reject).not.toHaveBeenCalled();
        });

        it('getWalletBalance maps inner errors to 500', async () => {
            mockDbRun.mockResolvedValueOnce(activeSessionRow());
            mockGetWalletBalance.mockRejectedValueOnce(new Error('worker stalled'));
            const req = createMockRequest({ sessionId: 's1' });
            await registeredHandlers['getWalletBalance'](req);
            expect(req.reject).toHaveBeenCalledWith(500, expect.stringContaining('getWalletBalance failed'));
        });

        it('estimateSendNightFee happy path forwards to the inner helper', async () => {
            mockDbRun.mockResolvedValueOnce(activeSessionRow());
            mockEstimateSendNightFee.mockResolvedValueOnce({ fee: '123', toLedger: 'shielded' });
            const req = createMockRequest({
                sessionId: 's1',
                receiverAddress: 'mn_shield-addr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                amount: '1'
            });
            const result = await registeredHandlers['estimateSendNightFee'](req);
            expect(result).toEqual({ fee: '123', toLedger: 'shielded' });
        });

        it('estimateSendNightFee rejects bad amount before any inner call', async () => {
            const req = createMockRequest({
                sessionId: 's1',
                receiverAddress: 'mn_shield-addr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                amount: '0'
            });
            await registeredHandlers['estimateSendNightFee'](req);
            expect(req.reject).toHaveBeenCalledWith(400, 'amount must be > 0');
            expect(mockEstimateSendNightFee).not.toHaveBeenCalled();
        });

        // 0.10.2 pool-starvation fix (worker-calls-outside-request-tx FR):
        // session reads detach from the request tx, worker waits are bounded.

        it('getWalletBalance resolves the session read outside the ambient request tx', async () => {
            mockRunWithoutAmbientTx.mockClear();
            mockDbRun.mockResolvedValueOnce(activeSessionRow());
            mockGetWalletBalance.mockResolvedValueOnce({
                shieldedNight: '1', unshieldedNight: '2', dustBalance: '0',
                registeredNightUtxoCount: 0, totalNightUtxoCount: 0
            });
            const req = createMockRequest({ sessionId: 's1' });
            await registeredHandlers['getWalletBalance'](req);
            expect(mockRunWithoutAmbientTx).toHaveBeenCalled();
        });

        it('getWalletBalance forwards the bounded sync gate to the worker call', async () => {
            mockDbRun.mockResolvedValueOnce(activeSessionRow());
            mockGetWalletBalance.mockResolvedValueOnce({
                shieldedNight: '1', unshieldedNight: '2', dustBalance: '0',
                registeredNightUtxoCount: 0, totalNightUtxoCount: 0
            });
            const req = createMockRequest({ sessionId: 's1' });
            await registeredHandlers['getWalletBalance'](req);
            expect(mockGetWalletBalance).toHaveBeenCalledWith(
                expect.objectContaining({ syncTimeoutMs: 10_000 })
            );
        });

        it('getWalletBalance maps a sync-gate timeout to 503 WALLET_SYNCING', async () => {
            mockDbRun.mockResolvedValueOnce(activeSessionRow());
            mockGetWalletBalance.mockRejectedValueOnce(new Error('getBalance: sync timeout'));
            const req = createMockRequest({ sessionId: 's1' });
            await registeredHandlers['getWalletBalance'](req);
            expect(req.reject).toHaveBeenCalledWith(expect.objectContaining({
                code: 'WALLET_SYNCING',
                status: 503
            }));
        });
    });

    // ------------------------------------------------------------------
    // disconnectWallet pre-eviction flow
    // ------------------------------------------------------------------

    describe('disconnectWallet (facade eviction)', () => {
        beforeEach(() => {
            vi.spyOn(cds.log('nightgate:sessions'), 'info').mockImplementation(() => {});
        });
        afterEach(() => {
            vi.restoreAllMocks();
        });

        it('deactivates the session and then evicts the cached facade for the account', async () => {
            mockDbRun.mockResolvedValueOnce(activeSessionRow());
            mockDbRun.mockResolvedValueOnce(1);

            const req = createMockRequest({ sessionId: 's1' });
            await registeredHandlers['disconnectWallet'](req);

            expect(mockEvictWalletFacade).toHaveBeenCalledWith('acct-derived');
            expect(updateWhereSpy).toHaveBeenCalledWith({ sessionId: 's1', userId: TEST_USER_ID });
        });

        it('runs its DB work detached so the evict await never holds a request tx', async () => {
            mockRunWithoutAmbientTx.mockClear();
            mockDbRun.mockResolvedValueOnce(activeSessionRow());
            mockDbRun.mockResolvedValueOnce(1);

            const req = createMockRequest({ sessionId: 's1' });
            await registeredHandlers['disconnectWallet'](req);

            // Session SELECT + final deactivating UPDATE both detach.
            expect(mockRunWithoutAmbientTx).toHaveBeenCalledTimes(2);
        });

        // session-sweep-evicts-live-facade FR: logout of one session must not
        // evict the facade a sibling active session still uses.

        it('keeps the facade when another active session still uses the wallet', async () => {
            mockDbRun.mockResolvedValueOnce({ ...activeSessionRow(), viewingKeyHash: 'hash-a' });
            mockDbRun.mockResolvedValueOnce(1);                             // deactivate UPDATE (runs first)
            mockDbRun.mockResolvedValueOnce([{ sessionId: 'other-live' }]); // guard: live sibling

            const req = createMockRequest({ sessionId: 's1' });
            await registeredHandlers['disconnectWallet'](req);

            expect(mockEvictWalletFacade).not.toHaveBeenCalled();
            // The disconnecting row itself is still deactivated.
            expect(updateWhereSpy).toHaveBeenCalledWith({ sessionId: 's1', userId: TEST_USER_ID });
        });

        it('evicts when the disconnecting session was the only live reference', async () => {
            mockDbRun.mockResolvedValueOnce({ ...activeSessionRow(), viewingKeyHash: 'hash-a' });
            mockDbRun.mockResolvedValueOnce(1);  // deactivate UPDATE (runs first)
            mockDbRun.mockResolvedValueOnce([]); // guard: own row already inactive, nobody else

            const req = createMockRequest({ sessionId: 's1' });
            await registeredHandlers['disconnectWallet'](req);

            expect(mockEvictWalletFacade).toHaveBeenCalledWith('acct-derived');
        });

        // session-sweep FR review P1: the expired-disconnect path must run the
        // same shared-session-aware eviction, or a sole session's in-memory
        // keys outlive the row forever (the sweep only selects active rows).

        it('expired disconnect evicts the facade when it was the only live reference', async () => {
            mockDbRun.mockResolvedValueOnce({ ...activeSessionRow({ expiresInMs: -1000 }), viewingKeyHash: 'hash-a' });
            mockDbRun.mockResolvedValueOnce(1);  // deactivate UPDATE
            mockDbRun.mockResolvedValueOnce([]); // guard: no live session left

            const req = createMockRequest({ sessionId: 's1' });
            await registeredHandlers['disconnectWallet'](req);

            expect(mockEvictWalletFacade).toHaveBeenCalledWith('acct-derived');
            expect(req.reject).toHaveBeenCalledWith(410, 'Session expired');
        });

        it('expired disconnect keeps the facade when another active session uses the wallet', async () => {
            mockDbRun.mockResolvedValueOnce({ ...activeSessionRow({ expiresInMs: -1000 }), viewingKeyHash: 'hash-a' });
            mockDbRun.mockResolvedValueOnce(1);                             // deactivate UPDATE
            mockDbRun.mockResolvedValueOnce([{ sessionId: 'other-live' }]); // guard: live sibling

            const req = createMockRequest({ sessionId: 's1' });
            await registeredHandlers['disconnectWallet'](req);

            expect(mockEvictWalletFacade).not.toHaveBeenCalled();
            expect(req.reject).toHaveBeenCalledWith(410, 'Session expired');
        });
    });

    describe('connectWallet label', () => {
        it('stores the operator-facing label and returns it', async () => {
            mockDbRun.mockResolvedValueOnce(undefined);
            const req = createMockRequest({ viewingKey: 'a'.repeat(64), label: 'sponsor-pool-1' });
            const result: any = await registeredHandlers['connectWallet'](req);

            expect(insertEntriesSpy.mock.calls[0][0].label).toBe('sponsor-pool-1');
            expect(result.label).toBe('sponsor-pool-1');
        });

        it('stores null when no label is given, so nothing changes for existing callers', async () => {
            mockDbRun.mockResolvedValueOnce(undefined);
            await registeredHandlers['connectWallet'](createMockRequest({ viewingKey: 'a'.repeat(64) }));
            expect(insertEntriesSpy.mock.calls[0][0].label).toBeNull();
        });

        it('rejects an oversized label instead of letting it become a storage field', async () => {
            const req = createMockRequest({ viewingKey: 'a'.repeat(64), label: 'x'.repeat(101) });
            await registeredHandlers['connectWallet'](req);
            expect(req.reject).toHaveBeenCalledWith(400, expect.stringContaining('at most 100'));
            expect(insertEntriesSpy).not.toHaveBeenCalled();
        });
    });

    describe('platform-sponsor expiry exemption', () => {
        const SPONSOR_SESSION = 'sponsor-session-x';
        const previousPool = process.env.NIGHTGATE_FEE_SPONSOR_SESSION;

        afterEach(() => {
            if (previousPool === undefined) delete process.env.NIGHTGATE_FEE_SPONSOR_SESSION;
            else process.env.NIGHTGATE_FEE_SPONSOR_SESSION = previousPool;
        });

        it('reads the balance of an EXPIRED session that is configured as a sponsor', async () => {
            // Live-observed on the hosted server: the pool's own sessions have
            // long-past expiresAt (they are exempt where they act as
            // infrastructure), so every ordinary read answered 410 for wallets
            // that were paying for everyone's transactions.
            process.env.NIGHTGATE_FEE_SPONSOR_SESSION = SPONSOR_SESSION;
            mockDbRun.mockResolvedValueOnce({ ...activeSessionRow({ expiresInMs: -60_000 }), sessionId: SPONSOR_SESSION });
            mockGetWalletBalance.mockResolvedValueOnce({ dustBalance: '42', registeredNightUtxoCount: 1 });

            const req = createMockRequest({ sessionId: SPONSOR_SESSION });
            const result: any = await registeredHandlers['getWalletBalance'](req);

            expect(req.reject).not.toHaveBeenCalled();
            expect(result.dustBalance).toBe('42');
        });

        it('still rejects an expired session that is NOT a configured sponsor', async () => {
            delete process.env.NIGHTGATE_FEE_SPONSOR_SESSION;
            mockDbRun.mockResolvedValueOnce(activeSessionRow({ expiresInMs: -60_000 }));

            const req = createMockRequest({ sessionId: 'sess-1' });
            await registeredHandlers['getWalletBalance'](req);

            expect(req.reject).toHaveBeenCalledWith(410, 'Session expired');
        });

        it('applies the same rule to sendNight, so one path cannot disagree with another', async () => {
            process.env.NIGHTGATE_FEE_SPONSOR_SESSION = SPONSOR_SESSION;
            mockDbRun.mockResolvedValueOnce({ ...activeSessionRow({ expiresInMs: -60_000 }), sessionId: SPONSOR_SESSION });

            const req = createMockRequest({
                sessionId: SPONSOR_SESSION,
                receiverAddress: 'addr'.repeat(20),
                amount: '1000'
            });
            await registeredHandlers['sendNight'](req);

            expect(req.reject).not.toHaveBeenCalledWith(410, expect.anything());
        });
    });

    describe('getSponsorPoolStatus', () => {
        const SPONSOR = 'sponsor-session-1';
        const previousPoolEnv = process.env.NIGHTGATE_FEE_SPONSOR_SESSION;

        afterEach(() => {
            if (previousPoolEnv === undefined) delete process.env.NIGHTGATE_FEE_SPONSOR_SESSION;
            else process.env.NIGHTGATE_FEE_SPONSOR_SESSION = previousPoolEnv;
        });

        function adminRequest() {
            const req = createMockRequest({});
            req.user.is = (role: string) => role === 'admin';
            return req;
        }

        beforeEach(() => {
            // Default to a WARM facade: the handler refuses to read a balance
            // from a cold one, so every other case here needs progress present.
            mockWalletGetSyncProgress.mockReturnValue({ caughtUp: true });
            mockHasWalletFacade.mockReturnValue(false);
        });

        it('is empty when no sponsor pool is configured', async () => {
            delete process.env.NIGHTGATE_FEE_SPONSOR_SESSION;
            const result: any = await registeredHandlers['getSponsorPoolStatus'](createMockRequest({}));
            expect(result).toEqual([]);
            expect(mockDbRun).not.toHaveBeenCalled();
        });

        it('reports backings as the parallel sponsoring capacity', async () => {
            process.env.NIGHTGATE_FEE_SPONSOR_SESSION = SPONSOR;
            const row = { ...activeSessionRow(), sessionId: SPONSOR, userId: 'someone-else' };
            mockDbRun.mockResolvedValueOnce(row);   // visibility lookup
            mockDbRun.mockResolvedValueOnce(row);   // loadSigningSessionAccountId
            mockGetWalletBalance.mockResolvedValueOnce({
                dustBalance: '5000',
                registeredNightUtxoCount: 4, dustUtxoCount: 4,
                dustPendingCount: 0,
                dustRestoreCount: 1
            });

            const result: any = await registeredHandlers['getSponsorPoolStatus'](adminRequest());
            expect(result).toHaveLength(1);
            expect(result[0]).toMatchObject({
                sessionId: SPONSOR,
                usable: true,
                registeredNightUtxos: 4, dustNotes: 4,
                pendingDustNotes: 0,
                dustRestoreCount: 1,
                lastError: null
            });
        });

        it('is not usable with backings but no dust', async () => {
            process.env.NIGHTGATE_FEE_SPONSOR_SESSION = SPONSOR;
            const row = { ...activeSessionRow(), sessionId: SPONSOR };
            mockDbRun.mockResolvedValueOnce(row).mockResolvedValueOnce(row);
            mockGetWalletBalance.mockResolvedValueOnce({ dustBalance: '0', registeredNightUtxoCount: 2 });

            const result: any = await registeredHandlers['getSponsorPoolStatus'](adminRequest());
            expect(result[0].usable).toBe(false);
        });

        it('counts DELEGATED dust notes as the capacity, not the sponsor own registrations', async () => {
            // Dust generation is delegable: a foreign wallet points its NIGHT
            // at this sponsor's dust address, and every one of its registered
            // UTXOs yields a note here while this sponsor's own registration
            // count never moves. Reporting the own count showed a pool that had
            // just gone from 3 to 14 notes as flat, and a sponsor funded purely
            // by donors as unusable.
            process.env.NIGHTGATE_FEE_SPONSOR_SESSION = SPONSOR;
            const row = { ...activeSessionRow(), sessionId: SPONSOR };
            mockDbRun.mockResolvedValueOnce(row).mockResolvedValueOnce(row);
            mockGetWalletBalance.mockResolvedValueOnce({
                dustBalance: '6510232317207628087',
                registeredNightUtxoCount: 0,   // owns nothing registered
                dustUtxoCount: 14,             // fourteen notes, all delegated
                dustPendingCount: 0,
                dustRestoreCount: 0
            });

            const result: any = await registeredHandlers['getSponsorPoolStatus'](adminRequest());
            expect(result[0]).toMatchObject({ usable: true, registeredNightUtxos: 0, dustNotes: 14 });
        });

        it('counts only FREE dust notes, since a pending one cannot back another sponsorship', async () => {
            // `dustUtxoCount` is the SDK's total, which is available PLUS
            // pending. Reading it as capacity promised four parallel
            // sponsorships from a wallet that could serve two.
            process.env.NIGHTGATE_FEE_SPONSOR_SESSION = SPONSOR;
            const row = { ...activeSessionRow(), sessionId: SPONSOR };
            mockDbRun.mockResolvedValueOnce(row).mockResolvedValueOnce(row);
            mockGetWalletBalance.mockResolvedValueOnce({
                dustBalance: '5000', registeredNightUtxoCount: 4,
                dustUtxoCount: 4, dustPendingCount: 2, dustRestoreCount: 0
            });

            const result: any = await registeredHandlers['getSponsorPoolStatus'](adminRequest());
            expect(result[0]).toMatchObject({ dustNotes: 2, pendingDustNotes: 2 });
        });

        it('prefers the worker own free-note count over the subtraction', async () => {
            // The worker reports `dustAvailableCount` where the SDK exposes an
            // available list; trust it rather than re-deriving the arithmetic.
            process.env.NIGHTGATE_FEE_SPONSOR_SESSION = SPONSOR;
            const row = { ...activeSessionRow(), sessionId: SPONSOR };
            mockDbRun.mockResolvedValueOnce(row).mockResolvedValueOnce(row);
            mockGetWalletBalance.mockResolvedValueOnce({
                dustBalance: '5000', registeredNightUtxoCount: 4,
                dustUtxoCount: 9, dustAvailableCount: 3, dustPendingCount: 2, dustRestoreCount: 0
            });

            const result: any = await registeredHandlers['getSponsorPoolStatus'](adminRequest());
            expect(result[0]).toMatchObject({ dustNotes: 3 });
        });

        it('a wallet whose notes are ALL pending is not usable', async () => {
            process.env.NIGHTGATE_FEE_SPONSOR_SESSION = SPONSOR;
            const row = { ...activeSessionRow(), sessionId: SPONSOR };
            mockDbRun.mockResolvedValueOnce(row).mockResolvedValueOnce(row);
            mockGetWalletBalance.mockResolvedValueOnce({
                dustBalance: '5000', registeredNightUtxoCount: 4,
                dustUtxoCount: 2, dustPendingCount: 2, dustRestoreCount: 0
            });

            const result: any = await registeredHandlers['getSponsorPoolStatus'](adminRequest());
            expect(result[0]).toMatchObject({ usable: false, dustNotes: 0 });
        });

        it('hides the exact balance from a caller who is neither admin nor owner, keeping the flags', async () => {
            process.env.NIGHTGATE_FEE_SPONSOR_SESSION = SPONSOR;
            const row = { ...activeSessionRow(), sessionId: SPONSOR, userId: 'someone-else' };
            mockDbRun.mockResolvedValueOnce(row).mockResolvedValueOnce(row);
            mockGetWalletBalance.mockResolvedValueOnce({
                dustBalance: '5000',
                registeredNightUtxoCount: 4, dustUtxoCount: 4,
                dustPendingCount: 2
            });

            const result: any = await registeredHandlers['getSponsorPoolStatus'](createMockRequest({}));
            expect(result[0].dustBalance).toBeNull();
            // Still enough to answer "can the pool pay, and is it wedged".
            expect(result[0]).toMatchObject({ usable: true, registeredNightUtxos: 4, dustNotes: 2, pendingDustNotes: 2 });
        });

        it('shows the exact balance to the session owner', async () => {
            process.env.NIGHTGATE_FEE_SPONSOR_SESSION = SPONSOR;
            const row = { ...activeSessionRow(), sessionId: SPONSOR, userId: TEST_USER_ID };
            mockDbRun.mockResolvedValueOnce(row).mockResolvedValueOnce(row);
            mockGetWalletBalance.mockResolvedValueOnce({ dustBalance: '5000', registeredNightUtxoCount: 1 });

            const result: any = await registeredHandlers['getSponsorPoolStatus'](createMockRequest({}));
            expect(result[0].dustBalance).toBe('5000');
        });

        it('does NOT call a configured sponsor expired, the way resolveFeeSponsor does not', async () => {
            // Live-found: the pool reported all three production sponsors as
            // "Session expired" while sponsoring worked fine. A configured
            // platform sponsor is infrastructure and does not expire while it
            // is configured; the cleanup sweep exempts it for the same reason.
            process.env.NIGHTGATE_FEE_SPONSOR_SESSION = SPONSOR;
            const expired = { ...activeSessionRow({ expiresInMs: -60_000 }), sessionId: SPONSOR };
            mockDbRun.mockResolvedValueOnce(expired).mockResolvedValueOnce(expired);
            mockGetWalletBalance.mockResolvedValueOnce({ dustBalance: '900', registeredNightUtxoCount: 3, dustUtxoCount: 3 });

            const result: any = await registeredHandlers['getSponsorPoolStatus'](adminRequest());
            expect(result[0].lastError).toBeNull();
            expect(result[0]).toMatchObject({ usable: true, registeredNightUtxos: 3, dustNotes: 3 });
        });

        it('names a configured sponsor that is missing or inactive', async () => {
            process.env.NIGHTGATE_FEE_SPONSOR_SESSION = SPONSOR;
            mockDbRun.mockResolvedValueOnce(undefined);

            const result: any = await registeredHandlers['getSponsorPoolStatus'](adminRequest());
            expect(result[0]).toMatchObject({ usable: false, registeredNightUtxos: 0, dustNotes: 0 });
            expect(result[0].lastError).toContain('missing or inactive');
            expect(mockGetWalletBalance).not.toHaveBeenCalled();
        });

        it('names a sponsor that cannot sign, which looks configured and is not', async () => {
            process.env.NIGHTGATE_FEE_SPONSOR_SESSION = SPONSOR;
            mockDbRun.mockResolvedValueOnce({ ...activeSessionRow({ withSeed: false }), sessionId: SPONSOR });

            const result: any = await registeredHandlers['getSponsorPoolStatus'](adminRequest());
            expect(result[0].usable).toBe(false);
            expect(result[0].lastError).toContain('no signing key');
        });

        it('reads a resident facade that never reported progress', async () => {
            // Live-observed on the hosted pool: a facade restored from
            // persisted state and already at the tip is fully usable and
            // pushes no progress snapshot, because the worker only sends those
            // while a sync WAIT runs. Gating on progress alone reported such a
            // sponsor as cold forever.
            process.env.NIGHTGATE_FEE_SPONSOR_SESSION = SPONSOR;
            const row = { ...activeSessionRow(), sessionId: SPONSOR };
            mockDbRun.mockResolvedValueOnce(row).mockResolvedValueOnce(row);
            mockWalletGetSyncProgress.mockReturnValue(null);
            mockHasWalletFacade.mockReturnValue(true);
            mockGetWalletBalance.mockResolvedValueOnce({ dustBalance: '700', registeredNightUtxoCount: 2, dustUtxoCount: 2 });

            const result: any = await registeredHandlers['getSponsorPoolStatus'](adminRequest());
            expect(result[0]).toMatchObject({ usable: true, registeredNightUtxos: 2, dustNotes: 2, lastError: null });
        });

        it('never builds a cold facade: a status read must not create work', async () => {
            // Live-observed: polling this against a freshly booted server piled
            // up worker RPCs (inFlightRpcs climbing, facades still empty),
            // because getWalletBalance builds the facade and that build
            // outlives the capped request. The progress cache decides instead.
            process.env.NIGHTGATE_FEE_SPONSOR_SESSION = SPONSOR;
            const row = { ...activeSessionRow(), sessionId: SPONSOR };
            mockDbRun.mockResolvedValueOnce(row).mockResolvedValueOnce(row);
            mockWalletGetSyncProgress.mockReturnValue(null);

            const result: any = await registeredHandlers['getSponsorPoolStatus'](adminRequest());
            expect(mockGetWalletBalance).not.toHaveBeenCalled();
            expect(result[0].usable).toBe(false);
            expect(result[0].lastError).toContain('not warm yet');
        });

        it('caps a sponsor whose facade never answers instead of parking the caller', async () => {
            // A status endpoint must not hang. The read-sync gate bounds the
            // catch-up wait, but BUILDING a cold facade happens before it and
            // is unbounded, so the whole per-sponsor read carries its own cap.
            process.env.NIGHTGATE_FEE_SPONSOR_SESSION = SPONSOR;
            process.env.NIGHTGATE_SPONSOR_STATUS_TIMEOUT_MS = '80';
            try {
                const row = { ...activeSessionRow(), sessionId: SPONSOR };
                mockDbRun.mockResolvedValueOnce(row).mockResolvedValueOnce(row);
                mockGetWalletBalance.mockImplementationOnce(() => new Promise(() => { /* never settles */ }));

                const started = Date.now();
                const result: any = await registeredHandlers['getSponsorPoolStatus'](adminRequest());
                expect(Date.now() - started).toBeLessThan(3000);
                expect(result[0].usable).toBe(false);
                expect(result[0].lastError).toContain('warming up');
            } finally {
                delete process.env.NIGHTGATE_SPONSOR_STATUS_TIMEOUT_MS;
            }
        });

        it('keeps reporting the rest of the pool when one sponsor is unreadable', async () => {
            process.env.NIGHTGATE_FEE_SPONSOR_SESSION = `${SPONSOR},sponsor-session-2`;
            const first = { ...activeSessionRow(), sessionId: SPONSOR };
            const second = { ...activeSessionRow(), sessionId: 'sponsor-session-2' };
            mockDbRun
                .mockResolvedValueOnce(first).mockResolvedValueOnce(first)
                .mockResolvedValueOnce(second).mockResolvedValueOnce(second);
            mockGetWalletBalance
                .mockRejectedValueOnce(new Error('wallet not genuinely synced'))
                .mockResolvedValueOnce({ dustBalance: '900', registeredNightUtxoCount: 2, dustUtxoCount: 2 });

            const result: any = await registeredHandlers['getSponsorPoolStatus'](adminRequest());
            expect(result).toHaveLength(2);
            expect(result[0].lastError).toContain('not genuinely synced');
            expect(result[1].usable).toBe(true);
        });

        it('looks a platform sponsor up WITHOUT the owner constraint', async () => {
            process.env.NIGHTGATE_FEE_SPONSOR_SESSION = SPONSOR;
            const row = { ...activeSessionRow(), sessionId: SPONSOR, userId: 'someone-else' };
            mockDbRun.mockResolvedValueOnce(row).mockResolvedValueOnce(row);
            mockGetWalletBalance.mockResolvedValueOnce({ dustBalance: '1', registeredNightUtxoCount: 1 });

            await registeredHandlers['getSponsorPoolStatus'](createMockRequest({}));
            // Same rule resolveFeeSponsor() applies: a configured sponsor is
            // infrastructure, not a caller's session.
            for (const call of selectWhereSpy.mock.calls) {
                expect(call[0]).not.toHaveProperty('userId');
            }
        });
    });
});
