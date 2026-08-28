// The standalone image builds its CDS_CONFIG from the environment in
// docker/cds-config.mjs (0.21.1: PostgreSQL via NIGHTGATE_DB_URL, SQLite
// otherwise). The mapping is what a container boots with, so it is pinned.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error plain ESM script without a declaration file
import { convertValue, convertRow } from '../../scripts/migrate-values.mjs';

const SCRIPT = path.resolve(__dirname, '../../docker/cds-config.mjs');

function run(env: Record<string, string>) {
    const clean: Record<string, string> = { PATH: process.env.PATH ?? '' };
    const r = spawnSync(process.execPath, [SCRIPT], { env: { ...clean, ...env }, encoding: 'utf8' });
    return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}

describe('docker/cds-config.mjs', () => {
    it('SQLite by default: file path, busy timeout, basic auth with the admin role', () => {
        const r = run({ NIGHTGATE_HTTP_PASSWORD: 'pw' });
        expect(r.code).toBe(0);
        const cfg = JSON.parse(r.out);
        expect(cfg.requires.db).toEqual({ kind: 'sqlite', credentials: { url: '/data/nightgate.db' }, client: { timeout: 30000 } });
        expect(cfg.requires.auth).toEqual({ impl: './srv/utils/agent-token-auth.js', users: { nightgate: { password: 'pw', roles: ['admin'] } } });
    });

    it('honours NIGHTGATE_DB_PATH, the busy timeout, user and roles', () => {
        const cfg = JSON.parse(run({ NIGHTGATE_HTTP_PASSWORD: 'pw', NIGHTGATE_DB_PATH: '/x/y.db', NIGHTGATE_SQLITE_BUSY_TIMEOUT_MS: '5000', NIGHTGATE_HTTP_USER: 'ops', NIGHTGATE_HTTP_ROLES: 'admin, viewer' }).out);
        expect(cfg.requires.db).toEqual({ kind: 'sqlite', credentials: { url: '/x/y.db' }, client: { timeout: 5000 } });
        expect(cfg.requires.auth.users).toEqual({ ops: { password: 'pw', roles: ['admin', 'viewer'] } });
    });

    it('NIGHTGATE_DB_URL selects PostgreSQL as pg Pool fields (host, port, user, password, database), no SQLite client block', () => {
        const cfg = JSON.parse(run({ NIGHTGATE_HTTP_PASSWORD: 'pw', NIGHTGATE_DB_URL: 'postgres://u:p%40ss@db:5433/nightgate', NIGHTGATE_DB_PATH: '/ignored.db' }).out);
        expect(cfg.requires.db).toMatchObject({ kind: 'postgres', credentials: { host: 'db', port: 5433, user: 'u', password: 'p@ss', database: 'nightgate' } });
        expect(cfg.requires.db.credentials.ssl).toBeUndefined();
        // the plugin's kind definition rides along: under NODE_ENV=production CAP does not load devDependency plugins
        expect(cfg.requires.kinds.postgres).toMatchObject({ impl: '@cap-js/postgres', dialect: 'postgres', schema_evolution: 'auto' });
        // pool sized for load + generic-pool selected (the built-in pool leaks on acquire timeouts)
        expect(cfg.requires.db.pool).toEqual({ min: 0, max: 20, testOnBorrow: true, acquireTimeoutMillis: 30000, destroyTimeoutMillis: 5000, idleTimeoutMillis: 60000, evictionRunIntervalMillis: 60000 });
        expect(cfg.requires.db.client).toEqual({ connectionTimeoutMillis: 10000 });
        expect(cfg.features).toEqual({ use_generic_pool: true });
        const sqlite = JSON.parse(run({ NIGHTGATE_HTTP_PASSWORD: 'pw' }).out);
        expect(sqlite.requires.kinds).toBeUndefined();
        expect(sqlite.features).toBeUndefined();
        const dflt = JSON.parse(run({ NIGHTGATE_HTTP_PASSWORD: 'pw', NIGHTGATE_DB_URL: 'postgresql://u:p@db/nightgate' }).out);
        expect(dflt.requires.db.credentials).toMatchObject({ port: 5432, database: 'nightgate' });
        expect(dflt.requires.db.credentials.ssl).toBeUndefined();
        const ssl = JSON.parse(run({ NIGHTGATE_HTTP_PASSWORD: 'pw', NIGHTGATE_DB_URL: 'postgres://u:p@db/nightgate?sslmode=require' }).out);
        expect(ssl.requires.db.credentials.ssl).toEqual({ rejectUnauthorized: false });
        expect(run({ NIGHTGATE_HTTP_PASSWORD: 'pw', NIGHTGATE_DB_URL: 'postgres://u:p@db/' }).err).toMatch(/host and a database name/);
    });

    it('sslmode: verify-full verifies (with sslrootcert); allow/prefer/verify-ca and unknown modes refuse instead of approximating', () => {
        const cfg = JSON.parse(run({ NIGHTGATE_HTTP_PASSWORD: 'pw', NIGHTGATE_DB_URL: 'postgres://u:p@db/nightgate?sslmode=verify-full' }).out);
        expect(cfg.requires.db.credentials.ssl).toEqual({ rejectUnauthorized: true });
        for (const mode of ['allow', 'prefer']) {
            const r = run({ NIGHTGATE_HTTP_PASSWORD: 'pw', NIGHTGATE_DB_URL: `postgres://u:p@db/nightgate?sslmode=${mode}` });
            expect(r.code).toBe(2);
            expect(r.err).toMatch(/opportunistic TLS/);
        }
        const vca = run({ NIGHTGATE_HTTP_PASSWORD: 'pw', NIGHTGATE_DB_URL: 'postgres://u:p@db/nightgate?sslmode=verify-ca' });
        expect(vca.code).toBe(2);
        expect(vca.err).toMatch(/verify-ca.*not supported/);
        expect(JSON.parse(run({ NIGHTGATE_HTTP_PASSWORD: 'pw', NIGHTGATE_DB_URL: 'postgres://u:p@db/nightgate?sslmode=disable' }).out).requires.db.credentials.ssl).toBeUndefined();
        const pem = path.join(os.tmpdir(), `nightgate-ca-${process.pid}.pem`);
        fs.writeFileSync(pem, '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n');
        try {
            const withCa = JSON.parse(run({ NIGHTGATE_HTTP_PASSWORD: 'pw', NIGHTGATE_DB_URL: `postgres://u:p@db/nightgate?sslmode=verify-full&sslrootcert=${encodeURIComponent(pem)}` }).out);
            expect(withCa.requires.db.credentials.ssl).toEqual({ rejectUnauthorized: true, ca: fs.readFileSync(pem, 'utf8') });
        } finally { fs.rmSync(pem, { force: true }); }
        expect(run({ NIGHTGATE_HTTP_PASSWORD: 'pw', NIGHTGATE_DB_URL: 'postgres://u:p@db/nightgate?sslmode=verify-full&sslrootcert=/nope/ca.pem' }).err).toMatch(/sslrootcert is not readable/);
        const bad = run({ NIGHTGATE_HTTP_PASSWORD: 'pw', NIGHTGATE_DB_URL: 'postgres://u:p@db/nightgate?sslmode=verify-everything' });
        expect(bad.code).toBe(2);
        expect(bad.err).toMatch(/unsupported sslmode='verify-everything'/);
    });

    it('refuses a non-postgres URL, a missing basic password and an unknown auth kind (exit 2, secret not echoed)', () => {
        const bad = run({ NIGHTGATE_HTTP_PASSWORD: 'pw', NIGHTGATE_DB_URL: 'mysql://u:secret@h/db' });
        expect(bad.code).toBe(2);
        expect(bad.err).toMatch(/must be a postgres:\/\/ URL/);
        expect(bad.err).not.toMatch(/secret/);
        expect(run({}).code).toBe(2);
        expect(run({}).err).toMatch(/NIGHTGATE_HTTP_PASSWORD is required/);
        expect(run({ NIGHTGATE_AUTH: 'jwt' }).err).toMatch(/unsupported NIGHTGATE_AUTH/);
    });

    it('dummy auth needs no password', () => {
        const cfg = JSON.parse(run({ NIGHTGATE_AUTH: 'dummy' }).out);
        expect(cfg.requires.auth).toEqual({ kind: 'dummy' });
    });

    it('--db-only (migrate mode) emits the database binding without auth and needs no password', () => {
        const r = spawnSync(process.execPath, [SCRIPT, '--db-only'], { env: { PATH: process.env.PATH ?? '', NIGHTGATE_DB_URL: 'postgres://u:p@db:5433/nightgate' }, encoding: 'utf8' });
        expect(r.status).toBe(0);
        const cfg = JSON.parse(r.stdout);
        expect(cfg.requires.db).toMatchObject({ kind: 'postgres', credentials: { host: 'db', port: 5433, user: 'u', password: 'p', database: 'nightgate' } });
        expect(cfg.requires.auth).toBeUndefined();
        expect(cfg.requires.kinds.postgres).toMatchObject({ impl: '@cap-js/postgres' });
        expect(cfg.features).toEqual({ use_generic_pool: true });
    });
});

describe('scripts/migrate-values.mjs (nightgate-db-migrate row conversion)', () => {
    const el = (type: string) => ({ type });

    it('keeps every digit of Integer64 and Decimal read as BigInt; refuses a Number that already lost precision', () => {
        const big = 9223372036854775807n; // > 2^53
        expect(convertValue(el('cds.Integer64'), big, 'c')).toBe('9223372036854775807');
        expect(convertValue(el('cds.Int64'), -12n, 'c')).toBe('-12');
        expect(convertValue(el('cds.Integer64'), '123', 'c')).toBe('123');
        expect(convertValue(el('cds.Decimal'), big, 'c')).toBe('9223372036854775807');
        expect(convertValue(el('cds.Decimal'), '12345678901234567890.123456789', 'c')).toBe('12345678901234567890.123456789');
        expect(convertValue(el('cds.Decimal'), 1.5, 'c')).toBe(1.5);
        expect(() => convertValue(el('cds.Integer64'), 2 ** 60, 'c')).toThrow(/lost precision/);
        // a Decimal SQLite stored as REAL beyond 2^53 was rounded at write time: refuse, never copy a wrong number
        expect(convertValue(el('cds.Decimal'), 2 ** 53 - 1, 'c')).toBe(2 ** 53 - 1);
        expect(() => convertValue(el('cds.Decimal'), 2 ** 53, 'c')).toThrow(/REAL beyond 2\^53/);
        expect(() => convertValue(el('cds.Decimal'), -5975896448806980778, 'c')).toThrow(/REAL beyond 2\^53/);
        expect(() => convertValue(el('cds.Decimal'), Infinity, 'c')).toThrow(/REAL beyond 2\^53/);
    });

    it('small integers, booleans and doubles come back as JS numbers/booleans; unknown types pass through', () => {
        expect(convertValue(el('cds.Integer'), 42n, 'c')).toBe(42);
        expect(convertValue(el('cds.Int16'), '7', 'c')).toBe(7);
        expect(() => convertValue(el('cds.Integer'), 2n ** 60n, 'c')).toThrow(/not a safe integer/);
        expect(convertValue(el('cds.Boolean'), 1n, 'c')).toBe(true);
        expect(convertValue(el('cds.Boolean'), 0n, 'c')).toBe(false);
        expect(convertValue(el('cds.Double'), 3n, 'c')).toBe(3);
        expect(convertValue(el('cds.Double'), 2.5, 'c')).toBe(2.5);
        expect(convertValue(el('cds.String'), 'x', 'c')).toBe('x');
        expect(convertValue(el('cds.Timestamp'), '2026-08-27T00:00:00.000Z', 'c')).toBe('2026-08-27T00:00:00.000Z');
        expect(convertValue(el('cds.String'), 5n, 'c')).toBe('5');
        expect(convertValue(el('cds.String'), null, 'c')).toBeNull();
    });

    it('convertRow drops columns the model no longer has and names the column in errors', () => {
        const def = { name: 'midnight.X', elements: { a: el('cds.Integer64'), b: el('cds.Boolean') } };
        expect(convertRow(def, { a: 1n, b: 1n, gone: 'x' })).toEqual({ a: '1', b: true });
        expect(() => convertRow(def, { a: 2 ** 60 })).toThrow(/midnight\.X\.a/);
    });
});
