/**
 * Tests for srv/crawler/crawler-fault-guard.ts.
 *
 * The guard takes over the process-level fault listeners, so every test
 * installs it against a stand-in for CAP's shutdown and removes it again.
 * What matters most is the second half: a fault that is NOT the crawler's
 * transport still reaches the shutdown it would have reached before.
 */

import cds from '@sap/cds';
import {
    installCrawlerFaultGuard, uninstallCrawlerFaultGuard,
    isCrawlerTransportFault, absorbedCrawlerFaults
} from '../../srv/crawler/crawler-fault-guard';

/** Stands in for the listener CAP registers. */
let shutdownCalls: unknown[];
let capShutdown: (reason: unknown) => void;
type FaultEvent = 'unhandledRejection' | 'uncaughtException';
const EVENTS: FaultEvent[] = ['unhandledRejection', 'uncaughtException'];
let outerListeners: Record<string, Array<(...args: any[]) => void>>;

beforeEach(() => {
    // The stand-in must be the ONLY delegate: the guard hands a foreign fault
    // to whatever it replaced, and the runner's own listener would report it.
    outerListeners = {};
    for (const event of EVENTS) {
        outerListeners[event] = (process.listeners as any)(event) as Array<(...args: any[]) => void>;
        for (const listener of outerListeners[event]) (process.removeListener as any)(event, listener);
    }
    shutdownCalls = [];
    capShutdown = (reason: unknown) => shutdownCalls.push(reason);
    for (const event of EVENTS) (process.on as any)(event, capShutdown);
});

afterEach(() => {
    uninstallCrawlerFaultGuard();
    for (const event of EVENTS) {
        (process.removeListener as any)(event, capShutdown);
        for (const listener of outerListeners[event]) (process.on as any)(event, listener);
    }
});

/** The shape the provider's timeout actually has: message plus its own frame. */
/** Transport wording carried on a frame from the crawler's provider. */
function withCrawlerFrame(message: string): Error {
    const err = new Error(message);
    err.stack = `Error: ${message}
    at rpc (/app/srv/providers/MidnightNodeProvider.js:231:20)`;
    return err;
}

function transportTimeout(): Error {
    const err = new Error('RPC timeout: chain_getBlockHash (30000ms)');
    err.stack = 'Error: RPC timeout: chain_getBlockHash (30000ms)\n'
        + '    at Timeout._onTimeout (/app/srv/providers/MidnightNodeProvider.js:185:28)\n'
        + '    at listOnTimeout (node:internal/timers:585:17)';
    return err;
}

describe('isCrawlerTransportFault', () => {
    it('recognises the provider vocabulary', () => {
        for (const message of [
            'RPC timeout: chain_getBlock (30000ms)',
            'Not connected to Midnight Node',
            'Connection closed',
            'WebSocket closed before connection established to ws://node',
            'socket hang up',
            'ECONNRESET'
        ]) {
            expect(isCrawlerTransportFault(withCrawlerFrame(message)), message).toBe(true);
            // The same wording without the crawler's frame is somebody else's.
            expect(isCrawlerTransportFault(new Error(message)), message).toBe(false);
        }
    });

    it('needs the frame as well as the message', () => {
        // Transport wording, but from the submission side.
        const foreign = new Error('ECONNRESET');
        foreign.stack = 'Error: ECONNRESET\n    at post (/app/srv/submission/handlers.js:40:3)';
        expect(isCrawlerTransportFault(foreign)).toBe(false);

        // Crawler frame, but a defect rather than a transport fault.
        const defect = new TypeError('prep.height is not a function');
        defect.stack = 'TypeError: prep.height is not a function\n    at run (/app/srv/crawler/Crawler.js:412:9)';
        expect(isCrawlerTransportFault(defect)).toBe(false);

        expect(isCrawlerTransportFault(transportTimeout())).toBe(true);
    });

    it('does not claim faults from elsewhere', () => {
        expect(isCrawlerTransportFault(new Error('Cannot read properties of undefined'))).toBe(false);
        expect(isCrawlerTransportFault(new TypeError('x is not a function'))).toBe(false);
        const dbErr = new Error('insert failed');
        dbErr.stack = 'Error: insert failed\n    at Object.run (/app/srv/submission/handlers.js:88:5)';
        expect(isCrawlerTransportFault(dbErr)).toBe(false);
        expect(isCrawlerTransportFault(null)).toBe(false);
        expect(isCrawlerTransportFault('RPC timeout: a bare string')).toBe(false);
    });
});

describe('installCrawlerFaultGuard', () => {
    it('absorbs a transport fault instead of shutting down, and counts it', () => {
        installCrawlerFaultGuard();
        process.emit('unhandledRejection', transportTimeout(), Promise.resolve() as any);

        expect(shutdownCalls).toEqual([]);
        expect(absorbedCrawlerFaults()).toBe(1);
    });

    /** The point of scoping it: a real bug must still be fatal. */
    it('hands every other fault to the listener it replaced, and shuts down', () => {
        installCrawlerFaultGuard();
        const calls: unknown[] = [];
        const previous = (cds as any).shutdown;
        (cds as any).shutdown = (reason: unknown) => calls.push(reason);
        try {
            const bug = new TypeError('handler is not a function');
            process.emit('unhandledRejection', bug, Promise.resolve() as any);

            expect(shutdownCalls).toEqual([bug]);
            expect(calls).toEqual([bug]);
            expect(absorbedCrawlerFaults()).toBe(0);
        } finally {
            (cds as any).shutdown = previous;
        }
    });

    it('covers uncaughtException on the same terms', () => {
        installCrawlerFaultGuard();
        const calls: unknown[] = [];
        const previous = (cds as any).shutdown;
        (cds as any).shutdown = (reason: unknown) => calls.push(reason);
        try {
            process.emit('uncaughtException', transportTimeout());
            expect(shutdownCalls).toEqual([]);
            expect(calls).toEqual([]);

            const bug = new RangeError('out of range');
            process.emit('uncaughtException', bug);
            expect(shutdownCalls).toEqual([bug]);
            expect(calls).toEqual([bug]);
        } finally {
            (cds as any).shutdown = previous;
        }
    });

    it('installs once, however often it is called', () => {
        installCrawlerFaultGuard();
        installCrawlerFaultGuard();
        process.emit('unhandledRejection', transportTimeout(), Promise.resolve() as any);
        // Twice would mean the guard wrapped itself.
        expect(absorbedCrawlerFaults()).toBe(1);
    });

    /**
     * cds serve registers its shutdown listeners when the server starts
     * listening, after this guard is installed, so they cannot be captured.
     * The switch it reads has to be off by then, or both handlers run and the
     * process ends anyway.
     */
    it('turns off the switch cds serve reads before it reads it', () => {
        const server: any = (cds.env as any).server ?? ((cds.env as any).server = {});
        server.shutdown_on_uncaught_errors = true;
        installCrawlerFaultGuard();
        expect(server.shutdown_on_uncaught_errors).toBe(false);
        uninstallCrawlerFaultGuard();
        expect(server.shutdown_on_uncaught_errors).toBe(true);
    });

    it('ends the process through cds.shutdown when nothing was captured', () => {
        // Nothing registered before: the case on a real boot.
        process.removeListener('unhandledRejection', capShutdown);
        process.removeListener('uncaughtException', capShutdown);
        installCrawlerFaultGuard();

        const calls: unknown[] = [];
        const previous = (cds as any).shutdown;
        (cds as any).shutdown = (reason: unknown) => calls.push(reason);
        try {
            const bug = new TypeError('handler is not a function');
            process.emit('unhandledRejection', bug, Promise.resolve() as any);
            expect(calls).toEqual([bug]);

            // A transport fault still does not reach it.
            process.emit('unhandledRejection', transportTimeout(), Promise.resolve() as any);
            expect(calls).toHaveLength(1);
        } finally {
            (cds as any).shutdown = previous;
            for (const event of EVENTS) (process.on as any)(event, capShutdown);
        }
    });

    /**
     * Error reporters register on these events too. They do not end anything,
     * and CAP's own handler is off, so a defect would leave the server up in
     * an unknown state if a captured listener were taken for a shutdown.
     */
    it('still shuts down when the captured listener only reports', () => {
        const reported: unknown[] = [];
        const reporter = (reason: unknown) => { reported.push(reason); };
        (process.on as any)('unhandledRejection', reporter);
        installCrawlerFaultGuard();

        const calls: unknown[] = [];
        const previous = (cds as any).shutdown;
        (cds as any).shutdown = (reason: unknown) => calls.push(reason);
        try {
            const bug = new TypeError('handler is not a function');
            process.emit('unhandledRejection', bug, Promise.resolve() as any);
            expect(reported).toEqual([bug]);
            expect(calls).toEqual([bug]);
        } finally {
            (cds as any).shutdown = previous;
            process.removeListener('unhandledRejection', reporter);
        }
    });

    it('does not shut down twice when the captured listener IS cds.shutdown', () => {
        const calls: unknown[] = [];
        const previous = (cds as any).shutdown;
        const shutdown = (reason: unknown) => calls.push(reason);
        (cds as any).shutdown = shutdown;
        // A late install, where cds serve had already registered its handler.
        (process.on as any)('unhandledRejection', shutdown);
        installCrawlerFaultGuard();
        try {
            const bug = new TypeError('handler is not a function');
            process.emit('unhandledRejection', bug, Promise.resolve() as any);
            expect(calls).toEqual([bug]);
        } finally {
            (cds as any).shutdown = previous;
            process.removeListener('unhandledRejection', shutdown);
        }
    });

    it('shuts down even when a reporter throws', () => {
        const angry = () => { throw new Error('reporter exploded'); };
        (process.on as any)('unhandledRejection', angry);
        installCrawlerFaultGuard();

        const calls: unknown[] = [];
        const previous = (cds as any).shutdown;
        (cds as any).shutdown = (reason: unknown) => calls.push(reason);
        try {
            const bug = new TypeError('handler is not a function');
            process.emit('unhandledRejection', bug, Promise.resolve() as any);
            expect(calls).toEqual([bug]);
        } finally {
            (cds as any).shutdown = previous;
            process.removeListener('unhandledRejection', angry);
        }
    });

    it('puts the original listeners back when removed', () => {
        installCrawlerFaultGuard();
        uninstallCrawlerFaultGuard();
        const fault = transportTimeout();
        process.emit('unhandledRejection', fault, Promise.resolve() as any);
        // Guard gone: the listener sees even a transport fault again.
        expect(shutdownCalls).toEqual([fault]);
    });
});
