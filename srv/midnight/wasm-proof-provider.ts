/**
 * Proof provider that proves in this process instead of on a proof server (NIGHTGATE_PROVING_MODE=wasm).
 * Keys come from the contract's files, or from the SDK for the standard circuits.
 * Proving blocks the calling thread.
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
        // Forget a failed import so the next call tries again.
        cachedDeps.catch(() => { cachedDeps = undefined; });
    }
    return cachedDeps;
}

/** Key provider for the standard circuits, shared so wallet and contract proving use one download cache. */
export async function getSharedKeyMaterialProvider(): Promise<{ lookupKey(loc: string): Promise<any>; getParams(k: number): Promise<Uint8Array> }> {
    return (await loadDeps()).fallbackKeys;
}

import { runtimeConfigEnum } from './runtime-config';

/** Uses runtime-config because this file also ships in the nightgate-tx package, which has no server config. */
export function isWasmProvingMode(): boolean {
    return runtimeConfigEnum('NIGHTGATE_PROVING_MODE') === 'wasm';
}

/** Drop-in for `httpClientProofProvider(url, zkConfigProvider)` without a proof server. */
export async function buildWasmProofProvider(zkConfigProvider: any): Promise<{ proveTx: (unprovenTx: any) => Promise<any> }> {
    const { zkir, ledger, zkConfigToProvingKeyMaterial, fallbackKeys } = await loadDeps();

    const keyMaterialProvider = {
        lookupKey: async (keyLocation: string) => {
            let zkConfigError: unknown;
            try {
                return zkConfigToProvingKeyMaterial(await zkConfigProvider.get(keyLocation));
            } catch (err) {
                // Normal for standard circuits. Kept so the error can name it if the fallback fails too.
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
