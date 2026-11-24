// Checks deploy, BYTEA round trip, indexes and lock-contention retry against a real PostgreSQL.
// Run: npm run integration:postgres
// Env: NIGHTGATE_PG_URL, else a throwaway postgres:16 container on port 15432 is used (needs Docker).

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
        // Timestamp::Now for the timestamp key; System.Events are stubbed below.
        getStorage: async (key) => (/^0xf0c365c3/.test(key) ? timestampHex : null),
        getMetadata: async () => { throw new Error('no metadata in this lane'); }
    };
    const processor = new BlockProcessor(provider);
    processor.db = db;
    // This lane pins the WRITE path, not event decoding: the runtime context
    // (registry + pallet map) for the spec version is pre-seeded so no
    // metadata fetch happens; the default pallet map classifies the extrinsic.
    processor.runtimes?.set?.(77, { registry: { metadata: { pallets: [] } }, palletMap: processor.defaultPalletMap });
    // A block with extrinsics needs its events; this lane has none to decode, so it projects none.
    processor.decodeBlockEvents = () => null;
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

    // ---- 2b. LargeBinary written by UPDATE (contract states, ledger parameters) ----
    const { upsertCurrentState } = require('./srv/crawler/contract-state.js');
    const { readCapBinary, capBinaryInput } = require('./srv/crawler/cap-binary.js');
    const stateA = Buffer.from('midnight:contract-state[v6]:A');
    const stateB = Buffer.from('midnight:contract-state[v6]:B-longer');
    const stateRow = (bytes, height) => ({
        contractAddress: 'ab'.repeat(32), height, state: bytes.toString('base64'), zswapState: bytes.toString('base64'),
        stateHash: 'h'.repeat(64), zswapStateHash: 'z'.repeat(64), contractActionId: actions[0].ID
    });
    await upsertCurrentState(db, stateRow(stateA, 9));
    await upsertCurrentState(db, stateRow(stateB, 10));
    const csRow = await db.run(cds.ql.SELECT.one.from('midnight.ContractStates').columns('state', 'zswapState').where({ contractAddress: 'ab'.repeat(32) }));
    const csBytes = await readCapBinary(csRow?.state);
    ok('postgres: ContractStates.state written by UPDATE reads back as the bytes', csBytes?.equals(stateB) === true, csBytes ? csBytes.subarray(0, 32).toString() : 'null');
    const csLen = await db.run("SELECT octet_length(state) AS n FROM midnight_contractstates");
    ok('postgres: BYTEA holds the state bytes, not base64 text', Number(csLen[0]?.n) === stateB.length, `octet_length=${csLen[0]?.n}, bytes=${stateB.length}`);
    await db.run(cds.ql.UPDATE.entity('midnight.ContractActions').set({ state: capBinaryInput(stateA.toString('base64')) }).where({ ID: actions[0].ID }));
    const caRow = await db.run(cds.ql.SELECT.one.from('midnight.ContractActions').columns('state').where({ ID: actions[0].ID }));
    ok('postgres: ContractActions.state written by UPDATE reads back as the bytes', (await readCapBinary(caRow?.state))?.equals(stateA) === true);
    const blockRow = await db.run(cds.ql.SELECT.one.from('midnight.Blocks').columns('ID'));
    await db.run(cds.ql.UPDATE.entity('midnight.Blocks').set({ ledgerParameters: capBinaryInput(stateA.toString('base64')) }).where({ ID: blockRow.ID }));
    const lpLen = await db.run("SELECT octet_length(ledgerparameters) AS n FROM midnight_blocks WHERE ledgerparameters IS NOT NULL");
    ok('postgres: Blocks.ledgerParameters written by UPDATE holds the bytes', Number(lpLen[0]?.n) === stateA.length, `octet_length=${lpLen[0]?.n}`);

    // ---- 2c. Rows in old formats --------------------------------------------
    const { findOldStoredFormats } = require('./srv/utils/old-stored-formats.js');
    const base64Rows = async () => (await findOldStoredFormats(db, 'postgres')).find(f => f.name === 'postgres-base64-binary')?.rows ?? 0;
    ok('postgres: binary columns written as bytes count as migrated', await base64Rows() === 0);
    await db.run(`UPDATE midnight_blocks SET ledgerparameters = convert_to('${stateA.toString('base64')}', 'UTF8') WHERE ID = '${blockRow.ID}'`);
    ok('postgres: a binary column holding base64 text counts as one row to migrate', await base64Rows() === 1);
    await db.run(cds.ql.UPDATE.entity('midnight.Blocks').set({ ledgerParameters: capBinaryInput(stateA.toString('base64')) }).where({ ID: blockRow.ID }));

    // ---- 3. Secondary indexes ---------------------------------------------
    const { ensureIndexes, NIGHTGATE_INDEXES } = require('./srv/utils/db-indexes.js');
    const warnings = [];
    const created = await ensureIndexes(db, 'postgres', (m) => warnings.push(m));
    ok('postgres: ensureIndexes creates every index', created === NIGHTGATE_INDEXES.length && warnings.length === 0, `${created}/${NIGHTGATE_INDEXES.length}, warnings: ${warnings.join('; ') || 'none'}`);
    const idx = await db.run("SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND indexname LIKE 'ng\\_%'");
    ok('postgres: pg_indexes lists them', idx.length === NIGHTGATE_INDEXES.length, `${idx.length}`);
    const again = await ensureIndexes(db, 'postgres', (m) => warnings.push(m));
    ok('postgres: ensureIndexes is idempotent', again === NIGHTGATE_INDEXES.length && warnings.length === 0);
    const unspentIndex = (await db.run("SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'ng_unshieldedutxos_unspent_position'"))[0]?.indexdef ?? '';
    ok('postgres: the index of the unspent UTXOs holds only those rows, newest first',
        /\(blockheight DESC, indexinblock DESC, outputindex DESC\) WHERE \(spentattransaction_id IS NULL\)$/.test(unspentIndex), unspentIndex);
    // The two reads these indexes serve. One contract has only the newest actions, so walking the table by position would pass every other row first.
    await db.run(`INSERT INTO midnight_contractactions (id, blockheight, indexinblock, actionindex, contractaddress, actiontype, transaction_id, createdat)
        SELECT 'lane-' || i, i, 0, 0, md5((i % 40)::text), 'CALL', 'lane-tx', now() FROM generate_series(1, 4000) AS i`);
    await db.run(`INSERT INTO midnight_contractactions (id, blockheight, indexinblock, actionindex, contractaddress, actiontype, transaction_id, createdat)
        SELECT 'lane-new-' || i, 5000 + i, 0, 0, md5('newest'), 'CALL', 'lane-tx', now() FROM generate_series(1, 20) AS i`);
    await db.run(`INSERT INTO midnight_unshieldedutxos (id, blockheight, indexinblock, owner, tokentype, value, intenthash, outputindex, initialnonce, createdattransaction_id, spentattransaction_id, createdat)
        SELECT 'lane-' || i, i, 0, 'mn_addr_lane', '00', 1, md5(i::text), 0, md5('n' || i::text), 'lane-tx', CASE WHEN i % 3 = 0 THEN NULL ELSE 'lane-spend' END, now()
        FROM generate_series(1, 4000) AS i`);
    await db.run('ANALYZE midnight_contractactions');
    await db.run('ANALYZE midnight_unshieldedutxos');
    const planner = pgClient();
    await planner.connect();
    const planOf = async (sql) => (await planner.query(`EXPLAIN ${sql}`)).rows.map(r => r['QUERY PLAN']).join(' | ');
    // The ORDER BY is what an OData read sends: the position, then the key CAP appends.
    const actionsPlan = await planOf("SELECT id FROM midnight_contractactions WHERE contractaddress = md5('newest') ORDER BY blockheight ASC, indexinblock ASC, actionindex ASC, id ASC LIMIT 10");
    ok('postgres: the oldest actions of a contract come from its index, read backwards',
        actionsPlan.includes('Index Scan Backward using ng_contractactions_address_position') && !actionsPlan.includes('Seq Scan'), actionsPlan);
    const newestActionsPlan = await planOf("SELECT id FROM midnight_contractactions WHERE contractaddress = md5('newest') ORDER BY blockheight DESC, indexinblock DESC, actionindex DESC, id ASC LIMIT 10");
    ok('postgres: the newest actions of a contract come from the same index, read forwards',
        newestActionsPlan.includes('Index Scan using ng_contractactions_address_position') && !newestActionsPlan.includes('Seq Scan'), newestActionsPlan);
    const unspentPlan = await planOf('SELECT id FROM midnight_unshieldedutxos WHERE spentattransaction_id IS NULL ORDER BY blockheight DESC, indexinblock DESC, outputindex DESC, id ASC LIMIT 10');
    ok('postgres: the newest unspent UTXOs come from their index',
        unspentPlan.includes('Index Scan using ng_unshieldedutxos_unspent_position') && !unspentPlan.includes('Seq Scan'), unspentPlan);
    const ownerPlan = await planOf("SELECT id FROM midnight_unshieldedutxos WHERE owner = 'mn_addr_lane' ORDER BY blockheight DESC, indexinblock DESC, outputindex DESC, id ASC LIMIT 10");
    ok('postgres: the newest UTXOs of an owner come from their index',
        ownerPlan.includes('Index Scan using ng_unshieldedutxos_owner_position') && !ownerPlan.includes('Seq Scan'), ownerPlan);
    await planner.end();
    await db.run("DELETE FROM midnight_contractactions WHERE id LIKE 'lane-%'");
    await db.run("DELETE FROM midnight_unshieldedutxos WHERE id LIKE 'lane-%'");

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

    // ---- Queries the services send -----------------------------------------
    const { SELECT, INSERT } = cds.ql;
    const offer = (n, tags) => ({
        ID: `11111111-0000-4000-8000-00000000000${n}`, offer: 'AA==', givesType: 'ab'.repeat(32), givesAmount: '1',
        wantsType: 'cd'.repeat(32), wantsAmount: '2', bound: false, nullifiers: '[]', status: 'open', posterUserId: 'lane-user', tags: JSON.stringify(tags)
    });
    await db.run(INSERT.into('midnight.SwapOffers').entries([offer(1, ['carbon', 'eu']), offer(2, ['car']), offer(3, ['100%_wind'])]));
    // The same filter as listSwapOffers with `tag`: the quoted tag inside the JSON text.
    const tagged = async (tag) => (await db.run(SELECT.from('midnight.SwapOffers').columns('ID').where`contains(tags, ${JSON.stringify(tag)})`))
        .map(r => String(r.ID).slice(-1)).sort().join(',');
    const byTag = { carbon: await tagged('carbon'), car: await tagged('car'), wind: await tagged('100%_wind'), wildcard: await tagged('1_0%_wind') };
    ok('postgres: the tag filter of the offer board keeps the rows that hold the quoted tag', byTag.carbon === '1' && byTag.car === '2', JSON.stringify(byTag));
    ok('postgres: % and _ in a tag are plain characters, not wildcards', byTag.wind === '3' && byTag.wildcard === '', JSON.stringify(byTag));

    // The start-up step that retires the open offers posted for one taker.
    await db.run(INSERT.into('midnight.SwapOffers').entries([
        { ...offer(4, []), takerSecretHash: 'ef'.repeat(32) },
        { ...offer(5, []), takerSecretHash: 'ef'.repeat(32), status: 'filled' }
    ]));
    const { retireOffersForOneTaker } = require('./srv/submission/swap-offers.js');
    const retiredCount = await retireOffersForOneTaker(db);
    const statuses = (await db.run(SELECT.from('midnight.SwapOffers').columns('ID', 'status')))
        .map(r => `${String(r.ID).slice(-1)}=${r.status}`).sort().join(',');
    ok('postgres: only the open offers posted for one taker are retired at start',
        retiredCount === 1 && statuses === '1=open,2=open,3=open,4=retired,5=filled', `${retiredCount} ${statuses}`);

    // The start-up step that gives proof and grant rows the owner of the job that wrote them.
    const old = '2026-01-10T10:00:00.000Z';
    const proof = (n, userId) => ({
        ID: `55555555-0000-4000-8000-00000000000${n}`, payloadHash: 'ab'.repeat(32), contractAddress: 'cd'.repeat(32),
        predicate: 'greaterOrEqual', op: 1, threshold: '5', userId, createdAt: old, modifiedAt: old
    });
    await db.run(INSERT.into('midnight.PredicateAttestations').entries([proof(1, null), proof(2, null), proof(3, 'kept')]));
    const proofJob = (n, createdAt) => ({
        ID: `66666666-0000-4000-8000-00000000000${n}`, kind: 'proveFieldPredicate', status: 'succeeded', requestedBy: 'lane-user',
        sessionId: `33333333-0000-4000-8000-00000000000${n}`, request: JSON.stringify({ predicateAttestationId: proof(n).ID }), createdAt, modifiedAt: createdAt
    });
    await db.run(INSERT.into('midnight.BackgroundJobs').entries([proofJob(1, old), proofJob(2, '2026-01-11T10:00:00.000Z'), proofJob(3, old)]));
    const { backfillRowOwners, moveStoredDiffCounts } = require('./srv/submission/job-store.js');
    const filledCount = await backfillRowOwners(db);
    const ownersNow = (await db.run(SELECT.from('midnight.PredicateAttestations').columns('ID', 'userId', 'sessionId')))
        .map(r => `${String(r.ID).slice(-1)}=${r.userId ?? '-'}/${r.sessionId ? String(r.sessionId).slice(-1) : '-'}`).sort().join(',');
    ok('postgres: a proof row without an owner gets the user and session of its job, within the time bound',
        filledCount === 1 && ownersNow === '1=lane-user/1,2=-/-,3=kept/-', `${filledCount} ${ownersNow}`);

    // The start-up step that gives the k of a stored document diff its own column.
    const LARGEST = '18446744073709551615';
    await db.run(INSERT.into('midnight.PredicateAttestations').entries([
        { ...proof(4, 'kept'), predicate: 'documentDiff', op: null, threshold: '3' }, { ...proof(5, 'kept'), threshold: LARGEST }
    ]));
    const movedCount = await moveStoredDiffCounts(db);
    const countsNow = (await db.run(SELECT.from('midnight.PredicateAttestations').columns('ID', 'threshold', 'k').where({ ID: { in: [proof(4).ID, proof(5).ID] } })))
        .map(r => `${String(r.ID).slice(-1)}=${r.threshold ?? '-'}/${r.k ?? '-'}`).sort().join(',');
    ok('postgres: a stored document diff gets its k in its own column, and a threshold of 2^64-1 is kept exactly',
        movedCount === 1 && countsNow === `4=-/3,5=${LARGEST}/-`, `${movedCount} ${countsNow}`);

    // The same filter as a READ of PendingSubmissions by a user: the user's sessions as a subquery.
    const session = (n, userId) => ({ sessionId: `33333333-0000-4000-8000-00000000000${n}`, userId, connectedAt: new Date().toISOString() });
    await db.run(INSERT.into('midnight.WalletSessions').entries([session(1, 'lane-user'), session(2, 'lane-user'), session(3, 'someone-else')]));
    const pending = (n) => ({ ID: `44444444-0000-4000-8000-00000000000${n}`, sessionId: `33333333-0000-4000-8000-00000000000${n}`, actionType: 'CALL', submittedAt: new Date().toISOString() });
    await db.run(INSERT.into('midnight.PendingSubmissions').entries([pending(1), pending(2), pending(3)]));
    const own = await db.run(SELECT.from('midnight.PendingSubmissions').columns('ID')
        .where({ sessionId: { in: SELECT.from('midnight.WalletSessions').columns('sessionId').where({ userId: 'lane-user' }) } }));
    const ownIds = own.map(r => String(r.ID).slice(-1)).sort().join(',');
    ok('postgres: pending submissions are narrowed to the sessions of one user by a subquery', ownIds === '1,2', ownIds);

    // ---- A database of the last release with the older names ----------------
    // The released model goes into its own schema. The tool and a deploy of the current model bring it forward.
    const { CHAIN_POSITION_COLUMNS, COLUMN_RENAMES, COLUMNS_TO_TEXT, KEY_CHANGES } = require('./srv/utils/db-indexes.js');
    const upgradeSchema = 'nightgate_upgrade_lane';
    await db.run(`DROP SCHEMA IF EXISTS ${upgradeSchema} CASCADE`);
    await db.run(`CREATE SCHEMA ${upgradeSchema}`);
    const upgradeDb = { ...cfg.requires.db, credentials: { ...creds, schema: upgradeSchema } };
    const upgradeEnv = { ...process.env, CDS_CONFIG: JSON.stringify({ ...cfg, requires: { ...cfg.requires, db: upgradeDb } }) };
    const upgrade = await cds.connect.to('upgrade-lane', upgradeDb);
    const released = path.join(repoRoot, 'test/fixtures/model-0.46.3');
    await cds.deploy(await cds.load([path.join(released, 'db'), path.join(released, 'srv')])).to(upgrade);
    const oldJobId = '77777777-0000-4000-8000-000000000001';
    const oldSessionId = '99999999-0000-4000-8000-000000000001';
    await upgrade.run(`INSERT INTO midnight_backgroundjobs (id, kind, status, txhash, indexertxhash) VALUES ('${oldJobId}', 'sponsorUnboundTransaction', 'succeeded', '00${'ab'.repeat(32)}', '${'cd'.repeat(32)}')`);
    await upgrade.run("INSERT INTO midnight_blocks (id, hash, height, protocolversion, timestamp) VALUES ('88888888-0000-4000-8000-000000000001', 'b10c', 7, 1, 1)");
    await upgrade.run("INSERT INTO midnight_transactions (id, transactionid, hash, ledgertxhash, protocolversion, transactiontype, block_id) VALUES ('88888888-0000-4000-8000-000000000002', 3, 'e0e0', 'f1f1', 1, 'REGULAR', '88888888-0000-4000-8000-000000000001')");
    await upgrade.run(`INSERT INTO midnight_walletsessions (id, sessionid, userid, connectedat, isactive, label) VALUES ('88888888-0000-4000-8000-000000000003', '${oldSessionId}', 'lane-user', now(), true, 'kept')`);
    await upgrade.run("INSERT INTO midnight_predicateattestations (id, payloadhash, contractaddress, predicate, threshold) VALUES ('88888888-0000-4000-8000-000000000004', 'aa', 'cc', 'greaterOrEqual', 9223372036854775807)");
    await upgrade.run("INSERT INTO midnight_contractactions (id, actionindex, address, actiontype, entrypoint, transaction_id) VALUES ('88888888-0000-4000-8000-000000000005', 1, 'c0', 'CALL', '5:0', '88888888-0000-4000-8000-000000000002')");
    await upgrade.run("INSERT INTO midnight_contractactions (id, actionindex, address, actiontype, entrypoint, transaction_id) VALUES ('88888888-0000-4000-8000-000000000007', 2, 'c0', 'CALL', 'attest', '88888888-0000-4000-8000-000000000002')");
    await upgrade.run("UPDATE midnight_transactions SET circuitname = '5:0' WHERE id = '88888888-0000-4000-8000-000000000002'");
    await upgrade.run("INSERT INTO midnight_unshieldedutxos (id, owner, tokentype, value, intenthash, outputindex, initialnonce, createdattransaction_id) VALUES ('88888888-0000-4000-8000-000000000006', 'mn_addr_x', '00', '5', 'i1', 0, 'n1', '88888888-0000-4000-8000-000000000002')");
    const columnsOf = async (table) => (await upgrade.run(`SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = '${table}'`)).map(r => r.column_name);
    const oldJobs = await columnsOf('midnight_backgroundjobs');
    const oldView = await columnsOf('nightgateservice_transactions');
    const typeOf = async (table, column) => (await upgrade.run(`SELECT data_type FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = '${table}' AND column_name = '${column}'`))[0]?.data_type;
    const WIDENED = [['midnight_blocks', 'timestamp'], ['midnight_unshieldedutxos', 'ctime'], ['midnight_backgroundjobs', 'chainblockheight'], ['midnight_pendingsubmissions', 'chainblockheight']];
    const oldTypes = await Promise.all(WIDENED.map(([table, column]) => typeOf(table, column)));
    ok('postgres: the released schema keeps block times and job block heights in 32 bit', oldTypes.every(t => t === 'integer'), oldTypes.join(','));
    ok('postgres: the released schema is in place, tables and views', oldJobs.includes('indexertxhash') && !oldJobs.includes('txid') && oldView.includes('hash'), `${oldJobs.join(',')} | ${oldView.join(',')}`);

    const tool = path.join(repoRoot, 'scripts/apply-schema-delta.mjs');
    const firstRun = execFileSync(process.execPath, [tool, '--postgres'], { cwd: repoRoot, env: upgradeEnv }).toString();
    ok('postgres: the tool renames every column, moves every key and retypes every number column that became text',
        firstRun.includes(`${COLUMN_RENAMES.length} column(s) renamed, ${KEY_CHANGES.length} key(s) moved, ${COLUMNS_TO_TEXT.length} column(s) text now, ${CHAIN_POSITION_COLUMNS.length} position column(s) filled`), firstRun.trim().split('\n').at(-1));
    const placed = (await upgrade.run(`SELECT 't' AS row, blockheight, indexinblock FROM midnight_transactions WHERE id = '88888888-0000-4000-8000-000000000002'
        UNION ALL SELECT 'a', blockheight, indexinblock FROM midnight_contractactions WHERE id = '88888888-0000-4000-8000-000000000005'
        UNION ALL SELECT 'u', blockheight, indexinblock FROM midnight_unshieldedutxos WHERE id = '88888888-0000-4000-8000-000000000006' ORDER BY 1`))
        .map(r => `${r.row}=${r.blockheight}.${r.indexinblock}`).join(',');
    ok('postgres: a transaction, its action and its UTXO carry their place in the chain after the tool', placed === 'a=7.3,t=7.3,u=7.3', placed);
    const circuits = (await upgrade.run(`SELECT 't' AS row, circuit FROM midnight_transactions WHERE id = '88888888-0000-4000-8000-000000000002'
        UNION ALL SELECT 'a' || actionindex, circuit FROM midnight_contractactions WHERE transaction_id = '88888888-0000-4000-8000-000000000002' ORDER BY 1`))
        .map(r => `${r.row}=${r.circuit}`).join(',');
    ok('postgres: a pallet call index kept as the circuit is cleared, a circuit name stays', circuits === 'a1=null,a2=attest,t=null', circuits);
    const nullable = (await upgrade.run(`SELECT count(*) AS n FROM information_schema.columns WHERE table_schema = current_schema() AND is_nullable = 'YES'
        AND (table_name, column_name) IN (${CHAIN_POSITION_COLUMNS.map(c => `('${c.table.toLowerCase()}', '${c.column.toLowerCase()}')`).join(', ')})`))[0].n;
    ok('postgres: every position column is NOT NULL after the tool', Number(nullable) === 0, String(nullable));
    const thresholdType = await typeOf('midnight_predicateattestations', 'threshold');
    const keptThreshold = (await upgrade.run("SELECT threshold FROM midnight_predicateattestations WHERE id = '88888888-0000-4000-8000-000000000004'"))[0];
    ok('postgres: the threshold of a proof is text after the tool and keeps its value',
        thresholdType === 'character varying' && keptThreshold?.threshold === '9223372036854775807', `${thresholdType} ${JSON.stringify(keptThreshold)}`);
    const jobCols = await columnsOf('midnight_backgroundjobs');
    const txCols = await columnsOf('midnight_transactions');
    const idCols = await columnsOf('midnight_transactionidentifiers');
    ok('postgres: the tables carry the new names, the old ones are gone',
        ['txid', 'txhash'].every(c => jobCols.includes(c)) && !jobCols.includes('indexertxhash')
            && ['indexinblock', 'extrinsichash', 'txhash'].every(c => txCols.includes(c)) && !['transactionid', 'hash', 'ledgertxhash'].some(c => txCols.includes(c))
            && idCols.includes('txid') && !idCols.includes('identifier'),
        `${jobCols.join(',')} | ${txCols.join(',')} | ${idCols.join(',')}`);
    const movedJob = (await upgrade.run(`SELECT txid, txhash FROM midnight_backgroundjobs WHERE id = '${oldJobId}'`))[0];
    ok('postgres: a job keeps its identifier and its hash through the rename', movedJob?.txid === `00${'ab'.repeat(32)}` && movedJob?.txhash === 'cd'.repeat(32), JSON.stringify(movedJob));
    const sessionCols = await columnsOf('midnight_walletsessions');
    const sessionKey = (await upgrade.run("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = to_regclass('midnight_walletsessions') AND contype IN ('p', 'u')")).map(r => r.def).join(' | ');
    ok('postgres: a wallet session is keyed by its session id, the former key column and the unique constraint are gone',
        !sessionCols.includes('id') && sessionKey === 'PRIMARY KEY (sessionid)', `${sessionCols.join(',')} | ${sessionKey}`);
    const storedModel = JSON.parse((await upgrade.run('SELECT csn FROM cds_model'))[0].csn).definitions;
    const storedSessionKeys = Object.entries(storedModel['midnight.WalletSessions'].elements).filter(([, e]) => e.key).map(([name]) => name).join(',');
    ok('postgres: the stored model names the columns and the key as the tables do, and has forgotten the dropped views',
        'txId' in storedModel['midnight.BackgroundJobs'].elements && !('indexerTxHash' in storedModel['midnight.BackgroundJobs'].elements)
            && storedSessionKeys === 'sessionId' && !('NightgateService.WalletSessions' in storedModel) && !('NightgateAdminService.WalletSessions' in storedModel),
        `${Object.keys(storedModel['midnight.BackgroundJobs'].elements).join(',')} | key ${storedSessionKeys}`);

    let redeploy = null;
    try { await cds.deploy(csn).to(upgrade); } catch (err) { redeploy = err; }
    ok('postgres: the deploy after the tool goes through', redeploy === null, redeploy?.message);
    const newTypes = await Promise.all(WIDENED.map(([table, column]) => typeOf(table, column.replace('chainblockheight', 'blockheight'))));
    ok('postgres: block times and job block heights are 64 bit after the upgrade', newTypes.every(t => t === 'bigint'), newTypes.join(','));
    const keptBlock = (await upgrade.run("SELECT timestamp FROM midnight_blocks WHERE id = '88888888-0000-4000-8000-000000000001'"))[0];
    ok('postgres: a block keeps its time through the wider column', String(keptBlock?.timestamp) === '1', JSON.stringify(keptBlock));
    const txView = await columnsOf('nightgateservice_transactions');
    const sessionView = await columnsOf('nightgateservice_walletsessions');
    ok('postgres: the views carry the new names after the deploy',
        ['indexinblock', 'extrinsichash', 'txhash'].every(c => txView.includes(c)) && !['transactionid', 'hash', 'ledgertxhash'].some(c => txView.includes(c))
            && sessionView.includes('sessionid') && !sessionView.includes('id'),
        `${txView.join(',')} | ${sessionView.join(',')}`);
    const viewedTx = (await upgrade.run('SELECT indexinblock, extrinsichash, txhash FROM nightgateservice_transactions'))[0];
    ok('postgres: a transaction keeps its position and both hashes, read through its view',
        Number(viewedTx?.indexinblock) === 3 && viewedTx?.extrinsichash === 'e0e0' && viewedTx?.txhash === 'f1f1', JSON.stringify(viewedTx));
    const chainIndexes = (await upgrade.run("SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND tablename IN ('midnight_transactions', 'midnight_contractactions', 'midnight_unshieldedutxos')")).map(r => r.indexname);
    ok('postgres: the position indexes are there after the upgrade and none sorts a chain table by its insert time',
        chainIndexes.filter(n => n.endsWith('_position')).length === 8 && !chainIndexes.some(n => n.includes('createdat')), chainIndexes.join(','));
    const actionKey = (await upgrade.run("SELECT is_nullable FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'midnight_contractactions' AND column_name = 'actionindex'"))[0];
    ok('postgres: the index of an action in its transaction is NOT NULL after the deploy', actionKey?.is_nullable === 'NO', JSON.stringify(actionKey));
    const viewedProof = (await upgrade.run('SELECT threshold, k FROM nightgateservice_predicateattestations'))[0];
    ok('postgres: a proof keeps its threshold, read through its view, and has a column for k',
        viewedProof?.threshold === '9223372036854775807' && viewedProof?.k === null, JSON.stringify(viewedProof));
    const viewedSession = (await upgrade.run('SELECT sessionid, userid, label FROM nightgateservice_walletsessions'))[0];
    ok('postgres: a wallet session keeps its session id, read through its view',
        viewedSession?.sessionid === oldSessionId && viewedSession?.userid === 'lane-user' && viewedSession?.label === 'kept', JSON.stringify(viewedSession));
    const secondRun = execFileSync(process.execPath, [tool, '--postgres'], { cwd: repoRoot, env: upgradeEnv }).toString();
    ok('postgres: a second run of the tool changes nothing', secondRun.includes('0 column(s) renamed, 0 key(s) moved, 0 column(s) text now, 0 position column(s) filled'), secondRun.trim().split('\n').at(-1));
    let secondDeploy = null;
    try { await cds.deploy(csn).to(upgrade); } catch (err) { secondDeploy = err; }
    ok('postgres: a second deploy goes through', secondDeploy === null, secondDeploy?.message);
    await upgrade.disconnect?.();
    await db.run(`DROP SCHEMA ${upgradeSchema} CASCADE`);

    // The start-up step that sorts values an older version kept under one name.
    await db.run(INSERT.into('midnight.BackgroundJobs').entries([
        { ID: '77777777-0000-4000-8000-000000000001', kind: 'sponsorUnbound', status: 'succeeded', txId: `00${'ab'.repeat(32)}`, txHash: 'cd'.repeat(32) },
        { ID: '77777777-0000-4000-8000-000000000002', kind: 'submitContractCall', status: 'succeeded', txId: 'ef'.repeat(32), txHash: null }
    ]));
    const { sortStoredTxValues } = require('./srv/submission/job-store.js');
    const sorted = await sortStoredTxValues(db);
    const sortedJob = (await db.run("SELECT txid, txhash FROM midnight_backgroundjobs WHERE id = '77777777-0000-4000-8000-000000000002'"))[0];
    ok('postgres: a ledger hash an older version kept as the identifier moves to txHash',
        sorted === 1 && sortedJob?.txid === null && sortedJob?.txhash === 'ef'.repeat(32), `${sorted} ${JSON.stringify(sortedJob)}`);
    // The start-up step that gives stored jobs and grants the current action names.
    await db.run(INSERT.into('midnight.BackgroundJobs').entries([
        { ID: '77777777-0000-4000-8000-000000000003', kind: 'issueFieldPredicateAttestation', status: 'succeeded' },
        { ID: '77777777-0000-4000-8000-000000000004', kind: 'retract', status: 'succeeded', request: JSON.stringify({ mode: 1, key: 'ab' }) }
    ]));
    await db.run(INSERT.into('midnight.AgentGrants').entries({
        ID: '77777777-0000-4000-8000-000000000005', userId: 'lane', sessionId: '77777777-0000-4000-8000-000000000006',
        tokenHash: '7'.repeat(64), allowedActions: JSON.stringify(['sponsorUnboundTransaction', 'sponsorSwap'])
    }));
    const { renameStoredActions } = require('./srv/submission/job-store.js');
    const renamedRows = await renameStoredActions(db);
    const renamedKinds = (await db.run("SELECT kind FROM midnight_backgroundjobs WHERE id IN ('77777777-0000-4000-8000-000000000003', '77777777-0000-4000-8000-000000000004') ORDER BY id"))
        .map(r => r.kind).join(',');
    const renamedGrant = (await db.run("SELECT allowedactions FROM midnight_agentgrants WHERE id = '77777777-0000-4000-8000-000000000005'"))[0];
    ok('postgres: stored jobs and grants take the current action names',
        renamedRows >= 3 && renamedKinds === 'proveFieldPredicate,purgeExpired' && renamedGrant?.allowedactions === '["sponsorUnbound","sponsorSwap"]',
        `${renamedRows} ${renamedKinds} ${renamedGrant?.allowedactions}`);
    ok('postgres: a second run renames nothing', await renameStoredActions(db) === 0);

    // ---- A read that takes too long is stopped ------------------------------
    // A lock on the table makes the read wait, so it reaches its time limit at a known moment.
    cds.env.requires.auth = { kind: 'dummy' };
    cds.model ??= cds.compile.for.nodejs(csn);
    const app = require('express')();
    await cds.serve('all').in(app);
    const server = require('node:http').createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const readBlocks = async () => {
        const started = Date.now();
        const res = await fetch(`http://127.0.0.1:${server.address().port}/odata/v4/midnight/Blocks?$top=1`);
        return { status: res.status, error: (await res.json().catch(() => ({}))).error, ms: Date.now() - started };
    };
    const blocker = pgClient();
    await blocker.connect();
    process.env.NIGHTGATE_QUERY_TIMEOUT_MS = '300';
    try {
        await blocker.query('BEGIN');
        // Without a mode PostgreSQL takes the strongest lock, which also blocks reads.
        await blocker.query('LOCK TABLE midnight_blocks');
        const stopped = await readBlocks();
        ok('postgres: a read past its time limit answers 504 QUERY_TIMEOUT',
            stopped.status === 504 && stopped.error?.code === 'QUERY_TIMEOUT' && stopped.ms < 5000, `${stopped.status} ${JSON.stringify(stopped.error)} after ${stopped.ms} ms`);
        await blocker.query('ROLLBACK');
        const after = await readBlocks();
        ok('postgres: the read after it runs as usual', after.status === 200, `${after.status} ${JSON.stringify(after.error)}`);
    } finally {
        delete process.env.NIGHTGATE_QUERY_TIMEOUT_MS;
        await blocker.end();
        server.close();
    }
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
