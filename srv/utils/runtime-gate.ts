// The checks a service runs before a request. Write actions wait with a retryable 503 until NIGHTGATE has started,
// because accepting them earlier would leave half-written state. Reads are counted and bounded in time.
import cds from '@sap/cds';
import { isBackgroundFenced } from './instance-lease';
import { readRuntimeState, type RuntimeState } from './runtime-state';
import { checkRateClass, rejectRateLimited } from './rate-classes';
import { principalRateKey } from './rate-limiter';
import { configMs, configNumber } from './config';
import type { Request } from '@sap/cds';

/** Actions that only compute or use the database. They need no wallet worker, node or proof server. */
export const RUNTIME_FREE_ACTIONS: ReadonlySet<string> = new Set([
    'prepareDocumentProof',
    'prepareMembershipSet',
    'deriveWalletInfo',
    'getJobStatus',
    'registerGranteeIdentity',
    'createAgentGrant',
    'createAgentGrants',
    'updateAgentGrant',
    'rotateAgentGrantToken',
    'revokeAgentGrant',
    'disconnectWallet'
]);

const MUTATING_EVENTS: ReadonlySet<string> = new Set(['CREATE', 'UPDATE', 'DELETE', 'UPSERT']);

export const RUNTIME_RETRY_AFTER_SECONDS = 15;

export const RUNTIME_UNAVAILABLE_CODE = 'RUNTIME_UNAVAILABLE';

/** Why write actions are refused, or null when they are allowed.
 *  With SKIP_AUTO_INIT the caller starts things itself, so "not started" is not an error. */
export function runtimeUnavailableReason(state: RuntimeState = readRuntimeState()): string | null {
    if (isBackgroundFenced()) {
        return 'this process lost the database instance lease to another NIGHTGATE process; write actions are refused until it restarts';
    }
    // Without the crawler the mode stays 'idle' after a successful start. Only 'offline' means failure.
    if (state.initialized && state.mode !== 'offline') return null;
    if (state.mode === 'offline') {
        // The startup error goes to the log and the admin status, never into the response.
        return 'Nightgate runtime is offline after a failed startup; write actions are refused until it restarts';
    }
    if (process.env.SKIP_AUTO_INIT === 'true') return null;
    return 'Nightgate runtime has not completed startup in this process; retry shortly';
}

/** True for entity writes and for actions not listed in RUNTIME_FREE_ACTIONS. Reads and functions are never blocked. */
export function isRuntimeWriteEvent(srv: cds.ApplicationService, event: string): boolean {
    if (MUTATING_EVENTS.has(event)) return true;
    if (RUNTIME_FREE_ACTIONS.has(event)) return false;
    const definitions: Record<string, { kind?: string } | undefined> = srv.model?.definitions ?? cds.model?.definitions ?? {};
    return definitions[`${srv.name}.${event}`]?.kind === 'action';
}

/** Registers the check. `$sanitize: false` keeps the 503 message, which CAP would otherwise hide in production. */
export function attachRuntimeGate(srv: cds.ApplicationService): void {
    srv.before('*', (req: Request) => {
        const event = String(req.event ?? '');
        if (!isRuntimeWriteEvent(srv, event)) return;
        const reason = runtimeUnavailableReason();
        if (!reason) return;
        try { req.http?.res?.set?.('Retry-After', String(RUNTIME_RETRY_AFTER_SECONDS)); } catch { /* the header is optional */ }
        const error = { status: 503, code: RUNTIME_UNAVAILABLE_CODE, message: reason, $sanitize: false };
        return req.reject(error);
    });
}

/** On PostgreSQL the database stops a statement of the running read after the time limit. The setting ends with its transaction. */
async function boundReadTime(): Promise<void> {
    const ms = Math.floor(configMs('NIGHTGATE_QUERY_TIMEOUT_MS'));
    if (ms <= 0 || !/postgres/i.test(String(cds.env.requires?.db?.kind ?? ''))) return;
    await cds.db.run(`SET LOCAL statement_timeout = ${ms}`);
}

const runningReads = new Map<string, number>();

/** Holds one of the caller's concurrent reads until the request's transaction ends. False after a 429. */
function holdReadSlot(req: Request): boolean {
    const key = principalRateKey(req, 'query');
    const limit = configNumber('NIGHTGATE_QUERY_CONCURRENCY');
    const running = runningReads.get(key) ?? 0;
    if (running >= limit) {
        rejectRateLimited(req, { name: 'query', limit, windowSeconds: 1, retryAfterMs: 1000, detail: `query: ${limit} reads at the same time` });
        return false;
    }
    runningReads.set(key, running + 1);
    req.on('done', () => {
        const left = (runningReads.get(key) ?? 1) - 1;
        if (left > 0) runningReads.set(key, left);
        else runningReads.delete(key);
    });
    return true;
}

/** Counts every entity read and each call of `functions` and `untimed` in the rate class `query`.
 *  Entity reads and `functions` are bounded in time and in how many run at once. `untimed` reads outside the request's transaction. */
export function attachReadLimits(srv: cds.ApplicationService, functions: readonly string[] = [], untimed: readonly string[] = []): void {
    const timed = new Set<string>(['READ', ...functions]);
    srv.before('*', async (req: Request) => {
        const event = String(req.event ?? '');
        if (!timed.has(event) && !untimed.includes(event)) return;
        // The key of the count is the caller's grant, which the token check sets.
        if (req.agentPrincipalReady) await req.agentPrincipalReady;
        if (!checkRateClass('query', 'query', req)) return;
        if (!timed.has(event) || !holdReadSlot(req)) return;
        await boundReadTime();
    });
}

export function __resetRunningReadsForTests(): void {
    runningReads.clear();
}
