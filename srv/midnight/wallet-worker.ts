/**
 * Wallet worker thread entry.
 *
 * Lives in its OWN Node `worker_threads` worker so the Midnight wallet SDK's
 * Effect.ts Fiber scheduler (which monopolises the microtask queue while a
 * chain sync is running) only blocks THIS thread's event loop. The main
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
 * Surface: the RPC handler map (`const handlers` below) is the authoritative
 * method list; core ops are init / waitForSyncedState / evict, token + dust
 * ops (transferNight, getBalance, estimate fees, register/deregister dust),
 * and the contract path (deployContract, submitContractCall(+Batch)).
 */

import { parentPort, MessageChannel, type MessagePort } from 'node:worker_threads';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { profileCurrentThread } from './cpu-profile';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { classificationHaystack, formatErr, formatErrWithCauses, safeDeepInspect } from '../utils/format-error';
import { deriveIndexerWsUrl } from '../utils/indexer-url';
import { computeArtifactGenerationDigest, effectiveModuleFormat } from '../submission/artifact-digest';
import { runBatchInScope } from './batch-call-scope';
import { buildWasmProofProvider, getSharedKeyMaterialProvider } from './wasm-proof-provider';
import {
    deriveAttestationSecret,
    getContractWitnessFactory,
    type MerkleProofBundle
} from '../submission/contract-witnesses';
import { deriveRoleSeeds } from '../utils/wallet-hd';
import type * as AddressFormat from '@midnightntwrk/wallet-sdk-address-format';

// Message protocol shared with main thread

export interface RpcRequest {
    kind: 'rpc';
    method: string;
    args: unknown;
    port: MessagePort;
}

export interface RpcErrorPayload { name: string; message: string }
export interface RpcOk { ok: true; result: unknown }
export interface RpcErr { ok: false; error: RpcErrorPayload }

export interface InitArgs {
    sessionId: string;
    seedHex: string;
    /** BIP32 account level the seed signs with (default 0). */
    accountIndex?: number;
    networkId: 'preprod' | 'testnet' | 'mainnet' | 'undeployed' | 'devnet' | 'qanet' | 'preview';
    indexerHttpUrl: string;
    indexerWsUrl: string;
    proofServerUrl: string;
    relayUrl: string;
    restoreBlobs?: { shielded?: string; unshielded?: string; dust?: string };
}

interface FacadeEntry {
    /** The `facades` map key this entry is stored under (the caller's accountId). */
    sessionId: string;
    facade: any;
    sdkVersion: string;
    zswapKeys: any;
    dustKey: any;
    unshieldedKeystore: any;
    saveTimer?: NodeJS.Timeout;
    /** Idle progress watch (startProgressWatch); cleared with the facade. */
    progressTimer?: NodeJS.Timeout;
    lastSavedBlobs?: { shielded?: string; unshielded?: string; dust?: string }; // Blobs of the last save the MAIN THREAD CONFIRMED it persisted
    pendingSaves?: Map<number, { shielded?: string; unshielded?: string; dust?: string }>; // In-flight saves by sequence number, resolved by `state-save-ack
    networkId: string;
    /** Indexer GraphQL HTTP URL, used to read the genuine sync target (tip). */
    indexerHttpUrl: string;
    /** The wallet configuration the facade's sub-wallets were built with; kept for dust snapshot restores. */
    walletConfiguration: any;
    /**
     * Dust sub-wallet state serialized BEFORE the current submission's build
     * (the build books the dust spend, so a pre-submit snapshot would already
     * carry the in-flight marker). Used to swap in a clean dust wallet after
     * a pre-mempool reject; see dust-pending-note-leak FR.
     */
    preSubmitDustSnapshot?: string;
    /** Bumped on every dust snapshot restore; lets the save tick drop a dust blob serialized from the pre-restore wallet. */
    dustEpoch?: number;
    /** Dust epoch each in-flight save's dust blob was serialized under (by seq); acks with a stale epoch must not advance the dust baseline. */
    dustSaveEpochs?: Map<number, number>;
    /** Snapshot restores whose re-persist the main thread CONFIRMED (state-save-ack). What getWalletBalance reports as dustRestoreCount. */
    dustRestoresPersisted?: number;
    // 32-byte session-stable secret for contracts that use the
    // `local_secret_key()` witness pattern (e.g. AttestationVault). Derived
    // once per facade build via deriveAttestationSecret(seedBytes).
    attestationSecret: Uint8Array;
}

const facades = new Map<string, FacadeEntry>();

// ---- Logging back to main thread ------------------------------------------

function log(level: 'info' | 'warn' | 'debug' | 'error', message: string): void {
    parentPort?.postMessage({ kind: 'log', level, message });
}

// ---- SDK loaders (dynamic ESM imports, same pattern as sdk-loader.ts) ----

let cachedLedger: any;
let cachedWallet: any;
let cachedFacadeSdk: any;
let cachedContractsSdk: any;
let cachedProving: any;
let cachedAddressFormat: typeof AddressFormat | undefined;

async function loadAddressFormat(): Promise<typeof AddressFormat> {
    if (cachedAddressFormat) return cachedAddressFormat;
    cachedAddressFormat = await import('@midnightntwrk/wallet-sdk-address-format');
    return cachedAddressFormat;
}

// The dust wallet's CoreWallet API (functional spendCoins), used by the
// note-pool paths. Memoized as a PROMISE so concurrent first callers share
// one module evaluation.
let cachedDustCore: Promise<any> | undefined;
function loadDustCoreWallet(): Promise<any> {
    cachedDustCore ??= import('@midnightntwrk/wallet-sdk-dust-wallet/v1' as string).then((m: any) => m.CoreWallet);
    return cachedDustCore;
}

// SDK submission service factory (dedicated per-submit node clients of the
// parallel sponsor path). Memoized as a PROMISE, like loadDustCoreWallet.
let cachedSubmission: Promise<any> | undefined;
function loadSubmissionSdk(): Promise<any> {
    cachedSubmission ??= import('@midnightntwrk/wallet-sdk-capabilities/submission' as string);
    return cachedSubmission;
}

// Loaded only when NIGHTGATE_PROVING_MODE=wasm; the default server path
// never touches the WASM prover module.
async function loadProvingSdk(): Promise<any> {
    if (!cachedProving) {
        cachedProving = await import('@midnightntwrk/wallet-sdk-capabilities/proving');
    }
    return cachedProving;
}

type ProvingMode = 'server' | 'wasm';

/**
 * NIGHTGATE_PROVING_MODE selects how transactions are proved: 'server'
 * (default) proxies to the proof-server container at proofServerUrl; 'wasm'
 * proves in-process, with no proof server needed. Wallet proving goes through
 * the SDK's WASM prover; contract circuits go through our own
 * wasm-proof-provider (zkir over the contract's local key material). Proving
 * keys for the standard circuits are fetched from Midnight's S3 bucket into
 * ONE shared in-memory cache per worker (getSharedKeyMaterialProvider), so
 * they download once per process, not once per session.
 */
function resolveProvingMode(): ProvingMode {
    const raw = (process.env.NIGHTGATE_PROVING_MODE || 'server').trim().toLowerCase();
    if (raw === 'wasm') return 'wasm';
    if (raw !== 'server') {
        log('warn', `NIGHTGATE_PROVING_MODE '${raw}' is not 'server' or 'wasm'; using 'server'`);
    }
    return 'server';
}

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
            import('@midnightntwrk/wallet-sdk-shielded'),
            import('@midnightntwrk/wallet-sdk-unshielded-wallet'),
            import('@midnightntwrk/wallet-sdk-dust-wallet'),
            import('@midnightntwrk/wallet-sdk-abstractions')
        ]);
        cachedWallet = { shielded, unshielded, dust, abstractions };
    }
    if (!cachedFacadeSdk) {
        const [facade, networkId] = await Promise.all([
            import('@midnightntwrk/wallet-sdk-facade'),
            import('@midnight-ntwrk/midnight-js-network-id')
        ]);
        cachedFacadeSdk = { facade, networkId };
    }
    return {
        ledger: cachedLedger,
        shielded: cachedWallet.shielded,
        unshielded: cachedWallet.unshielded,
        dust: cachedWallet.dust,
        abstractions: cachedWallet.abstractions,
        facade: cachedFacadeSdk.facade,
        networkId: cachedFacadeSdk.networkId
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
    indexer: any;
    proof: any;
    zk: any;
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
    artifactPath: string;
    /** Generation digest the main thread resolved (module + verifier keys); keys the module cache. */
    artifactDigest?: string;
    privateStateId: string;
    zkConfigPath: string;
    /** Content-tree width of a vault-family artifact (16 default, 32 for attestation-vault-32). */
    slotWidth?: number;
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

/** Insertion-ordered bounded map: `get` refreshes, `set` evicts the oldest entry past `max`. */
export class BoundedCache<K, V> {
    private readonly map = new Map<K, V>();
    constructor(private readonly max: number, private readonly onEvict?: (key: K, value: V) => void) {}
    get(key: K): V | undefined {
        const v = this.map.get(key);
        if (v !== undefined) { this.map.delete(key); this.map.set(key, v); }
        return v;
    }
    set(key: K, value: V): void {
        this.map.delete(key);
        this.map.set(key, value);
        while (this.map.size > this.max) {
            const oldest = this.map.keys().next().value as K;
            const evicted = this.map.get(oldest) as V;
            this.map.delete(oldest);
            try { this.onEvict?.(oldest, evicted); } catch { /* eviction hooks are best effort */ }
        }
    }
    has(key: K): boolean { return this.map.has(key); }
    delete(key: K): boolean { return this.map.delete(key); }
    get size(): number { return this.map.size; }
    keys(): K[] { return [...this.map.keys()]; }
}

/** Artifact generations kept warm (classes, zk config + proving providers); NIGHTGATE_WORKER_GENERATION_CACHE, default 8. */
function generationCacheSize(): number {
    const n = Number(process.env.NIGHTGATE_WORKER_GENERATION_CACHE);
    return Number.isInteger(n) && n >= 1 ? n : 8;
}
const contractScaffolds = new BoundedCache<string, ContractScaffold>(generationCacheSize(), (key) => onGenerationEvicted(key.split('\0')[2] ?? ''));

/** Test seam: drop every cached class. Node's ESM cache keeps the modules. */
export function __resetScaffoldCacheForTests(): void {
    for (const k of contractScaffolds.keys()) contractScaffolds.delete(k);
}

export async function getContractScaffold(name: string, registration: ContractRegistration): Promise<ContractScaffold> {
    // Keyed by name, artifact path and generation digest: a registry name is a
    // mutable alias and a revision can be rewritten in place under one path.
    // The class is imported from the generation's verified immutable snapshot.
    const generation = registration.artifactDigest ?? '';
    const key = `${name}\0${registration.artifactPath}\0${generation}`;
    const cached = contractScaffolds.get(key);
    if (cached) return cached;
    let mod: any;
    if (generation) {
        const snapshot = materializeArtifactSnapshot(name, registration);
        mod = await importArtifactGeneration(snapshot!.modulePath, generation);
        noteGenerationImported(generation);
    } else {
        // No digest on the registration (pre-0.21 caller): nothing to pin to.
        mod = await importArtifactGeneration(registration.artifactPath, generation);
    }
    const contractClass = mod.Contract ?? mod.default ?? mod;
    const scaffold: ContractScaffold = { contractClass };
    contractScaffolds.set(key, scaffold);
    return scaffold;
}

// ---- Content-addressed artifact snapshots ---------------------------------

/**
 * Immutable content-addressed snapshot of one artifact generation:
 * `<root>/<digest>/{module/artifact.<ext>,keys,zkir}`, root = NIGHTGATE_ARTIFACT_SNAPSHOT_DIR
 * or the OS temp dir. The SDK reads keys/zkir lazily at proving time and Node reads the
 * module at `import()`, so neither ever gets the mutable registration directory.
 * Built under a temp name, verified against the pinned digest, renamed into place, never
 * written again. The root links `node_modules` to the worker's own so the bare
 * `@midnight-ntwrk/compact-runtime` import resolves to the pinned runtime. A snapshot is
 * swept when evicted from the bounded caches with no job holding it (retainGeneration);
 * stale ones (NIGHTGATE_ARTIFACT_SNAPSHOT_TTL_DAYS, default 14) and `.tmp-*` builds are
 * swept once per process at first use. Node's ESM module cache is not bounded by any of this.
 */
export interface ArtifactSnapshot {
    digest: string;
    /** Immutable directory holding keys/ and zkir/ of this generation. */
    zkConfigPath: string;
    /** The module inside the snapshot; the class is imported from here. */
    modulePath: string;
}
const verifiedSnapshots = new Set<string>();
let snapshotRootPrepared: string | null = null;
const SNAPSHOT_ROOT_MARKER = '.nightgate-snapshot-root';

/** The configured or default base; the per-install and per-process levels live below it. */
export function artifactSnapshotBase(): string {
    const configured = process.env.NIGHTGATE_ARTIFACT_SNAPSHOT_DIR?.trim();
    return configured || path.join(os.tmpdir(), 'nightgate-artifact-snapshots');
}

/** One level per installation (the node_modules the runtime resolves from); two installs never share a link. */
function installKey(): string {
    return crypto.createHash('sha256').update(runtimeNodeModulesDir()).digest('hex').slice(0, 16);
}

/**
 * This process's snapshot root: `<base>/<install>/<pid>`. Snapshots, the node_modules
 * link, refcounts and evictions are process-local; another NIGHTGATE process cannot
 * repoint the link or sweep a snapshot in use here. Dead-process roots are removed in
 * prepareSnapshotRoot.
 */
export function artifactSnapshotRoot(): string {
    return path.join(artifactSnapshotBase(), installKey(), String(process.pid));
}

function processAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException)?.code === 'EPERM'; }
}

/** Test seam: forget which snapshots this process verified and prepared. */
export function __resetArtifactSnapshotsForTests(): void {
    verifiedSnapshots.clear();
    snapshotRootPrepared = null;
    generationRefs.clear();
}

function snapshotTtlMs(): number {
    const days = Number(process.env.NIGHTGATE_ARTIFACT_SNAPSHOT_TTL_DAYS);
    return (Number.isFinite(days) && days >= 0 ? days : 14) * 24 * 60 * 60 * 1000;
}

/** The node_modules directory the worker itself resolves compact-runtime from. */
function runtimeNodeModulesDir(): string {
    const resolved = require.resolve('@midnight-ntwrk/compact-runtime');
    const idx = resolved.lastIndexOf(`${path.sep}node_modules${path.sep}`);
    if (idx < 0) throw new Error(`cannot locate the node_modules directory of @midnight-ntwrk/compact-runtime (resolved to ${resolved})`);
    return resolved.slice(0, idx + `${path.sep}node_modules`.length);
}

/** Once per process: create the root, link its node_modules, sweep stale snapshots and leftover temp builds. */
function prepareSnapshotRoot(): string {
    const root = artifactSnapshotRoot();
    if (snapshotRootPrepared === root) return root;
    fs.mkdirSync(root, { recursive: true });
    // Only a link this code created (marker present, entry is a link) is replaced;
    // a real node_modules directory or a foreign link fails closed.
    const marker = path.join(root, SNAPSHOT_ROOT_MARKER);
    const link = path.join(root, 'node_modules');
    const target = runtimeNodeModulesDir();
    let linkOk = false;
    let current: fs.Stats | null = null;
    try { current = fs.lstatSync(link); } catch { current = null; }
    if (current) {
        if (!current.isSymbolicLink()) {
            throw new Error(`artifact snapshot root ${root} contains a real node_modules directory; NIGHTGATE_ARTIFACT_SNAPSHOT_DIR must be a directory of its own (it links node_modules for artifact resolution). Refusing to touch it.`);
        }
        try { linkOk = path.resolve(fs.realpathSync(link)) === path.resolve(fs.realpathSync(target)); } catch { linkOk = false; }
        if (!linkOk) {
            if (!fs.existsSync(marker)) {
                throw new Error(`artifact snapshot root ${root} contains a node_modules link NIGHTGATE did not create (no ${SNAPSHOT_ROOT_MARKER} marker); refusing to replace it. Point NIGHTGATE_ARTIFACT_SNAPSHOT_DIR at a directory of its own.`);
            }
            fs.rmSync(link, { force: true });
        }
    }
    if (!fs.existsSync(marker)) fs.writeFileSync(marker, 'content-addressed contract artifact snapshots of @odatano/nightgate; safe to delete while no NIGHTGATE is running\n');
    if (!linkOk) {
        fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    }
    // Sweep 1: roots of dead processes of this installation. A live process, or
    // one this user cannot signal, keeps its root.
    const installDir = path.dirname(root);
    try {
        for (const entry of fs.readdirSync(installDir)) {
            const pid = Number(entry);
            if (!Number.isInteger(pid) || pid === process.pid || processAlive(pid)) continue;
            const full = path.join(installDir, entry);
            try {
                if (fs.lstatSync(full).isDirectory()) {
                    fs.rmSync(full, { recursive: true, force: true });
                    log('info', `artifact snapshot sweep: removed root of dead process ${pid}`);
                }
            } catch { /* best effort */ }
        }
    } catch { /* best effort */ }
    // Sweep 2: leftover temp builds and snapshots unused within the TTL (mtime is bumped on every use, touchSnapshot).
    const cutoff = Date.now() - snapshotTtlMs();
    for (const entry of fs.readdirSync(root)) {
        if (entry === 'node_modules' || entry === SNAPSHOT_ROOT_MARKER) continue;
        const full = path.join(root, entry);
        try {
            const st = fs.lstatSync(full);
            if (!st.isDirectory()) continue;
            if (entry.includes('.tmp-') || st.mtimeMs < cutoff) {
                fs.rmSync(full, { recursive: true, force: true });
                log('info', `artifact snapshot sweep: removed ${entry.includes('.tmp-') ? 'leftover build' : 'stale snapshot'} ${entry.slice(0, 24)}…`);
            }
        } catch { /* best effort */ }
    }
    snapshotRootPrepared = root;
    return root;
}

function copyDirFiltered(from: string, to: string, filter: (f: string) => boolean): void {
    let files: string[] = [];
    try { files = fs.readdirSync(from).filter(filter).sort(); } catch { return; }
    if (files.length === 0) return;
    fs.mkdirSync(to, { recursive: true });
    for (const f of files) fs.copyFileSync(path.join(from, f), path.join(to, f));
}

/**
 * Canonical module name inside a snapshot; the digest is the identity, not the file
 * name. The extension carries the effective module format (`.mjs`/`.cjs`): the snapshot
 * lives outside the package scope whose package.json made a `.js` file ESM. The format
 * is part of the digest.
 */
function snapshotModuleName(registration: ContractRegistration): string {
    return effectiveModuleFormat(registration.artifactPath) === 'module' ? 'artifact.mjs' : 'artifact.cjs';
}

function snapshotRegistration(dir: string, registration: ContractRegistration) {
    return {
        artifactPath: path.join(dir, 'module', snapshotModuleName(registration)),
        privateStateId: registration.privateStateId,
        zkConfigPath: dir,
        ...(registration.slotWidth !== undefined ? { slotWidth: registration.slotWidth } : {})
    };
}

/**
 * Copy a source map next to the snapshot module with its `sourceRoot` made
 * absolute against the ORIGINAL module directory, so the `sources` it names
 * keep resolving (they are relative to where the map used to live). An
 * unparseable map is copied verbatim.
 */
function copySourceMapRebased(from: string, to: string, originalDir: string): void {
    try {
        const map = JSON.parse(fs.readFileSync(from, 'utf8'));
        if (map && typeof map === 'object') {
            // An absolute directory (trailing separator), which is what Node's
            // and Vite's source-map resolvers prepend to each `sources` entry.
            map.sourceRoot = path.resolve(originalDir, String(map.sourceRoot ?? '')) + path.sep;
            fs.writeFileSync(to, JSON.stringify(map));
            return;
        }
    } catch { /* fall through: verbatim copy */ }
    fs.copyFileSync(from, to);
}

function touchSnapshot(dir: string): void {
    try { const now = new Date(); fs.utimesSync(dir, now, now); } catch { /* best effort */ }
}

export function materializeArtifactSnapshot(name: string, registration: ContractRegistration): ArtifactSnapshot | null {
    const digest = registration.artifactDigest;
    if (!digest) return null;
    const root = prepareSnapshotRoot();
    const dir = path.join(root, digest);
    const snapReg = snapshotRegistration(dir, registration);
    const result: ArtifactSnapshot = { digest, zkConfigPath: dir, modulePath: snapReg.artifactPath };

    if (verifiedSnapshots.has(digest) && fs.existsSync(snapReg.artifactPath)) { touchSnapshot(dir); return result; }
    if (fs.existsSync(dir)) {
        let onDisk: string | null = null;
        try { onDisk = computeArtifactGenerationDigest(snapReg); } catch { onDisk = null; }
        if (onDisk === digest) { verifiedSnapshots.add(digest); touchSnapshot(dir); return result; }
        log('warn', `artifact snapshot ${digest.slice(0, 16)}… for '${name}' does not verify (${onDisk ? onDisk.slice(0, 16) + '…' : 'unreadable'}); rebuilding it from the registration`);
        fs.rmSync(dir, { recursive: true, force: true });
    }

    const tmp = `${dir}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    try {
        fs.mkdirSync(path.join(tmp, 'module'), { recursive: true });
        fs.copyFileSync(registration.artifactPath, path.join(tmp, 'module', snapshotModuleName(registration)));
        // Carry the source map under the name the module's sourceMappingURL names,
        // so stack traces keep working. Not part of the digest.
        const mapName = `${path.basename(registration.artifactPath)}.map`;
        const mapPath = path.join(path.dirname(registration.artifactPath), mapName);
        if (fs.existsSync(mapPath)) copySourceMapRebased(mapPath, path.join(tmp, 'module', mapName), path.dirname(registration.artifactPath));
        copyDirFiltered(path.join(registration.zkConfigPath, 'keys'), path.join(tmp, 'keys'), (f) => f.endsWith('.verifier') || f.endsWith('.prover'));
        copyDirFiltered(path.join(registration.zkConfigPath, 'zkir'), path.join(tmp, 'zkir'), () => true);
        const built = computeArtifactGenerationDigest(snapshotRegistration(tmp, registration));
        if (built !== digest) {
            throw new Error(
                `Contract '${name}' on disk is artifact generation ${built.slice(0, 16)}… but this job was pinned to ` +
                `${digest.slice(0, 16)}…; the module or its zk assets changed since the job was resolved. ` +
                `Refusing to snapshot a different generation; re-register the artifact (or re-issue the action against the current one).`);
        }
        try {
            fs.renameSync(tmp, dir);
        } catch (e) {
            // A concurrent job of the same generation won the rename: use its
            // snapshot if it verifies, otherwise surface the error.
            if (!fs.existsSync(dir) || computeArtifactGenerationDigest(snapReg) !== digest) throw e;
        }
        verifiedSnapshots.add(digest);
        log('info', `artifact snapshot ${digest.slice(0, 16)}… materialised for '${name}' under ${dir}`);
        return result;
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
}

// ---- Worker rotation ---------------------------------------------------------

/**
 * Node's ESM module cache keeps every imported generation for the life of the thread.
 * After NIGHTGATE_WORKER_MAX_GENERATIONS (default 32, 0 = never) distinct generations the
 * worker exits at the next idle moment (no RPC in flight, so no session lock held and no
 * proof running); the main thread respawns it and counts a rotation, not a crash.
 * A rotation makes the facade set cold (a large dust snapshot deserialises for minutes).
 */
const importedGenerations = new Set<string>();
let rotationPending = false;
/** Admission closed: in-flight RPCs drain, new ones are refused with WORKER_ROTATING and retried by the client. */
let draining = false;
let inflightRpcs = 0;
export const WORKER_ROTATING = 'WORKER_ROTATING';

function maxGenerationsBeforeRotation(): number {
    const n = Number(process.env.NIGHTGATE_WORKER_MAX_GENERATIONS);
    return Number.isInteger(n) && n >= 0 ? n : 32;
}

/** Records an imported generation; returns true once a rotation is due. */
export function noteGenerationImported(digest: string): boolean {
    if (!digest) return rotationPending;
    importedGenerations.add(digest);
    const max = maxGenerationsBeforeRotation();
    if (max > 0 && importedGenerations.size >= max && !rotationPending) {
        rotationPending = true;
        log('warn', `worker imported ${importedGenerations.size} distinct artifact generations (NIGHTGATE_WORKER_MAX_GENERATIONS=${max}); rotating at the next idle moment to release Node's module cache`);
    }
    return rotationPending;
}

/** Test seam. */
export function __rotationStateForTests(): { generations: number; pending: boolean; draining: boolean; inflight: number } {
    return { generations: importedGenerations.size, pending: rotationPending, draining, inflight: inflightRpcs };
}
export function __resetRotationForTests(): void {
    importedGenerations.clear(); rotationPending = false; draining = false; inflightRpcs = 0;
}

/**
 * Runs on every RPC completion (success or failure) and when a rotation becomes due:
 * close admission first (the main thread holds new calls until the respawn), then exit
 * once nothing is in flight. An admitted proof or submission always completes.
 */
function rotateIfDue(): void {
    if (!rotationPending) return;
    if (!draining) {
        draining = true;
        parentPort?.postMessage({ kind: 'rotating', generations: importedGenerations.size, inflight: inflightRpcs });
        log('info', `worker rotating after ${importedGenerations.size} artifact generations: admission closed, ${inflightRpcs} call(s) draining; the main thread respawns it`);
    }
    if (inflightRpcs > 0) return;
    // In a worker thread process.exit() ends this thread only.
    setImmediate(() => process.exit(0));
}

/** Test seam: the dispatcher's admission decision. */
export function __admitRpcForTests(): boolean { return !draining; }

// ---- Generation retention ---------------------------------------------------

const generationRefs = new Map<string, number>();

/** A job holds its generation for the whole RPC; the snapshot cannot be swept meanwhile. */
export function retainGeneration(digest: string | undefined): () => void {
    if (!digest) return () => undefined;
    generationRefs.set(digest, (generationRefs.get(digest) ?? 0) + 1);
    let released = false;
    return () => {
        if (released) return;
        released = true;
        const n = (generationRefs.get(digest) ?? 1) - 1;
        if (n > 0) generationRefs.set(digest, n);
        else { generationRefs.delete(digest); sweepGenerationIfUnused(digest); }
    };
}

function generationCached(digest: string): boolean {
    return contractScaffolds.keys().some(k => k.endsWith(`\0${digest}`)) || zkProviderBundles.keys().some(k => k.endsWith(`|${digest}`));
}

/** Evicted from a cache: drop the snapshot unless a job or the other cache still uses the generation. */
function onGenerationEvicted(digest: string): void {
    if (digest) sweepGenerationIfUnused(digest);
}

function sweepGenerationIfUnused(digest: string): void {
    if (!digest || generationRefs.has(digest) || generationCached(digest)) return;
    const dir = path.join(artifactSnapshotRoot(), digest);
    verifiedSnapshots.delete(digest);
    try {
        if (fs.existsSync(dir)) {
            fs.rmSync(dir, { recursive: true, force: true });
            log('info', `artifact snapshot ${digest.slice(0, 16)}… released (generation no longer cached or in use)`);
        }
    } catch (e) {
        log('warn', `artifact snapshot ${digest.slice(0, 16)}… could not be removed: ${String((e as Error)?.message ?? e)}`);
    }
}

/** Test seam: run the eviction path for a digest as the caches would. */
export function __evictGenerationForTests(digest: string): void {
    for (const k of contractScaffolds.keys()) if (k.endsWith(`\0${digest}`)) contractScaffolds.delete(k);
    for (const k of zkProviderBundles.keys()) if (k.endsWith(`|${digest}`)) zkProviderBundles.delete(k);
    onGenerationEvicted(digest);
}

/** Zk asset path for a job: the immutable snapshot of its pinned generation, or the registration directory when there is no digest. */
export function artifactAssetPath(name: string, registration: ContractRegistration): string {
    return materializeArtifactSnapshot(name, registration)?.zkConfigPath ?? registration.zkConfigPath;
}

/** Refuses a contract whose files no longer hash to the pinned generation. No digest on the registration = nothing to verify. */
export function assertArtifactGenerationOnDisk(name: string, registration: ContractRegistration): void {
    if (!registration.artifactDigest) return;
    const onDisk = computeArtifactGenerationDigest(registration);
    if (onDisk !== registration.artifactDigest) {
        throw new Error(
            `Contract '${name}' on disk is artifact generation ${onDisk.slice(0, 16)}… but this job was pinned to ` +
            `${registration.artifactDigest.slice(0, 16)}…; the module or its zk assets changed since the job was resolved. ` +
            `Refusing to load a different generation; re-register the artifact (or re-issue the action against the current one).`);
    }
}

/**
 * Generation-pinned artifact import for both module formats (mirrors contract-registry's
 * loader). ESM is cached per URL, so a `?gen=<digest>` query yields a fresh instance;
 * Node 22 serves a CommonJS module from its cache by filename regardless of the query,
 * so its cache entry is dropped first.
 */
export async function importArtifactGeneration(artifactPath: string, generation: string): Promise<any> {
    if (!path.isAbsolute(artifactPath)) return import(artifactPath);
    try { delete require.cache[require.resolve(artifactPath)]; } catch { /* ESM-only path */ }
    const url = pathToFileURL(artifactPath);
    if (generation) url.searchParams.set('gen', generation.slice(0, 32));
    return import(url.href);
}

/**
 * Per-contract constructor arguments for deploys. The AttestationVault
 * constructor takes the registrar identity as a PUBLIC argument (0.16.0):
 * a witness-backed constructor makes the deploy proof heavy enough that,
 * with 13 circuits' verifier keys, the node rejects the deploy tx as
 * exceeding its block cost limits. The worker injects the DEPLOY SESSION's
 * attester id (persistentHash over the same secret the local_secret_key()
 * witness serves), preserving the pre-0.16.0 "registrar = deploy session"
 * semantics exactly.
 */
async function deployConstructorArgs(contractName: string, entry: FacadeEntry): Promise<unknown[]> {
    // The whole vault family (attestation-vault, attestation-vault-32, future
    // width variants) shares the registrar-as-public-arg constructor; a
    // name-equality check here silently deployed variants with NO constructor
    // args, which the contract rejects.
    if (!contractName.startsWith('attestation-vault')) return [];
    const rt: any = await import('@midnight-ntwrk/compact-runtime');
    const attesterId: Uint8Array = rt.persistentHash(new rt.CompactTypeBytes(32), entry.attestationSecret);
    return [attesterId];
}

/**
 * Builds a CompiledContract for the given registered contract. If the
 * contract declares no witnesses, supplies vacant ones (counter). Otherwise
 * looks up the witness factory and feeds it the FacadeEntry's
 * attestationSecret (AttestationVault).
 *
 * Witnesses bind to a Compact Contract instance for the lifetime of its use,
 * so we must build them fresh per call; different sessions yield different
 * attester ids.
 */
/**
 * Witnesses for a registered contract NIGHTGATE has no witness factory for.
 *
 * Every name reads as a function, which is all a Compact constructor checks,
 * and calling one throws instead of feeding a circuit silent zeroes. A proxy
 * rather than a fixed set because the declared names live only in the emitted
 * constructor's checks, not in an exported list.
 */
export function unregisteredWitnessStub(contractName: string): Record<string, unknown> {
    return new Proxy({}, {
        has: () => true,
        get: (_target, prop: string | symbol) => {
            if (typeof prop === 'symbol') return undefined;
            return () => {
                throw new Error(
                    `contract '${contractName}' asked for the witness '${String(prop)}', which NIGHTGATE holds no material for. `
                    + 'Registered foreign contracts can be deployed (a constructor takes no witnesses); calls into them have to be '
                    + 'built by the caller, e.g. with @odatano/nightgate/txbuilder, and sponsored.'
                );
            };
        }
    });
}

async function getOrCompileContract(
    name: string,
    registration: ContractRegistration,
    entry: FacadeEntry,
    merkleProof?: MerkleProofBundle,
    merkleProofHolder?: { current?: MerkleProofBundle }
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
        ? CompiledContract.withWitnesses(witnessFactory({
            attestationSecret: entry.attestationSecret, merkleProof, merkleProofHolder,
            // Width variants (attestation-vault-32) size the witness decode
            // checks from the registration; absent means the classic 16.
            ...(registration.slotWidth !== undefined ? { slotWidth: registration.slotWidth } : {})
        }))
        // No factory: a contract we hold no witness material for. Vacant
        // witnesses are an EMPTY object, and a Compact constructor checks each
        // declared witness name individually, so anything with witnesses died
        // in `new Contract({})` before it could be deployed. A deploy never
        // calls a witness (the constructor runs on public args), so a stub that
        // satisfies the name check and throws when a CIRCUIT reaches for it
        // makes foreign contracts deployable and still fails calls loudly.
        : CompiledContract.withWitnesses(unregisteredWitnessStub(name));

    return CompiledContract.make(name, contractClass).pipe(
        witnessStep,
        // Assets of the pinned generation, never the mutable directory.
        CompiledContract.withCompiledFileAssets(artifactAssetPath(name, registration))
    );
}

// ---- Worker-side provider construction (Phase 2b) -------------------------

// One indexerPublicDataProvider (graphql-ws connection) per indexer endpoint, shared by
// every contract and generation. Zk config + proving providers are per (proof server,
// asset path, generation) and bounded.
const publicDataProviders = new Map<string, Promise<any>>();
const zkProviderBundles = new BoundedCache<string, Promise<{ zkConfigProvider: any; proofProvider: any }>>(generationCacheSize(), (key) => onGenerationEvicted(key.split('|').pop() ?? ''));

function getPublicDataProvider(indexerHttpUrl: string, indexerWsUrl: string): Promise<any> {
    const key = `${indexerHttpUrl}|${indexerWsUrl}`;
    let p = publicDataProviders.get(key);
    if (!p) {
        p = (async () => {
            // `ws` is CJS; Node 22 worker_threads can `require` it freely.
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const WebSocket = require('ws');
            const { indexer } = await loadContractsSdk();
            return indexer.indexerPublicDataProvider(indexerHttpUrl, indexerWsUrl, WebSocket);
        })();
        p.catch(() => { publicDataProviders.delete(key); });
        publicDataProviders.set(key, p);
    }
    return p;
}

function buildWorkerContractProviders(args: {
    indexerHttpUrl: string;
    indexerWsUrl: string;
    proofServerUrl: string;
    /** Immutable asset path of the pinned generation (artifactAssetPath), or the registration dir for digest-less callers. */
    zkConfigPath: string;
    /** Artifact generation the assets belong to; part of the provider cache key. */
    generation?: string;
}): Promise<{ publicDataProvider: any; zkConfigProvider: any; proofProvider: any }> {
    const key = `${args.proofServerUrl}|${args.zkConfigPath}|${args.generation ?? ''}`;
    let bundleP = zkProviderBundles.get(key);
    if (!bundleP) {
        bundleP = (async () => {
            const { proof, zk } = await loadContractsSdk();
            const zkConfigProvider = new zk.NodeZkConfigProvider(args.zkConfigPath);
            let proofProvider;
            if (resolveProvingMode() === 'wasm') {
                proofProvider = await buildWasmProofProvider(zkConfigProvider);
                log('info', 'contract proving: in-process (wasm), proof server not used');
            } else {
                proofProvider = proof.httpClientProofProvider(args.proofServerUrl, zkConfigProvider, { timeout: Number(process.env.NIGHTGATE_PROOF_TIMEOUT_MS || 300000) }); // MZCASH: proof HTTP timeout override (default 5 min = midnight-js DEFAULT_TIMEOUT)
            }
            return { zkConfigProvider, proofProvider };
        })();
        // A failed build (e.g. transient import error) must not stick: evict
        // the rejected promise so the next deploy/call retries.
        bundleP.catch(() => { zkProviderBundles.delete(key); });
        zkProviderBundles.set(key, bundleP);
    }
    return Promise.all([getPublicDataProvider(args.indexerHttpUrl, args.indexerWsUrl), bundleP])
        .then(([publicDataProvider, bundle]) => ({ publicDataProvider, ...bundle }));
}

// ---- findDeployedContract query caching -----------------------------------
// (FR wallet-save-pipeline-cpu-efficiency, remaining item)

// findDeployedContract re-runs the same indexer queries on EVERY call. Two of
// them are immutable per address: the deploy tx data and the DEPLOY-TIME
// contract state. On a grown ledger state (the vault grows with every anchored
// passport) these cost seconds per call (part of findContract=8.4s observed
// live on the predicate call), so serve them from a per-worker cache after
// first contact. Deliberately NOT cached:
// - queryContractState (the CURRENT state): findDeployedContract verifies the
//   local verifier keys against it, and VKs can be rotated/removed by
//   circuit-maintenance transactions from OTHER clients at any time; caching
//   would bypass that SDK safety check with a stale state for the rest of the
//   worker's life.
// - queryZSwapAndContractState: the state the circuit call builds transcripts
//   against; calls must always execute on fresh state.
const FIND_CONTRACT_CACHED_METHODS = new Set(['watchForDeployTxData', 'queryDeployContractState']);
const findContractQueryCache = new Map<string, Promise<unknown>>();

function withFindContractQueryCache(publicDataProvider: any, indexerHttpUrl: string): any {
    return new Proxy(publicDataProvider, {
        get(target, prop) {
            const v = target[prop];
            if (typeof v !== 'function') return v;
            if (typeof prop !== 'string' || !FIND_CONTRACT_CACHED_METHODS.has(prop)) return v.bind(target);
            return (contractAddress: string, ...rest: unknown[]) => {
                // Extra args (e.g. a block-offset config) select non-latest
                // variants; only the plain per-address form is cacheable.
                if (rest.length > 0) return v.call(target, contractAddress, ...rest);
                const cacheKey = `${prop}|${indexerHttpUrl}|${contractAddress}`;
                let p = findContractQueryCache.get(cacheKey);
                if (!p) {
                    p = v.call(target, contractAddress);
                    // Transient indexer failures must not stick.
                    p!.catch(() => { findContractQueryCache.delete(cacheKey); });
                    findContractQueryCache.set(cacheKey, p!);
                }
                return p;
            };
        }
    });
}

/**
 * Adapts a worker-side facade into the SDK's WalletProvider & MidnightProvider
 * shape. balanceTx routes through balanceUnboundTransaction → finalizeRecipe
 * (matches the main-thread wallet-material-factory adapter pre-Phase-2b).
 */
// Upper bound for the pre-balance sync wait. Long enough to absorb a normal
// tip catch-up between submissions, short enough that a stalled indexer
// subscription fails the job promptly instead of hanging. Env-overridable.
const BALANCE_SYNC_TIMEOUT_MS = Number(process.env.NIGHTGATE_BALANCE_SYNC_TIMEOUT_MS || 180_000);

// How close to the DUST STREAM tip counts as "caught up". Measured in ledger
// EVENTS, not blocks: the dust sub-wallet consumes dustLedgerEvents whose ids
// advance independently of (and far slower than) block height. A few events
// of slack avoids chasing a moving target.
const SYNC_TIP_GAP = BigInt(process.env.NIGHTGATE_SYNC_TIP_GAP || '8');
// The indexer's latest block must be at most this old for "caught up" to
// count. This preserves the guard against a lagging (self-hosted) indexer:
// the wallet would sync to a STALE tip and later spend dust whose merkle
// roots have pruned out of the node's root_history (Custom error 117).
const SYNC_FRESHNESS_MS = Number(process.env.NIGHTGATE_SYNC_FRESHNESS_MS || 300_000);
const SYNC_POLL_MS = 3000;
// How often the catch-up loop reports progress (log line + snapshot refresh).
const SYNC_PROGRESS_LOG_MS = 15_000;
// Rate is measured against an anchor no older than this, so a long catch-up
// reports its CURRENT throughput rather than an average diluted by the start.
const SYNC_RATE_WINDOW_MS = 60_000;
// A sync whose appliedIndex has not moved for this long is stalled; a sync still
// applying events is slow and runs up to the absolute ceiling. <= 0 disables.
const SYNC_STALL_MS = Number(process.env.NIGHTGATE_PREWARM_STALL_MS ?? 600_000);
// Absolute ceiling for the prewarm wait when the caller passes none; SYNC_STALL_MS is the primary limit.
const SYNC_CEILING_MS = 12 * 60 * 60 * 1000;
const wsleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/**
 * Last observed catch-up progress for one facade, refreshed by
 * `waitForGenuineSync` on every poll and PUSHED to the main thread (which caches
 * it) at the progress-log cadence.
 *
 * This exists because a catch-up used to be completely opaque: between "facade
 * started" and "CAUGHT UP" the worker emitted nothing above debug level, so a
 * stalled sync and a working one were indistinguishable from outside and the
 * only way to tell them apart was sampling the OS process CPU counter.
 *
 * Push, not an RPC the main thread issues: a catch-up is CPU-bound work on THIS
 * single thread, so a request/response round trip would be answered slowly or
 * time out exactly in the situation the numbers are wanted for. Pushing means
 * the main thread always has an answer, timestamped so a reader can tell how
 * stale it is. Numbers are decimal strings: appliedIndex and streamTip are
 * ledger-event ids (bigint) and must not lose precision crossing the thread
 * boundary or OData.
 */
export interface SyncProgressSnapshot {
    /** The facade key this snapshot belongs to (the caller's accountId). */
    sessionId: string;
    /** Ledger events applied by the dust sub-wallet so far. '-1' when unknown. */
    appliedIndex: string;
    /** Current tip of the dust ledger-event stream. '-1' when the probe failed. */
    streamTip: string;
    /** streamTip - appliedIndex, or null when either side is unknown. */
    behindEvents: string | null;
    /** Applied events per second over the last ~minute; null until measurable. */
    eventsPerSecond: number | null;
    /** Seconds to reach the tip at the current rate; null when not derivable. */
    etaSeconds: number | null;
    /** Indexer block height, for correlating with the chain. */
    blockHeight: string | null;
    isConnected: boolean;
    /** The indexer's latest block is recent enough to count as tip. */
    indexerFresh: boolean;
    caughtUp: boolean;
    /** Milliseconds this wait has been running. */
    elapsedMs: number;
    /** The wait that produced this snapshot ('prewarm', 'balance', ...). */
    label: string;
    updatedAt: string;
    /**
     * When `appliedIndex` last advanced (the wait's start until it first moves).
     * Unchanged across polls while `updatedAt` moves = stalled, not slow.
     */
    lastProgressAt: string;
}

const syncProgress = new Map<string, SyncProgressSnapshot>();

function pushSyncProgress(snapshot: SyncProgressSnapshot): void {
    parentPort?.postMessage({ kind: 'sync-progress', sessionId: snapshot.sessionId, snapshot });
}

/** The indexer's latest indexed block (height + timestamp, ms epoch). */
async function getIndexerTip(indexerHttpUrl: string): Promise<{ height: bigint | null; timestampMs: number | null }> {
    try {
        const r = await fetch(indexerHttpUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: '{ block { height timestamp } }' }),
            signal: AbortSignal.timeout(15_000)
        });
        const j: any = await r.json();
        const b = j?.data?.block;
        return {
            height: b?.height != null ? BigInt(b.height) : null,
            timestampMs: b?.timestamp != null ? Number(b.timestamp) : null
        };
    } catch { return { height: null, timestampMs: null }; }
}

// One stream-tip probe per few seconds is plenty for a 3s poll loop.
let dustTipCache: { tip: bigint; at: number } | null = null;

/**
 * The dust ledger-event stream's CURRENT tip (max id), read straight from the
 * indexer via a one-shot graphql-transport-ws subscription: the stream's
 * first backfill event carries `maxId`. This is the only reliable target for
 * the dust sub-wallet's `appliedIndex`:
 *  - `dust.progress.highestIndex` stays 0 against the public indexers, so
 *    the SDK itself never reports the stream tip;
 *  - the Block end-indices are DIFFERENT series and do not match the
 *    dustLedgerEvents ids (measured: dustGenerationEndIndex ~330k,
 *    dustCommitmentEndIndex ~939k vs stream maxId ~1.262M).
 * The ws URL is derived from the HTTP URL (.../graphql -> .../graphql/ws).
 * Returns null on any failure; callers treat that as "tip unknown".
 */
async function getDustStreamTip(indexerHttpUrl: string): Promise<bigint | null> {
    if (dustTipCache && Date.now() - dustTipCache.at < 10_000) return dustTipCache.tip;
    const wsUrl = deriveIndexerWsUrl(indexerHttpUrl);
    try {
        const { default: WebSocket } = await import('ws');
        const tip = await new Promise<bigint | null>((resolve) => {
            const sock: any = new (WebSocket as any)(wsUrl, 'graphql-transport-ws');
            let settled = false;
            const done = (v: bigint | null) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                try { sock.close(); } catch { /* already closed */ }
                resolve(v);
            };
            const timer = setTimeout(() => done(null), 10_000);
            sock.on('open', () => sock.send(JSON.stringify({ type: 'connection_init' })));
            sock.on('message', (buf: Buffer) => {
                try {
                    const m = JSON.parse(buf.toString());
                    if (m.type === 'connection_ack') {
                        sock.send(JSON.stringify({
                            id: '1', type: 'subscribe',
                            payload: { query: 'subscription { dustLedgerEvents(id: 0) { id maxId } }' }
                        }));
                    } else if (m.type === 'next') {
                        const maxId = m.payload?.data?.dustLedgerEvents?.maxId;
                        done(maxId != null ? BigInt(maxId) : null);
                    } else if (m.type === 'error' || m.type === 'complete') {
                        done(null);
                    }
                } catch { done(null); }
            });
            sock.on('error', () => done(null));
            sock.on('close', () => done(null));
        });
        if (tip != null) dustTipCache = { tip, at: Date.now() };
        return tip;
    } catch { return null; }
}

/**
 * GENUINE sync gate.
 *
 * `dust.progress.appliedIndex` counts LEDGER EVENTS (the indexer's
 * dustLedgerEvents id series), NOT blocks. Comparing it against the indexer's
 * BLOCK height is wrong: the event series never reaches block height
 * (preprod: ~1.26M events vs ~1.59M blocks), so every fully synced wallet
 * would look like a silent "stall" at the event tip and the prewarm would
 * time out.
 *
 * `dust.progress.highestIndex` stays 0 against the public indexers, so the
 * SDK never reports the stream tip itself. The tip therefore comes from
 * `getDustStreamTip` (a one-shot dustLedgerEvents probe whose first event
 * carries `maxId`).
 *
 * The gate checks, per poll:
 *   1. `appliedIndex >= streamTip - SYNC_TIP_GAP`: caught up with the dust
 *      stream's OWN tip, with `isConnected`.
 *   2. `streamTip > 0`: guards the historical failure where a wallet that
 *      never received a tip looked trivially synced.
 *   3. The indexer's latest block timestamp is fresh (SYNC_FRESHNESS_MS).
 *      This preserves the original guard motivation: a lagging self-hosted
 *      indexer must not count as tip, or balancing spends dust whose merkle
 *      roots pruned out of the node's ~1h root_history (Custom error 117).
 *
 * `waitForSyncedState()` is still not trusted; we read the numbers.
 *
 * Every poll refreshes `syncProgress[entry.sessionId]` and, every
 * SYNC_PROGRESS_LOG_MS, emits an INFO line. Both carry the applied index, the
 * stream tip, the current rate and an ETA, so a slow catch-up is legible from
 * the log and from `getSyncProgress` instead of looking identical to a hang.
 */
/** One emission of the non-blocking `facade.state()` observable, or null on timeout/error. Never blocks on `waitForSyncedState()`. */
async function peekFacadeState(facade: any, timeoutMs: number): Promise<any | null> {
    let sub: any;
    let timer: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            new Promise<any>((res, rej) => {
                try { sub = facade.state().subscribe({ next: (v: any) => res(v), error: (e: any) => rej(e) }); }
                catch (e) { rej(e); }
            }),
            new Promise<null>(res => { timer = setTimeout(() => res(null), timeoutMs); })
        ]);
    } catch {
        return null;
    } finally {
        try { sub && sub.unsubscribe(); } catch { }
        if (timer) clearTimeout(timer);
    }
}

/** Registered NIGHT UTXOs in a facade state's full unshielded coin set. */
function countRegisteredNightUtxos(state: any): number {
    // The full coin set when the SDK exposes one, else the available set (some shapes flag registered coins there).
    const all: any[] = state?.unshielded?.totalCoins
        ?? state?.unshielded?.allCoins ?? state?.unshielded?.coins ?? state?.unshielded?.availableCoins ?? [];
    return all.filter((c: any) => c?.meta?.registeredForDustGeneration === true).length;
}

/** Every unshielded NIGHT UTXO, registered or not; `fallback` when the SDK exposes no full coin set. */
function countAllNightUtxos(state: any, fallback: number): number {
    const all: any[] | undefined = state?.unshielded?.totalCoins
        ?? state?.unshielded?.allCoins ?? state?.unshielded?.coins;
    return Array.isArray(all) ? all.length : fallback;
}

async function waitForGenuineSync(entry: FacadeEntry, timeoutMs: number, label: string, stallMs: number = SYNC_STALL_MS): Promise<void> {
    const { facade, indexerHttpUrl, sessionId } = entry;
    const startedAt = Date.now();
    const deadline = startedAt + timeoutMs;
    let lastLog = 0;
    let lastApplied = -1n;
    let lastHighest = -1n;
    // The first observation seeds the index without counting as progress: an
    // index unchanged from the start is stalled once stallMs has passed.
    let progressApplied = -1n;
    let lastProgressAt = startedAt;
    // Sliding anchor for the rate: refreshed once it ages past the window, so
    // the reported throughput tracks the present, not the whole wait.
    let anchor: { applied: bigint; at: number } | null = null;

    const publish = (
        applied: bigint, highest: bigint, blockHeight: bigint | null,
        connected: boolean, fresh: boolean, caughtUp: boolean
    ): SyncProgressSnapshot => {
        const now = Date.now();
        let eventsPerSecond: number | null = null;
        if (applied >= 0n) {
            if (!anchor) {
                anchor = { applied, at: now };
            } else if (now - anchor.at >= SYNC_POLL_MS) {
                const seconds = (now - anchor.at) / 1000;
                const delta = Number(applied - anchor.applied);
                // A restored facade can report a LOWER index right after start;
                // a negative rate is noise, not information.
                if (delta >= 0) eventsPerSecond = delta / seconds;
                if (now - anchor.at >= SYNC_RATE_WINDOW_MS) anchor = { applied, at: now };
            }
        }
        const behind = highest >= 0n && applied >= 0n ? highest - applied : null;
        const snapshot: SyncProgressSnapshot = {
            sessionId,
            appliedIndex: applied.toString(),
            streamTip: highest.toString(),
            behindEvents: behind != null ? behind.toString() : null,
            eventsPerSecond,
            etaSeconds: behind != null && behind > 0n && eventsPerSecond != null && eventsPerSecond > 0
                ? Math.round(Number(behind) / eventsPerSecond)
                : (behind === 0n ? 0 : null),
            blockHeight: blockHeight != null ? blockHeight.toString() : null,
            isConnected: connected,
            indexerFresh: fresh,
            caughtUp,
            elapsedMs: now - startedAt,
            label,
            updatedAt: new Date(now).toISOString(),
            lastProgressAt: new Date(lastProgressAt).toISOString()
        };
        syncProgress.set(sessionId, snapshot);
        return snapshot;
    };

    while (Date.now() < deadline) {
        const tip = await getIndexerTip(indexerHttpUrl);
        // Read state via the NON-BLOCKING facade.state() observable.
        // facade.waitForSyncedState() is Promise.all([... dust.waitForSyncedState() ...])
        // which only resolves once every sub-wallet isStrictlyComplete(). That is never
        // true against an indexer not yet caught_up to chain tip (highestIndex stays 0),
        // so it would time out every poll and the real (advancing) appliedIndex would
        // never be read. The observable emits the current FacadeState immediately.
        let state: any;
        let sub: any;
        let peekTimer: NodeJS.Timeout | undefined;
        let peekFailed = false;
        try {
            state = await Promise.race([
                new Promise<any>((res, rej) => {
                    try { sub = facade.state().subscribe({ next: (v: any) => res(v), error: (e: any) => rej(e) }); }
                    catch (e) { rej(e); }
                }),
                new Promise((_, rej) => { peekTimer = setTimeout(() => rej(new Error('state peek timeout')), 30_000); })
            ]);
        } catch {
            peekFailed = true;
        } finally {
            // Always release the subscription and timer, whether `next` fired or
            // the timeout won the race. On a stalled indexer the timeout wins
            // every poll, so leaking here would accumulate one live subscription
            // per cycle exactly on the pathological path.
            try { sub && sub.unsubscribe(); } catch { }
            if (peekTimer) clearTimeout(peekTimer);
        }
        if (peekFailed) {
            // A state observable that never emits (or errors every poll) counts as no
            // progress for the stall bound. The last readable snapshot stays for diagnosis.
            if (stallMs > 0 && Date.now() - lastProgressAt > stallMs) {
                const last = syncProgress.get(sessionId);
                throw new Error(`wallet sync stalled: no progress for ${Math.round((Date.now() - lastProgressAt) / 60_000)} min and the wallet state is not readable (state peek timed out or failed on every poll; last snapshot: dust appliedIndex=${last?.appliedIndex ?? lastApplied}, streamTip=${last?.streamTip ?? lastHighest}, isConnected=${last?.isConnected ?? '?'}, elapsed=${Math.round((Date.now() - startedAt) / 1000)}s)`);
            }
            await wsleep(SYNC_POLL_MS);
            continue;
        }
        const p: any = state?.dust?.progress;
        const applied = p?.appliedIndex != null ? BigInt(p.appliedIndex) : -1n;
        const streamTip = await getDustStreamTip(indexerHttpUrl);
        const highest = streamTip ?? -1n;
        const connected = p?.isConnected === true;
        const fresh = tip.timestampMs != null && Date.now() - tip.timestampMs <= SYNC_FRESHNESS_MS;
        lastApplied = applied;
        lastHighest = highest;
        if (applied >= 0n) {
            if (progressApplied >= 0n && applied > progressApplied) lastProgressAt = Date.now();
            progressApplied = applied;
        }
        const caughtUp = connected && highest > 0n && applied >= 0n && applied >= highest - SYNC_TIP_GAP && fresh;
        const snapshot = publish(applied, highest, tip.height, connected, fresh, caughtUp);
        if (caughtUp) {
            pushSyncProgress(snapshot);
            log('info', `genuine-sync [${label}] CAUGHT UP: appliedIndex=${applied} streamTip=${highest} blockHeight=${tip.height} fresh=${fresh} after=${Math.round(snapshot.elapsedMs / 1000)}s`);
            return;
        }
        if (stallMs > 0 && Date.now() - lastProgressAt > stallMs) {
            // The last snapshot stays readable; the message names this condition ("no progress", not "too slow").
            pushSyncProgress(snapshot);
            const behind = snapshot.behindEvents ?? '?';
            throw new Error(`wallet sync stalled: no progress for ${Math.round((Date.now() - lastProgressAt) / 60_000)} min (dust appliedIndex stuck at ${applied}, streamTip=${highest}, ${behind} events behind, blockHeight=${tip.height}, isConnected=${connected}, indexerFresh=${fresh}, elapsed=${Math.round(snapshot.elapsedMs / 1000)}s)`);
        }
        // INFO, not debug: without this line a multi-hour catch-up is
        // indistinguishable from a hang for anyone outside this thread. The
        // push shares the cadence so the readable snapshot and the log agree.
        if (Date.now() - lastLog > SYNC_PROGRESS_LOG_MS) {
            pushSyncProgress(snapshot);
            const rate = snapshot.eventsPerSecond != null ? snapshot.eventsPerSecond.toFixed(1) : '?';
            const eta = snapshot.etaSeconds != null ? `${Math.round(snapshot.etaSeconds / 60)}min` : '?';
            log('info', `genuine-sync [${label}] ${sessionId.slice(0, 16)} appliedIndex=${applied} streamTip=${highest} behindEvents=${snapshot.behindEvents ?? '?'} rate=${rate}/s eta=${eta} elapsed=${Math.round(snapshot.elapsedMs / 1000)}s blockHeight=${tip.height} fresh=${fresh} connected=${connected}`);
            lastLog = Date.now();
        }
        await wsleep(SYNC_POLL_MS);
    }
    const tip = await getIndexerTip(indexerHttpUrl);
    const behind = lastHighest >= 0n && lastApplied >= 0n ? (lastHighest - lastApplied).toString() : '?';
    // The last snapshot stays in `syncProgress` on purpose: a caller that saw
    // the timeout can still read how far the wallet got and how fast it was
    // moving, which is what separates "too slow" from "stalled".
    const rate = syncProgress.get(sessionId)?.eventsPerSecond;
    throw new Error(`wallet not synced to tip after ${timeoutMs}ms (absolute ceiling): still ${behind} events behind at ${rate != null ? rate.toFixed(1) : '?'} events/s, dust appliedIndex=${lastApplied} streamTip=${lastHighest}, blockHeight=${tip.height}; the sync was moving (no stall detected), raise NIGHTGATE_PREWARM_SYNC_TIMEOUT_MS or wait for a quieter machine`);
}

/**
 * Pre-submit diagnostic dump: summarizes every intent's dust section of a
 * balanced/proven transaction. Node error `1010 Custom error: 117`
 * (NotNormalized) has exactly one dust-related trigger in the ledger: a
 * DustActions section whose spends AND registrations are both empty
 * (midnight-ledger dust.rs "non-canonical dust actions: empty"). This dump
 * makes the next 117 attributable: either the log shows an empty DustActions
 * (balancer bug, wallet SDK Transacting.balanceTransactions attaches the
 * section even for an empty recipe) or the malformation is elsewhere in the
 * transaction. Never throws: diagnostics must not break the submit path.
 */
export function describeTxDust(tx: any): { summary: string; emptyDustActions: boolean } {
    try {
        const parts: string[] = [];
        let empty = false;
        const intents = tx?.intents;
        if (!intents || typeof intents.entries !== 'function') {
            return { summary: 'no intents', emptyDustActions: false };
        }
        for (const [seg, intent] of intents.entries()) {
            const da = intent?.dustActions;
            if (!da) {
                parts.push(`seg=${seg} dust=none`);
                continue;
            }
            const spends = da.spends?.length ?? 0;
            const regs = da.registrations?.length ?? 0;
            const ctime = da.ctime instanceof Date ? da.ctime.toISOString() : String(da.ctime ?? '?');
            parts.push(`seg=${seg} dust{spends=${spends} regs=${regs} ctime=${ctime}}`);
            if (spends === 0 && regs === 0) empty = true;
        }
        return { summary: parts.join(' | ') || 'no intents', emptyDustActions: empty };
    } catch (e) {
        return { summary: `dump failed: ${(e as Error)?.message ?? e}`, emptyDustActions: false };
    }
}

/**
 * Best-effort revert of a built-but-never-submitted recipe (or finalized tx).
 *
 * SDK builds move the selected coins into the sub-wallets' `pendingUtxos` at
 * BUILD time. A recipe that is discarded (fee estimate) or dies before a
 * successful submit must be reverted, or those coins stay pending forever:
 * there is no TTL reclaim for untracked builds, and the periodic state save
 * persists the phantom spend across restarts (bug_002 Bug A). The facade's
 * public `revert(txOrRecipe)` runs the same sequence as its internal error
 * paths; sub-wallet rollbacks are keyed no-ops on absent entries, so
 * overlapping with the SDK's own reverts (finalize/submit catch) is safe.
 */
export async function revertRecipeBestEffort(facade: any, txOrRecipe: any, site: string): Promise<void> {
    if (!txOrRecipe) return;
    try {
        await facade.revert(txOrRecipe);
    } catch (e) {
        log('warn', `${site}: recipe revert failed (coins may stay pending until a fresh resync): ${formatErr(e)}`);
    }
}

/**
 * Fee of a recipe that exists only to be priced: computes the fee, then
 * ALWAYS reverts the recipe (success and failure alike).
 *
 * Uses `calculateTransactionFee`, not `estimateTransactionFee`: the estimate
 * variant re-runs the dust balancer's convergence loop (uncapped
 * `Effect.iterate` under `Effect.runSync`) over the already fee-balanced tx
 * and can pin the worker's event loop (bug_002 Bug B). On a balanced recipe
 * `calculateFee` yields the fee that recipe actually pays, loop-free.
 */
export async function feeOfDiscardedRecipe(facade: any, recipe: any, site: string): Promise<bigint> {
    try {
        return await facade.calculateTransactionFee(recipe.transaction);
    } finally {
        await revertRecipeBestEffort(facade, recipe, site);
    }
}

// ---- Dust wedge protection (dust-pending-note-leak FR) --------------------
//
// A submission that provably never reached the mempool leaves the dust note
// it spent marked in-flight FOREVER: the facade's submit-error revert does
// call dust.revertTransaction, but CoreWallet.applyFailed drops the
// pendingDust marker while the ledger-side reclaim
// (processTtls(ctime + grace)) no-ops, so the note stays spent in
// DustLocalState and no later sweep can find it. A single-note wallet (the
// common self-generation case) is then wedged: every build fails with
// `could not balance dust` until a cold re-sync. Until that is fixed
// upstream, we snapshot the dust sub-wallet BEFORE each build (the build is
// what books the spend) and, when the submit dies pre-mempool, swap in a
// fresh dust wallet restored from that snapshot. Nothing reached the chain,
// so the snapshot is by definition still valid; sync resumes from the
// snapshot's own progress index, exactly like a restart warm-restore.

/**
 * Substrate rejects that provably never entered the mempool: 1010 (invalid),
 * 1014 (priority too low; the pool kept the EARLIER tx, this one never
 * entered) and 1016 (immediately dropped). Deliberately NOT 1013 (already
 * imported: the tx IS in the pool, its spends must stay marked in-flight).
 *
 * The SDK buries the node's reject under generic wrappers (live-verified:
 * the thrown error is `(FiberFailure) SubmissionError: Transaction
 * submission error`, while `1010: Invalid Transaction: Custom error: 182`
 * only exists in the nested `cause`), so this matches against a bounded
 * deep inspection of the whole error structure, not just `message`.
 */
export function isPreMempoolReject(err: unknown): boolean {
    // classificationHaystack strips stack frames and :line:col tokens, so a
    // source position like `wallet.js:1010:27` cannot register as a reject
    // code; the numeric match additionally requires the node's `NNNN:` shape.
    const haystack = classificationHaystack(err);
    return /\b101[046]\s*:|priority is too low|immediately dropped|invalid transaction/i.test(haystack);
}

/**
 * Arm the wedge protection for the submission that is about to build.
 * Best-effort: a failed snapshot only disarms the protection for this tx.
 */
async function captureDustSnapshot(entry: FacadeEntry, site: string): Promise<void> {
    try {
        entry.preSubmitDustSnapshot = await entry.facade.dust.serializeState();
    } catch (e) {
        entry.preSubmitDustSnapshot = undefined;
        log('warn', `${site}: dust pre-build snapshot failed (wedge protection disarmed for this tx): ${formatErr(e)}`);
    }
}

/**
 * Replace the facade's dust sub-wallet with one restored from the armed
 * pre-build snapshot. The swap is safe mid-life: facade methods and our
 * periodic save / sync probes all reach the sub-wallet through `facade.dust`
 * at call time, and submits serialize per facade (the dispatcher's
 * SUBMIT_METHODS lock) so no other build is in flight. The unbound sponsor
 * path runs outside that lock but never books a spend in this wallet and
 * never arms this snapshot, so it cannot be rolled back by (or steal) one.
 * The old wallet is stopped only after the restored one started; if the
 * restore fails the old (wedged) wallet stays, which is no worse than today.
 */
async function restoreDustFromSnapshot(entry: FacadeEntry, site: string): Promise<void> {
    const snapshot = entry.preSubmitDustSnapshot;
    entry.preSubmitDustSnapshot = undefined;
    if (!snapshot) return;
    try {
        const sdk = await loadSdk();
        const fresh = sdk.dust.DustWallet(entry.walletConfiguration).restore(snapshot);
        await fresh.start(entry.dustKey);
        const old = entry.facade.dust;
        entry.facade.dust = fresh;
        try { await old.stop(); } catch { /* already dead is fine */ }
        // The periodic save may have persisted the poisoned in-flight state
        // while the tx was proving; a crash before the next tick would then
        // warm-restore the wedge. Persist the clean snapshot NOW, under a
        // bumped dust epoch: a save tick that already serialized the
        // pre-restore wallet drops its dust blob (epoch check in the tick),
        // and acks of dust pushed under an older epoch are ignored by
        // applySaveAck, so neither late pushes nor out-of-order acks can
        // win over the restored baseline.
        entry.dustEpoch = (entry.dustEpoch ?? 0) + 1;
        log('info', `${site}: dust sub-wallet restored from pre-build snapshot after pre-mempool reject (leaked in-flight spend discarded, snapshot re-persisted)`);
        // The push alone is fire-and-forget; a crash or persist failure
        // between push and ack would keep the poisoned DB state. WAIT for
        // the main thread's ack (bounded) and count the restore as durable
        // only then: dustRestoreCount reports persist-CONFIRMED restores,
        // so the live e2e gate also proves durability.
        try {
            await pushStateSaveAcked(entry.sessionId, entry, { dust: snapshot }, restoreSaveAckTimeoutMs());
            entry.dustRestoresPersisted = (entry.dustRestoresPersisted ?? 0) + 1;
            log('info', `${site}: restored dust snapshot persist CONFIRMED (state-save ack)`);
        } catch (e) {
            log('warn', `${site}: restored dust snapshot persist NOT confirmed (${formatErr(e)}); the DB may hold the pre-restore state until the next periodic save lands`);
        }
    } catch (e) {
        log('warn', `${site}: dust snapshot restore failed; wallet may be dust-wedged until a cold re-sync: ${formatErr(e)}`);
    }
}

/**
 * Best-effort pre-submit diagnostics: serialized size and the ledger's own
 * cost verdict for the transaction. Reads the ledger's cost model
 * (Transaction.cost) so a "1010: Transaction would exhaust the block
 * limits" reject is diagnosable from the field (which dimension overflowed,
 * by how much). Never throws; costing failures only log.
 */
async function logTxCost(tx: any, site: string): Promise<void> {
    try {
        const bytes = typeof tx?.serialize === 'function' ? tx.serialize() : undefined;
        const size = bytes?.length ?? bytes?.byteLength;
        let costSummary = 'n/a';
        try {
            const ledger: any = cachedLedger ?? (cachedLedger = await import('@midnight-ntwrk/ledger-v8'));
            const params = ledger.LedgerParameters?.initialParameters?.()
                ?? ledger.LedgerParameters?.default?.();
            if (params && typeof tx?.cost === 'function') {
                const c = tx.cost(params);
                costSummary = typeof c === 'object' ? JSON.stringify(c, (_k, v) => typeof v === 'bigint' ? v.toString() : v) : String(c);
            }
        } catch (err) {
            costSummary = `cost() failed: ${(err as Error)?.message}`;
        }
        log('info', `${site}: pre-submit tx size=${size ?? '?'}B cost=${costSummary.slice(0, 800)}`);
    } catch {
        /* diagnostics only */
    }
}

/**
 * facade.submitTransaction with the dust-wedge protection applied: a
 * pre-mempool reject restores the pre-build dust snapshot, every other
 * outcome (success, or a failure where the tx may have reached the pool)
 * just disarms it. Never restore for post-mempool failures: a tx that
 * landed and failed on-chain HAS consumed its guaranteed-section dust fee.
 */
async function submitWithDustGuard(entry: FacadeEntry, tx: any, site: string): Promise<any> {
    await logTxCost(tx, site);
    try {
        const txId = await entry.facade.submitTransaction(tx);
        entry.preSubmitDustSnapshot = undefined;
        return txId;
    } catch (e) {
        if (isPreMempoolReject(e)) {
            await restoreDustFromSnapshot(entry, site);
        } else {
            // Deliberate: a tx that may have reached the pool keeps its
            // booked spends. Log the inspected head so a mis-classified
            // reject is diagnosable from the field.
            log('info', `${site}: submit failed, NOT classified pre-mempool (dust guard disarmed): ${safeDeepInspect(e, 512).slice(0, 600)}`);
            entry.preSubmitDustSnapshot = undefined;
        }
        throw e;
    }
}

// ---- Dedicated submission clients (parallel sponsor path) ------------------
//
// The SDK's PolkadotNodeClient ends EVERY submission stream with
// `api.disconnect()` on the facade's ONE shared node socket
// (`Stream.ensuring` in sendMidnightTransaction). Two concurrent
// submitAndWatch subscriptions on that client therefore kill each other: the
// first stream to finish drops the socket and the other never receives its
// InBlock/Finalized (live 2026-08-19: 3 of 4 concurrent sponsorings hung with
// their transactions already on-chain). "Submits serialize per facade" is
// thus a NODE-CLIENT invariant, independent of dust state. Every concurrent
// unbound submit gets its OWN SDK SubmissionService (own socket) from a small
// pool per relay URL; a slot is exclusive while its submit is in flight.
//
// SETTLE WINDOW: `WsProvider.disconnect()` returns before the socket is
// closed and `isConnected` stays true until `onclose`, so the SDK's
// ensureConnection skips the reconnect and sends on a CLOSING socket, which
// rejects the request with `disconnected ...: 1000:: Normal Closure`. The
// SDK client disconnects right after creation (PolkadotNodeClient.make) and
// after every submission stream (Stream.ensuring), so a slot is unusable
// for a moment after both (measured: broken at <= 300 ms, fine at >= 800 ms
// against preprod). A slot therefore becomes ready only SUBMIT_CLIENT_SETTLE_MS
// after creation and after each use; a submit that still dies on that exact
// close is retried once (the request never left the closing socket, so no
// double submit is possible).
let SUBMIT_CLIENT_POOL_MAX = 8;
const SUBMIT_CLIENT_SETTLE_MS = 2500;
type SubmitClientSlot = { svc: any; busy: Promise<unknown> | null; readyAt: number };
const submitClientPools = new Map<string, SubmitClientSlot[]>();
const submitClientWaiters = new Map<string, number>(); // callers currently acquiring, per relay
// Test seams: cap + pool introspection (the cap is a constant in production).
export const __submitClientPoolForTests = {
    setMax: (n: number) => { SUBMIT_CLIENT_POOL_MAX = n; },
    size: (relayURL: URL) => submitClientPools.get(relayURL.toString())?.length ?? 0,
    reset: () => submitClientPools.clear()
};

export class SubmitWatchTimeoutError extends Error {
    constructor(ms: number) { super(`submit watch timed out after ${ms}ms without a Finalized status`); this.name = 'SubmitWatchTimeoutError'; }
}

async function withDedicatedSubmitClient<T>(relayURL: URL, fn: (svc: any) => Promise<T>, opts: { abandonAfterMs?: number } = {}): Promise<T> {
    const key = relayURL.toString();
    let pool = submitClientPools.get(key);
    if (!pool) { pool = []; submitClientPools.set(key, pool); }
    submitClientWaiters.set(key, (submitClientWaiters.get(key) ?? 0) + 1);
    let slot: SubmitClientSlot | undefined;
    try {
        for (;;) {
            const now = Date.now();
            const free = pool.filter((s) => s.busy === null);
            slot = free.find((s) => s.readyAt <= now);
            if (slot) break;
            // Create a client only when the free (ready or settling) slots cannot
            // cover the callers currently waiting, and never beyond the cap. The
            // slot is RESERVED SYNCHRONOUSLY (before any await) so concurrent
            // first callers cannot all pass the size check and over-create; it is
            // not ready (readyAt = Infinity) until the client exists.
            const waiters = submitClientWaiters.get(key) ?? 1;
            if (pool.length < SUBMIT_CLIENT_POOL_MAX && free.length < waiters) {
                const created: SubmitClientSlot = { svc: null, busy: null, readyAt: Number.POSITIVE_INFINITY };
                pool.push(created);
                try {
                    const caps: any = await loadSubmissionSdk();
                    created.svc = caps.makeDefaultSubmissionService({ relayURL });
                    created.readyAt = Date.now() + SUBMIT_CLIENT_SETTLE_MS;
                } catch (e) {
                    pool.splice(pool.indexOf(created), 1);
                    throw e;
                }
                continue; // re-evaluate; the new slot becomes ready after its settle window
            }
            const settling = free.filter((s) => Number.isFinite(s.readyAt));
            if (settling.length > 0) {
                const wait = Math.max(0, Math.min(...settling.map((s) => s.readyAt)) - Date.now());
                await new Promise((r) => setTimeout(r, wait));
            } else if (free.length > 0) {
                await new Promise((r) => setTimeout(r, 100)); // a slot is being created by another caller
            } else {
                await Promise.race(pool.map((s) => s.busy!.catch(() => undefined)));
            }
        }
    } finally {
        submitClientWaiters.set(key, Math.max(0, (submitClientWaiters.get(key) ?? 1) - 1));
    }
    const run = fn(slot.svc);
    slot.busy = run.catch(() => undefined);
    if (!opts.abandonAfterMs) {
        try { return await run; } finally { slot.busy = null; slot.readyAt = Date.now() + SUBMIT_CLIENT_SETTLE_MS; }
    }
    // WATCHDOG: a submitAndWatch whose socket died mid-watch never resolves
    // (the SDK client has no auto-reconnect after its own disconnect()). Do
    // not let that pin the job until the TTL: abandon the call, EVICT the slot
    // (its socket/subscription state is unknown) and let the caller decide via
    // the indexer whether the transaction is on-chain.
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new SubmitWatchTimeoutError(opts.abandonAfterMs!)), opts.abandonAfterMs); });
    try {
        return await Promise.race([run, timeout]);
    } catch (e) {
        if (e instanceof SubmitWatchTimeoutError) {
            const idx = pool.indexOf(slot);
            if (idx >= 0) pool.splice(idx, 1);
            try { await slot.svc?.close?.(); } catch { /* best effort */ }
            slot.busy = null;
        }
        throw e;
    } finally {
        if (timer) clearTimeout(timer);
        if (pool.includes(slot)) { slot.busy = null; slot.readyAt = Date.now() + SUBMIT_CLIENT_SETTLE_MS; }
    }
}

/**
 * Indexer lookup by transaction IDENTIFIER; null when unknown or unreachable.
 * Also returns the ledger's APPLY result: `SUCCESS`, or `PARTIAL_SUCCESS` /
 * `FAILURE` when a segment (the contract call) was rejected at apply time
 * although the transaction sits in a block (its guaranteed part, i.e. the
 * fee, went through). A sponsoring whose call did not apply is NOT a success
 * (live: `attest` in block 2172277 with segment 42593 success=false, the
 * anchor never existed, the sponsor paid).
 */
async function indexerBlockOfIdentifier(indexerHttpUrl: string, identifier: string): Promise<{ height: string; status: string | null; failedSegments: number[] } | null> {
    try {
        const r = await fetch(indexerHttpUrl, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: `{ transactions(offset:{identifier:"${identifier}"}) { block { height } ... on RegularTransaction { transactionResult { status segments { id success } } } } }` }),
            signal: AbortSignal.timeout(15_000)
        });
        const j: any = await r.json();
        const t = j?.data?.transactions?.[0];
        const h = t?.block?.height;
        if (h == null) return null;
        const res = t?.transactionResult;
        const failed = Array.isArray(res?.segments) ? res.segments.filter((s: any) => s?.success === false).map((s: any) => Number(s.id)) : [];
        return { height: String(h), status: res?.status ?? null, failedSegments: failed };
    } catch { return null; }
}

export class SponsoredCallNotAppliedError extends Error {
    constructor(identifier: string, height: string, status: string, failedSegments: number[]) {
        super(`sponsored transaction ${identifier.slice(0, 16)} is in block ${height} but its contract call did NOT apply (ledger result ${status}, failed segment${failedSegments.length === 1 ? '' : 's'} ${failedSegments.join(',') || '?'}); the sponsor paid the fee, the call must be rebuilt against the current contract state`);
        this.name = 'SponsoredCallNotAppliedError';
    }
}
function assertApplied(found: { height: string; status: string | null; failedSegments: number[] }, identifier: string): void {
    if (found.status && found.status !== 'SUCCESS') throw new SponsoredCallNotAppliedError(identifier, found.height, found.status, found.failedSegments);
}
// 60 s by default: a healthy submit sees Finalized well within that on preprod;
// anything slower is answered by the indexer lookup (the tx landed) or by a
// rebuild (it did not), instead of a watch that may never return.
const SUBMIT_WATCH_TIMEOUT_MS = (() => { const n = Number(process.env.NIGHTGATE_SUBMIT_WATCH_TIMEOUT_MS); return Number.isFinite(n) && n > 0 ? n : 60_000; })();
const SUBMIT_WATCH_CONFIRM_MS = 90_000;
// Which submission stage the unbound sponsor path waits for. 'Finalized' is
// what the facade waits for; 'InBlock' returns as soon as the transaction is
// in a block (measured preprod: ~12-18 s earlier per transaction). The job's
// chain outcome is confirmed by the indexer afterwards either way
// (crawler-free chain-outcome confirmer), so a reorg before finality surfaces
// as a failed chain status, not as a lost job. Default InBlock.
const SPONSOR_SUBMIT_WAIT: 'InBlock' | 'Finalized' = process.env.NIGHTGATE_SPONSOR_WAIT?.toLowerCase() === 'finalized' ? 'Finalized' : 'InBlock';
export function sponsorSubmitWaitStage(): 'InBlock' | 'Finalized' { return SPONSOR_SUBMIT_WAIT; }
// After InBlock, wait (bounded) until the PUBLIC INDEXER has the transaction
// before reporting landed: a caller that builds its next call right away reads
// the contract state from that indexer, and between InBlock and indexing it
// serves an inconsistent state (live: `expected a cell, received null` in the
// caller's findDeployedContract). Finalized mode never needed this (the
// indexer was always ahead by then).
const SPONSOR_INDEXER_VISIBLE_MS = (() => { const n = Number(process.env.NIGHTGATE_SPONSOR_INDEXER_VISIBLE_MS); return Number.isFinite(n) && n >= 0 ? n : 30_000; })();
async function waitIndexerVisible(indexerHttpUrl: string, identifier: string, site: string): Promise<void> {
    if (SPONSOR_INDEXER_VISIBLE_MS === 0) return;
    const t0 = Date.now();
    while (Date.now() - t0 < SPONSOR_INDEXER_VISIBLE_MS) {
        const found = await indexerBlockOfIdentifier(indexerHttpUrl, identifier);
        if (found) {
            log('debug', `${site}: indexer has the transaction in block ${found.height} (${found.status ?? 'status n/a'}) after ${Date.now() - t0}ms`);
            assertApplied(found, identifier);
            return;
        }
        await new Promise((r) => setTimeout(r, 1500));
    }
    log('warn', `${site}: transaction in block but not visible on the indexer after ${SPONSOR_INDEXER_VISIBLE_MS}ms; reporting landed anyway`);
}

/**
 * Pre-broadcast handshake with the main thread over the RPC reply port: sends
 * `{ kind: 'submit-intent', txHash }` and resolves when the client acks it
 * (`submit-intent-ack`). Without a port (tests calling the handler directly)
 * it is a no-op. A missing ack is NOT tolerated: better to fail the job before
 * the broadcast than to broadcast without the durable boundary.
 */
/** What the worker knows about the transaction it is about to broadcast. */
export interface SubmitIntent {
    txHash: string;
    /** Inspected from the caller transaction (shape check), not from the allow-list. */
    contractAddress?: string;
    circuits?: string[];
    /** Unbound channel: the dust backing the sponsor pays from. */
    note?: string;
    /** The sponsor ACCOUNT paying (the facade's account id). */
    sponsorAccountId?: string;
    /** Addresses of contract deploy actions in the tx; the main thread reserves the grant's deploy budget on them before acking. */
    deployed?: string[];
}
async function announceSubmitIntent(port: MessagePort | undefined, intent: SubmitIntent): Promise<void> {
    if (!port) return;
    const { txHash } = intent;
    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { port.off('message', onMsg); reject(new Error('submit-intent was not acknowledged by the main thread within 30s; not broadcasting')); }, 30_000);
        const onMsg = (m: any) => {
            if (m?.kind === 'submit-intent-ack' && m.txHash === txHash) {
                clearTimeout(timer); port.off('message', onMsg);
                if (m.ok === false) reject(new Error(`submit-intent rejected by the main thread: ${m.error ?? 'unknown'}`));
                else resolve();
            }
        };
        port.on('message', onMsg);
        port.postMessage({ kind: 'submit-intent', ...intent });
    });
}

/** The send itself died on the client's own lagging close (see settle window). */
export function isClosingSocketReject(err: unknown): boolean {
    return /disconnected from \S*:\s*1000\s*::\s*Normal Closure/i.test(classificationHaystack(err));
}

/**
 * Submit on a DEDICATED node client, without the dust-wedge guard and without
 * the facade's pending-tx tracker: for the unbound sponsor path, which never
 * booked a spend in the facade's dust wallet (the sponsor learns about the
 * landed spend from chain sync). Waits for FINALIZED like the facade does and
 * returns the transaction identifier the facade would return. On failure it
 * logs the reject class so a field 1010/170 is recognisable, then rethrows
 * for the handler's own retry.
 */
async function submitOnDedicatedClient(entry: FacadeEntry, tx: any, site: string): Promise<any> {
    await logTxCost(tx, site);
    const relayURL: URL = entry.walletConfiguration.relayURL;
    const identifier = String(tx.identifiers().at(-1));
    for (let attempt = 0; ; attempt++) {
        try {
            await withDedicatedSubmitClient(relayURL, (svc) => svc.submitTransaction(tx, SPONSOR_SUBMIT_WAIT), { abandonAfterMs: SUBMIT_WATCH_TIMEOUT_MS });
            if (SPONSOR_SUBMIT_WAIT === 'InBlock') await waitIndexerVisible(entry.indexerHttpUrl, identifier, site);
            return identifier;
        } catch (e) {
            if (attempt === 0 && isClosingSocketReject(e)) {
                log('warn', `${site}: submit request died on the client's own closing socket (SDK disconnect lag); retrying once on a settled client`);
                continue;
            }
            if (e instanceof SubmitWatchTimeoutError) {
                // The watch is gone, the transaction may well be on-chain (live:
                // a watch that never saw Finalized while the block was final for
                // minutes). Ask the indexer for up to SUBMIT_WATCH_CONFIRM_MS
                // before calling it lost; only then let the handler rebuild.
                const deadline = Date.now() + SUBMIT_WATCH_CONFIRM_MS;
                for (;;) {
                    const found = await indexerBlockOfIdentifier(entry.indexerHttpUrl, identifier);
                    if (found) {
                        log('info', `${site}: no Finalized within ${SUBMIT_WATCH_TIMEOUT_MS}ms, indexer has the transaction in block ${found.height} (${found.status ?? 'status n/a'}); landed`);
                        assertApplied(found, identifier);
                        return identifier;
                    }
                    if (Date.now() >= deadline) break;
                    await new Promise((r) => setTimeout(r, 10_000));
                }
                log('warn', `${site}: submit watch timed out and the indexer does not know the transaction ${identifier.slice(0, 16)} after ${SUBMIT_WATCH_CONFIRM_MS}ms; failing for a rebuild`);
                throw e;
            }
            log('info', `${site}: submit failed (${isPreMempoolReject(e) ? 'pre-mempool reject' : 'not pre-mempool'}; no dust guard on this path): ${safeDeepInspect(e, 512).slice(0, 600)}`);
            throw e;
        }
    }
}

// Exported for the in-thread unit tests (wallet-worker-dispatch.test.ts):
// the 117-guard around balanceTx/submitTx is OUR logic, not SDK choreography.
export function buildWorkerWalletProvider(entry: FacadeEntry): any {
    return {
        getCoinPublicKey(): string { return entry.zswapKeys.coinPublicKey; },
        getEncryptionPublicKey(): string { return entry.zswapKeys.encryptionPublicKey; },
        async balanceTx(tx: any, ttl?: Date): Promise<any> {
            // Block until GENUINELY synced to the indexer tip before balancing
            // (not the lying isSynced flag). Balancing stale (restored/partial)
            // dust makes the node reject the tx: `1010 Custom error: 170` (dust
            // validity window ctime+grace < tblock) or `117` (pruned dust merkle
            // roots). The prewarm job usually caught up already, so this is a
            // cheap re-check on the warm path; waitForGenuineSync is bounded so a
            // stalled indexer subscription fails fast instead of hanging.
            await waitForGenuineSync(entry, BALANCE_SYNC_TIMEOUT_MS, 'balance');
            // Arm the dust-wedge protection BEFORE the build books the spend.
            await captureDustSnapshot(entry, 'balance');
            const effectiveTtl = ttl ?? new Date(Date.now() + 60 * 60 * 1000);
            const recipe = await entry.facade.balanceUnboundTransaction(
                tx,
                { shieldedSecretKeys: entry.zswapKeys, dustSecretKey: entry.dustKey },
                { ttl: effectiveTtl }
            );
            let finalized: any;
            try {
                finalized = await entry.facade.finalizeRecipe(recipe);
            } catch (e) {
                // On prove failure the SDK reverts only the BALANCING tx of an
                // UNBOUND recipe; the base tx's in-place unshielded spends
                // would stay pending without this (bug_002 Bug A).
                await revertRecipeBestEffort(entry.facade, recipe, 'balance');
                throw e;
            }
            const dust = describeTxDust(finalized);
            log('info', `balanced tx dust sections: ${dust.summary}`);
            if (dust.emptyDustActions) {
                // The node would reject this as 1010/117 (NotNormalized). Fail
                // here instead: saves the proof round and pins the root cause
                // (balancer emitted an empty DustActions = fee evaluated to 0).
                // The tx is finalized but will never be submitted: free its
                // coins now instead of waiting for the pending-tx TTL reclaim.
                await revertRecipeBestEffort(entry.facade, finalized, 'balance');
                throw new Error(
                    'balanced transaction carries an EMPTY DustActions section ' +
                    '(node would reject it as 1010 Custom error: 117 NotNormalized). ' +
                    'The dust balancer produced an empty recipe, i.e. the computed ' +
                    `fee was 0. Dust sections: ${dust.summary}`
                );
            }
            return finalized;
        },
        async submitTx(tx: any): Promise<any> {
            const dust = describeTxDust(tx);
            log('info', `pre-submit tx dust sections: ${dust.summary}`);
            if (dust.emptyDustActions) {
                log('warn', `pre-submit tx has an EMPTY DustActions section (node rejects as 1010/117 NotNormalized): ${dust.summary}`);
            }
            return submitWithDustGuard(entry, tx, 'submit');
        }
    };
}

/**
 * Two-phase sponsored wallet provider: the CALLER builds and signs the
 * transaction, the SPONSOR pays the dust fee and submits.
 *
 * Phase 1 (caller facade): balanceUnboundTransaction with
 * tokenKindsToBalance ['shielded','unshielded'], signRecipe for any
 * unshielded inputs the balancer selected (no-op otherwise), finalizeRecipe.
 * The result is a fully signed, fee-unpaid FinalizedTransaction.
 *
 * Phase 2 (sponsor facade): balanceFinalizedTransaction with
 * tokenKindsToBalance ['dust'] ONLY. Re-balancing token kinds the caller
 * already balanced would double-spend; never widen this list. finalizeRecipe
 * proves the sponsor's dust spends; submitTx routes through the sponsor
 * facade (only the sponsor submits; its state anticipates the dust spends).
 *
 * Both phases share one explicit TTL so a stalled phase 2 cannot submit
 * against an expired phase 1.
 *
 * Exported for the in-thread unit tests, like buildWorkerWalletProvider.
 */
export function buildSponsoredWalletProvider(caller: FacadeEntry, sponsor: FacadeEntry): any {
    // The caller-side finalized tx of the LAST successful balanceTx. Kept so
    // a submit failure can revert the CALLER facade too: the SDK's
    // submitTransaction error path reverts only the facade it ran on (the
    // sponsor), while the caller's spends were pended by phase 1 (bug_002).
    // One slot is enough: providers are built per submission and submits
    // serialize per facade.
    let lastCallerFinalized: any;
    return {
        getCoinPublicKey(): string { return caller.zswapKeys.coinPublicKey; },
        getEncryptionPublicKey(): string { return caller.zswapKeys.encryptionPublicKey; },
        async balanceTx(tx: any, ttl?: Date): Promise<any> {
            // The SPONSOR spends the dust, so ITS wallet must be genuinely
            // synced (stale dust merkle roots are the Custom error 117 site).
            // The caller only balances shielded/unshielded; by default sync it
            // too so stale coin state cannot double-select inputs. Deployments
            // whose sponsored callers are known to hold nothing (e.g. a public
            // demo minting fresh identity wallets) can skip the caller wait
            // with NIGHTGATE_SPONSORED_CALLER_SYNC=skip: with no coins there
            // is nothing to select, and the fee side is the sponsor's alone.
            if (process.env.NIGHTGATE_SPONSORED_CALLER_SYNC === 'skip') {
                log('info', 'sponsored-balance: caller sync SKIPPED (NIGHTGATE_SPONSORED_CALLER_SYNC=skip)');
            } else {
                await waitForGenuineSync(caller, BALANCE_SYNC_TIMEOUT_MS, 'sponsored-balance caller');
            }
            await waitForGenuineSync(sponsor, BALANCE_SYNC_TIMEOUT_MS, 'sponsored-balance sponsor');
            const effectiveTtl = ttl ?? new Date(Date.now() + 30 * 60 * 1000);

            const recipe = await caller.facade.balanceUnboundTransaction(
                tx,
                { shieldedSecretKeys: caller.zswapKeys, dustSecretKey: caller.dustKey },
                { ttl: effectiveTtl, tokenKindsToBalance: ['shielded', 'unshielded'] }
            );
            const callerSign = (payload: Uint8Array) => caller.unshieldedKeystore.signData(payload);
            let callerFinalized: any;
            try {
                const signed = await caller.facade.signRecipe(recipe, callerSign);
                callerFinalized = await caller.facade.finalizeRecipe(signed);
            } catch (e) {
                // Sign failures are not covered by any SDK revert, and prove
                // failures revert only the balancing part of an UNBOUND recipe
                // (bug_002 Bug A). Reverting the unsigned recipe is fine: the
                // rollback matches by UTxO, not object identity.
                await revertRecipeBestEffort(caller.facade, recipe, 'sponsored-balance caller');
                throw e;
            }

            try {
                // Phase 2 books the SPONSOR's dust spend: arm its wedge
                // protection before the build.
                await captureDustSnapshot(sponsor, 'sponsored-balance sponsor');
                const sponsorRecipe = await sponsor.facade.balanceFinalizedTransaction(
                    callerFinalized,
                    { shieldedSecretKeys: sponsor.zswapKeys, dustSecretKey: sponsor.dustKey },
                    { ttl: effectiveTtl, tokenKindsToBalance: ['dust'] }
                );
                let finalized: any;
                try {
                    finalized = await sponsor.facade.finalizeRecipe(sponsorRecipe);
                } catch (e) {
                    await revertRecipeBestEffort(sponsor.facade, sponsorRecipe, 'sponsored-balance sponsor');
                    throw e;
                }

                const dust = describeTxDust(finalized);
                log('info', `sponsored balanced tx dust sections: ${dust.summary}`);
                if (dust.emptyDustActions) {
                    await revertRecipeBestEffort(sponsor.facade, finalized, 'sponsored-balance sponsor');
                    throw new Error(
                        'sponsored balanced transaction carries an EMPTY DustActions section ' +
                        '(node would reject it as 1010 Custom error: 117 NotNormalized). ' +
                        `The sponsor's dust balancer produced an empty recipe, i.e. the computed ` +
                        `fee was 0. Dust sections: ${dust.summary}`
                    );
                }
                lastCallerFinalized = callerFinalized;
                return finalized;
            } catch (e) {
                // The caller-side finalized tx will never be submitted; free
                // its coins now instead of waiting for the TTL reclaim.
                await revertRecipeBestEffort(caller.facade, callerFinalized, 'sponsored-balance caller');
                throw e;
            }
        },
        async submitTx(tx: any): Promise<any> {
            const dust = describeTxDust(tx);
            log('info', `pre-submit (sponsored) tx dust sections: ${dust.summary}`);
            if (dust.emptyDustActions) {
                log('warn', `pre-submit sponsored tx has an EMPTY DustActions section (node rejects as 1010/117 NotNormalized): ${dust.summary}`);
            }
            try {
                const result = await submitWithDustGuard(sponsor, tx, 'sponsored-submit sponsor');
                lastCallerFinalized = undefined;
                return result;
            } catch (e) {
                // The SDK reverted the SPONSOR facade (plus our dust guard
                // above); the caller's phase-1 spends stay pending without
                // this (bug_002). Safe either way: if the tx did land, sync
                // reconciles and a retry is rejected by the node; if it did
                // not, the retry works.
                await revertRecipeBestEffort(caller.facade, lastCallerFinalized ?? tx, 'sponsored-submit caller');
                lastCallerFinalized = undefined;
                throw e;
            }
        }
    };
}

/**
 * EXPERIMENTAL (cross-server-fee-sponsoring FR): a wallet provider that does
 * ONLY the caller's phase 1 (balance shielded/unshielded, sign, finalize) and
 * then STOPS instead of submitting. `submitTx` captures the fee-unpaid,
 * caller-signed FinalizedTransaction into `holder.captured` and returns a
 * sentinel, so the SDK's callTx completes without touching the chain. The
 * captured tx is what a remote sponsor would receive, balance dust onto, and
 * submit.
 *
 * This is the caller half of a cross-server split: prove it round-trips
 * through serialize/deserialize and is still accepted by
 * balanceFinalizedTransaction, and cross-machine sponsoring is just transport.
 */
/** Thrown by the build-only provider to stop the SDK's callTx at submit time. */
class BuildOnlyStop extends Error {
    constructor() { super('build-only: captured finalized tx, stopping before submit'); this.name = 'BuildOnlyStop'; }
}

function buildBuildOnlyWalletProvider(caller: FacadeEntry, holder: { captured?: any }): any {
    return {
        getCoinPublicKey(): string { return caller.zswapKeys.coinPublicKey; },
        getEncryptionPublicKey(): string { return caller.zswapKeys.encryptionPublicKey; },
        async balanceTx(tx: any, ttl?: Date): Promise<any> {
            if (process.env.NIGHTGATE_SPONSORED_CALLER_SYNC !== 'skip') {
                await waitForGenuineSync(caller, BALANCE_SYNC_TIMEOUT_MS, 'build-only caller');
            }
            const effectiveTtl = ttl ?? new Date(Date.now() + 30 * 60 * 1000);
            log('info', 'build-only: balanceUnboundTransaction (shielded/unshielded)');
            const recipe = await caller.facade.balanceUnboundTransaction(
                tx,
                { shieldedSecretKeys: caller.zswapKeys, dustSecretKey: caller.dustKey },
                { ttl: effectiveTtl, tokenKindsToBalance: ['shielded', 'unshielded'] }
            );
            const callerSign = (payload: Uint8Array) => caller.unshieldedKeystore.signData(payload);
            try {
                log('info', 'build-only: signRecipe + finalizeRecipe');
                const signed = await caller.facade.signRecipe(recipe, callerSign);
                const fin = await caller.facade.finalizeRecipe(signed);
                log('info', 'build-only: finalized (fee-unpaid); returning to callTx');
                return fin;
            } catch (e) {
                await revertRecipeBestEffort(caller.facade, recipe, 'build-only caller');
                throw e;
            }
        },
        async submitTx(tx: any): Promise<any> {
            // Capture and STOP: returning a fake tx id lets the SDK's callTx
            // continue into a watch-for-confirmation phase that never resolves.
            // Throwing aborts callTx here; the handler catches BuildOnlyStop and
            // proceeds to the sponsor phase with holder.captured. The caller's
            // phase-1 spends are pended by finalize and reverted by the handler
            // if the sponsor half never runs.
            holder.captured = tx;
            throw new BuildOnlyStop();
        }
    };
}

/**
 * Deserialize a caller-finalized (fee-unpaid, signed, proven, bound) Transaction
 * from base64. ledger-v8 `Transaction.deserialize` takes three string markers
 * (Signaturish/Proofish/Bindingish tags) + the raw bytes; a finalized tx is
 * signed+proven+bound. Live-proven pairing: ('signature','proof','binding').
 */
async function deserializeFinalizedTx(b64: string): Promise<{ tx: any; bytes: Uint8Array }> {
    const bytes = new Uint8Array(Buffer.from(b64, 'base64'));
    const ledger: any = cachedLedger ?? (cachedLedger = await import('@midnight-ntwrk/ledger-v8'));
    const attempts: Array<[string, string, string]> = [
        ['signature', 'proof', 'binding'],
        ['signature', 'proof', 'pre-binding']
    ];
    const errs: string[] = [];
    for (const [s, p, b] of attempts) {
        try { const tx = ledger.Transaction.deserialize(s, p, b, bytes); if (tx) return { tx, bytes }; }
        catch (e) { errs.push(`(${s},${p},${b}): ${formatErr(e).slice(0, 60)}`); }
    }
    throw new Error(`could not deserialize finalized tx (${bytes.length}B); tried ${errs.join(' | ')}`);
}

/**
 * The contract calls a deserialized tx carries: [{ address, entryPoint }].
 * Used to enforce sponsor-side policy (allowed vault + circuits) before paying.
 */
function inspectTxCalls(tx: any): Array<{ address: string; entryPoint: string }> {
    const out: Array<{ address: string; entryPoint: string }> = [];
    try {
        const intents: Map<number, any> | undefined = tx?.intents;
        if (!intents || typeof intents.entries !== 'function') return out;
        for (const [, intent] of Array.from(intents.entries())) {
            for (const action of (intent?.actions ?? [])) {
                const ep = action?.entryPoint;
                const name = typeof ep === 'string' ? ep : (ep instanceof Uint8Array ? new TextDecoder().decode(ep) : '');
                if (name) out.push({ address: String(action?.address ?? ''), entryPoint: name });
            }
        }
    } catch { /* best-effort inspection */ }
    return out;
}

/** True when an offer/action container visibly carries anything. */
function offerNonEmpty(offer: any): boolean {
    if (!offer) return false;
    let sawKnownKey = false;
    for (const key of ['inputs', 'outputs', 'transient', 'spends', 'registrations', 'deltas']) {
        const v = offer[key];
        if (v === undefined) continue;
        sawKnownKey = true;
        if (v === null) continue;
        if (Array.isArray(v)) { if (v.length > 0) return true; continue; }
        if (typeof v?.size === 'number') { if (v.size > 0) return true; continue; }
        if (typeof v?.length === 'number') { if (v.length > 0) return true; continue; }
        // a non-collection value under a content key counts as content
        return true;
    }
    // An offer object whose shape we cannot read at all still counts as
    // content: fail closed rather than sponsor the unknown.
    return !sawKnownKey;
}

/** Default sponsor size budget; a single vault call is ~5.4 KB. */
const DEFAULT_SPONSOR_MAX_TX_BYTES = 65536;
// A sponsored deploy's own ceiling: verifier keys cost a multiple of a call; the ledger caps written bytes at 32 KiB.
const DEFAULT_SPONSOR_MAX_DEPLOY_BYTES = 40_960;

/**
 * FAIL-CLOSED shape check for a transaction the sponsor is about to pay for.
 * The allow-list alone is not enough: a tx with one allowed call could carry
 * a contract DEPLOY, unshielded transfers, zswap offers or its own dust
 * actions in the same envelope, and the sponsor would pay for all of it.
 * Everything that is not an allow-listed contract call is a reason to refuse,
 * and so is structure this inspection cannot read.
 * Exported for the in-thread unit tests.
 */
/** Marker entry point for a sponsored deploy in the returned call list. */
export const DEPLOY_ENTRY_POINT = '<deploy>';

export function checkSponsorableShape(
    tx: any,
    byteLength: number,
    allowedContracts?: string[],
    allowedCircuits?: string[],
    // With `allowDeploy` (floor and grant, decided at admission) a ContractDeploy
    // action is sponsorable: never matched against `allowedContracts` (the address is
    // new), recorded onto the grant afterwards. `maxDeploys` caps deploys per tx (default 1).
    // `ownContracts`: addresses deployed under the requesting grant; calls on them
    // skip the circuit list (their circuits are the caller's, not the floor's).
    options: { allowDeploy?: boolean; maxDeploys?: number; ownContracts?: string[] } = {}
): Array<{ address: string; entryPoint: string }> {
    const maxDeploysPerTx = Number.isInteger(options.maxDeploys) && (options.maxDeploys as number) >= 0 ? (options.maxDeploys as number) : 1;
    let deployCount = 0;
    // A misconfigured budget must not DISABLE the budget ('abc' or 'Infinity'
    // would have skipped the check entirely): anything that is not a positive
    // finite integer falls back to the safe default.
    const rawMax = process.env.NIGHTGATE_SPONSOR_MAX_TX_BYTES;
    const parsedMax = rawMax === undefined ? DEFAULT_SPONSOR_MAX_TX_BYTES : Number(rawMax);
    const maxBytes = (Number.isInteger(parsedMax) && parsedMax > 0) ? parsedMax : DEFAULT_SPONSOR_MAX_TX_BYTES;
    if (maxBytes !== parsedMax) {
        log('warn', `NIGHTGATE_SPONSOR_MAX_TX_BYTES='${rawMax}' is not a positive integer; using the default ${DEFAULT_SPONSOR_MAX_TX_BYTES}`);
    }
    if (byteLength > maxBytes) {
        throw new Error(`refusing to sponsor: transaction is ${byteLength}B, over the ${maxBytes}B budget (NIGHTGATE_SPONSOR_MAX_TX_BYTES)`);
    }

    const intents: Map<number, any> | undefined = tx?.intents;
    if (!intents || typeof intents.entries !== 'function') {
        throw new Error('refusing to sponsor: transaction structure is not inspectable (no intents)');
    }
    // Value moves riding along at the transaction level (zswap).
    for (const key of ['guaranteedOffer', 'fallibleOffer', 'guaranteedCoins', 'fallibleCoins']) {
        const offer = (tx as any)[key];
        if (offer === undefined || offer === null) continue;
        if (typeof offer?.entries === 'function' && !('inputs' in offer)) {
            for (const [, sub] of Array.from(offer.entries() as Iterable<[unknown, unknown]>)) {
                if (offerNonEmpty(sub)) throw new Error(`refusing to sponsor: transaction carries a ${key} (shielded value transfer)`);
            }
        } else if (offerNonEmpty(offer)) {
            throw new Error(`refusing to sponsor: transaction carries a ${key} (shielded value transfer)`);
        }
    }

    const calls: Array<{ address: string; entryPoint: string }> = [];
    for (const [, intent] of Array.from(intents.entries())) {
        // Value moves riding along inside the intent (unshielded / dust). A
        // sponsorable tx is fee-UNPAID by definition, so caller dust actions
        // are just as suspect as token transfers.
        for (const key of ['guaranteedUnshieldedOffer', 'fallibleUnshieldedOffer', 'dustActions']) {
            if (offerNonEmpty(intent?.[key])) {
                throw new Error(`refusing to sponsor: transaction carries ${key} alongside its contract calls`);
            }
        }
        for (const action of (intent?.actions ?? [])) {
            const ep = action?.entryPoint;
            const name = typeof ep === 'string' ? ep : (ep instanceof Uint8Array ? new TextDecoder().decode(ep) : '');
            if (!name) {
                // deploys, maintenance updates, future action kinds
                const kind = action?.constructor?.name || typeof action;
                // A maintenance update changes a contract's authority and is never sponsored;
                // a deploy is refused only without the deploy right. Told apart by shape,
                // not by class name alone.
                const isMaintenance = kind === 'MaintenanceUpdate' || action?.updates !== undefined;
                if (isMaintenance) {
                    throw new Error('refusing to sponsor: transaction carries a contract maintenance update (never sponsorable)');
                }
                const isDeploy = kind === 'ContractDeploy' || (action?.initialState !== undefined && action?.address !== undefined);
                if (isDeploy && options.allowDeploy === true) {
                    const address = String(action?.address ?? '');
                    if (!address) throw new Error('refusing to sponsor: deploy action carries no contract address');
                    deployCount++;
                    if (deployCount > maxDeploysPerTx) {
                        throw new Error(`refusing to sponsor: transaction carries ${deployCount}+ contract deploys; at most ${maxDeploysPerTx} per sponsored transaction`);
                    }
                    // A deploy writes verifier keys on chain and costs a multiple of a call: its own byte ceiling.
                    const rawDeployMax = process.env.NIGHTGATE_SPONSOR_MAX_DEPLOY_BYTES;
                    const parsedDeployMax = rawDeployMax === undefined ? DEFAULT_SPONSOR_MAX_DEPLOY_BYTES : Number(rawDeployMax);
                    const maxDeployBytes = (Number.isInteger(parsedDeployMax) && parsedDeployMax > 0) ? parsedDeployMax : DEFAULT_SPONSOR_MAX_DEPLOY_BYTES;
                    if (byteLength > maxDeployBytes) {
                        throw new Error(`refusing to sponsor: deploy transaction is ${byteLength}B, over the ${maxDeployBytes}B deploy budget (NIGHTGATE_SPONSOR_MAX_DEPLOY_BYTES)`);
                    }
                    calls.push({ address, entryPoint: DEPLOY_ENTRY_POINT });
                    continue;
                }
                throw new Error(`refusing to sponsor: transaction carries a non-call action (${kind})${isDeploy ? '; deploys need allowDeploy on the grant and NIGHTGATE_SPONSOR_ALLOW_DEPLOY on the server' : ''}`);
            }
            const address = String(action?.address ?? '');
            if (allowedContracts?.length && !allowedContracts.includes(address)) {
                throw new Error(`refusing to sponsor: contract ${address.slice(0, 16)} is not in the allow-list`);
            }
            const own = Array.isArray(options.ownContracts) && options.ownContracts.includes(address);
            if (!own && allowedCircuits?.length && !allowedCircuits.includes(name)) {
                throw new Error(`refusing to sponsor: circuit '${name}' is not sponsorable`);
            }
            calls.push({ address, entryPoint: name });
        }
    }
    if (calls.length === 0) throw new Error('refusing to sponsor: the transaction carries no contract call');
    return calls;
}

/**
 * Phase 2 of sponsoring: balance dust onto a caller-finalized tx with the
 * SPONSOR facade and submit. The caller's identity is already baked into the
 * tx; the sponsor only pays. Shared by the probe and the standalone endpoint.
 */
/** Latest DustWalletState snapshot from the facade's dust state Observable. */
async function firstDustState(dust: any): Promise<any> {
    return await new Promise((resolve, reject) => {
        let done = false;
        const sub = dust.state?.subscribe?.({
            next: (v: any) => { if (!done) { done = true; setImmediate(() => sub?.unsubscribe?.()); resolve(v); } },
            error: (e: any) => { if (!done) { done = true; reject(e); } }
        });
        if (!sub) reject(new Error('facade.dust.state not observable'));
        setTimeout(() => { if (!done) { done = true; try { sub?.unsubscribe?.(); } catch { /* */ } reject(new Error('no dust emission in 10s')); } }, 10_000);
    });
}

/**
 * 0.18 note-lock pool. One dust NOTE can back one in-flight spend, but a
 * wallet has many notes, so N notes -> N parallel sponsorings. Locks are
 * in-memory (this worker owns the wallet), keyed `sessionId|backingNight#idx`,
 * TTL-expired so a crashed sponsor path frees the note.
 */
// key -> { expiry ms, lease token }. The token makes release OWNERSHIP-CHECKED:
// a lease that outlived NIGHTGATE_NOTE_LEASE_MS (slow prove/submit) may have
// been taken over by another job; the late finisher must not delete THAT
// job's lock, or a third job would run on the same backing in parallel and
// recreate the very 1010/196 race the lock exists for.
const noteLocks = new Map<string, { exp: number; token: number }>();
let noteLeaseSeq = 0;

/**
 * Lock key is the BACKING NIGHT utxo, NOT the individual note. All dust notes
 * generated by one NIGHT utxo share one generation/nullifier state, so two
 * concurrent spends against the SAME backing conflict in the ledger (1010/196).
 * Parallelism therefore scales with the number of DISTINCT backing NIGHT utxos
 * (many registered utxos in one wallet, or delegation from many accounts to one
 * dust address), which is exactly the dust-note-pool feeder design. Locking per
 * backing serializes same-backing spends and parallelizes distinct-backing ones.
 */
function backingKey(sessionId: string, note: any): string {
    return `${sessionId}|${note?.token?.backingNight ?? '?'}`;
}
function tryLockBacking(sessionId: string, notes: any[], needSpecks: bigint, ttlMs: number): any | null {
    const now = Date.now();
    // Least-charged sufficient note first: keep the big notes for big fees.
    const eligible = notes
        .filter((n) => { try { return BigInt(n.generatedNow ?? 0) >= needSpecks; } catch { return false; } })
        .sort((a, b) => (BigInt(a.generatedNow ?? 0) > BigInt(b.generatedNow ?? 0) ? 1 : -1));
    for (const n of eligible) {
        const key = backingKey(sessionId, n);
        const held = noteLocks.get(key);
        if (held && held.exp > now) continue; // this backing is busy; try a note on another backing
        const token = ++noteLeaseSeq;
        noteLocks.set(key, { exp: now + ttlMs, token });
        return { note: n, key, token, backing: String(n?.token?.backingNight ?? '?').slice(0, 16) };
    }
    return null;
}
/**
 * Lock a free BACKING, WAITING up to `waitMs` for one to free. On a single-
 * backing wallet this SERIALIZES concurrent spends deterministically (the
 * second waits out the first's submit) instead of failing; on a multi-backing
 * wallet the second locks a different backing immediately (parallel). `notes`
 * is refreshed by `refresh()` each poll so a freed backing is seen.
 */
async function acquireBacking(
    sessionId: string, refresh: () => Promise<any[]>, needSpecks: bigint, ttlMs: number, waitMs: number
): Promise<any> {
    const deadline = Date.now() + waitMs;
    for (;;) {
        const notes = await refresh();
        const leased = tryLockBacking(sessionId, notes, needSpecks, ttlMs);
        if (leased) return leased;
        if (Date.now() >= deadline) {
            throw new Error(`no free dust backing with >= ${needSpecks} specks within ${waitMs}ms (all backings busy)`);
        }
        await new Promise((r) => setTimeout(r, 1000));
    }
}
/** Release a backing lease; a no-op when the lease was already taken over. */
function releaseNote(key: string, token: number): void {
    const held = noteLocks.get(key);
    if (held && held.token === token) noteLocks.delete(key);
}
/**
 * Keep a lease alive while its job is still working (prove, submit, watch):
 * the TTL is a crash backstop, not a time budget. An ACTIVE lease in this
 * process must never be taken over by time; renewal every ttl/3 makes a
 * takeover possible only once the holder stopped renewing (it died or
 * finished). Returns a stop function.
 */
function keepLeaseAlive(key: string, token: number, ttlMs: number): () => void {
    const every = Math.max(5, Math.floor(ttlMs / 3));
    const timer = setInterval(() => {
        const held = noteLocks.get(key);
        if (held && held.token === token) held.exp = Date.now() + ttlMs;
    }, every);
    timer.unref?.();
    return () => clearInterval(timer);
}
/** NIGHTGATE_NOTE_LEASE_MS, fail-safe: positive finite integer or the default. */
function noteLeaseTtlMs(): number {
    const raw = process.env.NIGHTGATE_NOTE_LEASE_MS;
    if (raw === undefined) return 5 * 60 * 1000;
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : 5 * 60 * 1000;
}
// Exported for the unit tests (lease ownership + takeover semantics).
export const __noteLeaseForTests = { tryLockBacking, releaseNote, keepLeaseAlive, noteLeaseTtlMs, held: (key: string) => noteLocks.get(key), reset: () => noteLocks.clear() };

async function sponsorAndSubmitFinalized(sponsor: FacadeEntry, rehydrated: any, site: string, replyPort?: MessagePort, calls?: Array<{ address: string; entryPoint: string }>): Promise<string> {
    await waitForGenuineSync(sponsor, BALANCE_SYNC_TIMEOUT_MS, `${site} sponsor`);
    await captureDustSnapshot(sponsor, `${site} sponsor`);
    const sponsorRecipe = await sponsor.facade.balanceFinalizedTransaction(
        rehydrated,
        { shieldedSecretKeys: sponsor.zswapKeys, dustSecretKey: sponsor.dustKey },
        { ttl: new Date(Date.now() + 30 * 60 * 1000), tokenKindsToBalance: ['dust'] }
    );
    const finalized = await sponsor.facade.finalizeRecipe(sponsorRecipe);
    // Same external-effect boundary as the unbound path: the identifier is
    // known before the broadcast; the main thread records it (and acks) first.
    try {
        await announceSubmitIntent(replyPort, {
            txHash: String(finalized.identifiers().at(-1)),
            contractAddress: calls?.[0]?.address, circuits: calls?.map(c => c.entryPoint), sponsorAccountId: sponsor.sessionId,
            deployed: calls?.filter(c => c.entryPoint === DEPLOY_ENTRY_POINT).map(c => c.address) ?? []
        });
    } catch (e) {
        await revertRecipeBestEffort(sponsor.facade, finalized, `${site} sponsor-intent`);
        throw e;
    }
    return String(await submitWithDustGuard(sponsor, finalized, `${site} sponsor-submit`));
}

/**
 * Resolves the optional fee-sponsor facade. Throws a clear error when a
 * sponsor was requested but its facade is not initialised in this worker;
 * the main thread ensures the sponsor facade exists before dispatching, so
 * hitting this means the ensure step was skipped or the facade was evicted.
 */
function resolveSponsorEntry(sponsorSessionId?: string): FacadeEntry | undefined {
    if (!sponsorSessionId) return undefined;
    const sponsor = facades.get(sponsorSessionId);
    if (!sponsor) {
        throw new Error(
            `No facade for sponsorSessionId=${sponsorSessionId.slice(0, 16)} ` +
            `(the sponsor session must be connected for signing and its facade initialised)`
        );
    }
    return sponsor;
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
        // The package's `exports` map exposes neither `./package.json` nor a
        // `require` condition, so require.resolve() throws for both the
        // subpath and the bare specifier. Locate the package.json on disk by
        // walking the module resolution paths instead.
        const searchDirs = require.resolve.paths('@midnightntwrk/wallet-sdk-facade') ?? [];
        for (const dir of searchDirs) {
            const candidate = path.join(dir, '@midnightntwrk', 'wallet-sdk-facade', 'package.json');
            if (fs.existsSync(candidate)) { pkgPath = candidate; break; }
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
 * Bech32m-encodes a Midnight address object (Dust/Shielded/Unshielded) to its
 * canonical string via `MidnightBech32m.encode`, which reads the
 * `[Bech32mSymbol]` codec on each address class. Pre-encoded strings pass
 * through untouched.
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
    | { kind: 'shielded'; addr: AddressFormat.ShieldedAddress }
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
    // args.accountIndex selects the BIP32 account level; it must match the
    // account the session was connected for (WalletSessions.accountIndex).
    const bip39Seed = new Uint8Array(Buffer.from(args.seedHex, 'hex'));
    const roleSeeds = await deriveRoleSeeds(bip39Seed, args.accountIndex ?? 0);
    const zswapKeys = sdk.ledger.ZswapSecretKeys.fromSeed(roleSeeds.zswap);
    const dustKey = sdk.ledger.DustSecretKey.fromSeed(roleSeeds.dust);

    const txHistoryStorage = new sdk.abstractions.InMemoryTransactionHistoryStorage(
        sdk.facade.WalletEntrySchema,
        sdk.facade.mergeWalletEntries
    );
    const { createKeystore, PublicKey } = sdk.unshielded;
    const unshieldedKeystore = createKeystore(roleSeeds.night, args.networkId);

    const configuration = {
        networkId: args.networkId,
        provingServerUrl: new URL(args.proofServerUrl),
        relayURL: new URL(args.relayUrl),
        indexerClientConnection: {
            indexerHttpUrl: args.indexerHttpUrl,
            indexerWsUrl: args.indexerWsUrl
        },
        txHistoryStorage,
        // Fee floor: additionalFeeOverhead >= 1n guarantees the dust balancer
        // never converges on an EMPTY recipe (fee 0 -> empty DustActions -> node
        // 1010 Custom error: 117 NotNormalized, the only dust-related
        // NotNormalized site in midnight-ledger dust.rs). feeBlocksMargin 5
        // matches the wallet SDK's own e2e configuration; our previous margin 1
        // sat on the 0/1-atom knife edge on quiet test networks. Overpayment is
        // bounded by the overhead (1 atom, negligible vs typical balances).
        costParameters: { additionalFeeOverhead: 1n, feeBlocksMargin: 5 }
    };

    const dustParameters = sdk.ledger.LedgerParameters.initialParameters().dust;
    const ShieldedWallet = sdk.shielded.ShieldedWallet;
    const UnshieldedWallet = sdk.unshielded.UnshieldedWallet;
    const DustWallet = sdk.dust.DustWallet;
    const restore = args.restoreBlobs;

    const provingMode = resolveProvingMode();
    const proving = provingMode === 'wasm' ? await loadProvingSdk() : undefined;
    // One shared provider per worker: makeWasmProvingService() would otherwise
    // create a fresh in-memory key cache per session and re-download from S3.
    const sharedKeys = provingMode === 'wasm' ? await getSharedKeyMaterialProvider() : undefined;
    if (provingMode === 'wasm') {
        log('info', 'proving mode: wasm (in-process prover; proof server not used for wallet proving)');
    }

    const facade = await sdk.facade.WalletFacade.init({
        configuration,
        // Without provingService the facade defaults to the SERVER prover at
        // configuration.provingServerUrl (and throws if that is unset).
        ...(proving ? { provingService: () => proving.makeWasmProvingService({ keyMaterialProvider: sharedKeys }) } : {}),
        shielded: () => restore?.shielded
            ? ShieldedWallet(configuration).restore(restore.shielded)
            : ShieldedWallet(configuration).startWithSecretKeys(zswapKeys),
        unshielded: () => restore?.unshielded
            ? UnshieldedWallet(configuration).restore(restore.unshielded)
            : UnshieldedWallet(configuration).startWithPublicKey(PublicKey.fromKeyStore(unshieldedKeystore)),
        // NIGHTGATE_DUST_COLD_START=true forces the dust sub-wallet to sync
        // fresh from chain instead of restoring the persisted blob. Restored
        // dust state can carry merkle roots that have since been pruned from the
        // node's ~1h root_history, making the (large) dust balance UNSPENDABLE
        // and every submission fail with Custom error 117 (NotNormalized: empty
        // dust actions). Cold-starting dust rebuilds spendable, fresh-rooted
        // outputs. Experimental flag while we settle on a permanent fix.
        dust: () => (restore?.dust && process.env.NIGHTGATE_DUST_COLD_START !== 'true')
            ? DustWallet(configuration).restore(restore.dust)
            : DustWallet(configuration).startWithSecretKey(dustKey, dustParameters)
    });

    await facade.start(zswapKeys, dustKey);
    log('info', `facade started for ${args.sessionId.slice(0, 16)} (restored=${!!restore})`);

    return {
        sessionId: args.sessionId,
        facade,
        sdkVersion: getSdkVersion(),
        zswapKeys,
        dustKey,
        unshieldedKeystore,
        networkId: args.networkId,
        indexerHttpUrl: args.indexerHttpUrl,
        walletConfiguration: configuration,
        attestationSecret: deriveAttestationSecret(roleSeeds.zswap)
    };
}

// ---- Periodic state save (pushed to main thread) -------------------------

let saveSeqCounter = 0;

// Ack waiters for pushes that need durability confirmation (dust snapshot
// restore). Keyed by save seq; resolved by the dispatcher on state-save-ack
// INDEPENDENTLY of the facade lookup, so a waiter cannot dangle when the
// entry is evicted between push and ack.
const saveAckWaiters = new Map<number, () => void>();

export function resolveSaveAckWaiter(seq: number): void {
    saveAckWaiters.get(seq)?.();
}

/**
 * Push a state-save to the main thread. `lastSavedBlobs` is only advanced by
 * the corresponding `state-save-ack` (see the parentPort dispatcher), so a
 * failed or dropped persist keeps the blobs "unsaved" and they are re-pushed
 * on the next tick. `beforePost` runs after the seq is allocated but BEFORE
 * the message goes out, so an ack waiter can be registered race-free even
 * against a synchronous ack.
 */
function pushStateSave(sessionId: string, entry: FacadeEntry, blobs: { shielded?: string; unshielded?: string; dust?: string }, beforePost?: (seq: number) => void): number {
    const seq = ++saveSeqCounter;
    entry.pendingSaves ??= new Map();
    entry.pendingSaves.set(seq, blobs);
    // Tag dust-bearing pushes with the epoch their blob was serialized
    // under, so applySaveAck can reject acks that arrive after a dust
    // snapshot restore invalidated the blob.
    if (blobs.dust !== undefined) {
        (entry.dustSaveEpochs ??= new Map()).set(seq, entry.dustEpoch ?? 0);
    }
    // Bound the in-flight map: acks normally clear entries; if main never
    // acks (persist layer down), keep only the most recent few.
    if (entry.pendingSaves.size > 4) {
        const oldest = Math.min(...entry.pendingSaves.keys());
        entry.pendingSaves.delete(oldest);
        entry.dustSaveEpochs?.delete(oldest);
    }
    beforePost?.(seq);
    parentPort?.postMessage({
        kind: 'state-save',
        sessionId,
        sdkVersion: entry.sdkVersion,
        seq,
        blobs
    });
    return seq;
}

function restoreSaveAckTimeoutMs(): number {
    // Read per call so tests can shrink the window. The main-thread persist
    // chain can queue behind other saves; 30s is generous but bounded.
    return Number(process.env.NIGHTGATE_RESTORE_SAVE_ACK_TIMEOUT_MS || 30_000);
}

/**
 * pushStateSave that resolves once the main thread CONFIRMED the persist
 * (state-save-ack for this seq) and rejects after `timeoutMs` (there is no
 * explicit nack: a sink failure simply never acks).
 */
function pushStateSaveAcked(sessionId: string, entry: FacadeEntry, blobs: { shielded?: string; unshielded?: string; dust?: string }, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        pushStateSave(sessionId, entry, blobs, (seq) => {
            const timer = setTimeout(() => {
                saveAckWaiters.delete(seq);
                reject(new Error(`state-save seq=${seq} not acked within ${timeoutMs}ms`));
            }, timeoutMs);
            (timer as any).unref?.();
            saveAckWaiters.set(seq, () => {
                clearTimeout(timer);
                saveAckWaiters.delete(seq);
                resolve();
            });
        });
    });
}

/**
 * Apply a main-thread `state-save-ack`: advance the confirmed-saved blobs so
 * the tick's unchanged-skip applies. Pushes carry only CHANGED sub-blobs, so
 * this merges instead of replacing (a dust-only ack must not mark
 * shielded/unshielded never-saved). A dust blob acked under a STALE dust
 * epoch (a snapshot restore happened after its push) is dropped from the
 * merge: the restore's own push is the only valid dust baseline from then
 * on. Exported for the in-thread unit tests.
 */
export function applySaveAck(entry: FacadeEntry, seq: number): void {
    const blobs = entry.pendingSaves?.get(seq);
    if (!blobs) return;
    let effective = blobs;
    if (blobs.dust !== undefined && (entry.dustSaveEpochs?.get(seq) ?? 0) !== (entry.dustEpoch ?? 0)) {
        const { dust: _stale, ...rest } = blobs;
        effective = rest;
    }
    entry.lastSavedBlobs = { ...entry.lastSavedBlobs, ...effective };
    entry.pendingSaves!.delete(seq);
    entry.dustSaveEpochs?.delete(seq);
}

/**
 * Idle progress watch (0.21.4): `waitForGenuineSync` only publishes progress
 * while a job waits, so a facade that is far behind but has nothing to do
 * logs nothing and its `getWalletSyncProgress` row goes stale, which reads
 * like a hang. Every PROGRESS_WATCH_MS this peeks the dust progress (bounded
 * state read + one tip query), refreshes the cached snapshot and logs an INFO
 * line while the facade is behind; silent once at tip. Skipped while a
 * genuine-sync wait refreshed the snapshot itself within the interval.
 */
const PROGRESS_WATCH_MS = Math.max(15_000, Number(process.env.NIGHTGATE_PROGRESS_WATCH_MS) || 60_000);

function startProgressWatch(sessionId: string, entry: FacadeEntry): void {
    if (entry.progressTimer) return;
    let busy = false;
    entry.progressTimer = setInterval(async () => {
        if (busy) return;
        busy = true;
        try {
            const last = syncProgress.get(sessionId);
            if (last && Date.now() - Date.parse(last.updatedAt) < PROGRESS_WATCH_MS) return;
            let state: any; let sub: any; let timer: NodeJS.Timeout | undefined;
            try {
                state = await Promise.race([
                    new Promise<any>((res, rej) => { try { sub = entry.facade.state().subscribe({ next: (v: any) => res(v), error: (e: any) => rej(e) }); } catch (e) { rej(e); } }),
                    new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('state peek timeout')), 5_000); })
                ]);
            } catch { return; } finally { try { sub && sub.unsubscribe(); } catch { } if (timer) clearTimeout(timer); }
            const p: any = state?.dust?.progress;
            const applied = p?.appliedIndex != null ? BigInt(p.appliedIndex) : -1n;
            const highest = (await getDustStreamTip(entry.indexerHttpUrl)) ?? -1n;
            const behind = highest >= 0n && applied >= 0n ? highest - applied : null;
            const caughtUp = behind != null && behind <= SYNC_TIP_GAP;
            const now = Date.now();
            syncProgress.set(sessionId, {
                sessionId, appliedIndex: applied.toString(), streamTip: highest.toString(),
                behindEvents: behind != null ? behind.toString() : null, eventsPerSecond: null, etaSeconds: caughtUp ? 0 : null,
                blockHeight: null, isConnected: p?.isConnected === true, indexerFresh: true, caughtUp,
                elapsedMs: 0, label: last?.label ?? 'idle', updatedAt: new Date(now).toISOString(),
                lastProgressAt: last && last.appliedIndex === applied.toString() ? last.lastProgressAt : new Date(now).toISOString()
            });
            if (!caughtUp) {
                log('info', `idle-sync ${sessionId.slice(0, 16)} appliedIndex=${applied} streamTip=${highest} behindEvents=${behind ?? '?'} connected=${p?.isConnected === true} (no job waiting)`);
            }
        } catch (e) {
            log('debug', `progress watch ${sessionId.slice(0, 16)}: ${formatErr(e)}`);
        } finally {
            busy = false;
        }
    }, PROGRESS_WATCH_MS);
    entry.progressTimer.unref();
}

/**
 * Save tick interval (0.21.6: `NIGHTGATE_SAVE_INTERVAL_MS`, default 60 s,
 * min 10 s; was a fixed 30 s). Every tick serializes all three sub-wallets
 * of a facade into multi-MB hex strings; the dust wallet changes with
 * practically every block, so the tick nearly always allocates and pushes.
 * On the hosted pool (three facades) that churn made minor GC the worker's
 * main occupation (profileWorker: 63 scavenges of ~180 ms in 20 s, GC 42 %).
 * The interval bounds only how much sync work a crash re-does on restore.
 */
function saveIntervalMs(): number {
    const raw = Number(process.env.NIGHTGATE_SAVE_INTERVAL_MS);
    if (!Number.isFinite(raw) || raw <= 0) return 60_000;
    return Math.max(10_000, Math.floor(raw));
}

function startPeriodicSave(sessionId: string, entry: FacadeEntry): void {
    if (entry.saveTimer) return;
    let tickCount = 0;
    const intervalMs = saveIntervalMs();
    log('info', `periodic-save interval armed for ${sessionId.slice(0, 16)} (every ${Math.round(intervalMs / 1000)}s)`);
    entry.saveTimer = setInterval(async () => {
        tickCount++;
        const tickStart = Date.now();
        // Log BEFORE the first await so we know the timer fired even if
        // serializeState() hangs on the rx Observable.
        log('debug', `save-tick #${tickCount} fired, calling collectSerializedStates...`);
        try {
            const collectStart = Date.now();
            const epochAtCollect = entry.dustEpoch ?? 0;
            const blobs = await collectSerializedStates(entry.facade);
            if ((entry.dustEpoch ?? 0) !== epochAtCollect && blobs.dust) {
                // A dust snapshot restore landed while we were serializing:
                // this blob may describe the pre-restore (poisoned) wallet,
                // and the restore already persisted the clean snapshot.
                delete blobs.dust;
                log('debug', `save-tick #${tickCount} dropped dust blob (dust restore during collect)`);
            }
            const collectMs = Date.now() - collectStart;
            const shape = [
                `sh=${blobs.shielded ? blobs.shielded.length : '-'}`,
                `un=${blobs.unshielded ? blobs.unshielded.length : '-'}`,
                `du=${blobs.dust ? blobs.dust.length : '-'}`
            ].join(' ');
            log('debug', `save-tick #${tickCount} collect returned in ${collectMs}ms: ${shape}`);

            if (!hasAnyBlob(blobs)) return;
            // Push only sub-blobs that differ from the last CONFIRMED-saved
            // state (saveSyncState preserves stored blobs for keys sent as
            // null/absent). Dust churns with practically every block while
            // shielded/unshielded mostly don't; sending only what changed
            // avoids cloning + re-encrypting multi-MB blobs 2x/min per facade.
            // Diffing against CONFIRMED blobs (advanced only by the ack) keeps
            // a save whose persist failed marked unsaved for re-push.
            const changed = diffAgainstConfirmed(entry, blobs);
            if (!hasAnyBlob(changed)) {
                log('debug', `save-tick #${tickCount} unchanged, skipping push`);
                return;
            }
            const seq = pushStateSave(sessionId, entry, changed);
            log('debug', `save-tick #${tickCount} pushed seq=${seq} (total ${Date.now() - tickStart}ms)`);
        } catch (err: any) {
            log('warn', `periodic save failed: ${formatErr(err)}`);
        }
    }, intervalMs);
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

/** Sub-blobs that differ from the last save the main thread acked. */
function diffAgainstConfirmed(
    entry: FacadeEntry,
    blobs: { shielded?: string; unshielded?: string; dust?: string }
): { shielded?: string; unshielded?: string; dust?: string } {
    const saved = entry.lastSavedBlobs ?? {};
    const changed: { shielded?: string; unshielded?: string; dust?: string } = {};
    if (blobs.shielded && blobs.shielded !== saved.shielded) changed.shielded = blobs.shielded;
    if (blobs.unshielded && blobs.unshielded !== saved.unshielded) changed.unshielded = blobs.unshielded;
    if (blobs.dust && blobs.dust !== saved.dust) changed.dust = blobs.dust;
    return changed;
}

// ---- Contract-call phase timing -------------------------------------------
// (FR wallet-save-pipeline-cpu-efficiency, item 4)

/**
 * Wall-clock attribution for the contract-call phases (compile,
 * findDeployedContract's ledger-state fetch + deserialize, local circuit
 * execution, proving, balancing, submission). Logged as ONE debug line per
 * submission, also when a phase throws (the partial breakdown identifies the
 * phase that timed out). The hot pre-proof phase this was built to find
 * (findContract, 8.4 s live) is fixed by withFindContractQueryCache.
 */
class PhaseTimer {
    private readonly t0 = Date.now();
    private tPhase = this.t0;
    private readonly phases: Array<[string, number]> = [];

    /** Close the phase that ran since the previous mark (or construction). */
    mark(name: string): void {
        const now = Date.now();
        this.phases.push([name, now - this.tPhase]);
        this.tPhase = now;
    }

    /** Record an externally measured duration (does not advance the cursor). */
    add(name: string, ms: number): void {
        this.phases.push([name, ms]);
    }

    summary(): string {
        return this.phases.map(([n, ms]) => `${n}=${ms}ms`).join(' ') +
            ` total=${Date.now() - this.t0}ms`;
    }
}

/**
 * Wraps the per-call provider bundle so proving/balancing/submission report
 * their spans into the timer. `callRegion.start` is stamped right before the
 * SDK's circuit call; the FIRST proveTx invocation then yields
 * `circuitToProve` (callTx start -> first proof request), i.e. the local
 * circuit-execution + transcript span, the FR's prime suspect besides
 * findDeployedContract. Wallet-side proving inside balanceTx goes through the
 * facade's own proving service, so `prove` counts contract proofs only.
 */
function wrapProvidersForTiming(providers: any, timer: PhaseTimer, callRegion: { start: number }): any {
    const timed = async <T>(label: string, run: () => Promise<T>): Promise<T> => {
        const t = Date.now();
        try { return await run(); } finally { timer.add(label, Date.now() - t); }
    };

    let proveCalls = 0;
    const proofProvider = typeof providers.proofProvider?.proveTx === 'function'
        ? {
            ...providers.proofProvider,
            proveTx: (...pArgs: any[]) => {
                const n = ++proveCalls;
                if (n === 1 && callRegion.start > 0) {
                    timer.add('circuitToProve', Date.now() - callRegion.start);
                }
                return timed(n === 1 ? 'prove' : `prove#${n}`, () => providers.proofProvider.proveTx(...pArgs));
            }
        }
        : providers.proofProvider;

    const wp = providers.walletProvider;
    const walletProvider = {
        ...wp,
        ...(typeof wp?.balanceTx === 'function'
            ? { balanceTx: (...a: any[]) => timed('balance', () => wp.balanceTx(...a)) } : {}),
        ...(typeof wp?.submitTx === 'function'
            ? { submitTx: (...a: any[]) => timed('submit', () => wp.submitTx(...a)) } : {})
    };

    return { ...providers, proofProvider, walletProvider, midnightProvider: walletProvider };
}

// ---- RPC method handlers --------------------------------------------------

const handlers: Record<string, (args: any) => Promise<unknown>> = {
    async init(args: InitArgs) {
        if (facades.has(args.sessionId)) {
            log('debug', `init: cache hit ${args.sessionId.slice(0, 16)}`);
            return { facadeReady: true, alreadyExisted: true };
        }
        const entry = await buildFacade(args);
        facades.set(args.sessionId, entry);
        startPeriodicSave(args.sessionId, entry);
        startProgressWatch(args.sessionId, entry);
        return { facadeReady: true, alreadyExisted: false, sdkVersion: entry.sdkVersion };
    },

    /**
     * CPU profile of THIS worker thread for `seconds` (1..120), taken with the
     * in-thread inspector while the worker keeps serving; the summary travels
     * back, the raw .cpuprofile stays on disk for DevTools. Admin diagnostic
     * (`profileWorker`), added when the hosted worker sat at 100 % CPU with
     * three warm facades and nothing in the log said why.
     */
    async cpuProfile({ seconds, dir }: { seconds?: number; dir?: string }) {
        const p = await profileCurrentThread(seconds ?? 20, { dir, filePrefix: 'worker' });
        log('info', `cpuProfile: ${p.seconds}s sampled, idle ${p.idlePercent}%, gc ${p.gcPercent}% (${p.gc.count} collections, ${p.gc.totalMs}ms), wasm ${p.wasmPercent}%, heap ${p.heapAfter.usedMb}/${p.heapAfter.limitMb} MB, external ${p.heapAfter.externalMb} MB, top: ${p.topFunctions.slice(0, 3).map((f: { label: string; percent: number }) => `${f.label.split('  ')[0]} ${f.percent}%`).join(', ')}`);
        return { thread: 'worker', facadeCount: facades.size, ...p, gc: { ...p.gc, byKind: JSON.stringify(p.gc.byKind) } };
    },

    async waitForSyncedState({ sessionId, timeoutMs, stallMs }: { sessionId: string; timeoutMs?: number; stallMs?: number }) {
        const entry = facades.get(sessionId);
        if (!entry) throw new Error(`No facade for sessionId=${sessionId.slice(0, 16)}`);
        // Genuine catch-up to the indexer tip (the isSynced flag is trivially true
        // when highestIndex=0). Prewarm path: bounded by lack of progress (stallMs),
        // with an absolute ceiling as backstop.
        await waitForGenuineSync(entry, timeoutMs ?? SYNC_CEILING_MS, 'prewarm', stallMs ?? SYNC_STALL_MS);
        return { synced: true };
    },

    async evict({ sessionId }: { sessionId: string }) {
        const entry = facades.get(sessionId);
        if (!entry) return { evicted: false };
        // Remove from the map first so no NEW submit can resolve this facade.
        facades.delete(sessionId);
        syncProgress.delete(sessionId);
        if (entry.saveTimer) clearInterval(entry.saveTimer);
        if (entry.progressTimer) clearInterval(entry.progressTimer);
        // Teardown (final save + zeroing secrets + stopping the facade) runs under
        // the per-session submit lock so it can't yank key material from a submit
        // still in flight for this session (it holds `entry` mid-SDK-call). New
        // submits already fail the `facades.get` above, so never contend this lock.
        await withSessionLocks([sessionId], async () => {
            // Best-effort final save push. Cleanup-path errors don't block
            // eviction but are logged; silent swallowing would hide leaks.
            try {
                const blobs = await collectSerializedStates(entry.facade);
                // Changed-only, same as the tick: blobs already confirmed
                // persisted don't need a goodbye re-encrypt.
                const changed = diffAgainstConfirmed(entry, blobs);
                if (hasAnyBlob(changed)) {
                    pushStateSave(sessionId, entry, changed);
                }
            } catch (err) {
                log('warn', `evict final-save failed for ${sessionId.slice(0, 16)}: ${formatErr(err)}`);
            }
            try {
                // Zero every secret held by the entry, not just the zswap keys, so
                // nothing sensitive lingers in the orphaned entry until GC.
                entry.zswapKeys?.clear?.();
                entry.dustKey?.clear?.();
                entry.unshieldedKeystore?.clear?.();
                try { entry.attestationSecret?.fill?.(0); } catch { }
                await entry.facade?.stop?.();
            } catch (err) {
                log('warn', `evict cleanup failed for ${sessionId.slice(0, 16)}: ${formatErr(err)}`);
            }
        });
        // Drop the now-idle lock chain (the gate withSessionLocks left behind).
        sessionChains.delete(sessionId);
        return { evicted: true };
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
        log('info', `dust-register: waiting for synced state...`);
        const synced = syncTimeoutMs
            ? await Promise.race([
                entry.facade.waitForSyncedState(),
                new Promise<never>((_, rej) => setTimeout(() => rej(new Error('dust-register: sync timeout')), syncTimeoutMs))
            ])
            : await entry.facade.waitForSyncedState();
        log('info', `dust-register: synced.`);

        // `availableCoins` excludes UTXOs already registered for dust generation (SDK
        // contract); registered ones are counted off the full coin set.
        const availableCoins: any[] = synced?.unshielded?.availableCoins ?? [];
        const unregistered = availableCoins.filter(
            (c: any) => c?.meta?.registeredForDustGeneration !== true
        );
        const registeredUtxosBefore = countRegisteredNightUtxos(synced);
        // Without a full coin set the total is the available set plus the
        // registered UTXOs it does not already list.
        const registeredInAvailable = availableCoins.filter((c: any) => c?.meta?.registeredForDustGeneration === true).length;
        const totalNightUtxos = countAllNightUtxos(synced, availableCoins.length + registeredUtxosBefore - registeredInAvailable);

        const myDustAddr = await entry.facade.dust.getAddress();
        const receiverRaw = dustReceiverAddress || myDustAddr;
        const dustAddrStr = await encodeAddressString(receiverRaw, entry.networkId);

        if (unregistered.length === 0) {
            // Registration binds the address, so a call naming a different receiver
            // changes nothing. The standing receiver is not readable from the SDK
            // (only a boolean per UTXO): answer "unchanged, receiver not applied".
            const reason = registeredUtxosBefore > 0 ? 'already-registered' : 'no-night-utxos';
            const message = reason === 'no-night-utxos'
                ? 'no unshielded NIGHT UTXOs visible to this wallet (all NIGHT is held shielded, or the wallet is ' +
                  'unfunded); nothing was registered and no receiver was applied'
                : `all ${totalNightUtxos} NIGHT UTXO(s) are already registered to their standing receiver; ` +
                  'nothing was registered and the requested receiver was NOT applied. To move generation to a ' +
                  'different receiver, deregisterFromDustGeneration first, then register again naming it';
            log(dustReceiverAddress ? 'warn' : 'info', `dust-register: ${message}`);
            return {
                txId: null,
                changed: false,
                reason,
                registeredCount: 0,
                totalNightUtxos,
                // Never echo a receiver that was not applied.
                dustReceiverAddress: null,
                requestedReceiver: dustAddrStr,
                registeredUtxosBefore,
                registeredUtxosAfter: registeredUtxosBefore,
                settled: true,
                consolidated: null,
                message
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

        await captureDustSnapshot(entry, 'dust-register');
        const recipe = await entry.facade.registerNightUtxosForDustGeneration(
            unregistered,
            verifyingKey,
            signFn,
            receiverParsed
        );
        const finalized = await entry.facade.finalizeRecipe(recipe);
        const txId = await submitWithDustGuard(entry, finalized, 'dust-register');

        log('info', `dust-register: submitted ${unregistered.length} UTXO(s), txId=${String(txId).slice(0, 16)}...`);

        // Report the resulting shape: one registration over several UTXOs consolidates
        // them, and one registered UTXO yields one dust note. Bounded observation;
        // `settled: false` with a null count if the tx is not applied locally in time.
        const settleMs = Number(process.env.NIGHTGATE_DUST_REGISTER_SETTLE_MS ?? 90_000);
        const settleStartedAt = Date.now();
        let registeredUtxosAfter: number | null = null;
        while (settleMs > 0 && Date.now() - settleStartedAt < settleMs) {
            const state = await peekFacadeState(entry.facade, 10_000);
            const n = state ? countRegisteredNightUtxos(state) : null;
            if (n != null && n > registeredUtxosBefore) { registeredUtxosAfter = n; break; }
            await wsleep(SYNC_POLL_MS);
        }
        const settled = registeredUtxosAfter != null;
        const consolidated = settled ? (registeredUtxosAfter! - registeredUtxosBefore) < unregistered.length : null;
        if (settled) {
            log('info', `dust-register: settled, registered NIGHT UTXOs ${registeredUtxosBefore} -> ${registeredUtxosAfter} (${unregistered.length} input(s)${consolidated ? ', CONSOLIDATED' : ''})`);
        } else {
            log('info', `dust-register: not yet applied locally after ${Math.round((Date.now() - settleStartedAt) / 1000)}s; resulting UTXO count unknown`);
        }

        return {
            txId: String(txId),
            changed: true,
            reason: null,
            registeredCount: unregistered.length,
            totalNightUtxos,
            dustReceiverAddress: dustAddrStr,
            requestedReceiver: dustAddrStr,
            registeredUtxosBefore,
            registeredUtxosAfter,
            settled,
            consolidated,
            message: settled
                ? `${unregistered.length} UTXO(s) registered; the wallet now holds ${registeredUtxosAfter} registered NIGHT UTXO(s)` +
                  (consolidated ? ' (inputs were consolidated: register first, fund in separate payments afterwards to keep them split)' : '')
                : `${unregistered.length} UTXO(s) registered; the resulting UTXO count was not observable within ${settleMs}ms`
        };
    },

    /**
     * Symmetric pair to `registerDustGeneration`. Removes NIGHT UTXOs from
     * dust generation so they become spendable again (registered UTXOs are
     * committed to dust accrual and excluded from `availableCoins`).
     *
     * The SDK's `synced.unshielded.availableCoins` only lists *unregistered*
     * UTXOs, so we read registered ones from the full set the wallet tracks.
     * This action deregisters ALL registered UTXOs; per-UTXO
     * narrowing is a follow-up once we have a stable UTXO-id surface.
     */
    async deregisterDustGeneration({ sessionId, syncTimeoutMs, sponsorSessionId }: {
        sessionId: string;
        syncTimeoutMs?: number;
        /**
         * Optional fee sponsor: that facade balances the deregistration fee
         * from ITS dust and submits. This is the escape hatch for a wallet
         * whose entire generation is delegated away (dust balance 0 forever),
         * which otherwise cannot pay its own deregistration.
         */
        sponsorSessionId?: string;
    }) {
        const entry = facades.get(sessionId);
        if (!entry) throw new Error(`No facade for sessionId=${sessionId.slice(0, 16)}`);
        const sponsorEntry = resolveSponsorEntry(sponsorSessionId);

        log('info', `dust-deregister: waiting for synced state...`);
        const synced = syncTimeoutMs
            ? await Promise.race([
                entry.facade.waitForSyncedState(),
                new Promise<never>((_, rej) => setTimeout(() => rej(new Error('dust-deregister: sync timeout')), syncTimeoutMs))
            ])
            : await entry.facade.waitForSyncedState();
        log('info', `dust-deregister: synced.`);

        // The full coin set is `totalCoins` on the current SDK's unshielded
        // state (UnshieldedWalletState). Older SDKs called it `allCoins` /
        // `coins`; keep those as fallbacks. Registered UTXOs only surface in
        // the full set, and deregistration needs exactly those.
        const allCoins: any[] = synced?.unshielded?.totalCoins
            ?? synced?.unshielded?.allCoins ?? synced?.unshielded?.coins ?? [];
        const registered = allCoins.filter(
            (c: any) => c?.meta?.registeredForDustGeneration === true
        );

        if (registered.length === 0) {
            log('info', `dust-deregister: no registered NIGHT UTXOs to deregister.`);
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
        // The deregistration recipe is fee-less by design (allowFeePayment 0,
        // no dust spends): the SDK expects THE CALLER to balance the fee via
        // balanceUnprovenTransaction with tokenKindsToBalance ['dust'] (stated
        // in the facade's createDustActionTransaction step-4 comment).
        // Without it the node rejects 1010/138 BalanceCheckOverspend. The tx
        // is already fully signed by the facade; an extra signRecipe pass
        // DUPLICATES the offer signatures (1010/192). So: balance, then
        // finalize, no re-signing.
        //
        // With a sponsor, the SPONSOR's facade balances the fee from ITS dust
        // and submits. The dust spender must be genuinely synced first (stale
        // dust merkle roots are the Custom error 117 site); the unsponsored
        // path gets that freshness from the caller's own sync above.
        const payer = sponsorEntry ?? entry;
        if (sponsorEntry) {
            log('info', `dust-deregister: fee sponsored by ${sponsorEntry === entry ? 'self' : String(sponsorSessionId).slice(0, 16)}`);
            await waitForGenuineSync(sponsorEntry, BALANCE_SYNC_TIMEOUT_MS, 'deregister sponsor');
        }
        await captureDustSnapshot(payer, 'dust-deregister');
        const balanced = await payer.facade.balanceUnprovenTransaction(
            recipe.transaction,
            { shieldedSecretKeys: payer.zswapKeys, dustSecretKey: payer.dustKey },
            { ttl: new Date(Date.now() + 10 * 60000), tokenKindsToBalance: ['dust'] }
        );
        const finalized = await payer.facade.finalizeRecipe(balanced);
        const txId = await submitWithDustGuard(payer, finalized, 'dust-deregister');

        log('info', `dust-deregister: submitted ${registered.length} UTXO(s), txId=${String(txId).slice(0, 16)}...`);

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
     * cross-ledger funding is not attempted (NIGHT is unshielded-only,
     * there is no shield/unshield conversion in the protocol).
     *
     * Build + balance + prove + submit all in-worker via `facade.transferTransaction`.
     * Returns primitives only; no SDK objects cross the thread boundary.
     */
    async transferNight({ sessionId, receiverAddress, amount, ttlIso, syncTimeoutMs, tokenTypeHex }: {
        sessionId: string;
        receiverAddress: string;
        amount: string;          // bigint atoms as decimal string
        ttlIso?: string;          // ISO-8601 future timestamp; defaults to +10min
        syncTimeoutMs?: number;
        /** Raw token type (64 hex) to send instead of NIGHT; e.g. a contract-minted shielded token. */
        tokenTypeHex?: string;
    }) {
        const entry = facades.get(sessionId);
        if (!entry) throw new Error(`No facade for sessionId=${sessionId.slice(0, 16)}`);
        const sdk = await loadSdk();
        await ensureNetworkId(entry.networkId, sdk);

        log('info', `transfer: waiting for synced state...`);
        if (syncTimeoutMs) {
            await Promise.race([
                entry.facade.waitForSyncedState(),
                new Promise<never>((_, rej) => setTimeout(() => rej(new Error('transfer: sync timeout')), syncTimeoutMs))
            ]);
        } else {
            await entry.facade.waitForSyncedState();
        }
        log('info', `transfer: synced.`);

        const receiver = await parseReceiverAddress(receiverAddress, entry.networkId);
        const amountBig = BigInt(amount);
        const rawType = tokenTypeHex || sdk.ledger.nativeToken().raw;
        const ttl = ttlIso ? new Date(ttlIso) : new Date(Date.now() + 10 * 60 * 1000);

        const outputs: any[] = receiver.kind === 'shielded'
            ? [{ type: 'shielded', outputs: [{ type: rawType, receiverAddress: receiver.addr, amount: amountBig }] }]
            : [{ type: 'unshielded', outputs: [{ type: rawType, receiverAddress: receiver.addr, amount: amountBig }] }];

        log('info', `transfer: ${amount} ${tokenTypeHex ? `token ${tokenTypeHex.slice(0, 12)}...` : 'NIGHT'} to ${receiver.kind} addr ${receiverAddress.slice(0, 24)}...`);

        await captureDustSnapshot(entry, 'transfer');
        const recipe = await entry.facade.transferTransaction(
            outputs,
            { shieldedSecretKeys: entry.zswapKeys, dustSecretKey: entry.dustKey },
            { ttl }
        );
        // UNSHIELDED inputs are signature-authorized (not proof-authorized like
        // zswap): the recipe must pass through signRecipe with the keystore's
        // sign function, or the intent ships inputs with an empty signature
        // list and the node rejects it at the mempool with
        // `1010 Custom error: 192` (MalformedError::InputsSignaturesLengthMismatch).
        // No-op when the balancer selected no unshielded inputs.
        const signFn = (payload: Uint8Array) => entry.unshieldedKeystore.signData(payload);
        const signed = await entry.facade.signRecipe(recipe, signFn);
        const finalized = await entry.facade.finalizeRecipe(signed);
        const txId = await submitWithDustGuard(entry, finalized, 'transfer');

        log('info', `transfer: submitted, txId=${String(txId).slice(0, 16)}...`);

        return {
            txId: String(txId),
            toLedger: receiver.kind,
            amount: amount,
            receiverAddress: receiverAddress
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

        const shieldedNight = shieldedBalances[nightRawType] ?? 0n;
        const unshieldedNight = unshieldedBalances[nightRawType] ?? 0n;
        // dust.balance(time) is synchronous and returns Balance (= bigint). It
        // lives on the DustWalletState carried by the synced FacadeState, NOT
        // on facade.dust (which is a DustWalletAPI with no balance() method).
        const dustBalance: bigint = synced?.dust ? synced.dust.balance(new Date()) : 0n;
        // DIAGNOSTIC: real sync distance to tip + whether 'synced' is genuine.
        try {
            const p: any = (synced as any)?.dust?.progress;
            log('debug', `SYNC-PROGRESS isSynced=${(synced as any)?.isSynced} isConnected=${p?.isConnected} appliedIndex=${p?.appliedIndex} highestIndex=${p?.highestIndex} highestRelevantIndex=${p?.highestRelevantIndex}`);
        } catch (e: any) { log('debug', `SYNC-PROGRESS read failed: ${e?.message}`); }
        const registeredCount = totalNightCoins.filter(
            (c: any) => c?.meta?.registeredForDustGeneration === true
        ).length;
        // Dust-side diagnosability (dust-pending-note-leak FR): a wedged
        // wallet (in-flight spend leaked by a pre-mempool abort) shows
        // registered NIGHT but ZERO dust utxos and ZERO pending, which is
        // otherwise indistinguishable from "genuinely empty" without logs.
        const dustUtxos: any[] = synced?.dust?.totalCoins ?? [];
        const dustPending: any[] = synced?.dust?.pendingCoins ?? [];
        // `totalCoins` is available PLUS pending, so it is not the number of
        // notes you can spend right now; unbound sponsoring locks one FREE
        // note per in-flight transaction, and reading the total as capacity
        // counts notes that are already committed to a spend. Take the SDK's
        // own available list when it has one, and fall back to the difference.
        const dustAvailable: any[] | undefined = synced?.dust?.availableCoins;
        const dustPendingValue = dustPending.reduce(
            (sum: bigint, c: any) => sum + (typeof c?.generatedNow === 'bigint' ? c.generatedNow : 0n), 0n
        );

        return {
            shieldedNight: shieldedNight.toString(),
            unshieldedNight: unshieldedNight.toString(),
            dustBalance: dustBalance.toString(),
            registeredNightUtxoCount: registeredCount,
            totalNightUtxoCount: totalNightCoins.length,
            dustUtxoCount: dustUtxos.length,
            dustAvailableCount: Array.isArray(dustAvailable)
                ? dustAvailable.length
                : Math.max(0, dustUtxos.length - dustPending.length),
            dustPendingCount: dustPending.length,
            dustPendingValue: dustPendingValue.toString(),
            // Persist-CONFIRMED snapshot restores (bumped only after the
            // main thread acked the restore's re-persist). Exposed so the
            // live e2e can ASSERT the whole guard lane ran, including
            // durability (the SDK's own fast-path revert heals some aborts
            // without it, and a fire-and-forget push could green-light a
            // gate while the DB still holds the poisoned state).
            dustRestoreCount: entry.dustRestoresPersisted ?? 0
        };
    },

    /**
     * Pre-flight fee estimate for a NIGHT transfer. Builds the
     * `transferTransaction` recipe in the worker (which runs balancing
     * (lightweight) but NOT proof generation (heavy)), then prices the
     * balanced recipe via `calculateTransactionFee`. No submit. The recipe
     * is discarded AND reverted, so the coins the build moved into
     * `pendingUtxos` become spendable again (bug_002).
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
            ? [{ type: 'shielded', outputs: [{ type: nightRawType, receiverAddress: receiver.addr, amount: amountBig }] }]
            : [{ type: 'unshielded', outputs: [{ type: nightRawType, receiverAddress: receiver.addr, amount: amountBig }] }];

        const recipe = await entry.facade.transferTransaction(
            outputs,
            { shieldedSecretKeys: entry.zswapKeys, dustSecretKey: entry.dustKey },
            { ttl }
        );
        // recipe is UnprovenTransactionRecipe: { type: 'UNPROVEN_TRANSACTION', transaction }
        const fee = await feeOfDiscardedRecipe(entry.facade, recipe, 'estimateTransferFee');
        return { fee: fee.toString(), toLedger: receiver.kind };
    },

    /**
     * Deploy a Compact-emitted contract via the SDK, entirely in the worker.
     * Inputs are primitives + the registration meta; the contract artifact is
     * dynamic-imported and `CompiledContract.make`'d inside the worker, cached
     * by name. The private-state provider is a proxy that round-trips to main
     * (where the real CapDbPrivateStateProvider lives, keyed by proxyId).
     *
     * Returns primitives so nothing SDK-shaped crosses the thread boundary.
     */
    async deployContract({
        sessionId, proxyId, contractName, registration,
        indexerHttpUrl, indexerWsUrl, proofServerUrl,
        networkId, initialPrivateState, sponsorSessionId
    }: {
        sessionId: string;
        proxyId: string;
        contractName: string;
        registration: ContractRegistration;
        indexerHttpUrl: string;
        indexerWsUrl: string;
        proofServerUrl: string;
        networkId: string;
        initialPrivateState: unknown;
        /** Optional fee sponsor: this facade balances ['dust'] and submits. */
        sponsorSessionId?: string;
    }) {
        const entry = facades.get(sessionId);
        if (!entry) throw new Error(`No facade for sessionId=${sessionId.slice(0, 16)}`);
        const sponsorEntry = resolveSponsorEntry(sponsorSessionId);
        const sdk = await loadSdk();
        await ensureNetworkId(networkId, sdk);

        const compiledContract = await getOrCompileContract(contractName, registration, entry);
        const contractProviders = await buildWorkerContractProviders({
            indexerHttpUrl, indexerWsUrl, proofServerUrl,
            zkConfigPath: artifactAssetPath(contractName, registration), generation: registration.artifactDigest
        });
        const privateStateProvider = createPrivateStateProxy(proxyId);
        const walletProvider = sponsorEntry
            ? buildSponsoredWalletProvider(entry, sponsorEntry)
            : buildWorkerWalletProvider(entry);

        const providers = {
            ...contractProviders,
            privateStateProvider,
            walletProvider,
            midnightProvider: walletProvider
        };

        const { contracts } = await loadContractsSdk();
        log('info', `deployContract: starting ${contractName} sess=${sessionId.slice(0, 16)}` +
            (sponsorEntry ? ` (fee sponsored by ${String(sponsorSessionId).slice(0, 16)})` : ''));
        const constructorArgs = await deployConstructorArgs(contractName, entry);
        const result = await contracts.deployContract(providers, {
            compiledContract,
            privateStateId: registration.privateStateId,
            initialPrivateState,
            ...(constructorArgs.length > 0 ? { args: constructorArgs } : {})
        });
        const pub = result?.deployTxData?.public;
        const out = {
            txHash: String(pub?.txHash ?? ''),
            contractAddress: String(pub?.contractAddress ?? ''),
            onChainStatus: String(pub?.status ?? '')
        };
        log('info', `deployContract: done addr=${out.contractAddress.slice(0, 16)} status=${out.onChainStatus}`);
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
        networkId, merkleProof, initialPrivateState,
        sponsorSessionId
    }: {
        sessionId: string;
        proxyId: string;
        contractName: string;
        registration: ContractRegistration;
        contractAddress: string;
        circuit: string;
        args: unknown[];
        indexerHttpUrl: string;
        indexerWsUrl: string;
        proofServerUrl: string;
        networkId: string;
        merkleProof?: MerkleProofBundle;
        /** Seeded on this wallet's FIRST call to the contract (see below).
         *  Defaults to `{}`, which is what a stateless contract deploys with. */
        initialPrivateState?: unknown;
        /** Optional fee sponsor: this facade balances ['dust'] and submits. */
        sponsorSessionId?: string;
    }) {
        const entry = facades.get(sessionId);
        if (!entry) throw new Error(`No facade for sessionId=${sessionId.slice(0, 16)}`);
        const sponsorEntry = resolveSponsorEntry(sponsorSessionId);
        const timer = new PhaseTimer();
        const callRegion = { start: 0 };
        try {
            const sdk = await loadSdk();
            await ensureNetworkId(networkId, sdk);
            timer.mark('init');

            const compiledContract = await getOrCompileContract(contractName, registration, entry, merkleProof);
            timer.mark('compile');
            const contractProviders = await buildWorkerContractProviders({
                indexerHttpUrl, indexerWsUrl, proofServerUrl,
                zkConfigPath: artifactAssetPath(contractName, registration), generation: registration.artifactDigest
            });
            timer.mark('providers');
            const privateStateProvider = createPrivateStateProxy(proxyId);
            const walletProvider = sponsorEntry
                ? buildSponsoredWalletProvider(entry, sponsorEntry)
                : buildWorkerWalletProvider(entry);

            const providers = wrapProvidersForTiming({
                ...contractProviders,
                publicDataProvider: withFindContractQueryCache(contractProviders.publicDataProvider, indexerHttpUrl),
                privateStateProvider,
                walletProvider,
                midnightProvider: walletProvider
            }, timer, callRegion);

            const { contracts } = await loadContractsSdk();
            log('info', `submitContractCall: ${contractName}.${circuit}@${contractAddress.slice(0, 12)}` +
                (sponsorEntry ? ` (fee sponsored by ${String(sponsorSessionId).slice(0, 16)})` : ''));

            // A wallet that did not DEPLOY this contract has no entry at its
            // privateStateId, and `findDeployedContract` then throws "No private
            // state found at private state ID '<id>'". That blocks the entire
            // multi-caller case (several wallets acting on one shared contract,
            // e.g. N producers anchoring in the same attestation vault).
            //
            // Seed the private state on first contact for this wallet, and ONLY
            // then: the initialPrivateState variant of findDeployedContract
            // OVERWRITES whatever is stored, so an existing state (the deployer's,
            // or one a previous call evolved) must never be handed to it.
            // The store scopes reads by contract address (`findDeployedContract`
            // sets it internally); this probe runs BEFORE that, so set it here or
            // the provider rejects the read with "Contract address not set".
            privateStateProvider.setContractAddress(contractAddress);
            const existingPrivateState = await privateStateProvider.get(registration.privateStateId);
            const seed = existingPrivateState === undefined || existingPrivateState === null;
            if (seed) {
                log('info',
                    `submitContractCall: no private state at '${registration.privateStateId}' for this wallet, ` +
                    `seeding the contract's initial private state`);
            }
            timer.mark('stateProbe');
            const found = await contracts.findDeployedContract(providers, {
                contractAddress,
                compiledContract,
                privateStateId: registration.privateStateId,
                ...(seed ? { initialPrivateState: initialPrivateState ?? {} } : {})
            });
            timer.mark('findContract');
            const fn = found?.callTx?.[circuit];
            if (typeof fn !== 'function') {
                throw new Error(`Circuit '${circuit}' not found on contract at ${contractAddress}`);
            }
            callRegion.start = Date.now();
            const result = await fn(...(callArgs ?? []));
            timer.add('callTotal', Date.now() - callRegion.start);
            const pub = result?.public;
            const out = {
                txHash: String(pub?.txHash ?? ''),
                onChainStatus: String(pub?.status ?? '')
            };
            log('info', `submitContractCall: done txHash=${out.txHash.slice(0, 16)} status=${out.onChainStatus}`);
            return out;
        } finally {
            log('debug', `submitContractCall timing: ${contractName}.${circuit} ${timer.summary()}`);
        }
    },

    /**
     * EXPERIMENTAL PROTOTYPE (cross-server-fee-sponsoring FR). Proves the
     * load-bearing unknown: a caller builds + signs + finalizes a contract
     * call (phase 1), the fee-unpaid FinalizedTransaction survives a
     * serialize -> deserialize round-trip, and a SEPARATE sponsor session then
     * balances dust onto it and submits (phase 2). Same-worker here; splitting
     * the two phases across machines is then only transport.
     *
     * Returns { txHash, serializedBytes, roundTrip }. On any failure after the
     * caller finalized, the caller's phase-1 spends are reverted so its coins
     * are not stuck pending.
     */
    async probeCrossServerSponsor(args: {
        sessionId: string;
        sponsorSessionId: string;
        proxyId: string;
        contractName: string;
        registration: { artifactPath: string; artifactDigest?: string; privateStateId: string; zkConfigPath: string; slotWidth?: number };
        contractAddress: string;
        circuit: string;
        args?: unknown[]; // the call arguments (same field name as submitContractCall's RPC)
        indexerHttpUrl: string;
        indexerWsUrl: string;
        proofServerUrl: string;
        networkId: string;
        merkleProof?: MerkleProofBundle;
        initialPrivateState?: unknown;
    }) {
        const entry = facades.get(args.sessionId);
        if (!entry) throw new Error(`No facade for sessionId=${args.sessionId.slice(0, 16)}`);
        const sponsor = resolveSponsorEntry(args.sponsorSessionId);
        if (!sponsor) throw new Error('probeCrossServerSponsor requires a sponsorSessionId');
        log('info', `probe: start ${args.contractName}.${args.circuit}; caller=${args.sessionId.slice(0, 8)} sponsor=${args.sponsorSessionId.slice(0, 8)}`);

        const sdk = await loadSdk();
        await ensureNetworkId(args.networkId, sdk);
        log('info', 'probe: compiling contract');
        const compiledContract = await getOrCompileContract(args.contractName, args.registration, entry, args.merkleProof);
        log('info', 'probe: building providers');
        const contractProviders = await buildWorkerContractProviders({
            indexerHttpUrl: args.indexerHttpUrl, indexerWsUrl: args.indexerWsUrl,
            proofServerUrl: args.proofServerUrl, zkConfigPath: artifactAssetPath(args.contractName, args.registration), generation: args.registration.artifactDigest
        });
        const privateStateProvider = createPrivateStateProxy(args.proxyId);
        const holder: { captured?: any } = {};
        const walletProvider = buildBuildOnlyWalletProvider(entry, holder);
        const providers = {
            ...contractProviders,
            publicDataProvider: withFindContractQueryCache(contractProviders.publicDataProvider, args.indexerHttpUrl),
            privateStateProvider, walletProvider, midnightProvider: walletProvider
        };
        log('info', 'probe: loading contracts SDK');
        const { contracts } = await loadContractsSdk();

        // Same first-contact private-state seeding as submitContractCall.
        log('info', 'probe: reading private state');
        privateStateProvider.setContractAddress(args.contractAddress);
        const existing = await privateStateProvider.get(args.registration.privateStateId);
        const seed = existing === undefined || existing === null;
        log('info', `probe: findDeployedContract (seed=${seed})`);
        const found = await contracts.findDeployedContract(providers, {
            contractAddress: args.contractAddress, compiledContract,
            privateStateId: args.registration.privateStateId,
            ...(seed ? { initialPrivateState: args.initialPrivateState ?? {} } : {})
        });
        const fn = found?.callTx?.[args.circuit];
        if (typeof fn !== 'function') throw new Error(`Circuit '${args.circuit}' not found on contract at ${args.contractAddress}`);
        log('info', 'probe: running phase 1 (build + sign + finalize)');

        // Phase 1: build-only provider balances + signs + finalizes, then
        // throws BuildOnlyStop from submitTx to abort the SDK's post-submit
        // watch. The SDK WRAPS that throw ("Unexpected error submitting scoped
        // transaction ... BuildOnlyStop"), so instanceof no longer matches;
        // key the success on holder.captured being set instead. Only an empty
        // holder means a real phase-1 failure.
        try {
            await fn(...(args.args ?? []));
        } catch (e) {
            if (!holder.captured) throw e;
        }
        const callerFinalized = holder.captured;
        if (!callerFinalized || typeof callerFinalized.serialize !== 'function') {
            throw new Error('phase 1 did not produce a serializable finalized transaction (holder empty)');
        }
        log('info', 'probe: phase 1 captured; serialize -> deserialize round-trip');

        // The round-trip under test: serialize -> (this is what crosses the
        // wire) -> deserialize -> feed to the sponsor's dust balancing. The
        // finalized tx is the facade's type; try matching deserializers and
        // whatever serialize actually returns (bytes or a hex string).
        const serialized: any = callerFinalized.serialize();
        const serKind = typeof serialized === 'string' ? 'string' : (serialized?.constructor?.name ?? typeof serialized);
        const serLen = typeof serialized === 'string' ? serialized.length : (serialized?.byteLength ?? serialized?.length ?? 0);
        const ownCtor: any = callerFinalized.constructor;
        log('info', `probe: serialized kind=${serKind} len=${serLen}; own ctor=${ownCtor?.name} hasStaticDeserialize=${typeof ownCtor?.deserialize === 'function'}`);
        const ledger: any = cachedLedger ?? (cachedLedger = await import('@midnight-ntwrk/ledger-v8'));

        // Candidate (deserializer, input) pairs, in order of likelihood.
        const asBytes = typeof serialized === 'string' ? new Uint8Array(Buffer.from(serialized, 'hex')) : new Uint8Array(serialized);
        // ledger-v8 Transaction.deserialize takes THREE string markers
        // (Signaturish/Proofish/Bindingish instance tags) + the raw bytes. A
        // caller-finalized tx is signed + proven + bound. Try that first, then a
        // couple of proof/binding variants in case finalize leaves it unbound.
        const M = (s: string, p: string, b: string) => () => ledger.Transaction.deserialize(s, p, b, asBytes);
        const candidates: Array<[string, () => any]> = [
            ["deserialize('signature','proof','binding')", M('signature', 'proof', 'binding')],
            ["deserialize('signature','proof','pre-binding')", M('signature', 'proof', 'pre-binding')],
            ["deserialize('signature','pre-proof','pre-binding')", M('signature', 'pre-proof', 'pre-binding')],
            ['ownCtor.deserialize(bytes)', () => ownCtor?.deserialize?.(asBytes)]
        ];
        let rehydrated: any;
        const errs: string[] = [];
        for (const [name, fnTry] of candidates) {
            try { const r = fnTry(); if (r) { rehydrated = r; log('info', `probe: deserialized via ${name}`); break; } }
            catch (e) { errs.push(`${name}: ${formatErr(e).slice(0, 80)}`); }
        }
        if (!rehydrated) {
            await revertRecipeBestEffort(entry.facade, callerFinalized, 'probe caller (deserialize failed)');
            throw new Error(`finalized-tx round-trip FAILED at deserialize; tried: ${errs.join(' | ')}`);
        }
        const bytes = asBytes;

        try {
            const txId = await sponsorAndSubmitFinalized(sponsor, rehydrated, 'probe');
            log('info', `probeCrossServerSponsor: LANDED via cross-phase round-trip, txHash=${txId.slice(0, 16)} (${bytes.length}B)`);
            return { txHash: txId, serializedBytes: bytes.length, roundTrip: true };
        } catch (e) {
            // The sponsor half failed: revert the caller's pended phase-1 spends.
            await revertRecipeBestEffort(entry.facade, callerFinalized, 'probe caller (sponsor phase failed)');
            throw e;
        }
    },

    /**
     * PHASE 1 of cross-server sponsoring (0.17.0): build + sign + finalize a
     * contract call and return the fee-unpaid finalized tx as base64, WITHOUT
     * submitting. The caller's identity is baked in here. A remote sponsor (or
     * `sponsorFinalizedTx` below) balances dust onto it and submits. Same worker
     * shape as submitContractCall, but the build-only provider stops at finalize.
     */
    async buildSponsorableTx(args: {
        sessionId: string; proxyId: string; contractName: string;
        registration: { artifactPath: string; artifactDigest?: string; privateStateId: string; zkConfigPath: string; slotWidth?: number };
        contractAddress: string; circuit: string; args?: unknown[];
        indexerHttpUrl: string; indexerWsUrl: string; proofServerUrl: string;
        networkId: string; merkleProof?: MerkleProofBundle; initialPrivateState?: unknown;
    }) {
        const entry = facades.get(args.sessionId);
        if (!entry) throw new Error(`No facade for sessionId=${args.sessionId.slice(0, 16)}`);
        const sdk = await loadSdk();
        await ensureNetworkId(args.networkId, sdk);
        const compiledContract = await getOrCompileContract(args.contractName, args.registration, entry, args.merkleProof);
        const contractProviders = await buildWorkerContractProviders({
            indexerHttpUrl: args.indexerHttpUrl, indexerWsUrl: args.indexerWsUrl,
            proofServerUrl: args.proofServerUrl, zkConfigPath: artifactAssetPath(args.contractName, args.registration), generation: args.registration.artifactDigest
        });
        const privateStateProvider = createPrivateStateProxy(args.proxyId);
        const holder: { captured?: any } = {};
        const walletProvider = buildBuildOnlyWalletProvider(entry, holder);
        const providers = {
            ...contractProviders,
            publicDataProvider: withFindContractQueryCache(contractProviders.publicDataProvider, args.indexerHttpUrl),
            privateStateProvider, walletProvider, midnightProvider: walletProvider
        };
        const { contracts } = await loadContractsSdk();
        privateStateProvider.setContractAddress(args.contractAddress);
        const existing = await privateStateProvider.get(args.registration.privateStateId);
        const seed = existing === undefined || existing === null;
        const found = await contracts.findDeployedContract(providers, {
            contractAddress: args.contractAddress, compiledContract,
            privateStateId: args.registration.privateStateId,
            ...(seed ? { initialPrivateState: args.initialPrivateState ?? {} } : {})
        });
        const fn = found?.callTx?.[args.circuit];
        if (typeof fn !== 'function') throw new Error(`Circuit '${args.circuit}' not found on contract at ${args.contractAddress}`);
        try { await fn(...(args.args ?? [])); } catch (e) { if (!holder.captured) throw e; }
        const callerFinalized = holder.captured;
        if (!callerFinalized || typeof callerFinalized.serialize !== 'function') {
            throw new Error('phase 1 did not produce a serializable finalized transaction');
        }
        const bytes: Uint8Array = new Uint8Array(callerFinalized.serialize());
        log('info', `buildSponsorableTx: ${args.contractName}.${args.circuit} finalized (${bytes.length}B, fee-unpaid)`);
        return { finalizedTxB64: Buffer.from(bytes).toString('base64'), serializedBytes: bytes.length };
    },

    /**
     * PHASE 2 of cross-server sponsoring (0.17.0): take a caller-finalized,
     * fee-unpaid tx (base64), enforce sponsor-side policy (allowed vault +
     * circuits), balance dust with the SPONSOR facade and submit. The
     * attestation stays the caller's; the sponsor only pays. This is the half a
     * public / x402-metered endpoint exposes; the caller half runs on the
     * caller's own machine (the txbuilder SDK) so its key never leaves it.
     */
    async sponsorFinalizedTx(args: {
        sponsorSessionId: string; finalizedTxB64: string; networkId: string;
        allowedContracts?: string[]; allowedCircuits?: string[]; allowDeploy?: boolean; ownContracts?: string[];
        /** Set by the dispatcher: the RPC reply port, for the pre-broadcast submit-intent handshake. */
        __replyPort?: MessagePort;
    }) {
        const sponsor = resolveSponsorEntry(args.sponsorSessionId);
        if (!sponsor) throw new Error('sponsorFinalizedTx requires a sponsorSessionId');
        const sdk = await loadSdk();
        await ensureNetworkId(args.networkId, sdk);
        const { tx, bytes } = await deserializeFinalizedTx(args.finalizedTxB64);

        // Policy: FAIL-CLOSED shape check. Allow-listed contract calls are the
        // only thing a sponsorable tx may contain; deploys, token transfers,
        // caller dust, oversized or uninspectable transactions all refuse.
        const calls = checkSponsorableShape(tx, bytes.length, args.allowedContracts, args.allowedCircuits, { allowDeploy: args.allowDeploy === true, ownContracts: args.ownContracts });
        log('info', `sponsorFinalizedTx: paying dust for ${calls.map(c => c.entryPoint).join('+')} (${bytes.length}B)`);
        const txId = await sponsorAndSubmitFinalized(sponsor, tx, 'sponsor-endpoint', args.__replyPort, calls);
        log('info', `sponsorFinalizedTx: LANDED txHash=${txId.slice(0, 16)}`);
        return {
            txHash: txId, circuits: calls.map(c => c.entryPoint), contractAddress: calls[0]?.address ?? '',
            deployed: calls.filter(c => c.entryPoint === DEPLOY_ENTRY_POINT).map(c => c.address)
        };
    },

    /**
     * 0.18 PARALLEL sponsoring (dust-note-pool FR). Takes an UNBOUND
     * (pre-binding) proven+signed caller tx, locks ONE free dust BACKING of
     * the sponsor wallet, builds a dust-only tx against a note on it, proves
     * it, merges it into the caller tx and binds, then submits. N backings
     * back N parallel sponsorings from ONE wallet.
     *
     * CONCURRENCY CONTRACT (why this handler is NOT in SUBMIT_METHODS): the
     * path never touches the sponsor facade's mutable state. spendCoins is
     * functional (the updated CoreWallet state is discarded) and the submit
     * goes out on a DEDICATED node client (see withDedicatedSubmitClient: the
     * facade's shared client cannot carry two submits at once), so the facade
     * never books, reverts or tracks anything for this tx. Proving + submit
     * overlap between jobs; only the fast, key-using build runs under the
     * per-session lock (evict can't zero the dust key mid-spend, and two
     * builds never read the same dust snapshot). The whole-wallet dust-wedge
     * snapshot/restore is deliberately NOT armed here: there is nothing to
     * roll back, and a restore would swap `facade.dust` under concurrent
     * jobs. A lost dust race (1010/170) is healed by the handler's
     * rebuild-retry, an unused backing lock expires.
     */
    async sponsorUnboundTx(args: {
        sponsorSessionId: string; unboundTxB64: string; networkId: string;
        allowedContracts?: string[]; allowedCircuits?: string[]; allowDeploy?: boolean; ownContracts?: string[];
        /** Set by the dispatcher: the RPC reply port, for the pre-broadcast submit-intent handshake. */
        __replyPort?: MessagePort;
    }) {
        const sponsor = resolveSponsorEntry(args.sponsorSessionId);
        if (!sponsor) throw new Error('sponsorUnboundTx requires a sponsorSessionId');
        const sdk = await loadSdk();
        await ensureNetworkId(args.networkId, sdk);
        const { tx: callerTx, bytes } = await deserializeFinalizedTx(args.unboundTxB64);

        // Same fail-closed shape policy as the bound path.
        const calls = checkSponsorableShape(callerTx, bytes.length, args.allowedContracts, args.allowedCircuits, { allowDeploy: args.allowDeploy === true, ownContracts: args.ownContracts });

        await waitForGenuineSync(sponsor, BALANCE_SYNC_TIMEOUT_MS, 'sponsor-unbound');

        // Fee estimate for the caller tx -> how much dust the note must hold.
        const params = sdk.ledger.LedgerParameters?.initialParameters?.() ?? sdk.ledger.LedgerParameters?.default?.();
        let needSpecks: bigint;
        try { needSpecks = callerTx.feesWithMargin(params, 2); }
        catch { needSpecks = 100_000_000n; } // fallback floor if the estimate API shifts
        if (needSpecks <= 0n) needSpecks = 100_000_000n;

        // Read `facade.dust` at each use, never cache it: a bound-path dust
        // restore on this sponsor swaps the sub-wallet object.
        const leaseTtlMs = noteLeaseTtlMs();
        const backingWaitMs = (() => {
            const t = Number(process.env.NIGHTGATE_BACKING_WAIT_MS);
            return Number.isInteger(t) && t >= 0 ? t : 5 * 60 * 1000;
        })();

        // Lock a BACKING first, WAITING if all backings are busy. This makes a
        // single-backing wallet serialize deterministically (the 2nd request
        // waits out the 1st's submit) and a multi-backing wallet parallel.
        const snapshotNotes = async (): Promise<any[]> => {
            const dws: any = await firstDustState(sponsor.facade.dust);
            const cab = dws.capabilities?.coinsAndBalances;
            return Array.from(cab?.getAvailableCoins?.(dws.state, new Date()) ?? []);
        };
        const leased = await acquireBacking(sponsor.sessionId, snapshotNotes, needSpecks, leaseTtlMs, backingWaitMs);

        const stopRenewal = keepLeaseAlive(leased.key, leased.token, leaseTtlMs);
        let built: { dustUnproven: any };
        try {
            // Block-time ctime (a wall-clock ctime ahead of the block is the
            // 1010/170 site). Fetched BEFORE taking the lock: a network call
            // must not hold the per-session lock, and an earlier ctime is
            // safe (only a later one is rejected).
            const tip = await getIndexerTip(sponsor.indexerHttpUrl);
            const ctime = (() => {
                const t = tip.timestampMs;
                if (t == null || !Number.isFinite(t)) return new Date();
                const ms = t > 1e12 ? t : t * 1000; // < 1e12 => seconds
                const d = new Date(ms);
                return Number.isNaN(d.getTime()) ? new Date() : d;
            })();
            const ttl = new Date(ctime.getTime() + 30 * 60 * 1000);
            const CoreWalletApi = await loadDustCoreWallet();
            // SERIALIZED per wallet under the session lock (the same lock the
            // whole-call SUBMIT_METHODS hold): fresh snapshot -> spendCoins on
            // the leased backing -> build dust-only tx. Two builds never read
            // the same dust snapshot, and a bound-path job or an evict on this
            // sponsor cannot interleave with the key-using step. This is the
            // fast part; prove + submit follow OUTSIDE the lock, in parallel.
            built = await withSessionLocks([sponsor.sessionId], async () => {
                if (facades.get(sponsor.sessionId) !== sponsor) {
                    throw new Error('sponsor facade was evicted while waiting for the dust build lock');
                }
                const dws: any = await firstDustState(sponsor.facade.dust);
                const cab = dws.capabilities?.coinsAndBalances;
                const fresh: any[] = Array.from(cab?.getAvailableCoins?.(dws.state, new Date()) ?? []);
                const note = fresh.find((n) => backingKey(sponsor.sessionId, n) === leased.key
                    && (() => { try { return BigInt(n.generatedNow ?? 0) >= needSpecks; } catch { return false; } })())
                    ?? leased.note;
                const [spends] = CoreWalletApi.spendCoins(dws.state, sponsor.dustKey, [{ token: note.token, value: needSpecks }], ctime);
                const intent = sdk.ledger.Intent.new(ttl);
                intent.dustActions = new sdk.ledger.DustActions('signature', 'pre-proof', ctime, [spends[0]]);
                const dustUnproven = sdk.ledger.Transaction.fromPartsRandomized(args.networkId, undefined, undefined, intent);
                return { dustUnproven };
            });
        } catch (e) { stopRenewal(); releaseNote(leased.key, leased.token); throw e; }

        try {
            // Prove (parallel-safe) + merge into the caller tx (both pre-binding) + bind.
            // The sponsor's dust spend is proved with the FACADE's proving
            // service: the proof server in server mode (native, multi-threaded;
            // measured hosted: ~45 s in-process wasm vs single-digit seconds),
            // the shared wasm prover in wasm mode. Before, this path always
            // proved in wasm and that was the bulk of a sponsoring's latency.
            const tProve = Date.now();
            let provingService: any = sponsor.facade?.provingService;
            if (!provingService?.prove) {
                const provingSdk = await loadProvingSdk();
                const sharedKeys = await getSharedKeyMaterialProvider();
                provingService = provingSdk.makeWasmProvingService({ keyMaterialProvider: sharedKeys });
            }
            const dustProven = await provingService.prove(built.dustUnproven);
            log('info', `sponsorUnboundTx: dust spend proven in ${Date.now() - tProve}ms (${sponsor.facade?.provingService?.prove ? resolveProvingMode() : 'wasm'})`);
            const bound = dustProven.merge(callerTx).bind();
            // EXTERNAL-EFFECT BOUNDARY: the transaction identifier is known
            // before anything leaves the process. Hand it to the main thread
            // and WAIT for its ack (the job row then carries the txHash and is
            // in external_execution/submitted) before broadcasting, so a failure
            // after the broadcast (socket drop, watch timeout) becomes
            // reconciliation_required with the hash, never a plain `failed`
            // for a call that may be on-chain.
            await announceSubmitIntent(args.__replyPort, {
                txHash: String(bound.identifiers().at(-1)),
                contractAddress: calls[0]?.address, circuits: calls.map(c => c.entryPoint), note: leased.backing, sponsorAccountId: sponsor.sessionId,
                deployed: calls.filter(c => c.entryPoint === DEPLOY_ENTRY_POINT).map(c => c.address)
            });
            const txId = await submitOnDedicatedClient(sponsor, bound, 'sponsor-unbound-submit');
            log('info', `sponsorUnboundTx: LANDED txHash=${String(txId).slice(0, 16)} on backing ${leased.backing}`);
            return {
                txHash: String(txId), circuits: calls.map(c => c.entryPoint), contractAddress: calls[0]?.address ?? '', note: leased.backing,
                deployed: calls.filter(c => c.entryPoint === DEPLOY_ENTRY_POINT).map(c => c.address)
            };
        } finally {
            stopRenewal();
            releaseNote(leased.key, leased.token);
        }
    },

    /**
     * Submit SEVERAL circuit calls against ONE deployed contract as a SINGLE
     * transaction, via the SDK's `withContractScopedTransaction`. Each call is
     * added to the shared TransactionContext (the circuit-call interface's
     * `(txCtx, ...args)` overload); the SDK threads the contract's running
     * state across the calls, then balances, signs and submits ONCE at scope
     * end. With a sponsor, the two-phase dust balancing therefore also runs
     * once for the whole batch instead of once per call.
     *
     * Failure semantics, two distinct phases:
     * - BEFORE submission (a bad circuit, a throwing call, proving/balancing
     *   errors): the scope discards all unsubmitted calls and nothing is
     *   submitted.
     * - AFTER submission the ledger's fallible phase still applies: the
     *   transaction can finalize as PARTIAL_SUCCESS, i.e. it IS on chain and a
     *   subset of the batched calls may have been applied. The submitter then
     *   marks the submission failed (OnChainStatus:...), so callers must check
     *   effect state (e.g. verifyAttestationState) rather than assume
     *   all-or-nothing.
     */
    async submitContractCallBatch({
        sessionId, proxyId, contractName, registration,
        contractAddress, calls,
        indexerHttpUrl, indexerWsUrl, proofServerUrl,
        networkId, merkleProof, initialPrivateState,
        sponsorSessionId, independentCalls, orderedPrefix
    }: {
        sessionId: string;
        proxyId: string;
        contractName: string;
        registration: ContractRegistration;
        contractAddress: string;
        /** Ordered circuit calls; all execute inside one transaction scope.
         *  A call may carry its OWN `merkleProof` (per-call witness binding
         *  for proveFieldPredicate); any per-call proof switches the whole
         *  batch to holder mode, where the loop swaps the current proof
         *  before each call. Mutually exclusive with the batch-level
         *  `merkleProof` below. */
        calls: Array<{ circuit: string; args: unknown[]; merkleProof?: MerkleProofBundle }>;
        indexerHttpUrl: string;
        indexerWsUrl: string;
        proofServerUrl: string;
        networkId: string;
        /** Batch-level proof bundle: bound once to the compiled contract
         *  instance shared by every call in the scope. */
        merkleProof?: MerkleProofBundle;
        initialPrivateState?: unknown;
        /** Optional fee sponsor: this facade balances ['dust'] and submits. */
        sponsorSessionId?: string;
        /** The calls past `orderedPrefix` share no state: group them by execution stage before proving. */
        independentCalls?: boolean;
        orderedPrefix?: number;
    }) {
        if (!Array.isArray(calls) || calls.length === 0) {
            throw new Error('submitContractCallBatch: calls must be a non-empty array');
        }
        const entry = facades.get(sessionId);
        if (!entry) throw new Error(`No facade for sessionId=${sessionId.slice(0, 16)}`);
        const sponsorEntry = resolveSponsorEntry(sponsorSessionId);
        const timer = new PhaseTimer();
        const callRegion = { start: 0 };
        const circuits = calls.map(c => c.circuit);
        try {
            const sdk = await loadSdk();
            await ensureNetworkId(networkId, sdk);
            timer.mark('init');

            // Per-call witness binding: any call-level merkleProof switches the
            // batch to holder mode. EVERY call then gets a hook, so a call
            // without its own proof clears the holder rather than inheriting
            // its predecessor's.
            const holderMode = calls.some(c => c.merkleProof);
            if (holderMode && merkleProof) {
                throw new Error('submitContractCallBatch: per-call merkleProof and batch-level merkleProof are mutually exclusive');
            }
            const holder: { current?: MerkleProofBundle } = {};
            const scopeCalls = holderMode
                ? calls.map(c => ({ circuit: c.circuit, args: c.args, before: () => { holder.current = c.merkleProof; } }))
                : calls;

            const compiledContract = await getOrCompileContract(
                contractName, registration, entry,
                holderMode ? undefined : merkleProof,
                holderMode ? holder : undefined
            );
            timer.mark('compile');
            const contractProviders = await buildWorkerContractProviders({
                indexerHttpUrl, indexerWsUrl, proofServerUrl,
                zkConfigPath: artifactAssetPath(contractName, registration), generation: registration.artifactDigest
            });
            timer.mark('providers');
            const privateStateProvider = createPrivateStateProxy(proxyId);
            const walletProvider = sponsorEntry
                ? buildSponsoredWalletProvider(entry, sponsorEntry)
                : buildWorkerWalletProvider(entry);

            const providers = wrapProvidersForTiming({
                ...contractProviders,
                publicDataProvider: withFindContractQueryCache(contractProviders.publicDataProvider, indexerHttpUrl),
                privateStateProvider,
                walletProvider,
                midnightProvider: walletProvider
            }, timer, callRegion);

            const { contracts } = await loadContractsSdk();
            log('info', `submitContractCallBatch: ${contractName}.[${circuits.join('+')}]@${contractAddress.slice(0, 12)}` +
                (sponsorEntry ? ` (fee sponsored by ${String(sponsorSessionId).slice(0, 16)})` : ''));

            // Same first-contact private-state seeding as submitContractCall: a
            // wallet that did not deploy this contract has no entry at its
            // privateStateId, and findDeployedContract would throw. Never
            // overwrite an existing state.
            privateStateProvider.setContractAddress(contractAddress);
            const existingPrivateState = await privateStateProvider.get(registration.privateStateId);
            const seed = existingPrivateState === undefined || existingPrivateState === null;
            if (seed) {
                log('info',
                    `submitContractCallBatch: no private state at '${registration.privateStateId}' for this wallet, ` +
                    `seeding the contract's initial private state`);
            }
            timer.mark('stateProbe');
            const found = await contracts.findDeployedContract(providers, {
                contractAddress,
                compiledContract,
                privateStateId: registration.privateStateId,
                ...(seed ? { initialPrivateState: initialPrivateState ?? {} } : {})
            });
            timer.mark('findContract');
            // Scope mechanics (circuit validation, ordered (txCtx, ...args) calls,
            // result mapping) live in batch-call-scope.ts so they are unit-testable
            // outside the worker-thread guard.
            callRegion.start = Date.now();
            const out = await runBatchInScope(contracts, providers, found, scopeCalls, contractAddress, { independentCalls, orderedPrefix });
            timer.add('callTotal', Date.now() - callRegion.start);
            log('info', `submitContractCallBatch: done txHash=${out.txHash.slice(0, 16)} status=${out.onChainStatus} calls=${out.circuits.length}`);
            return out;
        } finally {
            log('debug', `submitContractCallBatch timing: ${contractName}.[${circuits.join('+')}] ${timer.summary()}`);
        }
    }
};

// ---- Per-facade serialization ---------------------------------------------

// Submitting handlers serialize per facade: two concurrent balance+submit calls
// on the SAME wallet would select overlapping UTXO/dust inputs and the node
// rejects the second (double-select). A sponsored submit also balances the
// sponsor's facade, so it locks both keys. Read-only handlers stay concurrent.
// This whole-call lock is ALSO what makes the dust-wedge snapshot/restore
// safe (one build/submit per facade at a time, see restoreDustFromSnapshot).
// `sponsorUnboundTx` is deliberately NOT listed: it takes the lock itself
// around its fast build only, so proving + submit overlap across jobs (its
// doc comment states the contract that makes that safe).
const SUBMIT_METHODS = new Set([
    'deployContract', 'submitContractCall', 'submitContractCallBatch',
    'registerDustGeneration', 'deregisterDustGeneration',
    'transferNight', 'probeCrossServerSponsor', 'buildSponsorableTx', 'sponsorFinalizedTx'
]);

const sessionChains = new Map<string, Promise<unknown>>();

function submitLockKeys(args: any): string[] {
    return [args?.sessionId, args?.sponsorSessionId]
        .filter((k): k is string => typeof k === 'string' && k.length > 0);
}

/**
 * Run `fn` with an exclusive slot on every key in `keys`. Keys are deduped and
 * sorted, and we never hold one slot while waiting for another (we wait for all
 * prior holders to settle, THEN run), so multi-key acquisition can't deadlock.
 */
async function withSessionLocks<T>(keys: string[], fn: () => Promise<T>): Promise<T> {
    const ordered = [...new Set(keys)].sort();
    if (ordered.length === 0) return fn();
    const prevs = ordered.map((k) => sessionChains.get(k) ?? Promise.resolve());
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    for (const k of ordered) sessionChains.set(k, gate);
    await Promise.allSettled(prevs);
    try {
        return await fn();
    } finally {
        release();
    }
}

// ---- Dispatcher -----------------------------------------------------------

if (!parentPort) {
    throw new Error('wallet-worker must be loaded as a worker_threads worker (no parentPort)');
}

parentPort.on('message', async (msg: any) => {
    if (msg?.kind === 'state-save-ack') {
        // Main thread confirmed it persisted save `seq`. Resolve durability
        // waiters FIRST (independent of the facade lookup); an entry evicted
        // in the meantime is otherwise ignored; merge/epoch rules in
        // applySaveAck.
        resolveSaveAckWaiter(msg.seq);
        const entry = facades.get(String(msg.sessionId ?? ''));
        if (entry) applySaveAck(entry, msg.seq);
        return;
    }
    if (msg?.kind !== 'rpc' || !msg.port) {
        log('warn', `unexpected message: ${JSON.stringify(msg).slice(0, 80)}`);
        return;
    }
    const { method, args, port } = msg as RpcRequest;
    if (draining) {
        // Admission is closed for the rotation; the client retries on the respawn.
        port.postMessage({ ok: false, error: { name: WORKER_ROTATING, message: 'wallet worker is rotating (artifact generation budget); retry on the respawned worker' } } as RpcErr);
        port.close();
        return;
    }
    try {
        const fn = handlers[method];
        if (!fn) throw new Error(`Unknown method: ${method}`);
        // The unbound sponsor path gets the reply port for its pre-broadcast
        // submit-intent handshake (see announceSubmitIntent).
        const callArgs = (method === 'sponsorUnboundTx' || method === 'sponsorFinalizedTx') ? { ...(args as object), __replyPort: port } : args;
        // A contract job holds its artifact generation for the whole call.
        const releaseGeneration = retainGeneration((args as any)?.registration?.artifactDigest);
        inflightRpcs++;
        let result: unknown;
        try {
            result = SUBMIT_METHODS.has(method)
                ? await withSessionLocks(submitLockKeys(args), () => fn(callArgs))
                : await fn(callArgs);
        } finally {
            inflightRpcs--;
            releaseGeneration();
            // Shared completion path (success and failure).
            rotateIfDue();
        }
        port.postMessage({ ok: true, result } as RpcOk);
    } catch (err: any) {
        // Carry the nested cause chain across the thread boundary: the node's
        // `1010: ... Custom error: N` line lives in the innermost cause and the
        // main-thread classifiers (dust race, failover) key on it.
        const payload: RpcErrorPayload = {
            name: err?.name ?? 'Error',
            message: formatErrWithCauses(err)
        };
        port.postMessage({ ok: false, error: payload } as RpcErr);
    } finally {
        port.close();
    }
});

parentPort.postMessage({ kind: 'ready' });
log('info', 'ready');
