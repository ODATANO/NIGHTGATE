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

const mockEvictWalletFacade = jest.fn();
const mockGetOrBuildWalletFacade = jest.fn();
const mockDeriveAccountId = jest.fn();
const mockDeriveStoragePassword = jest.fn();
const mockRegisterNightUtxosForDust = jest.fn();
const mockDeregisterNightUtxosFromDust = jest.fn();
const mockSendNight = jest.fn();
const mockUnshieldFunds = jest.fn();
const mockShieldFunds = jest.fn();
const mockGetWalletBalance = jest.fn();
const mockEstimateSendNightFee = jest.fn();
const mockEstimateUnshieldFee = jest.fn();
const mockEstimateShieldFee = jest.fn();
const mockEnsureNetworkId = jest.fn();

jest.mock('../../srv/submission/wallet-facade-builder', () => ({
    evictWalletFacade: mockEvictWalletFacade,
    getOrBuildWalletFacade: mockGetOrBuildWalletFacade
}));

jest.mock('../../srv/submission/wallet-material-factory', () => ({
    deriveAccountId: mockDeriveAccountId,
    deriveStoragePassword: mockDeriveStoragePassword
}));

jest.mock('../../srv/submission/dust-registration', () => ({
    registerNightUtxosForDust: mockRegisterNightUtxosForDust,
    deregisterNightUtxosFromDust: mockDeregisterNightUtxosFromDust
}));

jest.mock('../../srv/submission/token-ops', () => ({
    sendNight: mockSendNight,
    unshieldFunds: mockUnshieldFunds,
    shieldFunds: mockShieldFunds,
    getWalletBalance: mockGetWalletBalance,
    estimateSendNightFee: mockEstimateSendNightFee,
    estimateUnshieldFee: mockEstimateUnshieldFee,
    estimateShieldFee: mockEstimateShieldFee
}));

jest.mock('../../srv/midnight/providers', () => ({
    ensureNetworkId: mockEnsureNetworkId
}));

// Phase 2: dust handlers + connectWalletForSigning hand long work to startJob
// and return { jobId, status }. The stub here returns a predictable jobId so
// handler-level assertions can be deterministic; the work fn is captured for
// the few cases that drive it explicitly (idempotency, failure classification).
const mockStartJob = jest.fn(async (args: any) => ({ jobId: `job-${args.kind}-test`, status: 'pending' as const }));
jest.mock('../../srv/submission/background-jobs', () => ({
    startJob: (...args: unknown[]) => (mockStartJob as any)(...args)
}));

import cds from '@sap/cds';
import { encrypt, getEncryptionKey } from '../../srv/utils/crypto';
import { RateLimiter } from '../../srv/utils/rate-limiter';
import { registerWalletSessionHandlers, startSessionCleanup } from '../../srv/sessions/wallet-sessions';

// Unique IP per call so rate-limit buckets never collide across tests within
// a file (the per-IP "5 per hour" buckets would otherwise be exhausted by
// the first few cases). Tests that need a specific IP pass one explicitly.
let __ipCounter = 0;
function defaultIp(): string {
    // 192.168.x.x range — kept distinct from explicit IPs like 10.0.0.1 used
    // by rate-limit-specific tests so the two buckets can't collide.
    __ipCounter += 1;
    return `192.168.${(__ipCounter >> 8) & 0xff}.${__ipCounter & 0xff}`;
}

function createMockRequest(data: Record<string, unknown>, ip: string | null | undefined = undefined) {
    const req: any = {
        data,
        reject: jest.fn().mockImplementation((code: number, message: string) => ({
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
// VS Code's Jest extension propagates them into the test process. nightgate-
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
        jest.clearAllMocks();
        for (const key of NIGHTGATE_ENV_KEYS) delete process.env[key];
        mockDbRun.mockReset();
        selectWhereSpy.mockReset();
        updateWhereSpy.mockReset();
        insertEntriesSpy.mockReset();
        Object.keys(registeredHandlers).forEach(k => delete registeredHandlers[k]);
        (cds.env as any).requires = { nightgate: {} };
        mockDeriveAccountId.mockReturnValue('acct-derived');
        mockDeriveStoragePassword.mockReturnValue('storage-pass-derived');
        mockEnsureNetworkId.mockResolvedValue(undefined);
        mockGetOrBuildWalletFacade.mockResolvedValue({ facade: {} });
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
            encryptedSeedKey: opts.withSeed === false ? null : encrypt('b'.repeat(64), encKey),
            expiresAt: new Date(Date.now() + future).toISOString()
        };
    }

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
            isActive: true
        }));
        expect(result).toEqual(expect.objectContaining({
            sessionId: 'generated-id',
            isActive: true
        }));
        expect(result.sessionToken).toBeUndefined();
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

    // ------------------------------------------------------------------
    // connectWalletForSigning
    // ------------------------------------------------------------------

    describe('connectWalletForSigning', () => {
        const VALID_SEED = 'a'.repeat(64);
        const consoleSpies: jest.SpyInstance[] = [];

        beforeEach(() => {
            consoleSpies.push(jest.spyOn(console, 'log').mockImplementation());
            consoleSpies.push(jest.spyOn(console, 'warn').mockImplementation());
            consoleSpies.push(jest.spyOn(console, 'error').mockImplementation());
        });

        afterEach(() => {
            while (consoleSpies.length) consoleSpies.pop()?.mockRestore();
        });

        it('rejects rate-limited clients', async () => {
            const checkSpy = jest.spyOn(RateLimiter.prototype, 'check').mockReturnValue({ allowed: false, retryAfterMs: 1000 });
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
            expect(noSeed.reject).toHaveBeenCalledWith(400, 'seedHex is required');

            const badHex = createMockRequest({ sessionId: 's1', seedHex: 'not-hex' });
            await registeredHandlers['connectWalletForSigning'](badHex);
            expect(badHex.reject).toHaveBeenCalledWith(400, expect.stringContaining('64 hex characters'));
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
            expect(updateWhereSpy).toHaveBeenCalledWith({ sessionId: 's1' });
            // The pre-warm call moves into startJob's `work` closure — not
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
            await args.work();
            expect(mockEnsureNetworkId).toHaveBeenCalledWith('preprod');
            expect(mockGetOrBuildWalletFacade).toHaveBeenCalledWith('acct-derived', expect.objectContaining({
                seedHex:   VALID_SEED,
                networkId: 'preprod',
                relayUrl:  'wss://node'
            }));
        });

        it('returns signingEnabled:true with null prewarmJobId if startJob scheduling fails', async () => {
            const session = activeSessionRow();
            mockDbRun.mockResolvedValueOnce(session).mockResolvedValueOnce(1);
            mockStartJob.mockRejectedValueOnce(new Error('worker offline'));

            const warn = jest.spyOn(console, 'warn').mockImplementation();
            try {
                const req = createMockRequest({ sessionId: 's1', seedHex: VALID_SEED });
                const result = await registeredHandlers['connectWalletForSigning'](req);
                expect(result).toEqual({
                    sessionId:      's1',
                    signingEnabled: true,
                    prewarmJobId:   null,
                    prewarmStatus:  null
                });
                // The session UPDATE still committed — signing is enabled.
                expect(updateWhereSpy).toHaveBeenCalledWith({ sessionId: 's1' });
            } finally {
                warn.mockRestore();
            }
        });
    });

    // ------------------------------------------------------------------
    // registerForDustGeneration / deregisterFromDustGeneration
    // ------------------------------------------------------------------

    describe('dust-registration handlers', () => {
        const logSpies: jest.SpyInstance[] = [];

        beforeEach(() => {
            logSpies.push(jest.spyOn(console, 'log').mockImplementation());
            logSpies.push(jest.spyOn(console, 'warn').mockImplementation());
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
            // The inner worker call should NOT have happened synchronously —
            // it lives inside startJob's `work` closure now.
            expect(mockRegisterNightUtxosForDust).not.toHaveBeenCalled();

            // startJob receives the right shape: kind, sessionId, request snapshot
            // (no secrets), and a callable `work` that wraps the actual call.
            const args = mockStartJob.mock.calls[0][0];
            expect(args.kind).toBe('registerForDustGeneration');
            expect(args.sessionId).toBe('s1');
            expect(args.request).toEqual({ sessionId: 's1', dustReceiverAddress: 'mn_addr_x' });
            expect(typeof args.work).toBe('function');

            // Drive `work` directly and confirm it forwards cacheKey +
            // dustReceiverAddress through to the underlying call.
            await args.work();
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
            // Force the session SELECT to throw — this happens before the
            // handler hands off to startJob, so the request rejects directly.
            mockDbRun.mockRejectedValueOnce(new Error('db unreachable'));
            const req = createMockRequest({ sessionId: 's1' });
            await expect(registeredHandlers['registerForDustGeneration'](req)).rejects.toThrow('db unreachable');
        });

        it('rejects 429 when rate-limited', async () => {
            const checkSpy = jest.spyOn(RateLimiter.prototype, 'check').mockReturnValue({ allowed: false, retryAfterMs: 1000 });
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
            await args.work();
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
            jest.spyOn(console, 'log').mockImplementation();
            jest.spyOn(console, 'warn').mockImplementation();
        });

        afterEach(() => {
            jest.restoreAllMocks();
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

            // Drive the captured work fn and confirm it dispatches with the
            // session's derived accountId + caller args.
            const args = mockStartJob.mock.calls[0][0];
            expect(args.kind).toBe('sendNight');
            expect(args.sessionId).toBe('s1');
            expect(args.request).toEqual({
                sessionId: 's1',
                receiverAddress: 'mn_shield-addr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                amount: '1',
                ttlIso: null
            });
            mockSendNight.mockResolvedValueOnce({
                txId: 'tx-send', toLedger: 'shielded', amount: '1', receiverAddress: 'mn_shield-addr_x'
            });
            const workResult = await args.work();
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
    // unshieldFunds / shieldFunds
    // ------------------------------------------------------------------

    describe('swap handlers', () => {
        beforeEach(() => {
            jest.spyOn(console, 'log').mockImplementation();
        });
        afterEach(() => {
            jest.restoreAllMocks();
        });

        it('unshieldFunds returns { jobId, status } and defers the inner call to startJob', async () => {
            mockDbRun.mockResolvedValueOnce(activeSessionRow());
            const req = createMockRequest({ sessionId: 's1', amount: '5' });
            const result = await registeredHandlers['unshieldFunds'](req);

            expect(result).toEqual({ jobId: 'job-unshieldFunds-test', status: 'pending' });
            expect(mockUnshieldFunds).not.toHaveBeenCalled();

            const args = mockStartJob.mock.calls[0][0];
            expect(args.kind).toBe('unshieldFunds');
            mockUnshieldFunds.mockResolvedValueOnce({ txId: 'tx', amount: '5', unshieldedReceiverAddress: 'mn_addr_x' });
            const workResult = await args.work();
            expect(mockUnshieldFunds).toHaveBeenCalledWith(expect.objectContaining({ cacheKey: 'acct-derived', amount: '5' }));
            expect(workResult).toMatchObject({ txId: 'tx', unshieldedReceiverAddress: 'mn_addr_x' });
        });

        it('shieldFunds rejects amount=0', async () => {
            const req = createMockRequest({ sessionId: 's1', amount: '0' });
            await registeredHandlers['shieldFunds'](req);
            expect(req.reject).toHaveBeenCalledWith(400, 'amount must be > 0');
        });

        it('shieldFunds returns { jobId, status } and defers the inner call to startJob', async () => {
            mockDbRun.mockResolvedValueOnce(activeSessionRow());
            const req = createMockRequest({ sessionId: 's1', amount: '5' });
            const result = await registeredHandlers['shieldFunds'](req);

            expect(result).toEqual({ jobId: 'job-shieldFunds-test', status: 'pending' });
            expect(mockShieldFunds).not.toHaveBeenCalled();

            const args = mockStartJob.mock.calls[0][0];
            expect(args.kind).toBe('shieldFunds');
            mockShieldFunds.mockResolvedValueOnce({ txId: 'tx', amount: '5', shieldedReceiverAddress: 'mn_shield-addr_x' });
            const workResult = await args.work();
            expect(mockShieldFunds).toHaveBeenCalledWith(expect.objectContaining({ cacheKey: 'acct-derived', amount: '5' }));
            expect(workResult).toMatchObject({ txId: 'tx', shieldedReceiverAddress: 'mn_shield-addr_x' });
        });
    });

    // ------------------------------------------------------------------
    // getWalletBalance + estimateSendNightFee + estimate(Shield/Unshield)Fee
    // ------------------------------------------------------------------

    describe('diagnostics handlers', () => {
        beforeEach(() => {
            jest.spyOn(console, 'log').mockImplementation();
        });
        afterEach(() => {
            jest.restoreAllMocks();
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

        it('estimateUnshieldFee + estimateShieldFee route through the swap-estimate helper', async () => {
            mockDbRun.mockResolvedValueOnce(activeSessionRow());
            mockEstimateUnshieldFee.mockResolvedValueOnce({ fee: '7', direction: 'unshield' });
            const u = createMockRequest({ sessionId: 's1', amount: '5' });
            expect(await registeredHandlers['estimateUnshieldFee'](u)).toEqual({ fee: '7', direction: 'unshield' });

            mockDbRun.mockResolvedValueOnce(activeSessionRow());
            mockEstimateShieldFee.mockResolvedValueOnce({ fee: '9', direction: 'shield' });
            const s = createMockRequest({ sessionId: 's1', amount: '5' });
            expect(await registeredHandlers['estimateShieldFee'](s)).toEqual({ fee: '9', direction: 'shield' });
        });

        it('swap-estimate helper maps inner errors to 500 with the matching action name', async () => {
            mockDbRun.mockResolvedValueOnce(activeSessionRow());
            mockEstimateShieldFee.mockRejectedValueOnce(new Error('build failed'));
            const req = createMockRequest({ sessionId: 's1', amount: '5' });
            await registeredHandlers['estimateShieldFee'](req);
            expect(req.reject).toHaveBeenCalledWith(500, expect.stringContaining('estimateShieldFee failed'));
        });
    });

    // ------------------------------------------------------------------
    // disconnectWallet pre-eviction flow
    // ------------------------------------------------------------------

    describe('disconnectWallet (facade eviction)', () => {
        beforeEach(() => {
            jest.spyOn(console, 'log').mockImplementation();
        });
        afterEach(() => {
            jest.restoreAllMocks();
        });

        it('evicts the cached facade for the account before deactivating the session', async () => {
            mockDbRun.mockResolvedValueOnce(activeSessionRow());
            mockDbRun.mockResolvedValueOnce(1);

            const req = createMockRequest({ sessionId: 's1' });
            await registeredHandlers['disconnectWallet'](req);

            expect(mockEvictWalletFacade).toHaveBeenCalledWith('acct-derived');
            expect(updateWhereSpy).toHaveBeenCalledWith({ sessionId: 's1' });
        });
    });
});