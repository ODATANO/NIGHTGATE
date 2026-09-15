/**
 * Unauthenticated copies of the two crawler-free verify functions of the
 * Nightgate service (same signatures and results). Enabled by
 * `NIGHTGATE_PUBLIC_VERIFY=true`, else `404 PUBLIC_VERIFY_DISABLED`; rate
 * limited per client address (`NIGHTGATE_PUBLIC_VERIFY_RATE_LIMIT`/min).
 */
@path    : '/api/v1/verify'
@requires: 'any'
service NightgateVerifyService {

    /**
     * Check live contract state for the attester's record of `payloadHash`
     * (or of a bound `documentId`), optionally matching anchored `contentRoot`
     * / `schemaId`. An anchor is the attester's own statement: also check
     * `attesterId` (and `schemaId` for cross-root claims) against what you trust.
     * Absent record or no live provider: `verified: false`, not an error.
     * `network` reads another network's public indexer (400 if unknown;
     * endpoints via `cds.requires.nightgate.networks.<network>`).
     */
    function verifyAttestationState(contractAddress: String,
                                    attesterId: String, // 64 hex; with payloadHash names the record, recordKey(attesterId, payloadHash)
                                    payloadHash: String, // 64 hex; the attested hash
                                    documentId: String, // 64 hex; alternative selector (a payloadHash next to it must match)
                                    contentRoot: String, // optional 64 hex, checked against anchored root
                                    schemaId: String, // optional 64 hex, checked against anchored schema id
                                    compiledArtifactRef: String, // optional, defaults to 'attestation-vault'
                                    network: String // optional network override, e.g. 'preview' | 'preprod' | 'mainnet'
    )                                                                 returns {
        verified      : Boolean;
        attested      : Boolean; // payload_hash present in the attestation map
        contentRootOk : Boolean; // anchored content root matches (when contentRoot given)
        schemaOk      : Boolean; // anchored schema id matches (when schemaId given)
        bindingRegistered : Boolean; // the bound document id is registered to this attester (unregistered ids are first-come-first-served)
        attesterId    : String; // the record's attester id, if present
        payloadHash   : String; // the record's payload hash, if present
        recordKey     : String; // the ledger key the state was read under
        documentId    : String; // bound document id, if any
    };

    /**
     * Check live contract state for a true predicate result under the claim
     * key recomputed from the given coordinates; needs no job or DB row.
     * Cross-root kinds: `payloadHash` is document A, (A, B) order must match
     * the proving order. `threshold` must be the same scaled integer the
     * circuit hashed, else `verified: false`. Absent result, unknown contract
     * or no live provider: `verified: false`. `network` as on verifyAttestationState.
     */
    function verifyPredicateState(contractAddress: String,
                                  attesterId: String, // 64 hex; the attester whose record of payloadHash carries the claim
                                  payloadHash: String, // 64 hex (cross-root kinds: document A)
                                  fieldKey: String, // 64 hex; required for the numeric/bytes kinds
                                  predicate: String, // 'lessOrEqual' | 'greaterOrEqual' | 'bytesEquality' | 'setMembership' | 'documentIntegrity' | 'documentDiff'
                                  threshold: Integer64, // scaled circuit integer (numeric predicates only)
                                  expectedDigest: String, // 64 hex, required for 'bytesEquality'
                                  setRoot: String, // 64 hex canonical set root, required for 'setMembership'
                                  payloadHashB: String, // 64 hex document B, required for the cross-root kinds
                                  attesterIdB: String, // 64 hex; document B's attester for the cross-root kinds (default attesterId)
                                  allowedMask: Integer64, // packed width-bit mask, required for 'documentIntegrity'
                                  k: Integer, // minimum differing slots 1..width, required for 'documentDiff'
                                  compiledArtifactRef: String, // optional, defaults to 'attestation-vault'
                                  network: String // optional network override, e.g. 'preview' | 'preprod' | 'mainnet'
    )                                                                 returns {
        verified : Boolean;
        proven   : Boolean; // a true result is recorded on-chain for the claim key
    };
}
