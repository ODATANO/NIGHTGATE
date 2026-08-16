/**
 * Service-implementation helpers for the abstract `AttestationService` CDS
 * mixin. A consumer service that extends `AttestationService` calls
 * `registerAttestationServiceHandlers(this, db)` from its own `init()` to
 * wire:
 *
 *   1. `attachDisclosureRole` as a `before('*')` hook so every request
 *      gets `req.disclosureRole` populated from `midnight.DisclosureRoles`.
 *   2. Per-entity tier gates: `Disclosed` requires `legitimate_interest+`,
 *      `Authority` requires `authority`. `Public` has no gate.
 *
 * The gates reject with a 403 instead of silently returning an empty set,
 * so callers can tell "you can't reach this tier" apart from "this tier is
 * empty for you".
 *
 * TODO: Row-level visibility (e.g. "show me only attestations I have an on-chain
 * disclosure for") is deliberately out of scope here: that requires
 * indexing the AttestationVault `disclosures` Map into NIGHTGATE and
 * joining at query time.
 */
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
 * Wire the disclosure-role middleware + per-entity tier gates on the given
 * CAP service. Idempotent in the sense that re-registering on the same
 * service instance would just stack hooks (CAP allows that, but consumers
 * should call this once from their service's `init()`).
 */
export function registerAttestationServiceHandlers(
    srv: cds.ApplicationService,
    db: cds.DatabaseService
): void {
    // 1. Populate req.disclosureRole on every incoming request. The handler
    //    no-ops if there's no req.user (anonymous → public_only default).
    (srv as any).before('*', async (req: cds.Request) => {
        await attachDisclosureRole(req, db);
    });

    // 2. Gate per-entity reads. Service handlers run AFTER the before('*')
    //    hook so the role is already on req. We use entity-specific before
    //    handlers so the rejection fires before CAP runs the DB query.
    (srv as any).before('READ', 'Disclosed', makeTierGate('Disclosed'));
    (srv as any).before('READ', 'Authority', makeTierGate('Authority'));
}

function makeTierGate(tier: AttestationTier) {
    const required = REQUIRED[tier];
    return (req: cds.Request) => {
        const actual = (req as any).disclosureRole as DisclosureRoleValue | undefined;
        if (!meetsDisclosure(actual, required)) {
            return req.reject(403, `disclosure tier '${tier}' requires role '${required}'; caller has '${actual ?? 'public_only'}'`);
        }
    };
}

/**
 * Portable Attestation Credential (PAC) proof envelope. Field names match the
 * envelope NIGHTPASS drops into a `PredicateAttestationCredential`, so the
 * output is consumed unchanged.
 *
 * The proof is not standalone-verifiable with just a
 * VK. `proofValue` is therefore the proving transaction's hash.
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

/** The AttestationVault circuit that proves a given predicate literal. */
function circuitForPredicate(predicate: string): string {
    if (predicate === 'bytesEquality') return 'proveFieldEquality';
    if (predicate === 'setMembership') return 'proveFieldMembership';
    if (predicate === 'documentIntegrity' || predicate === 'documentDiff') return 'proveDocumentComparison';
    return 'proveFieldPredicate';
}

/**
 * Shape a `PredicateAttestations` row (or an issue* proof-action job result)
 * into the PAC proof envelope. Pure/synchronous so consumers can call it
 * without any NIGHTGATE service context.
 */
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
