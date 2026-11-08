// Keeps a lost or slow node connection in the crawler from shutting down the server. The crawler retries on its own.
// CAP ends the process on any unhandled fault, and adding a second listener cannot stop that.
// So this turns off CAP's shutdown switch before CAP reads it. Other faults still go to `cds.shutdown`.

import cds from '@sap/cds';
import { errorMessage } from '../utils/errors';
import { isNodeTransportError } from '../utils/retry';

const log = cds.log('nightgate:crawler');

type FaultEvent = 'unhandledRejection' | 'uncaughtException';

// A fault is ignored only if it looks like a connection error and its stack comes from the crawler or node provider.
// A TypeError in the crawler is a bug, and an ECONNRESET from the submission code must still shut down.

const CRAWLER_FRAME = /[/\\]srv[/\\](crawler|providers)[/\\]/;

let installed = false;
let delegates: {
    unhandledRejection?: NodeJS.UnhandledRejectionListener[];
    uncaughtException?: NodeJS.UncaughtExceptionListener[];
} = {};
let previousShutdownFlag: unknown;
let absorbed = 0;

// Ends the process the way CAP would. Listeners registered earlier, like error reporters, run first.
// Then `cds.shutdown` is called, unless one of those listeners already was `cds.shutdown`.
function shutDown<L>(event: FaultEvent, reason: unknown, captured: L[], call: (listener: L) => void): void {
    const shutdown = 'shutdown' in cds ? cds.shutdown : undefined;
    let alreadyShutDown = false;

    for (const listener of captured) {
        if (typeof shutdown === 'function' && listener === shutdown) alreadyShutDown = true;
        // A listener that throws must not prevent the shutdown.
        try { call(listener); } catch { /* ignored, the shutdown follows */ }
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

function absorb(reason: unknown): boolean {
    if (!isCrawlerTransportFault(reason)) return false;
    absorbed++;
    const message = errorMessage(reason);
    log.warn(
        `crawler transport fault absorbed (${absorbed} since start): ${message}. ` +
        'The crawler retries on its own; the server stays up.'
    );
    return true;
}

function onUnhandledRejection(reason: unknown, promise: Promise<unknown>): void {
    if (absorb(reason)) return;
    shutDown('unhandledRejection', reason, delegates.unhandledRejection ?? [], listener => listener(reason, promise));
}

function onUncaughtException(error: Error, origin: NodeJS.UncaughtExceptionOrigin): void {
    if (absorb(error)) return;
    shutDown('uncaughtException', error, delegates.uncaughtException ?? [], listener => listener(error, origin));
}

/** Replaces the process fault listeners with this guard. Existing listeners still get the faults it does not ignore. */
export function installCrawlerFaultGuard(): void {
    if (installed) return;
    installed = true;

    // cds serve reads this flag when the server starts listening, which happens after this call.
    const server: { shutdown_on_uncaught_errors?: unknown } = cds.env.server ?? (cds.env.server = {});
    previousShutdownFlag = server.shutdown_on_uncaught_errors;
    server.shutdown_on_uncaught_errors = false;

    const rejections = process.listeners('unhandledRejection');
    for (const listener of rejections) process.removeListener('unhandledRejection', listener);
    const exceptions = process.listeners('uncaughtException');
    for (const listener of exceptions) process.removeListener('uncaughtException', listener);
    delegates = { unhandledRejection: rejections, uncaughtException: exceptions };

    process.on('unhandledRejection', onUnhandledRejection);
    process.on('uncaughtException', onUncaughtException);

    log.info('crawler fault guard installed: a node transport fault no longer shuts the server down');
}

/** For tests: restores the listeners that were in place before. */
export function uninstallCrawlerFaultGuard(): void {
    if (!installed) return;
    for (const listener of process.listeners('unhandledRejection')) process.removeListener('unhandledRejection', listener);
    for (const listener of delegates.unhandledRejection ?? []) process.on('unhandledRejection', listener);
    for (const listener of process.listeners('uncaughtException')) process.removeListener('uncaughtException', listener);
    for (const listener of delegates.uncaughtException ?? []) process.on('uncaughtException', listener);
    const server: { shutdown_on_uncaught_errors?: unknown } | undefined = cds.env.server;
    if (server) server.shutdown_on_uncaught_errors = previousShutdownFlag;
    delegates = {};
    installed = false;
    absorbed = 0;
}
