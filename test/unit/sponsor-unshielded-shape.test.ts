/**
 * `checkSponsorableShape` with unshielded offers and `checkTransferShape` (wallet-worker):
 * a sponsored call may move the caller's own unshielded tokens into the contract under
 * public, checkable rules; a sponsored transfer is an offer and nothing else that nets to zero.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';

vi.mock('node:worker_threads', async () => {
    const actual = await vi.importActual<any>('node:worker_threads');
    return { ...actual, parentPort: { on: vi.fn(), postMessage: vi.fn() } };
});

let workerExports: any;
beforeAll(async () => {
    process.env.SKIP_AUTO_INIT = 'true';
    workerExports = await import('../../srv/midnight/wallet-worker.js');
});

const CALL = (address: string, entryPoint: string) => ({ address, entryPoint });
function tx(intents: Array<Record<string, unknown>>, top: Record<string, unknown> = {}) {
    return { intents: new Map(intents.map((i, n) => [n + 1, i])), ...top };
}

describe('unshielded offers next to a call', () => {
    const C = 'aa'.repeat(32);
    const OTHER = 'bb'.repeat(32);
    const NIGHT = 'ff'.repeat(32);
    const CREDIT = 'cc'.repeat(32);
    const KEY_A = '11'.repeat(32);
    const ADDR_A = 'a1'.repeat(32);
    const ADDR_B = 'b2'.repeat(32);
    const SPONSOR_KEY = '99'.repeat(32);
    const addressFromKey = (k: string) => (k === KEY_A ? ADDR_A : 'ee'.repeat(32));
    const input = (value: unknown, owner = KEY_A, type = NIGHT) => ({ value, owner, type, intentHash: '00'.repeat(32), outputNo: 0 });
    const output = (value: bigint, owner: string, type = NIGHT) => ({ value, owner, type });
    const payIn = (inputs: unknown[], outputs: unknown[]) => tx([{ actions: [CALL(C, 'deposit')], fallibleUnshieldedOffer: { inputs, outputs } }]);
    const canonical = payIn([input(50n)], [output(10n, C), output(40n, ADDR_A)]);
    const allowed = (t: unknown, extra: Record<string, unknown> = {}) => {
        const collectUnshielded: unknown[] = [];
        const calls = workerExports.checkSponsorableShape(t, 5000, [C], ['deposit'], {
            nightTokenType: NIGHT, allowUnshieldedOffers: true, addressFromKey, sponsorInputKeys: [SPONSOR_KEY], collectUnshielded, ...extra
        });
        return { calls, collectUnshielded };
    };

    it('stays refused without the right, naming the offer and the switch', () => {
        expect(() => workerExports.checkSponsorableShape(canonical, 5000, [C], ['deposit'], { nightTokenType: NIGHT }))
            .toThrow(/fallibleUnshieldedOffer alongside its contract calls; moving the caller's own unshielded tokens needs allowUnshieldedOffers/);
    });

    it('accepts the canonical pay-in: NIGHT in, the contract gets some, the spender gets the change', () => {
        const { calls, collectUnshielded } = allowed(canonical);
        expect(calls).toEqual([{ address: C, entryPoint: 'deposit' }]);
        expect(collectUnshielded).toEqual([{ type: NIGHT, amount: '10', to: C }]);
        const guaranteed = tx([{ actions: [CALL(C, 'deposit')], guaranteedUnshieldedOffer: { inputs: [input(10n)], outputs: [output(10n, C)] } }]);
        expect(allowed(guaranteed).collectUnshielded).toEqual([{ type: NIGHT, amount: '10', to: C }]);
    });

    it('refuses an offer that does not net to zero, in either direction', () => {
        expect(() => allowed(payIn([input(50n)], [output(10n, C), output(30n, ADDR_A)]))).toThrow(/does not net to zero.*spends more than it creates/);
        expect(() => allowed(payIn([input(50n)], [output(10n, C), output(50n, ADDR_A)]))).toThrow(/does not net to zero.*creates more than it spends/);
        expect(() => allowed(payIn([], [output(10n, C)]))).toThrow(/spends nothing/);
    });

    it('every output goes to a sponsorable contract or back to a spender, never to a third party', () => {
        expect(() => allowed(payIn([input(50n)], [output(10n, C), output(40n, ADDR_B)])))
            .toThrow(/pays b2b2b2b2b2b2b2b2…, which is neither a sponsorable contract nor an owner of its inputs/);
        expect(() => allowed(payIn([input(50n)], [output(50n, OTHER)]))).toThrow(/neither a sponsorable contract/);
        expect(workerExports.checkSponsorableShape(payIn([input(50n)], [output(50n, OTHER)]), 5000, [C, OTHER], ['deposit'], { nightTokenType: NIGHT, allowUnshieldedOffers: true, addressFromKey }))
            .toHaveLength(1);
        // an empty contract allow-list names nobody: only the called contract takes value
        expect(() => workerExports.checkSponsorableShape(payIn([input(50n)], [output(50n, OTHER)]), 5000, undefined, undefined, { nightTokenType: NIGHT, allowUnshieldedOffers: true, addressFromKey }))
            .toThrow(/neither a sponsorable contract/);
        // without the ledger's addressFromKey no change output can be recognised
        expect(() => allowed(canonical, { addressFromKey: undefined })).toThrow(/neither a sponsorable contract/);
    });

    it('moves NIGHT or a listed unshielded type, nothing else', () => {
        const credit = payIn([input(5n, KEY_A, CREDIT)], [output(5n, C, CREDIT)]);
        expect(() => allowed(credit)).toThrow(/token type cccccccccccccccc…, which is neither NIGHT nor in allowedUnshieldedTokenTypes/);
        expect(allowed(credit, { allowedUnshieldedTokenTypes: [CREDIT] }).collectUnshielded).toEqual([{ type: CREDIT, amount: '5', to: C }]);
    });

    it('an offer without a call in its intent, caller dust actions and the sponsor\'s own UTXOs stay refused', () => {
        expect(() => allowed(tx([{ actions: [], fallibleUnshieldedOffer: { inputs: [input(10n)], outputs: [output(10n, C)] } }, { actions: [CALL(C, 'deposit')] }])))
            .toThrow(/sits in an intent without a contract call/);
        expect(() => allowed(tx([{ actions: [CALL(C, 'deposit')], dustActions: { spends: [{}], registrations: [] } }]))).toThrow(/dustActions/);
        expect(() => allowed(payIn([input(10n, SPONSOR_KEY)], [output(10n, C)]))).toThrow(/spends a UTXO of the sponsor itself/);
    });

    it('fails closed on an unreadable offer', () => {
        expect(() => allowed(tx([{ actions: [CALL(C, 'deposit')], fallibleUnshieldedOffer: { inputs: 'x', outputs: [] } }]))).toThrow(/not inspectable/);
        expect(() => allowed(payIn([input('ten')], [output(10n, C)]))).toThrow(/value that is not readable/);
    });
});

describe('checkTransferShape', () => {
    const T = 'ab'.repeat(32);
    const nullifier = (n: number) => n.toString(16).padStart(64, '0');
    const transfer = (over: Record<string, unknown> = {}, top: Record<string, unknown> = {}) => ({
        intents: new Map(),
        fallibleOffer: undefined,
        guaranteedOffer: { inputs: [{ nullifier: nullifier(1) }], outputs: [{}, {}], transients: [], deltas: new Map(), ...over },
        imbalances: () => new Map([[T, 0n]]),
        ...top
    });

    it('accepts an offer and nothing else that nets to zero, and reports its inputs', () => {
        expect(workerExports.checkTransferShape(transfer(), 4)).toEqual({ inputs: 1, outputs: 2, nullifiers: [nullifier(1)] });
    });

    it('refuses intents, fallible offers, transients, contract coins, too many coins and a net change', () => {
        expect(() => workerExports.checkTransferShape(transfer({}, { intents: new Map([[1, {}]]) }), 4)).toThrow(/carries an intent/);
        expect(() => workerExports.checkTransferShape(transfer({}, { fallibleOffer: { inputs: [{}] } }), 4)).toThrow(/fallible offer/);
        expect(() => workerExports.checkTransferShape(transfer({ transients: [{}] }), 4)).toThrow(/transient coin/);
        expect(() => workerExports.checkTransferShape(transfer({ outputs: [{ contractAddress: 'aa'.repeat(32) }] }), 4)).toThrow(/contract-owned coin/);
        expect(() => workerExports.checkTransferShape(transfer({ inputs: [{}, {}, {}] }), 2)).toThrow(/carries 3 inputs; 1 to 2/);
        expect(() => workerExports.checkTransferShape(transfer({ outputs: [{}, {}, {}] }), 4)).toThrow(/carries 3 outputs/);
        expect(() => workerExports.checkTransferShape(transfer({ deltas: new Map([[T, 5n]]) }), 4)).toThrow(/does not net to zero/);
        expect(() => workerExports.checkTransferShape(transfer({}, { imbalances: () => new Map([[T, -3n]]) }), 4)).toThrow(/does not balance/);
    });
});
