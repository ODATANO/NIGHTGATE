import cds from '@sap/cds';
import { NightgateError, errorMessage } from '../srv/utils/errors';

import { startCrawler, stopCrawler } from '../srv/crawler/index';
import { pendingReindexHeight, startReindex } from '../srv/crawler/reindex';
import {
    isNightgateConfigured,
    resolveNightgateRuntimeConfig,
    crawlerStartConfig,
    missingEndpointsMessage,
    warnIfRetiredSettingsSet,
    warnIfFormerConfigKeys,
    resolveEffectiveProvingMode,
    resolveProofTimeoutMs,
    VALID_NIGHTGATE_NETWORKS,
    getNightgateConfig,
    isCloseSessionsOnRestartEnabled,
    DEFAULT_NETWORK
} from '../srv/utils/nightgate-config';
import { loadRegistryFromConfig, listRegisteredContracts } from '../srv/submission/contract-registry';
import { loadPersistedRegistrations } from '../srv/submission/contract-registrations';
import { refreshLearnedTokenTypes } from '../srv/submission/learned-token-types';
import { retireOffersForOneTaker } from '../srv/submission/swap-offers';
import { backfillRowOwners, moveStoredDiffCounts, renameStoredActions, renameStoredErrorCodes, sortStoredTxValues } from '../srv/submission/job-store';
import { redactUrlCredentials } from '../srv/utils/redact-url';
import { publishRuntimeState } from '../srv/utils/runtime-state';
import { ensureSyncStateSingleton } from '../srv/utils/sync-state';
import { closeSessionsFromPreviousProcess, adoptStoredSpellings } from '../srv/sessions/wallet-sessions';
import { getConfiguredFeeSponsorSessions, prewarmFeeSponsorPool, rewarmSponsorsAfterWorkerExit } from '../srv/submission/fee-sponsor';
import { isNodeTransportError } from '../srv/utils/retry';
const log = cds.log('nightgate');
import { startWalletWorker, stopWalletWorker } from '../srv/midnight/wallet-worker-client';
import { stopDecodeWorker } from '../srv/midnight/decode-worker-client';
import { wireWorkerStateSaveSink } from '../srv/submission/wallet-facade-builder';
import { clearAllEncryptionKeys } from '../srv/submission/wallet-sync-state-store';
import { ensureIndexes, modelTables, tableColumns, KEY_CHANGES } from '../srv/utils/db-indexes';
import { findOldStoredFormats } from '../srv/utils/old-stored-formats';
import { installPostgresOrderNulls } from '../srv/utils/pg-order-nulls';
import { assertStoredKeyIdsKnown } from '../srv/utils/encryption-rewrap';
import { recoverInterruptedJobs, dropPendingJobsForClosedSessions, startBackgroundJobProcessor, stopBackgroundJobProcessor, registerChainOutcomeConfirmer } from '../srv/submission/background-jobs';
import { createHttpTxConfirmer } from '../srv/submission/chain-outcome-confirmer';
import {
    assertSupportedRuntimeTopology,
    UnsupportedRuntimeTopologyError
} from '../srv/utils/runtime-topology';
import {
    BACKGROUND_LEASE_ROLE,
    acquireInstanceLease,
    releaseInstanceLease,
    setActiveLease,
    clearActiveLease,
    fenceBackgroundWork,
    startInstanceLeaseHeartbeat
} from '../srv/utils/instance-lease';
import { configMs } from '../srv/utils/config';
import { startEventLoopWatch, stopEventLoopWatch } from '../srv/monitoring/event-loop';
import { dbPoolGauges } from '../srv/monitoring/status';

export type { NightgateConfig } from '../srv/types';
export { DEFAULT_NETWORK, DEFAULT_NODE_URLS, DEFAULT_INDEXER_URLS } from '../srv/utils/nightgate-config';

export interface NightgateIndexerStatus {
    initialized: boolean;
    crawlerEnabled: boolean;
    network?: string;
    nodeUrl?: string;
    mode: 'idle' | 'active' | 'offline';
    lastError?: string;
    /** True when the crawler's start was the only thing that failed. */
    crawlerOnly?: boolean;
    instanceId?: string;
    runtimeMode?: 'single-instance';
    replicaCount?: number;
    databaseKind?: string;
    runtimeWarnings?: string[];
}

let initialized = false;
let leaseHolder: string | undefined;
let stopLeaseHeartbeat: (() => void) | undefined;
let stopSponsorRewarm: (() => void) | undefined;
let lastStatus: NightgateIndexerStatus = {
    initialized: false,
    crawlerEnabled: false,
    mode: 'idle'
};

// Always set the status here. It is also copied to srv/, which cannot import this module.
function setLastStatus(next: NightgateIndexerStatus): void {
    lastStatus = next;
    publishRuntimeState({ initialized: next.initialized, mode: next.mode, lastError: next.lastError, crawlerOnly: next.crawlerOnly });
}


function logStartupState(state: 'stopped' | 'syncing' | 'offline', detail?: string): void {
    const suffix = detail ? ` (${detail})` : '';
    log.info(`Startup state: ${state}${suffix}`);
}

/** A required table or column is missing from the connected database. */
export class SchemaNotDeployedError extends NightgateError {
    constructor(
        public readonly missingTable: string,
        public readonly dbPath: string,
        cause: unknown
    ) {
        const causeMsg = errorMessage(cause);
        super('SCHEMA_NOT_DEPLOYED',
            `Nightgate schema is not deployed (or out of date): ` +
            `missing table or column for '${missingTable}' in ${dbPath}. ` +
            `Underlying error: ${causeMsg}. ` +
            `Fix: fresh install \`npm run deploy\`; EXISTING database ` +
            `\`node scripts/apply-schema-delta.mjs\` (additive, keeps data; pass the db ` +
            `path or set NIGHTGATE_DB_PATH).`
        );
    }
}

function resolveDbPath(): string {
    const dbCfg = cds.env.requires?.db?.credentials || cds.env.requires?.db || {};
    return dbCfg.database || dbCfg.url || 'db.sqlite';
}

// Checks that every table and column of the model exists. It never changes the schema.
async function ensureSchemaDeployed(): Promise<void> {
    const db = cds.db || await cds.connect.to('db');
    const kind = String(cds.env.requires?.db?.kind ?? '');
    const model = cds.model;
    if (!model) throw new Error('ensureSchemaDeployed: the CDS model is not loaded');
    for (const { entity, table, columns } of modelTables(model)) {
        // HANA has no catalog read here, so a read of one row stands in for it.
        if (/hana/i.test(kind)) {
            try { await db.run(cds.ql.SELECT.one.from(entity, columns)); } catch (probeErr) {
                throw new SchemaNotDeployedError(entity, resolveDbPath(), probeErr);
            }
            continue;
        }
        const present = new Set(await tableColumns(db, kind, table));
        const missing = columns.filter(column => !present.has(column.toLowerCase()));
        if (missing.length === 0) continue;
        const what = present.size === 0 ? entity : `${entity} (needs columns: ${missing.join(', ')})`;
        throw new SchemaNotDeployedError(what, resolveDbPath(), new Error(present.size === 0 ? 'the table is missing' : 'the columns are missing'));
    }
    for (const change of KEY_CHANGES) {
        if (!(await tableColumns(db, kind, change.table)).includes(change.from.toLowerCase())) continue;
        throw new SchemaNotDeployedError(`${change.entity} (its key is ${change.to})`, resolveDbPath(), new Error(`the former key column ${change.from} is still there`));
    }
    const old = await findOldStoredFormats(db, kind);
    if (old.length > 0) {
        throw new NightgateError('SCHEMA_NOT_DEPLOYED', `The database holds rows in a format this version does not read: ${old.map(o => `${o.name} (${o.rows} rows). ${o.fix}`).join(' ')}`);
    }

    // Lets PostgreSQL use the secondary indexes for sorted queries. See srv/utils/pg-order-nulls.ts.
    if (/postgres/i.test(kind)) installPostgresOrderNulls();

    // Stop if a stored seed was encrypted with an unknown key, instead of treating it as missing.
    await assertStoredKeyIdsKnown(db);
}

/** The start-up steps that write. They run once this process holds the instance lease, so a second process that only waits changes nothing. */
async function prepareDatabase(): Promise<void> {
    const db = await cds.connect.to('db');
    const created = await ensureIndexes(db, String(cds.env.requires?.db?.kind ?? ''), msg => log.warn(msg));
    log.debug(`ensured ${created} secondary index(es)`);

    const renamed = await renameStoredActions(db);
    if (renamed > 0) log.info(`Gave ${renamed} stored job(s) and grant(s) the current action names`);

    const recoded = await renameStoredErrorCodes(db);
    if (recoded > 0) log.info(`Gave ${recoded} stored job(s) and attempt(s) the current error codes`);

    const sorted = await sortStoredTxValues(db);
    if (sorted > 0) log.info(`Sorted the transaction identifier and hash of ${sorted} row(s) stored by an older version`);

    const diffCounts = await moveStoredDiffCounts(db);
    if (diffCounts > 0) log.info(`Moved the k of ${diffCounts} stored document diff(s) from threshold to its own column`);

    const owned = await backfillRowOwners(db);
    if (owned > 0) log.info(`Recorded the owner of ${owned} proof and disclosure grant row(s) from the jobs that wrote them`);

    const retiredOffers = await retireOffersForOneTaker(db);
    if (retiredOffers > 0) log.warn(`Retired ${retiredOffers} swap offer(s) posted for one taker; the board lists only offers anyone can take`);
}

/** Starts NIGHTGATE once. Status is "offline" after a failed startup step and "idle" with block indexing off. */
export async function initialize(): Promise<NightgateIndexerStatus> {
    const nightgateConfig = getNightgateConfig();
    if (!isNightgateConfigured(nightgateConfig)) {
        setLastStatus({
            initialized: false,
            crawlerEnabled: false,
            mode: 'idle'
        });
        logStartupState('stopped', 'no network configured');
        return getStatus();
    }

    if (initialized) {
        return getStatus();
    }

    const { network, nodeUrl, crawlerConfig, crawlerNodeUrl, submissionEndpoints, invalidNetwork } = resolveNightgateRuntimeConfig(nightgateConfig);
    const crawlerEnabled = crawlerConfig.enabled !== false;

    if (invalidNetwork) {
        const message = `Invalid network "${invalidNetwork}". Must be one of: ${VALID_NIGHTGATE_NETWORKS.join(', ')}. ` +
            `Refusing to start on the "${DEFAULT_NETWORK}" fallback; fix NIGHTGATE_NETWORK / cds.requires.nightgate.network.`;
        initialized = false;
        setLastStatus({
            initialized: false,
            crawlerEnabled,
            network,
            nodeUrl,
            mode: 'offline',
            lastError: message
        });
        logStartupState('offline', 'invalid network');
        throw new Error(message);
    }

    const missingEndpoints = missingEndpointsMessage(network, nodeUrl, submissionEndpoints.indexerHttpUrl);
    if (missingEndpoints) {
        initialized = false;
        setLastStatus({ initialized: false, crawlerEnabled, network, nodeUrl, mode: 'offline', lastError: missingEndpoints });
        logStartupState('offline', 'node or indexer not configured');
        throw new Error(missingEndpoints);
    }

    let runtimeTopology;
    try {
        runtimeTopology = assertSupportedRuntimeTopology(nightgateConfig);
    } catch (err) {
        const message = errorMessage(err);
        const rejected = err instanceof UnsupportedRuntimeTopologyError ? err.topology : undefined;
        initialized = false;
        setLastStatus({
            initialized: false,
            crawlerEnabled,
            network,
            nodeUrl,
            mode: 'offline',
            lastError: message,
            instanceId: rejected?.instanceId,
            runtimeMode: rejected?.runtimeMode,
            replicaCount: rejected?.replicaCount,
            databaseKind: rejected?.databaseKind,
            runtimeWarnings: rejected?.warnings
        });
        logStartupState('offline', 'unsupported runtime topology');
        throw err;
    }
    log.info(
        `Runtime topology accepted: instanceId=${runtimeTopology.instanceId}, ` +
        `mode=${runtimeTopology.runtimeMode}, replicas=${runtimeTopology.replicaCount}, database=${runtimeTopology.databaseKind}`
    );
    for (const warning of runtimeTopology.warnings) log.warn(warning);
    const topologyStatus = {
        instanceId: runtimeTopology.instanceId,
        runtimeMode: runtimeTopology.runtimeMode,
        replicaCount: runtimeTopology.replicaCount,
        databaseKind: runtimeTopology.databaseKind,
        runtimeWarnings: runtimeTopology.warnings
    };

    try {
        await ensureSchemaDeployed();
    } catch (err) {
        const message = errorMessage(err);
        initialized = false;
        setLastStatus({
            initialized: false,
            crawlerEnabled,
            network,
            nodeUrl,
            mode: 'offline',
            lastError: message,
            ...topologyStatus
        });
        logStartupState('offline', 'schema unavailable');
        throw err;
    }

    // Refuse to start if the database was filled from another network.
    try {
        const db = await cds.connect.to('db');
        await ensureSyncStateSingleton(db);
    } catch (err) {
        const message = errorMessage(err);
        initialized = false;
        setLastStatus({
            initialized: false,
            crawlerEnabled,
            network,
            nodeUrl,
            mode: 'offline',
            lastError: message,
            ...topologyStatus
        });
        logStartupState('offline', 'network/database binding rejected');
        throw err;
    }

    // Only one process per database may run jobs and indexing. This lease makes sure of that.
    try {
        const db = await cds.connect.to('db');
        const ttlMs = configMs('NIGHTGATE_INSTANCE_LEASE_TTL_MS');
        const holder = `${runtimeTopology.instanceId}/${process.pid}`;
        await acquireInstanceLease(db, BACKGROUND_LEASE_ROLE, holder, ttlMs, {
            onWait: (other, waitMs) => log.warn(`Instance lease held by ${other}; waiting up to ${Math.round(waitMs / 1000)} s for it to expire`)
        });
        leaseHolder = holder;
        setActiveLease(BACKGROUND_LEASE_ROLE, holder);
        stopLeaseHeartbeat = startInstanceLeaseHeartbeat(db, BACKGROUND_LEASE_ROLE, holder, Math.floor(ttlMs / 3), () => {
            onInstanceLeaseLost(holder);
        }, err => log.warn(`Instance lease heartbeat failed: ${errorMessage(err)}`));
    } catch (err) {
        const message = errorMessage(err);
        initialized = false;
        setLastStatus({
            initialized: false,
            crawlerEnabled,
            network,
            nodeUrl,
            mode: 'offline',
            lastError: message,
            ...topologyStatus
        });
        logStartupState('offline', 'instance lease held by another process');
        throw err;
    }

    // The job reconciliation and the crawler find rows by hash, so the stored hashes get one spelling first.
    try {
        await prepareDatabase();
    } catch (err) {
        const message = errorMessage(err);
        initialized = false;
        setLastStatus({
            initialized: false,
            crawlerEnabled,
            network,
            nodeUrl,
            mode: 'offline',
            lastError: message,
            ...topologyStatus
        });
        logStartupState('offline', 'database not prepared');
        throw err;
    }

    // Before any job or wallet opens an account: the stored viewing keys get one spelling, so one key is one account.
    try {
        const adopted = await adoptStoredSpellings(await cds.connect.to('db'));
        if (adopted > 0) log.info(`Rewrote ${adopted} stored viewing key(s) to lowercase and moved their accounts`);
    } catch (err) {
        log.error(`Stored viewing keys were not checked for their spelling: ${errorMessage(err)}`);
    }

    // Jobs stopped before they sent anything are queued again. The others are checked against the chain.
    try {
        const recovered = await recoverInterruptedJobs();
        if (recovered > 0) {
            log.info(`Classified ${recovered} interrupted background job(s) for safe restart recovery/reconciliation`);
        }
    } catch (err) {
        const msg = errorMessage(err);
        log.warn(`Background-job recovery skipped: ${msg}`);
    }

    // After a crash, wallet sessions of the old process would stay open until they expire.
    // Close them so no wallet seed outlives the process it was given to.
    if (isCloseSessionsOnRestartEnabled(nightgateConfig)) {
        try {
            const db = await cds.connect.to('db');
            const closed = await closeSessionsFromPreviousProcess(db, nightgateConfig);
            if (closed.length > 0) {
                log.info(`Closed ${closed.length} wallet session(s) left by the previous process; callers reconnect with connectWallet`);
                const dropped = await dropPendingJobsForClosedSessions(closed);
                if (dropped > 0) {
                    log.info(`Dropped ${dropped} queued job(s) whose signing session was closed on restart (PROCESS_RESTART_SESSION_CLOSED)`);
                }
            }
        } catch (err) {
            const msg = errorMessage(err);
            log.warn(`Wallet-session restart cleanup skipped: ${msg}`);
        }
    }

    let submissionStartupError: string | undefined;

    try {
        loadRegistryFromConfig(nightgateConfig);
        const refs = listRegisteredContracts();
        if (refs.length) {
            log.info(`Registered contracts: ${refs.join(', ')}`);
        }
        await loadPersistedRegistrations(cds.db || await cds.connect.to('db'));
        const learned = await refreshLearnedTokenTypes(cds.db || await cds.connect.to('db'));
        if (learned.length) log.info(`Learned token types: ${learned.length}`);
    } catch (regErr) {
        const msg = errorMessage(regErr);
        log.warn(`Contract registry load warning: ${msg}`);
    }

    // Set in the environment so the worker thread reads the same values.
    const provingMode = resolveEffectiveProvingMode(nightgateConfig);
    process.env.NIGHTGATE_PROVING_MODE = provingMode;
    const proofTimeoutMs = resolveProofTimeoutMs(nightgateConfig);
    process.env.NIGHTGATE_PROOF_TIMEOUT_MS = String(proofTimeoutMs);
    log.info(`Proving mode: ${provingMode}` + (provingMode === 'wasm'
        ? ' (in-process; set NIGHTGATE_PROOF_SERVER_URL or NIGHTGATE_PROVING_MODE=server for a proof server)'
        : ` (proof server at ${submissionEndpoints.proofServerUrl}, proof request timeout ${proofTimeoutMs} ms)`));

    try {
        await startWalletWorker();
        wireWorkerStateSaveSink();
        await startBackgroundJobProcessor();
        // The only way submitted jobs learn whether they landed on chain.
        registerChainOutcomeConfirmer(createHttpTxConfirmer({ indexerHttpUrl: submissionEndpoints.indexerHttpUrl }));
        warnIfRetiredSettingsSet(nightgateConfig);
        warnIfFormerConfigKeys(nightgateConfig);
        log.info(`Indexer chain-outcome confirmation enabled${crawlerEnabled ? ' (alongside the crawler)' : ' (crawler off)'}`);
        log.info('Wallet worker thread ready');
        const pool = getConfiguredFeeSponsorSessions(nightgateConfig);
        if (pool.length > 0) {
            log.info(`Sponsor pool: warming ${pool.length} sponsor facade(s) in the background`);
            const prewarm = {
                db: cds.db,
                config: nightgateConfig,
                facadeConfig: {
                    networkId: network,
                    indexerHttpUrl: submissionEndpoints.indexerHttpUrl,
                    indexerWsUrl: submissionEndpoints.indexerWsUrl,
                    proofServerUrl: submissionEndpoints.proofServerUrl,
                    relayUrl: nodeUrl
                },
                log
            };
            stopSponsorRewarm = rewarmSponsorsAfterWorkerExit(prewarm);
            void prewarmFeeSponsorPool(prewarm).catch(err => log.warn(`Sponsor pool prewarm aborted: ${errorMessage(err)}`));
        }
    } catch (err) {
        const msg = errorMessage(err);
        log.warn(`Wallet worker startup failed: ${msg}`);
        log.warn('Signing-related operations will fail until restart');
        submissionStartupError = `submission pipeline did not start: ${msg}`;
    }

    log.info(`Network: ${network}`);
    log.info(`Node: ${redactUrlCredentials(nodeUrl)}`);

    let mode: NightgateIndexerStatus['mode'] = crawlerEnabled ? 'active' : 'idle';
    let lastError: string | undefined = submissionStartupError;
    if (submissionStartupError) mode = 'offline';
    let crawlerOnly = false;

    if (crawlerEnabled) {
        try {
            const start = () => startCrawler(crawlerStartConfig({ crawlerConfig, crawlerNodeUrl }));
            const openReindex = await pendingReindexHeight(cds.db);
            if (openReindex !== null) {
                log.warn(`A reindex from ${openReindex} was interrupted. It finishes first, then the crawler starts.`);
                startReindex(cds.db, openReindex, { stop: async () => true, start })
                    .catch(err => log.error(`Interrupted reindex did not finish: ${errorMessage(err)}`));
                logStartupState('stopped', 'finishing an interrupted reindex');
            } else {
                log.info('Initializing crawler and starting catch-up...');
                await start();
                logStartupState('syncing', 'crawler started');
            }
        } catch (err) {
            // Offline for the crawler alone ends when an operator starts the crawler. A failed submission start does not.
            crawlerOnly = !submissionStartupError;
            lastError = errorMessage(err);
            mode = 'offline';
            if (isNodeTransportError(err)) {
                log.warn(`Node not reachable at ${redactUrlCredentials(crawlerNodeUrl)}: ${lastError}`);
                logStartupState('offline', 'node unreachable');
                log.info('Running in offline mode. Start a Midnight node: docker compose -f docker/docker-compose.yml up -d');
            } else {
                log.warn(`Crawler startup failed: ${lastError}`);
                logStartupState('offline', 'startup error');
                log.info('Running in offline mode until the startup error is resolved');
            }
        }
    } else {
        logStartupState('stopped', 'crawler disabled');
    }

    startEventLoopWatch({ log, poolGauges: () => dbPoolGauges(cds.db) });

    initialized = true;
    setLastStatus({
        initialized,
        crawlerEnabled,
        network,
        nodeUrl,
        mode,
        lastError,
        crawlerOnly,
        ...topologyStatus
    });

    return getStatus();
}

/** Called when another process took over the lease. Stops all jobs and writes, and keeps running offline. */
function onInstanceLeaseLost(holder: string): void {
    fenceBackgroundWork();
    log.error(`Instance lease of ${holder} was taken over by another instance; job dispatch, write actions and broadcasts are refused, job loops and crawler stop`);
    stopBackgroundJobProcessor();
    void stopCrawler().catch(err => log.warn(`Crawler stop error: ${errorMessage(err)}`));
    setLastStatus({ ...lastStatus, mode: 'offline', lastError: 'instance lease taken over by another process' });
}

/** Stops NIGHTGATE. Calling it again does nothing. */
export async function shutdown(): Promise<void> {
    stopEventLoopWatch();
    stopBackgroundJobProcessor();
    stopLeaseHeartbeat?.();
    stopLeaseHeartbeat = undefined;
    stopSponsorRewarm?.();
    stopSponsorRewarm = undefined;
    registerChainOutcomeConfirmer(null);
    // The wallet stop runs beside the crawler stop, so a slow crawler never costs the final wallet saves.
    const timed = async (name: string, stop: () => Promise<void>): Promise<void> => {
        const startedAt = Date.now();
        try {
            await stop();
        } catch (err) {
            log.warn(`${name} stop error: ${errorMessage(err)}`);
            if (name === 'Crawler') setLastStatus({ ...lastStatus, lastError: errorMessage(err) });
        }
        log.info(`${name} stopped after ${Date.now() - startedAt} ms`);
    };
    await Promise.all([
        timed('Crawler', () => stopCrawler()),
        timed('Wallet worker', () => stopWalletWorker())
    ]);
    try {
        await stopDecodeWorker();
    } catch (err) {
        log.warn(`Decode worker stop error: ${errorMessage(err)}`);
    }
    if (leaseHolder) {
        try {
            await releaseInstanceLease(await cds.connect.to('db'), BACKGROUND_LEASE_ROLE, leaseHolder);
        } catch (err) {
            log.warn(`Instance lease release error: ${errorMessage(err)}`);
        }
        leaseHolder = undefined;
        clearActiveLease();
    }
    try {
        // Only after the worker stopped, because the worker may still save encrypted state.
        await clearAllEncryptionKeys();
    } catch (err) {
        const message = errorMessage(err);
        log.warn(`Encryption key cleanup error: ${message}`);
    }
    initialized = false;
    setLastStatus({
        ...lastStatus,
        initialized: false,
        mode: 'idle'
    });
}

/** The last known status, with credentials removed from the node URL. */
export function getStatus(): NightgateIndexerStatus {
    return { ...lastStatus, nodeUrl: redactUrlCredentials(lastStatus.nodeUrl) || undefined };
}
