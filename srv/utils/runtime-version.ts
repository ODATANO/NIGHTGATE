// Why a lineage package cannot run on the compact-runtime `installed` (its contract.json names another
// major.minor); null when it can or says nothing. No imports: the builder and the server registry share it.
export function runtimeVersionProblem(manifest: { compactRuntime?: unknown } | undefined, installed: string): string | null {
    const expected = manifest?.compactRuntime;
    if (typeof expected !== 'string' || !expected) return null;
    const minor = (v: string): string => v.split('-')[0].split('.').slice(0, 2).join('.');
    if (minor(expected) === minor(installed)) return null;
    return `was compiled for compact-runtime ${expected}, this runtime is ${installed}: rebuild the package with the matching compiler, or run the NIGHTGATE release of that runtime`;
}
