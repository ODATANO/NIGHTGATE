/**
 * Runtime gate: while the plugin's initialisation has not succeeded (never
 * ran, still running, or failed), every action that needs the wallet worker,
 * the node or the proof server is refused with a retryable 503. Accepting
 * it would fail later or leave half-written state (a wallet session row
 * without a facade to back it).
 *
 * Reads stay reachable: readiness, health, metrics, entity reads, status
 * functions and the compute-only actions listed below.
 */
import cds from '@sap/cds';
import type { Request } from '@sap/cds';
import { readRuntimeState, type RuntimeState } from './runtime-state';

/**
 * Actions that need no wallet worker, node or proof server: pure computation
 * over the caller's input or database-only bookkeeping. They stay reachable
 * while the runtime is down.
 */
export const RUNTIME_FREE_ACTIONS: ReadonlySet<string> = new Set([
    'prepareAnchorCommitment',
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
 * Why write actions are refused right now, or null when the runtime is up.
 * `idle` is only an outage when the process was expected to initialise:
 * with SKIP_AUTO_INIT the plugin was told not to run, so the surface serves
 * its database-backed reads and the caller wires its own runtime.
 */
export function runtimeUnavailableReason(state: RuntimeState = readRuntimeState()): string | null {
    // Same rule as readiness: initialised and not failed. A crawler-less start
    // stays in mode 'idle' after a SUCCESSFUL initialize(), so 'idle' alone
    // says nothing; only 'offline' means it failed.
    if (state.initialized && state.mode !== 'offline') return null;
    if (state.mode === 'offline') {
        // The startup error itself (paths, SQL, node URLs) stays in the log and
        // in the admin status; the caller learns only that the runtime failed.
        return 'Nightgate runtime is offline after a failed startup; write actions are refused until it restarts';
    }
    if (process.env.SKIP_AUTO_INIT === 'true') return null;
    return 'Nightgate runtime has not completed startup in this process; retry shortly';
}

/**
 * True for every event that changes state through the runtime: entity
 * writes and every unbound `action` of the service that is not in
 * RUNTIME_FREE_ACTIONS. Functions and reads are never gated.
 */
export function isRuntimeWriteEvent(srv: cds.ApplicationService, event: string): boolean {
    if (MUTATING_EVENTS.has(event)) return true;
    if (RUNTIME_FREE_ACTIONS.has(event)) return false;
    const definitions = ((srv as any).model?.definitions ?? (cds as any).model?.definitions ?? {}) as Record<string, { kind?: string } | undefined>;
    return definitions[`${srv.name}.${event}`]?.kind === 'action';
}

/**
 * Register the gate on a service. One hook for all write actions; the
 * refusal keeps its message in production (`$sanitize: false`, CAP strips
 * every 5xx message otherwise) and carries `Retry-After`.
 */
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
