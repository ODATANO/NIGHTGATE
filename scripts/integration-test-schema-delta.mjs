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
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
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

const db = new Database(dbPath);
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
`);
db.close();

execFileSync(process.execPath, [path.join(repoRoot, 'scripts/apply-schema-delta.mjs'), dbPath], {
    cwd: repoRoot, stdio: 'inherit'
});

const after = new Database(dbPath, { readonly: true });
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
after.close();
rmSync(dir, { recursive: true, force: true });

console.log();
console.log(failures === 0 ? 'Schema-delta migration verified against a synthetic legacy database.' : `${failures} failure(s).`);
process.exit(failures === 0 ? 0 : 1);
