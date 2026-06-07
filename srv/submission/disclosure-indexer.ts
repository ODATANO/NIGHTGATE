/**
 * Disclosure-grant chain indexer (Phase 2 of expose-disclosure-grants).
 *
 * Reads the AttestationVault `disclosures` ledger Map back out of on-chain
 * state and materializes it into the `DisclosureGrants` entity, so tier
 * entitlement becomes a queryable, chain-derived source of truth (the contract
 * is the ACL — see docs/feature-requests/expose-disclosure-grants.md).
 *
 * CENTRAL CONSTRAINT (validated in scripts/spike-disclosure-indexer.mjs):
 * the OUTER `disclosures` map exposes only `member`/`lookup` — it is NOT
 * iterable. The inner per-payload map and the sibling `attestation_owners`
 * map ARE iterable. So we enumerate payload hashes via `attestation_owners`
 * (every disclosure is scoped to an attested payload), then drill into
 * `disclosures.lookup(payloadHash)` for the grantee→level entries.
 *
 * The decode + enumerate logic is dependency-injected (`ledger`,
 * `queryContractState`) so it unit-tests without the ESM-only SDK. The thin
 * `reindexDisclosuresForContract` wrapper wires the real providers + artifact.
 */
import cds from '@sap/cds';
import { pathToFileURL } from 'node:url';
import { DisclosureGrants } from '#cds-models/midnight';

const { SELECT, INSERT, UPDATE } = cds.ql;

function hex(b: Uint8Array): string {
    return Buffer.from(b).toString('hex');
}

/** Minimal shape of the compiled artifact's `ledger(state)` return we rely on. */
export interface DisclosureLedger {
    attestation_owners: Iterable<[Uint8Array, Uint8Array]>;
    disclosures: {
        member(key: Uint8Array): boolean;
        lookup(key: Uint8Array): Iterable<[Uint8Array, bigint]>;
    };
}

export interface DisclosureGrantRecord {
    payloadHash: string;
    grantee: string;
    level: number;
}

/**
 * Enumerate every active grant in a decoded ledger. Works around the
 * non-iterable outer `disclosures` map by iterating `attestation_owners`.
 */
export function enumerateGrants(led: DisclosureLedger): DisclosureGrantRecord[] {
    const rows: DisclosureGrantRecord[] = [];
    for (const [payloadHashBytes] of led.attestation_owners) {
        if (!led.disclosures.member(payloadHashBytes)) continue;
        for (const [granteeBytes, levelBig] of led.disclosures.lookup(payloadHashBytes)) {
            rows.push({
                payloadHash: hex(payloadHashBytes),
                grantee:     hex(granteeBytes),
                level:       Number(levelBig)
            });
        }
    }
    return rows;
}

export interface ReindexDeps {
    // `any` (not cds.DatabaseService): tests inject a minimal `{ run }` mock,
    // matching the rest of the submission module.
    db: any;
    contractAddress: string;
    /** Decoder from the compiled artifact (`ledger`). */
    ledger: (state: any) => DisclosureLedger;
    /** publicDataProvider.queryContractState — returns ContractState | null. */
    queryContractState: (contractAddress: string) => Promise<any | null>;
}

export interface ReindexResult {
    /** Grants found on-chain for this contract. */
    indexed: number;
    /** Previously-active rows flipped to inactive (revoked on-chain). */
    deactivated: number;
}

/**
 * Re-materialize `DisclosureGrants` for one contract from current on-chain
 * state. Idempotent: existing rows are updated in place (preserving the
 * optimistic `grantedTxHash` the handler wrote), new on-chain grants are
 * inserted, and any previously-active row no longer present on-chain is swept
 * to `active=false` (its grantee was revoked).
 */
export async function reindexDisclosures(deps: ReindexDeps): Promise<ReindexResult> {
    const { db, contractAddress, ledger, queryContractState } = deps;

    const state = await queryContractState(contractAddress);
    if (!state) return { indexed: 0, deactivated: 0 };

    // ContractState carries the ledger in `.data` (a ChargedState); `ledger()`
    // also accepts a bare StateValue, so fall back to the state itself.
    const led = ledger(state.data ?? state);
    const onChain = enumerateGrants(led);

    const now = new Date().toISOString();
    const seen = new Set<string>();

    for (const g of onChain) {
        seen.add(`${g.payloadHash}|${g.grantee}`);
        const existing: any = await db.run(
            SELECT.one.from(DisclosureGrants).where({
                contractAddress, payloadHash: g.payloadHash, grantee: g.grantee
            })
        );
        if (existing) {
            await db.run(UPDATE.entity(DisclosureGrants)
                .set({ level: g.level, active: true, revokedTxHash: null, modifiedAt: now })
                .where({ ID: existing.ID }));
        } else {
            await db.run(INSERT.into(DisclosureGrants).entries({
                ID:              cds.utils.uuid(),
                payloadHash:     g.payloadHash,
                grantee:         g.grantee,
                level:           g.level,
                contractAddress,
                grantedTxHash:   null,
                revokedTxHash:   null,
                active:          true,
                createdAt:       now,
                modifiedAt:      now
            }));
        }
    }

    // Sweep: an active row for this contract that is no longer on-chain was
    // revoked. The chain is authoritative, so flip it inactive.
    const activeRows: any[] = (await db.run(
        SELECT.from(DisclosureGrants).where({ contractAddress, active: true })
    )) || [];

    let deactivated = 0;
    for (const r of activeRows) {
        if (!seen.has(`${r.payloadHash}|${r.grantee}`)) {
            await db.run(UPDATE.entity(DisclosureGrants)
                .set({ active: false, modifiedAt: now })
                .where({ ID: r.ID }));
            deactivated++;
        }
    }

    return { indexed: onChain.length, deactivated };
}

export interface ReindexForContractArgs {
    db: any;
    contractAddress: string;
    /** Path to the compiled contract artifact (`.../contract/index.js`). */
    artifactPath: string;
    /** Config for the contract-only provider bundle (no wallet needed to read). */
    contractProvidersConfig: import('../midnight/providers').ContractProvidersConfig;
}

/**
 * Production wrapper: build a contract-only provider bundle, load the
 * artifact's `ledger`, and reindex. Best-effort by design — callers run this
 * after a successful grant/revoke submit and must not let an indexing failure
 * fail the submission (the optimistic row already records intent; a later
 * reindex reconciles). Dynamic import keeps the ESM-only SDK out of CJS load.
 */
export async function reindexDisclosuresForContract(
    args: ReindexForContractArgs
): Promise<ReindexResult> {
    const { db, contractAddress, artifactPath, contractProvidersConfig } = args;

    const { buildContractProviders } = await import('../midnight/providers.js');
    const bundle = await buildContractProviders(contractProvidersConfig);
    const artifact: any = await import(pathToFileURL(artifactPath).href);

    return reindexDisclosures({
        db,
        contractAddress,
        ledger: artifact.ledger,
        queryContractState: (addr: string) => bundle.publicDataProvider.queryContractState(addr)
    });
}
