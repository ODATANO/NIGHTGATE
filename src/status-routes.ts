import crypto from 'crypto';
import cds from '@sap/cds';

// Plain HTTP status surface, so the tools that want this data can consume it:
//
//   GET <prefix>/metrics -> text/plain Prometheus exposition
//   GET <prefix>/health  -> JSON, same payload as getHealth()
//   GET <prefix>/ready   -> JSON, same payload as getReadiness(), 200 or 503
//
// `getMetrics()` returns the Prometheus body wrapped as
// `{"@odata.context":"...","value":"# HELP ..."}`, which no scraper parses,
// and a container HEALTHCHECK or Kubernetes probe cannot express
// `/api/v1/indexer/getReadiness()`. Hence plain routes.
//
// TWO THINGS THESE ROUTES MUST NOT DO, both learned the hard way:
//
// 1. They must not be anonymous by accident. They are mounted on the express
//    app during `cds.emit('bootstrap')`, which runs BEFORE CAP attaches its
//    context/auth middlewares to the service paths. So whatever protects the
//    OData surface does NOT protect these; under NODE_ENV=production, where
//    CAP restricts services by default, an unguarded route here would be a
//    genuine widening. They are therefore fail-closed: nothing is mounted
//    unless the operator has said how they may be reached.
//
// 2. They must not squat on generic host paths. NIGHTGATE is a CAP PLUGIN, so
//    the express app usually belongs to somebody else, and CAP registers its
//    own `/health` right AFTER the bootstrap event (@sap/cds/server.js). A
//    handler installed here would shadow it for the whole host, letting a
//    NIGHTGATE database problem decide a foreign app's liveness. Everything
//    is therefore namespaced under a prefix (default `/nightgate`).
//
// Configuration:
//   NIGHTGATE_STATUS_TOKEN=<secret>   mount, require `Authorization: Bearer <secret>`
//   NIGHTGATE_STATUS_ROUTES=public    mount anonymously (deliberate)
//   NIGHTGATE_STATUS_ROUTES=off       never mount
//   NIGHTGATE_STATUS_ROUTES_PREFIX=/x route prefix, default `/nightgate`
//   (neither of the first two set: nothing is mounted)
//
// The status builders are required lazily inside each handler: mounting runs
// during bootstrap, before the CDS model is loaded, and srv/monitoring/status.ts
// reaches for #cds-models. At request time the model is up.

type StatusModule = typeof import('../srv/monitoring/status');

let statusModule: StatusModule | null = null;

function loadStatus(): StatusModule {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    statusModule ??= require('../srv/monitoring/status') as StatusModule;
    return statusModule;
}

/** Test seam: lets a bare-Express harness inject a stub. */
export function __setStatusModuleForTests(mod: StatusModule | null): void {
    statusModule = mod;
}

export type StatusRouteAccess =
    | { mounted: false; reason: string }
    | { mounted: true; auth: 'token'; token: string }
    | { mounted: true; auth: 'public' };

/**
 * Fail-closed by design: an operator who has configured nothing gets no extra
 * HTTP surface, and is told once how to turn it on.
 */
export function resolveStatusRouteAccess(): StatusRouteAccess {
    const mode = String(process.env.NIGHTGATE_STATUS_ROUTES ?? '').trim().toLowerCase();
    if (mode === 'off') {
        return { mounted: false, reason: 'NIGHTGATE_STATUS_ROUTES=off' };
    }

    const token = String(process.env.NIGHTGATE_STATUS_TOKEN ?? '').trim();
    if (token) return { mounted: true, auth: 'token', token };
    if (mode === 'public') return { mounted: true, auth: 'public' };

    return {
        mounted: false,
        reason:
            'neither NIGHTGATE_STATUS_TOKEN nor NIGHTGATE_STATUS_ROUTES=public is set. ' +
            'These routes sit outside CAP authentication, so they stay unmounted until one is chosen'
    };
}

export function statusRoutePrefix(): string {
    const raw = String(process.env.NIGHTGATE_STATUS_ROUTES_PREFIX ?? '/nightgate').trim();
    const withSlash = raw.startsWith('/') ? raw : `/${raw}`;
    const trimmed = withSlash.replace(/\/+$/, '');
    // An empty prefix would put us back on the host's generic paths.
    return trimmed === '' ? '/nightgate' : trimmed;
}

/** Constant-time compare, so the token cannot be probed byte by byte. */
function tokenMatches(expected: string, presented: string): boolean {
    const a = Buffer.from(expected);
    const b = Buffer.from(presented);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

function authorised(access: StatusRouteAccess, req: any): boolean {
    if (!access.mounted) return false;
    if (access.auth === 'public') return true;
    const header = String(req?.headers?.authorization ?? '');
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    return match?.[1] ? tokenMatches(access.token, match[1].trim()) : false;
}

function db(): { run: (q: unknown) => Promise<any> } | null {
    const handle = (cds as any).db;
    return handle && typeof handle.run === 'function' ? handle : null;
}

/**
 * Errors are logged with their detail and answered without it: these routes
 * may be reachable by a scraper that is not otherwise trusted, and an
 * exception message can carry a file path or a SQL fragment.
 */
function logDetail(route: string, err: unknown): void {
    cds.log('nightgate:status').warn(`${route} failed:`, err instanceof Error ? err.message : String(err));
}

export function mountStatusRoutes(app: any): void {
    const access = resolveStatusRouteAccess();
    const log = cds.log('nightgate:status');
    if (!access.mounted) {
        log.info(`plain status routes not mounted: ${access.reason}`);
        return;
    }

    const prefix = statusRoutePrefix();
    if (access.auth === 'public') {
        log.warn(
            `plain status routes mounted ANONYMOUSLY under ${prefix} (NIGHTGATE_STATUS_ROUTES=public). ` +
            'They expose chain height, job counts, uptime and instance id to anyone who can reach the port.'
        );
    } else {
        log.info(`plain status routes mounted under ${prefix}, bearer token required`);
    }

    const guard = (handler: (req: any, res: any) => Promise<void>) => async (req: any, res: any) => {
        if (!authorised(access, req)) {
            res.status(401).set('www-authenticate', 'Bearer').json({ error: 'unauthorized' });
            return;
        }
        await handler(req, res);
    };

    app.get(`${prefix}/metrics`, guard(async (_req: any, res: any) => {
        const handle = db();
        if (!handle) {
            // Before the database is connected there is nothing truthful to
            // report; 503 keeps a scraper from recording zeros as real values.
            res.status(503).type('text/plain').send('# nightgate: not ready\n');
            return;
        }
        try {
            const body = await loadStatus().buildMetricsText(handle);
            res.status(200)
                .set('cache-control', 'no-store')
                .type('text/plain; version=0.0.4; charset=utf-8')
                .send(body);
        } catch (err) {
            logDetail('metrics', err);
            res.status(503).type('text/plain').send('# nightgate: metrics unavailable\n');
        }
    }));

    app.get(`${prefix}/health`, guard(async (_req: any, res: any) => {
        const handle = db();
        if (!handle) {
            res.status(503).json({ status: 'unknown' });
            return;
        }
        try {
            res.status(200).set('cache-control', 'no-store').json(await loadStatus().buildHealth(handle));
        } catch (err) {
            logDetail('health', err);
            res.status(503).json({ status: 'unknown' });
        }
    }));

    app.get(`${prefix}/ready`, guard(async (_req: any, res: any) => {
        const handle = db();
        if (!handle) {
            res.status(503).json({ ready: false });
            return;
        }
        try {
            const payload = await loadStatus().buildReadiness(handle);
            // The status code is what an orchestrator reads; the body is for
            // the human who then asks why.
            res.status(payload.ready ? 200 : 503).set('cache-control', 'no-store').json(payload);
        } catch (err) {
            logDetail('ready', err);
            res.status(503).json({ ready: false });
        }
    }));
}
