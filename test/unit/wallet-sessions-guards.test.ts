/**
 * Guard-branch tests for srv/sessions/wallet-sessions.ts.
 *
 * wallet-sessions.test.ts covers the happy paths; this file covers the
 * rejection ladders that were uncovered until the coverage review:
 *   - the deriveWalletInfo HANDLER (rate limit, auth, validation, and the
 *     "error paths never echo the secret" guarantee — the util itself is
 *     covered in wallet-info.test.ts)
 *   - the shared per-action guards on sendNight / unshieldFunds / shieldFunds
 *     (mainnet gate, 401/429, sessionId+amount+ttl validation, session ladder
 *     404/404/412/410, decrypt failure 500)
 *   - the diagnostics handlers' guards + 500 wrapping
 *   - the TTL-cleanup facade-eviction loop (review_001 P2)
 *
 * Same stub-service scaffold as wallet-sessions.test.ts.
 */

const mockDbRun = vi.hoisted(() => (vi.fn()));
const selectWhereSpy = vi.hoisted(() => (vi.fn()));
const selectFromWhereSpy = vi.hoisted(() => (vi.fn()));
const updateWhereSpy = vi.hoisted(() => (vi.fn()));
const logErrorSpy = vi.hoisted(() => (vi.fn()));

vi.mock('@sap/cds', () => {
    const cds: any = {
        env: { requires: { nightgate: {} } },
        ql: {
            SELECT: {
                one: { from: vi.fn().mockReturnValue({ where: selectWhereSpy }) },
                from: vi.fn().mockReturnValue({
                    columns: vi.fn().mockReturnValue({ where: selectFromWhereSpy })
                })
            },
            INSERT: { into: vi.fn().mockReturnValue({ entries: vi.fn() }) },
            UPDATE: {
                entity: vi.fn().mockReturnValue({
                    set: vi.fn().mockReturnValue({ where: updateWhereSpy })
                })
            }
        },
        utils: { uuid: vi.fn(() => 'generated-id') },
        log: vi.fn(() => ({ error: logErrorSpy, warn: vi.fn(), info: vi.fn(), debug: vi.fn() }))
    };
    cds.default = cds;
    return cds;
});

const mockEvictWalletFacade = vi.hoisted(() => (vi.fn()));
const mockGetOrBuildWalletFacade = vi.hoisted(() => (vi.fn()));
const mockDeriveAccountId = vi.hoisted(() => (vi.fn()));
const mockGetWalletBalance = vi.hoisted(() => (vi.fn()));
const mockEstimateSendNightFee = vi.hoisted(() => (vi.fn()));
const mockEstimateUnshieldFee = vi.hoisted(() => (vi.fn()));
const mockEstimateShieldFee = vi.hoisted(() => (vi.fn()));
const mockDeriveWalletInfoUtil = vi.hoisted(() => (vi.fn()));
const mockResolveBip39SeedHex = vi.hoisted(() => (vi.fn()));

vi.mock('../../srv/midnight/wallet-worker-client', () => ({
    walletWaitForSyncedState: vi.fn(async () => ({ synced: true }))
}));
vi.mock('../../srv/submission/wallet-facade-builder', () => ({
    evictWalletFacade: mockEvictWalletFacade,
    getOrBuildWalletFacade: mockGetOrBuildWalletFacade
}));
vi.mock('../../srv/submission/wallet-material-factory', () => ({
    deriveAccountId: mockDeriveAccountId,
    deriveStoragePassword: vi.fn(() => 'storage-pass')
}));
vi.mock('../../srv/submission/dust-registration', () => ({
    registerNightUtxosForDust: vi.fn(),
    deregisterNightUtxosFromDust: vi.fn()
}));
vi.mock('../../srv/submission/token-ops', () => ({
    sendNight: vi.fn(),
    unshieldFunds: vi.fn(),
    shieldFunds: vi.fn(),
    getWalletBalance: mockGetWalletBalance,
    estimateSendNightFee: mockEstimateSendNightFee,
    estimateUnshieldFee: mockEstimateUnshieldFee,
    estimateShieldFee: mockEstimateShieldFee
}));
vi.mock('../../srv/midnight/providers', () => ({
    ensureNetworkId: vi.fn(async () => undefined)
}));
vi.mock('../../srv/submission/background-jobs', () => ({
    startJob: vi.fn(async (args: any) => ({ jobId: `job-${args.kind}`, status: 'pending' }))
}));
vi.mock('../../srv/utils/wallet-info', () => ({
    deriveWalletInfo: mockDeriveWalletInfoUtil,
    resolveBip39SeedHex: mockResolveBip39SeedHex
}));

import cds from '@sap/cds';
import { encrypt, getEncryptionKey } from '../../srv/utils/crypto';
import { RateLimiter } from '../../srv/utils/rate-limiter';
import { registerWalletSessionHandlers, startSessionCleanup } from '../../srv/sessions/wallet-sessions';

const TEST_USER_ID = 'guard-user';
let __ipCounter = 0;
function nextIp(): string {
    __ipCounter += 1;
    return `172.16.${(__ipCounter >> 8) & 0xff}.${__ipCounter & 0xff}`;
}

function makeReq(data: Record<string, unknown>, opts: { user?: any } = {}) {
    const req: any = {
        data,
        user: 'user' in opts ? opts.user : { id: TEST_USER_ID },
        reject: vi.fn((code: number, message: string) => ({ __rejected: true, code, message })),
        _: { req: { ip: nextIp() } }
    };
    return req;
}

/** Signing-capable, unexpired session row (decryptable with the test key). */
function signingSessionRow(overrides: Record<string, any> = {}) {
    const encKey = getEncryptionKey();
    return {
        ID: 'row-1',
        sessionId: 'sess-1',
        isActive: true,
        encryptedViewingKey: encrypt('vk-'.padEnd(64, 'a'), encKey),
        encryptedSeedKey: encrypt('b'.repeat(128), encKey),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        ...overrides
    };
}

const NIGHTGATE_ENV_KEYS = [
    'NIGHTGATE_NETWORK', 'NIGHTGATE_NODE_URL', 'NIGHTGATE_CRAWLER_NODE_URL',
    'NIGHTGATE_CRAWLER_ENABLED', 'NIGHTGATE_INDEXER_HTTP_URL', 'NIGHTGATE_INDEXER_WS_URL',
    'NIGHTGATE_PROOF_SERVER_URL', 'NIGHTGATE_ZK_CONFIG_BASE'
] as const;
const originalEnv = Object.fromEntries(NIGHTGATE_ENV_KEYS.map((k) => [k, process.env[k]]));

describe('wallet session guard branches', () => {
    const handlers: Record<string, Function> = {};
    const srv = {
        on(event: string, h: Function) { handlers[event] = h; }
    } as any;

    afterAll(() => {
        for (const k of NIGHTGATE_ENV_KEYS) {
            const v = (originalEnv as any)[k];
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    });

    beforeEach(() => {
        vi.clearAllMocks();
        for (const k of NIGHTGATE_ENV_KEYS) delete process.env[k];
        (cds.env as any).requires = { nightgate: {} };
        mockDeriveAccountId.mockReturnValue('acct-derived');
        mockDbRun.mockResolvedValue(null);
        Object.keys(handlers).forEach(k => delete handlers[k]);
        registerWalletSessionHandlers(srv, { run: mockDbRun });
    });

    // ------------------------------------------------------------------
    // deriveWalletInfo handler (the util is covered in wallet-info.test.ts)
    // ------------------------------------------------------------------

    describe('deriveWalletInfo handler', () => {
        const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

        beforeEach(() => {
            mockResolveBip39SeedHex.mockReturnValue('c'.repeat(128));
            mockDeriveWalletInfoUtil.mockResolvedValue({ address: 'mn_addr_test', coinPublicKey: 'cpk' });
        });

        it('rejects rate-limited clients with 429', async () => {
            const spy = vi.spyOn(RateLimiter.prototype, 'check')
                .mockReturnValue({ allowed: false, retryAfterMs: 30_000 });
            try {
                const req = makeReq({ mnemonic: MNEMONIC });
                await handlers['deriveWalletInfo'](req);
                expect(req.reject).toHaveBeenCalledWith(429, expect.stringMatching(/Rate limited/));
            } finally {
                spy.mockRestore();
            }
            expect(mockDeriveWalletInfoUtil).not.toHaveBeenCalled();
        });

        it('rejects unauthenticated callers with 401', async () => {
            const req = makeReq({ mnemonic: MNEMONIC }, { user: undefined });
            await handlers['deriveWalletInfo'](req);
            expect(req.reject).toHaveBeenCalledWith(401, 'authentication required');
        });

        it('rejects an invalid wallet secret with the validator message (400)', async () => {
            mockResolveBip39SeedHex.mockImplementation(() => { throw new Error('either mnemonic or seedHex is required'); });
            const req = makeReq({});
            await handlers['deriveWalletInfo'](req);
            expect(req.reject).toHaveBeenCalledWith(400, 'either mnemonic or seedHex is required');
        });

        it.each([[-1], [1.5]])('rejects invalid accountIndex %s with 400', async (accountIndex) => {
            const req = makeReq({ mnemonic: MNEMONIC, accountIndex });
            await handlers['deriveWalletInfo'](req);
            expect(req.reject).toHaveBeenCalledWith(400, 'accountIndex must be a non-negative integer');
        });

        it('derives with the configured network and defaulted accountIndex 0', async () => {
            (cds.env as any).requires = { nightgate: { network: 'preview' } };
            const req = makeReq({ mnemonic: MNEMONIC });
            const result = await handlers['deriveWalletInfo'](req);
            expect(result).toEqual({ address: 'mn_addr_test', coinPublicKey: 'cpk' });
            expect(mockDeriveWalletInfoUtil).toHaveBeenCalledWith({
                mnemonic: MNEMONIC, seedHex: undefined, accountIndex: 0, network: 'preview'
            });
        });

        it('maps a derivation failure to a generic 500 that never echoes the secret', async () => {
            mockDeriveWalletInfoUtil.mockRejectedValue(new Error(`SDK exploded while processing ${MNEMONIC}`));
            const req = makeReq({ mnemonic: MNEMONIC });
            await handlers['deriveWalletInfo'](req);
            expect(req.reject).toHaveBeenCalledWith(500, 'wallet derivation failed');
            const [, rejectMsg] = req.reject.mock.calls[0];
            expect(rejectMsg).not.toContain(MNEMONIC);
        });
    });

    // ------------------------------------------------------------------
    // Token-op rejection ladder (sendNight / unshieldFunds / shieldFunds)
    // ------------------------------------------------------------------

    const OPS: Array<{ op: string; base: Record<string, unknown> }> = [
        { op: 'sendNight', base: { sessionId: 'sess-1', receiverAddress: 'mn_addr_' + 'x'.repeat(60), amount: '1000' } },
        { op: 'unshieldFunds', base: { sessionId: 'sess-1', amount: '1000' } },
        { op: 'shieldFunds', base: { sessionId: 'sess-1', amount: '1000' } }
    ];

    describe.each(OPS)('$op guards', ({ op, base }) => {
        it('is blocked on mainnet by default (403)', async () => {
            (cds.env as any).requires = { nightgate: { network: 'mainnet' } };
            const req = makeReq(base);
            await handlers[op](req);
            expect(req.reject).toHaveBeenCalledWith(403, expect.stringMatching(/mainnet/i));
        });

        it('rejects unauthenticated callers with 401', async () => {
            const req = makeReq(base, { user: undefined });
            await handlers[op](req);
            expect(req.reject).toHaveBeenCalledWith(401, 'authentication required');
        });

        it('rejects rate-limited clients with 429', async () => {
            const spy = vi.spyOn(RateLimiter.prototype, 'check')
                .mockReturnValue({ allowed: false, retryAfterMs: 5000 });
            try {
                const req = makeReq(base);
                await handlers[op](req);
                expect(req.reject).toHaveBeenCalledWith(429, expect.stringMatching(/Rate limited/));
            } finally {
                spy.mockRestore();
            }
        });

        it('rejects a missing sessionId with 400', async () => {
            const req = makeReq({ ...base, sessionId: undefined });
            await handlers[op](req);
            expect(req.reject).toHaveBeenCalledWith(400, 'sessionId is required');
        });

        it('rejects a non-integer amount with 400', async () => {
            const req = makeReq({ ...base, amount: '12.5' });
            await handlers[op](req);
            expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(/decimal integer/));
        });

        it('rejects an invalid ttlIso with 400', async () => {
            const req = makeReq({ ...base, ttlIso: 'not-a-date' });
            await handlers[op](req);
            expect(req.reject).toHaveBeenCalledWith(400, 'ttlIso must be a valid ISO-8601 timestamp');
        });

        it('rejects a past ttlIso with 400', async () => {
            const req = makeReq({ ...base, ttlIso: new Date(Date.now() - 60_000).toISOString() });
            await handlers[op](req);
            expect(req.reject).toHaveBeenCalledWith(400, 'ttlIso must be in the future');
        });

        it('rejects an unknown session with 404', async () => {
            mockDbRun.mockResolvedValue(null);
            const req = makeReq(base);
            await handlers[op](req);
            expect(req.reject).toHaveBeenCalledWith(404, 'Session not found or inactive');
        });

        it('rejects a session without a viewing key with 404', async () => {
            mockDbRun.mockResolvedValue(signingSessionRow({ encryptedViewingKey: null }));
            const req = makeReq(base);
            await handlers[op](req);
            expect(req.reject).toHaveBeenCalledWith(404, 'Session has no viewing key');
        });

        it('rejects a read-only session (no signing key) with 412', async () => {
            mockDbRun.mockResolvedValue(signingSessionRow({ encryptedSeedKey: null }));
            const req = makeReq(base);
            await handlers[op](req);
            expect(req.reject).toHaveBeenCalledWith(412, 'Session has no signing key. Call connectWalletForSigning first.');
        });

        it('rejects an expired session with 410', async () => {
            mockDbRun.mockResolvedValue(signingSessionRow({ expiresAt: new Date(Date.now() - 1000).toISOString() }));
            const req = makeReq(base);
            await handlers[op](req);
            expect(req.reject).toHaveBeenCalledWith(410, 'Session expired');
        });

        it('maps an undecryptable viewing key to 500', async () => {
            mockDbRun.mockResolvedValue(signingSessionRow({ encryptedViewingKey: 'deadbeef' }));
            const req = makeReq(base);
            await handlers[op](req);
            expect(req.reject).toHaveBeenCalledWith(500, 'Failed to decrypt session keys (ENCRYPTION_KEY mismatch?)');
        });
    });

    it('sendNight rejects a receiver address with a foreign prefix (400)', async () => {
        const req = makeReq({ sessionId: 'sess-1', receiverAddress: 'addr_test1qq' + 'x'.repeat(50), amount: '10' });
        await handlers['sendNight'](req);
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(/must start with 'mn_shield-addr_'/));
    });

    it('sendNight rejects a too-short receiver address (400)', async () => {
        const req = makeReq({ sessionId: 'sess-1', receiverAddress: 'mn_addr_short', amount: '10' });
        await handlers['sendNight'](req);
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(/too short/));
    });

    it('sendNight rejects amount 0 and an amount above the sanity bound (400)', async () => {
        const base = { sessionId: 'sess-1', receiverAddress: 'mn_addr_' + 'x'.repeat(60) };
        const zero = makeReq({ ...base, amount: '0' });
        await handlers['sendNight'](zero);
        expect(zero.reject).toHaveBeenCalledWith(400, 'amount must be > 0');

        const huge = makeReq({ ...base, amount: (10n ** 19n).toString() });
        await handlers['sendNight'](huge);
        expect(huge.reject).toHaveBeenCalledWith(400, 'amount exceeds sanity bound of 10^18 atoms');
    });

    // ------------------------------------------------------------------
    // Diagnostics handlers (mainnet-exempt, still session-gated)
    // ------------------------------------------------------------------

    const DIAG: Array<{ op: string; base: Record<string, unknown>; util: () => any }> = [
        { op: 'getWalletBalance', base: { sessionId: 'sess-1' }, util: () => mockGetWalletBalance },
        { op: 'estimateSendNightFee', base: { sessionId: 'sess-1', receiverAddress: 'mn_shield-addr_' + 'x'.repeat(60), amount: '5' }, util: () => mockEstimateSendNightFee },
        { op: 'estimateUnshieldFee', base: { sessionId: 'sess-1', amount: '5' }, util: () => mockEstimateUnshieldFee },
        { op: 'estimateShieldFee', base: { sessionId: 'sess-1', amount: '5' }, util: () => mockEstimateShieldFee }
    ];

    describe.each(DIAG)('$op guards', ({ op, base, util }) => {
        it('rejects unauthenticated callers with 401', async () => {
            const req = makeReq(base, { user: undefined });
            await handlers[op](req);
            expect(req.reject).toHaveBeenCalledWith(401, 'authentication required');
        });

        it('rejects an unknown session with 404', async () => {
            mockDbRun.mockResolvedValue(null);
            const req = makeReq(base);
            await handlers[op](req);
            expect(req.reject).toHaveBeenCalledWith(404, 'Session not found or inactive');
        });

        it('is NOT blocked on mainnet (read-only diagnostics) and wraps util failures in 500', async () => {
            (cds.env as any).requires = { nightgate: { network: 'mainnet' } };
            mockDbRun.mockResolvedValue(signingSessionRow());
            util().mockRejectedValue(new Error('worker offline'));
            const req = makeReq(base);
            await handlers[op](req);
            expect(req.reject).toHaveBeenCalledWith(500, expect.stringMatching(/failed: worker offline/));
        });

        it('returns the util result on the happy path', async () => {
            mockDbRun.mockResolvedValue(signingSessionRow());
            util().mockResolvedValue({ ok: true, marker: op });
            const req = makeReq(base);
            const result = await handlers[op](req);
            expect(result).toEqual({ ok: true, marker: op });
            expect(req.reject).not.toHaveBeenCalled();
        });
    });

    it('estimateSendNightFee rejects a foreign receiver prefix (400)', async () => {
        const req = makeReq({ sessionId: 'sess-1', receiverAddress: '0xabcdef' + 'x'.repeat(50), amount: '5' });
        await handlers['estimateSendNightFee'](req);
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(/must start with 'mn_shield-addr_'/));
    });

    // ------------------------------------------------------------------
    // TTL cleanup: forced expiry must evict cached facades (review_001 P2)
    // ------------------------------------------------------------------

    describe('startSessionCleanup facade eviction', () => {
        it('evicts the cached facade of every decryptable expiring session', async () => {
            vi.useFakeTimers();
            const encKey = getEncryptionKey();
            const db = {
                run: vi.fn()
                    // 1st call: SELECT expiring rows — one decryptable, one
                    // undecryptable (best-effort: must not abort the sweep),
                    // one already-nulled key.
                    .mockResolvedValueOnce([
                        { encryptedViewingKey: encrypt('vk-evict-me'.padEnd(64, 'e'), encKey) },
                        { encryptedViewingKey: 'garbage-not-decryptable' },
                        { encryptedViewingKey: null }
                    ])
                    // 2nd call: UPDATE deactivating them.
                    .mockResolvedValueOnce(3)
            };
            try {
                const timer = startSessionCleanup(db);
                await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
                expect(mockEvictWalletFacade).toHaveBeenCalledTimes(1);
                expect(mockEvictWalletFacade).toHaveBeenCalledWith('acct-derived');
                expect(db.run).toHaveBeenCalledTimes(2);
                clearInterval(timer);
            } finally {
                vi.useRealTimers();
            }
        });
    });
});
