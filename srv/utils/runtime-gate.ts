/**
 * Refuses write actions with a retryable 503 until the plugin has started successfully.
 * Accepting them earlier would leave half-written state. Reads stay available.
 */
import cds from '@sap/cds';
import { isBackgroundFenced } from './instance-lease';
import { readRuntimeState, type RuntimeState } from './runtime-state';
import type { Request } from '@sap/cds';

/** Actions that only compute or use the database. They need no wallet worker, node or proof server. */
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

export const RUNTIME_RETRY_AFTER_SECONDS = 15;

export const RUNTIME_UNAVAILABLE_CODE = 'RUNTIME_UNAVAILABLE';

/**
 * Why write actions are refused, or null when they are allowed.
 * With SKIP_AUTO_INIT the caller starts things itself, so "not started" is not an error.
 */
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
    const definitions = ((srv as any).model?.definitions ?? (cds as any).model?.definitions ?? {}) as Record<string, { kind?: string } | undefined>;
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
        return req.reject({ status: 503, code: RUNTIME_UNAVAILABLE_CODE, message: reason, $sanitize: false } as any);
    });
}
