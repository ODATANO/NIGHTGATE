/**
 * Reads the holder-registry contract. A token holder registers a claim key there.
 * Whoever shows the secret behind that key proves to this server that they hold the token.
 * SPDX-License-Identifier: Apache-2.0
 */
import { holderClaimKey, holderEntry as kitHolderEntry, hexToBytes32 } from '@odatano/contract-kit';
import { importArtifactByPath } from './contract-registry';

export const HOLDER_REGISTRY_REF = 'holder-registry';
export { holderClaimKey };

/** The registry entry for a token type and claim key, computed by the contract's own code. */
export function holderEntry(artifact: any, tokenTypeHex: string, claimKeyHex: string): string {
    return kitHolderEntry(artifact.pureCircuits, tokenTypeHex, claimKeyHex);
}

export interface HolderRegistrationQuery {
    contractAddress: string;
    tokenType: string;
    claimKey: string;
    artifactPath: string;
    contractProvidersConfig: import('../midnight/providers').ContractProvidersConfig;
}

/** Null when the contract has no state yet. */
export async function readHolderRegistration(q: HolderRegistrationQuery): Promise<{ registered: boolean; entry: string } | null> {
    const { buildContractProviders } = await import('../midnight/providers.js');
    const bundle = await buildContractProviders(q.contractProvidersConfig);
    const artifact: any = await importArtifactByPath(q.artifactPath);
    const state = await bundle.publicDataProvider.queryContractState(q.contractAddress);
    if (!state) return null;
    const entry = holderEntry(artifact, q.tokenType, q.claimKey);
    const led: any = artifact.ledger(state.data ?? state);
    return { registered: led.holders.member(hexToBytes32(entry)) === true, entry };
}
