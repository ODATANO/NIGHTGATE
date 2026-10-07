/**
 * Disclosure to token holders over real HTTP (cds.test boot, in-memory DB):
 * an issuer binds a text to a token type, the text must hash to the payload,
 * a claim proves a registered holding on the registry contract, revocation
 * and expiry close it, and the stored text never leaves the row in the clear.
 */
import cds from '@sap/cds';
import crypto from 'node:crypto';
import { blake2b } from '@noble/hashes/blake2b';
import { bytesToHex } from '@noble/hashes/utils';
(cds as any).env.requires.auth = {
    kind: 'basic',
    impl: '@odatano/cap-auth',
    users: {
        'issuer-lab': { password: 'lab-secret', roles: [] },
        'reader-x': { password: 'x-secret', roles: [] }
    }
};
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-encryption-key-for-holder-disclosure';
const cap = cds.test(__dirname + '/../..');
// The booted service runs the compiled modules: spy on what Node loaded.
/* eslint-disable @typescript-eslint/no-require-imports */
const registryModule = require('../../srv/submission/holder-registry');
const decodeWorker = require('../../srv/midnight/decode-worker-client');
const verifyState = require('../../srv/submission/verify-state');
const contractRegistry = require('../../srv/submission/contract-registry');
const { getNightgatePluginConfig } = require('../../srv/utils/nightgate-config');
/* eslint-enable @typescript-eslint/no-require-imports */

const API = '/api/v1/nightgate';
const TOKEN = 'ngat_' + 'e'.repeat(64);
const SESSION = 'c3c3c3c3-0000-4000-8000-000000000001';
const T = 'ab'.repeat(32);
const REGISTRY = 'dd'.repeat(32);
const SECRET = '11'.repeat(32);
const TEXT = '{"certificate":"copper-A","cu":99.97}';
const PAYLOAD = bytesToHex(blake2b(new TextEncoder().encode(TEXT), { dkLen: 32 }));
const asLab = { authorization: 'Basic ' + Buffer.from('issuer-lab:lab-secret').toString('base64') };
const asX = { authorization: 'Basic ' + Buffer.from('reader-x:x-secret').toString('base64') };
const asToken = { 'x-agent-token': TOKEN };

// The registry is read in the decode worker; the handler reaches it through this client function.
const readSpy = vi.spyOn(decodeWorker, 'readHolderRegistrationInWorker');
const liveSpy = vi.spyOn(verifyState, 'liveProviderConfigured');

async function post(action: string, body: Record<string, unknown>, headers: Record<string, string>) {
    return cap.axios.post(`${API}/${action}`, body, { headers, validateStatus: () => true });
}

describe('holder disclosure over HTTP', () => {
    beforeAll(async () => {
        contractRegistry.loadRegistryFromConfig(getNightgatePluginConfig());
        const db = await cds.connect.to('db');
        const now = new Date().toISOString();
        await db.run(cds.ql.INSERT.into('midnight.AgentGrants').entries({
            ID: cds.utils.uuid(), userId: 'reader-x', sessionId: SESSION, tokenHash: crypto.createHash('sha256').update(TOKEN).digest('hex'),
            allowedActions: JSON.stringify(['grantDisclosureToHolders']), isActive: true, createdAt: now, modifiedAt: now
        }));
    });
    beforeEach(() => {
        readSpy.mockReset();
        liveSpy.mockReset();
        liveSpy.mockReturnValue(true);
    });

    it('a grant needs a payload hash the content hashes to, and stores the text encrypted', async () => {
        const wrong = await post('grantDisclosureToHolders', { payloadHash: 'ff'.repeat(32), tokenType: T, registryAddress: REGISTRY, content: TEXT }, asLab);
        expect(wrong.status).toBe(400);
        const res = await post('grantDisclosureToHolders', { payloadHash: PAYLOAD, tokenType: T, registryAddress: REGISTRY, content: TEXT, contentType: 'application/json' }, asLab);
        expect(res.status).toBe(200);
        expect(res.data).toMatchObject({ payloadHash: PAYLOAD, tokenType: T, registryAddress: REGISTRY, hasContent: true, status: 'granted' });
        const db = await cds.connect.to('db');
        const row = await db.run(cds.ql.SELECT.one.from('midnight.HolderDisclosureGrants').where({ ID: res.data.holderGrantId }));
        expect(row.content).not.toContain('copper-A');
        expect(row.contentHashKind).toBe('blake2b-256');
        // the same grantor again: an update, not a second row
        const again = await post('grantDisclosureToHolders', { payloadHash: PAYLOAD, tokenType: T, registryAddress: REGISTRY, content: TEXT }, asLab);
        expect(again.data).toMatchObject({ holderGrantId: res.data.holderGrantId, status: 'updated' });
    });

    it('a claim proves the holding on the registry and reads the text; a stranger reads nothing', async () => {
        readSpy.mockImplementation(async (q: any) => ({ registered: q.claimKey === registryModule.holderClaimKey(SECRET), entry: '00'.repeat(32) }));
        const ok = await post('claimDisclosure', { payloadHash: PAYLOAD, tokenType: T, claimSecret: SECRET }, asX);
        expect(ok.status).toBe(200);
        expect(ok.data).toMatchObject({ entitled: true, registryAddress: REGISTRY, contentType: 'application/json', contentHashKind: 'blake2b-256', content: TEXT });
        expect(readSpy).toHaveBeenCalledWith(expect.objectContaining({ contractAddress: REGISTRY, tokenType: T, claimKey: registryModule.holderClaimKey(SECRET), artifactPath: expect.stringMatching(/holder-registry/) }));

        const stranger = await post('claimDisclosure', { payloadHash: PAYLOAD, tokenType: T, claimSecret: '22'.repeat(32) }, asX);
        expect(stranger.status).toBe(200);
        expect(stranger.data).toMatchObject({ entitled: false, reason: expect.stringMatching(/not registered as a holder/) });
        expect(stranger.data.content).toBeFalsy();

        // a token may claim without an allow-list entry
        const viaToken = await post('claimDisclosure', { payloadHash: PAYLOAD, tokenType: T, claimSecret: SECRET }, asToken);
        expect(viaToken.status).toBe(200);
        expect(viaToken.data.entitled).toBe(true);

        const unknown = await post('claimDisclosure', { payloadHash: 'ee'.repeat(32), tokenType: T, claimSecret: SECRET }, asX);
        expect(unknown.data).toMatchObject({ entitled: false, reason: expect.stringMatching(/no holder disclosure/) });
        expect((await post('claimDisclosure', { payloadHash: PAYLOAD, tokenType: T, claimSecret: 'short' }, asX)).status).toBe(400);
    });

    it('without a live indexer a claim is 503, not a false negative', async () => {
        liveSpy.mockReturnValue(false);
        expect((await post('claimDisclosure', { payloadHash: PAYLOAD, tokenType: T, claimSecret: SECRET }, asX)).status).toBe(503);
        expect(readSpy).not.toHaveBeenCalled();
    });

    it('an agent grant of the same user gets its own row and never takes over the user\'s grant', async () => {
        readSpy.mockResolvedValue({ registered: true, entry: '00'.repeat(32) });
        const db = await cds.connect.to('db');
        const labToken = 'ngat_' + 'f'.repeat(64);
        const now = new Date().toISOString();
        await db.run(cds.ql.INSERT.into('midnight.AgentGrants').entries({
            ID: cds.utils.uuid(), userId: 'issuer-lab', sessionId: SESSION, tokenHash: crypto.createHash('sha256').update(labToken).digest('hex'),
            allowedActions: JSON.stringify(['grantDisclosureToHolders', 'revokeHolderDisclosure']), isActive: true, createdAt: now, modifiedAt: now
        }));
        const type = 'ba'.repeat(32);
        const user = await post('grantDisclosureToHolders', { payloadHash: PAYLOAD, tokenType: type, registryAddress: REGISTRY, content: TEXT }, asLab);
        expect(user.status).toBe(200);
        const agent = await post('grantDisclosureToHolders', { payloadHash: PAYLOAD, tokenType: type, registryAddress: REGISTRY, expiresAt: new Date(Date.now() + 60_000).toISOString() }, { 'x-agent-token': labToken });
        expect(agent.status).toBe(200);
        expect(agent.data.holderGrantId).not.toBe(user.data.holderGrantId);
        expect(agent.data.status).toBe('granted');
        const userRow = await db.run(cds.ql.SELECT.one.from('midnight.HolderDisclosureGrants').where({ ID: user.data.holderGrantId }));
        expect(userRow.content).toBeTruthy();
        expect(userRow.grantorGrantId).toBeNull();
        expect((await post('revokeHolderDisclosure', { holderGrantId: user.data.holderGrantId }, { 'x-agent-token': labToken })).status).toBe(403);
        expect((await post('revokeHolderDisclosure', { holderGrantId: user.data.holderGrantId }, asLab)).data).toMatchObject({ status: 'revoked' });
    });

    it('among parallel grants a claim reads the one with content', async () => {
        readSpy.mockResolvedValue({ registered: true, entry: '00'.repeat(32) });
        const type = 'bc'.repeat(32);
        const agentToken = 'ngat_' + 'a'.repeat(64);
        const db = await cds.connect.to('db');
        const now = new Date().toISOString();
        await db.run(cds.ql.INSERT.into('midnight.AgentGrants').entries({
            ID: cds.utils.uuid(), userId: 'issuer-lab', sessionId: SESSION, tokenHash: crypto.createHash('sha256').update(agentToken).digest('hex'),
            allowedActions: JSON.stringify(['grantDisclosureToHolders']), isActive: true, createdAt: now, modifiedAt: now
        }));
        // The empty grant is newer and longer-lived; the content still wins.
        const full = await post('grantDisclosureToHolders', { payloadHash: PAYLOAD, tokenType: type, registryAddress: REGISTRY, content: TEXT, expiresAt: new Date(Date.now() + 60_000).toISOString() }, asLab);
        const empty = await post('grantDisclosureToHolders', { payloadHash: PAYLOAD, tokenType: type, registryAddress: REGISTRY }, { 'x-agent-token': agentToken });
        expect(full.status).toBe(200);
        expect(empty.status).toBe(200);
        const claim = await post('claimDisclosure', { payloadHash: PAYLOAD, tokenType: type, claimSecret: SECRET }, asX);
        expect(claim.data).toMatchObject({ entitled: true, holderGrantId: full.data.holderGrantId, content: TEXT });
    });

    it('an update without content keeps the stored text', async () => {
        readSpy.mockResolvedValue({ registered: true, entry: '00'.repeat(32) });
        const type = 'bb'.repeat(32);
        const first = await post('grantDisclosureToHolders', { payloadHash: PAYLOAD, tokenType: type, registryAddress: REGISTRY, content: TEXT }, asLab);
        const update = await post('grantDisclosureToHolders', { payloadHash: PAYLOAD, tokenType: type, registryAddress: REGISTRY, expiresAt: new Date(Date.now() + 60_000).toISOString() }, asLab);
        expect(update.data).toMatchObject({ holderGrantId: first.data.holderGrantId, status: 'updated', hasContent: true });
        const claim = await post('claimDisclosure', { payloadHash: PAYLOAD, tokenType: type, claimSecret: SECRET }, asX);
        expect(claim.data).toMatchObject({ entitled: true, content: TEXT });
    });

    it('only the grantor revokes; a revoked or expired grant answers no entitlement', async () => {
        readSpy.mockResolvedValue({ registered: true, entry: '00'.repeat(32) });
        const soon = new Date(Date.now() + 1500).toISOString();
        const short = await post('grantDisclosureToHolders', { payloadHash: PAYLOAD, tokenType: 'cd'.repeat(32), registryAddress: REGISTRY, expiresAt: soon }, asToken);
        expect(short.status).toBe(200);
        expect(short.data.hasContent).toBe(false);
        expect((await post('revokeHolderDisclosure', { holderGrantId: short.data.holderGrantId }, asLab)).status).toBe(403);
        let claim = await post('claimDisclosure', { payloadHash: PAYLOAD, tokenType: 'cd'.repeat(32), claimSecret: SECRET }, asX);
        expect(claim.data).toMatchObject({ entitled: true, content: null });
        await new Promise(r => setTimeout(r, 1600));
        claim = await post('claimDisclosure', { payloadHash: PAYLOAD, tokenType: 'cd'.repeat(32), claimSecret: SECRET }, asX);
        expect(claim.data).toMatchObject({ entitled: false, reason: expect.stringMatching(/expired/) });

        const lab = await post('grantDisclosureToHolders', { payloadHash: PAYLOAD, tokenType: 'ef'.repeat(32), registryAddress: REGISTRY, content: TEXT }, asLab);
        expect((await post('revokeHolderDisclosure', { holderGrantId: lab.data.holderGrantId }, asLab)).data).toMatchObject({ status: 'revoked' });
        claim = await post('claimDisclosure', { payloadHash: PAYLOAD, tokenType: 'ef'.repeat(32), claimSecret: SECRET }, asX);
        expect(claim.data).toMatchObject({ entitled: false, reason: expect.stringMatching(/no holder disclosure/) });
        expect((await post('revokeHolderDisclosure', { holderGrantId: '00000000-0000-4000-8000-000000000000' }, asLab)).status).toBe(404);
    });
});
