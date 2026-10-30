using {midnight} from '../db/schema';
using { Hex64, TxType } from '../db/types';

/** Midnight chain data, attestations, zero-knowledge proofs, wallet sessions and transaction jobs.
 * Actions that write to the chain return a `jobId` to poll with `getJobStatus`. A retry with the same `idempotencyKey` returns the first job.
 * `sponsorSessionId` is a second session that pays the fee. Amounts are decimal strings in the smallest unit. */
@path    : '/odata/v4/midnight'
@requires: 'authenticated-user'
service NightgateService {

    @readonly
    entity Blocks                as
        projection on midnight.Blocks {
            *,
            parent,
            transactions
        }
        actions {
            @cds.odata.bindingparameter.collection
            function latest()                                                            returns Blocks;

            @cds.odata.bindingparameter.collection
            function byHeight(@assert.range: [0, _] height: Integer)                                           returns Blocks;

            @cds.odata.bindingparameter.collection
            function range(startHeight: Integer64, endHeight: Integer64, @assert.range: [1, 5000] limit: Integer, @assert.range: [0, _] skip: Integer) returns array of Blocks;
        };

    @readonly
    entity Transactions          as
        projection on midnight.Transactions {
            *,
            block,
            transactionResult,
            transactionFees,
            contractActions,
            unshieldedCreatedOutputs,
            unshieldedSpentOutputs,
            zswapLedgerEvents,
            dustLedgerEvents
        }
        actions {
            // The same extrinsic hash can land in more than one block. Newest first, limit default 100.
            @cds.odata.bindingparameter.collection
            function byHash(hash: String, @assert.range: [1, 5000] limit: Integer, @assert.range: [0, _] skip: Integer) returns array of Transactions;

            @cds.odata.bindingparameter.collection
            function byType(@assert.range txType: TxType, @assert.range: [1, 5000] limit: Integer, @assert.range: [0, _] skip: Integer) returns array of Transactions;

            // identifier: a ledger identifier of the transaction, hex. 404 while the indexer has not seen it.
            @cds.odata.bindingparameter.collection
            function byIdentifier(identifier: String)       returns TransactionInclusion;
        };

    /** Where a transaction landed. `status` is null until the indexer supplement has the result. */
    type TransactionInclusion {
        identifier     : String;
        hash           : String;
        ledgerTxHash   : String;
        blockHeight    : Integer64;
        blockHash      : String;
        status         : String; // SUCCESS | PARTIAL_SUCCESS | FAILURE
        failedSegments : array of Integer;
    }

    /** One counted budget of a grant. `max` null = no limit. */
    type Budget {
        max      : Integer;
        used     : Integer;
        resetsAt : Timestamp; // when `used` returns to 0
    }

    /** A server rate class as it stands for the caller. */
    type RateClassState {
        name          : String; // prove | deploy | sponsor | compute | read
        windowSeconds : Integer;
        max           : Integer;
        remaining     : Integer;
    }

    /** Most atoms of one token type a grant may move per UTC day through sponsored swaps, transfers and mints. */
    type ValueBudget {
        tokenType : Hex64;
        amount    : String; // decimal; atoms
    }

    /** One value budget of a grant as it stands today. */
    type ValueBudgetState {
        tokenType : String;
        max       : String; // decimal; atoms
        used      : String; // decimal; atoms
        resetsAt  : Timestamp; // when `used` returns to 0
    }

    /** A statement of the instance about a landed job, signed with its receipt key (`getReceiptKey` on the indexer service). */
    type Receipt {
        payload   : LargeString; // JSON; the signed bytes, keys sorted
        signature : String; // hex; Ed25519 over the UTF-8 payload
        publicKey : String; // hex; the instance's receipt key
        algorithm : String; // ed25519
    }

    @readonly
    entity TransactionResults    as projection on midnight.TransactionResults;

    @readonly
    entity TransactionSegments   as projection on midnight.TransactionSegments;

    @readonly
    entity TransactionFees       as projection on midnight.TransactionFees;

    @readonly
    entity ContractActions       as
        projection on midnight.ContractActions {
            *,
            transaction,
            deploy,
            unshieldedBalances
        }
        actions {
            // Oldest first, limit default 100. Page with skip to read every action.
            @cds.odata.bindingparameter.collection
            function byAddress(address: String, @assert.range: [1, 5000] limit: Integer, @assert.range: [0, _] skip: Integer) returns array of ContractActions;

            // Newest first, limit default 100.
            @cds.odata.bindingparameter.collection
            function history(address: String, @assert.range: [1, 5000] limit: Integer, @assert.range: [0, _] skip: Integer)   returns array of ContractActions;
        };

    @readonly
    entity ContractBalances      as projection on midnight.ContractBalances;

    /** The state of a contract at a block. `state` and `zswapState` are base64. */
    type ContractStateSnapshot {
        address          : String;
        height           : Integer64; // null if not known locally
        state            : LargeString;
        zswapState       : LargeString;
        stateHash        : String;
        zswapStateHash   : String;
        source           : String(10); // history | current | indexer
        verified         : Boolean; // only for source indexer: the state matches the hash stored on chain
        blockHash        : String; // the block the state comes from
        ledgerParameters : LargeString; // base64; in effect at that block; null = not known to this server
        coveredHeight    : Integer64; // the database holds every contract state up to this block; null = supplement never ran, or source indexer
        chainHeight      : Integer64; // the chain tip the crawler last saw
    }

    /** The newest state of each contract. */
    @readonly
    entity ContractStates        as
        projection on midnight.ContractStates {
            *,
            contractAction
        }
        actions {
            // height: optional, default the current state
            @cds.odata.bindingparameter.collection
            function stateAt(address: String, height: Integer64) returns ContractStateSnapshot;
        };

    @readonly
    entity UnshieldedUtxos       as
        projection on midnight.UnshieldedUtxos {
            *,
            createdAtTransaction,
            spentAtTransaction
        }
        actions {
            // Newest first, limit default 1000.
            @cds.odata.bindingparameter.collection
            function byOwner(owner: String, @assert.range: [1, 5000] limit: Integer, @assert.range: [0, _] skip: Integer) returns array of UnshieldedUtxos;

            // Newest first, limit default 1000.
            @cds.odata.bindingparameter.collection
            function unspent(@assert.range: [1, 5000] limit: Integer, @assert.range: [0, _] skip: Integer)                returns array of UnshieldedUtxos;
        };

    @readonly
    entity ZswapLedgerEvents     as projection on midnight.ZswapLedgerEvents;

    @readonly
    entity DustLedgerEvents      as projection on midnight.DustLedgerEvents;

    /** Unshielded NIGHT balance per address. */
    @readonly
    entity NightBalances         as projection on midnight.NightBalances
        actions {
            @cds.odata.bindingparameter.collection
            function getBalance(address: String)   returns NightBalances;

            // Highest balance first, limit default 10.
            @cds.odata.bindingparameter.collection
            function getTopHolders(@assert.range: [1, 5000] limit: Integer, @assert.range: [0, _] skip: Integer) returns array of NightBalances;
        };

    /** Transactions this server submitted. They become `finalized` once the server has indexed their block. */
    @readonly
    entity PendingSubmissions    as
        projection on midnight.PendingSubmissions
        excluding {
            submitIntentData
        };

    // ---- Documents ----

    /** Documents whose hash was recorded on chain. Each user sees only their own. */
    @readonly
    entity Documents             as projection on midnight.Documents;

    /** Records a document hash and its public metadata on chain, signed by the session's wallet.
     * The server does not store the document itself. Keeping the bytes at `storageRef` is up to you. */
    action   anchorDocument(sha256: Hex64,
                            contentType: String,
                            size: Integer64,
                            storageRef: String,
                            metadata: LargeString, // JSON
                            sessionId: UUID,
                            contractAddress: String,
                            compiledArtifactRef: String, // optional, default 'attestation-vault'
                            idempotencyKey: String, // optional
                            sponsorSessionId: UUID // optional
    )                                                                         returns {
        jobId      : UUID;
        status     : String;
        documentId : UUID;
        attesterId : Hex64;
    };

    /** Checks a hash against a recorded document. A mismatch or a record not yet on chain gives `verified: false`. */
    function verifyDocument(documentId: UUID,
                            providedSha256: Hex64,
                            contractAddress: String, // optional; needed only for rows without a stored contract
                            compiledArtifactRef: String // optional, default 'attestation-vault'
    )                                                                         returns {
        verified       : Boolean;
        included       : Boolean;
        stateChecked   : Boolean; // false means the answer comes from the local index, not from the contract state
        anchoredTxHash : String;
        anchoredAt     : Timestamp;
        originalSha256 : String; // empty unless the hash matches
    };

    // ---- Zero-knowledge proofs about document fields ----
    // The inputs come from prepareDocumentProof: payloadHash, contentRoot, schemaId, fieldKey, fieldSalt, siblings, dirs.
    // A contentRoot passed here is recorded on chain first, under the session's own attester only.

    /** Proofs created by the issue* actions. `provenTxHash` and `provenAt` are set once the proof is on chain. */
    @readonly
    entity PredicateAttestations as projection on midnight.PredicateAttestations;

    // ---- Proof input types ----

    /** A field of a document to make provable. Its position in the list is its slot. */
    type ProofField {
        field : String; // path into the document, dots descend; a top-level key containing dots wins
        @assert.range
        kind  : String enum {
            uint;
            bytes;
        }; // default uint
        @assert.range: [1, 1000000000]
        scale : Integer; // uint only; default 1000
    }

    /** One prepared field: the inputs of a single-field proof. `salt` is the proof actions' `fieldSalt`. */
    type PreparedField {
        field       : String;
        fieldKey    : Hex64;
        kind        : String enum {
            uint;
            bytes;
        };
        value       : String; // decimal integer, scaled; uint only
        valueDigest : Hex64; // blake2b-256 of the exact string; bytes only
        salt        : Hex64;
        siblings    : array of Hex64;
        dirs        : array of Boolean;
    }

    /** One slot of the schema a document was prepared with. The comparison circuit recomputes the schema id from the list. */
    type SchemaSlot {
        fieldKey : Hex64;
        @assert.range: [0, 2]
        kind     : Integer; // 0 = uint, 1 = bytes, 2 = padding
        scale    : String; // decimal integer; 0 for bytes and padding
    }

    /** A document's private value of one slot. */
    type SlotOpening {
        present     : Boolean;
        value       : String; // decimal integer, scaled; uint only
        valueDigest : Hex64; // blake2b-256 of the exact string; bytes only
    }

    /** A document's private inputs for the comparison circuits. Store it; without it nothing can be proven about the root. */
    type DocumentOpening {
        saltSeed : Hex64;
        slots    : array of SlotOpening; // one per slot of the width
    }

    /** One claim of a batch: the inputs of the single action selected by `predicate`. */
    type BatchClaim {
        @assert.range
        predicate      : String enum {
            lessOrEqual;
            greaterOrEqual;
            bytesEquality;
            setMembership;
            documentIntegrity;
            documentDiff;
        };
        fieldKey       : Hex64; // all but the document kinds
        salt           : Hex64; // all but the document kinds
        siblings       : array of Hex64; // all but the document kinds
        dirs           : array of Boolean; // all but the document kinds
        unit           : String; // optional
        value          : String; // numeric: decimal integer, scaled; setMembership: the exact string
        threshold      : Integer64; // numeric; scaled like the value
        expectedValue  : String; // bytesEquality; one of expectedValue, expectedDigest
        expectedDigest : Hex64; // bytesEquality
        valueDigest    : Hex64; // setMembership; one of value, valueDigest
        allowedValues  : array of String; // setMembership; or setRoot with its path
        setRoot        : Hex64; // setMembership
        setSiblings    : array of Hex64; // setMembership; 6 entries
        setDirs        : array of Boolean; // setMembership; 6 entries
        payloadHashB   : Hex64; // document kinds
        attesterIdB    : Hex64; // document kinds; optional, default the batch attester
        allowedMask    : Integer64; // documentIntegrity; bit i set = slot i may differ
        k              : Integer; // documentDiff; minimum number of differing slots
        schema         : array of SchemaSlot; // document kinds
        openingA       : DocumentOpening; // document kinds
        openingB       : DocumentOpening; // document kinds
    }

    /** One claim of a batch as recorded, with its `PredicateAttestations` row. */
    type IssuedClaim {
        predicateAttestationId : UUID;
        predicate              : String;
        fieldKey               : Hex64;
        threshold              : Integer64;
        unit                   : String;
        expectedDigest         : Hex64;
        setRoot                : Hex64;
        payloadHashB           : Hex64;
        allowedMask            : Integer64;
        k                      : Integer;
    }

    /** Proves that a numeric document field is at most or at least `threshold`, without revealing the value. */
    action   issueFieldPredicateAttestation(payloadHash: Hex64,
                                            attesterId: Hex64, // optional, default the session's attester
                                            fieldKey: Hex64,
                                            value: String, // decimal integer, scaled like the prepared field
                                            fieldSalt: Hex64,
                                            contentRoot: Hex64, // optional
                                            schemaId: Hex64, // required with contentRoot
                                            siblings: array of Hex64, // inclusion path; one entry per tree level
                                            dirs: array of Boolean, // inclusion path; one entry per tree level
                                            @assert.range
                                            predicate: String enum {
                                                lessOrEqual;
                                                greaterOrEqual;
                                            },
                                            threshold: Integer64, // scaled like the value
                                            unit: String, // optional
                                            sessionId: UUID,
                                            contractAddress: String,
                                            compiledArtifactRef: String, // optional, default 'attestation-vault'
                                            idempotencyKey: String, // optional
                                            sponsorSessionId: UUID, // optional
                                            validUntil: Integer64 // UNIX seconds; optional, default one year from now; at most five years
    )                                                                         returns {
        jobId                  : UUID;
        status                 : String;
        predicateAttestationId : UUID;
    };

    /** Proves up to 8 claims about one document in a single transaction, 7 if `contentRoot` is given.
     * Each entry in `claims` has the inputs of the matching single action, selected by `predicate`.
     * If only part of the transaction succeeds on chain, the job fails. Then verify each claim on its own. */
    action   issueFieldPredicateAttestationBatch(payloadHash: Hex64,
                                                 attesterId: Hex64, // optional, default the session's attester
                                                 contentRoot: Hex64, // optional
                                                 schemaId: Hex64, // required with contentRoot
                                                 claims: array of BatchClaim,
                                                 sessionId: UUID,
                                                 contractAddress: String,
                                                 compiledArtifactRef: String, // optional, default 'attestation-vault'
                                                 idempotencyKey: String, // optional
                                                 sponsorSessionId: UUID, // optional
                                                 validUntil: Integer64 // UNIX seconds; optional, default one year from now; at most five years
    )                                                                         returns {
        jobId             : UUID;
        status            : String;
        claims            : array of IssuedClaim;
        droppedDuplicates : Integer;
    };

    /** Proves that a text field holds exactly the value behind `expectedDigest`.
     * This proves authenticity, not secrecy. A short or common value can be guessed from its digest. */
    action   issueFieldEqualityAttestation(payloadHash: Hex64,
                                           attesterId: Hex64, // optional, default the session's attester
                                           fieldKey: Hex64,
                                           expectedValue: String,
                                           expectedDigest: Hex64, // optional; blake2b-256 of expectedValue
                                           fieldSalt: Hex64,
                                           contentRoot: Hex64, // optional
                                           schemaId: Hex64, // required with contentRoot
                                           siblings: array of Hex64, // inclusion path; one entry per tree level
                                           dirs: array of Boolean, // inclusion path; one entry per tree level
                                           sessionId: UUID,
                                           contractAddress: String,
                                           compiledArtifactRef: String, // optional, default 'attestation-vault'
                                           idempotencyKey: String, // optional
                                           sponsorSessionId: UUID, // optional
                                           validUntil: Integer64 // UNIX seconds; optional, default one year from now; at most five years
    )                                                                         returns {
        jobId                  : UUID;
        status                 : String;
        predicateAttestationId : UUID;
    };

    /** Proves that a hidden text field is one of up to 64 allowed values.
     * Pass the allowed values as `allowedValues`, or the set from prepareMembershipSet as `setRoot` with its path. */
    action   issueFieldMembershipAttestation(payloadHash: Hex64,
                                             attesterId: Hex64, // optional, default the session's attester
                                             fieldKey: Hex64,
                                             value: String,
                                             valueDigest: Hex64, // optional; blake2b-256 of value
                                             allowedValues: array of String, // or setRoot with its path
                                             setRoot: Hex64,
                                             setSiblings: array of Hex64, // 6 entries
                                             setDirs: array of Boolean, // 6 entries
                                             fieldSalt: Hex64,
                                             contentRoot: Hex64, // optional
                                             schemaId: Hex64, // required with contentRoot
                                             siblings: array of Hex64, // inclusion path; one entry per tree level
                                             dirs: array of Boolean, // inclusion path; one entry per tree level
                                             sessionId: UUID,
                                             contractAddress: String,
                                             compiledArtifactRef: String, // optional, default 'attestation-vault'
                                             idempotencyKey: String, // optional
                                             sponsorSessionId: UUID, // optional
                                             validUntil: Integer64 // UNIX seconds; optional, default one year from now; at most five years
    )                                                                         returns {
        jobId                  : UUID;
        status                 : String;
        predicateAttestationId : UUID;
    };

    /** Proves that document B differs from document A only in the fields allowed by `allowedMask`, without revealing values.
     * Both documents must be prepared with the same field list. The order of A and B is part of the proof. */
    action   issueDocumentIntegrityAttestation(payloadHashA: Hex64,
                                               payloadHashB: Hex64,
                                               attesterIdA: Hex64, // optional, default the session's attester
                                               attesterIdB: Hex64, // optional, default attesterIdA
                                               allowedMask: Integer64, // bit i set = field i may differ
                                               schema: array of SchemaSlot, // `schema` from prepareDocumentProof
                                               openingA: DocumentOpening, // `opening` from prepareDocumentProof
                                               openingB: DocumentOpening,
                                               contentRootA: Hex64, // optional
                                               contentRootB: Hex64, // optional
                                               schemaId: Hex64, // required with contentRootA or contentRootB
                                               sessionId: UUID,
                                               contractAddress: String,
                                               compiledArtifactRef: String, // optional, default 'attestation-vault'
                                               idempotencyKey: String, // optional
                                               sponsorSessionId: UUID, // optional
                                               validUntil: Integer64 // UNIX seconds; optional, default one year from now; at most five years
    )                                                                         returns {
        jobId                  : UUID;
        status                 : String;
        predicateAttestationId : UUID;
    };

    /** Proves that at least `k` fields differ between two documents, without revealing which.
     * A field present in only one document counts as different. Inputs work as in issueDocumentIntegrityAttestation. */
    action   issueDocumentDiffAttestation(payloadHashA: Hex64,
                                          payloadHashB: Hex64,
                                          attesterIdA: Hex64, // optional, default the session's attester
                                          attesterIdB: Hex64, // optional, default attesterIdA
                                          k: Integer, // 1 to the number of fields; minimum number of differing fields
                                          schema: array of SchemaSlot, // `schema` from prepareDocumentProof
                                          openingA: DocumentOpening, // `opening` from prepareDocumentProof
                                          openingB: DocumentOpening,
                                          contentRootA: Hex64, // optional
                                          contentRootB: Hex64, // optional
                                          schemaId: Hex64, // required with contentRootA or contentRootB
                                          sessionId: UUID,
                                          contractAddress: String,
                                          compiledArtifactRef: String, // optional, default 'attestation-vault'
                                          idempotencyKey: String, // optional
                                          sponsorSessionId: UUID, // optional
                                          validUntil: Integer64 // UNIX seconds; optional, default one year from now; at most five years
    )                                                                         returns {
        jobId                  : UUID;
        status                 : String;
        predicateAttestationId : UUID;
    };

    /** Checks a stored proof row against the contract on chain. An unproven or expired proof gives `verified: false`. */
    function verifyPredicateAttestation(predicateAttestationId: UUID)         returns {
        verified       : Boolean;
        included       : Boolean;
        stateChecked   : Boolean; // false means the answer comes from the local index, not from the contract state
        predicate      : String;
        threshold      : Integer64; // for 'documentDiff' this is k
        unit           : String;
        expectedDigest : String;
        setRoot        : String;
        payloadHashB   : String;
        allowedMask    : Integer64;
        provenTxHash   : String;
        provenAt       : Timestamp;
    };

    /** Checks on chain whether an attester has attested a payload hash.
     * Only the attester vouches for its attestation, so check `attesterId` against attesters you trust.
     * If nothing is found, the result is `verified: false`, not an error. */
    function verifyAttestationState(contractAddress: String,
                                    attesterId: Hex64,
                                    payloadHash: Hex64,
                                    documentId: Hex64, // instead of attesterId and payloadHash
                                    contentRoot: Hex64, // optional; must match the stored content root
                                    schemaId: Hex64, // optional; must match the stored schema id
                                    compiledArtifactRef: String, // optional, default 'attestation-vault'
                                    network: String // optional, default the server's network; e.g. 'preprod'
    )                                                                         returns {
        verified          : Boolean;
        attested          : Boolean; // the payload hash is attested
        contentRootOk     : Boolean; // contentRoot matches
        schemaOk          : Boolean; // schemaId matches
        bindingRegistered : Boolean; // documentId belongs to this attester
        attesterId        : String;
        payloadHash       : String;
        recordKey         : String; // the key the attestation is stored under on chain
        documentId        : String;
    };

    /** Checks on chain whether a proof about a document field was recorded as true.
     * The inputs must be exactly those of the proof, otherwise the result is `verified: false`.
     * For a comparison of two documents, A and B must be in the same order as when proving. */
    function verifyPredicateState(contractAddress: String,
                                  attesterId: Hex64,
                                  payloadHash: Hex64, // document A when comparing two documents
                                  fieldKey: Hex64, // required for single-field predicates
                                  @assert.range
                                  predicate: String enum {
                                      lessOrEqual;
                                      greaterOrEqual;
                                      bytesEquality;
                                      setMembership;
                                      documentIntegrity;
                                      documentDiff;
                                  },
                                  threshold: Integer64, // required for numeric predicates; the scaled integer used when proving
                                  expectedDigest: Hex64, // required for 'bytesEquality'
                                  setRoot: Hex64, // required for 'setMembership'
                                  payloadHashB: Hex64, // required when comparing two documents; document B
                                  attesterIdB: Hex64, // optional, default attesterId; attester of document B
                                  allowedMask: Integer64, // required for 'documentIntegrity'; bit i set = field i may differ
                                  k: Integer, // required for 'documentDiff'; minimum number of differing fields
                                  compiledArtifactRef: String, // optional, default 'attestation-vault'
                                  network: String // optional, default the server's network; e.g. 'preprod'
    )                                                                         returns {
        verified : Boolean;
        proven   : Boolean; // the proof is recorded on chain as true
    };

    // ---- Disclosure ----

    /** Disclosure grants read from the contract on chain. `level` is 0 public, 1 legitimate interest, 2 authority. */
    @readonly
    entity DisclosureGrants      as projection on midnight.DisclosureGrants;

    /** Updates `DisclosureGrants` from the contract on chain, e.g. after a grant submitted outside this server. */
    action   reindexDisclosures(contractAddress: String,
                                compiledArtifactRef: String // optional, default 'attestation-vault'
    )                                                                         returns {
        contractAddress : String;
        active          : Integer;
        deactivated     : Integer;
        reconciledAt    : Timestamp;
    };

    /** Grants `grantee` a disclosure level on an attestation. Only the attester can grant. */
    action   grantDisclosure(payloadHash: Hex64,
                             grantee: Hex64,
                             level: Integer, // 0 public, 1 legitimate interest, 2 authority
                             sessionId: UUID,
                             contractAddress: String,
                             compiledArtifactRef: String, // optional, default 'attestation-vault'
                             idempotencyKey: String, // optional
                             sponsorSessionId: UUID // optional
    )                                                                         returns {
        jobId             : UUID;
        status            : String;
        disclosureGrantId : UUID;
    };

    /** Removes a grantee's disclosure on chain. Only the attester can revoke. */
    action   revokeDisclosure(payloadHash: Hex64,
                              grantee: Hex64,
                              sessionId: UUID,
                              contractAddress: String,
                              compiledArtifactRef: String, // optional, default 'attestation-vault'
                              idempotencyKey: String, // optional
                              sponsorSessionId: UUID // optional
    )                                                                         returns {
        jobId  : UUID;
        status : String;
    };

    /** Manages which attester may attest a document id. Modes 0 to 2 need the registrar's session, modes 3 and 4 the recovery identity's.
     * Mode 0 assigns `documentId` to `ownerId` and removes a previous owner's binding. Mode 1 removes the assignment.
     * Mode 2 hands the registrar role to `ownerId`. Mode 3 sets a new registrar. Mode 4 hands the recovery role to `ownerId`. */
    action   registerPassport(documentId: Hex64,
                              passportId: Hex64, // optional; default documentId
                              ownerId: Hex64,
                              mode: Integer, // optional, default 0
                              sessionId: UUID,
                              contractAddress: String,
                              compiledArtifactRef: String, // optional, default 'attestation-vault'
                              idempotencyKey: String, // optional
                              sponsorSessionId: UUID // optional
    )                                                                         returns {
        jobId  : UUID;
        status : String;
    };

    /** Withdraws an attestation. Only its attester can do this.
     * Its stored content root, disclosure grants and document binding are removed too, so proofs about the document stop verifying. */
    action   retractAttestation(payloadHash: Hex64,
                                sessionId: UUID,
                                contractAddress: String,
                                compiledArtifactRef: String, // optional, default 'attestation-vault'
                                idempotencyKey: String, // optional
                                sponsorSessionId: UUID // optional
    )                                                                         returns {
        jobId  : UUID;
        status : String;
    };

    /** Removes an expired proof from the contract. Anyone can call it. */
    action   purgeExpired(@assert.range
                          kind: String enum {
                              claim;
                          },
                          key: Hex64,
                          sessionId: UUID,
                          contractAddress: String,
                          compiledArtifactRef: String, // optional, default 'attestation-vault'
                          idempotencyKey: String, // optional
                          sponsorSessionId: UUID // optional
    )                                                                         returns {
        jobId  : UUID;
        status : String;
    };

    /** Links between users and the grantee ids that disclosure grants name. */
    @readonly
    entity GranteeIdentities     as projection on midnight.GranteeIdentities;

    /** Links the caller to a grantee id, the id that disclosure grants name.
     * `bindingInput` depends on the server setting `cds.requires.nightgate.granteeBinding`.
     * It is the wallet's coin public key for 'wallet' (default), a DID for 'did', or the 64 hex id for 'custom'. */
    action   registerGranteeIdentity(bindingInput: String,
                                     scope: String // optional, default a global link
    )                                                                         returns {
        ID          : UUID;
        granteeId   : String;
        bindingKind : String;
    };

    // ---- Contracts ----

    /** Deploys a contract known to the server. */
    action   deployContract(compiledArtifactRef: String,
                            sessionId: UUID,
                            initialPrivateState: Map, // optional, default {}
                            idempotencyKey: String, // optional
                            sponsorSessionId: UUID, // optional
                            recoveryId: Hex64 // optional; the attester that may use registerPassport modes 3 and 4
    )                                                                         returns {
        jobId  : UUID;
        status : String;
    };

    /** Calls a circuit on a deployed contract.
     * `initialPrivateState` is used only if the wallet has no private state for the contract yet.
     * A sponsor session must be your own signing session or a platform fee sponsor. */
    action   submitContractCall(contractAddress: String,
                                circuit: String,
                                compiledArtifactRef: String,
                                sessionId: UUID,
                                args: LargeString, // JSON array
                                idempotencyKey: String, // optional
                                initialPrivateState: Map, // optional, default {}
                                sponsorSessionId: UUID // optional
    )                                                                         returns {
        jobId  : UUID;
        status : String;
    };

    /** Builds, proves and signs a contract call as the caller, without paying the fee and without submitting it.
     * A sponsor then submits the result with sponsorFinalizedTransaction. */
    action   buildSponsorable(contractAddress: String,
                              circuit: String,
                              compiledArtifactRef: String,
                              sessionId: UUID,
                              args: LargeString)                              returns {
        jobId  : UUID;
        status : String;
    };

    /** Pays the fee for a signed transaction built by someone else and submits it.
     * The sponsor only pays for contracts and circuits its policy allows. */
    action   sponsorFinalizedTransaction(finalizedTxB64: LargeString,
                                         idempotencyKey: String)              returns { // optional
        jobId     : UUID;
        status    : String;
        sessionId : UUID; // pass it to getJobStatus
    };

    /** Pays the fee for a signed transaction that is not yet sealed and submits it.
     * Such a transaction comes from the transaction builder with `bind: false`. One sponsor can pay several at once. */
    action   sponsorUnboundTransaction(unboundTxB64: LargeString,
                                       idempotencyKey: String)                returns { // optional
        jobId     : UUID;
        status    : String;
        sessionId : UUID; // pass it to getJobStatus
    };

    /** Pays the fee for a shielded token swap and submits it.
     * The swap comes as two matching halves, each an offer file (`swapoffer1...`) or base64.
     * Both token types must be allowed for the sponsor, and the server needs `NIGHTGATE_SPONSOR_ALLOW_SWAPS`. */
    action   sponsorSwap(makerHalfB64: LargeString, // required unless offerId is given
                         takerHalfB64: LargeString,
                         idempotencyKey: String, // optional
                         offerId: UUID, // optional; a posted offer to use as the maker half
                         takerSecret: String)                                 returns { // optional; required to take a directed offer
        jobId     : UUID;
        status    : String;
        sessionId : UUID; // pass it to getJobStatus
    };

    /**
     * Pays the fee for a plain shielded transfer the caller built and submits it. Recipient and amount are hidden: `tokenType` and `amount` are the caller's statement.
     */
    action   sponsorTransfer(transferTxB64: LargeString, // base64; bound or unbound
                             tokenType: Hex64, // the type moved; must be in the effective allowedTokenTypes
                             amount: String, // decimal; atoms the recipient receives
                             idempotencyKey: String)                          returns { // optional
        jobId     : UUID;
        status    : String;
        sessionId : UUID; // pass it to getJobStatus
    };

    // ---- Swap offer board ----

    /** Posts one half of a swap so that others can find it and complete the swap. Posting holds or moves nothing.
     * The offer closes when a sponsored swap uses it, when it expires or when the poster retires it. */
    action   postSwapOffer(offer: LargeString, // offer file or base64
                           expiresAt: Timestamp, // optional
                           tags: array of String, // up to 8; optional
                           takerSecretHash: Hex64)                            returns { // optional; sha256 of the taker secret
        offerId     : UUID;
        status      : String;
        bound       : Boolean; // the half is already sealed
        givesType   : String;
        givesAmount : String;
        wantsType   : String;
        wantsAmount : String;
        expiresAt   : Timestamp;
        directed    : Boolean; // only the holder of the taker secret can take it
    };

    /** Lists offers, by default the open ones, newest first.
     * With `status: 'all'` and `since`, polling returns every change since the last call.
     * With `waitMs` the call holds while nothing matches, until an offer matches or the time is up, so one call replaces many polls. */
    function listSwapOffers(givesType: Hex64, // optional
                            wantsType: Hex64, // optional
                            tag: String, // optional
                            limit: Integer, // optional, default 50, at most 200
                            status: String, // optional, default 'open'; 'filled' | 'retired' | 'expired' | 'all'
                            since: Timestamp, // optional
                            mine: Boolean, // optional; only the caller's own offers
                            waitMs: Integer // ms; optional, at most 25000; hold the call until there is something to return
    )                                                                         returns array of {
        offerId      : UUID;
        offer        : LargeString;
        bound        : Boolean; // the half is already sealed
        givesType    : String;
        givesAmount  : String;
        wantsType    : String;
        wantsAmount  : String;
        tags         : many String;
        expiresAt    : Timestamp;
        postedAt     : Timestamp;
        status       : String; // open | filled | retired | expired
        filledTxHash : String;
        closedAt     : Timestamp;
        changedAt    : Timestamp;
        directed     : Boolean; // only the holder of the taker secret can take it
    };

    /** One offer by id, open or closed. An unknown id gives 404. */
    function getSwapOffer(offerId: UUID)                                      returns {
        offerId      : UUID;
        offer        : LargeString;
        bound        : Boolean; // the half is already sealed
        givesType    : String;
        givesAmount  : String;
        wantsType    : String;
        wantsAmount  : String;
        tags         : many String;
        expiresAt    : Timestamp;
        postedAt     : Timestamp;
        status       : String; // open | filled | retired | expired
        filledTxHash : String;
        closedAt     : Timestamp;
        changedAt    : Timestamp;
        directed     : Boolean; // only the holder of the taker secret can take it
    };

    /** Closes an open offer. Only the user or agent token that posted it can do this. An offer already closed answers its status. */
    action   retireSwapOffer(offerId: UUID)                                   returns {
        offerId : UUID;
        status  : String; // retired; expired | filled when the offer was closed before the call
    };

    // ---- Disclosure to token holders ----

    /** Lets every holder of `tokenType` read a document. Holders prove their holding through the registry at `registryAddress`.
     * `content` is stored encrypted and must hash to `payloadHash`, as blake2b-256 or sha256 of the UTF-8 text. */
    action   grantDisclosureToHolders(payloadHash: Hex64,
                                      tokenType: Hex64,
                                      registryAddress: String,
                                      content: LargeString, // optional
                                      contentType: String, // optional, default 'text/plain'
                                      expiresAt: Timestamp)                   returns { // optional
        holderGrantId   : UUID;
        payloadHash     : String;
        tokenType       : String;
        registryAddress : String;
        hasContent      : Boolean;
        expiresAt       : Timestamp;
        status          : String;
    };

    /** Revokes a holder disclosure. Only its grantor can do this. */
    action   revokeHolderDisclosure(holderGrantId: UUID)                      returns {
        holderGrantId : UUID;
        status        : String;
    };

    /** Proves a token holding and returns what the issuer disclosed to holders.
     * `claimSecret` is the secret used when registering in the holder registry. Without entitlement the result is `entitled: false`. */
    action   claimDisclosure(payloadHash: Hex64,
                             tokenType: Hex64,
                             claimSecret: Hex64)                              returns {
        entitled        : Boolean;
        reason          : String;
        payloadHash     : String;
        tokenType       : String;
        registryAddress : String;
        holderGrantId   : UUID;
        contentType     : String;
        contentHashKind : String;
        content         : LargeString;
        expiresAt       : Timestamp;
        /** The registries that were checked, for a negative answer. */
        registries      : array of String;
    };

    // ---- Batches and tokens ----

    /** Runs up to 8 circuit calls on one contract in a single transaction, in the given order.
     * Calls to the same circuit have no fixed order among themselves.
     * If only part of the transaction succeeds on chain, the job fails. */
    action   submitContractCallBatch(contractAddress: String,
                                     calls: LargeString, // JSON array of { circuit, args }
                                     compiledArtifactRef: String,
                                     sessionId: UUID,
                                     idempotencyKey: String, // optional
                                     initialPrivateState: Map, // optional, default {}
                                     sponsorSessionId: UUID, // optional
                                     independentCalls: Boolean // optional; true lets the server reorder calls that do not depend on each other
    )                                                                         returns {
        jobId  : UUID;
        status : String;
    };

    /** Mints a token on a token factory contract and sends it to a shielded address.
     * The session is the issuer, so the same `name` from another session is a different token. */
    action   mintFactoryToken(contractAddress: String, // optional; default NIGHTGATE_TOKEN_FACTORY_CONTRACT
                              name: String, // UTF-8, at most 32 bytes
                              amount: String,
                              recipientCoinPublicKey: Hex64,
                              sessionId: UUID, // optional for a token caller; default the session that pays its sponsored jobs
                              idempotencyKey: String, // optional
                              sponsorSessionId: UUID)                         returns { // optional
        jobId     : UUID;
        status    : String;
        name      : String;
        amount    : String;
        issuerKey : String;
        domain    : String;
        tokenType : Hex64;
    };

    /** Burns `amount` of a factory token the session holds; `issuerKey` names the issuer, default the session's own. */
    action   burnFactoryToken(contractAddress: String, // optional; default NIGHTGATE_TOKEN_FACTORY_CONTRACT
                              name: String, // UTF-8, at most 32 bytes
                              amount: String,
                              issuerKey: Hex64, // optional; default the session's own issuer key
                              sessionId: UUID,
                              idempotencyKey: String, // optional
                              sponsorSessionId: UUID)                         returns { // optional
        jobId     : UUID;
        status    : String;
        name      : String;
        amount    : String;
        issuerKey : String;
        domain    : String;
        tokenType : Hex64;
    };

    /** Mints 100000000 units of the bundled test token to the caller's shielded address. */
    action   mintShieldedTestToken(contractAddress: String,
                                   sessionId: UUID,
                                   compiledArtifactRef: String, // optional, default 'shielded-token'
                                   idempotencyKey: String, // optional
                                   sponsorSessionId: UUID // optional
    )                                                                         returns {
        jobId  : UUID;
        status : String;
    };

    /** Computes the token type a contract mints, for use as `tokenTypeHex` in sendNight. */
    function deriveTokenType(contractAddress: String,
                             domainSeparator: String // text or 64 hex; optional, default the bundled test token's
    )                                                                         returns {
        tokenTypeHex    : String;
        contractAddress : String;
        domainSeparator : Hex64;
    };

    // ---- Wallet sessions ----

    @readonly
    entity WalletSessions        as
        projection on midnight.WalletSessions
        excluding {
            viewingKeyHash,
            encryptedViewingKey,
            encryptedSeedKey
        };

    /** Creates a read-only wallet session. The viewing key is stored encrypted. */
    action   connectWallet(viewingKey: String,
                           label: String // at most 100 characters; optional
    )                                                                         returns {
        ID          : UUID;
        sessionId   : UUID;
        label       : String;
        connectedAt : Timestamp;
        expiresAt   : Timestamp;
        isActive    : Boolean;
    };

    /** Closes a session and deletes its stored keys. */
    action   disconnectWallet(sessionId: UUID);

    /** Lets a session sign transactions. The seed is stored encrypted and must belong to the session's viewing key.
     * Keys are derived from the seed the same way the Lace wallet does, so the addresses match Lace.
     * The wallet then syncs with the chain in the background, tracked by `prewarmJobId`. */
    action   connectWalletForSigning(sessionId: UUID,
                                     mnemonic: String, // BIP39 phrase; required unless seedHex is given
                                     seedHex: String, // 128 hex; optional
                                     accountIndex: Integer, // optional, default 0
                                     idempotencyKey: String, // optional
                                     prewarm: Boolean // optional, default true; false syncs only when needed
    )                                                                         returns {
        sessionId      : UUID;
        signingEnabled : Boolean;
        prewarmJobId   : UUID;
        prewarmStatus  : String;
    };

    /** Derives a wallet's viewing key, addresses and attester id from a mnemonic or seed. Stores nothing. */
    action   deriveWalletInfo(mnemonic: String, // BIP39 phrase; required unless seedHex is given
                              seedHex: String, // 128 hex; optional
                              accountIndex: Integer // optional, default 0
    )                                                                         returns {
        viewingKey      : Hex64;
        shieldedAddress : String;
        nightAddress    : String;
        dustAddress     : String;
        attesterId      : Hex64;
        accountIndex    : Integer;
        network         : String;
    };

    /** Registers the wallet's NIGHT coins so they generate DUST, the resource that pays transaction fees. */
    action   registerForDustGeneration(sessionId: UUID,
                                       dustReceiverAddress: String, // optional, default the wallet's own DUST address
                                       idempotencyKey: String // optional
    )                                                                         returns {
        jobId  : UUID;
        status : String;
    };

    /** Stops DUST generation for all of the wallet's NIGHT coins. */
    action   deregisterFromDustGeneration(sessionId: UUID,
                                          idempotencyKey: String, // optional
                                          sponsorSessionId: UUID // optional
    )                                                                         returns {
        jobId  : UUID;
        status : String;
    };

    /** Sends NIGHT, or the token `tokenTypeHex`, to an address.
     * An `mn_shield-addr_` address is paid from the shielded balance, an `mn_addr_` address from the unshielded one. */
    action   sendNight(sessionId: UUID,
                       receiverAddress: String,
                       amount: String,
                       ttlIso: String, // ISO 8601; optional, default 10 minutes from now
                       idempotencyKey: String, // optional
                       tokenTypeHex: Hex64 // optional, default NIGHT
    )                                                                         returns {
        jobId  : UUID;
        status : String;
    };

    /** Wallet balances. */
    function getWalletBalance(sessionId: UUID)                                returns {
        shieldedNight            : String;
        unshieldedNight          : String;
        shieldedTokens           : array of {
            tokenType : Hex64;
            amount    : String;
        };
        dustBalance              : String;
        registeredNightUtxoCount : Integer;
        totalNightUtxoCount      : Integer;
        dustUtxoCount            : Integer;
        dustPendingCount         : Integer;
        dustPendingValue         : String;
        dustRestoreCount         : Integer;
    };

    /** How far the wallet has caught up with the chain. The sync is stuck when `appliedIndex` stops growing. */
    function getWalletSyncProgress(sessionId: UUID)                           returns {
        known                : Boolean;
        caughtUp             : Boolean;
        appliedIndex         : String;
        streamTip            : String;
        behindEvents         : String;
        eventsPerSecond      : Decimal;
        etaSeconds           : Integer;
        blockHeight          : String;
        isConnected          : Boolean;
        indexerFresh         : Boolean;
        indexerTipAgeSeconds : Integer;
        indexerError         : String;
        elapsedMs            : Integer;
        phase                : String; // e.g. 'prewarm' or 'balance'
        updatedAt            : Timestamp;
        lastProgressAt       : Timestamp;
        staleSeconds         : Integer;
        stale                : Boolean; // no report for longer than NIGHTGATE_SYNC_PROGRESS_STALE_S, default 60 s
        jobId                : UUID; // the latest prewarm job
        jobStatus            : String;
        restoredFromSnapshot : Boolean; // false means the wallet syncs from the start
        snapshotSavedAt      : Timestamp;
        facadeBuildStartedAt : Timestamp;
        facadeBuiltAt        : Timestamp;
    };

    /** Health of each platform fee sponsor. Amounts are shown only to admins and the session owner. */
    function getSponsorPoolStatus()                                           returns array of {
        sessionId            : UUID;
        configured           : Boolean;
        usable               : Boolean;
        dustBalance          : String;
        unshieldedNight      : String;
        totalNightUtxoCount  : Integer;
        registeredNightUtxos : Integer;
        dustNotes            : Integer; // how many transactions the sponsor can pay at the same time
        pendingDustNotes     : Integer;
        dustRestoreCount     : Integer;
        caughtUp             : Boolean;
        stale                : Boolean; // the wallet did not answer, the figures are the last known ones
        asOf                 : Timestamp;
        lastError            : String;
    };

    /** Estimates the DUST fee of a sendNight without proving or submitting anything. */
    function estimateSendNightFee(sessionId: UUID,
                                  receiverAddress: String,
                                  amount: String,
                                  ttlIso: String, // ISO 8601; optional, default 10 minutes from now
                                  tokenTypeHex: Hex64 // optional, default NIGHT
    )                                                                         returns {
        fee      : String;
        toLedger : String;
    };

    // ---- Proof preparation, agent output, agent grants, jobs ----

    /** Prepares a JSON document for the proof actions. Nothing is stored.
     * Keep the field order of `proofFields` the same for every document of a kind.
     * Store `opening`. Without it no later proof about this document is possible. */
    action   prepareDocumentProof(document: Map, // the JSON document
                                  proofFields: array of ProofField, // at most 16 or 32 entries depending on the contract
                                  saltSeed: Hex64, // optional, default random
                                  compiledArtifactRef: String // optional, default 'attestation-vault'
    )                                                                         returns {
        payloadHash       : Hex64;
        canonicalDocument : LargeString; // the exact text that was hashed
        contentRoot       : Hex64;
        fields            : array of PreparedField;
        emptyFields       : array of String;
        schemaId          : Hex64;
        schema            : array of SchemaSlot;
        leaves            : array of Hex64; // salted leaf hashes in slot order
        opening           : DocumentOpening;
    };

    /** Builds the set of allowed values for issueFieldMembershipAttestation.
     * With `value` or `valueDigest` it also returns the path that proves the value is in the set. */
    action   prepareMembershipSet(allowedValues: array of String, // up to 64 distinct values
                                  value: String, // optional
                                  valueDigest: Hex64, // optional; blake2b-256 of value
                                  compiledArtifactRef: String // optional, default 'attestation-vault'
    )                                                                         returns {
        setRoot         : Hex64;
        memberCount     : Integer;
        setSiblings     : array of Hex64; // empty without value or valueDigest
        setDirs         : array of Boolean; // empty without value or valueDigest
    };

    /** Records on chain that an agent produced an output from an input, signed by the session's wallet.
     * Anyone can check it by hashing `envelopeJson` and calling verifyAttestationState. */
    action   attestAgentOutput(agentId: String, // at most 200 characters
                               inputHash: Hex64,
                               outputHash: Hex64,
                               modelId: String, // at most 200 characters; optional
                               policyHash: Hex64, // optional
                               producedAt: Timestamp, // optional, default now
                               storageRef: String, // optional, default 'agent-output://<agentId>'
                               sessionId: UUID,
                               contractAddress: String,
                               compiledArtifactRef: String, // optional, default 'attestation-vault'
                               idempotencyKey: String, // optional
                               sponsorSessionId: UUID // optional
    )                                                                         returns {
        jobId        : UUID;
        status       : String;
        documentId   : UUID;
        payloadHash  : Hex64;
        envelopeJson : LargeString;
    };

    /** The caller's agent grants. */
    @readonly
    entity AgentGrants           as
        projection on midnight.AgentGrants
        excluding {
            tokenHash
        };

    /** Creates a token that lets an agent act as the caller on one wallet session. The agent sends it in the `x-agent-token` header.
     * The agent may only call `allowedActions`, the verify functions and getJobStatus.
     * The allowed lists can only narrow what the platform's sponsor policy allows. */
    action   createAgentGrant(sessionId: UUID,
                              allowedActions: array of String,
                              maxJobsPerDay: Integer, // optional; default NIGHTGATE_GRANT_DEFAULT_JOBS_PER_DAY, else unlimited
                              maxJobsPerHour: Integer, // optional; default NIGHTGATE_GRANT_DEFAULT_JOBS_PER_HOUR, else unlimited
                              sponsorSessionId: UUID, // optional
                              validUntil: Timestamp, // optional, default no expiry
                              agentLabel: String, // optional
                              allowedContracts: array of String, // optional, default all the platform allows
                              allowedCircuits: array of String, // optional, default all the platform allows
                              allowDeploy: Boolean, // optional; the sponsor pays for deploys built by the agent, needs NIGHTGATE_SPONSOR_ALLOW_DEPLOY
                              maxDeploys: Integer, // optional, default 1 when allowDeploy is true
                              allowedTokenTypes: array of Hex64, // optional, default all the platform allows
                              allowUnshieldedOffers: Boolean, // optional; sponsored calls may pay the agent's own unshielded tokens in and the contract's payouts out, needs NIGHTGATE_SPONSOR_ALLOW_UNSHIELDED_OFFERS
                              allowedUnshieldedTokenTypes: array of Hex64, // optional, default all the platform allows besides NIGHT
                              maxValuePerDay: array of ValueBudget // optional, default no value limit
    )                                                                         returns {
        grantId                     : UUID;
        token                       : String; // shown only once
        allowedActions              : array of String;
        allowedContracts            : array of String;
        allowedCircuits             : array of String;
        allowDeploy                 : Boolean;
        maxDeploys                  : Integer;
        allowedTokenTypes           : array of String;
        allowUnshieldedOffers       : Boolean;
        allowedUnshieldedTokenTypes : array of String;
        maxValuePerDay              : array of ValueBudget;
        validUntil                  : Timestamp;
    };

    /** Creates up to 50 grants with the same settings, each with its own token.
     * Without `labels` they are named `<agentLabel>-1` to `<agentLabel>-n`. */
    action   createAgentGrants(count: Integer,
                               sessionId: UUID,
                               allowedActions: array of String,
                               labels: array of String, // optional; exactly count entries
                               maxJobsPerDay: Integer, // optional; default NIGHTGATE_GRANT_DEFAULT_JOBS_PER_DAY, else unlimited
                               maxJobsPerHour: Integer, // optional; default NIGHTGATE_GRANT_DEFAULT_JOBS_PER_HOUR, else unlimited
                               sponsorSessionId: UUID, // optional
                               validUntil: Timestamp, // optional, default no expiry
                               agentLabel: String, // optional
                               allowedContracts: array of String, // optional, default all the platform allows
                               allowedCircuits: array of String, // optional, default all the platform allows
                               allowDeploy: Boolean, // optional; the sponsor pays for deploys built by the agent, needs NIGHTGATE_SPONSOR_ALLOW_DEPLOY
                               maxDeploys: Integer, // optional, default 1 when allowDeploy is true
                               allowedTokenTypes: array of Hex64, // optional, default all the platform allows
                               allowUnshieldedOffers: Boolean, // optional; sponsored calls may pay the agent's own unshielded tokens in and the contract's payouts out, needs NIGHTGATE_SPONSOR_ALLOW_UNSHIELDED_OFFERS
                               allowedUnshieldedTokenTypes: array of Hex64, // optional, default all the platform allows besides NIGHT
                               maxValuePerDay: array of ValueBudget // optional, default no value limit
    )                                                                         returns {
        grants                      : array of {
            grantId    : UUID;
            token      : String; // shown only once
            agentLabel : String;
        };
        allowedActions              : array of String;
        allowedContracts            : array of String;
        allowedCircuits             : array of String;
        allowDeploy                 : Boolean;
        maxDeploys                  : Integer;
        allowedTokenTypes           : array of String;
        allowUnshieldedOffers       : Boolean;
        allowedUnshieldedTokenTypes : array of String;
        maxValuePerDay              : array of ValueBudget;
        validUntil                  : Timestamp;
    };

    /** Revokes a grant at once. A grant of another user gives 404. */
    action   revokeAgentGrant(grantId: UUID)                                  returns {
        revoked : Boolean;
    };

    /** Changes the given settings of a grant. */
    action   updateAgentGrant(grantId: UUID,
                              agentLabel: String,
                              allowedActions: array of String,
                              maxJobsPerDay: Integer,
                              maxJobsPerHour: Integer,
                              allowedContracts: array of String,
                              allowedCircuits: array of String,
                              allowedTokenTypes: array of String,
                              allowDeploy: Boolean,
                              maxDeploys: Integer,
                              allowUnshieldedOffers: Boolean,
                              allowedUnshieldedTokenTypes: array of String,
                              maxValuePerDay: array of ValueBudget,
                              validUntil: Timestamp)                          returns {
        grantId : UUID;
        updated : array of String;
    };

    /** Replaces a grant's token. The old token stops working at once. */
    action   rotateAgentGrantToken(grantId: UUID)                             returns {
        grantId : UUID;
        token   : String; // shown only once
    };

    /** What a grant did between `since` and `until` (default last 30 days, max 366) and its limits. A token may leave `grantId` empty. */
    function getGrantUsage(grantId: UUID, since: Timestamp, until: Timestamp) returns {
        grantId       : UUID;
        since         : Timestamp;
        until         : Timestamp;
        jobs          : array of {
            kind   : String;
            status : String;
            count  : Integer;
        };
        landed        : Integer; // transactions that succeeded on chain
        failed        : Integer;
        deploysUsed   : Integer;
        maxDeploys    : Integer;
        jobsUsedToday : Integer;
        maxJobsPerDay : Integer;
        dustPaid      : String;
        limits        : {
            jobsPerHour : Budget;
            jobsPerDay  : Budget;
            valuePerDay : array of ValueBudgetState;
            classes     : array of RateClassState;
        };
    };

    /** Returns the status of a background job. Poll until `status` is `succeeded` or `failed`.
     * `result` is the action's result as JSON. This is a POST but changes nothing.
     * With `waitMs` the call holds until the job settles or the time is up, so one call replaces many polls. */

    action   getJobStatus(jobId: UUID,
                          sessionId: UUID,
                          waitMs: Integer // ms; optional, at most 25000; hold the call until there is something to return
    )                                                                         returns {
        jobId               : UUID;
        kind                : String;
        status              : String; // pending | running | external_execution | submitted | reconciliation_required | succeeded | failed
        result              : LargeString;
        errorCode           : String;
        errorMessage        : LargeString;
        attempt             : Integer;
        maxAttempts         : Integer;
        submissionId        : UUID;
        txHash              : String; // hex; null before the build; the ledger identifier, same as transactionId
        transactionId       : String; // hex; null before the build; the ledger identifier, stable when the sponsor adds its fee
        transactionHash     : String; // hex; null until indexed; the transaction hash explorers show
        chainStatus         : String; // null | pending | success | failure | dropped
        chainFinalizedAt    : Timestamp;
        chainBlockHeight    : Integer;
        chainBlockHash      : String;
        chainSegments       : LargeString;
        queuedAt            : Timestamp;
        externalExecutionAt : Timestamp;
        submittedAt         : Timestamp;
        startedAt           : Timestamp;
        finishedAt          : Timestamp;
        receipt             : Receipt; // null until a sponsored swap or transfer succeeded on chain
    };
}

annotate NightgateService.Blocks with {
    hash   @title: 'Block Hash';
    height @title: 'Block Height';
};

annotate NightgateService.Transactions with {
    hash @title: 'Transaction Hash';
};

annotate NightgateService.ContractActions with {
    address @title: 'Contract Address';
};

annotate NightgateService.NightBalances with {
    address @title: 'Address';
    balance @title: 'NIGHT Balance';
};
