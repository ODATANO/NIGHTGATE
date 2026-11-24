// The checks a service runs before a request. Write actions wait with a retryable 503 until NIGHTGATE has started,
// because accepting them earlier would leave half-written state. Reads are counted and bounded in time.
import cds from '@sap/cds';
import { isBackgroundFenced } from './instance-lease';
import { readRuntimeState, type RuntimeState } from './runtime-state';
import { checkRateClass } from './rate-classes';
import { configMs } from './config';
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

/** On PostgreSQL the database stops a statement of the running read after the time limit. The setting ends with the read's transaction. */
async function boundReadTime(): Promise<void> {
    const ms = Math.floor(configMs('NIGHTGATE_QUERY_TIMEOUT_MS'));
    if (ms <= 0 || !/postgres/i.test(String(cds.env.requires?.db?.kind ?? ''))) return;
    await cds.db.run(`SET LOCAL statement_timeout = ${ms}`);
}

/** Counts every entity read and each call of `functions` in the rate class `query`, and bounds the time of an entity read. */
export function attachReadLimits(srv: cds.ApplicationService, functions: readonly string[] = []): void {
    const counted = new Set<string>(['READ', ...functions]);
    srv.before('*', async (req: Request) => {
        const event = String(req.event ?? '');
        if (!counted.has(event)) return;
        // The key of the count is the caller's grant, which the token check sets.
        if (req.agentPrincipalReady) await req.agentPrincipalReady;
        if (!checkRateClass('query', 'query', req)) return;
        if (event === 'READ') await boundReadTime();
    });
}
