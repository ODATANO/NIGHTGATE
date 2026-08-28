/**
 * Sample the CURRENT thread's V8 isolate for `seconds` with the in-thread
 * inspector, while the thread keeps running its event loop, and return the
 * summary (`cpu-profile-summary.ts`) plus heap and GC figures for the same
 * window. Used by the worker's `cpuProfile` RPC and by the admin action for
 * the main thread. The raw profile is written under `dir` for DevTools.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import v8 from 'node:v8';
import { PerformanceObserver } from 'node:perf_hooks';
import { summarizeCpuProfile, type CpuProfileSummary } from './cpu-profile-summary';

export interface HeapFigures {
    usedMb: number;
    totalMb: number;
    limitMb: number;
    externalMb: number;
    mallocedMb: number;
    rssMb: number;
    arrayBuffersMb: number;
}

export interface GcFigures {
    count: number;
    totalMs: number;
    /** perf_hooks GC kinds: minor (scavenge), major (mark-compact), incremental, weakcb. */
    byKind: Record<string, { count: number; ms: number }>;
}

export interface ThreadProfile extends CpuProfileSummary {
    seconds: number;
    file: string | null;
    heapBefore: HeapFigures;
    heapAfter: HeapFigures;
    gc: GcFigures;
}

const MB = 1024 * 1024;
export function heapFigures(): HeapFigures {
    const h = v8.getHeapStatistics();
    const m = process.memoryUsage();
    return {
        usedMb: Math.round(h.used_heap_size / MB),
        totalMb: Math.round(h.total_heap_size / MB),
        limitMb: Math.round(h.heap_size_limit / MB),
        externalMb: Math.round(h.external_memory / MB),
        mallocedMb: Math.round(h.malloced_memory / MB),
        rssMb: Math.round(m.rss / MB),
        arrayBuffersMb: Math.round(m.arrayBuffers / MB)
    };
}

const GC_KIND: Record<number, string> = { 1: 'minor', 2: 'major', 4: 'incremental', 8: 'weakcb', 16: 'major-snapshot' };

export async function profileCurrentThread(seconds: number, opts: { dir?: string; filePrefix?: string; top?: number } = {}): Promise<ThreadProfile> {
    const secs = Math.min(120, Math.max(1, Math.floor(Number(seconds) || 20)));
    const inspector = await import('node:inspector');
    const session = new inspector.Session();
    session.connect();
    const post = (m: string, p?: object) => new Promise<any>((res, rej) => (session as any).post(m, p ?? {}, (e: Error | null, r: unknown) => e ? rej(e) : res(r)));
    const gc: GcFigures = { count: 0, totalMs: 0, byKind: {} };
    const observer = new PerformanceObserver(list => {
        for (const e of list.getEntries()) {
            const kind = GC_KIND[(e as any).detail?.kind ?? (e as any).kind ?? 0] ?? 'other';
            gc.count++; gc.totalMs += e.duration;
            const k = (gc.byKind[kind] ??= { count: 0, ms: 0 });
            k.count++; k.ms += e.duration;
        }
    });
    const heapBefore = heapFigures();
    try {
        observer.observe({ entryTypes: ['gc'] });
        await post('Profiler.enable');
        await post('Profiler.setSamplingInterval', { interval: 1000 });
        await post('Profiler.start');
        await new Promise(r => setTimeout(r, secs * 1000));
        const { profile } = await post('Profiler.stop');
        observer.disconnect();
        const heapAfter = heapFigures();
        const summary = summarizeCpuProfile(profile, opts.top ?? 25);
        let file: string | null = null;
        try {
            const outDir = opts.dir || path.join(os.tmpdir(), 'nightgate-profiles');
            fs.mkdirSync(outDir, { recursive: true });
            file = path.join(outDir, `${opts.filePrefix ?? 'thread'}-${new Date().toISOString().replace(/[:.]/g, '-')}-${secs}s.cpuprofile`);
            fs.writeFileSync(file, JSON.stringify(profile));
        } catch { file = null; }
        gc.totalMs = Math.round(gc.totalMs);
        for (const k of Object.values(gc.byKind)) k.ms = Math.round(k.ms);
        return { seconds: secs, file, heapBefore, heapAfter, gc, ...summary };
    } finally {
        try { observer.disconnect(); } catch { /* already */ }
        try { session.disconnect(); } catch { /* already gone */ }
    }
}
