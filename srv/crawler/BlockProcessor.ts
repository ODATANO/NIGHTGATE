/** Parses Midnight blocks (header, extrinsic classification, outcomes) and persists them. */

import cds from '@sap/cds';
import { blake2b } from '@noble/hashes/blake2';
import { bytesToHex } from '@noble/hashes/utils';
import { TypeRegistry } from '@polkadot/types/create';
import { Metadata } from '@polkadot/types/metadata';
import { MidnightNodeProvider, SignedBlock } from '../providers/MidnightNodeProvider';
import { ensureNightgateModelLoaded } from '../utils/cds-model';
import { isUniqueViolation } from '../utils/retry';
import {
    getNightgatePluginConfig, getConfiguredNightgateNetwork, normalizeNightgateNetwork
} from '../utils/nightgate-config';
import { parseExtrinsicCallIndices, parseExtrinsicCall, decodeCompactBigInt } from '../utils/scale';
import {
    readBlockEvents, txTypeFromEvents, projectTransfer, NIGHT_RAW_TOKEN_TYPE, type ExtrinsicEvents
} from './block-events';
import { encodeUnshieldedOwner, computeInitialNonce } from './utxo-identity';
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
    /** null when the block carried no readable events; the pallet map then classifies alone. */
    extrinsicEvents: Map<number, ExtrinsicEvents> | null;
    fetchStartedAt: number;
    fetchCompletedAt?: number;
    alreadyIndexed: false;
}

/** One `UnshieldedUtxos` row, less the transaction it was created at. */
interface PreparedUtxoRow {
    owner: string;
    tokenType: string;
    value: string;
    intentHash: string;
    outputIndex: number;
    initialNonce: string;
    ctime: number;
}

/** What one extrinsic's events project onto columns, with addresses resolved. */
interface EventProjection {
    created: PreparedUtxoRow[];
    spent: Array<{ intentHash: string; outputIndex: number }>;
    senderAddress: string | null;
    receiverAddress: string | null;
    nightAmount: string | null;
}

/** Running NightBalances change for one address within a block. */
interface BalanceDelta {
    balance: bigint;
    utxoCount: number;
    totalReceived: bigint;
    txReceivedCount: number;
    totalSent: bigint;
    txSentCount: number;
}

function emptyBalanceDelta(): BalanceDelta {
    return { balance: 0n, utxoCount: 0, totalReceived: 0n, txReceivedCount: 0, totalSent: 0n, txSentCount: 0 };
}

/** One node lookup per LastRuntimeUpgrade value: which block asked, and whether the node agreed with the value. */
interface SpecVersionLookup {
    blockHash: string;
    answer: Promise<{ specVersion: number; agreed: boolean }>;
}

export class BlockProcessor {
    private db!: cds.DatabaseService;
    /** Pallet map without runtime metadata (defaults + config overrides); the metadata-derived map per specVersion lives in `runtimes`. */
    private readonly defaultPalletMap: Map<number, PalletMapping>;
    /** Event registry + pallet map per runtime specVersion, loaded once from the node's metadata. */
    private readonly runtimes = new Map<number, RuntimeContext>();
    private readonly palletOverrides = configPalletOverrides();
    /** Bech32m HRP network of the unshielded owners this index stores. */
    private resolvedNetwork?: string;

    /** Timestamp::Now = twox128("Timestamp") + twox128("Now"). */
    private static readonly TIMESTAMP_STORAGE_KEY =
        '0xf0c365c3cf59d671eb72da0e7a4113c49f1f0515f462cdcf84e0f1d6045dfcbb';
    /** System::Events = twox128("System") + twox128("Events"). */
    private static readonly SYSTEM_EVENTS_STORAGE_KEY =
        '0x26aa394eea5630e07c48ae0c9558cef780d41e5e16056765bc8461851072c9d7';
    /**
     * System::LastRuntimeUpgrade = twox128("System") + twox128("LastRuntimeUpgrade"),
     * SCALE `{ spec_version: Compact<u32>, spec_name: Vec<u8> }`. A plain storage
     * read, where `state_getRuntimeVersion` at a historical hash compiles that runtime.
     */
    private static readonly LAST_RUNTIME_UPGRADE_STORAGE_KEY =
        '0x26aa394eea5630e07c48ae0c9558cef7f9cce9c888469bb1a0dceaa129672ef8';
    /** specVersion per raw LastRuntimeUpgrade value: the node is asked once per value, not per block. */
    private readonly specVersionByUpgrade = new Map<string, SpecVersionLookup>();

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
        let upgradeResults: (string | null)[] = [];
        if (newIndices.length > 0) {
            const requests: Array<{ method: string; params: unknown[] }> = [];
            for (const i of newIndices) {
                requests.push({ method: 'chain_getBlock', params: [hashes[i]] });
                requests.push({ method: 'state_getStorage', params: [BlockProcessor.TIMESTAMP_STORAGE_KEY, hashes[i]] });
                requests.push({ method: 'state_getStorage', params: [BlockProcessor.SYSTEM_EVENTS_STORAGE_KEY, hashes[i]] });
                requests.push({ method: 'state_getStorage', params: [BlockProcessor.LAST_RUNTIME_UPGRADE_STORAGE_KEY, hashes[i]] });
            }
            const flat = await this.nodeProvider.rpcBatch(requests);
            blockResults = newIndices.map((_, k) => flat[k * 4]);
            tsResults = newIndices.map((_, k) => flat[k * 4 + 1]);
            eventResults = newIndices.map((_, k) => flat[k * 4 + 2]);
            upgradeResults = newIndices.map((_, k) => flat[k * 4 + 3]);
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
            const protocolVersion = await this.resolveSpecVersion(upgradeResults[newIdx], blockHash, `height ${heights[i]}`);
            const eventRegistry = await this.getEventRegistry(blockHash, protocolVersion);
            const palletMap = this.palletMapFor(protocolVersion);
            const timestamp = this.resolveTimestamp(tsResults[newIdx], signedBlock.block.extrinsics, `height ${heights[i]}`, palletMap);
            const extrinsicEvents = this.decodeBlockEvents(eventResults[newIdx], eventRegistry, `height ${heights[i]}`, signedBlock.block.extrinsics?.length ?? 0);
            newIdx++;
            out[i] = {
                blockHash,
                height: heights[i],
                signedBlock,
                protocolVersion,
                palletMap,
                timestamp,
                extrinsicEvents,
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

        const [signedBlock, timestampHex, upgradeHex, rawEvents] = await Promise.all([
            this.nodeProvider.getBlock(blockHash),
            this.getBlockTimestampHex(blockHash),
            this.getLastRuntimeUpgradeHex(blockHash),
            this.nodeProvider.getStorage(BlockProcessor.SYSTEM_EVENTS_STORAGE_KEY, blockHash)
        ]);
        if (!signedBlock?.block) {
            throw new Error(`No block body returned for ${blockHash} (pruned or racing node)`);
        }
        const protocolVersion = await this.resolveSpecVersion(upgradeHex, blockHash, `block ${blockHash}`);
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
            extrinsicEvents: this.decodeBlockEvents(rawEvents, eventRegistry, `block ${blockHash}`, signedBlock.block.extrinsics?.length ?? 0),
            fetchStartedAt: start,
            alreadyIndexed: false
        }, start, opts);
    }

    private async persistFromNode(
        prep: PreparedBlockFetched,
        start: number,
        opts?: { requireParent?: boolean }
    ): Promise<ProcessResult> {
        const { blockHash, height, signedBlock, protocolVersion, palletMap, timestamp, extrinsicEvents } = prep;
        const header = signedBlock.block.header;
        const extrinsics = signedBlock.block.extrinsics;

        let txCount = 0;
        let actionCount = 0;

        // Bech32m encoding and the nonce derivation run before the transaction
        // opens: both are SDK calls, and a db transaction is not the place to
        // await one.
        const projections = await this.projectEvents(extrinsicEvents, timestamp, `block ${blockHash}`);

        const written = await this.db.tx(async (tx: any) => {
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
                stateRoot: header.stateRoot,
                parent_ID: parentBlock?.ID || null
            }));

            const txRows: Record<string, unknown>[] = [];
            const txResultRows: Record<string, unknown>[] = [];
            const txFeeRows: Record<string, unknown>[] = [];
            const contractActionRows: Record<string, unknown>[] = [];
            const utxoRows: Record<string, unknown>[] = [];
            const spendRequests: Array<{ intentHash: string; outputIndex: number; txId: string }> = [];
            const balanceDeltas = new Map<string, BalanceDelta>();
            const deltaFor = (address: string): BalanceDelta => {
                let delta = balanceDeltas.get(address);
                if (!delta) { delta = emptyBalanceDelta(); balanceDeltas.set(address, delta); }
                return delta;
            };

            for (let i = 0; i < extrinsics.length; i++) {
                const extrinsicHex = extrinsics[i];
                const txId = cds.utils.uuid();
                const classification = this.classifyExtrinsic(extrinsicHex, palletMap);
                const extrinsicHash = this.hashExtrinsic(extrinsicHex);
                const txSize = this.extrinsicSize(extrinsicHex);
                const circuitName = this.buildCircuitName(classification);
                const events = extrinsicEvents?.get(i);
                const projection = projections.get(i);
                const contractAddress = events?.contracts[0]?.address ?? null;
                const senderAddress = projection?.senderAddress ?? null;
                const receiverAddress = projection?.receiverAddress ?? null;
                const nightAmount = projection?.nightAmount ?? null;

                txRows.push({
                    ID: txId,
                    transactionId: i,
                    hash: extrinsicHash,
                    ledgerTxHash: events?.ledgerTxHash ?? null,
                    protocolVersion,
                    raw: hexToBinaryValue(extrinsicHex),
                    transactionType: classification.isSystem ? 'SYSTEM' : 'REGULAR',
                    txType: txTypeFromEvents(events) ?? classification.txType,
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

                const outcome = this.outcomeFor(events);
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

                let actionIndex = 0;
                for (const action of this.contractActionsFor(events, classification)) {
                    contractActionRows.push({
                        ID: cds.utils.uuid(),
                        actionIndex: actionIndex++,
                        address: action.address,
                        actionType: action.actionType,
                        entryPoint: circuitName,
                        state: null,
                        transaction_ID: txId
                    });
                    actionCount++;
                }

                for (const utxo of projection?.created ?? []) {
                    utxoRows.push({ ID: cds.utils.uuid(), ...utxo, createdAtTransaction_ID: txId });
                    // A UTXO can hold any token; NightBalances counts NIGHT.
                    if (utxo.tokenType !== NIGHT_RAW_TOKEN_TYPE) continue;
                    const delta = deltaFor(utxo.owner);
                    const value = BigInt(utxo.value);
                    delta.balance += value;
                    delta.utxoCount += 1;
                    delta.totalReceived += value;
                    delta.txReceivedCount += 1;
                }
                for (const spend of projection?.spent ?? []) {
                    spendRequests.push({ ...spend, txId });
                }
                // Mirrors the sent-transaction rule in recomputeNightBalance.
                if (senderAddress && receiverAddress && receiverAddress !== senderAddress && BigInt(nightAmount ?? '0') > 0n) {
                    const delta = deltaFor(senderAddress);
                    delta.totalSent += BigInt(nightAmount ?? '0');
                    delta.txSentCount += 1;
                }

                txCount++;
            }

            if (txRows.length) await tx.run(INSERT.into(Transactions).entries(txRows));
            if (txResultRows.length) await tx.run(INSERT.into(TransactionResults).entries(txResultRows));
            if (txFeeRows.length) await tx.run(INSERT.into(TransactionFees).entries(txFeeRows));
            if (contractActionRows.length) await tx.run(INSERT.into(ContractActions).entries(contractActionRows));
            // Before the spends: a UTxO can be created and consumed in one block.
            if (utxoRows.length) await tx.run(INSERT.into(UnshieldedUtxos).entries(utxoRows));

            await this.applySpends(tx, spendRequests, deltaFor, height);
            for (const [address, delta] of balanceDeltas) {
                await this.applyBalanceDelta(tx, address, delta, height);
            }

            await tx.run(
                UPDATE.entity(SyncState).set({
                    lastIndexedHeight: height,
                    lastIndexedHash: blockHash,
                    lastIndexedAt: new Date().toISOString(),
                    syncStatus: 'syncing'
                }).where({ ID: 'SINGLETON' })
            );
            return true;
        }).catch(async (err: unknown) => {
            // Another writer landed this block between the fetch and the insert
            // (a catch-up next to a live head): the row is there, the
            // transaction rolled back, nothing is broken. A unique violation
            // without the row is a real fault and propagates.
            if (isUniqueViolation(err) && await this.blockExists(blockHash)) {
                log.warn(`Block ${height} (${blockHash}) was indexed by another writer meanwhile; skipped`);
                return false;
            }
            throw err;
        });

        if (!written) {
            return {
                blockHeight: height,
                blockHash,
                transactionCount: 0,
                contractActionCount: 0,
                processingTimeMs: Date.now() - start
            };
        }

        return {
            blockHeight: height,
            blockHash,
            transactionCount: txCount,
            contractActionCount: actionCount,
            processingTimeMs: Date.now() - start
        };
    }

    /** The network whose HRP unshielded owners are encoded under. */
    private network(): string {
        if (!this.resolvedNetwork) {
            this.resolvedNetwork = normalizeNightgateNetwork(
                getConfiguredNightgateNetwork(getNightgatePluginConfig())
            ).network;
        }
        return this.resolvedNetwork;
    }

    /**
     * Resolves each extrinsic's events into storable columns: Bech32m owners,
     * DUST initial nonces and the transfer projection. An entry whose identity
     * cannot be derived is dropped with a warning rather than failing the
     * block, since `initialNonce` has no null form.
     */
    private async projectEvents(
        extrinsicEvents: Map<number, ExtrinsicEvents> | null,
        timestamp: number,
        where: string
    ): Promise<Map<number, EventProjection>> {
        const projections = new Map<number, EventProjection>();
        if (!extrinsicEvents) return projections;
        const network = this.network();

        for (const [index, events] of extrinsicEvents) {
            if (!events.created.length && !events.spent.length) continue;

            const created: PreparedUtxoRow[] = [];
            for (const utxo of events.created) {
                try {
                    created.push({
                        owner: await encodeUnshieldedOwner(utxo.address, network),
                        tokenType: utxo.tokenType,
                        value: utxo.value.toString(),
                        intentHash: utxo.intentHash,
                        outputIndex: utxo.outputNo,
                        initialNonce: await computeInitialNonce(utxo.outputNo, utxo.intentHash),
                        ctime: timestamp
                    });
                } catch (err) {
                    log.warn(`${where}: UTXO ${utxo.intentHash}#${utxo.outputNo} not indexed: ${(err as Error).message}`);
                }
            }

            const transfer = projectTransfer(events);
            let senderAddress: string | null = null;
            let receiverAddress: string | null = null;
            try {
                if (transfer.senderAddress) senderAddress = await encodeUnshieldedOwner(transfer.senderAddress, network);
                if (transfer.receiverAddress) receiverAddress = await encodeUnshieldedOwner(transfer.receiverAddress, network);
            } catch (err) {
                log.warn(`${where}: transfer participants not resolved: ${(err as Error).message}`);
                senderAddress = null;
                receiverAddress = null;
            }

            projections.set(index, {
                created,
                spent: events.spent.map(u => ({ intentHash: u.intentHash, outputIndex: u.outputNo })),
                senderAddress,
                receiverAddress,
                nightAmount: receiverAddress && transfer.nightAmount != null ? transfer.nightAmount.toString() : null
            });
        }
        return projections;
    }

    /** FAILURE beats PARTIAL_SUCCESS beats SUCCESS. */
    private outcomeFor(events: ExtrinsicEvents | undefined): 'SUCCESS' | 'PARTIAL_SUCCESS' | 'FAILURE' | null {
        if (!events?.outcome) return null;
        if (events.outcome === 'FAILURE') return 'FAILURE';
        return events.partialSuccess ? 'PARTIAL_SUCCESS' : 'SUCCESS';
    }

    /**
     * Contract actions of one extrinsic. The pallet's own report wins where it
     * exists; the pallet-map classification only fills in for an extrinsic the
     * chain said nothing about, since a pallet index alone cannot tell a
     * contract call from a plain token movement.
     */
    private contractActionsFor(
        events: ExtrinsicEvents | undefined,
        classification: ExtrinsicClassification
    ): Array<{ actionType: 'DEPLOY' | 'CALL' | 'UPDATE'; address: string | null }> {
        if (events?.contracts.length) return events.contracts;
        if (events?.applied) return [];
        const fallback = this.toContractActionType(classification.txType);
        return fallback ? [{ actionType: fallback, address: null }] : [];
    }

    /** Marks spent UTxOs and folds their value into the owners' balance deltas. */
    private async applySpends(
        tx: any,
        spends: Array<{ intentHash: string; outputIndex: number; txId: string }>,
        deltaFor: (address: string) => BalanceDelta,
        height: number
    ): Promise<void> {
        for (const spend of spends) {
            const row = await tx.run(
                SELECT.one.from(UnshieldedUtxos)
                    .columns('ID', 'owner', 'value', 'tokenType', 'spentAtTransaction_ID')
                    .where({ intentHash: spend.intentHash, outputIndex: spend.outputIndex })
            );
            if (!row) {
                // Normal below the first indexed height: the output predates the index.
                log.debug(`spent UTXO ${spend.intentHash}#${spend.outputIndex} at height ${height} was never indexed`);
                continue;
            }
            if (row.spentAtTransaction_ID) continue;
            await tx.run(
                UPDATE.entity(UnshieldedUtxos)
                    .set({ spentAtTransaction_ID: spend.txId })
                    .where({ ID: row.ID })
            );
            if (row.tokenType !== NIGHT_RAW_TOKEN_TYPE) continue;
            const delta = deltaFor(row.owner);
            delta.balance -= this.toBigInt(row.value);
            delta.utxoCount -= 1;
        }
    }

    /**
     * Folds one block's change into an address's NightBalances row. Must stay
     * the mirror of `recomputeNightBalance` in rollback.ts, which rebuilds the
     * same figures from scratch after a reorg.
     */
    private async applyBalanceDelta(tx: any, address: string, delta: BalanceDelta, height: number): Promise<void> {
        const nowIso = new Date().toISOString();
        const existing = await tx.run(
            SELECT.one.from(NightBalances)
                .columns('address', 'balance', 'utxoCount', 'totalReceived', 'txReceivedCount',
                    'totalSent', 'txSentCount', 'firstSeenHeight')
                .where({ address })
        );

        if (!existing) {
            await tx.run(INSERT.into(NightBalances).entries({
                address,
                balance: delta.balance.toString() as any,
                utxoCount: delta.utxoCount,
                totalReceived: delta.totalReceived.toString() as any,
                txReceivedCount: delta.txReceivedCount,
                totalSent: delta.totalSent.toString() as any,
                txSentCount: delta.txSentCount,
                firstSeenHeight: height,
                firstSeenAt: nowIso,
                lastActivityHeight: height,
                lastActivityAt: nowIso,
                lastUpdatedHeight: height,
                lastUpdatedAt: nowIso
            }));
            return;
        }

        const priorFirstSeen = Number(existing.firstSeenHeight);
        await tx.run(UPDATE.entity(NightBalances).set({
            balance: (this.toBigInt(existing.balance) + delta.balance).toString() as any,
            utxoCount: this.toInt(existing.utxoCount) + delta.utxoCount,
            totalReceived: (this.toBigInt(existing.totalReceived) + delta.totalReceived).toString() as any,
            txReceivedCount: this.toInt(existing.txReceivedCount) + delta.txReceivedCount,
            totalSent: (this.toBigInt(existing.totalSent) + delta.totalSent).toString() as any,
            txSentCount: this.toInt(existing.txSentCount) + delta.txSentCount,
            firstSeenHeight: Number.isFinite(priorFirstSeen) ? Math.min(priorFirstSeen, height) : height,
            lastActivityHeight: height,
            lastActivityAt: nowIso,
            lastUpdatedHeight: height,
            lastUpdatedAt: nowIso
        }).where({ address }));
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

    /**
     * Per-extrinsic events of one block. A block with extrinsics but no readable events is
     * never persisted: its UTXO rows and balance deltas would be missing for good.
     */
    private decodeBlockEvents(
        rawEvents: string | null | undefined,
        registry: TypeRegistry | undefined,
        where: string = '',
        extrinsicCount: number = 0
    ): Map<number, ExtrinsicEvents> | null {
        if (!rawEvents || !registry) {
            if (extrinsicCount === 0) return null;
            if (!rawEvents) throw new Error(`No System.Events for ${where || 'block'} with ${extrinsicCount} extrinsic(s) (pruned or racing node)`);
            throw new Error(`No runtime metadata registry to decode System.Events for ${where || 'block'}`);
        }
        try {
            return readBlockEvents(registry.createType('Vec<EventRecord>', rawEvents) as any);
        } catch (err) {
            throw new Error(`System.Events of ${where || 'block'} do not decode: ${(err as Error).message}`);
        }
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

    /** System::LastRuntimeUpgrade storage at a block (raw hex), null when the RPC fails or the state is gone. */
    private async getLastRuntimeUpgradeHex(blockHash: string): Promise<string | null> {
        try {
            return (await this.nodeProvider.getStorage(BlockProcessor.LAST_RUNTIME_UPGRADE_STORAGE_KEY, blockHash)) ?? null;
        } catch (err) {
            log.warn(`Failed to read LastRuntimeUpgrade for ${blockHash}: ${(err as Error).message}`);
            return null;
        }
    }

    /**
     * The runtime specVersion of a block, keyed by its `System.LastRuntimeUpgrade`
     * value: the node is asked (`state_getRuntimeVersion`, the expensive call)
     * once per distinct value, so an upgrade still applies from its first block
     * while a million blocks under one runtime cost one call. The node stays the
     * authority; the decoded value cross-checks it, and an answer that disagrees
     * with it is used for that block only, never cached under the value (the
     * block that carries a runtime upgrade still reports the previous value).
     * A block whose storage carries no such value (pruned or racing node, or a
     * chain without it) is asked per block, as before.
     */
    private async resolveSpecVersion(upgradeHex: string | null | undefined, blockHash: string, where: string): Promise<number> {
        if (typeof upgradeHex !== 'string' || !/^0x[0-9a-fA-F]{2,}$/.test(upgradeHex)) {
            return this.getProtocolVersion(blockHash, where);
        }
        let lookup = this.specVersionByUpgrade.get(upgradeHex);
        if (!lookup) {
            const fresh: SpecVersionLookup = {
                blockHash,
                answer: this.getProtocolVersion(blockHash, where).then(specVersion => {
                    const decoded = BlockProcessor.decodeLastRuntimeUpgrade(upgradeHex);
                    if (decoded !== null && decoded !== specVersion) {
                        log.warn(`LastRuntimeUpgrade at ${where} decodes to specVersion ${decoded}, node reports ${specVersion}; using the node's for this block only`);
                        if (this.specVersionByUpgrade.get(upgradeHex) === fresh) this.specVersionByUpgrade.delete(upgradeHex);
                        return { specVersion, agreed: false };
                    }
                    log.info(`Runtime specVersion ${specVersion} first seen at ${where}`);
                    return { specVersion, agreed: true };
                })
            };
            this.specVersionByUpgrade.set(upgradeHex, fresh);
            // A failed lookup is not an answer: the next block with this value asks again.
            fresh.answer.catch(() => {
                if (this.specVersionByUpgrade.get(upgradeHex) === fresh) this.specVersionByUpgrade.delete(upgradeHex);
            });
            lookup = fresh;
        }
        const { specVersion, agreed } = await lookup.answer;
        // A disagreeing answer belongs to the block that asked; a block that waited on it asks for itself.
        if (agreed || lookup.blockHash === blockHash) return specVersion;
        return this.getProtocolVersion(blockHash, where);
    }

    /**
     * `spec_version` of a SCALE `LastRuntimeUpgradeInfo { spec_version: Compact<u32>, spec_name: Vec<u8> }`,
     * null when the bytes do not decode as one.
     */
    static decodeLastRuntimeUpgrade(hex: string): number | null {
        const bytes = Buffer.from(hex.startsWith('0x') ? hex.slice(2) : hex, 'hex');
        if (bytes.length === 0) return null;
        switch (bytes[0] & 0b11) {
            case 0: return bytes[0] >>> 2;
            case 1: return bytes.length >= 2 ? bytes.readUInt16LE(0) >>> 2 : null;
            case 2: return bytes.length >= 4 ? bytes.readUInt32LE(0) >>> 2 : null;
            default: return null; // big-integer mode: not a u32
        }
    }

    /** Asks the node for the runtime version AT this block: the expensive call, reserved for the first block of each runtime. */
    private async getProtocolVersion(blockHash: string, where: string = `block ${blockHash}`): Promise<number> {
        let rv: { specVersion?: number } | null | undefined;
        try {
            rv = await this.nodeProvider.getRuntimeVersion(blockHash);
        } catch (err) {
            throw new Error(`No runtime version for ${where}: ${(err as Error).message}`);
        }
        return this.specVersionFromBatch(rv, where);
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
