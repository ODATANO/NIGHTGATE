// Additive schema migration for an EXISTING db/midnight.db.
//
// `cds deploy` recreates (drops) all tables — destructive, would wipe the
// synced wallet/block state and force a multi-hour cold re-sync. This instead:
//   - CREATE TABLE only when the table is ABSENT (existing data untouched)
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

let createdTables = 0, refreshedViews = 0, skipped = 0;

const tx = db.transaction(() => {
    for (const stmt of statements) {
        const tableMatch = stmt.match(/^CREATE TABLE\s+("?)(\w+)\1/i);
        const viewMatch = stmt.match(/^CREATE VIEW\s+("?)(\w+)\1/i);
        if (tableMatch) {
            const name = tableMatch[2];
            if (existingTables.has(name)) { skipped++; continue; }
            db.exec(stmt + ';');
            console.log(`[delta] + table ${name}`);
            createdTables++;
        } else if (viewMatch) {
            const name = viewMatch[2];
            db.exec(`DROP VIEW IF EXISTS "${name}";`);
            db.exec(stmt + ';');
            refreshedViews++;
        }
    }
});
tx();
db.close();

console.log(`[delta] done: +${createdTables} tables, ${refreshedViews} views refreshed, ${skipped} existing tables untouched.`);
