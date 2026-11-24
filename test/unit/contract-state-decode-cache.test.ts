/**
 * The state readers decode a contract's state once per change: `queryLedger9ContractState` keeps the decoded
 * state per contract and reuses it while the indexer returns the same bytes.
 */
import { queryLedger9ContractState, queryLedger9ContractStateAtTip, indexerTipHeight, __resetPublicDataProvidersForTests, type ContractStateReader } from '../../srv/midnight/public-data-provider';
import { __resetConfigForTests } from '../../srv/utils/config';

const VAULT = 'aa'.repeat(32);
const OTHER = 'bb'.repeat(32);

/** A serialized state as the SDK hands it over: its bytes, and a decoder that counts its runs. */
function serializedState(bytes: Uint8Array, era = 'v9') {
    const deserialize = vi.fn(() => ({ decodedFrom: bytes[0] }));
    return { read: { contractState: { era, serialize: () => new Uint8Array(bytes), deserialize } }, deserialize };
}
const bytesOf = (fill: number, length = 8) => new Uint8Array(length).fill(fill);

/** A reader that answers from the given function and records its calls. */
function readerOf(answer: (address: string, at?: unknown) => unknown) {
    const queryContractState = vi.fn(async (address: string, at?: unknown) => answer(address, at));
    return { reader: { queryContractState } as unknown as ContractStateReader, queryContractState };
}

beforeEach(() => {
    delete process.env.NIGHTGATE_STATE_DECODE_CACHE_MB;
    __resetConfigForTests();
    __resetPublicDataProvidersForTests();
});
afterAll(() => {
    delete process.env.NIGHTGATE_STATE_DECODE_CACHE_MB;
    __resetConfigForTests();
});

describe('queryLedger9ContractState', () => {
    test('decodes the same bytes once and hands out the same state', async () => {
        const first = serializedState(bytesOf(1));
        const again = serializedState(bytesOf(1));
        const answers = [first.read, again.read];
        const { reader, queryContractState } = readerOf(() => answers.shift());

        const a = await queryLedger9ContractState(reader, VAULT);
        const b = await queryLedger9ContractState(reader, VAULT);
        expect(b).toBe(a);
        expect(first.deserialize).toHaveBeenCalledTimes(1);
        expect(again.deserialize).not.toHaveBeenCalled();
        // The indexer is still asked on every read, so the answer is as fresh as before.
        expect(queryContractState).toHaveBeenCalledTimes(2);
    });

    test('decodes again when the indexer returns other bytes, and keeps the newer state', async () => {
        const old = serializedState(bytesOf(1));
        const changed = serializedState(bytesOf(2));
        const same = serializedState(bytesOf(2));
        const answers = [old.read, changed.read, same.read];
        const { reader } = readerOf(() => answers.shift());

        const a = await queryLedger9ContractState(reader, VAULT);
        const b = await queryLedger9ContractState(reader, VAULT);
        const c = await queryLedger9ContractState(reader, VAULT);
        expect(b).not.toBe(a);
        expect(c).toBe(b);
        expect(changed.deserialize).toHaveBeenCalledTimes(1);
        expect(same.deserialize).not.toHaveBeenCalled();
    });

    test('keeps one state per contract, whatever the case of the address', async () => {
        const vault = serializedState(bytesOf(1));
        const other = serializedState(bytesOf(1));
        const upper = serializedState(bytesOf(1));
        const { reader } = readerOf((address) => (address === OTHER ? other.read : address === VAULT ? vault.read : upper.read));

        const a = await queryLedger9ContractState(reader, VAULT);
        await queryLedger9ContractState(reader, OTHER);
        expect(other.deserialize).toHaveBeenCalledTimes(1);
        expect(await queryLedger9ContractState(reader, VAULT.toUpperCase())).toBe(a);
        expect(upper.deserialize).not.toHaveBeenCalled();
    });

    test('reads that overlap share one indexer request', async () => {
        const state = serializedState(bytesOf(1));
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const { reader, queryContractState } = readerOf(async () => { await gate; return state.read; });

        const both = Promise.all([queryLedger9ContractState(reader, VAULT), queryLedger9ContractState(reader, VAULT)]);
        release();
        const [a, b] = await both;
        expect(a).toBe(b);
        expect(queryContractState).toHaveBeenCalledTimes(1);
        // A read that starts after the first one settled asks the indexer again.
        await queryLedger9ContractState(reader, VAULT);
        expect(queryContractState).toHaveBeenCalledTimes(2);
    });

    test('a failed read is not shared with the next one', async () => {
        const state = serializedState(bytesOf(1));
        const answers: Array<() => unknown> = [() => { throw new Error('indexer down'); }, () => state.read];
        const { reader } = readerOf(() => answers.shift()!());

        await expect(queryLedger9ContractState(reader, VAULT)).rejects.toThrow('indexer down');
        await expect(queryLedger9ContractState(reader, VAULT)).resolves.toEqual({ decodedFrom: 1 });
    });

    test('a read at an older height leaves the latest state in place', async () => {
        const latest = serializedState(bytesOf(2));
        const older = serializedState(bytesOf(1));
        const latestAgain = serializedState(bytesOf(2));
        const sameAsLatest = serializedState(bytesOf(2));
        const answers = [latest.read, older.read, latestAgain.read, sameAsLatest.read];
        const { reader, queryContractState } = readerOf(() => answers.shift());
        const at = { type: 'blockHeight' as const, blockHeight: 7 };

        const now = await queryLedger9ContractState(reader, VAULT);
        expect(await queryLedger9ContractState(reader, VAULT, at)).toEqual({ decodedFrom: 1 });
        expect(await queryLedger9ContractState(reader, VAULT)).toBe(now);
        expect(latestAgain.deserialize).not.toHaveBeenCalled();
        // The height goes to the indexer; a state equal to the kept one is not decoded again.
        expect(queryContractState).toHaveBeenNthCalledWith(2, VAULT, at);
        expect(await queryLedger9ContractState(reader, VAULT, at)).toBe(now);
        expect(sameAsLatest.deserialize).not.toHaveBeenCalled();
    });

    test('a read at the indexer\'s newest block asks at that height and is kept for later reads', async () => {
        const atTip = serializedState(bytesOf(3));
        const latest = serializedState(bytesOf(3));
        const answers = [atTip.read, latest.read];
        const { reader, queryContractState } = readerOf(() => answers.shift());

        const a = await queryLedger9ContractStateAtTip(reader, VAULT, 42);
        expect(queryContractState).toHaveBeenNthCalledWith(1, VAULT, { type: 'blockHeight', blockHeight: 42 });
        expect(await queryLedger9ContractStateAtTip(reader, VAULT)).toBe(a);
        expect(queryContractState).toHaveBeenNthCalledWith(2, VAULT, undefined);
        expect(latest.deserialize).not.toHaveBeenCalled();
    });

    test('no contract state is null, and a ledger 8 state is refused', async () => {
        const v8 = serializedState(bytesOf(1), 'v8');
        const answers: unknown[] = [null, v8.read];
        const { reader } = readerOf(() => answers.shift());

        await expect(queryLedger9ContractState(reader, VAULT)).resolves.toBeNull();
        await expect(queryLedger9ContractState(reader, VAULT)).rejects.toThrow(/written by ledger v8/);
        expect(v8.deserialize).not.toHaveBeenCalled();
    });
});

describe('an indexer that cannot serve the state', () => {
    test('is reported as a retryable upstream failure, without the indexer URL', async () => {
        const { reader } = readerOf(() => { throw new Error('fetch failed: https://user:key@indexer.example/api/v3/graphql ECONNREFUSED'); });
        const failure = await queryLedger9ContractState(reader, VAULT).catch((e: unknown) => e) as any;
        expect(failure).toMatchObject({ code: 'BAD_GATEWAY', status: 502, retryable: true });
        expect(failure.message).toMatch(new RegExp(`indexer could not serve the state of contract ${VAULT}: fetch failed: <indexer> ECONNREFUSED`));
        expect(failure.message).not.toMatch(/user:key|indexer\.example/);
    });

    test('a ledger 8 state is a conflict, never a retryable failure', async () => {
        const { reader } = readerOf(() => serializedState(bytesOf(2), 'v8').read);
        const failure = await queryLedger9ContractState(reader, VAULT).catch((e: unknown) => e) as any;
        expect(failure).toMatchObject({ code: 'CONFLICT', status: 409, retryable: false });
    });
});

describe('indexerTipHeight', () => {
    const URL_A = 'https://indexer.example/api/v4/graphql';
    const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

    test('asks for the newest block once for a burst of checks, and again after a moment', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        const fetchSpy = vi.spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(answer({ data: { block: { height: 100 } } }))
            .mockResolvedValueOnce(answer({ data: { block: { height: 101 } } }));
        expect(await Promise.all([indexerTipHeight(URL_A), indexerTipHeight(URL_A)])).toEqual([100, 100]);
        expect(await indexerTipHeight(URL_A)).toBe(100);
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(JSON.parse(String(fetchSpy.mock.calls[0][1]?.body))).toEqual({ query: '{ block { height } }' });
        vi.setSystemTime(Date.now() + 2_500);
        expect(await indexerTipHeight(URL_A)).toBe(101);
        expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    test('an indexer that names no block is a retryable upstream failure, without the URL', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(answer({ data: { block: null } })).mockResolvedValueOnce(answer({}, 503));
        await expect(indexerTipHeight('https://user:key@indexer.example/graphql')).rejects.toMatchObject({ code: 'BAD_GATEWAY', retryable: true });
        const failure = await indexerTipHeight('https://user:key@indexer.example/graphql').catch((e: unknown) => e) as Error;
        expect(failure.message).toMatch(/indexer could not name its newest block/);
        expect(failure.message).not.toMatch(/user:key/);
    });
});

describe('NIGHTGATE_STATE_DECODE_CACHE_MB', () => {
    const MB = 1024 * 1024;

    test('0 decodes on every read', async () => {
        process.env.NIGHTGATE_STATE_DECODE_CACHE_MB = '0';
        __resetConfigForTests();
        const first = serializedState(bytesOf(1));
        const again = serializedState(bytesOf(1));
        const answers = [first.read, again.read];
        const { reader } = readerOf(() => answers.shift());

        await queryLedger9ContractState(reader, VAULT);
        await queryLedger9ContractState(reader, VAULT);
        expect(again.deserialize).toHaveBeenCalledTimes(1);
    });

    test('over the budget the state used longest ago goes first', async () => {
        process.env.NIGHTGATE_STATE_DECODE_CACHE_MB = '1';
        __resetConfigForTests();
        const big = (fill: number) => bytesOf(fill, 0.6 * MB);
        const reads: Record<string, ReturnType<typeof serializedState>[]> = {
            [VAULT]: [serializedState(big(1)), serializedState(big(1))],
            [OTHER]: [serializedState(big(2)), serializedState(big(2))]
        };
        const { reader } = readerOf((address) => reads[address].shift()!.read);
        const [vaultFirst, vaultAgain] = reads[VAULT];
        const [, otherAgain] = reads[OTHER];

        await queryLedger9ContractState(reader, VAULT);
        await queryLedger9ContractState(reader, OTHER);
        // Two states of 0.6 MB do not fit in 1 MB: the vault's went, the other contract's stayed.
        await queryLedger9ContractState(reader, OTHER);
        expect(otherAgain.deserialize).not.toHaveBeenCalled();
        await queryLedger9ContractState(reader, VAULT);
        expect(vaultFirst.deserialize).toHaveBeenCalledTimes(1);
        expect(vaultAgain.deserialize).toHaveBeenCalledTimes(1);
    });

    test('a state larger than the budget is not kept', async () => {
        process.env.NIGHTGATE_STATE_DECODE_CACHE_MB = '1';
        __resetConfigForTests();
        const first = serializedState(bytesOf(1, 1.5 * MB));
        const again = serializedState(bytesOf(1, 1.5 * MB));
        const answers = [first.read, again.read];
        const { reader } = readerOf(() => answers.shift());

        await queryLedger9ContractState(reader, VAULT);
        await queryLedger9ContractState(reader, VAULT);
        expect(again.deserialize).toHaveBeenCalledTimes(1);
    });
});
