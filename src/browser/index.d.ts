/** `@odatano/nightgate/browser` - browser entry. See index.mjs. */

// Local import as well as the re-export below: `export { … } from` re-exports a name without
// binding it locally, and `PreparedCall.witnesses` REFERENCES this type further down. The repo's
// own typecheck hides the resulting TS2304 (skipLibCheck is on); only a consumer typechecking
// against the installed package sees it.
import type { AttestationVaultWitnesses } from './witnesses.js';

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
} from './witnesses.js';

// Phase 4 - providers + typed call helpers.

/** Browser ZK-config provider that fetches keys/zkir from `/zk-config/<contract>`. */
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

/** Trivial in-memory PrivateStateProvider (the vault has no contract private state). */
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
 * Which proving modality a consumer wants.
 *   'server' - httpClientProofProvider against the connector-reported proof server (default).
 *   'wallet' - delegate contract proving to the wallet's own prover; THROWS when the connected
 *              wallet has no `getProvingProvider` (never silently downgrades).
 *   'auto'   - wallet when available, else server.
 */
export type ProvingModality = 'server' | 'wallet' | 'auto';

export interface ConnectorProvidersResult {
    publicDataProvider: unknown;
    zkConfigProvider: FetchZkConfigProvider;
    proofProvider: unknown | undefined;
    /** The modality actually assembled. Log it: it says where the transaction preimage goes. */
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
    contract: string;
    fetchFn?: typeof fetch;
    webSocket?: any;
    proving?: ProvingModality;
}): Promise<ConnectorProvidersResult>;

/**
 * The proof-provider assembly on its own, for consumers that build the other providers
 * themselves. Same rules as the `proving` option above.
 */
export function buildProofProvider(input: {
    proving?: ProvingModality;
    connector: any;
    zkConfigProvider: FetchZkConfigProvider;
    proverServerUri?: string;
    proofMod: any;
}): Promise<{ proofProvider: unknown | undefined; provingModality: 'server' | 'wallet' | 'none' }>;

export interface PreparedCall {
    circuitId: string;
    /** boolean[] carries the cross-root integrity circuit's Vector<width, Boolean> mask arg. */
    args: Array<Uint8Array | bigint | boolean[]>;
    witnesses: AttestationVaultWitnesses;
    /**
     * The proof-prepare helpers pass their inputs through so a batch caller
     * can rebind the SAME call bundle (e.g. into a shared witness holder).
     */
    merkleProof?: import('./witnesses.js').MerkleProof;
    /** Slot width the call was prepared for (16 default, 32 for attestation-vault-32). */
    slotWidth?: number;
}
export function prepareRevokeDisclosure(input: { payloadHash: string; grantee: string; attestationSecret: Uint8Array }): PreparedCall;
export function prepareGrantDisclosure(input: { payloadHash: string; grantee: string; level: number | bigint; attestationSecret: Uint8Array }): PreparedCall;
export function prepareAttest(input: { payloadHash: string; metadataHash: string; attestationSecret: Uint8Array }): PreparedCall;
export function prepareAttestCommit(input: { commitment: string; attestationSecret: Uint8Array }): PreparedCall;
export function prepareAttestReveal(input: { payloadHash: string; metadataHash: string; nonce: string; attestationSecret: Uint8Array }): PreparedCall;
export function prepareRegisterPassport(input: { passportId: string; ownerId: string; attestationSecret: Uint8Array }): PreparedCall;
export function prepareBindPassport(input: { passportId: string; payloadHash: string; attestationSecret: Uint8Array }): PreparedCall;
export function prepareAnchorContentRoot(input: { payloadHash: string; contentRoot: string; schemaId: string; attestationSecret: Uint8Array }): PreparedCall;
export function prepareProveFieldPredicate(input: { payloadHash: string; fieldKey: string; threshold: number | bigint; op: number | bigint; merkleProof: import('./witnesses.js').MerkleProof; attestationSecret?: Uint8Array; slotWidth?: number }): PreparedCall;
export function prepareProveFieldEquality(input: { payloadHash: string; fieldKey: string; expectedDigest: string; merkleProof: import('./witnesses.js').MerkleProof; attestationSecret?: Uint8Array; slotWidth?: number }): PreparedCall;
export function prepareProveFieldMembership(input: { payloadHash: string; fieldKey: string; setRoot: string; merkleProof: import('./witnesses.js').MerkleProof; attestationSecret?: Uint8Array; slotWidth?: number }): PreparedCall;
export function prepareProveFieldsUnchangedExcept(input: { payloadHashA: string; payloadHashB: string; allowedMask: number; docPair: import('./witnesses.js').DocPair; attestationSecret?: Uint8Array; slotWidth?: number }): PreparedCall;
export function prepareProveFieldsDiffer(input: { payloadHashA: string; payloadHashB: string; k: number; docPair: import('./witnesses.js').DocPair; attestationSecret?: Uint8Array; slotWidth?: number }): PreparedCall;

export interface ContractBrowserMeta {
    name: string;
    /** npm subpath to import the compiled contract artifact from. */
    artifactSubpath: string;
    circuits: string[];
    /** Circuits requiring the attester-identity witness (local_secret_key). */
    attesterGated: string[];
    /** Circuits requiring the per-call Merkle inclusion proof witnesses. */
    merkleWitnessed?: string[];
    hasPrivateState: boolean;
    /** Content-tree width: provable fields per document (16 default, 32 on attestation-vault-32). */
    slotWidth: number;
    /** Inclusion-path depth, log2(slotWidth). */
    merkleDepth: number;
}

export const CONTRACTS: Record<string, ContractBrowserMeta>;
