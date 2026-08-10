// Additive schema migration for an EXISTING db/midnight.db.
//
// `cds deploy` recreates (drops) all tables: destructive, would wipe the
// synced wallet/block state and force a multi-hour cold re-sync. This instead:
//   - CREATE TABLE only when the table is ABSENT (existing data untouched)
//   - ALTER TABLE ADD COLUMN for columns missing from an EXISTING table
//     (additive fields like PredicateAttestations.fieldKey; data untouched)
//   - DROP + CREATE every VIEW (views are stateless; refreshes projections so
//     new service entities like DisclosureGrants/GranteeIdentities are queryable)
//
// DDL is taken from `cds compile srv --to sql --dialect sqlite`. Run with the
// server STOPPED (it holds the DB):  node scripts/apply-schema-delta.mjs

import { execSync } from 'node:child_process';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const DB_PATH = path.resolve('db/midnight.db');
console.log(`[delta] target: ${DB_PATH}`);

const ddl = execSync('npx cds compile srv --to sql --dialect sqlite', {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024
});

// Split into statements on the trailing ");" / semicolon boundaries.
const statements = ddl
    .split(/;\s*\n/)
    .map(s => s.trim())
    .filter(Boolean);

const db = new Database(DB_PATH);
const existingTables = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name)
);

let createdTables = 0, addedColumns = 0, refreshedViews = 0, skipped = 0;

/** Parse top-level column definitions out of a CREATE TABLE statement. */
function parseColumns(createStmt) {
    const body = createStmt.slice(createStmt.indexOf('(') + 1, createStmt.lastIndexOf(')'));
    const parts = [];
    let depth = 0, cur = '';
    for (const ch of body) {
        if (ch === '(') depth++;
        else if (ch === ')') depth--;
        if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; } else cur += ch;
    }
    if (cur.trim()) parts.push(cur);
    const cols = [];
    for (const raw of parts) {
        const p = raw.trim();
        // Skip table-level constraints; only real columns can be ADD COLUMN'd.
        if (/^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT)\b/i.test(p)) continue;
        const m = p.match(/^("?)(\w+)\1\s+/);
        if (m) cols.push({ name: m[2], def: p });
    }
    return cols;
}

let rebuiltTables = 0;

/**
 * Columns whose NOT NULL was RELAXED in the target schema (e.g.
 * PredicateAttestations.op/threshold in 0.15.0). SQLite cannot ALTER a
 * constraint, so the table is rebuilt: create the target shape under a temp
 * name, copy the shared columns (data untouched), drop the old table, rename.
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

function rebuildTable(name, createStmt) {
    const have = new Set(db.prepare(`PRAGMA table_info("${name}")`).all().map(r => r.name));
    const shared = parseColumns(createStmt).map(c => c.name).filter(n => have.has(n));
    const colList = shared.map(n => `"${n}"`).join(', ');
    const tmp = `__delta_new_${name}`;
    const tmpStmt = createStmt.replace(/^CREATE TABLE\s+("?)(\w+)\1/i, `CREATE TABLE "${tmp}"`);
    db.exec(`DROP TABLE IF EXISTS "${tmp}";`);
    db.exec(tmpStmt + ';');
    db.exec(`INSERT INTO "${tmp}" (${colList}) SELECT ${colList} FROM "${name}";`);
    db.exec(`DROP TABLE "${name}";`);
    db.exec(`ALTER TABLE "${tmp}" RENAME TO "${name}";`);
}

let restoredViews = 0;

const tx = db.transaction(() => {
    // Drop ALL views up front: they are stateless and may reference tables
    // that get rebuilt below (DROP TABLE fails on dependent views otherwise).
    // Views managed by the DDL are recreated in this same transaction; any
    // OTHER view (consumer-added, manual) is snapshotted here and restored
    // from its original SQL afterwards, so the migration never silently
    // deletes a view it does not own.
    const preViews = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='view'").all();
    for (const v of preViews) {
        db.exec(`DROP VIEW IF EXISTS "${v.name}";`);
    }
    const recreatedViews = new Set();
    for (const stmt of statements) {
        const tableMatch = stmt.match(/^CREATE TABLE\s+("?)(\w+)\1/i);
        const viewMatch = stmt.match(/^CREATE VIEW\s+("?)(\w+)\1/i);
        if (tableMatch) {
            const name = tableMatch[2];
            if (existingTables.has(name)) {
                // Constraint relaxation (NOT NULL dropped in the target) needs
                // a rebuild; the rebuild also carries any new columns.
                const relaxed = relaxedColumns(name, stmt);
                if (relaxed.length > 0) {
                    rebuildTable(name, stmt);
                    console.log(`[delta] ~ rebuilt ${name} (relaxed NOT NULL: ${relaxed.join(', ')})`);
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
    // Restore views the target DDL does not manage from their snapshotted SQL.
    for (const v of preViews) {
        if (recreatedViews.has(v.name) || !v.sql) continue;
        try {
            db.exec(v.sql + ';');
            console.log(`[delta] = restored unmanaged view ${v.name}`);
            restoredViews++;
        } catch (err) {
            // A custom view may reference something this migration changed.
            // Rethrow so the WHOLE transaction rolls back: the database stays
            // exactly as it was (view included) and the operator resolves the
            // conflict first, instead of the migration committing with the
            // view deleted.
            console.error(`[delta] ! could not restore unmanaged view ${v.name}: ${err.message}`);
            console.error(`[delta] ! original SQL was:\n${v.sql}`);
            console.error('[delta] ! aborting: the migration rolls back, nothing was changed.');
            throw err;
        }
    }
});
tx();
db.close();

console.log(`[delta] done: +${createdTables} tables, +${addedColumns} columns, ${rebuiltTables} rebuilt, ${refreshedViews} views refreshed, ${restoredViews} unmanaged views restored, ${skipped} existing tables reconciled.`);
