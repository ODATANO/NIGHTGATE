import { formatErr } from '../../srv/utils/format-error';

describe('formatErr', () => {
    it('returns the message for Error instances', () => {
        expect(formatErr(new Error('boom'))).toBe('boom');
    });

    it('returns the string for string values', () => {
        expect(formatErr('plain string')).toBe('plain string');
    });

    it('returns "null" / "undefined" for nullish values', () => {
        expect(formatErr(null)).toBe('null');
        expect(formatErr(undefined)).toBe('undefined');
    });

    it('JSON-stringifies plain objects so they do not become [object Object]', () => {
        expect(formatErr({ code: 'E_FOO', detail: 'bar' })).toBe('{"code":"E_FOO","detail":"bar"}');
    });

    it('falls back to String() when JSON.stringify throws (e.g. circular refs)', () => {
        const circular: any = { name: 'cycle' };
        circular.self = circular;
        expect(formatErr(circular)).toBe('[object Object]');
    });
});
