/** Parses Midnight blocks (header, extrinsic classification, outcomes) and persists them. */

import cds from '@sap/cds';
import { blake2b } from '@noble/hashes/blake2';
import { bytesToHex } from '@noble/hashes/utils';
import { TypeRegistry } from '@polkadot/types/create';
import { Metadata } from '@polkadot/types/metadata';
import { MidnightNodeProvider, SignedBlock } from '../providers/MidnightNodeProvider';
import { ensureNightgateModelLoaded } from '../utils/cds-model';
import { getNightgatePluginConfig } from '../utils/nightgate-config';
import { parseExtrinsicCallIndices, parseExtrinsicCall, decodeCompactBigInt } from '../utils/scale';
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

/** Default pallet index -> classification; runtime metadata re-maps these by pallet name. */
const DEFAULT_PALLET_MAP: Record<number, PalletMapping> = {
    0: { name: 'System', txType: 'system', isSystem: true },
    1: { name: 'Timestamp', txType: 'system', isSystem: true },
    2: { name: 'Aura', txType: 'system', isSystem: true },
    3: { name: 'Grandpa', txType: 'system', isSystem: true },
    4: { name: 'Sidechain', txType: 'system', isSystem: true },
    5: { name: 'Midnight', txType: 'contract_call' }, // send_mn_transaction: all ledger txs
    6: { name: 'MidnightSystem', txType: 'system', isSystem: true },
    8: { name: 'SessionCommitteeManagement', txType: 'system', isSystem: true },
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

function hexToBinaryValue(hex: string): string {
    return Buffer.from(hex.startsWith('0x') ? hex.slice(2) : hex, 'hex').toString('base64');
}

/** `cds.requires.nightgate.palletMap`: index-keyed overrides on top of defaults or runtime metadata. */
function configPalletOverrides(): Map<number, PalletMapping> {
    const map = new Map<number, PalletMapping>();
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

function buildPalletMap(): Map<number, PalletMapping> {
    const map = new Map<number, PalletMapping>();
    for (const [idx, entry] of Object.entries(DEFAULT_PALLET_MAP)) {
        map.set(Number(idx), entry);
    }
    for (const [idx, entry] of configPalletOverrides()) map.set(idx, entry);
    return map;
}

/** Pallet map from runtime metadata: default mappings matched by name, then the overrides. */
export function resolvePalletMapFromMetadata(
    pallets: Array<{ name: unknown; index: unknown }>,
    overrides: Map<number, PalletMapping> = new Map()
): { map: Map<number, PalletMapping>; moved: string[]; unmapped: string[] } {
    const byName = new Map<string, PalletMapping>();
    for (const entry of Object.values(DEFAULT_PALLET_MAP)) byName.set(entry.name, entry);
    const map = new Map<number, PalletMapping>();
    const moved: string[] = [];
    const unmapped: string[] = [];
    for (const p of pallets) {
        const name = String((p.name as any)?.toString?.() ?? p.name);
        const index = Number((p.index as any)?.toNumber?.() ?? p.index);
        if (!Number.isInteger(index)) continue;
        const mapping = byName.get(name);
        if (!mapping) { unmapped.push(`${name}@${index}`); continue; }
        map.set(index, mapping);
        if (DEFAULT_PALLET_MAP[index]?.name !== name) moved.push(`${name}@${index}`);
    }
    for (const [idx, entry] of overrides) map.set(idx, entry);
    return { map, moved, unmapped };
}

export interface ProcessResult {
    blockHeight: number;
    blockHash: string;
    transactionCount: number;
    contractActionCount: number;
    processingTimeMs: number;
}

/** What one runtime version decodes with: its event registry and its pallet map, cached together per specVersion. */
interface RuntimeContext {
    registry: TypeRegistry;
    palletMap: Map<number, PalletMapping>;
}

/** Per-block node data from `fetchBlockBatch`, ready for `persistPreparedBlock`. */
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
    palletMap: Map<number, PalletMapping>;
    timestamp: number;
    extrinsicOutcomes: Map<number, 'SUCCESS' | 'FAILURE'>;
    fetchStartedAt: number;
    fetchCompletedAt?: number;
    alreadyIndexed: false;
}

export class BlockProcessor {
    private db!: cds.DatabaseService;
    /** Pallet map without runtime metadata (defaults + config overrides); the metadata-derived map per specVersion lives in `runtimes`. */
    private readonly defaultPalletMap: Map<number, PalletMapping>;
    /** Event registry + pallet map per runtime specVersion, loaded once from the node's metadata. */
    private readonly runtimes = new Map<number, RuntimeContext>();
    private readonly palletOverrides = configPalletOverrides();

    /** Well-known Substrate storage key for Timestamp::Now (twox128("Timestamp") + twox128("Now")) */
    private static readonly TIMESTAMP_STORAGE_KEY =
        '0xf0c365c3cf59d671eb72da0e7a4113c4e2c375c859d5adb749f1454ac11356be';
    /** System::Events = twox128("System") + twox128("Events"). */
    private static readonly SYSTEM_EVENTS_STORAGE_KEY =
        '0x26aa394eea5630e07c48ae0c9558cef780d41e5e16056765bc8461851072c9d7';

    constructor(
        private nodeProvider: MidnightNodeProvider
    ) {
        this.defaultPalletMap = buildPalletMap();
    }

    /** The pallet map of a runtime version: from its metadata when loaded, else the defaults. */
    private palletMapFor(specVersion: number): Map<number, PalletMapping> {
        return this.runtimes.get(specVersion)?.palletMap ?? this.defaultPalletMap;
    }

    async init(): Promise<void> {
        await ensureNightgateModelLoaded();
        this.db = await cds.connect.to('db');
    }

    /** Not height-sequenced: a missing parent persists `parent_ID = null` instead of failing. */
    async processBlockByHash(blockHash: string): Promise<ProcessResult> {
        const start = Date.now();
        return this.processFromNode(blockHash, start, { requireParent: false });
    }

    /** Height-sequenced: a missing parent is an index gap and fails instead of persisting an orphan. */
    async processBlockByHeight(height: number): Promise<ProcessResult> {
        const hash = await this.nodeProvider.getBlockHash(height);
        if (!hash) throw new Error(`No block at height ${height}`);
        return this.processFromNode(hash, Date.now(), { requireParent: true });
    }

    /**
     * Fetches a height range in two batch frames: all hashes, then block,
     * timestamp, System.Events and runtime version for every hash not yet indexed.
     */
    async fetchBlockBatch(heights: number[]): Promise<PreparedBlock[]> {
        if (heights.length === 0) return [];
        const fetchStartedAt = Date.now();

        const hashes = await this.nodeProvider.rpcBatch(
            heights.map(h => ({ method: 'chain_getBlockHash', params: [h] }))
        ) as string[];

        const truthyHashes = hashes.filter((h): h is string => !!h);
        const existing: Array<{ hash: string }> = truthyHashes.length
            ? (await this.db.run(
                SELECT.from(Blocks).columns('hash').where({ hash: { in: truthyHashes } })
            ) || [])
            : [];
        const existingSet = new Set(existing.map(r => r.hash));

        const newIndices: number[] = [];
        for (let i = 0; i < heights.length; i++) {
            if (hashes[i] && !existingSet.has(hashes[i])) newIndices.push(i);
        }

        let blockResults: SignedBlock[] = [];
        let tsResults: (string | null)[] = [];
        let eventResults: (string | null)[] = [];
        let versionResults: Array<{ specVersion?: number } | null> = [];
        if (newIndices.length > 0) {
            const requests: Array<{ method: string; params: unknown[] }> = [];
            for (const i of newIndices) {
                requests.push({ method: 'chain_getBlock', params: [hashes[i]] });
                requests.push({ method: 'state_getStorage', params: [BlockProcessor.TIMESTAMP_STORAGE_KEY, hashes[i]] });
                requests.push({ method: 'state_getStorage', params: [BlockProcessor.SYSTEM_EVENTS_STORAGE_KEY, hashes[i]] });
                requests.push({ method: 'state_getRuntimeVersion', params: [hashes[i]] });
            }
            const flat = await this.nodeProvider.rpcBatch(requests);
            blockResults = newIndices.map((_, k) => flat[k * 4]);
            tsResults = newIndices.map((_, k) => flat[k * 4 + 1]);
            eventResults = newIndices.map((_, k) => flat[k * 4 + 2]);
            versionResults = newIndices.map((_, k) => flat[k * 4 + 3]);
        }

        const fetchCompletedAt = Date.now();

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
            const protocolVersion = this.specVersionFromBatch(versionResults[newIdx], `height ${heights[i]}`);
            const eventRegistry = await this.getEventRegistry(blockHash, protocolVersion);
            const palletMap = this.palletMapFor(protocolVersion);
            const timestamp = this.resolveTimestamp(tsResults[newIdx], signedBlock.block.extrinsics, `height ${heights[i]}`, palletMap);
            const extrinsicOutcomes = this.decodeExtrinsicOutcomes(eventResults[newIdx], eventRegistry, `height ${heights[i]}`, signedBlock.block.extrinsics?.length ?? 0);
            newIdx++;
            out[i] = {
                blockHash,
                height: heights[i],
                signedBlock,
                protocolVersion,
                palletMap,
                timestamp,
                extrinsicOutcomes,
                fetchStartedAt,
                fetchCompletedAt,
                alreadyIndexed: false
            };
        }
        return out;
    }

    /** Timestamp::Now storage (SCALE u64 LE milliseconds) as UNIX seconds, or null when absent/unparseable. */
    private parseTimestampHex(hex: string | null | undefined): number | null {
        if (!hex) return null;
        const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
        try {
            return Number(Buffer.from(clean, 'hex').readBigUInt64LE(0) / 1000n);
        } catch {
            return null;
        }
    }

    /** Timestamp::Now storage, else the `Timestamp.set` inherent at extrinsic 0 (survives state pruning). */
    private resolveTimestamp(storageHex: string | null | undefined, extrinsics: string[] | undefined, where: string, palletMap: Map<number, PalletMapping> = this.defaultPalletMap): number {
        const fromStorage = this.parseTimestampHex(storageHex);
        if (fromStorage != null) return fromStorage;
        const fromInherent = this.decodeTimestampInherent(extrinsics, palletMap);
        if (fromInherent != null) return fromInherent;
        throw new Error(`No timestamp for ${where}: Timestamp storage empty and no Timestamp.set inherent (pruned or racing node)`);
    }

    private decodeTimestampInherent(extrinsics: string[] | undefined, palletMap: Map<number, PalletMapping> = this.defaultPalletMap): number | null {
        const first = extrinsics?.[0];
        if (!first) return null;
        const call = parseExtrinsicCall(first);
        if (!call) return null;
        const pallet = palletMap.get(call.palletIndex);
        if (pallet?.name !== 'Timestamp' || call.callIndex !== 0) return null;
        const decoded = decodeCompactBigInt(call.buf, call.argsOffset);
        if (!decoded) return null;
        return Number(decoded[0] / 1000n);
    }

    /** Persists a block from `fetchBlockBatch` without further RPC calls. */
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
        // Catch-up persists in height order: a missing parent is an index gap.
        return this.persistFromNode(prep, start, { requireParent: true });
    }

    async blockExists(hash: string): Promise<boolean> {
        const existing = await this.db.run(
            SELECT.one.from(Blocks).columns('ID').where({ hash })
        );
        return !!existing;
    }

    private async processFromNode(
        blockHash: string,
        start: number,
        opts?: { requireParent?: boolean }
    ): Promise<ProcessResult> {
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

        const [signedBlock, timestampHex, protocolVersion, rawEvents] = await Promise.all([
            this.nodeProvider.getBlock(blockHash),
            this.getBlockTimestampHex(blockHash),
            this.getProtocolVersion(blockHash),
            this.nodeProvider.getStorage(BlockProcessor.SYSTEM_EVENTS_STORAGE_KEY, blockHash)
        ]);
        if (!signedBlock?.block) {
            throw new Error(`No block body returned for ${blockHash} (pruned or racing node)`);
        }
        const header = signedBlock.block.header;
        const height = MidnightNodeProvider.parseBlockNumber(header.number);
        const eventRegistry = await this.getEventRegistry(blockHash, protocolVersion);
        const palletMap = this.palletMapFor(protocolVersion);
        const timestamp = this.resolveTimestamp(timestampHex, signedBlock.block.extrinsics, `block ${blockHash}`, palletMap);

        return this.persistFromNode({
            blockHash,
            height,
            signedBlock,
            protocolVersion,
            palletMap,
            timestamp,
            extrinsicOutcomes: this.decodeExtrinsicOutcomes(rawEvents, eventRegistry, `block ${blockHash}`, signedBlock.block.extrinsics?.length ?? 0),
            fetchStartedAt: start,
            alreadyIndexed: false
        }, start, opts);
    }

    private async persistFromNode(
        prep: PreparedBlockFetched,
        start: number,
        opts?: { requireParent?: boolean }
    ): Promise<ProcessResult> {
        const { blockHash, height, signedBlock, protocolVersion, palletMap, timestamp, extrinsicOutcomes } = prep;
        const header = signedBlock.block.header;
        const extrinsics = signedBlock.block.extrinsics;

        let txCount = 0;
        let actionCount = 0;

        await this.db.tx(async (tx: any) => {
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

            const txRows: Record<string, unknown>[] = [];
            const txResultRows: Record<string, unknown>[] = [];
            const txFeeRows: Record<string, unknown>[] = [];
            const contractActionRows: Record<string, unknown>[] = [];

            for (let i = 0; i < extrinsics.length; i++) {
                const extrinsicHex = extrinsics[i];
                const txId = cds.utils.uuid();
                const classification = this.classifyExtrinsic(extrinsicHex, palletMap);
                const extrinsicHash = this.hashExtrinsic(extrinsicHex);
                const txSize = this.extrinsicSize(extrinsicHex);
                const circuitName = this.buildCircuitName(classification);
                const contractActionType = this.toContractActionType(classification.txType);
                const contractAddress: string | null = null;
                const senderAddress: string | null = null;
                const receiverAddress: string | null = null;
                const nightAmount: string | null = null;

                txRows.push({
                    ID: txId,
                    transactionId: i,
                    hash: extrinsicHash,
                    protocolVersion,
                    raw: hexToBinaryValue(extrinsicHex),
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

                if (contractActionType) {
                    contractActionRows.push({
                        ID: cds.utils.uuid(),
                        address: contractAddress,
                        actionType: contractActionType,
                        entryPoint: circuitName,
                        state: null,
                        transaction_ID: txId
                    });
                    actionCount++;
                }

                txCount++;
            }

            if (txRows.length) await tx.run(INSERT.into(Transactions).entries(txRows));
            if (txResultRows.length) await tx.run(INSERT.into(TransactionResults).entries(txResultRows));
            if (txFeeRows.length) await tx.run(INSERT.into(TransactionFees).entries(txFeeRows));
            if (contractActionRows.length) await tx.run(INSERT.into(ContractActions).entries(contractActionRows));

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

    /** Classify with the pallet map of the block's runtime; the default map only when none is given (tests). */
    private classifyExtrinsic(hex: string, palletMap: Map<number, PalletMapping> = this.defaultPalletMap): ExtrinsicClassification {
        if (!hex || hex.length < 10) {
            return { txType: 'system', isShielded: false, isSystem: true };
        }

        const indices = parseExtrinsicCallIndices(hex);
        if (indices) {
            return {
                ...this.mapPalletCall(indices.palletIndex, indices.callIndex, palletMap),
                palletIndex: indices.palletIndex,
                callIndex: indices.callIndex
            };
        }

        // Unparseable: length heuristic.
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

    private buildCircuitName(classification: ExtrinsicClassification): string | null {
        if (classification.palletIndex == null || classification.callIndex == null) {
            return null;
        }

        return `${classification.palletIndex}:${classification.callIndex}`;
    }

    private mapPalletCall(palletIndex: number, callIndex: number, palletMap: Map<number, PalletMapping> = this.defaultPalletMap): {
        txType: string;
        isShielded: boolean;
        isSystem: boolean;
    } {
        const entry = palletMap.get(palletIndex);
        if (!entry) {
            return { txType: 'unknown', isShielded: false, isSystem: false };
        }

        // A `Contracts`-named mapping (config override / tests) distinguishes
        // deploy vs call vs update by call_index.
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

    /** blake2b-256 of the raw extrinsic bytes: the canonical extrinsic hash explorers use. */
    private hashExtrinsic(hex: string): string {
        const cleanHex = hex.startsWith('0x') ? hex.slice(2) : hex;
        const bytes = Buffer.from(cleanHex, 'hex');
        const hash = blake2b(bytes, { dkLen: 32 });
        return '0x' + bytesToHex(hash);
    }

    /** Event registry of a runtime version, loaded from node metadata once per specVersion. */
    private async getEventRegistry(blockHash: string, specVersion: number): Promise<TypeRegistry | undefined> {
        // 0 is a valid specVersion: no falsy check.
        if (!Number.isInteger(specVersion) || specVersion < 0) {
            throw new Error(`Invalid runtime specVersion ${String(specVersion)} for block ${blockHash}`);
        }
        const cached = this.runtimes.get(specVersion);
        if (cached) return cached.registry;
        let metadataHex: unknown;
        try {
            metadataHex = await this.nodeProvider.getMetadata(blockHash);
        } catch (err) {
            throw new Error(`Runtime metadata unavailable for block ${blockHash} (specVersion ${specVersion}): ${(err as Error).message}`);
        }
        if (typeof metadataHex !== 'string' || !metadataHex.startsWith('0x') || metadataHex.length < 4) {
            // A null/empty answer is what a pruned or racing node gives: transient.
            throw new Error(`No runtime metadata for block ${blockHash} (specVersion ${specVersion}): pruned or racing node`);
        }
        let registry: TypeRegistry;
        try {
            registry = new TypeRegistry();
            registry.setMetadata(new Metadata(registry, metadataHex as `0x${string}`));
        } catch (err) {
            throw new Error(`Runtime metadata for block ${blockHash} (specVersion ${specVersion}) does not decode: ${(err as Error).message}`);
        }
        // Registry and pallet map are ONE cache entry per specVersion: a block
        // is always classified with the map of the runtime it was produced by.
        this.runtimes.set(specVersion, { registry, palletMap: this.palletMapFromMetadata(registry, specVersion) });
        return registry;
    }

    private palletMapFromMetadata(registry: TypeRegistry, specVersion: number): Map<number, PalletMapping> {
        let pallets: Array<{ name: unknown; index: unknown }>;
        try { pallets = ((registry.metadata as any)?.pallets ?? []) as Array<{ name: unknown; index: unknown }>; } catch (err) {
            throw new Error(`Runtime metadata for specVersion ${specVersion} exposes no readable pallet list (unsupported metadata representation): ${(err as Error).message}`);
        }
        if (!Array.isArray(pallets) || pallets.length === 0) {
            throw new Error(`Runtime metadata for specVersion ${specVersion} lists no pallets (unsupported metadata representation); refusing to classify with the default pallet indices`);
        }
        const { map, moved, unmapped } = resolvePalletMapFromMetadata(pallets, this.palletOverrides);
        const detail = [
            moved.length ? `moved from the default indices: ${moved.join(', ')}` : '',
            unmapped.length ? `not in the default map (txType unknown): ${unmapped.join(', ')}` : ''
        ].filter(Boolean).join('; ');
        (moved.length ? log.warn : log.info).call(log, `pallet map for specVersion ${specVersion} resolved from runtime metadata (${map.size} pallets)${detail ? ': ' + detail : ''}`);
        return map;
    }

    /** Outcome per extrinsic from System.ExtrinsicSuccess/ExtrinsicFailed only; a failure wins. */
    private decodeExtrinsicOutcomes(
        rawEvents: string | null | undefined,
        registry: TypeRegistry | undefined,
        where: string = '',
        extrinsicCount: number = 0
    ): Map<number, 'SUCCESS' | 'FAILURE'> {
        const outcomes = new Map<number, 'SUCCESS' | 'FAILURE'>();
        if (!rawEvents || !registry) {
            if (extrinsicCount > 0) {
                log.warn(`${where || 'block'}: transaction outcomes unknown (${!rawEvents ? 'System.Events storage empty (pruned or racing node)' : 'no runtime metadata registry'}); ${extrinsicCount} extrinsic(s) get no TransactionResults row`);
            }
            return outcomes;
        }
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

    private specVersionFromBatch(rv: { specVersion?: unknown } | null | undefined, where: string): number {
        const raw = rv?.specVersion;
        const v = typeof raw === 'number' ? raw
            : typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw)
                : NaN;
        if (Number.isInteger(v) && v >= 0) return v;
        throw new Error(`No runtime version for ${where} (pruned or racing node)`);
    }

    /** Timestamp::Now storage at a block as UNIX seconds, null when absent (no wall clock). */
    private async getBlockTimestamp(blockHash: string): Promise<number | null> {
        return this.parseTimestampHex(await this.getBlockTimestampHex(blockHash));
    }

    /** Timestamp::Now storage at a block (raw hex), null when the RPC fails or the state is gone. */
    private async getBlockTimestampHex(blockHash: string): Promise<string | null> {
        try {
            return (await this.nodeProvider.getStorage(BlockProcessor.TIMESTAMP_STORAGE_KEY, blockHash)) ?? null;
        } catch (err) {
            log.warn(`Failed to read on-chain timestamp for ${blockHash}: ${(err as Error).message}`);
            return null;
        }
    }

    /** Queried per block so a runtime upgrade applies from its first block. */
    private async getProtocolVersion(blockHash: string): Promise<number> {
        let rv: { specVersion?: number } | null | undefined;
        try {
            rv = await this.nodeProvider.getRuntimeVersion(blockHash);
        } catch (err) {
            throw new Error(`No runtime version for block ${blockHash}: ${(err as Error).message}`);
        }
        return this.specVersionFromBatch(rv, `block ${blockHash}`);
    }

    /** `engineId:data` of the PreRuntime digest log (type 6), else the first log. */
    private extractAuthor(digestLogs: string[] | undefined): string | null {
        if (!digestLogs || digestLogs.length === 0) return null;

        for (const logHex of digestLogs) {
            const clean = logHex.startsWith('0x') ? logHex.slice(2) : logHex;
            if (clean.length < 10) continue;

            const logType = parseInt(clean.slice(0, 2), 16);

            if (logType === 6) {
                const engineId = Buffer.from(clean.slice(2, 10), 'hex').toString('ascii');
                const data = '0x' + clean.slice(10);
                return `${engineId}:${data}`;
            }
        }

        return digestLogs[0] || null;
    }
}
