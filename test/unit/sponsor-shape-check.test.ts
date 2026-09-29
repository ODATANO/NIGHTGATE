/**
 * `checkSponsorableShape` (wallet-worker): the FAIL-CLOSED policy on what a
 * sponsor will pay for. An inspection that only COLLECTS contract calls would
 * let a transaction with one allowed call plus a deploy, a token transfer or
 * its own dust actions through the allow-list, and the sponsor would pay for
 * all of it.
 */

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

    it('rejects a NON-CALL action even when an allowed call rides in front', () => {
        expect(() => check(
            tx([{ actions: [CALL(), DEPLOY()] }]),
            5000, ['aa'.repeat(32)], ['attest']
        )).toThrow(/non-call action \(ContractDeploy\)/);
    });

    // A deploy passes only with allowDeploy and under its own byte ceiling; a maintenance update never passes.
    it('accepts a ContractDeploy only with allowDeploy, reports it under the deploy marker', () => {
        expect(() => check(tx([{ actions: [DEPLOY()] }]), 5000, ['aa'.repeat(32)], ['attest']))
            .toThrow(/non-call action \(ContractDeploy\); deploys need allowDeploy/);
        const calls = workerExports.checkSponsorableShape(tx([{ actions: [DEPLOY()] }]), 5000, ['aa'.repeat(32)], ['attest'], { allowDeploy: true });
        // The new address is not on the allow-list; the deploy still passes.
        expect(calls).toEqual([{ address: 'bb'.repeat(32), entryPoint: workerExports.DEPLOY_ENTRY_POINT }]);
        expect(workerExports.DEPLOY_ENTRY_POINT).toBe('<deploy>');
    });

    // The budget is reserved per deploy; default cap 1 deploy per transaction, the option widens or closes it.
    it('caps the ContractDeploy actions per transaction (default 1)', () => {
        expect(() => workerExports.checkSponsorableShape(tx([{ actions: [DEPLOY(), DEPLOY()] }]), 5000, undefined, undefined, { allowDeploy: true }))
            .toThrow(/carries 2\+ contract deploys; at most 1 per sponsored transaction/);
        expect(() => workerExports.checkSponsorableShape(tx([{ actions: [DEPLOY()] }, { actions: [DEPLOY()] }]), 5000, undefined, undefined, { allowDeploy: true }))
            .toThrow(/at most 1 per sponsored transaction/);
        expect(workerExports.checkSponsorableShape(tx([{ actions: [DEPLOY(), DEPLOY()] }]), 5000, undefined, undefined, { allowDeploy: true, maxDeploys: 2 })).toHaveLength(2);
        expect(() => workerExports.checkSponsorableShape(tx([{ actions: [DEPLOY()] }]), 5000, undefined, undefined, { allowDeploy: true, maxDeploys: 0 }))
            .toThrow(/at most 0 per sponsored transaction/);
    });

    it('never sponsors a maintenance update, allowDeploy or not', () => {
        const MAINT = () => { class MaintenanceUpdate { address = 'bb'.repeat(32); updates = []; } return new MaintenanceUpdate(); };
        expect(() => workerExports.checkSponsorableShape(tx([{ actions: [MAINT()] }]), 5000, undefined, undefined, { allowDeploy: true }))
            .toThrow(/maintenance update \(never sponsorable\)/);
    });

    it('a deploy has its own byte ceiling (NIGHTGATE_SPONSOR_MAX_DEPLOY_BYTES, default 40960)', () => {
        expect(() => workerExports.checkSponsorableShape(tx([{ actions: [DEPLOY()] }]), 50_000, undefined, undefined, { allowDeploy: true }))
            .toThrow(/over the 40960B deploy budget/);
        process.env.NIGHTGATE_SPONSOR_MAX_DEPLOY_BYTES = '60000';
        try {
            expect(workerExports.checkSponsorableShape(tx([{ actions: [DEPLOY()] }]), 50_000, undefined, undefined, { allowDeploy: true })).toHaveLength(1);
        } finally {
            delete process.env.NIGHTGATE_SPONSOR_MAX_DEPLOY_BYTES;
        }
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

    // allowedTokenTypes: a contract's own token may ride in the offer
    const T = 'ab'.repeat(32);
    const NIGHT = 'ff'.repeat(32);
    const offer = (deltas: Array<[string, bigint]>, extra: Record<string, unknown> = {}) =>
        ({ inputs: [], outputs: [{}], transients: [], deltas: new Map(deltas), ...extra });
    const withTokens = (t: any, opts: Record<string, unknown> = {}) =>
        workerExports.checkSponsorableShape(t, 5000, ['aa'.repeat(32)], ['mint'], { allowedTokenTypes: [T], nightTokenType: NIGHT, ...opts });

    it('accepts an offer whose net change is on an allow-listed token type (a mint to the caller)', () => {
        const calls = withTokens(tx([{ actions: [CALL(undefined, 'mint')] }], { guaranteedOffer: offer([[T, -420n]]) }));
        expect(calls).toEqual([{ address: 'aa'.repeat(32), entryPoint: 'mint' }]);
        // per-segment map form, 0x-prefixed and upper-case types normalize
        expect(withTokens(tx([{ actions: [CALL(undefined, 'mint')] }], { fallibleCoins: new Map([[1, offer([['0x' + T.toUpperCase(), -1n]])]]) }))).toHaveLength(1);
    });

    it('without allowedTokenTypes every non-empty offer still refuses', () => {
        expect(() => check(tx([{ actions: [CALL()] }], { guaranteedOffer: offer([[T, -1n]]) })))
            .toThrow(/guaranteedOffer \(shielded value transfer\)/);
        expect(() => withTokens(tx([{ actions: [CALL()] }], { guaranteedOffer: offer([[T, -1n]]) }), { allowedTokenTypes: [] }))
            .toThrow(/shielded value transfer/);
    });

    it('refuses an offer on a type outside the list, on NIGHT, and one that nets to zero', () => {
        expect(() => withTokens(tx([{ actions: [CALL()] }], { guaranteedOffer: offer([['cd'.repeat(32), -1n]]) })))
            .toThrow(/moves token type cdcdcdcdcdcdcdcd…, not in allowedTokenTypes/);
        expect(() => withTokens(tx([{ actions: [CALL()] }], { guaranteedOffer: offer([[T, -1n], ['cd'.repeat(32), 5n]]) })))
            .toThrow(/not in allowedTokenTypes/);
        expect(() => withTokens(tx([{ actions: [CALL()] }], { guaranteedOffer: offer([[NIGHT, -1n]]) }), { allowedTokenTypes: [T, NIGHT] }))
            .toThrow(/moves NIGHT/);
        expect(() => withTokens(tx([{ actions: [CALL()] }], { guaranteedOffer: offer([]) })))
            .toThrow(/nets to zero and carries no contract-owned coin/);
        expect(() => withTokens(tx([{ actions: [CALL()] }], { guaranteedOffer: { inputs: [{}], outputs: [] } })))
            .toThrow(/exposes no deltas/);
    });

    it('accepts a zero-net offer when a sponsorable contract owns a coin in it (a burn: receive + send to the burn address)', () => {
        // Shape of a burn: 1 user input, 2 commitment outputs (change + burn
        // address), 1 transient owned by the contract, deltas empty.
        const burn = offer([], { inputs: [{}], outputs: [{}, {}], transients: [{ contractAddress: 'aa'.repeat(32) }] });
        expect(withTokens(tx([{ actions: [CALL(undefined, 'mint')] }], { guaranteedOffer: burn }))).toHaveLength(1);
        // the contract-owned coin must still be sponsorable
        const foreignBurn = offer([], { inputs: [{}], outputs: [{}], transients: [{ contractAddress: 'ee'.repeat(32) }] });
        expect(() => withTokens(tx([{ actions: [CALL(undefined, 'mint')] }], { guaranteedOffer: foreignBurn })))
            .toThrow(/coin owned by contract eeeeeeeeeeeeeeee…/);
        // a zero-net offer with only user coins is still a transfer riding along
        expect(() => withTokens(tx([{ actions: [CALL(undefined, 'mint')] }], { guaranteedOffer: offer([], { inputs: [{}], outputs: [{}] }) })))
            .toThrow(/nets to zero and carries no contract-owned coin/);
    });

    it('contract-owned coins in the offer must belong to a sponsorable contract', () => {
        const burn = offer([[T, 100n]], { inputs: [{}], outputs: [{ contractAddress: 'aa'.repeat(32) }, {}] });
        expect(withTokens(tx([{ actions: [CALL(undefined, 'mint')] }], { guaranteedOffer: burn }))).toHaveLength(1);
        const foreign = offer([[T, 100n]], { inputs: [{ contractAddress: 'ee'.repeat(32) }], outputs: [] });
        expect(() => withTokens(tx([{ actions: [CALL(undefined, 'mint')] }], { guaranteedOffer: foreign })))
            .toThrow(/coin owned by contract eeeeeeeeeeeeeeee…/);
        // a grant-deployed contract counts, and an unrestricted contract floor accepts any owner
        expect(withTokens(tx([{ actions: [CALL(undefined, 'mint')] }], { guaranteedOffer: foreign }), { ownContracts: ['ee'.repeat(32)] })).toHaveLength(1);
        expect(workerExports.checkSponsorableShape(tx([{ actions: [CALL()] }], { guaranteedOffer: foreign }), 5000, undefined, undefined, { allowedTokenTypes: [T] })).toHaveLength(1);
    });

    it('an offer never stands in for the contract call', () => {
        expect(() => withTokens(tx([{ actions: [] }], { guaranteedOffer: offer([[T, -1n]]) }))).toThrow(/carries no contract call/);
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
        // 'abc' and 'Infinity' must not skip the check: a config typo would
        // turn into an unbounded sponsor.
        for (const bad of ['abc', 'Infinity', 'NaN', '0', '-1', '1.5', '']) {
            process.env.NIGHTGATE_SPONSOR_MAX_TX_BYTES = bad;
            expect(() => check(tx([{ actions: [CALL()] }]), 70_000), `value '${bad}'`)
                .toThrow(/over the 65536B budget/);
            // and a small tx still passes under the default
            expect(check(tx([{ actions: [CALL()] }]), 5000), `value '${bad}'`).toHaveLength(1);
        }
    });
});

// An artifact revision written in place under the same path loads as itself, for ESM and CommonJS, on real files.
describe('contract mints: the offer of a token a call of the transaction mints', () => {
    const FACTORY = 'aa'.repeat(32);
    const SEP = 'f4'.repeat(32);
    // Stand-in for the ledger's derivation: deterministic in both inputs.
    const derive = (domainSeparator: string, contract: string) => `${domainSeparator.slice(0, 32)}${contract.slice(0, 32)}`;
    const MINTED = derive(SEP, FACTORY);
    const NIGHT = '00'.repeat(32);
    const mintCall = (mints: Array<[string, bigint]>, over: Record<string, unknown> = {}) => ({
        address: FACTORY, entryPoint: 'mint',
        guaranteedTranscript: { effects: { shieldedMints: new Map(mints) } },
        fallibleTranscript: undefined,
        ...over
    });
    const offer = (deltas: Array<[string, bigint]>) => ({ inputs: [], outputs: [{}], transients: [], deltas: new Map(deltas) });
    const check = (t: any, opts: Record<string, unknown> = {}, contracts: string[] | undefined = [FACTORY]) =>
        workerExports.checkSponsorableShape(t, 5000, contracts, ['mint'], { nightTokenType: NIGHT, allowContractMints: true, deriveTokenType: derive, ...opts });

    it('sponsors the mint without the type in any list', () => {
        const t = tx([{ actions: [mintCall([[SEP, 1000n]])] }], { guaranteedOffer: offer([[MINTED, -1000n]]) });
        expect(check(t)).toEqual([{ address: FACTORY, entryPoint: 'mint' }]);
        // less than declared (part of the mint stays with the contract) passes too
        expect(check(tx([{ actions: [mintCall([[SEP, 1000n]])] }], { guaranteedOffer: offer([[MINTED, -400n]]) }))).toHaveLength(1);
    });

    it('stays closed without the platform switch or without a derivation', () => {
        const t = () => tx([{ actions: [mintCall([[SEP, 1000n]])] }], { guaranteedOffer: offer([[MINTED, -1000n]]) });
        expect(() => check(t(), { allowContractMints: false })).toThrow(/shielded value transfer/);
        expect(() => check(t(), { deriveTokenType: undefined })).toThrow(/shielded value transfer/);
        expect(() => check(t(), { allowContractMints: false, allowedTokenTypes: ['cd'.repeat(32)] })).toThrow(/not in allowedTokenTypes/);
    });

    it('refuses more than the calls mint, and a payment in the minted type', () => {
        expect(() => check(tx([{ actions: [mintCall([[SEP, 1000n]])] }], { guaranteedOffer: offer([[MINTED, -1001n]]) })))
            .toThrow(/creates 1001 of token type f4f4f4f4f4f4f4f4…, the transaction's calls mint 1000/);
        expect(() => check(tx([{ actions: [mintCall([[SEP, 1000n]])] }], { guaranteedOffer: offer([[MINTED, 5n]]) })))
            .toThrow(/pays in token type f4f4f4f4f4f4f4f4…, not in allowedTokenTypes/);
    });

    it('a type nobody mints in the transaction is refused as before', () => {
        const other = 'cd'.repeat(32);
        expect(() => check(tx([{ actions: [mintCall([[SEP, 1000n]])] }], { guaranteedOffer: offer([[MINTED, -1000n], [other, -1n]]) })))
            .toThrow(/moves token type cdcdcdcdcdcdcdcd…, not in allowedTokenTypes/);
    });

    it('counts only mints of sponsorable contracts; a contract deployed under the grant is one', () => {
        const foreign = 'ee'.repeat(32);
        const foreignMint = () => tx(
            [{ actions: [CALL(FACTORY, 'mint'), mintCall([[SEP, 1000n]], { address: foreign })] }],
            { guaranteedOffer: offer([[derive(SEP, foreign), -1000n]]) });
        expect(() => check(foreignMint())).toThrow(/shielded value transfer/);
        // The effective contract list carries the grant's deployed addresses.
        expect(check(foreignMint(), { ownContracts: [foreign] }, [FACTORY, foreign])).toHaveLength(2);
        expect(workerExports.declaredMints(foreignMint(), (a: string) => a === foreign, derive)).toEqual(new Map([[derive(SEP, foreign), 1000n]]));
    });

    it('sums the mints of several calls and both transcripts, and spends them once across the offers', () => {
        const calls = [
            mintCall([[SEP, 600n]]),
            mintCall([], { guaranteedTranscript: undefined, fallibleTranscript: { effects: { shieldedMints: new Map([[SEP, 400n]]) } } })
        ];
        const split = (second: bigint) => tx([{ actions: calls }], {
            guaranteedOffer: offer([[MINTED, -600n]]),
            fallibleOffer: new Map([[1, offer([[MINTED, second]])]])
        });
        expect(check(split(-400n))).toHaveLength(2);
        expect(() => check(split(-401n))).toThrow(/creates 401 of token type .* mint 400/);
    });

    it('a listed type is not charged to the mints, and NIGHT is never sponsored', () => {
        const t = tx([{ actions: [mintCall([[SEP, 10n]])] }], { guaranteedOffer: offer([[MINTED, -5000n]]) });
        expect(check(t, { allowedTokenTypes: [MINTED] })).toHaveLength(1);
        const night = tx([{ actions: [mintCall([[SEP, 10n]])] }], { guaranteedOffer: offer([[NIGHT, -10n]]) });
        expect(() => check(night, { deriveTokenType: () => NIGHT })).toThrow(/moves NIGHT/);
    });

    it('ignores a declared mint that is not a positive amount or derives no raw type', () => {
        const zero = tx([{ actions: [mintCall([[SEP, 0n]])] }], { guaranteedOffer: offer([[MINTED, -1n]]) });
        expect(() => check(zero)).toThrow(/shielded value transfer/);
        const odd = tx([{ actions: [mintCall([[SEP, 10n]])] }], { guaranteedOffer: offer([[MINTED, -1n]]) });
        expect(() => check(odd, { deriveTokenType: () => 'not-a-type' })).toThrow(/shielded value transfer/);
    });

    it('tokenTypeDeriver hands the ledger the domain separator as bytes', () => {
        const rawTokenType = vi.fn(() => MINTED);
        expect(workerExports.tokenTypeDeriver({ rawTokenType })('0a0b', FACTORY)).toBe(MINTED);
        expect(rawTokenType).toHaveBeenCalledWith(new Uint8Array([0x0a, 0x0b]), FACTORY);
    });
});

describe('checkSwapHalves: two halves of a shielded swap', () => {
    const A = 'a1'.repeat(32);
    const B = 'b2'.repeat(32);
    const NIGHT = '00'.repeat(32);
    const half = (deltas: Array<[string, bigint]>, over: Record<string, unknown> = {}, top: Record<string, unknown> = {}) => ({
        intents: new Map(),
        fallibleOffer: undefined,
        guaranteedOffer: { inputs: [{}], outputs: [{}, {}], transients: [], deltas: new Map(deltas), ...over },
        ...top
    });
    const maker = (over?: Record<string, unknown>, top?: Record<string, unknown>) => half([[A, 10n], [B, -3n]], over, top);
    const taker = (over?: Record<string, unknown>, top?: Record<string, unknown>) => half([[B, 3n], [A, -10n]], over, top);
    const check = (m: any, t: any, opts: Record<string, unknown> = {}) =>
        workerExports.checkSwapHalves(m, t, { allowedTokenTypes: [A, B], nightTokenType: NIGHT, maxInputs: 4, ...opts });

    it('returns the terms from the maker\'s side', () => {
        expect(check(maker(), taker())).toEqual({
            gives: { tokenType: A, amount: '10' },
            wants: { tokenType: B, amount: '3' }
        });
        // 0x-prefixed and upper-case types normalize
        expect(check(half([['0x' + A.toUpperCase(), 10n], [B, -3n]]), taker()).gives.tokenType).toBe(A);
    });

    it('refuses without listed token types, a type outside the list, and NIGHT', () => {
        expect(() => check(maker(), taker(), { allowedTokenTypes: [] })).toThrow(/none is listed/);
        expect(() => check(maker(), taker(), { allowedTokenTypes: [A] })).toThrow(/maker half moves token type b2b2b2b2b2b2b2b2…, not in allowedTokenTypes/);
        expect(() => check(half([[A, 10n], [NIGHT, -3n]]), half([[NIGHT, 3n], [A, -10n]]), { allowedTokenTypes: [A, NIGHT] }))
            .toThrow(/maker half moves NIGHT/);
    });

    it('refuses a gift cut in two, one half alone, and a half on one type', () => {
        expect(() => check(half([[A, 10n]]), half([[A, -10n]]))).toThrow(/maker half gives 1 token type\(s\) and wants 0/);
        expect(() => check(maker(), half([]))).toThrow(/taker half gives 0 token type\(s\) and wants 0/);
        expect(() => check(half([[A, 10n], [B, -3n], ['c3'.repeat(32), -1n]]), taker())).toThrow(/wants 2/);
    });

    it('refuses halves that do not mirror each other', () => {
        expect(() => check(maker(), half([[B, 3n], [A, -9n]]))).toThrow(/do not mirror each other/);
        expect(() => check(maker(), maker())).toThrow(/do not mirror each other/);
    });

    it('refuses anything but an offer: an intent, a fallible offer, a transient, a contract-owned coin', () => {
        expect(() => check(maker({}, { intents: new Map([[1, { actions: [CALL()] }]]) }), taker())).toThrow(/maker half carries an intent/);
        expect(() => check(maker(), taker({}, { fallibleOffer: new Map([[1, {}]]) }))).toThrow(/taker half carries a fallible offer/);
        expect(() => check(maker({ transients: [{}] }), taker())).toThrow(/carries a transient coin/);
        expect(() => check(maker({ outputs: [{ contractAddress: 'aa'.repeat(32) }] }), taker())).toThrow(/carries a contract-owned coin/);
        expect(() => check({ intents: new Map() }, taker())).toThrow(/maker half carries no readable guaranteed offer/);
        expect(() => check(maker({ deltas: undefined }), taker())).toThrow(/exposes no deltas/);
    });

    it('bounds the coins of a half: inputs by the configured cap, outputs by two', () => {
        expect(() => check(maker({ inputs: [{}, {}, {}, {}, {}] }), taker())).toThrow(/carries 5 inputs; 1 to 4 are sponsored/);
        expect(check(maker({ inputs: [{}, {}, {}, {}, {}] }), taker(), { maxInputs: 5 })).toBeTruthy();
        expect(() => check(maker({ inputs: [] }), taker())).toThrow(/carries 0 inputs/);
        expect(() => check(maker({ outputs: [{}, {}, {}] }), taker())).toThrow(/carries 3 outputs/);
        expect(check(maker({ outputs: [{}] }), taker())).toBeTruthy();
    });

    it('mergeSwapHalves: two unbound halves stay unbound, a bound half binds the other', () => {
        const tx = (name: string, boundForm = false): any => ({
            name, boundForm,
            bind() { return tx(name, true); },
            merge(other: any) {
                if (other.boundForm !== this.boundForm) throw new Error('Both transactions need to be of the same type.');
                return { merged: [this.name, other.name], boundForm: this.boundForm };
            }
        });
        expect(workerExports.mergeSwapHalves({ tx: tx('m'), bound: false }, { tx: tx('t'), bound: false }))
            .toEqual({ tx: { merged: ['m', 't'], boundForm: false }, bound: false });
        expect(workerExports.mergeSwapHalves({ tx: tx('m', true), bound: true }, { tx: tx('t', true), bound: true }))
            .toEqual({ tx: { merged: ['m', 't'], boundForm: true }, bound: true });
        expect(workerExports.mergeSwapHalves({ tx: tx('m', true), bound: true }, { tx: tx('t'), bound: false }))
            .toEqual({ tx: { merged: ['m', 't'], boundForm: true }, bound: true });
        expect(workerExports.mergeSwapHalves({ tx: tx('m'), bound: false }, { tx: tx('t', true), bound: true }))
            .toEqual({ tx: { merged: ['m', 't'], boundForm: true }, bound: true });
    });

    it('mergeSwapHalves: halves that share a coin are refused, not thrown through', () => {
        const half = { tx: { merge() { throw new Error('attempted to merge non-disjoint coin sets'); } }, bound: false };
        expect(() => workerExports.mergeSwapHalves(half, half)).toThrow(/refusing to sponsor: the halves do not merge: .*non-disjoint/);
    });

    it('assertSwapBalanced: the merge carries no intent, no delta and no imbalance, within the byte budget', () => {
        const merged = (over: Record<string, unknown> = {}) => ({
            intents: new Map(), guaranteedOffer: { deltas: new Map() },
            imbalances: () => new Map([[{ tag: 'shielded', raw: A }, 0n]]), ...over
        });
        expect(() => workerExports.assertSwapBalanced(merged(), 30000)).not.toThrow();
        expect(() => workerExports.assertSwapBalanced(merged(), 70000)).toThrow(/merged swap is 70000B, over the 65536B budget/);
        expect(() => workerExports.assertSwapBalanced(merged({ intents: new Map([[1, {}]]) }), 30000)).toThrow(/carries an intent/);
        expect(() => workerExports.assertSwapBalanced(merged({ guaranteedOffer: { deltas: new Map([[A, 1n]]) } }), 30000)).toThrow(/does not net to zero/);
        expect(() => workerExports.assertSwapBalanced(merged({ imbalances: () => new Map([[{ raw: A }, 1n]]) }), 30000)).toThrow(/does not balance/);
        expect(() => workerExports.assertSwapBalanced(merged({ imbalances: () => { throw new Error('x'); } }), 30000)).toThrow(/balance is not readable/);
    });
});

describe('importArtifactGeneration: generation-pinned loading for ESM and CommonJS artifacts', () => {
    let dir: string;
    beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ng-artifact-gen-')); });

    it('an ESM artifact rewritten in place loads as the NEW class under a new generation', async () => {
        const file = path.join(dir, 'esm.mjs');
        fs.writeFileSync(file, 'export class Contract { static gen = 1 }\n');
        const a = (await workerExports.importArtifactGeneration(file, 'g1')).Contract;
        fs.writeFileSync(file, 'export class Contract { static gen = 2 }\n');
        const b = (await workerExports.importArtifactGeneration(file, 'g2')).Contract;
        expect(a.gen).toBe(1);
        expect(b.gen).toBe(2);
        expect(a).not.toBe(b);
    });

    it('a CommonJS artifact rewritten in place loads as the NEW class under a new generation', async () => {
        const file = path.join(dir, 'cjs.cjs');
        fs.writeFileSync(file, 'exports.Contract = class Contract { static gen = 1 };\n');
        const a = (await workerExports.importArtifactGeneration(file, 'g1')).Contract;
        fs.writeFileSync(file, 'exports.Contract = class Contract { static gen = 2 };\n');
        const b = (await workerExports.importArtifactGeneration(file, 'g2')).Contract;
        expect(a.gen).toBe(1);
        expect(b.gen).toBe(2);
        expect(a).not.toBe(b);
    });
});

// The worker recomputes the pinned digest from the module and zk assets on disk and refuses a mismatch before loading anything.
describe('assertArtifactGenerationOnDisk: the worker verifies the pinned generation against the files', () => {
    let dir: string;
    beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ng-artifact-verify-')); });
    const layout = (name: string) => {
        const base = path.join(dir, name);
        fs.mkdirSync(path.join(base, 'keys'), { recursive: true });
        fs.mkdirSync(path.join(base, 'zkir'), { recursive: true });
        fs.mkdirSync(path.join(base, 'contract'), { recursive: true });
        fs.writeFileSync(path.join(base, 'keys', 'attest.verifier'), 'vk-1');
        fs.writeFileSync(path.join(base, 'keys', 'attest.prover'), 'pk-1');
        fs.writeFileSync(path.join(base, 'zkir', 'attest.zkir'), 'ir-1');
        fs.writeFileSync(path.join(base, 'contract', 'index.mjs'), 'export class Contract {}\n');
        return { artifactPath: path.join(base, 'contract', 'index.mjs'), zkConfigPath: base, privateStateId: 'ps' };
    };

    it('accepts files that still hash to the pinned generation, refuses a swapped prover key or module', async () => {
        const { computeArtifactGenerationDigest } = await import('../../srv/submission/artifact-digest.js');
        const reg = layout('a');
        const pinned = computeArtifactGenerationDigest(reg);
        expect(() => workerExports.assertArtifactGenerationOnDisk('a', { ...reg, artifactDigest: pinned })).not.toThrow();
        fs.writeFileSync(path.join(reg.zkConfigPath, 'keys', 'attest.prover'), 'pk-2');
        expect(() => workerExports.assertArtifactGenerationOnDisk('a', { ...reg, artifactDigest: pinned }))
            .toThrow(/on disk is artifact generation .* but this job was pinned to/);
        fs.writeFileSync(path.join(reg.zkConfigPath, 'keys', 'attest.prover'), 'pk-1');
        expect(() => workerExports.assertArtifactGenerationOnDisk('a', { ...reg, artifactDigest: pinned })).not.toThrow();
        fs.writeFileSync(reg.artifactPath, 'export class Contract { static v = 2 }\n');
        expect(() => workerExports.assertArtifactGenerationOnDisk('a', { ...reg, artifactDigest: pinned })).toThrow(/pinned to/);
    });

    it('the class is imported from the SNAPSHOT: a rewrite of the original between two loads of the same pinned generation cannot reach the job', async () => {
        const { computeArtifactGenerationDigest } = await import('../../srv/submission/artifact-digest.js');
        const snapRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ng-snap-'));
        process.env.NIGHTGATE_ARTIFACT_SNAPSHOT_DIR = snapRoot;
        try {
            const reg = layout('c');
            const pinned = computeArtifactGenerationDigest(reg);
            const first = await workerExports.getContractScaffold('c', { ...reg, artifactDigest: pinned });
            expect(first.contractClass.gen ?? 1).toBe(1);
            // the snapshot: canonical module name, keys/zkir, bare-specifier resolution link
            const assets = workerExports.artifactAssetPath('c', { ...reg, artifactDigest: pinned });
            expect(assets).toBe(path.join(workerExports.artifactSnapshotRoot(), pinned));
            expect(fs.existsSync(path.join(assets, 'module', 'artifact.mjs'))).toBe(true);
            expect(fs.readFileSync(path.join(assets, 'zkir', 'attest.zkir'), 'utf8')).toBe('ir-1');
            expect(fs.lstatSync(path.join(workerExports.artifactSnapshotRoot(), 'node_modules')).isSymbolicLink()).toBe(true);
            expect(fs.existsSync(path.join(workerExports.artifactSnapshotRoot(), 'node_modules', '@midnight-ntwrk', 'compact-runtime', 'package.json'))).toBe(true);
            // originals rewritten in place (module and asset) while the old snapshot exists and the
            // scaffold is evicted: the job pinned to the old generation still gets the old class from the snapshot
            fs.writeFileSync(reg.artifactPath, 'export class Contract { static gen = 2 }\n');
            fs.writeFileSync(path.join(reg.zkConfigPath, 'zkir', 'attest.zkir'), 'ir-2');
            workerExports.__resetScaffoldCacheForTests();
            const again = await workerExports.getContractScaffold('c', { ...reg, artifactDigest: pinned });
            expect(again.contractClass.gen).toBeUndefined();
            expect(fs.readFileSync(path.join(assets, 'zkir', 'attest.zkir'), 'utf8')).toBe('ir-1');
            // a job pinned to the new generation gets the new class and assets from its own snapshot
            const next = computeArtifactGenerationDigest(reg);
            expect(next).not.toBe(pinned);
            const fresh = await workerExports.getContractScaffold('c', { ...reg, artifactDigest: next });
            expect(fresh.contractClass.gen).toBe(2);
            expect(fs.readFileSync(path.join(workerExports.artifactAssetPath('c', { ...reg, artifactDigest: next }), 'zkir', 'attest.zkir'), 'utf8')).toBe('ir-2');
            // a job pinned to the old generation whose snapshot is gone is not served from changed originals
            fs.rmSync(assets, { recursive: true, force: true });
            workerExports.__resetArtifactSnapshotsForTests();
            workerExports.__resetScaffoldCacheForTests();
            await expect(workerExports.getContractScaffold('c', { ...reg, artifactDigest: pinned })).rejects.toThrow(/pinned to/);
        } finally {
            delete process.env.NIGHTGATE_ARTIFACT_SNAPSHOT_DIR;
            workerExports.__resetArtifactSnapshotsForTests();
            fs.rmSync(snapRoot, { recursive: true, force: true });
        }
    });

    it('byte-identical artifacts under different file names share ONE snapshot (canonical module name), neither rebuilds the other', async () => {
        const { computeArtifactGenerationDigest } = await import('../../srv/submission/artifact-digest.js');
        const snapRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ng-snap3-'));
        process.env.NIGHTGATE_ARTIFACT_SNAPSHOT_DIR = snapRoot;
        try {
            const a = layout('same-a');
            const b = { ...layout('same-b'), artifactPath: path.join(path.dirname(layout('same-b').artifactPath), 'contract.mjs') };
            fs.renameSync(path.join(path.dirname(b.artifactPath), 'index.mjs'), b.artifactPath);
            const da = computeArtifactGenerationDigest(a);
            expect(computeArtifactGenerationDigest(b)).toBe(da);
            const sa = workerExports.materializeArtifactSnapshot('same-a', { ...a, artifactDigest: da });
            const mtime = fs.statSync(path.join(sa.zkConfigPath, 'keys', 'attest.prover')).mtimeMs;
            workerExports.__resetArtifactSnapshotsForTests();
            const sb = workerExports.materializeArtifactSnapshot('same-b', { ...b, artifactDigest: da });
            expect(sb.zkConfigPath).toBe(sa.zkConfigPath);
            expect(sb.modulePath).toBe(sa.modulePath);
            expect(fs.statSync(path.join(sa.zkConfigPath, 'keys', 'attest.prover')).mtimeMs).toBe(mtime); // verified, not rebuilt
        } finally {
            delete process.env.NIGHTGATE_ARTIFACT_SNAPSHOT_DIR;
            workerExports.__resetArtifactSnapshotsForTests();
            fs.rmSync(snapRoot, { recursive: true, force: true });
        }
    });

    it('retention: an evicted generation is swept only when no job holds it; stale snapshots and leftover builds go at start-up', async () => {
        const { computeArtifactGenerationDigest } = await import('../../srv/submission/artifact-digest.js');
        const snapRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ng-snap4-'));
        process.env.NIGHTGATE_ARTIFACT_SNAPSHOT_DIR = snapRoot;
        try {
            // leftovers in the install's root, a snapshot unused for 30 days that
            // no live process holds, one that another live process (the parent) holds,
            // and a per-process root of the older per-pid layout whose process is gone
            const myRoot = workerExports.artifactSnapshotRoot();
            fs.mkdirSync(path.join(myRoot, 'deadbeef.tmp-1-abcd', 'module'), { recursive: true });
            fs.mkdirSync(path.join(myRoot, 'f'.repeat(64), 'keys'), { recursive: true });
            const old = new Date(Date.now() - 30 * 24 * 3600 * 1000);
            fs.utimesSync(path.join(myRoot, 'f'.repeat(64)), old, old);
            fs.mkdirSync(path.join(myRoot, 'd'.repeat(64), '.holders'), { recursive: true });
            fs.writeFileSync(path.join(myRoot, 'd'.repeat(64), '.holders', String(process.ppid)), 'x');
            fs.utimesSync(path.join(myRoot, 'd'.repeat(64)), old, old);
            const deadRoot = path.join(myRoot, '999999');
            fs.mkdirSync(path.join(deadRoot, 'a'.repeat(64)), { recursive: true });
            // one level per install, none per process: a restart reuses the snapshots
            expect(myRoot).toBe(path.join(snapRoot, path.basename(myRoot)));
            expect(path.basename(myRoot)).toMatch(/^[0-9a-f]{16}$/);
            const reg = layout('e');
            const digest = computeArtifactGenerationDigest(reg);
            const release = workerExports.retainGeneration(digest);
            const snap = workerExports.materializeArtifactSnapshot('e', { ...reg, artifactDigest: digest });
            expect(fs.existsSync(path.join(myRoot, 'deadbeef.tmp-1-abcd'))).toBe(false);
            expect(fs.existsSync(path.join(myRoot, 'f'.repeat(64)))).toBe(false);
            expect(fs.existsSync(path.join(myRoot, 'd'.repeat(64)))).toBe(true);
            expect(fs.existsSync(deadRoot)).toBe(false);
            // the materialised snapshot records this process as a holder
            expect(fs.existsSync(path.join(snap.zkConfigPath, '.holders', String(process.pid)))).toBe(true);
            await workerExports.getContractScaffold('e', { ...reg, artifactDigest: digest });
            // evicted while a job holds the generation: the snapshot stays
            workerExports.__evictGenerationForTests(digest);
            expect(fs.existsSync(snap.zkConfigPath)).toBe(true);
            // the job ends: nothing caches or holds the generation any more -> swept
            release();
            expect(fs.existsSync(snap.zkConfigPath)).toBe(false);
            // and it comes back on demand for the next job of that generation
            expect(fs.existsSync(workerExports.materializeArtifactSnapshot('e', { ...reg, artifactDigest: digest }).zkConfigPath)).toBe(true);
        } finally {
            delete process.env.NIGHTGATE_ARTIFACT_SNAPSHOT_DIR;
            workerExports.__resetArtifactSnapshotsForTests();
            workerExports.__resetScaffoldCacheForTests();
            fs.rmSync(snapRoot, { recursive: true, force: true });
        }
    });

    it('a SHIPPED .js ESM artifact (ESM through its package.json scope) snapshots as artifact.mjs and its class loads from the snapshot', async () => {
        const { computeArtifactGenerationDigest, effectiveModuleFormat } = await import('../../srv/submission/artifact-digest.js');
        const repo = path.resolve(__dirname, '../..');
        const reg = {
            artifactPath: path.join(repo, 'contracts/counter/src/managed/counter/contract/index.js'),
            zkConfigPath: path.join(repo, 'contracts/counter/src/managed/counter'),
            privateStateId: 'counter'
        };
        expect(effectiveModuleFormat(reg.artifactPath)).toBe('module');
        const snapRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ng-snap5-'));
        process.env.NIGHTGATE_ARTIFACT_SNAPSHOT_DIR = snapRoot;
        try {
            const digest = computeArtifactGenerationDigest(reg);
            const snap = workerExports.materializeArtifactSnapshot('counter', { ...reg, artifactDigest: digest });
            expect(path.basename(snap.modulePath)).toBe('artifact.mjs');
            // the module's `//# sourceMappingURL=index.js.map` keeps resolving inside the snapshot,
            // and the map's sources resolve too (sourceRoot rebased onto the original directory)
            const mapFile = path.join(path.dirname(snap.modulePath), 'index.js.map');
            expect(fs.existsSync(mapFile)).toBe(true);
            const map = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
            expect(path.isAbsolute(map.sourceRoot)).toBe(true);
            for (const src of map.sources) expect(fs.existsSync(path.join(map.sourceRoot, src))).toBe(true);
            // the snapshot re-verifies from its own extension to the same generation
            expect(computeArtifactGenerationDigest({ ...reg, artifactPath: snap.modulePath, zkConfigPath: snap.zkConfigPath })).toBe(digest);
            // and the real Compact module (bare @midnight-ntwrk/compact-runtime import) loads through the snapshot's node_modules link
            const scaffold = await workerExports.getContractScaffold('counter', { ...reg, artifactDigest: digest });
            expect(typeof scaffold.contractClass).toBe('function');
            expect(scaffold.contractClass.name).toBe('Contract');
        } finally {
            delete process.env.NIGHTGATE_ARTIFACT_SNAPSHOT_DIR;
            workerExports.__resetArtifactSnapshotsForTests();
            workerExports.__resetScaffoldCacheForTests();
            fs.rmSync(snapRoot, { recursive: true, force: true });
        }
    });

    it('a CommonJS artifact is a different generation from the same bytes as ESM, and snapshots as artifact.cjs', async () => {
        const { computeArtifactGenerationDigest, effectiveModuleFormat } = await import('../../srv/submission/artifact-digest.js');
        const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ng-fmt-'));
        fs.mkdirSync(path.join(base, 'esm'), { recursive: true });
        fs.mkdirSync(path.join(base, 'cjs'), { recursive: true });
        fs.writeFileSync(path.join(base, 'esm', 'package.json'), '{"type":"module"}');
        fs.writeFileSync(path.join(base, 'esm', 'index.js'), 'export class Contract {}\n');
        fs.writeFileSync(path.join(base, 'cjs', 'package.json'), '{"type":"commonjs"}');
        fs.writeFileSync(path.join(base, 'cjs', 'index.js'), 'export class Contract {}\n');
        expect(effectiveModuleFormat(path.join(base, 'esm', 'index.js'))).toBe('module');
        expect(effectiveModuleFormat(path.join(base, 'cjs', 'index.js'))).toBe('commonjs');
        const esm = computeArtifactGenerationDigest({ artifactPath: path.join(base, 'esm', 'index.js'), zkConfigPath: base, privateStateId: 'p' });
        const cjs = computeArtifactGenerationDigest({ artifactPath: path.join(base, 'cjs', 'index.js'), zkConfigPath: base, privateStateId: 'p' });
        expect(esm).not.toBe(cjs);
        // ESM adds no section: the digest equals the one of an .mjs twin (recorded digests of shipped ESM contracts stay stable)
        fs.writeFileSync(path.join(base, 'twin.mjs'), 'export class Contract {}\n');
        expect(computeArtifactGenerationDigest({ artifactPath: path.join(base, 'twin.mjs'), zkConfigPath: base, privateStateId: 'p' })).toBe(esm);
        const snapRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ng-snap6-'));
        process.env.NIGHTGATE_ARTIFACT_SNAPSHOT_DIR = snapRoot;
        try {
            fs.writeFileSync(path.join(base, 'cjs', 'index.js'), 'exports.Contract = class Contract { static fmt = "cjs" };\n');
            const reg = { artifactPath: path.join(base, 'cjs', 'index.js'), zkConfigPath: base, privateStateId: 'p' };
            const digest = computeArtifactGenerationDigest(reg);
            const snap = workerExports.materializeArtifactSnapshot('cjs', { ...reg, artifactDigest: digest });
            expect(path.basename(snap.modulePath)).toBe('artifact.cjs');
            const scaffold = await workerExports.getContractScaffold('cjs', { ...reg, artifactDigest: digest });
            expect(scaffold.contractClass.fmt).toBe('cjs');
        } finally {
            delete process.env.NIGHTGATE_ARTIFACT_SNAPSHOT_DIR;
            workerExports.__resetArtifactSnapshotsForTests();
            workerExports.__resetScaffoldCacheForTests();
            fs.rmSync(snapRoot, { recursive: true, force: true });
            fs.rmSync(base, { recursive: true, force: true });
        }
    });

    it('a snapshot root with a REAL node_modules directory or a foreign link fails closed instead of being deleted', async () => {
        const { computeArtifactGenerationDigest } = await import('../../srv/submission/artifact-digest.js');
        const reg = layout('root-safety');
        const digest = computeArtifactGenerationDigest(reg);
        const realDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ng-root-real-'));
        const foreign = fs.mkdtempSync(path.join(os.tmpdir(), 'ng-root-foreign-'));
        const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'ng-elsewhere-'));
        try {
            // a real directory where this process's link would go
            process.env.NIGHTGATE_ARTIFACT_SNAPSHOT_DIR = realDir;
            workerExports.__resetArtifactSnapshotsForTests();
            const myRealRoot = workerExports.artifactSnapshotRoot();
            fs.mkdirSync(path.join(myRealRoot, 'node_modules', 'somebody-elses-package'), { recursive: true });
            fs.writeFileSync(path.join(myRealRoot, 'node_modules', 'somebody-elses-package', 'index.js'), 'x');
            expect(() => workerExports.materializeArtifactSnapshot('root-safety', { ...reg, artifactDigest: digest })).toThrow(/real node_modules directory/);
            expect(fs.existsSync(path.join(myRealRoot, 'node_modules', 'somebody-elses-package', 'index.js'))).toBe(true);
            // a link NIGHTGATE did not create
            process.env.NIGHTGATE_ARTIFACT_SNAPSHOT_DIR = foreign;
            workerExports.__resetArtifactSnapshotsForTests();
            const myForeignRoot = workerExports.artifactSnapshotRoot();
            fs.mkdirSync(myForeignRoot, { recursive: true });
            fs.symlinkSync(elsewhere, path.join(myForeignRoot, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
            expect(() => workerExports.materializeArtifactSnapshot('root-safety', { ...reg, artifactDigest: digest })).toThrow(/did not create/);
            expect(fs.existsSync(elsewhere)).toBe(true);
            // the base itself is never touched: a sibling install/process of the same user keeps its own tree
            expect(fs.existsSync(path.join(realDir, 'node_modules'))).toBe(false);
        } finally {
            delete process.env.NIGHTGATE_ARTIFACT_SNAPSHOT_DIR;
            workerExports.__resetArtifactSnapshotsForTests();
            fs.rmSync(realDir, { recursive: true, force: true });
            fs.rmSync(foreign, { recursive: true, force: true });
            fs.rmSync(elsewhere, { recursive: true, force: true });
        }
    });

    it('rotation becomes due once NIGHTGATE_WORKER_MAX_GENERATIONS distinct generations were imported (never at 0)', () => {
        workerExports.__resetRotationForTests();
        process.env.NIGHTGATE_WORKER_MAX_GENERATIONS = '2';
        try {
            expect(workerExports.noteGenerationImported('a'.repeat(64))).toBe(false);
            expect(workerExports.noteGenerationImported('a'.repeat(64))).toBe(false); // same generation again
            expect(workerExports.noteGenerationImported('b'.repeat(64))).toBe(true);
            expect(workerExports.__rotationStateForTests()).toMatchObject({ generations: 2, pending: true });
            workerExports.__resetRotationForTests();
            process.env.NIGHTGATE_WORKER_MAX_GENERATIONS = '0';
            for (let i = 0; i < 5; i++) expect(workerExports.noteGenerationImported(String(i).repeat(64))).toBe(false);
        } finally {
            delete process.env.NIGHTGATE_WORKER_MAX_GENERATIONS;
            workerExports.__resetRotationForTests();
        }
    });

    it('a due rotation closes admission first and exits only once nothing is in flight, also after a FAILED call', async () => {
        workerExports.__resetRotationForTests();
        process.env.NIGHTGATE_WORKER_MAX_GENERATIONS = '1';
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as any);
        try {
            expect(workerExports.__admitRpcForTests()).toBe(true);
            expect(workerExports.noteGenerationImported('c'.repeat(64))).toBe(true);
            // nothing in flight and nothing ran yet: the state is pending, not draining
            expect(workerExports.__rotationStateForTests()).toMatchObject({ pending: true, draining: false, inflight: 0 });
        } finally {
            exitSpy.mockRestore();
            delete process.env.NIGHTGATE_WORKER_MAX_GENERATIONS;
            workerExports.__resetRotationForTests();
        }
    });

    it('BoundedCache keeps at most `max` generations and refreshes on get', () => {
        const c = new workerExports.BoundedCache(2);
        c.set('a', 1); c.set('b', 2);
        expect(c.get('a')).toBe(1);       // refreshed: 'b' is now the oldest
        c.set('c', 3);
        expect(c.keys()).toEqual(['a', 'c']);
        expect(c.get('b')).toBeUndefined();
        expect(c.size).toBe(2);
        const evicted: string[] = [];
        const h = new workerExports.BoundedCache(1, (k: string) => evicted.push(k));
        h.set('x', 1); h.set('y', 2);
        expect(evicted).toEqual(['x']);
        expect(h.has('y')).toBe(true);
    });

    it('a registration without a digest (older caller) has nothing to verify', () => {
        const reg = layout('b');
        expect(() => workerExports.assertArtifactGenerationOnDisk('b', reg)).not.toThrow();
    });
});

describe('ownContracts: circuits of a grant-deployed contract are sponsorable under a circuit floor', () => {
    const OWN = 'cc'.repeat(32);
    it('a call on an own contract passes the circuit list; the same circuit on another allowed contract still refuses', () => {
        const t = tx([{ actions: [CALL(OWN, 'increment')], guaranteedUnshieldedOffer: null, dustActions: null }]);
        expect(workerExports.checkSponsorableShape(t, 5000, ['aa'.repeat(32), OWN], ['attest'], { ownContracts: [OWN] }))
            .toEqual([{ address: OWN, entryPoint: 'increment' }]);
        const other = tx([{ actions: [CALL('aa'.repeat(32), 'increment')], guaranteedUnshieldedOffer: null, dustActions: null }]);
        expect(() => workerExports.checkSponsorableShape(other, 5000, ['aa'.repeat(32), OWN], ['attest'], { ownContracts: [OWN] }))
            .toThrow(/circuit 'increment' is not sponsorable/);
    });
    it('the exemption never widens the contract list or the byte ceiling', () => {
        const t = tx([{ actions: [CALL(OWN, 'increment')], guaranteedUnshieldedOffer: null, dustActions: null }]);
        expect(() => workerExports.checkSponsorableShape(t, 5000, ['aa'.repeat(32)], ['attest'], { ownContracts: [OWN] }))
            .toThrow(/not in the allow-list/);
        process.env.NIGHTGATE_SPONSOR_MAX_TX_BYTES = '1000';
        expect(() => workerExports.checkSponsorableShape(t, 5000, [], [], { ownContracts: [OWN] })).toThrow(/over the 1000B budget/);
    });
});
