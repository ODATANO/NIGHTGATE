/**
 * The agent-token lane against a REAL CAP `$batch` (cds.test boot with the
 * standalone image's transport auth): every part of a batch that carries the
 * token on the envelope is authenticated by the grant hook, a part with an
 * unknown token is refused, and a token cannot reach a non-allowlisted
 * action. This is the dispatch path the unit tests cannot see: CAP builds a
 * synthetic request per part with only the part's own headers.
 */

import cds from '@sap/cds';
import path from 'node:path';
import crypto from 'node:crypto';

// The standalone image's auth: basic for the operator, token lane for agents.
(cds as any).env.requires.auth = {
    impl: path.resolve(__dirname, '../../srv/utils/agent-token-auth.js'),
    users: { nightgate: { password: 'op-secret', roles: ['admin'] } }
};

const cap = cds.test(__dirname + '/../..');

const API = '/api/v1/nightgate';
const TOKEN = 'ngat_' + 'b'.repeat(64);
const OPERATOR = 'operator-batch';
const SESSION = 'sess-batch-1';

function sha256Hex(s: string): string { return crypto.createHash('sha256').update(s).digest('hex'); }

async function batch(headers: Record<string, string>, requests: Array<{ id: string; method: string; url: string; body?: unknown }>) {
    return cap.axios.post(`${API}/$batch`, { requests: requests.map(r => ({ ...r, headers: { 'content-type': 'application/json' } })) }, {
        headers: { 'content-type': 'application/json', ...headers },
        validateStatus: () => true
    });
}

describe('agent token on a real $batch', () => {
    let db: any;
    beforeAll(async () => {
        db = await cds.connect.to('db');
        const now = new Date().toISOString();
        await db.run(cds.ql.INSERT.into('midnight.WalletSessions').entries({
            ID: cds.utils.uuid(), userId: OPERATOR, sessionId: SESSION, viewingKeyHash: 'vk-batch', encryptedViewingKey: 'cipher',
            connectedAt: now, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), isActive: true, createdAt: now, modifiedAt: now
        }));
        await db.run(cds.ql.INSERT.into('midnight.WalletSessions').entries({
            ID: cds.utils.uuid(), userId: 'someone-else', sessionId: 'sess-other-1', viewingKeyHash: 'vk-other', encryptedViewingKey: 'cipher',
            connectedAt: now, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), isActive: true, createdAt: now, modifiedAt: now
        }));
        await db.run(cds.ql.INSERT.into('midnight.AgentGrants').entries({
            ID: cds.utils.uuid(), userId: OPERATOR, sessionId: SESSION, tokenHash: sha256Hex(TOKEN),
            allowedActions: JSON.stringify(['anchorDocument']), isActive: true, createdAt: now, modifiedAt: now
        }));
    });

    it('a part with an unknown token is refused (401) although the envelope passed transport auth', async () => {
        const res = await batch({ 'x-agent-token': 'ngat_' + 'f'.repeat(64) }, [{ id: 'r1', method: 'GET', url: 'WalletSessions' }]);
        expect(res.status).toBe(200);
        expect(res.data.responses[0].status).toBe(401);
    });

    it('a part with the envelope token runs as the grant operator, scoped to the grant session', async () => {
        const res = await batch({ 'x-agent-token': TOKEN }, [{ id: 'r1', method: 'GET', url: 'WalletSessions' }]);
        expect(res.status).toBe(200);
        expect(res.data.responses[0].status).toBe(200);
        const rows = res.data.responses[0].body.value;
        expect(rows.map((r: any) => r.sessionId)).toEqual([SESSION]);
    });

    it('a part naming a non-allowlisted action is refused (403); a malformed token is refused (401)', async () => {
        const forbidden = await batch({ 'x-agent-token': TOKEN }, [{ id: 'r1', method: 'POST', url: 'sendNight', body: { sessionId: SESSION, receiverAddress: 'x', amount: '1' } }]);
        expect(forbidden.data.responses[0].status).toBe(403);
        const malformed = await batch({ 'x-agent-token': 'not-a-token' }, [{ id: 'r1', method: 'GET', url: 'WalletSessions' }]);
        expect(malformed.data.responses[0].status).toBe(401);
    });

    it('basic auth on the envelope keeps working for the operator', async () => {
        const res = await batch({ authorization: 'Basic ' + Buffer.from('nightgate:op-secret').toString('base64') }, [{ id: 'r1', method: 'GET', url: 'WalletSessions' }]);
        expect(res.status).toBe(200);
        expect(res.data.responses[0].status).toBe(200);
    });

    it('a batch without any credentials is refused at transport level', async () => {
        const res = await batch({}, [{ id: 'r1', method: 'GET', url: 'WalletSessions' }]);
        expect(res.status).toBe(401);
    });
});
