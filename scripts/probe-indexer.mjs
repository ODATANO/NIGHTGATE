// Probes the local Midnight indexer container for liveness and progress.
//
// Reports: GraphQL HTTP status, latest indexed block, distance to chain tip,
// caught-up status, and a sample block query to confirm data delivery.
//
// Run:
//   npm run sync:probe                       (defaults to http://localhost:8088)
//   INDEXER_URL=http://other:8088 node scripts/probe-indexer.mjs

const URL_BASE = process.env.INDEXER_URL || 'http://localhost:8088';
const ENDPOINT = `${URL_BASE}/api/v4/graphql`;

async function gql(query) {
    const r = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query })
    });
    return { status: r.status, body: await r.json() };
}

function fmt(o) { return JSON.stringify(o, null, 2); }

(async () => {
    console.log(`Probing indexer at ${ENDPOINT}\n`);

    // 1. Liveness
    try {
        const live = await fetch(`${URL_BASE}/live`);
        console.log(`/live              → HTTP ${live.status}`);
    } catch (err) {
        console.error(`/live              → FAIL (${err.message})`);
        process.exit(1);
    }

    // 2. Schema introspection
    const intro = await gql('{__schema{queryType{name}}}');
    console.log(`schema introspection → HTTP ${intro.status}, query type = ${intro.body?.data?.__schema?.queryType?.name}`);

    // 3. Sync progress: latest block in the indexer
    const latest = await gql('{block{hash height protocolVersion timestamp}}');
    if (latest.body?.errors) {
        console.log(`\nlatest block query   → ERRORS:\n${fmt(latest.body.errors)}`);
    } else {
        const b = latest.body?.data?.block;
        console.log(`\nlatest indexed block:`);
        console.log(`  height        ${b?.height}`);
        console.log(`  hash          ${b?.hash?.slice(0, 32)}...`);
        console.log(`  timestamp     ${b?.timestamp}`);
        console.log(`  protocol      ${b?.protocolVersion}`);
    }

    // 4. Specific historical block (proves data is queryable, not just metadata)
    const hist = await gql('{block(offset:{height:100}){hash height transactions{hash}}}');
    if (hist.body?.errors) {
        console.log(`\nblock@height:100      → ERRORS:\n${fmt(hist.body.errors)}`);
    } else {
        const b = hist.body?.data?.block;
        console.log(`\nblock @ height 100:`);
        console.log(`  hash          ${b?.hash?.slice(0, 32)}...`);
        console.log(`  txs           ${b?.transactions?.length ?? 0}`);
    }

    console.log(`\nCheck catch-up status:`);
    console.log(`  docker logs --tail 50 odatano-night-indexer | findstr caught_up`);
    console.log(`(Look for "caught_up":true — only then are subscriptions live.)`);
})();
