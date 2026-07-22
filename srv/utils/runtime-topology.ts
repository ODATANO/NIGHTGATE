import crypto from 'node:crypto';
import cds from '@sap/cds';
import type { NightgatePluginConfig } from './nightgate-config';

export const NIGHTGATE_RUNTIME_MODE = 'single-instance' as const;

const instanceId = (
    process.env.NIGHTGATE_INSTANCE_ID
    || process.env.CF_INSTANCE_GUID
    || process.env.HOSTNAME
    || crypto.randomUUID()
).trim();

export interface RuntimeTopology {
    instanceId: string;
    runtimeMode: typeof NIGHTGATE_RUNTIME_MODE;
    replicaCount: number;
    multitenancy: boolean;
    databaseKind: string;
    valid: boolean;
    errors: string[];
    warnings: string[];
}

export class UnsupportedRuntimeTopologyError extends Error {
    constructor(public readonly topology: RuntimeTopology) {
        super(`Unsupported Nightgate runtime topology: ${topology.errors.join(' ')}`);
        this.name = 'UnsupportedRuntimeTopologyError';
    }
}

function positiveInteger(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
    if (typeof value !== 'string' || !value.trim()) return undefined;
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function configuredReplicaCount(config: NightgatePluginConfig): number {
    // NB: WEB_CONCURRENCY is deliberately NOT consulted — it counts HTTP worker
    // processes within one instance (Puma/Heroku convention), not replicas of
    // this stateful service, so reading it would false-positive abort a single
    // instance that happens to set it.
    return positiveInteger(process.env.NIGHTGATE_REPLICA_COUNT)
        ?? positiveInteger(process.env.CF_INSTANCE_COUNT)
        ?? positiveInteger(process.env.KUBERNETES_REPLICA_COUNT)
        ?? positiveInteger(config.replicaCount)
        ?? 1;
}

/**
 * Cloud Foundry sets CF_INSTANCE_INDEX (0-based) per running instance — unlike
 * CF_INSTANCE_COUNT/KUBERNETES_REPLICA_COUNT, which the platforms do NOT inject
 * automatically. Any index > 0 means CF actually scaled Nightgate to multiple
 * instances, so THIS instance must not run the crawler/wallet/jobs. This is the
 * only signal that catches an accidental scale-out (where the operator forgot to
 * declare replicaCount). Returns undefined when not on CF or malformed.
 */
function cfInstanceIndex(): number | undefined {
    const raw = process.env.CF_INSTANCE_INDEX;
    if (raw == null || !String(raw).trim()) return undefined;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 ? n : undefined;
}

function multitenancyEnabled(): boolean {
    const requires = (cds.env as any).requires ?? {};
    const configured = requires.multitenancy;
    if (configured === true) return true;
    if (configured && typeof configured === 'object' && configured.enabled !== false) return true;
    return process.env.CDS_MULTITENANCY === 'true';
}

function productionMode(): boolean {
    const profiles = (cds.env as any).profiles;
    return process.env.NODE_ENV === 'production'
        || (Array.isArray(profiles) && profiles.includes('production'))
        || (profiles instanceof Set && profiles.has('production'));
}

function databaseKind(): string {
    const db = (cds.env as any).requires?.db ?? {};
    if (db.kind) return String(db.kind);
    const impl = String(db.impl ?? '');
    if (impl.includes('@cap-js/sqlite')) return 'sqlite';
    if (impl.includes('@cap-js/postgres')) return 'postgres';
    if (impl.includes('@cap-js/hana')) return 'hana';
    return 'unknown';
}

function allowProductionSqlite(config: NightgatePluginConfig): boolean {
    return process.env.NIGHTGATE_ALLOW_PRODUCTION_SQLITE === 'true'
        || config.allowProductionSqlite === true;
}

export function getRuntimeTopology(config: NightgatePluginConfig = {}): RuntimeTopology {
    const requestedMode = config.runtimeMode ?? NIGHTGATE_RUNTIME_MODE;
    const replicaCount = configuredReplicaCount(config);
    const multitenancy = multitenancyEnabled();
    const dbKind = databaseKind();
    const errors: string[] = [];
    const warnings: string[] = [];

    if (requestedMode !== NIGHTGATE_RUNTIME_MODE) {
        errors.push(`runtimeMode '${String(requestedMode)}' is unsupported; use '${NIGHTGATE_RUNTIME_MODE}'.`);
    }
    if (replicaCount !== 1) {
        errors.push(`replicaCount is ${replicaCount}; the current crawler, wallet cache and job scheduler require exactly one replica.`);
    }
    const cfIndex = cfInstanceIndex();
    if (cfIndex != null && cfIndex > 0) {
        errors.push(`CF_INSTANCE_INDEX is ${cfIndex}; Cloud Foundry scaled Nightgate to multiple instances. Only instance 0 may run the crawler, wallet cache and job scheduler — scale to a single instance.`);
    }
    if (multitenancy) {
        errors.push('CAP multitenancy is enabled, but Nightgate background work does not yet persist and restore tenant context.');
    }
    if (productionMode() && dbKind === 'sqlite') {
        const message = 'SQLite is unsupported in production; configure PostgreSQL or SAP HANA.';
        if (allowProductionSqlite(config)) {
            warnings.push(`${message} NIGHTGATE_ALLOW_PRODUCTION_SQLITE=true is active as an emergency compatibility override.`);
        } else {
            errors.push(`${message} Set NIGHTGATE_ALLOW_PRODUCTION_SQLITE=true only for a temporary, single-instance migration window.`);
        }
    }

    return {
        instanceId,
        runtimeMode: NIGHTGATE_RUNTIME_MODE,
        replicaCount,
        multitenancy,
        databaseKind: dbKind,
        valid: errors.length === 0,
        errors,
        warnings
    };
}

export function assertSupportedRuntimeTopology(config: NightgatePluginConfig = {}): RuntimeTopology {
    const topology = getRuntimeTopology(config);
    if (!topology.valid) throw new UnsupportedRuntimeTopologyError(topology);
    return topology;
}
