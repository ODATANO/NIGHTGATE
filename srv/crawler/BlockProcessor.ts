/** Reads Midnight blocks from the node and stores them with their transactions, UTXOs and balances. */

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
import type { DbRunner } from '../utils/db-types';
import {
    Blocks, Transactions, TransactionResults, TransactionFees, ContractActions,
    UnshieldedUtxos, NightBalances, SyncState, type UnshieldedUtxo
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

export interface PalletMapping {
    name: string;
    txType: string;
    isShielded?: boolean;
    isSystem?: boolean;
}

/** Intent hashes per spend query, well below the parameter limits of SQLite and PostgreSQL. */
const SPEND_LOOKUP_CHUNK = 500;

/** Must match the TxType enum in db/schema.cds. */
const VALID_TX_TYPES = new Set([
    'night_transfer', 'shielded_transfer', 'contract_deploy', 'contract_call',
    'contract_update', 'dust_registration', 'dust_generation', 'governance',
    'system', 'unknown'
]);

/** Default classification per pallet index. Runtime metadata moves entries to their real index by pallet name. */
const DEFAULT_PALLET_MAP: Record<number, PalletMapping> = {
    0: { name: 'System', txType: 'system', isSystem: true },
    1: { name: 'Timestamp', txType: 'system', isSystem: true },
    2: { name: 'Aura', txType: 'system', isSystem: true },
    3: { name: 'Grandpa', txType: 'system', isSystem: true },
    4: { name: 'Sidechain', txType: 'system', isSystem: true },
    5: { name: 'Midnight', txType: 'contract_call' }, // send_mn_transaction carries every ledger transaction
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
    32: { name: 'Bridge', txType: 'night_transfer' }, // handle_transfers moves NIGHT across chains
    40: { name: 'Council', txType: 'governance' },
    41: { name: 'CouncilMembership', txType: 'governance' },
    42: { name: 'TechnicalCommittee', txType: 'governance' },
    43: { name: 'TechnicalCommitteeMembership', txType: 'governance' },
    44: { name: 'FederatedAuthority', txType: 'governance' },
    45: { name: 'FederatedAuthorityObservation', txType: 'system', isSystem: true }, // per-block inherent
    50: { name: 'SystemParameters', txType: 'system', isSystem: true },
    51: { name: 'Throttle', txType: 'system', isSystem: true }
};

function hexToBinaryValue(hex: string): string {
    return Buffer.from(hex.startsWith('0x') ? hex.slice(2) : hex, 'hex').toString('base64');
}

/** Entries from `cds.requires.nightgate.palletMap` override both the defaults and the runtime metadata. */
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

interface RuntimeContext {
    registry: TypeRegistry;
    palletMap: Map<number, PalletMapping>;
}

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
    /** Null when the block has no readable events. Then only the pallet map classifies extrinsics. */
    extrinsicEvents: Map<number, ExtrinsicEvents> | null;
    fetchStartedAt: number;
    fetchCompletedAt?: number;
    alreadyIndexed: false;
}

type PreparedUtxo = Pick<UnshieldedUtxo, 'owner' | 'tokenType' | 'value' | 'intentHash' | 'outputIndex' | 'initialNonce'> & { ctime: number };

interface EventProjection {
    created: PreparedUtxo[];
    spent: Array<{ intentHash: string; outputIndex: number }>;
    senderAddress: string | null;
    receiverAddress: string | null;
    nightAmount: string | null;
}

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

/** `agreed` is false when the node's answer differs from the decoded LastRuntimeUpgrade value. */
interface SpecVersionLookup {
    blockHash: string;
    answer: Promise<{ specVersion: number; agreed: boolean }>;
}

export class BlockProcessor {
    private db!: cds.DatabaseService;
    private readonly defaultPalletMap: Map<number, PalletMapping>;
    private readonly runtimes = new Map<number, RuntimeContext>();
    private readonly palletOverrides = configPalletOverrides();
    private resolvedNetwork?: string;

    /** Timestamp::Now = twox128("Timestamp") + twox128("Now"). */
    private static readonly TIMESTAMP_STORAGE_KEY =
        '0xf0c365c3cf59d671eb72da0e7a4113c49f1f0515f462cdcf84e0f1d6045dfcbb';
    /** System::Events = twox128("System") + twox128("Events"). */
    private static readonly SYSTEM_EVENTS_STORAGE_KEY =
        '0x26aa394eea5630e07c48ae0c9558cef780d41e5e16056765bc8461851072c9d7';
    /**
     * System::LastRuntimeUpgrade = twox128("System") + twox128("LastRuntimeUpgrade").
     * Reading it is cheap. `state_getRuntimeVersion` at an old block makes the node compile that runtime.
     */
    private static readonly LAST_RUNTIME_UPGRADE_STORAGE_KEY =
        '0x26aa394eea5630e07c48ae0c9558cef7f9cce9c888469bb1a0dceaa129672ef8';
    /** Runtime version per raw LastRuntimeUpgrade value, so the node is asked once per value and not per block. */
    private readonly specVersionByUpgrade = new Map<string, SpecVersionLookup>();

    constructor(
        private nodeProvider: MidnightNodeProvider
    ) {
        this.defaultPalletMap = buildPalletMap();
    }

    private palletMapFor(specVersion: number): Map<number, PalletMapping> {
        return this.runtimes.get(specVersion)?.palletMap ?? this.defaultPalletMap;
    }

    async init(): Promise<void> {
        await ensureNightgateModelLoaded();
        this.db = await cds.connect.to('db');
    }

    /** A missing parent is allowed here and stored as `parent_ID = null`. */
    async processBlockByHash(blockHash: string): Promise<ProcessResult> {
        const start = Date.now();
        return this.processFromNode(blockHash, start, { requireParent: false });
    }

    /** A missing parent means a gap in the index, so this fails instead of storing a block without parent. */
    async processBlockByHeight(height: number): Promise<ProcessResult> {
        const hash = await this.nodeProvider.getBlockHash(height);
        if (!hash) throw new Error(`No block at height ${height}`);
        return this.processFromNode(hash, Date.now(), { requireParent: true });
    }

    /**
     * Fetches a range of heights in two JSON-RPC batches.
     * The first gets all hashes, the second the block data for every hash not indexed yet.
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

    /** Timestamp::Now is a little-endian u64 in milliseconds. Returns UNIX seconds, or null. */
    private parseTimestampHex(hex: string | null | undefined): number | null {
        if (!hex) return null;
        const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
        try {
            return Number(Buffer.from(clean, 'hex').readBigUInt64LE(0) / 1000n);
        } catch {
            return null;
        }
    }

    /** Falls back to the `Timestamp.set` inherent, which still exists after the node pruned the state. */
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
        // Catch-up stores blocks in height order, so a missing parent is a gap in the index.
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

        // These SDK calls run before the database transaction opens,
        // so the transaction is not held open while waiting for them.
        const projections = await this.projectEvents(extrinsicEvents, timestamp, `block ${blockHash}`);

        const written = await this.db.tx(async (tx) => {
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
                // The pallet call does not show what the ledger transaction contains. Unknown until it is decoded.
                const shielded = classification.isSystem ? false : (classification.isShielded ? true : null);

                txRows.push({
                    ID: txId,
                    transactionId: i,
                    hash: extrinsicHash,
                    ledgerTxHash: events?.ledgerTxHash ?? null,
                    protocolVersion,
                    raw: hexToBinaryValue(extrinsicHex),
                    transactionType: classification.isSystem ? 'SYSTEM' : 'REGULAR',
                    txType: txTypeFromEvents(events) ?? classification.txType,
                    isShielded: shielded,
                    senderAddress,
                    receiverAddress,
                    nightAmount,
                    hasProof: shielded,
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
                    // Only NIGHT counts towards NightBalances.
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
                // Same rule for sent transactions as in recomputeNightBalance.
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
            // Insert before the spends, because a UTXO can be created and spent in the same block.
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
            // Another writer, such as catch-up next to the live handler, stored this block in the meantime.
            // The block exists, so nothing is lost. A unique violation without the block is a real error.
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

    /** Network prefix of the Bech32m owner addresses. */
    private network(): string {
        if (!this.resolvedNetwork) {
            this.resolvedNetwork = normalizeNightgateNetwork(
                getConfiguredNightgateNetwork(getNightgatePluginConfig())
            ).network;
        }
        return this.resolvedNetwork;
    }

    /**
     * A UTXO whose address or nonce cannot be derived is skipped with a warning instead of failing the block.
     * `initialNonce` cannot be null.
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

            const created: PreparedUtxo[] = [];
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
     * The pallet's events win. The pallet map is only a fallback for an extrinsic without events,
     * because a pallet index cannot tell a contract call from a token transfer.
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

    private async applySpends(
        tx: DbRunner,
        spends: Array<{ intentHash: string; outputIndex: number; txId: string }>,
        deltaFor: (address: string) => BalanceDelta,
        height: number
    ): Promise<void> {
        if (spends.length === 0) return;
        // Outputs created in this block are already inserted in the same transaction, so they are found too.
        const byKey = new Map<string, { ID: string; owner: string; value: unknown; tokenType: string; spentAtTransaction_ID: string | null }>();
        const hashes = [...new Set(spends.map(s => s.intentHash))];
        for (let i = 0; i < hashes.length; i += SPEND_LOOKUP_CHUNK) {
            const rows = await tx.run(
                SELECT.from(UnshieldedUtxos)
                    .columns('ID', 'owner', 'value', 'tokenType', 'intentHash', 'outputIndex', 'spentAtTransaction_ID')
                    .where({ intentHash: { in: hashes.slice(i, i + SPEND_LOOKUP_CHUNK) } })
            ) || [];
            for (const r of rows) byKey.set(`${r.intentHash}#${Number(r.outputIndex)}`, r);
        }
        const spentBy = new Map<string, string[]>();
        for (const spend of spends) {
            const row = byKey.get(`${spend.intentHash}#${spend.outputIndex}`);
            if (!row) {
                // Normal when the output was created before the first indexed block.
                log.debug(`spent UTXO ${spend.intentHash}#${spend.outputIndex} at height ${height} was never indexed`);
                continue;
            }
            if (row.spentAtTransaction_ID) continue;
            row.spentAtTransaction_ID = spend.txId;
            const ids = spentBy.get(spend.txId) ?? [];
            ids.push(row.ID);
            spentBy.set(spend.txId, ids);
            if (row.tokenType !== NIGHT_RAW_TOKEN_TYPE) continue;
            const delta = deltaFor(row.owner);
            delta.balance -= this.toBigInt(row.value);
            delta.utxoCount -= 1;
        }
        for (const [txId, ids] of spentBy) {
            await tx.run(UPDATE.entity(UnshieldedUtxos).set({ spentAtTransaction_ID: txId }).where({ ID: { in: ids } }));
        }
    }

    /**
     * Must give the same result as `recomputeNightBalance` in rollback.ts,
     * which rebuilds the values from scratch after a reorg.
     */
    private async applyBalanceDelta(tx: DbRunner, address: string, delta: BalanceDelta, height: number): Promise<void> {
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
                balance: delta.balance.toString(),
                utxoCount: delta.utxoCount,
                totalReceived: delta.totalReceived.toString(),
                txReceivedCount: delta.txReceivedCount,
                totalSent: delta.totalSent.toString(),
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
            balance: (this.toBigInt(existing.balance) + delta.balance).toString(),
            utxoCount: this.toInt(existing.utxoCount) + delta.utxoCount,
            totalReceived: (this.toBigInt(existing.totalReceived) + delta.totalReceived).toString(),
            txReceivedCount: this.toInt(existing.txReceivedCount) + delta.txReceivedCount,
            totalSent: (this.toBigInt(existing.totalSent) + delta.totalSent).toString(),
            txSentCount: this.toInt(existing.txSentCount) + delta.txSentCount,
            firstSeenHeight: Number.isFinite(priorFirstSeen) ? Math.min(priorFirstSeen, height) : height,
            lastActivityHeight: height,
            lastActivityAt: nowIso,
            lastUpdatedHeight: height,
            lastUpdatedAt: nowIso
        }).where({ address }));
    }

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

        // Not parseable, so guess by length.
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

        // A mapping named `Contracts`, from config or tests, tells deploy, call and update apart by call index.
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

    /** blake2b-256 of the raw extrinsic bytes, the standard extrinsic hash used by block explorers. */
    private hashExtrinsic(hex: string): string {
        const cleanHex = hex.startsWith('0x') ? hex.slice(2) : hex;
        const bytes = Buffer.from(cleanHex, 'hex');
        const hash = blake2b(bytes, { dkLen: 32 });
        return '0x' + bytesToHex(hash);
    }

    private async getEventRegistry(blockHash: string, specVersion: number): Promise<TypeRegistry | undefined> {
        // 0 is a valid specVersion, so no falsy check.
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
            // An empty answer comes from a pruned or lagging node, so it is treated as temporary.
            throw new Error(`No runtime metadata for block ${blockHash} (specVersion ${specVersion}): pruned or racing node`);
        }
        let registry: TypeRegistry;
        try {
            registry = new TypeRegistry();
            registry.setMetadata(new Metadata(registry, metadataHex as `0x${string}`));
        } catch (err) {
            throw new Error(`Runtime metadata for block ${blockHash} (specVersion ${specVersion}) does not decode: ${(err as Error).message}`);
        }
        // Registry and pallet map are cached together, so a block is always classified
        // with the pallet map of the runtime that produced it.
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
     * A block with extrinsics but without readable events is never stored.
     * Its UTXOs and balance changes would otherwise be missing for good.
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

    /** Never falls back to the local clock. */
    private async getBlockTimestamp(blockHash: string): Promise<number | null> {
        return this.parseTimestampHex(await this.getBlockTimestampHex(blockHash));
    }

    private async getBlockTimestampHex(blockHash: string): Promise<string | null> {
        try {
            return (await this.nodeProvider.getStorage(BlockProcessor.TIMESTAMP_STORAGE_KEY, blockHash)) ?? null;
        } catch (err) {
            log.warn(`Failed to read on-chain timestamp for ${blockHash}: ${(err as Error).message}`);
            return null;
        }
    }

    private async getLastRuntimeUpgradeHex(blockHash: string): Promise<string | null> {
        try {
            return (await this.nodeProvider.getStorage(BlockProcessor.LAST_RUNTIME_UPGRADE_STORAGE_KEY, blockHash)) ?? null;
        } catch (err) {
            log.warn(`Failed to read LastRuntimeUpgrade for ${blockHash}: ${(err as Error).message}`);
            return null;
        }
    }

    /**
     * The node is asked for the runtime version once per `System.LastRuntimeUpgrade` value, because the call is expensive.
     * An answer that differs from the decoded value is used for that block only and not cached.
     * This happens on the block that performs an upgrade, which still carries the old value.
     * Without a stored value, the node is asked for every block.
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
            // A failed lookup is not cached, so the next block with this value asks again.
            fresh.answer.catch(() => {
                if (this.specVersionByUpgrade.get(upgradeHex) === fresh) this.specVersionByUpgrade.delete(upgradeHex);
            });
            lookup = fresh;
        }
        const { specVersion, agreed } = await lookup.answer;
        // A differing answer applies only to the block that asked. Other blocks ask for themselves.
        if (agreed || lookup.blockHash === blockHash) return specVersion;
        return this.getProtocolVersion(blockHash, where);
    }

    /** Reads `spec_version` from a SCALE `LastRuntimeUpgradeInfo`. Null if the bytes do not decode. */
    static decodeLastRuntimeUpgrade(hex: string): number | null {
        const bytes = Buffer.from(hex.startsWith('0x') ? hex.slice(2) : hex, 'hex');
        if (bytes.length === 0) return null;
        switch (bytes[0] & 0b11) {
            case 0: return bytes[0] >>> 2;
            case 1: return bytes.length >= 2 ? bytes.readUInt16LE(0) >>> 2 : null;
            case 2: return bytes.length >= 4 ? bytes.readUInt32LE(0) >>> 2 : null;
            default: return null; // big-integer mode, not a u32
        }
    }

    /** The expensive call. Used only for the first block of each runtime. */
    private async getProtocolVersion(blockHash: string, where: string = `block ${blockHash}`): Promise<number> {
        let rv: { specVersion?: number } | null | undefined;
        try {
            rv = await this.nodeProvider.getRuntimeVersion(blockHash);
        } catch (err) {
            throw new Error(`No runtime version for ${where}: ${(err as Error).message}`);
        }
        return this.specVersionFromBatch(rv, where);
    }

    /** Returns `engineId:data` of the PreRuntime digest log, which has type 6. Otherwise the first log. */
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
