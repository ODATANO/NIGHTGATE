// HTTP client for a hosted NIGHTGATE: every capability of the online endpoint
// as a callable function. This is the same surface the MCP server exposes to
// agents, for code instead of tools: crawler-free verification, document
// ingestion, the ZK attestation actions, disclosure grants, custom tokens and
// cross-server fee sponsoring, plus job polling.
//
//   import { connect } from '@odatano/nightgate/client';
//
//   const ng = connect({ baseUrl: 'https://nightgate.example' });
//   const state = await ng.verifyAttestation({ contractAddress, payloadHash });
//
// Auth: pass `agentToken` (an `ngat_...` agent-grant token, travels in
// x-agent-token), or `token` (Bearer), or `username`/`password` (Basic). An
// agent token may be combined with Basic transport credentials.
//
// Write actions are async on the server: they return `{ jobId, status }`.
// `waitForJob` polls `getJobStatus` until the job settles and returns the
// parsed result, so the common path is one call + one wait.
//
// SPDX-License-Identifier: Apache-2.0

/** Error carrying the OData error body of a failed NIGHTGATE call. */
export class NightgateApiError extends Error {
    constructor(status, code, message) {
        super(message);
        this.name = 'NightgateApiError';
        this.status = status;
        this.code = code;
    }
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
 * Marker for an OData Int64 URL literal: rendered unquoted so precision is
 * preserved beyond Number.MAX_SAFE_INTEGER. Use for scaled circuit integers.
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

/**
 * Connect to a hosted NIGHTGATE.
 *
 * @param {object} opts
 * @param {string} opts.baseUrl            e.g. https://nightgate.example (no trailing slash needed)
 * @param {string} [opts.servicePath]      default '/api/v1/nightgate'
 * @param {string} [opts.agentToken]       agent-grant token (ngat_...), sent as x-agent-token
 * @param {string} [opts.token]            Bearer token
 * @param {string} [opts.username]         Basic auth user (also alongside agentToken)
 * @param {string} [opts.password]
 * @param {number} [opts.timeoutMs]        per-request timeout, default 120000
 * @param {number} [opts.pollMs]           waitForJob poll interval, default 5000
 * @param {Function} [opts.fetchFn]        override fetch (tests)
 */
export function connect(opts) {
    const {
        baseUrl, servicePath = '/api/v1/nightgate',
        agentToken, token, username, password,
        timeoutMs = 120_000, pollMs = 5_000, fetchFn
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

        const response = await doFetch(url, {
            method, headers,
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(timeoutMs)
        });
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

    /** Poll getJobStatus until the job settles; returns the PARSED result. */
    async function waitForJob({ jobId, sessionId, pollMs: overridePollMs, timeoutMs: waitTimeoutMs = 60 * 60 * 1000 }) {
        if (!jobId) throw new Error('waitForJob: jobId is required');
        const interval = overridePollMs ?? pollMs;
        const deadline = Date.now() + waitTimeoutMs;
        for (;;) {
            const job = await callAction('getJobStatus', { jobId, sessionId });
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

    /** callAction + waitForJob in one step, for the submit-and-wait pattern. */
    async function act(name, params, sessionKey = 'sessionId') {
        const started = await callAction(name, params);
        if (!started?.jobId) return started;
        // Prefer the session the SERVER says the job is keyed by: under an
        // agent grant the sponsor session is injected server-side and the
        // caller may not have passed one at all.
        return waitForJob({ jobId: started.jobId, sessionId: started.sessionId ?? params[sessionKey] });
    }

    return {
        // escape hatches: anything not wrapped below
        callFunction,
        callAction,
        waitForJob,

        // ---- crawler-free verification (GET, no wallet, no auth needed) ----
        verifyAttestation: (p) => callFunction('verifyAttestationState', p),
        verifyPredicate: (p) => callFunction('verifyPredicateState', p),
        verifyPredicateAttestation: (p) => callFunction('verifyPredicateAttestation', p),
        verifyDocument: (p) => callFunction('verifyDocument', p),
        deriveTokenType: (p) => callFunction('deriveTokenType', p),
        getHealth: () => request('GET', `${String(baseUrl).replace(/\/$/, '')}/api/v1/indexer/getHealth()`),

        // ---- compute-only preparation (POST, no wallet) ----
        prepareDocumentProof: (p) => callAction('prepareDocumentProof', p),
        prepareMembershipSet: (p) => callAction('prepareMembershipSet', p),
        prepareAnchorCommitment: (p) => callAction('prepareAnchorCommitment', p),

        // ---- wallet sessions ----
        connectWallet: (p) => callAction('connectWallet', p),
        connectWalletForSigning: (p) => callAction('connectWalletForSigning', p),
        disconnectWallet: (p) => callAction('disconnectWallet', p),
        deriveWalletInfo: (p) => callAction('deriveWalletInfo', p),
        getWalletBalance: (p) => callFunction('getWalletBalance', p),
        getWalletSyncProgress: (p) => callFunction('getWalletSyncProgress', p),

        // ---- anchoring + ZK attestations (async job -> waits for the result) ----
        anchorDocument: (p) => act('anchorDocument', p),
        commitDocumentAnchor: (p) => act('commitDocumentAnchor', p),
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

        // ---- contracts + tokens ----
        deployContract: (p) => act('deployContract', p),
        submitContractCall: (p) => act('submitContractCall', p),
        submitContractCallBatch: (p) => act('submitContractCallBatch', p),
        mintShieldedTestToken: (p) => act('mintShieldedTestToken', p),
        sendNight: (p) => act('sendNight', p),

        // ---- cross-server fee sponsoring (0.17.0) ----
        /**
         * Hand a locally built, fee-unpaid transaction (txbuilder's
         * finalizedTxB64) to the sponsor, wait for the submit, return the
         * txHash. The job is keyed by the SPONSOR session.
         */
        sponsorFinalized: (p) => act('sponsorFinalizedTransaction', p, 'sponsorSessionId'),
        buildSponsorable: (p) => act('buildSponsorable', p)
    };
}
