/** `@odatano/nightgate-tx/calls`, the entry point for browser apps. See index.mjs. */


export {
    deriveAttestationSecret,
    generateAttestationSecret,
    sealAttestationSecret,
    openAttestationSecret,
    computeAttesterId,
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

import { FetchZkConfigProvider } from '@midnight-ntwrk/midnight-js-fetch-zk-config-provider';
import type { ProofProvider, ZKConfigProvider, ZKConfigRegistry } from '@midnight-ntwrk/midnight-js-types';
import type {
    DAppConnectorNetworkAPI,
    DAppConnectorProvingAPI,
    DAppConnectorWalletAPI
} from '@midnight-ntwrk/midnight-js-dapp-connector-proof-provider';

/** The class of midnight-js that loads a contract's proving files over HTTP, here from `/zk-config/<contract>`: `new FetchZkConfigProvider(baseUrl, { fetchFunc? })`. */
export { FetchZkConfigProvider };

import type { InMemoryPrivateStateProvider } from '@odatano/contract-kit';
/** Where the proof provider finds a circuit's files: one contract's provider, or a registry of several. */
export type KeyMaterialSource = ZKConfigProvider<string> | ZKConfigRegistry;

/**
 * Where proofs are made.
 *   'server' - on the proof server the wallet reports. This is the default.
 *   'wallet' - in the wallet. Throws if the wallet cannot prove.
 *   'auto'   - in the wallet if it can prove, else on the server.
 */
export type ProvingModality = 'server' | 'wallet' | 'auto';
/** Where proofs end up being made. 'none' when the wallet cannot prove and reports no proof server, so the app can only read. */
export type AssembledProvingModality = 'server' | 'wallet' | 'none';

/** The module that makes a proof provider for a proof server: `@midnight-ntwrk/midnight-js-http-client-proof-provider`. */
export interface HttpProofModule { httpClientProofProvider(proofServerUrl: string, zkConfigProvider: KeyMaterialSource): ProofProvider }

export interface ConnectorProvidersResult {
    publicDataProvider: unknown;
    zkConfigProvider: FetchZkConfigProvider<string>;
    proofProvider: ProofProvider | undefined;
    /** Where proofs are actually made. Log it, because it says where the private inputs go. */
    provingModality: AssembledProvingModality;
    privateStateProvider: InMemoryPrivateStateProvider;
    connector: unknown;
    config: { indexerUri: string; indexerWsUri: string; substrateNodeUri: string; networkId: string; proverServerUri?: string };
    walletKeys: { coinPublicKey?: string; encryptionPublicKey?: string; shieldedAddress?: string };
    zkConfigBaseUrl: string;
}

/** The parsed answer of the server's `/contract-manifest` route. */
export interface ContractManifest {
    contracts: Array<{ name: string; zkConfigBaseUrl: string; circuits: string[] }>;
}

export function createNightgateConnectorProviders(opts: {
    connector: ContractConnector;
    manifest: ContractManifest;
    /** The URL the manifest was loaded from. Needed when the manifest has relative URLs and the app runs on another origin. */
    manifestUrl?: string;
    contractName: string;
    fetchFn?: typeof fetch;
    /** The WebSocket class for the indexer connection; default the platform's. */
    webSocket?: typeof WebSocket;
    proving?: ProvingModality;
    proofServerUrl?: string; // optional; default the server the wallet reports; a proof server for 'server' and 'auto'
    expectedManifestHash?: string; // SHA-256 as 64 hex; optional; the compiler manifest the served files must match
}): Promise<ConnectorProvidersResult>;

/** Creates only the proof provider, for apps that set up the other providers themselves. */
export function buildProofProvider(input: {
    proving?: ProvingModality;
    /** The wallet. Only `getProvingProvider` is read, and only to prove in the wallet. */
    connector: Partial<DAppConnectorProvingAPI>;
    zkConfigProvider: KeyMaterialSource;
    /** A proof server for 'server' and 'auto'. Without one and without a wallet that proves, nothing can prove. */
    proofServerUrl?: string;
    proofMod: HttpProofModule;
}): Promise<{ proofProvider: ProofProvider | undefined; provingModality: AssembledProvingModality }>;

/** The wallet methods `connectContract` uses. `getProvingProvider` is only needed to prove in the wallet. */
export type ContractConnector = DAppConnectorNetworkAPI & DAppConnectorWalletAPI & Partial<DAppConnectorProvingAPI>;

/** One circuit call. The `prepare*` helpers return this shape. */
export interface ContractCall {
    circuitId: string;
    args?: unknown[];
    /** The call's private inputs. Without them the `witnesses` of `connectContract` are used. */
    witnesses?: object;
    /** Runs right before the call is built. In a batch it sets what differs per call behind the shared witnesses. */
    before?: () => void;
}

/** A transaction that landed and applied fully. */
export interface ContractTxResult {
    /** A ledger identifier of the transaction. */
    txId: string;
    /** The ledger hash, as explorers show it. */
    txHash: string;
    blockHeight: number | null; // null = the SDK reported none
}

export interface ConnectContractOptions {
    /** The connected wallet, as the DApp connector returns it. */
    connector: ContractConnector;
    /** The contract's name in the manifest. */
    contractName: string;
    /** The compiled contract class, from a contract package or from your own build. */
    contractClass: Function;
    /** The parsed `/contract-manifest`. Without it `manifestUrl` is fetched. */
    manifest?: ContractManifest;
    /** Where the manifest is served. Needed without `manifest`, and when the manifest has relative URLs. */
    manifestUrl?: string;
    contractAddress?: string; // optional; a deploy sets it; the contract `call` and `batch` go to
    /** Private inputs for calls that carry none. A contract without witnesses needs none. */
    witnesses?: object;
    privateStateId?: string;
    /** Kept in this page only. */
    initialPrivateState?: unknown;
    proving?: ProvingModality;
    proofServerUrl?: string; // optional; default the server the wallet reports; a proof server for 'server' and 'auto'
    ttlMinutes?: number; // default 30; how long a built transaction stays valid
    expectedManifestHash?: string; // SHA-256 as 64 hex; optional; the compiler manifest the served files must match
    fetchFn?: typeof fetch;
    webSocket?: unknown; // optional; default the global WebSocket; the class the indexer connection uses
}

export interface ContractBatchOptions {
    /** One witnesses object for all calls. Needed when the calls carry different ones. */
    witnesses?: object;
    /** Set it when the calls after `orderedPrefix` do not depend on each other. They may then be reordered to an order the ledger accepts. */
    independentCalls?: boolean;
    /** With `independentCalls`: the number of leading calls that keep their position. */
    orderedPrefix?: number;
}

export interface ContractDeployInput {
    /** The contract's constructor arguments, in order. */
    args?: unknown[];
    /** Witnesses the constructor needs, if any. */
    witnesses?: object;
    initialPrivateState?: unknown;
}

/** One contract behind a connected wallet. The wallet balances, pays and submits every transaction. */
export interface ConnectedContract {
    readonly contractAddress: string | undefined;
    readonly networkId: string;
    /** Where proofs are made. Log it, because it says where the private inputs go. */
    readonly provingModality: AssembledProvingModality;
    /** Runs one circuit call as one transaction. `result` is what the circuit returned. */
    call(call: ContractCall): Promise<ContractTxResult & { result: unknown }>;
    /**
     * Runs up to 8 calls as one transaction, in array order.
     * It fails before proving with `code: 'BATCH_CAUSALITY_VIOLATION'` when the ledger would reject the order,
     * and with `code: 'BATCH_GAS_BUDGET_EXCEEDED'` when a call would run out of gas.
     */
    batch(calls: ContractCall[], options?: ContractBatchOptions): Promise<ContractTxResult>;
    /** Deploys the contract. Later calls of this object go to the new address. */
    deploy(input?: ContractDeployInput): Promise<ContractTxResult & { contractAddress: string }>;
}

/** Connects to one contract of the server's manifest through a connected wallet. */
export function connectContract(opts: ConnectContractOptions): Promise<ConnectedContract>;

export {
    type PreparedCall,
    type VaultBatchCall,
    prepareVaultBatch,
    DEFAULT_CLAIM_LIFETIME_S,
    prepareRevokeDisclosure,
    prepareGrantDisclosure,
    prepareAttest,
    recordKeyOf,
    prepareRegisterDocument,
    prepareBindDocument,
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
