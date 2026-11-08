// The integrity manifest compactc writes next to keys/ and zkir/. midnight-js verifies every key and zkir against it before proving.
// SPDX-License-Identifier: Apache-2.0

import fs from 'node:fs';
import path from 'node:path';

export const ZK_ARTIFACT_MANIFEST_DIR = 'compiler';
export const ZK_ARTIFACT_MANIFEST_FILE = 'contract-manifest.json';

export function zkArtifactManifestPath(zkConfigPath: string): string {
    return path.join(zkConfigPath, ZK_ARTIFACT_MANIFEST_DIR, ZK_ARTIFACT_MANIFEST_FILE);
}

export function hasZkArtifactManifest(zkConfigPath: string): boolean {
    try { return fs.statSync(zkArtifactManifestPath(zkConfigPath)).isFile(); } catch { return false; }
}

/** Why a zk directory cannot be proved from; null when it can. */
export function zkArtifactManifestProblem(zkConfigPath: string): string | null {
    return hasZkArtifactManifest(zkConfigPath)
        ? null
        : `zkConfigPath has no ${ZK_ARTIFACT_MANIFEST_DIR}/${ZK_ARTIFACT_MANIFEST_FILE} (compactc writes it; proving verifies every key against it): ${zkConfigPath}`;
}
