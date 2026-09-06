#!/usr/bin/env node
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
// (installed package: `npx nightgate-schema-delta`).
//
// Target file: first CLI arg > NIGHTGATE_DB_PATH > db/midnight.db. The Docker
// image sets NIGHTGATE_DB_PATH=/data/nightgate.db, so running this inside the
// container (or with that env var) migrates the right file.
//
// SQLITE ONLY: this tool rewrites a SQLite file in place. PostgreSQL/HANA
// deployments migrate through their own deployer (`cds deploy` against the
// managed service / `@cap-js/hana` delta handling), not through this script.

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// Resolve everything relative to the PACKAGE root (works from a repo checkout
// AND from an installed node_modules/@odatano/nightgate via the bin alias).
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// SQLite driver: prefer Node's BUILT-IN `node:sqlite` (>= 22.5), so neither
// CI nor a consumer needs a native module. better-sqlite3 is only an OPTIONAL
// peer of @cap-js/sqlite, i.e. not guaranteed to be installed; it stays as a
// fallback for older runtimes. Both expose the prepare/all/get/exec surface
// this script uses; only transactions differ (handled explicitly below).
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

const DB_PATH = path.resolve(process.argv[2] || process.env.NIGHTGATE_DB_PATH || path.join(packageRoot, 'db/midnight.db'));
if (!fs.existsSync(DB_PATH)) {
    console.error(`[delta] ! no database at ${DB_PATH} (pass the path as an argument or set NIGHTGATE_DB_PATH); a fresh install uses \`npm run deploy\` instead.`);
    process.exit(1);
}
console.log(`[delta] target: ${DB_PATH}`);

/**
 * The SQLite DDL of the shipped model. Compiled IN-PROCESS with @sap/cds
 * (a dependency of every consumer); the `cds` CLI lives in @sap/cds-dk,
 * which a host app does not have, so it is only the fallback.
 */
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
    // DROP TABLE also drops every index and trigger attached to it; snapshot
    // them from sqlite_master first and recreate them after the rename (same
    // transaction), so a rebuild never silently loses operator-added indexes
    // or triggers. Auto-indexes (PK/UNIQUE) carry NULL sql and recreate
    // themselves with the table.
    const attached = db.prepare(
        "SELECT type, name, sql FROM sqlite_master WHERE type IN ('index','trigger') AND tbl_name = ? AND sql IS NOT NULL"
    ).all(name);
    const tmp = `__delta_new_${name}`;
    const tmpStmt = createStmt.replace(/^CREATE TABLE\s+("?)(\w+)\1/i, `CREATE TABLE "${tmp}"`);
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
    // Secondary indexes (0.23.0), same list the server applies at startup.
    try {
        const { NIGHTGATE_INDEXES, indexStatement } = require(path.join(packageRoot, 'srv/utils/db-indexes.js'));
        for (const spec of NIGHTGATE_INDEXES) {
            if (!existingTables.has(spec.table) && !db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(spec.table)) continue;
            db.exec(indexStatement(spec) + ';');
        }
        console.log(`[delta] = ensured ${NIGHTGATE_INDEXES.length} secondary index(es)`);
    } catch (err) {
        console.warn(`[delta] ! indexes skipped (${err.message}); the server creates them at startup`);
    }

    // 0.23.0: Transactions.raw was written as the "0x..." HEX TEXT of the
    // extrinsic through CAP's binary transport, which base64-DECODES a string
    // (invalid characters dropped, a trailing partial group truncated) and
    // stores what that yields. The stored value is therefore LOSSY: it cannot
    // be turned back into the extrinsic by any re-encoding. Clear those
    // values (they start with "0x" because full base64 groups round-trip; a
    // genuine extrinsic never encodes to "0x..." since 0xd3 is no valid
    // compact length prefix) and the second copy ContractActions.state held;
    // reindexFromHeight(0) restores them from the chain.
    try {
        if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='midnight_Transactions'").get()) {
            const lossy = db.prepare("SELECT count(*) AS n FROM midnight_Transactions WHERE typeof(raw) = 'text' AND raw LIKE '0x%'").get()?.n ?? 0;
            if (lossy > 0) db.exec("UPDATE midnight_Transactions SET raw = NULL WHERE typeof(raw) = 'text' AND raw LIKE '0x%';");
            let stateCleared = 0;
            if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='midnight_ContractActions'").get()) {
                stateCleared = db.prepare("UPDATE midnight_ContractActions SET state = NULL WHERE state IS NOT NULL").run()?.changes ?? 0;
            }
            if (lossy > 0 || stateCleared > 0) {
                console.log(`[delta] ~ cleared ${lossy} lossy Transactions.raw value(s) written before 0.23.0 and ${stateCleared} ContractActions.state copy(ies); run reindexFromHeight(0) on the indexer service to restore the extrinsic bytes`);
            // Values derived from the extrinsic ENVELOPE before 0.23.0: a
            // "contract address" minted from the extrinsic hash, and a NIGHT
            // "transfer" (sender, receiver, amount, UTXO, balance) read from any
            // signed extrinsic whose args parsed as MultiAddress + Compact. The
            // ledger payload is not decoded, so the columns are null and the
            // derived rows go; a re-index writes none of them back.
            const addrCleared = db.prepare("UPDATE midnight_ContractActions SET address = NULL WHERE address IS NOT NULL").run()?.changes ?? 0;
            const txCleared = db.prepare("UPDATE midnight_Transactions SET contractAddress = NULL, senderAddress = NULL, receiverAddress = NULL, nightAmount = NULL WHERE contractAddress IS NOT NULL OR senderAddress IS NOT NULL OR receiverAddress IS NOT NULL OR nightAmount IS NOT NULL").run()?.changes ?? 0;
            let utxoCleared = 0, balanceCleared = 0;
            if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='midnight_UnshieldedUtxos'").get()) utxoCleared = db.prepare("DELETE FROM midnight_UnshieldedUtxos").run()?.changes ?? 0;
            if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='midnight_NightBalances'").get()) balanceCleared = db.prepare("DELETE FROM midnight_NightBalances").run()?.changes ?? 0;
            if (addrCleared || txCleared || utxoCleared || balanceCleared)
                console.log(`[delta] ~ cleared envelope-derived values written before 0.23.0: ${addrCleared} ContractActions.address, ${txCleared} Transactions sender/receiver/amount/contractAddress, ${utxoCleared} UnshieldedUtxos row(s), ${balanceCleared} NightBalances row(s)`);
            }
        }
    } catch (err) {
        console.warn(`[delta] ! raw cleanup skipped (${err.message}); run reindexFromHeight(0) once the server is up`);
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

console.log(`[delta] done: +${createdTables} tables, +${addedColumns} columns, ${rebuiltTables} rebuilt, ${refreshedViews} views refreshed, ${restoredViews} unmanaged views restored, ${skipped} existing tables reconciled.`);
