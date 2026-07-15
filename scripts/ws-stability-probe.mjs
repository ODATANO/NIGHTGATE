// Diagnostic: which WS connection drops/stalls, the NODE RPC or the
// INDEXER subscription? Opens BOTH simultaneously and logs every update + any
// close/error, so we can tell which one is the unstable link behind the wallet
// sync stalls (Custom error 117 chase).
//
//   NODE:    wss://rpc.preprod.midnight.network  → chain_subscribeNewHeads
//   INDEXER: wss://indexer.preprod.../graphql/ws → graphql-transport-ws: subscription { blocks { height } }
//
// Run: node scripts/ws-stability-probe.mjs   (default ~10 min; DURATION_S to override)

import WebSocket from 'ws';

const NODE_URL    = process.env.NODE_WS    || 'wss://rpc.preprod.midnight.network/';
const INDEXER_URL = process.env.INDEXER_WS || 'wss://indexer.preprod.midnight.network/api/v4/graphql/ws';
const DURATION_MS = (parseInt(process.env.DURATION_S || '600', 10)) * 1000;

const start = Date.now();
const t = () => `${((Date.now() - start) / 1000).toFixed(0)}s`;
const log = (who, msg) => console.log(`[${t().padStart(4)}] ${who.padEnd(7)} ${msg}`);

const stats = {
    node:    { updates: 0, lastHeight: null, lastMsgAt: 0, closed: false, closeInfo: null, opened: false },
    indexer: { updates: 0, lastHeight: null, lastMsgAt: 0, closed: false, closeInfo: null, opened: false }
};

// ---- NODE: Substrate JSON-RPC over WS -------------------------------------
function startNode() {
    const ws = new WebSocket(NODE_URL);
    ws.on('open', () => {
        stats.node.opened = true; stats.node.lastMsgAt = Date.now();
        log('NODE', 'connected → chain_subscribeNewHeads');
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'chain_subscribeNewHeads', params: [] }));
    });
    ws.on('message', d => {
        stats.node.lastMsgAt = Date.now();
        let m; try { m = JSON.parse(d); } catch { return; }
        const h = m?.params?.result?.number;
        if (h) {
            const height = parseInt(h, 16);
            stats.node.updates++; stats.node.lastHeight = height;
            if (stats.node.updates % 5 === 0) log('NODE', `head #${height} (${stats.node.updates} heads)`);
        }
    });
    ws.on('close', (code, reason) => {
        stats.node.closed = true; stats.node.closeInfo = `${code} ${reason || ''}`.trim();
        log('NODE', `❌ CLOSED: ${stats.node.closeInfo}`);
    });
    ws.on('error', e => log('NODE', `error: ${e.message}`));
    return ws;
}

// ---- INDEXER: graphql-transport-ws ----------------------------------------
function startIndexer() {
    const ws = new WebSocket(INDEXER_URL, 'graphql-transport-ws');
    ws.on('open', () => {
        stats.indexer.opened = true; stats.indexer.lastMsgAt = Date.now();
        log('INDEXER', 'connected → connection_init');
        ws.send(JSON.stringify({ type: 'connection_init' }));
    });
    ws.on('message', d => {
        stats.indexer.lastMsgAt = Date.now();
        let m; try { m = JSON.parse(d); } catch { return; }
        if (m.type === 'connection_ack') {
            log('INDEXER', 'ack → subscribe blocks');
            ws.send(JSON.stringify({ id: '1', type: 'subscribe', payload: { query: 'subscription { blocks { height } }' } }));
        } else if (m.type === 'next') {
            const height = m?.payload?.data?.blocks?.height;
            stats.indexer.updates++; if (height != null) stats.indexer.lastHeight = height;
            if (stats.indexer.updates % 5 === 0) log('INDEXER', `block #${height} (${stats.indexer.updates} blocks)`);
        } else if (m.type === 'error') {
            log('INDEXER', `subscribe error: ${JSON.stringify(m.payload)}`);
        } else if (m.type === 'complete') {
            log('INDEXER', '⚠️ subscription complete (server ended stream)');
        }
    });
    ws.on('close', (code, reason) => {
        stats.indexer.closed = true; stats.indexer.closeInfo = `${code} ${reason || ''}`.trim();
        log('INDEXER', `❌ CLOSED: ${stats.indexer.closeInfo}`);
    });
    ws.on('error', e => log('INDEXER', `error: ${e.message}`));
    return ws;
}

const nodeWs = startNode();
const idxWs = startIndexer();

// Stall detector: flag if a connection goes silent >40s while still "open".
const stallTimer = setInterval(() => {
    const now = Date.now();
    for (const k of ['node', 'indexer']) {
        const s = stats[k];
        if (s.opened && !s.closed && s.lastMsgAt && now - s.lastMsgAt > 40_000) {
            log(k.toUpperCase(), `⚠️ STALLED — no message for ${((now - s.lastMsgAt) / 1000).toFixed(0)}s (last height ${s.lastHeight})`);
            s.lastMsgAt = now; // avoid spamming
        }
    }
}, 10_000);

setTimeout(() => {
    clearInterval(stallTimer);
    console.log('\n==== SUMMARY ====');
    for (const k of ['node', 'indexer']) {
        const s = stats[k];
        console.log(`${k.toUpperCase().padEnd(7)}: opened=${s.opened} updates=${s.updates} lastHeight=${s.lastHeight} closed=${s.closed}${s.closeInfo ? ` (${s.closeInfo})` : ''}`);
    }
    const verdict = stats.node.closed && !stats.indexer.closed ? 'NODE is the unstable link'
        : stats.indexer.closed && !stats.node.closed ? 'INDEXER is the unstable link'
        : stats.node.closed && stats.indexer.closed ? 'BOTH dropped'
        : 'Neither dropped in this window (drops may be load-induced — try longer / under sync load)';
    console.log(`VERDICT: ${verdict}`);
    try { nodeWs.close(); } catch {}
    try { idxWs.close(); } catch {}
    process.exit(0);
}, DURATION_MS);

log('PROBE', `monitoring node + indexer for ${DURATION_MS / 1000}s...`);
