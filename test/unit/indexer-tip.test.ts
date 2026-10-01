import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A graphql-transport-ws fake: answers the blocks subscription from `wsTip.block`,
// a ledger-event stream from `wsTip.maxId`; null = error frame.
const wsTip = vi.hoisted(() => ({
    maxId: '100' as string | null,
    block: null as { height: string; timestamp: number } | null,
    opened: 0
}));
vi.mock('ws', () => {
    class FakeWebSocket {
        private handlers: Record<string, Array<(...a: any[]) => void>> = {};
        constructor(_url: string, _proto: string) {
            wsTip.opened += 1;
            setImmediate(() => this.emit('open'));
        }
        on(ev: string, fn: (...a: any[]) => void) { (this.handlers[ev] ??= []).push(fn); return this; }
        emit(ev: string, ...args: any[]) { for (const fn of this.handlers[ev] ?? []) fn(...args); }
        send(raw: string) {
            const m = JSON.parse(raw);
            if (m.type === 'connection_init') {
                setImmediate(() => this.emit('message', Buffer.from(JSON.stringify({ type: 'connection_ack' }))));
            } else if (m.type === 'subscribe') {
                const field = /subscription \{ (\w+)/.exec(String(m.payload?.query))?.[1] ?? 'dustLedgerEvents';
                const answer = field === 'blocks'
                    ? (wsTip.block == null ? { type: 'error' } : { type: 'next', payload: { data: { blocks: wsTip.block } } })
                    : (wsTip.maxId == null ? { type: 'error' } : { type: 'next', payload: { data: { [field]: { id: 0, maxId: wsTip.maxId } } } });
                setImmediate(() => this.emit('message', Buffer.from(JSON.stringify(answer))));
            }
        }
        close() { this.emit('close'); }
    }
    return { default: FakeWebSocket, WebSocket: FakeWebSocket };
});

import { getDustStreamTip, getIndexerTip, indexerTipCache, streamTipCache } from '../../srv/midnight/worker/facades';

const URL = 'https://indexer.example/api/v4/graphql';

function stubHttpTip(timestampMs: number, height = '500') {
    vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => ({ data: { block: { height, timestamp: timestampMs } } }) })));
}
function stubHttpRefused(status = 403) {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status, json: async () => { throw new SyntaxError('Unexpected token <'); } })));
}
function stubHttpTimeout() {
    vi.stubGlobal('fetch', vi.fn(async () => { throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }); }));
}

describe('getIndexerTip', () => {
    beforeEach(() => { indexerTipCache.clear(); wsTip.block = null; wsTip.opened = 0; });
    afterEach(() => { vi.unstubAllGlobals(); delete process.env.NIGHTGATE_INDEXER_TIP_GRACE_MS; });

    it('answers from the HTTP query without opening a subscription', async () => {
        const now = Date.now();
        stubHttpTip(now, '500');
        const tip = await getIndexerTip(URL);
        expect(tip).toEqual({ height: 500n, timestampMs: now, error: null, via: 'http' });
        expect(wsTip.opened).toBe(0);
    });

    // The HTTP query and the subscription fail independently at the indexer's edge.
    it('falls back to the blocks subscription when the HTTP query is refused', async () => {
        const now = Date.now();
        stubHttpRefused(503);
        wsTip.block = { height: '501', timestamp: now };
        const tip = await getIndexerTip(URL);
        expect(tip).toEqual({ height: 501n, timestampMs: now, error: null, via: 'ws' });
        expect(wsTip.opened).toBe(1);
    });

    it('reuses the last successful read within the grace window, naming this read\'s failure', async () => {
        const earlier = Date.now() - 20_000;
        stubHttpTip(earlier, '500');
        await getIndexerTip(URL);
        stubHttpTimeout();
        const tip = await getIndexerTip(URL);
        expect(tip).toEqual({ height: 500n, timestampMs: earlier, error: 'timeout', via: 'cached' });
    });

    it('reports the failure once the cached read has aged out of the grace window or grace is off', async () => {
        stubHttpTip(Date.now(), '500');
        await getIndexerTip(URL);
        indexerTipCache.set(URL, { tip: indexerTipCache.get(URL)!.tip, at: Date.now() - 181_000 });
        stubHttpRefused(403);
        expect(await getIndexerTip(URL)).toEqual({ height: null, timestampMs: null, error: 'HTTP 403', via: null });

        stubHttpTip(Date.now(), '500');
        await getIndexerTip(URL);
        process.env.NIGHTGATE_INDEXER_TIP_GRACE_MS = '0';
        stubHttpTimeout();
        expect(await getIndexerTip(URL)).toEqual({ height: null, timestampMs: null, error: 'timeout', via: null });
    });

    // The progress tick reads the stream tip and the block tip concurrently.
    it('falls back to the subscription while a stream-tip read is in flight', async () => {
        streamTipCache.clear();
        stubHttpRefused(503);
        wsTip.block = { height: '501', timestamp: Date.now() };
        const [streamTip, tip] = await Promise.all([getDustStreamTip(URL), getIndexerTip(URL)]);
        expect(streamTip).toBe(100n);
        expect(tip).toMatchObject({ height: 501n, error: null, via: 'ws' });
    });

    it('a fallback read never refreshes the cache', async () => {
        const earlier = Date.now() - 20_000;
        stubHttpTip(earlier, '500');
        await getIndexerTip(URL);
        const at = indexerTipCache.get(URL)!.at;
        stubHttpTimeout();
        await getIndexerTip(URL);
        expect(indexerTipCache.get(URL)!.at).toBe(at);
        wsTip.block = { height: '502', timestamp: Date.now() };
        const viaWs = await getIndexerTip(URL);
        expect(viaWs.via).toBe('ws');
        expect(indexerTipCache.get(URL)!.tip.height).toBe(502n);
    });
});
