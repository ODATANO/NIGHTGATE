/**
 * Tests for srv/submission/disclosure-indexer.ts.
 *
 * Exercises the decode/enumerate logic and the reindex upsert+sweep against a
 * FAKE `ledger()`-shaped object — crucially one whose outer `disclosures` map
 * is NOT iterable (only member/lookup), mirroring the real compiled artifact
 * (proven in scripts/spike-disclosure-indexer.mjs). No SDK, no chain.
 */
import { enumerateGrants, reindexDisclosures } from '../../srv/submission/disclosure-indexer';

// ---- fake ledger builder --------------------------------------------------

const b = (fill: number) => new Uint8Array(32).fill(fill);
const hx = (u: Uint8Array) => Buffer.from(u).toString('hex');

/**
 * Build a fake decoded ledger. `grants` is payloadHash-fill -> array of
 * [granteeFill, level]. `attestations` is the set of payloadHash-fills present
 * in attestation_owners (defaults to the keys of `grants`). The outer
 * `disclosures` object deliberately has NO [Symbol.iterator].
 */
function makeLedger(
    grants: Record<number, Array<[number, number]>>,
    attestations?: number[]
) {
    const ownerKeys = (attestations ?? Object.keys(grants).map(Number));
    const innerFor = (phFill: number) => {
        const entries = (grants[phFill] ?? []).map(([gFill, lvl]) =>
            [b(gFill), BigInt(lvl)] as [Uint8Array, bigint]);
        return {
            member: (k: Uint8Array) => entries.some(([g]) => hx(g) === hx(k)),
            lookup: (k: Uint8Array) => entries.find(([g]) => hx(g) === hx(k))![1],
            [Symbol.iterator]: () => entries[Symbol.iterator]()
        };
    };
    return {
        attestation_owners: {
            [Symbol.iterator]: () =>
                ownerKeys.map(f => [b(f), b(0)] as [Uint8Array, Uint8Array])[Symbol.iterator]()
        },
        disclosures: {
            // NO Symbol.iterator on purpose — matches the real artifact.
            member: (k: Uint8Array) => (grants[ownerKeys.find(f => hx(b(f)) === hx(k))!] ?? []).length >= 0
                && ownerKeys.some(f => hx(b(f)) === hx(k) && (grants[f]?.length ?? 0) > 0),
            lookup: (k: Uint8Array) => {
                const f = ownerKeys.find(ph => hx(b(ph)) === hx(k))!;
                return innerFor(f);
            }
        }
    } as any;
}

describe('enumerateGrants', () => {
    test('outer disclosures map is treated as non-iterable (uses attestation_owners)', () => {
        const led = makeLedger({ 0xaa: [[0xcc, 1]] });
        expect(typeof (led.disclosures as any)[Symbol.iterator]).toBe('undefined');
        const rows = enumerateGrants(led);
        expect(rows).toEqual([{ payloadHash: hx(b(0xaa)), grantee: hx(b(0xcc)), level: 1 }]);
    });

    test('returns empty when no grants', () => {
        expect(enumerateGrants(makeLedger({ 0xaa: [] }))).toEqual([]);
    });

    test('enumerates multiple grantees across multiple attestations', () => {
        const led = makeLedger({ 0x01: [[0x10, 0], [0x11, 2]], 0x02: [[0x20, 1]] });
        const rows = enumerateGrants(led);
        expect(rows).toHaveLength(3);
        expect(rows).toContainEqual({ payloadHash: hx(b(0x02)), grantee: hx(b(0x20)), level: 1 });
        expect(rows).toContainEqual({ payloadHash: hx(b(0x01)), grantee: hx(b(0x11)), level: 2 });
    });

    test('skips attestations with no disclosures entry', () => {
        // 0x03 is attested but has no disclosures (member → false).
        const led = makeLedger({ 0x01: [[0x10, 1]] }, [0x01, 0x03]);
        expect(enumerateGrants(led)).toEqual([
            { payloadHash: hx(b(0x01)), grantee: hx(b(0x10)), level: 1 }
        ]);
    });
});

// ---- reindexDisclosures (upsert + sweep) ----------------------------------
// Driven with a SEQUENCED db mock: reindex issues queries in a deterministic
// order, so we classify each call by its stable top-level CQN key
// (INSERT/UPDATE/SELECT) and feed return values in sequence. This avoids
// parsing CQN where-clauses (brittle) while still asserting the writes issued.

const classify = (q: any) => q?.INSERT ? 'INSERT' : q?.UPDATE ? 'UPDATE' : q?.SELECT ? 'SELECT' : '?';

function seqDb(responses: any[]) {
    const calls: any[] = [];
    const queue = [...responses];
    const run = jest.fn(async (q: any) => { calls.push(q); return queue.shift(); });
    return { run, calls };
}

describe('reindexDisclosures', () => {
    const CONTRACT = '0xVAULT';

    test('returns zero and never decodes when contract state is null', async () => {
        const db = seqDb([]);
        const ledger = jest.fn(() => { throw new Error('should not decode'); });
        const res = await reindexDisclosures({
            db, contractAddress: CONTRACT, ledger, queryContractState: async () => null
        });
        expect(res).toEqual({ indexed: 0, deactivated: 0 });
        expect(ledger).not.toHaveBeenCalled();
        expect(db.run).not.toHaveBeenCalled();
    });

    test('inserts a new on-chain grant as active (no existing row)', async () => {
        const led = makeLedger({ 0xaa: [[0xcc, 1]] });
        // order: SELECT.one existing → INSERT → SELECT active rows
        const db = seqDb([undefined, undefined, []]);
        const res = await reindexDisclosures({
            db, contractAddress: CONTRACT, ledger: () => led,
            queryContractState: async () => ({ data: {} })
        });
        expect(res).toEqual({ indexed: 1, deactivated: 0 });

        const insert = db.calls.find(c => classify(c) === 'INSERT');
        expect(insert.INSERT.entries[0]).toMatchObject({
            contractAddress: CONTRACT, payloadHash: hx(b(0xaa)),
            grantee: hx(b(0xcc)), level: 1, active: true
        });
        expect(db.calls.some(c => classify(c) === 'UPDATE')).toBe(false);
    });

    test('updates an existing optimistic row to active=true (no duplicate insert)', async () => {
        const led = makeLedger({ 0xaa: [[0xcc, 1]] });
        // order: SELECT.one existing → UPDATE → SELECT active rows
        const existing = { ID: 'row-1', grantedTxHash: '0xabc', active: false };
        const db = seqDb([existing, undefined, []]);
        await reindexDisclosures({
            db, contractAddress: CONTRACT, ledger: () => led,
            queryContractState: async () => ({ data: {} })
        });

        expect(db.calls.some(c => classify(c) === 'INSERT')).toBe(false);
        const upd = db.calls.find(c => classify(c) === 'UPDATE');
        // The UPDATE flips active and re-affirms level; grantedTxHash untouched.
        expect(JSON.stringify(upd.UPDATE.data ?? upd.UPDATE.with)).toContain('"active":true');
        expect(JSON.stringify(upd.UPDATE.data ?? upd.UPDATE.with)).not.toContain('grantedTxHash');
    });

    test('sweeps a previously-active row no longer on-chain to active=false', async () => {
        const led = makeLedger({ 0xaa: [] }); // attested but no grants on-chain
        const stale = { ID: 'stale', payloadHash: hx(b(0xaa)), grantee: hx(b(0xcc)) };
        // onChain empty → no per-grant calls. order: SELECT active rows → UPDATE
        const db = seqDb([[stale], undefined]);
        const res = await reindexDisclosures({
            db, contractAddress: CONTRACT, ledger: () => led,
            queryContractState: async () => ({ data: {} })
        });
        expect(res).toEqual({ indexed: 0, deactivated: 1 });
        const upd = db.calls.find(c => classify(c) === 'UPDATE');
        expect(JSON.stringify(upd.UPDATE.data ?? upd.UPDATE.with)).toContain('"active":false');
    });

    test('does not sweep a still-present grant (seen on-chain)', async () => {
        const led = makeLedger({ 0xaa: [[0xcc, 1]] });
        const present = { ID: 'live', payloadHash: hx(b(0xaa)), grantee: hx(b(0xcc)) };
        // order: SELECT.one existing → INSERT → SELECT active rows([present])
        const db = seqDb([undefined, undefined, [present]]);
        const res = await reindexDisclosures({
            db, contractAddress: CONTRACT, ledger: () => led,
            queryContractState: async () => ({ data: {} })
        });
        expect(res.deactivated).toBe(0);
        // exactly one UPDATE would mean a wrongful sweep; here only the INSERT exists.
        expect(db.calls.filter(c => classify(c) === 'UPDATE')).toHaveLength(0);
    });

    test('scopes the active-rows sweep query to the contract', async () => {
        const led = makeLedger({ 0xaa: [] });
        const db = seqDb([[], undefined]);
        await reindexDisclosures({
            db, contractAddress: CONTRACT, ledger: () => led,
            queryContractState: async () => ({ data: {} })
        });
        const activeSelect = db.calls.find(c => classify(c) === 'SELECT');
        expect(JSON.stringify(activeSelect.SELECT.where)).toContain(CONTRACT);
    });
});
