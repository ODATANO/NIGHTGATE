/**
 * Main-thread side of the decode worker: contract state and ledger transactions are decoded there,
 * so wasm never runs on the server thread. One worker per process, one message channel per call.
 * The worker starts on the first call and again after a crash.
 */

import cds from '@sap/cds';
import { Worker, MessageChannel } from 'node:worker_threads';
import path from 'node:path';
import { configMs, resolvedConfigSnapshot } from '../utils/config';
import { nightgateErrorFromPayload } from '../utils/errors';
import { formatErr } from '../utils/format-error';
import type { DecodeRpcReply } from './decode-worker/dispatch';
import type { ReadPredicateStateForContractArgs } from '../submission/predicate-state';
import type { ReadAttestationStateForContractArgs, AttestationStateResult } from '../submission/attestation-state';
import type { ReadDisclosureGrantsArgs, DisclosureGrantRecord } from '../submission/disclosure-grants';
import type { HolderRegistrationQuery, HolderRegistration } from '../submission/holder-registry';
import type { LedgerPayloadFacts } from '../crawler/ledger-payload';

const log = cds.log('nightgate:decode-worker');

export interface DecodeWorkerStatus {
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

let client: ClientState | null = null;
let stoppingWorker: Worker | null = null;
let exitCount = 0;
let lastExitCode: number | null = null;
let lastExitAt: string | null = null;
const pendingRpcs = new Set<PendingRpc>();

function resolveWorkerEntry(): string {
    return path.join(__dirname, 'decode-worker.js');
}

export function getDecodeWorkerStatus(): DecodeWorkerStatus {
    return { running: client !== null, inFlightRpcs: pendingRpcs.size, exitCount, lastExitCode, lastExitAt };
}

export async function startDecodeWorker(): Promise<void> {
    if (client) {
        await client.ready;
        return;
    }
    // The worker gets its config from here and never reads the environment.
    const worker = new Worker(resolveWorkerEntry(), {
        workerData: { config: resolvedConfigSnapshot() },
        stdout: false,
        stderr: false
    });
    const ready = new Promise<void>((resolve, reject) => {
        const onMessage = (msg: { kind?: string }): void => {
            if (msg?.kind === 'ready') { cleanup(); resolve(); }
        };
        const onError = (err: Error): void => { cleanup(); reject(err); };
        const onExit = (code: number): void => { cleanup(); reject(new Error(`decode-worker exited with code ${code} before it was ready`)); };
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
    client = state;

    worker.on('message', (msg: { kind?: string; level?: string; message?: string }) => {
        if (msg?.kind !== 'log') return;
        const level = msg.level === 'warn' || msg.level === 'error' || msg.level === 'debug' ? msg.level : 'info';
        log[level](`[decode-worker] ${msg.message}`);
    });
    worker.on('error', (err) => {
        log.error(`decode-worker error: ${formatErr(err)}`);
    });
    worker.on('exit', (code) => {
        if (client === state) client = null;
        const planned = stoppingWorker === worker;
        if (planned) {
            stoppingWorker = null;
        } else {
            exitCount++;
            lastExitCode = code;
            lastExitAt = new Date().toISOString();
            log.warn(`decode-worker exited with code ${code}; it restarts on the next call`);
        }
        rejectAllPendingRpcs(planned ? 'decode-worker stopped' : `decode-worker exited with code ${code}`);
    });

    try {
        await ready;
    } catch (err) {
        if (client === state) client = null;
        throw err;
    }
}

export async function stopDecodeWorker(): Promise<void> {
    const state = client;
    if (!state) return;
    client = null;
    stoppingWorker = state.worker;
    await state.worker.terminate();
}

function rejectAllPendingRpcs(reason: string): void {
    for (const p of [...pendingRpcs]) {
        try { p.reject(new Error(reason)); } catch { /* already settled */ }
    }
    pendingRpcs.clear();
}

async function rpc<T>(method: string, args: unknown): Promise<T> {
    await startDecodeWorker();
    const worker = client!.worker;
    const timeoutMs = configMs('NIGHTGATE_DECODE_WORKER_RPC_TIMEOUT_MS');
    return new Promise<T>((resolve, reject) => {
        const { port1, port2 } = new MessageChannel();
        let settled = false;
        const pending: PendingRpc = { reject: (e) => finish(() => reject(e)) };
        const finish = (outcome: () => void): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            pendingRpcs.delete(pending);
            port2.close();
            outcome();
        };
        pendingRpcs.add(pending);
        const timer = setTimeout(() => pending.reject(new Error(`decode-worker rpc '${method}' timed out after ${timeoutMs}ms`)), timeoutMs);

        port2.on('message', (msg: DecodeRpcReply) => finish(() => {
            if (msg?.ok) {
                resolve(msg.result as T);
                return;
            }
            const payload = msg?.error;
            if (!payload || typeof payload.message !== 'string') {
                reject(new Error('decode-worker rpc failed'));
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
            worker.postMessage({ kind: 'rpc', method, args, port: port1 }, [port1]);
        } catch (err) {
            // Never sent, so fail now instead of waiting for the timeout.
            pending.reject(err as Error);
        }
    });
}

/** Functions are not cloneable, so the claim-key override stays on the in-thread reader. */
export type ReadPredicateStateInWorkerArgs = Omit<ReadPredicateStateForContractArgs, 'computeFieldClaimKey'>;

export function readPredicateStateInWorker(args: ReadPredicateStateInWorkerArgs): Promise<boolean | null> {
    return rpc('readPredicateState', args);
}

export function readAttestationStateInWorker(args: ReadAttestationStateForContractArgs): Promise<AttestationStateResult | null> {
    return rpc('readAttestationState', args);
}

export function readDisclosureGrantsInWorker(args: ReadDisclosureGrantsArgs): Promise<DisclosureGrantRecord[] | null> {
    return rpc('readDisclosureGrants', args);
}

export function readHolderRegistrationInWorker(args: HolderRegistrationQuery): Promise<HolderRegistration | null> {
    return rpc('readHolderRegistration', args);
}

export function decodeLedgerPayloadInWorker(bytes: Uint8Array): Promise<LedgerPayloadFacts> {
    return rpc('decodeLedgerPayload', { bytes });
}

export async function __resetDecodeWorkerForTests(): Promise<void> {
    await stopDecodeWorker();
    exitCount = 0;
    lastExitCode = null;
    lastExitAt = null;
    pendingRpcs.clear();
}
