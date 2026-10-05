using { Hex64 } from '../db/types';

/**
 * The two verify functions of the Nightgate service, without login.
 * Off by default. Set `NIGHTGATE_PUBLIC_VERIFY=true` to enable it.
 * Requests per client address are limited by `NIGHTGATE_PUBLIC_VERIFY_RATE_LIMIT` per minute.
 */
@path    : '/api/v1/verify'
@requires: 'any'
service NightgateVerifyService {

    /**
     * Checks on chain whether an attester has attested a payload hash.
     * Only the attester vouches for its attestation, so check `attesterId` against attesters you trust.
     * If nothing is found, the result is `verified: false`, not an error.
     */
    function verifyAttestationState(contractAddress: String,
                                    attesterId: Hex64,
                                    payloadHash: Hex64,
                                    documentId: Hex64, // instead of attesterId and payloadHash
                                    contentRoot: Hex64, // optional; must match the stored content root
                                    schemaId: Hex64, // optional; must match the stored schema id
                                    compiledArtifactRef: String, // optional, default 'attestation-vault'
                                    network: String // optional, default the server's network; e.g. 'preprod'
    )                                                                 returns {
        verified      : Boolean;
        attested      : Boolean; // the payload hash is attested
        contentRootOk : Boolean; // contentRoot matches
        schemaOk      : Boolean; // schemaId matches
        bindingRegistered : Boolean; // documentId belongs to this attester
        attesterId    : String;
        payloadHash   : String;
        recordKey     : String; // the key the attestation is stored under on chain
        documentId    : String;
    };

    /**
     * Checks on chain whether a proof about a document field was recorded as true.
     * The inputs must be exactly those of the proof, otherwise the result is `verified: false`.
     * For a comparison of two documents, A and B must be in the same order as when proving.
     */
    function verifyPredicateState(contractAddress: String,
                                  attesterId: Hex64,
                                  payloadHash: Hex64, // document A when comparing two documents
                                  fieldKey: Hex64, // required for single-field predicates
                                  predicate: String, // 'lessOrEqual' | 'greaterOrEqual' | 'bytesEquality' | 'setMembership' | 'documentIntegrity' | 'documentDiff'
                                  threshold: Integer64, // required for numeric predicates; the scaled integer used when proving
                                  expectedDigest: Hex64, // required for 'bytesEquality'
                                  setRoot: Hex64, // required for 'setMembership'
                                  payloadHashB: Hex64, // required when comparing two documents; document B
                                  attesterIdB: Hex64, // optional, default attesterId; attester of document B
                                  allowedMask: Integer64, // required for 'documentIntegrity'; bit i set = field i may differ
                                  k: Integer, // required for 'documentDiff'; minimum number of differing fields
                                  compiledArtifactRef: String, // optional, default 'attestation-vault'
                                  network: String // optional, default the server's network; e.g. 'preprod'
    )                                                                 returns {
        verified : Boolean;
        proven   : Boolean; // the proof is recorded on chain as true
    };
}
