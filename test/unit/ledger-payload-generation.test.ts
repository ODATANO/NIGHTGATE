/**
 * Tests for the ledger generation `decodeLedgerPayload` picks: a block's runtime
 * version names the ledger that wrote its transactions. Both ledgers are fakes,
 * so no wasm loads here.
 */

const ledger9 = vi.hoisted(() => ({ Transaction: { deserialize: vi.fn(() => ({ identifiers: () => ['nine'] })) } }));
const ledger8 = vi.hoisted(() => ({ Transaction: { deserialize: vi.fn(() => ({ identifiers: () => ['eight'] })) } }));

vi.mock('../../srv/midnight/sdk-loader', async (importOriginal) => ({
    ...await importOriginal<typeof import('../../srv/midnight/sdk-loader')>(),
    loadLedger: vi.fn(async () => ledger9),
    loadLedger8: vi.fn(async () => ledger8)
}));

import { decodeLedgerPayload } from '../../srv/crawler/ledger-payload';
import { LEDGER_9_FIRST_SPEC_VERSION } from '../../srv/midnight/sdk-loader';

const BYTES = new Uint8Array([1, 2, 3]);

beforeEach(() => {
    ledger9.Transaction.deserialize.mockClear();
    ledger8.Transaction.deserialize.mockClear();
});

describe('decodeLedgerPayload: ledger generation by runtime version', () => {
    it('reads a block below the first ledger 9 version with ledger 8', async () => {
        const facts = await decodeLedgerPayload(BYTES, 1_000_300);
        expect(facts.identifiers).toEqual(['eight']);
        expect(ledger9.Transaction.deserialize).not.toHaveBeenCalled();
    });

    it('reads a block at or above it with ledger 9', async () => {
        expect((await decodeLedgerPayload(BYTES, LEDGER_9_FIRST_SPEC_VERSION)).identifiers).toEqual(['nine']);
        expect((await decodeLedgerPayload(BYTES, 2_001_100)).identifiers).toEqual(['nine']);
        expect(ledger8.Transaction.deserialize).not.toHaveBeenCalled();
    });

    it('reads with ledger 9 when the runtime version is not known', async () => {
        expect((await decodeLedgerPayload(BYTES)).identifiers).toEqual(['nine']);
        expect((await decodeLedgerPayload(BYTES, null)).identifiers).toEqual(['nine']);
    });
});
