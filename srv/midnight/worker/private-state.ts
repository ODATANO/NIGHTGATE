/**
 * The worker reads and writes contract private state through the main thread,
 * which stores it in the database.
 */

import { parentPort, MessageChannel } from 'node:worker_threads';

/** A stuck database must not hold the worker call and its session lock forever. */
export const PRIVATE_STATE_RPC_TIMEOUT_MS = 60_000;

export function privateStateRpc<T>(proxyId: string, method: string, args: unknown[]): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const { port1, port2 } = new MessageChannel();
        const timer = setTimeout(() => {
            port2.close();
            reject(new Error(`private-state rpc '${method}' was not answered by the main thread within ${PRIVATE_STATE_RPC_TIMEOUT_MS}ms`));
        }, PRIVATE_STATE_RPC_TIMEOUT_MS);
        (timer as any).unref?.();
        port2.once('message', (msg: any) => {
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

export function createPrivateStateProxy(proxyId: string): any {
    return {
        setContractAddress(addr: string): void {
            if (!addr) throw new Error('Contract address must not be empty');
            // The SDK expects this to be synchronous, so no reply is awaited.
            // Messages arrive in order, so it is applied before the next get or set.
            parentPort!.postMessage({
                kind: 'private-state-rpc',
                proxyId,
                method: 'setContractAddress',
                args: [addr]
            });
        },
        async set(privateStateId: string, state: unknown): Promise<void> {
            return privateStateRpc(proxyId, 'set', [privateStateId, state]);
        },
        async get(privateStateId: string): Promise<unknown> {
            return privateStateRpc(proxyId, 'get', [privateStateId]);
        },
        async remove(privateStateId: string): Promise<void> {
            return privateStateRpc(proxyId, 'remove', [privateStateId]);
        },
        async clear(): Promise<void> {
            return privateStateRpc(proxyId, 'clear', []);
        },
        async setSigningKey(addr: string, signingKey: string): Promise<void> {
            return privateStateRpc(proxyId, 'setSigningKey', [addr, signingKey]);
        },
        async getSigningKey(addr: string): Promise<string | null> {
            return privateStateRpc(proxyId, 'getSigningKey', [addr]);
        },
        async removeSigningKey(addr: string): Promise<void> {
            return privateStateRpc(proxyId, 'removeSigningKey', [addr]);
        },
        async clearSigningKeys(): Promise<void> {
            return privateStateRpc(proxyId, 'clearSigningKeys', []);
        }
    };
}

