/**
 * PostgreSQL integration test for the concurrent-insert idempotency guard that
 * startJob (srv/submission/background-jobs.ts) relies on.
 *
 * SQLite does NOT abort a transaction on a constraint violation, so the unit
 * suite cannot prove the savepoint is actually required. Postgres does: a failed
 * INSERT poisons the whole transaction until it is rolled back. This test proves
 * the two behaviours the fix depends on, against a real Postgres, with two
 * concurrent transactions:
 *
 *   1. Without a savepoint, the loser's aborted transaction rejects every
 *      subsequent statement (SQLSTATE 25P02) — i.e. the raw catch-and-recover
 *      on the ambient tx cannot work on Postgres.
 *   2. With SAVEPOINT / ROLLBACK TO SAVEPOINT, the loser recovers: it reads the
 *      winner's committed row and its outer transaction stays usable and commits.
 *
 * Connection: standard libpq env vars (PGHOST, PGPORT, PGUSER, PGPASSWORD,
 * PGDATABASE) or NIGHTGATE_PG_URL / DATABASE_URL. If no Postgres is reachable
 * the test SKIPS (exit 0) so it never breaks a SQLite-only CI. Point it at the
 * NIGHTPASS compose Postgres, e.g.:
 *
 *   PGHOST=localhost PGPORT=5432 PGUSER=nightpass PGPASSWORD=... PGDATABASE=nightpass \
 *     npm run test:pg-idempotency
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let Client;
try {
    ({ Client } = require('pg'));
} catch {
    console.log('SKIP: the `pg` driver is not installed (npm i -D @cap-js/postgres).');
    process.exit(0);
}

const connString = process.env.NIGHTGATE_PG_URL || process.env.DATABASE_URL;
const clientConfig = connString ? { connectionString: connString } : {};

const TABLE = 'nightgate_idem_probe';
const fail = (msg) => { console.error(`FAIL: ${msg}`); process.exitCode = 1; };

async function connect() {
    const c = new Client(clientConfig);
    await c.connect();
    return c;
}

async function main() {
    let admin;
    try {
        admin = await connect();
    } catch (err) {
        console.log(`SKIP: no Postgres reachable (${err.code || err.message}). Set PG* env vars to run.`);
        process.exit(0);
    }

    try {
        await admin.query(`DROP TABLE IF EXISTS ${TABLE}`);
        await admin.query(`
            CREATE TABLE ${TABLE} (
                id text PRIMARY KEY,
                session_id text NOT NULL,
                kind text NOT NULL,
                idempotency_key text,
                status text NOT NULL,
                UNIQUE (session_id, kind, idempotency_key)
            )
        `);

        const KEY = 'race-key';
        const row = (id) => ({ id, session_id: 's1', kind: 'sendNight', idempotency_key: KEY, status: 'pending' });
        const insert = (r) =>
            `INSERT INTO ${TABLE}(id, session_id, kind, idempotency_key, status) ` +
            `VALUES('${r.id}','${r.session_id}','${r.kind}','${r.idempotency_key}','${r.status}')`;

        // Two concurrent transactions; both start before either has inserted.
        const winner = await connect();
        const loser = await connect();
        try {
            await winner.query('BEGIN');
            await loser.query('BEGIN');

            // Both see no existing row for the key.
            const wSeen = await winner.query(`SELECT id FROM ${TABLE} WHERE idempotency_key='${KEY}'`);
            const lSeen = await loser.query(`SELECT id FROM ${TABLE} WHERE idempotency_key='${KEY}'`);
            if (wSeen.rowCount !== 0 || lSeen.rowCount !== 0) fail('precondition: key should not exist yet');

            // Winner inserts and commits.
            await winner.query(insert(row('winner-1')));
            await winner.query('COMMIT');

            // (1) Prove the poison: without a savepoint the loser's colliding
            //     INSERT aborts the whole transaction.
            let aborted = false;
            try {
                await loser.query(insert(row('loser-1')));
                fail('loser INSERT should have violated the unique constraint');
            } catch (err) {
                if (err.code !== '23505') fail(`expected 23505 unique_violation, got ${err.code}`);
            }
            try {
                await loser.query(`SELECT 1`);
                fail('a poisoned Postgres tx should reject subsequent statements');
            } catch (err) {
                aborted = err.code === '25P02'; // in_failed_sql_transaction
                if (!aborted) fail(`expected 25P02 on the poisoned tx, got ${err.code}`);
            }
            await loser.query('ROLLBACK');

            // (2) Prove the recovery: with a savepoint the loser survives the
            //     collision and its transaction stays usable.
            await loser.query('BEGIN');
            await loser.query('SAVEPOINT nightgate_job_insert');
            let violated = false;
            try {
                await loser.query(insert(row('loser-2')));
            } catch (err) {
                violated = err.code === '23505';
            }
            if (!violated) fail('expected the savepoint INSERT to raise 23505');
            await loser.query('ROLLBACK TO SAVEPOINT nightgate_job_insert');
            await loser.query('RELEASE SAVEPOINT nightgate_job_insert');

            // Outer tx still usable: recover the winner, then commit.
            const recovered = await loser.query(`SELECT id FROM ${TABLE} WHERE idempotency_key='${KEY}'`);
            if (recovered.rows[0]?.id !== 'winner-1') fail(`recovery should return the winner, got ${recovered.rows[0]?.id}`);
            await loser.query('COMMIT');

            const final = await admin.query(`SELECT count(*)::int AS n FROM ${TABLE} WHERE idempotency_key='${KEY}'`);
            if (final.rows[0].n !== 1) fail(`exactly one row must survive, found ${final.rows[0].n}`);

            if (!process.exitCode) {
                console.log('PASS: Postgres aborts the tx on collision (25P02) without a savepoint,');
                console.log('      and recovers to the winner via ROLLBACK TO SAVEPOINT. One row survived.');
            }
        } finally {
            await winner.end().catch(() => {});
            await loser.end().catch(() => {});
        }

        await admin.query(`DROP TABLE IF EXISTS ${TABLE}`);
    } finally {
        await admin.end().catch(() => {});
    }
}

main().catch((err) => { console.error(err); process.exit(1); });
