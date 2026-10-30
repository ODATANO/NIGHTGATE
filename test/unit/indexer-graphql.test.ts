import { describe, expect, it } from 'vitest';
import { indexerQuery, indexerTimestampMs, IndexerHttpError, IndexerQueryError, isIndexerRateLimit } from '../../srv/utils/indexer-graphql';

const answer = (body: unknown, init: { ok?: boolean; status?: number } = {}) =>
    (async () => ({ ok: init.ok ?? true, status: init.status ?? 200, json: async () => body })) as unknown as typeof fetch;

describe('indexerQuery', () => {
    it('returns data and sends variables beside the query', async () => {
        let sent: any;
        const fetchFn = (async (_url: string, init: { body: string }) => {
            sent = JSON.parse(init.body);
            return { ok: true, status: 200, json: async () => ({ data: { block: { height: 7 } } }) };
        }) as unknown as typeof fetch;
        expect(await indexerQuery('http://i', 'query($h: Int) { block { height } }', { variables: { h: 7 }, fetchFn })).toEqual({ block: { height: 7 } });
        expect(sent).toEqual({ query: 'query($h: Int) { block { height } }', variables: { h: 7 } });
    });

    it('throws the HTTP status and the GraphQL messages as typed errors', async () => {
        await expect(indexerQuery('http://i', '{ x }', { fetchFn: answer({}, { ok: false, status: 429 }) })).rejects.toBeInstanceOf(IndexerHttpError);
        expect(isIndexerRateLimit(new IndexerHttpError(429))).toBe(true);
        const err = await indexerQuery('http://i', '{ x }', { fetchFn: answer({ errors: [{ message: 'bad offset' }] }) }).catch((e: IndexerQueryError) => e);
        expect(err).toBeInstanceOf(IndexerQueryError);
        expect((err as IndexerQueryError).messages).toEqual(['bad offset']);
    });
});

describe('indexerTimestampMs', () => {
    it('reads seconds and milliseconds, numbers and digit strings', () => {
        expect(indexerTimestampMs(1_700_000_000)).toBe(1_700_000_000_000);
        expect(indexerTimestampMs(1_700_000_000_000)).toBe(1_700_000_000_000);
        expect(indexerTimestampMs('1700000000')).toBe(1_700_000_000_000);
    });

    it('answers null for anything that is not a positive whole timestamp', () => {
        for (const raw of [null, undefined, 0, -5, 'soon', '12.5', NaN]) expect(indexerTimestampMs(raw)).toBeNull();
    });
});
