/**
 * Keeps a crawler transport fault from taking the server down with it.
 *
 * CAP registers `process.on('unhandledRejection', shutdown)` and the same for
 * `uncaughtException`, so ANY unhandled rejection ends the process. The crawler
 * talks to a node that is sometimes slow or incomplete, and it already answers
 * that with retries, a re-queue, a poison latch and `syncStatus: 'error'`. A
 * timeout there is an operating condition, not a reason to drop the submission
 * side: every restart costs each sponsor facade its warm-up.
 *
 * Node calls every listener, so a second listener cannot outvote CAP's, and
 * CAP registers its own only once the server starts listening, which is after
 * the hook this is installed from. Capturing them is therefore not possible.
 * The policy is taken over instead: CAP's blanket switch is turned off before
 * it is read, and this handler decides. A node transport fault is logged and
 * counted; everything else goes to `cds.shutdown`, the same function CAP would
 * have registered.
 */

import cds from '@sap/cds';

const log = cds.log('nightgate:crawler');

type FaultEvent = 'unhandledRejection' | 'uncaughtException';
const EVENTS: FaultEvent[] = ['unhandledRejection', 'uncaughtException'];

/**
 * A fault this guard absorbs. BOTH signals are required: the message has to
 * read like the node transport AND the stack has to come from the crawler or
 * its provider. Either alone is too wide: a TypeError thrown inside the
 * crawler is a defect, not a transport fault, and an ECONNRESET can just as
 * well come from the submission side, which must keep shutting down.
 */
const TRANSPORT_MESSAGE = /RPC timeout|Not connected to Midnight Node|Connection closed|WebSocket closed|socket hang up|ECONNRESET|ECONNREFUSED|ETIMEDOUT/i;
const CRAWLER_FRAME = /[/\\]srv[/\\](crawler|providers)[/\\]/;

let installed = false;
let delegates: Partial<Record<FaultEvent, Array<(...args: any[]) => void>>> = {};
let previousShutdownFlag: unknown;
let absorbed = 0;

/**
 * Ends the process the way CAP would have, and lets anything that was already
 * listening see the fault first.
 *
 * A captured listener is not assumed to end anything: error reporters register
 * here too, and CAP's own handler is off. So the reporters run, and then
 * `cds.shutdown` is called anyway, unless one of them WAS `cds.shutdown` (a
 * late install, where CAP had already registered) and has ended it already.
 */
function shutDown(event: FaultEvent, reason: unknown, rest: unknown[]): void {
    const captured = delegates[event] ?? [];
    const shutdown = (cds as any).shutdown;
    let alreadyShutDown = false;

    for (const listener of captured) {
        if (typeof shutdown === 'function' && listener === shutdown) alreadyShutDown = true;
        // A reporter that throws must not cost the shutdown.
        try { listener(reason, ...rest); } catch { /* reported best-effort */ }
    }
    if (alreadyShutDown) return;

    if (typeof shutdown === 'function') {
        shutdown(reason);
        return;
    }
    log.error(`fatal ${event} with no shutdown handler: ${String(reason)}`);
    process.exit(1);
}

/** Faults absorbed since start; surfaced by getMetrics so this stays visible. */
export function absorbedCrawlerFaults(): number {
    return absorbed;
}

export function isCrawlerTransportFault(reason: unknown): boolean {
    if (!(reason instanceof Error)) return false;
    return TRANSPORT_MESSAGE.test(reason.message) && CRAWLER_FRAME.test(reason.stack ?? '');
}

/**
 * Takes over the process-level fault listeners. Call it once the server is up,
 * so CAP's own listeners are registered and can be captured as the delegates.
 */
export function installCrawlerFaultGuard(): void {
    if (installed) return;
    installed = true;

    // Read by cds serve when the server starts listening, after this runs.
    const server: any = (cds.env as any).server ?? ((cds.env as any).server = {});
    previousShutdownFlag = server.shutdown_on_uncaught_errors;
    server.shutdown_on_uncaught_errors = false;

    for (const event of EVENTS) {
        delegates[event] = (process.listeners as any)(event) as Array<(...args: any[]) => void>;
        for (const listener of delegates[event]!) (process.removeListener as any)(event, listener);

        (process.on as any)(event, (reason: unknown, ...rest: unknown[]) => {
            if (isCrawlerTransportFault(reason)) {
                absorbed++;
                const message = reason instanceof Error ? reason.message : String(reason);
                log.warn(
                    `crawler transport fault absorbed (${absorbed} since start): ${message}. ` +
                    'The crawler retries on its own; the server stays up.'
                );
                return;
            }
            shutDown(event, reason, rest);
        });
    }

    log.info('crawler fault guard installed: a node transport fault no longer shuts the server down');
}

/** Test seam: restores the listeners that were in place before. */
export function uninstallCrawlerFaultGuard(): void {
    if (!installed) return;
    for (const event of EVENTS) {
        for (const listener of (process.listeners as any)(event)) (process.removeListener as any)(event, listener);
        for (const listener of delegates[event] ?? []) (process.on as any)(event, listener);
    }
    const server: any = (cds.env as any).server;
    if (server) server.shutdown_on_uncaught_errors = previousShutdownFlag;
    delegates = {};
    installed = false;
    absorbed = 0;
}
