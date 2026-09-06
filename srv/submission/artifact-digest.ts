/**
 * Artifact generation digest: one SHA-256 over the Compact-emitted module, the
 * private-state id, a non-default slot width, every verifier key, every zkir
 * file and the prover keys: as the prover key manifest (`keys/manifest.json`,
 * sha256 per key) where the artifact ships one, so the keys can be fetched on
 * first need without changing the generation, and as the key bytes themselves
 * for an artifact without a manifest (a consumer's own compile).
 * Dependency-free (fs, path, crypto): the registry computes it on the main
 * thread, the wallet worker recomputes it from the files it loads.
 * The byte layout is fixed; recorded digests must keep matching (slot width 16 === absent).
 * Digests recorded before 0.23.0 hashed the prover keys and knew no manifest;
 * `artifactGenerationMatch` still accepts that form as 'legacy'.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export interface ArtifactGenerationInput {
    artifactPath: string;
    privateStateId: string;
    zkConfigPath: string;
    slotWidth?: number;
}

export function artifactSlotWidth(reg: Pick<ArtifactGenerationInput, 'slotWidth'> | undefined): number {
    const w = reg?.slotWidth;
    return Number.isInteger(w) && (w as number) > 0 ? (w as number) : 16;
}

export type ModuleFormat = 'module' | 'commonjs';

/**
 * How Node loads the artifact: by extension for `.mjs`/`.cjs`, for `.js` by the
 * nearest package.json `"type"` walking up from the file (absent = commonjs).
 * The format is part of the generation digest and selects the snapshot's file extension.
 */
export function effectiveModuleFormat(artifactPath: string): ModuleFormat {
    const ext = path.extname(artifactPath).toLowerCase();
    if (ext === '.mjs') return 'module';
    if (ext === '.cjs') return 'commonjs';
    let dir = path.dirname(path.resolve(artifactPath));
    for (; ;) {
        const pkg = path.join(dir, 'package.json');
        if (fs.existsSync(pkg)) {
            try {
                const type = JSON.parse(fs.readFileSync(pkg, 'utf8'))?.type;
                return type === 'module' ? 'module' : 'commonjs';
            } catch {
                return 'commonjs';
            }
        }
        const parent = path.dirname(dir);
        if (parent === dir) return 'commonjs';
        dir = parent;
    }
}

/**
 * The node_modules directory this process resolves `@midnight-ntwrk/compact-runtime`
 * from. A snapshot or probe directory links its own `node_modules` here, so a
 * Compact-emitted module imports the pinned runtime from wherever it was copied
 * (a consumer's artifact directory needs no node_modules of its own).
 */
export function runtimeNodeModulesDir(): string {
    const resolved = require.resolve('@midnight-ntwrk/compact-runtime');
    const idx = resolved.lastIndexOf(`${path.sep}node_modules${path.sep}`);
    if (idx < 0) throw new Error(`cannot locate the node_modules directory of @midnight-ntwrk/compact-runtime (resolved to ${resolved})`);
    return resolved.slice(0, idx + `${path.sep}node_modules`.length);
}

export interface DigestFormOptions {
    /**
     * The pre-0.21 digest without the module-format section. Only a CommonJS
     * artifact differs; ESM forms are byte-identical. Keeps 0.20 jobs and
     * evidence on unchanged CommonJS artifacts acceptable.
     */
    legacyModuleFormat?: boolean;
    /** The pre-0.23 form: prover keys hashed, no manifest section. */
    legacyProverKeys?: boolean;
}

export const PROVER_KEY_MANIFEST_FILE = 'manifest.json';

/**
 * Files an editor, a file manager or a copy tool leaves next to the assets.
 * They are not part of the artifact: two checkouts of the same generation
 * must hash the same with or without them.
 */
const STRAY_FILE_RE = /^(\.DS_Store|Thumbs\.db|desktop\.ini|\.#.*|\._.*)$|~$|\.(swp|swo|bak|orig|tmp)$/i;

/** A regular file that belongs to the artifact: not a directory, not a stray file. */
export function isArtifactAssetFile(dir: string, name: string): boolean {
    if (STRAY_FILE_RE.test(name)) return false;
    try { return fs.statSync(path.join(dir, name)).isFile(); } catch { return false; }
}

export function computeArtifactGenerationDigest(reg: ArtifactGenerationInput, opts: DigestFormOptions = {}): string {
    const hash = crypto.createHash('sha256');
    const section = (label: string, data: Buffer | string) => {
        const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
        hash.update(`${label}:${buf.length}\n`);
        hash.update(buf);
    };
    section('module', fs.readFileSync(reg.artifactPath));
    section('privateStateId', reg.privateStateId);
    if (artifactSlotWidth(reg) !== 16) section('slotWidth', String(artifactSlotWidth(reg)));
    if (!opts.legacyModuleFormat && effectiveModuleFormat(reg.artifactPath) === 'commonjs') section('moduleFormat', 'commonjs');
    const assetDir = (sub: string, filter: (f: string) => boolean) => {
        const dir = path.join(reg.zkConfigPath, sub);
        let files: string[] = [];
        try {
            files = fs.readdirSync(dir).filter(f => filter(f) && isArtifactAssetFile(dir, f)).sort();
        } catch { /* asset-less artifacts (pure-circuit-only) skip the section */ }
        for (const f of files) section(`${sub}/${f}`, fs.readFileSync(path.join(dir, f)));
    };
    const hasManifest = !opts.legacyProverKeys && fs.existsSync(path.join(reg.zkConfigPath, 'keys', PROVER_KEY_MANIFEST_FILE));
    assetDir('keys', (f) => f.endsWith('.verifier') || (hasManifest ? f === PROVER_KEY_MANIFEST_FILE : f.endsWith('.prover')));
    assetDir('zkir', () => true);
    return hash.digest('hex');
}

/**
 * Prover keys present under `keysDir` checked against its manifest: sha256
 * and size per key. Empty when there is no manifest (the digest then covers
 * the key bytes directly) or everything matches. The worker runs this on a
 * snapshot before proving from it, since the digest pins the manifest, not
 * the keys.
 */
export function proverKeyManifestProblems(keysDir: string): string[] {
    let manifest: { prover?: Record<string, { sha256?: string; bytes?: number }> };
    try {
        manifest = JSON.parse(fs.readFileSync(path.join(keysDir, PROVER_KEY_MANIFEST_FILE), 'utf8'));
    } catch {
        return [];
    }
    const problems: string[] = [];
    for (const f of fs.readdirSync(keysDir).filter(f => f.endsWith('.prover')).sort()) {
        const circuit = f.replace(/\.prover$/, '');
        const entry = manifest.prover?.[circuit];
        if (!entry) { problems.push(`${circuit}: not listed in the manifest`); continue; }
        const body = fs.readFileSync(path.join(keysDir, f));
        const sha256 = crypto.createHash('sha256').update(body).digest('hex');
        if (entry.sha256 !== sha256 || entry.bytes !== body.length) problems.push(`${circuit}: ${body.length} bytes, sha256 ${sha256.slice(0, 16)}… (manifest: ${entry.bytes} bytes, ${String(entry.sha256).slice(0, 16)}…)`);
    }
    return problems;
}

/**
 * Whether a recorded digest names this registration's generation. The legacy
 * forms (prover keys hashed, CommonJS without the format section) are tried
 * only after the current form failed, since hashing the prover keys reads a
 * hundred megabytes.
 */
export function artifactGenerationMatch(reg: ArtifactGenerationInput, recorded: string | undefined | null): 'current' | 'legacy' | null {
    if (!recorded) return null;
    const current = computeArtifactGenerationDigest(reg);
    if (recorded === current) return 'current';
    const forms: DigestFormOptions[] = [{ legacyProverKeys: true }];
    if (effectiveModuleFormat(reg.artifactPath) === 'commonjs') forms.push({ legacyModuleFormat: true }, { legacyModuleFormat: true, legacyProverKeys: true });
    for (const form of forms) if (recorded === computeArtifactGenerationDigest(reg, form)) return 'legacy';
    return null;
}
