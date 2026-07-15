/**
 * Tests for the connectWalletForSigning action.
 *
 * Drives registerWalletSessionHandlers against a stub service that captures
 * handler registrations. Same pattern as submission-handlers.test.ts.
 *
 * The handler kicks off `getOrBuildWalletFacade(...)` as a fire-and-forget
 * Promise to pre-warm the wallet. We mock that here so the unawaited chain
 * resolves synchronously instead of touching the worker RPC + CAP model load
 * — those held handles open past test completion and triggered "worker
 * failed to exit gracefully" warnings on Jest's worker pool teardown.
 */

vi.mock('../../srv/submission/wallet-facade-builder', () => ({
    getOrBuildWalletFacade: vi.fn(async () => ({ facade: {} })),
    evictWalletFacade: vi.fn(async () => undefined)
}));

vi.mock('../../srv/midnight/providers', () => ({
    ensureNetworkId: vi.fn(async () => undefined)
}));

// startJob is exercised in its own suite; here it's collapsed to a stub that
// returns a predictable jobId so connectWalletForSigning's return-shape
// assertions can be deterministic. The stub also records the work fn so a
// test can drive it explicitly if needed.
const mockStartJob = vi.hoisted(() => (vi.fn(async (args: any) => ({ jobId: 'job-prewarm-test', status: 'pending' as const }))));
vi.mock('../../srv/submission/background-jobs', () => ({
    startJob: (...args: unknown[]) => (mockStartJob as any)(...args)
}));

import { registerWalletSessionHandlers } from '../../srv/sessions/wallet-sessions';
import { encrypt, decrypt, getEncryptionKey } from '../../srv/utils/crypto';

type Handler = (req: any) => Promise<any>;

function makeFakeService() {
    const handlers: Record<string, Handler> = {};
    return {
        handlers,
        on: vi.fn((arg1: any, arg2: any, arg3?: any) => {
            // wallet-sessions.ts calls `srv.on(name, fn)` AND `srv.on(name, entity, fn)`.
            if (typeof arg2 === 'function') handlers[arg1] = arg2;
            else if (typeof arg3 === 'function') handlers[arg1] = arg3;
        })
    };
}

let __ipCounter = 0;
const TEST_USER_ID = 'test-user';

function makeReq(data: Record<string, unknown>, ip?: string) {
    // Each request gets a fresh IP unless one is pinned (for the rate-limit test).
    const clientIp = ip ?? `test-ip-${++__ipCounter}`;
    return {
        data,
        _: { req: { ip: clientIp } },
        // Sessions are user-bound (review_001 P1); handlers read req.user.id.
        user: { id: TEST_USER_ID },
        reject: vi.fn((status: number, message: string) => {
            const err: any = new Error(message);
            err.status = status;
            return err;
        })
    };
}

// In-memory fake DB mirroring the cds.ql shape we use.
function makeFakeDb() {
    const tables: Record<string, any[]> = { 'midnight.WalletSessions': [] };
    return {
        tables,
        run: vi.fn(async (q: any) => {
            const cqn = q.cqn || q;
            if (cqn.SELECT) {
                const entity = cqn.SELECT.from.ref?.[0] || cqn.SELECT.from;
                const rows = tables[entity] || [];
                const where = whereFromCqn(cqn.SELECT.where);
                const filtered = where ? rows.filter(r => matchRow(r, where)) : rows;
                return cqn.SELECT.one ? (filtered[0] ?? null) : filtered;
            }
            if (cqn.INSERT) {
                const entity = cqn.INSERT.into.ref?.[0] || cqn.INSERT.into;
                const entries = Array.isArray(cqn.INSERT.entries) ? cqn.INSERT.entries : [cqn.INSERT.entries];
                (tables[entity] ??= []).push(...entries);
                return entries.length;
            }
            if (cqn.UPDATE) {
                const entity = cqn.UPDATE.entity.ref?.[0] || cqn.UPDATE.entity;
                const rows = tables[entity] || [];
                const where = whereFromCqn(cqn.UPDATE.where);
                for (const r of rows) {
                    if (!where || matchRow(r, where)) Object.assign(r, cqn.UPDATE.data);
                }
                return 1;
            }
            return null;
        })
    };
}

function matchRow(row: any, where: any): boolean {
    return Object.keys(where).every(k => row[k] === where[k]);
}

function whereFromCqn(where: any): any {
    if (!where) return null;
    if (Array.isArray(where)) {
        const out: any = {};
        for (let i = 0; i < where.length; i++) {
            const t = where[i];
            if (t?.ref && where[i + 1] === '=' && where[i + 2]?.val !== undefined) {
                out[t.ref[0]] = where[i + 2].val;
            }
        }
        return out;
    }
    return where;
}

const VALID_SEED = 'a'.repeat(128); // 64-byte BIP39 seed (128 hex chars)

function seedSession(db: ReturnType<typeof makeFakeDb>, overrides: any = {}) {
    db.tables['midnight.WalletSessions'].push({
        ID: 'sess-uuid',
        sessionId: 'sess-1',
        userId: TEST_USER_ID, // must match req.user.id for the user-scoped load
        isActive: true,
        encryptedViewingKey: encrypt('mn_shield-vk_alice', getEncryptionKey()),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        ...overrides
    });
}

describe('connectWalletForSigning: argument validation', () => {
    function setup() {
        const srv = makeFakeService();
        const db = makeFakeDb();
        seedSession(db);
        registerWalletSessionHandlers(srv as any, db);
        return { srv, db };
    }

    test('rejects missing sessionId', async () => {
        const { srv } = setup();
        const req = makeReq({ seedHex: VALID_SEED });
        await srv.handlers['connectWalletForSigning'](req);
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(/sessionId/));
    });

    test('rejects missing seedHex', async () => {
        const { srv } = setup();
        const req = makeReq({ sessionId: 'sess-1' });
        await srv.handlers['connectWalletForSigning'](req);
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(/seedHex/));
    });

    test('rejects non-hex seed', async () => {
        const { srv } = setup();
        const req = makeReq({ sessionId: 'sess-1', seedHex: 'not-hex!' + 'a'.repeat(56) });
        await srv.handlers['connectWalletForSigning'](req);
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(/hex/));
    });

    test('rejects seed of wrong length', async () => {
        const { srv } = setup();
        const req = makeReq({ sessionId: 'sess-1', seedHex: 'ab' });
        await srv.handlers['connectWalletForSigning'](req);
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(/hex/));
    });
});

describe('connectWalletForSigning: state transitions', () => {
    test('encrypts seed, persists encryptedSeedKey, and returns prewarm jobId', async () => {
        const srv = makeFakeService();
        const db = makeFakeDb();
        seedSession(db);
        mockStartJob.mockClear();
        registerWalletSessionHandlers(srv as any, db);

        const req = makeReq({ sessionId: 'sess-1', seedHex: VALID_SEED });
        const result = await srv.handlers['connectWalletForSigning'](req);

        expect(result).toEqual({
            sessionId:      'sess-1',
            signingEnabled: true,
            prewarmJobId:   'job-prewarm-test',
            prewarmStatus:  'pending'
        });
        const row = db.tables['midnight.WalletSessions'][0];
        expect(row.encryptedSeedKey).toBeDefined();
        expect(row.encryptedSeedKey).not.toBe(VALID_SEED); // encrypted, not stored verbatim
        // round-trip:
        expect(decrypt(row.encryptedSeedKey, getEncryptionKey())).toBe(VALID_SEED);

        // The pre-warm job was scheduled with the right kind + a seed-less
        // request snapshot.
        expect(mockStartJob).toHaveBeenCalledTimes(1);
        const startArgs = mockStartJob.mock.calls[0][0];
        expect(startArgs.kind).toBe('connectWalletForSigning');
        expect(startArgs.sessionId).toBe('sess-1');
        expect(startArgs.request).not.toHaveProperty('seedHex');
        expect(typeof startArgs.work).toBe('function');
    });

    test('forwards idempotencyKey to startJob when provided', async () => {
        const srv = makeFakeService();
        const db = makeFakeDb();
        seedSession(db);
        mockStartJob.mockClear();
        registerWalletSessionHandlers(srv as any, db);

        const req = makeReq({ sessionId: 'sess-1', seedHex: VALID_SEED, idempotencyKey: 'idem-pre-1' });
        await srv.handlers['connectWalletForSigning'](req);

        expect(mockStartJob.mock.calls[0][0].idempotencyKey).toBe('idem-pre-1');
    });

    test('non-fatal: returns signingEnabled with null jobId if startJob throws', async () => {
        const srv = makeFakeService();
        const db = makeFakeDb();
        seedSession(db);
        mockStartJob.mockClear();
        mockStartJob.mockRejectedValueOnce(new Error('worker offline'));
        registerWalletSessionHandlers(srv as any, db);

        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const req = makeReq({ sessionId: 'sess-1', seedHex: VALID_SEED });
            const result = await srv.handlers['connectWalletForSigning'](req);
            expect(result).toEqual({
                sessionId:      'sess-1',
                signingEnabled: true,
                prewarmJobId:   null,
                prewarmStatus:  null
            });
        } finally {
            warn.mockRestore();
        }
    });

    test('404 when session is missing', async () => {
        const srv = makeFakeService();
        const db = makeFakeDb(); // no session inserted
        registerWalletSessionHandlers(srv as any, db);

        const req = makeReq({ sessionId: 'missing', seedHex: VALID_SEED });
        await srv.handlers['connectWalletForSigning'](req);
        expect(req.reject).toHaveBeenCalledWith(404, expect.stringMatching(/not found/i));
    });

    test('410 when session is expired', async () => {
        const srv = makeFakeService();
        const db = makeFakeDb();
        seedSession(db, { expiresAt: new Date(Date.now() - 1000).toISOString() });
        registerWalletSessionHandlers(srv as any, db);

        const req = makeReq({ sessionId: 'sess-1', seedHex: VALID_SEED });
        await srv.handlers['connectWalletForSigning'](req);
        expect(req.reject).toHaveBeenCalledWith(410, expect.stringMatching(/expired/i));
    });

    test('404 for a foreign principal — sessions are user-bound (review_001 P1)', async () => {
        const srv = makeFakeService();
        const db = makeFakeDb();
        seedSession(db); // owned by TEST_USER_ID
        registerWalletSessionHandlers(srv as any, db);

        // A different authenticated principal presents the (leaked) sessionId.
        const req: any = makeReq({ sessionId: 'sess-1', seedHex: VALID_SEED });
        req.user = { id: 'attacker' };
        await srv.handlers['connectWalletForSigning'](req);
        // Non-leaking: reads back as not-found rather than acting on it.
        expect(req.reject).toHaveBeenCalledWith(404, expect.stringMatching(/not found/i));
    });

    test('401 for an unauthenticated caller', async () => {
        const srv = makeFakeService();
        const db = makeFakeDb();
        seedSession(db);
        registerWalletSessionHandlers(srv as any, db);

        const req: any = makeReq({ sessionId: 'sess-1', seedHex: VALID_SEED });
        req.user = undefined;
        await srv.handlers['connectWalletForSigning'](req);
        expect(req.reject).toHaveBeenCalledWith(401, expect.stringMatching(/authentication/i));
    });

    test('rate-limited after 10 attempts/hour/ip (default)', async () => {
        const srv = makeFakeService();
        const db = makeFakeDb();
        seedSession(db);
        registerWalletSessionHandlers(srv as any, db);

        // Pin a single IP so the rate limit applies to all eleven requests.
        const PINNED_IP = `rate-test-${Date.now()}`;
        for (let i = 0; i < 10; i++) {
            const req = makeReq({ sessionId: 'sess-1', seedHex: VALID_SEED }, PINNED_IP);
            await srv.handlers['connectWalletForSigning'](req);
            expect(req.reject).not.toHaveBeenCalled();
        }
        const eleventh = makeReq({ sessionId: 'sess-1', seedHex: VALID_SEED }, PINNED_IP);
        await srv.handlers['connectWalletForSigning'](eleventh);
        expect(eleventh.reject).toHaveBeenCalledWith(429, expect.stringMatching(/Rate limited/));
    });
});

describe('disconnectWallet also nukes encryptedSeedKey', () => {
    test('seed key is cleared on explicit disconnect', async () => {
        const srv = makeFakeService();
        const db = makeFakeDb();
        const encSeed = encrypt(VALID_SEED, getEncryptionKey());
        seedSession(db, { encryptedSeedKey: encSeed });
        registerWalletSessionHandlers(srv as any, db);

        const req = makeReq({ sessionId: 'sess-1' });
        await srv.handlers['disconnectWallet'](req);

        const row = db.tables['midnight.WalletSessions'][0];
        expect(row.encryptedSeedKey).toBeNull();
        expect(row.encryptedViewingKey).toBeNull();
        expect(row.isActive).toBe(false);
    });
});
