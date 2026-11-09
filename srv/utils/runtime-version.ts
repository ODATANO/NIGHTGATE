const minor = (v: string): string => v.split('-')[0].split('.').slice(0, 2).join('.');

// The runtime of the ledger 8 compiler. midnight-js calls a contract built with it through its own ledger 8 path.
export function isLedger8Runtime(version: unknown): boolean {
    return typeof version === 'string' && minor(version) === '0.16';
}

// Whether a failed contract lookup means the contract predates ledger 9: it keeps its ledger 8 verifier keys, so a newer artifact cannot match them.
export async function isPreForkKeyMismatch(
    err: unknown,
    ContractTypeError: new (...args: never[]) => unknown,
    publicDataProvider: { watchForDeployTxData(address: string): Promise<{ era?: unknown }> },
    contractAddress: string
): Promise<boolean> {
    if (!(err instanceof ContractTypeError)) return false;
    const deploy = await publicDataProvider.watchForDeployTxData(contractAddress).catch(() => null);
    return deploy?.era === 'v8';
}

// Why a lineage package cannot run on the compact-runtime `installed` (its contract.json names another
// major.minor); null when it can or says nothing. No imports: the builder and the server registry share it.
export function runtimeVersionProblem(manifest: { compactRuntime?: unknown } | undefined, installed: string): string | null {
    const expected = manifest?.compactRuntime;
    if (typeof expected !== 'string' || !expected) return null;
    if (minor(expected) === minor(installed)) return null;
    return `was compiled for compact-runtime ${expected}, this runtime is ${installed}: rebuild the package with the matching compiler, or run the NIGHTGATE release of that runtime`;
}
