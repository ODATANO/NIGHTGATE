/**
 * Digest of a compiled contract build and checks of its prover key list.
 * The code lives in `@odatano/contract-kit/node`. It has no dependencies,
 * so the worker thread and the contracts repository compute the same digest.
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
