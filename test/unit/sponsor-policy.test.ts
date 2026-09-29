import cds from '@sap/cds';
/**
 * Sponsor shape policy: platform floor (env or file, hot-reloaded) narrowed by
 * the agent grant. Pure functions plus the file path against a temp directory; no CAP, no worker.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('@sap/cds', () => {
    const cds: any = { log: vi.fn(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() })) };
    cds.default = cds;
    return cds;
});

import {
    validatePolicyList,
    validateTokenTypeList,
    effectiveSponsorPolicy,
    getGlobalSponsorPolicy,
    resolveSponsorPolicyForRequest,
    SponsorPolicyEmptyError,
    SponsorPolicyUnavailableError,
    MAX_POLICY_ENTRIES,
    grantPolicyConflict,
    describeGlobalSponsorPolicy,
    shadowedSponsorEnvKeys,
    __resetSponsorPolicyForTests
} from '../../srv/submission/sponsor-policy';

const ENV_KEYS = ['NIGHTGATE_SPONSOR_ALLOWED_CONTRACTS', 'NIGHTGATE_SPONSOR_ALLOWED_CIRCUITS', 'NIGHTGATE_SPONSOR_POLICY_FILE', 'NIGHTGATE_SPONSOR_ALLOWED_TOKEN_TYPES',
    'NIGHTGATE_SPONSOR_ALLOW_CONTRACT_MINTS', 'NIGHTGATE_SPONSOR_ALLOW_DEPLOY', 'NIGHTGATE_SPONSOR_ALLOW_SWAPS'];
let tmpDir: string;

beforeEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
    __resetSponsorPolicyForTests();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightgate-policy-'));
});
afterEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('validatePolicyList', () => {
    it('trims, de-duplicates, and treats absent as empty', () => {
        expect(validatePolicyList('x', undefined)).toMatchObject([]);
        expect(validatePolicyList('x', null)).toMatchObject([]);
        expect(validatePolicyList('x', [' 0xVAULT ', '0xVAULT', 'attest'])).toMatchObject(['0xVAULT', 'attest']);
    });
    it('refuses what cannot be an address or a circuit name', () => {
        expect(() => validatePolicyList('allowedContracts', 'abc' as any)).toThrow(/array/);
        expect(() => validatePolicyList('allowedContracts', [''])).toThrow(/empty entry/);
        expect(() => validatePolicyList('allowedContracts', ['a,b'])).toThrow(/not a contract address/);
        expect(() => validatePolicyList('allowedContracts', ['has space'])).toThrow(/not a contract address/);
        expect(() => validatePolicyList('allowedContracts', [42 as any])).toThrow(/strings/);
        expect(() => validatePolicyList('allowedContracts', ['x'.repeat(131)])).toThrow(/longer/);
        expect(() => validatePolicyList('allowedContracts', Array.from({ length: MAX_POLICY_ENTRIES + 1 }, (_, i) => `c${i}`))).toThrow(/at most/);
    });
});

describe('allowedTokenTypes: raw types, floor opens, grant narrows', () => {
    const T1 = 'ab'.repeat(32);
    const T2 = 'cd'.repeat(32);

    it('validateTokenTypeList accepts 64 hex with optional 0x, normalizes and de-duplicates', () => {
        expect(validateTokenTypeList('x', undefined)).toEqual([]);
        expect(validateTokenTypeList('x', [' 0x' + T1.toUpperCase() + ' ', T1])).toEqual([T1]);
        expect(() => validateTokenTypeList('allowedTokenTypes', ['attest'])).toThrow(/not a raw token type/);
        expect(() => validateTokenTypeList('allowedTokenTypes', [T1.slice(1)])).toThrow(/not a raw token type/);
        expect(() => validateTokenTypeList('allowedTokenTypes', 'x' as any)).toThrow(/array/);
    });

    it('env floor: NIGHTGATE_SPONSOR_ALLOWED_TOKEN_TYPES, invalid entries fail closed (503)', () => {
        expect(getGlobalSponsorPolicy().allowedTokenTypes).toEqual([]);
        process.env.NIGHTGATE_SPONSOR_ALLOWED_TOKEN_TYPES = `${T1}, 0x${T2}`;
        expect(getGlobalSponsorPolicy().allowedTokenTypes).toEqual([T1, T2]);
        process.env.NIGHTGATE_SPONSOR_ALLOWED_TOKEN_TYPES = 'wzec';
        expect(() => getGlobalSponsorPolicy()).toThrow(SponsorPolicyUnavailableError);
    });

    it('policy file: allowedTokenTypes is a known key and validated', () => {
        const file = path.join(tmpDir, 'policy.json');
        fs.writeFileSync(file, JSON.stringify({ allowedContracts: ['A'], allowedTokenTypes: [T1] }));
        process.env.NIGHTGATE_SPONSOR_POLICY_FILE = file;
        expect(getGlobalSponsorPolicy().allowedTokenTypes).toEqual([T1]);
        fs.writeFileSync(file, JSON.stringify({ allowedTokenTypes: ['nope'] }));
        __resetSponsorPolicyForTests();
        expect(() => getGlobalSponsorPolicy()).toThrow(SponsorPolicyUnavailableError);
    });

    it('effective: a closed floor stays closed whatever the grant says; a grant narrows an open floor', () => {
        const closed = { allowedContracts: [], allowedCircuits: [] };
        expect(effectiveSponsorPolicy(closed).allowedTokenTypes).toEqual([]);
        expect(effectiveSponsorPolicy(closed, { allowedTokenTypes: [T1] }).allowedTokenTypes).toEqual([]);
        const open = { allowedContracts: [], allowedCircuits: [], allowedTokenTypes: [T1, T2] };
        expect(effectiveSponsorPolicy(open).allowedTokenTypes).toEqual([T1, T2]);
        expect(effectiveSponsorPolicy(open, { allowedTokenTypes: [] }).allowedTokenTypes).toEqual([T1, T2]);
        expect(effectiveSponsorPolicy(open, { allowedTokenTypes: [T2] }).allowedTokenTypes).toEqual([T2]);
        // Nothing shared: no offers, and the grant's other calls keep working.
        expect(effectiveSponsorPolicy(open, { allowedTokenTypes: ['ef'.repeat(32)] }).allowedTokenTypes).toEqual([]);
        expect(effectiveSponsorPolicy({ ...open, allowedContracts: ['A'] }, { allowedTokenTypes: ['ef'.repeat(32)] }))
            .toMatchObject({ allowedContracts: ['A'], allowedTokenTypes: [] });
    });
});

describe('effectiveSponsorPolicy', () => {
    const floor = { allowedContracts: ['A', 'B'], allowedCircuits: ['attest', 'anchorContentRoot'] };

    it('no grant, or a grant without lists, inherits the floor', () => {
        expect(effectiveSponsorPolicy(floor)).toMatchObject(floor);
        expect(effectiveSponsorPolicy(floor, null)).toMatchObject(floor);
        expect(effectiveSponsorPolicy(floor, { allowedContracts: [], allowedCircuits: null })).toMatchObject(floor);
    });
    it('narrows the floor to the intersection', () => {
        expect(effectiveSponsorPolicy(floor, { allowedContracts: ['B', 'C'], allowedCircuits: ['attest'] }))
            .toMatchObject({ allowedContracts: ['B'], allowedCircuits: ['attest'] });
    });
    it('an unrestricted floor lets the grant BE the policy', () => {
        expect(effectiveSponsorPolicy({ allowedContracts: [], allowedCircuits: [] }, { allowedContracts: ['C'], allowedCircuits: ['x'] }))
            .toMatchObject({ allowedContracts: ['C'], allowedCircuits: ['x'] });
    });
    it('two non-empty lists sharing nothing refuse with 403 (a grant can never widen the floor)', () => {
        expect(() => effectiveSponsorPolicy(floor, { allowedContracts: ['C'] })).toThrow(SponsorPolicyEmptyError);
        try { effectiveSponsorPolicy(floor, { allowedCircuits: ['sendAllMyMoney'] }); }
        catch (e: any) { expect(e.httpStatus).toBe(403); expect(e.code).toBe('SPONSOR_POLICY_EMPTY'); expect(e.message).toMatch(/allowedCircuits/); }
    });
});

describe('allowDeploy: floor AND grant, never implied', () => {
    const floorOpen = { allowedContracts: [], allowedCircuits: [], allowDeploy: true };
    const floorClosed = { allowedContracts: [], allowedCircuits: [] };

    it('is off unless the floor opens it', () => {
        expect(effectiveSponsorPolicy(floorClosed).allowDeploy).toBe(false);
        expect(effectiveSponsorPolicy(floorClosed, { allowDeploy: true }).allowDeploy).toBe(false);
    });
    it('a plain caller inherits the open floor; a token caller needs it on the grant too', () => {
        expect(effectiveSponsorPolicy(floorOpen).allowDeploy).toBe(true);
        expect(effectiveSponsorPolicy(floorOpen, { allowedContracts: ['A'] }).allowDeploy).toBe(false);
        expect(effectiveSponsorPolicy(floorOpen, { allowDeploy: true }).allowDeploy).toBe(true);
    });
    it('reads the floor from env and from the policy file', () => {
        process.env.NIGHTGATE_SPONSOR_ALLOW_DEPLOY = 'true';
        expect(getGlobalSponsorPolicy().allowDeploy).toBe(true);
        process.env.NIGHTGATE_SPONSOR_ALLOW_DEPLOY = 'no';
        expect(getGlobalSponsorPolicy().allowDeploy).toBe(false);
        delete process.env.NIGHTGATE_SPONSOR_ALLOW_DEPLOY;
        const file = path.join(tmpDir, 'p.json');
        fs.writeFileSync(file, JSON.stringify({ allowedContracts: [], allowDeploy: true }));
        process.env.NIGHTGATE_SPONSOR_POLICY_FILE = file;
        expect(getGlobalSponsorPolicy().allowDeploy).toBe(true);
        fs.writeFileSync(file, JSON.stringify({ allowedContracts: [], allowDeploy: 'yes' }));
        // Invalid edit: the last good policy (deploy open) stays in force.
        expect(getGlobalSponsorPolicy().allowDeploy).toBe(true);
    });
});

describe('getGlobalSponsorPolicy', () => {
    it('reads the env lists when no file is configured', () => {
        process.env.NIGHTGATE_SPONSOR_ALLOWED_CONTRACTS = '0xVAULT, 0xOTHER';
        process.env.NIGHTGATE_SPONSOR_ALLOWED_CIRCUITS = 'attest';
        expect(getGlobalSponsorPolicy()).toMatchObject({ allowedContracts: ['0xVAULT', '0xOTHER'], allowedCircuits: ['attest'] });
        delete process.env.NIGHTGATE_SPONSOR_ALLOWED_CIRCUITS;
        expect(getGlobalSponsorPolicy().allowedCircuits).toMatchObject([]);
    });

    it('reads the file, and picks up an edit without a restart (mtime cache)', () => {
        const file = path.join(tmpDir, 'sponsor-policy.json');
        fs.writeFileSync(file, JSON.stringify({ allowedContracts: ['A'], allowedCircuits: ['attest'] }));
        process.env.NIGHTGATE_SPONSOR_POLICY_FILE = file;
        process.env.NIGHTGATE_SPONSOR_ALLOWED_CONTRACTS = 'IGNORED_WHEN_FILE_SET';
        expect(getGlobalSponsorPolicy()).toMatchObject({ allowedContracts: ['A'], allowedCircuits: ['attest'] });

        // Edit in place: a size change is noticed even when the mtime granularity swallows it.
        fs.writeFileSync(file, JSON.stringify({ allowedContracts: ['A', 'B'], allowedCircuits: ['attest', 'anchorContentRoot'] }));
        expect(getGlobalSponsorPolicy()).toMatchObject({ allowedContracts: ['A', 'B'], allowedCircuits: ['attest', 'anchorContentRoot'] });
    });

    it('a configured but missing file with nothing loaded yet FAILS CLOSED (503), never "allow any"', () => {
        process.env.NIGHTGATE_SPONSOR_POLICY_FILE = path.join(tmpDir, 'absent.json');
        expect(() => getGlobalSponsorPolicy()).toThrow(SponsorPolicyUnavailableError);
        expect(() => getGlobalSponsorPolicy()).toThrow(/refusing to sponsor/); // and again, from the cache
        expect(() => resolveSponsorPolicyForRequest({})).toThrow(SponsorPolicyUnavailableError);
    });

    it('an invalid edit keeps the LAST GOOD policy in force', () => {
        const file = path.join(tmpDir, 'sponsor-policy.json');
        fs.writeFileSync(file, JSON.stringify({ allowedContracts: ['A'], allowedCircuits: [] }));
        process.env.NIGHTGATE_SPONSOR_POLICY_FILE = file;
        expect(getGlobalSponsorPolicy().allowedContracts).toMatchObject(['A']);
        fs.writeFileSync(file, '{ not json');
        expect(getGlobalSponsorPolicy().allowedContracts).toMatchObject(['A']);
        fs.writeFileSync(file, JSON.stringify({ allowedContracts: ['A'], bogus: 1 }));
        expect(getGlobalSponsorPolicy().allowedContracts).toMatchObject(['A']);
        fs.writeFileSync(file, JSON.stringify({ allowedContracts: ['not an address!'] }));
        expect(getGlobalSponsorPolicy().allowedContracts).toMatchObject(['A']);
        // Deleted: still the last good policy.
        fs.rmSync(file);
        expect(getGlobalSponsorPolicy().allowedContracts).toMatchObject(['A']);
    });

    it('an empty file object is "unrestricted", explicitly', () => {
        const file = path.join(tmpDir, 'p.json');
        fs.writeFileSync(file, '{}');
        process.env.NIGHTGATE_SPONSOR_POLICY_FILE = file;
        expect(getGlobalSponsorPolicy()).toMatchObject({ allowedContracts: [], allowedCircuits: [] });
    });
});

// A contract deployed under the grant is sponsorable at once; it joins the effective
// list after floor ∩ grant, since a non-empty floor would intersect it away.
describe('deployedContracts join the effective policy after the intersection', () => {
    const floor = { allowedContracts: ['A', 'B'], allowedCircuits: [] };

    it('a fresh address survives a non-empty platform floor', () => {
        expect(effectiveSponsorPolicy(floor, { allowedContracts: ['B'], deployedContracts: ['NEW'] }).allowedContracts).toEqual(['B', 'NEW']);
    });
    it('an inheriting grant (no own list) keeps the floor and gains the address', () => {
        expect(effectiveSponsorPolicy(floor, { deployedContracts: ['NEW'] }).allowedContracts).toEqual(['A', 'B', 'NEW']);
    });
    it('an unrestricted result stays unrestricted; duplicates and blanks are ignored', () => {
        expect(effectiveSponsorPolicy({ allowedContracts: [], allowedCircuits: [] }, { deployedContracts: ['NEW'] }).allowedContracts).toEqual([]);
        expect(effectiveSponsorPolicy(floor, { allowedContracts: ['A'], deployedContracts: ['A', '', 'NEW', 'NEW'] }).allowedContracts).toEqual(['A', 'NEW']);
    });
    it('does not rescue an empty intersection of the STATIC lists (still a misconfiguration)', () => {
        expect(() => effectiveSponsorPolicy(floor, { allowedContracts: ['Z'], deployedContracts: ['NEW'] })).toThrow(SponsorPolicyEmptyError);
    });
    it('rides along through resolveSponsorPolicyForRequest', () => {
        process.env.NIGHTGATE_SPONSOR_ALLOWED_CONTRACTS = 'A,B';
        const req = { agentGrant: { ID: 'g', allowedContracts: ['B'], allowedCircuits: [], deployedContracts: ['NEW'] } };
        expect(resolveSponsorPolicyForRequest(req).allowedContracts).toEqual(['B', 'NEW']);
    });
});

describe('a missing policy file is reported once, not per request', () => {
    it('logs the first miss at ERROR, stays silent while the file stays missing, and refuses each time', () => {
        const file = path.join(tmpDir, 'never-there.json');
        process.env.NIGHTGATE_SPONSOR_POLICY_FILE = file;
        // the module captured ITS logger at import (the mock hands out one per cds.log call)
        const logger: any = (cds.log as any).mock.results[0].value;
        const before = logger.error.mock.calls.length;
        expect(() => getGlobalSponsorPolicy()).toThrow(SponsorPolicyUnavailableError);
        expect(() => getGlobalSponsorPolicy()).toThrow(SponsorPolicyUnavailableError);
        expect(() => getGlobalSponsorPolicy()).toThrow(SponsorPolicyUnavailableError);
        expect(logger.error.mock.calls.length - before).toBe(1);
        // the file appears: read, cached, no error
        fs.writeFileSync(file, JSON.stringify({ allowedContracts: ['A'] }));
        expect(getGlobalSponsorPolicy().allowedContracts).toEqual(['A']);
        expect(logger.error.mock.calls.length - before).toBe(1);
    });
});

describe('resolveSponsorPolicyForRequest', () => {
    it('narrows the floor by req.agentGrant', () => {
        process.env.NIGHTGATE_SPONSOR_ALLOWED_CONTRACTS = 'A,B';
        const req = { agentGrant: { ID: 'g', allowedContracts: ['B'], allowedCircuits: ['attest'] } };
        expect(resolveSponsorPolicyForRequest(req)).toMatchObject({ allowedContracts: ['B'], allowedCircuits: ['attest'] });
        expect(resolveSponsorPolicyForRequest({})).toMatchObject({ allowedContracts: ['A', 'B'], allowedCircuits: [] });
    });
});

describe('ownContracts: calls on grant-deployed addresses are exempt from the circuit floor', () => {
    const floor = { allowedContracts: ['A'], allowedCircuits: ['attest'] };
    it('lists the grant\'s deployed addresses as ownContracts, deduplicated, blanks dropped', () => {
        expect(effectiveSponsorPolicy(floor, { deployedContracts: ['NEW', '', 'NEW', 'OTHER'] }).ownContracts).toEqual(['NEW', 'OTHER']);
    });
    it('is absent without a grant or without deployed addresses (no exemption)', () => {
        expect(effectiveSponsorPolicy(floor).ownContracts).toBeUndefined();
        expect(effectiveSponsorPolicy(floor, { deployedContracts: [] }).ownContracts).toBeUndefined();
        expect(effectiveSponsorPolicy(floor, { allowedContracts: ['A'] }).ownContracts).toBeUndefined();
    });
    it('does not widen allowedCircuits itself', () => {
        expect(effectiveSponsorPolicy(floor, { deployedContracts: ['NEW'] }).allowedCircuits).toEqual(['attest']);
    });
});

describe('allowContractMints: a platform switch', () => {
    const floor = { allowedContracts: [], allowedCircuits: [] };

    it('is off by default and read from env and from the policy file', () => {
        expect(getGlobalSponsorPolicy().allowContractMints).toBe(false);
        process.env.NIGHTGATE_SPONSOR_ALLOW_CONTRACT_MINTS = 'true';
        expect(getGlobalSponsorPolicy().allowContractMints).toBe(true);
        delete process.env.NIGHTGATE_SPONSOR_ALLOW_CONTRACT_MINTS;

        const file = path.join(tmpDir, 'policy.json');
        fs.writeFileSync(file, JSON.stringify({ allowContractMints: true }));
        process.env.NIGHTGATE_SPONSOR_POLICY_FILE = file;
        expect(getGlobalSponsorPolicy().allowContractMints).toBe(true);
    });

    it('a policy file with a non-boolean value is refused', () => {
        const file = path.join(tmpDir, 'policy.json');
        fs.writeFileSync(file, JSON.stringify({ allowContractMints: 'yes' }));
        process.env.NIGHTGATE_SPONSOR_POLICY_FILE = file;
        expect(() => getGlobalSponsorPolicy()).toThrow(SponsorPolicyUnavailableError);
    });

    it('follows the floor; a grant neither opens nor closes it', () => {
        expect(effectiveSponsorPolicy(floor).allowContractMints).toBe(false);
        expect(effectiveSponsorPolicy(floor, { allowContractMints: true } as any).allowContractMints).toBe(false);
        expect(effectiveSponsorPolicy({ ...floor, allowContractMints: true }, { allowedContracts: ['A'] }).allowContractMints).toBe(true);
    });
});

describe('grantPolicyConflict: lists checked when a grant is written', () => {
    const T1 = 'ab'.repeat(32);
    const T2 = 'cd'.repeat(32);
    const floor = { allowedContracts: ['A', 'B'], allowedCircuits: ['attest'], allowedTokenTypes: [T1] };

    it('accepts lists inside the floor, and a grant without lists', () => {
        expect(grantPolicyConflict(floor, {})).toBeNull();
        expect(grantPolicyConflict(floor, { allowedContracts: ['B'], allowedCircuits: ['attest'], allowedTokenTypes: [T1] })).toBeNull();
    });

    it('names every token type outside the platform list', () => {
        expect(grantPolicyConflict(floor, { allowedTokenTypes: [T1, T2] }))
            .toBe(`allowedTokenTypes ${T2} is not in the platform's sponsor token-type allow-list; the platform policy has to list a type before a grant can`);
        expect(grantPolicyConflict({ allowedContracts: [], allowedCircuits: [] }, { allowedTokenTypes: [T1, T2] }))
            .toMatch(new RegExp(`^allowedTokenTypes ${T1}, ${T2} are not in .* \\(the platform lists none\\)`));
    });

    it('reports contracts and circuits that share nothing with the floor', () => {
        expect(grantPolicyConflict(floor, { allowedContracts: ['C'] })).toMatch(/allowedContracts \(C\) share nothing/);
        expect(grantPolicyConflict(floor, { allowedCircuits: ['mint'] })).toMatch(/allowedCircuits \(mint\) share nothing/);
        // A partial overlap narrows; an unrestricted floor takes the grant's list as it is.
        expect(grantPolicyConflict(floor, { allowedContracts: ['B', 'C'] })).toBeNull();
        expect(grantPolicyConflict({ allowedContracts: [], allowedCircuits: [] }, { allowedContracts: ['C'] })).toBeNull();
    });
});

describe('describeGlobalSponsorPolicy', () => {
    it('env: source, no path, no load time', () => {
        process.env.NIGHTGATE_SPONSOR_ALLOWED_CONTRACTS = 'A,B';
        expect(describeGlobalSponsorPolicy()).toMatchObject({
            source: 'env', path: null, loadedAt: null, ignoredEnv: [], floorError: null,
            floor: { allowedContracts: ['A', 'B'], allowedCircuits: [], allowedTokenTypes: [], allowDeploy: false, allowContractMints: false }
        });
    });

    it('file: path, load time, and the env settings it replaces', () => {
        const file = path.join(tmpDir, 'policy.json');
        fs.writeFileSync(file, JSON.stringify({ allowedContracts: ['X'] }));
        process.env.NIGHTGATE_SPONSOR_POLICY_FILE = file;
        process.env.NIGHTGATE_SPONSOR_ALLOWED_CONTRACTS = 'A,B';
        process.env.NIGHTGATE_SPONSOR_ALLOWED_CIRCUITS = 'attest';
        const described = describeGlobalSponsorPolicy();
        expect(described).toMatchObject({
            source: 'file', path: file, floorError: null,
            ignoredEnv: ['NIGHTGATE_SPONSOR_ALLOWED_CONTRACTS', 'NIGHTGATE_SPONSOR_ALLOWED_CIRCUITS'],
            floor: { allowedContracts: ['X'], allowedCircuits: [] }
        });
        expect(Number.isNaN(Date.parse(String(described.loadedAt)))).toBe(false);
        expect(shadowedSponsorEnvKeys()).toHaveLength(2);
    });

    it('an unusable file reports the reason instead of a floor', () => {
        process.env.NIGHTGATE_SPONSOR_POLICY_FILE = path.join(tmpDir, 'missing.json');
        expect(describeGlobalSponsorPolicy()).toMatchObject({ source: 'file', floor: null, loadedAt: null, floorError: expect.stringMatching(/cannot be read/) });
    });

    it('warns once when the policy file replaces env settings', () => {
        const file = path.join(tmpDir, 'policy.json');
        fs.writeFileSync(file, JSON.stringify({}));
        process.env.NIGHTGATE_SPONSOR_POLICY_FILE = file;
        process.env.NIGHTGATE_SPONSOR_ALLOWED_CIRCUITS = 'attest';
        const warn = (cds.log as any).mock.results[0].value.warn;
        warn.mockClear();
        getGlobalSponsorPolicy();
        getGlobalSponsorPolicy();
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith(expect.stringMatching(/NIGHTGATE_SPONSOR_ALLOWED_CIRCUITS are set and ignored/));
    });
});

describe('allowSwaps: floor AND the grant action', () => {
    const closed = { allowedContracts: [], allowedCircuits: [] };
    const open = { ...closed, allowSwaps: true };

    it('is off by default and read from env and from the policy file', () => {
        expect(getGlobalSponsorPolicy().allowSwaps).toBe(false);
        process.env.NIGHTGATE_SPONSOR_ALLOW_SWAPS = 'true';
        expect(getGlobalSponsorPolicy().allowSwaps).toBe(true);
        delete process.env.NIGHTGATE_SPONSOR_ALLOW_SWAPS;
        const file = path.join(tmpDir, 'policy.json');
        fs.writeFileSync(file, JSON.stringify({ allowSwaps: true }));
        process.env.NIGHTGATE_SPONSOR_POLICY_FILE = file;
        expect(getGlobalSponsorPolicy().allowSwaps).toBe(true);
        fs.writeFileSync(file, JSON.stringify({ allowSwaps: 1, pad: 'x' }));
        expect(getGlobalSponsorPolicy().allowSwaps).toBe(true); // invalid edit: the last good policy stays
    });

    it('a plain caller inherits the floor; a grant needs the right itself', () => {
        expect(effectiveSponsorPolicy(closed, { allowSwaps: true }).allowSwaps).toBe(false);
        expect(effectiveSponsorPolicy(open).allowSwaps).toBe(true);
        expect(effectiveSponsorPolicy(open, { allowedContracts: ['A'] }).allowSwaps).toBe(false);
        expect(effectiveSponsorPolicy(open, { allowSwaps: true }).allowSwaps).toBe(true);
    });
});

describe('mintedTokenTypes: what a grant minted counts as listed for it', () => {
    const T1 = 'ab'.repeat(32);
    const T2 = 'cd'.repeat(32);
    const M = 'ef'.repeat(32);
    const floor = { allowedContracts: [], allowedCircuits: [], allowedTokenTypes: [T1, T2], allowContractMints: true };

    it('joins after the intersection, once, and is reported as ownTokenTypes', () => {
        expect(effectiveSponsorPolicy(floor, { allowedTokenTypes: [T2], mintedTokenTypes: [M, M, T2] }))
            .toMatchObject({ allowedTokenTypes: [T2, M], ownTokenTypes: [M, T2] });
        // a platform that lists no type at all still sponsors what the grant minted
        expect(effectiveSponsorPolicy({ ...floor, allowedTokenTypes: [] }, { mintedTokenTypes: [M] }).allowedTokenTypes).toEqual([M]);
    });

    it('counts only while the platform sponsors contract mints, and only raw types', () => {
        const off = effectiveSponsorPolicy({ ...floor, allowContractMints: false }, { mintedTokenTypes: [M] });
        expect(off.allowedTokenTypes).toEqual([T1, T2]);
        expect(off.ownTokenTypes).toBeUndefined();
        expect(effectiveSponsorPolicy(floor, { mintedTokenTypes: ['nope', M.toUpperCase()] }).ownTokenTypes).toBeUndefined();
    });

    it('is absent without a grant', () => {
        expect(effectiveSponsorPolicy(floor).ownTokenTypes).toBeUndefined();
    });
});
