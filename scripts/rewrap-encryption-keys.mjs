#!/usr/bin/env node
// Re-encrypt every stored ciphertext under the ACTIVE encryption key.
//
//   npx nightgate-rewrap-keys [--dry-run] [--batch 200] [--drop-legacy-sync-state]
//
// Key ring from the environment: ENCRYPTION_KEYS="id=secret,id=secret" plus
// ENCRYPTION_KEY_ACTIVE=<id>; the legacy ENCRYPTION_KEY is id `1`. Keep the
// OLD key in the ring while this runs; remove it afterwards. Refuses to write
// when a stored ciphertext names a key id that is not in the ring.
//
// Database like the server: NIGHTGATE_DB_URL (postgres://...) or the SQLite
// file (first argument, NIGHTGATE_DB_PATH, default db/midnight.db). Stop the
// server first: a running process would keep writing under its own ring.
//
// Rewraps every ring-sealed value (WalletSessions.encryptedViewingKey /
// encryptedSeedKey, BackgroundJobs.command aes-gcm-v1, AccountKeys.wrappedDek,
// the per-account data key that private states, signing keys and sync-state
// blobs are encrypted under) without any wallet secret. Rows written BEFORE
// the account key (keyScheme null) need the wallet's viewing key: they are
// migrated for every session whose viewing key the ring still opens and
// reported otherwise. Exit codes: 0 = nothing legacy remains, the old key may
// leave the ring; 1 = legacy rows remain (or an error), keep the old key;
// 2 = usage. --drop-legacy-sync-state deletes the legacy sync-state rows of
// accounts without a readable session (those wallets re-sync from genesis);
// private state and signing keys are never dropped by this tool.

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
const DROP_LEGACY_SYNC = process.argv.includes('--drop-legacy-sync-state');
const BATCH = Math.max(1, Number(arg('--batch', '200')) || 200);
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
    const report = await rewrapStoredCiphertexts(db, { ring, dryRun: DRY, batchSize: BATCH, dropLegacySyncState: DROP_LEGACY_SYNC, log: m => console.log(`[rewrap] ${m}`) });
    const total = report.envelope.reduce((n, e) => n + e.rewrapped, 0) + report.syncState.blobsRewrapped + report.privateState.rowsRewrapped;
    console.log(`[rewrap] ${DRY ? 'would rewrap' : 'rewrapped'} ${total} value(s) under key '${report.activeId}'`);
    const legacy = report.legacy;
    const stuck = legacy.accounts.filter(a => !report.migratableAccounts.includes(a));
    if (legacy.total > 0 && (!DRY || stuck.length > 0)) {
        for (const t of legacy.tables) if (t.rows > 0) console.log(`[rewrap] ! ${t.entity}: ${t.rows} legacy ${t.what} of ${t.accounts} account(s)`);
        for (const a of stuck) console.log(`[rewrap] ! account ${a.slice(0, 16)}: no session with a readable viewing key; its rows migrate when the wallet reconnects`);
        console.log(`[rewrap] ! ${DRY ? 'after a real run ' : ''}${stuck.length} account(s) keep rows under a pre-account-key derivation. The key they were written under MUST stay in the ring until every one of them has reconnected (run this tool again until it reports zero legacy rows), or until their sync-state rows are dropped (--drop-legacy-sync-state; private state and signing keys are never dropped).`);
        process.exitCode = 1;
    } else if (!DRY) {
        console.log('[rewrap] done, no legacy rows remain; the old key can leave the ring once every server using this database has restarted with the new ring');
    } else {
        console.log('[rewrap] dry run: a real run leaves no legacy rows behind');
    }
} catch (err) {
    console.error(`[rewrap] ! ${err?.message ?? err}`);
    process.exitCode = 1;
} finally {
    await cds.disconnect?.();
}
