/**
 * Artifact generations in the worker: scaffold cache, immutable content-addressed
 * snapshots, generation retention and the generation-pinned module import.
 */

// First import on purpose: the worker modules import each other in cycles and
// a module-level read must resolve before the cycle re-enters.
import { configNumber, configString } from '../../utils/config';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { computeArtifactGenerationDigest, effectiveModuleFormat, runtimeNodeModulesDir, proverKeyManifestProblems } from '../../submission/artifact-digest';
import { BoundedCache } from './bounded-cache';
import { log } from './context';
import { zkProviderBundles } from './contracts';
import { noteGenerationImported } from './rotation';

// ---- Compiled-contract cache ----------------------------------------------

export interface ContractRegistration {
    artifactPath: string;
    /** Generation digest the main thread resolved (module + verifier keys); keys the module cache. */
    artifactDigest?: string;
    privateStateId: string;
    zkConfigPath: string;
    /** Content-tree width of a vault-family artifact (16 default, 32 for attestation-vault-32). */
    slotWidth?: number;
}

// Only the imported class is cached: witnesses are session-specific, so the
// composition is rebuilt per call.
export interface ContractScaffold {
    contractClass: any;
}

/** Artifact generations kept warm (classes, zk config + proving providers); NIGHTGATE_WORKER_GENERATION_CACHE, default 8. */
export function generationCacheSize(): number {
    return configNumber('NIGHTGATE_WORKER_GENERATION_CACHE');
}
export const contractScaffolds = new BoundedCache<string, ContractScaffold>(generationCacheSize(), (key) => onGenerationEvicted(key.split('\0')[2] ?? ''));

/** Test seam: drop every cached class. Node's ESM cache keeps the modules. */
export function __resetScaffoldCacheForTests(): void {
    for (const k of contractScaffolds.keys()) contractScaffolds.delete(k);
}

export async function getContractScaffold(name: string, registration: ContractRegistration): Promise<ContractScaffold> {
    // Keyed by name, path and digest: a name is a mutable alias and a path can
    // be rewritten in place.
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
        mod = await importArtifactGeneration(registration.artifactPath, generation);
    }
    const contractClass = mod.Contract ?? mod.default ?? mod;
    const scaffold: ContractScaffold = { contractClass };
    contractScaffolds.set(key, scaffold);
    return scaffold;
}

// ---- Content-addressed artifact snapshots ---------------------------------

/**
 * Immutable snapshot `<root>/<digest>/{module,keys,zkir}`: the SDK reads keys lazily at
 * proving time, so it must never see the mutable registration dir. Built under a temp
 * name, verified against the digest, renamed, never written again.
 */
export interface ArtifactSnapshot {
    digest: string;
    /** Immutable directory holding keys/ and zkir/ of this generation. */
    zkConfigPath: string;
    /** The module inside the snapshot; the class is imported from here. */
    modulePath: string;
}
export const verifiedSnapshots = new Set<string>();
export let snapshotRootPrepared: string | null = null;
export const SNAPSHOT_ROOT_MARKER = '.nightgate-snapshot-root';

/** Base dir; the per-install level lives below it. */
export function artifactSnapshotBase(): string {
    return configString('NIGHTGATE_ARTIFACT_SNAPSHOT_DIR') || path.join(os.tmpdir(), 'nightgate-artifact-snapshots');
}

/** One level per installation (the node_modules the runtime resolves from); two installs never share a link. */
export function installKey(): string {
    return crypto.createHash('sha256').update(runtimeNodeModulesDir()).digest('hex').slice(0, 16);
}

/**
 * Snapshot root shared by every process of this install. Holder files
 * (`<digest>/.holders/<pid>`) keep a sweep off snapshots a live process uses.
 */
export function artifactSnapshotRoot(): string {
    return path.join(artifactSnapshotBase(), installKey());
}

export const SNAPSHOT_HOLDERS_DIR = '.holders';

/** Record this process as a user of the snapshot (touched on every retain). */
export function holdSnapshot(dir: string): void {
    try {
        const holders = path.join(dir, SNAPSHOT_HOLDERS_DIR);
        fs.mkdirSync(holders, { recursive: true });
        fs.writeFileSync(path.join(holders, String(process.pid)), new Date().toISOString());
    } catch { /* best effort: a snapshot without a holder file is swept by the TTL only */ }
}

/** Drop this process's holder file. */
export function releaseSnapshotHold(dir: string): void {
    try { fs.rmSync(path.join(dir, SNAPSHOT_HOLDERS_DIR, String(process.pid)), { force: true }); } catch { /* best effort */ }
}

/** Other live processes holding the snapshot; dead holders' files are removed. */
export function otherLiveHolders(dir: string): number[] {
    const holders = path.join(dir, SNAPSHOT_HOLDERS_DIR);
    let entries: string[] = [];
    try { entries = fs.readdirSync(holders); } catch { return []; }
    const live: number[] = [];
    for (const entry of entries) {
        const pid = Number(entry);
        if (!Number.isInteger(pid) || pid === process.pid) continue;
        if (processAlive(pid)) live.push(pid);
        else fs.rmSync(path.join(holders, entry), { force: true });
    }
    return live;
}

export function processAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException)?.code === 'EPERM'; }
}

/** Test seam: forget which snapshots this process verified and prepared. */
export function __resetArtifactSnapshotsForTests(): void {
    verifiedSnapshots.clear();
    snapshotRootPrepared = null;
    generationRefs.clear();
}

export function snapshotTtlMs(): number {
    return configNumber('NIGHTGATE_ARTIFACT_SNAPSHOT_TTL_DAYS') * 24 * 60 * 60 * 1000;
}

/** Once per process: create the root, link its node_modules, sweep stale snapshots and leftover temp builds. */
export function prepareSnapshotRoot(): string {
    const root = artifactSnapshotRoot();
    if (snapshotRootPrepared === root) return root;
    // Private to the user (best effort without POSIX modes).
    fs.mkdirSync(artifactSnapshotBase(), { recursive: true, mode: 0o700 });
    try { fs.chmodSync(artifactSnapshotBase(), 0o700); } catch { /* not supported here */ }
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
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
    // Sweep per-process roots (`<install>/<pid>`) whose process is gone.
    for (const entry of listDir(root)) {
        const pid = Number(entry);
        if (!Number.isInteger(pid) || pid === process.pid || processAlive(pid)) continue;
        const full = path.join(root, entry);
        try {
            if (fs.lstatSync(full).isDirectory()) {
                fs.rmSync(full, { recursive: true, force: true });
                log('info', `artifact snapshot sweep: removed per-process root of dead process ${pid}`);
            }
        } catch { /* best effort */ }
    }
    // Sweep temp builds and snapshots unused within the TTL (mtime bumped per use) no live process holds.
    const cutoff = Date.now() - snapshotTtlMs();
    for (const entry of listDir(root)) {
        if (entry === 'node_modules' || entry === SNAPSHOT_ROOT_MARKER || Number.isInteger(Number(entry))) continue;
        const full = path.join(root, entry);
        try {
            const st = fs.lstatSync(full);
            if (!st.isDirectory()) continue;
            if (entry.includes('.tmp-')) {
                fs.rmSync(full, { recursive: true, force: true });
                log('info', `artifact snapshot sweep: removed leftover build ${entry.slice(0, 24)}…`);
            } else if (st.mtimeMs < cutoff && otherLiveHolders(full).length === 0) {
                fs.rmSync(full, { recursive: true, force: true });
                log('info', `artifact snapshot sweep: removed stale snapshot ${entry.slice(0, 24)}…`);
            }
        } catch { /* best effort */ }
    }
    snapshotRootPrepared = root;
    return root;
}

function listDir(dir: string): string[] {
    try { return fs.readdirSync(dir); } catch { return []; }
}

export function copyDirFiltered(from: string, to: string, filter: (f: string) => boolean): void {
    let files: string[] = [];
    try { files = fs.readdirSync(from).filter(filter).sort(); } catch { return; }
    if (files.length === 0) return;
    fs.mkdirSync(to, { recursive: true });
    for (const f of files) fs.copyFileSync(path.join(from, f), path.join(to, f));
}

/**
 * `.mjs`/`.cjs` carries the effective module format: the snapshot lives outside the
 * package scope whose package.json made a `.js` file ESM.
 */
export function snapshotModuleName(registration: ContractRegistration): string {
    return effectiveModuleFormat(registration.artifactPath) === 'module' ? 'artifact.mjs' : 'artifact.cjs';
}

export function snapshotRegistration(dir: string, registration: ContractRegistration) {
    return {
        artifactPath: path.join(dir, 'module', snapshotModuleName(registration)),
        privateStateId: registration.privateStateId,
        zkConfigPath: dir,
        ...(registration.slotWidth !== undefined ? { slotWidth: registration.slotWidth } : {})
    };
}

/**
 * Copy a source map with `sourceRoot` made absolute against the original module
 * dir, so its relative `sources` keep resolving. Unparseable maps copy verbatim.
 */
export function copySourceMapRebased(from: string, to: string, originalDir: string): void {
    try {
        const map = JSON.parse(fs.readFileSync(from, 'utf8'));
        if (map && typeof map === 'object') {
            // Trailing separator: resolvers prepend sourceRoot to each entry.
            map.sourceRoot = path.resolve(originalDir, String(map.sourceRoot ?? '')) + path.sep;
            fs.writeFileSync(to, JSON.stringify(map));
            return;
        }
    } catch { /* fall through: verbatim copy */ }
    fs.copyFileSync(from, to);
}

export function touchSnapshot(dir: string): void {
    try { const now = new Date(); fs.utimesSync(dir, now, now); } catch { /* best effort */ }
}

export function materializeArtifactSnapshot(name: string, registration: ContractRegistration): ArtifactSnapshot | null {
    const digest = registration.artifactDigest;
    if (!digest) return null;
    const root = prepareSnapshotRoot();
    const dir = path.join(root, digest);
    const snapReg = snapshotRegistration(dir, registration);
    const result: ArtifactSnapshot = { digest, zkConfigPath: dir, modulePath: snapReg.artifactPath };

    if (verifiedSnapshots.has(digest) && fs.existsSync(snapReg.artifactPath)) { touchSnapshot(dir); holdSnapshot(dir); return result; }
    if (fs.existsSync(dir)) {
        let onDisk: string | null = null;
        try { onDisk = computeArtifactGenerationDigest(snapReg); } catch { onDisk = null; }
        if (onDisk === digest) { verifiedSnapshots.add(digest); touchSnapshot(dir); holdSnapshot(dir); return result; }
        log('warn', `artifact snapshot ${digest.slice(0, 16)}… for '${name}' does not verify (${onDisk ? onDisk.slice(0, 16) + '…' : 'unreadable'}); rebuilding it from the registration`);
        fs.rmSync(dir, { recursive: true, force: true });
    }

    const tmp = `${dir}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    try {
        fs.mkdirSync(path.join(tmp, 'module'), { recursive: true });
        fs.copyFileSync(registration.artifactPath, path.join(tmp, 'module', snapshotModuleName(registration)));
        // Source map under the name sourceMappingURL expects; not part of the digest.
        const mapName = `${path.basename(registration.artifactPath)}.map`;
        const mapPath = path.join(path.dirname(registration.artifactPath), mapName);
        if (fs.existsSync(mapPath)) copySourceMapRebased(mapPath, path.join(tmp, 'module', mapName), path.dirname(registration.artifactPath));
        copyDirFiltered(path.join(registration.zkConfigPath, 'keys'), path.join(tmp, 'keys'), (f) => f.endsWith('.verifier') || f.endsWith('.prover') || f === 'manifest.json');
        copyDirFiltered(path.join(registration.zkConfigPath, 'zkir'), path.join(tmp, 'zkir'), () => true);
        // The digest pins the manifest, not the prover bytes: check them here.
        const manifestProblems = proverKeyManifestProblems(path.join(tmp, 'keys'));
        if (manifestProblems.length) throw new Error(`Contract '${name}': prover keys do not match keys/manifest.json, refusing to prove from them: ${manifestProblems.join('; ')}`);
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
            // A concurrent job may have won the rename: use its snapshot if it verifies.
            if (!fs.existsSync(dir) || computeArtifactGenerationDigest(snapReg) !== digest) throw e;
        }
        verifiedSnapshots.add(digest);
        holdSnapshot(dir);
        log('info', `artifact snapshot ${digest.slice(0, 16)}… materialised for '${name}' under ${dir}`);
        return result;
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
}

// ---- Generation retention ---------------------------------------------------

export const generationRefs = new Map<string, number>();

/** A job holds its generation for the whole RPC; the snapshot cannot be swept meanwhile. */
export function retainGeneration(digest: string | undefined): () => void {
    if (!digest) return () => undefined;
    generationRefs.set(digest, (generationRefs.get(digest) ?? 0) + 1);
    const dir = path.join(artifactSnapshotRoot(), digest);
    if (fs.existsSync(dir)) holdSnapshot(dir);
    let released = false;
    return () => {
        if (released) return;
        released = true;
        const n = (generationRefs.get(digest) ?? 1) - 1;
        if (n > 0) generationRefs.set(digest, n);
        else { generationRefs.delete(digest); sweepGenerationIfUnused(digest); }
    };
}

export function generationCached(digest: string): boolean {
    return contractScaffolds.keys().some(k => k.endsWith(`\0${digest}`)) || zkProviderBundles.keys().some(k => k.endsWith(`|${digest}`));
}

/** Evicted from a cache: drop the snapshot unless a job or the other cache still uses the generation. */
export function onGenerationEvicted(digest: string): void {
    if (digest) sweepGenerationIfUnused(digest);
}

export function sweepGenerationIfUnused(digest: string): void {
    if (!digest || generationRefs.has(digest) || generationCached(digest)) return;
    const dir = path.join(artifactSnapshotRoot(), digest);
    verifiedSnapshots.delete(digest);
    try {
        if (fs.existsSync(dir)) {
            releaseSnapshotHold(dir);
            const others = otherLiveHolders(dir);
            if (others.length > 0) {
                log('info', `artifact snapshot ${digest.slice(0, 16)}… released here; kept for ${others.length} other live process(es)`);
                return;
            }
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

/** Zk asset path for a job: the pinned snapshot, or the registration dir without a digest. */
export function artifactAssetPath(name: string, registration: ContractRegistration): string {
    return materializeArtifactSnapshot(name, registration)?.zkConfigPath ?? registration.zkConfigPath;
}

/** Refuses a contract whose files no longer hash to the pinned generation. */
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
 * Generation-pinned import. ESM caches per URL (`?gen=` gives a fresh instance); CommonJS
 * caches by filename regardless of the query, so its require.cache entry is dropped first.
 */
export async function importArtifactGeneration(artifactPath: string, generation: string): Promise<any> {
    if (!path.isAbsolute(artifactPath)) return import(artifactPath);
    try { delete require.cache[require.resolve(artifactPath)]; } catch { /* ESM-only path */ }
    const url = pathToFileURL(artifactPath);
    if (generation) url.searchParams.set('gen', generation.slice(0, 32));
    return import(url.href);
}
