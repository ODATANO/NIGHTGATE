/** `@odatano/nightgate/browser`, the entry point for browser apps. See index.mjs. */


export {
    deriveAttestationSecret,
    generateAttestationSecret,
    sealAttestationSecret,
    openAttestationSecret,
    buildAttestationVaultWitnesses,
    InMemoryPrivateStateProvider,
    type InMemoryContractPrivateStates,
    type SealedAttestationSecret,
    type MerkleProof,
    type SchemaDescriptor,
    type SlotOpening,
    type DocumentOpening,
    type DocPair,
    type MerkleProofHolder,
    type BuildWitnessesInput,
    type AttestationVaultWitnesses
} from '@odatano/contract-kit';

import {
    FetchZkConfigProvider as MidnightFetchZkConfigProvider,
    type FetchZkConfigProviderOptions
} from '@midnight-ntwrk/midnight-js-fetch-zk-config-provider';
import type { ZKConfigRegistry } from '@midnight-ntwrk/midnight-js-types';

/** Loads a contract's proving files over HTTP from `/zk-config/<contract>` and checks each against the compiler's manifest there. */
export class FetchZkConfigProvider extends MidnightFetchZkConfigProvider<string> {
    /** `baseUrl` is absolute. `fetchFn` defaults to the platform's fetch. */
    constructor(baseUrl: string, fetchFn?: typeof fetch, options?: Omit<FetchZkConfigProviderOptions, 'fetchFunc'>);
}

import type { InMemoryPrivateStateProvider } from '@odatano/contract-kit';
import type { ProvingModality, AssembledProvingModality } from './providers.mjs';
export type { ProvingModality, AssembledProvingModality };

export interface ConnectorProvidersResult {
    publicDataProvider: unknown;
    zkConfigProvider: FetchZkConfigProvider;
    proofProvider: unknown | undefined;
    /** Where proofs are actually made. Log it, because it says where the private inputs go. */
    provingModality: AssembledProvingModality;
    privateStateProvider: InMemoryPrivateStateProvider;
    connector: unknown;
    config: { indexerUri: string; indexerWsUri: string; substrateNodeUri: string; networkId: string; proverServerUri?: string };
    walletKeys: { coinPublicKey?: string; encryptionPublicKey?: string; shieldedAddress?: string };
    zkConfigBaseUrl: string;
    keyMaterialProvider(): ReturnType<ZKConfigRegistry['asKeyMaterialProvider']>;
}

export function createNightgateConnectorProviders(opts: {
    connector: any;
    manifest: { contracts: Array<{ name: string; zkConfigBaseUrl: string; circuits: string[] }> };
    /** The URL the manifest was loaded from. Needed when the manifest has relative URLs and the app runs on another origin. */
    manifestUrl?: string;
    contract: string;
    fetchFn?: typeof fetch;
    webSocket?: any;
    proving?: ProvingModality;
    expectedManifestHash?: string; // SHA-256 as 64 hex; optional; the compiler manifest the served files must match
}): Promise<ConnectorProvidersResult>;

/** Creates only the proof provider, for apps that set up the other providers themselves. */
export function buildProofProvider(input: {
    proving?: ProvingModality;
    connector: any;
    zkConfigProvider: MidnightFetchZkConfigProvider<string> | ZKConfigRegistry;
    proverServerUri?: string;
    proofMod: any;
}): Promise<{ proofProvider: unknown | undefined; provingModality: AssembledProvingModality }>;

export {
    type PreparedCall,
    DEFAULT_CLAIM_LIFETIME_S,
    prepareRevokeDisclosure,
    prepareGrantDisclosure,
    prepareAttest,
    recordKeyOf,
    prepareRegisterDocument,
    prepareRegisterPassport,
    prepareBindDocument,
    prepareBindPassport,
    prepareRetract,
    prepareRetractAttestation,
    preparePurgeExpired,
    prepareAnchorContentRoot,
    prepareProveFieldPredicate,
    prepareProveFieldEquality,
    prepareProveFieldMembership,
    prepareProveFieldsUnchangedExcept,
    prepareProveFieldsDiffer
} from '@odatano/contract-kit';

export interface ContractBrowserMeta {
    name: string;
    artifactSubpath: string;
    circuits: string[];
    /** Circuits that need the attester's secret key. */
    attesterGated: string[];
    /** Circuits that need the document's Merkle proof data. */
    merkleWitnessed?: string[];
    hasPrivateState: boolean;
    /** Provable fields per document. 16, or 32 for attestation-vault-32. */
    slotWidth: number;
    /** Depth of the document's Merkle tree, log2(slotWidth). */
    merkleDepth: number;
}

export const CONTRACTS: Record<string, ContractBrowserMeta>;

/** Makes a manifest URL absolute, using manifestUrl or else the page's origin. */
export function resolveManifestUrl(url: string, manifestUrl?: string): string;
