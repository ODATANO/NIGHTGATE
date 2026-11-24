import cds from '@sap/cds';
import {
    assertSupportedRuntimeTopology,
    getRuntimeTopology,
    openAuthRefusal,
    openAuthKind,
    UnsupportedRuntimeTopologyError
} from '../../srv/utils/runtime-topology';

const ENV_KEYS = [
    'CDS_MULTITENANCY', 'CF_INSTANCE_COUNT', 'CF_INSTANCE_INDEX', 'KUBERNETES_REPLICA_COUNT',
    'NIGHTGATE_REPLICA_COUNT', 'NIGHTGATE_ALLOW_UNAUTHENTICATED', 'NODE_ENV', 'WEB_CONCURRENCY'
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

    it('SQLite with one instance is a supported way to run, in production too', () => {
        process.env.NODE_ENV = 'production';
        (cds.env as any).requires.auth = { kind: 'basic' };
        const topology = getRuntimeTopology({ replicaCount: 1 });
        expect(topology).toMatchObject({ valid: true, databaseKind: 'sqlite' });
        expect(topology.errors).toEqual([]);
        expect(topology.warnings.join(' ')).not.toMatch(/SQLite/);
    });

    it('SQLite does not lift the rule of one instance', () => {
        process.env.NODE_ENV = 'production';
        (cds.env as any).requires.auth = { kind: 'basic' };
        const topology = getRuntimeTopology({ replicaCount: 2 });
        expect(topology).toMatchObject({ valid: false, databaseKind: 'sqlite' });
        expect(topology.errors.join(' ')).toMatch(/exactly one replica/);
    });

    it('refuses dummy auth in production', () => {
        process.env.NODE_ENV = 'production';
        (cds.env as any).requires.db = { kind: 'postgres' };
        (cds.env as any).requires.auth = { kind: 'dummy' };
        const topology = getRuntimeTopology({ replicaCount: 1 });
        expect(topology.valid).toBe(false);
        expect(topology.errors.join(' ')).toMatch(/'dummy'.*refused in production/);
    });

    it('allows dummy auth in production only through NIGHTGATE_ALLOW_UNAUTHENTICATED, with a warning', () => {
        process.env.NODE_ENV = 'production';
        process.env.NIGHTGATE_ALLOW_UNAUTHENTICATED = 'true';
        (cds.env as any).requires.db = { kind: 'postgres' };
        (cds.env as any).requires.auth = { kind: 'dummy' };
        const topology = getRuntimeTopology({ replicaCount: 1 });
        expect(topology.valid).toBe(true);
        expect(topology.warnings.join(' ')).toMatch(/NIGHTGATE_ALLOW_UNAUTHENTICATED=true is active/);
    });

    it('treats mocked auth like dummy: refused in production, allowed only through the override', () => {
        process.env.NODE_ENV = 'production';
        (cds.env as any).requires.db = { kind: 'postgres' };
        (cds.env as any).requires.auth = { kind: 'mocked' };
        const refused = getRuntimeTopology({ replicaCount: 1 });
        expect(refused.valid).toBe(false);
        expect(refused.errors.join(' ')).toMatch(/'mocked'.*refused in production/);

        process.env.NIGHTGATE_ALLOW_UNAUTHENTICATED = 'true';
        const allowed = getRuntimeTopology({ replicaCount: 1 });
        expect(allowed.valid).toBe(true);
        expect(allowed.warnings.join(' ')).toMatch(/'mocked'.*NIGHTGATE_ALLOW_UNAUTHENTICATED=true is active/);
    });

    it('names the reason a server must not listen only for an open auth kind in production without the override', () => {
        (cds.env as any).requires.auth = { kind: 'dummy' };
        expect(openAuthRefusal()).toBeNull();

        process.env.NODE_ENV = 'production';
        expect(openAuthRefusal()).toMatch(/'dummy' serves every request unauthenticated and privileged.*refused in production/);
        (cds.env as any).requires.auth = { kind: 'mocked' };
        expect(openAuthRefusal()).toMatch(/'mocked'/);
        (cds.env as any).requires.auth = { kind: 'basic' };
        expect(openAuthRefusal()).toBeNull();

        (cds.env as any).requires.auth = { kind: 'dummy' };
        process.env.NIGHTGATE_ALLOW_UNAUTHENTICATED = 'true';
        expect(openAuthRefusal()).toBeNull();
    });

    it('names the open auth kind in every profile, also with the override', () => {
        (cds.env as any).requires.auth = { kind: 'dummy' };
        expect(openAuthKind()).toBe('dummy');
        process.env.NODE_ENV = 'production';
        process.env.NIGHTGATE_ALLOW_UNAUTHENTICATED = 'true';
        expect(openAuthKind()).toBe('dummy');
        (cds.env as any).requires.auth = { kind: 'mocked' };
        expect(openAuthKind()).toBe('mocked');
        for (const kind of ['basic', 'jwt', 'xsuaa']) {
            (cds.env as any).requires.auth = { kind };
            expect(openAuthKind(), kind).toBeUndefined();
        }
    });

    it('leaves dummy auth alone outside production', () => {
        (cds.env as any).requires.auth = { kind: 'dummy' };
        expect(getRuntimeTopology({ replicaCount: 1 })).toMatchObject({ valid: true, warnings: [] });
    });

    it('accepts PostgreSQL in production', () => {
        process.env.NODE_ENV = 'production';
        (cds.env as any).requires.db = { kind: 'postgres', impl: '@cap-js/postgres' };
        expect(getRuntimeTopology({ replicaCount: 1 })).toMatchObject({
            valid: true, databaseKind: 'postgres', errors: []
        });
    });
});
