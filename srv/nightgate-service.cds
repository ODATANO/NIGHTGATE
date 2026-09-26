using {midnight} from '../db/schema';

/** Midnight chain data, attestations and proofs, wallet sessions, async submission jobs. */
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

    // ---- Smart contracts ----

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

    // ---- UTXOs ----

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

    // ---- Ledger events ----

    @readonly
    entity ZswapLedgerEvents     as projection on midnight.ZswapLedgerEvents;

    @readonly
    entity DustLedgerEvents      as projection on midnight.DustLedgerEvents;

    // ---- Balances ----

    /** Unshielded NIGHT balance per address. */
    @readonly
    entity NightBalances         as projection on midnight.NightBalances
        actions {
            @cds.odata.bindingparameter.collection
            function getBalance(address: String)   returns NightBalances;

            @cds.odata.bindingparameter.collection
            function getTopHolders(limit: Integer) returns array of NightBalances;
        };

    // ---- Submissions ----

    /** Submissions made by this instance; the crawler marks them `finalized` once indexed. */
    @readonly
    entity PendingSubmissions    as
        projection on midnight.PendingSubmissions
        excluding {
            submitIntentData
        };

    // ---- Document anchoring ----

    /** Anchored documents, owner-scoped. */
    @readonly
    entity Documents             as projection on midnight.Documents;

    /**
     * Anchor a document hash and public metadata (vault `attest`) under
     * `recordKey(attesterId, sha256)` of the session's attester, which no other
     * identity can take over. The bytes at `storageRef` are the caller's job.
     * Async; the Documents row exists at once. Job result
     * `{ documentId, attestationId, attesterId, txHash, anchoredAt }`.
     */
    action   anchorDocument(sha256: String,
                            contentType: String,
                            size: Integer64,
                            storageRef: String,
                            metadata: LargeString, // JSON
                            sessionId: UUID,
                            contractAddress: String, // AttestationVault deployment to anchor into
                            compiledArtifactRef: String, // optional, defaults to 'attestation-vault'
                            idempotencyKey: String, // optional; dedupes retries
                            sponsorSessionId: UUID // optional; second session pays the dust fee
    )                                                                 returns {
        jobId      : UUID;
        status     : String; // 'pending' | 'succeeded' (idempotent retry)
        documentId : UUID; // Documents row handle
        attesterId : String; // 64 hex; with sha256 names the on-chain record
    };

    /**
     * Check `providedSha256` against an anchored document. Invalid input:
     * 400/404; mismatch or unconfirmed anchor: `verified: false`. Evidence is
     * the indexed tx, or live vault state (recorded vault, else `contractAddress`).
     */
    function verifyDocument(documentId: UUID,
                            providedSha256: String,
                            contractAddress: String, // optional; enables the live-state check for unrecorded rows
                            compiledArtifactRef: String // optional, defaults to 'attestation-vault'
    )                                                                 returns {
        verified       : Boolean; // attestation stands in live state; without a live provider: included
        included       : Boolean; // anchoring tx indexed as SUCCESS
        stateChecked   : Boolean; // false = verdict from the index only
        anchoredTxHash : String;
        anchoredAt     : Timestamp;
        originalSha256 : String;
    };

    // ---- ZK predicate attestations ----

    /** Rows from the issue* actions; `provenTxHash`/`provenAt` set on inclusion. Claims are root-bound and immutable. */
    @readonly
    entity PredicateAttestations as projection on midnight.PredicateAttestations;

    /**
     * Prove the value at `fieldKey` of an anchored content root satisfies
     * `predicate` against `threshold` (vault `proveFieldPredicate`, Merkle
     * inclusion). A given `contentRoot` is anchored first. `value` and
     * `fieldSalt` stay witness, never persisted. Async.
     */
    action   issueFieldPredicateAttestation(payloadHash: String, // attestation payload_hash (64 hex)
                                            attesterId: String, // optional 64 hex; record owner, default the session (contentRoot anchors only under the session's own record)
                                            fieldKey: String, // 64 hex canonical field id (public)
                                            value: String, // scaled integer, decimal string (witness only)
                                            fieldSalt: String, // 64-hex slot salt from prepareDocumentProof (witness)
                                            contentRoot: String, // optional 64-hex Merkle root to anchor first
                                            schemaId: String, // 64-hex schema id, required with contentRoot
                                            siblingsJson: String, // JSON array of 64-hex siblings; depth 4 (width 16) or 5 (width 32)
                                            dirsJson: String, // JSON array of left-child flags, one per level
                                            predicate: String, // 'lessOrEqual' | 'greaterOrEqual'
                                            threshold: Integer64, // scaled integer
                                            unit: String, // optional, informational
                                            sessionId: UUID,
                                            contractAddress: String, // AttestationVault deployment
                                            compiledArtifactRef: String, // optional, defaults to 'attestation-vault'
                                            idempotencyKey: String, // optional; dedupes retries
                                            sponsorSessionId: UUID, // optional; second session pays the dust fee
                                            validUntil: Integer64 // optional expiry, UNIX seconds; default +1 year (NIGHTGATE_CLAIM_LIFETIME_S), max 5 years
    )                                                                 returns {
        jobId                  : UUID;
        status                 : String;
        predicateAttestationId : UUID;
    };

    /**
     * Prove up to 8 claims on one payload in ONE transaction (7 when
     * `contentRoot` is anchored in the same batch). `claimsJson` entries,
     * by `predicate`, each validated like its single action:
     *   lessOrEqual|greaterOrEqual: `{ fieldKey, value, siblings, dirs, threshold, unit? }`
     *   bytesEquality: `{ fieldKey, expectedValue|expectedDigest, siblings, dirs }`
     *   setMembership: `{ fieldKey, value|valueDigest, allowedValues | setRoot+setSiblings+setDirs, siblings, dirs }`
     *   documentIntegrity|documentDiff: `{ payloadHashB, attesterIdB?, allowedMask|k, schema, openingA, openingB }`
     * Cross-root: document A = `payloadHash`, B's root must be anchored already.
     * Duplicate claims are dropped (`droppedDuplicates`). A false claim fails at
     * local proving, nothing submitted; PARTIAL_SUCCESS on chain fails the job,
     * so verify per claim. Rate limit counts claims. Async.
     */
    action   issueFieldPredicateAttestationBatch(payloadHash: String, // shared attestation payload_hash (64 hex)
                                                 attesterId: String, // optional 64 hex; record owner, default the session (contentRoot anchors only under the session's own record)
                                                 contentRoot: String, // optional 64-hex Merkle root, anchored in-batch first
                                                 schemaId: String, // 64-hex schema id (required with contentRoot)
                                                 claimsJson: LargeString, // JSON array of claims
                                                 sessionId: UUID,
                                                 contractAddress: String, // AttestationVault deployment
                                                 compiledArtifactRef: String, // optional, defaults to 'attestation-vault'
                                                 idempotencyKey: String, // optional; dedupes retries
                                                 sponsorSessionId: UUID, // optional; second session pays the dust fee
                                                 validUntil: Integer64 // optional expiry, UNIX seconds; default +1 year (NIGHTGATE_CLAIM_LIFETIME_S), max 5 years
    )                                                                 returns {
        jobId             : UUID;
        status            : String;
        claims            : LargeString; // JSON array of { predicateAttestationId, fieldKey, predicate, threshold, unit }, submission order
        droppedDuplicates : Integer;
    };

    /**
     * Prove the 'bytes' field at `fieldKey` holds the value behind the public
     * `expectedDigest` (vault `proveFieldEquality`). Authenticity, not
     * confidentiality: a low-entropy value is guessable from its digest. Pass
     * one of `expectedValue` or `expectedDigest`. A given `contentRoot` is anchored first. Async.
     */
    action   issueFieldEqualityAttestation(payloadHash: String, // attestation payload_hash (64 hex)
                                           attesterId: String, // optional 64 hex; record owner, default the session (contentRoot anchors only under the session's own record)
                                           fieldKey: String, // 64 hex canonical field id (public)
                                           expectedValue: String, // exact string, digested server-side
                                           expectedDigest: String, // 64-hex blake2b-256 of the exact value string
                                           fieldSalt: String, // 64-hex slot salt from prepareDocumentProof (witness)
                                           contentRoot: String, // optional 64-hex Merkle root to anchor first
                                           schemaId: String, // 64-hex schema id, required with contentRoot
                                           siblingsJson: String, // JSON array of 64-hex siblings; depth 4 (width 16) or 5 (width 32)
                                           dirsJson: String, // JSON array of left-child flags, one per level
                                           sessionId: UUID,
                                           contractAddress: String, // AttestationVault deployment
                                           compiledArtifactRef: String, // optional, defaults to 'attestation-vault'
                                           idempotencyKey: String, // optional; dedupes retries
                                           sponsorSessionId: UUID, // optional; second session pays the dust fee
                                           validUntil: Integer64 // optional expiry, UNIX seconds; default +1 year (NIGHTGATE_CLAIM_LIFETIME_S), max 5 years
    )                                                                 returns {
        jobId                  : UUID;
        status                 : String;
        predicateAttestationId : UUID;
    };

    /**
     * Prove the hidden 'bytes' value at `fieldKey` is one of a public
     * allow-list of up to 64 values (vault `proveFieldMembership`; set rule in
     * `prepareMembershipSet`). Pass one of `value` or `valueDigest` (witness,
     * never persisted), and `allowedValuesJson` (400 before proving if the value
     * is not in it) or `setRoot` + set path. Async.
     */
    action   issueFieldMembershipAttestation(payloadHash: String, // attestation payload_hash (64 hex)
                                             attesterId: String, // optional 64 hex; record owner, default the session (contentRoot anchors only under the session's own record)
                                             fieldKey: String, // 64 hex canonical field id (public)
                                             value: String, // exact string (witness)
                                             valueDigest: String, // 64-hex blake2b-256 of the exact string (witness)
                                             allowedValuesJson: LargeString, // JSON array of allowed strings
                                             setRoot: String, // 64-hex canonical set root
                                             setSiblingsJson: String, // JSON array of 6 × 64-hex sibling digests
                                             setDirsJson: String, // JSON array of 6 booleans (left-child flags)
                                             fieldSalt: String, // 64-hex slot salt from prepareDocumentProof (witness)
                                             contentRoot: String, // optional 64-hex Merkle root to anchor first
                                             schemaId: String, // 64-hex schema id, required with contentRoot
                                             siblingsJson: String, // JSON array of 64-hex siblings; depth 4 (width 16) or 5 (width 32)
                                             dirsJson: String, // JSON array of left-child flags, one per level
                                             sessionId: UUID,
                                             contractAddress: String, // AttestationVault deployment
                                             compiledArtifactRef: String, // optional, defaults to 'attestation-vault'
                                             idempotencyKey: String, // optional; dedupes retries
                                             sponsorSessionId: UUID, // optional; second session pays the dust fee
                                             validUntil: Integer64 // optional expiry, UNIX seconds; default +1 year (NIGHTGATE_CLAIM_LIFETIME_S), max 5 years
    )                                                                 returns {
        jobId                  : UUID;
        status                 : String;
        predicateAttestationId : UUID;
    };

    /**
     * Prove document B differs from A only in slots set in `allowedMask`,
     * values hidden (vault `proveDocumentComparison` mode 0). Both prepared with
     * the same proofFields order; both roots anchored (`contentRootA`/`B` anchor
     * first, one tx each). A change outside the mask fails at local proving.
     * A != B; (A, B) order is part of the claim key. Async.
     */
    action   issueDocumentIntegrityAttestation(payloadHashA: String, // document A payload_hash (64 hex)
                                               payloadHashB: String, // document B payload_hash (64 hex)
                                               attesterIdA: String, // optional 64 hex; document A's attester (default: the session's own)
                                               attesterIdB: String, // optional 64 hex; document B's attester (default attesterIdA)
                                               allowedMask: Integer64, // width-bit slot mask, bit i = slot i may differ; Int64 so bit 31 fits
                                               schemaJson: LargeString, // shared schema from prepareDocumentProof, one descriptor per slot
                                               openingAJson: LargeString, // document A opening { saltSeed, slots[width] } (witness)
                                               openingBJson: LargeString, // document B opening { saltSeed, slots[width] } (witness)
                                               contentRootA: String, // optional 64-hex root to anchor for A first
                                               contentRootB: String, // optional 64-hex root to anchor for B first
                                               schemaId: String, // 64-hex shared schema id, required when anchoring
                                               sessionId: UUID,
                                               contractAddress: String, // AttestationVault deployment
                                               compiledArtifactRef: String, // optional, defaults to 'attestation-vault'
                                               idempotencyKey: String, // optional; dedupes retries
                                               sponsorSessionId: UUID, // optional; second session pays the dust fee
                                               validUntil: Integer64 // optional expiry, UNIX seconds; default +1 year (NIGHTGATE_CLAIM_LIFETIME_S), max 5 years
    )                                                                 returns {
        jobId                  : UUID;
        status                 : String;
        predicateAttestationId : UUID;
    };

    /**
     * Prove at least `k` aligned slots differ between two anchored documents,
     * hiding which (vault `proveDocumentComparison` mode 1). A value or presence
     * change counts; both-empty and padding slots do not. Witnesses and
     * anchoring as issueDocumentIntegrityAttestation; fewer than k differences
     * fail at local proving. (A, B) order is part of the claim key. Async.
     */
    action   issueDocumentDiffAttestation(payloadHashA: String, // document A payload_hash (64 hex)
                                          payloadHashB: String, // document B payload_hash (64 hex)
                                          attesterIdA: String, // optional 64 hex; document A's attester (default: the session's own)
                                          attesterIdB: String, // optional 64 hex; document B's attester (default attesterIdA)
                                          k: Integer, // minimum differing slots, 1..width
                                          schemaJson: LargeString, // shared schema from prepareDocumentProof, one descriptor per slot
                                          openingAJson: LargeString, // document A opening { saltSeed, slots[width] } (witness)
                                          openingBJson: LargeString, // document B opening { saltSeed, slots[width] } (witness)
                                          contentRootA: String, // optional 64-hex root to anchor for A first
                                          contentRootB: String, // optional 64-hex root to anchor for B first
                                          schemaId: String, // 64-hex shared schema id, required when anchoring
                                          sessionId: UUID,
                                          contractAddress: String, // AttestationVault deployment
                                          compiledArtifactRef: String, // optional, defaults to 'attestation-vault'
                                          idempotencyKey: String, // optional; dedupes retries
                                          sponsorSessionId: UUID, // optional; second session pays the dust fee
                                          validUntil: Integer64 // optional expiry, UNIX seconds; default +1 year (NIGHTGATE_CLAIM_LIFETIME_S), max 5 years
    )                                                                 returns {
        jobId                  : UUID;
        status                 : String;
        predicateAttestationId : UUID;
    };

    /**
     * Verify a PredicateAttestations row: its claim key (recomputed from the
     * row) is unexpired under the payload's current anchor in live vault state,
     * or without a live provider the proof tx is indexed as SUCCESS. Unproven,
     * re-anchored or expired: `verified: false`, not an error. Claim-key
     * struct layouts (tags 16-20): the vault's Compact source.
     */
    function verifyPredicateAttestation(predicateAttestationId: UUID) returns {
        verified       : Boolean; // unexpired under the current anchor; without a live provider: included
        included       : Boolean; // proof tx indexed as SUCCESS
        stateChecked   : Boolean; // false = verdict from the index only
        predicate      : String;
        threshold      : Integer64; // numeric: scaled threshold; documentDiff: k
        unit           : String;
        expectedDigest : String; // bytesEquality
        setRoot        : String; // setMembership
        payloadHashB   : String; // cross-root: document B
        allowedMask    : Integer64; // documentIntegrity: width-bit slot mask
        provenTxHash   : String;
        provenAt       : Timestamp;
    };

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

    /**
     * On-chain disclosure grants indexed from the vault `disclosures` map (not
     * the off-chain DisclosureRoles). `level` 0 public, 1 legitimate interest,
     * 2 authority; `active` while present on chain.
     */
    @readonly
    entity DisclosureGrants      as projection on midnight.DisclosureGrants;

    /**
     * Reconcile DisclosureGrants with the vault `disclosures` map in live state,
     * e.g. after a wallet-submitted grant or revoke. Idempotent. `active` =
     * grants on chain afterwards; zero without a live provider.
     */
    action   reindexDisclosures(contractAddress: String,
                                compiledArtifactRef: String // optional, defaults to 'attestation-vault'
    )                                                                 returns {
        contractAddress : String;
        active          : Integer;
        deactivated     : Integer;
        reconciledAt    : Timestamp;
    };

    /**
     * Grant `grantee` a disclosure `level` (0 public, 1 legitimate interest,
     * 2 authority) on an attestation (vault `grantDisclosure`); attester-only,
     * enforced in-circuit. Async; the DisclosureGrants row exists at once,
     * inactive. Job result `{ disclosureGrantId, payloadHash, grantee, level, txHash }`.
     */
    action   grantDisclosure(payloadHash: String, // 64 hex, the attestation
                             grantee: String, // 64 hex Bytes<32> grantee identifier
                             level: Integer, // 0 | 1 | 2
                             sessionId: UUID,
                             contractAddress: String, // AttestationVault deployment
                             compiledArtifactRef: String, // optional, defaults to 'attestation-vault'
                             idempotencyKey: String, // optional; dedupes retries
                             sponsorSessionId: UUID // optional; second session pays the dust fee
    )                                                                 returns {
        jobId             : UUID;
        status            : String;
        disclosureGrantId : UUID;
    };

    /**
     * Remove a grantee's disclosure on chain (vault `revokeDisclosure`);
     * attester-only. Async; job result `{ payloadHash, grantee, txHash }`.
     */
    action   revokeDisclosure(payloadHash: String, // 64 hex, the attestation
                              grantee: String, // 64 hex Bytes<32> grantee identifier
                              sessionId: UUID,
                              contractAddress: String, // AttestationVault deployment
                              compiledArtifactRef: String, // optional, defaults to 'attestation-vault'
                              idempotencyKey: String, // optional; dedupes retries
                              sponsorSessionId: UUID // optional; second session pays the dust fee
    )                                                                 returns {
        jobId  : UUID;
        status : String;
    };

    /**
     * Document id registry (vault `registerDocument`), registrar-only in-circuit.
     * `mode` 0 assigns `documentId` to `ownerId`, the only attester who may bind
     * it (re-registering transfers it and releases another attester's binding);
     * 1 unregisters; 2 hands the registrar role to `ownerId`; 3 and 4 are
     * recovery-only: 3 re-points the registrar, 4 hands the recovery role over.
     * Async; job result `{ documentId, ownerId, mode, contractAddress, txHash }`.
     */
    action   registerPassport(documentId: String, // 64 hex Bytes<32> document identifier
                              passportId: String, // alias of documentId
                              ownerId: String, // 64 hex Bytes<32> attester id that may bind the document
                              mode: Integer, // optional; 0 register (default), 1 unregister, 2 transfer registrar, 3 recovery sets registrar, 4 recovery sets recovery
                              sessionId: UUID, // the registrar (modes 0-2) or the recovery identity (modes 3-4)
                              contractAddress: String, // AttestationVault deployment
                              compiledArtifactRef: String, // optional, defaults to 'attestation-vault'
                              idempotencyKey: String, // optional; dedupes retries
                              sponsorSessionId: UUID // optional; second session pays the dust fee
    )                                                                 returns {
        jobId  : UUID;
        status : String;
    };

    /**
     * Retract a payload (vault `retract` mode 0), owner-only in-circuit: the
     * attestation, content anchor, disclosure grants and document binding leave
     * the chain; claims against its root stop verifying. Async; job result
     * `{ mode, key, contractAddress, txHash }`.
     */
    action   retractAttestation(payloadHash: String, // 64 hex, the attestation
                                sessionId: UUID, // must own the attestation
                                contractAddress: String, // AttestationVault deployment
                                compiledArtifactRef: String, // optional, defaults to 'attestation-vault'
                                idempotencyKey: String, // optional; dedupes retries
                                sponsorSessionId: UUID // optional; second session pays the dust fee
    )                                                                 returns {
        jobId  : UUID;
        status : String;
    };

    /**
     * Remove an expired entry (vault `retract`); anyone may call, unexpired
     * entries are refused. Async; job result `{ mode, key, contractAddress, txHash }`.
     */
    action   purgeExpired(kind: String, // 'claim'
                          key: String, // 64 hex claim key
                          sessionId: UUID, // any wallet session
                          contractAddress: String, // AttestationVault deployment
                          compiledArtifactRef: String, // optional, defaults to 'attestation-vault'
                          idempotencyKey: String, // optional; dedupes retries
                          sponsorSessionId: UUID // optional; second session pays the dust fee
    )                                                                 returns {
        jobId  : UUID;
        status : String;
    };

    /** Principal to on-chain grantee id bindings. */
    @readonly
    entity GranteeIdentities     as projection on midnight.GranteeIdentities;

    /**
     * Bind the caller to the Bytes<32> grantee id the vault checks. Per
     * `cds.requires.nightgate.granteeBinding` (default 'wallet') `bindingInput`
     * is the coin public key hex ('wallet'), a DID ('did') or the 64-hex id
     * ('custom'). Idempotent on (user, scope).
     */
    action   registerGranteeIdentity(bindingInput: String,
                                     scope: String // optional; omit for a global binding
    )                                                                 returns {
        ID          : UUID;
        granteeId   : String;
        bindingKind : String;
    };

    /**
     * Deploy a registered contract. Async; job result `{ submissionId, txHash,
     * contractAddress, status }` (status = PendingSubmissions lifecycle).
     */
    action   deployContract(compiledArtifactRef: String,
                            sessionId: UUID,
                            initialPrivateState: LargeString, // JSON-encoded
                            idempotencyKey: String, // optional; dedupes retries
                            sponsorSessionId: UUID, // optional; second session pays the dust fee
                            recoveryId: String // optional 64 hex; vault family: attester id that may re-point the registrar (registerPassport modes 3/4); absent = no recovery
    )                                                                 returns {
        jobId  : UUID;
        status : String; // 'pending' | 'succeeded' (idempotent retry)
    };

    /**
     * Call a circuit on a deployed contract. Missing private state is seeded
     * from `initialPrivateState` (default `{}`), never overwritten. A
     * `sponsorSessionId` pays the dust fee and submits; it must be
     * signing-capable and the caller's own or a platform sponsor
     * (`NIGHTGATE_FEE_SPONSOR_SESSION` / `feeSponsorSessions`). Async; job
     * result `{ submissionId, txHash, contractAddress, status }`.
     */
    action   submitContractCall(contractAddress: String,
                                circuit: String,
                                compiledArtifactRef: String,
                                sessionId: UUID,
                                args: LargeString, // JSON-encoded array, may be '[]'
                                idempotencyKey: String, // optional; dedupes retries
                                initialPrivateState: LargeString, // optional JSON; seeded on this wallet's first call
                                sponsorSessionId: UUID // optional; second session pays the dust fee
    )                                                                 returns {
        jobId  : UUID;
        status : String; // 'pending' | 'succeeded' (idempotent retry)
    };

    /**
     * Build, prove and sign a call under the caller's identity without
     * submitting, for a sponsor's sponsorFinalizedTransaction. Async; job
     * result `{ finalizedTxB64, serializedBytes }`.
     */
    action   buildSponsorable(contractAddress: String,
                              circuit: String,
                              compiledArtifactRef: String,
                              sessionId: UUID,
                              args: LargeString)                      returns {
        jobId  : UUID;
        status : String;
    };

    /**
     * Pay the dust for a caller-finalized, fee-unpaid tx and submit it, within
     * the sponsor's contract/circuit allow-list. Async; job result
     * `{ txHash, circuits, contractAddress }`.
     */
    action   sponsorFinalizedTransaction(finalizedTxB64: LargeString,
                                         sponsorSessionId: UUID,
                                         idempotencyKey: String)      returns {
        jobId     : UUID;
        status    : String;
        sessionId : UUID; // sponsor session; poll getJobStatus with it
    };

    /**
     * Sponsor an unbound (pre-binding) signed tx (txbuilder `bind: false`):
     * merge a dust spend, bind, submit. Parallel up to the sponsor's free dust
     * backings; policy as sponsorFinalizedTransaction. Poll with `sessionId`.
     */
    action   sponsorUnboundTransaction(unboundTxB64: LargeString,
                                       sponsorSessionId: UUID,
                                       idempotencyKey: String)        returns {
        jobId     : UUID;
        status    : String;
        sessionId : UUID;
    };

    /**
     * Run up to 8 calls on one contract as ONE transaction. Apply order = call
     * order, so dependent calls may be batched (same-name circuits are unordered
     * among themselves). An error before submit submits nothing; PARTIAL_SUCCESS
     * on chain fails the job, so verify effects. Seeding, sponsoring and auth as
     * submitContractCall. Async; job result `{ submissionId, txHash, contractAddress, circuits, status }`.
     */
    action   submitContractCallBatch(contractAddress: String,
                                     calls: LargeString, // JSON array of { circuit, args }
                                     compiledArtifactRef: String,
                                     sessionId: UUID,
                                     idempotencyKey: String, // optional; dedupes retries
                                     initialPrivateState: LargeString, // optional JSON; seeded on this wallet's first call
                                     sponsorSessionId: UUID, // optional; second session pays the dust fee
                                     independentCalls: Boolean // optional; calls share no state: order by execution stage instead of call order
    )                                                                 returns {
        jobId  : UUID;
        status : String; // 'pending' | 'succeeded' (idempotent retry)
    };

    /**
     * Mint 100000000 atoms of the bundled `shielded-token` test token (deployed
     * with `compiledArtifactRef: 'shielded-token'`) to the caller's zswap key;
     * send it with `sendNight(tokenTypeHex)`. Async; job result
     * `{ submissionId, txHash, contractAddress, tokenTypeHex, amount }`.
     */
    action   mintShieldedTestToken(contractAddress: String,
                                   sessionId: UUID,
                                   compiledArtifactRef: String, // optional; defaults to 'shielded-token'
                                   idempotencyKey: String, // optional; dedupes retries
                                   sponsorSessionId: UUID // optional; second session pays the dust fee
    )                                                                 returns {
        jobId  : UUID;
        status : String; // 'pending' | 'succeeded' (idempotent retry)
    };

    /**
     * Compute `rawTokenType(domainSeparator, contractAddress)` for a minting
     * contract, no wallet or chain access. `domainSeparator`: the string the
     * contract padded, or 64 hex. Feeds `sendNight(tokenTypeHex)`.
     */
    function deriveTokenType(contractAddress: String,
                             domainSeparator: String // optional; string or 64 hex, defaults to the bundled test token's
    )                                                                 returns {
        tokenTypeHex    : String;
        contractAddress : String;
        domainSeparator : String; // padded 64-hex form used
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

    /** Create a read-only session; the viewing key is stored encrypted. */
    action   connectWallet(viewingKey: String,
                           label: String // optional, <= 100 chars
    )                                                                 returns {
        ID          : UUID;
        sessionId   : UUID;
        label       : String;
        connectedAt : Timestamp;
        expiresAt   : Timestamp;
        isActive    : Boolean;
    };

    /** Close a session and null its encrypted keys. */
    action   disconnectWallet(sessionId: UUID);

    /**
     * Enable signing on a session: store the BIP39 seed encrypted (Lace-exact
     * HD derivation). 400, fail-closed, unless the seed at `accountIndex` derives
     * the session's viewing key. Signing works on return; `prewarmJobId` tracks
     * the wallet sync, which later actions otherwise wait for.
     */
    action   connectWalletForSigning(sessionId: UUID,
                                     mnemonic: String, // BIP39 phrase; one of mnemonic|seedHex required
                                     seedHex: String, // optional: 64-byte BIP39 seed as 128 hex chars
                                     accountIndex: Integer, // optional, default 0; must match the session's viewing-key account
                                     idempotencyKey: String, // optional; dedupes retries
                                     prewarm: Boolean // optional; false skips the prewarm job (the wallet syncs on demand)
    )                                                                 returns {
        sessionId      : UUID;
        signingEnabled : Boolean;
        prewarmJobId   : UUID;
        prewarmStatus  : String; // 'pending' | 'succeeded' (idempotent retry)
    };

    /**
     * Derive a wallet's viewing key, addresses and attester id from a mnemonic
     * or seed; creates no session, stores and logs nothing. Matches
     * connectWalletForSigning for the same `accountIndex`.
     */
    action   deriveWalletInfo(mnemonic: String, // BIP39 recovery phrase; one of mnemonic|seedHex required
                              seedHex: String, // optional: 64-byte BIP39 seed as 128 hex chars
                              accountIndex: Integer // optional, default 0
    )                                                                 returns {
        viewingKey      : String; // 64 hex; connectWallet input
        shieldedAddress : String; // mn_shield-addr_...
        nightAddress    : String; // mn_addr_...
        dustAddress     : String; // mn_dust_...; a dustReceiverAddress for registerForDustGeneration
        attesterId      : String; // 64 hex vault caller id; usable as registerPassport ownerId before any call
        accountIndex    : Integer;
        network         : String; // the configured network
    };

    /**
     * Register the session's NIGHT UTXOs for DUST (fee token) generation; DUST
     * accrues 1-2 min after the tx settles. Async; job result
     * `{ txId, registeredCount, totalNightUtxos, dustReceiverAddress }`.
     */
    action   registerForDustGeneration(sessionId: UUID,
                                       dustReceiverAddress: String, // optional; defaults to the wallet's own DUST address
                                       idempotencyKey: String // optional; dedupes retries
    )                                                                 returns {
        jobId  : UUID;
        status : String; // 'pending' | 'succeeded' (idempotent retry)
    };

    /**
     * Remove all of the wallet's NIGHT UTXOs from dust generation. Async; job
     * result `{ txId, deregisteredCount, totalNightUtxos }`.
     */
    action   deregisterFromDustGeneration(sessionId: UUID,
                                          idempotencyKey: String, // optional
                                          sponsorSessionId: UUID // optional; second session pays the dust fee (a fully delegated wallet has none)
    )                                                                 returns {
        jobId  : UUID;
        status : String; // 'pending' | 'succeeded' (idempotent retry)
    };

    /**
     * Send NIGHT or `tokenTypeHex` to an address. The prefix picks the ledger
     * (`mn_shield-addr_` shielded, `mn_addr_` unshielded); funds come from the
     * same ledger. Async; job result `{ txId, toLedger, amount, receiverAddress }`.
     */
    action   sendNight(sessionId: UUID,
                       receiverAddress: String,
                       amount: String, // atoms, decimal string
                       ttlIso: String, // optional ISO-8601; defaults to +10min
                       idempotencyKey: String, // optional; dedupes retries
                       tokenTypeHex: String // optional raw token type (64 hex) instead of NIGHT
    )                                                                 returns {
        jobId  : UUID;
        status : String; // 'pending' | 'succeeded' (idempotent retry)
    };

    // ---- Diagnostics (read-only) ----

    /** Wallet balances; amounts are decimal atom strings. */
    function getWalletBalance(sessionId: UUID)                        returns {
        shieldedNight            : String;
        unshieldedNight          : String;
        shieldedTokens           : array of { // shielded token types other than NIGHT
            tokenType : String; // raw token type, 64 hex (see deriveTokenType)
            amount    : String; // atoms, decimal string
        };
        dustBalance              : String;
        registeredNightUtxoCount : Integer;
        totalNightUtxoCount      : Integer;
        dustUtxoCount            : Integer;
        dustPendingCount         : Integer;
        dustPendingValue         : String;
        dustRestoreCount         : Integer;
    };

    /**
     * Wallet catch-up progress from the worker's ~15 s snapshot. Healthy while
     * `appliedIndex` climbs; stuck when it stops or `isConnected` is false.
     * `known` false = nothing reported yet. Counts are dust ledger events
     * (decimal strings); `etaSeconds` is an order of magnitude.
     */
    function getWalletSyncProgress(sessionId: UUID)                   returns {
        known                : Boolean;
        caughtUp             : Boolean;
        appliedIndex         : String;
        streamTip            : String;
        behindEvents         : String; // streamTip - appliedIndex
        eventsPerSecond      : Decimal; // null until measurable
        etaSeconds           : Integer; // null if not derivable
        blockHeight          : String; // indexer block height
        isConnected          : Boolean;
        indexerFresh         : Boolean; // indexer tip recent enough to count as tip
        elapsedMs            : Integer; // duration of the current sync wait
        phase                : String; // 'prewarm' | 'balance' | ...
        updatedAt            : Timestamp; // last worker report
        lastProgressAt       : Timestamp; // appliedIndex last advanced; null if unreported
        staleSeconds         : Integer; // now - updatedAt
        stale                : Boolean; // past NIGHTGATE_SYNC_PROGRESS_STALE_S (60 s): nobody is syncing
        jobId                : UUID; // latest prewarm job; null if none
        jobStatus            : String;
        restoredFromSnapshot : Boolean; // false = cold start; null = no facade built
        snapshotSavedAt      : Timestamp;
        facadeBuildStartedAt : Timestamp;
        facadeBuiltAt        : Timestamp; // null while still deserializing
    };

    /**
     * Health of every configured platform fee sponsor. `usable`: spendable dust
     * notes and dust > 0. Amounts are null unless admin or session owner; an
     * unreadable sponsor is a row with `lastError`.
     */
    function getSponsorPoolStatus()                                   returns array of {
        sessionId            : UUID;
        configured           : Boolean;
        usable               : Boolean;
        dustBalance          : String; // null unless admin or session owner
        unshieldedNight      : String; // null unless admin or session owner
        totalNightUtxoCount  : Integer;
        registeredNightUtxos : Integer; // the sponsor's own NIGHT registered for dust generation
        dustNotes            : Integer; // spendable dust notes = parallel sponsoring capacity
        pendingDustNotes     : Integer; // > 0: spend in flight, or a leaked note
        dustRestoreCount     : Integer;
        caughtUp             : Boolean;
        stale                : Boolean;   // true: worker did not answer, figures are the last pushed ones
        asOf                 : Timestamp; // when the figures were read
        lastError            : String;
    };

    /** DUST fee estimate (atoms, decimal string) for a sendNight; no proof, no submit. */
    function estimateSendNightFee(sessionId: UUID,
                                  receiverAddress: String,
                                  amount: String,
                                  ttlIso: String, // optional
                                  tokenTypeHex: String // optional, raw token type instead of NIGHT
    )                                                                 returns {
        fee      : String;
        toLedger : String;
    };

    // ---- Proof preparation, provenance, agent grants, jobs ----

    /**
     * Hash canonical `documentJson` to `payloadHash` and build the salted
     * `contentRoot` + `schemaId` over the ordered proof fields (order = leaf
     * index, keep it stable). `kind` 'uint' (non-negative number x `scale`,
     * default 1000) or 'bytes' (digest of the exact string); `field` is a dot
     * path, absent values go to `emptyFields`. Compute-only, nothing persisted.
     * Store `opening` (losing the seed makes the root unprovable) and
     * `canonicalDocument` (the hashed byte form).
     */
    action   prepareDocumentProof(documentJson: LargeString, // JSON object: the full document
                                  proofFieldsJson: LargeString, // ordered JSON array of { field, kind?, scale? }, at most the slot width (16 or 32)
                                  saltSeed: String, // optional 64-hex salt seed (deterministic re-prepare); random if omitted
                                  compiledArtifactRef: String // optional, defaults to 'attestation-vault'
    )                                                                 returns {
        payloadHash       : String; // blake2b-256 of canonicalDocument (64 hex)
        canonicalDocument : LargeString; // the exact hashed byte form
        contentRoot       : String; // 64-hex SALTED Merkle root over the proof fields
        fields            : LargeString; // JSON array of { field, fieldKey, kind, value?, valueDigest?, salt, siblings, dirs }
        emptyFields       : LargeString; // JSON array of fields without a value (salted absent leaf)
        schemaId          : String; // 64-hex schema root of the ordered proof fields
        schema            : LargeString; // JSON array of slot descriptors { fieldKey, kind, scale } (public)
        leaves            : LargeString; // JSON array of 64-hex salted leaf hashes (informational)
        opening           : LargeString; // JSON { saltSeed, slots[width] }: witness bundle, store it
    };

    /**
     * Build the canonical depth-6 set root of an allow-list (blake2b-256 of each
     * exact string, dedupe, sort, pad to 64 with the last member). With `value`
     * or `valueDigest` also its inclusion path (witness; 400 if not a member).
     * Compute-only.
     */
    action   prepareMembershipSet(allowedValuesJson: LargeString, // JSON array of allowed strings (<= 64 distinct)
                                  value: String, // optional raw member string (pass this OR valueDigest)
                                  valueDigest: String, // optional 64-hex digest of the member value
                                  compiledArtifactRef: String // optional, defaults to 'attestation-vault'
    )                                                                 returns {
        setRoot         : String; // 64-hex canonical set root
        memberCount     : Integer; // distinct values in the set
        setSiblingsJson : String; // JSON array of 6 × 64-hex siblings (only with value/valueDigest)
        setDirsJson     : String; // JSON array of 6 booleans (only with value/valueDigest)
    };

    /**
     * Anchor a canonical provenance envelope `{ v, agentId, inputHash,
     * outputHash, producedAt, modelId?, policyHash? }` like anchorDocument.
     * Anyone verifies by re-hashing `envelopeJson` and calling
     * verifyAttestationState. The attester is the session wallet. Async.
     */
    action   attestAgentOutput(agentId: String, // agent identity (<= 200 chars), ideally a registered grantee id
                               inputHash: String, // 64 hex commitment to the agent's input
                               outputHash: String, // 64 hex commitment to the produced output
                               modelId: String, // optional model identifier (<= 200 chars)
                               policyHash: String, // optional 64 hex commitment to the governing policy
                               producedAt: Timestamp, // optional; defaults to now (server time)
                               storageRef: String, // optional; where output/envelope live, defaults to agent-output://<agentId>
                               sessionId: UUID,
                               contractAddress: String, // AttestationVault deployment
                               compiledArtifactRef: String, // optional, defaults to 'attestation-vault'
                               idempotencyKey: String, // optional; dedupes retries
                               sponsorSessionId: UUID // optional; second session pays the dust fee
    )                                                                 returns {
        jobId        : UUID;
        status       : String;
        documentId   : UUID; // Documents row handle
        payloadHash  : String; // blake2b-256 of envelopeJson, the anchored value
        envelopeJson : LargeString; // canonical envelope; re-hash to verify
    };

    /** The caller's agent grants. */
    @readonly
    entity AgentGrants           as
        projection on midnight.AgentGrants
        excluding {
            tokenHash
        };

    /**
     * Create a revocable bearer token over one of the caller's sessions.
     * Requests with it in `x-agent-token` run as the caller, limited to
     * `allowedActions` (attestation/predicate/disclosure only) plus verify and
     * getJobStatus, the grant's session, `maxJobsPerDay` and a fixed
     * `sponsorSessionId` (checked now, 4xx if unusable).
     */
    action   createAgentGrant(sessionId: UUID,
                              allowedActions: array of String,
                              maxJobsPerDay: Integer, // optional; null = unlimited
                              sponsorSessionId: UUID, // optional; fixed fee-sponsor binding
                              validUntil: Timestamp, // optional; null = no expiry
                              agentLabel: String, // optional, informational
                              allowedContracts: array of String, // optional; sponsorable contracts, effective = platform floor ∩ grant; absent = the floor
                              allowedCircuits: array of String, // optional; same rule for circuit names
                              allowDeploy: Boolean, // optional; sponsor pays a caller-built deploy (needs a sponsor* action and NIGHTGATE_SPONSOR_ALLOW_DEPLOY); the address becomes sponsorable
                              maxDeploys: Integer, // optional lifetime deploy budget; default 1 when allowDeploy
                              allowedTokenTypes: array of String // optional raw shielded token types (64 hex) whose offers the sponsor pays; floor ∩ grant (NIGHTGATE_SPONSOR_ALLOWED_TOKEN_TYPES)
    )                                                                 returns {
        grantId           : UUID;
        token             : String; // shown once, never stored
        allowedActions    : array of String;
        allowedContracts  : array of String; // empty = platform floor
        allowedCircuits   : array of String;
        allowDeploy       : Boolean;
        maxDeploys        : Integer;
        allowedTokenTypes : array of String;
        validUntil        : Timestamp;
    };

    /** Revoke a grant immediately; a foreign grantId is 404. */
    action   revokeAgentGrant(grantId: UUID)                          returns {
        revoked : Boolean;
    };

    /**
     * Change the given parameters of a grant; `null` clears maxJobsPerDay,
     * validUntil, agentLabel and the allow-lists. Session, sponsor and token are
     * immutable; `maxDeploys` >= deploys used. Foreign grant 404, revoked
     * `409 GRANT_REVOKED`. Never grantable; `NIGHTGATE_GRANT_ADMIN_RATE_LIMIT`.
     */
    action   updateAgentGrant(grantId: UUID,
                              agentLabel: String,
                              allowedActions: array of String,
                              maxJobsPerDay: Integer,
                              allowedContracts: array of String,
                              allowedCircuits: array of String,
                              allowedTokenTypes: array of String,
                              allowDeploy: Boolean,
                              maxDeploys: Integer,
                              validUntil: Timestamp)                     returns {
        grantId : UUID;
        updated : array of String; // applied parameter names
    };

    /**
     * Replace the grant's token; the old one is 401 from the next request.
     * Budgets and deployedContracts survive. Owner-scoped, never grantable.
     */
    action   rotateAgentGrantToken(grantId: UUID)                     returns {
        grantId : UUID;
        token   : String; // shown once, never stored
    };

    /**
     * Grant activity from `since` (default `until` - 30 days) to `until`
     * (default now), at most 366 days: jobs incl. children, budgets, indexed
     * DUST fees. Owner-scoped; a token sees only its own grant.
     */
    function getGrantUsage(grantId: UUID, since: Timestamp, until: Timestamp) returns {
        grantId       : UUID;
        since         : Timestamp;
        until         : Timestamp;
        jobs          : array of {
            kind   : String;
            status : String;
            count  : Integer;
        };
        landed        : Integer; // chainStatus success
        failed        : Integer; // status failed or chainStatus failure
        deploysUsed   : Integer;
        maxDeploys    : Integer;
        jobsUsedToday : Integer;
        maxJobsPerDay : Integer;
        dustPaid      : String; // decimal DUST atoms; null without the crawler
    };

    /**
     * Status of an async job; poll until `succeeded` or `failed`. `result` is
     * the action's return value as JSON; `errorCode` a stable classification
     * (e.g. '1016', 'TxFailed'). Foreign jobs are 404. POST, but side-effect free.
     */
    action   getJobStatus(jobId: UUID,
                          sessionId: UUID)                            returns {
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
        chainStatus         : String; // null | pending | success | failure | dropped (not included before its ttl); independent of status
        chainFinalizedAt    : Timestamp;
        chainBlockHeight    : Integer; // null until confirmed
        chainBlockHash      : String;
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
