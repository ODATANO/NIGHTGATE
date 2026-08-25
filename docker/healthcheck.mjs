/* eslint-disable no-console -- a healthcheck's only channel to the operator is
   docker's captured output; there is no logger in this process. */
/**
 * Container healthcheck: does NIGHTGATE work, not merely does the port answer.
 *
 * The plugin deliberately keeps its CAP host alive when Nightgate itself is
 * offline (an un-migrated database, a submission pipeline that did not start),
 * so probing `/` reports such a container as healthy while nothing works. The
 * readiness route answers 503 in exactly those cases.
 *
 * Only ONE case falls back to plain liveness: an operator who switched the
 * status routes off entirely (NIGHTGATE_STATUS_ROUTES=off) has said they do
 * not want them, so the container is judged on the port alone. Everything
 * else, including 401 and an unexpected 404, is a failure: those mean the
 * probe cannot see readiness, and a probe that cannot see it must not claim
 * the container is fine.
 */

import fs from 'node:fs';

const PORT = process.env.PORT || '4004';
// 127.0.0.1, not localhost: where that name resolves to ::1 first and the
// server listens on IPv4, the probe stalls until its own timeout and reports
// a healthy container as sick.
const BASE = `http://127.0.0.1:${PORT}`;

function prefix() {
    const raw = String(process.env.NIGHTGATE_STATUS_ROUTES_PREFIX ?? '/nightgate').trim();
    const withSlash = raw.startsWith('/') ? raw : `/${raw}`;
    const trimmed = withSlash.replace(/\/+$/, '');
    return trimmed === '' ? '/nightgate' : trimmed;
}

function token() {
    if (process.env.NIGHTGATE_STATUS_TOKEN) return process.env.NIGHTGATE_STATUS_TOKEN.trim();
    // The entrypoint writes an internal token here when the operator
    // configured none, so the container can probe itself while the routes stay
    // closed to everyone else. A HEALTHCHECK does not inherit variables the
    // entrypoint exported, hence the file.
    try {
        return fs.readFileSync('/tmp/nightgate-status-token', 'utf8').trim();
    } catch {
        return '';
    }
}

async function liveness() {
    const res = await fetch(BASE, { signal: AbortSignal.timeout(5000) });
    return res.status < 500;
}

async function main() {
    if (String(process.env.NIGHTGATE_STATUS_ROUTES ?? '').trim().toLowerCase() === 'off') {
        process.exit((await liveness()) ? 0 : 1);
    }

    const secret = token();
    const headers = secret ? { authorization: `Bearer ${secret}` } : {};
    const res = await fetch(`${BASE}${prefix()}/ready`, { headers, signal: AbortSignal.timeout(8000) });

    if (res.status === 401 || res.status === 404) {
        console.error(
            `healthcheck: ${prefix()}/ready answered ${res.status}. The status routes are not reachable ` +
            'for this probe (token missing or prefix mismatch), so readiness cannot be verified.'
        );
        process.exit(1);
    }
    process.exit(res.ok ? 0 : 1);
}

main().catch(err => {
    console.error(`healthcheck: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
});
