/**
 * Receives calls from the owning thread and runs the matching method.
 * One reply per call on the call's own port: `{ ok: true, result }` or `{ ok: false, error }`.
 * This module does not import `@sap/cds`, because the worker threads load it.
 */

import type { MessagePort } from 'node:worker_threads';
import { errorName, formatErrWithCauses } from '../../utils/format-error';
import { findNightgateError, type NightgateErrorPayload } from '../../utils/errors';
import { causeMessages } from '../submit-error-classification';

export type WorkerRpcHandlers = Record<string, (args: unknown) => Promise<unknown>>;

export interface WorkerRpcRequest {
    kind: 'rpc';
    method: string;
    args: unknown;
    port: MessagePort;
}

/** The worker's error reply. `nightgate` carries our own coded error, so it reaches the caller intact. */
export interface WorkerRpcErrorPayload {
    name: string;
    message: string;
    causes: string[];
    nightgate?: NightgateErrorPayload;
}

export type WorkerRpcReply = { ok: true; result: unknown } | { ok: false; error: WorkerRpcErrorPayload };

/** Sent on the call's port before the method runs, so the caller can tell queue time from run time. */
export interface WorkerRpcStarted { kind: 'started' }

export function isWorkerRpcRequest(msg: unknown): msg is WorkerRpcRequest {
    const m = msg as Partial<WorkerRpcRequest> | null;
    return !!m && m.kind === 'rpc' && typeof m.method === 'string' && !!m.port;
}

export function createDispatcher(handlers: WorkerRpcHandlers, log: (level: 'warn', message: string) => void): (msg: unknown) => Promise<void> {
    return async (msg: unknown): Promise<void> => {
        if (!isWorkerRpcRequest(msg)) {
            log('warn', `unexpected message: ${JSON.stringify(msg).slice(0, 80)}`);
            return;
        }
        const { method, args, port } = msg;
        let reply: WorkerRpcReply;
        try {
            port.postMessage({ kind: 'started' } satisfies WorkerRpcStarted);
            const fn = handlers[method];
            if (!fn) throw new Error(`Unknown method: ${method}`);
            reply = { ok: true, result: await fn(args) };
        } catch (err: unknown) {
            const error: WorkerRpcErrorPayload = {
                name: errorName(err),
                message: formatErrWithCauses(err),
                causes: causeMessages(err)
            };
            const coded = findNightgateError(err);
            if (coded) error.nightgate = coded.toPayload();
            reply = { ok: false, error };
        }
        try {
            port.postMessage(reply);
        } finally {
            port.close();
        }
    };
}
