// Legacy-migration integration test for scripts/apply-schema-delta.mjs.
//
// Builds a synthetic PRE-0.15 database shape (PredicateAttestations with
// NOT NULL op/threshold, which the target schema relaxed -> forces the
// rebuild path) plus an operator-added index, trigger and a data row, runs
// the real migration CLI against it, and asserts:
//   1. the new 0.16.0 columns exist (payloadHashB, allowedMask, network,
//      compiledArtifactRef),
//   2. the NOT NULL constraints were relaxed,
//   3. the data row survived,
//   4. the operator index AND trigger survived the rebuild (regression: the
//      rebuild used to drop them silently with the old table).
//
// Run: node scripts/integration-test-schema-delta.mjs

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Built-in driver (Node >= 22.5), same choice as the migration itself, so
// this lane needs no native module on CI or anywhere else.
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

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
const dbPath = path.join(dir, 'legacy.db');

const db = new DatabaseSync(dbPath);
db.exec(`
CREATE TABLE midnight_PredicateAttestations (
    ID TEXT NOT NULL PRIMARY KEY,
    createdAt TEXT,
    modifiedAt TEXT,
    payloadHash TEXT NOT NULL,
    contractAddress TEXT NOT NULL,
    predicate TEXT NOT NULL,
    op INTEGER NOT NULL,
    threshold INTEGER NOT NULL
);
CREATE INDEX operator_pa_payload_idx ON midnight_PredicateAttestations (payloadHash);
CREATE TRIGGER operator_pa_touch AFTER UPDATE ON midnight_PredicateAttestations
BEGIN
    UPDATE midnight_PredicateAttestations SET modifiedAt = 'touched' WHERE ID = NEW.ID;
END;
INSERT INTO midnight_PredicateAttestations (ID, payloadHash, contractAddress, predicate, op, threshold)
VALUES ('row-1', 'aa', 'bb', 'lessOrEqual', 0, 42);

-- A 0.19-shaped WalletSessions: everything 0.19 had, WITHOUT the 0.20 label
-- column. This is the table 0.20's startup preflight refuses on, and the
-- migration the changelog promises as not-code-only. Without it here the
-- delta would simply CREATE the table and the ALTER path would go untested.
CREATE TABLE midnight_WalletSessions (
    ID TEXT NOT NULL PRIMARY KEY,
    createdAt TEXT,
    createdBy TEXT,
    modifiedAt TEXT,
    modifiedBy TEXT,
    userId TEXT,
    viewingKeyHash TEXT,
    encryptedViewingKey TEXT,
    encryptedSeedKey TEXT,
    accountIndex INTEGER,
    sessionId TEXT NOT NULL,
    connectedAt TEXT NOT NULL,
    disconnectedAt TEXT,
    expiresAt TEXT,
    isActive INTEGER DEFAULT TRUE
);
INSERT INTO midnight_WalletSessions (ID, userId, sessionId, connectedAt, isActive, encryptedViewingKey)
VALUES ('sess-row-1', 'operator', 'sess-1', '2026-08-01T00:00:00.000Z', 1, 'cipher');

-- A 0.20-shaped AgentGrants: everything 0.20 had, WITHOUT the six 0.21 policy /
-- deploy columns. The upgrade note promises the ALTER path keeps existing
-- grants (and their tokens) working.
CREATE TABLE midnight_AgentGrants (
    ID TEXT NOT NULL PRIMARY KEY,
    createdAt TEXT,
    createdBy TEXT,
    modifiedAt TEXT,
    modifiedBy TEXT,
    userId TEXT NOT NULL,
    agentLabel TEXT,
    sessionId TEXT NOT NULL,
    tokenHash TEXT NOT NULL,
    allowedActions TEXT NOT NULL,
    maxJobsPerDay INTEGER,
    jobsUsedToday INTEGER DEFAULT 0,
    budgetWindow TEXT,
    sponsorSessionId TEXT,
    validUntil TEXT,
    isActive INTEGER DEFAULT TRUE,
    revokedAt TEXT
);
INSERT INTO midnight_AgentGrants (ID, userId, sessionId, tokenHash, allowedActions, maxJobsPerDay, jobsUsedToday, isActive)
VALUES ('grant-row-1', 'operator', 'sess-1', 'deadbeef', '["anchorDocument"]', 20, 3, 1);
`);
db.close();

execFileSync(process.execPath, [path.join(repoRoot, 'scripts/apply-schema-delta.mjs'), dbPath], {
    cwd: repoRoot, stdio: 'inherit'
});

const after = new DatabaseSync(dbPath, { readOnly: true });
const cols = new Map(after.prepare('PRAGMA table_info("midnight_PredicateAttestations")').all().map(r => [r.name, r]));
ok('delta: 0.16.0 columns added',
    cols.has('payloadHashB') && cols.has('allowedMask') && cols.has('network') && cols.has('compiledArtifactRef'),
    [...cols.keys()].join(','));
ok('delta: NOT NULL relaxed on op/threshold',
    cols.get('op')?.notnull === 0 && cols.get('threshold')?.notnull === 0);
const row = after.prepare("SELECT * FROM midnight_PredicateAttestations WHERE ID = 'row-1'").get();
ok('delta: data row survived the rebuild', row?.payloadHash === 'aa' && row?.threshold === 42);
const master = after.prepare(
    "SELECT type, name FROM sqlite_master WHERE tbl_name = 'midnight_PredicateAttestations' AND type IN ('index','trigger')"
).all();
ok('delta: operator index survived the rebuild', master.some(m => m.type === 'index' && m.name === 'operator_pa_payload_idx'), JSON.stringify(master));
ok('delta: operator trigger survived the rebuild', master.some(m => m.type === 'trigger' && m.name === 'operator_pa_touch'), JSON.stringify(master));

// --- the 0.20.0 upgrade path, the one the changelog calls not-code-only -----
const sessionCols = new Map(
    after.prepare('PRAGMA table_info("midnight_WalletSessions")').all().map(r => [r.name, r])
);
ok('delta 0.20: label added to an EXISTING WalletSessions table', sessionCols.has('label'),
    [...sessionCols.keys()].join(','));
// ADD COLUMN cannot introduce NOT NULL on a populated table, and the column is
// cosmetic anyway; a nullable column is the correct outcome.
ok('delta 0.20: the added label column is nullable', sessionCols.get('label')?.notnull === 0);
const sessionRow = after.prepare("SELECT * FROM midnight_WalletSessions WHERE ID = 'sess-row-1'").get();
ok('delta 0.20: the existing session row survived, keys intact',
    sessionRow?.sessionId === 'sess-1' && sessionRow?.encryptedViewingKey === 'cipher' && sessionRow?.label === null,
    JSON.stringify(sessionRow));

// --- the 0.21.0 upgrade path: six columns on an existing AgentGrants ---------
const grantCols = new Map(
    after.prepare('PRAGMA table_info("midnight_AgentGrants")').all().map(r => [r.name, r])
);
const added021 = ['allowedContracts', 'allowedCircuits', 'allowDeploy', 'maxDeploys', 'deploysUsed', 'deployedContracts'];
ok('delta 0.21: the six grant columns were added to an EXISTING AgentGrants table',
    added021.every(c => grantCols.has(c)), [...grantCols.keys()].join(','));
ok('delta 0.21: the added grant columns are nullable', added021.every(c => grantCols.get(c)?.notnull === 0));
const grantRow = after.prepare("SELECT * FROM midnight_AgentGrants WHERE ID = 'grant-row-1'").get();
ok('delta 0.21: the existing grant survived with its token and budget intact',
    grantRow?.tokenHash === 'deadbeef' && grantRow?.maxJobsPerDay === 20 && grantRow?.jobsUsedToday === 3 && grantRow?.isActive === 1,
    JSON.stringify(grantRow));
ok('delta 0.21: the existing grant inherits the floor (null lists) and has NO deploy right',
    grantRow?.allowedContracts === null && grantRow?.allowedCircuits === null && grantRow?.deployedContracts === null
        && !grantRow?.allowDeploy && (grantRow?.deploysUsed === 0 || grantRow?.deploysUsed === null),
    JSON.stringify(grantRow));
const regs = after.prepare("SELECT type FROM sqlite_master WHERE name = 'midnight_ContractRegistrations'").get();
ok('delta 0.21: the ContractRegistrations table exists', regs?.type === 'table');

const jobsView = after.prepare(
    "SELECT type FROM sqlite_master WHERE name = 'NightgateAdminService_BackgroundJobs'"
).get();
ok('delta 0.20: the admin BackgroundJobs projection exists as a view', jobsView?.type === 'view');
const jobsViewCols = after.prepare('PRAGMA table_info("NightgateAdminService_BackgroundJobs")').all().map(r => r.name);
ok('delta 0.20: the projection excludes the payload carriers',
    jobsViewCols.length > 0
    && !jobsViewCols.includes('command')
    && !jobsViewCols.includes('request')
    && !jobsViewCols.includes('result'),
    jobsViewCols.join(','));
ok('delta 0.20: the projection keeps what an operator needs',
    jobsViewCols.includes('status') && jobsViewCols.includes('errorCode') && jobsViewCols.includes('errorMessage'),
    jobsViewCols.join(','));

after.close();
rmSync(dir, { recursive: true, force: true });

console.log();
console.log(failures === 0 ? 'Schema-delta migration verified against a synthetic legacy database.' : `${failures} failure(s).`);
process.exit(failures === 0 ? 0 : 1);
