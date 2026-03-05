/**
 * BlockProcessor — Parses and persists Midnight blocks
 *
 * Processes a single block: parse header, classify transactions,
 * extract inputs/outputs/contract actions, and write to DB
 *
 */

import cds from '@sap/cds';
const { SELECT, INSERT, UPDATE } = cds.ql;
import { blake2b } from '@noble/hashes/blake2b';
import { bytesToHex } from '@noble/hashes/utils';
import { MidnightNodeProvider, SignedBlock, BlockHeader } from '../providers/MidnightNodeProvider';
import { parseExtrinsicCallIndices } from '../utils/scale';

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

/** Default Substrate pallet index → type mapping. Override via cds.requires.midnight.palletMap */
const DEFAULT_PALLET_MAP: Record<number, PalletMapping> = {
    0:  { name: 'System',       txType: 'system',            isSystem: true },
    1:  { name: 'Timestamp',    txType: 'timestamp',         isSystem: true },
    2:  { name: 'Babe',         txType: 'consensus',         isSystem: true },
    3:  { name: 'Grandpa',      txType: 'consensus',         isSystem: true },
    4:  { name: 'Balances',     txType: 'transfer' },
    5:  { name: 'Sudo',         txType: 'sudo',              isSystem: true },
    10: { name: 'Contracts',    txType: 'contract_call' },
    // @TODO Midnight-specific pallets — configure actual indices via cds.requires.midnight.palletMap:
    // { "15": { "name": "Zswap", "txType": "shielded_transfer", "isShielded": true } }
    // { "16": { "name": "ContractPallet", "txType": "contract_deploy" } }
};

function buildPalletMap(): Map<number, PalletMapping> {
    const map = new Map<number, PalletMapping>();

    // Load defaults
    for (const [idx, entry] of Object.entries(DEFAULT_PALLET_MAP)) {
        map.set(Number(idx), entry);
    }

    // Override with config
    const midnightConfig = (cds.env as any).requires?.midnight || {};
    const configMap = midnightConfig.palletMap;
    if (configMap && typeof configMap === 'object') {
        for (const [idx, entry] of Object.entries(configMap)) {
            map.set(Number(idx), entry as PalletMapping);
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

                await tx.run(INSERT.into('midnight.Transactions').entries({
                    ID: txId,
                    transactionId: i,
                    hash: this.hashExtrinsic(extrinsicHex),
                    protocolVersion,
                    raw: extrinsicHex,
                    transactionType: classification.isSystem ? 'SYSTEM' : 'REGULAR',
                    txType: classification.txType,
                    isShielded: classification.isShielded,
                    block_ID: blockId
                }));

                txCount++;

                // Track contract actions from extrinsic classification
                if (classification.txType === 'contract_deploy' ||
                    classification.txType === 'contract_call' ||
                    classification.txType === 'contract_update') {
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

    private classifyExtrinsic(hex: string): {
        txType: string;
        isShielded: boolean;
        isSystem: boolean;
    } {
        if (!hex || hex.length < 10) {
            return { txType: 'system', isShielded: false, isSystem: true };
        }

        // Parse SCALE-encoded extrinsic to extract pallet + call index
        const indices = parseExtrinsicCallIndices(hex);
        if (indices) {
            return this.mapPalletCall(indices.palletIndex, indices.callIndex);
        }

        // Fallback: length-based heuristic when parsing fails
        if (hex.length < 100) {
            return { txType: 'system', isShielded: false, isSystem: true };
        }
        return { txType: 'unknown', isShielded: false, isSystem: false };
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
