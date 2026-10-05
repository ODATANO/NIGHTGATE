/**
 * Keeps a lost or slow node connection in the crawler from shutting down the whole server.
 *
 * By default CAP ends the process on any unhandled rejection or uncaught exception.
 * The crawler already handles node timeouts with its own retries.
 * A restart would also cost every sponsor wallet its long warm-up.
 *
 * CAP's own handler cannot be overruled by adding a second one, because Node calls all listeners.
 * So this module turns off CAP's shutdown switch before CAP reads it and installs its own handler.
 * Node connection faults from the crawler are logged and counted.
 * Every other fault still goes to `cds.shutdown`, as CAP would have done.
 */

import cds from '@sap/cds';

const log = cds.log('nightgate:crawler');

type FaultEvent = 'unhandledRejection' | 'uncaughtException';
const EVENTS: FaultEvent[] = ['unhandledRejection', 'uncaughtException'];

/**
 * A fault is ignored only if the message looks like a connection error AND the stack comes from the crawler or node provider.
 * A TypeError inside the crawler is a bug, and an ECONNRESET from the submission code must still shut down.
 */
const TRANSPORT_MESSAGE = /RPC timeout|Not connected to Midnight Node|Connection closed|WebSocket closed|socket hang up|ECONNRESET|ECONNREFUSED|ETIMEDOUT/i;
const CRAWLER_FRAME = /[/\\]srv[/\\](crawler|providers)[/\\]/;

let installed = false;
let delegates: Partial<Record<FaultEvent, Array<(...args: any[]) => void>>> = {};
let previousShutdownFlag: unknown;
let absorbed = 0;

/**
 * Ends the process the way CAP would have.
 * The listeners that were registered before run first, for example error reporters.
 * Then `cds.shutdown` is called, unless one of those listeners already was `cds.shutdown`.
 */
function shutDown(event: FaultEvent, reason: unknown, rest: unknown[]): void {
    const captured = delegates[event] ?? [];
    const shutdown = (cds as any).shutdown;
    let alreadyShutDown = false;

    for (const listener of captured) {
        if (typeof shutdown === 'function' && listener === shutdown) alreadyShutDown = true;
        // A listener that throws must not prevent the shutdown.
        try { listener(reason, ...rest); } catch { /* ignored, the shutdown follows */ }
    }
    if (alreadyShutDown) return;

    if (typeof shutdown === 'function') {
        shutdown(reason);
        return;
    }
    log.error(`fatal ${event} with no shutdown handler: ${String(reason)}`);
    process.exit(1);
}

/** Number of ignored crawler faults since start. Reported by getMetrics. */
export function absorbedCrawlerFaults(): number {
    return absorbed;
}

export function isCrawlerTransportFault(reason: unknown): boolean {
    if (!(reason instanceof Error)) return false;
    return TRANSPORT_MESSAGE.test(reason.message) && CRAWLER_FRAME.test(reason.stack ?? '');
}

/**
 * Replaces the process-level fault listeners with this guard.
 * Listeners that already exist are kept and called for faults the guard does not ignore.
 */
export function installCrawlerFaultGuard(): void {
    if (installed) return;
    installed = true;

    // cds serve reads this flag when the server starts listening, which happens after this call.
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

/** For tests: restores the listeners that were in place before. */
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
