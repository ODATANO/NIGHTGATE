/**
 * Agent-token READs over real HTTP (cds.test boot with the standalone image's
 * transport auth): a token bound to one session sees only that session's
 * Documents rows, never the operator's other sessions or rows without a
 * session; an entity outside the agent-readable set answers 403; the
 * operator's own reads are untouched.
 */

import cds from '@sap/cds';
import path from 'node:path';
import crypto from 'node:crypto';

(cds as any).env.requires.auth = {
    impl: path.resolve(__dirname, '../../srv/utils/agent-token-auth.js'),
    users: { 'operator-docs': { password: 'op-secret', roles: [] } }
};

const cap = cds.test(__dirname + '/../..');

const API = '/api/v1/nightgate';
const TOKEN = 'ngat_' + 'c'.repeat(64);
const OPERATOR = 'operator-docs';
const SESSION = 'a1a1a1a1-0000-4000-8000-000000000001';
const OTHER_SESSION = 'a1a1a1a1-0000-4000-8000-000000000002';

function sha256Hex(s: string): string { return crypto.createHash('sha256').update(s).digest('hex'); }

async function get(url: string, headers: Record<string, string>) {
    return cap.axios.get(`${API}/${url}`, { headers, validateStatus: () => true });
}

const asToken = { 'x-agent-token': TOKEN };
const asOperator = { authorization: 'Basic ' + Buffer.from('operator-docs:op-secret').toString('base64') };

describe('agent token reads over HTTP', () => {
    beforeAll(async () => {
        const db = await cds.connect.to('db');
        const now = new Date().toISOString();
        await db.run(cds.ql.INSERT.into('midnight.AgentGrants').entries({
            ID: cds.utils.uuid(), userId: OPERATOR, sessionId: SESSION, tokenHash: sha256Hex(TOKEN),
            allowedActions: JSON.stringify(['anchorDocument']), isActive: true, createdAt: now, modifiedAt: now
        }));
        const doc = (id: string, sessionId: string | null, storageRef: string) => ({
            ID: id, userId: OPERATOR, sha256: sha256Hex(id), storageRef, sessionId,
            contractAddress: 'b'.repeat(64), createdAt: now, modifiedAt: now
        });
        await db.run(cds.ql.INSERT.into('midnight.Documents').entries([
            doc('11111111-1111-4111-8111-111111111111', SESSION, 's3://private/own-session'),
            doc('22222222-2222-4222-8222-222222222222', OTHER_SESSION, 's3://private/other-session'),
            doc('33333333-3333-4333-8333-333333333333', null, 's3://private/legacy-row')
        ]));
    });

    it('a token sees only the Documents of its own session', async () => {
        const res = await get('Documents', asToken);
        expect(res.status).toBe(200);
        const refs = res.data.value.map((r: any) => r.storageRef).sort();
        expect(refs).toEqual(['s3://private/own-session']);
    });

    it('a token cannot read GranteeIdentities', async () => {
        const res = await get('GranteeIdentities', asToken);
        expect(res.status).toBe(403);
    });

    it('the operator still reads every own row, sessions and legacy rows included', async () => {
        const res = await get('Documents', asOperator);
        expect(res.status).toBe(200);
        const refs = res.data.value.map((r: any) => r.storageRef).sort();
        expect(refs).toEqual(['s3://private/legacy-row', 's3://private/other-session', 's3://private/own-session']);
    });
});
