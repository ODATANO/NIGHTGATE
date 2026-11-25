using {midnight} from '../db/schema';
using {
    BackgroundJobChainStatus, BackgroundJobKind, BackgroundJobStatus, BigInt, ClaimPredicate, ContentHashKind, DustAddr, GranteeBinding,
    Hex64, Hex64List, HexEncoded, HexList, HolderGrantStatus, Network, NumericPredicate, ReceiverAddr, SeedHex, ShieldedAddr,
    StateSource, SwapOfferFilter, SwapOfferStatus, TransactionResultStatus, UnshieldedAddr
} from '../db/types';

/** Midnight chain data, attestations, zero-knowledge proofs, wallet sessions and transaction jobs.
 * Actions that write to the chain return a `jobId` to poll with `getJobStatus`. A retry with the same `idempotencyKey` returns the first job.
 * `sponsorSessionId` is a second session that pays the fee. Amounts are decimal strings in the smallest unit. */
@path    : '/odata/v4/midnight'
@requires: 'authenticated-user'
// Disclosure content is up to 1 MiB of text, which JSON escaping can lengthen. Express allows 100 KB without this.
@cds.server.body_parser.limit: '2mb'
service NightgateService {

    /** The ledger parameters in effect at a block. */
    type LedgerParametersSnapshot {
        height           : Integer64; // null = the chain tip
        ledgerParameters : LargeString not null; // base64
        coveredHeight    : Integer64; // the database holds every parameter change up to this block; null = supplement never ran
        chainHeight      : Integer64; // the chain tip the crawler last saw
    }

    @readonly
    entity Blocks                as
        projection on midnight.Blocks {
            *,
            parent,
            transactions
        }
        actions {
            // height: optional, default the chain tip. 404 when neither this server nor its indexer knows them.
            @cds.odata.bindingparameter.collection
            function ledgerParametersAt(height: Integer64) returns LedgerParametersSnapshot;
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
        excluding {
            identifiers,
            merkleTreeRoot,
            startIndex,
            endIndex
        }
        actions {
            // hash: the extrinsic hash or the ledger hash. One extrinsic hash can land in more than one block. Newest first, limit default 100.
            @cds.odata.bindingparameter.collection
            function byHash(hash: HexEncoded, @assert.range: [1, 5000] limit: Integer, @assert.range: [0, _] skip: Integer) returns array of Transactions;

            // txId: a ledger identifier of the transaction, hex. 404 while the indexer has not seen it.
            @cds.odata.bindingparameter.collection
            function byTxId(txId: HexEncoded)               returns TransactionInclusion;

            // hash: the extrinsic hash or the ledger hash. 404 while not indexed or when the row carries no ledger transaction.
            @cds.odata.bindingparameter.collection
            function ledgerTransaction(hash: HexEncoded)    returns TransactionLedgerBytes;
        };

    /** The serialized ledger transaction inside a transaction's extrinsic. */
    type TransactionLedgerBytes {
        extrinsicHash     : Hex64;
        ledgerTransaction : String; // base64
    }

    /** Where a transaction landed. `status` is null until the indexer supplement has the result. */
    type TransactionInclusion {
        txId           : HexEncoded;
        extrinsicHash  : Hex64;
        txHash         : Hex64;
        blockHeight    : Integer64;
        blockHash      : Hex64;
        status         : TransactionResultStatus;
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
        name          : String; // prove | deploy | sponsor | compute | read | query | verify
        windowSeconds : Integer;
        max           : Integer;
        remaining     : Integer;
    }

    /** Most atoms of one token type a grant may move per UTC day through sponsored swaps, transfers and mints. */
    type ValueBudget {
        tokenType : Hex64;
        amount    : BigInt; // decimal; atoms
    }

    /** One value budget of a grant as it stands today. */
    type ValueBudgetState {
        tokenType : Hex64;
        max       : BigInt; // decimal; atoms
        used      : BigInt; // decimal; atoms
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
        };

    @readonly
    entity ContractBalances      as projection on midnight.ContractBalances;

    /** The state of a contract at a block. `state` and `zswapState` are base64. */
    type ContractStateSnapshot {
        contractAddress  : HexEncoded;
        height           : Integer64; // null if not known locally
        state            : LargeString;
        zswapState       : LargeString;
        stateHash        : Hex64;
        zswapStateHash   : Hex64;
        source           : StateSource;
        verified         : Boolean; // only for source indexer: the state matches the hash stored on chain
        blockHash        : Hex64; // the block the state comes from
        ledgerParameters : LargeString; // base64; in effect at the requested height, default the chain tip; null = not known to this server
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
            function stateAt(contractAddress: HexEncoded, height: Integer64) returns ContractStateSnapshot;
        };

    @readonly
    entity UnshieldedUtxos       as
        projection on midnight.UnshieldedUtxos {
            *,
            createdAtTransaction,
            spentAtTransaction
        };

    @readonly
    entity ZswapLedgerEvents     as projection on midnight.ZswapLedgerEvents;

    @readonly
    entity DustLedgerEvents      as projection on midnight.DustLedgerEvents;

    /** Unshielded NIGHT balance per address. */
    @readonly
    entity NightBalances         as projection on midnight.NightBalances
        excluding {
            dustAddress,
            isDustRegistered
        };

    // ---- Documents ----

    /** Documents whose hash was recorded on chain. Each user sees only their own. */
    @readonly
    entity Documents             as projection on midnight.Documents;

    /** Records a document hash and its public metadata on chain, signed by the session's wallet.
     * The server does not store the document itself. Keeping the bytes at `storageRef` is up to you. */
    action   anchorDocument(payloadHash: Hex64,
                            contentType: String(100),
                            size: Integer64,
                            storageRef: String(500),
                            metadata: LargeString, // JSON
                            sessionId: UUID,
                            contractAddress: HexEncoded,
                            contractName: String, // optional, default 'attestation-vault'
                            idempotencyKey: String, // optional
                            sponsorSessionId: UUID // optional
    )                                                                         returns {
        jobId      : UUID;
        status     : BackgroundJobStatus;
        anchorId   : UUID; // the server's id of this anchored document
        attesterId : Hex64;
    };

    /** Checks a hash against a recorded document. A mismatch or a record not yet on chain gives `verified: false`. */
    function verifyDocument(anchorId: UUID,
                            payloadHash: Hex64,
                            contractAddress: HexEncoded, // optional; needed only for rows without a stored contract
                            contractName: String // optional, default 'attestation-vault'
    )                                                                         returns {
        verified       : Boolean not null;
        included       : Boolean not null;
        stateChecked   : Boolean not null; // false means the answer comes from the local index, not from the contract state
        anchoredTxHash : Hex64 not null;
        anchoredAt     : Timestamp;
        payloadHash    : Hex64 not null; // the recorded hash; empty unless the given one matches
    };

    // ---- Zero-knowledge proofs about document fields ----
    // The inputs come from prepareDocumentProof: payloadHash, contentRoot, schemaId, fieldKey, fieldSalt, siblings, dirs.
    // A contentRoot passed here is recorded on chain first, under the session's own attester only.

    /** Proofs created by the prove* actions. `provenTxHash` and `provenAt` are set once the proof is on chain. */
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
        siblings    : Hex64List;
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
        predicate      : ClaimPredicate;
        fieldKey       : Hex64; // all but the document kinds
        salt           : Hex64; // all but the document kinds
        siblings       : Hex64List; // all but the document kinds
        dirs           : array of Boolean; // all but the document kinds
        unit           : String(50); // optional
        value          : String; // numeric: decimal integer, scaled; setMembership: the exact string
        threshold      : BigInt; // numeric; scaled like the value, at most 2^64-1
        expectedValue  : String; // bytesEquality; one of expectedValue, expectedDigest
        expectedDigest : Hex64; // bytesEquality
        valueDigest    : Hex64; // setMembership; one of value, valueDigest
        allowedValues  : array of String; // setMembership; or setRoot with its path
        setRoot        : Hex64; // setMembership
        setSiblings    : Hex64List; // setMembership; 6 entries
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
        predicate              : ClaimPredicate;
        fieldKey               : Hex64;
        threshold              : BigInt;
        unit                   : String;
        expectedDigest         : Hex64;
        setRoot                : Hex64;
        payloadHashB           : Hex64;
        allowedMask            : Integer64;
        k                      : Integer;
    }

    /** Proves that a numeric document field is at most or at least `threshold`, without revealing the value. */
    action   proveFieldPredicate(payloadHash: Hex64,
                                            attesterId: Hex64, // optional, default the session's attester
                                            fieldKey: Hex64,
                                            value: BigInt, // scaled like the prepared field, at most 2^64-1
                                            fieldSalt: Hex64,
                                            contentRoot: Hex64, // optional
                                            schemaId: Hex64, // required with contentRoot
                                            siblings: Hex64List, // inclusion path; one entry per tree level
                                            dirs: array of Boolean, // inclusion path; one entry per tree level
                                            predicate: NumericPredicate,
                                            threshold: BigInt, // scaled like the value, at most 2^64-1
                                            unit: String(50), // optional
                                            sessionId: UUID,
                                            contractAddress: HexEncoded,
                                            contractName: String, // optional, default 'attestation-vault'
                                            idempotencyKey: String, // optional
                                            sponsorSessionId: UUID, // optional
                                            validUntil: Timestamp // optional, default one year from now; at most five years
    )                                                                         returns {
        jobId                  : UUID;
        status                 : BackgroundJobStatus;
        predicateAttestationId : UUID;
    };

    /** Proves up to 8 claims about one document in a single transaction, 7 if `contentRoot` is given.
     * Each entry in `claims` has the inputs of the matching single action, selected by `predicate`.
     * If only part of the transaction succeeds on chain, the job fails. Then verify each claim on its own. */
    action   proveClaims(payloadHash: Hex64,
                                                 attesterId: Hex64, // optional, default the session's attester
                                                 contentRoot: Hex64, // optional
                                                 schemaId: Hex64, // required with contentRoot
                                                 claims: array of BatchClaim,
                                                 sessionId: UUID,
                                                 contractAddress: HexEncoded,
                                                 contractName: String, // optional, default 'attestation-vault'
                                                 idempotencyKey: String, // optional
                                                 sponsorSessionId: UUID, // optional
                                                 validUntil: Timestamp // optional, default one year from now; at most five years
    )                                                                         returns {
        jobId             : UUID;
        status            : BackgroundJobStatus;
        claims            : array of IssuedClaim;
        droppedDuplicates : Integer;
    };

    /** Proves that a text field holds exactly the value behind `expectedDigest`.
     * This proves authenticity, not secrecy. A short or common value can be guessed from its digest. */
    action   proveFieldEquality(payloadHash: Hex64,
                                           attesterId: Hex64, // optional, default the session's attester
                                           fieldKey: Hex64,
                                           expectedValue: String,
                                           expectedDigest: Hex64, // optional; blake2b-256 of expectedValue
                                           fieldSalt: Hex64,
                                           contentRoot: Hex64, // optional
                                           schemaId: Hex64, // required with contentRoot
                                           siblings: Hex64List, // inclusion path; one entry per tree level
                                           dirs: array of Boolean, // inclusion path; one entry per tree level
                                           sessionId: UUID,
                                           contractAddress: HexEncoded,
                                           contractName: String, // optional, default 'attestation-vault'
                                           idempotencyKey: String, // optional
                                           sponsorSessionId: UUID, // optional
                                           validUntil: Timestamp // optional, default one year from now; at most five years
    )                                                                         returns {
        jobId                  : UUID;
        status                 : BackgroundJobStatus;
        predicateAttestationId : UUID;
    };

    /** Proves that a hidden text field is one of up to 64 allowed values.
     * Pass the allowed values as `allowedValues`, or the set from prepareMembershipSet as `setRoot` with its path. */
    action   proveFieldMembership(payloadHash: Hex64,
                                             attesterId: Hex64, // optional, default the session's attester
                                             fieldKey: Hex64,
                                             value: String,
                                             valueDigest: Hex64, // optional; blake2b-256 of value
                                             allowedValues: array of String, // or setRoot with its path
                                             setRoot: Hex64,
                                             setSiblings: Hex64List, // 6 entries
                                             setDirs: array of Boolean, // 6 entries
                                             fieldSalt: Hex64,
                                             contentRoot: Hex64, // optional
                                             schemaId: Hex64, // required with contentRoot
                                             siblings: Hex64List, // inclusion path; one entry per tree level
                                             dirs: array of Boolean, // inclusion path; one entry per tree level
                                             sessionId: UUID,
                                             contractAddress: HexEncoded,
                                             contractName: String, // optional, default 'attestation-vault'
                                             idempotencyKey: String, // optional
                                             sponsorSessionId: UUID, // optional
                                             validUntil: Timestamp // optional, default one year from now; at most five years
    )                                                                         returns {
        jobId                  : UUID;
        status                 : BackgroundJobStatus;
        predicateAttestationId : UUID;
    };

    /** Proves that document B differs from document A only in the fields allowed by `allowedMask`, without revealing values.
     * Both documents must be prepared with the same field list. The order of A and B is part of the proof. */
    action   proveDocumentIntegrity(payloadHashA: Hex64,
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
                                               contractAddress: HexEncoded,
                                               contractName: String, // optional, default 'attestation-vault'
                                               idempotencyKey: String, // optional
                                               sponsorSessionId: UUID, // optional
                                               validUntil: Timestamp // optional, default one year from now; at most five years
    )                                                                         returns {
        jobId                  : UUID;
        status                 : BackgroundJobStatus;
        predicateAttestationId : UUID;
    };

    /** Proves that at least `k` fields differ between two documents, without revealing which.
     * A field present in only one document counts as different. Inputs work as in proveDocumentIntegrity. */
    action   proveDocumentDiff(payloadHashA: Hex64,
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
                                          contractAddress: HexEncoded,
                                          contractName: String, // optional, default 'attestation-vault'
                                          idempotencyKey: String, // optional
                                          sponsorSessionId: UUID, // optional
                                          validUntil: Timestamp // optional, default one year from now; at most five years
    )                                                                         returns {
        jobId                  : UUID;
        status                 : BackgroundJobStatus;
        predicateAttestationId : UUID;
    };

    /** Checks a stored proof row against the contract on chain. An unproven or expired proof gives `verified: false`. */
    function verifyPredicateAttestation(predicateAttestationId: UUID)         returns {
        verified       : Boolean not null;
        included       : Boolean not null;
        stateChecked   : Boolean not null; // false means the answer comes from the local index, not from the contract state
        // What verifyPredicate needs to check the claim on chain.
        contractAddress : HexEncoded;
        attesterId      : Hex64;
        payloadHash     : Hex64;
        fieldKey        : Hex64; // null = the claim compares two documents
        predicate       : ClaimPredicate;
        // Of the following, a field the predicate does not use is null.
        threshold       : BigInt; // lessOrEqual, greaterOrEqual
        unit            : String; // lessOrEqual, greaterOrEqual; optional
        expectedDigest  : Hex64; // bytesEquality
        setRoot         : Hex64; // setMembership
        attesterIdB     : Hex64; // documentIntegrity, documentDiff
        payloadHashB    : Hex64; // documentIntegrity, documentDiff
        allowedMask     : Integer64; // documentIntegrity
        k               : Integer; // documentDiff
        provenTxHash    : Hex64; // null = not proven yet
        provenAt        : Timestamp;
    };

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
    )                                                                         returns {
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
    )                                                                         returns {
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
    )                                                                         returns {
        verified    : Boolean not null;
        granted     : Boolean not null; // a grant for the grantee is recorded on chain
        level       : Integer; // 0 public, 1 legitimate interest, 2 authority; null = no grant
        blockHeight : Integer64; // null = no indexer to read from; the answer holds at this block
    };

    // ---- Disclosure ----

    /** Disclosure grants read from the contract on chain. `level` is 0 public, 1 legitimate interest, 2 authority. */
    @readonly
    entity DisclosureGrants      as projection on midnight.DisclosureGrants;

    /** Updates `DisclosureGrants` from the contract on chain, e.g. after a grant submitted outside this server. */
    action   reindexDisclosures(contractAddress: HexEncoded,
                                contractName: String // optional, default 'attestation-vault'
    )                                                                         returns {
        contractAddress : HexEncoded;
        active          : Integer;
        deactivated     : Integer;
        reconciledAt    : Timestamp;
    };

    /** Grants `grantee` a disclosure level on an attestation. Only the attester can grant. */
    action   grantDisclosure(payloadHash: Hex64,
                             grantee: Hex64,
                             @assert.range: [0, 2]
                             level: Integer, // 0 public, 1 legitimate interest, 2 authority
                             sessionId: UUID,
                             contractAddress: HexEncoded,
                             contractName: String, // optional, default 'attestation-vault'
                             idempotencyKey: String, // optional
                             sponsorSessionId: UUID // optional
    )                                                                         returns {
        jobId             : UUID;
        status            : BackgroundJobStatus;
        disclosureGrantId : UUID;
    };

    /** Removes a grantee's disclosure on chain. Only the attester can revoke. */
    action   revokeDisclosure(payloadHash: Hex64,
                              grantee: Hex64,
                              sessionId: UUID,
                              contractAddress: HexEncoded,
                              contractName: String, // optional, default 'attestation-vault'
                              idempotencyKey: String, // optional
                              sponsorSessionId: UUID // optional
    )                                                                         returns {
        jobId  : UUID;
        status : BackgroundJobStatus;
    };

    /** Manages which attester may attest a document id. Modes 0 to 2 need the registrar's session, modes 3 and 4 the recovery identity's.
     * Mode 0 assigns `documentId` to `ownerId` and removes a previous owner's binding. Mode 1 removes the assignment.
     * Mode 2 hands the registrar role to `ownerId`. Mode 3 sets a new registrar. Mode 4 hands the recovery role to `ownerId`. */
    action   registerDocument(documentId: Hex64,
                              ownerId: Hex64,
                              @assert.range: [0, 4]
                              mode: Integer, // optional, default 0
                              sessionId: UUID,
                              contractAddress: HexEncoded,
                              contractName: String, // optional, default 'attestation-vault'
                              idempotencyKey: String, // optional
                              sponsorSessionId: UUID // optional
    )                                                                         returns {
        jobId  : UUID;
        status : BackgroundJobStatus;
    };

    /** Withdraws an attestation. Only its attester can do this.
     * Its stored content root, disclosure grants and document binding are removed too, so proofs about the document stop verifying. */
    action   retractAttestation(payloadHash: Hex64,
                                sessionId: UUID,
                                contractAddress: HexEncoded,
                                contractName: String, // optional, default 'attestation-vault'
                                idempotencyKey: String, // optional
                                sponsorSessionId: UUID // optional
    )                                                                         returns {
        jobId  : UUID;
        status : BackgroundJobStatus;
    };

    /** Removes an expired proof from the contract. Anyone can call it. */
    action   purgeExpired(@assert.range
                          kind: String enum {
                              claim;
                          },
                          key: Hex64,
                          sessionId: UUID,
                          contractAddress: HexEncoded,
                          contractName: String, // optional, default 'attestation-vault'
                          idempotencyKey: String, // optional
                          sponsorSessionId: UUID // optional
    )                                                                         returns {
        jobId  : UUID;
        status : BackgroundJobStatus;
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
        granteeId   : HexEncoded;
        bindingKind : GranteeBinding;
    };

    // ---- Contracts ----

    /** Deploys a contract known to the server. */
    action   deployContract(contractName: String,
                            sessionId: UUID,
                            initialPrivateState: Map, // optional, default {}
                            idempotencyKey: String, // optional
                            sponsorSessionId: UUID, // optional
                            recoveryId: Hex64 // optional; the attester that may use registerDocument modes 3 and 4
    )                                                                         returns {
        jobId  : UUID;
        status : BackgroundJobStatus;
    };

    /** Calls a circuit on a deployed contract.
     * `initialPrivateState` is used only if the wallet has no private state for the contract yet.
     * A sponsor session must be your own signing session or a platform fee sponsor. */
    action   submitContractCall(contractAddress: HexEncoded,
                                circuit: String,
                                contractName: String,
                                sessionId: UUID,
                                args: LargeString, // JSON array
                                idempotencyKey: String, // optional
                                initialPrivateState: Map, // optional, default {}
                                sponsorSessionId: UUID // optional
    )                                                                         returns {
        jobId  : UUID;
        status : BackgroundJobStatus;
    };

    /** Builds, proves and signs a contract call as the caller, without paying the fee and without submitting it.
     * A sponsor then submits the result with sponsorFinalized. */
    action   buildSponsorable(contractAddress: HexEncoded,
                              circuit: String,
                              contractName: String,
                              sessionId: UUID,
                              args: LargeString)                              returns {
        jobId  : UUID;
        status : BackgroundJobStatus;
    };

    /** Pays the fee for a signed transaction built by someone else and submits it.
     * The sponsor only pays for contracts and circuits its policy allows. */
    action   sponsorFinalized(finalizedTxB64: LargeString,
                                         idempotencyKey: String)              returns { // optional
        jobId     : UUID;
        status    : BackgroundJobStatus;
        sessionId : UUID; // the session the job runs under
    };

    /** Pays the fee for a signed transaction that is not yet sealed and submits it.
     * Such a transaction comes from the transaction builder with `bind: false`. One sponsor can pay several at once. */
    action   sponsorUnbound(unboundTxB64: LargeString,
                                       idempotencyKey: String)                returns { // optional
        jobId     : UUID;
        status    : BackgroundJobStatus;
        sessionId : UUID; // the session the job runs under
    };

    /** Pays the fee for a shielded token swap and submits it.
     * The swap comes as two matching halves, each an offer file (`swapoffer1...`) or base64.
     * Both token types must be allowed for the sponsor, and the server needs `NIGHTGATE_SPONSOR_ALLOW_SWAPS`. */
    action   sponsorSwap(makerHalfB64: LargeString, // required unless offerId is given
                         takerHalfB64: LargeString,
                         idempotencyKey: String, // optional
                         offerId: UUID)                                       returns { // optional; a posted offer to use as the maker half
        jobId     : UUID;
        status    : BackgroundJobStatus;
        sessionId : UUID; // the session the job runs under
    };

    /** Pays the fee for a plain transfer the caller built and submits it. A shielded transfer hides its terms, so `tokenType` and `amount` are the caller's statement.
     * An unshielded transfer shows them, so both must match the transaction. */
    action   sponsorTransfer(transferTxB64: LargeString, // base64; bound or unbound
                             tokenType: Hex64, // the type moved; must be allowed for the caller
                             amount: BigInt, // decimal; atoms the recipient receives
                             idempotencyKey: String)                          returns { // optional
        jobId     : UUID;
        status    : BackgroundJobStatus;
        sessionId : UUID; // the session the job runs under
    };

    // ---- Swap offer board ----

    /** Posts one half of a swap so that others can find it and complete the swap. Posting holds or moves nothing.
     * The offer closes when a sponsored swap uses it, when it expires or when the poster retires it. */
    action   postSwapOffer(offer: LargeString, // offer file or base64
                           expiresAt: Timestamp, // optional
                           tags: array of String)                             returns { // up to 8; optional
        offerId     : UUID;
        status      : SwapOfferStatus;
        bound       : Boolean; // the half is already sealed
        givesType   : Hex64;
        givesAmount : BigInt;
        wantsType   : Hex64;
        wantsAmount : BigInt;
        expiresAt   : Timestamp;
    };

    /** Lists offers, by default the open ones, newest first. A row carries the terms, `getSwapOffer` the half itself.
     * With `status: 'all'` and `since`, polling returns every change since the last call.
     * With `waitMs` the call holds while nothing matches, until an offer matches or the time is up, so one call replaces many polls. */
    function listSwapOffers(givesType: Hex64, // optional
                            wantsType: Hex64, // optional
                            tag: String, // optional
                            @assert.range: [1, 200] limit: Integer, // optional, default 50
                            status: SwapOfferFilter, // optional, default 'open'
                            since: Timestamp, // optional
                            mine: Boolean, // optional; only the caller's own offers
                            waitMs: Integer // ms; optional, at most 25000; hold the call until there is something to return
    )                                                                         returns array of {
        offerId      : UUID;
        bound        : Boolean; // the half is already sealed
        givesType    : Hex64;
        givesAmount  : BigInt;
        wantsType    : Hex64;
        wantsAmount  : BigInt;
        tags         : many String;
        expiresAt    : Timestamp;
        postedAt     : Timestamp;
        status       : SwapOfferStatus;
        filledTxHash : Hex64;
        closedAt     : Timestamp;
        changedAt    : Timestamp;
    };

    /** One offer by id, open or closed. An unknown id gives 404. */
    function getSwapOffer(offerId: UUID)                                      returns {
        offerId      : UUID;
        offer        : LargeString;
        bound        : Boolean; // the half is already sealed
        givesType    : Hex64;
        givesAmount  : BigInt;
        wantsType    : Hex64;
        wantsAmount  : BigInt;
        tags         : many String;
        expiresAt    : Timestamp;
        postedAt     : Timestamp;
        status       : SwapOfferStatus;
        filledTxHash : Hex64;
        closedAt     : Timestamp;
        changedAt    : Timestamp;
    };

    /** Closes an open offer. Only the user or agent token that posted it can do this. An offer already closed answers its status. */
    action   retireSwapOffer(offerId: UUID)                                   returns {
        offerId : UUID;
        status  : SwapOfferStatus; // retired; expired | filled when the offer was closed before the call
    };

    // ---- Disclosure to token holders ----

    /** Lets every holder of `tokenType` read a document. Holders prove their holding through the registry at `registryAddress`.
     * `content` is stored encrypted and must hash to `payloadHash`, as blake2b-256 or sha256 of the UTF-8 text. */
    action   grantDisclosureToHolders(payloadHash: Hex64,
                                      tokenType: Hex64,
                                      registryAddress: HexEncoded,
                                      content: LargeString, // optional
                                      contentType: String, // optional, default 'text/plain'
                                      expiresAt: Timestamp)                   returns { // optional
        holderGrantId   : UUID;
        payloadHash     : Hex64;
        tokenType       : Hex64;
        registryAddress : HexEncoded;
        hasContent      : Boolean;
        expiresAt       : Timestamp;
        status          : HolderGrantStatus;
    };

    /** Revokes a holder disclosure. Only its grantor can do this. */
    action   revokeHolderDisclosure(holderGrantId: UUID)                      returns {
        holderGrantId : UUID;
        status        : HolderGrantStatus;
    };

    /** Proves a token holding and returns what the issuer disclosed to holders.
     * `claimSecret` is the secret used when registering in the holder registry. Without entitlement the result is `entitled: false`. */
    action   claimDisclosure(payloadHash: Hex64,
                             tokenType: Hex64,
                             claimSecret: Hex64)                              returns {
        entitled        : Boolean;
        reason          : String;
        payloadHash     : Hex64;
        tokenType       : Hex64;
        registryAddress : HexEncoded;
        holderGrantId   : UUID;
        contentType     : String;
        contentHashKind : ContentHashKind;
        content         : LargeString;
        expiresAt       : Timestamp;
        /** The registries that were checked, for a negative answer. */
        registries      : array of String;
    };

    // ---- Batches and tokens ----

    /** Runs up to 8 circuit calls on one contract in a single transaction, in the given order.
     * Calls to the same circuit have no fixed order among themselves.
     * If only part of the transaction succeeds on chain, the job fails. */
    action   submitContractCallBatch(contractAddress: HexEncoded,
                                     calls: LargeString, // JSON array of { circuit, args }
                                     contractName: String,
                                     sessionId: UUID,
                                     idempotencyKey: String, // optional
                                     initialPrivateState: Map, // optional, default {}
                                     sponsorSessionId: UUID, // optional
                                     independentCalls: Boolean // optional; true lets the server reorder calls that do not depend on each other
    )                                                                         returns {
        jobId  : UUID;
        status : BackgroundJobStatus;
    };

    /** Mints a token on a token factory contract and sends it to a shielded address.
     * The session is the issuer, so the same `name` from another session is a different token. */
    action   mintFactoryToken(contractAddress: HexEncoded, // optional; default NIGHTGATE_TOKEN_FACTORY_CONTRACT
                              name: String, // UTF-8, at most 32 bytes
                              amount: BigInt,
                              receiverCoinPublicKey: Hex64,
                              sessionId: UUID, // optional for a token caller; default the session of its grant
                              idempotencyKey: String, // optional
                              sponsorSessionId: UUID)                         returns { // optional
        jobId     : UUID;
        status    : BackgroundJobStatus;
        name      : String;
        amount    : BigInt;
        issuerKey : Hex64;
        domain    : String;
        tokenType : Hex64;
    };

    /** Burns `amount` of a factory token the session holds; `issuerKey` names the issuer, default the session's own. */
    action   burnFactoryToken(contractAddress: HexEncoded, // optional; default NIGHTGATE_TOKEN_FACTORY_CONTRACT
                              name: String, // UTF-8, at most 32 bytes
                              amount: BigInt,
                              issuerKey: Hex64, // optional; default the session's own issuer key
                              sessionId: UUID,
                              idempotencyKey: String, // optional
                              sponsorSessionId: UUID)                         returns { // optional
        jobId     : UUID;
        status    : BackgroundJobStatus;
        name      : String;
        amount    : BigInt;
        issuerKey : Hex64;
        domain    : String;
        tokenType : Hex64;
    };

    /** Computes the token type a contract mints, for use as `tokenType` in sendToken. */
    function deriveTokenType(contractAddress: HexEncoded,
                             domainSeparator: String // text or 64 hex; the separator the contract mints under
    )                                                                         returns {
        tokenType    : Hex64 not null;
        contractAddress : HexEncoded not null;
        domainSeparator : Hex64 not null;
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
    action   connectWallet(viewingKey: Hex64, // required; the wallet's account is derived from it
                           label: String // at most 100 characters; optional
    )                                                                         returns {
        sessionId   : UUID not null;
        label       : String;
        connectedAt : Timestamp not null;
        expiresAt   : Timestamp not null;
        isActive    : Boolean not null;
    };

    /** Closes a session and deletes its stored keys. */
    action   disconnectWallet(sessionId: UUID)                                returns {
        sessionId : UUID not null;
        isActive  : Boolean not null;
    };

    /** Lets a session sign transactions. The seed is stored encrypted and must belong to the session's viewing key.
     * Keys are derived from the seed the same way the Lace wallet does, so the addresses match Lace.
     * The wallet then syncs with the chain in the background, tracked by `jobId`. */
    action   connectWalletForSigning(sessionId: UUID,
                                     mnemonic: String, // BIP39 phrase; required unless seedHex is given
                                     seedHex: SeedHex, // optional
                                     accountIndex: Integer, // optional, default 0
                                     idempotencyKey: String, // optional
                                     prewarm: Boolean // optional, default true; false syncs only when needed
    )                                                                         returns {
        sessionId      : UUID not null;
        signingEnabled : Boolean not null;
        jobId          : UUID; // null = no sync was started
        status         : BackgroundJobStatus; // null = no sync was started
    };

    /** Derives a wallet's viewing key, addresses and attester id from a mnemonic or seed. Stores nothing. */
    action   deriveWalletInfo(mnemonic: String, // BIP39 phrase; required unless seedHex is given
                              seedHex: SeedHex, // optional
                              accountIndex: Integer // optional, default 0
    )                                                                         returns {
        viewingKey      : Hex64 not null;
        shieldedAddress : ShieldedAddr not null;
        nightAddress    : UnshieldedAddr not null;
        dustAddress     : DustAddr not null;
        attesterId      : Hex64 not null;
        accountIndex    : Integer not null;
        network         : Network not null;
    };

    /** Registers the wallet's NIGHT coins so they generate DUST, the resource that pays transaction fees. */
    action   registerForDustGeneration(sessionId: UUID,
                                       dustReceiverAddress: DustAddr, // optional, default the wallet's own DUST address
                                       idempotencyKey: String // optional
    )                                                                         returns {
        jobId  : UUID;
        status : BackgroundJobStatus;
    };

    /** Stops DUST generation for all of the wallet's NIGHT coins. */
    action   deregisterFromDustGeneration(sessionId: UUID,
                                          idempotencyKey: String, // optional
                                          sponsorSessionId: UUID // optional
    )                                                                         returns {
        jobId  : UUID;
        status : BackgroundJobStatus;
    };

    /** Sends NIGHT, or the token `tokenType`, to an address.
     * An `mn_shield-addr` address is paid from the shielded balance, an `mn_addr` address from the unshielded one. */
    action   sendToken(sessionId: UUID,
                       receiverAddress: ReceiverAddr,
                       amount: BigInt,
                       expiresAt: Timestamp, // optional, default 10 minutes from now; the transaction is refused after it
                       idempotencyKey: String, // optional
                       tokenType: Hex64 // optional, default NIGHT
    )                                                                         returns {
        jobId  : UUID;
        status : BackgroundJobStatus;
    };

    /** Wallet balances. */
    function getWalletBalance(sessionId: UUID)                                returns {
        shieldedNight            : BigInt not null;
        unshieldedNight          : BigInt not null;
        shieldedTokens           : array of {
            tokenType : Hex64 not null;
            amount    : BigInt not null;
        } not null;
        dustBalance              : BigInt not null;
        registeredNightUtxoCount : Integer not null;
        totalNightUtxoCount      : Integer not null;
        dustUtxoCount            : Integer not null;
        dustPendingCount         : Integer not null;
        dustPendingValue         : BigInt not null;
        dustRestoreCount         : Integer not null;
    };

    /** How far the wallet has caught up with the chain. The sync is stuck when `appliedIndex` stops growing. */
    function getWalletSyncProgress(sessionId: UUID)                           returns {
        known                : Boolean not null;
        caughtUp             : Boolean not null;
        appliedIndex         : String;
        streamTip            : String;
        behindEvents         : String;
        eventsPerSecond      : Decimal;
        etaSeconds           : Integer;
        blockHeight          : Integer64;
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
        dustBalance          : BigInt;
        unshieldedNight      : BigInt;
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

    /** Estimates the DUST fee of a sendToken without proving or submitting anything. */
    function estimateSendTokenFee(sessionId: UUID,
                                  receiverAddress: ReceiverAddr,
                                  amount: BigInt,
                                  expiresAt: Timestamp, // optional, default 10 minutes from now; the transaction is refused after it
                                  tokenType: Hex64 // optional, default NIGHT
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
                                  contractName: String // optional, default 'attestation-vault'
    )                                                                         returns {
        payloadHash       : Hex64 not null;
        canonicalDocument : LargeString not null; // the exact text that was hashed
        contentRoot       : Hex64 not null;
        fields            : array of PreparedField not null;
        emptyFields       : array of String not null;
        schemaId          : Hex64 not null;
        schema            : array of SchemaSlot not null;
        leaves            : Hex64List not null; // salted leaf hashes in slot order
        opening           : DocumentOpening not null;
    };

    /** Builds the set of allowed values for proveFieldMembership.
     * With `value` or `valueDigest` it also returns the path that proves the value is in the set. */
    action   prepareMembershipSet(allowedValues: array of String, // up to 64 distinct values
                                  value: String, // optional
                                  valueDigest: Hex64, // optional; blake2b-256 of value
                                  contractName: String // optional, default 'attestation-vault'
    )                                                                         returns {
        setRoot         : Hex64 not null;
        memberCount     : Integer not null;
        setSiblings     : Hex64List not null; // empty without value or valueDigest
        setDirs         : array of Boolean not null; // empty without value or valueDigest
    };

    /** Records on chain that an agent produced an output from an input, signed by the session's wallet.
     * Anyone can check it by hashing `envelopeJson` and calling verifyAttestation. */
    action   attestAgentOutput(agentId: String, // at most 200 characters
                               inputHash: Hex64,
                               outputHash: Hex64,
                               modelId: String, // at most 200 characters; optional
                               policyHash: Hex64, // optional
                               producedAt: Timestamp, // optional, default now
                               storageRef: String(500), // optional, default 'agent-output://<agentId>'
                               sessionId: UUID,
                               contractAddress: HexEncoded,
                               contractName: String, // optional, default 'attestation-vault'
                               idempotencyKey: String, // optional
                               sponsorSessionId: UUID // optional
    )                                                                         returns {
        jobId        : UUID;
        status       : BackgroundJobStatus;
        anchorId     : UUID; // the server's id of this anchored document
        payloadHash  : Hex64;
        envelopeJson : LargeString;
    };

    /** The caller's agent grants. Their lists come back from the create and update actions, their use from getGrantUsage. */
    @readonly
    entity AgentGrants           as
        projection on midnight.AgentGrants
        excluding {
            tokenHash,
            allowedActions,
            allowedContracts,
            allowedCircuits,
            allowedTokenTypes,
            allowedUnshieldedTokenTypes,
            deployedContracts,
            mintedTokenTypes,
            maxValuePerDay,
            jobsUsedToday,
            budgetWindow,
            jobsUsedThisHour,
            hourWindow,
            deploysUsed,
            maintenanceUpdatesUsed,
            valueUsedToday,
            valueWindow
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
                              label: String, // optional
                              allowedContracts: HexList, // optional, default all the platform allows
                              allowedCircuits: array of String, // optional, default all the platform allows
                              allowDeploy: Boolean, // optional; the sponsor pays for deploys built by the agent
                              maxDeploys: Integer, // optional, default 1 when allowDeploy is true
                              allowMaintenance: Boolean, // optional; the sponsor pays for maintenance updates of the contracts deployed under this grant
                              maxMaintenanceUpdates: Integer, // optional, default 8 when allowMaintenance is true
                              allowedTokenTypes: Hex64List, // optional, default all the platform allows
                              allowUnshieldedOffers: Boolean, // optional; sponsored calls may pay the agent's own unshielded tokens in and the contract's payouts out, and sponsorTransfer takes unshielded transfers; needs NIGHTGATE_SPONSOR_ALLOW_UNSHIELDED_OFFERS
                              allowedUnshieldedTokenTypes: Hex64List, // optional, default all the platform allows besides NIGHT
                              maxValuePerDay: array of ValueBudget // optional, default no value limit
    )                                                                         returns {
        grantId                     : UUID;
        token                       : String; // shown only once
        allowedActions              : array of String;
        allowedContracts            : HexList;
        allowedCircuits             : array of String;
        allowDeploy                 : Boolean;
        maxDeploys                  : Integer;
        allowMaintenance            : Boolean;
        maxMaintenanceUpdates       : Integer;
        allowedTokenTypes           : Hex64List;
        allowUnshieldedOffers       : Boolean;
        allowedUnshieldedTokenTypes : Hex64List;
        maxValuePerDay              : array of ValueBudget;
        validUntil                  : Timestamp;
    };

    /** Creates up to 50 grants with the same settings, each with its own token.
     * Without `labels` they are named `<label>-1` to `<label>-n`. */
    action   createAgentGrants(count: Integer,
                               sessionId: UUID,
                               allowedActions: array of String,
                               labels: array of String, // optional; exactly count entries
                               maxJobsPerDay: Integer, // optional; default NIGHTGATE_GRANT_DEFAULT_JOBS_PER_DAY, else unlimited
                               maxJobsPerHour: Integer, // optional; default NIGHTGATE_GRANT_DEFAULT_JOBS_PER_HOUR, else unlimited
                               sponsorSessionId: UUID, // optional
                               validUntil: Timestamp, // optional, default no expiry
                               label: String, // optional
                               allowedContracts: HexList, // optional, default all the platform allows
                               allowedCircuits: array of String, // optional, default all the platform allows
                               allowDeploy: Boolean, // optional; the sponsor pays for deploys built by the agent
                               maxDeploys: Integer, // optional, default 1 when allowDeploy is true
                               allowMaintenance: Boolean, // optional; the sponsor pays for maintenance updates of the contracts deployed under this grant
                               maxMaintenanceUpdates: Integer, // optional, default 8 when allowMaintenance is true
                               allowedTokenTypes: Hex64List, // optional, default all the platform allows
                               allowUnshieldedOffers: Boolean, // optional; sponsored calls may pay the agent's own unshielded tokens in and the contract's payouts out, and sponsorTransfer takes unshielded transfers; needs NIGHTGATE_SPONSOR_ALLOW_UNSHIELDED_OFFERS
                               allowedUnshieldedTokenTypes: Hex64List, // optional, default all the platform allows besides NIGHT
                               maxValuePerDay: array of ValueBudget // optional, default no value limit
    )                                                                         returns {
        grants                      : array of {
            grantId    : UUID;
            token      : String; // shown only once
            label : String;
        };
        allowedActions              : array of String;
        allowedContracts            : HexList;
        allowedCircuits             : array of String;
        allowDeploy                 : Boolean;
        maxDeploys                  : Integer;
        allowMaintenance            : Boolean;
        maxMaintenanceUpdates       : Integer;
        allowedTokenTypes           : Hex64List;
        allowUnshieldedOffers       : Boolean;
        allowedUnshieldedTokenTypes : Hex64List;
        maxValuePerDay              : array of ValueBudget;
        validUntil                  : Timestamp;
    };

    /** Revokes a grant at once. A grant of another user gives 404. */
    action   revokeAgentGrant(grantId: UUID)                                  returns {
        revoked : Boolean;
    };

    /** Changes the given settings of a grant. */
    action   updateAgentGrant(grantId: UUID,
                              label: String,
                              allowedActions: array of String,
                              maxJobsPerDay: Integer,
                              maxJobsPerHour: Integer,
                              allowedContracts: HexList,
                              allowedCircuits: array of String,
                              allowedTokenTypes: Hex64List,
                              allowDeploy: Boolean,
                              maxDeploys: Integer,
                              allowMaintenance: Boolean,
                              maxMaintenanceUpdates: Integer,
                              allowUnshieldedOffers: Boolean,
                              allowedUnshieldedTokenTypes: Hex64List,
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
            kind   : BackgroundJobKind;
            status : BackgroundJobStatus;
            count  : Integer;
        };
        landed        : Integer; // transactions that succeeded on chain
        failed        : Integer;
        deploysUsed   : Integer;
        maxDeploys    : Integer;
        maintenanceUpdatesUsed : Integer;
        maxMaintenanceUpdates  : Integer;
        jobsUsedToday : Integer;
        maxJobsPerDay : Integer;
        dustPaid      : BigInt;
        limits        : {
            jobsPerHour : Budget;
            jobsPerDay  : Budget;
            valuePerDay : array of ValueBudgetState;
            classes     : array of RateClassState;
        };
    };

    /** One part of a batch transaction: its calls and whether they applied on chain. */
    type ChainSegment {
        segment : Integer;
        calls   : array of String;
        applied : Boolean;
    }

    /** Returns the status of a background job. Poll until `status` is `succeeded` or `failed`.
     * With `waitMs` the call holds until the job settles or the time is up, so one call replaces many polls. */
    function getJobStatus(jobId: UUID,
                          sessionId: UUID, // optional; the job's session. A token reads only the jobs of its own grant
                          waitMs: Integer, // ms; optional, at most 25000; hold the call until there is something to return
                          untilChain: Boolean // default false; with waitMs, a succeeded job also waits for the chain's verdict
    )                                                                         returns {
        jobId               : UUID;
        kind                : BackgroundJobKind;
        status              : BackgroundJobStatus;
        result              : Map; // null = no result yet; what the action returns
        errorCode           : String;
        errorMessage        : LargeString;
        attempt             : Integer;
        maxAttempts         : Integer;
        submissionId        : UUID;
        txId                : HexEncoded; // hex; null before the build; a ledger identifier, stable when the sponsor adds its fee
        txHash              : Hex64; // hex; null before the send; the ledger hash, as explorers show it
        chainStatus         : BackgroundJobChainStatus;
        chainFinalizedAt    : Timestamp;
        blockHeight         : Integer64;
        blockHash           : Hex64;
        chainSegments       : array of ChainSegment; // empty = not a batch, or not on chain yet
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
    txHash        @title: 'Transaction Hash';
    extrinsicHash @title: 'Extrinsic Hash';
};

annotate NightgateService.ContractActions with {
    contractAddress @title: 'Contract Address';
};

annotate NightgateService.NightBalances with {
    address @title: 'Address';
    balance @title: 'NIGHT Balance';
};
