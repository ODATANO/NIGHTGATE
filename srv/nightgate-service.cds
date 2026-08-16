using {midnight} from '../db/schema';

/**
 * Nightgate Blockchain OData V4 API Service
 *
 * This service exposes Midnight blockchain data as a Nightgate OData V4 API,
 * following enterprise architecture patterns.
 */
@path    : '/api/v1/nightgate'
@requires: 'authenticated-user'
service NightgateService {

    // ========================================================================
    // Blockchain Core - Read-Only Access
    // ========================================================================

    /**
     * Blocks endpoint with full navigation capabilities
     * Supports: $filter, $orderby, $expand, $select, $top, $skip
     */
    @readonly
    entity Blocks                as
        projection on midnight.Blocks {
            *,
            parent,
            transactions
        }
        actions {
            // Get latest block
            @cds.odata.bindingparameter.collection
            function latest()                                                            returns Blocks;

            // Get block by height
            function byHeight(height: Integer)                                           returns Blocks;

            // Windowed range query for block pagination
            @cds.odata.bindingparameter.collection
            function range(startHeight: Integer64, endHeight: Integer64, limit: Integer) returns array of Blocks;
        };

    /**
     * Transactions with expanded relationships
     */
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
            // Get transaction by hash
            function byHash(hash: String)                   returns Transactions;

            // Filter transactions by classified tx type
            @cds.odata.bindingparameter.collection
            function byType(txType: String, limit: Integer) returns array of Transactions;
        };

    @readonly
    entity TransactionResults    as projection on midnight.TransactionResults;

    @readonly
    entity TransactionSegments   as projection on midnight.TransactionSegments;

    @readonly
    entity TransactionFees       as projection on midnight.TransactionFees;

    // ========================================================================
    // Smart Contracts
    // ========================================================================

    /**
     * Contract actions with deployment, call, and update tracking
     */
    @readonly
    entity ContractActions       as
        projection on midnight.ContractActions {
            *,
            transaction,
            deploy,
            unshieldedBalances
        }
        actions {
            // Get contract actions by address
            @cds.odata.bindingparameter.collection
            function byAddress(address: String) returns array of ContractActions;

            // Get contract history
            function history(address: String)   returns array of ContractActions;
        };

    @readonly
    entity ContractBalances      as projection on midnight.ContractBalances;

    // ========================================================================
    // UTXOs
    // ========================================================================

    /**
     * Unshielded UTXOs for transparent transactions
     */
    @readonly
    entity UnshieldedUtxos       as
        projection on midnight.UnshieldedUtxos {
            *,
            createdAtTransaction,
            spentAtTransaction
        }
        actions {
            // Get UTXOs by owner
            @cds.odata.bindingparameter.collection
            function byOwner(owner: String) returns array of UnshieldedUtxos;

            // Get unspent UTXOs
            @cds.odata.bindingparameter.collection
            function unspent()              returns array of UnshieldedUtxos;
        };

    // ========================================================================
    // Ledger Events
    // ========================================================================

    @readonly
    entity ZswapLedgerEvents     as projection on midnight.ZswapLedgerEvents;

    @readonly
    entity DustLedgerEvents      as projection on midnight.DustLedgerEvents;

    // ========================================================================
    // Balance & Token Tracking
    // ========================================================================

    /**
     * Unshielded NIGHT token balances per address
     */
    @readonly
    entity NightBalances         as projection on midnight.NightBalances
        actions {
            // Get balance for a specific address
            @cds.odata.bindingparameter.collection
            function getBalance(address: String)   returns NightBalances;

            // Get top holders by balance
            @cds.odata.bindingparameter.collection
            function getTopHolders(limit: Integer) returns array of NightBalances;
        };

    // ========================================================================
    // Submission Lifecycle
    // ========================================================================

    /**
     * In-flight and historical submissions originated by this NIGHTGATE
     * instance via deployContract / submitContractCall. Reconciled to
     * `finalized` by the crawler when the matching tx is indexed.
     */
    @readonly
    entity PendingSubmissions    as projection on midnight.PendingSubmissions;

    // ========================================================================
    // Document Anchoring
    // ========================================================================

    /**
     * Read-side view of anchored documents. Rows are inserted by
     * `anchorDocument` and progress through `anchoredTxHash` once the
     * AttestationVault `attest` call has been submitted.
     */
    @readonly
    entity Documents             as projection on midnight.Documents;

    /**
     * Anchor a document's content hash on-chain via the AttestationVault
     * `attest` circuit. The caller is responsible for placing the actual
     * bytes at `storageRef` (e.g. file://, s3://, ipfs://); this action
     * commits only the hash + public metadata to the chain.
     *
     * Async: returns `{ jobId, status, documentId }` immediately. The
     * `documentId` is a stable handle into the Documents entity (the row is
     * inserted synchronously up-front), so callers can poll the row for
     * `anchoredTxHash` independently of `getJobStatus`. The job's `result`
     * on success carries `{ documentId, attestationId, txHash, anchoredAt }`.
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
                            sponsorSessionId: UUID, // optional; second session pays the dust fee (see submitContractCall)
                            nonce: String // optional; guarded REVEAL (from prepareAnchorCommitment, after commitDocumentAnchor finalized)
    )                                                                 returns {
        jobId      : UUID;
        status     : String; // 'pending' | 'succeeded' (idempotent retry)
        documentId : UUID; // stable handle for Documents row polling
    };

    /**
     * Guarded (commit-reveal) anchoring, phase 0: compute-only. Returns the
     * opaque `commitment` for `commitDocumentAnchor` plus the `nonce` the
     * later reveal (`anchorDocument` with `nonce`) requires. STORE the nonce
     * and keep it secret until reveal: it is exactly what a mempool
     * front-runner cannot forge. Why the guard exists: plain attest is
     * first-come-first-served and insert-once, so a mempool observer could
     * permanently claim a visible payload hash; a reveal whose commitment
     * predates such a snipe takes the attestation over in-circuit.
     */
    action   prepareAnchorCommitment(sha256: String,
                                     metadata: LargeString, // JSON; must equal the later anchorDocument metadata
                                     nonce: String // optional; random when omitted
    )                                                                 returns {
        commitment   : String; // 64 hex; input to commitDocumentAnchor
        nonce        : String; // 64 hex; SECRET until reveal, required by it
        metadataHash : String; // 64 hex; informational
    };

    /**
     * Guarded anchoring, phase 1: record the opaque commitment on-chain
     * (AttestationVault `attestGuarded` mode 0). Async job; after it
     * finalizes, run `anchorDocument` with the SAME sha256/metadata plus the
     * `nonce` (phase 2, reveal). Rate limit shared with anchorDocument.
     */
    action   commitDocumentAnchor(commitment: String,
                                  sessionId: UUID,
                                  contractAddress: String,
                                  compiledArtifactRef: String, // optional, defaults to 'attestation-vault'
                                  idempotencyKey: String, // optional
                                  sponsorSessionId: UUID // optional
    )                                                                 returns {
        jobId  : UUID;
        status : String;
    };

    /**
     * Verify that a document's content hash matches what was anchored on chain.
     * Returns a deterministic yes/no answer: invalid inputs reject
     * with 400/404, but a hash-mismatch on a known doc returns
     * `verified: false` rather than erroring, so calling UIs can render
     * "tampered" without status-code juggling.
     *
     * Verification rules (all must hold for `verified: true`):
     *   - Documents row exists for `documentId`
     *   - `providedSha256` (case-insensitive hex) equals the stored `sha256`
     *   - `anchoredTxHash` is set
     *   - The corresponding Transactions row's transactionResult status is SUCCESS
     *
     * Crawler-free fallback: when the local `Transactions` lookup finds nothing
     * (crawler disabled or lagging) and `contractAddress` is supplied, the
     * on-chain effect is confirmed directly against live contract state; the
     * document's `sha256` (its on-chain `payload_hash`) must be present in the
     * AttestationVault attestation map. The public `verified` contract is
     * unchanged; only the evidence source is extended. `compiledArtifactRef`
     * defaults to 'attestation-vault'.
     */
    function verifyDocument(documentId: UUID,
                            providedSha256: String,
                            contractAddress: String, // optional; enables the crawler-free state fallback
                            compiledArtifactRef: String // optional, defaults to 'attestation-vault'
    )                                                                 returns {
        verified       : Boolean;
        anchoredTxHash : String;
        anchoredAt     : Timestamp;
        originalSha256 : String;
    };

    // ========================================================================
    // ZK Predicate Attestations (on-chain-verified model)
    // ========================================================================

    /**
     * Read-side view of predicate attestations. Rows are inserted by the
     * issue* proof actions and gain `provenTxHash`/`provenAt` once the
     * proving AttestationVault call has been included on-chain.
     *
     * The commitment-only lane (`issuePredicateAttestation` via
     * commitValue/provePredicate) was REMOVED in 0.16.0: the on-chain
     * commitment was overwritable while recorded claims did not embed it, so
     * a replaced commitment left stale claims verifiable. Every remaining
     * claim kind is root-bound and immutable.
     */
    @readonly
    entity PredicateAttestations as projection on midnight.PredicateAttestations;

    /**
     * Field-bound predicate proof: the proven value is cryptographically
     * bound to a SPECIFIC passport field via Merkle inclusion against an
     * anchored content root, so a verifier knows the value came from THIS
     * passport's `field_key`, not an arbitrary committed number.
     *
     * The caller (e.g. NIGHTPASS) builds the content root + inclusion path
     * off-chain with the contract's exported `pureCircuits` so the hashing
     * matches in-circuit. If `contentRoot` is supplied it is anchored first
     * (AttestationVault `anchorContentRoot`); then `proveFieldPredicate` runs
     * with the Merkle witnesses. `value` is the scaled integer field value
     * (witness only, never persisted). `siblingsJson` / `dirsJson` are JSON
     * arrays of the DEPTH=4 inclusion path (4 × 64-hex siblings; 4 booleans).
     *
     * Async: returns `{ jobId, status, predicateAttestationId }` immediately.
     */
    action   issueFieldPredicateAttestation(payloadHash: String, // attestation payload_hash (64 hex)
                                            fieldKey: String, // 64 hex canonical field id (public)
                                            value: String, // scaled integer, decimal string (witness only)
                                            fieldSalt: String, // 64-hex per-slot salt (witness; prepareDocumentProof returns it per field)
                                            contentRoot: String, // optional 64-hex Merkle root to anchor first
                                            schemaId: String, // 64-hex schema id (required with contentRoot; from prepareDocumentProof)
                                            siblingsJson: String, // JSON array of 4 × 64-hex sibling digests
                                            dirsJson: String, // JSON array of 4 booleans (left-child flags)
                                            predicate: String, // 'lessOrEqual' | 'greaterOrEqual'
                                            threshold: Integer64, // scaled integer
                                            unit: String, // optional, informational
                                            sessionId: UUID,
                                            contractAddress: String, // AttestationVault deployment
                                            compiledArtifactRef: String, // optional, defaults to 'attestation-vault'
                                            idempotencyKey: String, // optional; dedupes retries
                                            sponsorSessionId: UUID // optional; second session pays the dust fee (see submitContractCall)
    )                                                                 returns {
        jobId                  : UUID;
        status                 : String;
        predicateAttestationId : UUID;
    };

    /**
     * Batch pendant to `issueFieldPredicateAttestation`: prove N field-bound
     * predicates on ONE passport in ONE transaction. If `contentRoot` is
     * supplied it is anchored as the FIRST call of the SAME batch (the 0.10.0
     * segment ordering pins the anchor ahead of the proofs, so the in-circuit
     * root-exists assert holds); it then occupies one of the 8 call slots
     * (max 7 claims with anchor, 8 without).
     *
     * `claimsJson` is a JSON array; entries may mix five claim kinds,
     * discriminated by `predicate`:
     *   - numeric: `{ fieldKey, value, siblings, dirs, predicate:
     *     'lessOrEqual'|'greaterOrEqual', threshold, unit? }`
     *   - equality: `{ fieldKey, expectedValue|expectedDigest, siblings,
     *     dirs, predicate: 'bytesEquality' }`
     *   - membership: `{ fieldKey, value|valueDigest, allowedValues |
     *     setRoot+setSiblings+setDirs, siblings, dirs, predicate:
     *     'setMembership' }`
     *   - cross-root integrity: `{ predicate: 'documentIntegrity',
     *     payloadHashB, allowedMask, leavesA, leavesB }` (document A is the
     *     batch payloadHash; see issueDocumentIntegrityAttestation)
     *   - cross-root diff: `{ predicate: 'documentDiff', payloadHashB, k,
     *     leavesA, leavesB }` (see issueDocumentDiffAttestation)
     * each entry validated exactly like its single action (64-hex keys,
     * DEPTH=4 inclusion path; witness material never persisted). The
     * cross-root kinds carry no fieldKey/path; an in-batch contentRoot
     * anchor is document A's root, document B's must already be anchored.
     * Exact duplicate claim tuples (numeric: fieldKey+threshold+predicate,
     * equality: fieldKey+expectedDigest, membership: fieldKey+setRoot,
     * integrity: payloadHashB+allowedMask, diff: payloadHashB+k) are
     * dropped server-side and reported via `droppedDuplicates`; claim keys
     * are idempotent on-chain, so this is a proving-time optimization only.
     *
     * One PredicateAttestations row per claim; on success ALL rows share one
     * `provenTxHash`. Failure semantics: a false predicate fails at LOCAL
     * proving time, so nothing is submitted and no row is marked proven.
     * AFTER submission the ledger's fallible phase can finalize
     * PARTIAL_SUCCESS (subset applied); the job then fails with
     * OnChainStatus:... and callers must verify per claim via
     * `verifyPredicateAttestation` (crawler-free, no txHash needed) rather
     * than assume all-or-nothing.
     *
     * Proving work stays additive (N proofs = N provings); the batch saves
     * N-1 balancing/submit rounds, confirmation waits and fee events. With
     * `sponsorSessionId` the two-phase dust balancing runs ONCE for the
     * whole batch. Rate limiting counts N claims, not one call.
     *
     * Async: returns `{ jobId, status, claims, droppedDuplicates }`; `claims`
     * is a JSON array of `{ predicateAttestationId, fieldKey, predicate,
     * threshold, unit }` in submission order.
     */
    action   issueFieldPredicateAttestationBatch(payloadHash: String, // shared attestation payload_hash (64 hex)
                                                 contentRoot: String, // optional 64-hex Merkle root, anchored in-batch first
                                                 schemaId: String, // 64-hex schema id (required with contentRoot)
                                                 claimsJson: LargeString, // JSON array of claims (see above)
                                                 sessionId: UUID,
                                                 contractAddress: String, // AttestationVault deployment
                                                 compiledArtifactRef: String, // optional, defaults to 'attestation-vault'
                                                 idempotencyKey: String, // optional; dedupes retries
                                                 sponsorSessionId: UUID // optional; second session pays the dust fee (see submitContractCall)
    )                                                                 returns {
        jobId             : UUID;
        status            : String;
        claims            : LargeString; // JSON array of { predicateAttestationId, fieldKey, predicate, threshold, unit }
        droppedDuplicates : Integer;
    };

    /**
     * Field-bound EQUALITY proof for a bytes-valued (string) passport field:
     * prove the anchored content root carries, at `fieldKey`, exactly the
     * value whose blake2b-256 digest is `expectedDigest` (AttestationVault
     * `proveFieldEquality`). The expected digest is PUBLIC (it is the
     * statement), so this is an authenticity/binding proof, not a
     * confidentiality feature: for low-entropy values the digest is
     * dictionary-guessable.
     *
     * Pass exactly one of `expectedValue` (raw string; the server digests
     * the exact string, no trimming) or `expectedDigest` (64 hex). The field
     * must have entered the content root as a bytes leaf
     * (`prepareDocumentProof` with `kind: 'bytes'`); `siblingsJson` /
     * `dirsJson` are the DEPTH=4 inclusion path exactly as for
     * `issueFieldPredicateAttestation`. If `contentRoot` is supplied it is
     * anchored first.
     *
     * Async: returns `{ jobId, status, predicateAttestationId }` immediately.
     */
    action   issueFieldEqualityAttestation(payloadHash: String, // attestation payload_hash (64 hex)
                                           fieldKey: String, // 64 hex canonical field id (public)
                                           expectedValue: String, // raw string; server digests (pass this OR expectedDigest)
                                           expectedDigest: String, // 64-hex blake2b-256 of the exact value string
                                           fieldSalt: String, // 64-hex per-slot salt (witness; prepareDocumentProof returns it per field)
                                           contentRoot: String, // optional 64-hex Merkle root to anchor first
                                            schemaId: String, // 64-hex schema id (required with contentRoot; from prepareDocumentProof)
                                           siblingsJson: String, // JSON array of 4 × 64-hex sibling digests
                                           dirsJson: String, // JSON array of 4 booleans (left-child flags)
                                           sessionId: UUID,
                                           contractAddress: String, // AttestationVault deployment
                                           compiledArtifactRef: String, // optional, defaults to 'attestation-vault'
                                           idempotencyKey: String, // optional; dedupes retries
                                           sponsorSessionId: UUID // optional; second session pays the dust fee
    )                                                                 returns {
        jobId                  : UUID;
        status                 : String;
        predicateAttestationId : UUID;
    };

    /**
     * Field-bound SET-MEMBERSHIP proof for a bytes-valued (string) passport
     * field: prove the field's HIDDEN value is one of a public allow-list,
     * without revealing which one (AttestationVault `proveFieldMembership`).
     * Two Merkle folds over the same witnessed digest: the DEPTH=4 content
     * fold binds it to `fieldKey` of THIS passport, the DEPTH=6 set fold
     * proves it is a leaf of the canonical membership-set tree (up to 64
     * distinct values; rule: digest each value, dedupe, sort ascending, pad
     * by repeating the last member digest; see `prepareMembershipSet`).
     *
     * Pass exactly one of `value` (raw string) or `valueDigest` (64 hex);
     * both stay witness material, never persisted, never logged. Supply the
     * allow-list as `allowedValuesJson` (JSON array of strings; the server
     * builds the set root and inclusion path, rejecting 400 when the value
     * is not in the list, BEFORE any proving) or precomputed as `setRoot` +
     * `setSiblingsJson` + `setDirsJson`.
     *
     * Async: returns `{ jobId, status, predicateAttestationId }` immediately.
     */
    action   issueFieldMembershipAttestation(payloadHash: String, // attestation payload_hash (64 hex)
                                             fieldKey: String, // 64 hex canonical field id (public)
                                             value: String, // raw string value (witness only; pass this OR valueDigest)
                                             valueDigest: String, // 64-hex blake2b-256 of the exact value string (witness only)
                                             allowedValuesJson: LargeString, // JSON array of allowed strings (pass this OR setRoot+path)
                                             setRoot: String, // 64-hex canonical set root
                                             setSiblingsJson: String, // JSON array of 6 × 64-hex sibling digests
                                             setDirsJson: String, // JSON array of 6 booleans (left-child flags)
                                             fieldSalt: String, // 64-hex per-slot salt (witness; prepareDocumentProof returns it per field)
                                             contentRoot: String, // optional 64-hex Merkle root to anchor first
                                            schemaId: String, // 64-hex schema id (required with contentRoot; from prepareDocumentProof)
                                             siblingsJson: String, // JSON array of 4 × 64-hex sibling digests
                                             dirsJson: String, // JSON array of 4 booleans (left-child flags)
                                             sessionId: UUID,
                                             contractAddress: String, // AttestationVault deployment
                                             compiledArtifactRef: String, // optional, defaults to 'attestation-vault'
                                             idempotencyKey: String, // optional; dedupes retries
                                             sponsorSessionId: UUID // optional; second session pays the dust fee
    )                                                                 returns {
        jobId                  : UUID;
        status                 : String;
        predicateAttestationId : UUID;
    };

    /**
     * Cross-root INTEGRITY proof: prove document B differs from document A
     * ONLY in the slots flagged by `allowedMask`, both bound to their
     * anchored content roots, values hidden (AttestationVault
     * `proveDocumentComparison` mode 0). The canonical version-integrity claim:
     * "the re-anchored passport changed nothing outside the allowed field
     * set".
     *
     * `allowedMask` is the packed 16-bit slot mask (bit i = slot i MAY
     * differ; 0 = identical values). v4 witness model: `schemaJson` is the
     * SHARED 16-entry descriptor list (fieldKey/kind/scale per slot;
     * `prepareDocumentProof` returns it as `schema`), `openingAJson` /
     * `openingBJson` are the documents' full openings ({ saltSeed,
     * slots[16] }; returned as `opening`). The circuit recomputes BOTH the
     * schema root and both content roots from these, so the anchored schema
     * id is PROVEN to describe the trees and the comparison runs on values.
     * Both documents must be prepared with the SAME proofFields list in the
     * same order, and both content roots must be anchored; optional
     * `contentRootA` / `contentRootB` anchor them first (each a separate
     * transaction ahead of the proof). A slot that changed, appeared or
     * disappeared outside the mask fails at LOCAL proving time; nothing is
     * submitted. `payloadHashA != payloadHashB` (a == b is trivially true).
     * (A, B) order is part of the claim key; verify with the same order.
     *
     * Async: returns `{ jobId, status, predicateAttestationId }` immediately.
     */
    action   issueDocumentIntegrityAttestation(payloadHashA: String, // document A payload_hash (64 hex)
                                               payloadHashB: String, // document B payload_hash (64 hex)
                                               allowedMask: Integer, // packed 16-bit mask (bit i = slot i may differ)
                                               schemaJson: LargeString, // JSON array of 16 slot descriptors (shared schema; from prepareDocumentProof)
                                               openingAJson: LargeString, // document A opening { saltSeed, slots[16] } (witness; from prepareDocumentProof)
                                               openingBJson: LargeString, // document B opening { saltSeed, slots[16] } (witness)
                                               contentRootA: String, // optional 64-hex root to anchor for A first
                                               contentRootB: String, // optional 64-hex root to anchor for B first
                                               schemaId: String, // 64-hex schema id (required when anchoring; both docs share it)
                                               sessionId: UUID,
                                               contractAddress: String, // AttestationVault deployment
                                               compiledArtifactRef: String, // optional, defaults to 'attestation-vault'
                                               idempotencyKey: String, // optional; dedupes retries
                                               sponsorSessionId: UUID // optional; second session pays the dust fee
    )                                                                 returns {
        jobId                  : UUID;
        status                 : String;
        predicateAttestationId : UUID;
    };

    /**
     * Cross-root DISTINCTNESS proof: prove at least `k` of the 16 aligned
     * slots differ between two anchored documents, without revealing which
     * slots or what values (AttestationVault `proveDocumentComparison` mode 1). k = 1 is
     * "provably not the same document"; higher k is the USDA-style
     * "distinct at enough loci" claim.
     *
     * Same v4 witness model as the integrity mode: `schemaJson` (shared
     * descriptor list) + `openingAJson` / `openingBJson` (full document
     * openings). The circuit recomputes schema root and both content roots
     * and counts VALUE-level differences under the shared schema: a counted
     * difference is a value or presence change; both-empty compares equal;
     * padding slots never count. Schema parity is structural (there is only
     * ONE witnessed descriptor list, proven against both anchors). Both
     * roots must be anchored (optional `contentRootA` / `contentRootB`
     * anchor first). Fewer than k actual differences fail at LOCAL proving
     * time; nothing is submitted. (A, B) order is part of the claim key.
     *
     * Async: returns `{ jobId, status, predicateAttestationId }` immediately.
     */
    action   issueDocumentDiffAttestation(payloadHashA: String, // document A payload_hash (64 hex)
                                          payloadHashB: String, // document B payload_hash (64 hex)
                                          k: Integer, // minimum differing slots, 1..16
                                          schemaJson: LargeString, // JSON array of 16 slot descriptors (shared schema; from prepareDocumentProof)
                                          openingAJson: LargeString, // document A opening { saltSeed, slots[16] } (witness; from prepareDocumentProof)
                                          openingBJson: LargeString, // document B opening { saltSeed, slots[16] } (witness)
                                          contentRootA: String, // optional 64-hex root to anchor for A first
                                          contentRootB: String, // optional 64-hex root to anchor for B first
                                          schemaId: String, // 64-hex schema id (required when anchoring; both docs share it)
                                          sessionId: UUID,
                                          contractAddress: String, // AttestationVault deployment
                                          compiledArtifactRef: String, // optional, defaults to 'attestation-vault'
                                          idempotencyKey: String, // optional; dedupes retries
                                          sponsorSessionId: UUID // optional; second session pays the dust fee
    )                                                                 returns {
        jobId                  : UUID;
        status                 : String;
        predicateAttestationId : UUID;
    };

    /**
     * Verify a predicate attestation under the on-chain-verified model: the
     * proving circuit call is only accepted by the ledger if its in-circuit
     * asserts (root binding + predicate) held, so a successful tx IS the
     * proof. Confirms the row's `provenTxHash` resolves to a SUCCESS
     * `Transactions` result. Returns `verified: false` (not an error) for a
     * known-but-unproven row, mirroring `verifyDocument`.
     *
     * Crawler-free fallback: when the local `Transactions` lookup finds nothing
     * (crawler disabled or lagging), the result is confirmed directly against
     * live contract state; the claim key is recomputed from the row and looked
     * up in the vault's result map. No txHash and no crawler required.
     * Field-bound numeric rows use
     * `persistentHash(FieldPredicateClaim{payloadHash, fieldKey, threshold,
     * op, epoch})` against `field_predicate_results`. Bytes rows use
     * `FieldEqualityClaim{payloadHash, fieldKey, expectedDigest, epoch}`
     * against `field_equality_results` and `FieldMembershipClaim{payloadHash,
     * fieldKey, setRoot, epoch}` against `field_membership_results`.
     * Cross-root rows use `DocumentIntegrityClaim{payloadHash, payloadHashB,
     * allowedMask, epochA, epochB}` against `document_integrity_results` and
     * `DocumentDiffClaim{payloadHash, payloadHashB, k, epochA, epochB}`
     * against `document_diff_results` (k rides in `threshold`). `epoch` is
     * the payload's CURRENT attestation epoch (`attestation_seqs` in ledger
     * state), read from the same state query: claims recorded during a
     * front-runner's ownership window stop verifying after a guarded-attest
     * takeover moved the epoch. External reimplementations MUST include the
     * epoch(s) or they compute wrong claim keys.
     */
    function verifyPredicateAttestation(predicateAttestationId: UUID) returns {
        verified        : Boolean;
        predicate       : String;
        threshold       : Integer64; // numeric predicates: scaled threshold; documentDiff: k
        unit            : String;
        expectedDigest  : String; // bytesEquality rows: the public expected digest
        setRoot         : String; // setMembership rows: the canonical set root
        payloadHashB    : String; // cross-root rows: the second document
        allowedMask     : Integer; // documentIntegrity rows: packed 16-bit mask
        provenTxHash    : String;
        provenAt        : Timestamp;
    };

    /**
     * Verify an attestation directly against LIVE contract state
     * (`queryContractState`), independent of the block crawler and of any
     * txHash. Confirms `payloadHash` is present in the vault's attestation map
     * (and, when `contentRoot` / `schemaId` are supplied, that they equal the
     * anchored content root / schema id for that payload). Read-only; keyed
     * entirely by the caller-supplied `payloadHash`, so it needs no crawler
     * and no enumeration. TRUST NOTE: an anchor is the anchoring attester's
     * statement about their own payload; a verifier of cross-party claims
     * must ALSO check `attesterId` against the identity it trusts (and, for
     * cross-root claims, `schemaId` against the canonical schema of the
     * expected field panel).
     *
     * Returns `verified: false` (not an error) for an absent attestation, and a
     * clean negative (not a 5xx) when no live provider is configured, mirroring
     * `verifyDocument`. `compiledArtifactRef` defaults to 'attestation-vault'.
     *
     * `network` (optional) reads the state from ANOTHER network's public
     * indexer instead of the configured one; the read is stateless and
     * wallet-free, so a preview-configured server can verify a preprod anchor.
     * Omitted or equal to the configured network keeps today's behavior
     * exactly (env/config endpoint overrides win); an unknown value is a 400.
     * Per-network endpoints are overridable via
     * `cds.requires.nightgate.networks.<network>.indexerHttpUrl/indexerWsUrl`.
     */
    function verifyAttestationState(contractAddress: String,
                                    payloadHash: String, // 64 hex
                                    contentRoot: String, // optional 64 hex, checked against anchored root
                                    schemaId: String, // optional 64 hex, checked against anchored schema id
                                    compiledArtifactRef: String, // optional, defaults to 'attestation-vault'
                                    network: String // optional network override, e.g. 'preview' | 'preprod' | 'mainnet'
    )                                                                 returns {
        verified      : Boolean;
        attested      : Boolean; // payload_hash present in the attestation map
        contentRootOk : Boolean; // anchored content root matches (when contentRoot given)
        schemaOk      : Boolean; // anchored schema id matches (when schemaId given)
        attesterId    : String; // owner grantee id, if present
    };

    /**
     * Verify a predicate proof directly against LIVE contract state
     * (`queryContractState`), independent of the block crawler, of any txHash,
     * and of any server-side PredicateAttestations row: the id-free counterpart
     * to `verifyPredicateAttestation` for WALLET-submitted proofs (browser signs,
     * NIGHTGATE never saw a jobId). Recomputes the on-chain claim key off-chain
     * from the supplied coordinates and confirms the vault recorded a true
     * result for it. Numeric predicates are field-bound and require
     * `fieldKey` (`field_predicate_results`); the commitment-only plain kind
     * was removed in 0.16.0. For the bytes claim kinds pass `predicate: 'bytesEquality'` +
     * `expectedDigest` (`field_equality_results`) or `predicate:
     * 'setMembership'` + `setRoot` (`field_membership_results`); `threshold`
     * is ignored for both. For the cross-root kinds pass `predicate:
     * 'documentIntegrity'` + `payloadHashB` + `allowedMask`
     * (`document_integrity_results`) or `predicate: 'documentDiff'` +
     * `payloadHashB` + `k` (`document_diff_results`); `payloadHash` is
     * document A and the (A, B) order must match the proving order, since
     * it is part of the claim key.
     *
     * `threshold` must be the SAME scaled Uint<64> integer the circuit hashed
     * into the claim key (e.g. raw value x1000 when the consumer scales by
     * 1000); a scaling mismatch silently yields `verified: false`.
     *
     * Returns `verified: false` (not an error) for an absent result, and a
     * clean negative (not a 5xx) when no live provider is configured or the
     * contract is unknown, mirroring `verifyAttestationState`.
     * `compiledArtifactRef` defaults to 'attestation-vault'.
     *
     * `network` (optional) behaves exactly as on `verifyAttestationState`:
     * read from another network's public indexer, 400 on unknown values.
     */
    function verifyPredicateState(contractAddress: String,
                                  payloadHash: String, // 64 hex (cross-root kinds: document A)
                                  fieldKey: String, // 64 hex; required for the numeric/bytes kinds
                                  predicate: String, // 'lessOrEqual' | 'greaterOrEqual' | 'bytesEquality' | 'setMembership' | 'documentIntegrity' | 'documentDiff'
                                  threshold: Integer64, // scaled circuit integer (numeric predicates only)
                                  expectedDigest: String, // 64 hex, required for 'bytesEquality'
                                  setRoot: String, // 64 hex canonical set root, required for 'setMembership'
                                  payloadHashB: String, // 64 hex document B, required for the cross-root kinds
                                  allowedMask: Integer, // packed 16-bit mask, required for 'documentIntegrity'
                                  k: Integer, // minimum differing slots 1..16, required for 'documentDiff'
                                  compiledArtifactRef: String, // optional, defaults to 'attestation-vault'
                                  network: String // optional network override, e.g. 'preview' | 'preprod' | 'mainnet'
    )                                                                 returns {
        verified : Boolean;
        proven   : Boolean; // a true result is recorded on-chain for the claim key
    };

    /**
     * Chain-derived disclosure grants, read off the AttestationVault
     * `disclosures` ledger Map by the chain indexer. Distinct from the
     * off-chain `DisclosureRoles` table; these are the tamper-evident,
     * attester-controlled on-chain ACL. `level`: 0=public, 1=legitimate-
     * interest, 2=authority. `active` is true while the grant is present
     * on-chain (granted and not revoked).
     */
    @readonly
    entity DisclosureGrants      as projection on midnight.DisclosureGrants;

    /**
     * Re-read the AttestationVault `disclosures` ledger Map from LIVE on-chain
     * state (`queryContractState`) and reconcile `DisclosureGrants`. This is the
     * same reconciliation the server-signed grant/revoke path runs internally,
     * exposed on demand: use it after a WALLET-submitted grant/revoke that
     * bypassed the plugin submission pipeline (browser signs, NIGHTGATE never
     * saw a jobId). Crawler-independent, idempotent, self-healing.
     *
     * `active` is the count of grants present on-chain for the contract after
     * reconciliation. Returns a clean zero (not a 5xx) when no live provider is
     * configured. `compiledArtifactRef` defaults to 'attestation-vault'.
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
     * Grant a disclosure tier to a grantee on an existing attestation, via the
     * AttestationVault `grantDisclosure` circuit. Attester-only (enforced
     * in-circuit; a non-attester caller's tx is rejected). `level`: 0 = public,
     * 1 = legitimate-interest, 2 = authority.
     *
     * Async: returns `{ jobId, status, disclosureGrantId }` immediately.
     * `disclosureGrantId` is a stable handle into DisclosureGrants (row inserted
     * up-front, active=false). The job `result` carries
     * `{ disclosureGrantId, payloadHash, grantee, level, txHash }`.
     * `compiledArtifactRef` defaults to 'attestation-vault'.
     */
    action   grantDisclosure(payloadHash: String, // 64 hex, the attestation
                             grantee: String, // 64 hex Bytes<32> grantee identifier
                             level: Integer, // 0 | 1 | 2
                             sessionId: UUID,
                             contractAddress: String, // AttestationVault deployment
                             compiledArtifactRef: String, // optional, defaults to 'attestation-vault'
                             idempotencyKey: String, // optional; dedupes retries
                             sponsorSessionId: UUID // optional; second session pays the dust fee (see submitContractCall)
    )                                                                 returns {
        jobId             : UUID;
        status            : String;
        disclosureGrantId : UUID;
    };

    /**
     * Revoke a previously granted disclosure, via the AttestationVault
     * `revokeDisclosure` circuit (removes the grantee entry on-chain).
     * Attester-only. Async: returns `{ jobId, status }`. The job `result`
     * carries `{ payloadHash, grantee, txHash }`.
     */
    action   revokeDisclosure(payloadHash: String, // 64 hex, the attestation
                              grantee: String, // 64 hex Bytes<32> grantee identifier
                              sessionId: UUID,
                              contractAddress: String, // AttestationVault deployment
                              compiledArtifactRef: String, // optional, defaults to 'attestation-vault'
                              idempotencyKey: String, // optional; dedupes retries
                              sponsorSessionId: UUID // optional; second session pays the dust fee (see submitContractCall)
    )                                                                 returns {
        jobId  : UUID;
        status : String;
    };

    /**
     * Pre-register (or re-register) passport ownership, via the
     * AttestationVault `registerPassport` circuit. Registrar-only (the vault
     * DEPLOYER's attester identity, enforced in-circuit): assigns the
     * passportId to an attester id, so only that attester may bind or re-bind
     * it via `bindPassport` (first-bind-squatting protection; re-registering
     * an id is the ownership-transfer and squatter-recovery path).
     *
     * Async: returns `{ jobId, status }`. The job `result` carries
     * `{ passportId, ownerId, contractAddress, txHash }`.
     * `compiledArtifactRef` defaults to 'attestation-vault'.
     */
    action   registerPassport(passportId: String, // 64 hex Bytes<32> passport identifier
                              ownerId: String, // 64 hex Bytes<32> attester id that may bind the passport
                              sessionId: UUID, // must be the vault deployer (registrar)
                              contractAddress: String, // AttestationVault deployment
                              compiledArtifactRef: String, // optional, defaults to 'attestation-vault'
                              idempotencyKey: String, // optional; dedupes retries
                              sponsorSessionId: UUID // optional; second session pays the dust fee (see submitContractCall)
    )                                                                 returns {
        jobId  : UUID;
        status : String;
    };

    /**
     * Grantee identities: binds an authenticated principal to the Bytes<32>
     * grantee id the AttestationVault checks (read side of the disclosure ACL).
     */
    @readonly
    entity GranteeIdentities     as projection on midnight.GranteeIdentities;

    /**
     * Bind the authenticated caller (req.user.id) to the `Bytes<32>` grantee id
     * the AttestationVault checks, so on-chain disclosure grants resolve to this
     * principal at read time. The binding kind is set per-deployment via
     * `cds.requires.nightgate.granteeBinding` (default 'wallet'):
     *   - 'wallet': `bindingInput` = the caller's coin public key (hex)
     *   - 'did':    `bindingInput` = a DID string
     *   - 'custom': `bindingInput` = the 64-hex grantee id itself
     * `scope` optionally restricts the binding to one contract/attestation;
     * omit for a global binding. Idempotent on (userId, scope); re-registering
     * updates the existing row. Requires authentication (401 otherwise).
     */
    action   registerGranteeIdentity(bindingInput: String,
                                     scope: String // optional; omit for a global binding
    )                                                                 returns {
        ID          : UUID;
        granteeId   : String;
        bindingKind : String;
    };

    /**
     * Deploy a registered compiled contract. The contract must be registered
     * via `cds.requires.nightgate.contracts.<ref>` or `registerContract()`.
     *
     * Async: returns `{ jobId, status }` immediately. Poll
     * `getJobStatus(jobId, sessionId)`; on success the `result` field carries
     * the original return shape `{ submissionId, txHash, contractAddress,
     * status }` (status here is the PendingSubmissions lifecycle status,
     * `included` / `finalized` / `failed`, distinct from the job status).
     */
    action   deployContract(compiledArtifactRef: String,
                            sessionId: UUID,
                            initialPrivateState: LargeString, // JSON-encoded
                            idempotencyKey: String, // optional; dedupes retries
                            sponsorSessionId: UUID // optional; second session pays the dust fee (see submitContractCall)
    )                                                                 returns {
        jobId  : UUID;
        status : String; // 'pending' | 'succeeded' (idempotent retry)
    };

    /**
     * Submit a call to a deployed contract. `args` is JSON-encoded.
     *
     * Async: returns `{ jobId, status }`. Polled via `getJobStatus`; the
     * `result` carries `{ submissionId, txHash, contractAddress, status }`.
     *
     * A wallet that did NOT deploy the contract has no private state for it.
     * The call seeds one on first contact (default `{}`, i.e. what a stateless
     * contract deploys with), so several wallets can act on one shared
     * contract; an existing private state is never overwritten. Pass
     * `initialPrivateState` for a contract whose private state is not empty.
     *
     * Per-tx fee sponsoring: pass `sponsorSessionId` to have a SECOND wallet
     * session pay the dust fee. The calling session builds and signs the
     * transaction (balancing shielded/unshielded only); the sponsor session
     * balances ONLY the dust fee and submits. The sponsor session must be
     * signing-capable (connectWalletForSigning) and either belong to the same
     * user or be listed by the operator in NIGHTGATE_FEE_SPONSOR_SESSION /
     * cds config `feeSponsorSessions` (platform sponsor). Job request and
     * result carry `feeSponsor` for audit.
     */
    action   submitContractCall(contractAddress: String,
                                circuit: String,
                                compiledArtifactRef: String,
                                sessionId: UUID,
                                args: LargeString, // JSON-encoded array, may be '[]'
                                idempotencyKey: String, // optional; dedupes retries
                                initialPrivateState: LargeString, // optional JSON; seeded on this wallet's first call
                                sponsorSessionId: UUID // optional; second session pays the dust fee (see above)
    )                                                                 returns {
        jobId  : UUID;
        status : String; // 'pending' | 'succeeded' (idempotent retry)
    };

    /**
     * Submit SEVERAL circuit calls against ONE deployed contract as a SINGLE
     * transaction. `calls` is a JSON array of `{ circuit, args }` executed
     * inside one transaction scope (SDK withContractScopedTransaction); the
     * batch is balanced, signed and submitted ONCE. At most 8 calls per batch.
     * The on-chain apply order is deterministic and equals the call order
     * (segment ids are rewritten before proving, see batch-segment-order.ts),
     * so DEPENDENT calls may be batched. Exception: duplicate circuit names
     * keep a random relative order among themselves; batch distinct circuits
     * when that matters.
     *
     * Failure semantics: an error BEFORE submission (bad circuit, throwing
     * call, proving/balancing) discards the scope and nothing is submitted.
     * AFTER submission the ledger's fallible phase still applies: the tx can
     * finalize as PARTIAL_SUCCESS (on chain, a subset of calls applied); the
     * job then fails with OnChainStatus:... and callers must verify effect
     * state (e.g. verifyAttestationState) rather than assume all-or-nothing.
     *
     * With `sponsorSessionId`, the two-phase dust balancing also runs once for
     * the whole batch (one sponsor sync + one dust spend instead of one per
     * call), which is the main latency win over N sequential submitContractCall
     * jobs. Same seeding, sponsoring and auth rules as submitContractCall.
     *
     * Async: returns `{ jobId, status }`; the job `result` carries
     * `{ submissionId, txHash, contractAddress, circuits, status }` (ONE
     * txHash for the whole batch).
     */
    action   submitContractCallBatch(contractAddress: String,
                                     calls: LargeString, // JSON array of { circuit, args }
                                     compiledArtifactRef: String,
                                     sessionId: UUID,
                                     idempotencyKey: String, // optional; dedupes retries
                                     initialPrivateState: LargeString, // optional JSON; seeded on this wallet's first call
                                     sponsorSessionId: UUID // optional; second session pays the dust fee (see submitContractCall)
    )                                                                 returns {
        jobId  : UUID;
        status : String; // 'pending' | 'succeeded' (idempotent retry)
    };

    // ========================================================================
    // Session Management (Wallet Connections)
    // ========================================================================

    /**
     * Wallet session management
     */
    @readonly
    entity WalletSessions        as
        projection on midnight.WalletSessions
        excluding {
            viewingKeyHash, // Internal lookup field
            encryptedViewingKey, // Encrypted viewing key, never exposed via OData
            encryptedSeedKey // Encrypted signing seed, never exposed via OData
        };

    /**
     * Create a read-only session by storing the viewing key encrypted at rest.
     * Returns the new session's UUID and metadata.
     */
    action   connectWallet(viewingKey: String)                        returns {
        ID          : UUID;
        sessionId   : UUID;
        connectedAt : Timestamp;
        expiresAt   : Timestamp;
        isActive    : Boolean;
    };

    /**
     * Disconnect an active session, nulling out encrypted keys.
     */
    action   disconnectWallet(sessionId: UUID);

    /**
     * Upgrade an existing read-only session with signing capability.
     * Stores the BIP39 seed encrypted at rest (AES-256-GCM via ENCRYPTION_KEY).
     * Required before deployContract/submitContractCall flows can balance/submit.
     *
     * Provide the wallet's BIP39 `mnemonic` (the Lace recovery phrase); the
     * server derives the per-role HD keys exactly as Lace does (see
     * srv/utils/wallet-hd.ts). `seedHex` is an optional programmatic
     * alternative: the raw 64-byte BIP39 seed as 128 hex chars (NOT a 32-byte
     * key). One of `mnemonic` or `seedHex` is required.
     *
     * `accountIndex` (default 0) selects the BIP32 account level and must be
     * the SAME value the session's viewing key was derived for (i.e. what was
     * passed to `deriveWalletInfo`). The action verifies, fail-closed, that
     * the seed at this accountIndex derives the session's viewing key and
     * rejects with 400 otherwise; all signing and the on-chain attester
     * identity then use this account.
     *
     * The session UPDATE happens synchronously; `signingEnabled: true` is
     * returned as soon as the encrypted seed is persisted, so callers can
     * proceed to other signing-capable actions immediately.
     *
     * `prewarmJobId` tracks an async pre-warm of the WalletFacade. The first
     * deployContract / submitContractCall after a fresh seed pays a multi-
     * hour cold-sync cost unless this pre-warm has finished. Poll
     * `getJobStatus(prewarmJobId, sessionId)` to know when the wallet is
     * ready. Failing to wait is fine; subsequent actions just block on the
     * same sync internally.
     */
    action   connectWalletForSigning(sessionId: UUID,
                                     mnemonic: String, // BIP39 recovery phrase (preferred)
                                     seedHex: String, // optional: 64-byte BIP39 seed as 128 hex chars
                                     accountIndex: Integer, // optional, default 0; must match the session's viewing-key account
                                     idempotencyKey: String, // optional; dedupes retries on a flaky network
                                     prewarm: Boolean // optional; false skips the sync-to-tip prewarm job
    // (for sponsored callers that hold nothing; submissions
    // ensure the facade on demand since 0.8.1)
    )                                                                 returns {
        sessionId      : UUID;
        signingEnabled : Boolean;
        prewarmJobId   : UUID;
        prewarmStatus  : String; // 'pending' | 'succeeded' (idempotent retry)
    };

    /**
     * Derive a wallet's connectable identity from its secret, WITHOUT creating
     * a session or persisting anything. Pure function
     * of the input; the mnemonic/seed is never stored or logged.
     *
     * Removes the last Lace dependency from programmatic wallet creation:
     * generate a BIP39 phrase consumer-side, call this to learn the
     * `viewingKey` (input to `connectWallet`), the `nightAddress` (faucet
     * funding target) and the `shieldedAddress`. Derivation is identical to
     * the signing path (per-role HD seeds, Lace-exact; srv/utils/wallet-hd.ts),
     * so the derived identity IS the account `connectWalletForSigning` will
     * sign with for the same secret AND the same `accountIndex` (pass the
     * value used here to `connectWalletForSigning` too).
     *
     * `accountIndex` (default 0) selects the BIP32 account level, so one
     * phrase can host multiple independent accounts (e.g. one per producer).
     */
    action   deriveWalletInfo(mnemonic: String, // BIP39 recovery phrase; one of mnemonic|seedHex required
                              seedHex: String, // optional: 64-byte BIP39 seed as 128 hex chars
                              accountIndex: Integer // optional, default 0
    )                                                                 returns {
        viewingKey      : String; // 64-hex zswap encryption public key (connectWallet input)
        shieldedAddress : String; // mn_shield-addr_... (receives shielded assets)
        nightAddress    : String; // mn_addr_... unshielded NIGHT address (faucet target)
        dustAddress     : String; // mn_dust_... DUST address; pass as dustReceiverAddress
        // to registerForDustGeneration for sponsored dust generation
        attesterId      : String; // 64-hex AttestationVault attester identity (the circuits'
        // caller_id); pass as registerPassport's ownerId to pre-register a passport
        // for a wallet BEFORE its first on-chain call
        accountIndex    : Integer;
        network         : String; // encoding network (the configured NIGHTGATE network)
    };

    /**
     * Register the session's NIGHT UTXOs for DUST generation. DUST is the fee
     * token on Midnight; without it, deployContract/submitContractCall cannot
     * pay fees. Initial DUST accrual takes 1-2 minutes after the on-chain
     * registration tx settles.
     *
     * Async: returns `{ jobId, status }` immediately. Poll
     * `getJobStatus(jobId, sessionId)` for the final result, which (on
     * success) carries the original shape `{ txId, registeredCount,
     * totalNightUtxos, dustReceiverAddress }` as JSON in `result`.
     *
     * `idempotencyKey` (optional) lets retries on a flaky network dedupe
     * against the original job; reusing a key returns the existing jobId.
     */
    action   registerForDustGeneration(sessionId: UUID,
                                       dustReceiverAddress: String, // optional; defaults to the wallet's own DUST address
                                       idempotencyKey: String // optional; dedupes retries
    )                                                                 returns {
        jobId  : UUID;
        status : String; // 'pending' | 'succeeded' (idempotent retry)
    };

    /**
     * Symmetric pair to `registerForDustGeneration`. Removes ALL the wallet's
     * registered NIGHT UTXOs from dust generation, making them spendable
     * again. Per-UTXO narrowing is not exposed yet.
     *
     * Async: same `{ jobId, status }` contract as `registerForDustGeneration`.
     * On success the `result` field of `getJobStatus` carries
     * `{ txId, deregisteredCount, totalNightUtxos }`.
     */
    action   deregisterFromDustGeneration(sessionId: UUID,
                                          idempotencyKey: String, // optional
                                          sponsorSessionId: UUID // optional; second session pays the dust fee (a fully
    // delegated wallet has dust 0 and cannot pay its own
    // deregistration; see submitContractCall for the rules)
    )                                                                 returns {
        jobId  : UUID;
        status : String; // 'pending' | 'succeeded' (idempotent retry)
    };

    /**
     * Transfer NIGHT to any Midnight address. Receiver ledger is auto-detected
     * from the Bech32m prefix: `mn_shield-addr_...` → shielded, `mn_addr_...`
     * → unshielded. Source funds come from the same ledger as the receiver.
     * (NIGHT is an unshielded-only token; there is no cross-ledger conversion.)
     *
     * `amount` is a decimal string of NIGHT atoms (parsed as bigint server-side
     * to avoid precision loss for values beyond Number.MAX_SAFE_INTEGER).
     *
     * Async: returns `{ jobId, status }`. Polled via `getJobStatus`; on
     * success the `result` carries `{ txId, toLedger, amount, receiverAddress }`.
     */
    action   sendNight(sessionId: UUID,
                       receiverAddress: String,
                       amount: String,
                       ttlIso: String, // optional ISO-8601; defaults to +10min
                       idempotencyKey: String, // optional; dedupes retries
                       tokenTypeHex: String // optional; raw token type (64 hex) to send instead of
    // NIGHT. Ledger-agnostic: the receiver address prefix decides
    // whether shielded or unshielded holdings of that token are
    // spent (e.g. a contract-minted shielded token to a
    // mn_shield-addr_, an unshielded custom token to a mn_addr_).
    )                                                                 returns {
        jobId  : UUID;
        status : String; // 'pending' | 'succeeded' (idempotent retry)
    };

    // ========================================================================
    // Diagnostics: read-only pre-flight UX
    // ========================================================================

    /**
     * Snapshot of the wallet's current balances. Read-only; does not build
     * or submit any transaction. Useful as a pre-flight check before
     * `sendNight` / `deployContract`.
     *
     * Returns NIGHT atoms (decimal strings to preserve bigint precision)
     * separated by shielded vs unshielded ledger, plus current DUST and the
     * count of NIGHT UTXOs currently committed to dust generation.
     */
    function getWalletBalance(sessionId: UUID)                        returns {
        shieldedNight            : String;
        unshieldedNight          : String;
        dustBalance              : String;
        registeredNightUtxoCount : Integer;
        totalNightUtxoCount      : Integer;
        dustUtxoCount            : Integer;
        dustPendingCount         : Integer;
        dustPendingValue         : String;
        dustRestoreCount         : Integer;
    };

    /**
     * How far the wallet's catch-up has got, and how fast it is moving.
     * Read-only and cheap: answers from a snapshot the wallet worker pushes
     * every ~15s, so it stays responsive while that worker is CPU-saturated
     * syncing (which is exactly when this matters).
     *
     * Poll this instead of guessing from elapsed time. A catch-up is slow but
     * healthy while `appliedIndex` climbs and `eventsPerSecond` stays above
     * zero; the same wallet is genuinely stuck when `appliedIndex` stops moving
     * across polls or `isConnected` is false.
     *
     * `known` is false before the first sync wait has reported anything, e.g.
     * the facade is still being built. `appliedIndex`, `streamTip` and
     * `behindEvents` count dust LEDGER EVENTS (not blocks) and are decimal
     * strings to preserve bigint precision. `etaSeconds` is derived from the
     * current rate, so it moves around; treat it as an order of magnitude.
     */
    function getWalletSyncProgress(sessionId: UUID)                   returns {
        known           : Boolean;
        caughtUp        : Boolean;
        appliedIndex    : String;  // dust ledger-event id applied so far
        streamTip       : String;  // current tip of that event stream
        behindEvents    : String;  // streamTip - appliedIndex
        eventsPerSecond : Decimal; // current rate, null until measurable
        etaSeconds      : Integer; // at the current rate, null if not derivable
        blockHeight     : String;  // indexer block height, for chain correlation
        isConnected     : Boolean;
        indexerFresh    : Boolean; // indexer tip recent enough to count as tip
        elapsedMs       : Integer; // how long this sync wait has been running
        phase           : String;  // 'prewarm' | 'balance' | ...
        updatedAt       : Timestamp; // when the worker last reported
    };

    /**
     * Pre-flight DUST fee estimate for a `sendNight` transfer. Builds the
     * recipe in the worker (lightweight; no ZK proof generation, no submit),
     * returns the estimated fee in DUST atoms (decimal string). The recipe
     * is discarded.
     *
     * Use this to gate `sendNight` on whether the wallet has enough DUST
     * to pay the fee.
     */
    function estimateSendNightFee(sessionId: UUID,
                                  receiverAddress: String,
                                  amount: String,
                                  ttlIso: String // optional
    )                                                                 returns {
        fee      : String;
        toLedger : String;
    };

    // ========================================================================
    // Background Jobs (async submission lifecycle)
    // ========================================================================

    /**
     * Turn a structured document into everything the field-predicate proof
     * surface needs: canonical JSON -> `payloadHash` (blake2b-256, the value
     * `anchorDocument` anchors), plus a depth-4 Merkle `contentRoot` over the
     * ORDERED `proofFieldsJson` list (leaf index = list position; keep the
     * order stable across anchor and proof) with per-field inclusion paths
     * ready for `issueFieldPredicateAttestation[Batch]`.
     *
     * `documentJson` is a JSON object (the full document; all of it goes into
     * `payloadHash`). `proofFieldsJson` is an ordered JSON array of up to 16
     * `{ field, kind?, scale? }` entries. `kind` is 'uint' (default; numeric
     * value scaled by `scale`, default 1000 milli-units) or 'bytes' (string
     * value, entered as the blake2b-256 digest of the EXACT string; feeds
     * `issueFieldEqualityAttestation` / `issueFieldMembershipAttestation`;
     * `scale` not allowed). `field` is a dot-separated path into the document
     * (`invoice.total`; numeric segments index arrays); a literal top-level
     * key containing dots wins over path descent. Values must resolve to
     * scalars (a path landing on an object/array is a 400; 'uint' requires
     * non-negative numerics, 'bytes' requires strings); absent values
     * occupy the salted absent leaf and are reported in `emptyFields`.
     * Every leaf is SALTED (v4) with a per-slot salt derived from a
     * per-document 32-byte seed: random by default, or caller-supplied via
     * `saltSeed` for a deterministic re-prepare of an already-anchored
     * payload. Leaf/node/descriptor hashing uses the contract artifact's
     * exported pure circuits, so root and schemaId are byte-identical to
     * the in-circuit recompute.
     *
     * Compute-only and synchronous: nothing is persisted, no job started.
     * The response's `fields` and `opening` carry WITNESS material (values,
     * salts, the seed); STORE the `opening` alongside the document. Losing
     * the seed makes the anchored root unprovable; leaking it makes shared
     * leaf hashes dictionary-testable. `canonicalDocument` is the exact
     * byte form behind `payloadHash`; store it at your `storageRef`, a
     * re-serialization with different key order will not re-hash equal.
     */
    action   prepareDocumentProof(documentJson: LargeString, // JSON object: the full document
                                  proofFieldsJson: LargeString, // ordered JSON array of { field, kind?, scale? }, max 16
                                  saltSeed: String, // optional 64-hex salt seed (deterministic re-prepare); random if omitted
                                  compiledArtifactRef: String // optional, defaults to 'attestation-vault'
    )                                                                 returns {
        payloadHash       : String; // blake2b-256 of canonicalDocument (64 hex)
        canonicalDocument : LargeString; // the exact hashed byte form
        contentRoot       : String; // 64-hex SALTED Merkle root over the proof fields
        fields            : LargeString; // JSON array of { field, fieldKey, kind, value?, valueDigest?, salt, siblings, dirs }
        emptyFields       : LargeString; // JSON array of fields without a value (salted absent leaf)
        schemaId          : String; // 64-hex schema root of the ORDERED proofFields list (anchored next to the root)
        schema            : LargeString; // JSON array of 16 slot descriptors { fieldKey, kind, scale } (public)
        leaves            : LargeString; // JSON array of 16 × 64-hex salted leaf hashes (informational)
        opening           : LargeString; // JSON { saltSeed, slots[16] }: the cross-root witness bundle (STORE IT)
    };

    /**
     * Canonical membership-set helper for `issueFieldMembershipAttestation`
     * and `verifyPredicateState`. Builds the deterministic depth-6 set tree
     * over an allow-list (digest each value with blake2b-256 of the exact
     * string, dedupe, sort ascending, pad to 64 slots by repeating the last
     * member digest) so any party can recompute the same `setRoot` from the
     * published list alone. Padding repeats a REAL member on purpose: every
     * leaf must be a member digest, or the padding constant itself would be
     * provable as a member of any non-full list.
     *
     * Without `value`/`valueDigest`: returns just `{ setRoot, memberCount }`
     * (the verifier lane). With one of them: additionally returns the
     * member's inclusion path (`setSiblingsJson`/`setDirsJson`, WITNESS
     * material: which slot matched narrows the hidden value); 400 when the
     * value is not in the list. Compute-only and synchronous.
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
     * Anchor an agent-output provenance envelope on-chain: "agent X produced
     * output O from input I at time T (optionally: with model M under policy
     * P)". Builds the canonical v1 envelope `{ v, agentId, inputHash,
     * outputHash, producedAt, modelId?, policyHash? }` server-side, hashes it
     * (blake2b-256) and anchors via the `anchorDocument` pipeline; the
     * canonical envelope rides as the anchor's public metadata blob, so the
     * on-chain metadata hash commits to the envelope itself.
     *
     * Verification needs no NIGHTGATE trust: a third party re-hashes the
     * returned `envelopeJson` and calls `verifyAttestationState` with the
     * result. The attestation owner is the session wallet (the operator);
     * the agent identity lives inside the envelope, ideally a registered
     * grantee id (`registerGranteeIdentity`).
     *
     * Async: returns `{ jobId, status, documentId }` like `anchorDocument`,
     * plus `payloadHash` and the canonical `envelopeJson`.
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
        documentId   : UUID; // Documents row handle (verify_document works on it)
        payloadHash  : String; // blake2b-256 of envelopeJson, the anchored value
        envelopeJson : LargeString; // canonical envelope; re-hash to verify
    };

    /**
     * Owner-scoped view of agent grants (tokenHash excluded: the token is
     * shown once at creation and its hash never leaves the server).
     */
    @readonly
    entity AgentGrants           as
        projection on midnight.AgentGrants
        excluding {
            tokenHash
        };

    /**
     * Create an agent grant: a scoped, revocable bearer capability derived
     * from one of the caller's wallet sessions. The returned `token` is shown
     * ONCE and never stored (only its SHA-256). A request carrying the token
     * in the `x-agent-token` header runs as the grant's operator but is
     * restricted to `allowedActions` (plus the read-only verify surface and
     * `getJobStatus`), bound to the grant's `sessionId`, limited to
     * `maxJobsPerDay` write jobs per UTC day, and pinned to
     * `sponsorSessionId` when set (the request may not override it, so a
     * fundless agent stays fundless).
     *
     * `allowedActions` entries must come from the allow-listable set
     * (attestation/predicate/disclosure actions); wallet lifecycle, sends,
     * deploys and grant administration are never grantable.
     *
     * `sponsorSessionId` is validated at creation with the same resolution
     * every sponsored write runs (platform-listed or caller-owned, active,
     * signing-capable), so a dead sponsor fails here with a 4xx instead of
     * producing a grant that burns budget on unusable writes. The sponsor is
     * still re-resolved on every use; this check cannot guarantee the
     * sponsor session outlives the grant.
     */
    action   createAgentGrant(sessionId: UUID,
                              allowedActions: array of String,
                              maxJobsPerDay: Integer, // optional; null = unlimited
                              sponsorSessionId: UUID, // optional; fixed fee-sponsor binding
                              validUntil: Timestamp, // optional; null = no expiry
                              agentLabel: String // optional, informational
    )                                                                 returns {
        grantId        : UUID;
        token          : String; // shown once, never stored
        allowedActions : array of String;
        validUntil     : Timestamp;
    };

    /**
     * Revoke an agent grant immediately. Owner-scoped: a foreign grantId
     * returns 404 rather than leaking existence.
     */
    action   revokeAgentGrant(grantId: UUID)                          returns {
        revoked : Boolean;
    };

    /**
     * Look up the status and result of a job submitted via one of the
     * async actions (`registerForDustGeneration`, `sendNight`,
     * `deployContract`, ...). Callers poll this until `status` reaches
     * `'succeeded'` or `'failed'`.
     *
     * `result` is the JSON-stringified return shape of the original action;
     * clients `JSON.parse(result)` to recover it. Null until status is
     * 'succeeded'. On failure, `errorCode` carries a stable classification
     * (e.g. '1014', '1016', 'TxFailed', 'WalletSigningNotAvailable') and
     * `errorMessage` is the human-readable detail.
     *
     * Scoped to the caller's `sessionId`: foreign job IDs return 404 rather
     * than leaking existence.
     *
     * Declared as `action` (HTTP POST) rather than `function` (HTTP GET) so
     * `status` describes server-side workflow completion. `chainStatus` is
     * independently populated later from canonical System.Events evidence.
     * Clients can polling-loop with the same POST + JSON-body pattern they
     * already use for every other async action. Side-effect free
     * despite the verb.
     */
    action   getJobStatus(jobId: UUID,
                          sessionId: UUID)                            returns {
        jobId        : UUID;
        kind         : String;
        status       : String; // pending | running | external_execution | submitted | reconciliation_required | succeeded | failed
        result       : LargeString;
        errorCode    : String;
        errorMessage : LargeString;
        attempt      : Integer;
        maxAttempts  : Integer;
        submissionId : UUID;
        txHash        : String;
        chainStatus   : String; // null | pending | success | failure; independent of job status
        chainFinalizedAt : Timestamp;
        leaseOwner    : String;
        leaseExpiresAt: Timestamp;
        heartbeatAt   : Timestamp;
        queuedAt      : Timestamp;
        externalExecutionAt : Timestamp;
        submittedAt  : Timestamp;
        startedAt    : Timestamp;
        finishedAt   : Timestamp;
    };
}

// ============================================================================
// Service-Level Annotations
// ============================================================================

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
