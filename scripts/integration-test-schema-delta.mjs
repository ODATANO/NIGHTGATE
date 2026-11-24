// Checks apply-schema-delta.mjs on a SQLite database of the last release: renamed columns, moved key, kept rows,
// filled chain positions, operator indexes and triggers. Run: node scripts/integration-test-schema-delta.mjs

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
// The built-in driver, the same one the tool uses.
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);
const cds = require('@sap/cds');

let failures = 0;
function ok(name, value, detail) {
    if (!value) {
        console.error(`FAIL ${name}${detail ? ` (${detail})` : ''}`);
        failures++;
    } else {
        console.log(`OK   ${name}`);
    }
}

const dir = mkdtempSync(path.join(tmpdir(), 'nightgate-delta-'));
const dbPath = path.join(dir, 'released.db');
const tool = path.join(repoRoot, 'scripts/apply-schema-delta.mjs');

// ---- A database deployed from the model of the last release ----------------
const released = path.join(repoRoot, 'test/fixtures/model-0.46.3');
const releasedCsn = await cds.load([path.join(released, 'db'), path.join(released, 'srv')]);
const db = new DatabaseSync(dbPath);
for (const statement of cds.compile.to.sql(releasedCsn, { dialect: 'sqlite' })) db.exec(statement);
db.exec(`
CREATE INDEX operator_pa_payload_idx ON midnight_PredicateAttestations (payloadHash);
CREATE TRIGGER operator_pa_touch AFTER UPDATE ON midnight_PredicateAttestations
BEGIN
    UPDATE midnight_PredicateAttestations SET modifiedAt = 'touched' WHERE ID = NEW.ID;
END;
INSERT INTO midnight_Blocks (ID, hash, height, protocolVersion, timestamp) VALUES ('b-7', 'b10c', 7, 1, 1);
INSERT INTO midnight_Transactions (ID, transactionId, hash, ledgerTxHash, protocolVersion, transactionType, circuitName, block_ID)
VALUES ('tx-7', 2, 'e0e0', 'f1f1', 1, 'REGULAR', '5:0', 'b-7');
INSERT INTO midnight_ContractActions (ID, actionIndex, address, actionType, entryPoint, transaction_ID)
VALUES ('ca-index', 0, 'c0', 'CALL', '5:0', 'tx-7'), ('ca-named', 1, 'c0', 'CALL', 'attest', 'tx-7');
INSERT INTO midnight_UnshieldedUtxos (ID, owner, tokenType, value, intentHash, outputIndex, initialNonce, createdAtTransaction_ID)
VALUES ('utxo-7', 'mn_addr_x', '00', '5', 'i1', 0, 'n1', 'tx-7');
INSERT INTO midnight_WalletSessions (ID, sessionId, userId, connectedAt, isActive, label)
VALUES ('row-id', 'sess-1', 'alice', '2026-11-01T00:00:00Z', 1, 'kept');
INSERT INTO midnight_PredicateAttestations (ID, payloadHash, contractAddress, predicate, threshold)
VALUES ('pa-1', 'aa', 'cc', 'lessOrEqual', 42), ('pa-max', 'aa', 'cc', 'lessOrEqual', 9223372036854775807);
INSERT INTO midnight_DisclosureGrants (ID, payloadHash, grantee, level, contractAddress, active) VALUES ('dg-1', 'p1', 'g1', 1, 'c1', 1);
INSERT INTO midnight_BackgroundJobs (ID, kind, status, txHash, indexerTxHash) VALUES ('job-1', 'sponsorUnbound', 'succeeded', '00identifier', 'cdcd');
INSERT INTO midnight_PendingSubmissions (ID, sessionId, actionType, submittedAt, status, txHash) VALUES ('sub-1', 'sess-1', 'CALL', '2026-11-01T00:00:00Z', 'submitted', '00identifier');
`);
db.close();

const firstRun = execFileSync(process.execPath, [tool, dbPath], { cwd: repoRoot }).toString();
process.stdout.write(firstRun);

const after = new DatabaseSync(dbPath, { readOnly: true });
const columnsOf = table => new Map(after.prepare(`PRAGMA table_info("${table}")`).all().map(r => [r.name, r]));

// ---- Renamed columns, with their values ------------------------------------
{
    const tx = columnsOf('midnight_Transactions');
    ok('Transactions columns carry their new names, the old ones are gone',
        ['indexInBlock', 'extrinsicHash', 'txHash', 'circuit'].every(c => tx.has(c)) && !['transactionId', 'hash', 'ledgerTxHash', 'circuitName'].some(c => tx.has(c)),
        [...tx.keys()].join(','));
    const moved = after.prepare("SELECT indexInBlock, extrinsicHash, txHash FROM midnight_Transactions WHERE ID = 'tx-7'").get();
    ok('a transaction keeps its position and both hashes under the new names',
        moved?.indexInBlock === 2 && moved?.extrinsicHash === 'e0e0' && moved?.txHash === 'f1f1', JSON.stringify(moved));
    for (const table of ['midnight_BackgroundJobs', 'midnight_PendingSubmissions']) {
        const cols = columnsOf(table);
        ok(`${table}.txHash is renamed to txId and a new txHash holds the ledger hash`,
            cols.has('txId') && cols.has('txHash') && !cols.has('indexerTxHash') && cols.has('blockHeight') && !cols.has('chainBlockHeight'), [...cols.keys()].join(','));
    }
    const job = after.prepare("SELECT txId, txHash FROM midnight_BackgroundJobs WHERE ID = 'job-1'").get();
    ok('a job keeps its identifier and its hash through the rename', job?.txId === '00identifier' && job?.txHash === 'cdcd', JSON.stringify(job));
    const sub = after.prepare("SELECT txId FROM midnight_PendingSubmissions WHERE ID = 'sub-1'").get();
    ok('a submission keeps its identifier through the rename', sub?.txId === '00identifier', JSON.stringify(sub));
    for (const [table, from, to] of [
        ['midnight_ContractActions', 'address', 'contractAddress'], ['midnight_ContractActions', 'entryPoint', 'circuit'],
        ['midnight_DisclosureGrants', 'active', 'isActive'], ['midnight_WalletSyncStates', 'networkId', 'network'],
        ['midnight_SyncState', 'networkId', 'network'], ['midnight_AgentGrants', 'agentLabel', 'label'],
        ['midnight_Documents', 'sha256', 'payloadHash'], ['midnight_Documents', 'compiledArtifactRef', 'contractName']
    ]) {
        const cols = columnsOf(table);
        ok(`${table}.${from} is renamed to ${to}`, cols.has(to) && !cols.has(from), [...cols.keys()].join(','));
    }
    const grant = after.prepare("SELECT isActive FROM midnight_DisclosureGrants WHERE ID = 'dg-1'").get();
    ok('a disclosure grant keeps its switch under the new name', Number(grant?.isActive) === 1, JSON.stringify(grant));
}

// ---- The key of WalletSessions ------------------------------------------------
{
    const cols = columnsOf('midnight_WalletSessions');
    const key = [...cols.values()].filter(c => c.pk > 0).map(c => c.name).join(',');
    ok('a wallet session is keyed by its session id, the former key column is gone', key === 'sessionId' && !cols.has('ID'), `${key} | ${[...cols.keys()].join(',')}`);
    const unique = after.prepare("SELECT count(*) AS n FROM pragma_index_list('midnight_WalletSessions') WHERE origin = 'u'").get()?.n;
    ok('the unique constraint the key replaces is gone', unique === 0, String(unique));
    const session = after.prepare("SELECT userId, label FROM midnight_WalletSessions WHERE sessionId = 'sess-1'").get();
    ok('the session row survived with its owner and label', session?.userId === 'alice' && session?.label === 'kept', JSON.stringify(session));
}

// ---- A number column that became text, rebuilt with the operator's index and trigger ----
{
    const cols = columnsOf('midnight_PredicateAttestations');
    const large = after.prepare("SELECT threshold, typeof(threshold) AS stored FROM midnight_PredicateAttestations WHERE ID = 'pa-max'").get();
    ok('the threshold column is text now and keeps a large value exactly',
        /char/i.test(cols.get('threshold')?.type ?? '') && large?.stored === 'text' && large?.threshold === '9223372036854775807', `${cols.get('threshold')?.type} ${JSON.stringify(large)}`);
    ok('PredicateAttestations gained k and the owner columns, empty on an existing row',
        ['k', 'userId', 'sessionId'].every(c => cols.has(c)) && after.prepare("SELECT userId FROM midnight_PredicateAttestations WHERE ID = 'pa-1'").get()?.userId === null);
    const master = after.prepare("SELECT type, name FROM sqlite_master WHERE tbl_name = 'midnight_PredicateAttestations' AND type IN ('index','trigger')").all();
    ok('the operator index survived the rebuild', master.some(m => m.type === 'index' && m.name === 'operator_pa_payload_idx'), JSON.stringify(master));
    ok('the operator trigger survived the rebuild', master.some(m => m.type === 'trigger' && m.name === 'operator_pa_touch'), JSON.stringify(master));
}

// ---- The chain position ----------------------------------------------------------
{
    const placeOf = (table, id) => { const r = after.prepare(`SELECT blockHeight, indexInBlock FROM ${table} WHERE ID = ?`).get(id); return `${r?.blockHeight}.${r?.indexInBlock}`; };
    const places = [placeOf('midnight_Transactions', 'tx-7'), placeOf('midnight_ContractActions', 'ca-index'), placeOf('midnight_UnshieldedUtxos', 'utxo-7')];
    ok('a transaction, its action and its UTXO carry their place in the chain', places.join(',') === '7.2,7.2,7.2', places.join(','));
    const circuits = ['ca-index', 'ca-named'].map(id => String(after.prepare('SELECT circuit FROM midnight_ContractActions WHERE ID = ?').get(id)?.circuit)).join(',');
    ok('a pallet call index kept as the circuit is cleared, a circuit name stays', circuits === 'null,attest', circuits);
    const ngIdx = after.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'ng_%'").all().map(r => r.name);
    const chainIdx = ngIdx.filter(n => /transactions|contractactions|unshieldedutxos/.test(n));
    ok('the position indexes are there and none sorts a chain table by its insert time',
        chainIdx.filter(n => n.endsWith('_position')).length === 8 && !chainIdx.some(n => n.includes('createdat')), chainIdx.join(','));
}

// ---- Views of the current model ---------------------------------------------------
{
    const view = after.prepare('PRAGMA table_info("NightgateService_Transactions")').all().map(r => r.name);
    ok('the service views carry the new names', ['indexInBlock', 'extrinsicHash', 'txHash'].every(c => view.includes(c)) && !view.includes('ledgerTxHash'), view.join(','));
    const jobsView = after.prepare('PRAGMA table_info("NightgateAdminService_BackgroundJobs")').all().map(r => r.name);
    ok('the admin job view keeps what an operator needs and leaves the payloads out',
        jobsView.includes('status') && jobsView.includes('txId') && !jobsView.includes('command') && !jobsView.includes('request'), jobsView.join(','));
}
after.close();

// ---- A second run changes nothing ------------------------------------------------
{
    const secondRun = execFileSync(process.execPath, [tool, dbPath], { cwd: repoRoot }).toString();
    process.stdout.write(secondRun);
    ok('a second run renames no column and rebuilds no table', secondRun.includes('0 columns renamed') && secondRun.includes(', 0 rebuilt,'), secondRun.trim().split('\n').at(-1));
    const again = new DatabaseSync(dbPath, { readOnly: true });
    const job = again.prepare("SELECT txId, txHash FROM midnight_BackgroundJobs WHERE ID = 'job-1'").get();
    ok('a second run keeps the rows as they are', job?.txId === '00identifier' && job?.txHash === 'cdcd', JSON.stringify(job));
    again.close();
}

rmSync(dir, { recursive: true, force: true });

console.log();
console.log(failures === 0 ? 'Schema delta verified on a database of the last release.' : `${failures} failure(s).`);
process.exit(failures === 0 ? 0 : 1);
