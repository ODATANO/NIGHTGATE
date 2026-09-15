/**
 * Agent grants: a bearer token that only restricts one wallet session, never an
 * identity. A valid token swaps the principal to the grant's operator, so every
 * existing userId gate applies unchanged.
 */

import cds from '@sap/cds';
import type { Request } from '@sap/cds';
import crypto from 'crypto';
import { AgentGrants, WalletSessions, BackgroundJobs, Transactions, TransactionFees } from '#cds-models/midnight';
import { RateLimiter } from '../utils/rate-limiter';
import { PLATFORM_POOL_SENTINEL } from '../submission/sponsor-pool';
import { getConfiguredFeeSponsorSessions } from '../submission/fee-sponsor';
import { GrantPolicyInput, validatePolicyList, validateTokenTypeList } from '../submission/sponsor-policy';
import { withKeyedLock } from '../utils/keyed-lock';
import { runWithoutAmbientTx } from '../submission/background-jobs';
import { resolveFeeSponsor, FeeSponsorError } from '../submission/fee-sponsor';
import { getNightgatePluginConfig, resolveNightgateRuntimeConfig } from '../utils/nightgate-config';
import { configNumber } from '../utils/config';
import { isSessionExpired } from '../utils/session-expiry';
import { AGENT_TOKEN_HEADER, AGENT_TOKEN_TRANSPORT_USER, PUBLIC_VERIFY_TRANSPORT_USER } from '../utils/agent-token-transport';
import { principalRateKey } from '../utils/rate-limiter';

const { SELECT, INSERT, UPDATE } = cds.ql;

const log = cds.log('nightgate:agent-grants');

export { AGENT_TOKEN_HEADER };
const TOKEN_PREFIX = 'ngat_';
const TOKEN_BYTES = 32;

/** Write actions a grant may allow; anything else not always-allowed is a 403 for a token. */
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
    // The transaction arrives proven and signed: the grant spends only the
    // sponsor's dust, which sponsor pinning and the daily budget meter.
    'sponsorFinalizedTransaction',
    'sponsorUnboundTransaction'
];

/** The phase-2 sponsoring actions: keyed by the SPONSOR session, pool-aware. */
export const SPONSOR_PHASE2_ACTIONS: ReadonlySet<string> = new Set([
    'sponsorFinalizedTransaction',
    'sponsorUnboundTransaction'
]);

/**
 * Entities a token may READ; session-bound ones are narrowed in enforceAgentGrant.
 * Any other owner-scoped listing would expose the operator's other sessions.
 */
export const AGENT_READABLE_ENTITIES: ReadonlySet<string> = new Set([
    'Blocks', 'Transactions', 'TransactionResults', 'TransactionSegments', 'TransactionFees',
    'ContractActions', 'ContractBalances', 'UnshieldedUtxos', 'ZswapLedgerEvents',
    'DustLedgerEvents', 'NightBalances', 'PredicateAttestations', 'DisclosureGrants',
    'WalletSessions', 'PendingSubmissions', 'AgentGrants', 'Documents'
]);

/** Events every valid token may use without an allowlist entry or budget. */
export const AGENT_ALWAYS_ALLOWED_EVENTS: ReadonlySet<string> = new Set([
    'READ',
    'verifyDocument',
    'verifyAttestationState',
    'verifyPredicateState',
    'verifyPredicateAttestation',
    'prepareDocumentProof', // compute-only
    'prepareMembershipSet', // compute-only
    'deriveTokenType', // compute-only
    'getJobStatus',
    'getGrantUsage' // narrowed to the token's own grant in enforceAgentGrant
    // Not getSponsorPoolStatus: as the operator, a token would read every
    // sponsor session that operator owns.
]);

// Grant administration (create, update, rotate, revoke) per hour per principal.
const grantAdminRateLimiter = new RateLimiter({ windowMs: 60 * 60 * 1000, maxRequests: configNumber('NIGHTGATE_GRANT_ADMIN_RATE_LIMIT') });

/** Forget every rate-limit window (tests: one principal serves every case). */
export function __resetGrantRateLimiterForTests(): void {
    grantAdminRateLimiter.reset();
}

interface AgentGrantRow {
    ID: string;
    userId: string;
    sessionId: string;
    allowedActions: string;
    maxJobsPerDay?: number | null;
    jobsUsedToday?: number | null;
    budgetWindow?: string | null;
    sponsorSessionId?: string | null;
    allowedContracts?: string | null; // JSON array or null
    allowedCircuits?: string | null;
    allowDeploy?: boolean | null;
    maxDeploys?: number | null;
    deploysUsed?: number | null;
    deployedContracts?: string | null; // JSON array: addresses deployed under this grant
    allowedTokenTypes?: string | null; // JSON array of raw token types, or null
    validUntil?: string | null;
    isActive?: boolean;
    revokedAt?: string | null;
}

/** Anything that runs a CQL statement: the db service, or one transaction of it. */
type Runner = { run: (q: unknown) => Promise<unknown> };

/**
 * Record addresses deployed under a grant; the sponsor policy adds them on top of
 * `floor ∩ grant` (in `allowedContracts` they would fall out of the intersection).
 */
export async function recordDeployedContracts(db: Runner, grantId: string, addresses: string[]): Promise<void> {
    const fresh = addresses.map(a => String(a).trim()).filter(Boolean);
    if (!grantId || fresh.length === 0) return;
    await withKeyedLock(`agent-grant-deploys:${grantId}`, async () => {
        try {
            const grant: AgentGrantRow | null = await runWithoutAmbientTx(() => db.run(
                SELECT.one.from(AgentGrants).where({ ID: grantId })
            )) as AgentGrantRow | null;
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
            log.error(`could not record deployed contract(s) ${fresh.map(a => a.slice(0, 12)).join(', ')} on grant ${grantId.slice(0, 8)}…: ${(err as Error)?.message ?? err}`);
            throw err;
        }
    });
}

/**
 * Reserve deploys of the grant's lifetime budget before the broadcast, all or
 * nothing. Run it in the transaction that inserts the attempt row.
 */
export async function reserveDeployBudget(runner: Runner, grantId: string, count: number): Promise<boolean> {
    if (!grantId || !Number.isInteger(count) || count < 1) return false;
    const grant = await runner.run(SELECT.one.from(AgentGrants).where({ ID: grantId })) as AgentGrantRow | null;
    if (!grant || grant.isActive === false || grant.allowDeploy !== true) return false;
    const max = grant.maxDeploys ?? 1;
    const updated = await runner.run(
        UPDATE.entity(AgentGrants)
            .set({ deploysUsed: { '+=': count } })
            .where({ ID: grantId, isActive: true, allowDeploy: true, deploysUsed: { '<=': max - count } })
    );
    return Number(updated) > 0;
}

/** Refund a reservation whose attempt was rejected; an ambiguous broadcast keeps it. */
export async function releaseDeployBudget(db: Runner, grantId: string, count: number): Promise<void> {
    if (!grantId || !Number.isInteger(count) || count < 1) return;
    try {
        await runWithoutAmbientTx(() => db.run(
            UPDATE.entity(AgentGrants)
                .set({ deploysUsed: { '-=': count } })
                .where({ ID: grantId, deploysUsed: { '>=': count } })
        ));
    } catch (err) {
        log.error(`could not release ${count} reserved deploy(s) on grant ${grantId.slice(0, 8)}…; deploysUsed is now one too high, correct it by hand: ${(err as Error)?.message ?? err}`);
        throw err;
    }
}

/**
 * The grant's current policy, re-resolved per job so a revoke or narrowing
 * applies to queued jobs too. null = revoked, expired or gone.
 */
export async function currentGrantPolicy(runner: Runner, grantId: string): Promise<GrantPolicyInput | null> {
    const grant = await currentGrantRow(runner, grantId);
    if (!grant) return null;
    return {
        allowedContracts: parseGrantList(grant.allowedContracts),
        allowedCircuits: parseGrantList(grant.allowedCircuits),
        deployedContracts: parseGrantList(grant.deployedContracts),
        allowedTokenTypes: parseGrantList(grant.allowedTokenTypes),
        allowDeploy: grant.allowDeploy === true
    };
}

/** The grant as it is now, for a re-check when a queued job runs; null = revoked, expired or gone. */
export async function currentGrantRow(runner: Runner, grantId: string): Promise<AgentGrantRow | null> {
    const grant = await runner.run(SELECT.one.from(AgentGrants).where({ ID: grantId })) as AgentGrantRow | null;
    if (!grant || grant.isActive === false || grant.revokedAt || grantExpired(grant)) return null;
    return grant;
}

/** The action(s) a job of this kind was admitted as; a retract command carries its mode. */
function actionsOfJob(kind: string, command: Record<string, unknown>): string[] {
    if (kind === 'retract') return command.mode === 1 ? ['purgeExpired'] : ['retractAttestation'];
    if (kind === 'anchorDocument') return ['anchorDocument', 'attestAgentOutput'];
    return [kind];
}

/** Circuits a persisted command runs when its op does not spell them out. */
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
 * Re-check of a queued job against the grant as it is NOW: the action the job
 * was admitted as (a child: its parent's kind, `parentKind`), then the contract
 * and every circuit the persisted command runs. null = still within scope.
 */
export function grantJobScopeViolation(
    grant: Pick<AgentGrantRow, 'allowedActions' | 'allowedContracts' | 'allowedCircuits'>,
    job: { kind: string; parentJobId?: string | null; parentKind?: string | null },
    command: Record<string, unknown>
): string | null {
    const admittedKind = job.parentJobId ? job.parentKind : job.kind;
    if (!admittedKind) return 'the action the parent job was admitted as is unknown';
    let allowed: unknown = [];
    try { allowed = JSON.parse(grant.allowedActions || '[]'); } catch { allowed = []; }
    const actions = actionsOfJob(admittedKind, job.parentJobId ? {} : command);
    if (!Array.isArray(allowed) || !actions.some(a => allowed.includes(a))) {
        return `action '${actions[0]}' is no longer allowed for this agent grant`;
    }
    const op = String(command.op ?? '');
    const data: Record<string, unknown> = { contractAddress: command.contractAddress };
    if (typeof command.circuit === 'string') data.circuit = command.circuit;
    if (Array.isArray(command.calls)) data.calls = command.calls;
    if (OP_CIRCUITS[op]) data.circuits = [...OP_CIRCUITS[op]];
    return grantScopeViolation(grant, data, op);
}

/** A grant's JSON list column as an array; malformed or absent = no narrowing. */
function parseGrantList(raw: string | null | undefined): string[] {
    if (!raw) return [];
    try {
        const v = JSON.parse(raw);
        return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
    } catch {
        return [];
    }
}

function grantExpired(grant: Pick<AgentGrantRow, 'validUntil'>, now: Date = new Date()): boolean {
    return !!grant.validUntil && new Date(grant.validUntil) < now;
}

/** The 403 message when the request's contract or circuits leave the grant's lists, else null. */
export function grantScopeViolation(
    grant: Pick<AgentGrantRow, 'allowedContracts' | 'allowedCircuits'>,
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
 * Circuits an action may run server-side; a grant's circuit list must allow all
 * of them. An action resolving to nothing known is refused under a circuit list.
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
    reindexDisclosures: []
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
    const uid = (req as any).user?.id;
    if (!uid) { req.reject?.(401, 'authentication required'); return undefined; }
    return uid as string;
}

function utcDay(now: Date = new Date()): string {
    return now.toISOString().slice(0, 10);
}

// ---- Grant administration -------------------------------------------------

/** The editable grant fields, as a client sends them. */
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

/** Validated values, ready for the row: lists are arrays (empty = unrestricted). */
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
 * Validation of the editable fields for create and update. On update a field
 * absent from the input keeps `existing`'s value; explicit null clears it.
 */
export function validateGrantShape(
    input: GrantShapeInput,
    existing?: AgentGrantRow
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

    // A deploy is a distinct right with its own budget, never implied by the
    // action list; only the sponsoring actions can carry one.
    const allowDeploy = has('allowDeploy') || !existing ? input.allowDeploy === true : existing.allowDeploy === true;
    if (allowDeploy && !effectiveActions.some(a => SPONSOR_PHASE2_ACTIONS.has(a))) {
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

    // Same rule as the policy file: the effective policy is floor ∩ grant.
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

/** Row fields a grant edit never touches; a different pin is a different grant. */
const GRANT_IMMUTABLE_FIELDS = ['sessionId', 'sponsorSessionId', 'userId', 'tokenHash'] as const;

/** ISO timestamp or undefined; `null` when the value does not parse. */
function parseTimestamp(raw: unknown): string | null | undefined {
    if (raw === undefined || raw === null || raw === '') return undefined;
    const t = new Date(String(raw));
    return Number.isNaN(t.getTime()) ? null : t.toISOString();
}

const USAGE_WINDOW_MAX_MS = 366 * 24 * 60 * 60 * 1000;
const USAGE_WINDOW_DEFAULT_MS = 30 * 24 * 60 * 60 * 1000;

export function registerAgentGrantHandlers(srv: any, db: any): void {
    srv.on('createAgentGrant', async (req: Request) => {
        if (!checkGrantAdminRate(req)) return;
        const userId = requireUserId(req);
        if (!userId) return;

        const data = req.data as {
            sessionId?: string;
            allowedActions?: string[];
            maxJobsPerDay?: number | null;
            sponsorSessionId?: string | null;
            validUntil?: string | null;
            agentLabel?: string | null;
            allowedContracts?: string[] | null;
            allowedCircuits?: string[] | null;
            allowDeploy?: boolean | null;
            maxDeploys?: number | null;
            allowedTokenTypes?: string[] | null;
        };

        if (!data.sessionId) return req.reject(400, 'sessionId is required');
        const shape = validateGrantShape(data);
        if (!shape.ok) return req.reject(400, shape.message);
        const { allowDeploy, maxDeploys, allowedContracts, allowedCircuits, allowedTokenTypes } = shape.values;
        const actions = shape.values.allowedActions as string[];

        const session: any = await runWithoutAmbientTx(() => db.run(
            SELECT.one.from(WalletSessions).where({ sessionId: data.sessionId, isActive: true, userId })
        ));
        if (!session) return req.reject(404, 'Session not found or inactive');
        if (isSessionExpired(data.sessionId, session.expiresAt)) {
            return req.reject(410, 'Session expired');
        }

        // Validate the sponsor at creation: it is injected into every write of
        // the grant, and a dead one would fail only after budget was spent.
        // The per-use resolution still runs. Only the sponsoring actions
        // understand the pool sentinel.
        if (data.sponsorSessionId === PLATFORM_POOL_SENTINEL) {
            const pool = getConfiguredFeeSponsorSessions(getNightgatePluginConfig());
            if (pool.length === 0) {
                return req.reject(412, `sponsorSessionId: '${PLATFORM_POOL_SENTINEL}' requires a configured NIGHTGATE_FEE_SPONSOR_SESSION pool`);
            }
            const incompatible = actions.filter(a => !SPONSOR_PHASE2_ACTIONS.has(a));
            if (incompatible.length > 0) {
                return req.reject(400,
                    `a platform-pool grant may only allow 'sponsorFinalizedTransaction' / 'sponsorUnboundTransaction'; `
                    + `these actions resolve the sponsor directly and cannot use the pool: ${incompatible.join(', ')}`);
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
                    return req.reject(err.httpStatus, `sponsorSessionId: ${err.message}`);
                }
                throw err;
            }
        }

        const token = TOKEN_PREFIX + crypto.randomBytes(TOKEN_BYTES).toString('hex');
        const grant = {
            ID: cds.utils.uuid(),
            userId,
            agentLabel: data.agentLabel ?? null,
            sessionId: data.sessionId,
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
        await db.run(INSERT.into(AgentGrants).entries(grant));
        log.info(`agent grant ${grant.ID} created for session ${String(data.sessionId).slice(0, 8)}… ` +
            `(actions: ${actions.join(', ')}${grant.maxJobsPerDay ? `, budget ${grant.maxJobsPerDay}/day` : ''}` +
            `${allowedContracts.length ? `, contracts ${allowedContracts.map(c => c.slice(0, 12)).join('|')}` : ''}` +
            `${allowedCircuits.length ? `, circuits ${allowedCircuits.join('|')}` : ''}` +
            `${allowedTokenTypes.length ? `, token types ${allowedTokenTypes.map(t => t.slice(0, 12)).join('|')}` : ''})`);

        return { grantId: grant.ID, token, allowedActions: actions, allowedContracts, allowedCircuits, allowDeploy, maxDeploys, allowedTokenTypes, validUntil: grant.validUntil };
    });

    srv.on('revokeAgentGrant', async (req: Request) => {
        if (!checkGrantAdminRate(req)) return;
        const userId = requireUserId(req);
        if (!userId) return;
        const { grantId } = req.data as { grantId?: string };
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

    srv.on('updateAgentGrant', async (req: Request) => {
        if (!checkGrantAdminRate(req)) return;
        const userId = requireUserId(req);
        if (!userId) return;
        const data = req.data as GrantShapeInput & { grantId?: string } & Record<string, unknown>;
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

        // Conditional on isActive: a concurrent revoke wins over the edit.
        const affected = await db.run(
            UPDATE.entity(AgentGrants).set(patch).where({ ID: data.grantId, userId, isActive: true })
        );
        if (!Number(affected)) return req.reject({ status: 409, code: 'GRANT_REVOKED', message: 'Grant is revoked' } as any);
        log.info(`agent grant ${data.grantId} updated (${updated.join(', ')})`);
        return { grantId: data.grantId, updated };
    });

    srv.on('rotateAgentGrantToken', async (req: Request) => {
        if (!checkGrantAdminRate(req)) return;
        const userId = requireUserId(req);
        if (!userId) return;
        const { grantId } = req.data as { grantId?: string };
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

    srv.on('getGrantUsage', async (req: Request) => {
        const userId = requireUserId(req);
        if (!userId) return;
        const data = req.data as { grantId?: string; since?: string; until?: string };
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

        // Revoked grants keep their history: the lookup is owner-scoped only.
        const grant: AgentGrantRow | null = await runWithoutAmbientTx(() => db.run(
            SELECT.one.from(AgentGrants).where({ ID: data.grantId, userId })
        )) as AgentGrantRow | null;
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

        // Fees are known only where the crawler indexed the transactions.
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

/** The caller's own grant, active or revoked; null for a foreign or unknown id. */
async function loadOwnGrant(db: Runner, grantId: string, userId: string): Promise<AgentGrantRow | null> {
    return await runWithoutAmbientTx(() => db.run(
        SELECT.one.from(AgentGrants).where({ ID: grantId, userId })
    )) as AgentGrantRow | null;
}

/** Sum of the indexed fees (DUST atoms) of the given job `txHash`es, as a decimal string. */
async function sumIndexedFees(db: Runner, hashes: string[]): Promise<string> {
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

// ---- Enforcement ----------------------------------------------------------

/** The token-enforcement before-hook; register it first in the service init. */
export function attachAgentGrantEnforcement(srv: any, db: any): void {
    srv.before('*', (req: Request) => {
        // CAP runs before-handlers in parallel, so the principal swap (after an
        // awaited lookup) is published for owner-scoping hooks to await.
        const resolution = enforceAgentGrant(req, db);
        (req as any)[AGENT_PRINCIPAL_READY] = resolution.then(() => undefined, () => undefined);
        return resolution;
    });
}

const AGENT_PRINCIPAL_READY = Symbol.for('nightgate.agentPrincipalReady');

/**
 * Await the effective principal; every before-hook reading `req.user` calls this
 * first, since registration order does not sequence CAP's before-handlers.
 */
export async function awaitAgentPrincipal(req: Request): Promise<void> {
    const ready = (req as any)[AGENT_PRINCIPAL_READY];
    if (ready) await ready;
}

/** Exported for unit tests. */
export async function enforceAgentGrant(req: Request, db: any): Promise<unknown> {
    // `req.headers` merges a $batch envelope's headers into each part;
    // `_.req.headers` alone is only the synthetic part request.
    const token = (req as any)?.headers?.[AGENT_TOKEN_HEADER] ?? (req as any)?._?.req?.headers?.[AGENT_TOKEN_HEADER];
    if (!token || typeof token !== 'string') {
        // Transport markers admitted a request nobody authenticated here; they
        // must never reach a handler as a user.
        const uid = (req as any)?.user?.id;
        if (uid === AGENT_TOKEN_TRANSPORT_USER) {
            return req.reject(401, 'agent token required');
        }
        if (uid === PUBLIC_VERIFY_TRANSPORT_USER) {
            return req.reject(401, 'authentication required');
        }
        return; // normal principal path
    }

    if (!token.startsWith(TOKEN_PREFIX)) {
        return req.reject(401, 'invalid agent token');
    }
    const grant: AgentGrantRow | null = await runWithoutAmbientTx(() => db.run(
        SELECT.one.from(AgentGrants).where({ tokenHash: hashAgentToken(token), isActive: true })
    )) as AgentGrantRow | null;
    if (!grant) return req.reject(401, 'invalid agent token'); // non-leaking
    if (grantExpired(grant)) {
        return req.reject(410, 'agent grant expired');
    }

    const event = String((req as any).event ?? '');
    const alwaysAllowed = AGENT_ALWAYS_ALLOWED_EVENTS.has(event);
    // The handler's owner scoping alone would answer for every grant of the operator.
    if (event === 'getGrantUsage' && String((req as any).data?.grantId ?? '') !== grant.ID) {
        return req.reject(404, 'Grant not found');
    }
    let allowlisted = false;
    if (!alwaysAllowed) {
        let allowed: string[] = [];
        try { allowed = JSON.parse(grant.allowedActions || '[]'); } catch { /* treat as empty */ }
        allowlisted = Array.isArray(allowed) && allowed.includes(event);
        if (!allowlisted) {
            return req.reject(403, `action '${event}' is not allowed for this agent grant`);
        }
    }

    // A grant covers one session: user-scoped listings must not widen to the
    // whole operator. The owner-scoping hooks AND their userId filter on top.
    if (event === 'READ') {
        const target = String((req as any).target?.name ?? '');
        const entity = target.slice(target.lastIndexOf('.') + 1);
        if (!AGENT_READABLE_ENTITIES.has(entity)) {
            return req.reject(403, `entity '${entity}' is not readable with an agent token`);
        }
        const query: any = (req as any).query;
        if (query?.where) {
            if (entity === 'WalletSessions' || entity === 'PendingSubmissions' || entity === 'Documents') {
                query.where({ sessionId: grant.sessionId });
            } else if (entity === 'AgentGrants') {
                query.where({ ID: grant.ID });
            }
        }
    }

    // The sponsoring actions are checked on the transaction's shape in the worker.
    if (allowlisted && !SPONSOR_PHASE2_ACTIONS.has(event)) {
        const scope = grantScopeViolation(grant, (req as any).data, event);
        if (scope) return req.reject(403, scope);
    }

    const data = (req as any).data;
    if (data && typeof data === 'object' && event !== 'READ') {
        // Sponsoring jobs are keyed by the sponsor session, so only a
        // getJobStatus may name it; a write with it would act as the sponsor.
        const sponsorPoll = event === 'getJobStatus'
            && !!grant.sponsorSessionId
            && (data.sessionId === grant.sponsorSessionId
                || (grant.sponsorSessionId === PLATFORM_POOL_SENTINEL
                    && getConfiguredFeeSponsorSessions(getNightgatePluginConfig()).includes(String(data.sessionId ?? ''))));
        // Pool jobs are keyed under the sentinel, not the concrete member.
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

    // Detached from the request tx: the spend sticks when the request later
    // fails (over-counting failures rather than under-counting abuse).
    if (allowlisted && grant.maxJobsPerDay !== undefined && grant.maxJobsPerDay !== null) {
        const consumed = await consumeDailyBudget(db, grant);
        if (!consumed) {
            return req.reject(429, `agent grant daily job budget exhausted (${grant.maxJobsPerDay}/day)`);
        }
        // A 400..428 refusal admitted no job: refund. 429 and 5xx keep the unit.
        (req as any).on?.('failed', (err: any) => {
            const status = Number(err?.status ?? err?.statusCode ?? err?.code);
            if (Number.isInteger(status) && status >= 400 && status < 429) {
                void refundDailyBudget(db, grant).catch((e: unknown) => log.warn(`daily budget refund for grant ${grant.ID} failed: ${String((e as Error)?.message ?? e)}`));
            }
        });
    }

    const UserCtor = (cds as any).User;
    (req as any).user = UserCtor ? new UserCtor({ id: grant.userId }) : { id: grant.userId };
    (req as any).agentGrant = {
        ID: grant.ID, sessionId: grant.sessionId, userId: grant.userId,
        allowedContracts: parseGrantList(grant.allowedContracts),
        allowedCircuits: parseGrantList(grant.allowedCircuits),
        deployedContracts: parseGrantList(grant.deployedContracts),
        allowedTokenTypes: parseGrantList(grant.allowedTokenTypes),
        // Admission pre-check only; the lifetime budget is reserved per deploy
        // before the broadcast (reserveDeployBudget).
        allowDeploy: grant.allowDeploy === true && (grant.deploysUsed ?? 0) < (grant.maxDeploys ?? 1)
    };
}

/** Undo one consumeDailyBudget within the same UTC day. */
async function refundDailyBudget(db: any, grant: AgentGrantRow): Promise<void> {
    await runWithoutAmbientTx(() => db.run(
        UPDATE.entity(AgentGrants)
            .set({ jobsUsedToday: { '-=': 1 } })
            .where({ ID: grant.ID, budgetWindow: utcDay(), jobsUsedToday: { '>': 0 } })
    ));
}

/**
 * Consume one budget unit without overspend under concurrency: a window reset
 * that CASes on the old window, then a bounded increment.
 */
async function consumeDailyBudget(db: any, grant: AgentGrantRow): Promise<boolean> {
    const today = utcDay();
    const max = grant.maxJobsPerDay as number;

    if (grant.budgetWindow !== today) {
        const reset = await runWithoutAmbientTx(() => db.run(
            UPDATE.entity(AgentGrants)
                .set({ budgetWindow: today, jobsUsedToday: 1 })
                .where({ ID: grant.ID, budgetWindow: grant.budgetWindow ?? null })
        ));
        if (Number(reset)) return true;
        // Lost the reset race: another request already moved the window.
    }
    const incremented = await runWithoutAmbientTx(() => db.run(
        UPDATE.entity(AgentGrants)
            .set({ jobsUsedToday: { '+=': 1 } })
            .where({ ID: grant.ID, budgetWindow: today, jobsUsedToday: { '<': max } })
    ));
    return Number(incremented) > 0;
}
