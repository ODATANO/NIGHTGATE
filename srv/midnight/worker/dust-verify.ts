/**
 * Wallet-worker side of the dust verify worker (`../dust-verify-worker.ts`).
 * One helper thread per wallet worker, started on the first collapse. The budget counts from
 * the moment the helper begins a check; a check past it ends the helper, and checks still
 * waiting move to the restarted one.
 */

import path from 'node:path';
import { configMs } from '../../utils/config';
import { WorkerRpcClient, type WorkerRpcStatus } from '../worker-rpc/client';
import { log } from './context';
import type { CollapsedDustExpectation, CollapsedDustVerdict } from './dust-collapse';

export function dustCollapseBudgetMs(): number {
    return configMs('NIGHTGATE_DUST_COLLAPSE_BUDGET_MS');
}

const client = new WorkerRpcClient({
    name: 'dust-verify-worker',
    entry: path.join(__dirname, '..', 'dust-verify-worker.js'),
    log,
    timeoutMs: dustCollapseBudgetMs,
    budgetFromStart: true,
    terminateOnTimeout: true,
    unref: true
});

export function verifyCollapsedDustInHelper(bytes: Uint8Array, expect: CollapsedDustExpectation): Promise<CollapsedDustVerdict> {
    return client.rpc('verifyCollapsedDust', { bytes, expect });
}

export function getDustVerifyWorkerStatus(): WorkerRpcStatus {
    return client.status();
}

export function stopDustVerifyWorker(): Promise<void> {
    return client.stop();
}
