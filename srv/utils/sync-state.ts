/**
 * Shared SyncState singleton initializer.
 *
 * Used by both the Crawler and NightgateIndexerService to ensure the
 * SyncState row exists before any reads/writes.
 */

import cds from '@sap/cds';
const { SELECT, INSERT, UPDATE } = cds.ql;

import { SyncState, Blocks } from '#cds-models/midnight';
import { getConfiguredNightgateNodeUrl, resolveNightgateRuntimeConfig, getNightgatePluginConfig } from './nightgate-config';
import { redactUrlCredentials } from './redact-url';

/**
 * Thrown when the database's SyncState row belongs to a DIFFERENT network
 * than the configured one. Fail-closed: reusing a database across networks
 * would mix chain-indexed rows (blocks, transactions, verification evidence)
 * of different chains.
 */
export class SyncStateNetworkMismatchError extends Error {
    constructor(public readonly storedNetwork: string, public readonly configuredNetwork: string) {
        super(
            `This database is bound to network '${storedNetwork}' but the configured network is ` +
            `'${configuredNetwork}'. Refusing to start: mixing chains in one database corrupts ` +
            `indexed and verification data. Use a separate database file per network (set ` +
            `NIGHTGATE_DB_PATH), or, to deliberately rebind an EMPTY/expendable database, delete it ` +
            `and redeploy.`
        );
        this.name = 'SyncStateNetworkMismatchError';
    }
}

export async function ensureSyncStateSingleton(db: cds.DatabaseService, nodeUrl?: string): Promise<void> {
    const existing: any = await db.run(
        SELECT.one.from(SyncState).where({ ID: 'SINGLETON' })
    );

    if (existing) {
        // NETWORK GUARD: an existing index is bound to its network.
        const nightgateConfig = getNightgatePluginConfig();
        const { network } = resolveNightgateRuntimeConfig(nightgateConfig);
        if (existing.networkId && existing.networkId !== network) {
            throw new SyncStateNetworkMismatchError(existing.networkId, network);
        }
        // Legacy rows without a networkId must not stay an open bypass: a
        // demonstrably EMPTY index (no indexed blocks) is bound to the
        // configured network in place; a populated one is fail-closed unless
        // the operator explicitly confirms the binding by setting
        // NIGHTGATE_ASSUME_DB_NETWORK to the configured network.
        if (!existing.networkId) {
            const anyBlock = await db.run(SELECT.one.from(Blocks));
            const assumed = process.env.NIGHTGATE_ASSUME_DB_NETWORK;
            if (anyBlock && assumed !== network) {
                throw new Error(
                    `This database carries indexed chain data but no recorded network binding ` +
                    `(pre-0.16.0). Refusing to start on '${network}': if the data was indexed from ` +
                    `another network, mixing chains corrupts it. If you KNOW this database belongs ` +
                    `to '${network}', confirm once with NIGHTGATE_ASSUME_DB_NETWORK=${network}; ` +
                    `otherwise use a separate database file (NIGHTGATE_DB_PATH).`
                );
            }
            await db.run(UPDATE.entity(SyncState).set({ networkId: network }).where({ ID: 'SINGLETON' }));
        }
        // Backfill: rows persisted before 0.16.0 may carry URL-embedded
        // credentials; strip them in place (SyncState is OData-readable).
        const redacted = redactUrlCredentials(existing.nodeUrl);
        if (existing.nodeUrl && redacted !== existing.nodeUrl) {
            await db.run(UPDATE.entity(SyncState).set({ nodeUrl: redacted }).where({ ID: 'SINGLETON' }));
        }
        return;
    }

    {
        try {
            const nightgateConfig = getNightgatePluginConfig();
            const { network } = resolveNightgateRuntimeConfig(nightgateConfig);
            const configuredNodeUrl = getConfiguredNightgateNodeUrl(nightgateConfig);
            await db.run(INSERT.into(SyncState).entries({
                ID: 'SINGLETON',
                networkId: network,
                lastIndexedHeight: 0,
                syncStatus: 'stopped',
                // SyncState is OData-readable; never persist embedded
                // credentials (userinfo / API-key query params).
                nodeUrl: redactUrlCredentials(nodeUrl || configuredNodeUrl || ''),
                chainHeight: 0,
                consecutiveErrors: 0
            }));
        } catch (err: any) {
            // Race condition: another service instance inserted first, safe to ignore
            if (!err.message?.includes('UNIQUE constraint')) throw err;
        }
    }
}
