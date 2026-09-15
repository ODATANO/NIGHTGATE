import cds from '@sap/cds';
const { SELECT, INSERT, UPDATE } = cds.ql;

import { SyncState, Blocks } from '#cds-models/midnight';
import { getConfiguredNightgateNodeUrl, resolveNightgateRuntimeConfig, getNightgatePluginConfig } from './nightgate-config';
import { redactUrlCredentials } from './redact-url';
import { configString } from './config';

/** The database is bound to another network than the configured one. */
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
        const nightgateConfig = getNightgatePluginConfig();
        const { network } = resolveNightgateRuntimeConfig(nightgateConfig);
        if (existing.networkId && existing.networkId !== network) {
            throw new SyncStateNetworkMismatchError(existing.networkId, network);
        }
        // No networkId: bind an empty index in place; a populated one needs
        // NIGHTGATE_ASSUME_DB_NETWORK, else a missing binding would be a bypass.
        if (!existing.networkId) {
            const anyBlock = await db.run(SELECT.one.from(Blocks));
            const assumed = configString('NIGHTGATE_ASSUME_DB_NETWORK');
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
        // SyncState is OData-readable: strip URL credentials from existing rows.
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
                // OData-readable: never persist URL credentials.
                nodeUrl: redactUrlCredentials(nodeUrl || configuredNodeUrl || ''),
                chainHeight: 0,
                consecutiveErrors: 0
            }));
        } catch (err: any) {
            // Another caller inserted first (SQLite / PostgreSQL wording).
            if (!/unique constraint|duplicate key/i.test(String(err.message ?? ''))) throw err;
        }
    }
}
