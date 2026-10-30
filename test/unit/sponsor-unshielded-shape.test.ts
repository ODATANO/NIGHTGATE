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
const unshieldedKey = (raw: string) => ({ tag: 'unshielded', raw });
// A ledger balance from the offers alone, as for a call that takes nothing in.
function offerBalance(intents: Map<number, any>, segment: number): Map<unknown, unknown> {
    const sums = new Map<string, bigint>();
    for (const [id, intent] of intents) {
        for (const [seg, key] of [[0, 'guaranteedUnshieldedOffer'], [id, 'fallibleUnshieldedOffer']] as const) {
            if (seg !== segment) continue;
            for (const i of intent?.[key]?.inputs ?? []) if (typeof i.value === 'bigint') sums.set(i.type, (sums.get(i.type) ?? 0n) + i.value);
            for (const o of intent?.[key]?.outputs ?? []) if (typeof o.value === 'bigint') sums.set(o.type, (sums.get(o.type) ?? 0n) - o.value);
        }
    }
    return new Map([...sums].map(([type, v]) => [unshieldedKey(type), v]));
}
function tx(intents: Array<Record<string, unknown>>, top: Record<string, unknown> = {}) {
    const map = new Map(intents.map((i, n) => [n + 1, i]));
    return { intents: map, imbalances: (segment: number) => offerBalance(map, segment), ...top };
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
    const allowed = (t: unknown, extra: Record<string, unknown> = {}, patch?: Record<string, unknown>) => {
        const collectUnshielded: unknown[] = [];
        const calls = workerExports.checkSponsorableShape(patch ? { ...(t as object), ...patch } : t, 5000, [C], ['deposit'], {
            nightTokenType: NIGHT, allowUnshieldedOffers: true, addressFromKey, sponsorInputKeys: [SPONSOR_KEY], collectUnshielded, ...extra
        });
        return { calls, collectUnshielded };
    };

    it('stays refused without the right, naming the offer and the switch', () => {
        expect(() => workerExports.checkSponsorableShape(canonical, 5000, [C], ['deposit'], { nightTokenType: NIGHT }))
            .toThrow(/fallibleUnshieldedOffer alongside its contract calls; moving unshielded tokens needs allowUnshieldedOffers/);
    });

    it('accepts the canonical pay-in: NIGHT in, the contract gets some, the spender gets the change', () => {
        const { calls, collectUnshielded } = allowed(canonical);
        expect(calls).toEqual([{ address: C, entryPoint: 'deposit' }]);
        expect(collectUnshielded).toEqual([{ type: NIGHT, amount: '10', to: C }]);
        const guaranteed = tx([{ actions: [CALL(C, 'deposit')], guaranteedUnshieldedOffer: { inputs: [input(10n)], outputs: [output(10n, C)] } }]);
        expect(allowed(guaranteed).collectUnshielded).toEqual([{ type: NIGHT, amount: '10', to: C }]);
    });

    it('the called circuit may take the rest in without an output of its own; the ledger balance says so', () => {
        const intake = payIn([input(5_000_000_000n)], [output(4_999_000_000n, ADDR_A)]);
        intake.imbalances = () => new Map([[unshieldedKey(NIGHT), 0n]]);
        expect(allowed(intake).collectUnshielded).toEqual([{ type: NIGHT, amount: '1000000', to: C }]);
        const both = payIn([input(50n)], [output(10n, C), output(30n, ADDR_A)]);
        both.imbalances = () => new Map([[unshieldedKey(NIGHT), 0n]]);
        expect(allowed(both).collectUnshielded).toEqual([{ type: NIGHT, amount: '10', to: C }, { type: NIGHT, amount: '10', to: C }]);
    });

    it('refuses an offer whose segment does not balance on the ledger, in either direction', () => {
        expect(() => allowed(payIn([input(50n)], [output(10n, C), output(30n, ADDR_A)]))).toThrow(/does not balance in token type.*surplus of 10/);
        const deficit = payIn([input(50n)], [output(10n, C), output(40n, ADDR_A)]);
        deficit.imbalances = () => new Map([[unshieldedKey(NIGHT), -5n]]);
        expect(() => allowed(deficit)).toThrow(/does not balance in token type.*deficit of 5/);
        expect(() => allowed(payIn([input(50n)], [output(10n, C), output(50n, ADDR_A)]))).toThrow(/creates more of token type.*than it spends/);
        expect(() => allowed(payIn([], [output(10n, C)]))).toThrow(/spends nothing and pays out nothing a called contract claims/);
    });

    it('a remainder for the circuit needs exactly one called contract', () => {
        const two = tx([{ actions: [CALL(C, 'deposit'), CALL(OTHER, 'deposit')], fallibleUnshieldedOffer: { inputs: [input(50n)], outputs: [output(40n, ADDR_A)] } }]);
        two.imbalances = () => new Map([[unshieldedKey(NIGHT), 0n]]);
        expect(() => workerExports.checkSponsorableShape(two, 5000, [C, OTHER], ['deposit'], { nightTokenType: NIGHT, allowUnshieldedOffers: true, addressFromKey }))
            .toThrow(/into 2 called contracts/);
    });

    it("reads the balance of the offer's own segment: 0 for the guaranteed offer, the intent id for the fallible one", () => {
        const seen: number[] = [];
        const t = tx([{ actions: [CALL(C, 'deposit')] }, { actions: [CALL(C, 'deposit')], guaranteedUnshieldedOffer: { inputs: [input(10n)], outputs: [output(10n, C)] }, fallibleUnshieldedOffer: { inputs: [input(5n)], outputs: [output(5n, C)] } }]);
        const balance = t.imbalances;
        t.imbalances = (segment: number) => { seen.push(segment); return balance(segment); };
        allowed(t);
        expect(seen).toEqual([0, 2]);
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

    describe('payouts the called contract claims', () => {
        const claim = (entries: Array<[string, string, bigint]>, at = C) => ({
            address: at, entryPoint: 'deposit',
            fallibleTranscript: { effects: { claimedUnshieldedSpends: new Map(entries.map(([type, to, v]) => [[unshieldedKey(type), { tag: 'user', address: to }], v])) } }
        });
        const payout = (claims: Array<[string, string, bigint]>, inputs: unknown[], outputs: unknown[], balance = 0n) => {
            const t = tx([{ actions: [claim(claims)], fallibleUnshieldedOffer: { inputs, outputs } }]);
            t.imbalances = () => new Map([[unshieldedKey(NIGHT), balance], [unshieldedKey(CREDIT), balance]]);
            return t;
        };

        it('accepts a payout to any address the contract names, with or without inputs of the caller', () => {
            expect(allowed(payout([[NIGHT, ADDR_B, 30n]], [], [output(30n, ADDR_B)])).collectUnshielded).toEqual([]);
            const mixed = payout([[NIGHT, ADDR_B, 30n]], [input(50n)], [output(10n, C), output(40n, ADDR_A), output(30n, ADDR_B)]);
            expect(allowed(mixed).collectUnshielded).toEqual([{ type: NIGHT, amount: '10', to: C }]);
            expect(allowed(payout([[NIGHT, ADDR_B, 20n], [NIGHT, ADDR_B, 10n]], [], [output(20n, ADDR_B), output(10n, ADDR_B)])).calls).toHaveLength(1);
        });

        it('refuses what the claims do not cover: a larger amount, another recipient, another token type', () => {
            expect(() => allowed(payout([[NIGHT, ADDR_B, 20n]], [], [output(30n, ADDR_B)]))).toThrow(/no called contract claims that payout/);
            expect(() => allowed(payout([[NIGHT, ADDR_A, 30n]], [], [output(30n, ADDR_B)]))).toThrow(/no called contract claims that payout/);
            expect(() => allowed(payout([[CREDIT, ADDR_B, 30n]], [], [output(30n, ADDR_B)]))).toThrow(/no called contract claims that payout/);
            expect(() => allowed(payout([[NIGHT, ADDR_B, 30n]], [], [output(30n, ADDR_B), output(30n, ADDR_B)]))).toThrow(/no called contract claims that payout/);
        });

        it('still needs a balanced segment and an allowed token type', () => {
            expect(() => allowed(payout([[NIGHT, ADDR_B, 30n]], [], [output(30n, ADDR_B)], -30n))).toThrow(/deficit of 30/);
            expect(() => allowed(payout([[CREDIT, ADDR_B, 5n]], [], [output(5n, ADDR_B, CREDIT)]))).toThrow(/neither NIGHT nor in allowedUnshieldedTokenTypes/);
            expect(allowed(payout([[CREDIT, ADDR_B, 5n]], [], [output(5n, ADDR_B, CREDIT)]), { allowedUnshieldedTokenTypes: [CREDIT] }).calls).toHaveLength(1);
        });

        it('reads claims only from calls on the given contracts and skips unreadable entries', () => {
            const actions = [claim([[NIGHT, ADDR_B, 30n]]), claim([[NIGHT, ADDR_A, 7n]], OTHER), { address: C, guaranteedTranscript: { effects: { claimedUnshieldedSpends: new Map<unknown, unknown>([['x', 1n], [[{ tag: 'shielded', raw: NIGHT }, { address: ADDR_A }], 2n]]) } } }];
            expect(workerExports.claimedPayouts(actions, new Set([C]))).toEqual(new Map([[`${NIGHT}:${ADDR_B}`, 30n]]));
            expect(workerExports.claimedPayouts(undefined, new Set([C]))).toEqual(new Map());
        });
    });

    it('fails closed on an unreadable offer or balance', () => {
        expect(() => allowed(tx([{ actions: [CALL(C, 'deposit')], fallibleUnshieldedOffer: { inputs: 'x', outputs: [] } }]))).toThrow(/not inspectable/);
        expect(() => allowed(payIn([input('ten')], [output(10n, C)]))).toThrow(/value that is not readable/);
        expect(() => allowed(canonical, {}, { imbalances: undefined })).toThrow(/not inspectable \(no imbalances\)/);
        expect(() => allowed(canonical, {}, { imbalances: () => { throw new Error('segment does not exist'); } })).toThrow(/balance of segment 1 is not readable/);
        expect(() => allowed(canonical, {}, { imbalances: () => new Map() })).toThrow(/reports no balance of token type/);
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
