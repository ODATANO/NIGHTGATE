/**
 * In-process ProofProvider for contract circuits (NIGHTGATE_PROVING_MODE=wasm).
 *
 * midnight-js's httpClientProofProvider is a thin transport: its proveTx runs
 * `unprovenTx.prove(provingProvider, costModel)` on the LOCAL ledger WASM,
 * which calls back per circuit with (serializedPreimage, keyLocation). The
 * HTTP provider ships those callbacks to the proof server's /check + /prove;
 * zkir-v2 exports the same computation locally (`provingProvider(keys)`), so
 * this module answers them in-process instead:
 *
 *   - contract circuits: key material from the contract's local zkConfig
 *     (managed/keys + zkir via the same zkConfigProvider.get(keyLocation)
 *     lookup the HTTP provider uses to embed material in its payloads)
 *   - standard circuits + BLS params: the wallet SDK's default key-material
 *     provider (Midnight's S3 bucket, in-memory cache per process)
 *
 * CPU note: proving blocks the calling thread for the proof duration. That is
 * acceptable for the dev/test scope of the wasm mode; production stays on the
 * proof server.
 */

interface WasmProofDeps {
    zkir: any;
    ledger: any;
    zkConfigToProvingKeyMaterial: (zkConfig: any) => any;
    fallbackKeys: { lookupKey(loc: string): Promise<any>; getParams(k: number): Promise<Uint8Array> };
}

let cachedDeps: Promise<WasmProofDeps> | undefined;

async function loadDeps(): Promise<WasmProofDeps> {
    if (!cachedDeps) {
        cachedDeps = (async () => {
            const [zkir, ledger, mjsTypes, proverEffect] = await Promise.all([
                import('@midnight-ntwrk/zkir-v2'),
                import('@midnight-ntwrk/ledger-v8'),
                import('@midnight-ntwrk/midnight-js-types'),
                import('@midnightntwrk/wallet-sdk-prover-client/effect')
            ]);
            return {
                zkir,
                ledger,
                zkConfigToProvingKeyMaterial: (mjsTypes as any).zkConfigToProvingKeyMaterial,
                fallbackKeys: (proverEffect as any).WasmProver.makeDefaultKeyMaterialProvider()
            };
        })();
        // A failed import must not poison the process; let the next call retry.
        cachedDeps.catch(() => { cachedDeps = undefined; });
    }
    return cachedDeps;
}

/**
 * The process-wide standard-circuit key-material provider (S3-backed, with the
 * SDK's in-memory cache). Shared so wallet proving and contract proving reuse
 * ONE download cache instead of re-fetching keys per wallet session.
 */
export async function getSharedKeyMaterialProvider(): Promise<{ lookupKey(loc: string): Promise<any>; getParams(k: number): Promise<Uint8Array> }> {
    return (await loadDeps()).fallbackKeys;
}

/** True when NIGHTGATE_PROVING_MODE selects in-process WASM proving. */
export function isWasmProvingMode(): boolean {
    return (process.env.NIGHTGATE_PROVING_MODE || 'server').trim().toLowerCase() === 'wasm';
}

/**
 * Drop-in replacement for `httpClientProofProvider(url, zkConfigProvider)`:
 * same `{ proveTx }` contract, no proof server involved.
 */
export async function buildWasmProofProvider(zkConfigProvider: any): Promise<{ proveTx: (unprovenTx: any) => Promise<any> }> {
    const { zkir, ledger, zkConfigToProvingKeyMaterial, fallbackKeys } = await loadDeps();

    const keyMaterialProvider = {
        lookupKey: async (keyLocation: string) => {
            let zkConfigError: unknown;
            try {
                return zkConfigToProvingKeyMaterial(await zkConfigProvider.get(keyLocation));
            } catch (err) {
                // Expected for zswap/dust standard circuits (not in the
                // contract's zkConfig); resolve those like the wallet prover.
                // Kept in case it was a REAL zkConfig failure and the fallback
                // misses too, so the thrown error names the actual cause.
                zkConfigError = err;
            }
            const material = await fallbackKeys.lookupKey(keyLocation);
            if (material === undefined) {
                const cause = zkConfigError instanceof Error ? zkConfigError.message : String(zkConfigError);
                throw new Error(
                    `No proving key material for '${keyLocation}': not in the contract's zkConfig ` +
                    `(${cause}) and not a standard circuit the fallback provider knows`
                );
            }
            return material;
        },
        getParams: (k: number) => fallbackKeys.getParams(k)
    };

    const provingProvider = zkir.provingProvider(keyMaterialProvider);
    return {
        proveTx: (unprovenTx: any) => unprovenTx.prove(provingProvider, ledger.CostModel.initialCostModel())
    };
}
