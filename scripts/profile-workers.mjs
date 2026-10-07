// CPU profile of the main thread and every worker thread of a running NIGHTGATE process.
// Prints the self time per function and, for a busy thread, the inclusive time of the JS
// frames above the wasm, which names the caller of a hot ledger call.
//
// Open the inspector on the server process first (SIGUSR1 to the node pid, or --inspect),
// then: node scripts/profile-workers.mjs [seconds] [host:port]
// In the container: docker exec -e NODE_PATH=/app/node_modules <container> node /app/scripts/profile-workers.mjs 15

import WebSocket from 'ws';

const secs = Number(process.argv[2] || 10);
const inspector = process.argv[3] || '127.0.0.1:9229';

const list = await (await fetch(`http://${inspector}/json`)).json();
const ws = new WebSocket(list[0].webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const workers = new Map();
const fromWorker = new Map();

const send = (method, params = {}) => new Promise((res, rej) => {
    const i = ++id;
    pending.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method, params }));
});
const sendToWorker = (sessionId, method, params = {}) => new Promise((res, rej) => {
    const i = ++id;
    fromWorker.set(`${sessionId}:${i}`, { res, rej });
    send('NodeWorker.sendMessageToWorker', { sessionId, message: JSON.stringify({ id: i, method, params }) }).catch(rej);
});

ws.on('message', (m) => {
    const d = JSON.parse(m);
    if (d.id && pending.has(d.id)) {
        const p = pending.get(d.id);
        pending.delete(d.id);
        return d.error ? p.rej(new Error(JSON.stringify(d.error))) : p.res(d.result);
    }
    if (d.method === 'NodeWorker.attachedToWorker') workers.set(d.params.sessionId, d.params.workerInfo);
    if (d.method === 'NodeWorker.receivedMessageFromWorker') {
        const r = JSON.parse(d.params.message);
        const k = `${d.params.sessionId}:${r.id}`;
        if (r.id && fromWorker.has(k)) {
            const p = fromWorker.get(k);
            fromWorker.delete(k);
            r.error ? p.rej(new Error(JSON.stringify(r.error))) : p.res(r.result);
        }
    }
});

await new Promise(r => ws.on('open', r));
await send('NodeWorker.enable', { waitForDebuggerOnStart: false });
await new Promise(r => setTimeout(r, 1500));

const targets = [['main', null], ...[...workers].map(([sid, info]) => [`${info.title || 'worker'} ${info.url.replace(/^.*\//, '')}`, sid])];
const call = (sid, method, params) => (sid ? sendToWorker(sid, method, params) : send(method, params));
for (const [, sid] of targets) {
    await call(sid, 'Profiler.enable');
    await call(sid, 'Profiler.setSamplingInterval', { interval: 1000 });
    await call(sid, 'Profiler.start');
}
await new Promise(r => setTimeout(r, secs * 1000));

const short = (u) => u.replace(/^.*\/node_modules\//, '').replace(/^.*\/app\//, '');
for (const [name, sid] of targets) {
    const { profile } = await call(sid, 'Profiler.stop');
    const byId = new Map(profile.nodes.map(n => [n.id, n]));
    const parent = new Map();
    for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
    const self = new Map();
    for (let i = 0; i < profile.samples.length; i++) {
        self.set(profile.samples[i], (self.get(profile.samples[i]) ?? 0) + (profile.timeDeltas[i] ?? 0));
    }
    const total = [...self.values()].reduce((a, b) => a + b, 0);
    const key = (n) => `${n.callFrame.functionName || '(anonymous)'} ${short(n.callFrame.url)}:${n.callFrame.lineNumber + 1}`;
    const agg = new Map();
    for (const [nid, t] of self) {
        const k = key(byId.get(nid));
        agg.set(k, (agg.get(k) ?? 0) + t);
    }
    const idle = agg.get('(idle) :0') ?? 0;
    const busy = total - idle;
    console.log(`\n=== ${name}: ${Math.round(total / 1000)} ms sampled, busy ${(100 * busy / total).toFixed(0)}%`);
    for (const [k, t] of [...agg].sort((a, b) => b[1] - a[1]).slice(0, 6)) {
        console.log(`  self ${(100 * t / total).toFixed(1).padStart(5)}%  ${k}`);
    }
    if (busy / total < 0.3) continue;
    // Inclusive time of the JS frames on the stack of each sample, without wasm and node internals.
    const incl = new Map();
    for (const [nid, t] of self) {
        const seen = new Set();
        for (let cur = nid; cur !== undefined; cur = parent.get(cur)) {
            const n = byId.get(cur);
            const url = n.callFrame.url;
            if (!url || url.startsWith('wasm://') || url.startsWith('node:')) continue;
            const k = key(n);
            if (seen.has(k)) continue;
            seen.add(k);
            incl.set(k, (incl.get(k) ?? 0) + t);
        }
    }
    console.log(`  --- inclusive time of JS frames above the hot code (${name}):`);
    for (const [k, t] of [...incl].sort((a, b) => b[1] - a[1]).slice(0, 18)) {
        console.log(`  incl ${(100 * t / busy).toFixed(0).padStart(4)}%  ${k}`);
    }
}
ws.close();
