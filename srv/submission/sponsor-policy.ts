/**
 * Decides which calls a fee sponsor pays for. The platform policy comes from env
 * or from `NIGHTGATE_SPONSOR_POLICY_FILE`. An agent grant can only narrow it further.
 * An empty platform list allows everything. An empty grant list takes the platform list.
 */
import fs from 'node:fs';
import cds from '@sap/cds';
import { configList, configFlag, configString, configIsSet } from '../utils/config';
import { NightgateError, errorMessage } from '../utils/errors';
import { HEX64_RE } from '../utils/hex';
import { sharedLearnedTokenTypes } from './learned-token-types';

const log = cds.log('nightgate:sponsor-policy');

export interface SponsorPolicy {
    allowedContracts: string[];
    allowedCircuits: string[];
    /** Sponsor deploys built by the caller. The platform and, for an agent, the grant must both allow it. */
    allowDeploy?: boolean;
    /**
     * Contracts deployed under the grant. `allowedCircuits` does not apply to them,
     * because it names circuits of the shared contracts. The size limit still applies.
     */
    ownContracts?: string[];
    /** Raw token types (64 hex) whose zswap offers are sponsored. Empty means none. */
    allowedTokenTypes?: string[];
    /** Also sponsor the offer of a token a sponsorable contract mints in the same transaction. */
    allowContractMints?: boolean;
    /** Sponsor shielded swaps sent in as two halves. The platform and, for an agent, the grant must both allow it. */
    allowSwaps?: boolean;
    /** Token types minted under any grant count as allowed for every grant. Needs `allowContractMints`. */
    shareMintedTokenTypes?: boolean;
    /** Token types minted under the grant. They are always part of `allowedTokenTypes`. */
    ownTokenTypes?: string[];
    /** Token types minted anywhere on the platform that are part of `allowedTokenTypes`. */
    sharedTokenTypes?: string[];
}

export interface GrantPolicyInput {
    allowedContracts?: string[] | null;
    allowedCircuits?: string[] | null;
    allowDeploy?: boolean | null;
    /** Contracts deployed under this grant. They are sponsored in addition to the narrowed lists. */
    deployedContracts?: string[] | null;
    allowedTokenTypes?: string[] | null;
    /** Token types minted under this grant. Sponsored in addition to the narrowed list while the platform sponsors contract mints. */
    mintedTokenTypes?: string[] | null;
    allowSwaps?: boolean | null;
}

/** Maximum entries per list. A grant serves one consumer and does not need more. */
export const MAX_POLICY_ENTRIES = 256;
const MAX_ENTRY_LENGTH = 130;

/**
 * Validates an allow-list, trimmed and without duplicates.
 * A malformed entry throws, so it cannot sit in the list and silently never match.
 */
export function validatePolicyList(name: string, raw: unknown): string[] {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw)) throw new Error(`${name} must be an array of strings`);
    if (raw.length > MAX_POLICY_ENTRIES) throw new Error(`${name} has ${raw.length} entries; at most ${MAX_POLICY_ENTRIES} are allowed`);
    const out: string[] = [];
    for (const entry of raw) {
        if (typeof entry !== 'string') throw new Error(`${name} entries must be strings`);
        const v = entry.trim();
        if (!v) throw new Error(`${name} contains an empty entry`);
        if (v.length > MAX_ENTRY_LENGTH) throw new Error(`${name} entry '${v.slice(0, 16)}…' is longer than ${MAX_ENTRY_LENGTH} characters`);
        if (!/^[A-Za-z0-9_]+$/.test(v)) throw new Error(`${name} entry '${v.slice(0, 32)}' is not a contract address or circuit name`);
        if (!out.includes(v)) out.push(v);
    }
    return out;
}

/** Validates raw token types as they appear in offer `deltas`. Lowercase, no 0x, no duplicates. */
export function validateTokenTypeList(name: string, raw: unknown): string[] {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw)) throw new Error(`${name} must be an array of strings`);
    if (raw.length > MAX_POLICY_ENTRIES) throw new Error(`${name} has ${raw.length} entries; at most ${MAX_POLICY_ENTRIES} are allowed`);
    const out: string[] = [];
    for (const entry of raw) {
        if (typeof entry !== 'string') throw new Error(`${name} entries must be strings`);
        const v = entry.trim().toLowerCase().replace(/^0x/, '');
        if (!HEX64_RE.test(v)) throw new Error(`${name} entry '${entry.trim().slice(0, 32)}' is not a raw token type (64 hex; use deriveTokenType)`);
        if (!out.includes(v)) out.push(v);
    }
    return out;
}

// ---- Platform policy -------------------------------------------------------

function envPolicy(): SponsorPolicy {
    let allowedTokenTypes: string[];
    try {
        allowedTokenTypes = validateTokenTypeList('NIGHTGATE_SPONSOR_ALLOWED_TOKEN_TYPES', configList('NIGHTGATE_SPONSOR_ALLOWED_TOKEN_TYPES'));
    } catch (e) {
        // Refuse to sponsor rather than use a list that silently lost an entry.
        throw new SponsorPolicyUnavailableError(`${(e as Error).message}; refusing to sponsor`);
    }
    return {
        allowedContracts: configList('NIGHTGATE_SPONSOR_ALLOWED_CONTRACTS'),
        allowedCircuits: configList('NIGHTGATE_SPONSOR_ALLOWED_CIRCUITS'),
        allowDeploy: configFlag('NIGHTGATE_SPONSOR_ALLOW_DEPLOY'),
        allowedTokenTypes,
        allowContractMints: configFlag('NIGHTGATE_SPONSOR_ALLOW_CONTRACT_MINTS'),
        allowSwaps: configFlag('NIGHTGATE_SPONSOR_ALLOW_SWAPS'),
        shareMintedTokenTypes: configFlag('NIGHTGATE_SPONSOR_SHARE_MINTED_TOKEN_TYPES')
    };
}

interface FileCache {
    path: string;
    mtimeMs: number;
    size: number;
    policy: SponsorPolicy | null;
    lastGood: SponsorPolicy | null;
    loadedAt: string | null; // when `lastGood` was read
}
let fileCache: FileCache | null = null;

/** Test seam: forget the cached file state. */
export function __resetSponsorPolicyForTests(): void {
    fileCache = null;
    shadowedEnvLogged = false;
}

export class SponsorPolicyUnavailableError extends NightgateError {
    constructor(message: string) {
        super('SPONSOR_POLICY_UNAVAILABLE', message, { exposeMessage: true });
    }
    /** @deprecated use `status`. */
    get httpStatus(): number { return this.status; }
}

function readPolicyFile(filePath: string): SponsorPolicy {
    const text = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('policy file must be a JSON object');
    }
    const unknownKeys = Object.keys(parsed).filter(k => !POLICY_FILE_KEYS.includes(k));
    if (unknownKeys.length) throw new Error(`policy file has unknown keys: ${unknownKeys.join(', ')}`);
    for (const flag of ['allowDeploy', 'allowContractMints', 'allowSwaps', 'shareMintedTokenTypes']) {
        if (parsed[flag] !== undefined && typeof parsed[flag] !== 'boolean') throw new Error(`${flag} must be a boolean`);
    }
    return {
        allowedContracts: validatePolicyList('allowedContracts', parsed.allowedContracts),
        allowedCircuits: validatePolicyList('allowedCircuits', parsed.allowedCircuits),
        allowDeploy: parsed.allowDeploy === true,
        allowedTokenTypes: validateTokenTypeList('allowedTokenTypes', parsed.allowedTokenTypes),
        allowContractMints: parsed.allowContractMints === true,
        allowSwaps: parsed.allowSwaps === true,
        shareMintedTokenTypes: parsed.shareMintedTokenTypes === true
    };
}

const POLICY_FILE_KEYS = ['allowedContracts', 'allowedCircuits', 'allowDeploy', 'allowedTokenTypes', 'allowContractMints', 'allowSwaps', 'shareMintedTokenTypes'];

/** Env settings the policy file replaces while it is set. */
const SHADOWED_ENV_KEYS = [
    'NIGHTGATE_SPONSOR_ALLOWED_CONTRACTS', 'NIGHTGATE_SPONSOR_ALLOWED_CIRCUITS', 'NIGHTGATE_SPONSOR_ALLOWED_TOKEN_TYPES',
    'NIGHTGATE_SPONSOR_ALLOW_DEPLOY', 'NIGHTGATE_SPONSOR_ALLOW_CONTRACT_MINTS', 'NIGHTGATE_SPONSOR_ALLOW_SWAPS',
    'NIGHTGATE_SPONSOR_SHARE_MINTED_TOKEN_TYPES'
];
let shadowedEnvLogged = false;

export function shadowedSponsorEnvKeys(): string[] {
    if (!configString('NIGHTGATE_SPONSOR_POLICY_FILE')) return [];
    return SHADOWED_ENV_KEYS.filter(k => configIsSet(k));
}

/** The current platform policy. From env, or from the policy file, re-read when its time or size changes. */
export function getGlobalSponsorPolicy(): SponsorPolicy {
    const filePath = configString('NIGHTGATE_SPONSOR_POLICY_FILE');
    if (!filePath) return envPolicy();
    if (!shadowedEnvLogged) {
        shadowedEnvLogged = true;
        const shadowed = shadowedSponsorEnvKeys();
        if (shadowed.length) log.warn(`sponsor policy comes from ${filePath}; ${shadowed.join(', ')} are set and ignored`);
    }

    let stat: fs.Stats | null = null;
    let statError: unknown = null;
    try { stat = fs.statSync(filePath); } catch (e) { statError = e; }

    const unchanged = fileCache && fileCache.path === filePath && stat
        && fileCache.mtimeMs === stat.mtimeMs && fileCache.size === stat.size;
    if (unchanged) {
        if (fileCache!.policy) return fileCache!.policy;
        // This file version was already logged as bad. Keep the same answer.
        if (fileCache!.lastGood) return fileCache!.lastGood;
        throw new SponsorPolicyUnavailableError(`sponsor policy file ${filePath} is unusable and no policy was loaded before; refusing to sponsor`);
    }

    const lastGood = fileCache?.path === filePath ? fileCache.lastGood : null;
    if (!stat) {
        // The file is still missing. Log it once, not on every request.
        if (fileCache?.path === filePath && fileCache.mtimeMs === -1) {
            if (lastGood) return lastGood;
            throw new SponsorPolicyUnavailableError(`sponsor policy file ${filePath} cannot be read and no policy was loaded before; refusing to sponsor`);
        }
        log.error(`sponsor policy file ${filePath} cannot be read (${errorMessage(statError)}); ` +
            (lastGood ? 'keeping the last good policy' : 'no policy loaded yet, refusing every sponsored call'));
        fileCache = { path: filePath, mtimeMs: -1, size: -1, policy: null, lastGood, loadedAt: lastGood ? fileCache?.loadedAt ?? null : null };
        if (lastGood) return lastGood;
        throw new SponsorPolicyUnavailableError(`sponsor policy file ${filePath} cannot be read and no policy was loaded before; refusing to sponsor`);
    }
    try {
        const policy = readPolicyFile(filePath);
        fileCache = { path: filePath, mtimeMs: stat.mtimeMs, size: stat.size, policy, lastGood: policy, loadedAt: new Date().toISOString() };
        log.info(`sponsor policy reloaded from ${filePath}: ${policy.allowedContracts.length} contract(s), ${policy.allowedCircuits.length} circuit(s)` +
            (policy.allowedContracts.length === 0 ? ' (contracts unrestricted)' : '') +
            (policy.allowedCircuits.length === 0 ? ' (circuits unrestricted)' : '') +
            `, ${policy.allowedTokenTypes?.length ?? 0} token type(s)` +
            (policy.allowContractMints ? ', contract mints sponsored' : '') +
            (policy.allowSwaps ? ', swaps sponsored' : '') +
            (policy.shareMintedTokenTypes ? ', minted types shared' : ''));
        return policy;
    } catch (e) {
        log.error(`sponsor policy file ${filePath} is invalid (${errorMessage(e)}); ` +
            (lastGood ? 'keeping the last good policy' : 'no policy loaded yet, refusing every sponsored call'));
        fileCache = { path: filePath, mtimeMs: stat.mtimeMs, size: stat.size, policy: null, lastGood, loadedAt: lastGood ? fileCache?.loadedAt ?? null : null };
        if (lastGood) return lastGood;
        throw new SponsorPolicyUnavailableError(`sponsor policy file ${filePath} is invalid and no policy was loaded before; refusing to sponsor`);
    }
}

// ---- Effective policy ------------------------------------------------------

export class SponsorPolicyEmptyError extends NightgateError {
    constructor(message: string) {
        super('SPONSOR_POLICY_EMPTY', message);
    }
    /** @deprecated use `status`. */
    get httpStatus(): number { return this.status; }
}

function intersect(floor: string[], grant: string[] | null | undefined, what: string): string[] {
    if (!grant || grant.length === 0) return floor;      // no grant list: take the platform list
    if (floor.length === 0) return grant;                // platform allows all: the grant list applies
    const both = grant.filter(g => floor.includes(g));
    if (both.length === 0) {
        throw new SponsorPolicyEmptyError(
            `this grant's ${what} (${grant.map(g => g.slice(0, 16)).join(', ')}) share nothing with the platform's ` +
            `sponsor allow-list; the grant cannot be sponsored here (revoke and re-issue it, or widen the platform policy)`);
    }
    return both;
}

/**
 * The platform policy narrowed by the grant. If nothing is left, it throws before a job is created.
 * `shared` holds token types minted anywhere on the platform. They are added to the platform's
 * token list while the platform shares minted types.
 */
export function effectiveSponsorPolicy(floor: SponsorPolicy, grant?: GrantPolicyInput | null, shared: string[] = sharedLearnedTokenTypes()): SponsorPolicy {
    const contracts = intersect(floor.allowedContracts, grant?.allowedContracts, 'allowedContracts');
    // Contracts deployed under the grant are added after narrowing. An empty list means "all" and stays empty.
    const deployed = [...new Set((grant?.deployedContracts ?? []).filter(a => typeof a === 'string' && a.length > 0))];
    const withDeployed = contracts.length === 0 || deployed.length === 0
        ? contracts
        : [...contracts, ...deployed.filter(a => !contracts.includes(a))];
    // An empty token list means no offers at all. So an empty overlap just disables
    // offers instead of blocking the grant's other calls.
    const sharing = floor.allowContractMints === true && floor.shareMintedTokenTypes === true;
    const sharedTypes = sharing ? [...new Set(shared.filter(t => typeof t === 'string' && HEX64_RE.test(t)))] : [];
    const floorTokens = floorTokenTypes(floor, sharedTypes);
    const grantTokens = (grant?.allowedTokenTypes ?? []).filter(t => typeof t === 'string' && t.length > 0);
    const listed = grantTokens.length === 0 ? floorTokens : grantTokens.filter(t => floorTokens.includes(t));
    // Token types the grant minted are added after narrowing, like its deployed contracts.
    const minted = floor.allowContractMints === true
        ? [...new Set((grant?.mintedTokenTypes ?? []).filter(t => typeof t === 'string' && HEX64_RE.test(t)))]
        : [];
    return {
        allowedContracts: withDeployed,
        allowedCircuits: intersect(floor.allowedCircuits, grant?.allowedCircuits, 'allowedCircuits'),
        allowedTokenTypes: [...listed, ...minted.filter(t => !listed.includes(t))],
        allowContractMints: floor.allowContractMints === true,
        allowSwaps: floor.allowSwaps === true && (grant ? grant.allowSwaps === true : true),
        shareMintedTokenTypes: sharing,
        ...(minted.length ? { ownTokenTypes: minted } : {}),
        ...(sharedTypes.length ? { sharedTokenTypes: sharedTypes } : {}),
        allowDeploy: floor.allowDeploy === true && (grant ? grant.allowDeploy === true : true),
        ...(deployed.length ? { ownContracts: deployed } : {})
    };
}

function floorTokenTypes(floor: SponsorPolicy, sharedTypes: string[]): string[] {
    const listed = floor.allowedTokenTypes ?? [];
    return sharedTypes.length ? [...listed, ...sharedTypes.filter(t => !listed.includes(t))] : listed;
}

/**
 * Why a grant's lists cannot work under the platform policy, or null. Used when a grant is written.
 * Sponsoring checks again later, because the platform policy can shrink.
 */
export function grantPolicyConflict(floor: SponsorPolicy, grant: GrantPolicyInput, shared: string[] = sharedLearnedTokenTypes()): string | null {
    let effective: SponsorPolicy;
    try {
        effective = effectiveSponsorPolicy(floor, grant, shared);
    } catch (e) {
        if (e instanceof SponsorPolicyEmptyError) return e.message;
        throw e;
    }
    const floorTokens = floorTokenTypes(floor, effective.sharedTokenTypes ?? []);
    const outside = (grant.allowedTokenTypes ?? []).filter(t => !floorTokens.includes(t));
    if (outside.length === 0) return null;
    return `allowedTokenTypes ${outside.join(', ')} ${outside.length === 1 ? 'is' : 'are'} not in the platform's sponsor token-type allow-list` +
        `${floorTokens.length === 0 ? ' (the platform lists none)' : ''}; the platform policy has to list a type before a grant can`;
}

export interface SponsorPolicyDescription {
    source: 'file' | 'env';
    path: string | null;
    /** When the policy in force was read from the file; null for env. */
    loadedAt: string | null;
    /** Env settings the policy file replaces. */
    ignoredEnv: string[];
    floor: SponsorPolicy | null;
    floorError: string | null;
}

export function describeGlobalSponsorPolicy(): SponsorPolicyDescription {
    const path = configString('NIGHTGATE_SPONSOR_POLICY_FILE') || null;
    let floor: SponsorPolicy | null = null;
    let floorError: string | null = null;
    try {
        floor = getGlobalSponsorPolicy();
    } catch (e) {
        if (!(e instanceof SponsorPolicyUnavailableError)) throw e;
        floorError = e.message;
    }
    return {
        source: path ? 'file' : 'env',
        path,
        loadedAt: path && fileCache?.path === path ? fileCache.loadedAt : null,
        ignoredEnv: shadowedSponsorEnvKeys(),
        floor,
        floorError
    };
}

export function resolveSponsorPolicyForRequest(req: { agentGrant?: GrantPolicyInput | null }): SponsorPolicy {
    const grant = req?.agentGrant as GrantPolicyInput | undefined;
    return effectiveSponsorPolicy(getGlobalSponsorPolicy(), grant, sharedLearnedTokenTypes());
}
