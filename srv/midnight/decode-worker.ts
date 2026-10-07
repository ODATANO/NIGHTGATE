/**
 * Entry point of the decode worker thread.
 * Decoding contract state and ledger transactions runs in wasm and blocks the thread it runs on,
 * so it runs here and not on the server thread. Every call returns plain data; no SDK object crosses the boundary.
 */

import { parentPort } from 'node:worker_threads';
import { setConfigWarnSink } from '../utils/config';
import { createDispatcher, type WorkerRpcHandlers } from './worker-rpc/dispatch';
import { readPredicateStateForContract, type ReadPredicateStateForContractArgs } from '../submission/predicate-state';
import { readAttestationStateForContract, type ReadAttestationStateForContractArgs } from '../submission/attestation-state';
import { readDisclosureGrants, type ReadDisclosureGrantsArgs } from '../submission/disclosure-grants';
import { readHolderRegistration, type HolderRegistrationQuery } from '../submission/holder-registry';
import { decodeLedgerPayload } from '../crawler/ledger-payload';

export function log(level: 'info' | 'warn' | 'debug' | 'error', message: string): void {
    parentPort?.postMessage({ kind: 'log', level, message });
}

/** The callable methods. The client in `decode-worker-client.ts` has one typed wrapper per entry. */
export const handlers: WorkerRpcHandlers = {
    readPredicateState: (args) => readPredicateStateForContract(args as ReadPredicateStateForContractArgs),
    readAttestationState: (args) => readAttestationStateForContract(args as ReadAttestationStateForContractArgs),
    readDisclosureGrants: (args) => readDisclosureGrants(args as ReadDisclosureGrantsArgs),
    readHolderRegistration: (args) => readHolderRegistration(args as HolderRegistrationQuery),
    decodeLedgerPayload: (args) => decodeLedgerPayload((args as { bytes: Uint8Array }).bytes)
};

if (!parentPort) {
    throw new Error('decode-worker must be loaded as a worker_threads worker (no parentPort)');
}
setConfigWarnSink((message) => log('warn', message));

const dispatch = createDispatcher(handlers, log);
parentPort.on('message', (msg: unknown) => { void dispatch(msg); });

parentPort.postMessage({ kind: 'ready' });
log('info', 'ready');
