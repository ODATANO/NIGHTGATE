/**
 * `checkSponsorableShape` (wallet-worker): the FAIL-CLOSED policy on what a
 * sponsor will pay for. The review finding this pins: the old inspection only
 * COLLECTED contract calls, so a transaction with one allowed call plus a
 * deploy, a token transfer or its own dust actions sailed through the
 * allow-list and the sponsor paid for all of it.
 */

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';

// The worker module refuses to load outside a worker thread; hand it a fake
// parentPort (same approach as wallet-worker-dispatch.test.ts).
vi.mock('node:worker_threads', async () => {
    const actual = await vi.importActual<any>('node:worker_threads');
    return { ...actual, parentPort: { on: vi.fn(), postMessage: vi.fn() } };
});

let workerExports: any;
beforeAll(async () => {
    process.env.SKIP_AUTO_INIT = 'true';
    workerExports = await import('../../srv/midnight/wallet-worker.js');
});
afterEach(() => { delete process.env.NIGHTGATE_SPONSOR_MAX_TX_BYTES; });

const CALL = (address = 'aa'.repeat(32), entryPoint = 'attest') => ({ address, entryPoint });
const DEPLOY = () => { class ContractDeploy { address = 'bb'.repeat(32); } return new ContractDeploy(); };
const EMPTY_OFFER = { inputs: [], outputs: [] };

function tx(intents: Array<Record<string, unknown>>, top: Record<string, unknown> = {}) {
    return { intents: new Map(intents.map((i, n) => [n, i])), ...top };
}

function check(t: any, bytes = 5000, contracts?: string[], circuits?: string[]) {
    return workerExports.checkSponsorableShape(t, bytes, contracts, circuits);
}

describe('checkSponsorableShape', () => {
    it('accepts the canonical shape: allow-listed calls, nothing else', () => {
        const calls = check(
            tx([{ actions: [CALL()], guaranteedUnshieldedOffer: null, dustActions: null }]),
            5000, ['aa'.repeat(32)], ['attest']
        );
        expect(calls).toEqual([{ address: 'aa'.repeat(32), entryPoint: 'attest' }]);
    });

    it('still enforces the contract and circuit allow-lists', () => {
        expect(() => check(tx([{ actions: [CALL('cc'.repeat(32))] }]), 5000, ['aa'.repeat(32)]))
            .toThrow(/not in the allow-list/);
        expect(() => check(tx([{ actions: [CALL(undefined, 'sendAllMyMoney')] }]), 5000, undefined, ['attest']))
            .toThrow(/not sponsorable/);
    });

    it('rejects a NON-CALL action even when an allowed call rides in front (the P1 attack)', () => {
        expect(() => check(
            tx([{ actions: [CALL(), DEPLOY()] }]),
            5000, ['aa'.repeat(32)], ['attest']
        )).toThrow(/non-call action \(ContractDeploy\)/);
    });

    it('rejects unshielded transfers and caller dust riding alongside', () => {
        expect(() => check(tx([{ actions: [CALL()], guaranteedUnshieldedOffer: { inputs: [{}], outputs: [] } }])))
            .toThrow(/guaranteedUnshieldedOffer/);
        expect(() => check(tx([{ actions: [CALL()], fallibleUnshieldedOffer: { inputs: [], outputs: [{}] } }])))
            .toThrow(/fallibleUnshieldedOffer/);
        expect(() => check(tx([{ actions: [CALL()], dustActions: { spends: [{}], registrations: [] } }])))
            .toThrow(/dustActions/);
    });

    it('rejects zswap offers at the transaction level (plain and per-segment)', () => {
        expect(() => check(tx([{ actions: [CALL()] }], { guaranteedOffer: { inputs: [{}], outputs: [] } })))
            .toThrow(/guaranteedOffer/);
        expect(() => check(tx([{ actions: [CALL()] }], { fallibleOffer: new Map([[0, { inputs: [], outputs: [{}] }]]) })))
            .toThrow(/fallibleOffer/);
    });

    it('tolerates EMPTY offer containers (the SDK materializes them as empty)', () => {
        const calls = check(tx(
            [{ actions: [CALL()], guaranteedUnshieldedOffer: EMPTY_OFFER, dustActions: { spends: [], registrations: [] } }],
            { guaranteedOffer: EMPTY_OFFER }
        ));
        expect(calls).toHaveLength(1);
    });

    it('fails closed on uninspectable structure', () => {
        expect(() => check({})).toThrow(/not inspectable/);
        expect(() => check({ intents: 'nope' })).toThrow(/not inspectable/);
        // an offer whose shape exposes none of the known content keys
        expect(() => check(tx([{ actions: [CALL()], guaranteedUnshieldedOffer: { mystery: true } }])))
            .toThrow(/guaranteedUnshieldedOffer/);
    });

    it('rejects a transaction with no contract call at all', () => {
        expect(() => check(tx([{ actions: [] }]))).toThrow(/no contract call/);
    });

    it('enforces the byte budget (NIGHTGATE_SPONSOR_MAX_TX_BYTES, default 65536)', () => {
        expect(() => check(tx([{ actions: [CALL()] }]), 70_000)).toThrow(/over the 65536B budget/);
        process.env.NIGHTGATE_SPONSOR_MAX_TX_BYTES = '4000';
        expect(() => check(tx([{ actions: [CALL()] }]), 5000)).toThrow(/over the 4000B budget/);
    });

    it('a misconfigured budget falls back to the default instead of DISABLING the cap', () => {
        // 'abc' and 'Infinity' used to skip the check entirely, which turned a
        // config typo into an unbounded sponsor.
        for (const bad of ['abc', 'Infinity', 'NaN', '0', '-1', '1.5', '']) {
            process.env.NIGHTGATE_SPONSOR_MAX_TX_BYTES = bad;
            expect(() => check(tx([{ actions: [CALL()] }]), 70_000), `value '${bad}'`)
                .toThrow(/over the 65536B budget/);
            // and a small tx still passes under the default
            expect(check(tx([{ actions: [CALL()] }]), 5000), `value '${bad}'`).toHaveLength(1);
        }
    });
});
