#!/usr/bin/env node
// Builds the CDS_CONFIG JSON for the standalone image from the environment.
// Called by docker/entrypoint.sh; kept in its own file so the mapping is unit
// tested (test/unit/docker-cds-config.test.ts).
//
//   NIGHTGATE_DB_URL      postgres://user:pw@host:5432/db  -> kind postgres
//                         (postgresql:// accepted); anything else is refused
//   NIGHTGATE_DB_PATH     SQLite file (default /data/nightgate.db) when no URL
//   NIGHTGATE_SQLITE_BUSY_TIMEOUT_MS  SQLite writer wait (default 30000)
//   NIGHTGATE_AUTH        basic (default) | dummy
//   NIGHTGATE_HTTP_USER / NIGHTGATE_HTTP_PASSWORD / NIGHTGATE_HTTP_ROLES
//
// Prints the JSON on stdout; exits 2 with a message on stderr when the
// environment is unusable.
/**
 * `@cap-js/postgres` takes pg Pool fields (host, port, user, password,
 * database, ssl), not a connection string: split the URL. The `sslmode`
 * values node-postgres can honour exactly:
 *   (none) | disable          -> no TLS
 *   require (or ssl=true/1)   -> TLS, certificate NOT verified
 *   verify-full               -> TLS, chain AND hostname verified against the
 *                                system CAs or `sslrootcert=<pem file>`
 * `allow`/`prefer` (opportunistic TLS) and `verify-ca` (chain without
 * hostname; needs a checkServerIdentity function, which JSON config cannot
 * carry) are refused rather than approximated, as is anything unknown.
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';

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

export function databaseConfig(env = process.env) {
    const url = String(env.NIGHTGATE_DB_URL ?? '').trim();
    if (url) {
        return { kind: 'postgres', credentials: postgresCredentials(url) };
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
    // The single configured user IS the operator of this deployment, so it
    // carries the admin role unless NIGHTGATE_HTTP_ROLES says otherwise.
    const roles = String(env.NIGHTGATE_HTTP_ROLES ?? 'admin').split(',').map(r => r.trim()).filter(Boolean);
    return { impl: './srv/utils/agent-token-auth.js', users: { [user]: { password, roles } } };
}

/**
 * The `postgres` kind is registered by the `@cap-js/postgres` plugin, which
 * CAP only discovers among devDependencies while NODE_ENV is not production.
 * The image runs in production, so the kind definition is injected from the
 * plugin's own package.json (impl, dialect, pool, schema_evolution).
 */
export function postgresKind() {
    let pkg;
    try { pkg = createRequire(import.meta.url)('@cap-js/postgres/package.json'); }
    catch { throw new Error('NIGHTGATE_DB_URL needs @cap-js/postgres installed next to @sap/cds'); }
    const kind = pkg?.cds?.requires?.kinds?.postgres;
    if (!kind?.impl) throw new Error('@cap-js/postgres/package.json carries no cds.requires.kinds.postgres definition');
    return kind;
}

/**
 * `dbOnly` (CLI `--db-only`): the database binding alone, for the image's
 * `migrate` mode, which deploys and copies data but serves nothing, so it
 * needs neither HTTP credentials nor the wallet encryption key.
 */
export function cdsConfig(env = process.env, { dbOnly = false } = {}) {
    const db = databaseConfig(env);
    const requires = dbOnly ? { db } : { db, auth: authConfig(env) };
    if (db.kind === 'postgres') requires.kinds = { postgres: postgresKind() };
    return { requires };
}

if (import.meta.url === `file://${process.argv[1]}` || import.meta.url === `file:///${String(process.argv[1]).replace(/\\/g, '/')}`) {
    try {
        process.stdout.write(JSON.stringify(cdsConfig(process.env, { dbOnly: process.argv.includes('--db-only') })) + '\n');
    } catch (e) {
        process.stderr.write(`FATAL: ${e.message}\n`);
        process.exit(2);
    }
}
