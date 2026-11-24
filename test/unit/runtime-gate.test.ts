/**
 * Runtime gate: write actions are refused with a retryable 503 while the
 * initialisation has not succeeded; reads and compute-only actions
 * stay reachable.
 *
 * The booted cds.test() server runs with SKIP_AUTO_INIT (runtime idle), so
 * the outage case is driven by publishing the offline state.
 */
import cds from '@sap/cds';
import { __resetRuntimeStateForTests, publishRuntimeState, readRuntimeState, noteCrawlerRunning } from '../../srv/utils/runtime-state';
import { attachReadLimits, isRuntimeWriteEvent, runtimeUnavailableReason, RUNTIME_FREE_ACTIONS } from '../../srv/utils/runtime-gate';
import { __resetRateLimitersForTests } from '../../srv/utils/rate-classes';

(cds as any).env.requires.auth = {
    kind: 'basic',
    impl: '@odatano/cap-auth',
    users: { operator: { password: 'op-secret', roles: [] }, admin: { password: 'admin-secret', roles: ['admin'] } }
};
const cap = cds.test(__dirname + '/../..');
const API = '/odata/v4/midnight';
const AUTH = { auth: { username: 'operator', password: 'op-secret' }, validateStatus: () => true };

// The booted server runs the compiled twin of runtime-state.js; the state is
// published through it so the gate inside the server sees it.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const serverRuntimeState = require('../../srv/utils/runtime-state.js');

afterEach(() => {
    serverRuntimeState.__resetRuntimeStateForTests();
    __resetRuntimeStateForTests();
});

describe('runtimeUnavailableReason', () => {
    test('is null when the runtime is active', () => {
        expect(runtimeUnavailableReason({ initialized: true, mode: 'active' })).toBeNull();
    });

    test('is null after a successful crawler-less start, which stays idle', () => {
        expect(runtimeUnavailableReason({ initialized: true, mode: 'idle' })).toBeNull();
    });

    test('says the runtime is offline without repeating the startup error', () => {
        const raw = 'SQLITE_CANTOPEN: unable to open C:/private/example.db (select * from midnight_SyncState)';
        const reason = runtimeUnavailableReason({ initialized: false, mode: 'offline', lastError: raw });
        expect(reason).toMatch(/offline/);
        expect(reason).not.toMatch(/SQLITE|private|example\.db|SyncState/);
    });

    test('treats idle as an outage only when the process was expected to initialise', () => {
        const previous = process.env.SKIP_AUTO_INIT;
        try {
            process.env.SKIP_AUTO_INIT = 'true';
            expect(runtimeUnavailableReason({ initialized: false, mode: 'idle' })).toBeNull();
            delete process.env.SKIP_AUTO_INIT;
            expect(runtimeUnavailableReason({ initialized: false, mode: 'idle' })).toMatch(/not completed startup/);
        } finally {
            if (previous === undefined) delete process.env.SKIP_AUTO_INIT;
            else process.env.SKIP_AUTO_INIT = previous;
        }
    });
});

describe('isRuntimeWriteEvent', () => {
    const srv = { name: 'NightgateService', model: { definitions: {
        'NightgateService.connectWallet': { kind: 'action' },
        'NightgateService.sendToken': { kind: 'action' },
        'NightgateService.getWalletBalance': { kind: 'function' },
        'NightgateService.prepareDocumentProof': { kind: 'action' }
    } } } as any;

    test('gates unbound actions and entity writes', () => {
        expect(isRuntimeWriteEvent(srv, 'connectWallet')).toBe(true);
        expect(isRuntimeWriteEvent(srv, 'sendToken')).toBe(true);
        expect(isRuntimeWriteEvent(srv, 'CREATE')).toBe(true);
        expect(isRuntimeWriteEvent(srv, 'UPDATE')).toBe(true);
    });

    test('leaves reads, functions and compute-only actions alone', () => {
        expect(isRuntimeWriteEvent(srv, 'READ')).toBe(false);
        expect(isRuntimeWriteEvent(srv, 'getWalletBalance')).toBe(false);
        expect(isRuntimeWriteEvent(srv, 'prepareDocumentProof')).toBe(false);
        for (const action of RUNTIME_FREE_ACTIONS) expect(isRuntimeWriteEvent(srv, action)).toBe(false);
        // The whole grant administration only uses the database, so it works while the runtime starts.
        for (const action of ['createAgentGrant', 'createAgentGrants', 'updateAgentGrant', 'rotateAgentGrantToken', 'revokeAgentGrant']) {
            expect(RUNTIME_FREE_ACTIONS.has(action)).toBe(true);
        }
    });
});

describe('an offline state caused by the crawler alone', () => {
    test('ends once the crawler runs, so write actions are served again', () => {
        publishRuntimeState({ initialized: true, mode: 'offline', lastError: 'node unreachable', crawlerOnly: true });
        expect(runtimeUnavailableReason()).toMatch(/offline/);
        noteCrawlerRunning();
        expect(readRuntimeState()).toEqual({ initialized: true, mode: 'active' });
        expect(runtimeUnavailableReason()).toBeNull();
    });

    test('a failed submission start stays offline when the crawler starts', () => {
        publishRuntimeState({ initialized: true, mode: 'offline', lastError: 'submission pipeline did not start' });
        noteCrawlerRunning();
        expect(readRuntimeState().mode).toBe('offline');
        expect(runtimeUnavailableReason()).toMatch(/offline/);
    });
});

describe('offline runtime on the served API', () => {
    test('connectWallet is refused with 503 and Retry-After, the message survives', async () => {
        serverRuntimeState.publishRuntimeState({ initialized: false, mode: 'offline', lastError: 'synthetic topology rejection' });
        const response = await cap.axios.post(`${API}/connectWallet`, { viewingKey: 'c'.repeat(64) }, AUTH);
        expect(response.status).toBe(503);
        expect(response.headers['retry-after']).toBe('15');
        expect(JSON.stringify(response.data)).toMatch(/offline/);
        expect(JSON.stringify(response.data)).not.toMatch(/synthetic topology rejection/);
        const sessions = await (await cds.connect.to('db')).run(cds.ql.SELECT.from('midnight.WalletSessions'));
        expect(sessions).toHaveLength(0);
    });

    test('a compute-only action and the readiness probe stay reachable', async () => {
        serverRuntimeState.publishRuntimeState({ initialized: false, mode: 'offline', lastError: 'synthetic topology rejection' });
        // The compute action reaches its handler (whatever it answers about
        // the input); the gate never turns it into a 503.
        const compute = await cap.axios.post(`${API}/prepareMembershipSet`, { allowedValues: ['a', 'b'] }, AUTH);
        expect(compute.status).not.toBe(503);
        // The probe answers for itself: 503 carrying the readiness payload,
        // not the runtime gate's generic refusal.
        const readiness = await cap.axios.get('/odata/v4/midnight-indexer/getReadiness()', AUTH);
        expect(readiness.status).toBe(503);
        expect(readiness.data.ready).toBe(false);
        expect(readiness.data.checks.initialization).toBe(false);
    });

    test('idle under SKIP_AUTO_INIT is not an outage: the action reaches its handler', async () => {
        const response = await cap.axios.post(`${API}/connectWallet`, { viewingKey: 'not-hex' }, AUTH);
        expect(response.status).not.toBe(503);
    });
});

describe('the time limit of an entity read', () => {
    type Hook = (req: Record<string, unknown>) => Promise<void>;
    const hookOf = (functions: string[] = []): Hook => {
        let hook: Hook | undefined;
        attachReadLimits({ before: (_event: string, handler: Hook) => { hook = handler; } } as never, functions);
        return hook!;
    };
    const request = (event: string) => ({ event, user: { id: 'reader' }, reject: vi.fn() });
    const database = (cds as any).env.requires.db;
    const savedKind = database.kind;
    let run: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        __resetRateLimitersForTests();
        run = vi.spyOn(cds.db, 'run').mockResolvedValue(undefined as never);
    });
    afterEach(() => {
        run.mockRestore();
        database.kind = savedKind;
        delete process.env.NIGHTGATE_QUERY_TIMEOUT_MS;
    });

    test('is set in the transaction of the read on PostgreSQL', async () => {
        database.kind = 'postgres';
        await hookOf()(request('READ'));
        expect(run).toHaveBeenCalledWith('SET LOCAL statement_timeout = 15000');
    });

    test('is left out on SQLite, for a counted function and when switched off', async () => {
        await hookOf()(request('READ'));
        database.kind = 'postgres';
        await hookOf(['getJobStatus'])(request('getJobStatus'));
        process.env.NIGHTGATE_QUERY_TIMEOUT_MS = '0';
        await hookOf()(request('READ'));
        expect(run).not.toHaveBeenCalled();
    });

    test('an event that is no read is neither counted nor bounded', async () => {
        database.kind = 'postgres';
        const req = request('anchorDocument');
        process.env.NIGHTGATE_QUERY_RATE_LIMIT = '1';
        try {
            const hook = hookOf();
            for (let i = 0; i < 3; i++) await hook(req);
            expect(req.reject).not.toHaveBeenCalled();
            expect(run).not.toHaveBeenCalled();
        } finally {
            delete process.env.NIGHTGATE_QUERY_RATE_LIMIT;
        }
    });

    test('a read over the limit is refused before the database is asked', async () => {
        database.kind = 'postgres';
        process.env.NIGHTGATE_QUERY_RATE_LIMIT = '1';
        try {
            const hook = hookOf();
            await hook(request('READ'));
            const refused = request('READ');
            await hook(refused);
            expect(refused.reject).toHaveBeenCalledWith(429, expect.stringMatching(/query: 1 per minute/));
            expect(run).toHaveBeenCalledTimes(1);
        } finally {
            delete process.env.NIGHTGATE_QUERY_RATE_LIMIT;
        }
    });
});

describe('the metrics are for the operator', () => {
    const metrics = (username: string, password: string) =>
        cap.axios.get('/odata/v4/midnight-indexer/getMetrics()', { auth: { username, password }, validateStatus: () => true });

    test('a signed-in user without the admin role is refused', async () => {
        expect((await metrics('operator', 'op-secret')).status).toBe(403);
    });

    test('an admin reads them', async () => {
        const res = await metrics('admin', 'admin-secret');
        expect(res.status).toBe(200);
        expect(res.data.value).toContain('odatano_nightgate_');
    });
});

describe('the address the server listens on', () => {
    test('a server that checks credentials listens on every address', () => {
        const { address } = (cds as any).app.server.address();
        expect(['::', '0.0.0.0']).toContain(address);
    });
});
