import {
    MAX_DESCRIPTION_LENGTH,
    MAX_REFERENCE_ID_LENGTH,
    validateCommitmentHash,
    validateCommitmentHashes,
    validateExpiresAt,
    validateFieldsToDisclose,
    validateStringField,
    validateViewingKey
} from '../../srv/utils/validation';
import { RateLimiter } from '../../srv/utils/rate-limiter';

describe('validation utilities', () => {
    it('validates commitment hashes and reports indexed failures', () => {
        expect(validateCommitmentHash('a'.repeat(64))).toBeUndefined();
        expect(validateCommitmentHash('xyz')).toContain('Invalid commitmentHash format');
        expect(validateCommitmentHashes(['a'.repeat(64), 'xyz'])).toContain('commitmentHashes[1]');
    });

    it('validates expiry timestamps', () => {
        expect(validateExpiresAt('not-a-date')).toBe('Invalid expiresAt: not a valid ISO 8601 date');
        expect(validateExpiresAt(new Date(Date.now() - 60_000).toISOString())).toBe('expiresAt must be in the future');
        expect(validateExpiresAt(new Date(Date.now() + 60_000).toISOString())).toBeUndefined();
    });

    it('validates bounded string fields and control characters', () => {
        expect(validateStringField(undefined, 'referenceId', MAX_REFERENCE_ID_LENGTH)).toBeUndefined();
        expect(validateStringField(123 as unknown as string, 'referenceId', MAX_REFERENCE_ID_LENGTH)).toBe('referenceId must be a string');
        expect(validateStringField('a'.repeat(MAX_DESCRIPTION_LENGTH + 1), 'description', MAX_DESCRIPTION_LENGTH)).toBe(
            `description exceeds maximum length of ${MAX_DESCRIPTION_LENGTH}`
        );
        expect(validateStringField('bad\u0001value', 'description', MAX_DESCRIPTION_LENGTH)).toBe(
            'description contains invalid control characters'
        );
    });

    it('validates disclosure fields against the allow-list', () => {
        expect(validateFieldsToDisclose([])).toBe('fieldsToDisclose must be a non-empty array');
        expect(validateFieldsToDisclose(['status', 'referenceId'])).toBeUndefined();
        expect(validateFieldsToDisclose(['status', 'secretField'])).toContain('Invalid fields for disclosure: secretField');
    });

    it('validates viewing keys as 32-byte hex strings', () => {
        expect(validateViewingKey(undefined)).toBe('viewingKey is required');
        expect(validateViewingKey('not-hex')).toBe('viewingKey must be hex-encoded');
        expect(validateViewingKey('a'.repeat(62))).toBe('viewingKey must be 64 hex characters (32 bytes), got 62');
        expect(validateViewingKey('a'.repeat(64))).toBeUndefined();
    });
});

describe('RateLimiter', () => {
    let nowSpy: jest.SpyInstance<number, []>;

    beforeEach(() => {
        nowSpy = jest.spyOn(Date, 'now');
    });

    afterEach(() => {
        nowSpy.mockRestore();
    });

    it('counts and stores the first request in the active window', () => {
        const limiter = new RateLimiter({ windowMs: 1000, maxRequests: 1 });

        nowSpy.mockReturnValue(1000);
        expect(limiter.check('client-1')).toEqual({ allowed: true, retryAfterMs: 0 });
        expect((limiter as any).hits.get('client-1')).toEqual([1000]);
    });

    it('returns retryAfter when the active window is already full', () => {
        const limiter = new RateLimiter({ windowMs: 1000, maxRequests: 1 });

        (limiter as any).hits.set('client-1', [1000]);
        nowSpy.mockReturnValue(1500);
        expect(limiter.check('client-1')).toEqual({ allowed: false, retryAfterMs: 500 });
    });

    it('sorts multiple in-window timestamps before calculating retryAfter', () => {
        const limiter = new RateLimiter({ windowMs: 1000, maxRequests: 2 });

        (limiter as any).hits.set('client-1', [1500, 1000]);
        nowSpy.mockReturnValue(1600);
        expect(limiter.check('client-1')).toEqual({ allowed: false, retryAfterMs: 400 });
        expect((limiter as any).hits.get('client-1')).toEqual([1000, 1500]);
    });

    it('appends a new hit when the window already has room left', () => {
        const limiter = new RateLimiter({ windowMs: 1000, maxRequests: 3 });

        (limiter as any).hits.set('client-3', [1000, 1500]);
        nowSpy.mockReturnValue(1700);
        expect(limiter.check('client-3')).toEqual({ allowed: true, retryAfterMs: 0 });
        expect((limiter as any).hits.get('client-3')).toEqual([1000, 1500, 1700]);
    });

    it('drops stale hits once the sliding window has moved on', () => {
        const limiter = new RateLimiter({ windowMs: 1000, maxRequests: 1 });

        nowSpy.mockReturnValue(1000);
        expect(limiter.check('client-2')).toEqual({ allowed: true, retryAfterMs: 0 });

        nowSpy.mockReturnValue(2200);
        expect(limiter.check('client-2')).toEqual({ allowed: true, retryAfterMs: 0 });
    });
});