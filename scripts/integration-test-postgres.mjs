// PostgreSQL integration lane: the plugin's database paths against a REAL
// PostgreSQL, the dialect the hosted deployment and the standalone image run
// on. Everything else in the suite runs on SQLite, which never exercised the
// BYTEA write path, the index DDL or the SQLSTATE-based retry classifier.
//
// Proves:
//   1. the CDS model deploys on the postgres dialect (`cds.deploy`, the same
//      call the image runs on every boot),
//   2. `Transactions.raw` round-trips as BYTES through the BlockProcessor's
//      write path (base64 in, Readable of bytes out, `.columns('raw')`),
//   3. `ensureIndexes` creates the secondary indexes and is idempotent,
//   4. `isLockContention` classifies REAL PostgreSQL errors by SQLSTATE:
//      55P03 (lock timeout), 40P01 (deadlock), 57014 (statement timeout),
//      40001 (serialization failure), and a non-contention error stays out,
//   5. `withLockContentionRetry` completes a write once the blocking
//      transaction releases the row.
//
// Database: `NIGHTGATE_PG_URL` (CI: a service container) or, when unset, a
// throwaway `postgres:16` container on port 15432 that is removed at the end.
// The schema-delta script is SQLite-only (sqlite_master, node:sqlite) and is
// not part of this lane; on PostgreSQL the image redeploys with `cds deploy`.
//
// Run: npm run integration:postgres        (needs Docker or NIGHTGATE_PG_URL)

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const require = createRequire(pathToFileURL(path.join(repoRoot, 'package.json')).href);

let failures = 0;
function ok(name, value, detail) {
    if (!value) {
        console.error(`FAIL ${name}${detail ? ` (${detail})` : ''}`);
        failures++;
    } else {
        console.log(`OK   ${name}${detail ? ` (${detail})` : ''}`);
    }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---- Database: external URL or a throwaway container ----------------------
const CONTAINER = 'nightgate-it-pg';
const LOCAL_URL = 'postgres://nightgate:nightgate@127.0.0.1:15432/nightgate';
let ownContainer = false;

function docker(...args) {
    return execFileSync('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
}

async function startContainer() {
    try { docker('rm', '-f', CONTAINER); } catch { /* not running */ }
    docker('run', '-d', '--rm', '--name', CONTAINER,
        '-e', 'POSTGRES_PASSWORD=nightgate', '-e', 'POSTGRES_USER=nightgate', '-e', 'POSTGRES_DB=nightgate',
        '-p', '15432:5432', 'postgres:16');
    ownContainer = true;
    for (let i = 0; i < 60; i++) {
        try {
            docker('exec', CONTAINER, 'pg_isready', '-U', 'nightgate', '-q');
            // pg_isready can pass during the init restart; a real connect settles it.
            await sleep(1000);
            docker('exec', CONTAINER, 'pg_isready', '-U', 'nightgate', '-q');
            return;
        } catch { await sleep(1000); }
    }
    throw new Error('PostgreSQL container did not become ready within 60 s');
}

function stopContainer() {
    if (!ownContainer) return;
    try { docker('rm', '-f', CONTAINER); } catch { /* already gone */ }
}

const dbUrl = process.env.NIGHTGATE_PG_URL?.trim();
if (!dbUrl) {
    console.log(`[postgres] no NIGHTGATE_PG_URL, starting ${CONTAINER} (postgres:16)`);
    await startContainer();
}
process.chdir(repoRoot);
process.env.NIGHTGATE_DB_URL = dbUrl || LOCAL_URL;
process.env.SKIP_AUTO_INIT = 'true';

let cds;
try {
    // The image's own CAP wiring: postgres kind injected, generic pool.
    const cfgMod = await import(pathToFileURL(path.join(repoRoot, 'docker/cds-config.mjs')).href);
    const cfg = cfgMod.cdsConfig(process.env, { dbOnly: true });
    process.env.CDS_CONFIG = JSON.stringify(cfg);
    const creds = cfg.requires.db.credentials;

    cds = require('@sap/cds');
    cds.root = repoRoot;
    const { Client } = require('pg');
    const pgClient = () => new Client({ host: creds.host, port: creds.port, user: creds.user, password: creds.password, database: creds.database, ...(creds.ssl ? { ssl: creds.ssl } : {}) });

    // ---- 1. Deploy the model ----------------------------------------------
    const csn = await cds.load('*');
    const db = await cds.connect.to('db');
    ok('postgres: CAP connected with the postgres kind', db.constructor.name === 'PostgresService', db.constructor.name);
    await cds.deploy(csn).to(db);
    const tables = await db.run("SELECT tablename FROM pg_tables WHERE schemaname = current_schema() AND tablename LIKE 'midnight_%'");
    ok('postgres: model deployed (midnight_* tables)', tables.length >= 27, `${tables.length} tables`);
    const rawType = await db.run("SELECT data_type FROM information_schema.columns WHERE table_name = 'midnight_transactions' AND column_name = 'raw'");
    ok('postgres: Transactions.raw is BYTEA', rawType[0]?.data_type === 'bytea', rawType[0]?.data_type);

    // ---- 2. raw round trip through the BlockProcessor ---------------------
    const { BlockProcessor } = require('./srv/crawler/BlockProcessor.js');
    const env = cds.env;
    env.requires.nightgate = env.requires.nightgate || {};
    env.requires.nightgate.palletMap = { ...(env.requires.nightgate.palletMap || {}), 10: { name: 'Contracts', txType: 'contract_call' } };
    const extrinsic = '0x' + Buffer.from([0x0c, 0x04, 10, 0]).toString('hex'); // unsigned contract_call
    const tsBuf = Buffer.alloc(8);
    tsBuf.writeBigUInt64LE(1_700_000_000n * 1000n);
    const timestampHex = '0x' + tsBuf.toString('hex');
    const provider = {
        getBlock: async () => ({ block: { header: { parentHash: '0xnoparent-pg', number: '0x09', stateRoot: '0xstate-pg' }, extrinsics: [extrinsic] }, justifications: null }),
        getRuntimeVersion: async () => ({ specVersion: 77 }),
        // Timestamp::Now for the timestamp key, no System.Events (null).
        getStorage: async (key) => (/^0xf0c365c3/.test(key) ? timestampHex : null),
        getMetadata: async () => { throw new Error('no metadata in this lane'); }
    };
    const processor = new BlockProcessor(provider);
    processor.db = db;
    // This lane pins the WRITE path, not event decoding: the runtime context
    // (registry + pallet map) for the spec version is pre-seeded so no
    // metadata fetch happens; the default pallet map classifies the extrinsic.
    processor.runtimes?.set?.(77, { registry: { metadata: { pallets: [] } }, palletMap: processor.defaultPalletMap });
    await db.run(cds.ql.DELETE.from('midnight.SyncState'));
    await db.run(cds.ql.INSERT.into('midnight.SyncState').entries({ ID: 'SINGLETON', syncStatus: 'stopped', lastIndexedHeight: 0, chainHeight: 0, consecutiveErrors: 0 }));
    const warn = cds.log('nightgate:crawler').warn;
    cds.log('nightgate:crawler').warn = () => undefined;
    try {
        await processor.processBlockByHash('0xrawbytes-pg');
    } finally {
        cds.log('nightgate:crawler').warn = warn;
    }
    const txRows = await db.run(cds.ql.SELECT.from('midnight.Transactions').columns('ID', 'raw'));
    ok('postgres: BlockProcessor persisted one transaction', txRows.length === 1, `${txRows.length} rows`);
    let stored = Buffer.alloc(0);
    if (txRows[0]?.raw) {
        const chunks = [];
        for await (const c of txRows[0].raw) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
        stored = Buffer.concat(chunks);
    }
    ok('postgres: Transactions.raw reads back as the extrinsic bytes', stored.toString('hex') === extrinsic.slice(2), stored.toString('hex') || 'empty');
    const rawLen = await db.run("SELECT octet_length(raw) AS n FROM midnight_transactions");
    ok('postgres: BYTEA holds the raw bytes, not text', Number(rawLen[0]?.n) === 4, `octet_length=${rawLen[0]?.n}`);
    const actions = await db.run(cds.ql.SELECT.from('midnight.ContractActions').columns('ID', 'state'));
    ok('postgres: ContractActions.state stays null', actions.length === 1 && actions[0].state === null);

    // ---- 3. Secondary indexes ---------------------------------------------
    const { ensureIndexes, NIGHTGATE_INDEXES } = require('./srv/utils/db-indexes.js');
    const warnings = [];
    const created = await ensureIndexes(db, 'postgres', (m) => warnings.push(m));
    ok('postgres: ensureIndexes creates every index', created === NIGHTGATE_INDEXES.length && warnings.length === 0, `${created}/${NIGHTGATE_INDEXES.length}, warnings: ${warnings.join('; ') || 'none'}`);
    const idx = await db.run("SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND indexname LIKE 'ng\\_%'");
    ok('postgres: pg_indexes lists them', idx.length === NIGHTGATE_INDEXES.length, `${idx.length}`);
    const again = await ensureIndexes(db, 'postgres', (m) => warnings.push(m));
    ok('postgres: ensureIndexes is idempotent', again === NIGHTGATE_INDEXES.length && warnings.length === 0);

    // ---- 4. Lock-contention classification on REAL errors -----------------
    const retry = require('./srv/submission/db-write-retry.js');
    const a = pgClient();
    const b = pgClient();
    await a.connect();
    await b.connect();
    await a.query("CREATE TABLE IF NOT EXISTS ng_lane_lock (id int PRIMARY KEY, n int)");
    await a.query("DELETE FROM ng_lane_lock");
    await a.query("INSERT INTO ng_lane_lock VALUES (1, 0), (2, 0)");
    const caught = async (fn) => { try { await fn(); return null; } catch (err) { return err; } };

    // 55P03: a lock_timeout expires behind a row lock.
    await a.query('BEGIN');
    await a.query('SELECT * FROM ng_lane_lock WHERE id = 1 FOR UPDATE');
    await b.query("SET lock_timeout = '200ms'");
    const lockErr = await caught(() => b.query('UPDATE ng_lane_lock SET n = n + 1 WHERE id = 1'));
    ok('postgres: lock timeout is 55P03 and classified as contention', lockErr?.code === '55P03' && retry.isLockContention(lockErr), `${lockErr?.code}: ${lockErr?.message}`);

    // 5. withLockContentionRetry succeeds once the lock is released.
    retry.__setLockContentionBackoffForTests([0, 100, 300, 600, 1000]);
    const release = sleep(500).then(() => a.query('COMMIT'));
    const attempts = [];
    const result = await retry.withLockContentionRetry('lane', async () => {
        attempts.push(Date.now());
        return b.query('UPDATE ng_lane_lock SET n = n + 1 WHERE id = 1 RETURNING n');
    }, (m) => attempts.push(m));
    await release;
    retry.__resetLockContentionBackoffForTests();
    const retried = attempts.filter(x => typeof x === 'string').length;
    ok('postgres: withLockContentionRetry completes after the lock is released', result?.rows?.[0]?.n === 1 && retried >= 1, `${retried} retry warning(s)`);
    await b.query("RESET lock_timeout");

    // 40P01: two transactions update the same rows in opposite order.
    await a.query('BEGIN');
    await b.query('BEGIN');
    await a.query('UPDATE ng_lane_lock SET n = n + 1 WHERE id = 1');
    await b.query('UPDATE ng_lane_lock SET n = n + 1 WHERE id = 2');
    const aWait = caught(() => a.query('UPDATE ng_lane_lock SET n = n + 1 WHERE id = 2'));
    await sleep(100);
    const bErr = await caught(() => b.query('UPDATE ng_lane_lock SET n = n + 1 WHERE id = 1'));
    const aErr = await aWait;
    const deadlock = [aErr, bErr].find(e => e?.code === '40P01');
    ok('postgres: deadlock is 40P01 and classified as contention', Boolean(deadlock) && retry.isLockContention(deadlock), deadlock ? deadlock.message : `a=${aErr?.code} b=${bErr?.code}`);
    await caught(() => a.query('ROLLBACK'));
    await caught(() => b.query('ROLLBACK'));

    // 57014: statement_timeout cancels a query.
    await b.query("SET statement_timeout = '100ms'");
    const stmtErr = await caught(() => b.query('SELECT pg_sleep(2)'));
    await b.query('RESET statement_timeout');
    ok('postgres: statement timeout is 57014 and classified as contention', stmtErr?.code === '57014' && retry.isLockContention(stmtErr), `${stmtErr?.code}: ${stmtErr?.message}`);

    // 40001: serializable write skew.
    await a.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await b.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await a.query('SELECT sum(n) FROM ng_lane_lock');
    await b.query('SELECT sum(n) FROM ng_lane_lock');
    await a.query('UPDATE ng_lane_lock SET n = n + 10 WHERE id = 1');
    await b.query('UPDATE ng_lane_lock SET n = n + 10 WHERE id = 2');
    const aCommit = await caught(() => a.query('COMMIT'));
    const bCommit = await caught(() => b.query('COMMIT'));
    const serial = [aCommit, bCommit].find(e => e?.code === '40001');
    ok('postgres: serialization failure is 40001 and classified as contention', Boolean(serial) && retry.isLockContention(serial), serial ? serial.message : `a=${aCommit?.code ?? 'ok'} b=${bCommit?.code ?? 'ok'}`);
    await caught(() => a.query('ROLLBACK'));
    await caught(() => b.query('ROLLBACK'));

    // A constraint violation is NOT contention (must propagate, never retry).
    const dupErr = await caught(() => a.query('INSERT INTO ng_lane_lock VALUES (1, 0)'));
    ok('postgres: duplicate key (23505) is not classified as contention', dupErr?.code === '23505' && !retry.isLockContention(dupErr), `${dupErr?.code}`);

    await a.query('DROP TABLE ng_lane_lock');
    await a.end();
    await b.end();
} catch (err) {
    console.error(`FAIL lane aborted: ${err?.stack ?? err}`);
    failures++;
} finally {
    try { await cds?.disconnect?.(); } catch { /* best effort */ }
    stopContainer();
}

if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
}
console.log('\nintegration-test-postgres: all checks passed');
process.exit(0);
