/** Access checks for the `AttestationService` base service. They decide per view, not per row. */
import type cds from '@sap/cds';
import {
    attachDisclosureRole,
    meetsDisclosure,
    DisclosureRoleValue
} from '../../srv/middleware/disclosure-role';
import type { Request } from '@sap/cds';

export type AttestationTier = 'Public' | 'Disclosed' | 'Authority';

const REQUIRED: Record<AttestationTier, DisclosureRoleValue> = {
    Public: 'public_only',
    Disclosed: 'legitimate_interest',
    Authority: 'authority'
};

/**
 * Call this from `init()`. It sets `req.disclosureRole` on every request.
 * A read of a view the caller's role does not allow fails with 403 instead of returning nothing.
 */
export function registerAttestationServiceHandlers(
    srv: cds.ApplicationService,
    db: cds.DatabaseService
): void {
    (srv as any).before('*', async (req: cds.Request) => {
        await attachDisclosureRole(req, db);
    });

    // CAP runs before-handlers in parallel, so the role may not be set yet when these checks run.
    (srv as any).before('READ', 'Disclosed', makeTierGate('Disclosed', db));
    (srv as any).before('READ', 'Authority', makeTierGate('Authority', db));
}

function makeTierGate(tier: AttestationTier, db: cds.DatabaseService) {
    const required = REQUIRED[tier];
    return async (req: Request) => {
        let actual = req.disclosureRole;
        if (actual === undefined) {
            actual = await attachDisclosureRole(req, db);
        }
        if (!meetsDisclosure(actual, required)) {
            return req.reject(403, `disclosure tier '${tier}' requires role '${required}'; caller has '${actual ?? 'public_only'}'`);
        }
    };
}

/**
 * A proof result in a portable format. The field names are public and must not change.
 * `proofValue` is the hash of the transaction that carried the proof. Midnight proofs can only be checked on chain.
 */
export interface PredicateAttestationEnvelope {
    digestMultibase: string | null;
    claim: {
        predicate: string;            // 'lessOrEqual' | 'greaterOrEqual' | 'bytesEquality' | 'setMembership'
        threshold: string | null;     // scaled integer as a string. null for bytesEquality and setMembership.
        unit: string | null;
        expectedDigest?: string;      // bytesEquality only. Hash of the expected value.
        setRoot?: string;             // setMembership only. Hash of the allow-list.
    };
    proof: {
        system: 'midnight-compact';
        circuit: string;              // the contract function that made the proof
        verificationMethod: string;   // AttestationVault contract address
        proofValue: string;           // hash of the transaction that carried the proof
    };
}

function circuitForPredicate(predicate: string): string {
    if (predicate === 'bytesEquality') return 'proveFieldEquality';
    if (predicate === 'setMembership') return 'proveFieldMembership';
    if (predicate === 'documentIntegrity' || predicate === 'documentDiff') return 'proveDocumentComparison';
    return 'proveFieldPredicate';
}

/** Converts a `PredicateAttestations` row or a proof job result into the portable format. */
export function toPredicateEnvelope(row: {
    predicate: string;
    threshold?: number | string | null;
    unit?: string | null;
    expectedDigest?: string | null;
    setRoot?: string | null;
    contractAddress: string;
    provenTxHash?: string | null;
}): PredicateAttestationEnvelope {
    return {
        digestMultibase: null,
        claim: {
            predicate: row.predicate,
            threshold: row.threshold === null || row.threshold === undefined ? null : String(row.threshold),
            unit: row.unit ?? null,
            ...(row.expectedDigest ? { expectedDigest: row.expectedDigest } : {}),
            ...(row.setRoot ? { setRoot: row.setRoot } : {})
        },
        proof: {
            system: 'midnight-compact',
            circuit: circuitForPredicate(row.predicate),
            verificationMethod: row.contractAddress,
            proofValue: row.provenTxHash ?? ''
        }
    };
}
