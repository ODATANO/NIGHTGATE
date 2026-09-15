/**
 * Submit with separate connect / request (until first status) / watch deadlines: a timeout on
 * the SDK's single `submitTransaction` promise cannot tell whether the tx was ever sent.
 * Only a connect failure is known unsent; late statuses are logged under the identifier.
 */
import { log as workerLog } from './context';

export type SubmitPhase = 'connect' | 'request' | 'watch';

export interface SubmitTimelineEntry { at: number; event: string; detail?: string }

export type NodeSubmitEvent = {
    tag: 'Submitted' | 'InBlock' | 'Finalized' | string;
    txHash?: string;
    blockHash?: string;
    blockHeight?: string | number | bigint;
};

export type SocketEvent = { kind: 'connected' | 'disconnected' | 'error'; detail?: string };

/** The node side of a phased submit; the SDK wrapper and the test fake implement it. */
export interface SubmitNodeAdapter {
    /** Bring the socket up (idempotent); rejects when the adapter's own connect fails. */
    connect(): Promise<void>;
    /** Settles when the subscription ends: stream end (Finalized), node error, or `signal` abort. */
    send(bytes: Uint8Array, onEvent: (ev: NodeSubmitEvent) => void, signal: AbortSignal): Promise<void>;
    onSocket(cb: (ev: SocketEvent) => void): void;
    close(): Promise<void>;
}

export interface PhasedSubmitTimeouts {
    connectMs: number;
    requestMs: number;
    watchMs: number;
    /** Bound on `close()`: a client whose initialisation hangs must not hang the timeout handling itself. */
    closeMs: number;
    /** How long a timed-out attempt keeps its subscription open for a late status or reject (logged, never acted on). */
    lateGraceMs: number;
}

export interface SubmitContext {
    /** Ledger transaction identifier (what the job stores); the log key. */
    identifier?: string;
    /** Call site / job correlation. */
    correlation?: string;
}

export interface PhasedSubmitService {
    submitTransaction(tx: { serialize(): Uint8Array }, waitFor: 'InBlock' | 'Finalized', ctx?: SubmitContext): Promise<NodeSubmitEvent>;
    close(): Promise<void>;
}

export class SubmitPhaseError extends Error {
    readonly phase: SubmitPhase;
    readonly identifier: string;
    readonly timeline: readonly SubmitTimelineEntry[];
    readonly elapsedMs: number;
    constructor(phase: SubmitPhase, message: string, info: { identifier: string; timeline: readonly SubmitTimelineEntry[]; elapsedMs: number; cause?: unknown }) {
        super(message, info.cause !== undefined ? { cause: info.cause } : undefined);
        this.name = 'SubmitPhaseError';
        this.phase = phase;
        this.identifier = info.identifier;
        this.timeline = info.timeline;
        this.elapsedMs = info.elapsedMs;
    }
}

/** The phase of a failure, walking the cause chain; null when no phased submit was involved. */
export function submitPhaseOf(err: unknown): SubmitPhase | null {
    let cur: any = err;
    for (let depth = 0; cur && depth < 8; depth++) {
        if (cur?.name === 'SubmitPhaseError' && typeof cur.phase === 'string') return cur.phase as SubmitPhase;
        cur = cur.cause;
    }
    return null;
}

function formatTimeline(entries: readonly SubmitTimelineEntry[], t0: number): string {
    return entries.map((e) => `${e.event}@+${((e.at - t0) / 1000).toFixed(1)}s${e.detail ? `(${e.detail})` : ''}`).join(' ');
}

function describe(err: unknown): string {
    const parts: string[] = [];
    let cur: any = err;
    for (let depth = 0; cur && depth < 6; depth++) {
        parts.push(String(cur?.message ?? cur));
        cur = cur.cause;
    }
    return parts.join(' <- ').slice(0, 400);
}

export function createPhasedSubmitService(opts: {
    adapter: () => Promise<SubmitNodeAdapter>;
    timeouts: PhasedSubmitTimeouts;
    log?: (level: 'info' | 'warn' | 'debug', message: string) => void;
}): PhasedSubmitService {
    const log = opts.log ?? workerLog;
    let adapterP: Promise<SubmitNodeAdapter> | null = null;
    let socketLog: SubmitTimelineEntry[] | null = null; // the timeline of the attempt in flight, for socket events
    const getAdapter = (): Promise<SubmitNodeAdapter> => {
        if (!adapterP) {
            adapterP = opts.adapter().then((a) => {
                a.onSocket((ev) => socketLog?.push({ at: Date.now(), event: `socket-${ev.kind}`, detail: ev.detail }));
                return a;
            });
            adapterP.catch(() => { adapterP = null; }); // a failed creation is retried by the next attempt
        }
        return adapterP;
    };

    const submitTransaction = async (tx: { serialize(): Uint8Array }, waitFor: 'InBlock' | 'Finalized', ctx: SubmitContext = {}): Promise<NodeSubmitEvent> => {
        const identifier = ctx.identifier ?? '?';
        const site = ctx.correlation ?? 'submit';
        const key = `${site} ${identifier.slice(0, 16)}`;
        const timeline: SubmitTimelineEntry[] = [];
        const t0 = Date.now();
        const mark = (event: string, detail?: string) => timeline.push({ at: Date.now(), event, detail });
        socketLog = timeline;
        const fail = (phase: SubmitPhase, message: string, cause?: unknown): SubmitPhaseError =>
            new SubmitPhaseError(phase, `${message} [${key}: ${formatTimeline(timeline, t0)}]`, { identifier, timeline, elapsedMs: Date.now() - t0, cause });

        // connect: client creation + socket, one budget
        let adapter: SubmitNodeAdapter;
        try {
            adapter = await withTimeout(getAdapter().then(async (a) => { mark('client-ready'); await a.connect(); return a; }), opts.timeouts.connectMs);
            mark('connected');
        } catch (e) {
            const err = e instanceof PhaseTimeout
                ? fail('connect', `submit connect phase: no connection within ${opts.timeouts.connectMs}ms; nothing was sent`)
                : fail('connect', `submit connect phase failed; nothing was sent: ${describe(e)}`, e);
            log('warn', `submit-phases ${key} phase=connect FAILED after ${Date.now() - t0}ms: ${describe(e)}`);
            throw err;
        }

        // request + watch: one subscription, two deadlines
        const bytes = tx.serialize();
        const ac = new AbortController();
        let settled = false;
        let firstAt = 0;
        let last: NodeSubmitEvent | null = null;
        let resolveFirst!: () => void; let resolveWanted!: (ev: NodeSubmitEvent) => void;
        const first = new Promise<void>((r) => { resolveFirst = r; });
        const wanted = new Promise<NodeSubmitEvent>((r) => { resolveWanted = r; });
        const onEvent = (ev: NodeSubmitEvent) => {
            const detail = ev.tag === 'InBlock' || ev.tag === 'Finalized' ? `block ${ev.blockHeight ?? '?'}` : undefined;
            mark(`status-${ev.tag}`, detail);
            last = ev;
            if (!firstAt) { firstAt = Date.now(); resolveFirst(); }
            if (ev.tag === waitFor) resolveWanted(ev);
            if (settled && !ac.signal.aborted) log('warn', `submit-late ${key}: status ${ev.tag}${detail ? ` (${detail})` : ''} at +${((Date.now() - t0) / 1000).toFixed(1)}s, after the attempt had given up`);
        };
        mark('request-sent');
        const done = adapter.send(bytes, onEvent, ac.signal);
        // A subscription rejection ends the attempt in whichever phase it is in.
        const streamFailure = done.then(() => { throw new StreamEnded(); });
        streamFailure.catch(() => undefined); // must not surface as unhandled after the attempt settled
        const phaseLine = (phase: SubmitPhase, outcome: string) =>
            `submit-phases ${key} phase=${phase} ${outcome} connect=${timelineDur(timeline, t0, 'connected')} request=${firstAt ? `${firstAt - requestSentAt(timeline, t0)}ms` : 'n/a'} total=${Date.now() - t0}ms statuses=${formatTimeline(timeline.filter((e) => e.event.startsWith('status-') || e.event.startsWith('socket-')), t0) || 'none'}`;
        // A timed-out attempt keeps listening for `lateGraceMs` so a late outcome is logged.
        const keepListening = () => {
            const t = setTimeout(() => ac.abort(), opts.timeouts.lateGraceMs);
            t.unref?.();
            lateWindows.add(t);
            // Not `.finally()`: its derived promise would reject unhandled on a late reject.
            const clear = () => { clearTimeout(t); lateWindows.delete(t); };
            done.then(clear, clear);
        };
        try {
            try {
                await withTimeout(Promise.race([first, streamFailure]), opts.timeouts.requestMs);
            } catch (e) {
                if (e instanceof PhaseTimeout) {
                    keepListening();
                    log('warn', phaseLine('request', `FAILED: no status from the node within ${opts.timeouts.requestMs}ms after the send; listening ${opts.timeouts.lateGraceMs}ms more for a late answer`));
                    throw fail('request', `submit request phase: no status from the node within ${opts.timeouts.requestMs}ms after the send; the transaction may or may not have reached the pool`);
                }
                if (e instanceof StreamEnded) throw fail('request', `submit stream ended without any status`);
                log('warn', phaseLine('request', `FAILED: ${describe(e)}`));
                throw e; // the node's own answer, classified by its text
            }
            try {
                const ev = await withTimeout(Promise.race([wanted, streamFailure]), opts.timeouts.watchMs);
                settled = true;
                if (waitFor === 'InBlock') ac.abort(); // done watching: unsubscribe + disconnect
                log('info', phaseLine('watch', `OK ${waitFor} after ${Date.now() - firstAt}ms`));
                return ev;
            } catch (e) {
                if (e instanceof PhaseTimeout) {
                    keepListening();
                    log('warn', phaseLine('watch', `FAILED: no ${waitFor} within ${opts.timeouts.watchMs}ms of the first status; listening ${opts.timeouts.lateGraceMs}ms more for a late outcome`));
                    throw fail('watch', `submit watch timed out after ${opts.timeouts.watchMs}ms without a ${waitFor} status (the node acknowledged the request; last status ${(last as NodeSubmitEvent | null)?.tag ?? 'none'})`);
                }
                if (e instanceof StreamEnded) throw fail('watch', `submit stream ended before ${waitFor} (last status ${(last as NodeSubmitEvent | null)?.tag ?? 'none'})`);
                log('warn', phaseLine('watch', `FAILED: ${describe(e)}`));
                throw e;
            }
        } finally {
            settled = true;
            if (socketLog === timeline) socketLog = null;
            // Log the subscription's end after settle; our own abort is not a result.
            void done.then(
                () => { if (!ac.signal.aborted) log('info', `submit-late ${key}: subscription ended after the attempt settled (last status ${(last as NodeSubmitEvent | null)?.tag ?? 'none'})`); },
                (err) => { if (!ac.signal.aborted) log('warn', `submit-late ${key}: node reported after the attempt settled: ${describe(err)}`); }
            );
        }
    };

    // Timed-out attempts still listening; close() waits for them, bounded.
    const lateWindows = new Set<NodeJS.Timeout>();

    return {
        submitTransaction,
        async close() {
            const a = adapterP; adapterP = null;
            if (!a) return;
            const deadline = Date.now() + (lateWindows.size ? opts.timeouts.lateGraceMs : 0) + opts.timeouts.closeMs;
            while (lateWindows.size && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
            try { await withTimeout(a.then((x) => x.close()), opts.timeouts.closeMs); } catch { /* bounded, best effort */ }
        }
    };
}

class PhaseTimeout extends Error { constructor() { super('phase timeout'); this.name = 'PhaseTimeout'; } }
class StreamEnded extends Error { constructor() { super('stream ended'); this.name = 'StreamEnded'; } }

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const t = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new PhaseTimeout()), ms); });
    return Promise.race([p, t]).finally(() => { if (timer) clearTimeout(timer); }) as Promise<T>;
}

function requestSentAt(timeline: readonly SubmitTimelineEntry[], t0: number): number {
    return timeline.find((e) => e.event === 'request-sent')?.at ?? t0;
}
function timelineDur(timeline: readonly SubmitTimelineEntry[], t0: number, event: string): string {
    const at = timeline.find((e) => e.event === event)?.at;
    return at ? `${at - t0}ms` : 'n/a';
}

// The real adapter: the SDK's PolkadotNodeClient through its effect API.

export interface NodeClientSdk {
    PolkadotNodeClient: any;
    SerializedTransaction: any;
    Effect: any; Scope: any; Exit: any; Stream: any; Duration: any;
}

export async function createSdkNodeAdapter(relayURL: URL, opts: { connectTimeoutMs: number; sdk: () => Promise<NodeClientSdk> }): Promise<SubmitNodeAdapter> {
    const { PolkadotNodeClient, SerializedTransaction, Effect, Scope, Exit, Stream, Duration } = await opts.sdk();
    const scope = Effect.runSync(Scope.make());
    // The SDK's default reconnection budget is infinite; the connect phase
    // needs a bound, and this is the only place the SDK takes one.
    const client: any = await Effect.runPromise(
        PolkadotNodeClient.make({ nodeURL: relayURL, reconnectionTimeout: Duration.millis(opts.connectTimeoutMs) })
            .pipe(Effect.provideService(Scope.Scope, scope))
    );
    const listeners: Array<(ev: SocketEvent) => void> = [];
    const api: any = client.api;
    for (const kind of ['connected', 'disconnected', 'error'] as const) {
        api?.on?.(kind, (arg: unknown) => {
            const ev: SocketEvent = { kind, detail: kind === 'error' ? String((arg as any)?.message ?? arg).slice(0, 200) : undefined };
            for (const l of listeners) l(ev);
        });
    }
    return {
        connect: () => Effect.runPromise(client.ensureConnection()),
        send: (bytes, onEvent, signal) => Effect.runPromise(
            Stream.runForEach(
                client.sendMidnightTransaction(SerializedTransaction.of(bytes)),
                (ev: any) => Effect.sync(() => onEvent({ tag: ev?._tag, txHash: ev?.txHash, blockHash: ev?.blockHash, blockHeight: ev?.blockHeight }))
            ),
            { signal }
        ),
        onSocket: (cb) => { listeners.push(cb); },
        close: () => Effect.runPromise(Scope.close(scope, Exit.void))
    };
}
