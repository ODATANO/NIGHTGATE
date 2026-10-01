/**
 * Artifact generation digest and key-manifest checks; the implementation
 * lives in `@odatano/contract-kit/node` (dependency-free, so the worker
 * thread and the contracts repository compute the same bytes).
 */
export {
    computeArtifactGenerationDigest,
    artifactGenerationMatch,
    artifactSlotWidth,
    effectiveModuleFormat,
    runtimeNodeModulesDir,
    isArtifactAssetFile,
    proverKeyManifestProblems,
    PROVER_KEY_MANIFEST_FILE,
    type ArtifactGenerationInput,
    type DigestFormOptions,
    type ModuleFormat
} from '@odatano/contract-kit/node';
