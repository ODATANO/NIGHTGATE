// HTTP client for a hosted NIGHTGATE server. Each server action is a function here.
// Write actions run as background jobs and return `{ jobId, status }`. `waitForJob` polls until the job ends.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from 'node:crypto';

export { verifyReceipt } from './receipt.mjs';

/** Error of a failed server call, with the server's status and error code. `retryAfterSeconds` comes from `Retry-After` when the server sent it. */
export class NightgateApiError extends Error {
    constructor(status, code, message, retryAfterSeconds, job) {
        super(message);
        this.name = 'NightgateApiError';
        this.status = status;
        this.code = code;
        this.retryAfterSeconds = retryAfterSeconds;
        if (job && typeof job === 'object') this.job = job;
    }
}

/** Server error codes a client may retry unchanged. `npm run errors:table` writes the list from the server's table of codes. */
export const RETRYABLE_ERROR_CODES = new Set([
    // retryable-codes:start
    'ACCOUNT_KEY_UNAVAILABLE', 'BAD_GATEWAY', 'JOB_ADMISSION_BUSY', 'PROVER_KEYS_UNAVAILABLE',
    'RATE_LIMITED', 'RUNTIME_UNAVAILABLE', 'SPONSOR_POLICY_UNAVAILABLE', 'SUBMIT_INTENT_TIMEOUT',
    'UNAVAILABLE', 'WALLET_NOT_SYNCED', 'WALLET_SYNCING', 'WORKER_ROTATING'
    // retryable-codes:end
]);

/** Whether a failed call may be retried unchanged. Uses the server's error code, else the HTTP status. Network errors are retryable.
 *  A write that carries `idempotencyKey` got no answer of the server itself and may have started its job: repeat it with that key, never unchanged. */
export function isRetryable(err) {
    const mayHaveStarted = typeof err?.idempotencyKey === 'string';
    if (err instanceof NightgateApiError) {
        if (typeof err.code === 'string' && !/^\d+$/.test(err.code)) return RETRYABLE_ERROR_CODES.has(err.code);
        // An answer without a server code comes from something in between, which may have passed the request on.
        return mayHaveStarted ? err.status === 429 : [429, 502, 503, 504].includes(err.status);
    }
    if (err instanceof NightgateJobError) return false;
    if (mayHaveStarted) return false;
    return gotNoAnswer(err);
}

/** True for a timeout or a network failure: the call got no answer, and the server may or may not have received it. */
function gotNoAnswer(err) {
    if (err instanceof NightgateApiError || err instanceof NightgateJobError) return false;
    return err?.name === 'TimeoutError' || err?.name === 'AbortError' || /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN/i.test(String(err?.message ?? err));
}

/** True for an answer that did not come from the server itself, such as a gateway timeout. The request may have gone through. */
function answeredInBetween(err) {
    if (!(err instanceof NightgateApiError)) return false;
    const ownCode = typeof err.code === 'string' && !/^\d+$/.test(err.code);
    return !ownCode && (err.status === 502 || err.status === 504);
}

/** Error thrown by waitForJob when the job itself failed. */
export class NightgateJobError extends Error {
    constructor(job) {
        super(`job ${job.jobId ?? ''} ${job.status}: ${job.errorCode ?? ''}: ${job.errorMessage ?? ''}`);
        this.name = 'NightgateJobError';
        this.job = job;
    }
}

/** Marks a value as a 64-bit integer for a function URL. It is written unquoted and stays exact above Number.MAX_SAFE_INTEGER. */
export function int64(value) {
    const digits = String(value);
    if (!/^-?\d+$/.test(digits)) throw new Error(`int64: not an integer: ${value}`);
    return { $int64: digits };
}

function odataLiteral(value) {
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (typeof value === 'bigint') return value.toString();
    if (value && typeof value === 'object' && value.$int64) return value.$int64;
    return `'${String(value).replace(/'/g, "''")}'`;
}

/** Lowercase hex without `0x`, the form the server stores addresses and identifiers in. */
function hexOf(value) {
    return String(value).trim().toLowerCase().replace(/^0x/, '');
}

/** A JSON list of strings as the server stores it, or an array already. Anything else is empty. */
function parseStringList(raw) {
    if (Array.isArray(raw)) return raw.map(String);
    if (typeof raw !== 'string' || !raw) return [];
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
        return [];
    }
}

function stripODataNoise(payload) {
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return payload;
    const out = {};
    for (const [key, value] of Object.entries(payload)) {
        if (key.startsWith('@odata')) continue;
        out[key] = value;
    }
    return out;
}

/** A request may be sent twice only when the second delivery cannot create a second effect. */
function isSafeToRepeat(method, body) {
    if (method === 'GET') return true;
    const key = body && typeof body === 'object' ? body.idempotencyKey : undefined;
    return typeof key === 'string' && key.length > 0;
}

/** Detects a reused connection that the server had already closed. */
function isStaleSocketError(err) {
    const cause = err?.cause ?? err;
    const code = String(cause?.code ?? '');
    return /fetch failed/i.test(String(err?.message ?? '')) && /^(ECONNRESET|EPIPE|UND_ERR_SOCKET)$/.test(code);
}

// A receipt takes as long as the chain does, and a metered gateway may bill each poll.
const RECEIPT_POLL_MS = 10_000;
const RECEIPT_POLL_MAX_MS = 60_000;

/** Connects to a hosted NIGHTGATE. `longPollMs` is capped at 25000 and at 5000 below `timeoutMs`, and 0 turns long polling off. */
export function connect(opts) {
    const {
        baseUrl, servicePath = '/odata/v4/midnight', indexerServicePath = '/odata/v4/midnight-indexer',
        agentToken, token, username, password,
        timeoutMs = 120_000, pollMs = 2_000, longPollMs = 20_000, fetchFn
    } = opts ?? {};
    // The server waits at most 25 s. Each wait ends 5 s before the request timeout so the answer still arrives.
    const longPollCapMs = Math.max(0, Math.min(Math.floor(Number(longPollMs) || 0), 25_000, timeoutMs - 5_000));
    const longPoll = longPollCapMs > 0;
    if (!baseUrl) throw new Error('connect: baseUrl is required');
    const doFetch = fetchFn || fetch;
    const service = String(baseUrl).replace(/\/$/, '') + servicePath;
    const indexerService = String(baseUrl).replace(/\/$/, '') + indexerServicePath;

    async function request(method, url, body) {
        const headers = { Accept: 'application/json' };
        if (agentToken) {
            headers['x-agent-token'] = agentToken;
            if (username) headers.Authorization = 'Basic ' + Buffer.from(`${username}:${password ?? ''}`).toString('base64');
        } else if (token) {
            headers.Authorization = `Bearer ${token}`;
        } else if (username) {
            headers.Authorization = 'Basic ' + Buffer.from(`${username}:${password ?? ''}`).toString('base64');
        }
        if (body !== undefined) headers['Content-Type'] = 'application/json';

        const init = () => ({
            method, headers,
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(timeoutMs)
        });
        let response;
        try {
            response = await doFetch(url, init());
        } catch (err) {
            // A connection that sat idle too long may have been closed by the server.
            // We cannot tell whether the server got the request, so only safe requests are resent.
            // Safe means a GET, or a POST with an `idempotencyKey` the server uses to drop duplicates.
            if (!isStaleSocketError(err) || !isSafeToRepeat(method, body)) throw err;
            response = await doFetch(url, init());
        }
        const text = await response.text();
        let payload;
        try { payload = text ? JSON.parse(text) : {}; } catch { payload = { raw: text }; }
        if (!response.ok) {
            const err = payload?.error;
            const retryAfter = Number(response.headers?.get?.('retry-after'));
            throw new NightgateApiError(response.status, err?.code, err?.message ?? `NIGHTGATE request failed with HTTP ${response.status}`,
                Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined, err?.['@nightgate.job']);
        }
        return stripODataNoise(payload);
    }

    /** GET <service>/<name>(p1=...,p2=...) with only the provided parameters. */
    function callFunction(name, params = {}) {
        const parts = [];
        for (const [key, value] of Object.entries(params)) {
            if (value === undefined || value === null || value === '') continue;
            parts.push(`${key}=${odataLiteral(value)}`);
        }
        return request('GET', `${service}/${name}(${parts.join(',')})`);
    }

    /** POST <service>/<name> with the provided parameters as JSON body. */
    function callAction(name, params = {}) {
        const body = {};
        for (const [key, value] of Object.entries(params)) {
            if (value === undefined) continue;
            body[key] = typeof value === 'bigint' ? value.toString() : value;
        }
        return request('POST', `${service}/${name}`, body);
    }

    /** The job keeps running on the server after a temporary poll error, so the poll is retried. */
    function isTransientPollError(err) {
        return isRetryable(err);
    }

    /** Polls getJobStatus until the job ends. Temporary poll errors are retried for up to `pollGraceMs`. A failed job throws at once. */
    async function waitForJob({ jobId, sessionId, pollMs: overridePollMs, timeoutMs: waitTimeoutMs = 60 * 60 * 1000, pollGraceMs = 5 * 60 * 1000 }) {
        if (!jobId) throw new Error('waitForJob: jobId is required');
        const interval = overridePollMs ?? pollMs;
        const deadline = Date.now() + waitTimeoutMs;
        let firstPollFailure = null;
        for (;;) {
            let job;
            const waitMs = longPoll ? Math.max(0, Math.min(longPollCapMs, deadline - Date.now())) : 0;
            const asked = Date.now();
            try {
                job = await callFunction('getJobStatus', waitMs > 0 ? { jobId, sessionId, waitMs } : { jobId, sessionId });
                firstPollFailure = null;
            } catch (err) {
                if (!isTransientPollError(err)) throw err;
                firstPollFailure ??= Date.now();
                // Give up when poll errors last too long or the overall deadline has passed.
                if (Date.now() - firstPollFailure > pollGraceMs || Date.now() > deadline) throw err;
                await new Promise(r => setTimeout(r, interval));
                continue;
            }
            if (job.status === 'succeeded') {
                const result = job.result ?? {};
                // A receipt exists only once the chain confirmed the job. The session lets a caller ask for it later.
                const chain = { chainStatus: job.chainStatus ?? null, blockHeight: job.blockHeight ?? null };
                return { ...result, jobId, sessionId, txId: result.txId ?? job.txId ?? null, txHash: result.txHash ?? job.txHash ?? null, ...chain, ...(job.receipt ? { receipt: job.receipt } : {}) };
            }
            if (job.status === 'failed' || job.status === 'reconciliation_required') {
                throw new NightgateJobError({ ...job, jobId });
            }
            if (Date.now() > deadline) throw Object.assign(new Error(`waitForJob: job ${jobId} still ${job.status} after ${waitTimeoutMs}ms`), { jobId, sessionId });
            // A long poll that ran its time needs no pause; one the server answered at once does.
            if (waitMs === 0 || Date.now() - asked < Math.min(waitMs, 1000)) await new Promise(r => setTimeout(r, interval));
        }
    }

    /** Waits until the chain confirmed a sponsored swap or transfer and returns its receipt. Throws when the job fails or can have none. */
    async function waitForReceipt({ jobId, sessionId, pollMs: overridePollMs, timeoutMs: waitTimeoutMs = 10 * 60 * 1000, pollGraceMs = 5 * 60 * 1000 }) {
        if (!jobId) throw new Error('waitForReceipt: jobId is required');
        const deadline = Date.now() + waitTimeoutMs;
        let interval = overridePollMs ?? RECEIPT_POLL_MS;
        let firstPollFailure = null;
        for (;;) {
            let job;
            const waitMs = longPoll ? Math.max(0, Math.min(longPollCapMs, deadline - Date.now())) : 0;
            const asked = Date.now();
            try {
                job = await callFunction('getJobStatus', waitMs > 0 ? { jobId, sessionId, waitMs, untilChain: true } : { jobId, sessionId });
                firstPollFailure = null;
            } catch (err) {
                if (!isTransientPollError(err)) throw err;
                firstPollFailure ??= Date.now();
                if (Date.now() - firstPollFailure > pollGraceMs || Date.now() > deadline) throw err;
                await new Promise(r => setTimeout(r, interval));
                continue;
            }
            if (job.receipt) return job.receipt;
            if (job.status === 'failed' || job.status === 'reconciliation_required') throw new NightgateJobError({ ...job, jobId });
            if (job.status === 'succeeded' && job.chainStatus !== 'pending') {
                throw new Error(`waitForReceipt: job ${jobId} (${job.kind ?? 'unknown kind'}) has no receipt, chain status ${job.chainStatus ?? 'none'}; only a sponsored swap or transfer that landed gets one`);
            }
            if (Date.now() > deadline) throw new Error(`waitForReceipt: job ${jobId} has no receipt after ${waitTimeoutMs}ms (status ${job.status}, chain status ${job.chainStatus ?? 'none'})`);
            // A long poll that ran its time needs no pause; one the server answered at once does.
            if (waitMs === 0 || Date.now() - asked < Math.min(waitMs, 1000)) {
                await new Promise(r => setTimeout(r, interval));
                interval = Math.min(interval * 2, RECEIPT_POLL_MAX_MS);
            }
        }
    }

    /** Starts a job and waits for its result. Every start carries a key, so a start that got no answer goes out once more without a second job. */
    async function act(name, params) {
        const ownKey = params?.idempotencyKey ? undefined : randomUUID();
        const body = { ...params, idempotencyKey: params?.idempotencyKey || ownKey };
        // A key this client made is unknown to the caller. A failed start names it, so the caller can repeat the call too.
        const named = (err) => {
            if (ownKey && err && typeof err === 'object') err.idempotencyKey = ownKey;
            return err;
        };
        let started;
        try {
            started = await callAction(name, body);
        } catch (err) {
            // The server may have started the job. Under the same key it answers the repeat with that job.
            // A dead connection was already tried again by the request itself, so it is not repeated here.
            if (isStaleSocketError(err) || (!gotNoAnswer(err) && !answeredInBetween(err))) throw named(err);
            started = await callAction(name, body).catch((again) => { throw named(again); });
        }
        if (!started?.jobId) return started;
        // Use the session id the server returns. Sponsored jobs run under a session the
        // server picks, so the caller cannot know it.
        return waitForJob({ jobId: started.jobId, sessionId: started.sessionId ?? params.sessionId });
    }

    /** Null for a 404, so a caller can wait for something the index has not seen yet. */
    const orNull = (promise) => promise.catch((err) => { if (err instanceof NightgateApiError && err.status === 404) return null; throw err; });

    /** The contract's state at `height`, or its newest one. `state`, `zswapState` and `ledgerParameters` are base64. */
    function contractStateAt({ contractAddress, height } = {}) {
        if (!contractAddress) throw new Error('contractStateAt: contractAddress is required');
        const at = height == null ? 'null' : odataLiteral(height);
        return orNull(request('GET', `${service}/ContractStates/stateAt(contractAddress=${odataLiteral(hexOf(contractAddress))},height=${at})`));
    }

    /** Where a transaction landed, by one of its ledger identifiers. Null while the server has not indexed it. */
    function transactionByTxId(txId) {
        if (!txId) throw new Error('transactionByTxId: txId is required');
        return orNull(callFunction('Transactions/byTxId', { txId: hexOf(txId) }));
    }

    /** The serialized ledger transaction as base64, or null while the server has not indexed it. */
    async function ledgerTransaction(hash) {
        if (!hash) throw new Error('ledgerTransaction: hash is required');
        return (await orNull(callFunction('Transactions/ledgerTransaction', { hash: hexOf(hash) })))?.ledgerTransaction ?? null;
    }

    /** The ledger parameters in effect at `height`, or at the chain tip. `ledgerParameters` is base64. Null when the server does not know them. */
    function ledgerParametersAt({ height } = {}) {
        const at = height == null ? 'null' : odataLiteral(height);
        return orNull(request('GET', `${service}/Blocks/ledgerParametersAt(height=${at})`));
    }

    /** One page of a table's rows. The server hands out at most its page size per read, 1000 rows by default: page with `skip` until a read is empty. */
    async function readTable(entity, { filter, orderby, top, skip, select, service: from = 'main' } = {}) {
        if (typeof entity !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*$/.test(entity)) throw new Error('read: entity must be the name of a table, such as Blocks');
        if (from !== 'main' && from !== 'indexer') throw new Error("read: service must be 'main' or 'indexer'");
        const options = [];
        const add = (name, value) => { if (value !== undefined && value !== null && value !== '') options.push(`${name}=${encodeURIComponent(String(value))}`); };
        add('$filter', filter);
        add('$orderby', orderby);
        add('$select', Array.isArray(select) ? select.join(',') : select);
        for (const [name, value] of [['top', top], ['skip', skip]]) {
            if (value === undefined || value === null) continue;
            if (!Number.isInteger(value) || value < 0) throw new Error(`read: ${name} must be a non-negative integer`);
            add(`$${name}`, value);
        }
        const page = await request('GET', `${from === 'indexer' ? indexerService : service}/${entity}${options.length ? `?${options.join('&')}` : ''}`);
        return Array.isArray(page?.value) ? page.value : [];
    }

    /** The block at `height`, or the newest one. Null while the server has not indexed it. */
    async function blockAt(height) {
        const pick = height == null ? '$orderby=height%20desc' : `$filter=${encodeURIComponent(`height eq ${odataLiteral(height)}`)}`;
        const page = await request('GET', `${service}/Blocks?${pick}&$top=1&$select=hash,height,protocolVersion,timestamp`);
        const block = Array.isArray(page?.value) ? page.value[0] : undefined;
        if (!block?.hash) return null;
        return { hash: block.hash, height: Number(block.height), protocolVersion: Number(block.protocolVersion), timestamp: Number(block.timestamp) };
    }

    /** The transaction that deployed the contract, or null while the server has not indexed it. */
    async function contractDeploy(contractAddress) {
        if (!contractAddress) throw new Error('contractDeploy: contractAddress is required');
        const filter = `contractAddress eq ${odataLiteral(hexOf(contractAddress))} and actionType eq 'DEPLOY'`;
        const expand = '$expand=transaction($expand=block,transactionResult($expand=segments))';
        const page = await request('GET', `${service}/ContractActions?$filter=${encodeURIComponent(filter)}&${expand}&$top=1`);
        const action = Array.isArray(page?.value) ? page.value[0] : undefined;
        const tx = action?.transaction;
        if (!tx?.block) return null;
        const identifiers = parseStringList(tx.identifiers);
        const segments = tx.transactionResult?.segments ?? [];
        return {
            extrinsicHash: tx.extrinsicHash,
            txHash: tx.txHash ?? null,
            blockHeight: Number(tx.block.height),
            blockHash: tx.block.hash,
            blockTimestamp: Number(tx.block.timestamp),
            protocolVersion: Number(tx.block.protocolVersion),
            status: tx.transactionResult?.status ?? null,
            failedSegments: segments.filter(s => s?.success === false).map(s => Number(s.segmentId)),
            identifiers,
            txId: action.actionIndex != null ? identifiers[Number(action.actionIndex)] : undefined
        };
    }

    return {
        // generic calls, for anything without its own function below
        callFunction,
        callAction,
        waitForJob,
        waitForReceipt,

        // ---- chain reads a transaction builder needs. No wallet, no login beyond the token. ----
        contractStateAt,
        ledgerParametersAt,
        read: readTable,
        blockAt,
        transactionByTxId,
        contractDeploy,
        ledgerTransaction,

        // ---- checks that read the chain directly. No wallet. ----
        verifyAttestation: (p) => callFunction('verifyAttestation', p),
        verifyPredicate: (p) => callFunction('verifyPredicate', p),
        verifyDisclosure: (p) => callFunction('verifyDisclosure', p),
        verifyPredicateAttestation: (p) => callFunction('verifyPredicateAttestation', p),
        verifyDocument: (p) => callFunction('verifyDocument', p),
        deriveTokenType: (p) => callFunction('deriveTokenType', p),
        getHealth: () => request('GET', `${indexerService}/getHealth()`),
        /** Counts of the offer board and the sponsor pool, plus the instance's token factory. No login. */
        getBoardStatus: () => request('GET', `${indexerService}/getBoardStatus()`),
        /** The key the instance signs job receipts with. No login. */
        getReceiptKey: () => request('GET', `${indexerService}/getReceiptKey()`),

        // ---- grants ----
        /** What a grant did and its limits. A token may leave `grantId` out. `since` and `until` are ISO timestamps, default the last 30 days. */
        getGrantUsage: ({ grantId, since, until } = {}) => callFunction('getGrantUsage', { grantId, since, until }),

        // ---- input preparation. No wallet, no transaction. ----
        prepareDocumentProof: (p) => callAction('prepareDocumentProof', p),
        prepareMembershipSet: (p) => callAction('prepareMembershipSet', p),

        // ---- wallet sessions ----
        connectWallet: (p) => callAction('connectWallet', p),
        connectWalletForSigning: (p) => callAction('connectWalletForSigning', p),
        disconnectWallet: (p) => callAction('disconnectWallet', p),
        deriveWalletInfo: (p) => callAction('deriveWalletInfo', p),
        getWalletBalance: (p) => callFunction('getWalletBalance', p),
        getWalletSyncProgress: (p) => callFunction('getWalletSyncProgress', p),

        // ---- documents and zero-knowledge proofs. These wait for the job result. ----
        anchorDocument: (p) => act('anchorDocument', p),
        attestAgentOutput: (p) => act('attestAgentOutput', p),
        proveFieldPredicate: (p) => act('proveFieldPredicate', p),
        proveFieldEquality: (p) => act('proveFieldEquality', p),
        proveFieldMembership: (p) => act('proveFieldMembership', p),
        proveClaims: (p) => act('proveClaims', p),
        proveDocumentIntegrity: (p) => act('proveDocumentIntegrity', p),
        proveDocumentDiff: (p) => act('proveDocumentDiff', p),

        // ---- disclosure ----
        grantDisclosure: (p) => act('grantDisclosure', p),
        revokeDisclosure: (p) => act('revokeDisclosure', p),
        registerDocument: (p) => act('registerDocument', p),
        retractAttestation: (p) => act('retractAttestation', p),
        purgeExpired: (p) => act('purgeExpired', p),

        // ---- contracts + tokens ----
        deployContract: (p) => act('deployContract', p),
        submitContractCall: (p) => act('submitContractCall', p),
        submitContractCallBatch: (p) => act('submitContractCallBatch', p),
        /** Mints a named token on a token factory. Takes `name`, `amount`, `receiverCoinPublicKey`, optionally `contractAddress` and `sessionId`. */
        mintFactoryToken: (p) => act('mintFactoryToken', p),
        /** Burns `amount` of a factory token the session holds. Takes `name`, `amount`, `sessionId`, optionally `contractAddress` and `issuerKey`. */
        burnFactoryToken: (p) => act('burnFactoryToken', p),
        sendToken: (p) => act('sendToken', p),

        /** Sends a transaction built without a fee, txbuilder's finalizedTxB64. The server adds the fee, submits it and returns the txHash. */
        sponsorFinalized: (p) => act('sponsorFinalized', p),
        /** Like sponsorFinalized, for a transaction built with `bind: false`. The server can pay for several of these at once. */
        sponsorUnbound: (p) => act('sponsorUnbound', p),
        /** Takes both halves of a private token swap. The server joins them, pays the fee and submits. */
        sponsorSwap: (p) => act('sponsorSwap', p),
        /** Takes a plain transfer (`transferTxB64`, `tokenType`, `amount`) built by the swap wallet or the unshielded wallet. The server pays the fee and submits. */
        sponsorTransfer: (p) => act('sponsorTransfer', p),
        buildSponsorable: async (p) => {
            const started = await callAction('buildSponsorable', p);
            return started?.jobId ? waitForJob({ jobId: started.jobId, sessionId: started.sessionId ?? p.sessionId }) : started;
        }
    };
}
