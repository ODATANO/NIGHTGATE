/**
 * Tests for srv/submission/chain-outcome-confirmer.ts.
 * `createHttpTxConfirmer` takes an injectable `fetch`, so the GraphQL parse +
 * status mapping run without a real Indexer.
 */
import { describe, test, expect, vi } from 'vitest';
import { mapIndexerStatus, createHttpTxConfirmer } from '../../srv/submission/chain-outcome-confirmer';

const jsonResponse = (data: any, init?: { ok?: boolean; status?: number }) => ({
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    json: async () => data
}) as any;

const txResult = (status: string) => ({ data: { transactions: [{ transactionResult: { status } }] } });

describe('mapIndexerStatus', () => {
    test('SUCCESS maps to success', () => {
        expect(mapIndexerStatus('SUCCESS')).toBe('success');
    });
    test('FAILURE and PARTIAL_SUCCESS map to failure', () => {
        expect(mapIndexerStatus('FAILURE')).toBe('failure');
        expect(mapIndexerStatus('PARTIAL_SUCCESS')).toBe('failure');
    });
    test('an unknown/future status is not confirmed (null), not a wrong failure', () => {
        expect(mapIndexerStatus('%future added value')).toBeNull();
        expect(mapIndexerStatus('SOMETHING_NEW')).toBeNull();
    });
});

describe('createHttpTxConfirmer', () => {
    test('requires an indexer URL', () => {
        expect(() => createHttpTxConfirmer({ indexerHttpUrl: '' })).toThrow(/indexerHttpUrl/);
    });

    test('maps a finalized SUCCESS', async () => {
        const confirm = createHttpTxConfirmer({
            indexerHttpUrl: 'http://indexer/graphql',
            fetchFn: async () => jsonResponse(txResult('SUCCESS'))
        });
        await expect(confirm('0xabc')).resolves.toEqual({ status: 'success' });
    });

    test('maps FAILURE and PARTIAL_SUCCESS to failure', async () => {
        for (const s of ['FAILURE', 'PARTIAL_SUCCESS']) {
            const confirm = createHttpTxConfirmer({
                indexerHttpUrl: 'http://indexer/graphql',
                fetchFn: async () => jsonResponse(txResult(s))
            });
            await expect(confirm('0xabc')).resolves.toEqual({ status: 'failure' });
        }
    });

    test('returns null for an unknown/future status (not confirmed)', async () => {
        const confirm = createHttpTxConfirmer({
            indexerHttpUrl: 'http://indexer/graphql',
            fetchFn: async () => jsonResponse(txResult('%future added value'))
        });
        await expect(confirm('0xfuture')).resolves.toBeNull();
    });

    test('returns null when the tx is not indexed yet (empty transactions)', async () => {
        const confirm = createHttpTxConfirmer({
            indexerHttpUrl: 'http://indexer/graphql',
            fetchFn: async () => jsonResponse({ data: { transactions: [] } })
        });
        await expect(confirm('0xnotyet')).resolves.toBeNull();
    });

    test('returns null for a found tx without a result (non-regular / no status)', async () => {
        const confirm = createHttpTxConfirmer({
            indexerHttpUrl: 'http://indexer/graphql',
            fetchFn: async () => jsonResponse({ data: { transactions: [{}] } })
        });
        await expect(confirm('0xsystem')).resolves.toBeNull();
    });

    test('throws on a non-ok HTTP response (surfaces a bad endpoint)', async () => {
        const confirm = createHttpTxConfirmer({
            indexerHttpUrl: 'http://indexer/graphql',
            fetchFn: async () => jsonResponse({}, { ok: false, status: 502 })
        });
        await expect(confirm('0xabc')).rejects.toThrow(/HTTP 502/);
    });

    test('throws on a GraphQL error', async () => {
        const confirm = createHttpTxConfirmer({
            indexerHttpUrl: 'http://indexer/graphql',
            fetchFn: async () => jsonResponse({ errors: [{ message: 'bad offset' }] })
        });
        await expect(confirm('0xabc')).rejects.toThrow(/bad offset/);
    });

    test('queries by tx hash (offset.hash) against the configured URL', async () => {
        const fetchFn = vi.fn(async (_url: string, _init: any) => jsonResponse(txResult('SUCCESS')));
        const confirm = createHttpTxConfirmer({ indexerHttpUrl: 'http://indexer/graphql', fetchFn: fetchFn as any });
        await confirm('0xdeadbeef');
        expect(fetchFn).toHaveBeenCalledTimes(1);
        const [url, init] = fetchFn.mock.calls[0];
        expect(url).toBe('http://indexer/graphql');
        expect(init.method).toBe('POST');
        expect(JSON.parse(init.body)).toMatchObject({ variables: { offset: { hash: '0xdeadbeef' } } });
        expect(init.signal).toBeDefined(); // AbortSignal deadline, so a stuck lookup cancels
    });
});
