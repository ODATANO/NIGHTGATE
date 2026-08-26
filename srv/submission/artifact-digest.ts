/**
 * Artifact generation digest: one SHA-256 over the Compact-emitted module, the
 * private-state id, a non-default slot width, every prover/verifier key and
 * every zkir file. Dependency-free (fs, path, crypto): the registry computes it
 * on the main thread, the wallet worker recomputes it from the files it loads.
 * The byte layout is fixed; recorded digests must keep matching (slot width 16 === absent).
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
 * `legacyModuleFormat`: the pre-0.21 digest without the module-format section.
 * Only a CommonJS artifact differs; ESM forms are byte-identical. Keeps 0.20
 * jobs and evidence on unchanged CommonJS artifacts acceptable.
 */
export function computeArtifactGenerationDigest(reg: ArtifactGenerationInput, opts: { legacyModuleFormat?: boolean } = {}): string {
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
            files = fs.readdirSync(dir).filter(filter).sort();
        } catch { /* asset-less artifacts (pure-circuit-only) skip the section */ }
        for (const f of files) section(`${sub}/${f}`, fs.readFileSync(path.join(dir, f)));
    };
    assetDir('keys', (f) => f.endsWith('.verifier') || f.endsWith('.prover'));
    assetDir('zkir', () => true);
    return hash.digest('hex');
}

/** Whether a recorded digest names this registration's generation. */
export function artifactGenerationMatch(reg: ArtifactGenerationInput, recorded: string | undefined | null): 'current' | 'legacy' | null {
    if (!recorded) return null;
    const current = computeArtifactGenerationDigest(reg);
    if (recorded === current) return 'current';
    if (effectiveModuleFormat(reg.artifactPath) === 'commonjs' && recorded === computeArtifactGenerationDigest(reg, { legacyModuleFormat: true })) return 'legacy';
    return null;
}
