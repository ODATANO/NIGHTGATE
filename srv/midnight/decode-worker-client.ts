/**
 * Main-thread side of the decode worker: contract state and ledger transactions are decoded there,
 * so wasm never runs on the server thread. One worker per process, one message channel per call.
 * The worker starts on the first call and again after a crash.
 */

import cds from '@sap/cds';
import path from 'node:path';
import { configMs, resolvedConfigSnapshot } from '../utils/config';
import { WorkerRpcClient, type WorkerRpcStatus } from './worker-rpc/client';
import type { ReadPredicateStateForContractArgs } from '../submission/predicate-state';
import type { ReadAttestationStateForContractArgs, AttestationStateResult } from '../submission/attestation-state';
import type { ReadDisclosureGrantsArgs, DisclosureGrantRecord } from '../submission/disclosure-grants';
import type { HolderRegistrationQuery, HolderRegistration } from '../submission/holder-registry';
import type { LedgerPayloadFacts } from '../crawler/ledger-payload';

const log = cds.log('nightgate:decode-worker');

export type DecodeWorkerStatus = WorkerRpcStatus;

const client = new WorkerRpcClient({
    name: 'decode-worker',
    entry: path.join(__dirname, 'decode-worker.js'),
    // The worker gets its config from here and never reads the environment.
    workerData: () => ({ config: resolvedConfigSnapshot() }),
    log: (level, message) => log[level](message),
    timeoutMs: () => configMs('NIGHTGATE_DECODE_WORKER_RPC_TIMEOUT_MS')
});

export function getDecodeWorkerStatus(): DecodeWorkerStatus {
    return client.status();
}

export function startDecodeWorker(): Promise<void> {
    return client.start();
}

export function stopDecodeWorker(): Promise<void> {
    return client.stop();
}

/** Functions are not cloneable, so the claim-key override stays on the in-thread reader. */
export type ReadPredicateStateInWorkerArgs = Omit<ReadPredicateStateForContractArgs, 'computeFieldClaimKey'>;

export function readPredicateStateInWorker(args: ReadPredicateStateInWorkerArgs): Promise<boolean | null> {
    return client.rpc('readPredicateState', args);
}

export function readAttestationStateInWorker(args: ReadAttestationStateForContractArgs): Promise<AttestationStateResult | null> {
    return client.rpc('readAttestationState', args);
}

export function readDisclosureGrantsInWorker(args: ReadDisclosureGrantsArgs): Promise<DisclosureGrantRecord[] | null> {
    return client.rpc('readDisclosureGrants', args);
}

export function readHolderRegistrationInWorker(args: HolderRegistrationQuery): Promise<HolderRegistration | null> {
    return client.rpc('readHolderRegistration', args);
}

export function decodeLedgerPayloadInWorker(bytes: Uint8Array): Promise<LedgerPayloadFacts> {
    return client.rpc('decodeLedgerPayload', { bytes });
}

export function __resetDecodeWorkerForTests(): Promise<void> {
    return client.resetForTests();
}
