#!/usr/bin/env node
// nightgate-db-migrate: copy a NIGHTGATE SQLite database into PostgreSQL.
//
//   nightgate-db-migrate --from /data/nightgate.db --to postgres://user:pw@host:5432/db [--dry-run] [--force] [--ignore-unknown] [--batch 500]
//
// Reads every persisted entity of the loaded CDS model (this package's own
// model plus a consuming app's, when run from its root; `.texts` and CAP's
// own tables such as cds.outbox.Messages included) from the SQLite file with
// better-sqlite3 and inserts the rows through CAP into PostgreSQL, so types
// are converted the way the runtime expects (SQLite 0/1 -> boolean, ISO
// strings stay timestamps, JSON columns stay text). Rows are STREAMED
// (statement iterator, integers read as BigInt so Integer64 keeps every
// digit; a Decimal that SQLite already holds as a rounded REAL beyond 2^53
// aborts the run, see migrate-values.mjs) and written in batches; memory
// stays flat on large indexer databases. Views are skipped (the deploy
// creates them). A source table the model does not define is reported; with
// rows it stops the run unless --ignore-unknown. The target must have been
// deployed (`cds deploy`, the image entrypoint does it) and must be EMPTY
// unless --force (rows are then appended; duplicate keys fail the run).
//
// Stop every writer first: this is a data migration, not a live sync. After
// the copy the script compares row counts per table and prints them; a
// mismatch exits 1. Defaults: --from NIGHTGATE_DB_PATH or /data/nightgate.db,
// --to NIGHTGATE_DB_URL.
//
// Needs `@cap-js/postgres` and `better-sqlite3` resolvable from this package
// or from the working directory (a plugin host running on PostgreSQL has the
// first; `@cap-js/sqlite` brings the second). The image has both.
//
// SPDX-License-Identifier: Apache-2.0
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);

function requireFromHost(name, hint) {
    const candidates = [require, createRequire(path.join(process.cwd(), 'package.json'))];
    for (const r of candidates) {
        try { return r(name); } catch (e) { if (e?.code !== 'MODULE_NOT_FOUND' || !String(e.message).includes(name)) throw e; }
    }
    console.error(`'${name}' is not installed (neither next to @odatano/nightgate nor in ${process.cwd()}). ${hint}`);
    process.exit(2);
}

function arg(name, fallback) {
    const i = process.argv.indexOf(name);
    if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
    return fallback;
}
const FROM = path.resolve(arg('--from', process.env.NIGHTGATE_DB_PATH || '/data/nightgate.db'));
const TO = arg('--to', process.env.NIGHTGATE_DB_URL || '');
const DRY = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');
const BATCH = Math.max(1, Number(arg('--batch', '500')) || 500);

if (!fs.existsSync(FROM)) { console.error(`source SQLite file not found: ${FROM}`); process.exit(2); }
if (!TO || !/^postgres(ql)?:\/\//i.test(TO)) { console.error('a postgres:// target is required (--to or NIGHTGATE_DB_URL)'); process.exit(2); }

const cds = requireFromHost('@sap/cds', 'Run this from a CAP project that has @sap/cds installed.');
const { postgresCredentials, postgresKind } = await import(new URL('../docker/cds-config.mjs', import.meta.url).href);
// Under NODE_ENV=production CAP does not load the devDependency plugin that
// registers the `postgres` kind; inject its definition like the image does.
requireFromHost('@cap-js/postgres/package.json', 'Install it in the host: npm i @cap-js/postgres');
cds.env.requires.kinds = { ...(cds.env.requires.kinds ?? {}), postgres: postgresKind() };
cds.env.requires.db = { kind: 'postgres', credentials: postgresCredentials(TO) };

const Database = requireFromHost('better-sqlite3', 'Install it in the host: npm i better-sqlite3 (@cap-js/sqlite brings it along).');
const src = new Database(FROM, { readonly: true });
const srcTables = new Set(src.prepare("select name from sqlite_master where type='table'").all().map(r => r.name));

const model = await cds.load('*');
cds.model = cds.compile.for.nodejs(model);
// Every persisted entity of the model: localized `.texts` entities and CAP's
// own tables (`cds.outbox.Messages`, ...) included; views, skipped and
// pre-existing entities are not tables of ours.
const entities = Object.values(cds.model.definitions)
    .filter(d => d.kind === 'entity' && !d.query && !d.projection && !d['@cds.persistence.skip'] && !d['@cds.persistence.exists']);

const db = await cds.connect.to('db');
const { SELECT, INSERT, DELETE } = cds.ql;

const plan = [];
const modelTables = new Set();
for (const d of entities) {
    const table = String(d.name).replace(/\./g, '_');
    modelTables.add(table);
    if (!srcTables.has(table)) { plan.push({ entity: d.name, table, source: null, note: 'not in source (skipped)' }); continue; }
    const srcCount = Number(src.prepare(`select count(*) n from "${table}"`).get().n);
    const [{ n: dstCount }] = await db.run(SELECT.from(d.name).columns('count(*) as n'));
    plan.push({ entity: d.name, table, source: srcCount, target: Number(dstCount), def: d });
}
// Tables in the source the loaded model does not know cannot be copied
// through CAP. Empty ones are noise; non-empty ones are data this run would
// silently leave behind, so they stop it unless --ignore-unknown.
const unknown = [...srcTables]
    .filter(t => !modelTables.has(t) && !t.startsWith('sqlite_'))
    .map(t => ({ table: t, rows: Number(src.prepare(`select count(*) n from "${t}"`).get().n) }));
const IGNORE_UNKNOWN = process.argv.includes('--ignore-unknown');

console.log(`source ${FROM}`);
console.log(`target ${TO.replace(/:\/\/([^:/@]*)(:[^@]*)?@/, '://$1:***@')}`);
for (const p of plan) console.log(`  ${p.table.padEnd(40)} source=${p.source ?? '-'} target=${p.target ?? '-'}${p.note ? ' ' + p.note : ''}`);
for (const u of unknown) console.log(`  ${u.table.padEnd(40)} source=${u.rows} NOT IN MODEL (not migrated${u.rows > 0 ? ', see --ignore-unknown' : ''})`);
const unknownWithRows = unknown.filter(u => u.rows > 0);
if (unknownWithRows.length && !IGNORE_UNKNOWN) {
    console.error(`source holds rows in table(s) the loaded model does not define: ${unknownWithRows.map(u => u.table).join(', ')}. Run from the CAP project whose model owns them, or pass --ignore-unknown to leave them behind.`);
    process.exit(1);
}
if (DRY) { console.log('dry run, nothing written'); process.exit(0); }

// The SyncState singleton is written by every server boot (network binding),
// so a target that has only run once holds one row: it is REPLACED by the
// source's row (which carries the real indexing state), never appended to.
const SINGLETONS = new Set(['midnight.SyncState']);
const nonEmpty = plan.filter(p => (p.target ?? 0) > 0 && !SINGLETONS.has(p.entity));
if (nonEmpty.length && !FORCE) {
    console.error(`target is not empty (${nonEmpty.map(p => p.table).join(', ')}); migrate into a freshly deployed database, or pass --force to append anyway`);
    process.exit(1);
}
for (const p of plan) {
    if (SINGLETONS.has(p.entity) && (p.target ?? 0) > 0 && (p.source ?? 0) > 0) {
        await cds.tx(async tx => { await tx.run(DELETE.from(p.entity)); });
        console.log(`  ${p.table.padEnd(40)} target row(s) replaced by the source (singleton)`);
        p.target = 0;
    }
}

const { convertRow } = await import(new URL('./migrate-values.mjs', import.meta.url).href);

let failed = false;
for (const p of plan) {
    if (p.source == null || p.source === 0) continue;
    // Streamed: the statement iterator yields one row at a time; only one
    // batch is ever materialised. Integers come back as BigInt.
    const stmt = src.prepare(`select * from "${p.table}"`);
    stmt.safeIntegers(true);
    let done = 0;
    let batch = [];
    const flush = async () => {
        if (!batch.length) return;
        const rows = batch; batch = [];
        await cds.tx(async tx => { await tx.run(INSERT.into(p.entity).entries(rows)); });
        done += rows.length;
        process.stdout.write(`\r  ${p.table.padEnd(40)} ${done}/${p.source}`);
    };
    for (const row of stmt.iterate()) {
        batch.push(convertRow(p.def, row));
        if (batch.length >= BATCH) await flush();
    }
    await flush();
    const [{ n }] = await db.run(SELECT.from(p.entity).columns('count(*) as n'));
    const ok = Number(n) === (p.target ?? 0) + p.source;
    if (!ok) failed = true;
    process.stdout.write(`\r  ${p.table.padEnd(40)} ${done}/${p.source} -> target ${n} ${ok ? 'OK' : 'MISMATCH'}\n`);
}
src.close();
await cds.disconnect?.();
console.log(failed ? 'FAILED: row counts differ' : 'done: every table copied, counts match');
process.exit(failed ? 1 : 0);
