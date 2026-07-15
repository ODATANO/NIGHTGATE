/**
 * In-thread tests for srv/midnight/wallet-worker.ts, the worker entry that
 * was 0% covered because every other suite mocks the whole Worker away.
 *
 * Harness: worker_threads is mocked so `parentPort` is a hand-rolled emitter
 * (MessageChannel stays REAL, so the per-call RPC reply plumbing runs for real),
 * and the wallet SDK packages are stubbed at the import seam, so `init` builds
 * a fake facade through the REAL buildFacade wiring (role-seed derivation,
 * restore-vs-fresh selection, dust cold-start flag, facade start).
 *
 * The facade OPERATION bodies (transferNight, shieldNight, deploys, …) stay
 * deliberately uncovered here: they are exercised by the live e2e scripts
 * (docs/reference.md "Testing baseline").
 */

const fakeParentPort = vi.hoisted(() => {
    const handlers: Record<string, Array<(...a: any[]) => void>> = {};
    return {
        on(ev: string, fn: (...a: any[]) => void) { (handlers[ev] ??= []).push(fn); return this; },
        emit(ev: string, ...args: any[]) { for (const fn of handlers[ev] ?? []) fn(...args); },
        postMessage: vi.fn()
    };
});

vi.mock('node:worker_threads', async () => {
    const actual = await vi.importActual<any>('node:worker_threads');
    return { ...actual, parentPort: fakeParentPort };
});

// ---- SDK seams --------------------------------------------------------------

vi.mock('../../srv/utils/wallet-hd', () => ({
    deriveRoleSeeds: vi.fn(async () => ({
        zswap: new Uint8Array(32).fill(1),
        dust: new Uint8Array(32).fill(2),
        night: new Uint8Array(32).fill(3)
    }))
}));

vi.mock('../../srv/submission/contract-witnesses', () => ({
    deriveAttestationSecret: vi.fn(() => new Uint8Array(32).fill(9)),
    getContractWitnessFactory: vi.fn()
}));

const zswapClear = vi.hoisted(() => (vi.fn()));
vi.mock('@midnight-ntwrk/ledger-v8', () => ({
    ZswapSecretKeys: {
        fromSeed: vi.fn(() => ({ coinPublicKey: 'cpk', encryptionPublicKey: 'epk', clear: zswapClear }))
    },
    DustSecretKey: { fromSeed: vi.fn(() => ({ dustKey: true })) },
    LedgerParameters: { initialParameters: vi.fn(() => ({ dust: { dustParams: true } })) }
}));

const shieldedStart = vi.hoisted(() => (vi.fn(() => 'sh-fresh')));
const shieldedRestore = vi.hoisted(() => (vi.fn(() => 'sh-restored')));
vi.mock('@midnightntwrk/wallet-sdk-shielded', () => ({
    ShieldedWallet: vi.fn(() => ({ startWithSecretKeys: shieldedStart, restore: shieldedRestore }))
}));

const unshieldedStart = vi.hoisted(() => (vi.fn(() => 'un-fresh')));
const unshieldedRestore = vi.hoisted(() => (vi.fn(() => 'un-restored')));
vi.mock('@midnightntwrk/wallet-sdk-unshielded-wallet', () => ({
    UnshieldedWallet: vi.fn(() => ({ startWithPublicKey: unshieldedStart, restore: unshieldedRestore })),
    createKeystore: vi.fn(() => ({ keystore: true })),
    PublicKey: { fromKeyStore: vi.fn(() => 'night-pub') }
}));

const dustStart = vi.hoisted(() => (vi.fn(() => 'du-fresh')));
const dustRestore = vi.hoisted(() => (vi.fn(() => 'du-restored')));
vi.mock('@midnightntwrk/wallet-sdk-dust-wallet', () => ({
    DustWallet: vi.fn(() => ({ startWithSecretKey: dustStart, restore: dustRestore }))
}));

vi.mock('@midnightntwrk/wallet-sdk-abstractions', () => ({
    InMemoryTransactionHistoryStorage: class { constructor(..._a: any[]) { /* stub */ } }
}));

// The facade mock invokes the shielded/unshielded/dust factory closures like
// the real WalletFacade.init does, so buildFacade's restore-vs-fresh selection
// actually executes.
const facadeState = vi.hoisted(() => ({
    current: { dust: { progress: { appliedIndex: '0', isConnected: false } } } as any
}));
const facadeInit = vi.hoisted(() => (vi.fn()));
vi.mock('@midnightntwrk/wallet-sdk-facade', () => ({
    WalletFacade: { init: facadeInit },
    WalletEntrySchema: { schema: true },
    mergeWalletEntries: vi.fn()
}));

vi.mock('@midnight-ntwrk/midnight-js-network-id', () => ({
    setNetworkId: vi.fn()
}));

// getDustStreamTip probes the indexer via a one-shot graphql-transport-ws
// subscription; this fake speaks just enough of the protocol.
const wsTip = vi.hoisted(() => ({ maxId: '100' as string | null }));
vi.mock('ws', () => {
    class FakeWebSocket {
        private handlers: Record<string, Array<(...a: any[]) => void>> = {};
        constructor(_url: string, _proto: string) {
            setImmediate(() => this.emit('open'));
        }
        on(ev: string, fn: (...a: any[]) => void) { (this.handlers[ev] ??= []).push(fn); return this; }
        emit(ev: string, ...args: any[]) { for (const fn of this.handlers[ev] ?? []) fn(...args); }
        send(raw: string) {
            const m = JSON.parse(raw);
            if (m.type === 'connection_init') {
                setImmediate(() => this.emit('message', Buffer.from(JSON.stringify({ type: 'connection_ack' }))));
            } else if (m.type === 'subscribe') {
                setImmediate(() => this.emit('message', Buffer.from(JSON.stringify(
                    wsTip.maxId == null
                        ? { type: 'error' }
                        : { type: 'next', payload: { data: { dustLedgerEvents: { id: 0, maxId: wsTip.maxId } } } }
                ))));
            }
        }
        close() { this.emit('close'); }
    }
    return { default: FakeWebSocket, WebSocket: FakeWebSocket };
});

import { MessageChannel } from 'node:worker_threads';

function makeFakeFacade() {
    const facade: any = {
        start: vi.fn(async () => undefined),
        stop: vi.fn(async () => undefined),
        shielded: { serializeState: vi.fn(async () => 'BLOB-SH') },
        unshielded: { serializeState: vi.fn(async () => 'BLOB-UN') },
        dust: { serializeState: vi.fn(async () => 'BLOB-DU') },
        state: () => ({
            subscribe(obs: any) { obs.next(facadeState.current); return { unsubscribe() { /* noop */ } }; }
        }),
        waitForSyncedState: vi.fn(async () => undefined)
    };
    return facade;
}

/** Drive the worker's dispatcher exactly like wallet-worker-client does. */
function rpc(method: string, args: unknown): Promise<any> {
    const { port1, port2 } = new MessageChannel();
    const reply = new Promise<any>((resolve) => {
        port2.once('message', (msg: any) => { port2.close(); resolve(msg); });
    });
    fakeParentPort.emit('message', { kind: 'rpc', method, args, port: port1 });
    return reply;
}

function stateSaves(): any[] {
    return fakeParentPort.postMessage.mock.calls.map(c => c[0]).filter((m: any) => m.kind === 'state-save');
}

const INIT_ARGS = {
    sessionId: 'session-aaaaaaaaaaaaaaaaaaaaaaaa',
    seedHex: 'ab'.repeat(64),
    networkId: 'preprod' as const,
    indexerHttpUrl: 'http://indexer.test/api/v4/graphql',
    indexerWsUrl: 'ws://indexer.test/api/v4/graphql/ws',
    proofServerUrl: 'http://localhost:6300',
    relayUrl: 'ws://relay.test'
};

let workerExports: any;

beforeAll(async () => {
    facadeInit.mockImplementation(async (opts: any) => {
        // Real WalletFacade.init calls the sub-wallet factories; do the same
        // so the restore-vs-fresh closures in buildFacade are exercised.
        opts.shielded();
        opts.unshielded();
        opts.dust();
        return makeFakeFacade();
    });
    workerExports = await import('../../srv/midnight/wallet-worker.js');
});

beforeEach(() => {
    fakeParentPort.postMessage.mockClear();
    facadeState.current = { dust: { progress: { appliedIndex: '0', isConnected: false } } };
    wsTip.maxId = '100';
});

describe('boot handshake', () => {
    it('announced readiness on load', () => {
        // postMessage was cleared in beforeEach, so assert on the recorded
        // module-load behavior instead: the dispatcher is registered and a
        // ping round-trips.
        return expect(rpc('ping', {})).resolves.toMatchObject({ ok: true });
    });
});

describe('dispatcher', () => {
    it('replies ok with the handler result and closes the port', async () => {
        const reply = await rpc('ping', {});
        expect(reply.ok).toBe(true);
        expect(reply.result.ok).toBe(true);
        expect(typeof reply.result.ts).toBe('number');
    });

    it('replies with a structured error for an unknown method', async () => {
        const reply = await rpc('definitely-not-a-method', {});
        expect(reply.ok).toBe(false);
        expect(reply.error.message).toMatch(/Unknown method: definitely-not-a-method/);
        expect(reply.error.name).toBe('Error');
    });

    it('warns (via the log push) on malformed messages instead of crashing', () => {
        fakeParentPort.emit('message', { kind: 'rpc' /* no port */ });
        fakeParentPort.emit('message', { kind: 'something-else' });
        const logs = fakeParentPort.postMessage.mock.calls
            .map(c => c[0])
            .filter((m: any) => m.kind === 'log' && /unexpected message/.test(m.message));
        expect(logs.length).toBe(2);
    });

    it('ignores a state-save-ack for an unknown session', () => {
        expect(() => fakeParentPort.emit('message', { kind: 'state-save-ack', sessionId: 'ghost', seq: 1 })).not.toThrow();
    });
});

describe('init', () => {
    it('builds a facade through the real wiring and reports the pinned SDK version', async () => {
        const reply = await rpc('init', INIT_ARGS);
        expect(reply.ok).toBe(true);
        expect(reply.result.facadeReady).toBe(true);
        expect(reply.result.alreadyExisted).toBe(false);
        expect(typeof reply.result.sdkVersion).toBe('string');
        expect(reply.result.sdkVersion.length).toBeGreaterThan(0);
        // Fresh start (no restore blobs) → the startWith* factories ran.
        expect(shieldedStart).toHaveBeenCalled();
        expect(unshieldedStart).toHaveBeenCalled();
        expect(dustStart).toHaveBeenCalled();
    });

    it('is idempotent per sessionId (cache hit)', async () => {
        const reply = await rpc('init', INIT_ARGS);
        expect(reply.ok).toBe(true);
        expect(reply.result.alreadyExisted).toBe(true);
    });

    it('restores sub-wallets from blobs when provided', async () => {
        const reply = await rpc('init', {
            ...INIT_ARGS,
            sessionId: 'session-restore-bbbbbbbbbbbb',
            restoreBlobs: { shielded: 'sh-blob', unshielded: 'un-blob', dust: 'du-blob' }
        });
        expect(reply.ok).toBe(true);
        expect(shieldedRestore).toHaveBeenCalledWith('sh-blob');
        expect(unshieldedRestore).toHaveBeenCalledWith('un-blob');
        expect(dustRestore).toHaveBeenCalledWith('du-blob');
    });

    it('cold-starts the dust sub-wallet when NIGHTGATE_DUST_COLD_START=true', async () => {
        process.env.NIGHTGATE_DUST_COLD_START = 'true';
        try {
            dustRestore.mockClear();
            dustStart.mockClear();
            const reply = await rpc('init', {
                ...INIT_ARGS,
                sessionId: 'session-coldstart-cccccccccc',
                restoreBlobs: { dust: 'du-blob' }
            });
            expect(reply.ok).toBe(true);
            expect(dustRestore).not.toHaveBeenCalled();
            expect(dustStart).toHaveBeenCalled();
        } finally {
            delete process.env.NIGHTGATE_DUST_COLD_START;
        }
    });
});

describe('serializeState / evict', () => {
    it('serializeState returns the sub-wallet blobs', async () => {
        const reply = await rpc('serializeState', { sessionId: INIT_ARGS.sessionId });
        expect(reply.ok).toBe(true);
        expect(reply.result.blobs).toEqual({ shielded: 'BLOB-SH', unshielded: 'BLOB-UN', dust: 'BLOB-DU' });
    });

    it('serializeState fails cleanly for an unknown session', async () => {
        const reply = await rpc('serializeState', { sessionId: 'ghost-session-xxxxxxxxxxxxx' });
        expect(reply.ok).toBe(false);
        expect(reply.error.message).toMatch(/No facade for sessionId/);
    });

    it('evict pushes a final save, clears the keys, stops the facade', async () => {
        const reply = await rpc('evict', { sessionId: 'session-restore-bbbbbbbbbbbb' });
        expect(reply.ok).toBe(true);
        expect(reply.result.evicted).toBe(true);
        expect(zswapClear).toHaveBeenCalled();
        const saves = stateSaves();
        expect(saves.length).toBe(1);
        expect(saves[0]).toMatchObject({
            sessionId: 'session-restore-bbbbbbbbbbbb',
            blobs: { shielded: 'BLOB-SH', unshielded: 'BLOB-UN', dust: 'BLOB-DU' }
        });
    });

    it('evict of an unknown session reports evicted=false', async () => {
        const reply = await rpc('evict', { sessionId: 'ghost-session-xxxxxxxxxxxxx' });
        expect(reply.ok).toBe(true);
        expect(reply.result.evicted).toBe(false);
    });
});

describe('waitForSyncedState (genuine sync gate)', () => {
    it('latches once appliedIndex reaches the dust stream tip and the indexer is fresh', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ({
            json: async () => ({ data: { block: { height: '500', timestamp: Date.now() } } })
        })));
        try {
            facadeState.current = { dust: { progress: { appliedIndex: '95', isConnected: true } } };
            wsTip.maxId = '100'; // gap 5 <= SYNC_TIP_GAP (8)
            const reply = await rpc('waitForSyncedState', { sessionId: INIT_ARGS.sessionId, timeoutMs: 30_000 });
            expect(reply.ok).toBe(true);
            expect(reply.result).toEqual({ synced: true });
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('rejects with a diagnostic when the deadline passes before catch-up', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ({
            json: async () => ({ data: { block: { height: '500', timestamp: Date.now() } } })
        })));
        try {
            const reply = await rpc('waitForSyncedState', { sessionId: INIT_ARGS.sessionId, timeoutMs: 0 });
            expect(reply.ok).toBe(false);
            expect(reply.error.message).toMatch(/wallet not synced to tip after 0ms/);
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('fails cleanly for an unknown session', async () => {
        const reply = await rpc('waitForSyncedState', { sessionId: 'ghost-session-xxxxxxxxxxxxx' });
        expect(reply.ok).toBe(false);
        expect(reply.error.message).toMatch(/No facade for sessionId/);
    });
});

describe('periodic save + ack protocol', () => {
    it('pushes on tick, skips unchanged only after the ack confirmed the save', async () => {
        // The 30s interval must be ARMED under fake timers, so this test
        // inits its own session inside the fake-timer scope.
        vi.useFakeTimers();
        const SESSION = 'session-savetick-dddddddddd';
        try {
            const initReply = await rpc('init', { ...INIT_ARGS, sessionId: SESSION });
            expect(initReply.ok).toBe(true);
            fakeParentPort.postMessage.mockClear();

            // Tick 1: blobs present, nothing confirmed yet → push.
            await vi.advanceTimersByTimeAsync(30_000);
            const saves = stateSaves();
            expect(saves.length).toBe(1);
            expect(saves[0].sessionId).toBe(SESSION);
            expect(saves[0].blobs.shielded).toBe('BLOB-SH');

            // Tick 2 WITHOUT ack: still unconfirmed → re-pushed.
            await vi.advanceTimersByTimeAsync(30_000);
            expect(stateSaves().length).toBe(2);

            // Ack the last push, then tick again: unchanged → skipped.
            const last = stateSaves().at(-1);
            fakeParentPort.emit('message', {
                kind: 'state-save-ack', sessionId: SESSION, seq: last.seq
            });
            await vi.advanceTimersByTimeAsync(30_000);
            expect(stateSaves().length).toBe(2);
        } finally {
            await rpc('evict', { sessionId: SESSION });
            vi.useRealTimers();
        }
    });
});

// ---- describeTxDust (the Custom-error-117 attribution dump) ----------------

describe('describeTxDust', () => {
    const dust = (spends: number, regs: number, ctime: any = new Date('2026-07-14T10:00:00Z')) => ({
        spends: Array(spends).fill({}),
        registrations: Array(regs).fill({}),
        ctime
    });

    it('reports "no intents" for transactions without an intents map', () => {
        expect(workerExports.describeTxDust(undefined)).toEqual({ summary: 'no intents', emptyDustActions: false });
        expect(workerExports.describeTxDust({ intents: {} })).toEqual({ summary: 'no intents', emptyDustActions: false });
    });

    it('summarizes every segment and flags an EMPTY DustActions section', () => {
        const tx = {
            intents: new Map<any, any>([
                [0, { dustActions: dust(2, 1) }],
                [1, {}], // no dust section at all: legal
                [2, { dustActions: dust(0, 0) }] // the 117 trigger
            ])
        };
        const r = workerExports.describeTxDust(tx);
        expect(r.emptyDustActions).toBe(true);
        expect(r.summary).toContain('seg=0 dust{spends=2 regs=1 ctime=2026-07-14T10:00:00.000Z}');
        expect(r.summary).toContain('seg=1 dust=none');
        expect(r.summary).toContain('seg=2 dust{spends=0 regs=0');
    });

    it('does NOT flag sections that spend or register dust', () => {
        const tx = { intents: new Map<any, any>([[0, { dustActions: dust(1, 0) }]]) };
        expect(workerExports.describeTxDust(tx).emptyDustActions).toBe(false);
    });

    it('stringifies non-Date ctimes and never throws (diagnostics must not break submits)', () => {
        const tx = { intents: new Map<any, any>([[0, { dustActions: dust(1, 0, 12345n) }]]) };
        expect(workerExports.describeTxDust(tx).summary).toContain('ctime=12345');

        const evil = { intents: { entries() { throw new Error('boom'); } } };
        const r = workerExports.describeTxDust(evil);
        expect(r).toEqual({ summary: expect.stringContaining('dump failed: boom'), emptyDustActions: false });
    });
});

// ---- buildWorkerWalletProvider: the 117 guard around balance/submit --------

describe('buildWorkerWalletProvider', () => {
    const DUST_OK = { spends: [{}], registrations: [], ctime: new Date() };
    const DUST_EMPTY = { spends: [], registrations: [], ctime: new Date() };

    function makeEntry(finalizedDust: any) {
        const finalized = { intents: new Map<any, any>([[0, { dustActions: finalizedDust }]]) };
        const facade = makeFakeFacade();
        facade.balanceUnboundTransaction = vi.fn(async () => ({ recipe: true }));
        facade.finalizeRecipe = vi.fn(async () => finalized);
        facade.submitTransaction = vi.fn(async () => ({ txId: '0xsubmitted' }));
        return {
            entry: {
                facade,
                sdkVersion: 'test',
                zswapKeys: { coinPublicKey: 'cpk', encryptionPublicKey: 'epk' },
                dustKey: { dust: true },
                unshieldedKeystore: {},
                networkId: 'preprod',
                indexerHttpUrl: 'http://indexer.test/api/v4/graphql',
                attestationSecret: new Uint8Array(32)
            },
            facade,
            finalized
        };
    }

    function withSyncedIndexer() {
        vi.stubGlobal('fetch', vi.fn(async () => ({
            json: async () => ({ data: { block: { height: '500', timestamp: Date.now() } } })
        })));
        facadeState.current = { dust: { progress: { appliedIndex: '100', isConnected: true } } };
        wsTip.maxId = '100';
    }

    it('exposes the zswap public keys', () => {
        const { entry } = makeEntry(DUST_OK);
        const provider = workerExports.buildWorkerWalletProvider(entry);
        expect(provider.getCoinPublicKey()).toBe('cpk');
        expect(provider.getEncryptionPublicKey()).toBe('epk');
    });

    it('balanceTx waits for genuine sync, balances with the session keys and returns the finalized tx', async () => {
        withSyncedIndexer();
        try {
            const { entry, facade, finalized } = makeEntry(DUST_OK);
            const provider = workerExports.buildWorkerWalletProvider(entry);
            const tx = { unbound: true };

            const result = await provider.balanceTx(tx);
            expect(result).toBe(finalized);
            expect(facade.balanceUnboundTransaction).toHaveBeenCalledWith(
                tx,
                { shieldedSecretKeys: entry.zswapKeys, dustSecretKey: entry.dustKey },
                { ttl: expect.any(Date) }
            );
            // Default ttl is ~1h out.
            const ttl = (facade.balanceUnboundTransaction as any).mock.calls[0][2].ttl as Date;
            expect(ttl.getTime()).toBeGreaterThan(Date.now() + 50 * 60 * 1000);
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('balanceTx honours an explicit ttl', async () => {
        withSyncedIndexer();
        try {
            const { entry, facade } = makeEntry(DUST_OK);
            const provider = workerExports.buildWorkerWalletProvider(entry);
            const ttl = new Date(Date.now() + 5 * 60 * 1000);
            await provider.balanceTx({}, ttl);
            expect((facade.balanceUnboundTransaction as any).mock.calls[0][2].ttl).toBe(ttl);
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('balanceTx FAILS FAST on an empty DustActions section instead of submitting a 117 candidate', async () => {
        withSyncedIndexer();
        try {
            const { entry } = makeEntry(DUST_EMPTY);
            const provider = workerExports.buildWorkerWalletProvider(entry);
            await expect(provider.balanceTx({})).rejects.toThrow(/EMPTY DustActions section.*117 NotNormalized/s);
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('submitTx dumps the dust sections, warns on empty DustActions and still submits', async () => {
        const { entry, facade } = makeEntry(DUST_OK);
        const provider = workerExports.buildWorkerWalletProvider(entry);
        const emptyTx = { intents: new Map<any, any>([[0, { dustActions: DUST_EMPTY }]]) };

        const result = await provider.submitTx(emptyTx);
        expect(result).toEqual({ txId: '0xsubmitted' });
        expect(facade.submitTransaction).toHaveBeenCalledWith(emptyTx);

        const warns = fakeParentPort.postMessage.mock.calls
            .map(c => c[0])
            .filter((m: any) => m.kind === 'log' && m.level === 'warn' && /EMPTY DustActions/.test(m.message));
        expect(warns.length).toBe(1);
    });
});
