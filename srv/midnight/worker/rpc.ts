/**
 * Receives calls from the main thread and runs the matching method.
 */

import { type MessagePort } from 'node:worker_threads';
import { runInRpcScope } from './cancellation';
import { SUBMIT_METHODS, isSubmittingMethod, WORKER_ROTATING, RpcErrorPayload } from '../wallet-worker-protocol';
import { classifySubmitFailure, causeMessages } from '../submit-error-classification';
import { errorName, formatErrWithCauses } from '../../utils/format-error';
import { findNightgateError } from '../../utils/errors';
import { facades, log, type RpcRequest, type RpcOk, type RpcErr } from './context';
import { facadeHandlers, withSessionLocks, submitLockKeys, resolveSaveAckWaiter, applySaveAck } from './facades';
import { tokenHandlers } from './tokens';
import { contractHandlers } from './contracts';
import { sponsorHandlers } from './sponsor';
import { rotationHandlers, rotationState, rotateIfDue } from './rotation';
import { retainGeneration } from './artifacts';

export const handlers: Record<string, (args: any) => Promise<unknown>> = {
    ...facadeHandlers,
    ...rotationHandlers,
    ...tokenHandlers,
    ...contractHandlers,
    ...sponsorHandlers
};

export async function handleMessage(msg: any): Promise<void> {
    if (msg?.kind === 'state-save-ack') {
        resolveSaveAckWaiter(msg.seq);
        const entry = facades.get(String(msg.sessionId ?? ''));
        if (entry) applySaveAck(entry, msg.seq);
        return;
    }
    if (msg?.kind !== 'rpc' || !msg.port) {
        log('warn', `unexpected message: ${JSON.stringify(msg).slice(0, 80)}`);
        return;
    }
    const { method, args, port } = msg as RpcRequest;
    await dispatch(method, args, port);
}

async function dispatch(method: string, args: unknown, port: MessagePort): Promise<void> {
    if (rotationState.draining) {
        port.postMessage({ ok: false, error: { name: WORKER_ROTATING, message: 'wallet worker is rotating (artifact generation budget); retry on the respawned worker' } } as RpcErr);
        port.close();
        return;
    }
    // Only a call that may send a tx delays a planned restart.
    const submitting = isSubmittingMethod(method);
    try {
        const fn = handlers[method];
        if (!fn) throw new Error(`Unknown method: ${method}`);
        // Submitting methods get the reply port to announce their tx before sending.
        const callArgs = submitting ? { ...(args as object), __replyPort: port } : args;
        // Keeps the contract's files from being cleaned up while the call runs.
        const releaseGeneration = retainGeneration((args as any)?.registration?.artifactDigest);
        if (submitting) rotationState.inflight++;
        const cancel = new AbortController();
        const onCancel = (m: any): void => { if (m?.kind === 'cancel') cancel.abort(); };
        port.on('message', onCancel);
        let result: unknown;
        try {
            result = await runInRpcScope(method, cancel.signal, () => SUBMIT_METHODS.has(method)
                ? withSessionLocks(submitLockKeys(args), () => fn(callArgs))
                : fn(callArgs));
        } finally {
            port.off('message', onCancel);
            if (submitting) rotationState.inflight--;
            releaseGeneration();
        }
        port.postMessage({ ok: true, result } as RpcOk);
    } catch (err: unknown) {
        const payload: RpcErrorPayload = {
            name: errorName(err),
            message: formatErrWithCauses(err),
            causes: causeMessages(err)
        };
        const coded = findNightgateError(err);
        if (coded) payload.nightgate = coded.toPayload();
        // Classify here, where the original SDK error objects are still available.
        if (submitting) {
            const info = classifySubmitFailure(err);
            payload.code = info.code;
            payload.retryable = info.retryable;
            if (info.ledgerCode) payload.ledgerCode = info.ledgerCode;
            if (info.calls?.length) payload.calls = info.calls;
            if (Number.isInteger(info.blockHeight)) payload.blockHeight = info.blockHeight;
        }
        port.postMessage({ ok: false, error: payload } as RpcErr);
    } finally {
        port.close();
        rotateIfDue();
    }
}
