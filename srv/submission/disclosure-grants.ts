/**
 * Reads the vault contract's on-chain disclosure grants.
 * Decoding the state runs in wasm, so this module does not import `@sap/cds` and runs in the decode worker.
 */
import { importArtifact } from './artifact-import';
import { buildPublicDataProvider, type IndexerEndpoints } from '../midnight/public-data-provider';
import type { ContractArtifact } from './predicate-state';

function hex(b: Uint8Array): string {
    return Buffer.from(b).toString('hex');
}

/** The part of the contract's decoded state that this module reads. */
export interface DisclosureLedger {
    attestations: Iterable<[Uint8Array, { payload_hash: Uint8Array; owner: Uint8Array }]>;
    disclosures: {
        member(key: Uint8Array): boolean;
        lookup(key: Uint8Array): Iterable<[Uint8Array, bigint]>;
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

export interface ReadDisclosureGrantsArgs extends IndexerEndpoints {
    contractAddress: string;
    /** Block height to read the state at. Without it the latest state is read. */
    atHeight?: number | null;
    artifactPath: string;
    /** Build of the artifact to load. Without it the module at `artifactPath` is imported as is. */
    artifactDigest?: string;
}

/** The grants on chain, or null when the contract has no state. */
export async function readDisclosureGrants(args: ReadDisclosureGrantsArgs): Promise<DisclosureGrantRecord[] | null> {
    const publicData = await buildPublicDataProvider(args);
    const artifact = await importArtifact(args.artifactPath, args.artifactDigest) as ContractArtifact<DisclosureLedger>;
    const at = args.atHeight === undefined || args.atHeight === null ? undefined : { type: 'blockHeight' as const, blockHeight: args.atHeight };
    const state = await publicData.queryContractState(args.contractAddress.toLowerCase(), at);
    if (!state) return null;
    // The state may come wrapped with the ledger in `.data`, or bare.
    return enumerateGrants(artifact.ledger(state.data ?? state));
}
