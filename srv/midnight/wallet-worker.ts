/**
 * Wallet worker thread entry.
 *
 * Lives in its OWN Node `worker_threads` worker so the Midnight wallet SDK's
 * Effect.ts Fiber scheduler — which monopolises the microtask queue while a
 * chain sync is running — only blocks THIS thread's event loop. The main
 * cds-serve thread stays responsive for OData requests and CAP DB writes.
 *
 * Communication: per-call `MessageChannel`. Main thread posts
 *   { kind: 'rpc', method, args, port: MessagePort }
 * and the worker replies on `port` with
 *   { ok: true, result } | { ok: false, error: string }
 *
 * Push events (worker → main, on `parentPort`):
 *   - { kind: 'state-save', sessionId, sdkVersion, blobs }
 *     emitted ~every 30 s while a facade is active so the main thread can
 *     persist via standard `cds.connect.to('db').run(...)`.
 *   - { kind: 'log', level, message }
 *     surfaces worker-side console.log/warn lines into the main thread's
 *     unified log stream.
 *
 * Phase 1 surface (this file): init / waitForSyncedState / serializeState /
 * evict. Phase 2 will add balanceUnboundTransaction / submitTransaction /
 * registerNightUtxosForDustGeneration so the full T15 deploy path moves here.
 */

import { parentPort, MessageChannel, type MessagePort } from 'node:worker_threads';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { formatErr } from '../utils/format-error';
import {
    deriveAttestationSecret,
    getContractWitnessFactory
} from '../submission/contract-witnesses';
import { deriveRoleSeeds } from '../utils/wallet-hd';
// Type-only import of the ESM-only address-format package. `import type`
// is erased at compile time so we don't emit a require() against an ESM-only
// module; runtime access still goes through dynamic `import()` in
// loadAddressFormat below.
import type * as AddressFormat from '@midnight-ntwrk/wallet-sdk-address-format';

// ---- Message protocol shared with main thread -----------------------------

export interface RpcRequest {
    kind: 'rpc';
    method: string;
    args: unknown;
    port: MessagePort;
}

export interface RpcErrorPayload { name: string; message: string }

export interface RpcOk  { ok: true;  result: unknown }
export interface RpcErr { ok: false; error: RpcErrorPayload }

export interface InitArgs {
    sessionId: string;
    seedHex: string;
    networkId: 'preprod' | 'testnet' | 'mainnet' | 'undeployed' | 'devnet' | 'qanet' | 'preview';
    indexerHttpUrl: string;
    indexerWsUrl: string;
    proofServerUrl: string;
    relayUrl: string;
    restoreBlobs?: { shielded?: string; unshielded?: string; dust?: string };
}

interface FacadeEntry {
    facade: any;
    sdkVersion: string;
    zswapKeys: any;
    dustKey: any;
    unshieldedKeystore: any;
    saveTimer?: NodeJS.Timeout;
    networkId: string;
    // 32-byte session-stable secret for contracts that use the
    // `local_secret_key()` witness pattern (e.g. AttestationVault). Derived
    // once per facade build via deriveAttestationSecret(seedBytes).
    attestationSecret: Uint8Array;
}

const facades = new Map<string, FacadeEntry>();

// ---- Logging back to main thread ------------------------------------------

function log(level: 'info' | 'warn', message: string): void {
    parentPort?.postMessage({ kind: 'log', level, message });
}

// ---- SDK loaders (dynamic ESM imports, same pattern as sdk-loader.ts) ----

let cachedLedger: any;
let cachedWallet: any;
let cachedFacadeSdk: any;
let cachedContractsSdk: any;
let cachedAddressFormat: typeof AddressFormat | undefined;

async function loadAddressFormat(): Promise<typeof AddressFormat> {
    if (cachedAddressFormat) return cachedAddressFormat;
    cachedAddressFormat = await import('@midnight-ntwrk/wallet-sdk-address-format');
    return cachedAddressFormat;
}

/**
 * Union of SDK address types this worker may need to encode/decode. Each
 * has the `[Bech32mSymbol]` codec attached (see the package's index.d.ts).
 *
 * Note on the type-only use of this union: `MidnightBech32m.encode<T>` has
 * an invariant `T extends HasCodec<T>` constraint, so passing a bare union
 * fails type-checking even though the runtime call works. We narrow per
 * concrete address at the call site (currently only DustAddress is used);
 * add overloads of `encodeAddressString` when the other variants are needed.
 */
type MidnightAddress =
    | AddressFormat.DustAddress
    | AddressFormat.ShieldedAddress
    | AddressFormat.UnshieldedAddress;

async function loadSdk(): Promise<{
    ledger: any;
    shielded: any;
    unshielded: any;
    dust: any;
    abstractions: any;
    facade: any;
    networkId: any;
}> {
    if (!cachedLedger) {
        cachedLedger = await import('@midnight-ntwrk/ledger-v8');
    }
    if (!cachedWallet) {
        const [shielded, unshielded, dust, abstractions] = await Promise.all([
            import('@midnight-ntwrk/wallet-sdk-shielded'),
            import('@midnight-ntwrk/wallet-sdk-unshielded-wallet'),
            import('@midnight-ntwrk/wallet-sdk-dust-wallet'),
            import('@midnight-ntwrk/wallet-sdk-abstractions')
        ]);
        cachedWallet = { shielded, unshielded, dust, abstractions };
    }
    if (!cachedFacadeSdk) {
        const [facade, networkId] = await Promise.all([
            import('@midnight-ntwrk/wallet-sdk-facade'),
            import('@midnight-ntwrk/midnight-js-network-id')
        ]);
        cachedFacadeSdk = { facade, networkId };
    }
    return {
        ledger:        cachedLedger,
        shielded:      cachedWallet.shielded,
        unshielded:    cachedWallet.unshielded,
        dust:          cachedWallet.dust,
        abstractions:  cachedWallet.abstractions,
        facade:        cachedFacadeSdk.facade,
        networkId:     cachedFacadeSdk.networkId
    };
}

let lastNetworkId: string | undefined;
async function ensureNetworkId(networkId: string, sdk: any): Promise<void> {
    if (lastNetworkId === networkId) return;
    sdk.networkId.setNetworkId(networkId);
    lastNetworkId = networkId;
}

/**
 * SDK packages needed for contract deploy/call (Phase 2b). Loaded lazily on
 * the first deploy/call so the worker startup cost only covers the wallet
 * sync surface.
 */
async function loadContractsSdk(): Promise<{
    contracts: any;
    indexer:   any;
    proof:     any;
    zk:        any;
    compactJs: any;
}> {
    if (cachedContractsSdk) return cachedContractsSdk;
    const [contracts, indexer, proof, zk, compactJs] = await Promise.all([
        import('@midnight-ntwrk/midnight-js-contracts'),
        import('@midnight-ntwrk/midnight-js-indexer-public-data-provider'),
        import('@midnight-ntwrk/midnight-js-http-client-proof-provider'),
        import('@midnight-ntwrk/midnight-js-node-zk-config-provider'),
        import('@midnight-ntwrk/compact-js')
    ]);
    cachedContractsSdk = { contracts, indexer, proof, zk, compactJs };
    return cachedContractsSdk;
}

// ---- Compiled-contract cache (Phase 2b) -----------------------------------

interface ContractRegistration {
    artifactPath:   string;
    privateStateId: string;
    zkConfigPath:   string;
}

// Cache of the heavy bits of contract compilation: imported module + ctor.
// Witnesses must be bound per-call (session-specific for contracts like
// AttestationVault that use `local_secret_key()`), so the final pipeable
// composition is rebuilt on each invocation. The pipe itself is cheap; what
// would be expensive (the dynamic import + ZK asset path validation) is
// the part that's reused.
interface ContractScaffold {
    contractClass: any;
}
const contractScaffolds = new Map<string, ContractScaffold>();

async function getContractScaffold(name: string, registration: ContractRegistration): Promise<ContractScaffold> {
    const cached = contractScaffolds.get(name);
    if (cached) return cached;
    const importSpec = path.isAbsolute(registration.artifactPath)
        ? pathToFileURL(registration.artifactPath).href
        : registration.artifactPath;
    const mod: any = await import(importSpec);
    const contractClass = mod.Contract ?? mod.default ?? mod;
    const scaffold: ContractScaffold = { contractClass };
    contractScaffolds.set(name, scaffold);
    return scaffold;
}

/**
 * Builds a CompiledContract for the given registered contract. If the
 * contract declares no witnesses, supplies vacant ones (counter). Otherwise
 * looks up the witness factory and feeds it the FacadeEntry's
 * attestationSecret (AttestationVault).
 *
 * Witnesses bind to a Compact Contract instance for the lifetime of its use,
 * so we must build them fresh per call — different sessions yield different
 * attester ids.
 */
async function getOrCompileContract(
    name: string,
    registration: ContractRegistration,
    entry: FacadeEntry
): Promise<any> {
    const { contractClass } = await getContractScaffold(name, registration);

    const { compactJs } = await loadContractsSdk();
    const CompiledContract = compactJs.CompiledContract ?? compactJs.effect?.CompiledContract;
    if (!CompiledContract?.make) {
        throw new Error(
            `CompiledContract.make not found in @midnight-ntwrk/compact-js exports; got keys: ${Object.keys(compactJs).join(',')}`
        );
    }

    const witnessFactory = getContractWitnessFactory(name);
    const witnessStep = witnessFactory
        ? CompiledContract.withWitnesses(witnessFactory({ attestationSecret: entry.attestationSecret }))
        : CompiledContract.withVacantWitnesses;

    return CompiledContract.make(name, contractClass).pipe(
        witnessStep,
        CompiledContract.withCompiledFileAssets(registration.zkConfigPath)
    );
}

// ---- Worker-side provider construction (Phase 2b) -------------------------

async function buildWorkerContractProviders(args: {
    indexerHttpUrl: string;
    indexerWsUrl:   string;
    proofServerUrl: string;
    zkConfigPath:   string;
}): Promise<{ publicDataProvider: any; zkConfigProvider: any; proofProvider: any }> {
    // `ws` is CJS — Node 22 worker_threads can `require` it freely.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const WebSocket = require('ws');
    const { indexer, proof, zk } = await loadContractsSdk();
    const zkConfigProvider = new zk.NodeZkConfigProvider(args.zkConfigPath);
    const publicDataProvider = indexer.indexerPublicDataProvider(
        args.indexerHttpUrl,
        args.indexerWsUrl,
        WebSocket
    );
    const proofProvider = proof.httpClientProofProvider(args.proofServerUrl, zkConfigProvider);
    return { publicDataProvider, zkConfigProvider, proofProvider };
}

/**
 * Adapts a worker-side facade into the SDK's WalletProvider & MidnightProvider
 * shape. balanceTx routes through balanceUnboundTransaction → finalizeRecipe
 * (matches the main-thread wallet-material-factory adapter pre-Phase-2b).
 */
function buildWorkerWalletProvider(entry: FacadeEntry): any {
    return {
        getCoinPublicKey(): string       { return entry.zswapKeys.coinPublicKey; },
        getEncryptionPublicKey(): string { return entry.zswapKeys.encryptionPublicKey; },
        async balanceTx(tx: any, ttl?: Date): Promise<any> {
            // Robustness: block until the wallet is synced to the chain tip
            // before balancing. The prewarm job (connectWalletForSigning) also
            // waits, but a caller that submits WITHOUT prewarming — or after the
            // facade has drifted — would otherwise balance against stale
            // (restored/partial) dust state, and the node rejects the tx with
            // `1010 Invalid Transaction: Custom error: 170` (dust validity
            // window: ctime + grace < tblock). waitForSyncedState is a no-op
            // once synced, so this is cheap on the common (prewarmed) path.
            await entry.facade.waitForSyncedState();
            const effectiveTtl = ttl ?? new Date(Date.now() + 60 * 60 * 1000);
            const recipe = await entry.facade.balanceUnboundTransaction(
                tx,
                { shieldedSecretKeys: entry.zswapKeys, dustSecretKey: entry.dustKey },
                { ttl: effectiveTtl }
            );
            return entry.facade.finalizeRecipe(recipe);
        },
        async submitTx(tx: any): Promise<any> {
            return entry.facade.submitTransaction(tx);
        }
    };
}

// ---- Private-state proxy (worker → main RPC) ------------------------------

/**
 * Each CRUD call on the proxy posts a `private-state-rpc` message back to the
 * main thread, which holds the real CapDbPrivateStateProvider (keyed by
 * proxyId, see srv/midnight/wallet-worker-client.ts). The SDK consumes the
 * returned object as a plain PrivateStateProvider; await semantics work
 * because each method returns a Promise that resolves on the reply port.
 *
 * `setContractAddress` is sync in the SDK contract; we forward it as a
 * fire-and-forget message (no reply port). worker_threads guarantees ordering
 * on parentPort, so the next async set/get from the same proxy is always
 * dispatched on main AFTER the address-set has been applied.
 */
function privateStateRpc<T>(proxyId: string, method: string, args: unknown[]): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const { port1, port2 } = new MessageChannel();
        port2.once('message', (msg: any) => {
            port2.close();
            if (msg?.ok) {
                resolve(msg.result as T);
            } else {
                const payload = msg?.error;
                const err = new Error(payload?.message ?? String(payload ?? 'private-state rpc failed'));
                if (payload?.name) err.name = payload.name;
                reject(err);
            }
        });
        port2.once('messageerror', err => { port2.close(); reject(err); });
        parentPort!.postMessage(
            { kind: 'private-state-rpc', proxyId, method, args, port: port1 },
            [port1]
        );
    });
}

function createPrivateStateProxy(proxyId: string): any {
    return {
        setContractAddress(addr: string): void {
            if (!addr) throw new Error('Contract address must not be empty');
            // Fire-and-forget; order preserved relative to subsequent async ops.
            parentPort!.postMessage({
                kind: 'private-state-rpc',
                proxyId,
                method: 'setContractAddress',
                args: [addr]
            });
        },
        async set(privateStateId: string, state: unknown): Promise<void> {
            return privateStateRpc(proxyId, 'set', [privateStateId, state]);
        },
        async get(privateStateId: string): Promise<unknown> {
            return privateStateRpc(proxyId, 'get', [privateStateId]);
        },
        async remove(privateStateId: string): Promise<void> {
            return privateStateRpc(proxyId, 'remove', [privateStateId]);
        },
        async clear(): Promise<void> {
            return privateStateRpc(proxyId, 'clear', []);
        },
        async setSigningKey(addr: string, signingKey: string): Promise<void> {
            return privateStateRpc(proxyId, 'setSigningKey', [addr, signingKey]);
        },
        async getSigningKey(addr: string): Promise<string | null> {
            return privateStateRpc(proxyId, 'getSigningKey', [addr]);
        },
        async removeSigningKey(addr: string): Promise<void> {
            return privateStateRpc(proxyId, 'removeSigningKey', [addr]);
        },
        async clearSigningKeys(): Promise<void> {
            return privateStateRpc(proxyId, 'clearSigningKeys', []);
        }
    };
}

// ---- SDK version pin ------------------------------------------------------

let resolvedSdkVersion: string | undefined;
function getSdkVersion(): string {
    if (resolvedSdkVersion) return resolvedSdkVersion;
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const fs = require('fs');
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const path = require('path');
        let pkgPath: string | undefined;
        // First try: direct subpath resolution. Newer ESM-only packages with
        // restricted `exports` reject this — that's why we had `@unknown`.
        try {
            pkgPath = require.resolve('@midnight-ntwrk/wallet-sdk-facade/package.json');
        } catch {
            // Fallback: walk up from the package's main module path until we
            // find a package.json. Works regardless of exports restrictions.
            const mainPath = require.resolve('@midnight-ntwrk/wallet-sdk-facade');
            let dir = path.dirname(mainPath);
            // Bound the walk to keep it cheap.
            for (let i = 0; i < 8 && dir && dir !== path.dirname(dir); i++) {
                const candidate = path.join(dir, 'package.json');
                if (fs.existsSync(candidate)) { pkgPath = candidate; break; }
                dir = path.dirname(dir);
            }
        }
        if (!pkgPath) throw new Error('package.json not located');
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        resolvedSdkVersion = `wallet-sdk-facade@${pkg.version}`;
    } catch {
        resolvedSdkVersion = 'wallet-sdk-facade@unknown';
    }
    return resolvedSdkVersion;
}

/**
 * Bech32m-encodes a Midnight address object (DustAddress / ShieldedAddress /
 * UnshieldedAddress) into its canonical string form.
 *
 * Uses `MidnightBech32m.encode` (declared in
 * `@midnight-ntwrk/wallet-sdk-address-format/dist/index.d.ts` as
 * `static encode<T extends HasCodec<T>>(networkId, item): MidnightBech32m`)
 * which reads the `[Bech32mSymbol]` codec attached to each address class.
 * `.toString()` on the result yields the Bech32m string.
 *
 * Pre-encoded strings pass through untouched.
 */
async function encodeAddressString(
    addr: AddressFormat.DustAddress | string | null | undefined,
    networkId: string
): Promise<string>;
async function encodeAddressString(
    addr: AddressFormat.ShieldedAddress | string | null | undefined,
    networkId: string
): Promise<string>;
async function encodeAddressString(
    addr: AddressFormat.UnshieldedAddress | string | null | undefined,
    networkId: string
): Promise<string>;
async function encodeAddressString(addr: any, networkId: string): Promise<string> {
    if (addr == null) return '';
    if (typeof addr === 'string') return addr;
    const af = await loadAddressFormat();
    return af.MidnightBech32m.encode(networkId, addr).toString();
}

/**
 * Parses a Bech32m receiver string into the SDK's typed address object.
 * Discriminates on the `mn_shield-addr_` vs `mn_addr_` HRP prefix so callers
 * can build the matching `CombinedTokenTransfer` wrapper.
 */
type ReceiverParsed =
    | { kind: 'shielded';   addr: AddressFormat.ShieldedAddress }
    | { kind: 'unshielded'; addr: AddressFormat.UnshieldedAddress };

async function parseReceiverAddress(addr: string, networkId: string): Promise<ReceiverParsed> {
    const af = await loadAddressFormat();
    if (addr.startsWith('mn_shield-addr_')) {
        return { kind: 'shielded', addr: af.MidnightBech32m.parse(addr).decode(af.ShieldedAddress, networkId) };
    }
    if (addr.startsWith('mn_addr_')) {
        return { kind: 'unshielded', addr: af.MidnightBech32m.parse(addr).decode(af.UnshieldedAddress, networkId) };
    }
    throw new Error(
        `Unsupported receiver address prefix in '${addr.slice(0, 16)}...' ` +
        `(expected 'mn_shield-addr_' for shielded or 'mn_addr_' for unshielded)`
    );
}

// ---- Facade construction --------------------------------------------------

async function buildFacade(args: InitArgs): Promise<FacadeEntry> {
    const sdk = await loadSdk();
    await ensureNetworkId(args.networkId, sdk);

    // args.seedHex is the 64-byte BIP39 seed (128 hex). Lace derives each key
    // type from a DIFFERENT HD role (Zswap/Dust/NightExternal); deriving them
    // all from one raw seed lands on the wrong account. See srv/utils/wallet-hd.ts.
    const bip39Seed = new Uint8Array(Buffer.from(args.seedHex, 'hex'));
    const roleSeeds = await deriveRoleSeeds(bip39Seed);
    const zswapKeys = sdk.ledger.ZswapSecretKeys.fromSeed(roleSeeds.zswap);
    const dustKey   = sdk.ledger.DustSecretKey.fromSeed(roleSeeds.dust);

    const txHistoryStorage = new sdk.abstractions.InMemoryTransactionHistoryStorage(
        sdk.facade.WalletEntrySchema,
        sdk.facade.mergeWalletEntries
    );
    const { createKeystore, PublicKey } = sdk.unshielded;
    const unshieldedKeystore = createKeystore(roleSeeds.night, args.networkId);

    const configuration = {
        networkId: args.networkId,
        provingServerUrl: new URL(args.proofServerUrl),
        relayURL:         new URL(args.relayUrl),
        indexerClientConnection: {
            indexerHttpUrl: args.indexerHttpUrl,
            indexerWsUrl:   args.indexerWsUrl
        },
        txHistoryStorage,
        costParameters: { additionalFeeOverhead: 0n, feeBlocksMargin: 1 }
    };

    const dustParameters = sdk.ledger.LedgerParameters.initialParameters().dust;
    const ShieldedWallet   = sdk.shielded.ShieldedWallet;
    const UnshieldedWallet = sdk.unshielded.UnshieldedWallet;
    const DustWallet       = sdk.dust.DustWallet;
    const restore = args.restoreBlobs;

    const facade = await sdk.facade.WalletFacade.init({
        configuration,
        shielded:   () => restore?.shielded
            ? ShieldedWallet(configuration).restore(restore.shielded)
            : ShieldedWallet(configuration).startWithSecretKeys(zswapKeys),
        unshielded: () => restore?.unshielded
            ? UnshieldedWallet(configuration).restore(restore.unshielded)
            : UnshieldedWallet(configuration).startWithPublicKey(PublicKey.fromKeyStore(unshieldedKeystore)),
        dust: () => restore?.dust
            ? DustWallet(configuration).restore(restore.dust)
            : DustWallet(configuration).startWithSecretKey(dustKey, dustParameters)
    });

    await facade.start(zswapKeys, dustKey);
    log('info', `[worker] facade started for ${args.sessionId.slice(0, 16)} (restored=${!!restore})`);

    return {
        facade,
        sdkVersion: getSdkVersion(),
        zswapKeys,
        dustKey,
        unshieldedKeystore,
        networkId: args.networkId,
        attestationSecret: deriveAttestationSecret(roleSeeds.zswap)
    };
}

// ---- Periodic state save (pushed to main thread) -------------------------

function startPeriodicSave(sessionId: string, entry: FacadeEntry): void {
    if (entry.saveTimer) return;
    let lastBlobs: { shielded?: string; unshielded?: string; dust?: string } = {};
    let tickCount = 0;
    log('info', `[worker] periodic-save interval armed for ${sessionId.slice(0, 16)}`);
    entry.saveTimer = setInterval(async () => {
        tickCount++;
        const tickStart = Date.now();
        // Log BEFORE the first await so we know the timer fired even if
        // serializeState() hangs on the rx Observable.
        log('info', `[worker] save-tick #${tickCount} fired, calling collectSerializedStates...`);
        try {
            const collectStart = Date.now();
            const blobs = await collectSerializedStates(entry.facade);
            const collectMs = Date.now() - collectStart;
            const shape = [
                `sh=${blobs.shielded   ? blobs.shielded.length   : '-'}`,
                `un=${blobs.unshielded ? blobs.unshielded.length : '-'}`,
                `du=${blobs.dust       ? blobs.dust.length       : '-'}`
            ].join(' ');
            log('info', `[worker] save-tick #${tickCount} collect returned in ${collectMs}ms: ${shape}`);

            if (!hasAnyBlob(blobs)) return;
            // Skip push if nothing changed since last tick — avoids burning
            // CAP write cycles when wallet is fully synced and idle.
            if (
                blobs.shielded   === lastBlobs.shielded   &&
                blobs.unshielded === lastBlobs.unshielded &&
                blobs.dust       === lastBlobs.dust
            ) {
                log('info', `[worker] save-tick #${tickCount} unchanged, skipping push`);
                return;
            }
            lastBlobs = blobs;
            parentPort?.postMessage({
                kind: 'state-save',
                sessionId,
                sdkVersion: entry.sdkVersion,
                blobs
            });
            log('info', `[worker] save-tick #${tickCount} pushed (total ${Date.now() - tickStart}ms)`);
        } catch (err: any) {
            log('warn', `[worker] periodic save failed: ${formatErr(err)}`);
        }
    }, 30_000);
    entry.saveTimer.unref();
}

async function collectSerializedStates(facade: any): Promise<{ shielded?: string; unshielded?: string; dust?: string }> {
    const out: any = {};
    const tryOne = async (key: 'shielded' | 'unshielded' | 'dust') => {
        try {
            const sub = facade?.[key];
            if (sub && typeof sub.serializeState === 'function') {
                const blob = await sub.serializeState();
                if (typeof blob === 'string') out[key] = blob;
            }
        } catch {
            // Best-effort: a missing blob for one sub-wallet doesn't block
            // persistence of the others.
        }
    };
    await Promise.all([tryOne('shielded'), tryOne('unshielded'), tryOne('dust')]);
    return out;
}

function hasAnyBlob(b: { shielded?: string; unshielded?: string; dust?: string }): boolean {
    return !!(b.shielded || b.unshielded || b.dust);
}

// ---- RPC method handlers --------------------------------------------------

const handlers: Record<string, (args: any) => Promise<unknown>> = {
    async init(args: InitArgs) {
        if (facades.has(args.sessionId)) {
            log('info', `[worker] init: cache hit ${args.sessionId.slice(0, 16)}`);
            return { facadeReady: true, alreadyExisted: true };
        }
        const entry = await buildFacade(args);
        facades.set(args.sessionId, entry);
        startPeriodicSave(args.sessionId, entry);
        return { facadeReady: true, alreadyExisted: false, sdkVersion: entry.sdkVersion };
    },

    async waitForSyncedState({ sessionId, timeoutMs }: { sessionId: string; timeoutMs?: number }) {
        const entry = facades.get(sessionId);
        if (!entry) throw new Error(`No facade for sessionId=${sessionId.slice(0, 16)}`);
        const deadline = timeoutMs
            ? new Promise<never>((_, rej) => setTimeout(() => rej(new Error('waitForSyncedState timeout')), timeoutMs))
            : null;
        const synced = deadline
            ? Promise.race([entry.facade.waitForSyncedState(), deadline])
            : entry.facade.waitForSyncedState();
        await synced;
        return { synced: true };
    },

    async serializeState({ sessionId }: { sessionId: string }) {
        const entry = facades.get(sessionId);
        if (!entry) throw new Error(`No facade for sessionId=${sessionId.slice(0, 16)}`);
        const blobs = await collectSerializedStates(entry.facade);
        return { sdkVersion: entry.sdkVersion, blobs };
    },

    async evict({ sessionId }: { sessionId: string }) {
        const entry = facades.get(sessionId);
        if (!entry) return { evicted: false };
        facades.delete(sessionId);
        if (entry.saveTimer) clearInterval(entry.saveTimer);
        // Best-effort final save push. Cleanup-path errors don't block
        // eviction but are logged — silent swallowing would hide leaks.
        try {
            const blobs = await collectSerializedStates(entry.facade);
            if (hasAnyBlob(blobs)) {
                parentPort?.postMessage({
                    kind: 'state-save',
                    sessionId,
                    sdkVersion: entry.sdkVersion,
                    blobs
                });
            }
        } catch (err) {
            log('warn', `[worker] evict final-save failed for ${sessionId.slice(0, 16)}: ${formatErr(err)}`);
        }
        try {
            entry.zswapKeys?.clear?.();
            await entry.facade?.stop?.();
        } catch (err) {
            log('warn', `[worker] evict cleanup failed for ${sessionId.slice(0, 16)}: ${formatErr(err)}`);
        }
        return { evicted: true };
    },

    async ping() {
        return { ok: true, ts: Date.now() };
    },

    /**
     * End-to-end NIGHT-UTXO registration for DUST generation. Wraps:
     *   waitForSyncedState → filter unregistered → register/finalize/submit.
     * Runs entirely in the worker so no SDK objects cross the thread boundary.
     */
    async registerDustGeneration({ sessionId, dustReceiverAddress, syncTimeoutMs }: {
        sessionId: string;
        dustReceiverAddress?: string;
        syncTimeoutMs?: number;
    }) {
        const entry = facades.get(sessionId);
        if (!entry) throw new Error(`No facade for sessionId=${sessionId.slice(0, 16)}`);

        // 1. Block until the wallet is synced enough to see its NIGHT UTXOs.
        log('info', `[worker] dust-register: waiting for synced state...`);
        const synced = syncTimeoutMs
            ? await Promise.race([
                entry.facade.waitForSyncedState(),
                new Promise<never>((_, rej) => setTimeout(() => rej(new Error('dust-register: sync timeout')), syncTimeoutMs))
            ])
            : await entry.facade.waitForSyncedState();
        log('info', `[worker] dust-register: synced.`);

        const availableCoins: any[] = synced?.unshielded?.availableCoins ?? [];
        const unregistered = availableCoins.filter(
            (c: any) => c?.meta?.registeredForDustGeneration !== true
        );

        const myDustAddr = await entry.facade.dust.getAddress();
        const receiverRaw = dustReceiverAddress || myDustAddr;
        const dustAddrStr = await encodeAddressString(receiverRaw, entry.networkId);

        if (unregistered.length === 0) {
            // Two distinct cases produce an empty unregistered list, distinguish
            // for the caller via the log so triage is faster.
            if (availableCoins.length === 0) {
                log('info',
                    `[worker] dust-register: no unshielded NIGHT UTXOs visible to this wallet. ` +
                    `Either all your NIGHT is held shielded (unshield via Lace to enable dust-gen), ` +
                    `or your unshielded UTXOs are already committed to dust generation and no longer ` +
                    `surface in synced.unshielded.availableCoins (the SDK's "available" excludes ` +
                    `registered UTXOs). Check Lace's "Refilling NhNNmin" indicator for the latter.`);
            } else {
                log('info', `[worker] dust-register: ${availableCoins.length} NIGHT UTXO(s) are already registered for dust-gen.`);
            }
            return {
                txId: null,
                registeredCount: 0,
                totalNightUtxos: availableCoins.length,
                dustReceiverAddress: dustAddrStr
            };
        }

        // 2. Parse Bech32m receiver string into a DustAddress, which is what
        //    `registerNightUtxosForDustGeneration` expects on the wire.
        let receiverParsed: AddressFormat.DustAddress | string = receiverRaw;
        if (typeof receiverRaw === 'string') {
            const af = await loadAddressFormat();
            receiverParsed = af.MidnightBech32m
                .parse(receiverRaw)
                .decode(af.DustAddress, entry.networkId);
        }

        // 3. Build registration recipe + finalize + submit. All in-process.
        const verifyingKey = entry.unshieldedKeystore.getPublicKey();
        const signFn = (payload: Uint8Array) => entry.unshieldedKeystore.signData(payload);

        const recipe = await entry.facade.registerNightUtxosForDustGeneration(
            unregistered,
            verifyingKey,
            signFn,
            receiverParsed
        );
        const finalized = await entry.facade.finalizeRecipe(recipe);
        const txId = await entry.facade.submitTransaction(finalized);

        log('info', `[worker] dust-register: submitted ${unregistered.length} UTXO(s), txId=${String(txId).slice(0, 16)}...`);

        return {
            txId: String(txId),
            registeredCount: unregistered.length,
            totalNightUtxos: availableCoins.length,
            dustReceiverAddress: dustAddrStr
        };
    },

    /**
     * Symmetric pair to `registerDustGeneration`. Removes NIGHT UTXOs from
     * dust generation so they become spendable again (registered UTXOs are
     * committed to dust accrual and excluded from `availableCoins`).
     *
     * The SDK's `synced.unshielded.availableCoins` only lists *unregistered*
     * UTXOs, so we read registered ones from the full set the wallet tracks.
     * For Phase 1 of this action we deregister ALL registered UTXOs; per-UTXO
     * narrowing is a follow-up once we have a stable UTXO-id surface.
     */
    async deregisterDustGeneration({ sessionId, syncTimeoutMs }: {
        sessionId: string;
        syncTimeoutMs?: number;
    }) {
        const entry = facades.get(sessionId);
        if (!entry) throw new Error(`No facade for sessionId=${sessionId.slice(0, 16)}`);

        log('info', `[worker] dust-deregister: waiting for synced state...`);
        const synced = syncTimeoutMs
            ? await Promise.race([
                entry.facade.waitForSyncedState(),
                new Promise<never>((_, rej) => setTimeout(() => rej(new Error('dust-deregister: sync timeout')), syncTimeoutMs))
            ])
            : await entry.facade.waitForSyncedState();
        log('info', `[worker] dust-deregister: synced.`);

        // The SDK exposes `availableCoins` (unregistered-only) AND `allCoins`
        // (full set) on the synced unshielded state. The full set is where
        // registered UTXOs live — they're committed to dust gen so the SDK
        // hides them from "available" but we still need them to deregister.
        const allCoins: any[] = synced?.unshielded?.allCoins ?? synced?.unshielded?.coins ?? [];
        const registered = allCoins.filter(
            (c: any) => c?.meta?.registeredForDustGeneration === true
        );

        if (registered.length === 0) {
            log('info', `[worker] dust-deregister: no registered NIGHT UTXOs to deregister.`);
            return {
                txId: null,
                deregisteredCount: 0,
                totalNightUtxos: allCoins.length
            };
        }

        const verifyingKey = entry.unshieldedKeystore.getPublicKey();
        const signFn = (payload: Uint8Array) => entry.unshieldedKeystore.signData(payload);

        const recipe = await entry.facade.deregisterFromDustGeneration(
            registered,
            verifyingKey,
            signFn
        );
        const finalized = await entry.facade.finalizeRecipe(recipe);
        const txId = await entry.facade.submitTransaction(finalized);

        log('info', `[worker] dust-deregister: submitted ${registered.length} UTXO(s), txId=${String(txId).slice(0, 16)}...`);

        return {
            txId: String(txId),
            deregisteredCount: registered.length,
            totalNightUtxos: allCoins.length
        };
    },

    /**
     * Send NIGHT to any Midnight address. The receiver's Bech32m prefix
     * decides the destination ledger (`mn_shield-addr_` → shielded,
     * `mn_addr_` → unshielded). Source funds are selected by the SDK's
     * balancer from the wallet's available UTXOs on the target ledger;
     * cross-ledger funding is not attempted here (use shield/unshieldFunds).
     *
     * Build + balance + prove + submit all in-worker via `facade.transferTransaction`.
     * Returns primitives only — no SDK objects cross the thread boundary.
     */
    async transferNight({ sessionId, receiverAddress, amount, ttlIso, syncTimeoutMs }: {
        sessionId: string;
        receiverAddress: string;
        amount: string;          // bigint atoms as decimal string
        ttlIso?: string;          // ISO-8601 future timestamp; defaults to +10min
        syncTimeoutMs?: number;
    }) {
        const entry = facades.get(sessionId);
        if (!entry) throw new Error(`No facade for sessionId=${sessionId.slice(0, 16)}`);
        const sdk = await loadSdk();
        await ensureNetworkId(entry.networkId, sdk);

        log('info', `[worker] transfer: waiting for synced state...`);
        if (syncTimeoutMs) {
            await Promise.race([
                entry.facade.waitForSyncedState(),
                new Promise<never>((_, rej) => setTimeout(() => rej(new Error('transfer: sync timeout')), syncTimeoutMs))
            ]);
        } else {
            await entry.facade.waitForSyncedState();
        }
        log('info', `[worker] transfer: synced.`);

        const receiver = await parseReceiverAddress(receiverAddress, entry.networkId);
        const amountBig = BigInt(amount);
        const nightRawType = sdk.ledger.nativeToken().raw;
        const ttl = ttlIso ? new Date(ttlIso) : new Date(Date.now() + 10 * 60 * 1000);

        const outputs: any[] = receiver.kind === 'shielded'
            ? [{ type: 'shielded',   outputs: [{ type: nightRawType, receiverAddress: receiver.addr, amount: amountBig }] }]
            : [{ type: 'unshielded', outputs: [{ type: nightRawType, receiverAddress: receiver.addr, amount: amountBig }] }];

        log('info', `[worker] transfer: ${amount} NIGHT to ${receiver.kind} addr ${receiverAddress.slice(0, 24)}...`);

        const recipe = await entry.facade.transferTransaction(
            outputs,
            { shieldedSecretKeys: entry.zswapKeys, dustSecretKey: entry.dustKey },
            { ttl }
        );
        const finalized = await entry.facade.finalizeRecipe(recipe);
        const txId = await entry.facade.submitTransaction(finalized);

        log('info', `[worker] transfer: submitted, txId=${String(txId).slice(0, 16)}...`);

        return {
            txId:            String(txId),
            toLedger:        receiver.kind,
            amount:          amount,
            receiverAddress: receiverAddress
        };
    },

    /**
     * Move NIGHT from shielded → unshielded ledger (own funds only).
     *
     * Built via `facade.initSwap` — the SDK's primitive for explicit
     * cross-ledger conversion. `desiredInputs` names the source ledger
     * + token + amount; `desiredOutputs` names the destination ledger
     * with the wallet's own unshielded address as receiver.
     *
     * For 1:1 self-swaps (no value change, just ledger shift), the same
     * NIGHT raw type and amount appear on both sides.
     */
    async unshieldNight({ sessionId, amount, ttlIso, syncTimeoutMs }: {
        sessionId: string;
        amount: string;
        ttlIso?: string;
        syncTimeoutMs?: number;
    }) {
        const entry = facades.get(sessionId);
        if (!entry) throw new Error(`No facade for sessionId=${sessionId.slice(0, 16)}`);
        const sdk = await loadSdk();
        await ensureNetworkId(entry.networkId, sdk);

        log('info', `[worker] unshield: waiting for synced state...`);
        if (syncTimeoutMs) {
            await Promise.race([
                entry.facade.waitForSyncedState(),
                new Promise<never>((_, rej) => setTimeout(() => rej(new Error('unshield: sync timeout')), syncTimeoutMs))
            ]);
        } else {
            await entry.facade.waitForSyncedState();
        }
        log('info', `[worker] unshield: synced.`);

        const ownUnshieldedAddr: AddressFormat.UnshieldedAddress = await entry.facade.unshielded.getAddress();
        const ownUnshieldedAddrStr = await encodeAddressString(ownUnshieldedAddr, entry.networkId);
        const amountBig = BigInt(amount);
        const nightRawType: string = sdk.ledger.nativeToken().raw;
        const ttl = ttlIso ? new Date(ttlIso) : new Date(Date.now() + 10 * 60 * 1000);

        const desiredInputs: { shielded: Record<string, bigint> } = {
            shielded: { [nightRawType]: amountBig }
        };
        const desiredOutputs: any[] = [
            { type: 'unshielded', outputs: [{ type: nightRawType, receiverAddress: ownUnshieldedAddr, amount: amountBig }] }
        ];

        log('info', `[worker] unshield: ${amount} NIGHT → own unshielded addr ${ownUnshieldedAddrStr.slice(0, 24)}...`);

        const recipe = await entry.facade.initSwap(
            desiredInputs,
            desiredOutputs,
            { shieldedSecretKeys: entry.zswapKeys, dustSecretKey: entry.dustKey },
            { ttl, payFees: true }
        );
        const finalized = await entry.facade.finalizeRecipe(recipe);
        const txId = await entry.facade.submitTransaction(finalized);

        log('info', `[worker] unshield: submitted, txId=${String(txId).slice(0, 16)}...`);

        return {
            txId:                       String(txId),
            amount:                     amount,
            unshieldedReceiverAddress:  ownUnshieldedAddrStr
        };
    },

    /**
     * Move NIGHT from unshielded → shielded ledger (own funds only).
     * Symmetric counterpart to `unshieldNight`. Same `initSwap` mechanism,
     * source/destination flipped.
     */
    async shieldNight({ sessionId, amount, ttlIso, syncTimeoutMs }: {
        sessionId: string;
        amount: string;
        ttlIso?: string;
        syncTimeoutMs?: number;
    }) {
        const entry = facades.get(sessionId);
        if (!entry) throw new Error(`No facade for sessionId=${sessionId.slice(0, 16)}`);
        const sdk = await loadSdk();
        await ensureNetworkId(entry.networkId, sdk);

        log('info', `[worker] shield: waiting for synced state...`);
        if (syncTimeoutMs) {
            await Promise.race([
                entry.facade.waitForSyncedState(),
                new Promise<never>((_, rej) => setTimeout(() => rej(new Error('shield: sync timeout')), syncTimeoutMs))
            ]);
        } else {
            await entry.facade.waitForSyncedState();
        }
        log('info', `[worker] shield: synced.`);

        const ownShieldedAddr: AddressFormat.ShieldedAddress = await entry.facade.shielded.getAddress();
        const ownShieldedAddrStr = await encodeAddressString(ownShieldedAddr, entry.networkId);
        const amountBig = BigInt(amount);
        const nightRawType: string = sdk.ledger.nativeToken().raw;
        const ttl = ttlIso ? new Date(ttlIso) : new Date(Date.now() + 10 * 60 * 1000);

        const desiredInputs: { unshielded: Record<string, bigint> } = {
            unshielded: { [nightRawType]: amountBig }
        };
        const desiredOutputs: any[] = [
            { type: 'shielded', outputs: [{ type: nightRawType, receiverAddress: ownShieldedAddr, amount: amountBig }] }
        ];

        log('info', `[worker] shield: ${amount} NIGHT → own shielded addr ${ownShieldedAddrStr.slice(0, 24)}...`);

        const recipe = await entry.facade.initSwap(
            desiredInputs,
            desiredOutputs,
            { shieldedSecretKeys: entry.zswapKeys, dustSecretKey: entry.dustKey },
            { ttl, payFees: true }
        );
        const finalized = await entry.facade.finalizeRecipe(recipe);
        const txId = await entry.facade.submitTransaction(finalized);

        log('info', `[worker] shield: submitted, txId=${String(txId).slice(0, 16)}...`);

        return {
            txId:                     String(txId),
            amount:                   amount,
            shieldedReceiverAddress:  ownShieldedAddrStr
        };
    },

    /**
     * Read-only snapshot of the wallet's current balances and dust state.
     *
     * Pulls from the cached synced state via `waitForSyncedState()` (which
     * resolves immediately when at tip, blocks during initial catch-up).
     * No transaction is built or submitted.
     *
     * Returns only NIGHT for shielded/unshielded in this first version
     * (other custom tokens omitted; add a `tokensJson` field later if a
     * consumer needs them).
     */
    async getBalance({ sessionId, syncTimeoutMs }: {
        sessionId: string;
        syncTimeoutMs?: number;
    }) {
        const entry = facades.get(sessionId);
        if (!entry) throw new Error(`No facade for sessionId=${sessionId.slice(0, 16)}`);
        const sdk = await loadSdk();
        await ensureNetworkId(entry.networkId, sdk);

        const synced = syncTimeoutMs
            ? await Promise.race([
                entry.facade.waitForSyncedState(),
                new Promise<never>((_, rej) => setTimeout(() => rej(new Error('getBalance: sync timeout')), syncTimeoutMs))
            ])
            : await entry.facade.waitForSyncedState();

        const nightRawType: string = sdk.ledger.nativeToken().raw;
        const shieldedBalances: Record<string, bigint> = synced?.shielded?.balances ?? {};
        const unshieldedBalances: Record<string, bigint> = synced?.unshielded?.balances ?? {};
        const totalNightCoins: any[] = synced?.unshielded?.totalCoins ?? [];

        const shieldedNight   = shieldedBalances[nightRawType]   ?? 0n;
        const unshieldedNight = unshieldedBalances[nightRawType] ?? 0n;
        // dust.balance(time) is synchronous and returns Balance (= bigint).
        const dustBalance: bigint = entry.facade.dust.balance(new Date());
        const registeredCount = totalNightCoins.filter(
            (c: any) => c?.meta?.registeredForDustGeneration === true
        ).length;

        return {
            shieldedNight:           shieldedNight.toString(),
            unshieldedNight:         unshieldedNight.toString(),
            dustBalance:             dustBalance.toString(),
            registeredNightUtxoCount: registeredCount,
            totalNightUtxoCount:      totalNightCoins.length
        };
    },

    /**
     * Pre-flight fee estimate for a NIGHT transfer. Builds the
     * `transferTransaction` recipe in the worker — which runs balancing
     * (lightweight) but NOT proof generation (heavy) — then calls
     * `estimateTransactionFee` to compute total fee including any
     * balancing tx. No submit. The recipe is discarded.
     */
    async estimateTransferFee({ sessionId, receiverAddress, amount, ttlIso, syncTimeoutMs }: {
        sessionId: string;
        receiverAddress: string;
        amount: string;
        ttlIso?: string;
        syncTimeoutMs?: number;
    }) {
        const entry = facades.get(sessionId);
        if (!entry) throw new Error(`No facade for sessionId=${sessionId.slice(0, 16)}`);
        const sdk = await loadSdk();
        await ensureNetworkId(entry.networkId, sdk);

        if (syncTimeoutMs) {
            await Promise.race([
                entry.facade.waitForSyncedState(),
                new Promise<never>((_, rej) => setTimeout(() => rej(new Error('estimateTransferFee: sync timeout')), syncTimeoutMs))
            ]);
        } else {
            await entry.facade.waitForSyncedState();
        }

        const receiver = await parseReceiverAddress(receiverAddress, entry.networkId);
        const amountBig = BigInt(amount);
        const nightRawType: string = sdk.ledger.nativeToken().raw;
        const ttl = ttlIso ? new Date(ttlIso) : new Date(Date.now() + 10 * 60 * 1000);

        const outputs: any[] = receiver.kind === 'shielded'
            ? [{ type: 'shielded',   outputs: [{ type: nightRawType, receiverAddress: receiver.addr, amount: amountBig }] }]
            : [{ type: 'unshielded', outputs: [{ type: nightRawType, receiverAddress: receiver.addr, amount: amountBig }] }];

        const recipe = await entry.facade.transferTransaction(
            outputs,
            { shieldedSecretKeys: entry.zswapKeys, dustSecretKey: entry.dustKey },
            { ttl }
        );
        // recipe is UnprovenTransactionRecipe: { type: 'UNPROVEN_TRANSACTION', transaction }
        const fee: bigint = await entry.facade.estimateTransactionFee(recipe.transaction, entry.dustKey, { ttl });
        return { fee: fee.toString(), toLedger: receiver.kind };
    },

    /**
     * Pre-flight fee estimate for a shield/unshield ledger shift. Same
     * approach as `estimateTransferFee`: build the `initSwap` recipe,
     * estimate, discard.
     *
     * `direction`: 'shield' means unshielded → shielded; 'unshield' means
     * shielded → unshielded. Always operates on the wallet's own NIGHT.
     */
    async estimateSwapFee({ sessionId, direction, amount, ttlIso, syncTimeoutMs }: {
        sessionId: string;
        direction: 'shield' | 'unshield';
        amount: string;
        ttlIso?: string;
        syncTimeoutMs?: number;
    }) {
        const entry = facades.get(sessionId);
        if (!entry) throw new Error(`No facade for sessionId=${sessionId.slice(0, 16)}`);
        const sdk = await loadSdk();
        await ensureNetworkId(entry.networkId, sdk);

        if (syncTimeoutMs) {
            await Promise.race([
                entry.facade.waitForSyncedState(),
                new Promise<never>((_, rej) => setTimeout(() => rej(new Error('estimateSwapFee: sync timeout')), syncTimeoutMs))
            ]);
        } else {
            await entry.facade.waitForSyncedState();
        }

        const amountBig = BigInt(amount);
        const nightRawType: string = sdk.ledger.nativeToken().raw;
        const ttl = ttlIso ? new Date(ttlIso) : new Date(Date.now() + 10 * 60 * 1000);

        let desiredInputs: { shielded?: Record<string, bigint>; unshielded?: Record<string, bigint> };
        let desiredOutputs: any[];

        if (direction === 'shield') {
            const ownShieldedAddr: AddressFormat.ShieldedAddress = await entry.facade.shielded.getAddress();
            desiredInputs  = { unshielded: { [nightRawType]: amountBig } };
            desiredOutputs = [{ type: 'shielded', outputs: [{ type: nightRawType, receiverAddress: ownShieldedAddr, amount: amountBig }] }];
        } else {
            const ownUnshieldedAddr: AddressFormat.UnshieldedAddress = await entry.facade.unshielded.getAddress();
            desiredInputs  = { shielded: { [nightRawType]: amountBig } };
            desiredOutputs = [{ type: 'unshielded', outputs: [{ type: nightRawType, receiverAddress: ownUnshieldedAddr, amount: amountBig }] }];
        }

        const recipe = await entry.facade.initSwap(
            desiredInputs,
            desiredOutputs,
            { shieldedSecretKeys: entry.zswapKeys, dustSecretKey: entry.dustKey },
            { ttl, payFees: true }
        );
        const fee: bigint = await entry.facade.estimateTransactionFee(recipe.transaction, entry.dustKey, { ttl });
        return { fee: fee.toString(), direction };
    },

    /**
     * Deploy a Compact-emitted contract via the SDK, entirely in the worker.
     * Inputs are primitives + the registration meta — the contract artifact is
     * dynamic-imported and `CompiledContract.make`'d inside the worker, cached
     * by name. The private-state provider is a proxy that round-trips to main
     * (where the real CapDbPrivateStateProvider lives, keyed by proxyId).
     *
     * Returns primitives so nothing SDK-shaped crosses the thread boundary.
     */
    async deployContract({
        sessionId, proxyId, contractName, registration,
        indexerHttpUrl, indexerWsUrl, proofServerUrl,
        networkId, initialPrivateState
    }: {
        sessionId: string;
        proxyId:   string;
        contractName: string;
        registration: ContractRegistration;
        indexerHttpUrl: string;
        indexerWsUrl:   string;
        proofServerUrl: string;
        networkId: string;
        initialPrivateState: unknown;
    }) {
        const entry = facades.get(sessionId);
        if (!entry) throw new Error(`No facade for sessionId=${sessionId.slice(0, 16)}`);
        const sdk = await loadSdk();
        await ensureNetworkId(networkId, sdk);

        const compiledContract = await getOrCompileContract(contractName, registration, entry);
        const contractProviders = await buildWorkerContractProviders({
            indexerHttpUrl, indexerWsUrl, proofServerUrl,
            zkConfigPath: registration.zkConfigPath
        });
        const privateStateProvider = createPrivateStateProxy(proxyId);
        const walletProvider = buildWorkerWalletProvider(entry);

        const providers = {
            ...contractProviders,
            privateStateProvider,
            walletProvider,
            midnightProvider: walletProvider
        };

        const { contracts } = await loadContractsSdk();
        log('info', `[worker] deployContract: starting ${contractName} sess=${sessionId.slice(0, 16)}`);
        const result = await contracts.deployContract(providers, {
            compiledContract,
            privateStateId: registration.privateStateId,
            initialPrivateState
        });
        const pub = result?.deployTxData?.public;
        const out = {
            txHash:          String(pub?.txHash ?? ''),
            contractAddress: String(pub?.contractAddress ?? ''),
            onChainStatus:   String(pub?.status ?? '')
        };
        log('info', `[worker] deployContract: done addr=${out.contractAddress.slice(0, 16)} status=${out.onChainStatus}`);
        return out;
    },

    /**
     * Submit a circuit call against an already-deployed contract. Same worker-
     * side provider assembly as deployContract; routes through
     * `findDeployedContract` and invokes the circuit by name.
     */
    async submitContractCall({
        sessionId, proxyId, contractName, registration,
        contractAddress, circuit, args: callArgs,
        indexerHttpUrl, indexerWsUrl, proofServerUrl,
        networkId
    }: {
        sessionId: string;
        proxyId:   string;
        contractName: string;
        registration: ContractRegistration;
        contractAddress: string;
        circuit: string;
        args: unknown[];
        indexerHttpUrl: string;
        indexerWsUrl:   string;
        proofServerUrl: string;
        networkId: string;
    }) {
        const entry = facades.get(sessionId);
        if (!entry) throw new Error(`No facade for sessionId=${sessionId.slice(0, 16)}`);
        const sdk = await loadSdk();
        await ensureNetworkId(networkId, sdk);

        const compiledContract = await getOrCompileContract(contractName, registration, entry);
        const contractProviders = await buildWorkerContractProviders({
            indexerHttpUrl, indexerWsUrl, proofServerUrl,
            zkConfigPath: registration.zkConfigPath
        });
        const privateStateProvider = createPrivateStateProxy(proxyId);
        const walletProvider = buildWorkerWalletProvider(entry);

        const providers = {
            ...contractProviders,
            privateStateProvider,
            walletProvider,
            midnightProvider: walletProvider
        };

        const { contracts } = await loadContractsSdk();
        log('info', `[worker] submitContractCall: ${contractName}.${circuit}@${contractAddress.slice(0, 12)}`);
        const found = await contracts.findDeployedContract(providers, {
            contractAddress,
            compiledContract,
            privateStateId: registration.privateStateId
        });
        const fn = found?.callTx?.[circuit];
        if (typeof fn !== 'function') {
            throw new Error(`Circuit '${circuit}' not found on contract at ${contractAddress}`);
        }
        const result = await fn(...(callArgs ?? []));
        const pub = result?.public;
        const out = {
            txHash:        String(pub?.txHash ?? ''),
            onChainStatus: String(pub?.status ?? '')
        };
        log('info', `[worker] submitContractCall: done txHash=${out.txHash.slice(0, 16)} status=${out.onChainStatus}`);
        return out;
    }
};

// ---- Dispatcher -----------------------------------------------------------

if (!parentPort) {
    throw new Error('wallet-worker must be loaded as a worker_threads worker (no parentPort)');
}

parentPort.on('message', async (msg: any) => {
    if (msg?.kind !== 'rpc' || !msg.port) {
        log('warn', `[worker] unexpected message: ${JSON.stringify(msg).slice(0, 80)}`);
        return;
    }
    const { method, args, port } = msg as RpcRequest;
    try {
        const fn = handlers[method];
        if (!fn) throw new Error(`Unknown method: ${method}`);
        const result = await fn(args);
        port.postMessage({ ok: true, result } as RpcOk);
    } catch (err: any) {
        const payload: RpcErrorPayload = {
            name:    err?.name ?? 'Error',
            message: formatErr(err)
        };
        port.postMessage({ ok: false, error: payload } as RpcErr);
    } finally {
        port.close();
    }
});

parentPort.postMessage({ kind: 'ready' });
log('info', '[worker] ready');
