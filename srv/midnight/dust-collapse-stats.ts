/**
 * Cost of the dust snapshot collapse per wallet, as the wallet worker reports it with every save tick.
 * Kept on the main thread for `getMetrics()`. This module does not import `@sap/cds`, so the
 * worker can import the sample type.
 */

export type DustCollapseOutcome = 'collapsed' | 'uncollapsed' | 'skipped';

export interface DustCollapseSample {
    outcome: DustCollapseOutcome;
    /** Whole dust part of the tick: serialize, collapse and the verification wait. */
    ms: number;
    /** The verification alone. Null when it did not run. */
    verifyMs: number | null;
    fullBytes: number | null;
    bytes: number | null;
    at: string;
}

export interface DustCollapseStats {
    last: DustCollapseSample;
    p99Ms: number;
    runs: Record<DustCollapseOutcome, number>;
}

const SAMPLES_KEPT = 100;

interface Entry {
    last: DustCollapseSample;
    recentMs: number[];
    runs: Record<DustCollapseOutcome, number>;
}

const entries = new Map<string, Entry>();

export function recordDustCollapseSample(sessionId: string, sample: DustCollapseSample): void {
    let entry = entries.get(sessionId);
    if (!entry) {
        entry = { last: sample, recentMs: [], runs: { collapsed: 0, uncollapsed: 0, skipped: 0 } };
        entries.set(sessionId, entry);
    }
    entry.last = sample;
    entry.runs[sample.outcome] = (entry.runs[sample.outcome] ?? 0) + 1;
    // A skipped tick costs nothing and would only pull the percentile down.
    if (sample.outcome !== 'skipped') {
        entry.recentMs.push(sample.ms);
        if (entry.recentMs.length > SAMPLES_KEPT) entry.recentMs.shift();
    }
}

export function forgetDustCollapseStats(sessionId: string): void {
    entries.delete(sessionId);
}

export function dustCollapseStats(): Map<string, DustCollapseStats> {
    const out = new Map<string, DustCollapseStats>();
    for (const [sessionId, entry] of entries) {
        out.set(sessionId, { last: entry.last, p99Ms: percentile(entry.recentMs, 0.99), runs: { ...entry.runs } });
    }
    return out;
}

function percentile(values: number[], q: number): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
}

export function __resetDustCollapseStatsForTests(): void {
    entries.clear();
}
