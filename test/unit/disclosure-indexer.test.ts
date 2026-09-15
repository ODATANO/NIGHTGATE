/**
 * Tests for srv/submission/disclosure-indexer.ts.
 *
 * Exercises the decode/enumerate logic and the reindex upsert+sweep against a
 * FAKE `ledger()`-shaped object, crucially one whose outer `disclosures` map
 * is NOT iterable (only member/lookup), mirroring the real compiled artifact.
 * No SDK, no chain.
 */
import { enumerateGrants, reindexDisclosures, queryIndexerTipHeight } from '../../srv/submission/disclosure-indexer';

// ---- fake ledger builder --------------------------------------------------

const b = (fill: number) => new Uint8Array(32).fill(fill);
const hx = (u: Uint8Array) => Buffer.from(u).toString('hex');

/**
 * Build a fake decoded ledger. `records` maps a record-key fill to
 * { owner fill, payload fill, grants: [granteeFill, level][] }. The outer
 * `disclosures` object deliberately has NO [Symbol.iterator]; the
 * `attestations` map iterates [record key, { payload_hash, owner }].
 */
function makeLedger(records: Record<number, { owner: number; payload: number; grants: Array<[number, number]> }>) {
    const keys = Object.keys(records).map(Number);
    const innerFor = (keyFill: number) => {
        const entries = records[keyFill].grants.map(([gFill, lvl]) => [b(gFill), BigInt(lvl)] as [Uint8Array, bigint]);
        return {
            member: (k: Uint8Array) => entries.some(([g]) => hx(g) === hx(k)),
            lookup: (k: Uint8Array) => entries.find(([g]) => hx(g) === hx(k))![1],
            [Symbol.iterator]: () => entries[Symbol.iterator]()
        };
    };
    return {
        attestations: {
            [Symbol.iterator]: () =>
                keys.map(f => [b(f), { payload_hash: b(records[f].payload), owner: b(records[f].owner) }] as [Uint8Array, unknown])[Symbol.iterator]()
        },
        disclosures: {
            // NO Symbol.iterator on purpose; matches the real artifact.
            member: (k: Uint8Array) => keys.some(f => hx(b(f)) === hx(k) && records[f].grants.length > 0),
            lookup: (k: Uint8Array) => innerFor(keys.find(f => hx(b(f)) === hx(k))!)
        }
    } as any;
}

const ATTESTER = 0x01;
const A_HEX = hx(b(ATTESTER));
const PAYLOAD_AA = hx(b(0xaa));

describe('enumerateGrants', () => {
    test('outer disclosures map is treated as non-iterable (uses attestations)', () => {
        const led = makeLedger({ 0x50: { owner: ATTESTER, payload: 0xaa, grants: [[0xcc, 1]] } });
        expect(typeof (led.disclosures as any)[Symbol.iterator]).toBe('undefined');
        const rows = enumerateGrants(led);
        expect(rows).toEqual([{ attesterId: A_HEX, payloadHash: PAYLOAD_AA, grantee: hx(b(0xcc)), level: 1 }]);
    });

    test('returns empty when no grants', () => {
        expect(enumerateGrants(makeLedger({ 0x50: { owner: ATTESTER, payload: 0xaa, grants: [] } }))).toEqual([]);
    });

    test('enumerates multiple grantees across multiple records, attester from the record', () => {
        const led = makeLedger({
            0x51: { owner: ATTESTER, payload: 0x01, grants: [[0x10, 0], [0x11, 2]] },
            0x52: { owner: 0x02, payload: 0x01, grants: [[0x20, 1]] }
        });
        const rows = enumerateGrants(led);
        expect(rows).toHaveLength(3);
        expect(rows).toContainEqual({ attesterId: hx(b(0x02)), payloadHash: hx(b(0x01)), grantee: hx(b(0x20)), level: 1 });
        expect(rows).toContainEqual({ attesterId: A_HEX, payloadHash: hx(b(0x01)), grantee: hx(b(0x11)), level: 2 });
    });

    test('skips records with no disclosures entry', () => {
        const led = makeLedger({
            0x51: { owner: ATTESTER, payload: 0x01, grants: [[0x10, 1]] },
            0x53: { owner: ATTESTER, payload: 0x03, grants: [] }
        });
        expect(enumerateGrants(led)).toEqual([
            { attesterId: A_HEX, payloadHash: hx(b(0x01)), grantee: hx(b(0x10)), level: 1 }
        ]);
    });
});

// ---- reindexDisclosures (upsert + sweep) ----------------------------------
// Driven with a SEQUENCED db mock: reindex issues queries in a deterministic
// order, so we classify each call by its stable top-level CQN key
// (INSERT/UPDATE/SELECT) and feed return values in sequence.

const classify = (q: any) => q?.INSERT ? 'INSERT' : q?.UPDATE ? 'UPDATE' : q?.SELECT ? 'SELECT' : '?';
const setOf = (upd: any) => JSON.stringify(upd.UPDATE.data ?? upd.UPDATE.with);

function seqDb(responses: any[]) {
    const calls: any[] = [];
    const queue = [...responses];
    const run = vi.fn(async (q: any) => { calls.push(q); return queue.shift(); });
    return { run, calls };
}

const oneGrant = () => makeLedger({ 0x50: { owner: ATTESTER, payload: 0xaa, grants: [[0xcc, 1]] } });
const noGrants = () => makeLedger({ 0x50: { owner: ATTESTER, payload: 0xaa, grants: [] } });

describe('reindexDisclosures', () => {
    const CONTRACT = '0xvault';

    test('returns zero and never decodes when contract state is null', async () => {
        const db = seqDb([]);
        const ledger = vi.fn(() => { throw new Error('should not decode'); });
        const res = await reindexDisclosures({
            db, contractAddress: CONTRACT, ledger, queryContractState: async () => null
        });
        expect(res).toEqual({ indexed: 0, deactivated: 0, snapshotHeight: null });
        expect(ledger).not.toHaveBeenCalled();
        expect(db.run).not.toHaveBeenCalled();
    });

    test('inserts a new on-chain grant as active with attester and snapshot height', async () => {
        // order: SELECT.one existing → INSERT → SELECT active rows
        const db = seqDb([undefined, undefined, []]);
        const res = await reindexDisclosures({
            db, contractAddress: CONTRACT, ledger: () => oneGrant(),
            queryContractState: async () => ({ data: {} }), atHeight: 500
        });
        expect(res).toEqual({ indexed: 1, deactivated: 0, snapshotHeight: 500 });

        const existingSelect = db.calls.find(c => classify(c) === 'SELECT');
        expect(JSON.stringify(existingSelect.SELECT.where)).toContain(A_HEX);
        const insert = db.calls.find(c => classify(c) === 'INSERT');
        expect(insert.INSERT.entries[0]).toMatchObject({
            contractAddress: CONTRACT, attesterId: A_HEX, payloadHash: PAYLOAD_AA,
            grantee: hx(b(0xcc)), level: 1, active: true, changedAtHeight: 500
        });
        expect(db.calls.some(c => classify(c) === 'UPDATE')).toBe(false);
    });

    test('updates an existing optimistic row to active=true (no duplicate insert)', async () => {
        const existing = { ID: 'row-1', grantedTxHash: '0xabc', active: false };
        const db = seqDb([existing, undefined, []]);
        await reindexDisclosures({
            db, contractAddress: CONTRACT, ledger: () => oneGrant(),
            queryContractState: async () => ({ data: {} })
        });

        expect(db.calls.some(c => classify(c) === 'INSERT')).toBe(false);
        const upd = db.calls.find(c => classify(c) === 'UPDATE');
        // The UPDATE flips active and re-affirms level; grantedTxHash untouched.
        expect(setOf(upd)).toContain('"active":true');
        expect(setOf(upd)).not.toContain('grantedTxHash');
    });

    test('the snapshot is read at the given height and stamps the rows it changes', async () => {
        const queryContractState = vi.fn(async () => ({ data: {} }));
        const existing = { ID: 'row-1', active: false, changedAtHeight: 400 };
        const db = seqDb([existing, undefined, []]);
        await reindexDisclosures({ db, contractAddress: CONTRACT, ledger: () => oneGrant(), queryContractState, atHeight: 500 });
        expect(queryContractState).toHaveBeenCalledWith(CONTRACT, 500);
        expect(setOf(db.calls.find(c => classify(c) === 'UPDATE'))).toContain('"changedAtHeight":500');
    });

    test('falls back to the indexer tip when no height is given', async () => {
        const queryContractState = vi.fn(async () => ({ data: {} }));
        const db = seqDb([undefined, undefined, []]);
        const res = await reindexDisclosures({
            db, contractAddress: CONTRACT, ledger: () => oneGrant(), queryContractState,
            queryTipHeight: async () => 777
        });
        expect(queryContractState).toHaveBeenCalledWith(CONTRACT, 777);
        expect(res.snapshotHeight).toBe(777);
    });

    test('a snapshot older than the row never revives a revoked grant', async () => {
        // The revoke landed at 600; a reindex that read the ledger at 590 still
        // sees the grant. It must not flip the row back or clear the marker.
        const revoked = { ID: 'row-1', active: false, revokedTxHash: '0xrevoke', changedAtHeight: 600 };
        const db = seqDb([revoked, []]);
        const res = await reindexDisclosures({
            db, contractAddress: CONTRACT, ledger: () => oneGrant(),
            queryContractState: async () => ({ data: {} }), atHeight: 590
        });
        expect(res.indexed).toBe(1);
        expect(db.calls.some(c => classify(c) === 'UPDATE')).toBe(false);
    });

    test('a snapshot older than the row never rolls a level back', async () => {
        const downgraded = { ID: 'row-1', active: true, level: 1, changedAtHeight: 600 };
        const db = seqDb([downgraded, [{ ...downgraded, attesterId: A_HEX, payloadHash: PAYLOAD_AA, grantee: hx(b(0xcc)) }]]);
        await reindexDisclosures({
            db, contractAddress: CONTRACT, ledger: () => makeLedger({ 0x50: { owner: ATTESTER, payload: 0xaa, grants: [[0xcc, 2]] } }),
            queryContractState: async () => ({ data: {} }), atHeight: 590
        });
        expect(db.calls.some(c => classify(c) === 'UPDATE')).toBe(false);
    });

    test('an unordered snapshot never revives a confirmed revoke', async () => {
        const revoked = { ID: 'row-1', active: false, revokedTxHash: '0xrevoke', changedAtHeight: 600 };
        const db = seqDb([revoked, []]);
        await reindexDisclosures({
            db, contractAddress: CONTRACT, ledger: () => oneGrant(),
            queryContractState: async () => ({ data: {} })
        });
        expect(db.calls.some(c => classify(c) === 'UPDATE')).toBe(false);
    });

    test('a snapshot at or past the row applies the on-chain grant', async () => {
        const revoked = { ID: 'row-1', active: false, revokedTxHash: '0xrevoke', changedAtHeight: 600 };
        const db = seqDb([revoked, undefined, []]);
        await reindexDisclosures({
            db, contractAddress: CONTRACT, ledger: () => oneGrant(),
            queryContractState: async () => ({ data: {} }), atHeight: 600
        });
        const upd = db.calls.find(c => classify(c) === 'UPDATE');
        expect(setOf(upd)).toContain('"active":true');
        expect(setOf(upd)).toContain('"revokedTxHash":null');
    });

    test('the upsert is a compare-and-set on the height the row was read at (a revoke confirmed in between is kept)', async () => {
        const existing = { ID: 'row-1', active: true, level: 1, changedAtHeight: 400 };
        const db = seqDb([existing, undefined, []]);
        await reindexDisclosures({
            db, contractAddress: CONTRACT, ledger: () => oneGrant(),
            queryContractState: async () => ({ data: {} }), atHeight: 500
        });
        const upd = db.calls.find(c => classify(c) === 'UPDATE');
        expect(upd.UPDATE.where).toEqual(expect.arrayContaining([{ ref: ['ID'] }, { val: 'row-1' }, { ref: ['changedAtHeight'] }, { val: 400 }]));
    });

    test('the upsert of a row without a height matches only while it still has none', async () => {
        const existing = { ID: 'row-1', active: false };
        const db = seqDb([existing, undefined, []]);
        await reindexDisclosures({
            db, contractAddress: CONTRACT, ledger: () => oneGrant(),
            queryContractState: async () => ({ data: {} }), atHeight: 500
        });
        const upd = db.calls.find(c => classify(c) === 'UPDATE');
        expect(JSON.stringify(upd.UPDATE.where)).toContain('"changedAtHeight"');
        expect(upd.UPDATE.where).toEqual(expect.arrayContaining([{ val: null }]));
    });

    test('sweeps a previously-active row no longer on-chain to active=false', async () => {
        const stale = { ID: 'stale', attesterId: A_HEX, payloadHash: PAYLOAD_AA, grantee: hx(b(0xcc)) };
        // onChain empty → no per-grant calls. order: SELECT active rows → UPDATE
        const db = seqDb([[stale], undefined]);
        const res = await reindexDisclosures({
            db, contractAddress: CONTRACT, ledger: () => noGrants(),
            queryContractState: async () => ({ data: {} })
        });
        expect(res).toEqual({ indexed: 0, deactivated: 1, snapshotHeight: null });
        expect(setOf(db.calls.find(c => classify(c) === 'UPDATE'))).toContain('"active":false');
    });

    test('does not sweep a still-present grant (seen on-chain)', async () => {
        const present = { ID: 'live', attesterId: A_HEX, payloadHash: PAYLOAD_AA, grantee: hx(b(0xcc)) };
        const db = seqDb([undefined, undefined, [present]]);
        const res = await reindexDisclosures({
            db, contractAddress: CONTRACT, ledger: () => oneGrant(),
            queryContractState: async () => ({ data: {} })
        });
        expect(res.deactivated).toBe(0);
        expect(db.calls.filter(c => classify(c) === 'UPDATE')).toHaveLength(0);
    });

    test('the same payload granted by another attester is a different row', async () => {
        // Only attester 0x02's grant is on-chain; attester 0x01's active row for
        // the same payload and grantee is gone from the chain and is swept.
        const led = makeLedger({ 0x52: { owner: 0x02, payload: 0xaa, grants: [[0xcc, 1]] } });
        const mine = { ID: 'mine', attesterId: A_HEX, payloadHash: PAYLOAD_AA, grantee: hx(b(0xcc)), modifiedAt: '2020-01-01T00:00:00.000Z' };
        const db = seqDb([undefined, undefined, [mine], undefined]);
        const res = await reindexDisclosures({
            db, contractAddress: CONTRACT, ledger: () => led,
            queryContractState: async () => ({ data: {} })
        });
        expect(res).toMatchObject({ indexed: 1, deactivated: 1 });
    });

    test('scopes the active-rows sweep query to the contract', async () => {
        const db = seqDb([[], undefined]);
        await reindexDisclosures({
            db, contractAddress: CONTRACT, ledger: () => noGrants(),
            queryContractState: async () => ({ data: {} })
        });
        const activeSelect = db.calls.find(c => classify(c) === 'SELECT');
        expect(JSON.stringify(activeSelect.SELECT.where)).toContain(CONTRACT);
    });

    test('normalizes contractAddress to lowercase in queries and inserts', async () => {
        const db = seqDb([undefined, undefined, []]);
        await reindexDisclosures({
            db, contractAddress: '0xVaUlT', ledger: () => oneGrant(),
            queryContractState: async () => ({ data: {} })
        });
        const insert = db.calls.find(c => classify(c) === 'INSERT');
        expect(insert.INSERT.entries[0].contractAddress).toBe('0xvault');
        for (const c of db.calls.filter(x => classify(x) === 'SELECT')) {
            expect(JSON.stringify(c.SELECT.where)).not.toContain('0xVaUlT');
        }
    });

    test('does not sweep a row modified within the grace window (stale-read protection)', async () => {
        const fresh = {
            ID: 'fresh', attesterId: A_HEX, payloadHash: PAYLOAD_AA, grantee: hx(b(0xcc)),
            modifiedAt: new Date().toISOString()
        };
        const db = seqDb([[fresh]]);
        const res = await reindexDisclosures({
            db, contractAddress: CONTRACT, ledger: () => noGrants(),
            queryContractState: async () => ({ data: {} })
        });
        expect(res.deactivated).toBe(0);
        expect(db.calls.some(c => classify(c) === 'UPDATE')).toBe(false);
    });

    test('sweeps a row whose modifiedAt is older than the grace window', async () => {
        const old = {
            ID: 'old', attesterId: A_HEX, payloadHash: PAYLOAD_AA, grantee: hx(b(0xcc)),
            modifiedAt: new Date(Date.now() - 11 * 60 * 1000).toISOString()
        };
        const db = seqDb([[old], undefined]);
        const res = await reindexDisclosures({
            db, contractAddress: CONTRACT, ledger: () => noGrants(),
            queryContractState: async () => ({ data: {} })
        });
        expect(res.deactivated).toBe(1);
    });

    test('a row with a recorded height is ordered by height, not by the grace window', async () => {
        const landedBefore = {
            ID: 'before', attesterId: A_HEX, payloadHash: PAYLOAD_AA, grantee: hx(b(0xcc)),
            modifiedAt: new Date().toISOString(), changedAtHeight: 590
        };
        const landedAfter = {
            ID: 'after', attesterId: A_HEX, payloadHash: PAYLOAD_AA, grantee: hx(b(0xcd)),
            modifiedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(), changedAtHeight: 610
        };
        const db = seqDb([[landedBefore, landedAfter], undefined]);
        const res = await reindexDisclosures({
            db, contractAddress: CONTRACT, ledger: () => noGrants(),
            queryContractState: async () => ({ data: {} }), atHeight: 600
        });
        // 'before' landed under the snapshot and is absent from it: revoked.
        // 'after' landed past the snapshot: the snapshot cannot know it.
        expect(res.deactivated).toBe(1);
        const upd = db.calls.find(c => classify(c) === 'UPDATE');
        expect(JSON.stringify(upd.UPDATE.where)).toContain('before');
    });

    test('sweepGraceMs=0 sweeps regardless of modifiedAt', async () => {
        const fresh = {
            ID: 'fresh', attesterId: A_HEX, payloadHash: PAYLOAD_AA, grantee: hx(b(0xcc)),
            modifiedAt: new Date().toISOString()
        };
        const db = seqDb([[fresh], undefined]);
        const res = await reindexDisclosures({
            db, contractAddress: CONTRACT, ledger: () => noGrants(),
            queryContractState: async () => ({ data: {} }),
            sweepGraceMs: 0
        });
        expect(res.deactivated).toBe(1);
    });

    test('two reindexes of one contract run one after the other', async () => {
        const order: string[] = [];
        let releaseFirst!: () => void;
        const firstState = new Promise<any>(resolve => { releaseFirst = () => resolve({ data: {} }); });
        const db1 = seqDb([undefined, undefined, []]);
        const db2 = seqDb([undefined, undefined, []]);
        const first = reindexDisclosures({
            db: db1, contractAddress: CONTRACT, ledger: () => oneGrant(),
            queryContractState: async () => { order.push('first-read'); const s = await firstState; order.push('first-done'); return s; }
        });
        const second = reindexDisclosures({
            db: db2, contractAddress: CONTRACT, ledger: () => oneGrant(),
            queryContractState: async () => { order.push('second-read'); return { data: {} }; }
        });
        await new Promise(r => setTimeout(r, 10));
        expect(order).toEqual(['first-read']);
        releaseFirst();
        await Promise.all([first, second]);
        expect(order).toEqual(['first-read', 'first-done', 'second-read']);
    });
});

describe('queryIndexerTipHeight', () => {
    test('reads the latest block height from the indexer GraphQL', async () => {
        const fetchFn = vi.fn(async () => ({ ok: true, json: async () => ({ data: { block: { height: 4321 } } }) })) as any;
        await expect(queryIndexerTipHeight('http://idx/api/v1/graphql', fetchFn)).resolves.toBe(4321);
        expect(fetchFn.mock.calls[0][1].body).toContain('block { height }');
    });

    test('is null on transport or shape failures', async () => {
        await expect(queryIndexerTipHeight('http://idx', (async () => { throw new Error('down'); }) as any)).resolves.toBeNull();
        await expect(queryIndexerTipHeight('http://idx', (async () => ({ ok: false })) as any)).resolves.toBeNull();
        await expect(queryIndexerTipHeight('http://idx', (async () => ({ ok: true, json: async () => ({}) })) as any)).resolves.toBeNull();
    });
});
