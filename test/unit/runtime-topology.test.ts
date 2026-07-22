import cds from '@sap/cds';
import {
    assertSupportedRuntimeTopology,
    getRuntimeTopology,
    UnsupportedRuntimeTopologyError
} from '../../srv/utils/runtime-topology';

const ENV_KEYS = [
    'CDS_MULTITENANCY', 'CF_INSTANCE_COUNT', 'CF_INSTANCE_INDEX', 'KUBERNETES_REPLICA_COUNT',
    'NIGHTGATE_REPLICA_COUNT', 'NIGHTGATE_ALLOW_PRODUCTION_SQLITE', 'NODE_ENV', 'WEB_CONCURRENCY'
] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
const originalRequires = (cds.env as any).requires;

describe('runtime topology guard', () => {
    beforeEach(() => {
        for (const key of ENV_KEYS) delete process.env[key];
        (cds.env as any).requires = { db: { kind: 'sqlite' }, nightgate: {} };
    });

    afterAll(() => {
        for (const key of ENV_KEYS) {
            const value = originalEnv[key];
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        (cds.env as any).requires = originalRequires;
    });

    it('accepts the explicit single-instance, single-tenant topology', () => {
        const topology = assertSupportedRuntimeTopology({
            runtimeMode: 'single-instance', replicaCount: 1
        });
        expect(topology).toMatchObject({
            runtimeMode: 'single-instance', replicaCount: 1,
            multitenancy: false, valid: true, errors: []
        });
        expect(topology.instanceId).toBeTruthy();
    });

    it('fails closed when more than one replica is declared', () => {
        process.env.NIGHTGATE_REPLICA_COUNT = '2';
        expect(() => assertSupportedRuntimeTopology({})).toThrow(UnsupportedRuntimeTopologyError);
        expect(getRuntimeTopology({})).toMatchObject({ replicaCount: 2, valid: false });
    });

    it('fails closed on a secondary Cloud Foundry instance (CF_INSTANCE_INDEX > 0)', () => {
        process.env.CF_INSTANCE_INDEX = '1';
        const topology = getRuntimeTopology({});
        expect(topology.valid).toBe(false);
        expect(topology.errors.join(' ')).toMatch(/CF_INSTANCE_INDEX/);
        expect(() => assertSupportedRuntimeTopology({})).toThrow(UnsupportedRuntimeTopologyError);
    });

    it('accepts the primary Cloud Foundry instance (CF_INSTANCE_INDEX = 0)', () => {
        process.env.CF_INSTANCE_INDEX = '0';
        expect(getRuntimeTopology({ replicaCount: 1 })).toMatchObject({ valid: true });
    });

    it('ignores WEB_CONCURRENCY (HTTP worker count, not a replica count)', () => {
        process.env.WEB_CONCURRENCY = '4';
        expect(getRuntimeTopology({ replicaCount: 1 })).toMatchObject({ replicaCount: 1, valid: true });
    });

    it('fails closed when CAP multitenancy is enabled', () => {
        (cds.env as any).requires.multitenancy = true;
        const topology = getRuntimeTopology({});
        expect(topology.multitenancy).toBe(true);
        expect(topology.valid).toBe(false);
        expect(topology.errors.join(' ')).toMatch(/tenant context/i);
    });

    it('fails closed for production SQLite', () => {
        process.env.NODE_ENV = 'production';
        const topology = getRuntimeTopology({ replicaCount: 1 });
        expect(topology).toMatchObject({ valid: false, databaseKind: 'sqlite' });
        expect(topology.errors.join(' ')).toMatch(/SQLite is unsupported in production/);
    });

    it('allows production SQLite only through the explicit emergency override', () => {
        process.env.NODE_ENV = 'production';
        process.env.NIGHTGATE_ALLOW_PRODUCTION_SQLITE = 'true';
        const topology = getRuntimeTopology({ replicaCount: 1 });
        expect(topology.valid).toBe(true);
        expect(topology.warnings.join(' ')).toMatch(/emergency compatibility override/);
    });

    it('accepts PostgreSQL in production', () => {
        process.env.NODE_ENV = 'production';
        (cds.env as any).requires.db = { kind: 'postgres', impl: '@cap-js/postgres' };
        expect(getRuntimeTopology({ replicaCount: 1 })).toMatchObject({
            valid: true, databaseKind: 'postgres', errors: []
        });
    });
});
