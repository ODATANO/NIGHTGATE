/**
 * Type definitions for Midnight blockchain data structures.
 *
 * These types describe the shape of indexed blockchain data.
 * Used by MidnightService transformers and syncBlock.
 */

// ============================================================================
// Block & Transaction Types
// ============================================================================

export interface Block {
    hash: string;
    height: number;
    protocolVersion: number;
    timestamp: number;
    author: string;
    ledgerParameters: string;
    transactions?: Transaction[];
    systemParameters?: SystemParameters;
}

export interface Transaction {
    id: number;
    hash: string;
    protocolVersion: number;
    raw?: string;
    contractActions?: ContractAction[];
    unshieldedCreatedOutputs?: UnshieldedUtxo[];
    unshieldedSpentOutputs?: UnshieldedUtxo[];
    zswapLedgerEvents?: ZswapLedgerEvent[];
    dustLedgerEvents?: DustLedgerEvent[];
}

export interface RegularTransaction extends Transaction {
    merkleTreeRoot: string;
    startIndex: number;
    endIndex: number;
    identifiers?: string[];
    transactionResult?: TransactionResult;
    fees?: TransactionFees;
}

export interface SystemTransaction extends Transaction {
    // System transactions have no additional fields beyond base Transaction
}

// ============================================================================
// Transaction Details
// ============================================================================

export interface TransactionResult {
    status: string;
    segments?: TransactionSegment[];
}

export interface TransactionSegment {
    id: number;
    success: boolean;
}

export interface TransactionFees {
    paidFees: string;
    estimatedFees: string;
}

// ============================================================================
// Contract Types
// ============================================================================

export interface ContractAction {
    address: string;
    state?: string;
    zswapState?: string;
    unshieldedBalances?: ContractBalance[];
}

export interface ContractDeploy extends ContractAction {
    deploy: unknown;
}

export interface ContractCall extends ContractAction {
    entryPoint: string;
    deploy?: unknown;
}

export interface ContractUpdate extends ContractAction {
    // Update actions have base fields only
}

export interface ContractBalance {
    tokenType: string;
    amount: string;
}

// ============================================================================
// UTXO Types
// ============================================================================

export interface UnshieldedUtxo {
    owner: string;
    tokenType: string;
    value: string;
    intentHash: string;
    outputIndex: number;
    ctime?: number;
    initialNonce: string;
    registeredForDustGeneration: boolean;
}

// ============================================================================
// Ledger Event Types
// ============================================================================

export interface ZswapLedgerEvent {
    id: number;
    raw: string;
    maxId: number;
}

export interface DustLedgerEvent {
    id: number;
    raw: string;
    maxId: number;
}

// ============================================================================
// Governance Types
// ============================================================================

export interface SystemParameters {
    dParameter: DParameter;
    termsAndConditions?: TermsAndConditions;
}

export interface DParameter {
    numPermissionedCandidates: number;
    numRegisteredCandidates: number;
}

export interface TermsAndConditions {
    hash: string;
    url: string;
}

// ============================================================================
// DUST Types
// ============================================================================

export interface DustGenerationStatus {
    cardanoRewardAddress: string;
    dustAddress?: string;
    registered: boolean;
    nightBalance: string;
    generationRate: string;
    maxCapacity: string;
    currentCapacity: string;
    utxoTxHash?: string;
    utxoOutputIndex?: number;
}
