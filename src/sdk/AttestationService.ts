/** Handlers for the abstract `AttestationService` CDS mixin; row-level visibility is out of scope. */
import type cds from '@sap/cds';
import {
    attachDisclosureRole,
    meetsDisclosure,
    DisclosureRoleValue
} from '../../srv/middleware/disclosure-role';

export type AttestationTier = 'Public' | 'Disclosed' | 'Authority';

const REQUIRED: Record<AttestationTier, DisclosureRoleValue> = {
    Public: 'public_only',
    Disclosed: 'legitimate_interest',
    Authority: 'authority'
};

/**
 * Call from `init()`: sets `req.disclosureRole` on every request and answers reads
 * of `Disclosed`/`Authority` below the required tier with 403, not an empty set.
 */
export function registerAttestationServiceHandlers(
    srv: cds.ApplicationService,
    db: cds.DatabaseService
): void {
    (srv as any).before('*', async (req: cds.Request) => {
        await attachDisclosureRole(req, db);
    });

    // CAP runs before-handlers in parallel: the gate cannot rely on the '*' hook.
    (srv as any).before('READ', 'Disclosed', makeTierGate('Disclosed', db));
    (srv as any).before('READ', 'Authority', makeTierGate('Authority', db));
}

function makeTierGate(tier: AttestationTier, db: cds.DatabaseService) {
    const required = REQUIRED[tier];
    return async (req: cds.Request) => {
        let actual = (req as any).disclosureRole as DisclosureRoleValue | undefined;
        if (actual === undefined) {
            actual = await attachDisclosureRole(req, db);
        }
        if (!meetsDisclosure(actual, required)) {
            return req.reject(403, `disclosure tier '${tier}' requires role '${required}'; caller has '${actual ?? 'public_only'}'`);
        }
    };
}

/**
 * Portable Attestation Credential proof envelope; field names are a public contract.
 * `proofValue` is the proving tx hash: Midnight proofs are not verifiable standalone.
 */
export interface PredicateAttestationEnvelope {
    digestMultibase: string | null;
    claim: {
        predicate: string;            // 'lessOrEqual' | 'greaterOrEqual' | 'bytesEquality' | 'setMembership'
        threshold: string | null;     // scaled integer as a string; null for the bytes kinds
        unit: string | null;
        expectedDigest?: string;      // bytesEquality: public expected value digest
        setRoot?: string;             // setMembership: canonical allow-list set root
    };
    proof: {
        system: 'midnight-compact';
        circuit: string;              // proving circuit, derived from the predicate kind
        verificationMethod: string;   // AttestationVault contract address
        proofValue: string;           // proving tx hash
    };
}

function circuitForPredicate(predicate: string): string {
    if (predicate === 'bytesEquality') return 'proveFieldEquality';
    if (predicate === 'setMembership') return 'proveFieldMembership';
    if (predicate === 'documentIntegrity' || predicate === 'documentDiff') return 'proveDocumentComparison';
    return 'proveFieldPredicate';
}

/** A `PredicateAttestations` row or issue* job result as a PAC envelope; pure, needs no service context. */
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
