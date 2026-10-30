#!/usr/bin/env node
// Builds the CDS_CONFIG JSON for the standalone image from the environment. Called by docker/entrypoint.sh.
// Reads NIGHTGATE_DB_URL or NIGHTGATE_DB_PATH, NIGHTGATE_SQLITE_BUSY_TIMEOUT_MS, NIGHTGATE_AUTH and NIGHTGATE_HTTP_USER, _PASSWORD, _ROLES.
// Prints the JSON on stdout. Exits 2 with a message on stderr when the environment is unusable.
import { createRequire } from 'node:module';
import fs from 'node:fs';

// Splits the URL into the pg Pool fields that `@cap-js/postgres` takes. Supported sslmode values are disable, require and verify-full.
// require encrypts but does not check the certificate. Other modes are refused, because JSON config cannot express them exactly.
export function postgresCredentials(url) {
    let u;
    try { u = new URL(url); } catch { throw new Error('NIGHTGATE_DB_URL is not a valid URL'); }
    if (!/^postgres(ql)?:$/i.test(u.protocol)) {
        throw new Error(`NIGHTGATE_DB_URL must be a postgres:// URL (got '${url.replace(/:\/\/[^@]*@/, '://***@').slice(0, 40)}…'); for SQLite use NIGHTGATE_DB_PATH`);
    }
    const database = decodeURIComponent(u.pathname.replace(/^\//, ''));
    if (!u.hostname || !database) throw new Error('NIGHTGATE_DB_URL needs a host and a database name (postgres://user:pw@host:5432/db)');
    return {
        host: u.hostname,
        port: Number(u.port || 5432),
        user: decodeURIComponent(u.username || ''),
        password: decodeURIComponent(u.password || ''),
        database,
        ...sslOptions(u.searchParams)
    };
}

function sslOptions(params) {
    const sslmode = (params.get('sslmode') || '').toLowerCase();
    const sslFlag = (params.get('ssl') || '').toLowerCase();
    const mode = sslmode || (['1', 'true', 'require'].includes(sslFlag) ? 'require' : '');
    if (!mode || mode === 'disable') return {};
    if (mode === 'require') return { ssl: { rejectUnauthorized: false } };
    if (mode === 'verify-full') {
        const rootcert = params.get('sslrootcert');
        if (!rootcert) return { ssl: { rejectUnauthorized: true } };
        let ca;
        try { ca = fs.readFileSync(rootcert, 'utf8'); } catch (e) { throw new Error(`sslrootcert is not readable: ${rootcert} (${e.message})`); }
        return { ssl: { rejectUnauthorized: true, ca } };
    }
    if (mode === 'allow' || mode === 'prefer') throw new Error(`sslmode='${mode}' (opportunistic TLS) is not supported by node-postgres; use disable, require or verify-full`);
    if (mode === 'verify-ca') throw new Error("sslmode='verify-ca' (chain without hostname check) is not supported; use verify-full, or require to skip verification");
    throw new Error(`unsupported sslmode='${mode}' in NIGHTGATE_DB_URL (use: disable | require | verify-full)`);
}

/** Pool and client settings for PostgreSQL. CAP's defaults suit an idle dev box, and their 1 s acquire timeout fires under checkpoint stalls.
 *  CAP's `cds_requires_db_pool_*` and `cds_requires_db_client_*` env vars override any of these. */
export const POSTGRES_POOL = Object.freeze({
    min: 0, max: 20, testOnBorrow: true,
    acquireTimeoutMillis: 30000, destroyTimeoutMillis: 5000,
    idleTimeoutMillis: 60000, evictionRunIntervalMillis: 60000
});
export const POSTGRES_CLIENT = Object.freeze({ connectionTimeoutMillis: 10000 });

export function databaseConfig(env = process.env) {
    const url = String(env.NIGHTGATE_DB_URL ?? '').trim();
    if (url) {
        return { kind: 'postgres', credentials: postgresCredentials(url), pool: { ...POSTGRES_POOL }, client: { ...POSTGRES_CLIENT } };
    }
    const path = String(env.NIGHTGATE_DB_PATH ?? '/data/nightgate.db');
    const timeout = Number(env.NIGHTGATE_SQLITE_BUSY_TIMEOUT_MS) || 30000;
    return { kind: 'sqlite', credentials: { url: path }, client: { timeout } };
}

export function authConfig(env = process.env) {
    const kind = String(env.NIGHTGATE_AUTH ?? 'basic');
    if (kind === 'dummy') return { kind: 'dummy' };
    if (kind !== 'basic') throw new Error(`unsupported NIGHTGATE_AUTH='${kind}' (use: basic | dummy)`);
    const password = String(env.NIGHTGATE_HTTP_PASSWORD ?? '');
    if (!password) throw new Error('NIGHTGATE_HTTP_PASSWORD is required with basic auth (local unauthenticated testing only: NIGHTGATE_AUTH=dummy)');
    const user = String(env.NIGHTGATE_HTTP_USER || 'nightgate');
    // No role by default: the admin service (signing-key export, session
    // invalidation, job queue) needs NIGHTGATE_HTTP_ROLES=admin.
    const roles = String(env.NIGHTGATE_HTTP_ROLES ?? '').split(',').map(r => r.trim()).filter(Boolean);
    return { kind: 'basic', impl: '@odatano/cap-auth', realm: 'nightgate', users: { [user]: { password, roles } } };
}

/** CAP finds `@cap-js/postgres` only among devDependencies outside production, so the image injects the kind from its package.json. */
export function postgresKind() {
    let pkg;
    try { pkg = createRequire(import.meta.url)('@cap-js/postgres/package.json'); }
    catch { throw new Error('NIGHTGATE_DB_URL needs @cap-js/postgres installed next to @sap/cds'); }
    const kind = pkg?.cds?.requires?.kinds?.postgres;
    if (!kind?.impl) throw new Error('@cap-js/postgres/package.json carries no cds.requires.kinds.postgres definition');
    return kind;
}

// CAP logs every request header except the masked ones. The image adds the agent token here, so the mask holds before the plugin loads.
export const LOG_MASK_HEADERS = ['/authorization/i', '/cookie/i', '/cert/i', '/ssl/i', '/api-key/i', '/x-agent-token/i'];

/** With `dbOnly` it returns only the database binding, for the image's `migrate` mode. */
export function cdsConfig(env = process.env, { dbOnly = false } = {}) {
    const db = databaseConfig(env);
    const requires = dbOnly ? { db } : { db, auth: authConfig(env) };
    const log = { mask_headers: LOG_MASK_HEADERS };
    if (db.kind === 'postgres') {
        requires.kinds = { postgres: postgresKind() };
        // The plugin sets the same default at load; the image states it
        // explicitly so `cds deploy` (no plugin hooks) uses the same pool.
        return { features: { use_generic_pool: true }, log, requires };
    }
    return { log, requires };
}

if (import.meta.url === `file://${process.argv[1]}` || import.meta.url === `file:///${String(process.argv[1]).replace(/\\/g, '/')}`) {
    try {
        process.stdout.write(JSON.stringify(cdsConfig(process.env, { dbOnly: process.argv.includes('--db-only') })) + '\n');
    } catch (e) {
        process.stderr.write(`FATAL: ${e.message}\n`);
        process.exit(2);
    }
}
