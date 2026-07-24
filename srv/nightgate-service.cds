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
                            sponsorSessionId: UUID // optional; second session pays the dust fee (see submitContractCall)
    )                                                                 returns {
        jobId      : UUID;
        status     : String; // 'pending' | 'succeeded' (idempotent retry)
        documentId : UUID; // stable handle for Documents row polling
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
     * Read-side view of predicate attestations. Rows are inserted by
     * `issuePredicateAttestation` and gain `provenTxHash`/`provenAt` once the
     * AttestationVault `provePredicate` call has been included on-chain.
     */
    @readonly
    entity PredicateAttestations as projection on midnight.PredicateAttestations;

    /**
     * Prove that a hidden numeric value satisfies a predicate against a public
     * `threshold`, without revealing the value (on-chain-verified model).
     *
     * The job submits two AttestationVault circuit calls: `commitValue` (binds
     * `persistentCommit(value, salt)` to the attestation) then `provePredicate`
     * (asserts the commitment matches AND the predicate holds, recording the
     * result on-chain). `value` is a scaled integer (the caller owns float
     * scaling, e.g. kg CO2e/kWh × 1000); it is used ONLY as a circuit witness
     * and is never persisted. `salt` is an optional 64-hex commitment opening
     * (generated if omitted). `predicate` is 'lessOrEqual' | 'greaterOrEqual'.
     *
     * Async: returns `{ jobId, status, predicateAttestationId }` immediately.
     * `predicateAttestationId` is a stable handle into PredicateAttestations
     * (row inserted up-front). The job `result` carries the PAC envelope shape
     * `{ predicateAttestationId, payloadHash, claim, proof }`.
     */
    action   issuePredicateAttestation(payloadHash: String, // attestation payload_hash (64 hex)
                                       value: String, // scaled integer, decimal string (witness only)
                                       salt: String, // optional 64-hex commitment opening
                                       predicate: String, // 'lessOrEqual' | 'greaterOrEqual'
                                       threshold: Integer64, // scaled integer
                                       unit: String, // optional, informational (e.g. 'kgCO2e/kWh')
                                       valueCommitment: String, // optional 64-hex on-chain commitment (for the envelope)
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
     * Field-bound predicate proof (hardened model). Like
     * `issuePredicateAttestation`, but the proven value is cryptographically
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
                                            contentRoot: String, // optional 64-hex Merkle root to anchor first
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
     * Verify a predicate attestation under the on-chain-verified model: the
     * `provePredicate` proof is only accepted by the ledger if the in-circuit
     * asserts (commitment match + predicate) held, so a successful tx IS the
     * proof. Confirms the row's `provenTxHash` resolves to a SUCCESS
     * `Transactions` result. Returns `verified: false` (not an error) for a
     * known-but-unproven row, mirroring `verifyDocument`.
     *
     * Crawler-free fallback: when the local `Transactions` lookup finds nothing
     * (crawler disabled or lagging), the result is confirmed directly against
     * live contract state; the claim key is recomputed from the row and looked
     * up in the vault's result map. No txHash and no crawler required. Plain
     * proofs use `persistentHash(PredicateClaim{payloadHash, threshold, op})`
     * against `predicate_results`; field-bound rows (with a `fieldKey`) use
     * `persistentHash(FieldPredicateClaim{payloadHash, fieldKey, threshold, op})`
     * against `field_predicate_results`.
     */
    function verifyPredicateAttestation(predicateAttestationId: UUID) returns {
        verified        : Boolean;
        predicate       : String;
        threshold       : Integer64;
        unit            : String;
        valueCommitment : String;
        provenTxHash    : String;
        provenAt        : Timestamp;
    };

    /**
     * Verify an attestation directly against LIVE contract state
     * (`queryContractState`), independent of the block crawler and of any
     * txHash. Confirms `payloadHash` is present in the vault's attestation map
     * (and, when `contentRoot` is supplied, that it equals the anchored content
     * root for that payload). Read-only; keyed entirely by the caller-supplied
     * `payloadHash`, so it needs no crawler and no enumeration.
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
                                    compiledArtifactRef: String, // optional, defaults to 'attestation-vault'
                                    network: String // optional network override, e.g. 'preview' | 'preprod' | 'mainnet'
    )                                                                 returns {
        verified      : Boolean;
        attested      : Boolean; // payload_hash present in the attestation map
        contentRootOk : Boolean; // anchored content root matches (when contentRoot given)
        attesterId    : String; // owner grantee id, if present
    };

    /**
     * Verify a predicate proof directly against LIVE contract state
     * (`queryContractState`), independent of the block crawler, of any txHash,
     * and of any server-side PredicateAttestations row: the id-free counterpart
     * to `verifyPredicateAttestation` for WALLET-submitted proofs (browser signs,
     * NIGHTGATE never saw a jobId). Recomputes the on-chain claim key off-chain
     * from the supplied coordinates and confirms the vault recorded a true
     * result for it. Supply `fieldKey` for a field-bound proof
     * (`field_predicate_results`); omit it for a plain one (`predicate_results`).
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
                                  payloadHash: String, // 64 hex
                                  fieldKey: String, // optional 64 hex; when set, field-bound
                                  predicate: String, // 'lessOrEqual' | 'greaterOrEqual'
                                  threshold: Integer64, // scaled circuit integer (see above)
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
     * sign with for the same secret.
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
     * → unshielded. Source funds come from the same ledger as the receiver;
     * use `shieldFunds` / `unshieldFunds` for cross-ledger conversion.
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
                       idempotencyKey: String // optional; dedupes retries
    )                                                                 returns {
        jobId  : UUID;
        status : String; // 'pending' | 'succeeded' (idempotent retry)
    };

    /**
     * Move the wallet's own NIGHT from shielded → unshielded ledger. Useful
     * for making NIGHT available to `registerForDustGeneration` (only
     * unshielded NIGHT UTXOs can be registered for dust accrual).
     *
     * Cross-ledger conversion is via the SDK's `initSwap` primitive: same
     * NIGHT amount appears on both sides, just shifts ledgers.
     *
     * Async: `{ jobId, status }`. `result` carries
     * `{ txId, amount, unshieldedReceiverAddress }`.
     */
    action   unshieldFunds(sessionId: UUID,
                           amount: String,
                           ttlIso: String, // optional
                           idempotencyKey: String // optional
    )                                                                 returns {
        jobId  : UUID;
        status : String;
    };

    /**
     * Symmetric counterpart to `unshieldFunds`. Move the wallet's own NIGHT
     * from unshielded → shielded ledger via `initSwap`.
     *
     * Async: `{ jobId, status }`. `result` carries
     * `{ txId, amount, shieldedReceiverAddress }`.
     */
    action   shieldFunds(sessionId: UUID,
                         amount: String,
                         ttlIso: String, // optional
                         idempotencyKey: String // optional
    )                                                                 returns {
        jobId  : UUID;
        status : String;
    };

    // ========================================================================
    // Diagnostics: read-only pre-flight UX
    // ========================================================================

    /**
     * Snapshot of the wallet's current balances. Read-only; does not build
     * or submit any transaction. Useful as a pre-flight check before
     * `sendNight` / `shieldFunds` / `unshieldFunds` / `deployContract`.
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

    /**
     * Pre-flight DUST fee estimate for an `unshieldFunds` ledger-shift.
     * Builds the `initSwap` recipe without finalizing, returns fee in
     * DUST atoms (decimal string).
     */
    function estimateUnshieldFee(sessionId: UUID,
                                 amount: String,
                                 ttlIso: String // optional
    )                                                                 returns {
        fee       : String;
        direction : String; // 'unshield'
    };

    /** Symmetric counterpart: estimate DUST fee for a `shieldFunds` shift. */
    function estimateShieldFee(sessionId: UUID,
                               amount: String,
                               ttlIso: String // optional
    )                                                                 returns {
        fee       : String;
        direction : String; // 'shield'
    };

    // ========================================================================
    // Background Jobs (async submission lifecycle)
    // ========================================================================

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
