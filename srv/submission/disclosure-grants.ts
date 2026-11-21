// Reads the vault contract's on-chain disclosure grants.
// Decoding the state runs in wasm, so this module does not import `@sap/cds` and runs in the decode worker.
import { hexToBytes } from '../utils/hex';
import { importArtifact } from './artifact-import';
import { buildPublicDataProvider, queryLedger9ContractState, type IndexerEndpoints } from '../midnight/public-data-provider';
import { computeRecordKey, refusedByRuntime, type ContractArtifact } from './predicate-state';
import type { ContractProvidersConfig } from '../midnight/providers';

function hex(b: Uint8Array): string {
    return Buffer.from(b).toString('hex');
}

/** The grants on one record, grantee to level. */
interface GrantMap extends Iterable<[Uint8Array, bigint]> {
    member(grantee: Uint8Array): boolean;
    lookup(grantee: Uint8Array): bigint;
}

/** The part of the contract's decoded state that this module reads. */
export interface DisclosureLedger {
    attestations: Iterable<[Uint8Array, { payload_hash: Uint8Array; owner: Uint8Array }]>;
    disclosures: {
        member(recordKey: Uint8Array): boolean;
        lookup(recordKey: Uint8Array): GrantMap;
    };
}

export interface DisclosureGrantRecord {
    attesterId: string;
    payloadHash: string;
    grantee: string;
    level: number;
}

/** All active grants. The `disclosures` map cannot be iterated, so its keys come from `attestations`. */
export function enumerateGrants(led: DisclosureLedger): DisclosureGrantRecord[] {
    const rows: DisclosureGrantRecord[] = [];
    for (const [recordKey, record] of led.attestations) {
        if (!led.disclosures.member(recordKey)) continue;
        for (const [granteeBytes, levelBig] of led.disclosures.lookup(recordKey)) {
            rows.push({
                attesterId: hex(record.owner),
                payloadHash: hex(record.payload_hash),
                grantee: hex(granteeBytes),
                level: Number(levelBig)
            });
        }
    }
    return rows;
}

/** The circuit every vault lineage deploys and no other registered contract has. */
const GRANT_ENTRY_POINT = 'grantDisclosure';

export interface ReadDisclosureGrantsArgs extends IndexerEndpoints {
    contractAddress: string;
    /** Block height to read the state at. Without it the latest state is read. */
    atHeight?: number | null;
    artifactPath: string;
    /** Build of the artifact to load. Without it the module at `artifactPath` is imported as is. */
    artifactDigest?: string;
}

/** The grants on chain, or null when the contract has no state or is not a vault. */
export async function readDisclosureGrants(args: ReadDisclosureGrantsArgs): Promise<DisclosureGrantRecord[] | null> {
    const publicData = await buildPublicDataProvider(args);
    const artifact = await importArtifact(args.artifactPath, args.artifactDigest) as ContractArtifact<DisclosureLedger>;
    const at = args.atHeight === undefined || args.atHeight === null ? undefined : { type: 'blockHeight' as const, blockHeight: args.atHeight };
    const state = await queryLedger9ContractState(publicData, args.contractAddress.toLowerCase(), at);
    if (!state) return null;
    // Walking the maps of another contract's state fails with an error the runtime does not name, so the kind is checked first.
    if (state.operation(GRANT_ENTRY_POINT) === undefined) return null;
    return enumerateGrants(artifact.ledger(state.data));
}

/** The level `grantee` holds on the record stored under `recordKey`: 0 public, 1 legitimate interest, 2 authority. Null without a grant. */
export function grantOf(led: Pick<DisclosureLedger, 'disclosures'>, recordKey: string, grantee: string): number | null {
    const key = hexToBytes(recordKey);
    if (!led.disclosures.member(key)) return null;
    const grants = led.disclosures.lookup(key);
    const id = hexToBytes(grantee);
    return grants.member(id) ? Number(grants.lookup(id)) : null;
}

export interface ReadDisclosureLevelArgs {
    contractAddress: string;
    attesterId: string;
    payloadHash: string;
    grantee: string;
    artifactPath: string;
    /** Build of the artifact to load. Without it the module at `artifactPath` is imported as is. */
    artifactDigest?: string;
    contractProvidersConfig: ContractProvidersConfig;
}

/** The level one grantee holds on an attester's record. Null without a grant, without contract state and for a contract that is no vault. */
export async function readDisclosureLevelForContract(args: ReadDisclosureLevelArgs): Promise<number | null> {
    const publicData = await buildPublicDataProvider(args.contractProvidersConfig);
    const artifact = await importArtifact(args.artifactPath, args.artifactDigest) as ContractArtifact<Partial<Pick<DisclosureLedger, 'disclosures'>>>;
    const state = await queryLedger9ContractState(publicData, args.contractAddress.toLowerCase());
    if (!state) return null;
    const recordKey = await computeRecordKey(args.attesterId, args.payloadHash);
    try {
        const { disclosures } = artifact.ledger(state.data);
        // An artifact without the map is not a vault.
        return disclosures ? grantOf({ disclosures }, recordKey, args.grantee) : null;
    } catch (err) {
        if (await refusedByRuntime(err)) return null;
        throw err;
    }
}
