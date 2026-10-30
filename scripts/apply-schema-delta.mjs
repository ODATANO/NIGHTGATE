#!/usr/bin/env node
// Additive SQLite schema migration: creates missing tables and columns, rebuilds changed constraints, refreshes views.
// Run with the server stopped: node scripts/apply-schema-delta.mjs [dbPath] (installed: npx nightgate-schema-delta)
// Target: first CLI arg, else NIGHTGATE_DB_PATH, else db/midnight.db. PostgreSQL and HANA use their own deployer.

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// Resolve everything relative to the PACKAGE root (works from a repo checkout
// AND from an installed node_modules/@odatano/nightgate via the bin alias).
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

let createdTables = 0, addedColumns = 0, refreshedViews = 0, skipped = 0;

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
    const recreatedViews = new Set();
    for (const stmt of statements) {
        const tableMatch = stmt.match(/^CREATE TABLE\s+("?)(\w+)\1/i);
        const viewMatch = stmt.match(/^CREATE VIEW\s+("?)(\w+)\1/i);
        if (tableMatch) {
            const name = tableMatch[2];
            if (existingTables.has(name)) {
                // A relaxed NOT NULL or changed unique keys need a rebuild; the
                // rebuild also carries any new columns.
                const relaxed = relaxedColumns(name, stmt);
                const tightened = tightenedColumns(name, stmt);
                const uniqueChanged = uniqueKeysChanged(name, stmt);
                if (relaxed.length > 0 || tightened.length > 0 || uniqueChanged) {
                    for (const col of tightened) {
                        const filled = db.prepare(`UPDATE "${name}" SET "${col.name}" = ${col.fallback} WHERE "${col.name}" IS NULL`).run()?.changes ?? 0;
                        if (filled) console.log(`[delta] = ${name}.${col.name}: ${filled} NULL row(s) set to ${col.fallback}`);
                    }
                    rebuildTable(name, stmt);
                    const why = [
                        relaxed.length > 0 ? `relaxed NOT NULL: ${relaxed.join(', ')}` : '',
                        tightened.length > 0 ? `NOT NULL: ${tightened.map(c => c.name).join(', ')}` : '',
                        uniqueChanged ? 'unique keys changed' : ''
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
            if (spec.replaces) db.exec(`DROP INDEX IF EXISTS ${spec.replaces};`);
        }
        console.log(`[delta] = ensured ${NIGHTGATE_INDEXES.length} secondary index(es)`);
    } catch (err) {
        console.warn(`[delta] ! indexes skipped (${err.message}); the server creates them at startup`);
    }

    // A Transactions.raw stored as "0x..." text is lossy and cannot be re-encoded.
    // Clear it and the ContractActions.state copy; reindexFromHeight(0) restores both from the chain.
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
            // Values derived from the extrinsic envelope are wrong; the crawler now reads them from chain events.
            // Clear them; a re-index writes the real ones. Only a database with lossy raw values reaches this.
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

    // Before 0.25.0 the crawler wrote the substrate header's state root into a
    // column named ledgerParameters, which is a different thing entirely. The
    // value is good, the column was wrong: move it across once.
    try {
        const cols = new Set(db.prepare('PRAGMA table_info("midnight_Blocks")').all().map(r => r.name));
        if (cols.has('stateRoot') && cols.has('ledgerParameters')) {
            const moved = db.prepare(
                'UPDATE midnight_Blocks SET stateRoot = ledgerParameters, ledgerParameters = NULL ' +
                'WHERE stateRoot IS NULL AND ledgerParameters IS NOT NULL'
            ).run()?.changes ?? 0;
            if (moved > 0) {
                console.log(`[delta] ~ moved ${moved} Blocks.ledgerParameters value(s) written before 0.25.0 into stateRoot, where they belong`);
            }
        }
    } catch (err) {
        console.warn(`[delta] ! Blocks.stateRoot migration skipped (${err.message})`);
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

console.log(`[delta] done: +${createdTables} tables, +${addedColumns} columns, ${rebuiltTables} rebuilt, ${refreshedViews} views refreshed, ${restoredViews} unmanaged views restored, ${skipped} existing tables reconciled.`);
