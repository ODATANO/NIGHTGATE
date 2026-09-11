/**
 * Runtime gate: write actions are refused with a retryable 503 while the
 * plugin's initialisation has not succeeded; reads and compute-only actions
 * stay reachable.
 *
 * The booted cds.test() server runs with SKIP_AUTO_INIT (runtime idle), so
 * the outage case is driven by publishing the offline state.
 */
import cds from '@sap/cds';
import path from 'node:path';
import { publishRuntimeState, __resetRuntimeStateForTests } from '../../srv/utils/runtime-state';
import { isRuntimeWriteEvent, runtimeUnavailableReason, RUNTIME_FREE_ACTIONS } from '../../srv/utils/runtime-gate';

(cds as any).env.requires.auth = {
    impl: path.resolve(__dirname, '../../srv/utils/agent-token-auth.js'),
    users: { operator: { password: 'op-secret', roles: [] } }
};
const cap = cds.test(__dirname + '/../..');
const API = '/api/v1/nightgate';
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
        'NightgateService.sendNight': { kind: 'action' },
        'NightgateService.getWalletBalance': { kind: 'function' },
        'NightgateService.prepareDocumentProof': { kind: 'action' }
    } } } as any;

    test('gates unbound actions and entity writes', () => {
        expect(isRuntimeWriteEvent(srv, 'connectWallet')).toBe(true);
        expect(isRuntimeWriteEvent(srv, 'sendNight')).toBe(true);
        expect(isRuntimeWriteEvent(srv, 'CREATE')).toBe(true);
        expect(isRuntimeWriteEvent(srv, 'UPDATE')).toBe(true);
    });

    test('leaves reads, functions and compute-only actions alone', () => {
        expect(isRuntimeWriteEvent(srv, 'READ')).toBe(false);
        expect(isRuntimeWriteEvent(srv, 'getWalletBalance')).toBe(false);
        expect(isRuntimeWriteEvent(srv, 'prepareDocumentProof')).toBe(false);
        for (const action of RUNTIME_FREE_ACTIONS) expect(isRuntimeWriteEvent(srv, action)).toBe(false);
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
        const compute = await cap.axios.post(`${API}/prepareMembershipSet`, { allowedValuesJson: JSON.stringify(['a', 'b']) }, AUTH);
        expect(compute.status).not.toBe(503);
        const readiness = await cap.axios.get('/api/v1/indexer/getReadiness()', AUTH);
        expect(readiness.status).toBe(200);
        expect(readiness.data.ready).toBe(false);
    });

    test('idle under SKIP_AUTO_INIT is not an outage: the action reaches its handler', async () => {
        const response = await cap.axios.post(`${API}/connectWallet`, { viewingKey: 'not-hex' }, AUTH);
        expect(response.status).not.toBe(503);
    });
});
