/**
 * BlockProcessor: parses and persists Midnight blocks.
 * Parse header, classify transactions, extract inputs/outputs/contract
 * actions, write to DB.
 */

import cds from '@sap/cds';
import { blake2b } from '@noble/hashes/blake2';
import { bytesToHex } from '@noble/hashes/utils';
import { TypeRegistry } from '@polkadot/types/create';
import { Metadata } from '@polkadot/types/metadata';
import { MidnightNodeProvider, SignedBlock } from '../providers/MidnightNodeProvider';
import { ensureNightgateModelLoaded } from '../utils/cds-model';
import { getNightgatePluginConfig } from '../utils/nightgate-config';
import { parseExtrinsicCallIndices, parseExtrinsicParticipantInfo } from '../utils/scale';
import { reconcilePendingSubmission } from '../submission/TransactionSubmitter';
import {
    Blocks, Transactions, TransactionResults, TransactionFees, ContractActions,
    UnshieldedUtxos, NightBalances, SyncState
} from '#cds-models/midnight';

const { SELECT, INSERT, UPDATE } = cds.ql;
const log = cds.log('nightgate:crawler');

interface ExtrinsicClassification {
    txType: string;
    isShielded: boolean;
    isSystem: boolean;
    palletIndex?: number;
    callIndex?: number;
}

/** Pallet index → name + transaction type, for classifying extrinsics. */
export interface PalletMapping {
    name: string;
    txType: string;
    isShielded?: boolean;
    isSystem?: boolean;
}

/** Valid TxType values matching the schema enum in db/schema.cds */
const VALID_TX_TYPES = new Set([
    'night_transfer', 'shielded_transfer', 'contract_deploy', 'contract_call',
    'contract_update', 'dust_registration', 'dust_generation', 'governance',
    'system', 'unknown'
]);

/**
 * Midnight runtime pallet index → classification.
 *
 * HARDCODED from runtime metadata (specName 'midnight', specVersion 1000000;
 * read from preprod via state_getMetadata 2026-07-22). Pallet indices are fixed
 * by `construct_runtime!` and identical across nodes of the same runtime
 * version, NOT a per-deployment choice. They CAN shift on a Midnight RUNTIME
 * UPGRADE: re-verify against chain metadata when Midnight bumps its runtime. The
 * `cds.requires.nightgate.palletMap` override is a hotfix escape hatch.
 *
 * NOTE: Midnight wraps ALL user operations (contract deploy/call, shielded
 * transfer, unshield, NIGHT transfer) in ONE call, `Midnight.send_mn_transaction`
 * (pallet 5, call 0). The operation type lives in the ledger payload, not the
 * pallet/call index, so it can't be distinguished here; pallet 5 is bucketed as
 * `contract_call`. Finer classification needs decoding the ledger tx payload.
 */
const DEFAULT_PALLET_MAP: Record<number, PalletMapping> = {
    0:  { name: 'System', txType: 'system', isSystem: true },
    1:  { name: 'Timestamp', txType: 'system', isSystem: true },
    2:  { name: 'Aura', txType: 'system', isSystem: true },
    3:  { name: 'Grandpa', txType: 'system', isSystem: true },
    4:  { name: 'Sidechain', txType: 'system', isSystem: true },
    5:  { name: 'Midnight', txType: 'contract_call' }, // send_mn_transaction: all ledger txs
    6:  { name: 'MidnightSystem', txType: 'system', isSystem: true },
    8:  { name: 'SessionCommitteeManagement', txType: 'system', isSystem: true },
    11: { name: 'NodeVersion', txType: 'system', isSystem: true },
    13: { name: 'CNightObservation', txType: 'system', isSystem: true }, // per-block inherent
    15: { name: 'Preimage', txType: 'system', isSystem: true },
    16: { name: 'MultiBlockMigrations', txType: 'system', isSystem: true },
    17: { name: 'PalletSession', txType: 'system', isSystem: true },
    18: { name: 'Scheduler', txType: 'system', isSystem: true },
    19: { name: 'TxPause', txType: 'system', isSystem: true },
    21: { name: 'Beefy', txType: 'system', isSystem: true },
    22: { name: 'Mmr', txType: 'system', isSystem: true },
    23: { name: 'BeefyMmrLeaf', txType: 'system', isSystem: true },
    30: { name: 'Session', txType: 'system', isSystem: true },
    32: { name: 'Bridge', txType: 'night_transfer' }, // handle_transfers: cross-chain NIGHT
    40: { name: 'Council', txType: 'governance' },
    41: { name: 'CouncilMembership', txType: 'governance' },
    42: { name: 'TechnicalCommittee', txType: 'governance' },
    43: { name: 'TechnicalCommitteeMembership', txType: 'governance' },
    44: { name: 'FederatedAuthority', txType: 'governance' },
    45: { name: 'FederatedAuthorityObservation', txType: 'system', isSystem: true }, // per-block inherent
    50: { name: 'SystemParameters', txType: 'system', isSystem: true },
    51: { name: 'Throttle', txType: 'system', isSystem: true }
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
                log.warn(`palletMap[${idx}] has invalid txType "${mapping.txType}", falling back to "unknown"`);
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
 * Per-block data fetched from the node, ready to persist. Produced by
 * `fetchBlockBatch`, consumed by `persistBlockData`. Decoupling fetch from
 * persist lets the crawler pipeline RPC fetches in parallel while writing to
 * SQLite serially.
 *
 * Discriminated union on `alreadyIndexed`: a DB short-circuit omits the heavy
 * RPC fields; a full fetch has them all.
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
    extrinsicOutcomes: Map<number, 'SUCCESS' | 'FAILURE'>;
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
    /** Last successfully fetched specVersion. Fallback ONLY when the
     *  runtime-version RPC fails; never used to skip the query (runtime
     *  upgrades would otherwise persist blocks with a stale version). */
    private cachedSpecVersion: number = 0;
    private eventRegistries = new Map<number, TypeRegistry>();

    /** Well-known Substrate storage key for Timestamp::Now (twox128("Timestamp") + twox128("Now")) */
    private static readonly TIMESTAMP_STORAGE_KEY =
        '0xf0c365c3cf59d671eb72da0e7a4113c4e2c375c859d5adb749f1454ac11356be';
    /** System::Events = twox128("System") + twox128("Events"). */
    private static readonly SYSTEM_EVENTS_STORAGE_KEY =
        '0x26aa394eea5630e07c48ae0c9558cef780d41e5e16056765bc8461851072c9d7';

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
     * Process a single block by hash, fetch, parse, and persist atomically.
     * Hash-addressed on-demand processing is NOT height-sequenced, so a
     * missing parent falls back to `parent_ID = null` instead of failing.
     */
    async processBlockByHash(blockHash: string): Promise<ProcessResult> {
        const start = Date.now();
        return this.processFromNode(blockHash, start, { requireParent: false });
    }

    /**
     * Process a block by height. Height-sequenced path (live crawler): a
     * missing parent means an index gap and must fail loudly instead of
     * silently persisting an orphan row.
     */
    async processBlockByHeight(height: number): Promise<ProcessResult> {
        const hash = await this.nodeProvider.getBlockHash(height);
        if (!hash) throw new Error(`No block at height ${height}`);
        return this.processFromNode(hash, Date.now(), { requireParent: true });
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

        // Round 2: block + timestamp + System.Events for every new hash.
        let blockResults: SignedBlock[] = [];
        let tsResults: (string | null)[] = [];
        let eventResults: (string | null)[] = [];
        if (newIndices.length > 0) {
            const requests: Array<{ method: string; params: unknown[] }> = [];
            for (const i of newIndices) {
                requests.push({ method: 'chain_getBlock', params: [hashes[i]] });
                requests.push({ method: 'state_getStorage', params: [BlockProcessor.TIMESTAMP_STORAGE_KEY, hashes[i]] });
                requests.push({ method: 'state_getStorage', params: [BlockProcessor.SYSTEM_EVENTS_STORAGE_KEY, hashes[i]] });
            }
            const flat = await this.nodeProvider.rpcBatch(requests);
            blockResults = newIndices.map((_, k) => flat[k * 3]);
            tsResults = newIndices.map((_, k) => flat[k * 3 + 1]);
            eventResults = newIndices.map((_, k) => flat[k * 3 + 2]);
        }

        // ProtocolVersion is queried once per batch (first hash) so runtime
        // upgrades land at batch granularity: one extra RPC per batch, and an
        // upgrade mid-batch is reflected from the next batch onward.
        const protocolVersion = heights.length > 0 && hashes[0]
            ? await this.getProtocolVersion(hashes[0])
            : this.cachedSpecVersion;
        const eventRegistry = newIndices.length > 0 && hashes[0]
            ? await this.getEventRegistry(hashes[0], protocolVersion)
            : undefined;

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

            if (!signedBlock?.block) {
                throw new Error(`No block body returned for height ${heights[i]} (pruned or racing node)`);
            }
            const timestamp = this.parseTimestampHex(tsResults[newIdx]);
            const extrinsicOutcomes = this.decodeExtrinsicOutcomes(eventResults[newIdx], eventRegistry);
            newIdx++;
            out[i] = {
                blockHash,
                height: heights[i],
                signedBlock,
                protocolVersion,
                timestamp,
                extrinsicOutcomes,
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
        // Catch-up pipeline persists in strict height order: a missing parent
        // means an index gap and must fail loudly.
        return this.persistFromNode(prep, start, { requireParent: true });
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

    private async processFromNode(
        blockHash: string,
        start: number,
        opts?: { requireParent?: boolean }
    ): Promise<ProcessResult> {
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
        const [signedBlock, timestamp, protocolVersion, rawEvents] = await Promise.all([
            this.nodeProvider.getBlock(blockHash),
            this.getBlockTimestamp(blockHash),
            this.getProtocolVersion(blockHash),
            this.nodeProvider.getStorage(BlockProcessor.SYSTEM_EVENTS_STORAGE_KEY, blockHash)
        ]);
        if (!signedBlock?.block) {
            throw new Error(`No block body returned for ${blockHash} (pruned or racing node)`);
        }
        const header = signedBlock.block.header;
        const height = MidnightNodeProvider.parseBlockNumber(header.number);
        const eventRegistry = await this.getEventRegistry(blockHash, protocolVersion);

        return this.persistFromNode({
            blockHash,
            height,
            signedBlock,
            protocolVersion,
            timestamp,
            extrinsicOutcomes: this.decodeExtrinsicOutcomes(rawEvents, eventRegistry),
            fetchStartedAt: start,
            alreadyIndexed: false
        }, start, opts);
    }

    private async persistFromNode(
        prep: PreparedBlockFetched,
        start: number,
        opts?: { requireParent?: boolean }
    ): Promise<ProcessResult> {
        const { blockHash, height, signedBlock, protocolVersion, timestamp, extrinsicOutcomes } = prep;
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

            if (opts?.requireParent && height > 0 && !parentBlock) {
                throw new Error(
                    `Parent block ${header.parentHash} of block ${height} is not indexed; ` +
                    'refusing to persist an orphan (index gap)'
                );
            }

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

            // 2. Parse extrinsics into rows for bulk insert
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

                const outcome = extrinsicOutcomes.get(i);
                if (outcome) {
                    txResultRows.push({
                        ID: cds.utils.uuid(),
                        status: outcome,
                        outcomeSource: 'substrate-system-events',
                        transaction_ID: txId
                    });
                }

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

            // Cold path
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
                // Decimal(20,0) columns carrying u128 amounts as strings, see INSERT above.
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
     * blake2b-256 of the raw SCALE-encoded extrinsic bytes: the canonical
     * extrinsic hash matching block explorers and other indexers.
     */
    private hashExtrinsic(hex: string): string {
        const cleanHex = hex.startsWith('0x') ? hex.slice(2) : hex;
        const bytes = Buffer.from(cleanHex, 'hex');
        const hash = blake2b(bytes, { dkLen: 32 });
        return '0x' + bytesToHex(hash);
    }

    private async getEventRegistry(blockHash: string, specVersion: number): Promise<TypeRegistry | undefined> {
        if (!specVersion) return undefined;
        const cached = this.eventRegistries.get(specVersion);
        if (cached) return cached;
        try {
            const metadataHex = await this.nodeProvider.getMetadata(blockHash);
            const registry = new TypeRegistry();
            registry.setMetadata(new Metadata(registry, metadataHex as `0x${string}`));
            this.eventRegistries.set(specVersion, registry);
            return registry;
        } catch (err) {
            log.warn(`Failed to load runtime metadata for System.Events at ${blockHash}: ${(err as Error).message}`);
            return undefined;
        }
    }

    /** Decode only the canonical System outcome event for each extrinsic. */
    private decodeExtrinsicOutcomes(
        rawEvents: string | null | undefined,
        registry: TypeRegistry | undefined
    ): Map<number, 'SUCCESS' | 'FAILURE'> {
        const outcomes = new Map<number, 'SUCCESS' | 'FAILURE'>();
        if (!rawEvents || !registry) return outcomes;
        try {
            const records: any = registry.createType('Vec<EventRecord>', rawEvents);
            for (const record of records as any) {
                if (!record.phase?.isApplyExtrinsic) continue;
                const index = record.phase.asApplyExtrinsic.toNumber();
                const section = String(record.event?.section ?? '').toLowerCase();
                const method = String(record.event?.method ?? '');
                if (section !== 'system') continue;
                if (method === 'ExtrinsicFailed') outcomes.set(index, 'FAILURE');
                else if (method === 'ExtrinsicSuccess' && outcomes.get(index) !== 'FAILURE') outcomes.set(index, 'SUCCESS');
            }
        } catch (err) {
            log.warn(`Failed to decode System.Events; transaction outcomes remain unknown: ${(err as Error).message}`);
        }
        return outcomes;
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
            log.warn(`Failed to read on-chain timestamp for ${blockHash}: ${(err as Error).message}`);
        }
        return Math.floor(Date.now() / 1000);
    }

    /**
     * Get the runtime specVersion at a specific block. Always queried per
     * block/batch so runtime upgrades are reflected; the cached value is only
     * a fallback when the RPC itself fails.
     */
    private async getProtocolVersion(blockHash: string): Promise<number> {
        try {
            const rv = await this.nodeProvider.getRuntimeVersion(blockHash);
            this.cachedSpecVersion = rv.specVersion;
            return rv.specVersion;
        } catch (err) {
            log.warn(`Failed to get runtime version for ${blockHash}: ${(err as Error).message}`);
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
