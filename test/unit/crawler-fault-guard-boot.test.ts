/**
 * The fault guard against a REAL CAP boot.
 *
 * The guard's subject is the environment, not its own branching: when CAP
 * registers its shutdown handlers, whether the switch it reads is still true,
 * what ends up on the process. A test that hand-registers listeners can only
 * confirm what it already assumes, so this one boots the server.
 *
 * The hook is registered BEFORE cds.test() so the order matches production:
 * served -> guard installs -> listening -> cds serve reads the switch.
 */

import cds from '@sap/cds';
import {
    installCrawlerFaultGuard, uninstallCrawlerFaultGuard, absorbedCrawlerFaults
} from '../../srv/crawler/crawler-fault-guard';

type FaultEvent = 'unhandledRejection' | 'uncaughtException';
const EVENTS: FaultEvent[] = ['unhandledRejection', 'uncaughtException'];

/**
 * The runner registers its own fault reporter. The guard would capture it and
 * hand it the deliberate defect below, failing the run for a fault the test
 * asked for; on a real boot there is no such reporter. Taken off before the
 * boot so it is not captured, put back afterwards.
 */
const runnerListeners: Record<string, Array<(...args: any[]) => void>> = {};
for (const event of EVENTS) {
    runnerListeners[event] = (process.listeners as any)(event) as Array<(...args: any[]) => void>;
    for (const listener of runnerListeners[event]) (process.removeListener as any)(event, listener);
}

cds.once('served', () => installCrawlerFaultGuard());
const cap = cds.test(__dirname + '/../..');

afterAll(() => {
    uninstallCrawlerFaultGuard();
    for (const event of EVENTS) {
        for (const listener of (process.listeners as any)(event)) (process.removeListener as any)(event, listener);
        for (const listener of runnerListeners[event]) (process.on as any)(event, listener);
    }
});

describe('crawler fault guard on a booted server', () => {
    it('keeps cds serve from registering its blanket shutdown', () => {
        // The guard turned the switch off during `served`; cds serve read it
        // when the server started listening and registered nothing.
        expect((cds.env as any).server.shutdown_on_uncaught_errors).toBe(false);

        const names = process.listeners('unhandledRejection').map(l => (l as any).name);
        expect(names).not.toContain('_shutdown');
        expect((cds as any).server?.listening).toBeTruthy();
    });

    it('absorbs a node transport fault without ending the process', () => {
        const before = absorbedCrawlerFaults();
        const calls: unknown[] = [];
        const previous = (cds as any).shutdown;
        (cds as any).shutdown = (reason: unknown) => calls.push(reason);
        try {
            const fault = new Error('RPC timeout: chain_getBlock (30000ms)');
            fault.stack = 'Error: RPC timeout: chain_getBlock (30000ms)\n'
                + '    at Timeout._onTimeout (/app/srv/providers/MidnightNodeProvider.js:185:28)';
            process.emit('unhandledRejection', fault, Promise.resolve() as any);

            expect(calls).toEqual([]);
            expect(absorbedCrawlerFaults()).toBe(before + 1);
        } finally {
            (cds as any).shutdown = previous;
        }
    });

    it('still ends the process on a fault that is not the transport', () => {
        const calls: unknown[] = [];
        const previous = (cds as any).shutdown;
        (cds as any).shutdown = (reason: unknown) => calls.push(reason);
        try {
            const bug = new TypeError('prep.height is not a function');
            bug.stack = 'TypeError: prep.height is not a function\n'
                + '    at run (/app/srv/crawler/Crawler.js:412:9)';
            process.emit('unhandledRejection', bug, Promise.resolve() as any);

            // Crawler frame, but a defect: it must reach the shutdown.
            expect(calls).toEqual([bug]);
        } finally {
            (cds as any).shutdown = previous;
        }
    });

    it('serves requests throughout, which is the point of absorbing at all', async () => {
        const { GET } = cap as any;
        const before = await GET('/api/v1/indexer/getLiveness()');
        expect(before.status).toBe(200);

        const fault = new Error('Not connected to Midnight Node');
        fault.stack = 'Error: Not connected to Midnight Node\n'
            + '    at rpc (/app/srv/providers/MidnightNodeProvider.js:223:19)';
        process.emit('unhandledRejection', fault, Promise.resolve() as any);

        const after = await GET('/api/v1/indexer/getLiveness()');
        expect(after.status).toBe(200);
    });
});
