import cds from '@sap/cds';
import { NightgateError } from './errors';
import { isUniqueViolation } from './db-errors';
const { SELECT, INSERT } = cds.ql;

import { SyncState } from '#cds-models/midnight';
import { getConfiguredNightgateNodeUrl, resolveNightgateRuntimeConfig, getNightgateConfig } from './nightgate-config';
import { redactUrlCredentials } from './redact-url';


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

/** The node's finalized chain has another block than the index at one height. The crawler stores only finalized blocks, so that is another chain. */
export class SyncStateChainMismatchError extends NightgateError {
    constructor(public readonly height: number, public readonly storedHash: string, public readonly nodeHash: string) {
        // The text must not hold a word the retry logic reads as a passing fault.
        super('SYNC_STATE_CHAIN_MISMATCH',
            `The node serves another chain than this database was indexed from: block ${height} is ${nodeHash} on the node ` +
            `and ${storedHash} in the database. Indexing stops. Check NIGHTGATE_NODE_URL. If the node is right, ` +
            `stop the server and run scripts/adopt-chain.mjs.`
        );
    }
}

export async function ensureSyncStateSingleton(db: cds.DatabaseService, nodeUrl?: string): Promise<void> {
    const existing: SyncState | null | undefined = await db.run(
        SELECT.one.from(SyncState).where({ ID: 'SINGLETON' })
    );

    if (existing) {
        const nightgateConfig = getNightgateConfig();
        const { network } = resolveNightgateRuntimeConfig(nightgateConfig);
        if (existing.network && existing.network !== network) {
            throw new SyncStateNetworkMismatchError(existing.network, network);
        }
        if (!existing.network) {
            throw new NightgateError('SYNC_STATE_NETWORK_MISMATCH', `This database records no network, so it cannot be bound to '${network}'. Index it again in an empty database.`);
        }
        return;
    }

    {
        try {
            const nightgateConfig = getNightgateConfig();
            const { network } = resolveNightgateRuntimeConfig(nightgateConfig);
            const configuredNodeUrl = getConfiguredNightgateNodeUrl(nightgateConfig);
            await db.run(INSERT.into(SyncState).entries({
                ID: 'SINGLETON',
                network,
                lastIndexedHeight: 0,
                syncStatus: 'stopped',
                // Readable over OData, so never store URL credentials.
                nodeUrl: redactUrlCredentials(nodeUrl || configuredNodeUrl || ''),
                chainHeight: 0,
                consecutiveErrors: 0
            }));
        } catch (err: unknown) {
            // Another caller inserted the row first.
            if (!isUniqueViolation(err)) throw err;
        }
    }
}
