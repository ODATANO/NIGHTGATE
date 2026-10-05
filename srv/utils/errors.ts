/**
 * The error type used across NIGHTGATE. Every error has a fixed code, an HTTP status and a retryable flag.
 * ERROR_CODES lists all codes. The error table in the docs is generated from it.
 * This module does not import `@sap/cds`, because the wallet worker loads it too.
 * SPDX-License-Identifier: Apache-2.0
 */

export interface ErrorCodeSpec {
    status: number;
    retryable?: boolean;
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
    RATE_LIMITED: { status: 429, retryable: true, doc: 'A rate limit or daily budget is exhausted; see `Retry-After` where set.' },
    INTERNAL: { status: 500, doc: 'Unexpected server failure; the message is withheld in production.' },
    NOT_IMPLEMENTED: { status: 501, doc: 'The operation is not available in this configuration.' },
    BAD_GATEWAY: { status: 502, retryable: true, doc: 'An upstream (node, indexer, proof server) answered wrongly.' },
    UNAVAILABLE: { status: 503, retryable: true, doc: 'Temporarily unavailable; retry later.' },

    // Specific codes a client can act on.
    ACCOUNT_KEY_UNAVAILABLE: { status: 503, retryable: true, doc: 'The per-account data key could not be read.' },
    AGENT_GRANT_REVOKED: { status: 403, doc: 'The agent grant a queued job ran under was revoked; nothing was sponsored.' },
    ARG_COERCION_FAILED: { status: 400, doc: 'A circuit argument does not match the circuit\'s declared type.' },
    BATCH_CAUSALITY_VIOLATION: { status: 409, doc: 'A batch orders a fallible call before a guaranteed one; split or reorder it.' },
    CONTRACT_NOT_REGISTERED: { status: 404, doc: 'No compiled artifact is registered under this name.' },
    CONTRACT_REGISTRATION_REJECTED: { status: 400, doc: 'A runtime contract registration was refused.' },
    ENCRYPTION_KEY_UNKNOWN: { status: 500, doc: 'A stored ciphertext names a key id outside the configured ring.' },
    FEE_SPONSOR_UNUSABLE: { status: 400, doc: 'The fee-sponsor session cannot pay for this caller or is not ready.' },
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
    PURE_CIRCUITS_UNAVAILABLE: { status: 404, doc: 'The artifact does not export the pure circuits this operation needs.' },
    TOKEN_FACTORY_UNAVAILABLE: { status: 404, doc: 'No token-factory lineage is registered, or the artifact is not one.' },
    RUNTIME_UNAVAILABLE: { status: 503, retryable: true, doc: 'The runtime did not start (schema, network or worker); see getRuntimeInfo.' },
    SCHEMA_NOT_DEPLOYED: { status: 503, doc: 'The database schema is missing tables or columns; run the schema delta.' },
    SESSION_NOT_FOUND: { status: 401, doc: 'The wallet session does not exist, is inactive or belongs to another user.' },
    SIGNING_KEY_EXPORT_REJECTED: { status: 400, doc: 'The signing-key export was refused.' },
    SPONSOR_POLICY_EMPTY: { status: 403, doc: 'The effective sponsor policy allows nothing for this caller.' },
    SPONSOR_POLICY_UNAVAILABLE: { status: 503, retryable: true, doc: 'The sponsor policy file cannot be read; fail-closed.' },
    SPONSOR_REFUSED: { status: 403, doc: 'The sponsor refused the transaction under its policy.' },
    SWAP_OFFER_INVALID: { status: 400, doc: 'The posted text is not a swap half the offer board can carry.' },
    SWAP_OFFER_NOT_OPEN: { status: 409, doc: 'The swap offer is filled, retired or expired.' },
    SPONSORED_CALL_NOT_APPLIED: { status: 409, doc: 'The sponsored call landed but did not apply (the caller\'s transcript is stale).' },
    SUBMIT_INTENT_REJECTED: { status: 409, doc: 'The server refused to record the broadcast; nothing was sent.' },
    SUBMIT_INTENT_TIMEOUT: { status: 503, retryable: true, doc: 'The broadcast was not acknowledged in time; nothing was sent.' },
    SUBMIT_PHASE_FAILED: { status: 502, doc: 'A submission phase (send, watch) failed; `info.phase` names it.' },
    SUBMIT_WATCH_TIMEOUT: { status: 504, doc: 'The submission was sent but its inclusion was not seen in time; the outcome is unknown.' },
    SYNC_STATE_NETWORK_MISMATCH: { status: 503, doc: 'The database is bound to another network than the configured one.' },
    TOKEN_TYPE_INVALID: { status: 400, doc: 'The token type or contract address is malformed.' },
    TX_FAILED: { status: 409, doc: 'The transaction landed and failed on chain.' },
    WALLET_MATERIAL_UNAVAILABLE: { status: 501, doc: 'This session has no wallet material for signing.' },
    WALLET_NOT_SYNCED: { status: 503, retryable: true, doc: 'The wallet did not reach the chain tip in time; nothing was sent.' },
    WALLET_SIGNING_NOT_AVAILABLE: { status: 409, doc: 'The session was connected without a signing key.' },
    WALLET_SYNCING: { status: 503, retryable: true, doc: 'The wallet is still catching up; retry after `Retry-After`.' },
    WORKER_ROTATING: { status: 503, retryable: true, doc: 'The wallet worker is rotating; retry.' },
} as const satisfies Record<string, ErrorCodeSpec>;

export type ErrorCode = keyof typeof ERROR_CODES;

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
        this.status = opts.status ?? spec.status;
        this.retryable = opts.retryable ?? spec.retryable ?? false;
        if (opts.info) this.info = opts.info;
        if (opts.exposeMessage) (this as { $sanitize?: boolean }).$sanitize = false;
    }

    toPayload(): NightgateErrorPayload {
        return {
            name: this.name, code: this.code, status: this.status, retryable: this.retryable, message: this.message,
            ...(this.info ? { info: this.info } : {})
        };
    }
}

/** The message of a thrown value, or the value itself as text. */
export function errorMessage(err: unknown): string {
    return String((err as Error)?.message ?? err);
}

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

/** Rebuilds an error that was sent from another thread. Keeps the original `name`. */
export function nightgateErrorFromPayload(p: NightgateErrorPayload): NightgateError {
    const code = (p.code in ERROR_CODES ? p.code : statusClassCode(p.status)) as ErrorCode;
    const err = new NightgateError(code, p.message, { status: p.status, retryable: p.retryable, info: p.info });
    err.name = p.name;
    return err;
}

/** Markdown rows of the error-code table in docs/reference.md. */
export function errorCodeMarkdownRows(): string[] {
    return Object.entries(ERROR_CODES).map(([code, spec]) =>
        `| \`${code}\` | ${spec.status} | ${'retryable' in spec && spec.retryable ? 'yes' : 'no'} | ${spec.doc} |`);
}
