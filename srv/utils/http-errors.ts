/**
 * `srv.on('error')` handler of the NIGHTGATE services: every error response carries a
 * string code. CAP runs it synchronously inside the transaction rollback, with the
 * error and `cds.context` (not always the request), for rejects, throws and each
 * `$batch` part.
 * SPDX-License-Identifier: Apache-2.0
 */
import { statusClassCode } from './errors';

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

const isProduction = (): boolean => process.env.NODE_ENV === 'production' || process.env.CDS_ENV === 'prod';

/** What a sanitized 5xx keeps; everything else CAP would pass into the body. */
const SANITIZED_KEYS = new Set(['code', 'message', 'status', 'statusCode', '$sanitize']);

const GENERIC_5XX: Record<number, string> ={ 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout' };

function normalizeOne(err: HttpErrorLike): void {
    // `req.reject(400, text)` yields code 400 and no status; CAP derives the status from
    // the numeric code later, so the status must be taken before the code is replaced.
    if (err.status === undefined && err.statusCode === undefined && numericCode(err.code)) err.status = Number(err.code);
    const status = Number(err.status ?? err.statusCode ?? 500);
    if (err.code === undefined || err.code === null || err.code === '' || numericCode(err.code)) err.code = statusClassCode(status);
    // CAP replaces a 5xx body including its code in production; sanitize here instead,
    // so the code survives. With CAP's guard off, only the allowed keys may remain
    // (`reason` would surface as `innererror`). An error that opted in keeps its body.
    if (status >= 500 && err.$sanitize !== false && isProduction()) {
        for (const key of Object.keys(err)) if (!SANITIZED_KEYS.has(key)) delete (err as Record<string, unknown>)[key];
        err.message = GENERIC_5XX[status] ?? 'Internal Server Error';
        err.$sanitize = false;
    }
}

export function normalizeHttpError(err: unknown): void {
    if (!err || typeof err !== 'object') return;
    normalizeOne(err as HttpErrorLike);
    const details = (err as HttpErrorLike).details;
    if (Array.isArray(details)) for (const d of details) if (d && typeof d === 'object') normalizeOne(d as HttpErrorLike);
}
