import crypto from 'crypto';
import cds from '@sap/cds';
import { configEnum, configString } from '../srv/utils/config';

// Plain /metrics, /health, /ready routes for scrapers and probes. Mounted at
// bootstrap, outside CAP auth, so fail-closed: only with NIGHTGATE_STATUS_TOKEN
// (bearer) or NIGHTGATE_STATUS_ROUTES=public.

type StatusModule = typeof import('../srv/monitoring/status');

let statusModule: StatusModule | null = null;

// Lazy: status.ts needs #cds-models, which is not loaded yet at bootstrap.
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

/** Fail-closed: without configuration nothing is mounted. */
export function resolveStatusRouteAccess(): StatusRouteAccess {
    const mode = configEnum('NIGHTGATE_STATUS_ROUTES') ?? '';
    if (mode === 'off') {
        return { mounted: false, reason: 'NIGHTGATE_STATUS_ROUTES=off' };
    }

    const token = configString('NIGHTGATE_STATUS_TOKEN') ?? '';
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
    const raw = configString('NIGHTGATE_STATUS_ROUTES_PREFIX') ?? '/nightgate';
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

// Detail goes to the log only: a message can carry a file path or SQL.
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
            // 503, so a scraper does not record zeros as real values.
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
            res.status(payload.ready ? 200 : 503).set('cache-control', 'no-store').json(payload);
        } catch (err) {
            logDetail('ready', err);
            res.status(503).json({ ready: false });
        }
    }));
}
