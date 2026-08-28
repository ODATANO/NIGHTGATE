/**
 * Summarises a V8 CPU profile (the `Profiler.stop` payload / a .cpuprofile
 * file) into what an operator needs from `profileWorker`: where the worker
 * thread's time went, by function and by file, without shipping megabytes
 * of raw samples over OData. Pure; the raw profile is kept on disk for a
 * DevTools deep dive.
 */
export interface CpuProfileLike {
    nodes: Array<{ id: number; callFrame: { functionName: string; url: string; lineNumber: number }; children?: number[] }>;
    samples: number[];
    timeDeltas: number[];
    startTime?: number;
    endTime?: number;
}

export interface CpuProfileSummary {
    sampledMs: number;
    idlePercent: number;
    gcPercent: number;
    wasmPercent: number;
    /** Self time by function: `functionName  file:line`, share of the sampled window. */
    topFunctions: Array<{ label: string; percent: number }>;
    /** Self time by file (or native bucket). */
    topFiles: Array<{ label: string; percent: number }>;
    /** Inclusive time (a sample counts once per distinct frame on its stack). */
    topInclusive: Array<{ label: string; percent: number }>;
}

function shortUrl(url: string): string {
    return url
        .replace(/^file:\/\/\/?.*?node_modules\//, 'nm/')
        .replace(/^file:\/\/\/?.*?[\\/]NIGHTGATE[\\/]/, '')
        .replace(/^.*?node_modules[\\/]/, 'nm/');
}

export function summarizeCpuProfile(profile: CpuProfileLike, top = 20): CpuProfileSummary {
    const nodes = new Map(profile.nodes.map(n => [n.id, n]));
    const parent = new Map<number, number>();
    for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
    const self = new Map<number, number>();
    let total = 0;
    for (let i = 0; i < profile.samples.length; i++) {
        const dt = profile.timeDeltas[i] ?? 0;
        total += dt;
        self.set(profile.samples[i], (self.get(profile.samples[i]) ?? 0) + dt);
    }
    const label = (id: number) => {
        const f = nodes.get(id)!.callFrame;
        const url = shortUrl(f.url || '');
        return `${f.functionName || '(anon)'}  ${url}${f.lineNumber >= 0 ? ':' + (f.lineNumber + 1) : ''}`.trim();
    };
    const fileOf = (id: number) => {
        const f = nodes.get(id)!.callFrame;
        return f.url ? shortUrl(f.url) : `(native/${f.functionName || 'anon'})`;
    };
    const byFn = new Map<string, number>(), byFile = new Map<string, number>(), incl = new Map<string, number>();
    let idle = 0, gc = 0, wasm = 0;
    for (const [id, us] of self) {
        const n = nodes.get(id)!;
        const name = n.callFrame.functionName;
        if (name === '(idle)') idle += us;
        else if (name === '(garbage collector)') gc += us;
        if ((n.callFrame.url || '').startsWith('wasm://')) wasm += us;
        byFn.set(label(id), (byFn.get(label(id)) ?? 0) + us);
        byFile.set(fileOf(id), (byFile.get(fileOf(id)) ?? 0) + us);
        const seen = new Set<string>();
        let cur: number | undefined = id;
        while (cur !== undefined) {
            const l = label(cur);
            if (!seen.has(l)) { seen.add(l); incl.set(l, (incl.get(l) ?? 0) + us); }
            cur = parent.get(cur);
        }
    }
    const pct = (us: number) => total > 0 ? Math.round(us / total * 1000) / 10 : 0;
    const rank = (m: Map<string, number>, n: number, skip: RegExp | null = null) =>
        [...m].filter(([l]) => !skip || !skip.test(l)).sort((a, b) => b[1] - a[1]).slice(0, n).map(([l, us]) => ({ label: l, percent: pct(us) }));
    return {
        sampledMs: Math.round(total / 1000),
        idlePercent: pct(idle),
        gcPercent: pct(gc),
        wasmPercent: pct(wasm),
        topFunctions: rank(byFn, top),
        topFiles: rank(byFile, Math.min(top, 12)),
        topInclusive: rank(incl, top, /^\((root|program|idle|garbage collector)\)/)
    };
}
