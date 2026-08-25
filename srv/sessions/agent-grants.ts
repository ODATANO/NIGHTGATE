/**
 * Agent grants: scoped machine capabilities over a wallet session
 * (agent-access-layer FR, workstream 2 / phase B).
 *
 * Two exports wired up in nightgate-service.ts:
 *   - `registerAgentGrantHandlers`: createAgentGrant / revokeAgentGrant.
 *   - `attachAgentGrantEnforcement`: a before('*') hook that turns an
 *     `x-agent-token` header into a restricted principal. It must be
 *     registered BEFORE all other before-hooks so the effective user is
 *     already the grant's operator when owner-scoping hooks read it.
 *
 * Model (see docs/feature-requests/agent-access-layer.md): the token is a
 * bearer capability, NOT an identity. On-chain authority stays the session
 * wallet; the grant only restricts. Transport authentication remains the
 * host app's concern; the token authorizes and scopes WITHIN the service,
 * and a valid token replaces the transport principal with the operator's
 * userId so every existing `userId` gate keeps working unchanged.
 *
 * Enforcement ladder for token-carrying requests:
 *   1. token resolves to an active grant (401 otherwise, non-leaking)
 *   2. grant not expired (410)
 *   3. event allowed: read-only verify surface + getJobStatus always;
 *      write actions only when allow-listed (403); everything else 403
 *      (wallet lifecycle, sends, deploys, grant admin are not grantable)
 *   4. sessionId / sponsorSessionId pinned to the grant (403 on mismatch,
 *      injected when absent; a sponsor-bound agent MUST run sponsored).
 *      One exception: getJobStatus may name the grant's PINNED sponsor
 *      session, because phase-2 sponsoring jobs are keyed by it
 *   5. daily write-job budget consumed via atomic conditional UPDATE (429
 *      when exhausted). Detached from the request tx on purpose: budget
 *      spend must stick even when the request later fails, which
 *      over-counts failed requests rather than under-counting abuse.
 */

import cds from '@sap/cds';
import type { Request } from '@sap/cds';
import crypto from 'crypto';
import { AgentGrants, WalletSessions } from '#cds-models/midnight';
import { RateLimiter } from '../utils/rate-limiter';
import { PLATFORM_POOL_SENTINEL } from '../submission/sponsor-pool';
import { getConfiguredFeeSponsorSessions } from '../submission/fee-sponsor';
import { runWithoutAmbientTx } from '../submission/background-jobs';
import { resolveFeeSponsor, FeeSponsorError } from '../submission/fee-sponsor';
import { getNightgatePluginConfig } from '../utils/nightgate-config';
import { isSessionExpired } from '../utils/session-expiry';

const { SELECT, INSERT, UPDATE } = cds.ql;

const log = cds.log('nightgate:agent-grants');

export const AGENT_TOKEN_HEADER = 'x-agent-token';
const TOKEN_PREFIX = 'ngat_';
const TOKEN_BYTES = 32;

/**
 * Write actions an operator MAY put on a grant's allowlist. Everything not
 * in this set and not in AGENT_ALWAYS_ALLOWED_EVENTS is a hard 403 for
 * token requests: wallet lifecycle, sends, deploys, passport/identity
 * registration and grant administration are never grantable.
 */
export const AGENT_ALLOWLISTABLE_ACTIONS: readonly string[] = [
    'anchorDocument',
    'commitDocumentAnchor',
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
    // Cross-server fee sponsoring, phase 2 (0.17.0): the transaction arrives
    // PROVEN and SIGNED, so the grant spends nothing but the sponsor's dust,
    // which is exactly what sponsor pinning + the daily budget meter. The
    // on-chain effect carries the BUILDER's identity, not the session's.
    // The unbound (parallel, 0.18) channel has the identical trust shape.
    'sponsorFinalizedTransaction',
    'sponsorUnboundTransaction'
];

/** The phase-2 sponsoring actions: keyed by the SPONSOR session, pool-aware. */
export const SPONSOR_PHASE2_ACTIONS: ReadonlySet<string> = new Set([
    'sponsorFinalizedTransaction',
    'sponsorUnboundTransaction'
]);

/**
 * Events every valid token may use without an allowlist entry and without
 * consuming budget: the read-only verify surface, entity READs (already
 * owner-scoped downstream) and job polling.
 */
export const AGENT_ALWAYS_ALLOWED_EVENTS: ReadonlySet<string> = new Set([
    'READ',
    'verifyDocument',
    'verifyAttestationState',
    'verifyPredicateState',
    'verifyPredicateAttestation',
    'prepareDocumentProof', // compute-only, no chain write, no session needed
    'prepareAnchorCommitment', // compute-only (commit-reveal phase 0)
    'prepareMembershipSet', // compute-only (canonical set tree)
    'deriveTokenType', // compute-only (token identity from address + separator)
    'getJobStatus'
    // NOT getSponsorPoolStatus. It looked harmless ("let a pinned agent see
    // whether its sponsor can still pay"), but the enforcement hook below
    // replaces the principal with the grant's OPERATOR, so any token, however
    // minimal and whatever session it is bound to, would read the pool status
    // of every sponsor session that operator owns, exact balances included.
    // That is precisely the boundary a grant exists to draw.
]);

const grantAdminRateLimiter = new RateLimiter({ windowMs: 60 * 60 * 1000, maxRequests: 10 });

interface AgentGrantRow {
    ID: string;
    userId: string;
    sessionId: string;
    allowedActions: string;
    maxJobsPerDay?: number | null;
    jobsUsedToday?: number | null;
    budgetWindow?: string | null;
    sponsorSessionId?: string | null;
    validUntil?: string | null;
    isActive?: boolean;
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

export function registerAgentGrantHandlers(srv: any, db: any): void {
    srv.on('createAgentGrant', async (req: Request) => {
        const clientKey = (req as any)?._.req?.ip || 'global';
        const rate = grantAdminRateLimiter.check(clientKey);
        if (!rate.allowed) {
            return req.reject(429, `Rate limited. Retry after ${Math.ceil(rate.retryAfterMs / 1000)}s`);
        }
        // Token requests cannot mint grants: createAgentGrant is neither
        // always-allowed nor allow-listable, so enforcement already 403s.
        const userId = requireUserId(req);
        if (!userId) return;

        const data = req.data as {
            sessionId?: string;
            allowedActions?: string[];
            maxJobsPerDay?: number | null;
            sponsorSessionId?: string | null;
            validUntil?: string | null;
            agentLabel?: string | null;
        };

        if (!data.sessionId) return req.reject(400, 'sessionId is required');
        const actions = data.allowedActions;
        if (!Array.isArray(actions) || actions.length === 0) {
            return req.reject(400, 'allowedActions must be a non-empty array');
        }
        const unknown = actions.filter(a => !AGENT_ALLOWLISTABLE_ACTIONS.includes(a));
        if (unknown.length > 0) {
            return req.reject(400,
                `allowedActions contains non-grantable entries: ${unknown.join(', ')}. ` +
                `Grantable: ${AGENT_ALLOWLISTABLE_ACTIONS.join(', ')}`);
        }
        if (data.maxJobsPerDay !== undefined && data.maxJobsPerDay !== null) {
            if (!Number.isInteger(data.maxJobsPerDay) || data.maxJobsPerDay < 1) {
                return req.reject(400, 'maxJobsPerDay must be a positive integer');
            }
        }
        if (data.validUntil) {
            const t = new Date(data.validUntil);
            if (Number.isNaN(t.getTime())) return req.reject(400, 'validUntil must be a valid ISO-8601 timestamp');
            if (t.getTime() <= Date.now()) return req.reject(400, 'validUntil must be in the future');
        }
        if (data.agentLabel && data.agentLabel.length > 100) {
            return req.reject(400, 'agentLabel must be at most 100 characters');
        }

        // The session the grant acts through must be the caller's own, active
        // and not expired. Detached read: no request tx held across it.
        const session: any = await runWithoutAmbientTx(() => db.run(
            SELECT.one.from(WalletSessions).where({ sessionId: data.sessionId, isActive: true, userId })
        ));
        if (!session) return req.reject(404, 'Session not found or inactive');
        // Shared rule (srv/utils/session-expiry.ts): a configured platform fee
        // sponsor is infrastructure and does not expire while configured, so a
        // grant may be issued through one.
        if (isSessionExpired(data.sessionId, session.expiresAt)) {
            return req.reject(410, 'Session expired');
        }

        // The sponsor binding is permanent and injected into every write, so a
        // dead sponsor would make the grant unusable AFTER burning budget.
        // Validate at creation with the SAME resolution every sponsored write
        // runs (platform-listed or caller-owned, active, unexpired, signing
        // key present, decryptable). Use-time re-resolution stays in place:
        // this cannot guarantee the sponsor outlives the grant.
        if (data.sponsorSessionId === PLATFORM_POOL_SENTINEL) {
            // Pool grant (0.17.2): the concrete sponsor is chosen per job with
            // failover. Valid only when a platform pool is configured; there
            // is no single session to validate here, the per-use resolution
            // stays in place. ONLY the phase-2 sponsoring actions understand
            // the sentinel: it would be injected into every other allow-listed
            // write and fail AFTER burning daily budget, so restrict the
            // action set at creation.
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
            validUntil: data.validUntil ?? null,
            isActive: true
        };
        await db.run(INSERT.into(AgentGrants).entries(grant));
        log.info(`agent grant ${grant.ID} created for session ${String(data.sessionId).slice(0, 8)}… ` +
            `(actions: ${actions.join(', ')}${grant.maxJobsPerDay ? `, budget ${grant.maxJobsPerDay}/day` : ''})`);

        return { grantId: grant.ID, token, allowedActions: actions, validUntil: grant.validUntil };
    });

    srv.on('revokeAgentGrant', async (req: Request) => {
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
}

// ---- Enforcement ----------------------------------------------------------

/**
 * Register the token-enforcement before-hook. MUST be the first registration
 * in the service init so the principal override precedes every owner-scoping
 * before-hook.
 */
export function attachAgentGrantEnforcement(srv: any, db: any): void {
    srv.before('*', (req: Request) => enforceAgentGrant(req, db));
}

/** Exported for unit tests; see module doc for the enforcement ladder. */
export async function enforceAgentGrant(req: Request, db: any): Promise<unknown> {
    const token = (req as any)?._?.req?.headers?.[AGENT_TOKEN_HEADER];
    if (!token || typeof token !== 'string') return; // normal principal path

    if (!token.startsWith(TOKEN_PREFIX)) {
        return req.reject(401, 'invalid agent token');
    }
    const grant: AgentGrantRow | null = await runWithoutAmbientTx(() => db.run(
        SELECT.one.from(AgentGrants).where({ tokenHash: hashAgentToken(token), isActive: true })
    )) as AgentGrantRow | null;
    if (!grant) return req.reject(401, 'invalid agent token'); // non-leaking
    if (grant.validUntil && new Date(grant.validUntil) < new Date()) {
        return req.reject(410, 'agent grant expired');
    }

    const event = String((req as any).event ?? '');
    const alwaysAllowed = AGENT_ALWAYS_ALLOWED_EVENTS.has(event);
    let allowlisted = false;
    if (!alwaysAllowed) {
        let allowed: string[] = [];
        try { allowed = JSON.parse(grant.allowedActions || '[]'); } catch { /* treat as empty */ }
        allowlisted = Array.isArray(allowed) && allowed.includes(event);
        if (!allowlisted) {
            return req.reject(403, `action '${event}' is not allowed for this agent grant`);
        }
    }

    // READ narrowing: a grant is scoped to ONE session, so listing surfaces
    // that are merely user-scoped downstream must not widen to the whole
    // operator. WalletSessions/PendingSubmissions collapse to the grant's
    // session, AgentGrants to the grant itself; chain-derived entities
    // (blocks, transactions, documents, ...) stay readable as-is. The
    // owner-scoping before-hooks add their userId filter on top (ANDed).
    if (event === 'READ') {
        const target = String((req as any).target?.name ?? '');
        const query: any = (req as any).query;
        if (query?.where) {
            if (target.endsWith('.WalletSessions') || target.endsWith('.PendingSubmissions')) {
                query.where({ sessionId: grant.sessionId });
            } else if (target.endsWith('.AgentGrants')) {
                query.where({ ID: grant.ID });
            }
        }
    }

    // Bind the request to the grant's session (and sponsor, when pinned).
    const data = (req as any).data;
    if (data && typeof data === 'object' && event !== 'READ') {
        // Phase-2 sponsoring jobs (sponsorFinalizedTransaction /
        // sponsorUnboundTransaction) are keyed by
        // the SPONSOR session, so polling them is the ONE place the grant's
        // pinned sponsor session is a valid job scope. Only getJobStatus:
        // a write with the sponsor session as sessionId would act under the
        // sponsor's identity and must keep failing.
        const sponsorPoll = event === 'getJobStatus'
            && !!grant.sponsorSessionId
            && (data.sessionId === grant.sponsorSessionId
                || (grant.sponsorSessionId === PLATFORM_POOL_SENTINEL
                    && getConfiguredFeeSponsorSessions(getNightgatePluginConfig()).includes(String(data.sessionId ?? ''))));
        // Pool jobs are KEYED under the sentinel; a poll naming a concrete
        // pool member would pass this gate and then 404 in getJobStatus.
        // Normalize to the sentinel after the membership check.
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
        }
    }

    // Daily write-job budget, atomic + detached (see module doc).
    if (allowlisted && grant.maxJobsPerDay !== undefined && grant.maxJobsPerDay !== null) {
        const consumed = await consumeDailyBudget(db, grant);
        if (!consumed) {
            return req.reject(429, `agent grant daily job budget exhausted (${grant.maxJobsPerDay}/day)`);
        }
    }

    // Effective principal: the operator. All existing userId gates now apply.
    const UserCtor = (cds as any).User;
    (req as any).user = UserCtor ? new UserCtor({ id: grant.userId }) : { id: grant.userId };
    (req as any).agentGrant = { ID: grant.ID, sessionId: grant.sessionId, userId: grant.userId };
}

/**
 * Consume one unit of the grant's daily budget. Two conditional UPDATEs so
 * concurrent requests cannot overspend: a window reset (compare-and-swap on
 * the OLD window value) and a bounded increment (`jobsUsedToday < max`).
 * Both run detached; whichever statement reports an affected row wins.
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
