// SPDX-License-Identifier: Apache-2.0
import { errorMessage } from '../utils/errors';
import { withTimeout } from '../utils/timeout';
import type { MidnightNodeProvider, RuntimeVersion } from '../providers/MidnightNodeProvider';
import type { getRuntimeInfo } from '#cds-models/NightgateIndexerService';

export type NodeInfo = NonNullable<NonNullable<Awaited<ReturnType<typeof getRuntimeInfo>>>['node']>;

const NODE_INFO_TIMEOUT_MS = 5_000;

interface SystemHealth {
    peers: number;
    isSyncing: boolean;
}

/** Version, runtime, ledger and sync state of the node the crawler reads. Each part that fails is null, `errors` says why. */
export async function readNodeInfo(provider: Pick<MidnightNodeProvider, 'rpc' | 'getRuntimeVersion'>): Promise<NodeInfo> {
    const errors: string[] = [];
    const ask = async <T>(name: string, call: () => Promise<unknown>): Promise<T | null> => {
        try {
            return await withTimeout(call(), NODE_INFO_TIMEOUT_MS) as T;
        } catch (err) {
            errors.push(`${name}: ${errorMessage(err)}`);
            return null;
        }
    };
    const [version, runtime, ledgerVersion, health] = await Promise.all([
        ask<string>('system_version', () => provider.rpc('system_version')),
        ask<RuntimeVersion>('state_getRuntimeVersion', () => provider.getRuntimeVersion()),
        ask<string>('midnight_ledgerVersion', () => provider.rpc('midnight_ledgerVersion')),
        ask<SystemHealth>('system_health', () => provider.rpc('system_health'))
    ]);
    return {
        version: typeof version === 'string' ? version : null,
        specName: runtime?.specName ?? null,
        specVersion: runtime?.specVersion ?? null,
        transactionVersion: runtime?.transactionVersion ?? null,
        ledgerVersion: typeof ledgerVersion === 'string' ? ledgerVersion : null,
        peers: typeof health?.peers === 'number' ? health.peers : null,
        isSyncing: typeof health?.isSyncing === 'boolean' ? health.isSyncing : null,
        errors
    };
}
