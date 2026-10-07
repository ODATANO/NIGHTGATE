/**
 * Reads an attestation directly from the live vault contract, without the crawler.
 * An attestation is found by attester id plus payload hash, or by a document id bound to it.
 * Decoding the state runs in wasm, so this module does not import `@sap/cds` and runs in the decode worker.
 */
import { hexToBytes } from '../utils/hex';
import { importArtifact } from './artifact-import';
import { buildPublicDataProvider } from '../midnight/public-data-provider';
import { computeRecordKey, type ContractArtifact } from './predicate-state';

function hex(b: Uint8Array): string {
    return Buffer.from(b).toString('hex');
}

export interface AttestationRecord {
    payload_hash: Uint8Array;
    metadata_hash: Uint8Array;
    owner: Uint8Array;
    document_id: Uint8Array;
}

export interface AttestationLedger {
    attestations:      { member(key: Uint8Array): boolean; lookup(key: Uint8Array): AttestationRecord };
    content_anchors:   { member(key: Uint8Array): boolean; lookup(key: Uint8Array): { root: Uint8Array; schema: Uint8Array } };
    document_bindings: { member(key: Uint8Array): boolean; lookup(key: Uint8Array): Uint8Array };
    document_owners:   { member(key: Uint8Array): boolean; lookup(key: Uint8Array): Uint8Array };
}

/** Hex fields are '' when absent. The *Ok flags are false when no value was given to compare. */
export interface AttestationStateResult {
    attested: boolean;
    contentRootOk: boolean;
    schemaOk: boolean;
    /** The document id is registered to this attester. An unregistered id can be taken by anyone first. */
    bindingRegistered: boolean;
    attesterId: string;
    payloadHash: string;
    /** Key of the attestation entry. '' when the document id was not found. */
    recordKey: string;
    documentId: string;
    contentRoot: string;
    schemaId: string;
}

export interface ReadAttestationStateDeps {
    contractAddress: string;
    attesterId?: string;
    payloadHash?: string;
    /** Finds the attestation through the contract's `document_bindings` map. */
    documentId?: string;
    contentRoot?: string;
    schemaId?: string;
    ledger: (state: any) => AttestationLedger;
    queryContractState: (contractAddress: string) => Promise<any | null>;
}

const ZERO_ID = '00'.repeat(32);

/**
 * A given payloadHash or attesterId must match the attestation found.
 * Returns null when the contract has no state, so callers answer "not found" instead of a server error.
 */
export async function readAttestationState(
    deps: ReadAttestationStateDeps
): Promise<AttestationStateResult | null> {
    if (!deps.documentId && !(deps.attesterId && deps.payloadHash)) {
        throw new Error('attesterId and payloadHash, or documentId, are required');
    }
    const state = await deps.queryContractState(deps.contractAddress.toLowerCase());
    if (!state) return null;

    const led = deps.ledger(state.data ?? state);

    let recordKey = '';
    if (deps.documentId) {
        const id = hexToBytes(deps.documentId);
        if (led.document_bindings.member(id)) recordKey = hex(led.document_bindings.lookup(id));
    } else {
        recordKey = await computeRecordKey(deps.attesterId!, deps.payloadHash!);
    }
    const negative: AttestationStateResult = {
        attested: false, contentRootOk: false, schemaOk: false, bindingRegistered: false,
        attesterId: '', payloadHash: '', recordKey, documentId: '', contentRoot: '', schemaId: ''
    };
    if (!recordKey) return negative;
    const key = hexToBytes(recordKey);
    if (!led.attestations.member(key)) return negative;
    const record = led.attestations.lookup(key);
    const payloadHash = hex(record.payload_hash);
    if (deps.payloadHash && payloadHash !== deps.payloadHash.toLowerCase()) return negative;
    if (deps.attesterId && hex(record.owner) !== deps.attesterId.toLowerCase()) return negative;

    const anchor = led.content_anchors.member(key) ? led.content_anchors.lookup(key) : null;
    const contentRoot = anchor ? hex(anchor.root) : '';
    const schemaId = anchor ? hex(anchor.schema) : '';
    const contentRootOk = !!deps.contentRoot && contentRoot !== '' && contentRoot === deps.contentRoot.toLowerCase();
    const schemaOk = !!deps.schemaId && schemaId !== '' && schemaId === deps.schemaId.toLowerCase();
    const documentId = hex(record.document_id);
    const bindingRegistered = documentId !== ZERO_ID
        && led.document_owners.member(record.document_id)
        && hex(led.document_owners.lookup(record.document_id)) === hex(record.owner);
    return {
        attested: true,
        contentRootOk,
        schemaOk,
        bindingRegistered,
        attesterId: hex(record.owner),
        payloadHash,
        recordKey,
        documentId: documentId === ZERO_ID ? '' : documentId,
        contentRoot,
        schemaId
    };
}

export interface ReadAttestationStateForContractArgs {
    contractAddress: string;
    attesterId?: string;
    payloadHash?: string;
    documentId?: string;
    contentRoot?: string;
    schemaId?: string;
    artifactPath: string;
    /** Build of the artifact to load. Without it the module at `artifactPath` is imported as is. */
    artifactDigest?: string;
    contractProvidersConfig: import('../midnight/providers').ContractProvidersConfig;
}

export async function readAttestationStateForContract(
    args: ReadAttestationStateForContractArgs
): Promise<AttestationStateResult | null> {
    const publicData = await buildPublicDataProvider(args.contractProvidersConfig);
    const artifact = await importArtifact(args.artifactPath, args.artifactDigest) as ContractArtifact<AttestationLedger>;

    return readAttestationState({
        contractAddress: args.contractAddress,
        attesterId: args.attesterId,
        payloadHash: args.payloadHash,
        documentId: args.documentId,
        contentRoot: args.contentRoot,
        schemaId: args.schemaId,
        ledger: artifact.ledger,
        queryContractState: (addr: string) => publicData.queryContractState(addr)
    });
}
