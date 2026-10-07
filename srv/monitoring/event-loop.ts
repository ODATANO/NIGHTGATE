/**
 * Watches the main thread's event-loop delay. A saturated thread shows up here before the healthcheck fails.
 * The gauges hold the last completed window, so one scrape never sees a half-filled histogram.
 */

import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';
import { configMs } from '../utils/config';

export const EVENT_LOOP_WINDOW_MS = 30_000;

export interface EventLoopLagGauges {
    p50Ms: number;
    p99Ms: number;
    maxMs: number;
}

interface EventLoopWatchDeps {
    log: { warn: (message: string) => void };
    /** Pool gauges for the log line, e.g. `() => dbPoolGauges(cds.db)`. */
    poolGauges?: () => { size: number; borrowed: number; pending: number } | null;
    /** Test seam; defaults to `EVENT_LOOP_WINDOW_MS`. */
    windowMs?: number;
}

let histogram: IntervalHistogram | null = null;
let timer: NodeJS.Timeout | null = null;
let lastWindow: EventLoopLagGauges = { p50Ms: 0, p99Ms: 0, maxMs: 0 };

const toMs = (nanos: number): number => Math.round(nanos / 1e4) / 100;

/** Starts the watch. Calling it again replaces the previous one. */
export function startEventLoopWatch(deps: EventLoopWatchDeps): void {
    stopEventLoopWatch();
    histogram = monitorEventLoopDelay({ resolution: 20 });
    histogram.enable();
    const warnAboveMs = configMs('NIGHTGATE_EVENT_LOOP_LAG_WARN_MS');
    timer = setInterval(() => {
        if (!histogram) return;
        lastWindow = {
            p50Ms: toMs(histogram.percentile(50)),
            p99Ms: toMs(histogram.percentile(99)),
            maxMs: toMs(histogram.max)
        };
        histogram.reset();
        if (warnAboveMs > 0 && lastWindow.p99Ms >= warnAboveMs) {
            const pool = deps.poolGauges?.() ?? null;
            const poolText = pool ? `; db pool pending=${pool.pending} borrowed=${pool.borrowed}/${pool.size}` : '';
            deps.log.warn(`event loop lag p50=${lastWindow.p50Ms}ms p99=${lastWindow.p99Ms}ms max=${lastWindow.maxMs}ms over the last ${Math.round((deps.windowMs ?? EVENT_LOOP_WINDOW_MS) / 1000)} s${poolText}`);
        }
    }, deps.windowMs ?? EVENT_LOOP_WINDOW_MS);
    timer.unref();
}

export function stopEventLoopWatch(): void {
    if (timer) clearInterval(timer);
    timer = null;
    histogram?.disable();
    histogram = null;
}

/** The last completed window. Zeros before the first window or when the watch is off. */
export function eventLoopLagGauges(): EventLoopLagGauges {
    return lastWindow;
}

export function __resetEventLoopWatchForTests(): void {
    stopEventLoopWatch();
    lastWindow = { p50Ms: 0, p99Ms: 0, maxMs: 0 };
}
