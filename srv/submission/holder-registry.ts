/**
 * Reads the holder-registry contract. A token holder registers a claim key there.
 * Whoever shows the secret behind that key proves to this server that they hold the token.
 * Decoding the state runs in wasm, so this module does not import `@sap/cds` and runs in the decode worker.
 * SPDX-License-Identifier: Apache-2.0
 */
import { holderClaimKey, holderEntry as kitHolderEntry, hexToBytes32 } from '@odatano/contract-kit';
import { importArtifact } from './artifact-import';
import { buildPublicDataProvider } from '../midnight/public-data-provider';
import type { ContractArtifact } from './predicate-state';

export const HOLDER_REGISTRY_REF = 'holder-registry';
export { holderClaimKey };

export interface HolderRegistryLedger {
    holders: { member(key: Uint8Array): boolean };
}

/** The registry entry for a token type and claim key, computed by the contract's own code. */
export function holderEntry(artifact: Pick<ContractArtifact<unknown>, 'pureCircuits'>, tokenTypeHex: string, claimKeyHex: string): string {
    return kitHolderEntry(artifact.pureCircuits as Parameters<typeof kitHolderEntry>[0], tokenTypeHex, claimKeyHex);
}

export interface HolderRegistrationQuery {
    contractAddress: string;
    tokenType: string;
    claimKey: string;
    artifactPath: string;
    /** Build of the artifact to load. Without it the module at `artifactPath` is imported as is. */
    artifactDigest?: string;
    contractProvidersConfig: import('../midnight/providers').ContractProvidersConfig;
}

export interface HolderRegistration {
    registered: boolean;
    entry: string;
}

/** Null when the contract has no state yet. */
export async function readHolderRegistration(q: HolderRegistrationQuery): Promise<HolderRegistration | null> {
    const publicData = await buildPublicDataProvider(q.contractProvidersConfig);
    const artifact = await importArtifact(q.artifactPath, q.artifactDigest) as ContractArtifact<HolderRegistryLedger>;
    const state = await publicData.queryContractState(q.contractAddress);
    if (!state) return null;
    const entry = holderEntry(artifact, q.tokenType, q.claimKey);
    const led = artifact.ledger(state.data ?? state);
    return { registered: led.holders.member(hexToBytes32(entry)) === true, entry };
}
