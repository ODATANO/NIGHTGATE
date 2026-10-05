// Helpers for callers that pay their own fee and submit to the node themselves, without a sponsor.
// On Midnight the fee is paid in DUST.
//
// The node's HTTP gateway rejects large request bodies, so transactions are submitted over WebSocket.
//
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const DESERIALIZE_TAGS = [
    ['signature', 'proof', 'binding'],
    ['signature', 'proof', 'pre-binding']
];

const toBytes = (input) => {
    if (input instanceof Uint8Array) return input;
    if (typeof input === 'string') return new Uint8Array(Buffer.from(input, 'base64'));
    throw new Error('expected a Uint8Array or a base64 string');
};

/** Decodes a built transaction from bytes or base64. Accepts sealed and unsealed transactions. */
export async function deserializeTransaction(bytesOrB64) {
    const bytes = toBytes(bytesOrB64);
    const { Transaction } = await import('@midnight-ntwrk/ledger-v8');
    let lastError;
    for (const tags of DESERIALIZE_TAGS) {
        try {
            const tx = Transaction.deserialize(...tags, bytes);
            if (tx) return tx;
        } catch (e) { lastError = e; }
    }
    throw new Error('could not deserialize the transaction (tried binding and pre-binding tags): ' + String(lastError?.message ?? lastError));
}

/**
 * Returns the transaction's identifiers. Use the last one to look the transaction up in the indexer.
 * Resend the same bytes only after `probeLanded` says the first send did not land.
 */
export function txIdentifiers(tx) {
    if (typeof tx?.identifiers !== 'function') {
        throw new Error('txIdentifiers: expected a deserialized ledger Transaction (see deserializeTransaction)');
    }
    return Array.from(tx.identifiers(), String);
}

// Joins the messages of an error and its causes.
// Source positions like `:12:34` are removed so they are never read as error codes.
function rejectHaystack(err) {
    const parts = [];
    let cur = err;
    for (let i = 0; i < 8 && cur != null; i++) {
        parts.push(typeof cur === 'string' ? cur : String(cur.message ?? ''));
        if (Array.isArray(cur.errors)) for (const e of cur.errors.slice(0, 4)) parts.push(String(e?.message ?? ''));
        cur = cur.cause;
    }
    return parts.join(' ').replace(/:\d+:\d+/g, '');
}

/**
 * Whether the node refused the transaction before it entered the mempool (codes 1010, 1014, 1016).
 * No fee was spent. If the transaction paid its own fee, restore the DUST wallet with `withDustGuard`.
 */
export function isPreMempoolReject(err) {
    return /\b101[046]\s*:|priority is too low|immediately dropped|invalid transaction/i.test(rejectHaystack(err));
}

/**
 * Whether the node says the transaction is already in the pool (code 1013).
 * After a resend this means the first send worked. Wait for it with `waitLanded`, do not treat it as a failure.
 */
export function isAlreadyImported(err) {
    return /\b1013\s*:|already imported/i.test(rejectHaystack(err));
}

/**
 * Whether the connection failed while sending. The transaction may still have reached the node.
 * Check with `probeLanded`, then resend the same bytes. Never rebuild, or both transactions may land.
 */
export function isTransportFailure(err) {
    if (isPreMempoolReject(err)) return false;
    return /disconnected from|Normal Closure|Abnormal Closure|WebSocket is not connected|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|socket hang up|Unable to connect|TimeoutError|TimeoutException|timed? ?out|no reply|no response|request timeout/i
        .test(rejectHaystack(err));
}

/**
 * Explains a node rejection by its ledger error code, and what to do about it.
 *
 *   'stale-dust-proof'  Codes 170, 171, 196. The fee was proven against an outdated state.
 *                       Sync the wallet, rebuild and submit again.
 *   'funds'             Codes 138, 173. The wallet cannot pay. Retrying does not help.
 *   'sequencing'        Codes 219-224 and 188. The batch's call order is not allowed.
 *                       Send the calls as separate transactions.
 *   'malformed'         Code 117, often a zero fee. Retrying does not help.
 *   'stale-transcript'  Code 104. Another transaction changed the contract first. No fee was spent.
 *                       Build the call again, for example with `rebuildOnStaleTranscript`.
 *   'unknown'           Any other rejection.
 *
 * After a rejection, always build new bytes. Resend the same bytes only after a connection failure.
 */
export function classifyNodeReject(err) {
    const haystack = rejectHaystack(err);
    const custom = /custom error:?\s*(\d+)/i.exec(haystack) ?? /\b1010\/(\d+)\b/.exec(haystack);
    const subCode = custom ? Number(custom[1]) : null;
    if (subCode !== null) {
        if (subCode === 104) return { kind: 'stale-transcript', subCode };
        if ([170, 171, 196].includes(subCode)) return { kind: 'stale-dust-proof', subCode };
        if ([138, 173].includes(subCode)) return { kind: 'funds', subCode };
        if ((subCode >= 219 && subCode <= 224) || subCode === 188) return { kind: 'sequencing', subCode };
        if (subCode === 117) return { kind: 'malformed', subCode };
    }
    if (/insufficient funds|could not balance dust/i.test(haystack)) return { kind: 'funds', subCode };
    if (/causality|sequencing/i.test(haystack)) return { kind: 'sequencing', subCode };
    return { kind: 'unknown', subCode };
}

/**
 * Runs `attempt` again after a 'stale-transcript' rejection, up to `retries` times.
 * `attempt` must build a new transaction each time, because the same bytes are refused again.
 * The pause gives the indexer time to show the contract's new state.
 */
export async function rebuildOnStaleTranscript(attempt, { retries = 2, backoffMs = 15_000, onRetry, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    for (let retry = 0; ; retry++) {
        try {
            return await attempt(retry);
        } catch (err) {
            if (retry >= retries || classifyNodeReject(err).kind !== 'stale-transcript') throw err;
            if (typeof onRetry === 'function') onRetry(retry + 1, err);
            await sleep(backoffMs);
        }
    }
}

/** Turns a ws(s):// node URL into the matching http(s):// URL. */
export function nodeHttpUrlFor(nodeUrl) {
    const u = new URL(nodeUrl);
    if (u.protocol === 'wss:') u.protocol = 'https:';
    else if (u.protocol === 'ws:') u.protocol = 'http:';
    else if (u.protocol !== 'https:' && u.protocol !== 'http:') {
        throw new Error(`nodeUrl must be ws(s):// or http(s)://, got ${u.protocol}//`);
    }
    return u.toString().replace(/\/$/, '');
}

/**
 * Submits an encoded extrinsic over a new WebSocket and returns its hash.
 * A rejection throws an Error. Pass it to `classifyNodeReject`.
 */
export function submitExtrinsic(extrinsicHex, { nodeUrl, timeoutMs = 30_000, WebSocketImpl } = {}) {
    if (!nodeUrl) throw new Error('submitExtrinsic: nodeUrl is required (the node WebSocket RPC)');
    const WsImpl = WebSocketImpl ?? require('ws');
    return new Promise((resolve, reject) => {
        const ws = new WsImpl(nodeUrl);
        let settled = false;
        let timer;
        const settle = (fn, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try { ws.close(); } catch { /* already gone */ }
            fn(value);
        };
        const failTransport = (message) => {
            const e = new Error(message);
            e.transport = true;
            settle(reject, e);
        };
        timer = setTimeout(() => failTransport(
            `submit timed out after ${timeoutMs}ms; the transaction MAY be in the mempool: probe the indexer for its identifier before resending`
        ), timeoutMs);
        ws.onopen = () => ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'author_submitExtrinsic', params: [extrinsicHex] }));
        ws.onmessage = (ev) => {
            let m;
            try { m = JSON.parse(ev.data); } catch { return; }
            if (m?.id !== 1) return;
            if (m.error) {
                const e = new Error(`node rejected: ${m.error.code} ${m.error.message}${m.error.data !== undefined ? ' | ' + JSON.stringify(m.error.data) : ''}`);
                e.code = m.error.code;
                e.data = m.error.data;
                settle(reject, e);
            } else {
                settle(resolve, String(m.result));
            }
        };
        ws.onerror = (ev) => failTransport('websocket error during submit: ' + String(ev?.message ?? ev?.error?.message ?? 'connection failed'));
        // A close before the reply fails at once, without waiting for the timeout.
        ws.onclose = (ev) => failTransport(
            `disconnected from ${nodeUrl}: ${ev?.code ?? '?'}:: ${ev?.reason || 'socket closed before the submit reply'}; ` +
            'the transaction MAY be in the mempool: probe the indexer for its identifier before resending'
        );
    });
}

/**
 * Submits a sealed transaction with its fee paid and returns the extrinsic hash.
 * Needs the optional dependency `@polkadot/api`. To look the transaction up in the indexer, use `txIdentifiers`.
 */
export async function submitFinalized(tx, { nodeUrl, nodeHttpUrl, timeoutMs = 30_000, WebSocketImpl } = {}) {
    if (!nodeUrl) throw new Error('submitFinalized: nodeUrl is required (the node WebSocket RPC, e.g. wss://rpc.preprod.midnight.network/)');
    const bytes = typeof tx?.serialize === 'function' ? new Uint8Array(tx.serialize()) : toBytes(tx);
    let polkadot;
    try {
        polkadot = await import('@polkadot/api');
    } catch {
        throw new Error("submitFinalized needs @polkadot/api to encode the extrinsic: npm install @polkadot/api");
    }
    const httpUrl = nodeHttpUrl ?? nodeHttpUrlFor(nodeUrl);
    const api = await polkadot.ApiPromise.create({ provider: new polkadot.HttpProvider(httpUrl), noInitWarn: true });
    let extrinsicHex;
    try {
        extrinsicHex = api.tx.midnight.sendMnTransaction('0x' + Buffer.from(bytes).toString('hex')).toHex();
    } finally {
        try { await api.disconnect(); } catch { /* best effort */ }
    }
    return submitExtrinsic(extrinsicHex, { nodeUrl, timeoutMs, WebSocketImpl });
}

/**
 * Asks the indexer whether a transaction landed. Returns null while this is not known yet.
 * `applied: false` means the transaction is in a block but its call failed. The fee was still spent.
 * Always check by identifier. Watching the contract address could pick up someone else's call.
 */
export async function probeLanded(identifier, { indexerHttpUrl, fetchFn, timeoutMs = 15_000 } = {}) {
    if (!identifier) throw new Error('probeLanded: identifier is required (txIdentifiers(tx).at(-1))');
    if (!indexerHttpUrl) throw new Error('probeLanded: indexerHttpUrl is required');
    const doFetch = fetchFn || fetch;
    try {
        const r = await doFetch(indexerHttpUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: `{ transactions(offset:{identifier:"${identifier}"}) { block { height } ... on RegularTransaction { transactionResult { status segments { id success } } } } }` }),
            signal: AbortSignal.timeout(timeoutMs)
        });
        if (!r.ok) return null;
        const j = await r.json();
        if (Array.isArray(j?.errors) && j.errors.length > 0) return null;
        const t = j?.data?.transactions?.[0];
        const height = t?.block?.height;
        if (height == null) return null;
        // A landed transaction always has a status. Without one the indexer answer is incomplete.
        const status = t?.transactionResult?.status;
        if (status == null) return null;
        const segments = t.transactionResult.segments;
        const failedSegments = Array.isArray(segments) ? segments.filter((s) => s?.success === false).map((s) => Number(s.id)) : [];
        return { height: String(height), status: String(status), failedSegments, applied: status === 'SUCCESS' };
    } catch {
        return null;
    }
}

/**
 * Calls `probeLanded` until the transaction is found or `timeoutMs` has passed. It asks at least once.
 * Use it when a resend is rejected. The first send may already be on chain while the indexer lags behind.
 */
export async function waitLanded(identifier, { indexerHttpUrl, timeoutMs = 30_000, pollMs = 5_000, fetchFn } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (; ;) {
        const found = await probeLanded(identifier, { indexerHttpUrl, fetchFn });
        if (found) return found;
        const left = deadline - Date.now();
        if (left <= 0) return null;
        await new Promise((r) => setTimeout(r, Math.min(pollMs, left)));
    }
}

/**
 * Runs `fn`, which builds and submits one transaction that pays its own fee.
 * If the node rejects it before the mempool, the SDK's DUST wallet wrongly keeps the fee reserved.
 * Enough of these and the wallet can no longer pay. So this saves the DUST wallet first and restores it after such a rejection.
 * The rethrown error then has `dustRestored = true`. If you save the wallet to disk, save the restored state.
 * Run only one guarded build per wallet at a time.
 *
 * @param facade  The wallet facade whose DUST wallet to protect.
 * @param opts    The configuration the facade was created with, the DUST secret key,
 *                and optionally your own DustWallet factory.
 * @param fn      Builds, balances and submits one transaction.
 */
export async function withDustGuard(facade, { configuration, dustKey, dustWalletFactory } = {}, fn) {
    if (!facade?.dust) throw new Error('withDustGuard: facade with a dust sub-wallet is required');
    if (!configuration || !dustKey) throw new Error('withDustGuard: configuration and dustKey are required (the values the facade was created with)');
    let snapshot = null;
    try { snapshot = await facade.dust.serializeState(); } catch { snapshot = null; }
    try {
        return await fn();
    } catch (e) {
        if (snapshot && isPreMempoolReject(e)) {
            try {
                const factory = dustWalletFactory ?? (await import('@midnightntwrk/wallet-sdk-dust-wallet')).DustWallet;
                const fresh = factory(configuration).restore(snapshot);
                await fresh.start(dustKey);
                const old = facade.dust;
                facade.dust = fresh;
                try { await old.stop(); } catch { /* already dead is fine */ }
                try { e.dustRestored = true; } catch { /* frozen error */ }
            } catch { /* restore failed: keep the old wallet */ }
        }
        throw e;
    }
}
