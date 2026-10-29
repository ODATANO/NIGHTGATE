/**
 * Sponsor policy: the transfer right, the unshielded-offer right and its type list.
 * The platform opens them, a grant can only follow and narrow.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('@sap/cds', () => {
    const cds: any = { log: vi.fn(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() })) };
    cds.default = cds;
    return cds;
});
vi.mock('../../srv/submission/learned-token-types', () => ({
    sharedLearnedTokenTypes: () => []
}));

import {
    effectiveSponsorPolicy, getGlobalSponsorPolicy, grantPolicyConflict, SponsorPolicyUnavailableError, __resetSponsorPolicyForTests
} from '../../srv/submission/sponsor-policy';

const ENV_KEYS = [
    'NIGHTGATE_SPONSOR_POLICY_FILE', 'NIGHTGATE_SPONSOR_ALLOW_TRANSFERS', 'NIGHTGATE_SPONSOR_ALLOW_UNSHIELDED_OFFERS',
    'NIGHTGATE_SPONSOR_ALLOWED_UNSHIELDED_TOKEN_TYPES'
];
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ng-policy-rights-'));
afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

const floor = { allowedContracts: [], allowedCircuits: [] };
const N1 = 'ab'.repeat(32);
const N2 = 'cd'.repeat(32);

describe('allowTransfers, allowUnshieldedOffers and the unshielded type list', () => {
    beforeEach(() => {
        for (const k of ENV_KEYS) delete process.env[k];
        __resetSponsorPolicyForTests();
    });

    it('are off by default and read from env', () => {
        expect(getGlobalSponsorPolicy()).toMatchObject({ allowTransfers: false, allowUnshieldedOffers: false, allowedUnshieldedTokenTypes: [] });
        process.env.NIGHTGATE_SPONSOR_ALLOW_TRANSFERS = 'true';
        process.env.NIGHTGATE_SPONSOR_ALLOW_UNSHIELDED_OFFERS = '1';
        process.env.NIGHTGATE_SPONSOR_ALLOWED_UNSHIELDED_TOKEN_TYPES = `0x${N1.toUpperCase()}, ${N1}`;
        expect(getGlobalSponsorPolicy()).toMatchObject({ allowTransfers: true, allowUnshieldedOffers: true, allowedUnshieldedTokenTypes: [N1] });
        process.env.NIGHTGATE_SPONSOR_ALLOWED_UNSHIELDED_TOKEN_TYPES = 'abc';
        expect(() => getGlobalSponsorPolicy()).toThrow(SponsorPolicyUnavailableError);
    });

    it('are read from the policy file; a bad edit keeps the last good policy', () => {
        const file = path.join(tmpDir, 'policy.json');
        fs.writeFileSync(file, JSON.stringify({ allowTransfers: true, allowUnshieldedOffers: true, allowedUnshieldedTokenTypes: [N1, N2] }));
        process.env.NIGHTGATE_SPONSOR_POLICY_FILE = file;
        expect(getGlobalSponsorPolicy()).toMatchObject({ allowTransfers: true, allowUnshieldedOffers: true, allowedUnshieldedTokenTypes: [N1, N2] });
        fs.writeFileSync(file, JSON.stringify({ allowUnshieldedOffers: 'yes' }));
        expect(getGlobalSponsorPolicy().allowUnshieldedOffers).toBe(true);
    });

    it('follow the floor; a token caller needs the right on the grant too', () => {
        expect(effectiveSponsorPolicy(floor, { allowTransfers: true, allowUnshieldedOffers: true })).toMatchObject({ allowTransfers: false, allowUnshieldedOffers: false });
        const open = { ...floor, allowTransfers: true, allowUnshieldedOffers: true };
        expect(effectiveSponsorPolicy(open)).toMatchObject({ allowTransfers: true, allowUnshieldedOffers: true });
        expect(effectiveSponsorPolicy(open, { allowedContracts: ['A'] })).toMatchObject({ allowTransfers: false, allowUnshieldedOffers: false });
        expect(effectiveSponsorPolicy(open, { allowTransfers: true, allowUnshieldedOffers: true })).toMatchObject({ allowTransfers: true, allowUnshieldedOffers: true });
    });

    it('the grant narrows the unshielded type list, never widens it', () => {
        const open = { ...floor, allowUnshieldedOffers: true, allowedUnshieldedTokenTypes: [N1, N2] };
        expect(effectiveSponsorPolicy(open).allowedUnshieldedTokenTypes).toEqual([N1, N2]);
        expect(effectiveSponsorPolicy(open, { allowUnshieldedOffers: true, allowedUnshieldedTokenTypes: [N2] }).allowedUnshieldedTokenTypes).toEqual([N2]);
        expect(effectiveSponsorPolicy(open, { allowUnshieldedOffers: true, allowedUnshieldedTokenTypes: ['ef'.repeat(32)] }).allowedUnshieldedTokenTypes).toEqual([]);
        expect(effectiveSponsorPolicy(floor, { allowedUnshieldedTokenTypes: [N1] }).allowedUnshieldedTokenTypes).toEqual([]);
    });

    it('grantPolicyConflict names an unshielded type the platform does not list', () => {
        expect(grantPolicyConflict({ ...floor, allowedUnshieldedTokenTypes: [N1] }, { allowedUnshieldedTokenTypes: [N1] })).toBeNull();
        expect(grantPolicyConflict({ ...floor, allowedUnshieldedTokenTypes: [N1] }, { allowedUnshieldedTokenTypes: [N2] }))
            .toMatch(/allowedUnshieldedTokenTypes cdcd.* is not in the platform's unshielded token-type list/);
        expect(grantPolicyConflict(floor, { allowedUnshieldedTokenTypes: [N2] })).toMatch(/the platform lists none besides NIGHT/);
    });
});
