#!/usr/bin/env node
// Re-encrypts every stored ciphertext under the active key. Stop the server first; exit 0 means the old key may leave the ring.
// Run: node scripts/rewrap-encryption-keys.mjs [--dry-run] [--batch 200]
// Env: ENCRYPTION_KEYS="id=secret,..." with the old key, ENCRYPTION_KEY_ACTIVE, and NIGHTGATE_DB_URL or NIGHTGATE_DB_PATH.

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');


function arg(name, fallback) {
    const i = process.argv.indexOf(name);
    if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
    return fallback;
}
const DRY = process.argv.includes('--dry-run');
const BATCH = Math.max(1, Number(arg('--batch', '200')) || 200);
const positional = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && all[i - 1] !== '--batch');

const cds = require('@sap/cds');
const { postgresCredentials, postgresKind } = await import(new URL('../docker/cds-config.mjs', import.meta.url).href);

const dbUrl = String(process.env.NIGHTGATE_DB_URL ?? '').trim();
if (dbUrl) {
    cds.env.requires.kinds = { ...(cds.env.requires.kinds ?? {}), postgres: postgresKind() };
    cds.env.requires.db = { kind: 'postgres', credentials: postgresCredentials(dbUrl) };
} else {
    const dbPath = path.resolve(positional[0] || process.env.NIGHTGATE_DB_PATH || path.join(packageRoot, 'db/midnight.db'));
    if (!fs.existsSync(dbPath)) {
        console.error(`[rewrap] no database at ${dbPath} (pass the path as an argument, set NIGHTGATE_DB_PATH, or NIGHTGATE_DB_URL for PostgreSQL)`);
        process.exit(2);
    }
    cds.env.requires.db = { kind: 'sqlite', credentials: { url: dbPath } };
}

const { getEncryptionKey, parseKeyRingSpec } = require(path.join(packageRoot, 'srv/utils/crypto.js'));
const { rewrapStoredCiphertexts } = require(path.join(packageRoot, 'srv/utils/encryption-rewrap.js'));

if (!parseKeyRingSpec()) {
    console.error('[rewrap] no key ring: set ENCRYPTION_KEYS (id=secret,...) with ENCRYPTION_KEY_ACTIVE, or ENCRYPTION_KEY');
    process.exit(2);
}
const ring = getEncryptionKey();
console.log(`[rewrap] ring keys: ${ring.ids().join(', ')}; active: ${ring.activeId}${DRY ? ' (dry run)' : ''}`);

const model = await cds.load('*');
cds.model = cds.compile.for.nodejs(model);
const db = await cds.connect.to('db');

try {
    const report = await rewrapStoredCiphertexts(db, { ring, dryRun: DRY, batchSize: BATCH, log: m => console.log(`[rewrap] ${m}`) });
    const total = report.envelope.reduce((n, e) => n + e.rewrapped, 0);
    const unreadable = report.envelope.reduce((n, e) => n + e.unreadable, 0);
    console.log(`[rewrap] ${DRY ? 'would rewrap' : 'rewrapped'} ${total} value(s) under key '${report.activeId}'`);
    if (unreadable > 0) {
        console.log(`[rewrap] ! ${unreadable} value(s) could not be read and stay under their old key. That key MUST stay in the ring.`);
        process.exitCode = 1;
    } else if (!DRY) {
        console.log('[rewrap] done; the old key can leave the ring once every server using this database has restarted with the new ring');
    }
} catch (err) {
    console.error(`[rewrap] ! ${err?.message ?? err}`);
    process.exitCode = 1;
} finally {
    await cds.disconnect?.();
}
