// One-shot: query a Midnight (Substrate) node's sync state over WS JSON-RPC.
// Reports finalized + best head height and system_syncState, then exits.
//   NODE_WS=ws://161.97.105.139:9944 node scripts/probe-node-sync.mjs
import WebSocket from 'ws';

const URL = process.env.NODE_WS || 'ws://161.97.105.139:9944';
const ws = new WebSocket(URL);
let id = 0;
const pending = new Map();
function call(method, params = []) {
    id++;
    return new Promise((res, rej) => {
        pending.set(id, { res, rej });
        ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
}
const hx = h => (h?.number ? parseInt(h.number, 16) : null);

const timeout = setTimeout(() => { console.error('TIMEOUT'); process.exit(1); }, 25000);

ws.on('open', async () => {
    try {
        const [health, sync, finalHash] = await Promise.all([
            call('system_health'),
            call('system_syncState'),
            call('chain_getFinalizedHead'),
        ]);
        const bestHeader = await call('chain_getHeader');           // best head
        const finalHeader = await call('chain_getHeader', [finalHash]);
        const best = hx(bestHeader), fin = hx(finalHeader);
        const ss = sync || {};
        console.log('NODE', URL);
        console.log('  peers          ', health?.peers);
        console.log('  isSyncing      ', health?.isSyncing);
        console.log('  best head      ', best, '   (syncState.currentBlock=', ss.currentBlock, ')');
        console.log('  finalized head ', fin);
        console.log('  highestBlock   ', ss.highestBlock, '(peers\' tip)');
        if (ss.highestBlock != null && ss.currentBlock != null) {
            console.log('  node gap to net tip', ss.highestBlock - ss.currentBlock, 'blocks');
        }
        const idxTip = 635600;
        console.log('  vs indexer ~', idxTip, '→ node', (best ?? 0) - idxTip, 'blocks ahead of indexer');
        clearTimeout(timeout);
        ws.close(); process.exit(0);
    } catch (e) { console.error('ERR', e.message); process.exit(1); }
});
ws.on('message', d => {
    let m; try { m = JSON.parse(d); } catch { return; }
    const p = pending.get(m.id);
    if (p) { pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
});
ws.on('error', e => { console.error('WS ERROR', e.message); process.exit(1); });
