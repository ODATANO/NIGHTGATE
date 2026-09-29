import cds from '@sap/cds';
import { NightgateError } from '../srv/utils/errors';

import { startCrawler, stopCrawler } from '../srv/crawler/index';
import { ensureNightgateModelLoaded } from '../srv/utils/cds-model';
import {
    isNightgatePluginConfigured,
    resolveNightgateRuntimeConfig,
    warnIfCrawlerlessChainConfirmSet,
    resolveEffectiveProvingMode,
    resolveProofTimeoutMs,
    VALID_NIGHTGATE_NETWORKS,
    getNightgatePluginConfig,
    isCloseSessionsOnRestartEnabled,
    DEFAULT_NETWORK
} from '../srv/utils/nightgate-config';
import { loadRegistryFromConfig, listRegisteredContracts } from '../srv/submission/contract-registry';
import { loadPersistedRegistrations } from '../srv/submission/contract-registrations';
import { redactUrlCredentials } from '../srv/utils/redact-url';
import { publishRuntimeState } from '../srv/utils/runtime-state';
import { ensureSyncStateSingleton } from '../srv/utils/sync-state';
import { closeSessionsFromPreviousProcess } from '../srv/sessions/wallet-sessions';
import { getConfiguredFeeSponsorSessions, prewarmFeeSponsorPool } from '../srv/submission/fee-sponsor';
const log = cds.log('nightgate');
import { startWalletWorker, stopWalletWorker } from '../srv/midnight/wallet-worker-client';
import { wireWorkerStateSaveSink } from '../srv/submission/wallet-facade-builder';
import { clearAllEncryptionKeys } from '../srv/submission/wallet-sync-state-store';
import { ensureIndexes } from '../srv/utils/db-indexes';
import { installPostgresOrderNulls } from '../srv/utils/pg-order-nulls';
import { assertStoredKeyIdsKnown } from '../srv/utils/encryption-rewrap';
import { recoverInterruptedJobs, dropPendingJobsForClosedSessions, startBackgroundJobProcessor, stopBackgroundJobProcessor, registerChainOutcomeConfirmer } from '../srv/submission/background-jobs';
import { buildIndexerTxConfirmer } from '../srv/submission/chain-outcome-confirmer';
import { TransactionResults } from '#cds-models/midnight';
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

export type { NightgateConfig } from '../srv/types';
export { DEFAULT_NETWORK, DEFAULT_NODE_URL } from '../srv/utils/nightgate-config';

export interface NightgateIndexerStatus {
    initialized: boolean;
    crawlerEnabled: boolean;
    network?: string;
    nodeUrl?: string;
    mode: 'idle' | 'active' | 'offline';
    lastError?: string;
    instanceId?: string;
    runtimeMode?: 'single-instance';
    replicaCount?: number;
    databaseKind?: string;
    runtimeWarnings?: string[];
}

let initialized = false;
// Lease holder id: the topology's instance plus the pid, so two processes on one host differ.
let leaseHolder: string | undefined;
let stopLeaseHeartbeat: (() => void) | undefined;
let lastStatus: NightgateIndexerStatus = {
    initialized: false,
    crawlerEnabled: false,
    mode: 'idle'
};

// Single write path: also publishes to srv/'s runtime-state holder, since srv/
// cannot import this module without an import cycle.
function setLastStatus(next: NightgateIndexerStatus): void {
    lastStatus = next;
    publishRuntimeState({ initialized: next.initialized, mode: next.mode, lastError: next.lastError });
}

function isLikelyNodeConnectionError(message: string): boolean {
    return /ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|socket hang up|WebSocket|Not connected to Midnight Node/i.test(message);
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
        const causeMsg = cause instanceof Error ? cause.message : String(cause);
        super('SCHEMA_NOT_DEPLOYED',
            `Nightgate schema is not deployed (or out of date): ` +
            `missing table or column for '${missingTable}' in ${dbPath}. ` +
            `Underlying error: ${causeMsg}. ` +
            `Fix: fresh install \`npm run deploy\`; EXISTING database ` +
            `\`node scripts/apply-schema-delta.mjs\` (installed package: ` +
            `\`npx nightgate-schema-delta\`; additive, keeps data; pass the db ` +
            `path or set NIGHTGATE_DB_PATH).`
        );
    }
}

function resolveDbPath(): string {
    const dbCfg = (cds.env as any).requires?.db?.credentials || (cds.env as any).requires?.db || {};
    return dbCfg.database || dbCfg.url || 'db.sqlite';
}

// Probes tables and columns only, never deploys: the operator migrates explicitly.
async function ensureSchemaDeployed(): Promise<void> {
    const requiredTables: Array<{ table: string; columns?: string[] }> = [
        { table: 'midnight.Blocks' },
        { table: 'midnight.SyncState' },
        { table: 'midnight.PendingSubmissions', columns: ['submitIntentData'] },
        { table: 'midnight.TransactionResults' },
        { table: 'midnight.PrivateStates' },
        { table: 'midnight.ContractSigningKeys' },
        { table: 'midnight.WalletSyncStates' },
        { table: 'midnight.Attestations' },
        { table: 'midnight.Documents', columns: ['userId', 'contractAddress', 'network', 'compiledArtifactRef', 'artifactDigest', 'sessionId', 'attesterId'] },
        { table: 'midnight.PredicateAttestations', columns: ['payloadHashB', 'allowedMask', 'network', 'compiledArtifactRef', 'artifactDigest', 'attesterId', 'attesterIdB'] },
        { table: 'midnight.DisclosureRoles' },
        { table: 'midnight.DisclosureGrants', columns: ['pendingLevel', 'attesterId', 'changedAtHeight'] },
        { table: 'midnight.BackgroundJobs', columns: ['chainSegments'] },
        { table: 'midnight.WalletSessions', columns: ['label'] },
        { table: 'midnight.AgentGrants', columns: ['allowedContracts', 'allowedCircuits', 'allowDeploy', 'maxDeploys', 'deploysUsed', 'deployedContracts', 'allowedTokenTypes', 'mintedTokenTypes'] },
        { table: 'midnight.ContractRegistrations' },
        { table: 'midnight.ContractActions', columns: ['stateHash', 'stateSize', 'zswapStateHash', 'zswapStateSize'] },
        { table: 'midnight.ContractStates' },
        { table: 'midnight.InstanceLeases' }
    ];

    const db = cds.db || await cds.connect.to('db');
    const { SELECT } = cds.ql;

    for (const { table, columns } of requiredTables) {
        try {
            await db.run(columns ? SELECT.one.from(table, columns) : SELECT.one.from(table));
        } catch (probeErr) {
            const what = columns ? `${table} (needs columns: ${columns.join(', ')})` : table;
            throw new SchemaNotDeployedError(what, resolveDbPath(), probeErr);
        }
    }

    const dbKind = String((cds.env as any).requires?.db?.kind ?? '');
    // ORDER BY without a NULLS clause on key / NOT NULL columns, so the indexes
    // below serve `$top`, `$orderby` and latest() (srv/utils/pg-order-nulls.ts).
    if (/postgres/i.test(dbKind)) installPostgresOrderNulls();
    const created = await ensureIndexes(db as any, dbKind, msg => log.warn(msg));
    log.debug(`ensured ${created} secondary index(es)`);

    // Fail closed: an unreadable seed must not pass as a missing one.
    await assertStoredKeyIdsKnown(db as any);

    const removed = await db.run(
        cds.ql.DELETE.from(TransactionResults).where({ outcomeSource: null })
    );
    const removedCount = typeof removed === 'number' ? removed : Number((removed as any)?.changes ?? 0);
    if (removedCount > 0) log.warn(`Removed ${removedCount} legacy unverified TransactionResults row(s); re-crawl historical blocks to backfill canonical outcomes`);
}

/**
 * Initialize Nightgate; idempotent. Status is "offline" when a startup step
 * failed, "idle" when the crawler is disabled.
 */
export async function initialize(): Promise<NightgateIndexerStatus> {
    await ensureNightgateModelLoaded();

    const nightgateConfig = getNightgatePluginConfig();
    if (!isNightgatePluginConfigured(nightgateConfig)) {
        setLastStatus({
            initialized: false,
            crawlerEnabled: false,
            mode: 'idle'
        });
        logStartupState('stopped', 'plugin not configured');
        return getStatus();
    }

    if (initialized) {
        return getStatus();
    }

    const { network, nodeUrl, crawlerConfig, crawlerNodeUrl, submissionEndpoints, invalidNetwork } = resolveNightgateRuntimeConfig(nightgateConfig);
    const crawlerEnabled = (crawlerConfig as any).enabled !== false;

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

    let runtimeTopology;
    try {
        runtimeTopology = assertSupportedRuntimeTopology(nightgateConfig);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
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

    try {
        await ensureSchemaDeployed();
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        initialized = false;
        setLastStatus({
            initialized: false,
            crawlerEnabled,
            network,
            nodeUrl,
            mode: 'offline',
            lastError: message,
            instanceId: runtimeTopology.instanceId,
            runtimeMode: runtimeTopology.runtimeMode,
            replicaCount: runtimeTopology.replicaCount,
            databaseKind: runtimeTopology.databaseKind,
            runtimeWarnings: runtimeTopology.warnings
        });
        logStartupState('offline', 'schema unavailable');
        throw err;
    }

    // Network/database binding: fail closed, before anything reads or writes jobs.
    try {
        const db = await cds.connect.to('db');
        await ensureSyncStateSingleton(db);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        initialized = false;
        setLastStatus({
            initialized: false,
            crawlerEnabled,
            network,
            nodeUrl,
            mode: 'offline',
            lastError: message
        });
        logStartupState('offline', 'network/database binding rejected');
        throw err;
    }

    // One process per database runs recovery, sessions cleanup, job loops and crawler.
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
        }, err => log.warn(`Instance lease heartbeat failed: ${err instanceof Error ? err.message : String(err)}`));
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        initialized = false;
        setLastStatus({
            initialized: false,
            crawlerEnabled,
            network,
            nodeUrl,
            mode: 'offline',
            lastError: message
        });
        logStartupState('offline', 'instance lease held by another process');
        throw err;
    }

    // Asymmetric: only commands interrupted before the external boundary requeue.
    try {
        const recovered = await recoverInterruptedJobs();
        if (recovered > 0) {
            log.info(`Classified ${recovered} interrupted background job(s) for safe restart recovery/reconciliation`);
        }
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`Background-job recovery skipped: ${msg}`);
    }

    // An ungraceful stop leaks sessions for their full TTL; close them so no
    // seed material outlives the process that authorised it.
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
            const msg = err instanceof Error ? err.message : String(err);
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
        // Runtime registrations go on top of the config floor.
        await loadPersistedRegistrations(cds.db || await cds.connect.to('db'));
    } catch (regErr) {
        const msg = regErr instanceof Error ? regErr.message : String(regErr);
        log.warn(`Contract registry load warning: ${msg}`);
    }

    // Pinned into the env before the worker spawns: the worker reads only env.
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
        // The only chain-evidence path for submitted jobs: always registered.
        registerChainOutcomeConfirmer(buildIndexerTxConfirmer({ indexerHttpUrl: submissionEndpoints.indexerHttpUrl }));
        warnIfCrawlerlessChainConfirmSet(nightgateConfig);
        log.info(`Indexer chain-outcome confirmation enabled${crawlerEnabled ? ' (alongside the crawler)' : ' (crawler off)'}`);
        log.info('Wallet worker thread ready');
        const pool = getConfiguredFeeSponsorSessions(nightgateConfig);
        if (pool.length > 0) {
            log.info(`Sponsor pool: warming ${pool.length} sponsor facade(s) in the background`);
            void prewarmFeeSponsorPool({
                db: cds.db,
                config: nightgateConfig,
                facadeConfig: {
                    networkId: network as any,
                    indexerHttpUrl: submissionEndpoints.indexerHttpUrl,
                    indexerWsUrl: submissionEndpoints.indexerWsUrl,
                    proofServerUrl: submissionEndpoints.proofServerUrl,
                    relayUrl: nodeUrl
                },
                log
            }).catch(err => log.warn(`Sponsor pool prewarm aborted: ${err instanceof Error ? err.message : String(err)}`));
        }
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`Wallet worker startup failed: ${msg}`);
        log.warn('Signing-related operations will fail until restart');
        submissionStartupError = `submission pipeline did not start: ${msg}`;
    }

    log.info(`Network: ${network}`);
    log.info(`Node: ${redactUrlCredentials(nodeUrl)}`);

    let mode: NightgateIndexerStatus['mode'] = crawlerEnabled ? 'active' : 'idle';
    let lastError: string | undefined = submissionStartupError;
    if (submissionStartupError) mode = 'offline';

    if (crawlerEnabled) {
        try {
            log.info('Initializing crawler and starting catch-up...');
            await startCrawler({
                ...(crawlerConfig as Record<string, unknown>),
                enabled: true,
                nodeUrl: crawlerNodeUrl,
                requestTimeout: (crawlerConfig as any).requestTimeout || 30000
            });
            logStartupState('syncing', 'crawler started');
        } catch (err) {
            lastError = err instanceof Error ? err.message : String(err);
            mode = 'offline';
            if (isLikelyNodeConnectionError(lastError)) {
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

    initialized = true;
    setLastStatus({
        initialized,
        crawlerEnabled,
        network,
        nodeUrl,
        mode,
        lastError,
        instanceId: runtimeTopology.instanceId,
        runtimeMode: runtimeTopology.runtimeMode,
        replicaCount: runtimeTopology.replicaCount,
        databaseKind: runtimeTopology.databaseKind,
        runtimeWarnings: runtimeTopology.warnings
    });

    return getStatus();
}

/**
 * Another process took the lease over: no dispatch, no write action and no broadcast
 * from here on (in-flight calls stop at their boundary check); the process stays up offline.
 */
function onInstanceLeaseLost(holder: string): void {
    fenceBackgroundWork();
    log.error(`Instance lease of ${holder} was taken over by another instance; job dispatch, write actions and broadcasts are refused, job loops and crawler stop`);
    stopBackgroundJobProcessor();
    void stopCrawler().catch(err => log.warn(`Crawler stop error: ${err instanceof Error ? err.message : String(err)}`));
    setLastStatus({ ...lastStatus, mode: 'offline', lastError: 'instance lease taken over by another process' });
}

/** Shut down Nightgate; idempotent. Status is "idle" afterwards. */
export async function shutdown(): Promise<void> {
    stopBackgroundJobProcessor();
    stopLeaseHeartbeat?.();
    stopLeaseHeartbeat = undefined;
    registerChainOutcomeConfirmer(null);
    try {
        await stopCrawler();
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn(`Crawler stop error: ${message}`);
        setLastStatus({
            ...lastStatus,
            lastError: message
        });
    }
    try {
        await stopWalletWorker();
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn(`Wallet worker stop error: ${message}`);
    }
    if (leaseHolder) {
        try {
            await releaseInstanceLease(await cds.connect.to('db'), BACKGROUND_LEASE_ROLE, leaseHolder);
        } catch (err) {
            log.warn(`Instance lease release error: ${err instanceof Error ? err.message : String(err)}`);
        }
        leaseHolder = undefined;
        clearActiveLease();
    }
    try {
        // After the worker stop: no save can arrive that needs a key.
        await clearAllEncryptionKeys();
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn(`Encryption key cleanup error: ${message}`);
    }
    initialized = false;
    setLastStatus({
        ...lastStatus,
        initialized: false,
        mode: 'idle'
    });
}

/** Last known status, node URL credentials redacted. */
export function getStatus(): NightgateIndexerStatus {
    return { ...lastStatus, nodeUrl: redactUrlCredentials(lastStatus.nodeUrl) || undefined };
}
