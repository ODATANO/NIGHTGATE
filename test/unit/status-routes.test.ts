/**
 * src/status-routes.ts: the plain metrics/health/ready routes.
 *
 * They exist because the OData functions cannot be consumed by the tools that
 * want this data: getMetrics() arrives wrapped as {"value": "# HELP ..."},
 * and a probe cannot spell `/api/v1/indexer/getReadiness()`.
 *
 * Two properties matter as much as the payloads. These routes are mounted in
 * the bootstrap event, BEFORE CAP attaches its auth middlewares, so nothing
 * that protects the OData surface protects them: they are fail-closed and
 * mount only once the operator has said how they may be reached. And NIGHTGATE
 * is a plugin in someone else's express app, where CAP registers its own
 * `/health` right after bootstrap, so everything lives under a prefix instead
 * of squatting on generic host paths.
 */

const mockCdsDb = vi.hoisted(() => ({ current: null as any }));

vi.mock('@sap/cds', () => {
    const cds: any = {
        log: (() => {
            const _c: Record<string, any> = {};
            return (name: string) => (_c[name] ??= {
                info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn()
            });
        })()
    };
    Object.defineProperty(cds, 'db', { get: () => mockCdsDb.current });
    cds.default = cds;
    return cds;
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
    mountStatusRoutes,
    resolveStatusRouteAccess,
    statusRoutePrefix,
    __setStatusModuleForTests
} from '../../src/status-routes';

const TOKEN = 'test-status-token';

/** Bare Express stand-in: collects routes so a test can drive one directly. */
function fakeApp() {
    const routes = new Map<string, (req: any, res: any) => Promise<void> | void>();
    return {
        get: (path: string, handler: any) => routes.set(path, handler),
        routes,
        async call(path: string, headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }) {
            const handler = routes.get(path);
            if (!handler) throw new Error(`route ${path} not mounted`);
            const res = fakeRes();
            await handler({ headers }, res);
            return res;
        }
    };
}

function fakeRes() {
    const res: any = {
        statusCode: null as number | null,
        headers: {} as Record<string, string>,
        contentType: null as string | null,
        body: null as unknown,
        status(code: number) { res.statusCode = code; return res; },
        set(key: string, value: string) { res.headers[key] = value; return res; },
        type(value: string) { res.contentType = value; return res; },
        send(payload: unknown) { res.body = payload; return res; },
        json(payload: unknown) { res.body = payload; return res; }
    };
    return res;
}

const STATUS_STUB = {
    buildMetricsText: vi.fn(async () => 'odatano_nightgate_chain_height 5\n'),
    buildHealth: vi.fn(async () => ({ status: 'healthy', lag: 0 })),
    buildReadiness: vi.fn(async () => ({ ready: true, checks: {} }))
} as any;

/** Mount with a token configured, the normal case for the route tests. */
function mountWithToken() {
    process.env.NIGHTGATE_STATUS_TOKEN = TOKEN;
    const app = fakeApp();
    mountStatusRoutes(app as any);
    return app;
}

beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.NIGHTGATE_STATUS_ROUTES;
    delete process.env.NIGHTGATE_STATUS_TOKEN;
    delete process.env.NIGHTGATE_STATUS_ROUTES_PREFIX;
    mockCdsDb.current = { run: vi.fn() };
    __setStatusModuleForTests(STATUS_STUB);
    STATUS_STUB.buildMetricsText.mockResolvedValue('odatano_nightgate_chain_height 5\n');
    STATUS_STUB.buildHealth.mockResolvedValue({ status: 'healthy', lag: 0 });
    STATUS_STUB.buildReadiness.mockResolvedValue({ ready: true, checks: {} });
});

afterEach(() => {
    __setStatusModuleForTests(null);
    delete process.env.NIGHTGATE_STATUS_TOKEN;
    delete process.env.NIGHTGATE_STATUS_ROUTES;
    delete process.env.NIGHTGATE_STATUS_ROUTES_PREFIX;
});

describe('mounting policy', () => {
    it('mounts NOTHING when the operator has configured nothing', () => {
        // These routes sit outside CAP authentication, so an unconfigured
        // deployment must not silently gain an anonymous HTTP surface.
        const app = fakeApp();
        mountStatusRoutes(app as any);
        expect(app.routes.size).toBe(0);
        expect(resolveStatusRouteAccess().mounted).toBe(false);
    });

    it('mounts nothing with NIGHTGATE_STATUS_ROUTES=off, even with a token set', () => {
        process.env.NIGHTGATE_STATUS_ROUTES = 'off';
        process.env.NIGHTGATE_STATUS_TOKEN = TOKEN;
        const app = fakeApp();
        mountStatusRoutes(app as any);
        expect(app.routes.size).toBe(0);
    });

    it('mounts behind a bearer token when one is configured', () => {
        const app = mountWithToken();
        expect([...app.routes.keys()].sort()).toEqual([
            '/nightgate/health',
            '/nightgate/metrics',
            '/nightgate/ready'
        ]);
    });

    it('mounts anonymously only on an explicit opt-in', () => {
        process.env.NIGHTGATE_STATUS_ROUTES = 'public';
        const app = fakeApp();
        mountStatusRoutes(app as any);
        expect(app.routes.size).toBe(3);
        const access = resolveStatusRouteAccess();
        expect(access.mounted && access.auth).toBe('public');
    });

    it('never claims a generic host path, because CAP owns /health there', () => {
        // CAP registers its own /health AFTER the bootstrap event, so a
        // handler mounted here would shadow it for the entire host app.
        const app = mountWithToken();
        for (const route of app.routes.keys()) {
            expect(route.startsWith('/nightgate/')).toBe(true);
        }
        expect(app.routes.has('/health')).toBe(false);
    });

    it('honours a custom prefix but refuses to sit at the root', () => {
        process.env.NIGHTGATE_STATUS_ROUTES_PREFIX = 'ops/';
        expect(statusRoutePrefix()).toBe('/ops');
        process.env.NIGHTGATE_STATUS_ROUTES_PREFIX = '/';
        expect(statusRoutePrefix()).toBe('/nightgate');
    });
});

describe('token enforcement', () => {
    it('refuses a request with no credentials', async () => {
        const app = mountWithToken();
        const res = await app.call('/nightgate/metrics', {});
        expect(res.statusCode).toBe(401);
        expect(STATUS_STUB.buildMetricsText).not.toHaveBeenCalled();
    });

    it('refuses a wrong token, on every route', async () => {
        const app = mountWithToken();
        for (const route of ['/nightgate/metrics', '/nightgate/health', '/nightgate/ready']) {
            const res = await app.call(route, { authorization: 'Bearer wrong-token' });
            expect(res.statusCode, route).toBe(401);
        }
    });

    it('refuses a token of a different length without leaking through the compare', async () => {
        const app = mountWithToken();
        const res = await app.call('/nightgate/metrics', { authorization: 'Bearer short' });
        expect(res.statusCode).toBe(401);
    });

    it('accepts the configured token', async () => {
        const app = mountWithToken();
        const res = await app.call('/nightgate/metrics');
        expect(res.statusCode).toBe(200);
    });
});

describe('metrics', () => {
    it('serves the exposition body as text/plain, not wrapped in JSON', async () => {
        const app = mountWithToken();
        const res = await app.call('/nightgate/metrics');
        expect(res.statusCode).toBe(200);
        expect(res.contentType).toContain('text/plain');
        expect(res.body).toBe('odatano_nightgate_chain_height 5\n');
        expect(res.headers['cache-control']).toBe('no-store');
    });

    it('answers 503 rather than zeros when the database is not connected', async () => {
        mockCdsDb.current = null;
        const app = mountWithToken();
        const res = await app.call('/nightgate/metrics');
        // A scraper must not record a fabricated zero as a real sample.
        expect(res.statusCode).toBe(503);
        expect(STATUS_STUB.buildMetricsText).not.toHaveBeenCalled();
    });

    it('answers 503 without echoing the internal error', async () => {
        STATUS_STUB.buildMetricsText.mockRejectedValue(new Error('SQLITE_BUSY at /data/nightgate.db'));
        const app = mountWithToken();
        const res = await app.call('/nightgate/metrics');
        expect(res.statusCode).toBe(503);
        expect(String(res.body)).not.toContain('/data/nightgate.db');
        expect(String(res.body)).not.toContain('SQLITE_BUSY');
    });
});

describe('health', () => {
    it('returns the getHealth payload as plain JSON', async () => {
        const app = mountWithToken();
        const res = await app.call('/nightgate/health');
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ status: 'healthy', lag: 0 });
    });

    it('reports unknown without the internal detail', async () => {
        STATUS_STUB.buildHealth.mockRejectedValue(new Error('no such table: midnight_SyncState'));
        const app = mountWithToken();
        const res = await app.call('/nightgate/health');
        expect(res.statusCode).toBe(503);
        expect(res.body).toEqual({ status: 'unknown' });
    });
});

describe('ready', () => {
    it('is 200 when ready', async () => {
        const app = mountWithToken();
        const res = await app.call('/nightgate/ready');
        expect(res.statusCode).toBe(200);
        expect((res.body as any).ready).toBe(true);
    });

    it('is 503 when not ready, because the status code is what an orchestrator reads', async () => {
        STATUS_STUB.buildReadiness.mockResolvedValue({ ready: false, checks: { database: false } });
        const app = mountWithToken();
        const res = await app.call('/nightgate/ready');
        expect(res.statusCode).toBe(503);
        // The body still explains why, for the human who asks next.
        expect((res.body as any).checks.database).toBe(false);
    });

    it('is 503 with no database rather than reporting an unknown state as ready', async () => {
        mockCdsDb.current = null;
        const app = mountWithToken();
        const res = await app.call('/nightgate/ready');
        expect(res.statusCode).toBe(503);
        expect((res.body as any).ready).toBe(false);
    });
});
