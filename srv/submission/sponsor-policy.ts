// Decides which calls a fee sponsor pays for. The platform policy comes from env or `NIGHTGATE_SPONSOR_POLICY_FILE`, and an agent grant can only narrow it.
// An empty platform list allows everything. An empty grant list takes the platform list.
import fs from 'node:fs';
import cds from '@sap/cds';
import { configList, configFlag, configString, configIsSet } from '../utils/config';
import { NightgateError, errorMessage } from '../utils/errors';
import { HEX64_RE } from '../utils/hex';
import { sharedLearnedTokenTypes } from './learned-token-types';
import { isRateClass, RATE_CLASS_NAMES, type RateClass } from '../utils/rate-class-table';
import { setRateLimitOverrideSource } from '../utils/rate-classes';

const log = cds.log('nightgate:sponsor-policy');

/** The circuits sponsored on one contract: `'*'` for all of them, else exactly the named ones. */
export type ContractCircuitRule = '*' | string[];
export type ContractCircuitRules = Record<string, ContractCircuitRule>;

export interface SponsorPolicy {
    allowedContracts: string[];
    allowedCircuits: string[];
    /** Per contract address, the rule that replaces `allowedCircuits` for calls on it. */
    contractCircuits?: ContractCircuitRules;
    /** Sponsor deploys built by the caller. The platform and, for an agent, the grant must both allow it. */
    allowDeploy?: boolean;
    /** Contracts deployed under the grant. `allowedCircuits` names circuits of the shared contracts, so it does not apply here. The size limit still applies. */
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
    /** Sponsor plain shielded transfers of a listed token type. The platform and, for an agent, the grant must both allow it. */
    allowTransfers?: boolean;
    /** Sponsor a call whose intent moves unshielded tokens: the caller's own in, the contract's payouts out. Platform and grant must both allow it. */
    allowUnshieldedOffers?: boolean;
    /** Raw token types an unshielded offer may move besides NIGHT. Empty means NIGHT only. */
    allowedUnshieldedTokenTypes?: string[];
    /** Counts per rate class that replace the config keys while the file is set. */
    rateLimits?: Partial<Record<RateClass, number>>;
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
    allowTransfers?: boolean | null;
    allowUnshieldedOffers?: boolean | null;
    allowedUnshieldedTokenTypes?: string[] | null;
}

/** Maximum entries per list. A grant serves one consumer and does not need more. */
export const MAX_POLICY_ENTRIES = 256;
const MAX_ENTRY_LENGTH = 130;

/** Validates an allow-list, trimmed and without duplicates. A malformed entry throws, so it cannot sit in the list and silently never match. */
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

/** Validates `contractCircuits`: addresses as 64 hex (lowercased) to `"*"` or a non-empty circuit list. */
export function validateContractCircuits(name: string, raw: unknown): ContractCircuitRules | undefined {
    if (raw === undefined || raw === null) return undefined;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${name} must be an object of contract address to "*" or circuit names`);
    const entries = Object.entries(raw as Record<string, unknown>);
    if (entries.length > MAX_POLICY_ENTRIES) throw new Error(`${name} has ${entries.length} entries; at most ${MAX_POLICY_ENTRIES} are allowed`);
    const out: ContractCircuitRules = {};
    for (const [key, value] of entries) {
        const address = key.trim().toLowerCase();
        if (!HEX64_RE.test(address)) throw new Error(`${name} key '${key.trim().slice(0, 32)}' is not a contract address (64 hex)`);
        if (address in out) throw new Error(`${name} lists contract ${address.slice(0, 16)} twice`);
        const label = `${name}.${address.slice(0, 16)}`;
        if (value === '*') { out[address] = '*'; continue; }
        if (Array.isArray(value) && value.includes('*')) throw new Error(`${label}: use "*" as the value, not inside the array`);
        const circuits = validatePolicyList(label, value);
        if (circuits.length === 0) throw new Error(`${label} must be "*" or a non-empty array of circuit names`);
        out[address] = circuits;
    }
    return out;
}

// ---- Platform policy -------------------------------------------------------

function envPolicy(): SponsorPolicy {
    let allowedTokenTypes: string[];
    let allowedUnshieldedTokenTypes: string[];
    try {
        allowedTokenTypes = validateTokenTypeList('NIGHTGATE_SPONSOR_ALLOWED_TOKEN_TYPES', configList('NIGHTGATE_SPONSOR_ALLOWED_TOKEN_TYPES'));
        allowedUnshieldedTokenTypes = validateTokenTypeList('NIGHTGATE_SPONSOR_ALLOWED_UNSHIELDED_TOKEN_TYPES', configList('NIGHTGATE_SPONSOR_ALLOWED_UNSHIELDED_TOKEN_TYPES'));
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
        allowTransfers: configFlag('NIGHTGATE_SPONSOR_ALLOW_TRANSFERS'),
        shareMintedTokenTypes: configFlag('NIGHTGATE_SPONSOR_SHARE_MINTED_TOKEN_TYPES'),
        allowUnshieldedOffers: configFlag('NIGHTGATE_SPONSOR_ALLOW_UNSHIELDED_OFFERS'),
        allowedUnshieldedTokenTypes
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
    for (const flag of ['allowDeploy', 'allowContractMints', 'allowSwaps', 'allowTransfers', 'shareMintedTokenTypes', 'allowUnshieldedOffers']) {
        if (parsed[flag] !== undefined && typeof parsed[flag] !== 'boolean') throw new Error(`${flag} must be a boolean`);
    }
    const rateLimits = readRateLimits(parsed.rateLimits);
    const contractCircuits = validateContractCircuits('contractCircuits', parsed.contractCircuits);
    const allowedContracts = validatePolicyList('allowedContracts', parsed.allowedContracts);
    // A ruled contract is allowed without a second entry. An empty list means every contract and stays empty.
    const ruled = Object.keys(contractCircuits ?? {}).filter(a => !allowedContracts.includes(a));
    return {
        allowedContracts: allowedContracts.length === 0 ? allowedContracts : [...allowedContracts, ...ruled],
        allowedCircuits: validatePolicyList('allowedCircuits', parsed.allowedCircuits),
        ...(contractCircuits ? { contractCircuits } : {}),
        allowDeploy: parsed.allowDeploy === true,
        allowedTokenTypes: validateTokenTypeList('allowedTokenTypes', parsed.allowedTokenTypes),
        allowContractMints: parsed.allowContractMints === true,
        allowSwaps: parsed.allowSwaps === true,
        allowTransfers: parsed.allowTransfers === true,
        shareMintedTokenTypes: parsed.shareMintedTokenTypes === true,
        allowUnshieldedOffers: parsed.allowUnshieldedOffers === true,
        allowedUnshieldedTokenTypes: validateTokenTypeList('allowedUnshieldedTokenTypes', parsed.allowedUnshieldedTokenTypes),
        ...(rateLimits ? { rateLimits } : {})
    };
}

function readRateLimits(raw: unknown): Partial<Record<RateClass, number>> | undefined {
    if (raw === undefined) return undefined;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('rateLimits must be an object of class name to count');
    const out: Partial<Record<RateClass, number>> = {};
    for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
        if (!isRateClass(name)) throw new Error(`rateLimits names unknown class '${name}'; known: ${RATE_CLASS_NAMES.join(', ')}`);
        if (!Number.isInteger(value) || (value as number) < 1) throw new Error(`rateLimits.${name} must be an integer of at least 1`);
        out[name] = value as number;
    }
    return out;
}

const POLICY_FILE_KEYS = [
    'allowedContracts', 'allowedCircuits', 'contractCircuits', 'allowDeploy', 'allowedTokenTypes', 'allowContractMints', 'allowSwaps',
    'allowTransfers', 'shareMintedTokenTypes', 'allowUnshieldedOffers', 'allowedUnshieldedTokenTypes', 'rateLimits'
];

/** Env settings the policy file replaces while it is set. */
const SHADOWED_ENV_KEYS = [
    'NIGHTGATE_SPONSOR_ALLOWED_CONTRACTS', 'NIGHTGATE_SPONSOR_ALLOWED_CIRCUITS', 'NIGHTGATE_SPONSOR_ALLOWED_TOKEN_TYPES',
    'NIGHTGATE_SPONSOR_ALLOW_DEPLOY', 'NIGHTGATE_SPONSOR_ALLOW_CONTRACT_MINTS', 'NIGHTGATE_SPONSOR_ALLOW_SWAPS',
    'NIGHTGATE_SPONSOR_ALLOW_TRANSFERS', 'NIGHTGATE_SPONSOR_SHARE_MINTED_TOKEN_TYPES',
    'NIGHTGATE_SPONSOR_ALLOW_UNSHIELDED_OFFERS', 'NIGHTGATE_SPONSOR_ALLOWED_UNSHIELDED_TOKEN_TYPES'
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
            `, ${Object.keys(policy.contractCircuits ?? {}).length} contract circuit rule(s)` +
            `, ${policy.allowedTokenTypes?.length ?? 0} token type(s)` +
            (policy.allowContractMints ? ', contract mints sponsored' : '') +
            (policy.allowSwaps ? ', swaps sponsored' : '') +
            (policy.allowTransfers ? ', transfers sponsored' : '') +
            (policy.allowUnshieldedOffers ? `, unshielded offers sponsored (${policy.allowedUnshieldedTokenTypes?.length ?? 0} type(s) besides NIGHT)` : '') +
            (policy.shareMintedTokenTypes ? ', minted types shared' : '') +
            (policy.rateLimits ? `, rate limits ${Object.entries(policy.rateLimits).map(([k, v]) => `${k}=${v}`).join(' ')}` : ''));
        return policy;
    } catch (e) {
        log.error(`sponsor policy file ${filePath} is invalid (${errorMessage(e)}); ` +
            (lastGood ? 'keeping the last good policy' : 'no policy loaded yet, refusing every sponsored call'));
        fileCache = { path: filePath, mtimeMs: stat.mtimeMs, size: stat.size, policy: null, lastGood, loadedAt: lastGood ? fileCache?.loadedAt ?? null : null };
        if (lastGood) return lastGood;
        throw new SponsorPolicyUnavailableError(`sponsor policy file ${filePath} is invalid and no policy was loaded before; refusing to sponsor`);
    }
}

/** The rate counts the policy file sets; empty without a file or while it is unusable. */
export function policyFileRateLimits(): Partial<Record<RateClass, number>> {
    if (!configString('NIGHTGATE_SPONSOR_POLICY_FILE')) return {};
    try {
        return getGlobalSponsorPolicy().rateLimits ?? {};
    } catch (e) {
        if (e instanceof SponsorPolicyUnavailableError) return {};
        throw e;
    }
}

setRateLimitOverrideSource(policyFileRateLimits);

// ---- Effective policy ------------------------------------------------------

export class SponsorPolicyEmptyError extends NightgateError {
    constructor(message: string) {
        super('SPONSOR_POLICY_EMPTY', message);
    }
    /** @deprecated use `status`. */
    get httpStatus(): number { return this.status; }
}

function emptyIntersection(what: string, grant: string[]): SponsorPolicyEmptyError {
    return new SponsorPolicyEmptyError(
        `this grant's ${what} (${grant.map(g => g.slice(0, 16)).join(', ')}) share nothing with the platform's ` +
        `sponsor allow-list; the grant cannot be sponsored here (revoke and re-issue it, or widen the platform policy)`);
}

function intersect(floor: string[], grant: string[] | null | undefined, what: string): string[] {
    if (!grant || grant.length === 0) return floor;      // no grant list: take the platform list
    if (floor.length === 0) return grant;                // platform allows all: the grant list applies
    const both = grant.filter(g => floor.includes(g));
    if (both.length === 0) throw emptyIntersection(what, grant);
    return both;
}

/** The circuit lists narrowed by the grant. A grant list that only a rule names keeps the ruled contracts alone. */
function narrowCircuits(
    floor: SponsorPolicy, grantList: string[] | null | undefined, contracts: string[]
): Pick<SponsorPolicy, 'allowedContracts' | 'allowedCircuits' | 'contractCircuits'> {
    const rules = floor.contractCircuits;
    if (!grantList || grantList.length === 0) {
        return { allowedContracts: contracts, allowedCircuits: floor.allowedCircuits, ...(rules ? { contractCircuits: rules } : {}) };
    }
    const flat = floor.allowedCircuits.length === 0 ? grantList : grantList.filter(c => floor.allowedCircuits.includes(c));
    const narrowed: ContractCircuitRules = {};
    for (const [address, rule] of Object.entries(rules ?? {})) {
        narrowed[address] = rule === '*' ? grantList : rule.filter(c => grantList.includes(c));
    }
    if (flat.length > 0) {
        return { allowedContracts: contracts, allowedCircuits: flat, ...(rules ? { contractCircuits: narrowed } : {}) };
    }
    const usable = Object.keys(narrowed).filter(a => narrowed[a].length > 0 && (contracts.length === 0 || contracts.includes(a)));
    if (usable.length === 0) throw emptyIntersection('allowedCircuits', grantList);
    return { allowedContracts: usable, allowedCircuits: grantList, contractCircuits: Object.fromEntries(usable.map(a => [a, narrowed[a]])) };
}

// The platform policy narrowed by the grant. Throws before a job is created when nothing is left.
// `shared` holds token types minted anywhere on the platform. They join the platform's token list while minted types are shared.
export function effectiveSponsorPolicy(floor: SponsorPolicy, grant?: GrantPolicyInput | null, shared: string[] = sharedLearnedTokenTypes()): SponsorPolicy {
    const circuits = narrowCircuits(floor, grant?.allowedCircuits, intersect(floor.allowedContracts, grant?.allowedContracts, 'allowedContracts'));
    const contracts = circuits.allowedContracts;
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
        allowedCircuits: circuits.allowedCircuits,
        ...(circuits.contractCircuits ? { contractCircuits: circuits.contractCircuits } : {}),
        allowedTokenTypes: [...listed, ...minted.filter(t => !listed.includes(t))],
        allowContractMints: floor.allowContractMints === true,
        allowSwaps: floor.allowSwaps === true && (grant ? grant.allowSwaps === true : true),
        allowTransfers: floor.allowTransfers === true && (grant ? grant.allowTransfers === true : true),
        shareMintedTokenTypes: sharing,
        ...(minted.length ? { ownTokenTypes: minted } : {}),
        ...(sharedTypes.length ? { sharedTokenTypes: sharedTypes } : {}),
        allowDeploy: floor.allowDeploy === true && (grant ? grant.allowDeploy === true : true),
        ...(deployed.length ? { ownContracts: deployed } : {}),
        allowUnshieldedOffers: floor.allowUnshieldedOffers === true && (grant ? grant.allowUnshieldedOffers === true : true),
        allowedUnshieldedTokenTypes: narrowUnshieldedTypes(floor.allowedUnshieldedTokenTypes ?? [], grant?.allowedUnshieldedTokenTypes)
    };
}

/** NIGHT is always allowed and never listed. A grant list keeps only the types the floor lists. */
function narrowUnshieldedTypes(floor: string[], grant: string[] | null | undefined): string[] {
    const wanted = (grant ?? []).filter(t => typeof t === 'string' && HEX64_RE.test(t));
    return wanted.length === 0 ? floor : wanted.filter(t => floor.includes(t));
}

function floorTokenTypes(floor: SponsorPolicy, sharedTypes: string[]): string[] {
    const listed = floor.allowedTokenTypes ?? [];
    return sharedTypes.length ? [...listed, ...sharedTypes.filter(t => !listed.includes(t))] : listed;
}

/**
 * Why a grant's lists cannot work under the platform policy, or null. Used when a grant is written. Sponsoring checks again later, because the platform policy can shrink.
 */
export function grantPolicyConflict(floor: SponsorPolicy, grant: GrantPolicyInput, shared: string[] = sharedLearnedTokenTypes()): string | null {
    let effective: SponsorPolicy;
    try {
        effective = effectiveSponsorPolicy(floor, grant, shared);
    } catch (e) {
        if (e instanceof SponsorPolicyEmptyError) return e.message;
        throw e;
    }
    const floorUnshielded = floor.allowedUnshieldedTokenTypes ?? [];
    const outsideUnshielded = (grant.allowedUnshieldedTokenTypes ?? []).filter(t => !floorUnshielded.includes(t));
    if (outsideUnshielded.length > 0) {
        return `allowedUnshieldedTokenTypes ${outsideUnshielded.join(', ')} ${outsideUnshielded.length === 1 ? 'is' : 'are'} not in the platform's unshielded token-type list` +
            `${floorUnshielded.length === 0 ? ' (the platform lists none besides NIGHT)' : ''}; the platform policy has to list a type before a grant can`;
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
