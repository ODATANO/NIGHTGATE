// Diagnostic: is the ~0.44 blk/s indexer cap the PUBLIC RPC / our internet, or
// the indexer's own per-block processing? Pulls raw blocks straight from the
// public preprod node RPC (getBlockHash + getBlock) and measures throughput,
// sequentially and in parallel. If we can pull blocks WAY faster than 0.44/s,
// the bottleneck is the indexer's processing, not the RPC/internet.
//
// Run: node scripts/rpc-throughput-probe.mjs

import WebSocket from 'ws';

const NODE_URL = process.env.NODE_WS || 'wss://rpc.preprod.midnight.network/';
const N = parseInt(process.env.N || '60', 10);          // blocks per test
const CONC = parseInt(process.env.CONC || '16', 10);    // parallel concurrency

const ws = new WebSocket(NODE_URL);
let id = 1;
const pending = new Map();
ws.on('message', d => {
    let o; try { o = JSON.parse(d); } catch { return; }
    if (o.id != null && pending.has(o.id)) {
        const { resolve, reject } = pending.get(o.id);
        pending.delete(o.id);
        if (o.error) reject(new Error(JSON.stringify(o.error))); else resolve(o.result);
    }
});
ws.on('error', e => { console.error('ws error', e.message); process.exit(1); });
const call = (method, params = []) => new Promise((resolve, reject) => {
    const i = id++;
    pending.set(i, { resolve, reject });
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }));
    setTimeout(() => { if (pending.has(i)) { pending.delete(i); reject(new Error(`${method} timeout`)); } }, 30000);
});

const hx = n => '0x' + n.toString(16);
async function fetchBlock(height) {
    const hash = await call('chain_getBlockHash', [hx(height)]);
    const blk = await call('chain_getBlock', [hash]);
    const exs = blk?.block?.extrinsics?.length ?? 0;
    const bytes = JSON.stringify(blk).length;
    return { exs, bytes };
}

ws.on('open', async () => {
    try {
        const t0 = Date.now();
        const head = await call('chain_getHeader');
        const tip = parseInt(head.number, 16);
        const rtt = Date.now() - t0;
        console.log(`node: ${NODE_URL}`);
        console.log(`tip height: ${tip}   (single getHeader RTT: ${rtt}ms)`);
        const base = tip - N - 5;   // pull recent, real-sized blocks

        // --- Sequential ---
        let ms = Date.now(), exTot = 0, byTot = 0;
        for (let h = base; h < base + N; h++) { const r = await fetchBlock(h); exTot += r.exs; byTot += r.bytes; }
        const seqS = (Date.now() - ms) / 1000;
        console.log(`\nSEQUENTIAL: ${N} blocks in ${seqS.toFixed(1)}s = ${(N/seqS).toFixed(1)} blk/s  (avg ${(byTot/N/1024).toFixed(1)} KB, ${(exTot/N).toFixed(1)} extrinsics/blk)`);

        // --- Parallel ---
        ms = Date.now();
        const heights = Array.from({ length: N }, (_, k) => base + N + 10 + k);
        let idx = 0;
        async function worker() { while (idx < heights.length) { const h = heights[idx++]; await fetchBlock(h); } }
        await Promise.all(Array.from({ length: CONC }, worker));
        const parS = (Date.now() - ms) / 1000;
        console.log(`PARALLEL (x${CONC}): ${N} blocks in ${parS.toFixed(1)}s = ${(N/parS).toFixed(1)} blk/s`);

        console.log(`\nVERDICT:`);
        const seqRate = N / seqS, parRate = N / parS;
        const indexer = 0.44;
        if (seqRate > indexer * 5 || parRate > indexer * 5) {
            console.log(`  Raw RPC fetch (${seqRate.toFixed(1)} seq / ${parRate.toFixed(1)} par blk/s) is MUCH faster than the indexer's ~${indexer} blk/s.`);
            console.log(`  => NOT the RPC / our internet. The indexer's per-block PROCESSING is the bottleneck.`);
        } else {
            console.log(`  Raw RPC fetch (${seqRate.toFixed(1)} seq / ${parRate.toFixed(1)} par blk/s) is close to the indexer rate.`);
            console.log(`  => The RPC / network IS the cap (throttled or slow link).`);
        }
        ws.close(); process.exit(0);
    } catch (e) { console.error('FAIL', e.message); process.exit(1); }
});
