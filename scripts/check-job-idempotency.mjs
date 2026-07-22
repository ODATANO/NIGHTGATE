import cds from '@sap/cds';

await cds.plugins;
const db = await cds.connect.to('db');
const { SELECT } = cds.ql;

const duplicates = await db.run(
  SELECT.from('midnight.BackgroundJobs')
    .columns('sessionId', 'kind', 'idempotencyKey', 'count(*) as count')
    .where('idempotencyKey is not null')
    .groupBy('sessionId', 'kind', 'idempotencyKey')
    .having('count(*) > 1')
);

if (duplicates.length) {
  console.error('Duplicate BackgroundJobs idempotency tuples found:');
  console.table(duplicates);
  console.error('Resolve these rows explicitly before deploying the unique constraint. No rows were modified.');
  await db.disconnect();
  process.exitCode = 2;
} else {
  console.log('BackgroundJobs idempotency preflight passed: no duplicate non-null keys.');
  await db.disconnect();
}
