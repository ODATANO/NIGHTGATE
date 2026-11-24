#!/usr/bin/env node
// Moves stored per-action contract states to one state per contract plus a hash per action. Stop the server first.
// Run: node scripts/compact-contract-state.mjs [--dry-run] [--batch 100] [sqlite-file]
// Env: NIGHTGATE_DB_URL or NIGHTGATE_DB_PATH; NIGHTGATE_CRAWLER_CONTRACT_STATE_HISTORY keeps full states.

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
const BATCH = Math.max(1, Number(arg('--batch', '100')) || 100);
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
