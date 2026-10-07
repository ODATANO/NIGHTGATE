/**
 * Imports a compiled contract module pinned to one build.
 * This module does not import `@sap/cds`, because the decode worker loads it too.
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** file:// URL with the digest in the query. Node caches ESM per URL, so each build loads as its own module. */
export function artifactImportSpec(artifactPath: string, generation: string): string {
    if (!path.isAbsolute(artifactPath)) return artifactPath;
    const url = pathToFileURL(artifactPath);
    url.searchParams.set('gen', generation.slice(0, 32));
    return url.href;
}

/**
 * Imports the module of one specific build. Node caches CommonJS by file name and
 * ignores the query, so the CommonJS cache entry is removed first.
 */
export async function importArtifactGeneration(artifactPath: string, generation: string): Promise<unknown> {
    if (path.isAbsolute(artifactPath)) {
        try {
            const resolved = require.resolve(artifactPath);
            delete require.cache[resolved];
        } catch { /* not a CommonJS module, fine for ESM */ }
    }
    return import(artifactImportSpec(artifactPath, generation));
}

/** Without a digest the module is imported as is, which suits a fixture or a probe. */
export function importArtifact(artifactPath: string, generation?: string): Promise<unknown> {
    if (generation) return importArtifactGeneration(artifactPath, generation);
    return import(path.isAbsolute(artifactPath) ? pathToFileURL(artifactPath).href : artifactPath);
}
