/**
 * The error model: registry, NightgateError, payload round trip and the HTTP normaliser.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
    ERROR_CODES, errorCodeMarkdownRows, NightgateError, isNightgateError, isJobErrorCode, isNodeRejectCode, findNightgateError, nightgateErrorFromPayload,
    retryableErrorCodes, statusClassCode, type ErrorCodeSpec
} from '../../srv/utils/errors';
import { normalizeHttpError } from '../../srv/utils/http-errors';

describe('ERROR_CODES', () => {
    it('are UPPER_SNAKE_CASE with a doc line, and each is a request code, a job code or both', () => {
        for (const [code, spec] of Object.entries(ERROR_CODES as Record<string, ErrorCodeSpec>)) {
            expect(code).toMatch(/^[A-Z][A-Z0-9_]+$/);
            expect(spec.status !== undefined || spec.job === true, code).toBe(true);
            if (spec.status !== undefined) {
                expect(spec.status).toBeGreaterThanOrEqual(400);
                expect(spec.status).toBeLessThan(600);
            }
            expect(spec.doc.length).toBeGreaterThan(10);
        }
    });

    it('a code that comes with several statuses lists its default among them, and the sponsor code is raised with no other', () => {
        for (const [code, spec] of Object.entries(ERROR_CODES as Record<string, ErrorCodeSpec>)) {
            if (spec.statuses) expect(spec.statuses, code).toContain(spec.status);
        }
        const source = fs.readFileSync(path.resolve(__dirname, '../../srv/submission/fee-sponsor.ts'), 'utf8');
        const raised = [...source.matchAll(/new FeeSponsorError\((\d+)/g)].map(m => Number(m[1]));
        expect(raised.length).toBeGreaterThan(3);
        expect(raised.filter(status => !ERROR_CODES.FEE_SPONSOR_UNUSABLE.statuses.includes(status as 404))).toEqual([]);
    });

    it('an error that crossed a thread keeps its own name and message; the text around it becomes its cause', () => {
        class SyncError extends NightgateError {}
        const thrown = new SyncError('WALLET_NOT_SYNCED', 'wallet not synced to tip after 1000ms', { exposeMessage: true });
        const rebuilt = nightgateErrorFromPayload(thrown.toPayload(), { name: 'Error', message: 'send failed <- wallet not synced to tip after 1000ms <- socket closed' });
        expect(rebuilt).toMatchObject({ name: 'SyncError', code: 'WALLET_NOT_SYNCED', status: 503, retryable: true, message: 'wallet not synced to tip after 1000ms' });
        expect(rebuilt.cause).toMatchObject({ name: 'Error', message: 'send failed <- wallet not synced to tip after 1000ms <- socket closed' });
        // The mark that keeps the message of a server error in production crosses with it.
        expect((rebuilt as { $sanitize?: boolean }).$sanitize).toBe(false);
        const plain = nightgateErrorFromPayload(new NightgateError('TX_FAILED', 'did not apply').toPayload(), { name: 'NightgateError', message: 'did not apply' });
        expect(plain.cause).toBeUndefined();
        expect((plain as { $sanitize?: boolean }).$sanitize).toBeUndefined();
    });

    it('tell a job code and a number of the node from any other text', () => {
        expect(['TX_FAILED', 'UNKNOWN_ERROR', 'CHILD_FAILED'].every(isJobErrorCode)).toBe(true);
        expect(['RATE_LIMITED', 'TxFailed', 'TypeError', '', null, 1010].some(isJobErrorCode)).toBe(false);
        expect(['1010', '1010/104', '1014', '1016'].every(isNodeRejectCode)).toBe(true);
        expect(['1010/', '1015', 'pool-invalid', '1010/abc', 1014].some(isNodeRejectCode)).toBe(false);
    });

    it('the client carries exactly the retryable codes of a refused request', async () => {
        const { RETRYABLE_ERROR_CODES }: typeof import('../../src/sdk/client') = await import('../../src/sdk/client.mjs' as string);
        expect([...RETRYABLE_ERROR_CODES].sort()).toEqual(retryableErrorCodes());
        expect(retryableErrorCodes()).toContain('SUBMIT_INTENT_TIMEOUT');
        // A code only a job ends with is no answer to a request, so it is not in the list.
        expect(retryableErrorCodes()).not.toContain('NETWORK_OR_TIMEOUT');
    });

    it('no code of the table is dead: each is raised or written somewhere in the sources', () => {
        const sources: string[] = [];
        const walk = (dir: string): void => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const file = path.join(dir, entry.name);
                if (entry.isDirectory()) walk(file);
                else if (/\.(ts|mts|mjs)$/.test(entry.name) && !/\.d\.m?ts$/.test(entry.name) && file !== path.resolve(__dirname, '../../srv/utils/errors.ts')) sources.push(fs.readFileSync(file, 'utf8'));
            }
        };
        walk(path.resolve(__dirname, '../../srv'));
        walk(path.resolve(__dirname, '../../src'));
        // The module of the table itself counts from the end of the table on: it holds error classes that raise a code.
        const own = fs.readFileSync(path.resolve(__dirname, '../../srv/utils/errors.ts'), 'utf8');
        const text = [...sources, own.slice(own.indexOf('} as const satisfies'))].join('\n');
        // The generic codes stand for an HTTP status and are chosen by number.
        const generic = new Set(['INVALID_ARGUMENT', 'UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'CONFLICT', 'GONE', 'PRECONDITION_FAILED', 'PAYLOAD_TOO_LARGE', 'RATE_LIMITED', 'INTERNAL', 'NOT_IMPLEMENTED', 'BAD_GATEWAY', 'UNAVAILABLE']);
        const dead = Object.keys(ERROR_CODES).filter(code => !generic.has(code) && !new RegExp(`\\b${code}\\b`).test(text));
        expect(dead).toEqual([]);
    });

    it('every code the server writes into a job is in the table as a job code', () => {
        const literals = new Set<string>();
        const dir = path.resolve(__dirname, '../../srv/submission');
        for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.ts') && !f.endsWith('.d.ts'))) {
            const source = fs.readFileSync(path.join(dir, file), 'utf8');
            for (const m of source.matchAll(/errorCode: '([^']+)'/g)) literals.add(m[1]);
        }
        expect(literals.size).toBeGreaterThan(10);
        expect([...literals].filter(code => !isJobErrorCode(code))).toEqual([]);
    });

    it('maps every status the services reject with to a class code', () => {
        for (const s of [400, 401, 403, 404, 409, 410, 412, 413, 429, 500, 501, 502, 503]) {
            expect(ERROR_CODES[statusClassCode(s)].status).toBe(s);
        }
        expect(statusClassCode(418)).toBe('INVALID_ARGUMENT');
        expect(statusClassCode(504)).toBe('INTERNAL');
    });
});

describe('NightgateError', () => {
    it('takes status and retryable from the registry, overridable per site', () => {
        const e = new NightgateError('WALLET_NOT_SYNCED', 'not at tip');
        expect([e.code, e.status, e.retryable, e.name]).toEqual(['WALLET_NOT_SYNCED', 503, true, 'NightgateError']);
        const f = new NightgateError('FEE_SPONSOR_UNUSABLE', 'x', { status: 410 });
        expect(f.status).toBe(410);
    });

    it('keeps the subclass name and the cause', () => {
        class MyError extends NightgateError {}
        const cause = new Error('inner');
        const e = new MyError('CONFLICT', 'outer', { cause });
        expect(e.name).toBe('MyError');
        expect(e.cause).toBe(cause);
    });

    it('opts a 5xx message into exposure', () => {
        expect((new NightgateError('UNAVAILABLE', 'x', { exposeMessage: true }) as any).$sanitize).toBe(false);
        expect((new NightgateError('UNAVAILABLE', 'x') as any).$sanitize).toBeUndefined();
    });

    it('round-trips through a structured clone (the worker boundary)', () => {
        const e = new NightgateError('SUBMIT_PHASE_FAILED', 'send failed', { info: { phase: 'send' } });
        const back = nightgateErrorFromPayload(structuredClone(e.toPayload()));
        expect(isNightgateError(back)).toBe(true);
        expect([back.code, back.status, back.retryable, back.message, back.info]).toEqual(['SUBMIT_PHASE_FAILED', 502, false, 'send failed', { phase: 'send' }]);
    });

    it('rebuilds an unknown code as its status class and keeps the name', () => {
        const back = nightgateErrorFromPayload({ name: 'Foo', code: 'NOT_A_CODE', status: 409, retryable: false, message: 'm' });
        expect([back.code, back.name]).toEqual(['CONFLICT', 'Foo']);
    });

    it('is found in a cause chain', () => {
        const inner = new NightgateError('TX_FAILED', 'landed failed');
        const outer = new Error('wrapped', { cause: new Error('mid', { cause: inner }) });
        expect(findNightgateError(outer)).toBe(inner);
        expect(findNightgateError(new Error('plain'))).toBeUndefined();
    });
});

describe('normalizeHttpError', () => {
    const prodEnv = process.env.NODE_ENV;
    afterEach(() => { if (prodEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prodEnv; });

    it('turns a numeric reject code into its status and class code', () => {
        const err: any = { code: 400, message: 'bad' };
        normalizeHttpError(err);
        expect([err.status, err.code, err.message]).toEqual([400, 'INVALID_ARGUMENT', 'bad']);
        const str: any = { code: '429', message: 'slow down' };
        normalizeHttpError(str);
        expect([str.status, str.code]).toEqual([429, 'RATE_LIMITED']);
    });

    it('leaves a string code and its status alone', () => {
        const err: any = { code: 'JOB_ADMISSION_BUSY', status: 503, message: 'busy', $sanitize: false };
        normalizeHttpError(err);
        expect([err.status, err.code, err.message]).toEqual([503, 'JOB_ADMISSION_BUSY', 'busy']);
    });

    it('codes an error without status or code as INTERNAL', () => {
        const err: any = new Error('boom');
        normalizeHttpError(err);
        expect(err.code).toBe('INTERNAL');
    });

    it('normalizes every entry of a multi-error response', () => {
        const err: any = { code: 'MULTIPLE_ERRORS', status: 400, details: [{ code: 400, message: 'a' }, { code: 'X_CODE', message: 'b' }] };
        normalizeHttpError(err);
        expect(err.details.map((d: any) => d.code)).toEqual(['INVALID_ARGUMENT', 'X_CODE']);
    });

    it('gives a combined input error without own status the status of its parts, not 500', () => {
        process.env.NODE_ENV = 'production';
        const err: any = { message: 'MULTIPLE_ERRORS', details: [
            { status: 400, code: 'ASSERT_DATA_TYPE', message: 'not a Map', target: 'document' },
            { status: 400, code: 'ASSERT_ARRAY', message: 'Value must be an array', target: 'proofFields' }] };
        normalizeHttpError(err);
        expect([err.status, err.code, err.message]).toEqual([400, 'INVALID_ARGUMENT', 'MULTIPLE_ERRORS']);
        expect(err.details.map((d: any) => d.target)).toEqual(['document', 'proofFields']);
        const mixed: any = { message: 'MULTIPLE_ERRORS', details: [{ status: 400, message: 'a' }, { status: 503, message: 'b' }] };
        normalizeHttpError(mixed);
        expect(mixed.status).toBe(500);
    });

    it('withholds a 5xx message in production itself, so the code survives', () => {
        process.env.NODE_ENV = 'production';
        const err: any = { code: 503, message: 'secret upstream detail' };
        normalizeHttpError(err);
        expect([err.code, err.message, err.$sanitize]).toEqual(['UNAVAILABLE', 'Service Unavailable', false]);
        const exposed: any = { code: 'WALLET_SYNCING', status: 503, message: 'syncing 42%', $sanitize: false };
        normalizeHttpError(exposed);
        expect(exposed.message).toBe('syncing 42%');
    });

    it('strips everything but code, message and status from a 5xx it sanitizes', () => {
        process.env.NODE_ENV = 'production';
        const err: any = { status: 502, message: 'upstream secret', reason: 'SECRET', innererror: { x: 1 }, details: [{ message: 'd' }], extra: 'e' };
        normalizeHttpError(err);
        expect(Object.keys(err).sort()).toEqual(['$sanitize', 'code', 'message', 'status']);
        expect(err).toMatchObject({ code: 'BAD_GATEWAY', message: 'Bad Gateway' });
    });

    it('keeps 5xx messages outside production and ignores non-objects', () => {
        delete process.env.NODE_ENV;
        const err: any = { code: 500, message: 'detail' };
        normalizeHttpError(err);
        expect(err.message).toBe('detail');
        expect(() => normalizeHttpError(undefined)).not.toThrow();
        expect(() => normalizeHttpError('x')).not.toThrow();
    });
});

describe('a read the database stopped', () => {
    it('answers 504 QUERY_TIMEOUT with the time limit and drops the statement text', () => {
        const err: Record<string, unknown> = {
            code: '57014', message: 'canceling statement due to statement timeout', status: 500, severity: 'ERROR', query: 'SELECT secret FROM t'
        };
        normalizeHttpError(err);
        expect(err).toEqual({
            status: 504, code: 'QUERY_TIMEOUT', $sanitize: false,
            message: 'The read ran longer than 15 s and was stopped. Narrow the filter or sort by an indexed column.'
        });
    });

    it('names a limit under a second in milliseconds', () => {
        process.env.NIGHTGATE_QUERY_TIMEOUT_MS = '300';
        try {
            const err: Record<string, unknown> = { code: '57014', message: 'canceling statement due to statement timeout' };
            normalizeHttpError(err);
            expect(err.message).toMatch(/longer than 300 ms /);
        } finally {
            delete process.env.NIGHTGATE_QUERY_TIMEOUT_MS;
        }
    });

    it('keeps its message in production', () => {
        const saved = process.env.NODE_ENV;
        process.env.NODE_ENV = 'production';
        try {
            const err: Record<string, unknown> = { code: '57014', message: 'canceling statement due to statement timeout', status: 500 };
            normalizeHttpError(err);
            expect(err.message).toMatch(/stopped/);
        } finally {
            process.env.NODE_ENV = saved;
        }
    });
});

describe('error codes in the docs', () => {
    it('docs/reference.md carries exactly the generated rows', () => {
        const doc = fs.readFileSync(path.resolve(__dirname, '../../docs/reference.md'), 'utf8').replace(/\r\n/g, '\n');
        const start = doc.indexOf('<!-- error-codes:start -->');
        const end = doc.indexOf('<!-- error-codes:end -->');
        expect(start).toBeGreaterThan(0);
        expect(doc.slice(start, end).split('\n').filter(l => l.startsWith('| `'))).toEqual(errorCodeMarkdownRows());
    });
});
