/**
 * Unit tests for srv/sessions/agent-grants.ts:
 *   - createAgentGrant validation ladder (429/401/400/404) + token shape
 *     (returned once, only the SHA-256 stored)
 *   - revokeAgentGrant owner scoping
 *   - enforceAgentGrant ladder: no-op without header, 401 unknown token,
 *     410 expired, 403 non-allowlisted / session mismatch / sponsor
 *     mismatch, principal override + session/sponsor injection, and the
 *     daily budget (window reset, bounded increment, 429 exhausted).
 *
 * Same stub-service scaffold as wallet-sessions-guards.test.ts.
 */

const mockDbRun = vi.hoisted(() => (vi.fn()));
const selectOneWhereSpy = vi.hoisted(() => (vi.fn()));
const insertEntriesSpy = vi.hoisted(() => (vi.fn()));
const updateSetSpy = vi.hoisted(() => (vi.fn()));
const updateWhereSpy = vi.hoisted(() => (vi.fn()));

vi.mock('@sap/cds', () => {
    const cds: any = {
        env: { requires: { nightgate: {} } },
        ql: {
            SELECT: {
                one: { from: vi.fn().mockReturnValue({ where: selectOneWhereSpy }) },
                from: vi.fn().mockReturnValue({ where: vi.fn() })
            },
            INSERT: { into: vi.fn().mockReturnValue({ entries: insertEntriesSpy }) },
            UPDATE: {
                entity: vi.fn().mockReturnValue({ set: updateSetSpy })
            }
        },
        utils: { uuid: vi.fn(() => 'grant-uuid') },
        log: vi.fn(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }))
    };
    cds.default = cds;
    return cds;
});

vi.mock('../../srv/submission/background-jobs', () => ({
    runWithoutAmbientTx: (fn: () => Promise<unknown>) => fn()
}));

const mockResolveFeeSponsor = vi.hoisted(() => (vi.fn()));
vi.mock('../../srv/submission/fee-sponsor', () => {
    class FeeSponsorError extends Error {
        constructor(public readonly httpStatus: number, message: string) {
            super(message);
            this.name = 'FeeSponsorError';
        }
    }
    // real env-reading behavior for the pool sentinel tests
    const getConfiguredFeeSponsorSessions = () =>
        String(process.env.NIGHTGATE_FEE_SPONSOR_SESSION ?? '').split(',').map(s => s.trim()).filter(Boolean);
    return { resolveFeeSponsor: mockResolveFeeSponsor, FeeSponsorError, getConfiguredFeeSponsorSessions };
});
vi.mock('../../srv/utils/nightgate-config', () => ({
    getNightgatePluginConfig: () => ({})
}));

import { FeeSponsorError } from '../../srv/submission/fee-sponsor';

import {
    registerAgentGrantHandlers,
    enforceAgentGrant,
    hashAgentToken,
    AGENT_ALLOWLISTABLE_ACTIONS
} from '../../srv/sessions/agent-grants';

const TEST_USER_ID = 'operator-1';
let __ipCounter = 0;
function nextIp(): string {
    __ipCounter += 1;
    return `172.17.${(__ipCounter >> 8) & 0xff}.${__ipCounter & 0xff}`;
}

function makeReq(
    data: Record<string, unknown>,
    opts: { user?: any; event?: string; headers?: Record<string, string>; ip?: string } = {}
) {
    const req: any = {
        data,
        event: opts.event ?? 'createAgentGrant',
        user: 'user' in opts ? opts.user : { id: TEST_USER_ID },
        reject: vi.fn((code: number, message: string) => ({ __rejected: true, code, message })),
        _: { req: { ip: opts.ip ?? nextIp(), headers: opts.headers ?? {} } }
    };
    return req;
}

function activeSessionRow(overrides: Record<string, any> = {}) {
    return {
        sessionId: 'sess-1',
        userId: TEST_USER_ID,
        isActive: true,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        ...overrides
    };
}

function grantRow(overrides: Record<string, any> = {}) {
    return {
        ID: 'grant-1',
        userId: TEST_USER_ID,
        sessionId: 'sess-1',
        allowedActions: JSON.stringify(['anchorDocument']),
        maxJobsPerDay: null,
        jobsUsedToday: 0,
        budgetWindow: null,
        sponsorSessionId: null,
        validUntil: null,
        isActive: true,
        ...overrides
    };
}

const TODAY = new Date().toISOString().slice(0, 10);

describe('agent grants', () => {
    const handlers: Record<string, Function> = {};
    const srv = {
        on(event: string, h: Function) { handlers[event] = h; }
    } as any;
    const db = { run: mockDbRun };

    beforeEach(() => {
        vi.clearAllMocks();
        mockDbRun.mockResolvedValue(null);
        updateSetSpy.mockReturnValue({ where: updateWhereSpy });
        updateWhereSpy.mockImplementation((w: any) => ({ __update: w }));
        selectOneWhereSpy.mockImplementation((w: any) => ({ __select: w }));
        insertEntriesSpy.mockImplementation((e: any) => ({ __insert: e }));
        Object.keys(handlers).forEach(k => delete handlers[k]);
        registerAgentGrantHandlers(srv, db);
    });

    // ------------------------------------------------------------------
    // createAgentGrant
    // ------------------------------------------------------------------

    describe('createAgentGrant', () => {
        const VALID = { sessionId: 'sess-1', allowedActions: ['anchorDocument'] };

        it('rejects 401 without an authenticated user', async () => {
            const req = makeReq(VALID, { user: undefined });
            await handlers.createAgentGrant(req);
            expect(req.reject).toHaveBeenCalledWith(401, expect.stringContaining('authentication'));
        });

        it('rejects 400 on an empty allowedActions array', async () => {
            const req = makeReq({ sessionId: 'sess-1', allowedActions: [] });
            await handlers.createAgentGrant(req);
            expect(req.reject).toHaveBeenCalledWith(400, expect.stringContaining('non-empty'));
        });

        it('rejects 400 when allowedActions contains a non-grantable action', async () => {
            const req = makeReq({ sessionId: 'sess-1', allowedActions: ['anchorDocument', 'sendNight'] });
            await handlers.createAgentGrant(req);
            expect(req.reject).toHaveBeenCalledWith(400, expect.stringContaining('sendNight'));
            expect(AGENT_ALLOWLISTABLE_ACTIONS).not.toContain('sendNight');
        });

        it('rejects 400 on a validUntil in the past', async () => {
            const req = makeReq({ ...VALID, validUntil: new Date(Date.now() - 1000).toISOString() });
            await handlers.createAgentGrant(req);
            expect(req.reject).toHaveBeenCalledWith(400, expect.stringContaining('future'));
        });

        it('rejects 404 when the session is not the caller\'s or inactive', async () => {
            mockDbRun.mockResolvedValueOnce(null);
            const req = makeReq(VALID);
            await handlers.createAgentGrant(req);
            expect(req.reject).toHaveBeenCalledWith(404, expect.stringContaining('Session'));
            expect(selectOneWhereSpy).toHaveBeenCalledWith(
                expect.objectContaining({ sessionId: 'sess-1', userId: TEST_USER_ID, isActive: true })
            );
        });

        it('rejects 410 when the session is expired', async () => {
            mockDbRun.mockResolvedValueOnce(activeSessionRow({
                expiresAt: new Date(Date.now() - 1000).toISOString()
            }));
            const req = makeReq(VALID);
            await handlers.createAgentGrant(req);
            expect(req.reject).toHaveBeenCalledWith(410, expect.stringContaining('expired'));
        });

        it('returns the token once and stores only its SHA-256', async () => {
            mockDbRun.mockResolvedValueOnce(activeSessionRow()); // session lookup
            mockDbRun.mockResolvedValueOnce(1);                  // insert
            const req = makeReq({ ...VALID, maxJobsPerDay: 5, agentLabel: 'doc-bot' });
            const result = await handlers.createAgentGrant(req);

            expect(req.reject).not.toHaveBeenCalled();
            expect(result.grantId).toBe('grant-uuid');
            expect(result.token).toMatch(/^ngat_[0-9a-f]{64}$/);
            expect(result.allowedActions).toEqual(['anchorDocument']);

            const inserted = insertEntriesSpy.mock.calls[0][0];
            expect(inserted.tokenHash).toBe(hashAgentToken(result.token));
            expect(inserted).not.toHaveProperty('token');
            expect(inserted.allowedActions).toBe(JSON.stringify(['anchorDocument']));
            expect(inserted.maxJobsPerDay).toBe(5);
            expect(inserted.jobsUsedToday).toBe(0);
            expect(inserted.userId).toBe(TEST_USER_ID);
        });

        it('rejects an unusable sponsor at creation with the resolver status, before any insert', async () => {
            mockDbRun.mockResolvedValueOnce(activeSessionRow()); // main session ok
            mockResolveFeeSponsor.mockRejectedValueOnce(new FeeSponsorError(412,
                'Sponsor session has no signing key. Call connectWalletForSigning for the sponsor session first.'));
            const req = makeReq({ ...VALID, sponsorSessionId: 'sponsor-dead' });
            await handlers.createAgentGrant(req);
            expect(req.reject).toHaveBeenCalledWith(412, expect.stringContaining('sponsorSessionId:'));
            expect(mockResolveFeeSponsor).toHaveBeenCalledWith(
                expect.objectContaining({ sponsorSessionId: 'sponsor-dead', requestingUserId: TEST_USER_ID })
            );
            expect(insertEntriesSpy).not.toHaveBeenCalled();
        });

        it('stores a sponsor that passes the same resolution the write path uses', async () => {
            mockDbRun.mockResolvedValueOnce(activeSessionRow()); // main session ok
            mockResolveFeeSponsor.mockResolvedValueOnce({ sponsorSessionId: 'sponsor-1' });
            mockDbRun.mockResolvedValueOnce(1);                  // insert
            const req = makeReq({ ...VALID, sponsorSessionId: 'sponsor-1' });
            const result = await handlers.createAgentGrant(req);
            expect(req.reject).not.toHaveBeenCalled();
            expect(result.grantId).toBe('grant-uuid');
            expect(insertEntriesSpy.mock.calls[0][0].sponsorSessionId).toBe('sponsor-1');
        });

        it('rate-limits the 11th call from one client with 429', async () => {
            const ip = '10.99.0.1';
            for (let i = 0; i < 10; i++) {
                await handlers.createAgentGrant(makeReq(VALID, { user: undefined, ip }));
            }
            const req = makeReq(VALID, { ip });
            await handlers.createAgentGrant(req);
            expect(req.reject).toHaveBeenCalledWith(429, expect.stringContaining('Rate limited'));
        });
    });

    // ------------------------------------------------------------------
    // revokeAgentGrant
    // ------------------------------------------------------------------

    describe('revokeAgentGrant', () => {
        it('rejects 404 for a foreign or unknown grant', async () => {
            mockDbRun.mockResolvedValueOnce(0);
            const req = makeReq({ grantId: 'grant-1' });
            await handlers.revokeAgentGrant(req);
            expect(req.reject).toHaveBeenCalledWith(404, expect.stringContaining('not found'));
            expect(updateWhereSpy).toHaveBeenCalledWith(
                expect.objectContaining({ ID: 'grant-1', userId: TEST_USER_ID, isActive: true })
            );
        });

        it('deactivates the grant and reports revoked', async () => {
            mockDbRun.mockResolvedValueOnce(1);
            const req = makeReq({ grantId: 'grant-1' });
            const result = await handlers.revokeAgentGrant(req);
            expect(result).toEqual({ revoked: true });
            expect(updateSetSpy).toHaveBeenCalledWith(
                expect.objectContaining({ isActive: false, revokedAt: expect.any(String) })
            );
        });
    });

    // ------------------------------------------------------------------
    // enforceAgentGrant
    // ------------------------------------------------------------------

    describe('enforceAgentGrant', () => {
        const TOKEN = 'ngat_' + 'a'.repeat(64);

        function tokenReq(event: string, data: Record<string, unknown> = {}, token: string = TOKEN) {
            return makeReq(data, {
                event,
                user: { id: 'transport-user' },
                headers: { 'x-agent-token': token }
            });
        }

        it('is a no-op without the token header', async () => {
            const req = makeReq({}, { event: 'anchorDocument', user: { id: 'u' } });
            await enforceAgentGrant(req, db);
            expect(req.reject).not.toHaveBeenCalled();
            expect(req.user).toEqual({ id: 'u' });
            expect(mockDbRun).not.toHaveBeenCalled();
        });

        it('rejects 401 on a token without the expected prefix', async () => {
            const req = tokenReq('anchorDocument', {}, 'not-a-grant-token');
            await enforceAgentGrant(req, db);
            expect(req.reject).toHaveBeenCalledWith(401, expect.stringContaining('invalid'));
            expect(mockDbRun).not.toHaveBeenCalled();
        });

        it('rejects 401 on an unknown token, non-leaking', async () => {
            mockDbRun.mockResolvedValueOnce(null);
            const req = tokenReq('anchorDocument');
            await enforceAgentGrant(req, db);
            expect(req.reject).toHaveBeenCalledWith(401, expect.stringContaining('invalid'));
            expect(selectOneWhereSpy).toHaveBeenCalledWith(
                expect.objectContaining({ tokenHash: hashAgentToken(TOKEN), isActive: true })
            );
        });

        it('rejects 410 on an expired grant', async () => {
            mockDbRun.mockResolvedValueOnce(grantRow({
                validUntil: new Date(Date.now() - 1000).toISOString()
            }));
            const req = tokenReq('anchorDocument');
            await enforceAgentGrant(req, db);
            expect(req.reject).toHaveBeenCalledWith(410, expect.stringContaining('expired'));
        });

        it('rejects 403 for an action outside the allowlist', async () => {
            mockDbRun.mockResolvedValueOnce(grantRow());
            const req = tokenReq('grantDisclosure');
            await enforceAgentGrant(req, db);
            expect(req.reject).toHaveBeenCalledWith(403, expect.stringContaining('grantDisclosure'));
        });

        it('rejects 403 for wallet lifecycle and grant admin regardless of allowlist', async () => {
            for (const event of ['sendNight', 'deployContract', 'connectWallet', 'createAgentGrant']) {
                mockDbRun.mockResolvedValueOnce(grantRow({
                    allowedActions: JSON.stringify([...AGENT_ALLOWLISTABLE_ACTIONS])
                }));
                const req = tokenReq(event);
                await enforceAgentGrant(req, db);
                expect(req.reject).toHaveBeenCalledWith(403, expect.stringContaining(event));
            }
        });

        it('overrides the principal and injects the grant session on an allowlisted action', async () => {
            mockDbRun.mockResolvedValueOnce(grantRow());
            const req = tokenReq('anchorDocument', { sessionId: null });
            await enforceAgentGrant(req, db);
            expect(req.reject).not.toHaveBeenCalled();
            expect(req.user.id).toBe(TEST_USER_ID);
            expect(req.data.sessionId).toBe('sess-1');
            expect(req.agentGrant).toEqual({ ID: 'grant-1', sessionId: 'sess-1', userId: TEST_USER_ID });
        });

        it('rejects 403 on a sessionId that does not match the grant', async () => {
            mockDbRun.mockResolvedValueOnce(grantRow());
            const req = tokenReq('anchorDocument', { sessionId: 'other-session' });
            await enforceAgentGrant(req, db);
            expect(req.reject).toHaveBeenCalledWith(403, expect.stringContaining('sessionId'));
        });

        it('rejects 403 on a session mismatch even for always-allowed getJobStatus', async () => {
            mockDbRun.mockResolvedValueOnce(grantRow());
            const req = tokenReq('getJobStatus', { jobId: 'j-1', sessionId: 'other-session' });
            await enforceAgentGrant(req, db);
            expect(req.reject).toHaveBeenCalledWith(403, expect.stringContaining('sessionId'));
        });

        it('narrows READs of session-scoped entities to the grant, leaves chain entities open', async () => {
            for (const [target, expectedWhere] of [
                ['NightgateService.WalletSessions', { sessionId: 'sess-1' }],
                ['NightgateService.PendingSubmissions', { sessionId: 'sess-1' }],
                ['NightgateService.AgentGrants', { ID: 'grant-1' }]
            ] as const) {
                mockDbRun.mockResolvedValueOnce(grantRow());
                const whereSpy = vi.fn();
                const req = tokenReq('READ');
                req.target = { name: target };
                req.query = { where: whereSpy };
                await enforceAgentGrant(req, db);
                expect(req.reject).not.toHaveBeenCalled();
                expect(whereSpy).toHaveBeenCalledWith(expectedWhere);
            }

            mockDbRun.mockResolvedValueOnce(grantRow());
            const openSpy = vi.fn();
            const open = tokenReq('READ');
            open.target = { name: 'NightgateService.Blocks' };
            open.query = { where: openSpy };
            await enforceAgentGrant(open, db);
            expect(open.reject).not.toHaveBeenCalled();
            expect(openSpy).not.toHaveBeenCalled();
        });

        it('allows the verify surface without an allowlist entry and without budget', async () => {
            mockDbRun.mockResolvedValueOnce(grantRow({
                allowedActions: JSON.stringify([]), maxJobsPerDay: 1, jobsUsedToday: 1, budgetWindow: TODAY
            }));
            const req = tokenReq('verifyAttestationState', { payloadHash: 'f'.repeat(64) });
            await enforceAgentGrant(req, db);
            expect(req.reject).not.toHaveBeenCalled();
            expect(mockDbRun).toHaveBeenCalledTimes(1); // grant lookup only, no budget UPDATE
        });

        it('a grant may pin the platform-pool sentinel; requires a configured pool', async () => {
            const PLATFORM_POOL_SENTINEL = '00000000-0000-0000-0000-706f6f6c0000';
            // without a pool: 412 at creation (after the session-ownership check)
            delete process.env.NIGHTGATE_FEE_SPONSOR_SESSION;
            mockDbRun.mockResolvedValueOnce({ sessionId: 'sess-1', isActive: true, expiresAt: null });
            const req = makeReq({
                sessionId: 'sess-1', allowedActions: ['sponsorFinalizedTransaction'],
                sponsorSessionId: PLATFORM_POOL_SENTINEL
            });
            await handlers.createAgentGrant(req);
            expect(req.reject).toHaveBeenCalledWith(412, expect.stringMatching(/pool/));

            // with a pool but EXTRA actions: 400 (only sponsorFinalizedTransaction
            // understands the sentinel; anything else would burn budget and fail)
            process.env.NIGHTGATE_FEE_SPONSOR_SESSION = 'pool-1,pool-2';
            mockDbRun.mockResolvedValueOnce({ sessionId: 'sess-1', isActive: true, expiresAt: null });
            const mixed = makeReq({
                sessionId: 'sess-1',
                allowedActions: ['sponsorFinalizedTransaction', 'anchorDocument'],
                sponsorSessionId: PLATFORM_POOL_SENTINEL
            });
            await handlers.createAgentGrant(mixed);
            expect(mixed.reject).toHaveBeenCalledWith(400, expect.stringMatching(/anchorDocument/));

            // both phase-2 sponsoring actions understand the sentinel: accepted together
            mockDbRun.mockResolvedValueOnce({ sessionId: 'sess-1', isActive: true, expiresAt: null });
            const both = makeReq({
                sessionId: 'sess-1',
                allowedActions: ['sponsorFinalizedTransaction', 'sponsorUnboundTransaction'],
                sponsorSessionId: PLATFORM_POOL_SENTINEL
            });
            await handlers.createAgentGrant(both);
            expect(both.reject).not.toHaveBeenCalled();
            delete process.env.NIGHTGATE_FEE_SPONSOR_SESSION;

            // with a pool: getJobStatus may poll under ANY pool member
            process.env.NIGHTGATE_FEE_SPONSOR_SESSION = 'pool-1,pool-2';
            try {
                mockDbRun.mockResolvedValueOnce(grantRow({ sponsorSessionId: PLATFORM_POOL_SENTINEL }));
                const poll = tokenReq('getJobStatus', { jobId: 'j1', sessionId: 'pool-2' });
                await enforceAgentGrant(poll, db);
                expect(poll.reject).not.toHaveBeenCalled();
                // NORMALIZED: pool jobs are keyed under the sentinel, a
                // concrete member id would pass the gate and then 404
                expect(poll.data.sessionId).toBe(PLATFORM_POOL_SENTINEL);

                // and the sentinel itself polls too
                mockDbRun.mockResolvedValueOnce(grantRow({ sponsorSessionId: PLATFORM_POOL_SENTINEL }));
                const direct = tokenReq('getJobStatus', { jobId: 'j1', sessionId: PLATFORM_POOL_SENTINEL });
                await enforceAgentGrant(direct, db);
                expect(direct.reject).not.toHaveBeenCalled();

                mockDbRun.mockResolvedValueOnce(grantRow({ sponsorSessionId: PLATFORM_POOL_SENTINEL }));
                const foreign = tokenReq('getJobStatus', { jobId: 'j1', sessionId: 'not-in-pool' });
                await enforceAgentGrant(foreign, db);
                expect(foreign.reject).toHaveBeenCalledWith(403, expect.stringContaining('sessionId'));
            } finally {
                delete process.env.NIGHTGATE_FEE_SPONSOR_SESSION;
            }
        });

        it('sponsorFinalizedTransaction is grantable; the compute-only reads are free', async () => {
            expect(AGENT_ALLOWLISTABLE_ACTIONS).toContain('sponsorFinalizedTransaction');
            // 0.18: the parallel channel has the same trust shape and is grantable too.
            expect(AGENT_ALLOWLISTABLE_ACTIONS).toContain('sponsorUnboundTransaction');
            // still never grantable: the actions that could move funds or act
            // as the session in any other way
            expect(AGENT_ALLOWLISTABLE_ACTIONS).not.toContain('buildSponsorable');
            expect(AGENT_ALLOWLISTABLE_ACTIONS).not.toContain('mintShieldedTestToken');

            mockDbRun.mockResolvedValueOnce(grantRow({
                allowedActions: JSON.stringify(['sponsorFinalizedTransaction']),
                sponsorSessionId: 'sponsor-1'
            }));
            const req = tokenReq('sponsorFinalizedTransaction', { finalizedTxB64: 'AAAA' });
            await enforceAgentGrant(req, db);
            expect(req.reject).not.toHaveBeenCalled();
            // sponsor injected from the grant, so the agent can only spend
            // THIS sponsor's dust
            expect(req.data.sponsorSessionId).toBe('sponsor-1');

            for (const event of ['deriveTokenType', 'prepareMembershipSet']) {
                mockDbRun.mockResolvedValueOnce(grantRow({ allowedActions: JSON.stringify([]) }));
                const free = tokenReq(event, { contractAddress: 'c'.repeat(64) });
                await enforceAgentGrant(free, db);
                expect(free.reject).not.toHaveBeenCalled();
            }
        });

        it('getJobStatus may poll under the grant sponsor session, writes may NOT run as it', async () => {
            // phase-2 jobs are keyed by the SPONSOR session; polling them must work
            mockDbRun.mockResolvedValueOnce(grantRow({ sponsorSessionId: 'sponsor-1' }));
            const poll = tokenReq('getJobStatus', { jobId: 'j1', sessionId: 'sponsor-1' });
            await enforceAgentGrant(poll, db);
            expect(poll.reject).not.toHaveBeenCalled();
            expect(poll.data.sessionId).toBe('sponsor-1'); // NOT overwritten

            // but a foreign session still rejects
            mockDbRun.mockResolvedValueOnce(grantRow({ sponsorSessionId: 'sponsor-1' }));
            const foreign = tokenReq('getJobStatus', { jobId: 'j1', sessionId: 'someone-else' });
            await enforceAgentGrant(foreign, db);
            expect(foreign.reject).toHaveBeenCalledWith(403, expect.stringContaining('sessionId'));

            // and a WRITE naming the sponsor session as sessionId still rejects:
            // it would act under the sponsor's identity
            mockDbRun.mockResolvedValueOnce(grantRow({ sponsorSessionId: 'sponsor-1' }));
            const write = tokenReq('anchorDocument', { sha256: 'a'.repeat(64), sessionId: 'sponsor-1' });
            await enforceAgentGrant(write, db);
            expect(write.reject).toHaveBeenCalledWith(403, expect.stringContaining('sessionId'));

            // without a pinned sponsor there is no sponsor-poll exception
            mockDbRun.mockResolvedValueOnce(grantRow({ sponsorSessionId: null }));
            const nopin = tokenReq('getJobStatus', { jobId: 'j1', sessionId: 'sponsor-1' });
            await enforceAgentGrant(nopin, db);
            expect(nopin.reject).toHaveBeenCalledWith(403, expect.stringContaining('sessionId'));
        });

        it('pins the sponsor: mismatch rejects 403, absence injects it', async () => {
            mockDbRun.mockResolvedValueOnce(grantRow({ sponsorSessionId: 'sponsor-1' }));
            const bad = tokenReq('anchorDocument', { sponsorSessionId: 'other-sponsor' });
            await enforceAgentGrant(bad, db);
            expect(bad.reject).toHaveBeenCalledWith(403, expect.stringContaining('sponsorSessionId'));

            mockDbRun.mockResolvedValueOnce(grantRow({ sponsorSessionId: 'sponsor-1' }));
            const good = tokenReq('anchorDocument', {});
            await enforceAgentGrant(good, db);
            expect(good.reject).not.toHaveBeenCalled();
            expect(good.data.sponsorSessionId).toBe('sponsor-1');
        });

        it('consumes budget via window reset on the first job of the day', async () => {
            mockDbRun.mockResolvedValueOnce(grantRow({ maxJobsPerDay: 2, budgetWindow: null }));
            mockDbRun.mockResolvedValueOnce(1); // reset UPDATE wins
            const req = tokenReq('anchorDocument', {});
            await enforceAgentGrant(req, db);
            expect(req.reject).not.toHaveBeenCalled();
            expect(updateSetSpy).toHaveBeenCalledWith(
                expect.objectContaining({ budgetWindow: TODAY, jobsUsedToday: 1 })
            );
        });

        it('falls back to the bounded increment when losing the reset race', async () => {
            mockDbRun.mockResolvedValueOnce(grantRow({ maxJobsPerDay: 2, budgetWindow: 'stale' }));
            mockDbRun.mockResolvedValueOnce(0); // reset lost
            mockDbRun.mockResolvedValueOnce(1); // increment wins
            const req = tokenReq('anchorDocument', {});
            await enforceAgentGrant(req, db);
            expect(req.reject).not.toHaveBeenCalled();
            expect(updateWhereSpy).toHaveBeenLastCalledWith(
                expect.objectContaining({ ID: 'grant-1', budgetWindow: TODAY, jobsUsedToday: { '<': 2 } })
            );
        });

        it('rejects 429 when the daily budget is exhausted', async () => {
            mockDbRun.mockResolvedValueOnce(grantRow({ maxJobsPerDay: 2, jobsUsedToday: 2, budgetWindow: TODAY }));
            mockDbRun.mockResolvedValueOnce(0); // bounded increment finds no headroom
            const req = tokenReq('anchorDocument', {});
            await enforceAgentGrant(req, db);
            expect(req.reject).toHaveBeenCalledWith(429, expect.stringContaining('budget'));
        });
    });
});
