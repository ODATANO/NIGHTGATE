// The NIGHTGATE error type and the one table of codes. The table feeds the docs and the retry list of the client.
// This module does not import `@sap/cds`, because the wallet worker loads it too.
// SPDX-License-Identifier: Apache-2.0

export interface ErrorCodeSpec {
    /** The HTTP status of a request refused with the code. A code without one only ends a job. */
    status?: number;
    /** Every status the code comes with, where the status says why. Without it the code has the one `status`. */
    statuses?: readonly number[];
    /** A new attempt of the same call can succeed, and nothing happened that it would double. */
    retryable?: boolean;
    /** A job can end with the code, as `getJobStatus.errorCode`. */
    job?: true;
    doc: string;
}

export const ERROR_CODES = {
    // Generic codes, used when a reject names only an HTTP status.
    INVALID_ARGUMENT: { status: 400, doc: 'A parameter is missing, malformed or out of range.' },
    UNAUTHENTICATED: { status: 401, doc: 'No or unknown principal, or a session the caller does not own.' },
    FORBIDDEN: { status: 403, doc: 'The principal may not perform this operation.' },
    NOT_FOUND: { status: 404, doc: 'The addressed record does not exist or is not visible to the caller.' },
    CONFLICT: { status: 409, doc: 'The request conflicts with the current state.' },
    GONE: { status: 410, doc: 'The addressed record expired or was closed.' },
    PRECONDITION_FAILED: { status: 412, doc: 'A required earlier step is missing (e.g. no signing key on the session).' },
    PAYLOAD_TOO_LARGE: { status: 413, doc: 'The request body exceeds a limit.' },
    RATE_LIMITED: { status: 429, retryable: true, doc: 'A rate class or a grant budget is used up; the message names it, `Retry-After` says when to retry.' },
    INTERNAL: { status: 500, doc: 'Unexpected server failure; the message is withheld in production.' },
    NOT_IMPLEMENTED: { status: 501, doc: 'The operation is not available in this configuration.' },
    BAD_GATEWAY: { status: 502, retryable: true, doc: 'An upstream (node, indexer, proof server) answered wrongly.' },
    UNAVAILABLE: { status: 503, retryable: true, doc: 'Temporarily unavailable; retry later.' },

    // Specific codes a client can act on.
    ACCOUNT_KEY_UNAVAILABLE: { status: 503, retryable: true, doc: 'The per-account data key could not be read.' },
    ACCOUNT_MOVE_BLOCKED: { status: 409, doc: 'An open session holds this wallet under another spelling of its viewing key. Close that session, then connect again.' },
    AGENT_GRANT_REVOKED: { status: 403, job: true, doc: 'The agent grant a queued job ran under was revoked; nothing was sponsored.' },
    ARG_COERCION_FAILED: { status: 400, doc: 'A circuit argument does not match the circuit\'s declared type.' },
    BATCH_CAUSALITY_VIOLATION: { status: 409, job: true, doc: 'A batch orders a fallible call before a guaranteed one; split or reorder it.' },
    CONTRACT_NOT_REGISTERED: { status: 404, doc: 'No compiled artifact is registered under this name.' },
    CONTRACT_REGISTRATION_REJECTED: { status: 400, doc: 'A runtime contract registration was refused.' },
    ENCRYPTION_KEY_UNKNOWN: { status: 500, doc: 'A stored ciphertext names a key id outside the configured ring.' },
    FEE_SPONSOR_UNUSABLE: {
        status: 404, statuses: [403, 404, 410, 412], job: true,
        doc: 'The session named by `sponsorSessionId` cannot pay. The status says why: 403 the caller is not signed in, 404 no such session of this caller, 410 expired, 412 it has no signing key.'
    },
    GRANT_REVOKED: { status: 409, doc: 'The agent grant is revoked; it cannot be changed any more.' },
    IDEMPOTENCY_KEY_CONFLICT: { status: 409, doc: 'The idempotency key was used with a different payload.' },
    IDEMPOTENCY_KEY_INVALID: { status: 400, doc: 'The idempotency key is longer than 128 characters.' },
    INSTANCE_LEASE_HELD: { status: 503, doc: 'Another process runs the background work on this database.' },
    JOB_ADMISSION_BUSY: { status: 503, retryable: true, doc: 'The job admission lock is contended; retry after `Retry-After`.' },
    PRIVATE_STATE_EXPORT_INVALID: { status: 400, doc: 'The private-state export is not in the expected format.' },
    PRIVATE_STATE_EXPORT_UNREADABLE: { status: 400, doc: 'The private-state export does not decrypt with this password.' },
    PRIVATE_STATE_IMPORT_CONFLICT: { status: 409, doc: 'The private-state import would overwrite existing state.' },
    PROVER_KEYS_UNAVAILABLE: { status: 503, retryable: true, doc: 'The contract\'s prover keys are not available on this server.' },
    RUNTIME_TOPOLOGY_UNSUPPORTED: { status: 503, doc: 'The deployment topology (replicas, multitenancy, database) is not supported.' },
    PUBLIC_VERIFY_DISABLED: { status: 404, doc: 'Unauthenticated verification is not enabled on this server.' },
    QUERY_TIMEOUT: { status: 504, doc: 'A read ran longer than its time limit and was stopped; narrow the filter or sort by an indexed column.' },
    PURE_CIRCUITS_UNAVAILABLE: { status: 404, doc: 'The artifact does not export the pure circuits this operation needs.' },
    TOKEN_FACTORY_UNAVAILABLE: { status: 404, doc: 'No token-factory lineage is registered, or the artifact is not one.' },
    RUNTIME_UNAVAILABLE: { status: 503, retryable: true, doc: 'The runtime did not start (schema, network or worker); see getRuntimeInfo.' },
    SCHEMA_NOT_DEPLOYED: { status: 503, doc: 'The database schema is missing tables or columns; run the schema delta.' },
    SESSION_NOT_FOUND: { status: 404, job: true, doc: 'The wallet session does not exist, is inactive or belongs to another user.' },
    SIGNING_KEY_EXPORT_REJECTED: { status: 400, doc: 'The signing-key export was refused.' },
    SPONSOR_DUST_UNAVAILABLE: { status: 503, job: true, doc: 'The sponsor has no free dust note that covers the fee: too little dust, or every note is in use. A later attempt may succeed.' },
    SPONSOR_POLICY_EMPTY: { status: 403, job: true, doc: 'The effective sponsor policy allows nothing for this caller.' },
    SPONSOR_POLICY_UNAVAILABLE: { status: 503, retryable: true, job: true, doc: 'The sponsor policy file cannot be read; fail-closed.' },
    SPONSOR_REFUSED: { status: 403, job: true, doc: 'The sponsor refused the transaction under its policy.' },
    SWAP_OFFER_INVALID: { status: 400, doc: 'The posted text is not a swap half the offer board can carry.' },
    SUBMIT_INTENT_REJECTED: { status: 409, job: true, doc: 'The server refused to record the broadcast; nothing was sent.' },
    SUBMIT_INTENT_TIMEOUT: { status: 503, retryable: true, job: true, doc: 'The announced transaction was not recorded in time; nothing was sent. The server does not repeat the job itself.' },
    SUBMIT_PHASE_FAILED: { status: 502, doc: 'A submission phase (send, watch) failed; `info.phase` names it.' },
    SUBMIT_WATCH_TIMEOUT: { status: 504, doc: 'The submission was sent but its inclusion was not seen in time; the outcome is unknown.' },
    SYNC_STATE_CHAIN_MISMATCH: { status: 503, doc: 'The node serves another chain than the one the database was indexed from. Indexing stops.' },
    SYNC_STATE_NETWORK_MISMATCH: { status: 503, doc: 'The database is bound to another network than the configured one.' },
    TOKEN_TYPE_INVALID: { status: 400, doc: 'The token type or contract address is malformed.' },
    TX_FAILED: { status: 409, job: true, doc: 'The transaction landed and failed on chain.' },
    WALLET_MATERIAL_UNAVAILABLE: { status: 501, doc: 'This session has no wallet material for signing.' },
    WALLET_NOT_SYNCED: { status: 503, retryable: true, doc: 'The wallet did not reach the chain tip in time; nothing was sent.' },
    WALLET_SIGNING_NOT_AVAILABLE: { status: 409, job: true, doc: 'The session was connected without a signing key.' },
    WALLET_SYNCING: { status: 503, retryable: true, doc: 'The wallet is still catching up; retry after `Retry-After`.' },
    WORKER_ROTATING: { status: 503, retryable: true, job: true, doc: 'The wallet worker is rotating; retry.' },

    // Codes only a job ends with. A reject of the node keeps the node's own number instead, such as `1010/104`.
    AGENT_GRANT_SCOPE: { job: true, doc: 'The agent grant no longer covers what the queued job would do; nothing was executed.' },
    BATCH_GAS_BUDGET_EXCEEDED: { job: true, doc: 'A call of the batch runs out of gas before proving; split the batch.' },
    BROADCAST_NOT_INCLUDED: { job: true, doc: 'The transaction was sent and is in no block; the chain is past its expiry.' },
    BROADCAST_UNCONFIRMED: { job: true, doc: 'The transaction was sent, the node gave no status and the indexer does not show it yet.' },
    CHAIN_EXECUTION_FAILED: { job: true, doc: 'The transaction is on chain and its contract call did not apply.' },
    CHAIN_EXECUTION_FAILED_UNCONFIRMED: { job: true, doc: 'The call failed on chain, and the block of the transaction is not recorded yet.' },
    CHILD_FAILED: { job: true, doc: 'A workflow step failed; the message names the steps already on chain.' },
    CHILD_RECONCILIATION_REQUIRED: { job: true, doc: 'A workflow step is on chain and a later step did not complete.' },
    CONTRACT_CONFIG_INVALID: { job: true, doc: 'The SDK refused the contract call as configured (argument types or private state); the message names its error.' },
    DISCLOSURE_REINDEX_FAILED: { job: true, doc: 'The disclosure grants of a contract could not be read back after a landed change.' },
    EXTERNAL_EXECUTION_FAILED: { job: true, doc: 'The job failed after its transaction was sent; check the chain before a new attempt.' },
    LEASE_EXPIRED: { job: true, doc: 'The process that ran the job stopped reporting.' },
    MALFORMED_RESULT: { job: true, doc: 'The SDK returned a submission result without the expected fields.' },
    NETWORK_OR_TIMEOUT: { job: true, retryable: true, doc: 'The send failed before the node answered; nothing is on chain.' },
    POOL_INVALID: { job: true, retryable: true, doc: 'The pool reported the transaction invalid without a ledger code; a competing transaction may have spent a coin first.' },
    PROCESS_RESTART_BEFORE_BROADCAST: { job: true, doc: 'The server restarted after the transaction was announced and before it was sent.' },
    PROCESS_RESTART_BEFORE_EXECUTION: { job: true, doc: 'The server restarted before the job did anything outside the database.' },
    PROCESS_RESTART_RECONCILE: { job: true, doc: 'The server restarted after the transaction was sent.' },
    PROCESS_RESTART_SESSION_CLOSED: { job: true, doc: 'The server restarted and closed the wallet session the queued job belongs to.' },
    PROCESS_RESTART_SESSION_JOB_DROPPED: { job: true, doc: 'The server restarted while a job of the wallet session itself was running.' },
    REJECTED: { job: true, doc: 'The attempt was refused before any block took it; nothing is on chain.' },
    REJECTED_ATTEMPT_BOOKKEEPING_PENDING: { job: true, doc: 'A refused sponsored attempt is not booked back yet; the reconciler does it.' },
    RESULT_PERSIST_FAILED: { job: true, doc: 'The transaction was sent, but the result of the job could not be stored.' },
    SPONSOR_ATTEMPT_REJECTED: { job: true, doc: 'A sponsored attempt was refused before any block took it; its budget is booked back.' },
    SUBMIT_AMBIGUOUS: { job: true, doc: 'The transaction may have reached the node; it is never built again.' },
    SUPERSEDED: { job: true, doc: 'Another run took the job over while this one was still working.' },
    UNKNOWN_ERROR: { job: true, doc: 'Any other failure; the message starts with the name of the error.' },
    WORKER_ROTATED: { job: true, doc: 'The wallet worker was restarted while the job was running in it.' },
} as const satisfies Record<string, ErrorCodeSpec>;

type Specs = typeof ERROR_CODES;
/** A code a request is refused with. */
export type ErrorCode = { [K in keyof Specs]: Specs[K] extends { status: number } ? K : never }[keyof Specs];
/** A code a job ends with. */
export type JobErrorCode = { [K in keyof Specs]: Specs[K] extends { job: true } ? K : never }[keyof Specs];
/** A reject of the node, by the node's own number: `1010`, `1010/<ledger error>`, `1014` or `1016`. */
export type NodeRejectCode = '1010' | '1014' | '1016' | `1010/${number}`;

/** Any code of the table. A job keeps such a code, also one without the `job` mark. */
export function isTableErrorCode(code: unknown): code is keyof Specs {
    return typeof code === 'string' && Object.prototype.hasOwnProperty.call(ERROR_CODES, code);
}

export function isJobErrorCode(code: unknown): code is JobErrorCode {
    return typeof code === 'string' && (ERROR_CODES as Record<string, ErrorCodeSpec>)[code]?.job === true;
}

export function isNodeRejectCode(code: unknown): code is NodeRejectCode {
    return typeof code === 'string' && /^10(10(\/\d+)?|14|16)$/.test(code);
}

/** The codes of a refused request a caller may retry unchanged, sorted. The client carries this list. */
export function retryableErrorCodes(): string[] {
    return Object.entries(ERROR_CODES as Record<string, ErrorCodeSpec>)
        .filter(([, spec]) => spec.retryable && spec.status !== undefined).map(([code]) => code).sort();
}

/** The generic code for each HTTP status. */
export const STATUS_CLASS_CODES: Readonly<Record<number, ErrorCode>> = {
    400: 'INVALID_ARGUMENT', 401: 'UNAUTHENTICATED', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 409: 'CONFLICT',
    410: 'GONE', 412: 'PRECONDITION_FAILED', 413: 'PAYLOAD_TOO_LARGE', 429: 'RATE_LIMITED', 500: 'INTERNAL',
    501: 'NOT_IMPLEMENTED', 502: 'BAD_GATEWAY', 503: 'UNAVAILABLE'
};

export function statusClassCode(status: number): ErrorCode {
    return STATUS_CLASS_CODES[status] ?? (status >= 500 ? 'INTERNAL' : 'INVALID_ARGUMENT');
}

export interface NightgateErrorOptions {
    /** Overrides the default status of the code. */
    status?: number;
    retryable?: boolean;
    /** Extra details. Must be JSON-safe and contain no secrets, because it is sent between threads. */
    info?: Record<string, unknown>;
    cause?: unknown;
    /** Keep the message of a server error in production, where CAP would hide it. */
    exposeMessage?: boolean;
}

export interface NightgateErrorPayload {
    name: string;
    code: string;
    status: number;
    retryable: boolean;
    message: string;
    info?: Record<string, unknown>;
    /** The message of a server error is shown in production too. */
    exposeMessage?: boolean;
}

export class NightgateError extends Error {
    /** Used instead of `instanceof`, which fails when the module is loaded twice. */
    readonly isNightgateError = true as const;
    readonly code: ErrorCode;
    status: number;
    retryable: boolean;
    info?: Record<string, unknown>;

    constructor(code: ErrorCode, message: string, opts: NightgateErrorOptions = {}) {
        super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
        this.name = new.target.name;
        this.code = code;
        const spec: ErrorCodeSpec = ERROR_CODES[code];
        this.status = opts.status ?? spec.status ?? 500;
        this.retryable = opts.retryable ?? spec.retryable ?? false;
        if (opts.info) this.info = opts.info;
        if (opts.exposeMessage) (this as { $sanitize?: boolean }).$sanitize = false;
    }

    toPayload(): NightgateErrorPayload {
        return {
            name: this.name, code: this.code, status: this.status, retryable: this.retryable, message: this.message,
            ...(this.info ? { info: this.info } : {}),
            ...((this as { $sanitize?: boolean }).$sanitize === false ? { exposeMessage: true } : {})
        };
    }
}

/** The one answer for a wallet session that does not exist, is inactive or belongs to another user. */
export class SessionNotFoundError extends NightgateError {
    constructor(sessionId: string) {
        super('SESSION_NOT_FOUND', `Session '${sessionId}' not found, expired, or inactive`);
    }
}

import { errorMessage } from '../../src/shared/error-message.mjs';
export { errorMessage };

export function isNightgateError(err: unknown): err is NightgateError {
    return !!err && typeof err === 'object' && (err as { isNightgateError?: unknown }).isNightgateError === true
        && typeof (err as { code?: unknown }).code === 'string';
}

/** The first NightgateError in the chain of causes, if any. */
export function findNightgateError(err: unknown, depth = 8): NightgateError | undefined {
    let cur: unknown = err;
    const seen = new Set<unknown>();
    for (let i = 0; i <= depth && cur != null && !seen.has(cur); i++) {
        if (isNightgateError(cur)) return cur;
        seen.add(cur);
        cur = (cur as { cause?: unknown }).cause;
    }
    return undefined;
}

/** The error's text with every URL replaced. An upstream URL can carry a key. */
export function messageWithoutUrls(err: unknown, placeholder = '<url>'): string {
    return errorMessage(err).replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, placeholder);
}

/** Rebuilds an error that crossed a thread, with its own name and message. `outer` is the error it was found in,
 *  with the texts of its causes: it becomes the cause, so a log and a classification still see them. */
export function nightgateErrorFromPayload(p: NightgateErrorPayload, outer?: { name?: string; message: string }): NightgateError {
    const code = (p.code in ERROR_CODES ? p.code : statusClassCode(p.status)) as ErrorCode;
    const cause = outer && outer.message !== p.message ? Object.assign(new Error(outer.message), outer.name ? { name: outer.name } : {}) : undefined;
    const err = new NightgateError(code, p.message, { status: p.status, retryable: p.retryable, info: p.info, exposeMessage: p.exposeMessage, cause });
    err.name = p.name;
    return err;
}

/** Markdown rows of the error-code table in docs/reference.md. */
export function errorCodeMarkdownRows(): string[] {
    return Object.entries(ERROR_CODES as Record<string, ErrorCodeSpec>).map(([code, spec]) =>
        `| \`${code}\` | ${spec.statuses?.join(', ') ?? spec.status ?? ''} | ${spec.job ? 'yes' : ''} | ${spec.retryable ? 'yes' : 'no'} | ${spec.doc} |`);
}
