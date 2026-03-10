/**
 * Shared SyncState singleton initializer.
 *
 * Used by both the Crawler and NightgateIndexerService to ensure the
 * SyncState row exists before any reads/writes.
 */

import cds from '@sap/cds';
const { SELECT, INSERT } = cds.ql;

import { getConfiguredNightgateNodeUrl, resolveNightgateRuntimeConfig } from './nightgate-config';

export async function ensureSyncStateSingleton(db: any, nodeUrl?: string): Promise<void> {
    const existing = await db.run(
        SELECT.one.from('midnight.SyncState').where({ ID: 'SINGLETON' })
    );

    if (!existing) {
        try {
            const nightgateConfig = (cds.env as any).requires?.nightgate || {};
            const { network } = resolveNightgateRuntimeConfig(nightgateConfig);
            const configuredNodeUrl = getConfiguredNightgateNodeUrl(nightgateConfig);
            await db.run(INSERT.into('midnight.SyncState').entries({
                ID: 'SINGLETON',
                networkId: network,
                lastIndexedHeight: 0,
                syncStatus: 'stopped',
                nodeUrl: nodeUrl || configuredNodeUrl || '',
                chainHeight: 0,
                consecutiveErrors: 0
            }));
        } catch (err: any) {
            // Race condition: another service instance inserted first — safe to ignore
            if (!err.message?.includes('UNIQUE constraint')) throw err;
        }
    }
}
