/**
 * The calling side of a helper worker thread: lazy start, one message channel per call,
 * a timeout per call, restart on the next call after a crash.
 * This module does not import `@sap/cds`, because the wallet worker uses it too.
 */

import { Worker, MessageChannel } from 'node:worker_threads';
import { nightgateErrorFromPayload } from '../../utils/errors';
import { formatErr } from '../../utils/format-error';
import type { WorkerRpcReply } from './dispatch';

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
     * Ends the worker when a call runs past its timeout, so a stuck call does not hold the
     * thread for the calls behind it. Off, a timed-out call keeps running in the worker.
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

interface PendingRpc { reject: (e: Error) => void }

export class WorkerRpcClient {
    private client: ClientState | null = null;
    private stoppingWorker: Worker | null = null;
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
            if (planned) {
                this.stoppingWorker = null;
            } else {
                this.exitCount++;
                this.lastExitCode = code;
                this.lastExitAt = new Date().toISOString();
                log('warn', `${name} exited with code ${code}; it restarts on the next call`);
            }
            this.rejectAllPending(planned ? `${name} stopped` : `${name} exited with code ${code}`);
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

    private rejectAllPending(reason: string): void {
        for (const p of [...this.pendingRpcs]) {
            try { p.reject(new Error(reason)); } catch { /* already settled */ }
        }
        this.pendingRpcs.clear();
    }

    async rpc<T>(method: string, args: unknown): Promise<T> {
        await this.start();
        const state = this.client!;
        const timeoutMs = this.options.timeoutMs();
        const { name, log } = this.options;
        return new Promise<T>((resolve, reject) => {
            const { port1, port2 } = new MessageChannel();
            let settled = false;
            const pending: PendingRpc = { reject: (e) => finish(() => reject(e)) };
            const finish = (outcome: () => void): void => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                this.pendingRpcs.delete(pending);
                port2.close();
                outcome();
            };
            this.pendingRpcs.add(pending);
            const timer = setTimeout(() => {
                pending.reject(new Error(`${name} rpc '${method}' timed out after ${timeoutMs}ms`));
                if (this.options.terminateOnTimeout && this.client === state) {
                    log('warn', `${name} rpc '${method}' ran past ${timeoutMs}ms; ending the thread, it restarts on the next call`);
                    void this.stop().catch(() => undefined);
                }
            }, timeoutMs);

            port2.on('message', (msg: WorkerRpcReply) => finish(() => {
                if (msg?.ok) {
                    resolve(msg.result as T);
                    return;
                }
                const payload = msg?.error;
                if (!payload || typeof payload.message !== 'string') {
                    reject(new Error(`${name} rpc failed`));
                    return;
                }
                if (payload.nightgate) {
                    reject(nightgateErrorFromPayload({ ...payload.nightgate, name: payload.name, message: payload.message }));
                    return;
                }
                const err = new Error(payload.message);
                if (payload.name) err.name = payload.name;
                reject(err);
            }));
            port2.once('messageerror', (err) => finish(() => reject(err)));
            try {
                state.worker.postMessage({ kind: 'rpc', method, args, port: port1 }, [port1]);
            } catch (err) {
                // Never sent, so fail now instead of waiting for the timeout.
                pending.reject(err as Error);
            }
        });
    }

    async resetForTests(): Promise<void> {
        await this.stop();
        this.exitCount = 0;
        this.lastExitCode = null;
        this.lastExitAt = null;
        this.pendingRpcs.clear();
    }
}
