import { describe, it, expect } from 'vitest';
import { redactUrlCredentials } from '../../srv/utils/redact-url';

describe('redactUrlCredentials', () => {
    it('strips userinfo credentials', () => {
        expect(redactUrlCredentials('wss://user:pass@rpc.example.com/path'))
            .toBe('wss://rpc.example.com/path');
    });

    it('strips API-key query parameters', () => {
        expect(redactUrlCredentials('https://indexer.example.com/api?apikey=secret123'))
            .toBe('https://indexer.example.com/api');
    });

    it('returns clean URLs verbatim (no normalization churn)', () => {
        expect(redactUrlCredentials('ws://localhost:9944')).toBe('ws://localhost:9944');
        expect(redactUrlCredentials('wss://rpc.preprod.midnight.network/'))
            .toBe('wss://rpc.preprod.midnight.network/');
    });

    it('passes through non-URL strings and maps empty input to the empty string', () => {
        expect(redactUrlCredentials('not a url')).toBe('not a url');
        expect(redactUrlCredentials('')).toBe('');
        expect(redactUrlCredentials(undefined)).toBe('');
        expect(redactUrlCredentials(null)).toBe('');
    });
});
