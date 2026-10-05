import cds from '@sap/cds';
import { NightgateError } from './errors';
const { SELECT, INSERT, UPDATE } = cds.ql;

import { SyncState, Blocks } from '#cds-models/midnight';
import { getConfiguredNightgateNodeUrl, resolveNightgateRuntimeConfig, getNightgatePluginConfig } from './nightgate-config';
import { redactUrlCredentials } from './redact-url';
import { formatErr } from './format-error';
import { configString } from './config';

export class SyncStateNetworkMismatchError extends NightgateError {
    constructor(public readonly storedNetwork: string, public readonly configuredNetwork: string) {
        super('SYNC_STATE_NETWORK_MISMATCH',
            `This database is bound to network '${storedNetwork}' but the configured network is ` +
            `'${configuredNetwork}'. Refusing to start: mixing chains in one database corrupts ` +
            `indexed and verification data. Use a separate database file per network (set ` +
            `NIGHTGATE_DB_PATH), or, to deliberately rebind an EMPTY/expendable database, delete it ` +
            `and redeploy.`
        );
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
        // No network stored yet. An empty database gets the configured network.
        // A database with blocks needs NIGHTGATE_ASSUME_DB_NETWORK, so data from another chain cannot slip in.
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
        // SyncState can be read over OData, so remove credentials from the stored URL.
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
                // Readable over OData, so never store URL credentials.
                nodeUrl: redactUrlCredentials(nodeUrl || configuredNodeUrl || ''),
                chainHeight: 0,
                consecutiveErrors: 0
            }));
        } catch (err: unknown) {
            // Another caller inserted the row first.
            if (!/unique constraint|duplicate key/i.test(formatErr(err))) throw err;
        }
    }
}
