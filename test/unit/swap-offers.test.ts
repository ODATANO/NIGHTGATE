/**
 * The offer board over real HTTP (cds.test boot, the standalone image's
 * transport auth, in-memory DB): an operator and a token post maker halves,
 * takers list them by terms and tag, only the poster retires, the clock and
 * a landed nullifier close them, and the terms always come from the half.
 */
import cds from '@sap/cds';
import crypto from 'node:crypto';
(cds as any).env.requires.auth = {
    kind: 'basic',
    impl: '@odatano/cap-auth',
    users: {
        'operator-a': { password: 'a-secret', roles: [] },
        'operator-b': { password: 'b-secret', roles: [] }
    }
};
const cap = cds.test(__dirname + '/../..');
// The booted service runs the compiled module: spy on the one Node loaded, never on a vi.mock.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const workerClient = require('../../srv/midnight/wallet-worker-client');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const offersModule = require('../../srv/submission/swap-offers');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const boardStatusModule = require('../../srv/submission/board-status');

const API = '/api/v1/nightgate';
const TOKEN = 'ngat_' + 'd'.repeat(64);
const SESSION = 'b2b2b2b2-0000-4000-8000-000000000001';
const T_CERT = 'ab'.repeat(32);
const T_CREDIT = 'cd'.repeat(32);
const asA = { authorization: 'Basic ' + Buffer.from('operator-a:a-secret').toString('base64') };
const asB = { authorization: 'Basic ' + Buffer.from('operator-b:b-secret').toString('base64') };
const asToken = { 'x-agent-token': TOKEN };

function sha256Hex(s: string): string { return crypto.createHash('sha256').update(s).digest('hex'); }
/** A distinct "half": the spy reads its terms from the fixture, the server only needs valid base64. */
function halfText(seed: number): string { return Buffer.from(new Uint8Array(400).fill(seed)).toString('base64'); }
function nullifier(seed: number): string { return seed.toString(16).padStart(64, '0'); }

const describeSpy = vi.spyOn(workerClient, 'walletDescribeSwapHalf');
function describeAs(terms: { gives: [string, string]; wants: [string, string]; bound?: boolean; nullifiers?: string[] }) {
    describeSpy.mockImplementationOnce(async () => ({
        gives: { tokenType: terms.gives[0], amount: terms.gives[1] },
        wants: { tokenType: terms.wants[0], amount: terms.wants[1] },
        bound: terms.bound ?? true, inputs: 1, nullifiers: terms.nullifiers ?? [nullifier(1)]
    }));
}

async function post(action: string, body: Record<string, unknown>, headers: Record<string, string>) {
    return cap.axios.post(`${API}/${action}`, body, { headers, validateStatus: () => true });
}
async function list(params: Record<string, string | number | boolean | null>, headers: Record<string, string>) {
    const args = Object.entries({ givesType: null, wantsType: null, tag: null, limit: null, status: null, since: null, mine: null, ...params })
        .map(([k, v]) => `${k}=${v === null ? 'null' : typeof v === 'number' || typeof v === 'boolean' ? v : `'${v}'`}`).join(',');
    return cap.axios.get(`${API}/listSwapOffers(${args})`, { headers, validateStatus: () => true });
}
async function getOffer(offerId: string, headers: Record<string, string>) {
    return cap.axios.get(`${API}/getSwapOffer(offerId=${offerId})`, { headers, validateStatus: () => true });
}

describe('offer board over HTTP', () => {
    beforeAll(async () => {
        const db = await cds.connect.to('db');
        const now = new Date().toISOString();
        await db.run(cds.ql.INSERT.into('midnight.AgentGrants').entries({
            ID: cds.utils.uuid(), userId: 'operator-b', sessionId: SESSION, tokenHash: sha256Hex(TOKEN),
            allowedActions: JSON.stringify(['postSwapOffer', 'retireSwapOffer']), isActive: true, createdAt: now, modifiedAt: now
        }));
    });
    afterEach(() => { describeSpy.mockReset(); });

    it('a posted half is recorded with the terms the worker read, never the caller\'s', async () => {
        describeAs({ gives: [T_CERT, '1'], wants: [T_CREDIT, '250'], nullifiers: [nullifier(11)] });
        const res = await post('postSwapOffer', { offer: halfText(1), tags: JSON.stringify(['cert', 'copper']) }, asA);
        expect(res.status).toBe(200);
        expect(res.data).toMatchObject({ status: 'open', bound: true, givesType: T_CERT, givesAmount: '1', wantsType: T_CREDIT, wantsAmount: '250', expiresAt: null });
        expect(describeSpy).toHaveBeenCalledWith({ halfB64: halfText(1) });

        const listed = await list({ wantsType: T_CREDIT }, asB);
        expect(listed.status).toBe(200);
        const mine = listed.data.value.find((o: any) => o.offerId === res.data.offerId);
        expect(mine).toMatchObject({ offer: halfText(1), givesType: T_CERT, wantsAmount: '250', tags: JSON.stringify(['cert', 'copper']) });
        expect(mine).not.toHaveProperty('posterUserId');
        expect(mine).not.toHaveProperty('nullifiers');
    });

    it('refuses what is not a swap half, a damaged offer file, bad tags and a past expiry before the worker is asked', async () => {
        expect((await post('postSwapOffer', { offer: 'hello world!' }, asA)).status).toBe(400);
        expect((await post('postSwapOffer', { offer: halfText(2), tags: JSON.stringify(Array.from({ length: 9 }, (_, i) => `t${i}`)) }, asA)).status).toBe(400);
        expect((await post('postSwapOffer', { offer: halfText(2), expiresAt: '2001-01-01T00:00:00Z' }, asA)).status).toBe(400);
        expect(describeSpy).not.toHaveBeenCalled();

        const { SponsorRefusalError } = require('../../srv/midnight/submit-error-classification');
        describeSpy.mockImplementationOnce(async () => { throw new SponsorRefusalError('not a swap half: the half carries an intent (a contract call, unshielded value or dust actions)'); });
        const refused = await post('postSwapOffer', { offer: halfText(2) }, asA);
        expect(refused.status).toBe(400);
        expect(JSON.stringify(refused.data)).toMatch(/SWAP_OFFER_INVALID|carries an intent/);
    });

    it('lists by gives/wants type and by tag, newest first, within the limit', async () => {
        describeAs({ gives: [T_CREDIT, '250'], wants: [T_CERT, '1'], nullifiers: [nullifier(21)] });
        const first = await post('postSwapOffer', { offer: halfText(3), tags: '["buyback"]' }, asA);
        describeAs({ gives: [T_CREDIT, '300'], wants: [T_CERT, '1'], nullifiers: [nullifier(22)] });
        const second = await post('postSwapOffer', { offer: halfText(4), tags: '["buyback"]' }, asA);
        expect(first.status).toBe(200); expect(second.status).toBe(200);

        const byGives = await list({ givesType: T_CREDIT, tag: 'buyback' }, asA);
        expect(byGives.data.value.map((o: any) => o.offerId)).toEqual([second.data.offerId, first.data.offerId]);
        const limited = await list({ givesType: T_CREDIT, tag: 'buyback', limit: 1 }, asA);
        expect(limited.data.value.map((o: any) => o.offerId)).toEqual([second.data.offerId]);
        expect((await list({ givesType: 'zz' }, asA)).status).toBe(400);
        expect((await list({ limit: 0 }, asA)).status).toBe(400);
    });

    it('only the poster retires; a token retires its own grant\'s offers and reads the board without an allow-list entry', async () => {
        describeAs({ gives: [T_CERT, '1'], wants: [T_CREDIT, '10'], nullifiers: [nullifier(31)] });
        const byToken = await post('postSwapOffer', { offer: halfText(5) }, asToken);
        expect(byToken.status).toBe(200);
        describeAs({ gives: [T_CERT, '1'], wants: [T_CREDIT, '11'], nullifiers: [nullifier(32)] });
        const byA = await post('postSwapOffer', { offer: halfText(6) }, asA);

        expect((await list({ wantsType: T_CREDIT }, asToken)).status).toBe(200);
        // operator-b owns the token's grant but did not post under its own name: not the poster
        expect((await post('retireSwapOffer', { offerId: byToken.data.offerId }, asB)).status).toBe(403);
        expect((await post('retireSwapOffer', { offerId: byA.data.offerId }, asToken)).status).toBe(403);
        expect((await post('retireSwapOffer', { offerId: byToken.data.offerId }, asToken)).status).toBe(200);
        expect((await post('retireSwapOffer', { offerId: byA.data.offerId }, asA)).data).toMatchObject({ status: 'retired' });
        // retired twice: not open any more
        expect((await post('retireSwapOffer', { offerId: byA.data.offerId }, asA)).status).toBe(409);
        expect((await post('retireSwapOffer', { offerId: '00000000-0000-4000-8000-000000000000' }, asA)).status).toBe(404);
        const open = await list({ wantsType: T_CREDIT }, asA);
        expect(open.data.value.map((o: any) => o.offerId)).not.toContain(byA.data.offerId);
    });

    it('an expired offer leaves the board and cannot be retired or filled', async () => {
        describeAs({ gives: [T_CERT, '1'], wants: [T_CREDIT, '12'], nullifiers: [nullifier(41)] });
        const soon = new Date(Date.now() + 1500).toISOString();
        const res = await post('postSwapOffer', { offer: halfText(7), expiresAt: soon }, asA);
        expect(res.status).toBe(200);
        expect((await list({ wantsType: T_CREDIT }, asA)).data.value.map((o: any) => o.offerId)).toContain(res.data.offerId);
        await new Promise(r => setTimeout(r, 1600));
        expect((await list({ wantsType: T_CREDIT }, asA)).data.value.map((o: any) => o.offerId)).not.toContain(res.data.offerId);
        expect((await post('retireSwapOffer', { offerId: res.data.offerId }, asA)).status).toBe(409);
        const db = await cds.connect.to('db');
        const row = await db.run(cds.ql.SELECT.one.from('midnight.SwapOffers').where({ ID: res.data.offerId }));
        expect(row.status).toBe('expired');
    });

    it('newer expired offers never push an open one out of the limit', async () => {
        const type = 'f1'.repeat(32);
        describeAs({ gives: [type, '1'], wants: [T_CREDIT, '21'], nullifiers: [nullifier(61)] });
        const open = await post('postSwapOffer', { offer: halfText(21), tags: JSON.stringify(['scarce']) }, asA);
        const soon = new Date(Date.now() + 1500).toISOString();
        for (const seed of [62, 63]) {
            describeAs({ gives: [type, '1'], wants: [T_CREDIT, '22'], nullifiers: [nullifier(seed)] });
            expect((await post('postSwapOffer', { offer: halfText(seed), expiresAt: soon, tags: JSON.stringify(['scarce']) }, asA)).status).toBe(200);
        }
        await new Promise(r => setTimeout(r, 1600));
        expect((await list({ givesType: type, limit: 1 }, asA)).data.value.map((o: any) => o.offerId)).toEqual([open.data.offerId]);
        expect((await list({ givesType: type, tag: 'scarce', limit: 1 }, asA)).data.value.map((o: any) => o.offerId)).toEqual([open.data.offerId]);
    });

    it('a landed nullifier closes every open half that spent it', async () => {
        const shared = nullifier(51);
        describeAs({ gives: [T_CERT, '1'], wants: [T_CREDIT, '13'], nullifiers: [shared, nullifier(52)] });
        const a = await post('postSwapOffer', { offer: halfText(8) }, asA);
        describeAs({ gives: [T_CERT, '1'], wants: [T_CREDIT, '14'], nullifiers: [shared] });
        const b = await post('postSwapOffer', { offer: halfText(9) }, asA);
        describeAs({ gives: [T_CERT, '1'], wants: [T_CREDIT, '15'], nullifiers: [nullifier(53)] });
        const c = await post('postSwapOffer', { offer: halfText(10) }, asA);
        const db = await cds.connect.to('db');
        const closed = await offersModule.closeSwapOffersByNullifiers(db, [shared.toUpperCase(), 'junk'], 'ee'.repeat(32));
        expect(closed.sort()).toEqual([a.data.offerId, b.data.offerId].sort());
        const rows = await db.run(cds.ql.SELECT.from('midnight.SwapOffers').columns('ID', 'status', 'filledTxHash').where({ ID: [a.data.offerId, b.data.offerId, c.data.offerId] }));
        const byId = Object.fromEntries(rows.map((r: any) => [r.ID, r]));
        expect(byId[a.data.offerId]).toMatchObject({ status: 'filled', filledTxHash: 'ee'.repeat(32) });
        expect(byId[b.data.offerId].status).toBe('filled');
        expect(byId[c.data.offerId].status).toBe('open');
        // closing again is a no-op
        expect(await offersModule.closeSwapOffersByNullifiers(db, [shared], 'ff'.repeat(32))).toEqual([]);
    });

    it("getSwapOffer reads one offer by id in the board's shape, open or closed, for every token", async () => {
        describeAs({ gives: [T_CERT, '1'], wants: [T_CREDIT, '70'], nullifiers: [nullifier(71)] });
        const posted = await post('postSwapOffer', { offer: halfText(31), tags: '["single"]' }, asA);
        expect(posted.status).toBe(200);
        const open = await getOffer(posted.data.offerId, asToken);
        expect(open.status).toBe(200);
        expect(open.data).toMatchObject({ offerId: posted.data.offerId, offer: halfText(31), status: 'open', wantsAmount: '70', tags: '["single"]', filledTxHash: null, closedAt: null });
        expect(open.data).not.toHaveProperty('posterUserId');
        expect(open.data.changedAt).toBeTruthy();

        const db = await cds.connect.to('db');
        await offersModule.closeSwapOffersByNullifiers(db, [nullifier(71)], 'ab'.repeat(32));
        const filled = await getOffer(posted.data.offerId, asB);
        expect(filled.data).toMatchObject({ status: 'filled', filledTxHash: 'ab'.repeat(32) });
        expect(filled.data.closedAt).toBeTruthy();
        expect((await getOffer('00000000-0000-4000-8000-000000000000', asA)).status).toBe(404);
    });

    it("lists closed offers by status, every change since an instant, and the caller's own posts", async () => {
        const type = 'e2'.repeat(32);
        const before = new Date(Date.now() - 1).toISOString();
        describeAs({ gives: [type, '1'], wants: [T_CREDIT, '81'], nullifiers: [nullifier(81)] });
        const toFill = await post('postSwapOffer', { offer: halfText(41) }, asA);
        describeAs({ gives: [type, '1'], wants: [T_CREDIT, '82'], nullifiers: [nullifier(82)] });
        const toRetire = await post('postSwapOffer', { offer: halfText(42) }, asToken);
        describeAs({ gives: [type, '1'], wants: [T_CREDIT, '83'], nullifiers: [nullifier(83)] });
        const stays = await post('postSwapOffer', { offer: halfText(43) }, asA);
        describeAs({ gives: [type, '1'], wants: [T_CREDIT, '84'], nullifiers: [nullifier(84)] });
        const soon = new Date(Date.now() + 1200).toISOString();
        const expiring = await post('postSwapOffer', { offer: halfText(44), expiresAt: soon }, asA);
        const db = await cds.connect.to('db');
        await offersModule.closeSwapOffersByNullifiers(db, [nullifier(81)], 'cd'.repeat(32));
        expect((await post('retireSwapOffer', { offerId: toRetire.data.offerId }, asToken)).status).toBe(200);
        await new Promise(r => setTimeout(r, 1300));

        const ids = (res: any) => res.data.value.map((o: any) => o.offerId);
        expect(ids(await list({ givesType: type }, asB))).toEqual([stays.data.offerId]);
        expect(ids(await list({ givesType: type, status: 'filled' }, asB))).toEqual([toFill.data.offerId]);
        expect(ids(await list({ givesType: type, status: 'retired' }, asB))).toEqual([toRetire.data.offerId]);
        // not yet stamped by a write path: the clock alone makes it expired
        const expired = await list({ givesType: type, status: 'expired' }, asB);
        expect(ids(expired)).toEqual([expiring.data.offerId]);
        expect(expired.data.value[0].status).toBe('expired');
        expect(ids(await list({ givesType: type, status: 'all' }, asB)).sort()).toEqual(
            [toFill, toRetire, stays, expiring].map(r => r.data.offerId).sort());
        expect(ids(await list({ givesType: type, status: 'all', since: before }, asB))).toHaveLength(4);
        expect(ids(await list({ givesType: type, status: 'all', since: new Date(Date.now() + 60_000).toISOString() }, asB))).toEqual([]);
        // the clock-expired offer changed at expiresAt, never stamped: a feed started after its post still sees it
        const afterPosts = new Date(Date.parse(expiring.data.expiresAt) - 500).toISOString();
        const late = await list({ givesType: type, status: 'all', since: afterPosts }, asB);
        expect(ids(late)).toContain(expiring.data.offerId);
        expect(late.data.value.find((o: any) => o.offerId === expiring.data.offerId)).toMatchObject({ status: 'expired', changedAt: expiring.data.expiresAt });
        // the change log: a fill moves the offer up front
        const changes = await list({ givesType: type, status: 'all' }, asB);
        expect(changes.data.value[0].status).not.toBe('open');
        expect((await list({ givesType: type, status: 'bogus' }, asB)).status).toBe(400);
        expect((await list({ givesType: type, since: 'yesterday' }, asB)).status).toBe(400);

        // mine: the token sees its grant's posts, operator-a its own, operator-b (the grant's owner) nothing
        expect(ids(await list({ givesType: type, status: 'all', mine: true }, asToken))).toEqual([toRetire.data.offerId]);
        expect(ids(await list({ givesType: type, status: 'all', mine: true }, asA)).sort()).toEqual(
            [toFill, stays, expiring].map(r => r.data.offerId).sort());
        expect(ids(await list({ givesType: type, status: 'all', mine: true }, asB))).toEqual([]);
    });

    it('getBoardStatus counts open and filled offers for an anonymous reader, nothing else', async () => {
        const type = 'd4'.repeat(32);
        boardStatusModule.__resetBoardStatusForTests();
        const before = await cap.axios.get('/api/v1/indexer/getBoardStatus()', { validateStatus: () => true });
        expect(before.status).toBe(200);
        describeAs({ gives: [type, '1'], wants: [T_CREDIT, '91'], nullifiers: [nullifier(91)] });
        const a = await post('postSwapOffer', { offer: halfText(51) }, asA);
        describeAs({ gives: [type, '1'], wants: [T_CREDIT, '92'], nullifiers: [nullifier(92)] });
        await post('postSwapOffer', { offer: halfText(52) }, asA);
        const db = await cds.connect.to('db');
        await offersModule.closeSwapOffersByNullifiers(db, [nullifier(91)], 'ba'.repeat(32));
        // the figures are memoized for a few seconds: a repeat read within them is the same answer
        const memo = await cap.axios.get('/api/v1/indexer/getBoardStatus()', { validateStatus: () => true });
        expect(memo.data).toEqual(before.data);
        boardStatusModule.__resetBoardStatusForTests();
        const after = await cap.axios.get('/api/v1/indexer/getBoardStatus()', { validateStatus: () => true });
        expect(after.status).toBe(200);
        expect(after.data.openOffers - before.data.openOffers).toBe(1);
        expect(after.data.offersFilledToday - before.data.offersFilledToday).toBe(1);
        expect(after.data).toMatchObject({ swapsToday: 0, sponsorsConfigured: 0, sponsorsReady: 0 });
        expect(Object.keys(after.data).sort()).toEqual(['@odata.context', 'asOf', 'offersFilledToday', 'openOffers', 'sponsorsConfigured', 'sponsorsReady', 'swapsToday']);
        expect(a.status).toBe(200);
    });
});
