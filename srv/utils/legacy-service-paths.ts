// Serves the old `/api/v1/...` service paths as `/odata/v4/midnight...` until 1.0; the plugin mounts it at bootstrap.
// SPDX-License-Identifier: Apache-2.0

import cds from '@sap/cds';
import type { NextFunction, Request, Response } from 'express';

const log = cds.log('nightgate');

/** Old service path -> the path the service is mounted at. */
export const LEGACY_SERVICE_PATHS: Readonly<Record<string, string>> = {
    '/api/v1/nightgate': '/odata/v4/midnight',
    '/api/v1/indexer': '/odata/v4/midnight-indexer',
    '/api/v1/verify': '/odata/v4/midnight-verify',
    '/api/v1/analytics': '/odata/v4/midnight-analytics',
    '/api/v1/admin': '/odata/v4/midnight-admin'
};

const warned = new Set<string>();
const requestCounts = new Map<string, number>(Object.keys(LEGACY_SERVICE_PATHS).map((from) => [from, 0]));

function legacyPrefixOf(url: string): string | null {
    for (const from of Object.keys(LEGACY_SERVICE_PATHS)) {
        if (url === from || url.startsWith(from + '/') || url.startsWith(from + '?')) return from;
    }
    return null;
}

/** The URL on the new path, or null when it is not on an old path (`/api/v1/nightgate-x` is not). */
export function rewriteLegacyServicePath(url: string): string | null {
    const from = legacyPrefixOf(url);
    return from === null ? null : LEGACY_SERVICE_PATHS[from] + url.slice(from.length);
}

/** Requests on each old path since process start. Every old path is present. */
export function legacyPathRequestTotals(): ReadonlyMap<string, number> {
    return requestCounts;
}

export function legacyServicePathMiddleware(req: Request, _res: Response, next: NextFunction): void {
    const from = legacyPrefixOf(req.url);
    if (from !== null) {
        requestCounts.set(from, (requestCounts.get(from) ?? 0) + 1);
        if (!warned.has(from)) {
            warned.add(from);
            log.warn(`${from} is a deprecated service path; use ${LEGACY_SERVICE_PATHS[from]} (the old path goes with 1.0)`);
        }
        const original = rewriteLegacyServicePath(req.originalUrl);
        if (original !== null) req.originalUrl = original;
        req.url = LEGACY_SERVICE_PATHS[from] + req.url.slice(from.length);
    }
    next();
}

/** Forget the first-use warnings and the counts (tests). */
export function __resetLegacyServicePathsForTests(): void {
    warned.clear();
    for (const from of requestCounts.keys()) requestCounts.set(from, 0);
}
