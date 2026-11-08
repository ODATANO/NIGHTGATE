// Proves in this process instead of on a proof server, under NIGHTGATE_PROVING_MODE=wasm.
// Keys come from the contract's files, or from the SDK for standard circuits. Proving blocks the thread.

import type { KeyMaterialProvider } from '@midnightntwrk/zkir-v2';
import type { ProofProvider, ZKConfigProvider } from '@midnight-ntwrk/midnight-js-types';
import type * as MidnightJsTypes from '@midnight-ntwrk/midnight-js-types';
import type * as CompactJs from '@midnight-ntwrk/compact-js';

/** Supplies the standard circuits' keys and the BLS parameters, as the SDK's `makeDefaultKeyMaterialProvider` does. */
export type StandardKeyMaterialProvider = KeyMaterialProvider;

interface WasmProofDeps {
    zkir: Pick<typeof import('@midnightntwrk/zkir-v2'), 'provingProvider'>;
    zkirV3: Pick<typeof import('@midnightntwrk/zkir-v3'), 'provingProvider'>;
    createLedger9ProofProvider: typeof MidnightJsTypes.createLedger9ProofProvider;
    zkConfigToProvingKeyMaterial: typeof MidnightJsTypes.zkConfigToProvingKeyMaterial;
    parseContractKeyLocation: typeof CompactJs.parseContractKeyLocation;
    hashVerifierKey: typeof CompactJs.hashVerifierKey;
    fallbackKeys: StandardKeyMaterialProvider;
}

const ZKIR_V3_HEADER = 'midnight:ir-source[v3';

let cachedDeps: Promise<WasmProofDeps> | undefined;

async function loadDeps(): Promise<WasmProofDeps> {
    if (!cachedDeps) {
        cachedDeps = (async () => {
            const [zkir, zkirV3, mjsTypes, proverEffect, compactJs] = await Promise.all([
                import('@midnightntwrk/zkir-v2'),
                import('@midnightntwrk/zkir-v3'),
                import('@midnight-ntwrk/midnight-js-types'),
                import('@midnightntwrk/wallet-sdk-prover-client/effect'),
                import('@midnight-ntwrk/compact-js')
            ]);
            return {
                zkir,
                zkirV3,
                createLedger9ProofProvider: mjsTypes.createLedger9ProofProvider,
                zkConfigToProvingKeyMaterial: mjsTypes.zkConfigToProvingKeyMaterial,
                parseContractKeyLocation: compactJs.parseContractKeyLocation,
                hashVerifierKey: compactJs.hashVerifierKey,
                fallbackKeys: proverEffect.WasmProver.makeV9KeyMaterialProvider()
            };
        })();
        // Forget a failed import so the next call tries again.
        cachedDeps.catch(() => { cachedDeps = undefined; });
    }
    return cachedDeps;
}

/** Key provider for the standard circuits, shared so wallet and contract proving use one download cache. */
export async function getSharedKeyMaterialProvider(): Promise<StandardKeyMaterialProvider> {
    return (await loadDeps()).fallbackKeys;
}

import { runtimeConfigEnum } from './runtime-config';
import { errorMessage } from '../utils/errors';

/** Uses runtime-config because this file also ships in the nightgate-tx package, which has no server config. */
export function isWasmProvingMode(): boolean {
    return runtimeConfigEnum('NIGHTGATE_PROVING_MODE') === 'wasm';
}

/** Drop-in for `httpClientProofProvider(url, zkConfigProvider)` without a proof server.
 *  `standardKeys` replaces the SDK's download-per-process provider for the standard circuits and parameters. */
export async function buildWasmProofProvider(zkConfigProvider: Pick<ZKConfigProvider<string>, 'get'>, standardKeys?: StandardKeyMaterialProvider): Promise<ProofProvider> {
    const deps = await loadDeps();
    const { zkir, zkirV3, createLedger9ProofProvider, zkConfigToProvingKeyMaterial, parseContractKeyLocation, hashVerifierKey } = deps;
    const fallbackKeys = standardKeys ?? deps.fallbackKeys;

    const keyMaterialProvider: KeyMaterialProvider = {
        lookupKey: async (keyLocation: string) => {
            // A contract call names its key as contract:<address>/<circuit>?vk=<hash of the deployed verifier key>.
            const location = parseContractKeyLocation?.(keyLocation);
            if (location) {
                const zkConfig = await zkConfigProvider.get(location.circuitId);
                const localHash = hashVerifierKey(zkConfig.verifierKey);
                if (localHash !== location.verifierKeyHash) {
                    throw new Error(
                        `The keys of circuit '${location.circuitId}' do not match contract ${location.contractAddress}: ` +
                        `local verifier key ${localHash}, deployed ${location.verifierKeyHash}`
                    );
                }
                return zkConfigToProvingKeyMaterial(zkConfig);
            }
            let zkConfigError: unknown;
            try {
                return zkConfigToProvingKeyMaterial(await zkConfigProvider.get(keyLocation));
            } catch (err) {
                // Normal for standard circuits. Kept so the error can name it if the fallback fails too.
                zkConfigError = err;
            }
            const material = await fallbackKeys.lookupKey(keyLocation);
            if (material === undefined) {
                const cause = errorMessage(zkConfigError);
                throw new Error(
                    `No proving key material for '${keyLocation}': not in the contract's zkConfig ` +
                    `(${cause}) and not a standard circuit the fallback provider knows`
                );
            }
            return material;
        },
        getParams: (k: number) => fallbackKeys.getParams(k)
    };

    // The ledger also asks the proving provider itself for key material.
    const v2Provider = zkir.provingProvider(keyMaterialProvider);
    const v3Provider = zkirV3.provingProvider(keyMaterialProvider);
    // Compiled contracts carry zkir v3 and the ledger's standard circuits v2. Neither runtime reads the other's files.
    const providerFor = async (keyLocation: string) => {
        const material = await keyMaterialProvider.lookupKey(keyLocation);
        const header = material ? new TextDecoder().decode(material.ir.subarray(0, ZKIR_V3_HEADER.length)) : '';
        return header === ZKIR_V3_HEADER ? v3Provider : v2Provider;
    };
    return createLedger9ProofProvider({
        check: async (preimage: Uint8Array, keyLocation: string) => (await providerFor(keyLocation)).check(preimage, keyLocation),
        prove: async (preimage: Uint8Array, keyLocation: string, bindingInput?: bigint) => (await providerFor(keyLocation)).prove(preimage, keyLocation, bindingInput),
        lookupKey: keyMaterialProvider.lookupKey
    });
}
