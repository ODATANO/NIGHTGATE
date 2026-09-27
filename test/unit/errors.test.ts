/**
 * The error model: registry, NightgateError, payload round trip and the HTTP normaliser.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
    ERROR_CODES, errorCodeMarkdownRows, NightgateError, isNightgateError, findNightgateError, nightgateErrorFromPayload, statusClassCode
} from '../../srv/utils/errors';
import { normalizeHttpError } from '../../srv/utils/http-errors';

describe('ERROR_CODES', () => {
    it('are UPPER_SNAKE_CASE with an HTTP status and a doc line', () => {
        for (const [code, spec] of Object.entries(ERROR_CODES)) {
            expect(code).toMatch(/^[A-Z][A-Z0-9_]+$/);
            expect(spec.status).toBeGreaterThanOrEqual(400);
            expect(spec.status).toBeLessThan(600);
            expect(spec.doc.length).toBeGreaterThan(10);
        }
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

describe('error codes in the docs', () => {
    it('docs/reference.md carries exactly the generated rows', () => {
        const doc = fs.readFileSync(path.resolve(__dirname, '../../docs/reference.md'), 'utf8').replace(/\r\n/g, '\n');
        const start = doc.indexOf('<!-- error-codes:start -->');
        const end = doc.indexOf('<!-- error-codes:end -->');
        expect(start).toBeGreaterThan(0);
        expect(doc.slice(start, end).split('\n').filter(l => l.startsWith('| `'))).toEqual(errorCodeMarkdownRows());
    });
});
