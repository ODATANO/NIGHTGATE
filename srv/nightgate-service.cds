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
    // Session Management (Wallet Connections)
    // ========================================================================

    /**
     * Wallet session management
     */
    entity WalletSessions            as
        projection on midnight.WalletSessions
        excluding {
            viewingKeyHash, // Internal lookup field
            encryptedViewingKey // Encrypted key — never exposed via OData
        }
        actions {
            // Connect with viewing key
            action connectWallet(viewingKey: String) returns WalletSessions;

            // Disconnect session
            action disconnectWallet(sessionId: UUID);
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
