// Keeps a lost or slow node connection in the crawler from shutting down the server. The crawler retries on its own.
// CAP ends the process on any unhandled fault, and adding a second listener cannot stop that.
// So this turns off CAP's shutdown switch before CAP reads it. Other faults still go to `cds.shutdown`.

import cds from '@sap/cds';
import { errorMessage } from '../utils/errors';
import { isNodeTransportError } from '../utils/retry';

const log = cds.log('nightgate:crawler');

type FaultEvent = 'unhandledRejection' | 'uncaughtException';
const EVENTS: FaultEvent[] = ['unhandledRejection', 'uncaughtException'];

// A fault is ignored only if it looks like a connection error and its stack comes from the crawler or node provider.
// A TypeError in the crawler is a bug, and an ECONNRESET from the submission code must still shut down.

const CRAWLER_FRAME = /[/\\]srv[/\\](crawler|providers)[/\\]/;

let installed = false;
let delegates: Partial<Record<FaultEvent, Array<(...args: any[]) => void>>> = {};
let previousShutdownFlag: unknown;
let absorbed = 0;

// Ends the process the way CAP would. Listeners registered earlier, like error reporters, run first.
// Then `cds.shutdown` is called, unless one of those listeners already was `cds.shutdown`.
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
    return isNodeTransportError(reason) && CRAWLER_FRAME.test(reason.stack ?? '');
}

/** Replaces the process fault listeners with this guard. Existing listeners still get the faults it does not ignore. */
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
                const message = errorMessage(reason);
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
