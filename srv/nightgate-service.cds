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
    entity Blocks                    as
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
    entity Transactions              as
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
    entity TransactionResults        as projection on midnight.TransactionResults;

    @readonly
    entity TransactionSegments       as projection on midnight.TransactionSegments;

    @readonly
    entity TransactionFees           as projection on midnight.TransactionFees;

    // ========================================================================
    // Smart Contracts
    // ========================================================================

            /**
             * Contract actions with deployment, call, and update tracking
             */
    @readonly
    entity ContractActions           as
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
    entity ContractBalances          as projection on midnight.ContractBalances;

    // ========================================================================
    // UTXOs
    // ========================================================================

            /**
             * Unshielded UTXOs for transparent transactions
             */
    @readonly
    entity UnshieldedUtxos           as
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
    entity ZswapLedgerEvents         as projection on midnight.ZswapLedgerEvents;

    @readonly
    entity DustLedgerEvents          as projection on midnight.DustLedgerEvents;

    // ========================================================================
    // Balance & Token Tracking
    // ========================================================================

            /**
             * Unshielded NIGHT token balances per address
             */
    @readonly
    entity NightBalances             as projection on midnight.NightBalances
        actions {
            // Get balance for a specific address
            @cds.odata.bindingparameter.collection
            function getBalance(address: String)   returns NightBalances;

            // Get top holders by balance
            @cds.odata.bindingparameter.collection
            function getTopHolders(limit: Integer) returns array of NightBalances;
        };

    // ========================================================================
    // Submission Lifecycle (T4/T5)
    // ========================================================================

    /**
     * In-flight and historical submissions originated by this NIGHTGATE
     * instance via deployContract / submitContractCall. Reconciled to
     * `finalized` by the crawler when the matching tx is indexed.
     */
    @readonly
    entity PendingSubmissions        as projection on midnight.PendingSubmissions;

    // ========================================================================
    // Document Anchoring (T12)
    // ========================================================================

    /**
     * Read-side view of anchored documents. Rows are inserted by
     * `anchorDocument` and progress through `anchoredTxHash` once the
     * AttestationVault `attest` call has been submitted.
     */
    @readonly
    entity Documents                 as projection on midnight.Documents;

    /**
     * Anchor a document's content hash on-chain via the AttestationVault
     * `attest` circuit. The caller is responsible for placing the actual
     * bytes at `storageRef` (e.g. file://, s3://, ipfs://) — this action
     * commits only the hash + public metadata to the chain.
     *
     * `sha256` is a 64-char hex string of the file content (becomes
     * `payload_hash` on chain). `metadata` is a JSON-encoded public blob;
     * its blake2b/sha256 commitment is what `attest` stores as
     * `metadata_hash`. `sessionId` provides the wallet that signs and pays
     * DUST fees. `compiledArtifactRef` defaults to 'attestation-vault'.
     *
     * Async: returns `{ jobId, status, documentId }` immediately. The
     * `documentId` is a stable handle into the Documents entity (the row is
     * inserted synchronously up-front), so callers can poll the row for
     * `anchoredTxHash` independently of `getJobStatus`. The job's `result`
     * on success carries `{ documentId, attestationId, txHash, anchoredAt }`.
     */
    action anchorDocument(
        sha256:              String,
        contentType:         String,
        size:                Integer64,
        storageRef:          String,
        metadata:            LargeString,  // JSON
        sessionId:           UUID,
        contractAddress:     String,       // AttestationVault deployment to anchor into
        compiledArtifactRef: String,       // optional, defaults to 'attestation-vault'
        idempotencyKey:      String        // optional; dedupes retries
    )                                returns {
        jobId:      UUID;
        status:     String;  // 'pending' | 'succeeded' (idempotent retry)
        documentId: UUID;    // stable handle for Documents row polling
    };

    /**
     * Verify that a document's content hash matches what was anchored on chain
     * (T13). Returns a deterministic yes/no answer — invalid inputs reject
     * with 400/404, but a hash-mismatch on a known doc returns
     * `verified: false` rather than erroring, so calling UIs can render
     * "tampered" without status-code juggling.
     *
     * Verification rules (all must hold for `verified: true`):
     *   - Documents row exists for `documentId`
     *   - `providedSha256` (case-insensitive hex) equals the stored `sha256`
     *   - `anchoredTxHash` is set
     *   - The corresponding Transactions row's transactionResult status is SUCCESS
     */
    function verifyDocument(
        documentId:     UUID,
        providedSha256: String
    )                                returns {
        verified:       Boolean;
        anchoredTxHash: String;
        anchoredAt:     Timestamp;
        originalSha256: String;
    };

    /**
     * Deploy a registered compiled contract. The contract must be registered
     * via `cds.requires.nightgate.contracts.<ref>` or `registerContract()`.
     *
     * Async: returns `{ jobId, status }` immediately. Poll
     * `getJobStatus(jobId, sessionId)`; on success the `result` field carries
     * the original return shape `{ submissionId, txHash, contractAddress,
     * status }` (status here is the PendingSubmissions lifecycle status —
     * `included` / `finalized` / `failed` — distinct from the job status).
     */
    action deployContract(
        compiledArtifactRef: String,
        sessionId:           UUID,
        initialPrivateState: LargeString, // JSON-encoded
        idempotencyKey:      String       // optional; dedupes retries
    )                                returns {
        jobId:  UUID;
        status: String;  // 'pending' | 'succeeded' (idempotent retry)
    };

    /**
     * Submit a call to a deployed contract. `args` is JSON-encoded.
     *
     * Async: returns `{ jobId, status }`. Polled via `getJobStatus`; the
     * `result` carries `{ submissionId, txHash, contractAddress, status }`.
     */
    action submitContractCall(
        contractAddress:     String,
        circuit:             String,
        compiledArtifactRef: String,
        sessionId:           UUID,
        args:                LargeString, // JSON-encoded array, may be '[]'
        idempotencyKey:      String       // optional; dedupes retries
    )                                returns {
        jobId:  UUID;
        status: String;  // 'pending' | 'succeeded' (idempotent retry)
    };

    // ========================================================================
    // Session Management (Wallet Connections)
    // ========================================================================

    /**
     * Wallet session management
     */
    entity WalletSessions            as
        projection on midnight.WalletSessions
        excluding {
            viewingKeyHash, // Internal lookup field
            encryptedViewingKey // Encrypted key, never exposed via OData
        };

    /**
     * Create a read-only session by storing the viewing key encrypted at rest.
     * Returns the new session's UUID and metadata.
     */
    action connectWallet(viewingKey: String) returns {
        ID: UUID;
        sessionId: UUID;
        connectedAt: Timestamp;
        expiresAt: Timestamp;
        isActive: Boolean;
    };

    /**
     * Disconnect an active session, nulling out encrypted keys.
     */
    action disconnectWallet(sessionId: UUID);

    /**
     * Upgrade an existing read-only session with signing capability.
     * Stores the seed key encrypted at rest (AES-256-GCM via ENCRYPTION_KEY).
     * Required before deployContract/submitContractCall flows can balance/submit.
     *
     * The session UPDATE happens synchronously — `signingEnabled: true` is
     * returned as soon as the encrypted seed is persisted, so callers can
     * proceed to other signing-capable actions immediately.
     *
     * `prewarmJobId` tracks an async pre-warm of the WalletFacade. The first
     * deployContract / submitContractCall after a fresh seed pays a multi-
     * hour cold-sync cost unless this pre-warm has finished. Poll
     * `getJobStatus(prewarmJobId, sessionId)` to know when the wallet is
     * ready. Failing to wait is fine — subsequent actions just block on the
     * same sync internally.
     */
    action connectWalletForSigning(
        sessionId:      UUID,
        seedHex:        String,
        idempotencyKey: String   // optional; dedupes retries on a flaky network
    ) returns {
        sessionId:      UUID;
        signingEnabled: Boolean;
        prewarmJobId:   UUID;
        prewarmStatus:  String;  // 'pending' | 'succeeded' (idempotent retry)
    };

    /**
     * Register the session's NIGHT UTXOs for DUST generation. DUST is the fee
     * token on Midnight; without it, deployContract/submitContractCall cannot
     * pay fees. Initial DUST accrual takes 1-2 minutes after the on-chain
     * registration tx settles.
     *
     * Async: returns `{ jobId, status }` immediately. Poll
     * `getJobStatus(jobId, sessionId)` for the final result, which (on
     * success) carries the original shape — `{ txId, registeredCount,
     * totalNightUtxos, dustReceiverAddress }` — as JSON in `result`.
     *
     * `idempotencyKey` (optional) lets retries on a flaky network dedupe
     * against the original job; reusing a key returns the existing jobId.
     */
    action registerForDustGeneration(
        sessionId:           UUID,
        dustReceiverAddress: String,  // optional; defaults to the wallet's own DUST address
        idempotencyKey:      String   // optional; dedupes retries
    ) returns {
        jobId:  UUID;
        status: String;  // 'pending' | 'succeeded' (idempotent retry)
    };

    /**
     * Symmetric pair to `registerForDustGeneration`. Removes ALL the wallet's
     * registered NIGHT UTXOs from dust generation, making them spendable
     * again. Per-UTXO narrowing is not exposed yet.
     *
     * Async — same `{ jobId, status }` contract as `registerForDustGeneration`.
     * On success the `result` field of `getJobStatus` carries
     * `{ txId, deregisteredCount, totalNightUtxos }`.
     */
    action deregisterFromDustGeneration(
        sessionId:      UUID,
        idempotencyKey: String   // optional
    ) returns {
        jobId:  UUID;
        status: String;  // 'pending' | 'succeeded' (idempotent retry)
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
    action sendNight(
        sessionId:       UUID,
        receiverAddress: String,
        amount:          String,
        ttlIso:          String,  // optional ISO-8601; defaults to +10min
        idempotencyKey:  String   // optional; dedupes retries
    ) returns {
        jobId:  UUID;
        status: String;  // 'pending' | 'succeeded' (idempotent retry)
    };

    /**
     * Move the wallet's own NIGHT from shielded → unshielded ledger. Useful
     * for making NIGHT available to `registerForDustGeneration` (only
     * unshielded NIGHT UTXOs can be registered for dust accrual).
     *
     * Cross-ledger conversion is via the SDK's `initSwap` primitive: same
     * NIGHT amount appears on both sides, just shifts ledgers.
     *
     * Async — `{ jobId, status }`. `result` carries
     * `{ txId, amount, unshieldedReceiverAddress }`.
     */
    action unshieldFunds(
        sessionId:      UUID,
        amount:         String,
        ttlIso:         String,  // optional
        idempotencyKey: String   // optional
    ) returns {
        jobId:  UUID;
        status: String;
    };

    /**
     * Symmetric counterpart to `unshieldFunds`. Move the wallet's own NIGHT
     * from unshielded → shielded ledger via `initSwap`.
     *
     * Async — `{ jobId, status }`. `result` carries
     * `{ txId, amount, shieldedReceiverAddress }`.
     */
    action shieldFunds(
        sessionId:      UUID,
        amount:         String,
        ttlIso:         String,  // optional
        idempotencyKey: String   // optional
    ) returns {
        jobId:  UUID;
        status: String;
    };

    // ========================================================================
    // Diagnostics — read-only pre-flight UX
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
    function getWalletBalance(sessionId: UUID) returns {
        shieldedNight: String;
        unshieldedNight: String;
        dustBalance: String;
        registeredNightUtxoCount: Integer;
        totalNightUtxoCount: Integer;
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
    function estimateSendNightFee(
        sessionId:       UUID,
        receiverAddress: String,
        amount:          String,
        ttlIso:          String   // optional
    ) returns {
        fee: String;
        toLedger: String;
    };

    /**
     * Pre-flight DUST fee estimate for an `unshieldFunds` ledger-shift.
     * Builds the `initSwap` recipe without finalizing, returns fee in
     * DUST atoms (decimal string).
     */
    function estimateUnshieldFee(
        sessionId: UUID,
        amount:    String,
        ttlIso:    String   // optional
    ) returns {
        fee: String;
        direction: String;   // 'unshield'
    };

    /** Symmetric counterpart: estimate DUST fee for a `shieldFunds` shift. */
    function estimateShieldFee(
        sessionId: UUID,
        amount:    String,
        ttlIso:    String   // optional
    ) returns {
        fee: String;
        direction: String;   // 'shield'
    };

    // ========================================================================
    // Background Jobs (async submission lifecycle, 0.2.0)
    // ========================================================================

    /**
     * Look up the status and result of a job submitted via one of the
     * async-migrated actions (`registerForDustGeneration`, `sendNight`,
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
     * clients can polling-loop with the same POST + JSON-body pattern they
     * already use for every other 0.2.0 async action. Side-effect free
     * despite the verb.
     */
    action getJobStatus(
        jobId:     UUID,
        sessionId: UUID
    ) returns {
        jobId:        UUID;
        kind:         String;
        status:       String;   // 'pending' | 'running' | 'succeeded' | 'failed'
        result:       LargeString;
        errorCode:    String;
        errorMessage: LargeString;
        submittedAt:  Timestamp;
        startedAt:    Timestamp;
        finishedAt:   Timestamp;
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
