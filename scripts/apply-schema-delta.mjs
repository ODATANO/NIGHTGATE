#!/usr/bin/env node
// Additive SQLite schema migration: creates missing tables and columns, rebuilds changed constraints, refreshes views.
// Run with the server stopped: node scripts/apply-schema-delta.mjs [dbPath]
// Target: first CLI arg, else NIGHTGATE_DB_PATH, else db/midnight.db. With --postgres it only renames columns and moves keys, before `cds deploy` does the rest.

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Prefer the built-in node:sqlite so no native module is needed.
// better-sqlite3 is an optional fallback; only its transaction API differs.
const require = createRequire(import.meta.url);
let openDatabase;
try {
    const { DatabaseSync } = await import('node:sqlite');
    openDatabase = (p) => new DatabaseSync(p);
} catch {
    try {
        const BetterSqlite3 = require('better-sqlite3');
        openDatabase = (p) => new BetterSqlite3(p);
    } catch {
        console.error('[delta] ! no SQLite driver: this needs Node >= 22.5 (built-in node:sqlite) or an installed better-sqlite3.');
        process.exit(1);
    }
}

/** Every view that reads a table, directly or through another view. */
const DEPENDENT_VIEWS = `
    WITH RECURSIVE dependents(oid) AS (
        SELECT r.ev_class FROM pg_depend d JOIN pg_rewrite r ON r.oid = d.objid
         WHERE d.classid = 'pg_rewrite'::regclass AND d.refclassid = 'pg_class'::regclass AND d.refobjid = to_regclass($1) AND r.ev_class <> d.refobjid
        UNION
        SELECT r.ev_class FROM dependents p
          JOIN pg_depend d ON d.classid = 'pg_rewrite'::regclass AND d.refclassid = 'pg_class'::regclass AND d.refobjid = p.oid
          JOIN pg_rewrite r ON r.oid = d.objid
         WHERE r.ev_class <> p.oid
    )
    SELECT c.relname, c.relkind FROM dependents JOIN pg_class c ON c.oid = dependents.oid`;

const KEY_CONSTRAINTS = `
    SELECT c.conname, c.contype, array_agg(a.attname::text ORDER BY k.ord) AS columns
      FROM pg_constraint c
     CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
     WHERE c.conrelid = to_regclass($1) AND c.contype IN ('p', 'u')
     GROUP BY c.conname, c.contype`;

/** Every index and key constraint of the given tables, with the statement that drops it and the one that builds it again. */
const TABLE_INDEXES = `
    WITH owned AS (
        SELECT oid, conrelid, conname, conindid FROM pg_constraint
         WHERE conrelid = ANY($1::text[]::regclass[]) AND contype IN ('p', 'u', 'x')
    )
    SELECT conname::text AS name, true AS constraint, format('ALTER TABLE %s DROP CONSTRAINT %I', conrelid::regclass, conname) AS dropping,
           format('ALTER TABLE %s ADD CONSTRAINT %I %s', conrelid::regclass, conname, pg_get_constraintdef(oid)) AS creating
      FROM owned
    UNION ALL
    SELECT c.relname::text, false, format('DROP INDEX %s', i.indexrelid::regclass), pg_get_indexdef(i.indexrelid)
      FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
     WHERE i.indrelid = ANY($1::text[]::regclass[]) AND i.indexrelid NOT IN (SELECT conindid FROM owned)`;

/** Lets PostgreSQL sort an index build in memory, for this transaction. A value the server sets itself stays. */
const SORT_MEMORY = `
    SELECT set_config('maintenance_work_mem', '1GB', true)
      FROM pg_settings WHERE name = 'maintenance_work_mem' AND source = 'default'`;

// A NOT NULL column cannot be added to a table that has rows, so the position columns are added and filled here.
// PostgreSQL writes an entry into every index of a changed row: the indexes of the tables are dropped and built again.
async function fillChainPositionOnPostgres(client, pending, lists) {
    const { CHAIN_POSITION_COLUMNS, CHAIN_POSITION_FILLS, NIGHTGATE_INDEXES, indexStatement } = lists;
    const tables = [...new Set(CHAIN_POSITION_COLUMNS.map(c => c.table))];
    const started = Date.now();
    const seconds = () => Math.round((Date.now() - started) / 1000);
    const existing = (await client.query(TABLE_INDEXES, [tables.map(t => t.toLowerCase())])).rows;
    console.log(`[delta] ~ chain position: ${pending.length} column(s) to add and fill in ${tables.length} table(s); this writes every row once`);
    for (const index of existing) await client.query(index.dropping);
    for (const c of pending) await client.query(`ALTER TABLE ${c.table} ADD COLUMN ${c.column} ${c.type === 'cds.Integer64' ? 'BIGINT' : 'INTEGER'}`);
    for (const fill of CHAIN_POSITION_FILLS) {
        const { rowCount } = await client.query(fill.sql);
        console.log(`[delta] ~ ${fill.table}: chain position of ${rowCount} row(s) filled, ${seconds()} s so far`);
    }
    for (const c of pending) {
        const { n } = (await client.query(`SELECT count(*)::int AS n FROM ${c.table} WHERE ${c.column} IS NULL`)).rows[0];
        if (n > 0) throw new Error(`${n} row(s) of ${c.table} got no ${c.column}: the row they belong to is missing, so they have no place in the chain. Remove them and run this again`);
        await client.query(`ALTER TABLE ${c.table} ALTER COLUMN ${c.column} SET NOT NULL`);
    }
    await client.query(SORT_MEMORY);
    // An index of this package that the current list no longer names is left out: another index stands for it.
    const current = new Set(NIGHTGATE_INDEXES.map(i => i.name.toLowerCase()));
    const kept = existing.filter(i => i.constraint || !i.name.startsWith('ng_') || current.has(i.name));
    for (const index of kept) await client.query(index.creating);
    const listed = NIGHTGATE_INDEXES.filter(spec => tables.includes(spec.table));
    for (const spec of listed) await client.query(indexStatement(spec, 'postgres'));
    console.log(`[delta] ~ chain position: ${kept.length} index(es) built again, ${listed.length} of the current list ensured, ${seconds()} s in all`);
}

// PostgreSQL does not drop or retype a column a view reads. The views of the model are dropped and taken out of the
// stored model, so the deploy creates them again. A view the model does not know stops the change.
async function dropModelViewsOf(client, csn, views, tableName) {
    const dependents = (await client.query(DEPENDENT_VIEWS, [tableName.toLowerCase()])).rows;
    const foreign = dependents.filter(d => d.relkind !== 'v' || !views.has(d.relname));
    if (foreign.length > 0) {
        throw new Error(`${foreign.map(d => d.relname).join(', ')} reads ${tableName} and is not part of the model: drop it, run this again, then create it again`);
    }
    for (const d of dependents) {
        await client.query(`DROP VIEW IF EXISTS "${d.relname}" CASCADE`);
        delete csn.definitions[views.get(d.relname)];
    }
    return dependents.length;
}

async function columnToTextOnPostgres(client, csn, views, change) {
    const dropped = await dropModelViewsOf(client, csn, views, change.table);
    await client.query(`ALTER TABLE ${change.table} ALTER COLUMN ${change.column} TYPE VARCHAR(${change.length}) USING ${change.column}::text`);
    console.log(`[delta] ~ ${change.table}.${change.column} is text now, ${dropped} view(s) left for the deploy to create`);
}

async function moveKeyOnPostgres(client, csn, views, change) {
    const table = change.table.toLowerCase();
    const to = change.to.toLowerCase();
    const dropped = await dropModelViewsOf(client, csn, views, change.table);
    const constraints = (await client.query(KEY_CONSTRAINTS, [table])).rows;
    const replaced = constraints.filter(c => c.contype === 'p' || (c.columns.length === 1 && c.columns[0] === to));
    const steps = [...replaced.map(c => `DROP CONSTRAINT "${c.conname}"`), `DROP COLUMN ${change.from}`, `ADD PRIMARY KEY (${change.to})`];
    await client.query(`ALTER TABLE ${change.table} ${steps.join(', ')}`);
    console.log(`[delta] ~ ${change.table}: key moved from ${change.from} to ${change.to}, ${dropped} view(s) left for the deploy to create`);
}

// `cds deploy` on PostgreSQL adds columns and refuses a model that drops one, turns a number into text or adds a
// NOT NULL column to rows. Those changes happen here first, in the tables and in the model CAP stored at the last deploy.
async function prepareTablesOnPostgres() {
    const lists = require(path.join(packageRoot, 'srv/utils/db-indexes.js'));
    const { pendingColumnRenames, pendingKeyChanges, pendingTextColumns, pendingDerivedColumns, renameInStoredModel, moveKeyInStoredModel, toTextInStoredModel, addToStoredModel, viewsOfStoredModel } = lists;
    const { Client } = require('pg');
    const credentials = process.env.CDS_CONFIG ? JSON.parse(process.env.CDS_CONFIG)?.requires?.db?.credentials : null;
    if (!credentials && !process.env.NIGHTGATE_DB_URL) throw new Error('--postgres needs CDS_CONFIG with requires.db.credentials or NIGHTGATE_DB_URL');
    const client = new Client(credentials ?? { connectionString: process.env.NIGHTGATE_DB_URL });
    await client.connect();
    try {
        // The schema `cds deploy` works on.
        if (credentials?.schema) await client.query(`SET search_path TO "${credentials.schema}"`);
        await client.query('BEGIN');
        const { rows } = await client.query('SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = current_schema()');
        const columns = new Map();
        const types = new Map();
        for (const r of rows) {
            columns.set(r.table_name, [...(columns.get(r.table_name) ?? []), r.column_name]);
            types.set(`${r.table_name}.${r.column_name}`, r.data_type);
        }
        const columnsOf = table => columns.get(table.toLowerCase());
        const renames = pendingColumnRenames(columnsOf);
        const keyChanges = pendingKeyChanges(columnsOf);
        const toText = pendingTextColumns((table, column) => types.get(`${table}.${column}`.toLowerCase()));
        const derived = pendingDerivedColumns(columnsOf);
        if (renames.length + keyChanges.length + toText.length + derived.length > 0) {
            const stored = columns.has('cds_model') ? (await client.query('SELECT csn FROM cds_model')).rows[0]?.csn : null;
            if (!stored) throw new Error('the database has tables of an older version and no stored model (table cds_model), so `cds deploy` cannot bring it forward');
            const csn = JSON.parse(stored);
            for (const r of renames) {
                await client.query(`ALTER TABLE ${r.table} RENAME COLUMN ${r.from} TO ${r.to}`);
                console.log(`[delta] ~ renamed ${r.table}.${r.from} to ${r.to}`);
            }
            const views = viewsOfStoredModel(csn);
            for (const change of keyChanges) await moveKeyOnPostgres(client, csn, views, change);
            for (const change of toText) await columnToTextOnPostgres(client, csn, views, change);
            if (derived.length > 0) await fillChainPositionOnPostgres(client, derived, lists);
            const renamed = renameInStoredModel(csn, renames);
            const moved = moveKeyInStoredModel(csn, keyChanges);
            const retyped = toTextInStoredModel(csn, toText);
            const added = addToStoredModel(csn, derived);
            await client.query('UPDATE cds_model SET csn = $1', [JSON.stringify(csn)]);
            console.log(`[delta] = stored model: ${renamed} element(s) renamed, ${moved} key(s) moved, ${retyped} element(s) text now, ${added} position column(s) added`);
        }
        await client.query('COMMIT');
        console.log(`[delta] done: ${renames.length} column(s) renamed, ${keyChanges.length} key(s) moved, ${toText.length} column(s) text now, ${derived.length} position column(s) filled`);
    } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
    } finally {
        await client.end();
    }
}

if (process.argv.includes('--postgres')) {
    await prepareTablesOnPostgres();
    process.exit(0);
}

const DB_PATH = path.resolve(process.argv[2] || process.env.NIGHTGATE_DB_PATH || path.join(packageRoot, 'db/midnight.db'));
if (!fs.existsSync(DB_PATH)) {
    console.error(`[delta] ! no database at ${DB_PATH} (pass the path as an argument or set NIGHTGATE_DB_PATH); a fresh install uses \`npm run deploy\` instead.`);
    process.exit(1);
}
console.log(`[delta] target: ${DB_PATH}`);

/** SQLite DDL of the shipped model, compiled in-process with @sap/cds; the cds CLI is only the fallback. */
async function compileSqliteDdl() {
    try {
        const cds = require('@sap/cds');
        cds.root = packageRoot;
        const csn = await cds.load(path.join(packageRoot, 'srv'));
        const out = cds.compile.to.sql(csn, { dialect: 'sqlite' });
        return Array.isArray(out) ? out.join(';\n') + ';\n' : String(out);
    } catch (err) {
        console.warn(`[delta] in-process compile failed (${err.message}); falling back to the cds CLI`);
        return execSync('npx cds compile srv --to sql --dialect sqlite', {
            encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, cwd: packageRoot
        });
    }
}
const ddl = await compileSqliteDdl();

// Split into statements on the trailing ");" / semicolon boundaries.
const statements = ddl
    .split(/;\s*\n/)
    .map(s => s.trim())
    .filter(Boolean);

const db = openDatabase(DB_PATH);
const existingTables = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name)
);

let createdTables = 0, addedColumns = 0, refreshedViews = 0, skipped = 0, renamedColumns = 0;

/** Top-level parts of a CREATE TABLE body: column definitions and table constraints. */
function tableParts(createStmt) {
    const body = createStmt.slice(createStmt.indexOf('(') + 1, createStmt.lastIndexOf(')'));
    const parts = [];
    let depth = 0, cur = '';
    for (const ch of body) {
        if (ch === '(') depth++;
        else if (ch === ')') depth--;
        if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; } else cur += ch;
    }
    if (cur.trim()) parts.push(cur);
    return parts.map(p => p.trim());
}

/** Parse top-level column definitions out of a CREATE TABLE statement. */
function parseColumns(createStmt) {
    const cols = [];
    for (const p of tableParts(createStmt)) {
        // Skip table-level constraints; only real columns can be ADD COLUMN'd.
        if (/^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT)\b/i.test(p)) continue;
        const m = p.match(/^("?)(\w+)\1\s+/);
        if (m) cols.push({ name: m[2], def: p });
    }
    return cols;
}

/** Column lists of the table-level UNIQUE constraints, normalized; constraint names are ignored. */
function uniqueKeys(createStmt) {
    return tableParts(createStmt)
        .map(p => p.replace(/^CONSTRAINT\s+("?)\w+\1\s+/i, ''))
        .filter(p => /^UNIQUE\b/i.test(p))
        .map(p => p.replace(/"/g, '').replace(/\s*([(),])\s*/g, '$1').replace(/\s+/g, ' ').toUpperCase())
        .sort();
}

/** SQLite cannot alter a constraint: a table whose unique keys differ from the target is rebuilt. */
function uniqueKeysChanged(name, createStmt) {
    const current = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name)?.sql ?? '';
    return JSON.stringify(uniqueKeys(current)) !== JSON.stringify(uniqueKeys(createStmt));
}

/** Columns of the PRIMARY KEY of a CREATE TABLE statement, in key order. */
function primaryKey(createStmt) {
    const part = tableParts(createStmt)
        .map(p => p.replace(/^CONSTRAINT\s+("?)\w+\1\s+/i, ''))
        .find(p => /^PRIMARY\s+KEY\b/i.test(p));
    if (!part) return [];
    return part.slice(part.indexOf('(') + 1, part.lastIndexOf(')')).split(',').map(c => c.replace(/"/g, '').trim());
}

/** SQLite cannot alter a key either: a table whose key columns differ from the target is rebuilt. */
function primaryKeyChanged(name, createStmt) {
    const current = db.prepare(`PRAGMA table_info("${name}")`).all()
        .filter(r => r.pk > 0).sort((a, b) => a.pk - b.pk).map(r => r.name.toLowerCase());
    return JSON.stringify(current) !== JSON.stringify(primaryKey(createStmt).map(c => c.toLowerCase()));
}

let rebuiltTables = 0;

/**
 * Columns whose NOT NULL was relaxed. SQLite cannot alter a constraint, so the table is rebuilt.
 */
function relaxedColumns(name, createStmt) {
    const info = new Map(
        db.prepare(`PRAGMA table_info("${name}")`).all().map(r => [r.name, r])
    );
    const relaxed = [];
    for (const col of parseColumns(createStmt)) {
        const cur = info.get(col.name);
        if (!cur) continue;
        const targetNotNull = /\bNOT\s+NULL\b/i.test(col.def);
        if (cur.notnull === 1 && !targetNotNull && cur.pk === 0) relaxed.push(col.name);
    }
    return relaxed;
}

/** Columns made NOT NULL with a DEFAULT; their NULL rows take the default before the rebuild. */
function tightenedColumns(name, createStmt) {
    const info = new Map(
        db.prepare(`PRAGMA table_info("${name}")`).all().map(r => [r.name, r])
    );
    const tightened = [];
    for (const col of parseColumns(createStmt)) {
        const cur = info.get(col.name);
        const fallback = col.def.match(/\bDEFAULT\s+('(?:[^']|'')*'|[^\s,]+)/i)?.[1];
        if (cur && cur.notnull === 0 && cur.pk === 0 && fallback && /\bNOT\s+NULL\b/i.test(col.def)) {
            tightened.push({ name: col.name, fallback });
        }
    }
    return tightened;
}

function rebuildTable(name, createStmt) {
    const have = new Set(db.prepare(`PRAGMA table_info("${name}")`).all().map(r => r.name));
    const shared = parseColumns(createStmt).map(c => c.name).filter(n => have.has(n));
    const colList = shared.map(n => `"${n}"`).join(', ');
    // DROP TABLE also drops attached indexes and triggers, so they are saved first and recreated after the rename.
    // Auto-indexes for PK and UNIQUE have NULL sql and come back with the table.
    const attached = db.prepare(
        "SELECT type, name, sql FROM sqlite_master WHERE type IN ('index','trigger') AND tbl_name = ? AND sql IS NOT NULL"
    ).all(name);
    // A column the old table lacks has nothing to copy: like ADD COLUMN, it
    // loses a bare NOT NULL.
    let shaped = createStmt;
    for (const col of parseColumns(createStmt)) {
        if (have.has(col.name) || !/\bNOT\s+NULL\b/i.test(col.def) || /\bDEFAULT\b/i.test(col.def)) continue;
        shaped = shaped.replace(col.def, col.def.replace(/\bNOT\s+NULL\b/i, '').replace(/\s{2,}/g, ' ').trim());
    }
    const tmp = `__delta_new_${name}`;
    const tmpStmt = shaped.replace(/^CREATE TABLE\s+("?)(\w+)\1/i, `CREATE TABLE "${tmp}"`);
    db.exec(`DROP TABLE IF EXISTS "${tmp}";`);
    db.exec(tmpStmt + ';');
    db.exec(`INSERT INTO "${tmp}" (${colList}) SELECT ${colList} FROM "${name}";`);
    db.exec(`DROP TABLE "${name}";`);
    db.exec(`ALTER TABLE "${tmp}" RENAME TO "${name}";`);
    for (const obj of attached) {
        db.exec(obj.sql + ';');
        console.log(`[delta] = restored ${obj.type} ${obj.name} on rebuilt ${name}`);
    }
}

let restoredViews = 0;

const migrate = () => {
    // Drop all views first, since DROP TABLE fails on dependent views.
    // Views not in the DDL are saved here and restored from their SQL afterwards.
    const preViews = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='view'").all();
    for (const v of preViews) {
        db.exec(`DROP VIEW IF EXISTS "${v.name}";`);
    }
    // Renames come before the comparison with the model, which would otherwise add the new names as empty columns.
    const { pendingColumnRenames, pendingTextColumns, pendingDerivedColumns, CHAIN_POSITION_FILLS } = require(path.join(packageRoot, 'srv/utils/db-indexes.js'));
    const columnsOf = (table) => (existingTables.has(table) ? db.prepare(`PRAGMA table_info("${table}")`).all().map(r => r.name) : undefined);
    // A SQLite column keeps the storage class it was created with, so a number column that became text needs a rebuild.
    const typeOf = (table, column) => (existingTables.has(table) ? db.prepare(`PRAGMA table_info("${table}")`).all().find(r => r.name === column)?.type : undefined);
    const toText = pendingTextColumns(typeOf);
    // The model adds the position columns below like any other. Their rows are filled once the columns exist.
    const positionsToFill = pendingDerivedColumns(columnsOf).length > 0;
    for (const r of pendingColumnRenames(columnsOf)) {
        db.exec(`ALTER TABLE "${r.table}" RENAME COLUMN "${r.from}" TO "${r.to}";`);
        console.log(`[delta] ~ renamed ${r.table}.${r.from} to ${r.to}`);
        renamedColumns++;
    }
    const recreatedViews = new Set();
    for (const stmt of statements) {
        const tableMatch = stmt.match(/^CREATE TABLE\s+("?)(\w+)\1/i);
        const viewMatch = stmt.match(/^CREATE VIEW\s+("?)(\w+)\1/i);
        if (tableMatch) {
            const name = tableMatch[2];
            if (existingTables.has(name)) {
                // A relaxed NOT NULL, changed unique keys or a changed key need a rebuild.
                // The rebuild also carries any new columns.
                const relaxed = relaxedColumns(name, stmt);
                const tightened = tightenedColumns(name, stmt);
                const uniqueChanged = uniqueKeysChanged(name, stmt);
                const keyChanged = primaryKeyChanged(name, stmt);
                const retyped = toText.filter(c => c.table === name).map(c => c.column);
                if (relaxed.length > 0 || tightened.length > 0 || uniqueChanged || keyChanged || retyped.length > 0) {
                    for (const col of tightened) {
                        const filled = db.prepare(`UPDATE "${name}" SET "${col.name}" = ${col.fallback} WHERE "${col.name}" IS NULL`).run()?.changes ?? 0;
                        if (filled) console.log(`[delta] = ${name}.${col.name}: ${filled} NULL row(s) set to ${col.fallback}`);
                    }
                    rebuildTable(name, stmt);
                    const why = [
                        relaxed.length > 0 ? `relaxed NOT NULL: ${relaxed.join(', ')}` : '',
                        tightened.length > 0 ? `NOT NULL: ${tightened.map(c => c.name).join(', ')}` : '',
                        uniqueChanged ? 'unique keys changed' : '',
                        keyChanged ? `key is now ${primaryKey(stmt).join(', ')}` : '',
                        retyped.length > 0 ? `text now: ${retyped.join(', ')}` : ''
                    ].filter(Boolean).join('; ');
                    console.log(`[delta] ~ rebuilt ${name} (${why})`);
                    rebuiltTables++;
                    skipped++;
                    continue;
                }
                // Table exists → reconcile columns (additive only).
                const have = new Set(
                    db.prepare(`PRAGMA table_info("${name}")`).all().map(r => r.name)
                );
                for (const col of parseColumns(stmt)) {
                    if (have.has(col.name)) continue;
                    // SQLite ADD COLUMN cannot introduce NOT NULL without a
                    // DEFAULT; additive fields are nullable, so drop a bare
                    // NOT NULL to keep the migration safe.
                    let def = col.def;
                    if (/\bNOT\s+NULL\b/i.test(def) && !/\bDEFAULT\b/i.test(def)) {
                        def = def.replace(/\bNOT\s+NULL\b/i, '').replace(/\s{2,}/g, ' ').trim();
                    }
                    db.exec(`ALTER TABLE "${name}" ADD COLUMN ${def};`);
                    console.log(`[delta] + column ${name}.${col.name}`);
                    addedColumns++;
                }
                skipped++;
                continue;
            }
            db.exec(stmt + ';');
            console.log(`[delta] + table ${name}`);
            createdTables++;
        } else if (viewMatch) {
            const name = viewMatch[2];
            db.exec(`DROP VIEW IF EXISTS "${name}";`);
            db.exec(stmt + ';');
            recreatedViews.add(name);
            refreshedViews++;
        }
    }
    if (positionsToFill) {
        for (const fill of CHAIN_POSITION_FILLS) {
            const filled = db.prepare(fill.sql).run()?.changes ?? 0;
            console.log(`[delta] ~ ${fill.table}: chain position of ${filled} row(s) filled`);
            const unplaced = db.prepare(`SELECT count(*) AS n FROM "${fill.table}" WHERE blockHeight IS NULL`).get()?.n ?? 0;
            if (unplaced > 0) console.warn(`[delta] ! ${unplaced} row(s) of ${fill.table} have no chain position: their block or transaction is missing. reindexFromHeight(0) on the indexer service writes them again`);
        }
    }
    // Secondary indexes, same list the server applies at startup.
    try {
        const { NIGHTGATE_INDEXES, indexStatement } = require(path.join(packageRoot, 'srv/utils/db-indexes.js'));
        for (const spec of NIGHTGATE_INDEXES) {
            if (!existingTables.has(spec.table) && !db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(spec.table)) continue;
            try {
                db.exec(indexStatement(spec) + ';');
            } catch (err) {
                console.warn(`[delta] ! index ${spec.name} not created (${err.message})`);
                continue;
            }
            for (const older of spec.replaces ?? []) db.exec(`DROP INDEX IF EXISTS ${older};`);
        }
        console.log(`[delta] = ensured ${NIGHTGATE_INDEXES.length} secondary index(es)`);
    } catch (err) {
        console.warn(`[delta] ! indexes skipped (${err.message}); the server creates them at startup`);
    }

    // Restore views the target DDL does not manage from their snapshotted SQL.
    for (const v of preViews) {
        if (recreatedViews.has(v.name) || !v.sql) continue;
        try {
            db.exec(v.sql + ';');
            console.log(`[delta] = restored unmanaged view ${v.name}`);
            restoredViews++;
        } catch (err) {
            // Rethrow so the whole transaction rolls back and the view is not lost.
            console.error(`[delta] ! could not restore unmanaged view ${v.name}: ${err.message}`);
            console.error(`[delta] ! original SQL was:\n${v.sql}`);
            console.error('[delta] ! aborting: the migration rolls back, nothing was changed.');
            throw err;
        }
    }
};

// Explicit transaction (node:sqlite has no db.transaction() wrapper): the
// whole migration commits or the database stays exactly as it was.
db.exec('BEGIN');
try {
    migrate();
    db.exec('COMMIT');
} catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* the failing statement may already have aborted it */ }
    db.close();
    throw err;
}
db.close();

console.log(`[delta] done: ${renamedColumns} columns renamed, +${createdTables} tables, +${addedColumns} columns, ${rebuiltTables} rebuilt, ${refreshedViews} views refreshed, ${restoredViews} unmanaged views restored, ${skipped} existing tables reconciled.`);
