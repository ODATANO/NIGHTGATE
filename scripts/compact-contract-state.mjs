#!/usr/bin/env node
// Move stored per-action contract states to the hash-per-action layout.
//
//   npx nightgate-compact-contract-state [--dry-run] [--batch 100] [sqlite-file]
//
// Writes the newest state per contract into ContractStates, a sha256 and the
// size onto every contract action, and clears the full per-action state unless
// NIGHTGATE_CRAWLER_CONTRACT_STATE_HISTORY (watched / all, with
// NIGHTGATE_CRAWLER_CONTRACT_STATE_WATCH) keeps it. Idempotent.
//
// Database like the server: NIGHTGATE_DB_URL (postgres://...) or the SQLite
// file (first argument, NIGHTGATE_DB_PATH, default db/midnight.db). Stop the
// server first, or at least its supplement pass. The space returns to the file
// system only after `VACUUM FULL midnight_contractactions` (PostgreSQL, takes
// an exclusive lock) or `VACUUM` (SQLite).

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
const DRY = process.argv.includes('--dry-run');
const BATCH = Math.max(1, Number(arg('--batch', '100')) || 100);
const positional = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && all[i - 1] !== '--batch');

const cds = requireFromHost('@sap/cds', 'Run this from a CAP project that has @sap/cds installed.');
const { postgresCredentials, postgresKind } = await import(new URL('../docker/cds-config.mjs', import.meta.url).href);

const dbUrl = String(process.env.NIGHTGATE_DB_URL ?? '').trim();
if (dbUrl) {
    requireFromHost('@cap-js/postgres/package.json', 'Install it in the host: npm i @cap-js/postgres');
    cds.env.requires.kinds = { ...(cds.env.requires.kinds ?? {}), postgres: postgresKind() };
    cds.env.requires.db = { kind: 'postgres', credentials: postgresCredentials(dbUrl) };
} else {
    const dbPath = path.resolve(positional[0] || process.env.NIGHTGATE_DB_PATH || path.join(packageRoot, 'db/midnight.db'));
    if (!fs.existsSync(dbPath)) {
        console.error(`[contract-state] no database at ${dbPath} (pass the path as an argument, set NIGHTGATE_DB_PATH, or NIGHTGATE_DB_URL for PostgreSQL)`);
        process.exit(2);
    }
    cds.env.requires.db = { kind: 'sqlite', credentials: { url: dbPath } };
}

const { compactStoredContractState, contractStatePolicy } = require(path.join(packageRoot, 'srv/crawler/contract-state.js'));
const { configEnum, configList } = require(path.join(packageRoot, 'srv/utils/config.js'));

const policy = contractStatePolicy(
    configEnum('NIGHTGATE_CRAWLER_CONTRACT_STATE_HISTORY'),
    configList('NIGHTGATE_CRAWLER_CONTRACT_STATE_WATCH')
);
console.log(`[contract-state] history: ${policy.history}${policy.watched.size ? ` (${policy.watched.size} watched)` : ''}${DRY ? ' (dry run)' : ''}`);

const model = await cds.load('*');
cds.model = cds.compile.for.nodejs(model);
const db = await cds.connect.to('db');

try {
    const report = await compactStoredContractState(db, {
        policy, batchSize: BATCH, dryRun: DRY, log: m => console.log(`[contract-state] ${m}`)
    });
    console.log(`[contract-state] ${JSON.stringify(report)}`);
    if (!DRY && report.statesCleared > 0) {
        console.log(dbUrl
            ? '[contract-state] reclaim the space with the server stopped: VACUUM FULL midnight_contractactions;'
            : '[contract-state] reclaim the space with the server stopped: VACUUM;');
    }
} catch (err) {
    console.error(`[contract-state] ! ${err?.message ?? err}`);
    process.exitCode = 1;
} finally {
    await cds.disconnect?.();
}
