// The worker reads and writes contract private state through the main thread, which stores it in the database.

import { parentPort, MessageChannel } from 'node:worker_threads';
import type { ContractPrivateStates, PrivateStateProvider } from '@midnight-ntwrk/midnight-js-types';

/** A stuck database must not hold the worker call and its session lock forever. */
export const PRIVATE_STATE_RPC_TIMEOUT_MS = 60_000;

export function privateStateRpc<T>(proxyId: string, method: string, args: unknown[]): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const { port1, port2 } = new MessageChannel();
        const timer = setTimeout(() => {
            port2.close();
            reject(new Error(`private-state rpc '${method}' was not answered by the main thread within ${PRIVATE_STATE_RPC_TIMEOUT_MS}ms`));
        }, PRIVATE_STATE_RPC_TIMEOUT_MS);
        timer.unref();
        // The reply comes from the main thread as an untyped worker message.
        port2.once('message', (msg: { ok?: boolean; result?: unknown; error?: { name?: string; message?: string } } | null) => {
            clearTimeout(timer);
            port2.close();
            if (msg?.ok) {
                resolve(msg.result as T);
            } else {
                const payload = msg?.error;
                const err = new Error(payload?.message ?? String(payload ?? 'private-state rpc failed'));
                if (payload?.name) err.name = payload.name;
                reject(err);
            }
        });
        port2.once('messageerror', err => { clearTimeout(timer); port2.close(); reject(err); });
        parentPort!.postMessage(
            { kind: 'private-state-rpc', proxyId, method, args, port: port1 },
            [port1]
        );
    });
}

/** The main thread keeps the export and import methods for itself, so the worker cannot move keys or states out. */
function notInWorker(method: string): never {
    throw new Error(`private-state '${method}' is not available from the wallet worker`);
}

/** Every call carries the contract address, so the main-thread provider holds no per-call state. */
export function createPrivateStateProxy(proxyId: string): PrivateStateProvider<string, unknown> {
    return {
        forContract(contractAddress: string): ContractPrivateStates<string, unknown> {
            if (!contractAddress) throw new Error('Contract address must not be empty');
            return {
                contractAddress: contractAddress.toLowerCase(),
                set: (privateStateId, state) => privateStateRpc(proxyId, 'set', [contractAddress, privateStateId, state]),
                get: (privateStateId) => privateStateRpc(proxyId, 'get', [contractAddress, privateStateId]),
                remove: (privateStateId) => privateStateRpc(proxyId, 'remove', [contractAddress, privateStateId]),
                clear: () => privateStateRpc(proxyId, 'clear', [contractAddress]),
                exportPrivateStates: () => notInWorker('exportPrivateStates'),
                importPrivateStates: () => notInWorker('importPrivateStates')
            };
        },
        clearAll: () => privateStateRpc(proxyId, 'clearAll', []),
        setSigningKey: (addr, signingKey) => privateStateRpc(proxyId, 'setSigningKey', [addr, signingKey]),
        getSigningKey: (addr) => privateStateRpc(proxyId, 'getSigningKey', [addr]),
        removeSigningKey: (addr) => privateStateRpc(proxyId, 'removeSigningKey', [addr]),
        clearSigningKeys: () => privateStateRpc(proxyId, 'clearSigningKeys', []),
        exportSigningKeys: () => notInWorker('exportSigningKeys'),
        importSigningKeys: () => notInWorker('importSigningKeys')
    };
}
