/**
 * The calling side of a helper worker thread: lazy start, one message channel per call,
 * a timeout per call, restart on the next call after a crash.
 * This module does not import `@sap/cds`, because the wallet worker uses it too.
 */

import { Worker, MessageChannel, type MessagePort } from 'node:worker_threads';
import { nightgateErrorFromPayload } from '../../utils/errors';
import { formatErr } from '../../utils/format-error';
import type { WorkerRpcReply, WorkerRpcStarted } from './dispatch';

export type WorkerRpcLogLevel = 'info' | 'warn' | 'error' | 'debug';

export interface WorkerRpcClientOptions {
    /** Short name for log lines and error messages. */
    name: string;
    /** Path of the compiled worker entry. */
    entry: string;
    /** Built when the worker starts, so a restart sees the current value. */
    workerData?: () => unknown;
    log: (level: WorkerRpcLogLevel, message: string) => void;
    /** Read per call. */
    timeoutMs: () => number;
    /**
     * Counts the timeout from the moment the worker begins the call, not from the send.
     * A call waiting behind others is then not charged for the queue.
     */
    budgetFromStart?: boolean;
    /**
     * Ends the worker when a call runs past its timeout, so a stuck call does not hold the
     * thread for the calls behind it. Calls the worker had not begun are sent again to the
     * restarted worker once. Off, a timed-out call keeps running in the worker.
     */
    terminateOnTimeout?: boolean;
    /** For a worker that must never keep its owning thread alive. */
    unref?: boolean;
}

export interface WorkerRpcStatus {
    running: boolean;
    inFlightRpcs: number;
    /** Crashes since process start. A planned stop does not count. */
    exitCount: number;
    lastExitCode: number | null;
    lastExitAt: string | null;
}

interface ClientState {
    worker: Worker;
    ready: Promise<void>;
}

interface PendingRpc {
    method: string;
    args: unknown;
    /** The worker that holds this call, once sent. */
    sentTo: Worker | null;
    /** The worker reported that it began the call. */
    started: boolean;
    /** Sent again after a restart. Once, so a call cannot bounce forever. */
    resent: boolean;
    port: MessagePort | null;
    timer: ReturnType<typeof setTimeout> | null;
    settle: (outcome: () => void) => void;
}

export class WorkerRpcClient {
    private client: ClientState | null = null;
    private stoppingWorker: Worker | null = null;
    /** The worker ended for a timed-out call. Its unstarted calls move to the next worker. */
    private restartingWorker: Worker | null = null;
    private exitCount = 0;
    private lastExitCode: number | null = null;
    private lastExitAt: string | null = null;
    private readonly pendingRpcs = new Set<PendingRpc>();

    constructor(private readonly options: WorkerRpcClientOptions) {}

    status(): WorkerRpcStatus {
        return {
            running: this.client !== null,
            inFlightRpcs: this.pendingRpcs.size,
            exitCount: this.exitCount,
            lastExitCode: this.lastExitCode,
            lastExitAt: this.lastExitAt
        };
    }

    async start(): Promise<void> {
        if (this.client) {
            await this.client.ready;
            return;
        }
        const { name, log } = this.options;
        const worker = new Worker(this.options.entry, {
            workerData: this.options.workerData?.(),
            stdout: false,
            stderr: false
        });
        if (this.options.unref) worker.unref();
        const ready = new Promise<void>((resolve, reject) => {
            const onMessage = (msg: { kind?: string }): void => {
                if (msg?.kind === 'ready') { cleanup(); resolve(); }
            };
            const onError = (err: Error): void => { cleanup(); reject(err); };
            const onExit = (code: number): void => { cleanup(); reject(new Error(`${name} exited with code ${code} before it was ready`)); };
            const cleanup = (): void => {
                worker.off('message', onMessage);
                worker.off('error', onError);
                worker.off('exit', onExit);
            };
            worker.on('message', onMessage);
            worker.on('error', onError);
            worker.on('exit', onExit);
        });
        const state: ClientState = { worker, ready };
        this.client = state;

        worker.on('message', (msg: { kind?: string; level?: string; message?: string }) => {
            if (msg?.kind !== 'log') return;
            const level = msg.level === 'warn' || msg.level === 'error' || msg.level === 'debug' ? msg.level : 'info';
            log(level, `[${name}] ${msg.message}`);
        });
        worker.on('error', (err) => {
            log('error', `${name} error: ${formatErr(err)}`);
        });
        worker.on('exit', (code) => {
            if (this.client === state) this.client = null;
            const planned = this.stoppingWorker === worker;
            const restarting = this.restartingWorker === worker;
            if (planned) this.stoppingWorker = null;
            if (restarting) this.restartingWorker = null;
            if (!planned) {
                this.exitCount++;
                this.lastExitCode = code;
                this.lastExitAt = new Date().toISOString();
                log('warn', `${name} exited with code ${code}; it restarts on the next call`);
            }
            this.settlePendingOf(worker, restarting, planned ? `${name} stopped` : `${name} exited with code ${code}`);
        });

        try {
            await ready;
        } catch (err) {
            if (this.client === state) this.client = null;
            throw err;
        }
    }

    async stop(): Promise<void> {
        const state = this.client;
        if (!state) return;
        this.client = null;
        this.stoppingWorker = state.worker;
        await state.worker.terminate();
    }

    /** Calls the gone worker held: unstarted ones go to the next worker after a timeout restart, the rest fail. */
    private settlePendingOf(worker: Worker, requeueUnstarted: boolean, reason: string): void {
        for (const p of [...this.pendingRpcs]) {
            if (p.sentTo !== worker) continue;
            if (requeueUnstarted && !p.started && !p.resent) {
                p.resent = true;
                this.detach(p);
                void this.send(p);
                continue;
            }
            p.settle(() => { throw new Error(reason); });
        }
    }

    private detach(p: PendingRpc): void {
        if (p.timer) clearTimeout(p.timer);
        p.timer = null;
        p.port?.close();
        p.port = null;
        p.sentTo = null;
        p.started = false;
    }

    rpc<T>(method: string, args: unknown): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            let settled = false;
            const pending: PendingRpc = {
                method,
                args,
                sentTo: null,
                started: false,
                resent: false,
                port: null,
                timer: null,
                settle: (outcome) => {
                    if (settled) return;
                    settled = true;
                    this.detach(pending);
                    this.pendingRpcs.delete(pending);
                    try {
                        resolve(outcome() as T);
                    } catch (err) {
                        reject(err);
                    }
                }
            };
            this.pendingRpcs.add(pending);
            void this.send(pending);
        });
    }

    private async send(pending: PendingRpc): Promise<void> {
        try {
            await this.start();
        } catch (err) {
            pending.settle(() => { throw err; });
            return;
        }
        if (!this.pendingRpcs.has(pending)) return;
        const state = this.client!;
        const { name, log } = this.options;
        const { method } = pending;
        const timeoutMs = this.options.timeoutMs();
        const { port1, port2 } = new MessageChannel();
        pending.port = port2;
        pending.sentTo = state.worker;

        const armTimer = (): void => {
            pending.timer = setTimeout(() => {
                pending.settle(() => { throw new Error(`${name} rpc '${method}' timed out after ${timeoutMs}ms`); });
                if (this.options.terminateOnTimeout && this.client === state) {
                    log('warn', `${name} rpc '${method}' ran past ${timeoutMs}ms; ending the thread, it restarts on the next call`);
                    this.restartingWorker = state.worker;
                    void this.stop().catch(() => undefined);
                }
            }, timeoutMs);
        };
        if (!this.options.budgetFromStart) armTimer();

        port2.on('message', (msg: WorkerRpcReply | WorkerRpcStarted) => {
            if ((msg as WorkerRpcStarted).kind === 'started') {
                pending.started = true;
                if (this.options.budgetFromStart && !pending.timer) armTimer();
                return;
            }
            const reply = msg as WorkerRpcReply;
            pending.settle(() => {
                if (reply?.ok) return reply.result;
                const payload = reply?.error;
                if (!payload || typeof payload.message !== 'string') throw new Error(`${name} rpc failed`);
                if (payload.nightgate) throw nightgateErrorFromPayload({ ...payload.nightgate, name: payload.name, message: payload.message });
                const err = new Error(payload.message);
                if (payload.name) err.name = payload.name;
                throw err;
            });
        });
        port2.once('messageerror', (err) => pending.settle(() => { throw err; }));
        try {
            state.worker.postMessage({ kind: 'rpc', method, args: pending.args, port: port1 }, [port1]);
        } catch (err) {
            // Never sent, so fail now instead of waiting for the timeout.
            pending.settle(() => { throw err; });
        }
    }

    async resetForTests(): Promise<void> {
        await this.stop();
        this.exitCount = 0;
        this.lastExitCode = null;
        this.lastExitAt = null;
        this.pendingRpcs.clear();
    }
}
