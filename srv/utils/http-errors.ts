// Error handler of the NIGHTGATE services. It gives every error response a text code.
// CAP calls it synchronously for every error, also for each part of a `$batch` request.
// SPDX-License-Identifier: Apache-2.0
import { statusClassCode } from './errors';
import { configMs } from './config';
import { isProduction } from './production';

type HttpErrorLike = {
    code?: unknown;
    status?: unknown;
    statusCode?: unknown;
    message?: string;
    details?: unknown;
    $sanitize?: boolean;
};

const numericCode = (code: unknown): boolean =>
    typeof code === 'number' || (typeof code === 'string' && /^\d{3}$/.test(code));


/** The only fields a server error keeps in production. */
const SANITIZED_KEYS = new Set(['code', 'message', 'status', 'statusCode', '$sanitize']);

const GENERIC_5XX: Record<number, string> ={ 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout' };

/** PostgreSQL's code for a statement it stopped, here by the time limit of a read. */
const STATEMENT_STOPPED = '57014';

/** The answer for a read the database stopped. The database's own error names the statement, so only these fields stay. */
function asQueryTimeout(err: HttpErrorLike): void {
    for (const key of Object.keys(err)) delete (err as Record<string, unknown>)[key];
    const ms = configMs('NIGHTGATE_QUERY_TIMEOUT_MS');
    const limit = ms >= 1000 ? `${ms / 1000} s` : `${ms} ms`;
    Object.assign(err, { status: 504, code: 'QUERY_TIMEOUT', message: `The read ran longer than ${limit} and was stopped. Narrow the filter or sort by an indexed column.`, $sanitize: false });
}

/** The status of a combined error, as CAP infers it: one shared sub-error status, 500 if any is a server error, else 400. */
function statusFromDetails(details: unknown[]): number {
    const nested = [...new Set(details
        .map(d => (d && typeof d === 'object' ? Number((d as HttpErrorLike).status ?? (d as HttpErrorLike).statusCode) : NaN))
        .filter(Number.isFinite))];
    if (nested.length === 1) return nested[0];
    return nested.some(s => s >= 500) ? 500 : 400;
}

function normalizeOne(err: HttpErrorLike): void {
    if (err.code === STATEMENT_STOPPED) return asQueryTimeout(err);
    // `req.reject(400, text)` sets code 400 but no status.
    // Copy the status from the code before the code is replaced.
    if (err.status === undefined && err.statusCode === undefined && numericCode(err.code)) err.status = Number(err.code);
    if (err.status === undefined && err.statusCode === undefined && Array.isArray(err.details) && err.details.length) err.status = statusFromDetails(err.details);
    const status = Number(err.status ?? err.statusCode ?? 500);
    if (err.code === undefined || err.code === null || err.code === '' || numericCode(err.code)) err.code = statusClassCode(status);
    // In production CAP would replace the whole body of a server error, including the code.
    // So we hide the details here ourselves and keep the code.
    // An error with `$sanitize: false` keeps its full body.
    if (status >= 500 && err.$sanitize !== false && isProduction()) {
        for (const key of Object.keys(err)) if (!SANITIZED_KEYS.has(key)) delete (err as Record<string, unknown>)[key];
        err.message = GENERIC_5XX[status] ?? 'Internal Server Error';
        err.$sanitize = false;
    }
}

/** Express error middleware. Node's message for a body that is not JSON quotes part of the input, which may be a secret, so it is replaced. */
export function redactInvalidJson(err: unknown, _req: unknown, _res: unknown, next: (err?: unknown) => void): void {
    const e = err as { name?: unknown; message?: unknown; stack?: unknown } | null;
    if (e && typeof e === 'object' && e.name === 'Invalid JSON body') {
        e.message = 'The request body is not valid JSON';
        e.stack = `${e.name}: ${e.message}`;
    }
    next(err);
}

export function normalizeHttpError(err: unknown): void {
    if (!err || typeof err !== 'object') return;
    // Sub-errors first, so a combined error takes its status from theirs.
    const details = (err as HttpErrorLike).details;
    if (Array.isArray(details)) for (const d of details) if (d && typeof d === 'object') normalizeOne(d as HttpErrorLike);
    normalizeOne(err as HttpErrorLike);
}
