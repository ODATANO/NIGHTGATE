using {midnight} from '../db/schema';
using { Hex64 } from '../db/types';

/**
 * Midnight chain data, attestations, zero-knowledge proofs, wallet sessions and transaction jobs.
 * Actions that write to the chain return a `jobId`. Poll `getJobStatus` for the result.
 * A retry with the same `idempotencyKey` returns the first job. `sponsorSessionId` is a second session that pays the fee.
 * Amounts are decimal strings in the smallest unit.
 */
@path    : '/api/v1/nightgate'
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

            function byHeight(height: Integer)                                           returns Blocks;

            @cds.odata.bindingparameter.collection
            function range(startHeight: Integer64, endHeight: Integer64, limit: Integer) returns array of Blocks;
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
            function byHash(hash: String)                   returns Transactions;

            // txType: a TxType value
            @cds.odata.bindingparameter.collection
            function byType(txType: String, limit: Integer) returns array of Transactions;
        };

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
            @cds.odata.bindingparameter.collection
            function byAddress(address: String) returns array of ContractActions;

            function history(address: String)   returns array of ContractActions;
        };

    @readonly
    entity ContractBalances      as projection on midnight.ContractBalances;

    /** The state of a contract at a block. `state` and `zswapState` are base64. */
    type ContractStateSnapshot {
        address        : String;
        height         : Integer64; // null if not known locally
        state          : LargeString;
        zswapState     : LargeString;
        stateHash      : String;
        zswapStateHash : String;
        source         : String(10); // history | current | indexer
        verified       : Boolean; // only for source indexer: the state matches the hash stored on chain
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
            @cds.odata.bindingparameter.collection
            function byOwner(owner: String) returns array of UnshieldedUtxos;

            @cds.odata.bindingparameter.collection
            function unspent()              returns array of UnshieldedUtxos;
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

            @cds.odata.bindingparameter.collection
            function getTopHolders(limit: Integer) returns array of NightBalances;
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

    /**
     * Records a document hash and its public metadata on chain, signed by the session's wallet.
     * The server does not store the document itself. Keeping the bytes at `storageRef` is up to you.
     */
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
    // The inputs come from prepareDocumentProof: payloadHash, contentRoot, schemaId, fieldKey, fieldSalt, siblingsJson, dirsJson.
    // A contentRoot passed here is recorded on chain first, under the session's own attester only.

    /** Proofs created by the issue* actions. `provenTxHash` and `provenAt` are set once the proof is on chain. */
    @readonly
    entity PredicateAttestations as projection on midnight.PredicateAttestations;

    /** Proves that a numeric document field is at most or at least `threshold`, without revealing the value. */
    action   issueFieldPredicateAttestation(payloadHash: Hex64,
                                            attesterId: Hex64, // optional, default the session's attester
                                            fieldKey: Hex64,
                                            value: String, // decimal integer, scaled like the prepared field
                                            fieldSalt: Hex64,
                                            contentRoot: Hex64, // optional
                                            schemaId: Hex64, // required with contentRoot
                                            siblingsJson: String, // JSON array of 64 hex
                                            dirsJson: String, // JSON array of booleans
                                            predicate: String, // 'lessOrEqual' | 'greaterOrEqual'
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

    /**
     * Proves up to 8 claims about one document in a single transaction, 7 if `contentRoot` is given.
     * Each entry in `claimsJson` has the inputs of the matching single action, selected by `predicate`.
     * If only part of the transaction succeeds on chain, the job fails. Then verify each claim on its own.
     */
    action   issueFieldPredicateAttestationBatch(payloadHash: Hex64,
                                                 attesterId: Hex64, // optional, default the session's attester
                                                 contentRoot: Hex64, // optional
                                                 schemaId: Hex64, // required with contentRoot
                                                 claimsJson: LargeString, // JSON array
                                                 sessionId: UUID,
                                                 contractAddress: String,
                                                 compiledArtifactRef: String, // optional, default 'attestation-vault'
                                                 idempotencyKey: String, // optional
                                                 sponsorSessionId: UUID, // optional
                                                 validUntil: Integer64 // UNIX seconds; optional, default one year from now; at most five years
    )                                                                         returns {
        jobId             : UUID;
        status            : String;
        claims            : LargeString; // JSON array
        droppedDuplicates : Integer;
    };

    /**
     * Proves that a text field holds exactly the value behind `expectedDigest`.
     * This proves authenticity, not secrecy. A short or common value can be guessed from its digest.
     */
    action   issueFieldEqualityAttestation(payloadHash: Hex64,
                                           attesterId: Hex64, // optional, default the session's attester
                                           fieldKey: Hex64,
                                           expectedValue: String,
                                           expectedDigest: Hex64, // optional; blake2b-256 of expectedValue
                                           fieldSalt: Hex64,
                                           contentRoot: Hex64, // optional
                                           schemaId: Hex64, // required with contentRoot
                                           siblingsJson: String, // JSON array of 64 hex
                                           dirsJson: String, // JSON array of booleans
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

    /**
     * Proves that a hidden text field is one of up to 64 allowed values.
     * Pass the allowed values as `allowedValuesJson`, or the set from prepareMembershipSet as `setRoot` with its path.
     */
    action   issueFieldMembershipAttestation(payloadHash: Hex64,
                                             attesterId: Hex64, // optional, default the session's attester
                                             fieldKey: Hex64,
                                             value: String,
                                             valueDigest: Hex64, // optional; blake2b-256 of value
                                             allowedValuesJson: LargeString, // JSON array of strings
                                             setRoot: Hex64,
                                             setSiblingsJson: String, // JSON array of 6 x 64 hex
                                             setDirsJson: String, // JSON array of 6 booleans
                                             fieldSalt: Hex64,
                                             contentRoot: Hex64, // optional
                                             schemaId: Hex64, // required with contentRoot
                                             siblingsJson: String, // JSON array of 64 hex
                                             dirsJson: String, // JSON array of booleans
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

    /**
     * Proves that document B differs from document A only in the fields allowed by `allowedMask`, without revealing values.
     * Both documents must be prepared with the same field list. The order of A and B is part of the proof.
     */
    action   issueDocumentIntegrityAttestation(payloadHashA: Hex64,
                                               payloadHashB: Hex64,
                                               attesterIdA: Hex64, // optional, default the session's attester
                                               attesterIdB: Hex64, // optional, default attesterIdA
                                               allowedMask: Integer64, // bit i set = field i may differ
                                               schemaJson: LargeString,
                                               openingAJson: LargeString,
                                               openingBJson: LargeString,
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

    /**
     * Proves that at least `k` fields differ between two documents, without revealing which.
     * A field present in only one document counts as different. Inputs work as in issueDocumentIntegrityAttestation.
     */
    action   issueDocumentDiffAttestation(payloadHashA: Hex64,
                                          payloadHashB: Hex64,
                                          attesterIdA: Hex64, // optional, default the session's attester
                                          attesterIdB: Hex64, // optional, default attesterIdA
                                          k: Integer, // 1 to the number of fields; minimum number of differing fields
                                          schemaJson: LargeString,
                                          openingAJson: LargeString,
                                          openingBJson: LargeString,
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

    /**
     * Manages which attester may attest a document id. Modes 0 to 2 need the registrar's session, modes 3 and 4 the recovery identity's.
     * Mode 0 assigns `documentId` to `ownerId`, 1 removes the assignment, 2 hands the registrar role to `ownerId`.
     * Assigning an id that already has an owner moves it and removes the previous owner's binding.
     * Mode 3 sets a new registrar, 4 hands the recovery role to `ownerId`.
     */
    action   registerPassport(documentId: Hex64,
                              passportId: String, // same as documentId
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

    /**
     * Withdraws an attestation. Only its attester can do this.
     * Its stored content root, disclosure grants and document binding are removed too, so proofs about the document stop verifying.
     */
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
    action   purgeExpired(kind: String, // 'claim'
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

    /**
     * Links the caller to a grantee id, the id that disclosure grants name.
     * `bindingInput` depends on the server setting `cds.requires.nightgate.granteeBinding`.
     * It is the wallet's coin public key for 'wallet' (default), a DID for 'did', or the 64 hex id for 'custom'.
     */
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
                            initialPrivateState: LargeString, // JSON
                            idempotencyKey: String, // optional
                            sponsorSessionId: UUID, // optional
                            recoveryId: Hex64 // optional; the attester that may use registerPassport modes 3 and 4
    )                                                                         returns {
        jobId  : UUID;
        status : String;
    };

    /**
     * Calls a circuit on a deployed contract.
     * `initialPrivateState` is used only if the wallet has no private state for the contract yet.
     * A sponsor session must be your own signing session or a platform fee sponsor.
     */
    action   submitContractCall(contractAddress: String,
                                circuit: String,
                                compiledArtifactRef: String,
                                sessionId: UUID,
                                args: LargeString, // JSON array
                                idempotencyKey: String, // optional
                                initialPrivateState: LargeString, // JSON; optional, default {}
                                sponsorSessionId: UUID // optional
    )                                                                         returns {
        jobId  : UUID;
        status : String;
    };

    /**
     * Builds, proves and signs a contract call as the caller, without paying the fee and without submitting it.
     * A sponsor then submits the result with sponsorFinalizedTransaction.
     */
    action   buildSponsorable(contractAddress: String,
                              circuit: String,
                              compiledArtifactRef: String,
                              sessionId: UUID,
                              args: LargeString)                              returns {
        jobId  : UUID;
        status : String;
    };

    /**
     * Pays the fee for a signed transaction built by someone else and submits it.
     * The sponsor only pays for contracts and circuits its policy allows.
     */
    action   sponsorFinalizedTransaction(finalizedTxB64: LargeString,
                                         sponsorSessionId: UUID,
                                         idempotencyKey: String)              returns { // optional
        jobId     : UUID;
        status    : String;
        sessionId : UUID; // pass it to getJobStatus
    };

    /**
     * Pays the fee for a signed transaction that is not yet sealed and submits it.
     * Such a transaction comes from the transaction builder with `bind: false`. One sponsor can pay several at once.
     */
    action   sponsorUnboundTransaction(unboundTxB64: LargeString,
                                       sponsorSessionId: UUID,
                                       idempotencyKey: String)                returns { // optional
        jobId     : UUID;
        status    : String;
        sessionId : UUID; // pass it to getJobStatus
    };

    /**
     * Pays the fee for a shielded token swap and submits it.
     * The swap comes as two matching halves, each an offer file (`swapoffer1...`) or base64.
     * Both token types must be allowed for the sponsor, and the server needs `NIGHTGATE_SPONSOR_ALLOW_SWAPS`.
     */
    action   sponsorSwap(makerHalfB64: LargeString, // required unless offerId is given
                         takerHalfB64: LargeString,
                         sponsorSessionId: UUID,
                         idempotencyKey: String, // optional
                         offerId: UUID)                                       returns { // optional; a posted offer to use as the maker half
        jobId     : UUID;
        status    : String;
        sessionId : UUID; // pass it to getJobStatus
    };

    // ---- Swap offer board ----

    /**
     * Posts one half of a swap so that others can find it and complete the swap. Posting holds or moves nothing.
     * The offer closes when a sponsored swap uses it, when it expires or when the poster retires it.
     */
    action   postSwapOffer(offer: LargeString, // offer file or base64
                           expiresAt: Timestamp, // optional
                           tags: LargeString)                                 returns { // JSON array of up to 8 strings; optional
        offerId     : UUID;
        status      : String;
        bound       : Boolean; // the half is already sealed
        givesType   : String;
        givesAmount : String;
        wantsType   : String;
        wantsAmount : String;
        expiresAt   : Timestamp;
    };

    /**
     * Lists offers, by default the open ones, newest first.
     * With `status: 'all'` and `since`, polling returns every change since the last call.
     */
    function listSwapOffers(givesType: Hex64, // optional
                            wantsType: Hex64, // optional
                            tag: String, // optional
                            limit: Integer, // optional, default 50, at most 200
                            status: String, // optional, default 'open'; 'filled' | 'retired' | 'expired' | 'all'
                            since: Timestamp, // optional
                            mine: Boolean)                                    returns array of { // optional; only the caller's own offers
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
    };

    /** Closes an open offer. Only the user or agent token that posted it can do this. */
    action   retireSwapOffer(offerId: UUID)                                   returns {
        offerId : UUID;
        status  : String;
    };

    // ---- Disclosure to token holders ----

    /**
     * Lets every holder of `tokenType` read a document. Holders prove their holding through the registry at `registryAddress`.
     * `content` is stored encrypted and must hash to `payloadHash`, as blake2b-256 or sha256 of the UTF-8 text.
     */
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

    /**
     * Proves a token holding and returns what the issuer disclosed to holders.
     * `claimSecret` is the secret used when registering in the holder registry. Without entitlement the result is `entitled: false`.
     */
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

    /**
     * Runs up to 8 circuit calls on one contract in a single transaction, in the given order.
     * Calls to the same circuit have no fixed order among themselves.
     * If only part of the transaction succeeds on chain, the job fails.
     */
    action   submitContractCallBatch(contractAddress: String,
                                     calls: LargeString, // JSON array of { circuit, args }
                                     compiledArtifactRef: String,
                                     sessionId: UUID,
                                     idempotencyKey: String, // optional
                                     initialPrivateState: LargeString, // JSON; optional, default {}
                                     sponsorSessionId: UUID, // optional
                                     independentCalls: Boolean // optional; true lets the server reorder calls that do not depend on each other
    )                                                                         returns {
        jobId  : UUID;
        status : String;
    };

    /**
     * Mints a token on a token factory contract and sends it to a shielded address.
     * The session is the issuer, so the same `name` from another session is a different token.
     */
    action   mintFactoryToken(contractAddress: String,
                              name: String, // UTF-8, at most 32 bytes
                              amount: String,
                              recipientCoinPublicKey: Hex64,
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

    /**
     * Lets a session sign transactions. The seed is stored encrypted and must belong to the session's viewing key.
     * Keys are derived from the seed the same way the Lace wallet does, so the addresses match Lace.
     * The wallet then syncs with the chain in the background, tracked by `prewarmJobId`.
     */
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

    /**
     * Sends NIGHT, or the token `tokenTypeHex`, to an address.
     * An `mn_shield-addr_` address is paid from the shielded balance, an `mn_addr_` address from the unshielded one.
     */
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

    /**
     * Prepares a JSON document for the proof actions. Nothing is stored.
     * Keep the field order of `proofFieldsJson` the same for every document of a kind. `kind` is 'uint' or 'bytes', `scale` defaults to 1000.
     * Store `opening`. Without it no later proof about this document is possible.
     */
    action   prepareDocumentProof(documentJson: LargeString, // JSON object
                                  proofFieldsJson: LargeString, // JSON array of { field, kind, scale }, at most 16 or 32 entries depending on the contract
                                  saltSeed: Hex64, // optional, default random
                                  compiledArtifactRef: String // optional, default 'attestation-vault'
    )                                                                         returns {
        payloadHash       : Hex64;
        canonicalDocument : LargeString; // the exact text that was hashed
        contentRoot       : Hex64;
        fields            : LargeString; // JSON array
        emptyFields       : LargeString; // JSON array
        schemaId          : Hex64;
        schema            : LargeString; // JSON array
        leaves            : LargeString; // JSON array of 64 hex
        opening           : LargeString; // JSON
    };

    /**
     * Builds the set of allowed values for issueFieldMembershipAttestation.
     * With `value` or `valueDigest` it also returns the path that proves the value is in the set.
     */
    action   prepareMembershipSet(allowedValuesJson: LargeString, // JSON array of up to 64 strings
                                  value: String, // optional
                                  valueDigest: Hex64, // optional; blake2b-256 of value
                                  compiledArtifactRef: String // optional, default 'attestation-vault'
    )                                                                         returns {
        setRoot         : Hex64;
        memberCount     : Integer;
        setSiblingsJson : String;
        setDirsJson     : String;
    };

    /**
     * Records on chain that an agent produced an output from an input, signed by the session's wallet.
     * Anyone can check it by hashing `envelopeJson` and calling verifyAttestationState.
     */
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

    /**
     * Creates a token that lets an agent act as the caller on one wallet session. The agent sends it in the `x-agent-token` header.
     * The agent may only call `allowedActions`, the verify functions and getJobStatus.
     * The allowed lists can only narrow what the platform's sponsor policy allows.
     */
    action   createAgentGrant(sessionId: UUID,
                              allowedActions: array of String,
                              maxJobsPerDay: Integer, // optional, default unlimited
                              sponsorSessionId: UUID, // optional
                              validUntil: Timestamp, // optional, default no expiry
                              agentLabel: String, // optional
                              allowedContracts: array of String, // optional, default all the platform allows
                              allowedCircuits: array of String, // optional, default all the platform allows
                              allowDeploy: Boolean, // optional; the sponsor pays for deploys built by the agent, needs NIGHTGATE_SPONSOR_ALLOW_DEPLOY
                              maxDeploys: Integer, // optional, default 1 when allowDeploy is true
                              allowedTokenTypes: array of Hex64 // optional, default all the platform allows
    )                                                                         returns {
        grantId           : UUID;
        token             : String; // shown only once
        allowedActions    : array of String;
        allowedContracts  : array of String;
        allowedCircuits   : array of String;
        allowDeploy       : Boolean;
        maxDeploys        : Integer;
        allowedTokenTypes : array of String;
        validUntil        : Timestamp;
    };

    /**
     * Creates up to 50 grants with the same settings, each with its own token.
     * Without `labels` they are named `<agentLabel>-1` to `<agentLabel>-n`.
     */
    action   createAgentGrants(count: Integer,
                               sessionId: UUID,
                               allowedActions: array of String,
                               labels: array of String, // optional; exactly count entries
                               maxJobsPerDay: Integer, // optional, default unlimited
                               sponsorSessionId: UUID, // optional
                               validUntil: Timestamp, // optional, default no expiry
                               agentLabel: String, // optional
                               allowedContracts: array of String, // optional, default all the platform allows
                               allowedCircuits: array of String, // optional, default all the platform allows
                               allowDeploy: Boolean, // optional; the sponsor pays for deploys built by the agent, needs NIGHTGATE_SPONSOR_ALLOW_DEPLOY
                               maxDeploys: Integer, // optional, default 1 when allowDeploy is true
                               allowedTokenTypes: array of Hex64 // optional, default all the platform allows
    )                                                                         returns {
        grants            : array of {
            grantId    : UUID;
            token      : String; // shown only once
            agentLabel : String;
        };
        allowedActions    : array of String;
        allowedContracts  : array of String;
        allowedCircuits   : array of String;
        allowDeploy       : Boolean;
        maxDeploys        : Integer;
        allowedTokenTypes : array of String;
        validUntil        : Timestamp;
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
                              allowedContracts: array of String,
                              allowedCircuits: array of String,
                              allowedTokenTypes: array of String,
                              allowDeploy: Boolean,
                              maxDeploys: Integer,
                              validUntil: Timestamp)                          returns {
        grantId : UUID;
        updated : array of String;
    };

    /** Replaces a grant's token. The old token stops working at once. */
    action   rotateAgentGrantToken(grantId: UUID)                             returns {
        grantId : UUID;
        token   : String; // shown only once
    };

    /** What a grant did between `since` and `until`, by default the last 30 days, at most 366 days. */
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
    };

    /**
     * Returns the status of a background job. Poll until `status` is `succeeded` or `failed`.
     * `result` is the action's result as JSON. This is a POST but changes nothing.
     */

    action   getJobStatus(jobId: UUID,
                          sessionId: UUID)                                    returns {
        jobId               : UUID;
        kind                : String;
        status              : String; // pending | running | external_execution | submitted | reconciliation_required | succeeded | failed
        result              : LargeString;
        errorCode           : String;
        errorMessage        : LargeString;
        attempt             : Integer;
        maxAttempts         : Integer;
        submissionId        : UUID;
        txHash              : String;
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
