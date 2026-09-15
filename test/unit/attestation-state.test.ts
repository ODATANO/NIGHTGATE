/**
 * Tests for srv/submission/attestation-state.ts (crawler-free attestation reader).
 *
 * Exercises readAttestationState against a FAKE `ledger()`-shaped object and a
 * fake queryContractState: no SDK, no chain. The maps here mirror the real
 * compiled artifact's `attestations` (record key -> record struct),
 * `content_anchors` (record key -> { root, schema }) and `document_bindings`
 * (document id -> record key); member/lookup only. Record keys are the real
 * `recordKey(attesterId, payloadHash)` recompute.
 */
import { readAttestationState } from '../../srv/submission/attestation-state';
import { computeRecordKey } from '../../srv/submission/predicate-state';

const b = (fill: number) => new Uint8Array(32).fill(fill);
const hx = (u: Uint8Array) => Buffer.from(u).toString('hex');
const ZERO = new Uint8Array(32);

const OWNER = 0x11;
const PAYLOAD = 0xaa;
let RK = '';

beforeAll(async () => {
    RK = await computeRecordKey(hx(b(OWNER)), hx(b(PAYLOAD)));
});

interface LedgerSpec {
    /** record key hex -> { owner fill, payload fill, document fill? } */
    records?: Record<string, { owner: number; payload: number; document?: number }>;
    /** record key hex -> root fill (schema = root + 1) */
    roots?: Record<string, number>;
    /** document id fill -> record key hex */
    bindings?: Record<number, string>;
    /** document id fill -> registered owner fill */
    owners?: Record<number, number>;
}

function makeLedger(spec: LedgerSpec) {
    const records = spec.records ?? {};
    const roots = spec.roots ?? {};
    const bindings = spec.bindings ?? {};
    const owners = spec.owners ?? {};
    return {
        attestations: {
            member: (k: Uint8Array) => hx(k) in records,
            lookup: (k: Uint8Array) => {
                const r = records[hx(k)];
                return {
                    payload_hash: b(r.payload),
                    metadata_hash: b(0),
                    owner: b(r.owner),
                    document_id: r.document !== undefined ? b(r.document) : ZERO
                };
            }
        },
        content_anchors: {
            member: (k: Uint8Array) => hx(k) in roots,
            lookup: (k: Uint8Array) => ({ root: b(roots[hx(k)]), schema: b(roots[hx(k)] + 1) })
        },
        document_bindings: {
            member: (k: Uint8Array) => k[0] in bindings,
            lookup: (k: Uint8Array) => Buffer.from(bindings[k[0]], 'hex')
        },
        document_owners: {
            member: (k: Uint8Array) => k[0] in owners,
            lookup: (k: Uint8Array) => b(owners[k[0]])
        }
    } as any;
}

function readFor(ledger: any, sel: { attester?: number; payload?: number; document?: number }, contentRootFill?: number, schemaFill?: number) {
    return readAttestationState({
        contractAddress: '0xVAULT',
        attesterId: sel.attester === undefined ? undefined : hx(b(sel.attester)),
        payloadHash: sel.payload === undefined ? undefined : hx(b(sel.payload)),
        documentId: sel.document === undefined ? undefined : hx(b(sel.document)),
        contentRoot: contentRootFill === undefined ? undefined : hx(b(contentRootFill)),
        schemaId: schemaFill === undefined ? undefined : hx(b(schemaFill)),
        ledger: () => ledger,
        queryContractState: async () => ({}) // non-null → ledger() is consulted
    });
}

describe('readAttestationState', () => {
    test('attested present, no contentRoot supplied → attested true, contentRootOk false, attesterId set', async () => {
        const led = makeLedger({ records: { [RK]: { owner: OWNER, payload: PAYLOAD } } });
        const r = await readFor(led, { attester: OWNER, payload: PAYLOAD });
        expect(r).toEqual({
            attested: true, contentRootOk: false, schemaOk: false, bindingRegistered: false, attesterId: hx(b(OWNER)),
            payloadHash: hx(b(PAYLOAD)), recordKey: RK, documentId: '', contentRoot: '', schemaId: ''
        });
    });

    test('bindingRegistered is true only when the bound id is registered to the record\'s attester', async () => {
        const bound = { records: { [RK]: { owner: OWNER, payload: PAYLOAD, document: 0x77 } }, bindings: { 0x77: RK } };
        expect(await readFor(makeLedger(bound), { document: 0x77 })).toMatchObject({ attested: true, bindingRegistered: false });
        expect(await readFor(makeLedger({ ...bound, owners: { 0x77: OWNER } }), { document: 0x77 })).toMatchObject({ attested: true, bindingRegistered: true });
        // Registered to someone else: the registrar re-pointed the id and this record's binding is stale.
        expect(await readFor(makeLedger({ ...bound, owners: { 0x77: 0x22 } }), { document: 0x77 })).toMatchObject({ attested: true, bindingRegistered: false });
        // No binding at all: nothing to be registered.
        const unbound = makeLedger({ records: { [RK]: { owner: OWNER, payload: PAYLOAD } }, owners: { 0x77: OWNER } });
        expect(await readFor(unbound, { attester: OWNER, payload: PAYLOAD })).toMatchObject({ attested: true, bindingRegistered: false });
    });

    test('another attester has no record of the same payload → attested false', async () => {
        const led = makeLedger({ records: { [RK]: { owner: OWNER, payload: PAYLOAD } } });
        const r = await readFor(led, { attester: 0x22, payload: PAYLOAD });
        expect(r).toMatchObject({ attested: false, attesterId: '', payloadHash: '', documentId: '', contentRoot: '', schemaId: '' });
        expect(r!.recordKey).toBe(await computeRecordKey(hx(b(0x22)), hx(b(PAYLOAD))));
    });

    test('contentRoot and schema match the anchor → both ok, anchor reported', async () => {
        const led = makeLedger({ records: { [RK]: { owner: OWNER, payload: PAYLOAD } }, roots: { [RK]: 0xdd } });
        const r = await readFor(led, { attester: OWNER, payload: PAYLOAD }, 0xdd, 0xde);
        expect(r).toMatchObject({ attested: true, contentRootOk: true, schemaOk: true, contentRoot: hx(b(0xdd)), schemaId: hx(b(0xde)) });
    });

    test('contentRoot mismatch → contentRootOk false', async () => {
        const led = makeLedger({ records: { [RK]: { owner: OWNER, payload: PAYLOAD } }, roots: { [RK]: 0xdd } });
        const r = await readFor(led, { attester: OWNER, payload: PAYLOAD }, 0xee);
        expect(r).toMatchObject({ attested: true, contentRootOk: false, contentRoot: hx(b(0xdd)) });
    });

    test('contentRoot supplied but none anchored → contentRootOk false', async () => {
        const led = makeLedger({ records: { [RK]: { owner: OWNER, payload: PAYLOAD } } });
        const r = await readFor(led, { attester: OWNER, payload: PAYLOAD }, 0xdd);
        expect(r).toMatchObject({ attested: true, contentRootOk: false, contentRoot: '' });
    });

    test('the document binding is reported', async () => {
        const led = makeLedger({ records: { [RK]: { owner: OWNER, payload: PAYLOAD, document: 0x77 } } });
        const r = await readFor(led, { attester: OWNER, payload: PAYLOAD });
        expect(r).toMatchObject({ documentId: hx(b(0x77)) });
    });

    test('a document id resolves the record through the binding, attester unknown up front', async () => {
        const led = makeLedger({
            records: { [RK]: { owner: OWNER, payload: PAYLOAD, document: 0x77 } },
            roots: { [RK]: 0xdd },
            bindings: { 0x77: RK }
        });
        const r = await readFor(led, { document: 0x77 }, 0xdd);
        expect(r).toMatchObject({ attested: true, attesterId: hx(b(OWNER)), payloadHash: hx(b(PAYLOAD)), recordKey: RK, contentRootOk: true });
    });

    test('a document id next to a payload hash must resolve to that payload', async () => {
        const led = makeLedger({ records: { [RK]: { owner: OWNER, payload: PAYLOAD, document: 0x77 } }, bindings: { 0x77: RK } });
        expect(await readFor(led, { document: 0x77, payload: PAYLOAD })).toMatchObject({ attested: true });
        expect(await readFor(led, { document: 0x77, payload: 0xab })).toMatchObject({ attested: false, recordKey: RK });
    });

    test('a document id next to an attester id must resolve to a record of that attester', async () => {
        const led = makeLedger({ records: { [RK]: { owner: OWNER, payload: PAYLOAD, document: 0x77 } }, bindings: { 0x77: RK } });
        expect(await readFor(led, { document: 0x77, attester: OWNER })).toMatchObject({ attested: true, attesterId: hx(b(OWNER)) });
        expect(await readFor(led, { document: 0x77, attester: 0x01 })).toMatchObject({ attested: false, attesterId: '', recordKey: RK });
        expect(await readFor(led, { document: 0x77, attester: 0x01, payload: PAYLOAD })).toMatchObject({ attested: false });
    });

    test('an unbound document id → attested false, no record key', async () => {
        const led = makeLedger({ records: { [RK]: { owner: OWNER, payload: PAYLOAD } } });
        expect(await readFor(led, { document: 0x78 })).toMatchObject({ attested: false, recordKey: '' });
    });

    test('without a record selector the reader throws', async () => {
        const led = makeLedger({});
        await expect(readFor(led, { payload: PAYLOAD })).rejects.toThrow(/attesterId and payloadHash, or documentId/);
    });

    test('contentRoot compare is case-insensitive', async () => {
        const led = makeLedger({ records: { [RK]: { owner: OWNER, payload: PAYLOAD } }, roots: { [RK]: 0xdd } });
        const r = await readAttestationState({
            contractAddress: '0xVAULT',
            attesterId: hx(b(OWNER)),
            payloadHash: hx(b(PAYLOAD)).toUpperCase(),
            contentRoot: hx(b(0xdd)).toUpperCase(),
            ledger: () => led,
            queryContractState: async () => ({})
        });
        expect(r).toMatchObject({ attested: true, contentRootOk: true });
    });

    test('no contract state (null) → returns null (clean negative)', async () => {
        const r = await readAttestationState({
            contractAddress: '0xVAULT',
            attesterId: hx(b(OWNER)),
            payloadHash: hx(b(PAYLOAD)),
            ledger: () => { throw new Error('ledger should not be called'); },
            queryContractState: async () => null
        });
        expect(r).toBeNull();
    });

    test('decodes via state.data when present (ChargedState shape)', async () => {
        const led = makeLedger({ records: { [RK]: { owner: OWNER, payload: PAYLOAD } } });
        const seen: any[] = [];
        const r = await readAttestationState({
            contractAddress: '0xVAULT',
            attesterId: hx(b(OWNER)),
            payloadHash: hx(b(PAYLOAD)),
            ledger: (s: any) => { seen.push(s); return led; },
            queryContractState: async () => ({ data: 'CHARGED_STATE' })
        });
        expect(seen[0]).toBe('CHARGED_STATE');
        expect(r).toMatchObject({ attested: true });
    });
});
