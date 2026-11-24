using { BigInt, ClaimPredicate, Hex64, HexEncoded, Network } from '../db/types';

/** The verify functions of the Nightgate service, without login.
 * Off by default. Set `NIGHTGATE_PUBLIC_VERIFY=true` to enable it.
 * Requests per client address are limited by `NIGHTGATE_PUBLIC_VERIFY_RATE_LIMIT` per minute. */
@path    : '/odata/v4/midnight-verify'
@requires: 'any'
service NightgateVerifyService {

    /** Checks on chain whether an attester has attested a payload hash.
     * Only the attester vouches for its attestation, so check `attesterId` against attesters you trust.
     * If nothing is found, the result is `verified: false`, not an error. */
    function verifyAttestation(contractAddress: HexEncoded,
                                    attesterId: Hex64,
                                    payloadHash: Hex64,
                                    documentId: Hex64, // instead of attesterId and payloadHash
                                    contentRoot: Hex64, // optional; must match the stored content root
                                    schemaId: Hex64, // optional; must match the stored schema id
                                    contractName: String, // optional, default 'attestation-vault'
                                    network: Network // optional, default the server's network
    )                                                                 returns {
        verified          : Boolean not null;
        attested          : Boolean not null; // the payload hash is attested
        contentRootOk     : Boolean not null; // contentRoot matches
        schemaOk          : Boolean not null; // schemaId matches
        bindingRegistered : Boolean not null; // documentId belongs to this attester
        attesterId        : Hex64 not null;
        payloadHash       : Hex64 not null;
        recordKey         : Hex64 not null; // the key the attestation is stored under on chain
        documentId        : Hex64 not null;
        blockHeight       : Integer64; // null = no indexer to read from; the answer holds at this block
    };

    /** Checks on chain whether a proof about a document field was recorded as true.
     * The inputs must be exactly those of the proof, otherwise the result is `verified: false`.
     * For a comparison of two documents, A and B must be in the same order as when proving. */
    function verifyPredicate(contractAddress: HexEncoded,
                                  attesterId: Hex64,
                                  payloadHash: Hex64, // document A when comparing two documents
                                  fieldKey: Hex64, // required for single-field predicates
                                  predicate: ClaimPredicate,
                                  threshold: BigInt, // required for numeric predicates; the scaled integer used when proving
                                  expectedDigest: Hex64, // required for 'bytesEquality'
                                  setRoot: Hex64, // required for 'setMembership'
                                  payloadHashB: Hex64, // required when comparing two documents; document B
                                  attesterIdB: Hex64, // optional, default attesterId; attester of document B
                                  allowedMask: Integer64, // required for 'documentIntegrity'; bit i set = field i may differ
                                  k: Integer, // required for 'documentDiff'; minimum number of differing fields
                                  contractName: String, // optional, default 'attestation-vault'
                                  network: Network // optional, default the server's network
    )                                                                 returns {
        verified    : Boolean not null;
        proven      : Boolean not null; // the proof is recorded on chain as true
        blockHeight : Integer64; // null = no indexer to read from; the answer holds at this block
    };

    /** Checks on chain which disclosure level an attester has granted to `grantee` on a payload hash.
     * A revoked grant and a retracted attestation leave no grant.
     * If nothing is found, the result is `verified: false`, not an error. */
    function verifyDisclosure(contractAddress: HexEncoded,
                                   attesterId: Hex64,
                                   payloadHash: Hex64,
                                   grantee: Hex64,
                                   @assert.range: [0, 2]
                                   minLevel: Integer, // optional, default 0; the lowest level that counts as verified
                                   contractName: String, // optional, default 'attestation-vault'
                                   network: Network // optional, default the server's network
    )                                                                 returns {
        verified    : Boolean not null;
        granted     : Boolean not null; // a grant for the grantee is recorded on chain
        level       : Integer; // 0 public, 1 legitimate interest, 2 authority; null = no grant
        blockHeight : Integer64; // null = no indexer to read from; the answer holds at this block
    };
}
