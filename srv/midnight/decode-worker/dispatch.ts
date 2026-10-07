/**
 * Receives calls from the main thread and runs the matching method.
 * One reply per call on the call's own port: `{ ok: true, result }` or `{ ok: false, error }`.
 * This module does not import `@sap/cds`, because the decode worker loads it.
 */

import type { MessagePort } from 'node:worker_threads';
import { errorName, formatErrWithCauses } from '../../utils/format-error';
import { findNightgateError, type NightgateErrorPayload } from '../../utils/errors';
import { causeMessages } from '../submit-error-classification';

export type DecodeHandlers = Record<string, (args: unknown) => Promise<unknown>>;

export interface DecodeRpcRequest {
    kind: 'rpc';
    method: string;
    args: unknown;
    port: MessagePort;
}

/** The worker's error reply. `nightgate` carries our own coded error, so it reaches the main thread intact. */
export interface DecodeRpcErrorPayload {
    name: string;
    message: string;
    causes: string[];
    nightgate?: NightgateErrorPayload;
}

export type DecodeRpcReply = { ok: true; result: unknown } | { ok: false; error: DecodeRpcErrorPayload };

export function isDecodeRpcRequest(msg: unknown): msg is DecodeRpcRequest {
    const m = msg as Partial<DecodeRpcRequest> | null;
    return !!m && m.kind === 'rpc' && typeof m.method === 'string' && !!m.port;
}

export function createDispatcher(handlers: DecodeHandlers, log: (level: 'warn', message: string) => void): (msg: unknown) => Promise<void> {
    return async (msg: unknown): Promise<void> => {
        if (!isDecodeRpcRequest(msg)) {
            log('warn', `unexpected message: ${JSON.stringify(msg).slice(0, 80)}`);
            return;
        }
        const { method, args, port } = msg;
        let reply: DecodeRpcReply;
        try {
            const fn = handlers[method];
            if (!fn) throw new Error(`Unknown method: ${method}`);
            reply = { ok: true, result: await fn(args) };
        } catch (err: unknown) {
            const error: DecodeRpcErrorPayload = {
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
