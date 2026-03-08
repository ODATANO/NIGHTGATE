/**
 * BlockProcessor — Parses and persists Midnight blocks
 *
 * Processes a single block: parse header, classify transactions,
 * extract inputs/outputs/contract actions, and write to DB
 *
 */

interface ExtrinsicClassification {
    txType: string;
    isShielded: boolean;
    isSystem: boolean;
    palletIndex?: number;
    callIndex?: number;
}

import cds from '@sap/cds';
const { SELECT, INSERT, UPDATE } = cds.ql;
import { blake2b } from '@noble/hashes/blake2b';
import { bytesToHex } from '@noble/hashes/utils';
import { MidnightNodeProvider, SignedBlock, BlockHeader } from '../providers/MidnightNodeProvider';
import { ensureNightgateModelLoaded } from '../utils/cds-model';
import { parseExtrinsicCallIndices, parseExtrinsicParticipantInfo } from '../utils/scale';

/**
 * Mapping of pallet index to human-readable name and transaction type.
 * Used for classifying extrinsics into transaction types (e.g. transfer, contract_call).
 */

export interface PalletMapping {
    name: string;
    txType: string;
    isShielded?: boolean;
    isSystem?: boolean;
}

/** Default Substrate pallet index → type mapping. Override via cds.requires.nightgate.palletMap */
/** Valid TxType values matching the schema enum in db/schema.cds */
const VALID_TX_TYPES = new Set([
    'night_transfer', 'shielded_transfer', 'contract_deploy', 'contract_call',
    'contract_update', 'dust_registration', 'dust_generation', 'governance',
    'system', 'unknown'
]);

const DEFAULT_PALLET_MAP: Record<number, PalletMapping> = {
    0: { name: 'System', txType: 'system', isSystem: true },
    1: { name: 'Timestamp', txType: 'system', isSystem: true },
    2: { name: 'Babe', txType: 'system', isSystem: true },
    3: { name: 'Grandpa', txType: 'system', isSystem: true },
    4: { name: 'Balances', txType: 'night_transfer' },
    5: { name: 'Sudo', txType: 'system', isSystem: true },
    10: { name: 'Contracts', txType: 'contract_call' },
    // Midnight-specific pallets — configure actual indices via cds.requires.nightgate.palletMap:
    // { "15": { "name": "Zswap", "txType": "shielded_transfer", "isShielded": true } }
    // { "16": { "name": "ContractPallet", "txType": "contract_deploy" } }
};

const NIGHT_TOKEN_TYPE_HEX = '0x4e49474854';

function buildPalletMap(): Map<number, PalletMapping> {
    const map = new Map<number, PalletMapping>();

    // Load defaults
    for (const [idx, entry] of Object.entries(DEFAULT_PALLET_MAP)) {
        map.set(Number(idx), entry);
    }

    // Override with config
    const nightgateConfig = (cds.env as any).requires?.nightgate || {};
    const configMap = nightgateConfig.palletMap;
    if (configMap && typeof configMap === 'object') {
        for (const [idx, entry] of Object.entries(configMap)) {
            const mapping = entry as PalletMapping;
            if (!VALID_TX_TYPES.has(mapping.txType)) {
                console.warn(`[BlockProcessor] palletMap[${idx}] has invalid txType "${mapping.txType}", falling back to "unknown"`);
                mapping.txType = 'unknown';
            }
            map.set(Number(idx), mapping);
        }
    }

    return map;
}

// ============================================================================
// Types
// ============================================================================

export interface ProcessResult {
    blockHeight: number;
    blockHash: string;
    transactionCount: number;
    contractActionCount: number;
    processingTimeMs: number;
}

// ============================================================================
// Block Processor
// ============================================================================

export class BlockProcessor {
    private db: any;
    private palletMap: Map<number, PalletMapping>;

    // Cache: specVersion rarely changes (only on runtime upgrades)
    private cachedSpecVersion: number = 0;
    private cachedSpecVersionHash: string | null = null;

    /** Well-known Substrate storage key for Timestamp::Now (twox128("Timestamp") + twox128("Now")) */
    private static readonly TIMESTAMP_STORAGE_KEY =
        '0xf0c365c3cf59d671eb72da0e7a4113c4e2c375c859d5adb749f1454ac11356be';

    constructor(
        private nodeProvider: MidnightNodeProvider
    ) {
        this.palletMap = buildPalletMap();
    }

    async init(): Promise<void> {
        await ensureNightgateModelLoaded();
        this.db = await cds.connect.to('db');
    }

    /**
     * Process a single block by hash — fetch, parse, and persist atomically
     */
    async processBlockByHash(blockHash: string): Promise<ProcessResult> {
        const start = Date.now();
        return this.processFromNode(blockHash, start);
    }

    /**
     * Process a block by height
     */
    async processBlockByHeight(height: number): Promise<ProcessResult> {
        const hash = await this.nodeProvider.getBlockHash(height);
        if (!hash) throw new Error(`No block at height ${height}`);
        return this.processBlockByHash(hash);
    }

    /**
     * Check if a block already exists in the local DB
     */
    async blockExists(hash: string): Promise<boolean> {
        const existing = await this.db.run(
            SELECT.one.from('midnight.Blocks').columns('ID').where({ hash })
        );
        return !!existing;
    }

    // ========================================================================
    // Node-based Processing (Substrate RPC raw blocks)
    // ========================================================================

    private async processFromNode(blockHash: string, start: number): Promise<ProcessResult> {
        // Skip if already processed
        if (await this.blockExists(blockHash)) {
            const header = await this.nodeProvider.getHeader(blockHash);
            return {
                blockHeight: MidnightNodeProvider.parseBlockNumber(header.number),
                blockHash,
                transactionCount: 0,
                contractActionCount: 0,
                processingTimeMs: Date.now() - start
            };
        }

        const signedBlock = await this.nodeProvider.getBlock(blockHash);
        const header = signedBlock.block.header;
        const height = MidnightNodeProvider.parseBlockNumber(header.number);
        const extrinsics = signedBlock.block.extrinsics;

        let txCount = 0;
        let actionCount = 0;

        // Fetch canonical metadata from node (outside tx for RPC calls)
        const protocolVersion = await this.getProtocolVersion(blockHash);
        const timestamp = await this.getBlockTimestamp(blockHash);

        // Atomic DB write
        await this.db.tx(async (tx: any) => {
            // 1. Insert block
            const blockId = cds.utils.uuid();
            const parentBlock = await tx.run(
                SELECT.one.from('midnight.Blocks').columns('ID').where({ hash: header.parentHash })
            );

            await tx.run(INSERT.into('midnight.Blocks').entries({
                ID: blockId,
                hash: blockHash,
                height: height,
                protocolVersion,
                timestamp,
                author: this.extractAuthor(header.digest?.logs),
                ledgerParameters: header.stateRoot,
                parent_ID: parentBlock?.ID || null
            }));

            // 2. Parse extrinsics as transactions
            for (let i = 0; i < extrinsics.length; i++) {
                const extrinsicHex = extrinsics[i];
                const txId = cds.utils.uuid();
                const classification = this.classifyExtrinsic(extrinsicHex);
                const participants = parseExtrinsicParticipantInfo(extrinsicHex);
                const extrinsicHash = this.hashExtrinsic(extrinsicHex);
                const txSize = this.extrinsicSize(extrinsicHex);
                const circuitName = this.buildCircuitName(classification);
                const contractActionType = this.toContractActionType(classification.txType);
                const contractAddress = contractActionType ? this.deriveContractAddress(extrinsicHash) : null;
                const senderAddress = participants?.senderAddress || null;
                const isTransferLike = !!participants?.receiverAddress && !!participants?.amount && !classification.isSystem;
                const receiverAddress = isTransferLike ? participants!.receiverAddress! : null;
                const nightAmount = isTransferLike ? participants!.amount! : null;

                await tx.run(INSERT.into('midnight.Transactions').entries({
                    ID: txId,
                    transactionId: i,
                    hash: extrinsicHash,
                    protocolVersion,
                    raw: extrinsicHex,
                    transactionType: classification.isSystem ? 'SYSTEM' : 'REGULAR',
                    txType: classification.txType,
                    isShielded: classification.isShielded,
                    senderAddress,
                    receiverAddress,
                    nightAmount,
                    hasProof: classification.isShielded,
                    proofHash: classification.isShielded ? extrinsicHash : null,
                    contractAddress,
                    circuitName,
                    size: txSize,
                    block_ID: blockId
                }));

                // Baseline tx child records keep exposed compositions queryable.
                await tx.run(INSERT.into('midnight.TransactionResults').entries({
                    ID: cds.utils.uuid(),
                    status: 'SUCCESS',
                    transaction_ID: txId
                }));

                await tx.run(INSERT.into('midnight.TransactionFees').entries({
                    ID: cds.utils.uuid(),
                    paidFees: '0',
                    estimatedFees: '0',
                    transaction_ID: txId
                }));

                if (isTransferLike && receiverAddress && nightAmount) {
                    await this.persistTransferProjections(tx, {
                        txId,
                        txHash: extrinsicHash,
                        blockHeight: height,
                        blockTimestamp: timestamp,
                        senderAddress,
                        receiverAddress,
                        amount: nightAmount,
                        outputIndex: i
                    });
                }

                txCount++;

                // Track contract actions from extrinsic classification
                if (contractActionType && contractAddress) {
                    await tx.run(INSERT.into('midnight.ContractActions').entries({
                        ID: cds.utils.uuid(),
                        address: contractAddress,
                        actionType: contractActionType,
                        entryPoint: circuitName,
                        state: extrinsicHex,
                        transaction_ID: txId
                    }));
                    actionCount++;
                }
            }

            // 3. Update SyncState
            await tx.run(
                UPDATE.entity('midnight.SyncState').set({
                    lastIndexedHeight: height,
                    lastIndexedHash: blockHash,
                    lastIndexedAt: new Date().toISOString(),
                    syncStatus: 'syncing'
                }).where({ ID: 'SINGLETON' })
            );
        });

        return {
            blockHeight: height,
            blockHash,
            transactionCount: txCount,
            contractActionCount: actionCount,
            processingTimeMs: Date.now() - start
        };
    }

    // ========================================================================
    // Extrinsic Classification (for node-sourced blocks)
    // ========================================================================

    private classifyExtrinsic(hex: string): ExtrinsicClassification {
        if (!hex || hex.length < 10) {
            return { txType: 'system', isShielded: false, isSystem: true };
        }

        // Parse SCALE-encoded extrinsic to extract pallet + call index
        const indices = parseExtrinsicCallIndices(hex);
        if (indices) {
            return {
                ...this.mapPalletCall(indices.palletIndex, indices.callIndex),
                palletIndex: indices.palletIndex,
                callIndex: indices.callIndex
            };
        }

        // Fallback: length-based heuristic when parsing fails
        if (hex.length < 100) {
            return { txType: 'system', isShielded: false, isSystem: true };
        }
        return { txType: 'unknown', isShielded: false, isSystem: false };
    }

    private extrinsicSize(hex: string): number {
        const cleanHex = hex.startsWith('0x') ? hex.slice(2) : hex;
        return Math.ceil(cleanHex.length / 2);
    }

    private toContractActionType(txType: string): 'DEPLOY' | 'CALL' | 'UPDATE' | null {
        if (txType === 'contract_deploy') return 'DEPLOY';
        if (txType === 'contract_call') return 'CALL';
        if (txType === 'contract_update') return 'UPDATE';
        return null;
    }

    private deriveContractAddress(extrinsicHash: string): string {
        const cleanHash = extrinsicHash.startsWith('0x') ? extrinsicHash.slice(2) : extrinsicHash;
        // Keep a deterministic 28-byte key-hash-like identifier for contract address grouping.
        return `0x${cleanHash.slice(0, 56)}`;
    }

    private buildCircuitName(classification: ExtrinsicClassification): string | null {
        if (classification.palletIndex == null || classification.callIndex == null) {
            return null;
        }

        return `${classification.palletIndex}:${classification.callIndex}`;
    }

    private mapPalletCall(palletIndex: number, callIndex: number): {
        txType: string;
        isShielded: boolean;
        isSystem: boolean;
    } {
        const entry = this.palletMap.get(palletIndex);
        if (!entry) {
            return { txType: 'unknown', isShielded: false, isSystem: false };
        }

        // For Contracts pallet, distinguish deploy vs call vs update by call_index
        let txType = entry.txType;
        if (entry.name === 'Contracts') {
            if (callIndex === 0) txType = 'contract_call';
            else if (callIndex === 1) txType = 'contract_deploy';
            else if (callIndex === 2) txType = 'contract_update';
        }

        return {
            txType,
            isShielded: entry.isShielded || false,
            isSystem: entry.isSystem || false
        };
    }

    private async persistTransferProjections(tx: any, params: {
        txId: string;
        txHash: string;
        blockHeight: number;
        blockTimestamp: number;
        senderAddress: string | null;
        receiverAddress: string;
        amount: string;
        outputIndex: number;
    }): Promise<void> {
        const amount = this.toBigInt(params.amount);
        if (amount <= 0n) return;

        await tx.run(INSERT.into('midnight.UnshieldedUtxos').entries({
            ID: cds.utils.uuid(),
            owner: params.receiverAddress,
            tokenType: NIGHT_TOKEN_TYPE_HEX,
            value: amount.toString(),
            intentHash: params.txHash,
            outputIndex: params.outputIndex,
            ctime: params.blockTimestamp,
            initialNonce: params.txHash,
            registeredForDustGeneration: false,
            createdAtTransaction_ID: params.txId
        }));

        await this.upsertNightBalance(tx, {
            address: params.receiverAddress,
            blockHeight: params.blockHeight,
            balanceDelta: amount,
            utxoCountDelta: 1,
            txSentDelta: 0,
            txReceivedDelta: 1,
            sentAmountDelta: 0n,
            receivedAmountDelta: amount
        });

        if (params.senderAddress && params.senderAddress !== params.receiverAddress) {
            await this.upsertNightBalance(tx, {
                address: params.senderAddress,
                blockHeight: params.blockHeight,
                balanceDelta: 0n,
                utxoCountDelta: 0,
                txSentDelta: 1,
                txReceivedDelta: 0,
                sentAmountDelta: amount,
                receivedAmountDelta: 0n
            });
        }
    }

    private async upsertNightBalance(tx: any, params: {
        address: string;
        blockHeight: number;
        balanceDelta: bigint;
        utxoCountDelta: number;
        txSentDelta: number;
        txReceivedDelta: number;
        sentAmountDelta: bigint;
        receivedAmountDelta: bigint;
    }): Promise<void> {
        const nowIso = new Date().toISOString();
        const existing = await tx.run(
            SELECT.one
                .from('midnight.NightBalances')
                .columns(
                    'address',
                    'balance',
                    'utxoCount',
                    'txSentCount',
                    'txReceivedCount',
                    'totalSent',
                    'totalReceived'
                )
                .where({ address: params.address })
        );

        if (!existing) {
            const initialBalance = params.balanceDelta < 0n ? 0n : params.balanceDelta;
            await tx.run(INSERT.into('midnight.NightBalances').entries({
                address: params.address,
                balance: initialBalance.toString(),
                utxoCount: Math.max(params.utxoCountDelta, 0),
                firstSeenHeight: params.blockHeight,
                firstSeenAt: nowIso,
                lastActivityHeight: params.blockHeight,
                lastActivityAt: nowIso,
                txSentCount: Math.max(params.txSentDelta, 0),
                txReceivedCount: Math.max(params.txReceivedDelta, 0),
                totalSent: params.sentAmountDelta.toString(),
                totalReceived: params.receivedAmountDelta.toString(),
                lastUpdatedHeight: params.blockHeight,
                lastUpdatedAt: nowIso
            }));
            return;
        }

        const currentBalance = this.toBigInt(existing.balance);
        const nextBalanceRaw = currentBalance + params.balanceDelta;
        const nextBalance = nextBalanceRaw < 0n ? 0n : nextBalanceRaw;

        const currentUtxoCount = this.toInt(existing.utxoCount);
        const nextUtxoCount = Math.max(currentUtxoCount + params.utxoCountDelta, 0);

        const currentSentCount = this.toInt(existing.txSentCount);
        const currentReceivedCount = this.toInt(existing.txReceivedCount);

        const currentTotalSent = this.toBigInt(existing.totalSent);
        const currentTotalReceived = this.toBigInt(existing.totalReceived);

        await tx.run(
            UPDATE.entity('midnight.NightBalances').set({
                balance: nextBalance.toString(),
                utxoCount: nextUtxoCount,
                txSentCount: currentSentCount + params.txSentDelta,
                txReceivedCount: currentReceivedCount + params.txReceivedDelta,
                totalSent: (currentTotalSent + params.sentAmountDelta).toString(),
                totalReceived: (currentTotalReceived + params.receivedAmountDelta).toString(),
                lastActivityHeight: params.blockHeight,
                lastActivityAt: nowIso,
                lastUpdatedHeight: params.blockHeight,
                lastUpdatedAt: nowIso
            }).where({ address: params.address })
        );
    }

    private toBigInt(value: unknown): bigint {
        if (typeof value === 'bigint') return value;
        if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.trunc(value));
        if (typeof value === 'string' && value.trim() !== '') {
            try {
                return BigInt(value);
            } catch {
                return 0n;
            }
        }
        return 0n;
    }

    private toInt(value: unknown): number {
        if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
        if (typeof value === 'string' && value.trim() !== '') {
            const parsed = Number(value);
            if (Number.isFinite(parsed)) return Math.trunc(parsed);
        }
        return 0;
    }

    /**
     * Compute blake2b-256 hash of the raw SCALE-encoded extrinsic bytes.
     * Produces the canonical extrinsic hash matching block explorers and other indexers.
     */
    private hashExtrinsic(hex: string): string {
        const cleanHex = hex.startsWith('0x') ? hex.slice(2) : hex;
        const bytes = Buffer.from(cleanHex, 'hex');
        const hash = blake2b(bytes, { dkLen: 32 });
        return '0x' + bytesToHex(hash);
    }

    /**
     * Query the Timestamp pallet storage at a specific block to get the on-chain timestamp.
     * Returns UNIX timestamp in seconds. Falls back to wall-clock time if query fails.
     */
    private async getBlockTimestamp(blockHash: string): Promise<number> {
        try {
            const result = await this.nodeProvider.getStorage(
                BlockProcessor.TIMESTAMP_STORAGE_KEY,
                blockHash
            );
            if (result) {
                const hex = result.startsWith('0x') ? result.slice(2) : result;
                const buf = Buffer.from(hex, 'hex');
                // Timestamp::Now is a SCALE-encoded u64, little-endian, in milliseconds
                const msTimestamp = buf.readBigUInt64LE(0);
                return Number(msTimestamp / 1000n);
            }
        } catch (err) {
            console.warn(`[BlockProcessor] Failed to read on-chain timestamp for ${blockHash}: ${(err as Error).message}`);
        }
        return Math.floor(Date.now() / 1000);
    }

    /**
     * Get the runtime specVersion at a specific block. Caches since version only changes on upgrades.
     */
    private async getProtocolVersion(blockHash: string): Promise<number> {
        if (this.cachedSpecVersionHash === blockHash) {
            return this.cachedSpecVersion;
        }
        try {
            const rv = await this.nodeProvider.getRuntimeVersion(blockHash);
            this.cachedSpecVersion = rv.specVersion;
            this.cachedSpecVersionHash = blockHash;
            return rv.specVersion;
        } catch (err) {
            console.warn(`[BlockProcessor] Failed to get runtime version for ${blockHash}: ${(err as Error).message}`);
            return this.cachedSpecVersion;
        }
    }

    /**
     * Extract author/validator info from digest logs.
     * Looks for PreRuntime log (type 0x06) containing engine ID + authority data.
     * Falls back to the first digest log entry if no PreRuntime log found.
     */
    private extractAuthor(digestLogs: string[] | undefined): string | null {
        if (!digestLogs || digestLogs.length === 0) return null;

        for (const logHex of digestLogs) {
            const clean = logHex.startsWith('0x') ? logHex.slice(2) : logHex;
            if (clean.length < 10) continue;

            const logType = parseInt(clean.slice(0, 2), 16);

            // PreRuntime digest log type = 6
            if (logType === 6) {
                const engineId = Buffer.from(clean.slice(2, 10), 'hex').toString('ascii');
                const data = '0x' + clean.slice(10);
                return `${engineId}:${data}`;
            }
        }

        // Fallback: return first log entry
        return digestLogs[0] || null;
    }
}
