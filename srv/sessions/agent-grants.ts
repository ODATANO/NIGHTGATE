/**
 * Agent grants: a token that lets an agent use one wallet session with limited rights.
 * A valid token makes the request run as the user who issued the grant,
 * so all existing per-user checks still apply.
 */

import { parseJsonStringList } from '../utils/json-list';
import cds from '@sap/cds';
import crypto from 'crypto';
import { AgentGrants, WalletSessions, BackgroundJobs, Transactions, TransactionFees, type WalletSession, type AgentGrant } from '#cds-models/midnight';
import { RateLimiter } from '../utils/rate-limiter';
import { PLATFORM_POOL_SENTINEL } from '../submission/sponsor-pool';
import { getConfiguredFeeSponsorSessions } from '../submission/fee-sponsor';
import {
    GrantPolicyInput, validatePolicyList, validateTokenTypeList, grantPolicyConflict, getGlobalSponsorPolicy, MAX_POLICY_ENTRIES,
    effectiveSponsorPolicy, describeGlobalSponsorPolicy, SponsorPolicyEmptyError, SponsorPolicyUnavailableError, type SponsorPolicy
} from '../submission/sponsor-policy';
import { withKeyedLock } from '../utils/keyed-lock';
import { runWithoutAmbientTx } from '../submission/background-jobs';
import { resolveFeeSponsor, FeeSponsorError } from '../submission/fee-sponsor';
import { getNightgatePluginConfig, resolveNightgateRuntimeConfig } from '../utils/nightgate-config';
import { configNumber } from '../utils/config';
import { isSessionExpired } from '../utils/session-expiry';
import { AGENT_TOKEN_HEADER, AGENT_TOKEN_TRANSPORT_USER, PUBLIC_VERIFY_TRANSPORT_USER } from '../utils/agent-token-transport';
import { principalRateKey } from '../utils/rate-limiter';
import type { DbRunner } from '../utils/db-types';
import { errorMessage } from '../utils/errors';
import { HEX64_RE } from '../utils/hex-patterns';
import { createAgentGrant, createAgentGrants, getGrantUsage, revokeAgentGrant, rotateAgentGrantToken, updateAgentGrant } from '#cds-models/NightgateService';
import type { getSponsorPolicy } from '#cds-models/NightgateAdminService';
import type { Request } from '@sap/cds';

const { SELECT, INSERT, UPDATE } = cds.ql;

const log = cds.log('nightgate:agent-grants');

export { AGENT_TOKEN_HEADER };
const TOKEN_PREFIX = 'ngat_';
const TOKEN_BYTES = 32;
const MAX_GRANTS_PER_CALL = 50;

/** Write actions a grant may allow. A token gets 403 for any other action that is not always allowed. */
export const AGENT_ALLOWLISTABLE_ACTIONS: readonly string[] = [
    'anchorDocument',
    'attestAgentOutput',
    'issueFieldPredicateAttestation',
    'issueFieldEqualityAttestation',
    'issueFieldMembershipAttestation',
    'issueFieldPredicateAttestationBatch',
    'issueDocumentIntegrityAttestation',
    'issueDocumentDiffAttestation',
    'grantDisclosure',
    'revokeDisclosure',
    'reindexDisclosures',
    // The transaction arrives proven and signed. The grant only spends the sponsor's dust,
    // which is limited by the fixed sponsor and the daily budget.
    'sponsorFinalizedTransaction',
    'sponsorUnboundTransaction',
    'sponsorSwap',
    'postSwapOffer',
    'retireSwapOffer',
    'grantDisclosureToHolders',
    'revokeHolderDisclosure',
    'mintFactoryToken'
];

/** Actions that use no sponsor. A grant on the platform sponsor pool may allow them as well. */
const POOL_NEUTRAL_ACTIONS: ReadonlySet<string> = new Set(['postSwapOffer', 'retireSwapOffer']);

const SPONSOR_TRANSACTION_ACTIONS: ReadonlySet<string> = new Set([
    'sponsorFinalizedTransaction',
    'sponsorUnboundTransaction'
]);

/** A grant may have swaps sponsored if `allowedActions` contains this action. */
export const SPONSOR_SWAP_ACTION = 'sponsorSwap';

/** Actions where a sponsor pays for a caller's transaction. Their jobs run under the sponsor session, which may be the platform pool. */
export const SPONSOR_PHASE2_ACTIONS: ReadonlySet<string> = new Set([...SPONSOR_TRANSACTION_ACTIONS, SPONSOR_SWAP_ACTION]);

/**
 * Entities a token may read. Session-specific ones are filtered to the grant's session in enforceAgentGrant.
 * Other per-user lists are excluded, because they would show the issuer's other sessions.
 */
export const AGENT_READABLE_ENTITIES: ReadonlySet<string> = new Set([
    'Blocks', 'Transactions', 'TransactionResults', 'TransactionSegments', 'TransactionFees',
    'ContractActions', 'ContractBalances', 'ContractStates', 'UnshieldedUtxos', 'ZswapLedgerEvents',
    'DustLedgerEvents', 'NightBalances', 'PredicateAttestations', 'DisclosureGrants',
    'WalletSessions', 'PendingSubmissions', 'AgentGrants', 'Documents'
]);

/** Events any valid token may use without listing them in the grant and without using its budget. */
export const AGENT_ALWAYS_ALLOWED_EVENTS: ReadonlySet<string> = new Set([
    'READ',
    'verifyDocument',
    'verifyAttestationState',
    'verifyPredicateState',
    'verifyPredicateAttestation',
    'prepareDocumentProof', // only computes, writes nothing
    'prepareMembershipSet', // only computes, writes nothing
    'deriveTokenType', // only computes, writes nothing
    'listSwapOffers', // the offer list is public to every token
    'getSwapOffer',
    'claimDisclosure', // the caller proves ownership with a secret, no wallet involved
    'getJobStatus',
    'getGrantUsage', // limited to the token's own grant in enforceAgentGrant
    // Read functions bound to indexer entities. They return rows that `READ` already allows,
    // but CAP reports each one as its own event.
    'latest', 'byHeight', 'range',          // Blocks
    'byHash', 'byType',                     // Transactions
    'byAddress', 'history',                 // ContractActions
    'stateAt',                              // ContractStates
    'byOwner', 'unspent',                   // UnshieldedUtxos
    'getBalance', 'getTopHolders',          // NightBalances
    // getSponsorPoolStatus is excluded. Running as the issuer, a token would see
    // all sponsor sessions of that user.
]);

const grantAdminRateLimiter = new RateLimiter({ windowMs: 60 * 60 * 1000, maxRequests: configNumber('NIGHTGATE_GRANT_ADMIN_RATE_LIMIT') });

export function __resetGrantRateLimiterForTests(): void {
    grantAdminRateLimiter.reset();
}


/**
 * Records contracts deployed under a grant. The sponsor policy allows calls to them
 * in addition to the contracts both the platform and the grant allow.
 */
export async function recordDeployedContracts(db: DbRunner, grantId: string, addresses: string[]): Promise<void> {
    const fresh = addresses.map(a => String(a).trim()).filter(Boolean);
    if (!grantId || fresh.length === 0) return;
    await withKeyedLock(`agent-grant-deploys:${grantId}`, async () => {
        try {
            const grant: AgentGrant | null = await runWithoutAmbientTx(() => db.run(
                SELECT.one.from(AgentGrants).where({ ID: grantId })
            )) as AgentGrant | null;
            if (!grant) return;
            const current = parseGrantList(grant.deployedContracts);
            const merged = [...current];
            for (const a of fresh) if (!merged.includes(a)) merged.push(a);
            if (merged.length === current.length) return;
            await runWithoutAmbientTx(() => db.run(
                UPDATE.entity(AgentGrants).set({ deployedContracts: JSON.stringify(merged) }).where({ ID: grantId })
            ));
            log.info(`agent grant ${grantId.slice(0, 8)}… now sponsors ${fresh.map(a => a.slice(0, 12)).join(', ')} (deployed under it; ${grant.deploysUsed ?? 0}/${grant.maxDeploys ?? 1} deploys used)`);
        } catch (err) {
            log.error(`could not record deployed contract(s) ${fresh.map(a => a.slice(0, 12)).join(', ')} on grant ${grantId.slice(0, 8)}…: ${errorMessage(err)}`);
            throw err;
        }
    });
}

/** Records token types minted under a grant. The sponsor policy treats them as allowed for this grant. */
export async function recordMintedTokenTypes(db: DbRunner, grantId: string, types: string[]): Promise<void> {
    const fresh = [...new Set(types.map(t => String(t).trim().toLowerCase()).filter(t => HEX64_RE.test(t)))];
    if (!grantId || fresh.length === 0) return;
    await withKeyedLock(`agent-grant-mints:${grantId}`, async () => {
        try {
            const grant: AgentGrant | null = await runWithoutAmbientTx(() => db.run(
                SELECT.one.from(AgentGrants).where({ ID: grantId })
            )) as AgentGrant | null;
            if (!grant) return;
            const current = parseGrantList(grant.mintedTokenTypes);
            const added = fresh.filter(t => !current.includes(t));
            if (added.length === 0) return;
            if (current.length + added.length > MAX_POLICY_ENTRIES) {
                log.warn(`agent grant ${grantId.slice(0, 8)}… holds ${current.length} minted token types; ${added.map(t => t.slice(0, 12)).join(', ')} not recorded (at most ${MAX_POLICY_ENTRIES})`);
                return;
            }
            await runWithoutAmbientTx(() => db.run(
                UPDATE.entity(AgentGrants).set({ mintedTokenTypes: JSON.stringify([...current, ...added]) }).where({ ID: grantId })
            ));
            log.info(`agent grant ${grantId.slice(0, 8)}… minted token type(s) ${added.map(t => t.slice(0, 12)).join(', ')}`);
        } catch (err) {
            // The mint is already on chain. A type missed here is recorded on its next mint.
            log.error(`could not record minted token type(s) ${fresh.map(t => t.slice(0, 12)).join(', ')} on grant ${grantId.slice(0, 8)}…: ${errorMessage(err)}`);
        }
    });
}

/**
 * Reserves deploys from the grant's total deploy budget before sending. All or nothing.
 * Run it in the same database transaction that inserts the submission attempt row.
 */
export async function reserveDeployBudget(runner: DbRunner, grantId: string, count: number): Promise<boolean> {
    if (!grantId || !Number.isInteger(count) || count < 1) return false;
    const grant = await runner.run(SELECT.one.from(AgentGrants).where({ ID: grantId })) as AgentGrant | null;
    if (!grant || grant.isActive === false || grant.allowDeploy !== true) return false;
    const max = grant.maxDeploys ?? 1;
    const updated = await runner.run(
        UPDATE.entity(AgentGrants)
            .set({ deploysUsed: { '+=': count } })
            .where({ ID: grantId, isActive: true, allowDeploy: true, deploysUsed: { '<=': max - count } })
    );
    return Number(updated) > 0;
}

/** Gives back a reservation whose transaction was rejected. Keep it if the transaction may still land. */
export async function releaseDeployBudget(db: DbRunner, grantId: string, count: number): Promise<void> {
    if (!grantId || !Number.isInteger(count) || count < 1) return;
    try {
        await runWithoutAmbientTx(() => db.run(
            UPDATE.entity(AgentGrants)
                .set({ deploysUsed: { '-=': count } })
                .where({ ID: grantId, deploysUsed: { '>=': count } })
        ));
    } catch (err) {
        log.error(`could not release ${count} reserved deploy(s) on grant ${grantId.slice(0, 8)}…; deploysUsed is now one too high, correct it by hand: ${errorMessage(err)}`);
        throw err;
    }
}

/**
 * Reads the grant's current policy for each job, so a revoke or a narrower grant also hits queued jobs.
 * Returns null if the grant is revoked, expired or deleted.
 */
export async function currentGrantPolicy(runner: DbRunner, grantId: string): Promise<GrantPolicyInput | null> {
    const grant = await currentGrantRow(runner, grantId);
    if (!grant) return null;
    return {
        allowedContracts: parseGrantList(grant.allowedContracts),
        allowedCircuits: parseGrantList(grant.allowedCircuits),
        deployedContracts: parseGrantList(grant.deployedContracts),
        allowedTokenTypes: parseGrantList(grant.allowedTokenTypes),
        mintedTokenTypes: parseGrantList(grant.mintedTokenTypes),
        allowDeploy: grant.allowDeploy === true,
        allowSwaps: parseGrantList(grant.allowedActions).includes(SPONSOR_SWAP_ACTION)
    };
}

export async function currentGrantRow(runner: DbRunner, grantId: string): Promise<AgentGrant | null> {
    const grant = await runner.run(SELECT.one.from(AgentGrants).where({ ID: grantId })) as AgentGrant | null;
    if (!grant || grant.isActive === false || grant.revokedAt || grantExpired(grant)) return null;
    return grant;
}

function actionsOfJob(kind: string, command: Record<string, unknown>): string[] {
    if (kind === 'retract') return command.mode === 1 ? ['purgeExpired'] : ['retractAttestation'];
    if (kind === 'anchorDocument') return ['anchorDocument', 'attestAgentOutput'];
    return [kind];
}

/** Circuits a stored command runs when the command does not list them itself. */
const OP_CIRCUITS: Readonly<Record<string, readonly string[]>> = {
    fieldPredicateWorkflow: ['anchorContentRoot', 'proveFieldPredicate'],
    fieldEqualityWorkflow: ['anchorContentRoot', 'proveFieldEquality'],
    fieldMembershipWorkflow: ['anchorContentRoot', 'proveFieldMembership'],
    fieldPredicateBatchWorkflow: ['anchorContentRoot', 'proveFieldPredicate', 'proveFieldEquality', 'proveFieldMembership', 'proveDocumentComparison'],
    documentIntegrityWorkflow: ['anchorContentRoot', 'proveDocumentComparison'],
    documentDiffWorkflow: ['anchorContentRoot', 'proveDocumentComparison'],
    anchorDocument: ['attest'],
    grantDisclosure: ['grantDisclosure'],
    revokeDisclosure: ['revokeDisclosure'],
    registerPassport: ['registerDocument'],
    retract: ['retract']
};

/**
 * Checks a queued job against the grant as it is now. A child job is checked by its parent's kind.
 * Returns null if the job is still allowed, else the reason.
 */
export function grantJobScopeViolation(
    grant: Pick<AgentGrant, 'allowedActions' | 'allowedContracts' | 'allowedCircuits'>,
    job: { kind: string; parentJobId?: string | null; parentKind?: string | null },
    command: Record<string, unknown>
): string | null {
    const admittedKind = job.parentJobId ? job.parentKind : job.kind;
    if (!admittedKind) return 'the action the parent job was admitted as is unknown';
    const allowed = parseJsonStringList(grant.allowedActions);
    const actions = actionsOfJob(admittedKind, job.parentJobId ? {} : command);
    if (!actions.some(a => allowed.includes(a))) {
        return `action '${actions[0]}' is no longer allowed for this agent grant`;
    }
    const op = String(command.op ?? '');
    const data: Record<string, unknown> = { contractAddress: command.contractAddress };
    if (typeof command.circuit === 'string') data.circuit = command.circuit;
    if (Array.isArray(command.calls)) data.calls = command.calls;
    if (OP_CIRCUITS[op]) data.circuits = [...OP_CIRCUITS[op]];
    return grantScopeViolation(grant, data, op);
}

/** Parses a grant's JSON list column. A missing or broken value gives an empty list, which means no limit. */
const parseGrantList = parseJsonStringList;

function grantExpired(grant: Pick<AgentGrant, 'validUntil'>, now: Date = new Date()): boolean {
    return !!grant.validUntil && new Date(grant.validUntil) < now;
}

export function grantScopeViolation(
    grant: Pick<AgentGrant, 'allowedContracts' | 'allowedCircuits'>,
    data: unknown,
    event?: string
): string | null {
    const d = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
    const contracts = parseGrantList(grant.allowedContracts).map(c => c.toLowerCase());
    if (contracts.length > 0 && typeof d.contractAddress === 'string' && d.contractAddress.length > 0
        && !contracts.includes(d.contractAddress.toLowerCase())) {
        return `contract '${d.contractAddress.slice(0, 16)}' is not in this agent grant's allowedContracts`;
    }
    const circuits = parseGrantList(grant.allowedCircuits);
    if (circuits.length === 0) return null;
    const required = circuitsOfRequest(event ?? '', d);
    if (required === null) {
        return `action '${(event ?? '').slice(0, 64)}' cannot be matched against this agent grant's allowedCircuits`;
    }
    for (const c of required) {
        if (!circuits.includes(c)) {
            return `circuit '${c.slice(0, 64)}' is not in this agent grant's allowedCircuits`;
        }
    }
    return null;
}

/**
 * Circuits each action may run on the server. A grant with a circuit list must allow all of them.
 * If the circuits of a request cannot be determined, a grant with a circuit list refuses it.
 */
const ACTION_CIRCUITS: Readonly<Record<string, readonly string[]>> = {
    issueFieldPredicateAttestation: ['anchorContentRoot', 'proveFieldPredicate'],
    issueFieldEqualityAttestation: ['anchorContentRoot', 'proveFieldEquality'],
    issueFieldMembershipAttestation: ['anchorContentRoot', 'proveFieldMembership'],
    issueFieldPredicateAttestationBatch: ['anchorContentRoot', 'proveFieldPredicate', 'proveFieldEquality', 'proveFieldMembership', 'proveDocumentComparison'],
    issueDocumentIntegrityAttestation: ['anchorContentRoot', 'proveDocumentComparison'],
    issueDocumentDiffAttestation: ['anchorContentRoot', 'proveDocumentComparison'],
    grantDisclosure: ['grantDisclosure'],
    revokeDisclosure: ['revokeDisclosure'],
    reindexDisclosures: [],
    mintFactoryToken: ['mint']
};

export function circuitsOfRequest(event: string, d: Record<string, unknown>): string[] | null {
    const out = new Set<string>();
    let known = false;
    if (event === 'anchorDocument' || event === 'attestAgentOutput') {
        known = true;
        out.add('attest');
    } else if (Object.prototype.hasOwnProperty.call(ACTION_CIRCUITS, event)) {
        known = true;
        for (const c of ACTION_CIRCUITS[event]) out.add(c);
    }
    if (typeof d.circuit === 'string') { known = true; out.add(d.circuit); }
    if (Array.isArray(d.circuits)) {
        known = true;
        for (const c of d.circuits) { if (typeof c === 'string') out.add(c); else return null; }
    }
    if (d.calls !== undefined && d.calls !== null) {
        known = true;
        let calls: unknown = d.calls;
        if (typeof calls === 'string') { try { calls = JSON.parse(calls); } catch { return null; } }
        if (!Array.isArray(calls)) return null;
        for (const call of calls) {
            const c = call && typeof call === 'object' ? (call as Record<string, unknown>) : null;
            const name = c ? (c.circuit ?? c.name) : undefined;
            if (typeof name !== 'string' || name.length === 0) return null;
            out.add(name);
        }
    }
    return known ? [...out] : null;
}

export function hashAgentToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
}

function requireUserId(req: Request): string | undefined {
    const uid = req.user?.id;
    if (!uid) { req.reject?.(401, 'authentication required'); return undefined; }
    return uid as string;
}

function utcDay(now: Date = new Date()): string {
    return now.toISOString().slice(0, 10);
}

interface GrantShapeInput {
    allowedActions?: string[] | null;
    maxJobsPerDay?: number | null;
    validUntil?: string | null;
    agentLabel?: string | null;
    allowedContracts?: string[] | null;
    allowedCircuits?: string[] | null;
    allowDeploy?: boolean | null;
    maxDeploys?: number | null;
    allowedTokenTypes?: string[] | null;
}

/** Validated values, ready to store. An empty list means no limit. */
interface GrantShapeValues {
    allowedActions?: string[];
    maxJobsPerDay?: number | null;
    validUntil?: string | null;
    agentLabel?: string | null;
    allowedContracts: string[];
    allowedCircuits: string[];
    allowedTokenTypes: string[];
    allowDeploy: boolean;
    maxDeploys: number | null;
}

/**
 * Validates the editable fields for create and update. On update, a missing field
 * keeps its value from `existing`, and an explicit null clears it.
 */
export function validateGrantShape(
    input: GrantShapeInput,
    existing?: AgentGrant
): { ok: true; values: GrantShapeValues } | { ok: false; message: string } {
    const has = (k: keyof GrantShapeInput) => Object.prototype.hasOwnProperty.call(input, k);
    const fail = (message: string) => ({ ok: false as const, message });

    let actions: string[] | undefined;
    if (has('allowedActions') || !existing) {
        actions = input.allowedActions as string[];
        if (!Array.isArray(actions) || actions.length === 0) return fail('allowedActions must be a non-empty array');
        const unknown = actions.filter(a => !AGENT_ALLOWLISTABLE_ACTIONS.includes(a));
        if (unknown.length > 0) {
            return fail(`allowedActions contains non-grantable entries: ${unknown.join(', ')}. ` +
                `Grantable: ${AGENT_ALLOWLISTABLE_ACTIONS.join(', ')}`);
        }
    }
    const effectiveActions: string[] = actions ?? parseGrantList(existing?.allowedActions);

    // Deploying is a separate right with its own budget, not implied by the action list.
    // Only a grant with a sponsoring action can have it.
    const allowDeploy = has('allowDeploy') || !existing ? input.allowDeploy === true : existing.allowDeploy === true;
    if (allowDeploy && !effectiveActions.some(a => SPONSOR_TRANSACTION_ACTIONS.has(a))) {
        return fail("allowDeploy needs 'sponsorFinalizedTransaction' or 'sponsorUnboundTransaction' in allowedActions: a deploy is sponsored, never run by the server wallet");
    }
    let maxDeploys: number | null = null;
    if (allowDeploy) {
        const raw = has('maxDeploys') ? input.maxDeploys : existing ? existing.maxDeploys : undefined;
        maxDeploys = raw === undefined || raw === null ? 1 : Number(raw);
        if (!Number.isInteger(maxDeploys) || maxDeploys < 1 || maxDeploys > 100) {
            return fail('maxDeploys must be an integer between 1 and 100');
        }
        if (existing && maxDeploys < (existing.deploysUsed ?? 0)) {
            return fail(`maxDeploys must not be below the ${existing.deploysUsed} deploys already used`);
        }
    } else if (has('maxDeploys') && input.maxDeploys !== undefined && input.maxDeploys !== null) {
        return fail('maxDeploys needs allowDeploy: true');
    }

    // Same rule as the policy file: only what both the platform policy and the grant allow is allowed.
    let allowedContracts: string[];
    let allowedCircuits: string[];
    let allowedTokenTypes: string[];
    try {
        allowedContracts = has('allowedContracts') || !existing
            ? validatePolicyList('allowedContracts', input.allowedContracts)
            : parseGrantList(existing.allowedContracts);
        allowedCircuits = has('allowedCircuits') || !existing
            ? validatePolicyList('allowedCircuits', input.allowedCircuits)
            : parseGrantList(existing.allowedCircuits);
        allowedTokenTypes = has('allowedTokenTypes') || !existing
            ? validateTokenTypeList('allowedTokenTypes', input.allowedTokenTypes)
            : parseGrantList(existing.allowedTokenTypes);
    } catch (e) {
        return fail((e as Error).message);
    }

    const values: GrantShapeValues = { allowedContracts, allowedCircuits, allowedTokenTypes, allowDeploy, maxDeploys };
    if (actions) values.allowedActions = actions;
    if (has('maxJobsPerDay') || !existing) {
        if (input.maxJobsPerDay !== undefined && input.maxJobsPerDay !== null) {
            if (!Number.isInteger(input.maxJobsPerDay) || input.maxJobsPerDay < 1) {
                return fail('maxJobsPerDay must be a positive integer');
            }
        }
        values.maxJobsPerDay = input.maxJobsPerDay ?? null;
    }
    if (has('validUntil') || !existing) {
        if (input.validUntil) {
            const t = new Date(input.validUntil);
            if (Number.isNaN(t.getTime())) return fail('validUntil must be a valid ISO-8601 timestamp');
            if (t.getTime() <= Date.now()) return fail('validUntil must be in the future');
        }
        values.validUntil = input.validUntil ?? null;
    }
    if (has('agentLabel') || !existing) {
        if (input.agentLabel && input.agentLabel.length > 100) return fail('agentLabel must be at most 100 characters');
        values.agentLabel = input.agentLabel ?? null;
    }
    return { ok: true, values };
}

/** Fields an update may not change. Changing them needs a new grant. */
const GRANT_IMMUTABLE_FIELDS = ['sessionId', 'sponsorSessionId', 'userId', 'tokenHash'] as const;

/** Returns an ISO timestamp, undefined for an empty value, or null if it does not parse. */
function parseTimestamp(raw: unknown): string | null | undefined {
    if (raw === undefined || raw === null || raw === '') return undefined;
    const t = new Date(String(raw));
    return Number.isNaN(t.getTime()) ? null : t.toISOString();
}

/**
 * Returns a reject if the platform policy allows nothing from the grant's lists, else null.
 * A grant without own lists uses the platform's, so it is not checked here.
 */
function policyReject(values: GrantShapeValues, deployedContracts: string[] = []): { status: number; code?: string; message: string } | null {
    if (!values.allowedContracts.length && !values.allowedCircuits.length && !values.allowedTokenTypes.length) return null;
    try {
        const conflict = grantPolicyConflict(getGlobalSponsorPolicy(), {
            allowedContracts: values.allowedContracts, allowedCircuits: values.allowedCircuits,
            allowedTokenTypes: values.allowedTokenTypes, allowDeploy: values.allowDeploy, deployedContracts
        });
        return conflict ? { status: 400, message: conflict } : null;
    } catch (e) {
        if (e instanceof SponsorPolicyUnavailableError) return { status: e.status, code: e.code, message: e.message };
        throw e;
    }
}

export interface GrantSponsorPolicyView {
    grantId: string;
    active: boolean;
    allowedContracts: string[];
    allowedCircuits: string[];
    allowedTokenTypes: string[];
    deployedContracts: string[];
    mintedTokenTypes: string[];
    allowDeploy: boolean;
    allowSwaps: boolean;
    maxDeploys: number | null;
    deploysUsed: number;
}

type SponsorPolicyDescription = NonNullable<Awaited<ReturnType<typeof getSponsorPolicy>>>;

/** A policy as the admin API shows it. An unset list means an empty one. */
function policyView(p: SponsorPolicy): NonNullable<SponsorPolicyDescription['effective']> {
    return {
        allowedContracts: p.allowedContracts,
        allowedCircuits: p.allowedCircuits,
        allowedTokenTypes: p.allowedTokenTypes ?? [],
        ownContracts: p.ownContracts ?? [],
        ownTokenTypes: p.ownTokenTypes ?? [],
        allowDeploy: p.allowDeploy ?? null,
        allowContractMints: p.allowContractMints ?? null,
        allowSwaps: p.allowSwaps ?? null
    };
}

function floorView(p: SponsorPolicy): NonNullable<SponsorPolicyDescription['floor']> {
    const { ownContracts: _own, ownTokenTypes: _ownTypes, ...floor } = policyView(p);
    return floor;
}

export async function describeSponsorPolicy(db: DbRunner, grantId?: string | null): Promise<SponsorPolicyDescription | null> {
    const platform = describeGlobalSponsorPolicy();
    const out: SponsorPolicyDescription = {
        ...platform, floor: platform.floor ? floorView(platform.floor) : null, grant: null, effective: null, effectiveError: null
    };
    if (!grantId) {
        out.effective = platform.floor ? policyView(effectiveSponsorPolicy(platform.floor)) : null;
        out.effectiveError = platform.floorError;
        return out;
    }
    const row = await runWithoutAmbientTx(() => db.run(SELECT.one.from(AgentGrants).where({ ID: grantId }))) as AgentGrant | null;
    if (!row) return null;
    const active = row.isActive !== false && !row.revokedAt && !grantExpired(row);
    const grant: GrantSponsorPolicyView = {
        grantId: row.ID,
        active,
        allowedContracts: parseGrantList(row.allowedContracts),
        allowedCircuits: parseGrantList(row.allowedCircuits),
        allowedTokenTypes: parseGrantList(row.allowedTokenTypes),
        deployedContracts: parseGrantList(row.deployedContracts),
        mintedTokenTypes: parseGrantList(row.mintedTokenTypes),
        allowDeploy: row.allowDeploy === true,
        allowSwaps: parseGrantList(row.allowedActions).includes(SPONSOR_SWAP_ACTION),
        maxDeploys: row.maxDeploys ?? null,
        deploysUsed: row.deploysUsed ?? 0
    };
    out.grant = grant;
    if (!active) out.effectiveError = 'the grant is revoked or expired';
    else if (!platform.floor) out.effectiveError = platform.floorError;
    else {
        try {
            out.effective = policyView(effectiveSponsorPolicy(platform.floor, {
                ...grant, allowDeploy: grant.allowDeploy && grant.deploysUsed < (grant.maxDeploys ?? 1)
            }));
        } catch (e) {
            if (!(e instanceof SponsorPolicyEmptyError)) throw e;
            out.effectiveError = e.message;
        }
    }
    return out;
}

const USAGE_WINDOW_MAX_MS = 366 * 24 * 60 * 60 * 1000;
const USAGE_WINDOW_DEFAULT_MS = 30 * 24 * 60 * 60 * 1000;

export function registerAgentGrantHandlers(srv: cds.ApplicationService, db: DbRunner): void {
    interface GrantCreationInput {
        sessionId?: string | null;
        allowedActions?: string[] | null;
        maxJobsPerDay?: number | null;
        sponsorSessionId?: string | null;
        validUntil?: string | null;
        agentLabel?: string | null;
        allowedContracts?: string[] | null;
        allowedCircuits?: string[] | null;
        allowDeploy?: boolean | null;
        maxDeploys?: number | null;
        allowedTokenTypes?: string[] | null;
    }

    /**
     * Runs all checks before a grant is created.
     * On failure it rejects the request and returns undefined.
     */
    async function prepareGrantCreation(req: Request, data: GrantCreationInput, userId: string): Promise<{ values: GrantShapeValues; actions: string[]; sessionId: string } | undefined> {
        if (!data.sessionId) { req.reject(400, 'sessionId is required'); return undefined; }
        const shape = validateGrantShape(data);
        if (!shape.ok) { req.reject(400, shape.message); return undefined; }
        const actions = shape.values.allowedActions as string[];
        const refused = policyReject(shape.values);
        if (refused) { if (refused.code) req.reject(refused as any); else req.reject(refused.status, refused.message); return undefined; }

        const session: WalletSession | undefined = await runWithoutAmbientTx(() => db.run(
            SELECT.one.from(WalletSessions).where({ sessionId: data.sessionId, isActive: true, userId })
        ));
        if (!session) { req.reject(404, 'Session not found or inactive'); return undefined; }
        if (isSessionExpired(data.sessionId, session.expiresAt)) { req.reject(410, 'Session expired'); return undefined; }

        // Check the sponsor now. It is used on every write of the grant, and a broken one
        // would only fail after budget was spent. It is checked again on each use.
        // Only the sponsoring actions can use the platform pool.
        if (data.sponsorSessionId === PLATFORM_POOL_SENTINEL) {
            const pool = getConfiguredFeeSponsorSessions(getNightgatePluginConfig());
            if (pool.length === 0) {
                req.reject(412, `sponsorSessionId: '${PLATFORM_POOL_SENTINEL}' requires a configured NIGHTGATE_FEE_SPONSOR_SESSION pool`);
                return undefined;
            }
            const incompatible = actions.filter(a => !SPONSOR_PHASE2_ACTIONS.has(a) && !POOL_NEUTRAL_ACTIONS.has(a));
            if (incompatible.length > 0) {
                req.reject(400,
                    `a platform-pool grant may only allow 'sponsorFinalizedTransaction' / 'sponsorUnboundTransaction' / 'sponsorSwap' / 'postSwapOffer' / 'retireSwapOffer'; `
                    + `these actions resolve the sponsor directly and cannot use the pool: ${incompatible.join(', ')}`);
                return undefined;
            }
        } else if (data.sponsorSessionId) {
            try {
                await runWithoutAmbientTx(() => resolveFeeSponsor({
                    db,
                    sponsorSessionId: String(data.sponsorSessionId),
                    requestingUserId: userId,
                    config: getNightgatePluginConfig()
                }));
            } catch (err) {
                if (err instanceof FeeSponsorError) {
                    req.reject(err.httpStatus, `sponsorSessionId: ${err.message}`);
                    return undefined;
                }
                throw err;
            }
        }
        return { values: shape.values, actions, sessionId: data.sessionId };
    }

    function newGrantRow(userId: string, sessionId: string, data: GrantCreationInput, values: GrantShapeValues, actions: string[], agentLabel: string | null) {
        const { allowDeploy, maxDeploys, allowedContracts, allowedCircuits, allowedTokenTypes } = values;
        const token = TOKEN_PREFIX + crypto.randomBytes(TOKEN_BYTES).toString('hex');
        const grant = {
            ID: cds.utils.uuid(),
            userId,
            agentLabel,
            sessionId,
            tokenHash: hashAgentToken(token),
            allowedActions: JSON.stringify(actions),
            maxJobsPerDay: data.maxJobsPerDay ?? null,
            jobsUsedToday: 0,
            budgetWindow: null,
            sponsorSessionId: data.sponsorSessionId ?? null,
            allowedContracts: allowedContracts.length ? JSON.stringify(allowedContracts) : null,
            allowedCircuits: allowedCircuits.length ? JSON.stringify(allowedCircuits) : null,
            allowDeploy,
            maxDeploys,
            deploysUsed: 0,
            deployedContracts: null,
            allowedTokenTypes: allowedTokenTypes.length ? JSON.stringify(allowedTokenTypes) : null,
            validUntil: data.validUntil ?? null,
            isActive: true
        };
        return { grant, token };
    }

    function describeGrantCreation(values: GrantShapeValues, actions: string[], maxJobsPerDay: number | null | undefined): string {
        const { allowedContracts, allowedCircuits, allowedTokenTypes } = values;
        return `actions: ${actions.join(', ')}${maxJobsPerDay ? `, budget ${maxJobsPerDay}/day` : ''}`
            + `${allowedContracts.length ? `, contracts ${allowedContracts.map(c => c.slice(0, 12)).join('|')}` : ''}`
            + `${allowedCircuits.length ? `, circuits ${allowedCircuits.join('|')}` : ''}`
            + `${allowedTokenTypes.length ? `, token types ${allowedTokenTypes.map(t => t.slice(0, 12)).join('|')}` : ''}`;
    }

    function grantShapeView(values: GrantShapeValues, actions: string[], validUntil: string | null) {
        const { allowDeploy, maxDeploys, allowedContracts, allowedCircuits, allowedTokenTypes } = values;
        return { allowedActions: actions, allowedContracts, allowedCircuits, allowDeploy, maxDeploys, allowedTokenTypes, validUntil };
    }

    srv.on(createAgentGrant, async (req) => {
        if (!checkGrantAdminRate(req)) return;
        const userId = requireUserId(req);
        if (!userId) return;
        const data = req.data;
        const prepared = await prepareGrantCreation(req, data, userId);
        if (!prepared) return;
        const { values, actions, sessionId } = prepared;

        const { grant, token } = newGrantRow(userId, sessionId, data, values, actions, data.agentLabel ?? null);
        await db.run(INSERT.into(AgentGrants).entries(grant));
        log.info(`agent grant ${grant.ID} created for session ${String(data.sessionId).slice(0, 8)}… (${describeGrantCreation(values, actions, grant.maxJobsPerDay)})`);

        return { grantId: grant.ID, token, ...grantShapeView(values, actions, grant.validUntil) };
    });

    srv.on(createAgentGrants, async (req) => {
        if (!checkGrantAdminRate(req)) return;
        const userId = requireUserId(req);
        if (!userId) return;
        const data = req.data;
        const count = Number(data.count);
        if (!Number.isInteger(count) || count < 1 || count > MAX_GRANTS_PER_CALL) {
            return req.reject(400, `count must be an integer from 1 to ${MAX_GRANTS_PER_CALL}`);
        }
        let labels: string[];
        if (data.labels !== undefined && data.labels !== null) {
            if (!Array.isArray(data.labels) || data.labels.length !== count || data.labels.some(l => typeof l !== 'string' || l.trim() === '')) {
                return req.reject(400, 'labels must be an array of count non-empty strings');
            }
            labels = data.labels.map(l => l.trim());
            if (labels.some(l => l.length > 100)) return req.reject(400, 'labels: each at most 100 characters');
        } else {
            const stem = (data.agentLabel ?? 'agent').trim() || 'agent';
            labels = Array.from({ length: count }, (_, i) => `${stem}-${i + 1}`.slice(0, 100));
        }
        const prepared = await prepareGrantCreation(req, data, userId);
        if (!prepared) return;
        const { values, actions, sessionId } = prepared;

        const rows = labels.map(label => newGrantRow(userId, sessionId, data, values, actions, label));
        await db.run(INSERT.into(AgentGrants).entries(rows.map(r => r.grant)));
        log.info(`${rows.length} agent grants created for session ${String(data.sessionId).slice(0, 8)}… (${describeGrantCreation(values, actions, data.maxJobsPerDay)})`);

        return {
            grants: rows.map(({ grant, token }) => ({ grantId: grant.ID, token, agentLabel: grant.agentLabel })),
            ...grantShapeView(values, actions, data.validUntil ?? null)
        };
    });

    srv.on(revokeAgentGrant, async (req) => {
        if (!checkGrantAdminRate(req)) return;
        const userId = requireUserId(req);
        if (!userId) return;
        const { grantId } = req.data;
        if (!grantId) return req.reject(400, 'grantId is required');

        const affected = await db.run(
            UPDATE.entity(AgentGrants)
                .set({ isActive: false, revokedAt: new Date().toISOString() })
                .where({ ID: grantId, userId, isActive: true })
        );
        if (!Number(affected)) return req.reject(404, 'Grant not found');
        log.info(`agent grant ${grantId} revoked`);
        return { revoked: true };
    });

    srv.on(updateAgentGrant, async (req) => {
        if (!checkGrantAdminRate(req)) return;
        const userId = requireUserId(req);
        if (!userId) return;
        const data = req.data;
        if (!data.grantId) return req.reject(400, 'grantId is required');
        const immutable = GRANT_IMMUTABLE_FIELDS.filter(f => Object.prototype.hasOwnProperty.call(data, f));
        if (immutable.length > 0) {
            return req.reject(400, `${immutable.join(', ')} cannot be changed; issue a new grant for a different binding`);
        }

        const existing = await loadOwnGrant(db, data.grantId, userId);
        if (!existing) return req.reject(404, 'Grant not found');
        if (!existing.isActive) return req.reject({ status: 409, code: 'GRANT_REVOKED', message: 'Grant is revoked' } as any);

        const shape = validateGrantShape(data, existing);
        if (!shape.ok) return req.reject(400, shape.message);
        const v = shape.values;
        const refused = policyReject(v, parseGrantList(existing.deployedContracts));
        if (refused) return refused.code ? req.reject(refused as any) : req.reject(refused.status, refused.message);
        const patch: Record<string, unknown> = {
            allowedContracts: v.allowedContracts.length ? JSON.stringify(v.allowedContracts) : null,
            allowedCircuits: v.allowedCircuits.length ? JSON.stringify(v.allowedCircuits) : null,
            allowedTokenTypes: v.allowedTokenTypes.length ? JSON.stringify(v.allowedTokenTypes) : null,
            allowDeploy: v.allowDeploy,
            maxDeploys: v.maxDeploys
        };
        if (v.allowedActions) patch.allowedActions = JSON.stringify(v.allowedActions);
        if ('maxJobsPerDay' in v) patch.maxJobsPerDay = v.maxJobsPerDay;
        if ('validUntil' in v) patch.validUntil = v.validUntil;
        if ('agentLabel' in v) patch.agentLabel = v.agentLabel;
        const updated = Object.keys(data).filter(k => k !== 'grantId');

        // Only updates active grants, so a revoke at the same time wins over the edit.
        const affected = await db.run(
            UPDATE.entity(AgentGrants).set(patch).where({ ID: data.grantId, userId, isActive: true })
        );
        if (!Number(affected)) return req.reject({ status: 409, code: 'GRANT_REVOKED', message: 'Grant is revoked' } as any);
        log.info(`agent grant ${data.grantId} updated (${updated.join(', ')})`);
        return { grantId: data.grantId, updated };
    });

    srv.on(rotateAgentGrantToken, async (req) => {
        if (!checkGrantAdminRate(req)) return;
        const userId = requireUserId(req);
        if (!userId) return;
        const { grantId } = req.data;
        if (!grantId) return req.reject(400, 'grantId is required');

        const token = TOKEN_PREFIX + crypto.randomBytes(TOKEN_BYTES).toString('hex');
        const affected = await db.run(
            UPDATE.entity(AgentGrants)
                .set({ tokenHash: hashAgentToken(token) })
                .where({ ID: grantId, userId, isActive: true })
        );
        if (!Number(affected)) return req.reject(404, 'Grant not found');
        log.info(`agent grant ${grantId} token rotated`);
        return { grantId, token };
    });

    srv.on(getGrantUsage, async (req) => {
        const userId = requireUserId(req);
        if (!userId) return;
        const data = req.data;
        if (!data.grantId) return req.reject(400, 'grantId is required');
        const to = parseTimestamp(data.until);
        const from = parseTimestamp(data.since);
        if (to === null) return req.reject(400, 'until must be a valid ISO-8601 timestamp');
        if (from === null) return req.reject(400, 'since must be a valid ISO-8601 timestamp');
        const toMs = to ? new Date(to).getTime() : Date.now();
        const fromMs = from ? new Date(from).getTime() : toMs - USAGE_WINDOW_DEFAULT_MS;
        if (fromMs > toMs) return req.reject(400, 'since must not lie after until');
        if (toMs - fromMs > USAGE_WINDOW_MAX_MS) return req.reject(400, 'the window may span at most 366 days');
        const fromIso = new Date(fromMs).toISOString();
        const toIso = new Date(toMs).toISOString();

        // Revoked grants still show their history, so this only checks the owner.
        const grant: AgentGrant | null = await runWithoutAmbientTx(() => db.run(
            SELECT.one.from(AgentGrants).where({ ID: data.grantId, userId })
        )) as AgentGrant | null;
        if (!grant) return req.reject(404, 'Grant not found');

        const rows = (await runWithoutAmbientTx(() => db.run(
            SELECT.from(BackgroundJobs)
                .columns('kind', 'status', 'chainStatus', 'txHash')
                .where({ grantId: grant.ID, queuedAt: { '>=': fromIso } })
                .and({ queuedAt: { '<=': toIso } })
        )) ?? []) as Array<{ kind?: string; status?: string; chainStatus?: string | null; txHash?: string | null }>;

        const counts = new Map<string, { kind: string; status: string; count: number }>();
        let landed = 0;
        let failed = 0;
        const landedHashes: string[] = [];
        for (const r of rows) {
            const kind = String(r.kind ?? 'unknown');
            const status = String(r.status ?? 'unknown');
            const key = `${kind}\0${status}`;
            const c = counts.get(key) ?? { kind, status, count: 0 };
            c.count += 1;
            counts.set(key, c);
            if (r.chainStatus === 'success') {
                landed += 1;
                if (r.txHash) landedHashes.push(String(r.txHash).toLowerCase());
            }
            if (status === 'failed' || r.chainStatus === 'failure') failed += 1;
        }
        const jobs = [...counts.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.status.localeCompare(b.status));

        // Fees are only known for transactions the crawler has indexed.
        const crawlerOn = (resolveNightgateRuntimeConfig(getNightgatePluginConfig()).crawlerConfig as any)?.enabled !== false;
        const dustPaid = crawlerOn ? await sumIndexedFees(db, landedHashes) : null;

        return {
            grantId: grant.ID,
            since: fromIso,
            until: toIso,
            jobs,
            landed,
            failed,
            deploysUsed: grant.deploysUsed ?? 0,
            maxDeploys: grant.maxDeploys ?? null,
            jobsUsedToday: grant.budgetWindow === utcDay() ? (grant.jobsUsedToday ?? 0) : 0,
            maxJobsPerDay: grant.maxJobsPerDay ?? null,
            dustPaid
        };
    });
}

function checkGrantAdminRate(req: Request): boolean {
    const rate = grantAdminRateLimiter.check(principalRateKey(req, 'grant-admin'));
    if (rate.allowed) return true;
    req.reject(429, `Rate limited. Retry after ${Math.ceil(rate.retryAfterMs / 1000)}s`);
    return false;
}

async function loadOwnGrant(db: DbRunner, grantId: string, userId: string): Promise<AgentGrant | null> {
    return await runWithoutAmbientTx(() => db.run(
        SELECT.one.from(AgentGrants).where({ ID: grantId, userId })
    )) as AgentGrant | null;
}

/** Sum of the indexed fees (DUST atoms) of the given job `txHash`es, as a decimal string. */
async function sumIndexedFees(db: DbRunner, hashes: string[]): Promise<string> {
    let total = 0n;
    for (let i = 0; i < hashes.length; i += 500) {
        const chunk = hashes.slice(i, i + 500);
        const txs = (await runWithoutAmbientTx(() => db.run(
            SELECT.from(Transactions).columns('ID').where({ hash: { in: chunk } })
        )) ?? []) as Array<{ ID: string }>;
        const ids = txs.map(t => t.ID).filter(Boolean);
        if (ids.length === 0) continue;
        const fees = (await runWithoutAmbientTx(() => db.run(
            SELECT.from(TransactionFees).columns('paidFees').where({ transaction_ID: { in: ids } })
        )) ?? []) as Array<{ paidFees?: string | number | bigint | null }>;
        for (const f of fees) {
            if (f.paidFees === undefined || f.paidFees === null) continue;
            try { total += BigInt(f.paidFees); } catch { /* not a number: skip */ }
        }
    }
    return total.toString();
}

/** Registers the hook that checks agent tokens. Register it first in the service init. */
export function attachAgentGrantEnforcement(srv: any, db: DbRunner): void {
    srv.before('*', (req: Request) => {
        // CAP runs before-handlers in parallel. Other hooks that check the user
        // must wait for this one to set it, so the promise is stored on the request.
        const resolution = enforceAgentGrant(req, db);
        (req as any)[AGENT_PRINCIPAL_READY] = resolution.then(() => undefined, () => undefined);
        return resolution;
    });
}

const AGENT_PRINCIPAL_READY = Symbol.for('nightgate.agentPrincipalReady');

/**
 * Waits until the agent token check has set the request user.
 * Every before-hook that reads `req.user` must call this first.
 */
export async function awaitAgentPrincipal(req: Request): Promise<void> {
    const ready = (req as any)[AGENT_PRINCIPAL_READY];
    if (ready) await ready;
}

/** CAP's per-request HTTP context. In a $batch it holds the headers of the single part. */
type BatchPartRequest = Request & { _?: { req?: { headers?: Record<string, string | string[] | undefined> } } };

export async function enforceAgentGrant(req: BatchPartRequest, db: DbRunner): Promise<unknown> {
    // In a $batch request, `req.headers` also contains the outer request's headers.
    // `_.req.headers` only has the headers of the single part.
    const token = req?.headers?.[AGENT_TOKEN_HEADER] ?? req?._?.req?.headers?.[AGENT_TOKEN_HEADER];
    if (!token || typeof token !== 'string') {
        // These placeholder users mark requests the auth layer let through without a login.
        // They must never reach a handler as a real user.
        const uid = req?.user?.id;
        if (uid === AGENT_TOKEN_TRANSPORT_USER) {
            return req.reject(401, 'agent token required');
        }
        if (uid === PUBLIC_VERIFY_TRANSPORT_USER) {
            return req.reject(401, 'authentication required');
        }
        return;
    }

    if (!token.startsWith(TOKEN_PREFIX)) {
        return req.reject(401, 'invalid agent token');
    }
    const grant: AgentGrant | null = await runWithoutAmbientTx(() => db.run(
        SELECT.one.from(AgentGrants).where({ tokenHash: hashAgentToken(token), isActive: true })
    )) as AgentGrant | null;
    if (!grant) return req.reject(401, 'invalid agent token'); // same message, so it reveals nothing
    if (grantExpired(grant)) {
        return req.reject(410, 'agent grant expired');
    }

    const event = String(req.event ?? '');
    const alwaysAllowed = AGENT_ALWAYS_ALLOWED_EVENTS.has(event);
    // The handler only checks the owner, which would allow every grant of that user.
    if (event === 'getGrantUsage' && String(req.data?.grantId ?? '') !== grant.ID) {
        return req.reject(404, 'Grant not found');
    }
    let allowlisted = false;
    if (!alwaysAllowed) {
        allowlisted = parseJsonStringList(grant.allowedActions).includes(event);
        if (!allowlisted) {
            return req.reject(403, `action '${event}' is not allowed for this agent grant`);
        }
    }

    // A grant covers one session, so lists must not show the user's other sessions.
    // The owner hooks add their userId filter on top of this one.
    if (event === 'READ') {
        const target = String(req.target?.name ?? '');
        const entity = target.slice(target.lastIndexOf('.') + 1);
        if (!AGENT_READABLE_ENTITIES.has(entity)) {
            return req.reject(403, `entity '${entity}' is not readable with an agent token`);
        }
        const query: any = req.query;
        if (query?.where) {
            if (entity === 'WalletSessions' || entity === 'PendingSubmissions' || entity === 'Documents') {
                query.where({ sessionId: grant.sessionId });
            } else if (entity === 'AgentGrants') {
                query.where({ ID: grant.ID });
            }
        }
    }

    // Sponsoring actions are checked by the worker, which inspects the transaction itself.
    if (allowlisted && !SPONSOR_PHASE2_ACTIONS.has(event)) {
        const scope = grantScopeViolation(grant, req.data, event);
        if (scope) return req.reject(403, scope);
    }

    const data = req.data;
    if (data && typeof data === 'object' && event !== 'READ') {
        // Sponsoring jobs belong to the sponsor session. Only getJobStatus may name it,
        // because a write with it would act as the sponsor.
        const sponsorPoll = event === 'getJobStatus'
            && !!grant.sponsorSessionId
            && (data.sessionId === grant.sponsorSessionId
                || (grant.sponsorSessionId === PLATFORM_POOL_SENTINEL
                    && getConfiguredFeeSponsorSessions(getNightgatePluginConfig()).includes(String(data.sessionId ?? ''))));
        // Pool jobs are stored under the pool placeholder id, not under one pool wallet.
        if (sponsorPoll && grant.sponsorSessionId === PLATFORM_POOL_SENTINEL) {
            data.sessionId = PLATFORM_POOL_SENTINEL;
        }
        if (data.sessionId !== undefined && data.sessionId !== null
            && data.sessionId !== grant.sessionId && !sponsorPoll) {
            return req.reject(403, 'sessionId does not match this agent grant');
        }
        if (!sponsorPoll) data.sessionId = grant.sessionId;
        if (allowlisted && grant.sponsorSessionId) {
            if (data.sponsorSessionId !== undefined && data.sponsorSessionId !== null
                && data.sponsorSessionId !== grant.sponsorSessionId) {
                return req.reject(403, 'sponsorSessionId does not match this agent grant');
            }
            data.sponsorSessionId = grant.sponsorSessionId;
        } else if (allowlisted && data.sponsorSessionId !== undefined && data.sponsorSessionId !== null && data.sponsorSessionId !== '') {
            return req.reject(403, 'this agent grant has no sponsor binding; issue the grant with sponsorSessionId to sponsor its jobs');
        }
    }

    // Runs outside the request transaction, so the count stays even if the request fails later.
    // Counting a failure is better than missing abuse.
    if (allowlisted && grant.maxJobsPerDay !== undefined && grant.maxJobsPerDay !== null) {
        const consumed = await consumeDailyBudget(db, grant);
        if (!consumed) {
            return req.reject(429, `agent grant daily job budget exhausted (${grant.maxJobsPerDay}/day)`);
        }
        // A 400 to 428 error started no job, so give the unit back. 429 and 5xx keep it.
        (req as any).on?.('failed', (err: any) => {
            const status = Number(err?.status ?? err?.statusCode ?? err?.code);
            if (Number.isInteger(status) && status >= 400 && status < 429) {
                void refundDailyBudget(db, grant).catch((e: unknown) => log.warn(`daily budget refund for grant ${grant.ID} failed: ${errorMessage(e)}`));
            }
        });
    }

    const UserCtor = (cds as any).User;
    (req as any).user = UserCtor ? new UserCtor({ id: grant.userId }) : { id: grant.userId };
    req.agentGrant = {
        ID: grant.ID, sessionId: grant.sessionId, userId: grant.userId,
        allowedContracts: parseGrantList(grant.allowedContracts),
        allowedCircuits: parseGrantList(grant.allowedCircuits),
        deployedContracts: parseGrantList(grant.deployedContracts),
        allowedTokenTypes: parseGrantList(grant.allowedTokenTypes),
        mintedTokenTypes: parseGrantList(grant.mintedTokenTypes),
        allowSwaps: parseGrantList(grant.allowedActions).includes(SPONSOR_SWAP_ACTION),
        // Only a first check. The deploy budget is reserved before each deploy is sent,
        // in reserveDeployBudget.
        allowDeploy: grant.allowDeploy === true && (grant.deploysUsed ?? 0) < (grant.maxDeploys ?? 1)
    };
}

async function refundDailyBudget(db: DbRunner, grant: AgentGrant): Promise<void> {
    await runWithoutAmbientTx(() => db.run(
        UPDATE.entity(AgentGrants)
            .set({ jobsUsedToday: { '-=': 1 } })
            .where({ ID: grant.ID, budgetWindow: utcDay(), jobsUsedToday: { '>': 0 } })
    ));
}

/**
 * Uses one unit of the daily budget. Safe under parallel requests.
 * A new day resets the counter only if no other request reset it first.
 */
async function consumeDailyBudget(db: DbRunner, grant: AgentGrant): Promise<boolean> {
    const today = utcDay();
    const max = grant.maxJobsPerDay as number;

    if (grant.budgetWindow !== today) {
        const reset = await runWithoutAmbientTx(() => db.run(
            UPDATE.entity(AgentGrants)
                .set({ budgetWindow: today, jobsUsedToday: 1 })
                .where({ ID: grant.ID, budgetWindow: grant.budgetWindow ?? null })
        ));
        if (Number(reset)) return true;
    }
    const incremented = await runWithoutAmbientTx(() => db.run(
        UPDATE.entity(AgentGrants)
            .set({ jobsUsedToday: { '+=': 1 } })
            .where({ ID: grant.ID, budgetWindow: today, jobsUsedToday: { '<': max } })
    ));
    return Number(incremented) > 0;
}
