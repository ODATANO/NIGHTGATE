/**
 * Until initialisation succeeded, write actions are refused with a retryable 503; accepting them would
 * leave half-written state (a session row without a facade). Reads and RUNTIME_FREE_ACTIONS stay reachable.
 */
import cds from '@sap/cds';
import type { Request } from '@sap/cds';
import { readRuntimeState, type RuntimeState } from './runtime-state';

/** Actions that need no worker, node or proof server (compute-only or database-only). */
export const RUNTIME_FREE_ACTIONS: ReadonlySet<string> = new Set([
    'prepareDocumentProof',
    'prepareMembershipSet',
    'deriveWalletInfo',
    'getJobStatus',
    'registerGranteeIdentity',
    'createAgentGrant',
    'revokeAgentGrant',
    'disconnectWallet'
]);

const MUTATING_EVENTS: ReadonlySet<string> = new Set(['CREATE', 'UPDATE', 'DELETE', 'UPSERT']);

/** Seconds in the `Retry-After` header of a runtime refusal. */
export const RUNTIME_RETRY_AFTER_SECONDS = 15;

export const RUNTIME_UNAVAILABLE_CODE = 'RUNTIME_UNAVAILABLE';

/**
 * Why write actions are refused, or null when the runtime is up. Under SKIP_AUTO_INIT the caller
 * wires its own runtime, so an uninitialised process is not an outage.
 */
export function runtimeUnavailableReason(state: RuntimeState = readRuntimeState()): string | null {
    // A crawler-less start stays 'idle' after a successful init; only 'offline' means failed.
    if (state.initialized && state.mode !== 'offline') return null;
    if (state.mode === 'offline') {
        // The startup error stays in the log and admin status, never in the response.
        return 'Nightgate runtime is offline after a failed startup; write actions are refused until it restarts';
    }
    if (process.env.SKIP_AUTO_INIT === 'true') return null;
    return 'Nightgate runtime has not completed startup in this process; retry shortly';
}

/** Entity writes and service actions outside RUNTIME_FREE_ACTIONS; functions and reads are never gated. */
export function isRuntimeWriteEvent(srv: cds.ApplicationService, event: string): boolean {
    if (MUTATING_EVENTS.has(event)) return true;
    if (RUNTIME_FREE_ACTIONS.has(event)) return false;
    const definitions = ((srv as any).model?.definitions ?? (cds as any).model?.definitions ?? {}) as Record<string, { kind?: string } | undefined>;
    return definitions[`${srv.name}.${event}`]?.kind === 'action';
}

/** Register the gate; `$sanitize: false` keeps the 503 message in production, where CAP strips 5xx messages. */
export function attachRuntimeGate(srv: cds.ApplicationService): void {
    srv.before('*', (req: Request) => {
        const event = String((req as any).event ?? '');
        if (!isRuntimeWriteEvent(srv, event)) return;
        const reason = runtimeUnavailableReason();
        if (!reason) return;
        try { (req as any).http?.res?.set?.('Retry-After', String(RUNTIME_RETRY_AFTER_SECONDS)); } catch { /* courtesy header */ }
        return req.reject({ status: 503, code: RUNTIME_UNAVAILABLE_CODE, message: reason, $sanitize: false } as any);
    });
}
