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
// SELECT.from(...).columns(...).where(...).and(...): one chainable object.
const selectFromChain = vi.hoisted(() => {
    const chain: any = {};
    chain.columns = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    chain.and = vi.fn(() => chain);
    return chain;
});
const crawlerState = vi.hoisted(() => ({ enabled: false }));
const insertEntriesSpy = vi.hoisted(() => (vi.fn()));
const updateSetSpy = vi.hoisted(() => (vi.fn()));
const updateWhereSpy = vi.hoisted(() => (vi.fn()));

vi.mock('@sap/cds', () => {
    const cds: any = {
        env: { requires: { nightgate: {} } },
        ql: {
            SELECT: {
                one: { from: vi.fn().mockReturnValue({ where: selectOneWhereSpy }) },
                from: vi.fn().mockReturnValue(selectFromChain)
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
    getNightgatePluginConfig: () => ({}),
    resolveNightgateRuntimeConfig: () => ({ crawlerConfig: { enabled: crawlerState.enabled } })
}));

import { FeeSponsorError } from '../../srv/submission/fee-sponsor';

import { __resetGrantRateLimiterForTests, currentGrantPolicy,
    registerAgentGrantHandlers,
    enforceAgentGrant,
    grantScopeViolation,
    grantJobScopeViolation,
    circuitsOfRequest,
    hashAgentToken,
    recordDeployedContracts,
    reserveDeployBudget,
    releaseDeployBudget,
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
        __resetGrantRateLimiterForTests();
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

        it('rate-limits the 11th call of one principal with 429; another principal is unaffected', async () => {
            for (let i = 0; i < 10; i++) {
                await handlers.createAgentGrant(makeReq(VALID, { user: { id: 'rl-user' } }));
            }
            const req = makeReq(VALID, { user: { id: 'rl-user' } });
            await handlers.createAgentGrant(req);
            expect(req.reject).toHaveBeenCalledWith(429, expect.stringContaining('Rate limited'));
            const other = makeReq(VALID, { user: { id: 'rl-other' } });
            await handlers.createAgentGrant(other);
            expect(other.reject).not.toHaveBeenCalledWith(429, expect.anything());
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

    // ------------------------------------------------------------------
    // policy follows the grant
    // ------------------------------------------------------------------

    describe('updateAgentGrant', () => {
        function existing(overrides: Record<string, any> = {}) {
            return grantRow({ maxJobsPerDay: 5, allowDeploy: false, maxDeploys: null, deploysUsed: 0,
                allowedContracts: null, allowedCircuits: null, allowedTokenTypes: null, agentLabel: 'bot', ...overrides });
        }
        const call = (data: Record<string, unknown>, opts: Record<string, unknown> = {}) =>
            handlers.updateAgentGrant(makeReq(data, { event: 'updateAgentGrant', ...opts }));

        it('changes only the passed fields; an explicit null clears', async () => {
            mockDbRun.mockResolvedValueOnce(existing()); // own grant
            mockDbRun.mockResolvedValueOnce(1);          // conditional UPDATE
            const req = makeReq({ grantId: 'grant-1', maxJobsPerDay: 20, validUntil: null }, { event: 'updateAgentGrant' });
            const result = await handlers.updateAgentGrant(req);
            expect(req.reject).not.toHaveBeenCalled();
            const patch = updateSetSpy.mock.calls[0][0];
            expect(patch).toMatchObject({ maxJobsPerDay: 20, validUntil: null, allowDeploy: false, maxDeploys: null });
            expect(patch).not.toHaveProperty('allowedActions');
            expect(patch).not.toHaveProperty('agentLabel');
            expect(updateWhereSpy).toHaveBeenCalledWith({ ID: 'grant-1', userId: TEST_USER_ID, isActive: true });
            expect(result).toEqual({ grantId: 'grant-1', updated: ['maxJobsPerDay', 'validUntil'] });
        });

        it('refuses the immutable bindings with 400 before reading anything', async () => {
            const req = makeReq({ grantId: 'grant-1', sessionId: 'other' }, { event: 'updateAgentGrant' });
            await handlers.updateAgentGrant(req);
            expect(req.reject).toHaveBeenCalledWith(400, expect.stringContaining('sessionId'));
            expect(mockDbRun).not.toHaveBeenCalled();
        });

        it('a foreign or unknown grant is 404, a revoked one 409 GRANT_REVOKED', async () => {
            mockDbRun.mockResolvedValueOnce(null);
            const missing = makeReq({ grantId: 'grant-x', maxJobsPerDay: 1 }, { event: 'updateAgentGrant' });
            await handlers.updateAgentGrant(missing);
            expect(missing.reject).toHaveBeenCalledWith(404, expect.stringContaining('Grant'));
            expect(selectOneWhereSpy).toHaveBeenCalledWith({ ID: 'grant-x', userId: TEST_USER_ID });

            mockDbRun.mockResolvedValueOnce(existing({ isActive: false }));
            const revoked = makeReq({ grantId: 'grant-1', maxJobsPerDay: 1 }, { event: 'updateAgentGrant' });
            await handlers.updateAgentGrant(revoked);
            expect(revoked.reject).toHaveBeenCalledWith(expect.objectContaining({ status: 409, code: 'GRANT_REVOKED' }));
        });

        it('a revoke that lands between the read and the write wins (409, nothing resurrected)', async () => {
            mockDbRun.mockResolvedValueOnce(existing());
            mockDbRun.mockResolvedValueOnce(0);
            const req = makeReq({ grantId: 'grant-1', maxJobsPerDay: 1 }, { event: 'updateAgentGrant' });
            await handlers.updateAgentGrant(req);
            expect(req.reject).toHaveBeenCalledWith(expect.objectContaining({ status: 409, code: 'GRANT_REVOKED' }));
        });

        it('validates like creation: deploy budget below the used count, a past validUntil, a non-grantable action', async () => {
            mockDbRun.mockResolvedValueOnce(existing({
                allowedActions: JSON.stringify(['sponsorUnboundTransaction']), allowDeploy: true, maxDeploys: 5, deploysUsed: 3
            }));
            const budget = makeReq({ grantId: 'grant-1', maxDeploys: 2 }, { event: 'updateAgentGrant' });
            await handlers.updateAgentGrant(budget);
            expect(budget.reject).toHaveBeenCalledWith(400, expect.stringContaining('below the 3 deploys'));

            mockDbRun.mockResolvedValueOnce(existing());
            const past = makeReq({ grantId: 'grant-1', validUntil: new Date(Date.now() - 1000).toISOString() }, { event: 'updateAgentGrant' });
            await handlers.updateAgentGrant(past);
            expect(past.reject).toHaveBeenCalledWith(400, expect.stringContaining('future'));

            mockDbRun.mockResolvedValueOnce(existing());
            const bad = makeReq({ grantId: 'grant-1', allowedActions: ['sendNight'] }, { event: 'updateAgentGrant' });
            await handlers.updateAgentGrant(bad);
            expect(bad.reject).toHaveBeenCalledWith(400, expect.stringContaining('sendNight'));

            // the deploy right needs a sponsoring action in the EFFECTIVE list
            mockDbRun.mockResolvedValueOnce(existing());
            const deploy = makeReq({ grantId: 'grant-1', allowDeploy: true }, { event: 'updateAgentGrant' });
            await handlers.updateAgentGrant(deploy);
            expect(deploy.reject).toHaveBeenCalledWith(400, expect.stringContaining('allowDeploy needs'));
            expect(updateSetSpy).not.toHaveBeenCalled();
        });

        it('lists and the deploy right patch as JSON like creation', async () => {
            mockDbRun.mockResolvedValueOnce(existing({ allowedActions: JSON.stringify(['sponsorUnboundTransaction']) }));
            mockDbRun.mockResolvedValueOnce(1);
            const req = makeReq({ grantId: 'grant-1', allowedContracts: ['ab'.repeat(32)], allowDeploy: true, maxDeploys: 3 }, { event: 'updateAgentGrant' });
            await handlers.updateAgentGrant(req);
            expect(req.reject).not.toHaveBeenCalled();
            expect(updateSetSpy.mock.calls[0][0]).toMatchObject({
                allowedContracts: JSON.stringify(['ab'.repeat(32)]), allowDeploy: true, maxDeploys: 3
            });
        });

        it('shares the grant-admin rate limit: the 11th administration call of one principal is 429', async () => {
            for (let i = 0; i < 10; i++) await call({ grantId: 'grant-1', maxJobsPerDay: 1 }, { ip: '10.9.9.9' });
            const req = makeReq({ grantId: 'grant-1' }, { event: 'rotateAgentGrantToken', ip: '10.9.9.9' });
            await handlers.rotateAgentGrantToken(req);
            expect(req.reject).toHaveBeenCalledWith(429, expect.stringContaining('Rate limited'));
        });
    });

    describe('rotateAgentGrantToken', () => {
        it('replaces the hash in one conditional UPDATE and returns the new token once', async () => {
            mockDbRun.mockResolvedValueOnce(1);
            const req = makeReq({ grantId: 'grant-1' }, { event: 'rotateAgentGrantToken' });
            const result = await handlers.rotateAgentGrantToken(req);
            expect(req.reject).not.toHaveBeenCalled();
            expect(result.grantId).toBe('grant-1');
            expect(result.token).toMatch(/^ngat_[0-9a-f]{64}$/);
            expect(updateSetSpy).toHaveBeenCalledWith({ tokenHash: hashAgentToken(result.token) });
            expect(updateWhereSpy).toHaveBeenCalledWith({ ID: 'grant-1', userId: TEST_USER_ID, isActive: true });
            // nothing else on the row is touched
            expect(Object.keys(updateSetSpy.mock.calls[0][0])).toEqual(['tokenHash']);
        });

        it('a foreign, unknown or revoked grant is 404', async () => {
            mockDbRun.mockResolvedValueOnce(0);
            const req = makeReq({ grantId: 'grant-9' }, { event: 'rotateAgentGrantToken' });
            await handlers.rotateAgentGrantToken(req);
            expect(req.reject).toHaveBeenCalledWith(404, expect.stringContaining('Grant'));
        });
    });

    describe('getGrantUsage', () => {
        const usageRows = [
            { kind: 'anchorDocument', status: 'succeeded', chainStatus: 'success', txHash: 'AA' },
            { kind: 'anchorDocument', status: 'succeeded', chainStatus: 'success', txHash: 'bb' },
            { kind: 'anchorDocument', status: 'failed', chainStatus: null, txHash: null },
            { kind: 'sponsorUnboundTransaction', status: 'succeeded', chainStatus: 'failure', txHash: 'cc' }
        ];

        beforeEach(() => { crawlerState.enabled = false; });

        it('groups the window by kind and status, counts landed and failed, defaults to the last 30 days', async () => {
            mockDbRun.mockResolvedValueOnce(grantRow({ maxJobsPerDay: 10, jobsUsedToday: 4, budgetWindow: TODAY, deploysUsed: 1, maxDeploys: 2 }));
            mockDbRun.mockResolvedValueOnce(usageRows);
            const req = makeReq({ grantId: 'grant-1' }, { event: 'getGrantUsage' });
            const before = Date.now();
            const result = await handlers.getGrantUsage(req);
            expect(req.reject).not.toHaveBeenCalled();
            expect(result).toMatchObject({
                grantId: 'grant-1', landed: 2, failed: 2, deploysUsed: 1, maxDeploys: 2, jobsUsedToday: 4, maxJobsPerDay: 10, dustPaid: null,
                jobs: [
                    { kind: 'anchorDocument', status: 'failed', count: 1 },
                    { kind: 'anchorDocument', status: 'succeeded', count: 2 },
                    { kind: 'sponsorUnboundTransaction', status: 'succeeded', count: 1 }
                ]
            });
            const span = new Date(result.until).getTime() - new Date(result.since).getTime();
            expect(span).toBe(30 * 24 * 3600 * 1000);
            expect(new Date(result.until).getTime()).toBeGreaterThanOrEqual(before);
            expect(selectOneWhereSpy).toHaveBeenCalledWith({ ID: 'grant-1', userId: TEST_USER_ID });
            expect(selectFromChain.where).toHaveBeenCalledWith({ grantId: 'grant-1', queuedAt: { '>=': result.since } });
            expect(selectFromChain.and).toHaveBeenCalledWith({ queuedAt: { '<=': result.until } });
        });

        it("today's budget counts only inside the current window", async () => {
            mockDbRun.mockResolvedValueOnce(grantRow({ maxJobsPerDay: 10, jobsUsedToday: 4, budgetWindow: '2020-01-01' }));
            mockDbRun.mockResolvedValueOnce([]);
            const result = await handlers.getGrantUsage(makeReq({ grantId: 'grant-1' }, { event: 'getGrantUsage' }));
            expect(result.jobsUsedToday).toBe(0);
        });

        it('sums the indexed fees of the landed transactions when the crawler runs', async () => {
            crawlerState.enabled = true;
            mockDbRun.mockResolvedValueOnce(grantRow());
            mockDbRun.mockResolvedValueOnce(usageRows);
            mockDbRun.mockResolvedValueOnce([{ ID: 'tx-1' }, { ID: 'tx-2' }]);      // Transactions by hash
            mockDbRun.mockResolvedValueOnce([{ paidFees: '100' }, { paidFees: 50 }]); // their fee rows
            const result = await handlers.getGrantUsage(makeReq({ grantId: 'grant-1' }, { event: 'getGrantUsage' }));
            expect(result.dustPaid).toBe('150');
            expect(selectFromChain.where).toHaveBeenCalledWith({ hash: { in: ['aa', 'bb'] } });
            expect(selectFromChain.where).toHaveBeenCalledWith({ transaction_ID: { in: ['tx-1', 'tx-2'] } });
        });

        it('bounds the window: at most 366 days, since before until, valid timestamps', async () => {
            const now = Date.now();
            const wide = makeReq({ grantId: 'grant-1', since: new Date(now - 400 * 86400_000).toISOString() }, { event: 'getGrantUsage' });
            await handlers.getGrantUsage(wide);
            expect(wide.reject).toHaveBeenCalledWith(400, expect.stringContaining('366'));
            const flipped = makeReq({ grantId: 'grant-1', since: new Date(now + 1000).toISOString(), until: new Date(now).toISOString() }, { event: 'getGrantUsage' });
            await handlers.getGrantUsage(flipped);
            expect(flipped.reject).toHaveBeenCalledWith(400, expect.stringContaining('since must not lie after'));
            const bad = makeReq({ grantId: 'grant-1', until: 'yesterday' }, { event: 'getGrantUsage' });
            await handlers.getGrantUsage(bad);
            expect(bad.reject).toHaveBeenCalledWith(400, expect.stringContaining('until'));
            expect(mockDbRun).not.toHaveBeenCalled();
        });

        it('a foreign grant is 404; a revoked own grant keeps its history', async () => {
            mockDbRun.mockResolvedValueOnce(null);
            const foreign = makeReq({ grantId: 'grant-x' }, { event: 'getGrantUsage' });
            await handlers.getGrantUsage(foreign);
            expect(foreign.reject).toHaveBeenCalledWith(404, expect.stringContaining('Grant'));

            mockDbRun.mockResolvedValueOnce(grantRow({ isActive: false }));
            mockDbRun.mockResolvedValueOnce([]);
            const revoked = makeReq({ grantId: 'grant-1' }, { event: 'getGrantUsage' });
            const result = await handlers.getGrantUsage(revoked);
            expect(revoked.reject).not.toHaveBeenCalled();
            expect(result.landed).toBe(0);
        });
    });

    describe('per-grant sponsor allow-list', () => {
        const VALID = { sessionId: 'sess-1', allowedActions: ['sponsorFinalizedTransaction'] };

        it('persists allowedContracts/allowedCircuits as JSON and returns them', async () => {
            mockDbRun.mockResolvedValueOnce(activeSessionRow());
            const req = makeReq({ ...VALID, allowedContracts: [' 0xVAULT ', '0xVAULT'], allowedCircuits: ['attest'] });
            const result = await handlers.createAgentGrant(req);
            expect(req.reject).not.toHaveBeenCalled();
            expect(insertEntriesSpy).toHaveBeenCalledWith(expect.objectContaining({
                allowedContracts: JSON.stringify(['0xVAULT']),
                allowedCircuits: JSON.stringify(['attest'])
            }));
            expect(result).toMatchObject({ allowedContracts: ['0xVAULT'], allowedCircuits: ['attest'] });
        });

        it('persists allowedTokenTypes (raw 64-hex, normalized) and refuses anything else', async () => {
            const T = 'ab'.repeat(32);
            mockDbRun.mockResolvedValueOnce(activeSessionRow());
            const req = makeReq({ ...VALID, allowedTokenTypes: ['0x' + T.toUpperCase(), T] });
            const result = await handlers.createAgentGrant(req);
            expect(req.reject).not.toHaveBeenCalled();
            expect(insertEntriesSpy).toHaveBeenCalledWith(expect.objectContaining({ allowedTokenTypes: JSON.stringify([T]) }));
            expect(result).toMatchObject({ allowedTokenTypes: [T] });

            mockDbRun.mockResolvedValueOnce(activeSessionRow());
            const bad = makeReq({ ...VALID, allowedTokenTypes: ['wzec'] });
            await handlers.createAgentGrant(bad);
            expect(bad.reject).toHaveBeenCalledWith(400, expect.stringMatching(/allowedTokenTypes.*not a raw token type/));
        });

        it('absent lists are stored as null (inherit the platform floor) and returned empty', async () => {
            mockDbRun.mockResolvedValueOnce(activeSessionRow());
            const req = makeReq(VALID);
            const result = await handlers.createAgentGrant(req);
            expect(insertEntriesSpy).toHaveBeenCalledWith(expect.objectContaining({ allowedContracts: null, allowedCircuits: null, allowedTokenTypes: null }));
            expect(result).toMatchObject({ allowedContracts: [], allowedCircuits: [], allowedTokenTypes: [] });
        });

        it('rejects 400 on an entry that cannot be an address or circuit', async () => {
            const req = makeReq({ ...VALID, allowedContracts: ['0xVAULT,0xOTHER'] });
            await handlers.createAgentGrant(req);
            expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(/allowedContracts.*not a contract address/));
            expect(insertEntriesSpy).not.toHaveBeenCalled();
        });

        it('the enforcement hook attaches the parsed lists to req.agentGrant', async () => {
            const TOKEN = 'ngat_' + 'b'.repeat(64);
            mockDbRun.mockResolvedValueOnce(grantRow({
                allowedActions: JSON.stringify(['sponsorFinalizedTransaction']),
                allowedContracts: JSON.stringify(['0xVAULT']),
                allowedCircuits: null
            }));
            const req = makeReq({ sponsorSessionId: undefined }, {
                event: 'sponsorFinalizedTransaction', user: { id: 'transport-user' }, headers: { 'x-agent-token': TOKEN }
            });
            await enforceAgentGrant(req, db);
            expect(req.reject).not.toHaveBeenCalled();
            expect(req.agentGrant).toMatchObject({ ID: 'grant-1', allowedContracts: ['0xVAULT'], allowedCircuits: [], allowedTokenTypes: [] });
        });
    });

    // A sponsored deploy is a distinct grant right with its own budget.
    describe('allowDeploy (sponsored deploys)', () => {
        it('needs a sponsor* action: a deploy is sponsored, never run by the server wallet', async () => {
            const req = makeReq({ sessionId: 'sess-1', allowedActions: ['anchorDocument'], allowDeploy: true });
            await handlers.createAgentGrant(req);
            expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(/allowDeploy needs 'sponsorFinalizedTransaction'/));
        });

        it('defaults the deploy budget to 1, validates an explicit one, and refuses a budget without the right', async () => {
            mockDbRun.mockResolvedValueOnce(activeSessionRow());
            const req = makeReq({ sessionId: 'sess-1', allowedActions: ['sponsorUnboundTransaction'], allowDeploy: true });
            const result = await handlers.createAgentGrant(req);
            expect(insertEntriesSpy).toHaveBeenCalledWith(expect.objectContaining({ allowDeploy: true, maxDeploys: 1, deploysUsed: 0 }));
            expect(result).toMatchObject({ allowDeploy: true, maxDeploys: 1 });

            const bad = makeReq({ sessionId: 'sess-1', allowedActions: ['sponsorUnboundTransaction'], allowDeploy: true, maxDeploys: 0 });
            await handlers.createAgentGrant(bad);
            expect(bad.reject).toHaveBeenCalledWith(400, expect.stringMatching(/maxDeploys must be an integer between 1 and 100/));

            const noRight = makeReq({ sessionId: 'sess-1', allowedActions: ['sponsorUnboundTransaction'], maxDeploys: 3 });
            await handlers.createAgentGrant(noRight);
            expect(noRight.reject).toHaveBeenCalledWith(400, expect.stringMatching(/maxDeploys needs allowDeploy/));
        });

        it('the hook grants the deploy right only while the budget lasts', async () => {
            const TOKEN = 'ngat_' + 'c'.repeat(64);
            const tokenReq = () => makeReq({}, { event: 'sponsorUnboundTransaction', user: { id: 'transport-user' }, headers: { 'x-agent-token': TOKEN } });
            mockDbRun.mockResolvedValueOnce(grantRow({ allowedActions: JSON.stringify(['sponsorUnboundTransaction']), allowDeploy: true, maxDeploys: 2, deploysUsed: 1 }));
            const open = tokenReq();
            await enforceAgentGrant(open, db);
            expect(open.agentGrant.allowDeploy).toBe(true);

            mockDbRun.mockResolvedValueOnce(grantRow({ allowedActions: JSON.stringify(['sponsorUnboundTransaction']), allowDeploy: true, maxDeploys: 2, deploysUsed: 2 }));
            const spent = tokenReq();
            await enforceAgentGrant(spent, db);
            expect(spent.agentGrant.allowDeploy).toBe(false);

            mockDbRun.mockResolvedValueOnce(grantRow({ allowedActions: JSON.stringify(['sponsorUnboundTransaction']) }));
            const none = tokenReq();
            await enforceAgentGrant(none, db);
            expect(none.agentGrant.allowDeploy).toBe(false);
        });

        // The budget is reserved atomically before the broadcast; recordDeployedContracts only
        // remembers the address, in its own column.
        it('recordDeployedContracts records the address in deployedContracts and leaves the counter alone', async () => {
            mockDbRun.mockResolvedValueOnce(grantRow({ allowedContracts: JSON.stringify(['0xOLD']), deployedContracts: JSON.stringify(['0xEARLIER']), allowDeploy: true, maxDeploys: 2, deploysUsed: 1 }));
            await recordDeployedContracts(db, 'grant-1', ['0xNEW', '0xEARLIER']);
            expect(updateSetSpy).toHaveBeenCalledWith({ deployedContracts: JSON.stringify(['0xEARLIER', '0xNEW']) });
            expect(updateWhereSpy).toHaveBeenCalledWith({ ID: 'grant-1' });
            // nothing new: no write
            updateSetSpy.mockClear();
            mockDbRun.mockResolvedValueOnce(grantRow({ deployedContracts: JSON.stringify(['0xNEW']), allowDeploy: true }));
            await recordDeployedContracts(db, 'grant-1', ['0xNEW']);
            expect(updateSetSpy).not.toHaveBeenCalled();
        });

        it('the hook hands deployedContracts to the sponsor policy', async () => {
            const TOKEN = 'ngat_' + 'd'.repeat(64);
            mockDbRun.mockResolvedValueOnce(grantRow({ allowedActions: JSON.stringify(['sponsorUnboundTransaction']), deployedContracts: JSON.stringify(['0xNEW']) }));
            const req = makeReq({}, { event: 'sponsorUnboundTransaction', user: { id: 'transport-user' }, headers: { 'x-agent-token': TOKEN } });
            await enforceAgentGrant(req, db);
            expect(req.agentGrant.deployedContracts).toEqual(['0xNEW']);
        });

        it('reserveDeployBudget is ONE conditional UPDATE bounded by maxDeploys (parallel callers cannot overspend)', async () => {
            mockDbRun.mockResolvedValueOnce(grantRow({ allowDeploy: true, maxDeploys: 2, deploysUsed: 1 }));
            mockDbRun.mockResolvedValueOnce(1); // the UPDATE hit a row
            expect(await reserveDeployBudget(db, 'grant-1', 1)).toBe(true);
            expect(updateSetSpy).toHaveBeenCalledWith({ deploysUsed: { '+=': 1 } });
            expect(updateWhereSpy).toHaveBeenCalledWith({ ID: 'grant-1', isActive: true, allowDeploy: true, deploysUsed: { '<=': 1 } });

            // the same stale read, second caller: the UPDATE matches no row
            mockDbRun.mockResolvedValueOnce(grantRow({ allowDeploy: true, maxDeploys: 2, deploysUsed: 1 }));
            mockDbRun.mockResolvedValueOnce(0);
            expect(await reserveDeployBudget(db, 'grant-1', 1)).toBe(false);

            // a tx with more deploys than the whole budget
            mockDbRun.mockResolvedValueOnce(grantRow({ allowDeploy: true, maxDeploys: 1, deploysUsed: 0 }));
            mockDbRun.mockResolvedValueOnce(0);
            expect(await reserveDeployBudget(db, 'grant-1', 2)).toBe(false);
            expect(updateWhereSpy).toHaveBeenLastCalledWith({ ID: 'grant-1', isActive: true, allowDeploy: true, deploysUsed: { '<=': -1 } });
        });

        it('reserveDeployBudget refuses without the right, on a revoked grant, or for a non-positive count, touching nothing', async () => {
            updateSetSpy.mockClear();
            mockDbRun.mockResolvedValueOnce(grantRow({ allowDeploy: false, maxDeploys: 5 }));
            expect(await reserveDeployBudget(db, 'grant-1', 1)).toBe(false);
            mockDbRun.mockResolvedValueOnce(grantRow({ allowDeploy: true, maxDeploys: 5, isActive: false }));
            expect(await reserveDeployBudget(db, 'grant-1', 1)).toBe(false);
            expect(await reserveDeployBudget(db, 'grant-1', 0)).toBe(false);
            expect(await reserveDeployBudget(db, '', 1)).toBe(false);
            expect(updateSetSpy).not.toHaveBeenCalled();
        });

        it('releaseDeployBudget gives a reservation back, never below zero', async () => {
            mockDbRun.mockResolvedValueOnce(1);
            await releaseDeployBudget(db, 'grant-1', 1);
            expect(updateSetSpy).toHaveBeenCalledWith({ deploysUsed: { '-=': 1 } });
            expect(updateWhereSpy).toHaveBeenCalledWith({ ID: 'grant-1', deploysUsed: { '>=': 1 } });
        });
    });

    describe('enforceAgentGrant', () => {
        const TOKEN = 'ngat_' + 'a'.repeat(64);

        function tokenReq(event: string, data: Record<string, unknown> = {}, token: string = TOKEN) {
            return makeReq(data, {
                event,
                user: { id: 'transport-user' },
                headers: { 'x-agent-token': token }
            });
        }

        it('an unpinned grant may not choose a sponsor', async () => {
            mockDbRun.mockResolvedValueOnce(grantRow({ sponsorSessionId: null, allowedActions: JSON.stringify(['anchorDocument']) }));
            const req = tokenReq('anchorDocument', { sessionId: 'sess-1', sponsorSessionId: 'some-sponsor' });
            await enforceAgentGrant(req, db);
            expect(req.reject).toHaveBeenCalledWith(403, expect.stringMatching(/no sponsor binding/));
        });

        it('currentGrantPolicy: the live lists of an active grant, null once revoked', async () => {
            mockDbRun.mockResolvedValueOnce(grantRow({ allowedContracts: JSON.stringify(['c1']), allowedCircuits: null, deployedContracts: JSON.stringify(['d1']), allowDeploy: true }));
            expect(await currentGrantPolicy(db, 'g1')).toEqual({
                allowedContracts: ['c1'], allowedCircuits: [], deployedContracts: ['d1'], allowedTokenTypes: [], allowDeploy: true
            });
            mockDbRun.mockResolvedValueOnce(grantRow({ isActive: false }));
            expect(await currentGrantPolicy(db, 'g1')).toBeNull();
            mockDbRun.mockResolvedValueOnce(grantRow({ revokedAt: '2026-09-05T00:00:00Z' }));
            expect(await currentGrantPolicy(db, 'g1')).toBeNull();
            mockDbRun.mockResolvedValueOnce(null);
            expect(await currentGrantPolicy(db, 'g1')).toBeNull();
        });

        it('currentGrantPolicy: an expired grant yields no policy, a future validUntil does', async () => {
            mockDbRun.mockResolvedValueOnce(grantRow({ validUntil: '2000-01-01T00:00:00.000Z', allowedContracts: JSON.stringify(['c1']) }));
            expect(await currentGrantPolicy(db, 'g1')).toBeNull();
            mockDbRun.mockResolvedValueOnce(grantRow({ validUntil: new Date(Date.now() + 60_000).toISOString(), allowedContracts: JSON.stringify(['c1']) }));
            expect(await currentGrantPolicy(db, 'g1')).toMatchObject({ allowedContracts: ['c1'] });
        });

        it('the grant lists bound every action naming a contract or circuit, an empty list bounds nothing', async () => {
            const scoped = () => grantRow({
                allowedActions: JSON.stringify(['anchorDocument', 'issueFieldPredicateAttestation']),
                allowedContracts: JSON.stringify(['ABCDEF01']),
                allowedCircuits: JSON.stringify(['attest', 'attestGuarded', 'anchorContentRoot', 'proveFieldPredicate'])
            });
            mockDbRun.mockResolvedValueOnce(scoped());
            const outside = tokenReq('anchorDocument', { sessionId: 'sess-1', contractAddress: 'ffff0000' });
            await enforceAgentGrant(outside, db);
            expect(outside.reject).toHaveBeenCalledWith(403, expect.stringMatching(/ffff0000.*allowedContracts/));

            mockDbRun.mockResolvedValueOnce(scoped());
            const inside = tokenReq('anchorDocument', { sessionId: 'sess-1', contractAddress: 'abcdef01' });
            await enforceAgentGrant(inside, db);
            expect(inside.reject).not.toHaveBeenCalled();
            expect(inside.user.id).toBe(TEST_USER_ID);

            mockDbRun.mockResolvedValueOnce(scoped());
            const circuit = tokenReq('issueFieldPredicateAttestation', { sessionId: 'sess-1', contractAddress: 'abcdef01', circuit: 'bindPassport' });
            await enforceAgentGrant(circuit, db);
            expect(circuit.reject).toHaveBeenCalledWith(403, expect.stringMatching(/bindPassport.*allowedCircuits/));

            mockDbRun.mockResolvedValueOnce(grantRow({ allowedContracts: null, allowedCircuits: null }));
            const open = tokenReq('anchorDocument', { sessionId: 'sess-1', contractAddress: 'ffff0000' });
            await enforceAgentGrant(open, db);
            expect(open.reject).not.toHaveBeenCalled();

            // the sponsoring actions keep their own floor-and-grant check in the worker
            mockDbRun.mockResolvedValueOnce(grantRow({
                allowedActions: JSON.stringify(['sponsorFinalizedTransaction']), sponsorSessionId: 'sponsor-1',
                allowedContracts: JSON.stringify(['abcdef01'])
            }));
            const sponsored = tokenReq('sponsorFinalizedTransaction', { sessionId: 'sess-1', contractAddress: 'ffff0000', transactionHex: '00' });
            await enforceAgentGrant(sponsored, db);
            expect(sponsored.reject).not.toHaveBeenCalled();
        });

        it('is a no-op without the token header', async () => {
            const req = makeReq({}, { event: 'anchorDocument', user: { id: 'u' } });
            await enforceAgentGrant(req, db);
            expect(req.reject).not.toHaveBeenCalled();
            expect(req.user).toEqual({ id: 'u' });
            expect(mockDbRun).not.toHaveBeenCalled();
        });

        it('reads the token from the merged req.headers, where the $batch envelope header lands', async () => {
            // A batch part's synthetic Express request carries no token; CAP
            // merges the envelope headers into the cds Request's `headers`.
            mockDbRun.mockResolvedValueOnce(grantRow({ allowedActions: JSON.stringify(['anchorDocument']) }));
            const req = makeReq({ sessionId: 'sess-1' }, { event: 'anchorDocument', user: { id: 'agent-token-transport' } });
            req.headers = { 'x-agent-token': TOKEN };
            await enforceAgentGrant(req, db);
            expect(req.reject).not.toHaveBeenCalled();
            expect(req.user).toEqual({ id: TEST_USER_ID });
        });

        it('refunds the daily budget unit when the handler refuses the request as invalid (4xx below 429), keeps it otherwise', async () => {
            const today = new Date().toISOString().slice(0, 10);
            const handlers: Record<string, (err: unknown) => void> = {};
            const run = async (status: number) => {
                mockDbRun.mockReset();
                updateWhereSpy.mockClear();
                mockDbRun
                    .mockResolvedValueOnce(grantRow({ maxJobsPerDay: 5, jobsUsedToday: 1, budgetWindow: today })) // grant lookup
                    .mockResolvedValueOnce(1)   // consume (increment)
                    .mockResolvedValueOnce(1);  // refund
                const req = tokenReq('anchorDocument', { sessionId: 'sess-1' });
                req.on = (event: string, cb: (err: unknown) => void) => { handlers[event] = cb; };
                await enforceAgentGrant(req, db);
                expect(req.reject).not.toHaveBeenCalled();
                expect(handlers.failed).toBeDefined();
                const before = mockDbRun.mock.calls.length;
                handlers.failed({ status });
                await new Promise(r => setImmediate(r));
                return mockDbRun.mock.calls.length - before;
            };
            try {
                expect(await run(400)).toBe(1);   // refund UPDATE issued
                expect(updateSetSpy).toHaveBeenCalledWith({ jobsUsedToday: { '-=': 1 } });
                expect(await run(404)).toBe(1);
                expect(await run(429)).toBe(0);   // exhausted stays exhausted
                expect(await run(503)).toBe(0);   // a server-side failure after admission keeps the unit
            } finally {
                // unconsumed mockResolvedValueOnce values must not leak into the next test
                mockDbRun.mockReset();
                mockDbRun.mockResolvedValue(null);
            }
        });

        it('rejects 401 when the transport marker principal arrives without a token (a $batch part)', async () => {
            // The standalone image admits a token request under a marker principal
            // and relies on this hook; a batch part carries no token header but
            // inherits that principal. It must not run as an authenticated user.
            const req = makeReq({}, { event: 'sponsorFinalizedTransaction', user: { id: 'agent-token-transport' } });
            await enforceAgentGrant(req, db);
            expect(req.reject).toHaveBeenCalledWith(401, expect.stringContaining('agent token required'));
            expect(req.user).toEqual({ id: 'agent-token-transport' });
            expect(mockDbRun).not.toHaveBeenCalled();
        });

        it('rejects 401 when the public verify marker principal reaches this service', async () => {
            const req = makeReq({}, { event: 'verifyAttestationState', user: { id: 'public-verify-transport' } });
            await enforceAgentGrant(req, db);
            expect(req.reject).toHaveBeenCalledWith(401, expect.stringContaining('authentication required'));
            expect(mockDbRun).not.toHaveBeenCalled();
        });

        it('getGrantUsage is always allowed but only for the token\'s own grant', async () => {
            mockDbRun.mockResolvedValueOnce(grantRow({ allowedActions: JSON.stringify([]), maxJobsPerDay: 1, jobsUsedToday: 1, budgetWindow: TODAY }));
            const own = tokenReq('getGrantUsage', { grantId: 'grant-1' });
            await enforceAgentGrant(own, db);
            expect(own.reject).not.toHaveBeenCalled();
            expect(mockDbRun).toHaveBeenCalledTimes(1); // no budget UPDATE
            expect(own.user).toEqual({ id: TEST_USER_ID });

            mockDbRun.mockResolvedValueOnce(grantRow());
            const foreign = tokenReq('getGrantUsage', { grantId: 'grant-2' });
            await enforceAgentGrant(foreign, db);
            expect(foreign.reject).toHaveBeenCalledWith(404, expect.stringContaining('Grant'));
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
            expect(req.agentGrant).toEqual({ ID: 'grant-1', sessionId: 'sess-1', userId: TEST_USER_ID, allowedContracts: [], allowedCircuits: [], deployedContracts: [], allowedTokenTypes: [], allowDeploy: false });
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

        it('refuses READs of entities outside the agent-readable set', async () => {
            for (const target of ['NightgateService.GranteeIdentities', 'NightgateService.DisclosureRoles', 'NightgateService.Anything']) {
                mockDbRun.mockResolvedValueOnce(grantRow());
                const whereSpy = vi.fn();
                const req = tokenReq('READ');
                req.target = { name: target };
                req.query = { where: whereSpy };
                await enforceAgentGrant(req, db);
                expect(req.reject).toHaveBeenCalledWith(403, expect.stringMatching(new RegExp(target.split('.').pop() as string)));
                expect(whereSpy).not.toHaveBeenCalled();
            }
        });

        it('narrows READs of session-scoped entities to the grant, leaves chain entities open', async () => {
            for (const [target, expectedWhere] of [
                ['NightgateService.WalletSessions', { sessionId: 'sess-1' }],
                ['NightgateService.PendingSubmissions', { sessionId: 'sess-1' }],
                ['NightgateService.Documents', { sessionId: 'sess-1' }],
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
            // the unbound (parallel) channel has the same trust shape and is grantable too.
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

describe('agent grant circuit scope follows the action, not the request fields', () => {
    const db = { run: mockDbRun };
    const TOKEN_R2 = 'ngat_' + 'd'.repeat(64);
    const tokenReq = (event: string, data: Record<string, unknown>) => ({
        event, data, headers: { 'x-agent-token': TOKEN_R2 }, reject: vi.fn(), user: { id: 'anonymous' }
    }) as any;
    const attestOnly = (actions: string[]) => grantRow({
        allowedActions: JSON.stringify(actions),
        allowedContracts: JSON.stringify(['abcdef01']), allowedCircuits: JSON.stringify(['attest'])
    });

    it('grantDisclosure runs the grantDisclosure circuit, so a grant limited to attest is refused', async () => {
        mockDbRun.mockResolvedValueOnce(attestOnly(['grantDisclosure']));
        const req = tokenReq('grantDisclosure', { sessionId: 'sess-1', contractAddress: 'abcdef01', payloadHash: 'b'.repeat(64), grantee: 'c'.repeat(64), level: 2 });
        await enforceAgentGrant(req, db);
        expect(req.reject).toHaveBeenCalledWith(403, expect.stringMatching(/grantDisclosure.*allowedCircuits/));
    });

    it('a batch names its circuits in the calls JSON and every one of them counts', async () => {
        mockDbRun.mockResolvedValueOnce(attestOnly(['submitContractCallBatch']));
        const calls = JSON.stringify([{ circuit: 'attest', args: [] }, { circuit: 'revokeDisclosure', args: ['b'.repeat(64), 'c'.repeat(64)] }]);
        const req = tokenReq('submitContractCallBatch', { sessionId: 'sess-1', contractAddress: 'abcdef01', calls });
        await enforceAgentGrant(req, db);
        expect(req.reject).toHaveBeenCalledWith(403, expect.stringMatching(/revokeDisclosure.*allowedCircuits/));
    });

    it('anchorDocument and attestAgentOutput need exactly the attest circuit', () => {
        const plainOnly = { allowedContracts: null, allowedCircuits: JSON.stringify(['attest']) };
        expect(grantScopeViolation(plainOnly, { contractAddress: 'abcdef01' }, 'anchorDocument')).toBeNull();
        expect(grantScopeViolation(plainOnly, { contractAddress: 'abcdef01' }, 'attestAgentOutput')).toBeNull();
        const proofsOnly = { allowedContracts: null, allowedCircuits: JSON.stringify(['proveFieldPredicate']) };
        expect(grantScopeViolation(proofsOnly, { contractAddress: 'abcdef01' }, 'anchorDocument')).toMatch(/attest/);
        expect(grantScopeViolation(proofsOnly, { contractAddress: 'abcdef01' }, 'attestAgentOutput')).toMatch(/attest/);
        expect(circuitsOfRequest('anchorDocument', {})).toEqual(['attest']);
        expect(circuitsOfRequest('attestAgentOutput', {})).toEqual(['attest']);
    });

    it('an action whose circuits cannot be derived is refused while a circuit list is set, and passes without one', () => {
        const listed = { allowedContracts: null, allowedCircuits: JSON.stringify(['attest']) };
        expect(grantScopeViolation(listed, { contractAddress: 'abcdef01' }, 'someFutureAction')).toMatch(/cannot be matched/);
        expect(grantScopeViolation(listed, { contractAddress: 'abcdef01', calls: 'not json' }, 'submitContractCallBatch')).toMatch(/cannot be matched/);
        expect(grantScopeViolation(listed, { contractAddress: 'abcdef01', calls: JSON.stringify([{ args: [] }]) }, 'submitContractCallBatch')).toMatch(/cannot be matched/);
        expect(grantScopeViolation({ allowedContracts: null, allowedCircuits: null }, { contractAddress: 'abcdef01' }, 'someFutureAction')).toBeNull();
        expect(grantScopeViolation(listed, {}, 'reindexDisclosures')).toBeNull();
    });

    it('a queued job is re-checked against the grant as it is now: action, contract, circuits', () => {
        const grant = { allowedActions: JSON.stringify(['grantDisclosure', 'submitContractCallBatch']), allowedContracts: JSON.stringify(['abcdef01']), allowedCircuits: JSON.stringify(['grantDisclosure', 'attest']) };
        const grantCmd = { op: 'grantDisclosure', contractAddress: 'abcdef01', level: 1 };
        expect(grantJobScopeViolation(grant, { kind: 'grantDisclosure' }, grantCmd)).toBeNull();
        // The action left the grant after admission.
        expect(grantJobScopeViolation({ ...grant, allowedActions: JSON.stringify(['anchorDocument']) }, { kind: 'grantDisclosure' }, grantCmd)).toMatch(/no longer allowed/);
        // The contract left the grant after admission.
        expect(grantJobScopeViolation({ ...grant, allowedContracts: JSON.stringify(['ffffffff']) }, { kind: 'grantDisclosure' }, grantCmd)).toMatch(/allowedContracts/);
        // A batch names its circuits in the persisted calls.
        const batch = { op: 'callBatch', contractAddress: 'abcdef01', calls: [{ circuit: 'attest', args: [] }, { circuit: 'revokeDisclosure', args: [] }] };
        expect(grantJobScopeViolation(grant, { kind: 'submitContractCallBatch' }, batch)).toMatch(/revokeDisclosure.*allowedCircuits/);
        // A workflow child is checked as the action its PARENT was admitted as; circuits still count.
        const child = { op: 'call', contractAddress: 'abcdef01', circuit: 'proveFieldPredicate', args: [] };
        const proofGrant = { ...grant, allowedActions: JSON.stringify(['issueFieldPredicateAttestation']) };
        expect(grantJobScopeViolation(proofGrant, { kind: 'fieldPredicateProof', parentJobId: 'p', parentKind: 'issueFieldPredicateAttestation' }, child)).toMatch(/proveFieldPredicate.*allowedCircuits/);
        expect(grantJobScopeViolation({ ...proofGrant, allowedCircuits: null }, { kind: 'fieldPredicateProof', parentJobId: 'p', parentKind: 'issueFieldPredicateAttestation' }, child)).toBeNull();
        // The parent's action left the grant while the child waited.
        expect(grantJobScopeViolation({ ...grant, allowedActions: JSON.stringify(['anchorDocument']), allowedCircuits: null }, { kind: 'fieldPredicateProof', parentJobId: 'p', parentKind: 'issueFieldPredicateAttestation' }, child)).toMatch(/issueFieldPredicateAttestation.*no longer allowed/);
        // A child whose parent cannot be resolved is refused, never waved through.
        expect(grantJobScopeViolation({ ...proofGrant, allowedCircuits: null }, { kind: 'fieldPredicateProof', parentJobId: 'p', parentKind: null }, child)).toMatch(/parent job/);
        // Retract jobs are admitted as retractAttestation (mode 0) or purgeExpired (mode 1).
        const retractGrant = { allowedActions: JSON.stringify(['purgeExpired']), allowedContracts: null, allowedCircuits: null };
        expect(grantJobScopeViolation(retractGrant, { kind: 'retract' }, { op: 'retract', mode: 1, contractAddress: 'abcdef01' })).toBeNull();
        expect(grantJobScopeViolation(retractGrant, { kind: 'retract' }, { op: 'retract', mode: 0, contractAddress: 'abcdef01' })).toMatch(/retractAttestation/);
    });

    it('circuitsOfRequest lists the server-side circuits of every grantable action', () => {
        expect(circuitsOfRequest('issueFieldPredicateAttestationBatch', {})).toEqual(expect.arrayContaining(['anchorContentRoot', 'proveFieldPredicate', 'proveFieldEquality', 'proveFieldMembership', 'proveDocumentComparison']));
        expect(circuitsOfRequest('issueDocumentDiffAttestation', {})).toEqual(expect.arrayContaining(['anchorContentRoot', 'proveDocumentComparison']));
        expect(circuitsOfRequest('revokeDisclosure', {})).toEqual(['revokeDisclosure']);
        expect(circuitsOfRequest('reindexDisclosures', {})).toEqual([]);
        expect(circuitsOfRequest('unknownAction', {})).toBeNull();
        expect(circuitsOfRequest('unknownAction', { circuit: 'attest' })).toEqual(['attest']);
    });
});
