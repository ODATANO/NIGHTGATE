/**
 * Tests for srv/submission/chain-outcome-confirmer.ts.
 * `createHttpTxConfirmer` takes an injectable `fetch`, so the GraphQL parse +
 * status mapping run without a real Indexer.
 */
import { describe, test, expect, vi } from 'vitest';
import { mapIndexerStatus, createHttpTxConfirmer, CHAIN_ABSENT, chainAbsent, isChainOutcome, isChainAbsent } from '../../srv/submission/chain-outcome-confirmer';

const jsonResponse = (data: any, init?: { ok?: boolean; status?: number }) => ({
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    json: async () => data
}) as any;

const txResult = (status: string) => ({ data: { transactions: [{ hash: '0xindexerhash', block: { hash: '0xblockhash', height: 2415919 }, transactionResult: { status } }] } });

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
        await expect(confirm('0xabc')).resolves.toMatchObject({ status: 'success' });
    });

    test('maps FAILURE and PARTIAL_SUCCESS to failure', async () => {
        for (const s of ['FAILURE', 'PARTIAL_SUCCESS']) {
            const confirm = createHttpTxConfirmer({
                indexerHttpUrl: 'http://indexer/graphql',
                fetchFn: async () => jsonResponse(txResult(s))
            });
            await expect(confirm('0xabc')).resolves.toMatchObject({ status: 'failure' });
        }
    });

    test('carries the inclusion coordinates, and confirms nothing without a block height', async () => {
        const confirm = createHttpTxConfirmer({
            indexerHttpUrl: 'http://indexer/graphql',
            fetchFn: async () => jsonResponse(txResult('SUCCESS'))
        });
        await expect(confirm('00identifier')).resolves.toEqual({
            status: 'success', blockHeight: 2415919, blockHash: '0xblockhash', indexerTxHash: '0xindexerhash'
        });
        const bare = createHttpTxConfirmer({
            indexerHttpUrl: 'http://indexer/graphql',
            fetchFn: async () => jsonResponse({ data: { transactions: [{ transactionResult: { status: 'SUCCESS' } }] } })
        });
        // No height, no confirmation: the height is the rollback coordinate.
        await expect(bare('00identifier')).resolves.toBeNull();
        // `block.height: null` is "no height" too (Number(null) would be 0, a plausible block).
        const nullHeight = createHttpTxConfirmer({
            indexerHttpUrl: 'http://indexer/graphql',
            fetchFn: async () => jsonResponse({ data: { transactions: [{ block: { hash: '0xb', height: null }, transactionResult: { status: 'SUCCESS' } }] } })
        });
        await expect(nullHeight('00identifier')).resolves.toBeNull();
        // A digit string is a height (some indexer schemas serialise it that way).
        const stringHeight = createHttpTxConfirmer({
            indexerHttpUrl: 'http://indexer/graphql',
            fetchFn: async () => jsonResponse({ data: { transactions: [{ block: { hash: '0xb', height: '2415919' }, transactionResult: { status: 'SUCCESS' } }] } })
        });
        await expect(stringHeight('00identifier')).resolves.toMatchObject({ status: 'success', blockHeight: 2415919 });
    });

    test('returns null for an unknown/future status (not confirmed)', async () => {
        const confirm = createHttpTxConfirmer({
            indexerHttpUrl: 'http://indexer/graphql',
            fetchFn: async () => jsonResponse(txResult('%future added value'))
        });
        await expect(confirm('0xfuture')).resolves.toBeNull();
    });

    test('reports CHAIN_ABSENT (no outcome, provable absence) when the indexer has no such tx (empty transactions)', async () => {
        const confirm = createHttpTxConfirmer({
            indexerHttpUrl: 'http://indexer/graphql',
            fetchFn: async () => jsonResponse({ data: { transactions: [] } })
        });
        const lookup = await confirm('0xnotyet');
        expect(lookup).toEqual(CHAIN_ABSENT); // no block in the answer: absent without a tip
        expect(isChainOutcome(lookup)).toBe(false);
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

    test('queries by transaction IDENTIFIER first (what NIGHTGATE stores as txHash), against the configured URL', async () => {
        const fetchFn = vi.fn(async (_url: string, _init: any) => jsonResponse(txResult('SUCCESS')));
        const confirm = createHttpTxConfirmer({ indexerHttpUrl: 'http://indexer/graphql', fetchFn: fetchFn as any });
        await confirm('00deadbeef');
        expect(fetchFn).toHaveBeenCalledTimes(1);
        const [url, init] = fetchFn.mock.calls[0];
        expect(url).toBe('http://indexer/graphql');
        expect(init.method).toBe('POST');
        expect(JSON.parse(init.body)).toMatchObject({ variables: { offset: { identifier: '00deadbeef' } } });
        expect(init.signal).toBeDefined(); // AbortSignal deadline, so a stuck lookup cancels
    });

    test('falls back to offset.hash when the identifier lookup finds nothing (rows written by older paths)', async () => {
        const fetchFn = vi.fn(async (_url: string, init: any) => {
            const offset = JSON.parse(init.body).variables.offset;
            return offset.identifier ? jsonResponse({ data: { transactions: [] } }) : jsonResponse(txResult('SUCCESS'));
        });
        const confirm = createHttpTxConfirmer({ indexerHttpUrl: 'http://indexer/graphql', fetchFn: fetchFn as any });
        await expect(confirm('0xabc')).resolves.toMatchObject({ status: 'success' });
        expect(fetchFn).toHaveBeenCalledTimes(2);
        expect(JSON.parse(fetchFn.mock.calls[1][1].body)).toMatchObject({ variables: { offset: { hash: '0xabc' } } });
    });

    test('an "invalid transaction hash/identifier" GraphQL error is treated as not found for that key, not as a failure', async () => {
        const fetchFn = vi.fn(async (_url: string, init: any) => {
            const offset = JSON.parse(init.body).variables.offset;
            return offset.identifier
                ? jsonResponse(txResult('SUCCESS'))
                : jsonResponse({ errors: [{ message: 'invalid transaction hash: cannot convert to ByteArray<32>' }] });
        });
        const confirm = createHttpTxConfirmer({ indexerHttpUrl: 'http://indexer/graphql', fetchFn: fetchFn as any });
        await expect(confirm('00deadbeef')).resolves.toMatchObject({ status: 'success' });
    });
});

describe('absence vs. unconfirmable', () => {
    test('no transaction under identifier nor hash is CHAIN_ABSENT; an indexed transaction without a usable result is null (present, not confirmable)', async () => {
        // the answer carries the indexer's tip: the absence is "as of" that tip, from the same replica
        const empty = createHttpTxConfirmer({ indexerHttpUrl: 'http://indexer/graphql', fetchFn: vi.fn(async () => jsonResponse({ data: { transactions: [], block: { height: 2484576, timestamp: 1789020090000 } } })) as any });
        const absent = await empty('00gone');
        expect(absent).toEqual(chainAbsent(1789020090000));
        expect(isChainAbsent(absent)).toBe(true);
        expect(isChainOutcome(absent)).toBe(false);
        // seconds are scaled, garbage is no tip
        const secs = createHttpTxConfirmer({ indexerHttpUrl: 'http://indexer/graphql', fetchFn: vi.fn(async () => jsonResponse({ data: { transactions: [], block: { timestamp: '1789020090' } } })) as any });
        expect(await secs('00gone')).toEqual(chainAbsent(1789020090000));
        const junk = createHttpTxConfirmer({ indexerHttpUrl: 'http://indexer/graphql', fetchFn: vi.fn(async () => jsonResponse({ data: { transactions: [], block: { timestamp: 'soon' } } })) as any });
        expect(await junk('00gone')).toEqual(chainAbsent(null));
        // identifier lookup absent WITH a tip, hash lookup a GraphQL error without data: the identifier answer's tip survives
        const mixed = createHttpTxConfirmer({ indexerHttpUrl: 'http://indexer/graphql', fetchFn: vi.fn(async (_u: string, init: any) => {
            const offset = JSON.parse(init.body).variables.offset;
            return offset.identifier
                ? jsonResponse({ data: { transactions: [], block: { timestamp: 1789020090000 } } })
                : jsonResponse({ errors: [{ message: 'invalid transaction hash: cannot convert to ByteArray<32>' }] });
        }) as any });
        expect(await mixed('00gone')).toEqual(chainAbsent(1789020090000));
        // both keys absent with DIFFERENT tips (two requests, a fresher replica answered the second):
        // the joint absence is as of the OLDER tip, the identifier absence was not re-checked at the newer one
        const skew = createHttpTxConfirmer({ indexerHttpUrl: 'http://indexer/graphql', fetchFn: vi.fn(async (_u: string, init: any) => {
            const offset = JSON.parse(init.body).variables.offset;
            return jsonResponse({ data: { transactions: [], block: { timestamp: offset.identifier ? 1789020000000 : 1789020600000 } } });
        }) as any });
        expect(await skew('00gone')).toEqual(chainAbsent(1789020000000));
        // one of the two answers without a tip: no tip for the joint absence
        const half = createHttpTxConfirmer({ indexerHttpUrl: 'http://indexer/graphql', fetchFn: vi.fn(async (_u: string, init: any) => {
            const offset = JSON.parse(init.body).variables.offset;
            return jsonResponse({ data: { transactions: [], ...(offset.identifier ? { block: { timestamp: 1789020000000 } } : {}) } });
        }) as any });
        expect(await half('00gone')).toEqual(chainAbsent(null));
        const future = createHttpTxConfirmer({ indexerHttpUrl: 'http://indexer/graphql', fetchFn: vi.fn(async () => jsonResponse(txResult('SOMETHING_NEW'))) as any });
        expect(await future('00future')).toBeNull();
        const noHeight = createHttpTxConfirmer({ indexerHttpUrl: 'http://indexer/graphql', fetchFn: vi.fn(async () => jsonResponse({ data: { transactions: [{ hash: '0xh', block: null, transactionResult: { status: 'SUCCESS' } }] } })) as any });
        expect(await noHeight('00noheight')).toBeNull();
        const noResult = createHttpTxConfirmer({ indexerHttpUrl: 'http://indexer/graphql', fetchFn: vi.fn(async () => jsonResponse({ data: { transactions: [{ hash: '0xh' }] } })) as any });
        expect(await noResult('00noresult')).toBeNull();
        expect(isChainOutcome(null)).toBe(false);
        expect(isChainAbsent(null)).toBe(false);
        expect(JSON.parse((await (async () => { let body = ''; const c = createHttpTxConfirmer({ indexerHttpUrl: 'http://indexer/graphql', fetchFn: vi.fn(async (_u: string, init: any) => { body = init.body; return jsonResponse({ data: { transactions: [] } }); }) as any }); await c('00q'); return body; })())).query).toMatch(/block \{ height timestamp \}/); // tip and transaction in ONE request
        expect(isChainOutcome({ status: 'success', blockHeight: 1 })).toBe(true);
    });
});
