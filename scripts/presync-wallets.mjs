#!/usr/bin/env node
// Syncs wallets one after another against an indexer and writes each wallet's
// sync state to a file. `scripts/import-wallet-state.mjs` loads such a file
// into a server's WalletSyncStates, so the server restores instead of syncing.
//
//   node scripts/presync-wallets.mjs <wallets.json> [--out presync] [--max-minutes N] [--save-every-seconds 120] [--only <label>]
//
// wallets.json (keep it out of git, it carries seeds):
//   { "network": "preprod",
//     "indexerHttpUrl": "https://indexer.preprod.midnight.network/api/v4/graphql",   // optional, default = the network's public indexer
//     "nodeUrl": "wss://rpc.preprod.midnight.network/",                               // optional
//     "wallets": [ { "label": "sponsor-a", "sessionId": "<uuid>", "mnemonic": "..." | "seedHex": "<128 hex>", "accountIndex": 0 } ] }
//
// Output: <out>/<label>.json with the three serialized sub-wallet states, the
// seed fingerprint, the SDK version and the index the wallet reached. A run
// resumes from an existing file, so a stopped run loses at most one save.
// Exit 0 when every wallet reached the tip, 1 otherwise.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { deriveRoleSeeds, mnemonicToBip39SeedHex } = require(path.join(packageRoot, 'srv/utils/wallet-hd.js'));
const { seedFingerprintOf } = require(path.join(packageRoot, 'srv/submission/wallet-facade-builder.js'));
const { getWalletSdkVersion } = require(path.join(packageRoot, 'srv/submission/wallet-sync-state-store.js'));
const { appliedIndexOf, describeSyncState } = require(path.join(packageRoot, 'srv/midnight/worker/sync-replay.js'));
const { deriveIndexerWsUrl } = require(path.join(packageRoot, 'srv/utils/indexer-url.js'));
const { DEFAULT_INDEXER_URLS, DEFAULT_NODE_URLS, DEFAULT_NODE_URL } = require(path.join(packageRoot, 'srv/utils/nightgate-config.js'));

const EXPORT_VERSION = 1;
const POLL_MS = 3000;
const LOG_MS = 15_000;

function arg(name, fallback) {
    const i = process.argv.indexOf(name);
    if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
    return fallback;
}
const positional = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && !all[i - 1]?.startsWith('--'));
const configPath = positional[0];
if (!configPath) {
    console.error('usage: node scripts/presync-wallets.mjs <wallets.json> [--out presync] [--max-minutes N] [--save-every-seconds 120] [--only <label>]');
    process.exit(2);
}
const OUT_DIR = path.resolve(arg('--out', 'presync'));
const MAX_MINUTES = Number(arg('--max-minutes', '0')) || 0;
const SAVE_EVERY_MS = Math.max(10, Number(arg('--save-every-seconds', '120')) || 120) * 1000;
const ONLY = arg('--only', null);
const TIP_GAP = BigInt(Number(process.env.NIGHTGATE_SYNC_TIP_GAP ?? '8') || 0);

const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const network = cfg.network ?? 'preprod';
const indexerHttpUrl = cfg.indexerHttpUrl ?? DEFAULT_INDEXER_URLS[network]?.http;
const indexerWsUrl = cfg.indexerWsUrl ?? (cfg.indexerHttpUrl ? deriveIndexerWsUrl(cfg.indexerHttpUrl) : DEFAULT_INDEXER_URLS[network]?.ws);
const nodeUrl = cfg.nodeUrl ?? DEFAULT_NODE_URLS[network] ?? DEFAULT_NODE_URL;
if (!indexerHttpUrl || !indexerWsUrl) { console.error(`no indexer URL for network '${network}'`); process.exit(2); }
if (!Array.isArray(cfg.wallets) || cfg.wallets.length === 0) { console.error('wallets.json: "wallets" must be a non-empty list'); process.exit(2); }

const sdkVersion = getWalletSdkVersion();
const log = (m) => console.log(`${new Date().toISOString()} ${m}`);

const [ledger, networkIdSdk, facadeSdk, shieldedSdk, unshieldedSdk, dustSdk, abstractions, WebSocketModule] = await Promise.all([
    import('@midnight-ntwrk/ledger-v8'),
    import('@midnight-ntwrk/midnight-js-network-id'),
    import('@midnightntwrk/wallet-sdk-facade'),
    import('@midnightntwrk/wallet-sdk-shielded'),
    import('@midnightntwrk/wallet-sdk-unshielded-wallet'),
    import('@midnightntwrk/wallet-sdk-dust-wallet'),
    import('@midnightntwrk/wallet-sdk-abstractions'),
    import('ws')
]);
const WebSocket = WebSocketModule.default;
networkIdSdk.setNetworkId(network);

/** The newest dust ledger event id on the indexer, read through a one-shot subscription. Null when it does not answer in 10 s. */
function readDustStreamTip() {
    return new Promise((resolve) => {
        const sock = new WebSocket(indexerWsUrl, 'graphql-transport-ws');
        let settled = false;
        const done = (v) => { if (settled) return; settled = true; clearTimeout(timer); try { sock.close(); } catch { /* closed */ } resolve(v); };
        const timer = setTimeout(() => done(null), 10_000);
        sock.on('open', () => sock.send(JSON.stringify({ type: 'connection_init' })));
        sock.on('message', (buf) => {
            try {
                const m = JSON.parse(buf.toString());
                if (m.type === 'connection_ack') sock.send(JSON.stringify({ id: '1', type: 'subscribe', payload: { query: 'subscription { dustLedgerEvents(id: 0) { id maxId } }' } }));
                else if (m.type === 'next') { const id = m.payload?.data?.dustLedgerEvents?.maxId; done(id == null ? null : BigInt(id)); }
                else if (m.type === 'error' || m.type === 'complete') done(null);
            } catch { done(null); }
        });
        sock.on('error', () => done(null));
        sock.on('close', () => done(null));
    });
}

function firstEmission(observable, timeoutMs) {
    return new Promise((resolve, reject) => {
        let sub;
        const timer = setTimeout(() => { sub?.unsubscribe?.(); reject(new Error(`no wallet state within ${timeoutMs}ms`)); }, timeoutMs);
        sub = observable.subscribe({
            next: (v) => { clearTimeout(timer); resolve(v); queueMicrotask(() => sub?.unsubscribe?.()); },
            error: (e) => { clearTimeout(timer); reject(e); }
        });
    });
}

function exportPath(w) { return path.join(OUT_DIR, `${w.label}.json`); }

function readExisting(w) {
    const p = exportPath(w);
    if (!fs.existsSync(p)) return null;
    const saved = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (saved.sdkVersion !== sdkVersion || saved.networkId !== network) {
        log(`${w.label}: existing file is for ${saved.sdkVersion} on ${saved.networkId}, this run is ${sdkVersion} on ${network}; starting from zero`);
        return null;
    }
    return saved;
}

async function serialize(facade) {
    return {
        shielded: await facade.shielded.serializeState(),
        unshielded: await facade.unshielded.serializeState(),
        dust: await facade.dust.serializeState()
    };
}

function writeExport(w, seedFingerprint, states, reached) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const body = {
        version: EXPORT_VERSION,
        label: w.label,
        sessionId: w.sessionId ?? null,
        networkId: network,
        sdkVersion,
        seedFingerprint,
        accountIndex: w.accountIndex ?? 0,
        indexerHttpUrl,
        savedAt: new Date().toISOString(),
        reached,
        states
    };
    const tmp = `${exportPath(w)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(body));
    fs.renameSync(tmp, exportPath(w));
}

async function syncWallet(w) {
    if (!w.label || !/^[A-Za-z0-9._-]+$/.test(w.label)) throw new Error('each wallet needs a label of letters, digits, dot, dash or underscore');
    const seedHex = w.seedHex ?? (w.mnemonic ? mnemonicToBip39SeedHex(w.mnemonic) : null);
    if (!seedHex) throw new Error(`${w.label}: seedHex or mnemonic is required`);
    const seedFingerprint = seedFingerprintOf(seedHex);
    const accountIndex = w.accountIndex ?? 0;
    const existing = readExisting(w);
    if (existing && existing.seedFingerprint !== seedFingerprint) throw new Error(`${w.label}: existing file was made with another seed; delete it or fix the config`);
    const restore = existing?.states;

    const roleSeeds = await deriveRoleSeeds(new Uint8Array(Buffer.from(seedHex, 'hex')), accountIndex);
    const zswapKeys = ledger.ZswapSecretKeys.fromSeed(roleSeeds.zswap);
    const dustKey = ledger.DustSecretKey.fromSeed(roleSeeds.dust);
    const keystore = unshieldedSdk.createKeystore(roleSeeds.night, network);

    // Same configuration as the server's wallet worker, so the serialized states fit its restore.
    const configuration = {
        networkId: network,
        provingServerUrl: new URL('http://127.0.0.1:6300'),
        relayURL: new URL(nodeUrl),
        indexerClientConnection: { indexerHttpUrl, indexerWsUrl },
        txHistoryStorage: new abstractions.InMemoryTransactionHistoryStorage(facadeSdk.WalletEntrySchema, facadeSdk.mergeWalletEntries),
        costParameters: { additionalFeeOverhead: 1n, feeBlocksMargin: 5 }
    };
    const dustParameters = ledger.LedgerParameters.initialParameters().dust;
    const facade = await facadeSdk.WalletFacade.init({
        configuration,
        shielded: () => restore?.shielded
            ? shieldedSdk.ShieldedWallet(configuration).restore(restore.shielded)
            : shieldedSdk.ShieldedWallet(configuration).startWithSecretKeys(zswapKeys),
        unshielded: () => restore?.unshielded
            ? unshieldedSdk.UnshieldedWallet(configuration).restore(restore.unshielded)
            : unshieldedSdk.UnshieldedWallet(configuration).startWithPublicKey(unshieldedSdk.PublicKey.fromKeyStore(keystore)),
        dust: () => restore?.dust
            ? dustSdk.DustWallet(configuration).restore(restore.dust)
            : dustSdk.DustWallet(configuration).startWithSecretKey(dustKey, dustParameters)
    });
    await facade.start(zswapKeys, dustKey);
    log(`${w.label}: wallet started (${restore ? `restored from ${existing.savedAt}, dust appliedIndex=${existing.reached?.dustAppliedIndex ?? '?'}` : 'from zero'})`);

    const started = Date.now();
    let lastLog = 0;
    let lastSave = Date.now();
    let tip = null;
    let tipAt = 0;
    let reached = null;
    let atTip = false;
    try {
        for (;;) {
            const state = await firstEmission(facade.state(), 30_000);
            const applied = appliedIndexOf(state, 'dust');
            if (Date.now() - tipAt > 10_000) { const t = await readDustStreamTip(); if (t != null) { tip = t; tipAt = Date.now(); } }
            const d = describeSyncState(state);
            reached = { dustAppliedIndex: d.dustAppliedIndex, dustSyncTime: d.dustSyncTime, shieldedAppliedIndex: d.shieldedAppliedIndex, streamTip: tip == null ? null : tip.toString() };
            atTip = applied != null && tip != null && tip > 0n && applied >= tip - TIP_GAP;
            if (Date.now() - lastLog > LOG_MS) {
                lastLog = Date.now();
                const behind = applied != null && tip != null ? (tip - applied).toString() : '?';
                log(`${w.label}: dust appliedIndex=${d.dustAppliedIndex ?? '?'} streamTip=${tip ?? '?'} behind=${behind} shielded appliedIndex=${d.shieldedAppliedIndex ?? '?'} elapsed=${Math.round((Date.now() - started) / 1000)}s`);
            }
            if (atTip) break;
            if (MAX_MINUTES > 0 && Date.now() - started > MAX_MINUTES * 60_000) { log(`${w.label}: time budget of ${MAX_MINUTES} min used, saving and moving on`); break; }
            if (Date.now() - lastSave > SAVE_EVERY_MS) {
                writeExport(w, seedFingerprint, await serialize(facade), reached);
                lastSave = Date.now();
                log(`${w.label}: saved ${exportPath(w)}`);
            }
            await new Promise(r => setTimeout(r, POLL_MS));
        }
        writeExport(w, seedFingerprint, await serialize(facade), reached);
        log(`${w.label}: ${atTip ? 'AT TIP' : 'not at tip'}, saved ${exportPath(w)} (dust appliedIndex=${reached?.dustAppliedIndex ?? '?'}, streamTip=${reached?.streamTip ?? '?'})`);
    } finally {
        try { await facade.stop?.(); } catch { /* already stopped */ }
        zswapKeys.clear?.();
    }
    return atTip;
}

let allAtTip = true;
for (const w of cfg.wallets) {
    if (ONLY && w.label !== ONLY) continue;
    try {
        if (!(await syncWallet(w))) allAtTip = false;
    } catch (err) {
        allAtTip = false;
        log(`${w.label}: FAILED: ${err?.message ?? err}`);
    }
}
process.exit(allAtTip ? 0 : 1);
