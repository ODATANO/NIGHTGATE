/** srv/monitoring/event-loop.ts: the main thread's lag becomes a log line and a gauge. */

import { describe, it, expect, afterEach } from 'vitest';
import { startEventLoopWatch, eventLoopLagGauges, __resetEventLoopWatchForTests } from '../../srv/monitoring/event-loop';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const block = (ms: number) => { const end = Date.now() + ms; while (Date.now() < end) { /* hold the thread */ } };

afterEach(() => {
    __resetEventLoopWatchForTests();
    delete process.env.NIGHTGATE_EVENT_LOOP_LAG_WARN_MS;
});

describe('startEventLoopWatch', () => {
    it('logs a blocked thread with the pool depth and exposes the window as gauges', async () => {
        process.env.NIGHTGATE_EVENT_LOOP_LAG_WARN_MS = '50';
        const warnings: string[] = [];
        startEventLoopWatch({ log: { warn: m => warnings.push(m) }, poolGauges: () => ({ size: 20, borrowed: 20, pending: 7 }), windowMs: 200 });
        await sleep(40); // the sampler takes its first reading after one tick
        block(150);
        await sleep(120); // one window completes, the next (idle) one has not replaced it yet
        expect(eventLoopLagGauges().maxMs).toBeGreaterThanOrEqual(80);
        expect(warnings.length).toBeGreaterThanOrEqual(1);
        expect(warnings[0]).toMatch(/event loop lag p50=.* p99=.* max=.*ms/);
        expect(warnings[0]).toContain('db pool pending=7 borrowed=20/20');
    });

    it('stays quiet below the threshold and with the threshold off', async () => {
        process.env.NIGHTGATE_EVENT_LOOP_LAG_WARN_MS = '0';
        const warnings: string[] = [];
        startEventLoopWatch({ log: { warn: m => warnings.push(m) }, windowMs: 100 });
        await sleep(40);
        block(120);
        await sleep(250);
        expect(warnings).toEqual([]);
        expect(eventLoopLagGauges().maxMs).toBeGreaterThan(0);
    });
});
