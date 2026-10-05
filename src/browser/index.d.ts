/** `@odatano/nightgate/browser`, the entry point for browser apps. See index.mjs. */


export {
    deriveAttestationSecret,
    generateAttestationSecret,
    sealAttestationSecret,
    openAttestationSecret,
    buildAttestationVaultWitnesses,
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

/** Loads a contract's proving files over HTTP from `/zk-config/<contract>`. */
export class FetchZkConfigProvider {
    constructor(baseUrl: string, fetchFn?: typeof fetch);
    getProverKey(circuitId: string): Promise<Uint8Array>;
    getVerifierKey(circuitId: string): Promise<Uint8Array>;
    getZKIR(circuitId: string): Promise<Uint8Array>;
    getVerifierKeys(circuitIds: string[]): Promise<[string, Uint8Array][]>;
    get(circuitId: string): Promise<unknown>;
    asKeyMaterialProvider(): {
        getZKIR(loc: string): Promise<Uint8Array>;
        getProverKey(loc: string): Promise<Uint8Array>;
        getVerifierKey(loc: string): Promise<Uint8Array>;
    };
}

/** Keeps contract private state in memory. The vault contract has no private state. */
export class InMemoryPrivateStateProvider {
    setContractAddress(address: unknown): void;
    set(id: unknown, state: unknown): Promise<void>;
    get(id: unknown): Promise<unknown | null>;
    remove(id: unknown): Promise<void>;
    clear(): Promise<void>;
    setSigningKey(address: unknown, key: unknown): Promise<void>;
    getSigningKey(address: unknown): Promise<unknown | null>;
    removeSigningKey(address: unknown): Promise<void>;
    clearSigningKeys(): Promise<void>;
    exportPrivateStates(): Promise<unknown>;
    importPrivateStates(): Promise<unknown>;
    exportSigningKeys(): Promise<unknown>;
    importSigningKeys(): Promise<unknown>;
}

/**
 * Where proofs are made.
 *   'server' - on the proof server the wallet reports. This is the default.
 *   'wallet' - in the wallet. Throws if the wallet cannot prove.
 *   'auto'   - in the wallet if it can prove, else on the server.
 */
export type ProvingModality = 'server' | 'wallet' | 'auto';

export interface ConnectorProvidersResult {
    publicDataProvider: unknown;
    zkConfigProvider: FetchZkConfigProvider;
    proofProvider: unknown | undefined;
    /** Where proofs are actually made. Log it, because it says where the private inputs go. */
    provingModality: 'server' | 'wallet' | 'none';
    privateStateProvider: InMemoryPrivateStateProvider;
    connector: unknown;
    config: { indexerUri: string; indexerWsUri: string; substrateNodeUri: string; networkId: string; proverServerUri?: string };
    walletKeys: { coinPublicKey?: string; encryptionPublicKey?: string; shieldedAddress?: string };
    zkConfigBaseUrl: string;
    keyMaterialProvider(): { getZKIR(l: string): Promise<Uint8Array>; getProverKey(l: string): Promise<Uint8Array>; getVerifierKey(l: string): Promise<Uint8Array> };
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
}): Promise<ConnectorProvidersResult>;

/** Creates only the proof provider, for apps that set up the other providers themselves. */
export function buildProofProvider(input: {
    proving?: ProvingModality;
    connector: any;
    zkConfigProvider: FetchZkConfigProvider;
    proverServerUri?: string;
    proofMod: any;
}): Promise<{ proofProvider: unknown | undefined; provingModality: 'server' | 'wallet' | 'none' }>;

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
