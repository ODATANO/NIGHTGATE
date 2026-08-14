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
 * The facade OPERATION bodies (transferNight, deploys, …) stay
 * deliberately uncovered here: they are exercised by the live e2e scripts
 * (docs/reference.md "Testing baseline").
 */

// In-memory private-state store answering the worker's private-state-rpc
// messages (normally served by the main thread's CapDbPrivateStateProvider).
const privateState = vi.hoisted(() => ({
    store: {} as Record<string, unknown>,
    calls: [] as Array<{ method: string; args: unknown[] }>
}));

const fakeParentPort = vi.hoisted(() => {
    const handlers: Record<string, Array<(...a: any[]) => void>> = {};
    return {
        on(ev: string, fn: (...a: any[]) => void) { (handlers[ev] ??= []).push(fn); return this; },
        emit(ev: string, ...args: any[]) { for (const fn of handlers[ev] ?? []) fn(...args); },
        postMessage: vi.fn((msg: any) => {
            if (msg?.kind !== 'private-state-rpc') return;
            privateState.calls.push({ method: msg.method, args: msg.args });
            if (!msg.port) return; // fire-and-forget (setContractAddress)
            if (msg.method === 'get') {
                msg.port.postMessage({ ok: true, result: privateState.store[String(msg.args[0])] });
            } else if (msg.method === 'set') {
                privateState.store[String(msg.args[0])] = msg.args[1];
                msg.port.postMessage({ ok: true, result: undefined });
            } else {
                msg.port.postMessage({ ok: true, result: undefined });
            }
        })
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
    LedgerParameters: { initialParameters: vi.fn(() => ({ dust: { dustParams: true } })) },
    nativeToken: vi.fn(() => ({ raw: 'night-raw-type' }))
}));

// Receiver-address parsing + address encoding go through the real
// parseReceiverAddress/encodeAddressString; only the SDK codec is stubbed.
vi.mock('@midnightntwrk/wallet-sdk-address-format', () => ({
    MidnightBech32m: {
        parse: vi.fn((s: string) => ({ decode: vi.fn(() => ({ decoded: s })) })),
        encode: vi.fn((_net: string, addr: any) => ({ toString: () => `enc:${JSON.stringify(addr)}` }))
    },
    ShieldedAddress: class {},
    UnshieldedAddress: class {},
    DustAddress: class {}
}));

// Contract-path SDK seams (loadContractsSdk + buildWorkerContractProviders).
const findDeployedContract = vi.hoisted(() => (vi.fn()));
vi.mock('@midnight-ntwrk/midnight-js-contracts', () => ({ findDeployedContract }));
// Query methods findDeployedContract hits per call; tracked so the
// withFindContractQueryCache tests can count underlying indexer fetches.
const publicDataMethods = vi.hoisted(() => ({
    watchForDeployTxData: vi.fn(async () => ({ deployTxData: true })),
    queryDeployContractState: vi.fn(async () => ({ deployState: true })),
    queryContractState: vi.fn(async () => ({ currentState: true })),
    queryZSwapAndContractState: vi.fn(async () => ({ zswapAndState: true }))
}));
vi.mock('@midnight-ntwrk/midnight-js-indexer-public-data-provider', () => ({
    indexerPublicDataProvider: vi.fn(() => ({ tag: 'publicData', ...publicDataMethods }))
}));
const proveTxMock = vi.hoisted(() => (vi.fn(async () => ({ proven: true }))));
const httpClientProofProvider = vi.hoisted(() => (vi.fn(() => ({ tag: 'http-proof', proveTx: proveTxMock }))));
vi.mock('@midnight-ntwrk/midnight-js-http-client-proof-provider', () => ({ httpClientProofProvider }));
vi.mock('@midnight-ntwrk/midnight-js-node-zk-config-provider', () => ({
    NodeZkConfigProvider: vi.fn().mockImplementation(function (dir: string) { return { tag: 'zkConfig', directory: dir }; } as any)
}));
vi.mock('@midnight-ntwrk/compact-js', () => ({
    CompiledContract: {
        make: vi.fn(() => ({ pipe: vi.fn(() => ({ compiled: true })) })),
        withVacantWitnesses: vi.fn(),
        withWitnesses: vi.fn(() => vi.fn()),
        withCompiledFileAssets: vi.fn(() => vi.fn())
    }
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
    createKeystore: vi.fn(() => ({
        keystore: true,
        signData: vi.fn(() => 'night-signature'),
        getPublicKey: vi.fn(() => 'night-verifying-key')
    })),
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

const makeWasmProvingService = vi.hoisted(() => (vi.fn((..._args: any[]) => ({ wasmProver: true }))));
vi.mock('@midnightntwrk/wallet-sdk-capabilities/proving', () => ({
    makeWasmProvingService
}));

// wasm mode shares one key-material provider via wasm-proof-provider's
// loadDeps; stub its ESM imports so no real SDK loads in unit tests.
vi.mock('@midnight-ntwrk/zkir-v2', () => ({ provingProvider: vi.fn(() => ({})) }));
vi.mock('@midnight-ntwrk/midnight-js-types', () => ({ zkConfigToProvingKeyMaterial: vi.fn() }));
const sharedKeyProvider = vi.hoisted(() => ({ lookupKey: vi.fn(), getParams: vi.fn() }));
vi.mock('@midnightntwrk/wallet-sdk-prover-client/effect', () => ({
    WasmProver: { makeDefaultKeyMaterialProvider: () => sharedKeyProvider }
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
import path from 'node:path';

function makeFakeFacade() {
    const facade: any = {
        start: vi.fn(async () => undefined),
        stop: vi.fn(async () => undefined),
        shielded: { serializeState: vi.fn(async () => 'BLOB-SH') },
        unshielded: { serializeState: vi.fn(async () => 'BLOB-UN') },
        dust: { serializeState: vi.fn(async () => 'BLOB-DU'), getAddress: vi.fn(async () => 'mn_dust_own_address') },
        state: () => ({
            subscribe(obs: any) { obs.next(facadeState.current); return { unsubscribe() { /* noop */ } }; }
        }),
        waitForSyncedState: vi.fn(async () => undefined),
        revert: vi.fn(async () => undefined),
        transferTransaction: vi.fn(async () => ({ type: 'UNPROVEN_TRANSACTION', transaction: { unproven: true } })),
        signRecipe: vi.fn(async (r: any) => r),
        finalizeRecipe: vi.fn(async () => ({ finalized: true })),
        submitTransaction: vi.fn(async () => 'tx-hash-fixture'),
        calculateTransactionFee: vi.fn(async () => 42n),
        registerNightUtxosForDustGeneration: vi.fn(async () => ({ type: 'RECIPE', transaction: { reg: true } })),
        deregisterFromDustGeneration: vi.fn(async () => ({ transaction: { dereg: true } })),
        balanceUnprovenTransaction: vi.fn(async () => ({ balanced: true }))
    };
    return facade;
}

/** Init a fresh session and hand back its fake facade for stubbing. */
async function initSession(sessionId: string) {
    const reply = await rpc('init', { ...INIT_ARGS, sessionId });
    expect(reply.ok).toBe(true);
    const facade = await facadeInit.mock.results.at(-1)!.value;
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

/**
 * The dust-restore path awaits the main thread's state-save ack. Emit that
 * ack synchronously for dust-bearing pushes (like a healthy persist layer
 * would, just faster); returns an undo function.
 */
function autoAckDustSaves(): () => void {
    const base = fakeParentPort.postMessage.getMockImplementation()!;
    fakeParentPort.postMessage.mockImplementation((m: any) => {
        base(m);
        if (m?.kind === 'state-save' && m.blobs?.dust) {
            fakeParentPort.emit('message', { kind: 'state-save-ack', sessionId: m.sessionId, seq: m.seq });
        }
    });
    return () => fakeParentPort.postMessage.mockImplementation(base);
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
        // cheap RPC (evict of an unknown session) round-trips.
        return expect(rpc('evict', { sessionId: 'ghost-boot-check' })).resolves.toMatchObject({ ok: true });
    });
});

describe('dispatcher', () => {
    it('replies ok with the handler result and closes the port', async () => {
        const reply = await rpc('evict', { sessionId: 'ghost-dispatcher-check' });
        expect(reply.ok).toBe(true);
        expect(reply.result.evicted).toBe(false);
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

    it('passes no provingService by default (facade uses its server prover)', async () => {
        facadeInit.mockClear();
        const reply = await rpc('init', { ...INIT_ARGS, sessionId: 'session-provedefault-dddddd' });
        expect(reply.ok).toBe(true);
        expect(facadeInit.mock.calls[0][0].provingService).toBeUndefined();
    });

    it('NIGHTGATE_PROVING_MODE=wasm passes a provingService that builds the WASM prover with the SHARED key provider', async () => {
        process.env.NIGHTGATE_PROVING_MODE = 'wasm';
        try {
            facadeInit.mockClear();
            makeWasmProvingService.mockClear();
            const reply = await rpc('init', { ...INIT_ARGS, sessionId: 'session-provewasm-eeeeeeee' });
            expect(reply.ok).toBe(true);
            const provingService = facadeInit.mock.calls[0][0].provingService;
            expect(typeof provingService).toBe('function');
            expect(provingService()).toEqual({ wasmProver: true });
            // The per-worker shared key provider must be passed, otherwise the
            // SDK builds a fresh S3 cache per session.
            expect(makeWasmProvingService).toHaveBeenCalledWith({ keyMaterialProvider: sharedKeyProvider });
        } finally {
            delete process.env.NIGHTGATE_PROVING_MODE;
        }
    });

    it('an unknown NIGHTGATE_PROVING_MODE falls back to server and warns', async () => {
        process.env.NIGHTGATE_PROVING_MODE = 'gpu';
        try {
            facadeInit.mockClear();
            const reply = await rpc('init', { ...INIT_ARGS, sessionId: 'session-provebogus-ffffff' });
            expect(reply.ok).toBe(true);
            expect(facadeInit.mock.calls[0][0].provingService).toBeUndefined();
            const warns = fakeParentPort.postMessage.mock.calls
                .map(c => c[0])
                .filter((m: any) => m.kind === 'log' && m.level === 'warn' && /NIGHTGATE_PROVING_MODE 'gpu'/.test(m.message));
            expect(warns.length).toBe(1);
        } finally {
            delete process.env.NIGHTGATE_PROVING_MODE;
        }
    });
});

describe('evict', () => {
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

    it('pushes only changed sub-blobs and merges partial acks into the confirmed state', async () => {
        vi.useFakeTimers();
        const SESSION = 'session-partial-eeeeeeeeee';
        try {
            const facade = await initSession(SESSION);
            fakeParentPort.postMessage.mockClear();

            // Tick 1: nothing confirmed yet → the full triple goes out. Ack it.
            await vi.advanceTimersByTimeAsync(30_000);
            expect(stateSaves().length).toBe(1);
            expect(stateSaves()[0].blobs).toEqual({
                shielded: 'BLOB-SH', unshielded: 'BLOB-UN', dust: 'BLOB-DU'
            });
            fakeParentPort.emit('message', {
                kind: 'state-save-ack', sessionId: SESSION, seq: stateSaves()[0].seq
            });

            // Only dust changes (the steady-state case) → the push must carry
            // dust alone, shielded/unshielded stay preserved server-side.
            facade.dust.serializeState.mockResolvedValue('BLOB-DU-2');
            await vi.advanceTimersByTimeAsync(30_000);
            expect(stateSaves().length).toBe(2);
            expect(stateSaves()[1].blobs).toEqual({ dust: 'BLOB-DU-2' });

            // Ack the dust-only push: the merge must keep shielded/unshielded
            // confirmed, so the next unchanged tick pushes NOTHING.
            fakeParentPort.emit('message', {
                kind: 'state-save-ack', sessionId: SESSION, seq: stateSaves()[1].seq
            });
            await vi.advanceTimersByTimeAsync(30_000);
            expect(stateSaves().length).toBe(2);
        } finally {
            await rpc('evict', { sessionId: SESSION });
            vi.useRealTimers();
        }
    });

    it('evict pushes only sub-blobs not yet confirmed saved', async () => {
        vi.useFakeTimers();
        const SESSION = 'session-evictdiff-ffffffff';
        try {
            const facade = await initSession(SESSION);
            fakeParentPort.postMessage.mockClear();

            // Confirm the full triple, then let only dust move on.
            await vi.advanceTimersByTimeAsync(30_000);
            fakeParentPort.emit('message', {
                kind: 'state-save-ack', sessionId: SESSION, seq: stateSaves()[0].seq
            });
            facade.dust.serializeState.mockResolvedValue('BLOB-DU-FINAL');
            const before = stateSaves().length;

            const reply = await rpc('evict', { sessionId: SESSION });
            expect(reply.ok).toBe(true);
            expect(reply.result.evicted).toBe(true);
            const finalSave = stateSaves().at(-1);
            expect(stateSaves().length).toBe(before + 1);
            expect(finalSave.blobs).toEqual({ dust: 'BLOB-DU-FINAL' });
        } finally {
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

// ---- revertRecipeBestEffort / feeOfDiscardedRecipe: the bug_002 guards -----

describe('revertRecipeBestEffort / feeOfDiscardedRecipe', () => {
    function warns(): string[] {
        return fakeParentPort.postMessage.mock.calls
            .map(c => c[0])
            .filter((m: any) => m.kind === 'log' && m.level === 'warn')
            .map((m: any) => m.message);
    }

    it('feeOfDiscardedRecipe prices via calculateTransactionFee (NOT the hang-prone estimateTransactionFee) and ALWAYS reverts', async () => {
        const facade = makeFakeFacade();
        facade.calculateTransactionFee = vi.fn(async () => 42n);
        facade.estimateTransactionFee = vi.fn(async () => { throw new Error('must not be called: uncapped runSync loop'); });
        const recipe = { type: 'UNPROVEN_TRANSACTION', transaction: { tx: true } };

        const fee = await workerExports.feeOfDiscardedRecipe(facade, recipe, 'test-site');
        expect(fee).toBe(42n);
        expect(facade.calculateTransactionFee).toHaveBeenCalledWith(recipe.transaction);
        expect(facade.estimateTransactionFee).not.toHaveBeenCalled();
        expect(facade.revert).toHaveBeenCalledWith(recipe);
    });

    it('feeOfDiscardedRecipe reverts the recipe even when the fee computation fails', async () => {
        const facade = makeFakeFacade();
        facade.calculateTransactionFee = vi.fn(async () => { throw new Error('fee boom'); });
        const recipe = { type: 'UNPROVEN_TRANSACTION', transaction: {} };

        await expect(workerExports.feeOfDiscardedRecipe(facade, recipe, 'test-site')).rejects.toThrow('fee boom');
        expect(facade.revert).toHaveBeenCalledWith(recipe);
    });

    it('revertRecipeBestEffort swallows revert failures with a warn (revert must never mask the original error)', async () => {
        const facade = makeFakeFacade();
        facade.revert = vi.fn(async () => { throw new Error('revert boom'); });

        await expect(workerExports.revertRecipeBestEffort(facade, { recipe: true }, 'test-site')).resolves.toBeUndefined();
        expect(warns().some(m => /test-site: recipe revert failed.*revert boom/.test(m))).toBe(true);
    });

    it('revertRecipeBestEffort no-ops on a missing recipe', async () => {
        const facade = makeFakeFacade();
        await workerExports.revertRecipeBestEffort(facade, undefined, 'test-site');
        expect(facade.revert).not.toHaveBeenCalled();
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
                sessionId: 'session-provider-test-aaaaaa',
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

    it('balanceTx FAILS FAST on an empty DustActions section instead of submitting a 117 candidate, and reverts the dead finalized tx', async () => {
        withSyncedIndexer();
        try {
            const { entry, facade, finalized } = makeEntry(DUST_EMPTY);
            const provider = workerExports.buildWorkerWalletProvider(entry);
            await expect(provider.balanceTx({})).rejects.toThrow(/EMPTY DustActions section.*117 NotNormalized/s);
            expect(facade.revert).toHaveBeenCalledWith(finalized);
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('balanceTx reverts the recipe when finalizeRecipe fails (base-tx coins would stay pending otherwise)', async () => {
        withSyncedIndexer();
        try {
            const { entry, facade } = makeEntry(DUST_OK);
            facade.finalizeRecipe = vi.fn(async () => { throw new Error('prove boom'); });
            const provider = workerExports.buildWorkerWalletProvider(entry);
            await expect(provider.balanceTx({})).rejects.toThrow('prove boom');
            expect(facade.revert).toHaveBeenCalledWith({ recipe: true });
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

    // ---- dust wedge protection (dust-pending-note-leak FR) -----------------

    it('balanceTx arms the pre-build dust snapshot; a successful submit disarms it', async () => {
        withSyncedIndexer();
        try {
            const { entry, finalized } = makeEntry(DUST_OK);
            const provider = workerExports.buildWorkerWalletProvider(entry);
            await provider.balanceTx({});
            expect((entry as any).preSubmitDustSnapshot).toBe('BLOB-DU');
            await provider.submitTx(finalized);
            expect((entry as any).preSubmitDustSnapshot).toBeUndefined();
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('submitTx swaps in a dust wallet restored from the pre-build snapshot on a pre-mempool reject', async () => {
        withSyncedIndexer();
        const undoAck = autoAckDustSaves();
        try {
            const { entry, facade, finalized } = makeEntry(DUST_OK);
            const oldDust = facade.dust;
            oldDust.stop = vi.fn(async () => undefined);
            const freshDust = { start: vi.fn(async () => undefined), stop: vi.fn() };
            dustRestore.mockReturnValueOnce(freshDust as any);
            facade.submitTransaction = vi.fn(async () => { throw new Error('1014: Priority is too low'); });

            const provider = workerExports.buildWorkerWalletProvider(entry);
            await provider.balanceTx({});
            await expect(provider.submitTx(finalized)).rejects.toThrow('1014');

            expect(dustRestore).toHaveBeenCalledWith('BLOB-DU');
            expect(freshDust.start).toHaveBeenCalledWith(entry.dustKey);
            expect(facade.dust).toBe(freshDust);
            expect(oldDust.stop).toHaveBeenCalled();
            expect((entry as any).preSubmitDustSnapshot).toBeUndefined();

            // The clean snapshot is persisted IMMEDIATELY (a crash before the
            // next periodic tick must not warm-restore the wedged state), the
            // push is tagged with the bumped dust epoch, and the acked persist
            // counts as a durable restore.
            const restorePush = stateSaves().at(-1);
            expect(restorePush.sessionId).toBe((entry as any).sessionId);
            expect(restorePush.blobs).toEqual({ dust: 'BLOB-DU' });
            expect((entry as any).dustEpoch).toBe(1);
            expect((entry as any).dustRestoresPersisted).toBe(1);
        } finally {
            undoAck();
            vi.unstubAllGlobals();
        }
    });

    it('a restore whose persist is never acked completes (in-memory protection) but does NOT count as durable', async () => {
        withSyncedIndexer();
        process.env.NIGHTGATE_RESTORE_SAVE_ACK_TIMEOUT_MS = '50';
        try {
            const { entry, facade, finalized } = makeEntry(DUST_OK);
            facade.dust.stop = vi.fn(async () => undefined);
            const freshDust = { start: vi.fn(async () => undefined), stop: vi.fn() };
            dustRestore.mockReturnValueOnce(freshDust as any);
            facade.submitTransaction = vi.fn(async () => { throw new Error('1014: Priority is too low'); });

            const provider = workerExports.buildWorkerWalletProvider(entry);
            await provider.balanceTx({});
            await expect(provider.submitTx(finalized)).rejects.toThrow('1014');

            // In-memory swap happened, but with no ack the durable counter
            // must NOT move and the timeout must be logged.
            expect(facade.dust).toBe(freshDust);
            expect((entry as any).dustRestoresPersisted ?? 0).toBe(0);
            const warns = fakeParentPort.postMessage.mock.calls
                .map(c => c[0])
                .filter((m: any) => m.kind === 'log' && m.level === 'warn' && /persist NOT confirmed/.test(m.message));
            expect(warns.length).toBe(1);
        } finally {
            delete process.env.NIGHTGATE_RESTORE_SAVE_ACK_TIMEOUT_MS;
            vi.unstubAllGlobals();
        }
    });

    it('a DELAYED persist ack is awaited: the durable counter moves only once the ack lands', async () => {
        withSyncedIndexer();
        try {
            const { entry, facade, finalized } = makeEntry(DUST_OK);
            facade.dust.stop = vi.fn(async () => undefined);
            const freshDust = { start: vi.fn(async () => undefined), stop: vi.fn() };
            dustRestore.mockReturnValueOnce(freshDust as any);
            facade.submitTransaction = vi.fn(async () => { throw new Error('1014: Priority is too low'); });

            const provider = workerExports.buildWorkerWalletProvider(entry);
            await provider.balanceTx({});
            const pendingSubmit = provider.submitTx(finalized);
            pendingSubmit.catch(() => { /* asserted below */ });

            // Restore is waiting on the ack: swap done, counter still 0.
            await new Promise(r => setTimeout(r, 20));
            expect(facade.dust).toBe(freshDust);
            expect((entry as any).dustRestoresPersisted ?? 0).toBe(0);

            const restorePush = stateSaves().at(-1);
            fakeParentPort.emit('message', { kind: 'state-save-ack', sessionId: restorePush.sessionId, seq: restorePush.seq });
            await expect(pendingSubmit).rejects.toThrow('1014');
            expect((entry as any).dustRestoresPersisted).toBe(1);
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('submitTx does NOT restore dust on a failure that may have reached the mempool', async () => {
        withSyncedIndexer();
        try {
            const { entry, facade, finalized } = makeEntry(DUST_OK);
            const oldDust = facade.dust;
            dustRestore.mockClear();
            facade.submitTransaction = vi.fn(async () => { throw new Error('TxFailedError: status was not success'); });

            const provider = workerExports.buildWorkerWalletProvider(entry);
            await provider.balanceTx({});
            await expect(provider.submitTx(finalized)).rejects.toThrow('TxFailedError');

            expect(dustRestore).not.toHaveBeenCalled();
            expect(facade.dust).toBe(oldDust);
            expect((entry as any).preSubmitDustSnapshot).toBeUndefined();
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('a failed pre-build snapshot only disarms the protection, the build proceeds', async () => {
        withSyncedIndexer();
        try {
            const { entry, facade, finalized } = makeEntry(DUST_OK);
            facade.dust.serializeState = vi.fn(async () => { throw new Error('serialize boom'); });
            const provider = workerExports.buildWorkerWalletProvider(entry);
            const result = await provider.balanceTx({});
            expect(result).toBe(finalized);
            expect((entry as any).preSubmitDustSnapshot).toBeUndefined();
        } finally {
            vi.unstubAllGlobals();
        }
    });
});

// ---- dust save epoch guard (dust-pending-note-leak FR, review P1) ----------
//
// After a dust snapshot restore, neither a save tick that already serialized
// the pre-restore (poisoned) wallet nor a late ack of an older dust push may
// win over the restored baseline.

describe('dust save epoch guard', () => {
    it('applySaveAck drops a dust blob acked under a stale epoch but merges the rest', () => {
        const entry: any = {
            pendingSaves: new Map([[7, { shielded: 'SH-7', dust: 'POISON' }]]),
            dustSaveEpochs: new Map([[7, 0]]),
            dustEpoch: 1,
            lastSavedBlobs: { unshielded: 'UN-0' }
        };
        workerExports.applySaveAck(entry, 7);
        expect(entry.lastSavedBlobs).toEqual({ unshielded: 'UN-0', shielded: 'SH-7' });
        expect(entry.pendingSaves.size).toBe(0);
        expect(entry.dustSaveEpochs.size).toBe(0);
    });

    it('applySaveAck merges a dust blob acked under the current epoch', () => {
        const entry: any = {
            pendingSaves: new Map([[8, { dust: 'CLEAN' }]]),
            dustSaveEpochs: new Map([[8, 1]]),
            dustEpoch: 1
        };
        workerExports.applySaveAck(entry, 8);
        expect(entry.lastSavedBlobs).toEqual({ dust: 'CLEAN' });
    });

    it('tick collects poisoned -> restore pushes clean -> the late tick push carries no dust', async () => {
        vi.useFakeTimers();
        const SESSION = 'session-epochrace-gggggggg';
        const undoAck = autoAckDustSaves();
        try {
            const facade = await initSession(SESSION);
            fakeParentPort.postMessage.mockClear();

            // The 30s tick starts collecting while the dust serialize hangs:
            // this is the in-flight save of the soon-poisoned state.
            let releaseCollect!: (v: string) => void;
            facade.dust.serializeState.mockImplementationOnce(
                () => new Promise<string>(res => { releaseCollect = res; })
            );
            await vi.advanceTimersByTimeAsync(30_000);

            // Meanwhile a submission arms the clean pre-build snapshot and
            // dies pre-mempool: the restore swaps the dust wallet, bumps the
            // epoch and pushes the snapshot.
            const freshDust = { start: vi.fn(async () => undefined), stop: vi.fn(), serializeState: vi.fn(async () => 'BLOB-DU') };
            dustRestore.mockReturnValueOnce(freshDust as any);
            facade.submitTransaction = vi.fn(async () => { throw new Error('1014: Priority is too low'); });
            const reply = await rpc('transferNight', {
                sessionId: SESSION,
                receiverAddress: 'mn_addr_preprod1' + 'x'.repeat(48),
                amount: '10'
            });
            expect(reply.ok).toBe(false);
            const restorePush = stateSaves().at(-1);
            expect(restorePush.blobs).toEqual({ dust: 'BLOB-DU' });

            // The stale collect finally returns the poisoned blob: the tick
            // detects the epoch change and pushes WITHOUT the dust part.
            releaseCollect('POISONED');
            await vi.advanceTimersByTimeAsync(0);
            const lateSaves = stateSaves().filter(s => s.seq > restorePush.seq);
            expect(lateSaves.length).toBeGreaterThan(0);
            for (const s of lateSaves) expect(s.blobs.dust).toBeUndefined();
        } finally {
            await rpc('evict', { sessionId: SESSION });
            undoAck();
            vi.useRealTimers();
        }
    });
});

describe('isPreMempoolReject', () => {
    it.each([
        ['1010: Invalid Transaction', true],
        ['1013: Transaction Already Imported', false],
        ['Error: 1014: Priority is too low', true],
        ['1016 Immediately Dropped', true],
        ['transaction is invalid transaction with bad proof', true],
        ['TxFailedError: on-chain status was not success', false],
        ['ECONNRESET while submitting', false],
        ['some 21014 lookalike', false]
    ])('%s -> %s', (message, expected) => {
        expect(workerExports.isPreMempoolReject(new Error(message))).toBe(expected);
    });

    it('finds the node reject buried in the SDK error wrappers (live shape: FiberFailure > SubmissionError > cause)', () => {
        // Mirrors the live-observed structure: generic outer message, the
        // Substrate code only in the nested cause.
        const rpcErr = new Error('1010: Invalid Transaction: Custom error: 182');
        const submissionErr: any = new Error('Transaction submission error');
        submissionErr._tag = 'SubmissionError';
        submissionErr.cause = rpcErr;
        expect(workerExports.isPreMempoolReject(submissionErr)).toBe(true);

        const benign: any = new Error('Transaction submission error');
        benign.cause = new Error('socket hang up');
        expect(workerExports.isPreMempoolReject(benign)).toBe(false);
    });

    it('does not read a stack frame :1010:27 as a reject (a post-broadcast error must not restore dust)', () => {
        const err = new Error('proving pipeline crashed');
        err.stack = 'Error: proving pipeline crashed\n    at prove (C:/app/proof-provider.js:1010:27)\n    at submit (C:/app/wallet.js:1016:3)';
        expect(workerExports.isPreMempoolReject(err)).toBe(false);

        const nested: any = new Error('outer wrapper');
        nested.cause = err; // nested stacks render as escaped one-line strings
        expect(workerExports.isPreMempoolReject(nested)).toBe(false);
    });
});

// ---- buildSponsoredWalletProvider: two-phase fee sponsoring ----------------

describe('buildSponsoredWalletProvider', () => {
    const DUST_OK = { spends: [{}], registrations: [], ctime: new Date() };
    const DUST_EMPTY = { spends: [], registrations: [], ctime: new Date() };

    /**
     * Caller facade: balances non-dust kinds, signs, finalizes into a
     * fee-unpaid tx. Sponsor facade: balances dust onto it and finalizes into
     * the submit candidate. Distinct sentinels per stage make ordering and
     * facade attribution assertable.
     */
    function makePair(sponsorFinalDust: any = DUST_OK) {
        const callerFinalized = { stage: 'caller-finalized', intents: new Map<any, any>([[0, {}]]) };
        const sponsorFinalized = { stage: 'sponsor-finalized', intents: new Map<any, any>([[0, { dustActions: sponsorFinalDust }]]) };

        const callerSigned = { stage: 'caller-signed' };
        const callerFacade = makeFakeFacade();
        callerFacade.balanceUnboundTransaction = vi.fn(async () => ({ stage: 'caller-recipe' }));
        callerFacade.signRecipe = vi.fn(async () => callerSigned);
        callerFacade.finalizeRecipe = vi.fn(async () => callerFinalized);
        callerFacade.submitTransaction = vi.fn(async () => { throw new Error('caller must never submit a sponsored tx'); });

        const sponsorFacade = makeFakeFacade();
        sponsorFacade.balanceFinalizedTransaction = vi.fn(async () => ({ stage: 'sponsor-recipe' }));
        sponsorFacade.finalizeRecipe = vi.fn(async () => sponsorFinalized);
        sponsorFacade.submitTransaction = vi.fn(async () => ({ txId: '0xsponsored' }));

        const caller = {
            facade: callerFacade,
            sdkVersion: 'test',
            zswapKeys: { coinPublicKey: 'caller-cpk', encryptionPublicKey: 'caller-epk' },
            dustKey: { caller: true },
            unshieldedKeystore: { signData: vi.fn(() => 'caller-sig') },
            networkId: 'preprod',
            indexerHttpUrl: 'http://indexer.test/api/v4/graphql',
            attestationSecret: new Uint8Array(32)
        };
        const sponsor = {
            facade: sponsorFacade,
            sdkVersion: 'test',
            zswapKeys: { coinPublicKey: 'sponsor-cpk', encryptionPublicKey: 'sponsor-epk' },
            dustKey: { sponsor: true },
            unshieldedKeystore: { signData: vi.fn(() => 'sponsor-sig') },
            networkId: 'preprod',
            indexerHttpUrl: 'http://indexer.test/api/v4/graphql',
            attestationSecret: new Uint8Array(32)
        };
        return { caller, sponsor, callerFacade, sponsorFacade, callerFinalized, sponsorFinalized, callerSigned };
    }

    function withSyncedIndexer() {
        vi.stubGlobal('fetch', vi.fn(async () => ({
            json: async () => ({ data: { block: { height: '500', timestamp: Date.now() } } })
        })));
        facadeState.current = { dust: { progress: { appliedIndex: '100', isConnected: true } } };
        wsTip.maxId = '100';
    }

    it('exposes the CALLER identity (the sponsor only pays, it does not own the tx)', () => {
        const { caller, sponsor } = makePair();
        const provider = workerExports.buildSponsoredWalletProvider(caller, sponsor);
        expect(provider.getCoinPublicKey()).toBe('caller-cpk');
        expect(provider.getEncryptionPublicKey()).toBe('caller-epk');
    });

    it('balanceTx runs the two-phase choreography with a shared TTL', async () => {
        withSyncedIndexer();
        try {
            const { caller, sponsor, callerFacade, sponsorFacade, callerFinalized, sponsorFinalized, callerSigned } = makePair();
            const provider = workerExports.buildSponsoredWalletProvider(caller, sponsor);
            const tx = { unbound: true };

            const result = await provider.balanceTx(tx);
            expect(result).toBe(sponsorFinalized);

            // Phase 1: caller balances ONLY shielded/unshielded with its keys.
            expect(callerFacade.balanceUnboundTransaction).toHaveBeenCalledWith(
                tx,
                { shieldedSecretKeys: caller.zswapKeys, dustSecretKey: caller.dustKey },
                { ttl: expect.any(Date), tokenKindsToBalance: ['shielded', 'unshielded'] }
            );
            expect(callerFacade.signRecipe).toHaveBeenCalledWith({ stage: 'caller-recipe' }, expect.any(Function));
            expect(callerFacade.finalizeRecipe).toHaveBeenCalledWith(callerSigned);

            // Phase 2: sponsor balances ONLY dust on the caller-finalized tx.
            expect(sponsorFacade.balanceFinalizedTransaction).toHaveBeenCalledWith(
                callerFinalized,
                { shieldedSecretKeys: sponsor.zswapKeys, dustSecretKey: sponsor.dustKey },
                { ttl: expect.any(Date), tokenKindsToBalance: ['dust'] }
            );

            // Both phases share ONE ttl instance.
            const callerTtl = (callerFacade.balanceUnboundTransaction as any).mock.calls[0][2].ttl;
            const sponsorTtl = (sponsorFacade.balanceFinalizedTransaction as any).mock.calls[0][2].ttl;
            expect(sponsorTtl).toBe(callerTtl);

            // The sponsor never re-signs; only its own dust balancing is proven.
            expect(sponsorFacade.finalizeRecipe).toHaveBeenCalledWith({ stage: 'sponsor-recipe' });
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('balanceTx honours an explicit ttl in both phases', async () => {
        withSyncedIndexer();
        try {
            const { caller, sponsor, callerFacade, sponsorFacade } = makePair();
            const provider = workerExports.buildSponsoredWalletProvider(caller, sponsor);
            const ttl = new Date(Date.now() + 5 * 60 * 1000);
            await provider.balanceTx({}, ttl);
            expect((callerFacade.balanceUnboundTransaction as any).mock.calls[0][2].ttl).toBe(ttl);
            expect((sponsorFacade.balanceFinalizedTransaction as any).mock.calls[0][2].ttl).toBe(ttl);
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('NIGHTGATE_SPONSORED_CALLER_SYNC=skip bypasses the CALLER sync only', async () => {
        withSyncedIndexer();
        process.env.NIGHTGATE_SPONSORED_CALLER_SYNC = 'skip';
        try {
            const { caller, sponsor, sponsorFacade } = makePair();
            // waitForGenuineSync reads state via facade.state(); spy on both.
            const callerState = vi.fn(caller.facade.state);
            const sponsorState = vi.fn(sponsor.facade.state);
            caller.facade.state = callerState;
            sponsor.facade.state = sponsorState;

            await workerExports.buildSponsoredWalletProvider(caller, sponsor).balanceTx({});
            expect(callerState).not.toHaveBeenCalled();       // caller sync skipped
            expect(sponsorState).toHaveBeenCalled();          // sponsor sync stays mandatory
            expect(sponsorFacade.balanceFinalizedTransaction).toHaveBeenCalled();
        } finally {
            delete process.env.NIGHTGATE_SPONSORED_CALLER_SYNC;
            vi.unstubAllGlobals();
        }
    });

    it('balanceTx FAILS FAST when the sponsored tx still has an empty DustActions section, reverting BOTH facades', async () => {
        withSyncedIndexer();
        try {
            const { caller, sponsor, callerFacade, sponsorFacade, callerFinalized, sponsorFinalized } = makePair(DUST_EMPTY);
            const provider = workerExports.buildSponsoredWalletProvider(caller, sponsor);
            await expect(provider.balanceTx({})).rejects.toThrow(/EMPTY DustActions section.*117 NotNormalized/s);
            expect(sponsorFacade.revert).toHaveBeenCalledWith(sponsorFinalized);
            expect(callerFacade.revert).toHaveBeenCalledWith(callerFinalized);
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('balanceTx reverts the caller recipe when the caller-side sign/finalize fails and never reaches the sponsor', async () => {
        withSyncedIndexer();
        try {
            const { caller, sponsor, callerFacade, sponsorFacade } = makePair();
            callerFacade.finalizeRecipe = vi.fn(async () => { throw new Error('caller prove boom'); });
            const provider = workerExports.buildSponsoredWalletProvider(caller, sponsor);
            await expect(provider.balanceTx({})).rejects.toThrow('caller prove boom');
            expect(callerFacade.revert).toHaveBeenCalledWith({ stage: 'caller-recipe' });
            expect(sponsorFacade.balanceFinalizedTransaction).not.toHaveBeenCalled();
            expect(sponsorFacade.revert).not.toHaveBeenCalled();
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('balanceTx reverts the sponsor recipe AND the stranded caller-finalized tx when the sponsor-side finalize fails', async () => {
        withSyncedIndexer();
        try {
            const { caller, sponsor, callerFacade, sponsorFacade, callerFinalized } = makePair();
            sponsorFacade.finalizeRecipe = vi.fn(async () => { throw new Error('sponsor prove boom'); });
            const provider = workerExports.buildSponsoredWalletProvider(caller, sponsor);
            await expect(provider.balanceTx({})).rejects.toThrow('sponsor prove boom');
            expect(sponsorFacade.revert).toHaveBeenCalledWith({ stage: 'sponsor-recipe' });
            expect(callerFacade.revert).toHaveBeenCalledWith(callerFinalized);
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('submitTx routes through the SPONSOR facade only', async () => {
        const { caller, sponsor, callerFacade, sponsorFacade, sponsorFinalized } = makePair();
        const provider = workerExports.buildSponsoredWalletProvider(caller, sponsor);
        const result = await provider.submitTx(sponsorFinalized);
        expect(result).toEqual({ txId: '0xsponsored' });
        expect(sponsorFacade.submitTransaction).toHaveBeenCalledWith(sponsorFinalized);
        expect(callerFacade.submitTransaction).not.toHaveBeenCalled();
        expect(callerFacade.revert).not.toHaveBeenCalled();
    });

    it('submitTx failure reverts the CALLER-finalized tx from the preceding balanceTx (SDK only reverts the sponsor facade)', async () => {
        withSyncedIndexer();
        try {
            const { caller, sponsor, callerFacade, sponsorFacade, callerFinalized, sponsorFinalized } = makePair();
            sponsorFacade.submitTransaction = vi.fn(async () => { throw new Error('relay boom'); });
            const provider = workerExports.buildSponsoredWalletProvider(caller, sponsor);

            await provider.balanceTx({});
            await expect(provider.submitTx(sponsorFinalized)).rejects.toThrow('relay boom');
            expect(callerFacade.revert).toHaveBeenCalledWith(callerFinalized);
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('submitTx failure without a preceding balanceTx falls back to reverting the submitted tx on the caller facade', async () => {
        const { caller, sponsor, callerFacade, sponsorFacade, sponsorFinalized } = makePair();
        sponsorFacade.submitTransaction = vi.fn(async () => { throw new Error('relay boom'); });
        const provider = workerExports.buildSponsoredWalletProvider(caller, sponsor);

        await expect(provider.submitTx(sponsorFinalized)).rejects.toThrow('relay boom');
        expect(callerFacade.revert).toHaveBeenCalledWith(sponsorFinalized);
    });
});

describe('sponsored dispatch guards', () => {
    it('submitContractCall rejects when the sponsor facade is not initialised', async () => {
        const reply = await rpc('submitContractCall', {
            sessionId: INIT_ARGS.sessionId,
            sponsorSessionId: 'ghost-sponsor-xxxxxxxxxxxxxx',
            proxyId: 'p1',
            contractName: 'c',
            registration: { artifactPath: 'a', privateStateId: 'ps', zkConfigPath: 'zk' },
            contractAddress: '00'.repeat(32),
            circuit: 'attest',
            args: [],
            indexerHttpUrl: 'http://i', indexerWsUrl: 'ws://i', proofServerUrl: 'http://p',
            networkId: 'preprod'
        });
        expect(reply.ok).toBe(false);
        expect(reply.error.message).toMatch(/No facade for sponsorSessionId=ghost-sponsor-xx/);
    });

    it('deregisterDustGeneration rejects when the sponsor facade is not initialised', async () => {
        const reply = await rpc('deregisterDustGeneration', {
            sessionId: INIT_ARGS.sessionId,
            sponsorSessionId: 'ghost-sponsor-xxxxxxxxxxxxxx'
        });
        expect(reply.ok).toBe(false);
        expect(reply.error.message).toMatch(/No facade for sponsorSessionId=ghost-sponsor-xx/);
    });
});

// ---- transferNight (token-type selection + ledger routing) -----------------

describe('transferNight', () => {
    it('defaults to NIGHT and routes an mn_addr_ receiver to the unshielded ledger', async () => {
        const facade = await initSession('session-transfer-night-aaaa');
        const reply = await rpc('transferNight', {
            sessionId: 'session-transfer-night-aaaa',
            receiverAddress: 'mn_addr_preprod1' + 'x'.repeat(48),
            amount: '1234'
        });
        expect(reply.ok).toBe(true);
        expect(reply.result.txId).toBe('tx-hash-fixture');
        expect(reply.result.toLedger).toBe('unshielded');

        const outputs = facade.transferTransaction.mock.calls[0][0];
        expect(outputs[0].type).toBe('unshielded');
        expect(outputs[0].outputs[0].type).toBe('night-raw-type');
        expect(outputs[0].outputs[0].amount).toBe(1234n);
        // Unshielded spends are signature-authorized: signRecipe must run.
        expect(facade.signRecipe).toHaveBeenCalled();
        expect(facade.finalizeRecipe).toHaveBeenCalled();
        expect(facade.submitTransaction).toHaveBeenCalled();
    });

    it('tokenTypeHex overrides the NIGHT raw type', async () => {
        const facade = await initSession('session-transfer-token-bbbb');
        const custom = 'ab'.repeat(32);
        const reply = await rpc('transferNight', {
            sessionId: 'session-transfer-token-bbbb',
            receiverAddress: 'mn_shield-addr_preprod1' + 'x'.repeat(40),
            amount: '5',
            tokenTypeHex: custom
        });
        expect(reply.ok).toBe(true);
        const outputs = facade.transferTransaction.mock.calls[0][0];
        expect(outputs[0].type).toBe('shielded');
        expect(outputs[0].outputs[0].type).toBe(custom);
    });

    it('rejects a receiver with a foreign prefix', async () => {
        await initSession('session-transfer-badaddr-cc');
        const reply = await rpc('transferNight', {
            sessionId: 'session-transfer-badaddr-cc',
            receiverAddress: 'addr_test1qq' + 'x'.repeat(50),
            amount: '1'
        });
        expect(reply.ok).toBe(false);
        expect(reply.error.message).toMatch(/Unsupported receiver address prefix/);
    });
});

// ---- getBalance + estimateTransferFee --------------------------------------

describe('getBalance / estimateTransferFee', () => {
    it('getBalance maps NIGHT balances, dust balance and UTXO counts from the synced state', async () => {
        const facade = await initSession('session-balance-dddddddddd');
        facade.waitForSyncedState.mockResolvedValue({
            shielded: { balances: { 'night-raw-type': 111n } },
            unshielded: {
                balances: { 'night-raw-type': 222n },
                totalCoins: [
                    { meta: { registeredForDustGeneration: true } },
                    { meta: { registeredForDustGeneration: false } },
                    {}
                ]
            },
            // dust.balance lives on the SYNCED FacadeState, not facade.dust:
            // exactly the wrong-object trap the implementation comment warns
            // about, so the fixture models the correct location.
            dust: {
                balance: vi.fn(() => 333n),
                progress: {},
                totalCoins: [{ generatedNow: 300n }, { generatedNow: 33n }],
                pendingCoins: [{ generatedNow: 44n }, { noGeneratedNowField: true }]
            }
        });
        const reply = await rpc('getBalance', { sessionId: 'session-balance-dddddddddd' });
        expect(reply.ok).toBe(true);
        expect(reply.result).toEqual({
            shieldedNight: '111',
            unshieldedNight: '222',
            dustBalance: '333',
            registeredNightUtxoCount: 1,
            totalNightUtxoCount: 3,
            dustUtxoCount: 2,
            dustPendingCount: 2,
            dustPendingValue: '44',
            dustRestoreCount: 0
        });
    });

    it('estimateTransferFee prices via calculateTransactionFee and ALWAYS reverts the recipe (bug_002)', async () => {
        const facade = await initSession('session-estimate-eeeeeeee');
        const reply = await rpc('estimateTransferFee', {
            sessionId: 'session-estimate-eeeeeeee',
            receiverAddress: 'mn_addr_preprod1' + 'x'.repeat(48),
            amount: '10'
        });
        expect(reply.ok).toBe(true);
        expect(reply.result).toEqual({ fee: '42', toLedger: 'unshielded' });
        expect(facade.calculateTransactionFee).toHaveBeenCalled();
        expect(facade.revert).toHaveBeenCalled();
        expect(facade.submitTransaction).not.toHaveBeenCalled();
    });
});

// ---- dust register / deregister --------------------------------------------

describe('registerDustGeneration / deregisterDustGeneration', () => {
    it('registers exactly the UNREGISTERED subset of available coins', async () => {
        const facade = await initSession('session-dustreg-ffffffff');
        const unreg1 = { id: 'c1', meta: { registeredForDustGeneration: false } };
        const unreg2 = { id: 'c2' };
        const reg = { id: 'c3', meta: { registeredForDustGeneration: true } };
        facade.waitForSyncedState.mockResolvedValue({
            unshielded: { availableCoins: [reg, unreg1, unreg2] }
        });
        const reply = await rpc('registerDustGeneration', { sessionId: 'session-dustreg-ffffffff' });
        expect(reply.ok).toBe(true);
        expect(reply.result.registeredCount).toBe(2);
        expect(reply.result.totalNightUtxos).toBe(3);
        expect(reply.result.txId).toBe('tx-hash-fixture');
        const [coins] = facade.registerNightUtxosForDustGeneration.mock.calls[0];
        expect(coins).toEqual([unreg1, unreg2]);
    });

    it('returns a no-op result when every coin is already registered', async () => {
        const facade = await initSession('session-dustreg-noop-gggg');
        facade.waitForSyncedState.mockResolvedValue({
            unshielded: { availableCoins: [{ meta: { registeredForDustGeneration: true } }] }
        });
        const reply = await rpc('registerDustGeneration', { sessionId: 'session-dustreg-noop-gggg' });
        expect(reply.ok).toBe(true);
        expect(reply.result).toMatchObject({ txId: null, registeredCount: 0, totalNightUtxos: 1 });
        expect(facade.registerNightUtxosForDustGeneration).not.toHaveBeenCalled();
    });

    it('deregisters the REGISTERED subset of totalCoins and balances the fee-less recipe with dust', async () => {
        const facade = await initSession('session-dustdereg-hhhhhh');
        const reg1 = { id: 'r1', meta: { registeredForDustGeneration: true } };
        const unreg = { id: 'r2', meta: { registeredForDustGeneration: false } };
        facade.waitForSyncedState.mockResolvedValue({
            unshielded: { totalCoins: [reg1, unreg] }
        });
        const reply = await rpc('deregisterDustGeneration', { sessionId: 'session-dustdereg-hhhhhh' });
        expect(reply.ok).toBe(true);
        expect(reply.result).toMatchObject({ deregisteredCount: 1, totalNightUtxos: 2, txId: 'tx-hash-fixture' });
        const [coins] = facade.deregisterFromDustGeneration.mock.calls[0];
        expect(coins).toEqual([reg1]);
        // The recipe is fee-less by design; the caller must balance ['dust']
        // (otherwise node error 138) and must NOT re-sign (error 192).
        const balanceOpts = facade.balanceUnprovenTransaction.mock.calls[0][2];
        expect(balanceOpts.tokenKindsToBalance).toEqual(['dust']);
        expect(facade.signRecipe).not.toHaveBeenCalled();
    });

    it('deregister falls back across the SDK naming generations (allCoins) and no-ops when none registered', async () => {
        const facade = await initSession('session-dustdereg-noop-ii');
        facade.waitForSyncedState.mockResolvedValue({
            unshielded: { allCoins: [{ meta: { registeredForDustGeneration: false } }] }
        });
        const reply = await rpc('deregisterDustGeneration', { sessionId: 'session-dustdereg-noop-ii' });
        expect(reply.ok).toBe(true);
        expect(reply.result).toMatchObject({ txId: null, deregisteredCount: 0, totalNightUtxos: 1 });
        expect(facade.deregisterFromDustGeneration).not.toHaveBeenCalled();
    });
});

// ---- submitContractCall: first-contact private-state seeding guard ----------

describe('submitContractCall private-state seeding', () => {
    const REGISTRATION = {
        artifactPath: path.resolve(process.cwd(), 'test/fixtures/fake-contract-artifact.mjs'),
        privateStateId: 'fakePrivateState',
        zkConfigPath: path.resolve(process.cwd(), 'test/fixtures')
    };

    function callArgs(sessionId: string) {
        return {
            sessionId,
            proxyId: 'proxy-seed-test',
            contractName: 'fake-artifact',
            registration: REGISTRATION,
            contractAddress: 'ab'.repeat(32),
            circuit: 'increment',
            args: [],
            indexerHttpUrl: 'http://indexer.seed-test/api/v4/graphql',
            indexerWsUrl: 'ws://indexer.seed-test/api/v4/graphql/ws',
            proofServerUrl: 'http://proof.seed-test:6300',
            networkId: 'preprod'
        };
    }

    beforeEach(() => {
        privateState.store = {};
        privateState.calls = [];
        findDeployedContract.mockReset();
        findDeployedContract.mockResolvedValue({
            callTx: { increment: vi.fn(async () => ({ public: { txHash: 'tx-cc-fixture', status: 'SUCCESS' } })) }
        });
    });

    it('seeds initialPrivateState ONLY when this wallet has no stored state', async () => {
        await initSession('session-seed-fresh-jjjjjj');
        const reply = await rpc('submitContractCall', {
            ...callArgs('session-seed-fresh-jjjjjj'),
            initialPrivateState: { seeded: true }
        });
        expect(reply.ok).toBe(true);
        expect(reply.result).toEqual({ txHash: 'tx-cc-fixture', onChainStatus: 'SUCCESS' });

        const opts = findDeployedContract.mock.calls[0][1];
        expect(opts.initialPrivateState).toEqual({ seeded: true });

        // The probe must set the contract address BEFORE reading the state,
        // or the provider rejects with "Contract address not set".
        const methods = privateState.calls.map(c => c.method);
        expect(methods.indexOf('setContractAddress')).toBeGreaterThanOrEqual(0);
        expect(methods.indexOf('setContractAddress')).toBeLessThan(methods.indexOf('get'));
    });

    it('NEVER passes initialPrivateState when state already exists (it would overwrite it)', async () => {
        privateState.store['fakePrivateState'] = { existing: 'state' };
        await initSession('session-seed-existing-kkkk');
        const reply = await rpc('submitContractCall', {
            ...callArgs('session-seed-existing-kkkk'),
            initialPrivateState: { seeded: true }
        });
        expect(reply.ok).toBe(true);
        const opts = findDeployedContract.mock.calls[0][1];
        expect('initialPrivateState' in opts).toBe(false);
    });

    it('fails cleanly when the circuit does not exist on the deployed contract', async () => {
        await initSession('session-seed-nocircuit-ll');
        findDeployedContract.mockResolvedValue({ callTx: {} });
        const reply = await rpc('submitContractCall', callArgs('session-seed-nocircuit-ll'));
        expect(reply.ok).toBe(false);
        expect(reply.error.message).toMatch(/Circuit 'increment' not found/);
    });

    function timingLogs(): string[] {
        return fakeParentPort.postMessage.mock.calls
            .map(c => c[0])
            .filter((m: any) => m.kind === 'log' && /submitContractCall timing:/.test(m.message))
            .map((m: any) => m.message);
    }

    it('logs a phase-timing breakdown incl. circuitToProve/prove when the call proves', async () => {
        await initSession('session-timing-mmmmmm');
        // The circuit call routes a proof request through the (wrapped)
        // proofProvider handed to findDeployedContract, like the real SDK.
        findDeployedContract.mockImplementation(async (providers: any) => ({
            callTx: {
                increment: vi.fn(async () => {
                    await providers.proofProvider.proveTx({ unproven: true });
                    return { public: { txHash: 'tx-timing', status: 'SUCCESS' } };
                })
            }
        }));
        fakeParentPort.postMessage.mockClear();
        proveTxMock.mockClear();
        const reply = await rpc('submitContractCall', callArgs('session-timing-mmmmmm'));
        expect(reply.ok).toBe(true);
        expect(proveTxMock).toHaveBeenCalledWith({ unproven: true });

        const lines = timingLogs();
        expect(lines.length).toBe(1);
        for (const phase of ['init', 'compile', 'providers', 'stateProbe', 'findContract',
            'circuitToProve', 'prove', 'callTotal', 'total']) {
            expect(lines[0]).toMatch(new RegExp(`${phase}=\\d+ms`));
        }
        expect(lines[0]).toContain('fake-artifact.increment');
    });

    it('logs the partial phase breakdown when a phase throws', async () => {
        await initSession('session-timing-fail-nnnn');
        findDeployedContract.mockRejectedValue(new Error('indexer unreachable'));
        fakeParentPort.postMessage.mockClear();
        const reply = await rpc('submitContractCall', callArgs('session-timing-fail-nnnn'));
        expect(reply.ok).toBe(false);

        const lines = timingLogs();
        expect(lines.length).toBe(1);
        // Phases up to the probe completed; the failed find and the call
        // never produced entries.
        expect(lines[0]).toMatch(/stateProbe=\d+ms/);
        expect(lines[0]).not.toMatch(/findContract=/);
        expect(lines[0]).not.toMatch(/callTotal=/);
    });
});

// ---- submitContractCall: findDeployedContract query caching ------------------

describe('withFindContractQueryCache', () => {
    const REGISTRATION = {
        artifactPath: path.resolve(process.cwd(), 'test/fixtures/fake-contract-artifact.mjs'),
        privateStateId: 'fakePrivateState',
        zkConfigPath: path.resolve(process.cwd(), 'test/fixtures')
    };

    function callArgs(sessionId: string, contractAddress: string) {
        return {
            sessionId,
            proxyId: 'proxy-cache-test',
            contractName: 'fake-artifact',
            registration: REGISTRATION,
            contractAddress,
            circuit: 'increment',
            args: [],
            indexerHttpUrl: 'http://indexer.seed-test/api/v4/graphql',
            indexerWsUrl: 'ws://indexer.seed-test/api/v4/graphql/ws',
            proofServerUrl: 'http://proof.seed-test:6300',
            networkId: 'preprod'
        };
    }

    beforeEach(() => {
        privateState.store = { fakePrivateState: { existing: true } };
        privateState.calls = [];
        for (const fn of Object.values(publicDataMethods)) fn.mockClear();
        findDeployedContract.mockReset();
        // Exercise the wrapped provider the way the real SDK does: the find
        // performs the three per-address queries, the circuit call reads the
        // fresh state through queryZSwapAndContractState.
        findDeployedContract.mockImplementation(async (providers: any, opts: any) => {
            await providers.publicDataProvider.watchForDeployTxData(opts.contractAddress);
            await providers.publicDataProvider.queryDeployContractState(opts.contractAddress);
            await providers.publicDataProvider.queryContractState(opts.contractAddress);
            return {
                callTx: {
                    increment: vi.fn(async () => {
                        await providers.publicDataProvider.queryZSwapAndContractState(opts.contractAddress);
                        return { public: { txHash: 'tx-cache-fixture', status: 'SUCCESS' } };
                    })
                }
            };
        });
    });

    it('serves the immutable deploy queries from cache; current-state queries stay fresh', async () => {
        const addr = 'ca'.repeat(32);
        await initSession('session-qcache-hit-aaaa');
        expect((await rpc('submitContractCall', callArgs('session-qcache-hit-aaaa', addr))).ok).toBe(true);
        expect((await rpc('submitContractCall', callArgs('session-qcache-hit-aaaa', addr))).ok).toBe(true);

        expect(publicDataMethods.watchForDeployTxData).toHaveBeenCalledTimes(1);
        expect(publicDataMethods.queryDeployContractState).toHaveBeenCalledTimes(1);
        // The verifier-key check must see maintenance transactions from other
        // clients, and transcripts build against current state: NEVER cached.
        expect(publicDataMethods.queryContractState).toHaveBeenCalledTimes(2);
        expect(publicDataMethods.queryZSwapAndContractState).toHaveBeenCalledTimes(2);
    });

    it('caches per contract address', async () => {
        await initSession('session-qcache-addr-bbbb');
        expect((await rpc('submitContractCall', callArgs('session-qcache-addr-bbbb', 'cb'.repeat(32)))).ok).toBe(true);
        expect((await rpc('submitContractCall', callArgs('session-qcache-addr-bbbb', 'cc'.repeat(32)))).ok).toBe(true);
        expect(publicDataMethods.queryDeployContractState).toHaveBeenCalledTimes(2);
    });

    it('does not stick a transient indexer failure', async () => {
        const addr = 'cd'.repeat(32);
        await initSession('session-qcache-fail-cccc');
        publicDataMethods.watchForDeployTxData.mockRejectedValueOnce(new Error('indexer unreachable'));
        const failed = await rpc('submitContractCall', callArgs('session-qcache-fail-cccc', addr));
        expect(failed.ok).toBe(false);
        expect(failed.error.message).toMatch(/indexer unreachable/);

        const retried = await rpc('submitContractCall', callArgs('session-qcache-fail-cccc', addr));
        expect(retried.ok).toBe(true);
        expect(publicDataMethods.watchForDeployTxData).toHaveBeenCalledTimes(2);
    });

    it('passes non-plain query variants through uncached', async () => {
        const addr = 'ce'.repeat(32);
        await initSession('session-qcache-args-dddd');
        findDeployedContract.mockImplementation(async (providers: any, opts: any) => {
            await providers.publicDataProvider.queryDeployContractState(opts.contractAddress, { variant: 'nonPlain' });
            return { callTx: { increment: vi.fn(async () => ({ public: { txHash: 'tx', status: 'SUCCESS' } })) } };
        });
        expect((await rpc('submitContractCall', callArgs('session-qcache-args-dddd', addr))).ok).toBe(true);
        expect((await rpc('submitContractCall', callArgs('session-qcache-args-dddd', addr))).ok).toBe(true);
        expect(publicDataMethods.queryDeployContractState).toHaveBeenCalledTimes(2);
    });
});
