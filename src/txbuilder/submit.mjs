// Self-funded submission: the pieces a caller needs when it pays its own dust
// and submits to the node itself instead of handing the transaction to a
// sponsor. Build with `createTxBuilder`, balance the fee in your own wallet
// facade, then submit and confirm here.
//
// The node's HTTP gateway rejects request bodies over ~14 KB with a 403, so a
// proven contract-call transaction only submits over WebSocket. Encoding the
// extrinsic still runs over HTTP (a metadata read, no persistent socket).
//
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** Tag sets a built transaction deserializes under: bound first, then pre-binding. */
const DESERIALIZE_TAGS = [
    ['signature', 'proof', 'binding'],
    ['signature', 'proof', 'pre-binding']
];

const toBytes = (input) => {
    if (input instanceof Uint8Array) return input;
    if (typeof input === 'string') return new Uint8Array(Buffer.from(input, 'base64'));
    throw new Error('expected a Uint8Array or a base64 string');
};

/**
 * Deserialize a built transaction (bytes or base64) into a ledger
 * `Transaction`, trying the bound tag set first, then pre-binding.
 */
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
 * The transaction's identifiers (`tx.identifiers()`), the last one being what
 * the wallet SDK's submit returns and what the indexer's
 * `transactions(offset:{identifier})` query takes. Resend the SAME bytes only
 * after `probeLanded` says the first send did not land.
 */
export function txIdentifiers(tx) {
    if (typeof tx?.identifiers !== 'function') {
        throw new Error('txIdentifiers: expected a deserialized ledger Transaction (see deserializeTransaction)');
    }
    return Array.from(tx.identifiers(), String);
}

// Messages of the error and its cause chain, `:line:col` tokens stripped so a
// source position can never register as a reject code.
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
 * Substrate rejects that provably never entered the mempool: 1010 (invalid),
 * 1014 (priority too low: the pool kept the earlier transaction) and 1016
 * (immediately dropped). Deliberately NOT 1013 (already imported: the
 * transaction IS in the pool). A pre-mempool reject spends no fee; after one
 * on a dust-spending transaction, restore the dust wallet (`withDustGuard`)
 * or its spent note stays pending until the wallet cannot balance.
 */
export function isPreMempoolReject(err) {
    return /\b101[046]\s*:|priority is too low|immediately dropped|invalid transaction/i.test(rejectHaystack(err));
}

/**
 * 1013 Transaction Already Imported: the transaction IS in the pool. After a
 * resend of the same bytes (the first reply was lost) this is the expected
 * answer, and it means the ORIGINAL send succeeded: go to the confirmation
 * loop (`probeLanded`), never treat it as a failure; an immediate probe can
 * still be null from indexer lag.
 */
export function isAlreadyImported(err) {
    return /\b1013\s*:|already imported/i.test(rejectHaystack(err));
}

/**
 * The send itself failed (socket closed or reset, no reply, submit timeout):
 * the transaction MAY still be in the mempool. Probe the indexer for the
 * identifier, then resend the SAME bytes; never rebuild on transport alone,
 * a rebuilt duplicate can land next to the original.
 */
export function isTransportFailure(err) {
    if (isPreMempoolReject(err)) return false;
    return /disconnected from|Normal Closure|Abnormal Closure|WebSocket is not connected|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|socket hang up|Unable to connect|TimeoutError|TimeoutException|timed? ?out|no reply|no response|request timeout/i
        .test(rejectHaystack(err));
}

/**
 * What a node reject means, from the ledger sub-code in the error (message or
 * cause chain). The kinds and their remedies:
 *
 *   'stale-dust-proof'  170 InvalidDustSpendProof / 171 OutOfDustValidityWindow /
 *                       196 nullifier already known: the dust fee was proven
 *                       against a state the node moved past. The wallet is NOT
 *                       out of dust: re-sync it to the tip, rebuild, resubmit.
 *   'funds'             138 BalanceCheckOverspend / 173, or the balancer's own
 *                       "could not balance dust": the wallet genuinely cannot
 *                       pay. Retrying or splitting buys nothing.
 *   'sequencing'        219-224 (188 on older nodes): the batch's call order is
 *                       illegal for the contract's current state. Splitting
 *                       into single-call transactions is the remedy.
 *   'malformed'         117 NotNormalized (classically a zero fee). Neither
 *                       waiting nor an identical rebuild fixes it.
 *   'unknown'           a 1010 this table does not know, or not a coded reject.
 *
 * Rebuilds after a reject must produce FRESH bytes; resubmitting identical
 * bytes is only ever correct after a transport failure (see isTransportFailure).
 */
export function classifyNodeReject(err) {
    const haystack = rejectHaystack(err);
    const custom = /custom error:?\s*(\d+)/i.exec(haystack);
    const subCode = custom ? Number(custom[1]) : null;
    if (subCode !== null) {
        if ([170, 171, 196].includes(subCode)) return { kind: 'stale-dust-proof', subCode };
        if ([138, 173].includes(subCode)) return { kind: 'funds', subCode };
        if ((subCode >= 219 && subCode <= 224) || subCode === 188) return { kind: 'sequencing', subCode };
        if (subCode === 117) return { kind: 'malformed', subCode };
    }
    if (/insufficient funds|could not balance dust/i.test(haystack)) return { kind: 'funds', subCode };
    if (/causality|sequencing/i.test(haystack)) return { kind: 'sequencing', subCode };
    return { kind: 'unknown', subCode };
}

/** `wss://host/path` -> `https://host/path` (and ws -> http); http(s) passes through. */
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
 * Submit an already-encoded extrinsic over a one-shot WebSocket
 * (`author_submitExtrinsic`). Resolves with the extrinsic hash; a node reject
 * becomes an Error carrying the code, message and the ledger sub-code in
 * `error.data` (feed it to `classifyNodeReject`).
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
        // A close before the reply (the gateway's own 1000 Normal Closure
        // included) must fail NOW as transport, not wait out the timeout.
        ws.onclose = (ev) => failTransport(
            `disconnected from ${nodeUrl}: ${ev?.code ?? '?'}:: ${ev?.reason || 'socket closed before the submit reply'}; ` +
            'the transaction MAY be in the mempool: probe the indexer for its identifier before resending'
        );
    });
}

/**
 * Submit a finalized (bound, fee-paid) transaction to the node. Takes the
 * ledger `Transaction` or its serialized bytes/base64; encodes the
 * `midnight.sendMnTransaction` extrinsic over HTTP (derived from `nodeUrl`
 * unless `nodeHttpUrl` is given), then submits over a one-shot WebSocket.
 * Returns the extrinsic hash; the transaction identifier for the indexer
 * comes from `txIdentifiers`.
 *
 * Needs `@polkadot/api` (an optional peer dependency): the extrinsic encoding
 * reads the runtime metadata, so a runtime upgrade cannot silently break it.
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
 * Ask the indexer whether a transaction landed. Returns null while unknown
 * (not indexed yet, an HTTP or GraphQL error, or a partial answer without a
 * transaction result), else `{ height, status, failedSegments, applied }`:
 * `applied` is true only for ledger result SUCCESS; false means the
 * transaction is in a block but its call did NOT apply (FAILURE /
 * PARTIAL_SUCCESS: the fee was spent, rebuild against current state).
 * Confirm by identifier, never by watching the contract address: on a
 * public contract someone else's call confirms yours otherwise.
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
        // Every submitted transaction is a RegularTransaction, so a landing
        // carries a status; a missing one is a partial indexer answer and
        // must read as unknown, never as applied.
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
 * `probeLanded` in a bounded loop: poll until the identifier is known or
 * `timeoutMs` is up (one probe minimum, so `timeoutMs: 0` asks exactly once).
 * Use it before trusting the refusal of a RESEND: any reject of resent bytes
 * (1013 Already Imported, but also e.g. a 1010 whose note the landed first
 * send already spent) can mean the FIRST send is on chain while the indexer
 * still lags; a reject propagated too early makes a landed transaction look
 * like a failure, and a dust guard would then restore a snapshot it must not.
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
 * Dust wedge protection around a dust-spending build + submit. A pre-mempool
 * reject leaves the spent dust note pending inside the SDK's dust wallet
 * (upstream bug); the pending atoms accumulate until the wallet cannot
 * balance a fee it can afford. This snapshots the dust sub-wallet before
 * `fn`, and on a pre-mempool reject swaps in a wallet restored from the
 * snapshot (`error.dustRestored = true` on the rethrown error). The caller
 * owns persistence: if you snapshot the facade to disk, persist the restored
 * state and never a post-reject one, or a restart restores the wedge.
 *
 * Serialize your builds: one guarded build per facade at a time.
 *
 * @param facade  the wallet facade whose `dust` sub-wallet to guard
 * @param opts    `{ configuration, dustKey, dustWalletFactory? }`: the same
 *                configuration object the facade was created with, the dust
 *                secret key, and optionally your own `(configuration) =>
 *                DustWallet` (defaults to the SDK's).
 * @param fn      builds, balances and submits ONE transaction
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
            } catch { /* restore failed: the old (possibly wedged) wallet stays, no worse than without the guard */ }
        }
        throw e;
    }
}
