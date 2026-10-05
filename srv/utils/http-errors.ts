/**
 * Error handler of the NIGHTGATE services. It makes sure every error response has a text code.
 * CAP calls it synchronously for every error, also for each part of a `$batch` request.
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

/** The only fields a server error keeps in production. */
const SANITIZED_KEYS = new Set(['code', 'message', 'status', 'statusCode', '$sanitize']);

const GENERIC_5XX: Record<number, string> ={ 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout' };

function normalizeOne(err: HttpErrorLike): void {
    // `req.reject(400, text)` sets code 400 but no status.
    // Copy the status from the code before the code is replaced.
    if (err.status === undefined && err.statusCode === undefined && numericCode(err.code)) err.status = Number(err.code);
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

export function normalizeHttpError(err: unknown): void {
    if (!err || typeof err !== 'object') return;
    normalizeOne(err as HttpErrorLike);
    const details = (err as HttpErrorLike).details;
    if (Array.isArray(details)) for (const d of details) if (d && typeof d === 'object') normalizeOne(d as HttpErrorLike);
}
