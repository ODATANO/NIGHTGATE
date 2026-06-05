/**
 * BlockProcessor, Parses and persists Midnight blocks
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
import { getNightgatePluginConfig } from '../utils/nightgate-config';
import { parseExtrinsicCallIndices, parseExtrinsicParticipantInfo } from '../utils/scale';
import { reconcilePendingSubmission } from '../submission/TransactionSubmitter';
import {
    Blocks, Transactions, TransactionResults, TransactionFees, ContractActions,
    UnshieldedUtxos, NightBalances, SyncState
} from '#cds-models/midnight';

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
    // Midnight-specific pallets, configure actual indices via cds.requires.nightgate.palletMap:
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
    const nightgateConfig = getNightgatePluginConfig();
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

/**
 * Per-block data fetched from the node, ready to be persisted. Produced by
 * `fetchBlockData`, consumed by `persistBlockData`. Decoupling fetch from
 * persist lets the crawler pipeline RPC fetches in parallel while writing
 * to SQLite serially.
 *
 * Modeled as a discriminated union on `alreadyIndexed`: when we short-circuit
 * because the block exists in the DB, the heavy RPC fields are absent; when
 * we fetched fully, they are all present. This replaces the earlier
 * `signedBlock: null as any` placeholder which bypassed type checking.
 */
export type PreparedBlock = PreparedBlockSkipped | PreparedBlockFetched;

export interface PreparedBlockSkipped {
    blockHash: string;
    height: number;
    fetchStartedAt: number;
    alreadyIndexed: true;
}

export interface PreparedBlockFetched {
    blockHash: string;
    height: number;
    signedBlock: SignedBlock;
    protocolVersion: number;
    timestamp: number;
    fetchStartedAt: number;
    /** Set when all RPCs for this block have resolved. Used for fetch-vs-persist timing diagnostics. */
    fetchCompletedAt?: number;
    alreadyIndexed: false;
}

// ============================================================================
// Block Processor
// ============================================================================

export class BlockProcessor {
    private db!: cds.DatabaseService;
    private palletMap: Map<number, PalletMapping>;
    private cachedSpecVersion: number = 0;
    private cachedSpecVersionValid: boolean = false;

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
     * Process a single block by hash, fetch, parse, and persist atomically
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
     * Fetch all data for a block in parallel without writing to the DB.
     * Used by the parallel catch-up pipeline so multiple block fetches can
     * be in flight while writes to SQLite happen serially in height order.
     */
    async fetchBlockData(height: number): Promise<PreparedBlock> {
        const fetchStartedAt = Date.now();
        const blockHash = await this.nodeProvider.getBlockHash(height);
        if (!blockHash) throw new Error(`No block at height ${height}`);

        if (await this.blockExists(blockHash)) {
            return {
                blockHash,
                height,
                fetchStartedAt,
                alreadyIndexed: true
            };
        }

        // Three independent RPCs over the same WSS connection. The provider
        // multiplexes by request id, so these resolve in parallel.
        const [signedBlock, timestamp, protocolVersion] = await Promise.all([
            this.nodeProvider.getBlock(blockHash),
            this.getBlockTimestamp(blockHash),
            this.getProtocolVersion(blockHash)
        ]);

        return {
            blockHash,
            height,
            signedBlock,
            protocolVersion,
            timestamp,
            fetchStartedAt,
            fetchCompletedAt: Date.now(),
            alreadyIndexed: false
        };
    }

    /**
     * Fetch a contiguous range of blocks in two JSON-RPC batches.
     *
     * Round 1: `chain_getBlockHash(h)` for every height → 1 WSS round-trip
     * Round 2: for every NEW hash, `chain_getBlock(h)` + `state_getStorage(timestamp_key, h)`
     *           together in one batch frame → 1 WSS round-trip
     */
    async fetchBlockBatch(heights: number[]): Promise<PreparedBlock[]> {
        if (heights.length === 0) return [];
        const fetchStartedAt = Date.now();

        // Round 1: heights → hashes, one batched RPC frame.
        const hashes = await this.nodeProvider.rpcBatch(
            heights.map(h => ({ method: 'chain_getBlockHash', params: [h] }))
        ) as string[];

        // Bulk SELECT: which of these hashes are already in the DB
        const truthyHashes = hashes.filter((h): h is string => !!h);
        const existing: Array<{ hash: string }> = truthyHashes.length
            ? (await this.db.run(
                SELECT.from(Blocks).columns('hash').where({ hash: { in: truthyHashes } })
            ) || [])
            : [];
        const existingSet = new Set(existing.map(r => r.hash));

        // collect the indices of NEW blocks we still need to fetch.
        const newIndices: number[] = [];
        for (let i = 0; i < heights.length; i++) {
            if (hashes[i] && !existingSet.has(hashes[i])) newIndices.push(i);
        }

        // Round 2: getBlock + getStorage(timestamp) for every new hash, one batch.
        // Order: [block0, ts0, block1, ts1, ...] so we can de-interleave by index.
        let blockResults: SignedBlock[] = [];
        let tsResults: (string | null)[] = [];
        if (newIndices.length > 0) {
            const requests: Array<{ method: string; params: unknown[] }> = [];
            for (const i of newIndices) {
                requests.push({ method: 'chain_getBlock', params: [hashes[i]] });
                requests.push({ method: 'state_getStorage', params: [BlockProcessor.TIMESTAMP_STORAGE_KEY, hashes[i]] });
            }
            const flat = await this.nodeProvider.rpcBatch(requests);
            blockResults = newIndices.map((_, k) => flat[k * 2]);
            tsResults = newIndices.map((_, k) => flat[k * 2 + 1]);
        }

        // ProtocolVersion is cached after the first hit, so this is a no-op
        // RPC for the second batch onward. Calling it on the first hash of
        // the batch is enough to warm the cache.
        const protocolVersion = heights.length > 0 && hashes[0]
            ? await this.getProtocolVersion(hashes[0])
            : this.cachedSpecVersion;

        const fetchCompletedAt = Date.now();

        // Assemble PreparedBlock[] in the same order as input heights.
        const out: PreparedBlock[] = new Array(heights.length);
        let newIdx = 0;
        for (let i = 0; i < heights.length; i++) {
            const blockHash = hashes[i];
            if (!blockHash) {
                throw new Error(`No block at height ${heights[i]}`);
            }
            if (existingSet.has(blockHash)) {
                out[i] = {
                    blockHash,
                    height: heights[i],
                    fetchStartedAt,
                    alreadyIndexed: true
                };
                continue;
            }
            const signedBlock = blockResults[newIdx];
            const timestamp = this.parseTimestampHex(tsResults[newIdx]);
            newIdx++;
            out[i] = {
                blockHash,
                height: heights[i],
                signedBlock,
                protocolVersion,
                timestamp,
                fetchStartedAt,
                fetchCompletedAt,
                alreadyIndexed: false
            };
        }
        return out;
    }

    private parseTimestampHex(hex: string | null | undefined): number {
        if (!hex) return Math.floor(Date.now() / 1000);
        const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
        try {
            return Number(Buffer.from(clean, 'hex').readBigUInt64LE(0) / 1000n);
        } catch {
            return Math.floor(Date.now() / 1000);
        }
    }

    /**
     * Persist a prefetched block. Mirror of the persist phase in
     * `processFromNode`, but skips all RPC calls.
     */
    async persistPreparedBlock(prep: PreparedBlock): Promise<ProcessResult> {
        const start = prep.fetchStartedAt;
        if (prep.alreadyIndexed) {
            return {
                blockHeight: prep.height,
                blockHash: prep.blockHash,
                transactionCount: 0,
                contractActionCount: 0,
                processingTimeMs: Date.now() - start
            };
        }
        return this.persistFromNode(prep, start);
    }

    /**
     * Check if a block already exists in the local DB
     */
    async blockExists(hash: string): Promise<boolean> {
        const existing = await this.db.run(
            SELECT.one.from(Blocks).columns('ID').where({ hash })
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

        // Parallelize the three independent RPC fetches over the same WSS.
        const [signedBlock, timestamp, protocolVersion] = await Promise.all([
            this.nodeProvider.getBlock(blockHash),
            this.getBlockTimestamp(blockHash),
            this.getProtocolVersion(blockHash)
        ]);
        const header = signedBlock.block.header;
        const height = MidnightNodeProvider.parseBlockNumber(header.number);

        return this.persistFromNode({
            blockHash,
            height,
            signedBlock,
            protocolVersion,
            timestamp,
            fetchStartedAt: start,
            alreadyIndexed: false
        }, start);
    }

    private async persistFromNode(prep: PreparedBlockFetched, start: number): Promise<ProcessResult> {
        const { blockHash, height, signedBlock, protocolVersion, timestamp } = prep;
        const header = signedBlock.block.header;
        const extrinsics = signedBlock.block.extrinsics;

        let txCount = 0;
        let actionCount = 0;

        // Atomic DB write
        await this.db.tx(async (tx: any) => {
            // 1. Insert block
            const blockId = cds.utils.uuid();
            const parentBlock = await tx.run(
                SELECT.one.from(Blocks).columns('ID').where({ hash: header.parentHash })
            );

            await tx.run(INSERT.into(Blocks).entries({
                ID: blockId,
                hash: blockHash,
                height: height,
                protocolVersion,
                timestamp,
                author: this.extractAuthor(header.digest?.logs),
                ledgerParameters: header.stateRoot,
                parent_ID: parentBlock?.ID || null
            }));

            // 2. Parse extrinsics into rows for bulk insert.
            // Each extrinsic produced 4-6 individual `tx.run(INSERT…)` calls
            // before; batching cuts that to one INSERT per table regardless of
            // tx count. CAP rewrites array-entries INSERTs into a single
            // SQLite VALUES(...) statement, which collapses prepare/run overhead.
            const txRows: Record<string, unknown>[] = [];
            const txResultRows: Record<string, unknown>[] = [];
            const txFeeRows: Record<string, unknown>[] = [];
            const contractActionRows: Record<string, unknown>[] = [];
            const pendingReconciles: Array<{ hash: string; ctx: Record<string, unknown> }> = [];
            const transferProjections: Array<{
                txId: string; txHash: string; blockHeight: number; blockTimestamp: number;
                senderAddress: string | null; receiverAddress: string; amount: string; outputIndex: number;
            }> = [];

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

                txRows.push({
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
                });

                txResultRows.push({
                    ID: cds.utils.uuid(),
                    status: 'SUCCESS',
                    transaction_ID: txId
                });

                txFeeRows.push({
                    ID: cds.utils.uuid(),
                    paidFees: '0',
                    estimatedFees: '0',
                    transaction_ID: txId
                });

                pendingReconciles.push({
                    hash: extrinsicHash,
                    ctx: {
                        txId, transactionId: i, txType: classification.txType,
                        contractAddress, circuitName, blockId, blockHeight: height, timestamp
                    }
                });

                if (isTransferLike && receiverAddress && nightAmount) {
                    transferProjections.push({
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

                if (contractActionType && contractAddress) {
                    contractActionRows.push({
                        ID: cds.utils.uuid(),
                        address: contractAddress,
                        actionType: contractActionType,
                        entryPoint: circuitName,
                        state: extrinsicHex,
                        transaction_ID: txId
                    });
                    actionCount++;
                }

                txCount++;
            }

            // Bulk inserts: one statement per table regardless of tx count.
            if (txRows.length) await tx.run(INSERT.into(Transactions).entries(txRows));
            if (txResultRows.length) await tx.run(INSERT.into(TransactionResults).entries(txResultRows));
            if (txFeeRows.length) await tx.run(INSERT.into(TransactionFees).entries(txFeeRows));
            if (contractActionRows.length) await tx.run(INSERT.into(ContractActions).entries(contractActionRows));

            // Cold path: PendingSubmissions updates + balance projections.
            // No-op for most blocks. Kept sequential because the balance
            // upsert is read-modify-write and order-dependent within a block.
            for (const r of pendingReconciles) {
                await reconcilePendingSubmission(tx, r.hash, r.ctx);
            }
            for (const tp of transferProjections) {
                await this.persistTransferProjections(tx, tp);
            }

            // 3. Update SyncState
            await tx.run(
                UPDATE.entity(SyncState).set({
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

        await tx.run(INSERT.into(UnshieldedUtxos).entries({
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
                .from(NightBalances)
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
            // balance/totalSent/totalReceived are Decimal(20,0) columns holding
            // u128 amounts as strings to avoid JS number precision loss. The
            // cds-models generator types Decimal as `number`, so cast the string
            // values; the DB layer accepts the string at runtime.
            await tx.run(INSERT.into(NightBalances).entries({
                address: params.address,
                balance: initialBalance.toString() as any,
                utxoCount: Math.max(params.utxoCountDelta, 0),
                firstSeenHeight: params.blockHeight,
                firstSeenAt: nowIso,
                lastActivityHeight: params.blockHeight,
                lastActivityAt: nowIso,
                txSentCount: Math.max(params.txSentDelta, 0),
                txReceivedCount: Math.max(params.txReceivedDelta, 0),
                totalSent: params.sentAmountDelta.toString() as any,
                totalReceived: params.receivedAmountDelta.toString() as any,
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
            UPDATE.entity(NightBalances).set({
                // Decimal(20,0) columns carrying u128 amounts as strings — see INSERT above.
                balance: nextBalance.toString() as any,
                utxoCount: nextUtxoCount,
                txSentCount: currentSentCount + params.txSentDelta,
                txReceivedCount: currentReceivedCount + params.txReceivedDelta,
                totalSent: (currentTotalSent + params.sentAmountDelta).toString() as any,
                totalReceived: (currentTotalReceived + params.receivedAmountDelta).toString() as any,
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
     * Get the runtime specVersion at a specific block
     */
    private async getProtocolVersion(blockHash: string): Promise<number> {
        if (this.cachedSpecVersionValid) {
            return this.cachedSpecVersion;
        }
        try {
            const rv = await this.nodeProvider.getRuntimeVersion(blockHash);
            this.cachedSpecVersion = rv.specVersion;
            this.cachedSpecVersionValid = true;
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
