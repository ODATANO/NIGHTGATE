/**
 * Tests for srv/crawler/ledger-payload.ts and srv/crawler/indexer-supplement.ts:
 * the two pure readers behind the trailing passes.
 *
 * The ledger transaction is a fake object shaped like the SDK's, so no wasm
 * loads here; the real decode is exercised against the chain by the probes and
 * by scripts/integration-test-utxo-identity.mjs for the identity helpers.
 */

import { extractLedgerPayload, readLedgerFacts } from '../../srv/crawler/ledger-payload';
import { readSupplementBlock } from '../../srv/crawler/indexer-supplement';

const CONTRACT = 'cc'.repeat(32);
const CONTRACT_PREFIX = Buffer.from('midnight:contract-address[v2]:', 'latin1').toString('hex');

/** SCALE compact encoding, single- and two-byte modes. */
function compact(value: number): number[] {
    if (value <= 63) return [value << 2];
    const buf = Buffer.alloc(2);
    buf.writeUInt16LE((value << 2) | 0x01, 0);
    return [...buf];
}

describe('extractLedgerPayload', () => {
    test('reads the compact-length-prefixed payload at the argument offset', () => {
        const payload = [1, 2, 3, 4, 5];
        const buf = Buffer.from([0x04, 5, 0, ...compact(payload.length), ...payload]);
        expect(extractLedgerPayload(buf, 3)).toEqual(new Uint8Array(payload));
    });

    test('refuses a length that runs past the buffer', () => {
        const buf = Buffer.from([0x04, 5, 0, ...compact(40), 1, 2]);
        expect(extractLedgerPayload(buf, 3)).toBeNull();
    });

    test('refuses an empty payload and an unreadable prefix', () => {
        expect(extractLedgerPayload(Buffer.from([0x04, 5, 0, ...compact(0)]), 3)).toBeNull();
        expect(extractLedgerPayload(Buffer.from([0x04, 5, 0]), 3)).toBeNull();
    });
});

/** A stand-in for the SDK's deserialized transaction. */
function fakeTx(over: Record<string, any> = {}): any {
    return {
        identifiers: () => ['0xAA', '0xbb'],
        guaranteedOffer: { inputs: [1], outputs: [1, 2], transients: [] },
        fallibleOffer: new Map([[7, { inputs: [], outputs: [1], transients: [1] }]]),
        intents: new Map([
            [5, {
                actions: [{ address: `0x${CONTRACT_PREFIX}${CONTRACT}`, entryPoint: 'increment' }],
                dustActions: { spends: [{ vFee: 10n }, { vFee: 5n }], registrations: [{}] }
            }],
            [1, {
                actions: [{ address: `0x${CONTRACT}`, entryPoint: new TextEncoder().encode('attest') }],
                dustActions: undefined
            }]
        ]),
        ...over
    };
}

describe('readLedgerFacts', () => {
    test('reads identifiers, contract calls, zswap and DUST counts', () => {
        const facts = readLedgerFacts(fakeTx());
        expect(facts.identifiers).toEqual(['aa', 'bb']);
        // Segment order, so the actions line up with the events' order.
        expect(facts.contractActions).toEqual([
            { address: CONTRACT, entryPoint: 'attest' },
            { address: CONTRACT, entryPoint: 'increment' }
        ]);
        expect(facts.zswapInputCount).toBe(1);
        expect(facts.zswapOutputCount).toBe(3);
        expect(facts.zswapTransientCount).toBe(1);
        expect(facts.dustSpendCount).toBe(2);
        expect(facts.dustRegistrationCount).toBe(1);
        expect(facts.dustSpendValue).toBe(15n);
    });

    test('an accessor that throws costs only its own field', () => {
        const tx = fakeTx({ identifiers: () => { throw new Error('unreadable'); } });
        // Defined after construction: a spread would trip the getter itself.
        Object.defineProperty(tx, 'guaranteedOffer', {
            get() { throw new Error('unreadable'); }
        });
        const facts = readLedgerFacts(tx);
        expect(facts.identifiers).toEqual([]);
        expect(facts.zswapInputCount).toBe(0);
        // The intents still read.
        expect(facts.contractActions).toHaveLength(2);
    });

    test('a transaction without intents reads as empty', () => {
        const facts = readLedgerFacts({ identifiers: () => [], intents: undefined });
        expect(facts.contractActions).toEqual([]);
        expect(facts.dustSpendValue).toBe(0n);
    });

    test('a deploy carries no entry point', () => {
        const facts = readLedgerFacts({
            identifiers: () => [],
            intents: new Map([[1, { actions: [{ address: `0x${CONTRACT}` }] }]])
        });
        expect(facts.contractActions).toEqual([{ address: CONTRACT, entryPoint: null }]);
    });
});

describe('readSupplementBlock', () => {
    const block = {
        block: {
            height: 42,
            transactions: [{
                hash: '0xABC',
                unshieldedCreatedOutputs: [
                    { intentHash: '0x11', outputIndex: 0, registeredForDustGeneration: true },
                    { intentHash: '0x22', outputIndex: 1, registeredForDustGeneration: false }
                ],
                contractActions: [{
                    __typename: 'ContractCall',
                    address: `0x${CONTRACT}`,
                    state: '0xdeadbeef',
                    zswapState: null,
                    unshieldedBalances: [{ tokenType: '0x00', amount: '500' }]
                }],
                zswapLedgerEvents: [{ id: 3, raw: '0xaabb', maxId: 9 }],
                dustLedgerEvents: [
                    { __typename: 'DustGenerationDtimeUpdate', id: '1,000', raw: null, maxId: 9 },
                    { __typename: 'DustInitialUtxo', id: 1001, raw: null, maxId: 9, output: { nonce: '0xAB' } },
                    { __typename: 'DustSpendProcessed', id: 1002, raw: null, maxId: 9 },
                    { __typename: 'ParamChange', id: 1003, raw: null, maxId: 9 },
                    { __typename: 'SomethingNew', id: 1004, raw: null, maxId: 9 }
                ],
                fee: '1',
                transactionResult: { status: 'PARTIAL_SUCCESS', segments: [{ id: 0, success: true }, { id: 3283, success: false }] }
            }]
        }
    };

    test('maps a block onto the supplement shape', () => {
        const mapped = readSupplementBlock(block)!;
        expect(mapped.height).toBe(42);
        const tx = mapped.transactions[0];
        expect(tx.ledgerTxHash).toBe('abc');
        expect(tx.status).toBe('PARTIAL_SUCCESS');
        expect(tx.fee).toBe('1');
        expect(tx.segments).toEqual([{ segmentId: 0, success: true }, { segmentId: 3283, success: false }]);
        expect(tx.contractActions).toEqual([{
            actionType: 'CALL',
            address: CONTRACT,
            state: Buffer.from('deadbeef', 'hex').toString('base64'),
            zswapState: null,
            balances: [{ tokenType: '00', amount: '500' }]
        }]);
        // Hex in, base64 out: a LargeBinary column takes base64.
        expect(tx.zswapEvents).toEqual([{ eventId: 3, maxId: 9, raw: Buffer.from('aabb', 'hex').toString('base64') }]);
        // Every kind the stream carries, and only INITIAL_UTXO keeps a nonce.
        expect(tx.dustEvents).toEqual([
            { eventId: 1000, maxId: 9, raw: null, eventType: 'DTIME_UPDATE', dustOutputNonce: null },
            { eventId: 1001, maxId: 9, raw: null, eventType: 'INITIAL_UTXO', dustOutputNonce: 'ab' },
            { eventId: 1002, maxId: 9, raw: null, eventType: 'SPEND_PROCESSED', dustOutputNonce: null },
            { eventId: 1003, maxId: 9, raw: null, eventType: 'PARAM_CHANGE', dustOutputNonce: null }
        ]);
        // Only the outputs that are actually registered.
        expect(tx.dustRegisteredOutputs).toEqual([{ intentHash: '11', outputIndex: 0 }]);
    });

    test('a missing block and a transaction without a hash are skipped', () => {
        expect(readSupplementBlock({})).toBeNull();
        expect(readSupplementBlock({ block: { height: 1, transactions: [{ hash: '' }] } })!.transactions).toEqual([]);
    });

    test('an unknown contract action type is dropped rather than guessed', () => {
        const mapped = readSupplementBlock({
            block: { height: 1, transactions: [{ hash: '0x1', contractActions: [{ __typename: 'Something', address: '0x2' }] }] }
        })!;
        expect(mapped.transactions[0].contractActions).toEqual([]);
    });
});
