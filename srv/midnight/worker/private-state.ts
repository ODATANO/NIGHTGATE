/**
 * Private-state proxy: the worker reads and writes contract private state
 * through the main thread (CapDbPrivateStateProvider) over per-call ports.
 */

import { parentPort, MessageChannel } from 'node:worker_threads';

// ---- Private-state proxy (worker → main RPC) ------------------------------

/**
 * Each CRUD call on the proxy posts a `private-state-rpc` message back to the
 * main thread, which holds the real CapDbPrivateStateProvider (keyed by
 * proxyId, see srv/midnight/wallet-worker-client.ts). The SDK consumes the
 * returned object as a plain PrivateStateProvider; await semantics work
 * because each method returns a Promise that resolves on the reply port.
 *
 * `setContractAddress` is sync in the SDK contract; we forward it as a
 * fire-and-forget message (no reply port). worker_threads guarantees ordering
 * on parentPort, so the next async set/get from the same proxy is always
 * dispatched on main AFTER the address-set has been applied.
 */
/** A private-state round trip that the main thread never answers (a stalled CAP DB) must not pin the worker op and its session lock forever. */
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
            // Fire-and-forget; order preserved relative to subsequent async ops.
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

