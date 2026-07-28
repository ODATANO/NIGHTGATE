// Minimal compiled-artifact stand-in for wallet-worker dispatch tests:
// getContractScaffold() dynamic-imports the artifactPath and picks up the
// `Contract` export; nothing else from a real managed/ artifact is needed
// because CompiledContract is mocked at the import seam.
export class Contract {
    constructor(witnesses) {
        this.witnesses = witnesses;
    }
}
