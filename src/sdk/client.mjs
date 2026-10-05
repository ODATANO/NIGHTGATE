// HTTP client for a hosted NIGHTGATE server. Each server action is a function here.
//
//   import { connect } from '@odatano/nightgate/client';
//
//   const ng = connect({ baseUrl: 'https://nightgate.example' });
//   const state = await ng.verifyAttestation({ contractAddress, attesterId, payloadHash });
//
// To log in, pass `agentToken`, `token` for Bearer, or `username` and `password` for Basic.
// An agent token can be sent together with Basic credentials.
//
// Actions that write run as background jobs and return `{ jobId, status }`.
// `waitForJob` polls until the job ends and returns its parsed result.
//
// SPDX-License-Identifier: Apache-2.0

/** Error of a failed server call, with the server's status and error code. */
export class NightgateApiError extends Error {
    constructor(status, code, message) {
        super(message);
        this.name = 'NightgateApiError';
        this.status = status;
        this.code = code;
    }
}

/** Server error codes a client may retry unchanged. */
export const RETRYABLE_ERROR_CODES = new Set([
    'RATE_LIMITED', 'BAD_GATEWAY', 'UNAVAILABLE', 'ACCOUNT_KEY_UNAVAILABLE', 'JOB_ADMISSION_BUSY',
    'PROVER_KEYS_UNAVAILABLE', 'RUNTIME_UNAVAILABLE', 'SPONSOR_POLICY_UNAVAILABLE', 'SUBMIT_INTENT_TIMEOUT',
    'WALLET_NOT_SYNCED', 'WALLET_SYNCING', 'WORKER_ROTATING'
]);

/**
 * Whether a failed call may be retried unchanged.
 * Uses the server's error code if there is one, else the HTTP status. Network errors are retryable.
 */
export function isRetryable(err) {
    if (err instanceof NightgateApiError) {
        if (typeof err.code === 'string' && !/^\d+$/.test(err.code)) return RETRYABLE_ERROR_CODES.has(err.code);
        return [429, 502, 503, 504].includes(err.status);
    }
    if (err instanceof NightgateJobError) return false;
    return err?.name === 'TimeoutError' || err?.name === 'AbortError' || /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN/i.test(String(err?.message ?? err));
}

/** Error thrown by waitForJob when the job itself failed. */
export class NightgateJobError extends Error {
    constructor(job) {
        super(`job ${job.jobId ?? ''} ${job.status}: ${job.errorCode ?? ''}: ${job.errorMessage ?? ''}`);
        this.name = 'NightgateJobError';
        this.job = job;
    }
}

/**
 * Marks a value as a 64-bit integer for a function URL.
 * It is written without quotes and keeps full precision above Number.MAX_SAFE_INTEGER.
 */
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

/**
 * Connect to a hosted NIGHTGATE.
 *
 * @param {object} opts
 * @param {string} opts.baseUrl            For example https://nightgate.example
 * @param {string} [opts.servicePath]      Defaults to '/api/v1/nightgate'.
 * @param {string} [opts.agentToken]       Agent token (ngat_...). Sent in the x-agent-token header.
 * @param {string} [opts.token]            Bearer token
 * @param {string} [opts.username]         Basic auth user. Can be combined with agentToken.
 * @param {string} [opts.password]
 * @param {number} [opts.timeoutMs]        Timeout per request in ms. Defaults to 120000.
 * @param {number} [opts.pollMs]           How often waitForJob polls, in ms. Defaults to 2000.
 * @param {Function} [opts.fetchFn]        Replaces fetch, for tests.
 */
export function connect(opts) {
    const {
        baseUrl, servicePath = '/api/v1/nightgate',
        agentToken, token, username, password,
        timeoutMs = 120_000, pollMs = 2_000, fetchFn
    } = opts ?? {};
    if (!baseUrl) throw new Error('connect: baseUrl is required');
    const doFetch = fetchFn || fetch;
    const service = String(baseUrl).replace(/\/$/, '') + servicePath;

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
            throw new NightgateApiError(response.status, err?.code, err?.message ?? `NIGHTGATE request failed with HTTP ${response.status}`);
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

    /**
     * A poll that failed for a temporary reason, not because the job failed.
     * The job keeps running on the server, so the poll is retried.
     */
    function isTransientPollError(err) {
        return isRetryable(err);
    }

    /**
     * Polls getJobStatus until the job ends and returns the parsed result.
     * Temporary poll errors in a row are retried for up to `pollGraceMs`, default 5 minutes.
     * A failed job throws at once.
     */
    async function waitForJob({ jobId, sessionId, pollMs: overridePollMs, timeoutMs: waitTimeoutMs = 60 * 60 * 1000, pollGraceMs = 5 * 60 * 1000 }) {
        if (!jobId) throw new Error('waitForJob: jobId is required');
        const interval = overridePollMs ?? pollMs;
        const deadline = Date.now() + waitTimeoutMs;
        let firstPollFailure = null;
        for (;;) {
            let job;
            try {
                job = await callAction('getJobStatus', { jobId, sessionId });
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
                let result = {};
                try { result = job.result ? JSON.parse(job.result) : {}; } catch { result = { raw: job.result }; }
                return { ...result, jobId, txHash: result.txHash ?? job.txHash };
            }
            if (job.status === 'failed' || job.status === 'reconciliation_required') {
                throw new NightgateJobError({ ...job, jobId });
            }
            if (Date.now() > deadline) throw new Error(`waitForJob: job ${jobId} still ${job.status} after ${waitTimeoutMs}ms`);
            await new Promise(r => setTimeout(r, interval));
        }
    }

    /** Starts a job and waits for its result. */
    async function act(name, params, sessionKey = 'sessionId') {
        const started = await callAction(name, params);
        if (!started?.jobId) return started;
        // Use the session id the server returns. With an agent token the server picks
        // the session, so the caller may not know it.
        return waitForJob({ jobId: started.jobId, sessionId: started.sessionId ?? params[sessionKey] });
    }

    return {
        // generic calls, for anything without its own function below
        callFunction,
        callAction,
        waitForJob,

        // ---- checks that read the chain directly. No wallet, no login. ----
        verifyAttestation: (p) => callFunction('verifyAttestationState', p),
        verifyPredicate: (p) => callFunction('verifyPredicateState', p),
        verifyPredicateAttestation: (p) => callFunction('verifyPredicateAttestation', p),
        verifyDocument: (p) => callFunction('verifyDocument', p),
        deriveTokenType: (p) => callFunction('deriveTokenType', p),
        getHealth: () => request('GET', `${String(baseUrl).replace(/\/$/, '')}/api/v1/indexer/getHealth()`),

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
        proveFieldPredicate: (p) => act('issueFieldPredicateAttestation', p),
        proveFieldEquality: (p) => act('issueFieldEqualityAttestation', p),
        proveFieldMembership: (p) => act('issueFieldMembershipAttestation', p),
        proveFieldPredicatesBatch: (p) => act('issueFieldPredicateAttestationBatch', p),
        proveDocumentIntegrity: (p) => act('issueDocumentIntegrityAttestation', p),
        proveDocumentDiff: (p) => act('issueDocumentDiffAttestation', p),

        // ---- disclosure ----
        grantDisclosure: (p) => act('grantDisclosure', p),
        revokeDisclosure: (p) => act('revokeDisclosure', p),
        registerPassport: (p) => act('registerPassport', p),
        registerDocument: (p) => act('registerPassport', p),
        retractAttestation: (p) => act('retractAttestation', p),
        purgeExpired: (p) => act('purgeExpired', p),

        // ---- contracts + tokens ----
        deployContract: (p) => act('deployContract', p),
        submitContractCall: (p) => act('submitContractCall', p),
        submitContractCallBatch: (p) => act('submitContractCallBatch', p),
        mintShieldedTestToken: (p) => act('mintShieldedTestToken', p),
        sendNight: (p) => act('sendNight', p),

        // ---- the server pays the fee for a transaction built elsewhere ----
        /**
         * Sends a transaction you built without a fee (txbuilder's finalizedTxB64).
         * The server adds the fee, submits it and returns the txHash.
         */
        sponsorFinalized: (p) => act('sponsorFinalizedTransaction', p, 'sponsorSessionId'),
        /** Like sponsorFinalized, for a transaction built with `bind: false`. The server can pay for several of these at once. */
        sponsorUnbound: (p) => act('sponsorUnboundTransaction', p, 'sponsorSessionId'),
        /** Takes both halves of a private token swap. The server joins them, pays the fee and submits. */
        sponsorSwap: (p) => act('sponsorSwap', p, 'sponsorSessionId'),
        buildSponsorable: (p) => act('buildSponsorable', p)
    };
}
