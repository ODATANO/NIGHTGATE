/**
 * Agent-token READs over real HTTP (cds.test boot with the standalone image's
 * transport auth): a token bound to one session sees only that session's
 * Documents rows, never the operator's other sessions or rows without a
 * session; the bound read functions of the chain entities answer under a
 * token; an entity outside the agent-readable set answers 403; the
 * operator's own reads are untouched. A token reads the jobs of its own
 * grant by their id.
 */

import cds from '@sap/cds';
import crypto from 'node:crypto';

(cds as any).env.requires.auth = {
    kind: 'basic',
    impl: '@odatano/cap-auth',
    users: { 'operator-docs': { password: 'op-secret', roles: [] } }
};

const cap = cds.test(__dirname + '/../..');

const API = '/odata/v4/midnight';
const TOKEN = 'ngat_' + 'c'.repeat(64);
const OPERATOR = 'operator-docs';
const SESSION = 'a1a1a1a1-0000-4000-8000-000000000001';
const OTHER_SESSION = 'a1a1a1a1-0000-4000-8000-000000000002';
const GRANT = 'a1a1a1a1-0000-4000-8000-00000000000a';
const POOL = '00000000-0000-0000-0000-706f6f6c0000';

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
            ID: GRANT, userId: OPERATOR, sessionId: SESSION, tokenHash: sha256Hex(TOKEN),
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

    it('a token calls the bound read functions of the chain entities', async () => {
        const db = await cds.connect.to('db');
        const now = new Date().toISOString();
        await db.run(cds.ql.INSERT.into('midnight.Blocks').entries({
            ID: cds.utils.uuid(), hash: 'a'.repeat(64), height: 7, protocolVersion: 1, timestamp: 1700000000,
            createdAt: now, modifiedAt: now
        }));
        const latest = await get('Blocks/latest()', asToken);
        expect(latest.status).toBe(200);
        expect(String(latest.data.height)).toBe('7');
        const holders = await get('NightBalances/getTopHolders(limit=5)', asToken);
        expect(holders.status).toBe(200);
    });

    it('a token cannot read GranteeIdentities', async () => {
        const res = await get('GranteeIdentities', asToken);
        expect(res.status).toBe(403);
    });

    it('a token reads a job of its own grant by its id alone, and no job of another grant', async () => {
        const db = await cds.connect.to('db');
        const now = new Date().toISOString();
        const job = (ID: string, grantId: string | null) => ({
            ID, kind: 'sponsorTransfer', sessionId: POOL, status: 'succeeded', requestedBy: OPERATOR, grantId, createdAt: now, modifiedAt: now
        });
        const own = 'b2b2b2b2-0000-4000-8000-000000000001';
        const otherGrant = 'b2b2b2b2-0000-4000-8000-000000000002';
        const noGrant = 'b2b2b2b2-0000-4000-8000-000000000003';
        await db.run(cds.ql.INSERT.into('midnight.BackgroundJobs').entries([
            job(own, GRANT), job(otherGrant, 'a1a1a1a1-0000-4000-8000-00000000000b'), job(noGrant, null)
        ]));
        const status = (body: Record<string, string>, headers: Record<string, string>) =>
            cap.axios.post(`${API}/getJobStatus`, body, { headers, validateStatus: () => true });

        const mine = await status({ jobId: own }, asToken);
        expect([mine.status, mine.data.jobId, mine.data.status]).toEqual([200, own, 'succeeded']);
        expect((await status({ jobId: otherGrant }, asToken)).status).toBe(404);
        expect((await status({ jobId: noGrant }, asToken)).status).toBe(404);
        // naming the session the job runs under works as before
        expect((await status({ jobId: own, sessionId: POOL }, asToken)).status).toBe(200);
        // the operator started all three
        for (const jobId of [own, otherGrant, noGrant]) expect((await status({ jobId }, asOperator)).status).toBe(200);
    });

    it('the operator still reads every own row, sessions and legacy rows included', async () => {
        const res = await get('Documents', asOperator);
        expect(res.status).toBe(200);
        const refs = res.data.value.map((r: any) => r.storageRef).sort();
        expect(refs).toEqual(['s3://private/legacy-row', 's3://private/other-session', 's3://private/own-session']);
    });
});
