/**
 * Actions under an agent token through the real grant hook and the real handlers of a booted server:
 * the hook fills in the grant's session, refuses what the grant does not allow, and the pool never mints.
 */

import cds from '@sap/cds';
import crypto from 'node:crypto';

cds.User.default = (cds.User as unknown as { Anonymous: typeof cds.User.default }).Anonymous;
(cds as any).env.requires.auth = {
    kind: 'basic',
    impl: '@odatano/cap-auth',
    users: { 'operator-actions': { password: 'op-secret', roles: [] } }
};

const cap = cds.test(__dirname + '/../..');

const API = '/odata/v4/midnight';
const OPERATOR = 'operator-actions';
const SESSION = '7a7a7a7a-0000-4000-8000-000000000001';
const OWN_TOKEN = 'ngat_' + '1'.repeat(64);
const POOL_TOKEN = 'ngat_' + '2'.repeat(64);
const POOL = '00000000-0000-0000-0000-706f6f6c0000';
const FACTORY = 'd9'.repeat(32);
const asOperator = { authorization: 'Basic ' + Buffer.from(`${OPERATOR}:op-secret`).toString('base64') };

const sha256Hex = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const mintBody = (extra: Record<string, unknown> = {}) => ({ contractAddress: FACTORY, name: 'CREDIT', amount: '5', receiverCoinPublicKey: '1b'.repeat(32), ...extra });

async function post(action: string, body: unknown, headers: Record<string, string>) {
    const res = await cap.axios.post(`${API}/${action}`, body, { headers, validateStatus: () => true });
    return { status: res.status, message: String(res.data?.error?.message ?? '') };
}

describe('agent token actions through the real grant hook', () => {
    beforeAll(async () => {
        const db = await cds.connect.to('db');
        const now = new Date().toISOString();
        await db.run(cds.ql.INSERT.into('midnight.WalletSessions').entries({
            userId: OPERATOR, sessionId: SESSION, viewingKeyHash: 'vk-actions', encryptedViewingKey: 'cipher',
            connectedAt: now, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), isActive: true, createdAt: now, modifiedAt: now
        }));
        await db.run(cds.ql.INSERT.into('midnight.AgentGrants').entries([
            { ID: cds.utils.uuid(), userId: OPERATOR, sessionId: SESSION, tokenHash: sha256Hex(OWN_TOKEN), allowedActions: JSON.stringify(['mintFactoryToken']), isActive: true, createdAt: now, modifiedAt: now },
            { ID: cds.utils.uuid(), userId: OPERATOR, sessionId: SESSION, sponsorSessionId: POOL, tokenHash: sha256Hex(POOL_TOKEN), allowedActions: JSON.stringify(['mintFactoryToken']), isActive: true, createdAt: now, modifiedAt: now }
        ]));
    });

    it('an operator mint without a session is refused with 400', async () => {
        const res = await post('mintFactoryToken', mintBody(), asOperator);
        expect(res).toMatchObject({ status: 400, message: 'sessionId is required' });
    });

    it('a token mint without a session runs as the grant session and gets past every check up to the contract', async () => {
        // This boot loads no contract registry, so the first step after the checks answers 404.
        const res = await post('mintFactoryToken', mintBody(), { 'x-agent-token': OWN_TOKEN });
        expect(res.status).toBe(404);
        expect(res.message).toMatch(/Contract 'token-factory' is not registered/);
    });

    it('a token may not name another session than its grant', async () => {
        const res = await post('mintFactoryToken', mintBody({ sessionId: '7a7a7a7a-0000-4000-8000-0000000000ff' }), { 'x-agent-token': OWN_TOKEN });
        expect(res.status).toBe(403);
    });

    it('a grant the platform pool pays for never mints', async () => {
        const res = await post('mintFactoryToken', mintBody(), { 'x-agent-token': POOL_TOKEN });
        expect(res.status).toBe(403);
        expect(res.message).toMatch(/platform pool/);
    });

    it('an action the grant does not list and an action no grant may hold are refused', async () => {
        expect((await post('burnFactoryToken', { contractAddress: FACTORY, name: 'CREDIT', amount: '1' }, { 'x-agent-token': OWN_TOKEN })).status).toBe(403);
        expect((await post('sendToken', { sessionId: SESSION, receiverAddress: 'mn_addr_x', amount: '1' }, { 'x-agent-token': OWN_TOKEN })).status).toBe(403);
    });

    it('an unknown token is refused with 401', async () => {
        expect((await post('mintFactoryToken', mintBody(), { 'x-agent-token': 'ngat_' + '9'.repeat(64) })).status).toBe(401);
    });
});
