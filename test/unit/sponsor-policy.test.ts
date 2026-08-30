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
    __resetSponsorPolicyForTests
} from '../../srv/submission/sponsor-policy';

const ENV_KEYS = ['NIGHTGATE_SPONSOR_ALLOWED_CONTRACTS', 'NIGHTGATE_SPONSOR_ALLOWED_CIRCUITS', 'NIGHTGATE_SPONSOR_POLICY_FILE', 'NIGHTGATE_SPONSOR_ALLOWED_TOKEN_TYPES'];
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

describe('allowedTokenTypes (0.22.0): raw types, floor opens, grant narrows', () => {
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
        expect(() => effectiveSponsorPolicy(open, { allowedTokenTypes: ['ef'.repeat(32)] })).toThrow(SponsorPolicyEmptyError);
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

describe('allowDeploy (0.21.0): floor AND grant, never implied', () => {
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
