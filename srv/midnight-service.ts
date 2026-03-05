/**
 * Midnight Service Implementation — ODATANO-NIGHT Indexer
 *
 * ODATANO-NIGHT IS the indexer. It crawls blocks directly from a Midnight Node
 * via Substrate RPC (ws://localhost:9944) and stores them in local SQLite.
 * OData queries run against the local DB.
 *
 * Data flow: Midnight Node → Crawler → SQLite → OData V4
 */

import cds, { Request } from '@sap/cds';
const { SELECT, INSERT, UPDATE } = cds.ql;
import { getEncryptionKey, encrypt, hashViewingKey } from './utils/crypto';
import { validateViewingKey } from './utils/validation';
import { RateLimiter } from './utils/rate-limiter';

// Type-only imports — these types describe the IndexerProvider's data shapes.
// They are used by transformers and syncBlock. The actual IndexerProvider is gone.
import type {
    Block,
    Transaction,
    ContractAction,
    RegularTransaction,
    SystemParameters,
    DustGenerationStatus as DustGenStatus,
    ContractCall,
    ContractBalance,
    TransactionResult,
    TransactionFees as IndexerTransactionFees,
    ZswapLedgerEvent,
    DustLedgerEvent
} from './lib/midnight-client';

// ============================================================================
// Type Definitions for CAP Entities
// ============================================================================

interface BlockEntity {
    ID: string;
    hash: string;
    height: number;
    protocolVersion: number;
    timestamp: number;
    author?: string;
    ledgerParameters: string;
    parent_ID?: string;
    systemParameters_ID?: string;
}

interface TransactionEntity {
    ID: string;
    transactionId: number;
    hash: string;
    protocolVersion: number;
    raw?: string;
    transactionType: 'REGULAR' | 'SYSTEM';
    merkleTreeRoot?: string;
    startIndex?: number;
    endIndex?: number;
    identifiers?: string;
    block_ID?: string;
}

interface ContractActionEntity {
    ID: string;
    address: string;
    state?: string;
    zswapState?: string;
    actionType: 'DEPLOY' | 'CALL' | 'UPDATE';
    entryPoint?: string;
    transaction_ID?: string;
    deploy_ID?: string;
}

interface UnshieldedUtxoEntity {
    ID: string;
    owner: string;
    tokenType: string;
    value: string;
    intentHash: string;
    outputIndex: number;
    ctime?: number;
    initialNonce: string;
    registeredForDustGeneration: boolean;
    createdAtTransaction_ID?: string;
    spentAtTransaction_ID?: string;
}

interface SystemParametersEntity {
    ID: string;
    validFrom: string;
    validTo?: string;
    numPermissionedCandidates: number;
    numRegisteredCandidates: number;
    termsHash?: string;
    termsUrl?: string;
}

interface DustGenerationStatusEntity {
    ID: string;
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

interface WalletSessionEntity {
    ID: string;
    viewingKeyHash: string;
    encryptedViewingKey: string;
    sessionToken: string;
    sessionId: string;
    connectedAt: string;
    disconnectedAt?: string;
    expiresAt?: string;
    isActive: boolean;
}

// ============================================================================
// Service Implementation
// ============================================================================

export default class MidnightService extends cds.ApplicationService {
    private static _crawlerStarted = false;  // Prevent duplicate crawler starts across service instances
    private db!: any;

    async init(): Promise<void> {
        const midnightConfig = (cds.env as any).requires?.midnight || {};

        this.db = await cds.connect.to('db');

        // ====================================================================
        // Block Handlers
        // ====================================================================

        this.on('READ', 'Blocks', async (req: Request) => {
            return this.handleBlocksRead(req);
        });

        this.on('latest', 'Blocks', async () => {
            return this.db.run(
                SELECT.one.from('midnight.Blocks').orderBy('height desc')
            );
        });

        this.on('byHeight', 'Blocks', async (req: Request) => {
            const { height } = req.data as { height: number };
            return this.db.run(
                SELECT.one.from('midnight.Blocks').where({ height })
            );
        });

        // ====================================================================
        // Transaction Handlers
        // ====================================================================

        this.on('READ', 'Transactions', async (req: Request) => {
            return this.handleTransactionsRead(req);
        });

        this.on('byHash', 'Transactions', async (req: Request) => {
            const { hash } = req.data as { hash: string };
            return this.db.run(SELECT.from('midnight.Transactions').where({ hash }));
        });

        // ====================================================================
        // Contract Handlers
        // ====================================================================

        this.on('READ', 'ContractActions', async (req: Request) => {
            return this.handleContractActionsRead(req);
        });

        this.on('byAddress', 'ContractActions', async (req: Request) => {
            const { address } = req.data as { address: string };
            return this.db.run(
                SELECT.from('midnight.ContractActions').where({ address })
            );
        });

        this.on('history', 'ContractActions', async (req: Request) => {
            const { address } = req.data as { address: string };
            return this.db.run(
                SELECT.from('midnight.ContractActions')
                    .where({ address })
                    .orderBy('createdAt desc')
                    .limit(100)
            );
        });

        // ====================================================================
        // UTXO Handlers
        // ====================================================================

        this.on('READ', 'UnshieldedUtxos', async (req: Request) => {
            return this.handleUtxosRead(req);
        });

        this.on('byOwner', 'UnshieldedUtxos', async (req: Request) => {
            const { owner } = req.data as { owner: string };
            return this.db.run(SELECT.from('midnight.UnshieldedUtxos').where({ owner }));
        });

        this.on('unspent', 'UnshieldedUtxos', async () => {
            return this.db.run(
                SELECT.from('midnight.UnshieldedUtxos').where({ spentAtTransaction_ID: null })
            );
        });

        // ====================================================================
        // Governance Handlers
        // ====================================================================

        this.on('READ', 'SystemParameters', async (req: Request) => {
            return this.handleSystemParametersRead(req);
        });

        this.on('current', 'SystemParameters', async () => {
            return this.db.run(
                SELECT.one.from('midnight.SystemParameters')
                    .orderBy('validFrom desc')
            );
        });

        this.on('READ', 'DParameterHistory', async (req: Request) => {
            return this.db.run(req.query) || [];
        });

        this.on('READ', 'TermsAndConditionsHistory', async (req: Request) => {
            return this.db.run(req.query) || [];
        });

        // ====================================================================
        // DUST Generation Handlers
        // ====================================================================

        this.on('READ', 'DustGenerationStatus', async (req: Request) => {
            return this.handleDustGenerationRead(req);
        });

        this.on('byCardanoAddress', 'DustGenerationStatus', async (req: Request) => {
            const { address } = req.data as { address: string };
            return this.db.run(
                SELECT.one.from('midnight.DustGenerationStatus')
                    .where({ cardanoRewardAddress: address })
            );
        });

        this.on('byCardanoAddresses', 'DustGenerationStatus', async (req: Request) => {
            const { addresses } = req.data as { addresses: string[] };
            return this.db.run(
                SELECT.from('midnight.DustGenerationStatus')
                    .where({ cardanoRewardAddress: { in: addresses } })
            );
        });

        // ====================================================================
        // Session Management Handlers
        // ====================================================================

        const walletRateLimiter = new RateLimiter({
            windowMs: 60 * 1000,   // 1-minute window
            maxRequests: 10         // Max 10 connect attempts per minute per client
        });

        this.on('connectWallet', 'WalletSessions', async (req: Request) => {
            // Rate limiting
            const clientKey = (req as any)?._.req?.ip || 'global';
            const rateResult = walletRateLimiter.check(clientKey);
            if (!rateResult.allowed) {
                return req.reject(429, `Rate limited. Retry after ${Math.ceil(rateResult.retryAfterMs / 1000)}s`);
            }

            const { viewingKey } = req.data as { viewingKey: string };

            // Input validation
            const validationError = validateViewingKey(viewingKey);
            if (validationError) {
                return req.reject(400, validationError);
            }

            // Encrypt viewing key at rest
            const encKey = getEncryptionKey();
            const vkHash = hashViewingKey(viewingKey);
            const encryptedVk = encrypt(viewingKey, encKey);
            const sessionToken = cds.utils.uuid();

            // Compute TTL
            const midnightConfig = (cds.env as any).requires?.midnight || {};
            const sessionTtlMs = midnightConfig.sessionTtlMs || 24 * 60 * 60 * 1000; // 24h default
            const expiresAt = new Date(Date.now() + sessionTtlMs).toISOString();

            const session: WalletSessionEntity = {
                ID: cds.utils.uuid(),
                sessionId: cds.utils.uuid(),
                viewingKeyHash: vkHash,
                encryptedViewingKey: encryptedVk,
                sessionToken,
                connectedAt: new Date().toISOString(),
                expiresAt,
                isActive: true
            };

            await this.db.run(INSERT.into('midnight.WalletSessions').entries(session));

            // Return only safe fields — no viewing key, no encrypted key
            return {
                ID: session.ID,
                sessionId: session.sessionId,
                sessionToken,
                connectedAt: session.connectedAt,
                expiresAt: session.expiresAt,
                isActive: true
            };
        });

        this.on('disconnectWallet', 'WalletSessions', async (req: Request) => {
            const sessionId = String(req.params[0]);

            try {
                const session = await this.db.run(
                    SELECT.one.from('midnight.WalletSessions').where({ ID: sessionId })
                ) as WalletSessionEntity | null;

                if (!session) {
                    req.error?.(404, 'Session not found');
                    return;
                }

                // Check if session is already expired
                if (session.expiresAt && new Date(session.expiresAt) < new Date()) {
                    await this.db.run(
                        UPDATE.entity('midnight.WalletSessions')
                            .set({ isActive: false, encryptedViewingKey: null })
                            .where({ ID: sessionId })
                    );
                    req.error?.(410, 'Session expired');
                    return;
                }

                await this.db.run(
                    UPDATE.entity('midnight.WalletSessions')
                        .set({
                            disconnectedAt: new Date().toISOString(),
                            isActive: false,
                            encryptedViewingKey: null  // Clear encrypted key on disconnect
                        })
                        .where({ ID: sessionId })
                );
            } catch (error) {
                const message = error instanceof Error ? error.message : 'Unknown error';
                req.error?.(500, `Failed to disconnect: ${message}`);
            }
        });

        // ====================================================================
        // Read-only Enforcement
        // ====================================================================

        this.before(['CREATE', 'UPDATE', 'DELETE'], [
            'Blocks', 'Transactions', 'ContractActions', 'UnshieldedUtxos',
            'ZswapLedgerEvents', 'DustLedgerEvents', 'SystemParameters',
            'DParameterHistory', 'TermsAndConditionsHistory', 'DustGenerationStatus'
        ], (req: Request) => {
            req.reject?.(405, 'Blockchain data is read-only');
        });

        // Periodic cleanup of expired wallet sessions (every 15 minutes)
        const SESSION_CLEANUP_INTERVAL = 15 * 60 * 1000;
        const cleanupTimer = setInterval(async () => {
            try {
                await this.db.run(
                    UPDATE.entity('midnight.WalletSessions')
                        .set({ isActive: false, encryptedViewingKey: null })
                        .where({ isActive: true, expiresAt: { '<': new Date().toISOString() } })
                );
            } catch { /* ignore cleanup errors */ }
        }, SESSION_CLEANUP_INTERVAL);
        if (typeof cleanupTimer.unref === 'function') {
            cleanupTimer.unref(); // Don't keep process alive just for cleanup
        }

        await super.init();

        // Start Crawler — ODATANO-NIGHT IS the indexer.
        // Guard: only start once (multiple CDS services share this implementation file)
        if (MidnightService._crawlerStarted) return;
        MidnightService._crawlerStarted = true;

        const crawlerConfig = midnightConfig.crawler || {};
        const nodeUrl = crawlerConfig.nodeUrl || midnightConfig.nodeUrl || 'ws://localhost:9944';

        if (crawlerConfig.enabled !== false) {
            this.startCrawler({ ...crawlerConfig, enabled: true, nodeUrl }).catch(err => {
                console.warn(`[MidnightService] Node not reachable at ${nodeUrl}: ${err.message || err}`);
                console.log('[MidnightService] Running in offline mode — start a Midnight node: docker compose -f docker/docker-compose.yml up -d');
            });
        }
    }

    // ========================================================================
    // Read Handlers — all queries run against local SQLite (populated by crawler)
    // ========================================================================

    private async handleBlocksRead(req: Request): Promise<any> {
        return await this.db.run(req.query) || [];
    }

    private async handleTransactionsRead(req: Request): Promise<any> {
        return await this.db.run(req.query) || [];
    }

    private async handleContractActionsRead(req: Request): Promise<any> {
        return await this.db.run(req.query) || [];
    }

    private async handleUtxosRead(req: Request): Promise<any> {
        return await this.db.run(req.query) || [];
    }

    private async handleSystemParametersRead(req: Request): Promise<any> {
        return await this.db.run(req.query) || [];
    }

    private async handleDustGenerationRead(req: Request): Promise<any> {
        return await this.db.run(req.query) || [];
    }

    // ========================================================================
    // Data Transformation (used by syncBlock for programmatic block ingestion)
    // ========================================================================

    private transformBlock(block: Block): BlockEntity {
        return {
            ID: cds.utils.uuid(),
            hash: block.hash,
            height: block.height,
            protocolVersion: block.protocolVersion,
            timestamp: block.timestamp,
            author: block.author,
            ledgerParameters: block.ledgerParameters
        };
    }

    private transformTransaction(tx: Transaction): TransactionEntity {
        const regularTx = tx as RegularTransaction;
        const isRegular = regularTx.merkleTreeRoot !== undefined;

        return {
            ID: cds.utils.uuid(),
            transactionId: tx.id,
            hash: tx.hash,
            protocolVersion: tx.protocolVersion,
            raw: tx.raw,
            transactionType: isRegular ? 'REGULAR' : 'SYSTEM',
            merkleTreeRoot: regularTx.merkleTreeRoot,
            startIndex: regularTx.startIndex,
            endIndex: regularTx.endIndex,
            identifiers: regularTx.identifiers ? JSON.stringify(regularTx.identifiers) : undefined
        };
    }

    private transformContractAction(action: ContractAction): ContractActionEntity {
        const callAction = action as ContractCall;
        let actionType: 'DEPLOY' | 'CALL' | 'UPDATE' = 'UPDATE';

        if (callAction.entryPoint !== undefined) {
            actionType = 'CALL';
        } else if (!callAction.deploy) {
            actionType = 'DEPLOY';
        }

        return {
            ID: cds.utils.uuid(),
            address: action.address,
            state: action.state,
            zswapState: action.zswapState,
            actionType: actionType,
            entryPoint: callAction.entryPoint
        };
    }

    private transformTransactionResult(result: TransactionResult): {
        entity: { ID: string; status: string };
        segments: { ID: string; segmentId: number; success: boolean; transactionResult_ID: string }[];
    } {
        const id = cds.utils.uuid();
        const segments = (result.segments || []).map(seg => ({
            ID: cds.utils.uuid(),
            segmentId: seg.id,
            success: seg.success,
            transactionResult_ID: id
        }));

        return {
            entity: { ID: id, status: result.status },
            segments
        };
    }

    private transformTransactionFees(fees: IndexerTransactionFees): {
        ID: string;
        paidFees: string;
        estimatedFees: string;
    } {
        return {
            ID: cds.utils.uuid(),
            paidFees: fees.paidFees,
            estimatedFees: fees.estimatedFees
        };
    }

    private transformContractBalance(balance: ContractBalance): {
        ID: string;
        tokenType: string;
        amount: string;
    } {
        return {
            ID: cds.utils.uuid(),
            tokenType: balance.tokenType,
            amount: balance.amount
        };
    }

    private transformZswapLedgerEvent(event: ZswapLedgerEvent): {
        ID: string;
        eventId: number;
        raw: string;
        maxId: number;
    } {
        return {
            ID: cds.utils.uuid(),
            eventId: event.id,
            raw: event.raw,
            maxId: event.maxId
        };
    }

    private transformDustLedgerEvent(event: DustLedgerEvent): {
        ID: string;
        eventId: number;
        raw: string;
        maxId: number;
        eventType: string;
        dustOutputNonce?: string;
    } {
        return {
            ID: cds.utils.uuid(),
            eventId: event.id,
            raw: event.raw,
            maxId: event.maxId,
            eventType: (event as any).output?.nonce ? 'INITIAL_UTXO' : 'DTIME_UPDATE',
            dustOutputNonce: (event as any).output?.nonce
        };
    }

    private transformSystemParameters(params: SystemParameters): SystemParametersEntity {
        return {
            ID: cds.utils.uuid(),
            validFrom: new Date().toISOString(),
            numPermissionedCandidates: params.dParameter.numPermissionedCandidates,
            numRegisteredCandidates: params.dParameter.numRegisteredCandidates,
            termsHash: params.termsAndConditions?.hash,
            termsUrl: params.termsAndConditions?.url
        };
    }

    private transformDustGenerationStatus(status: DustGenStatus): DustGenerationStatusEntity {
        return {
            ID: cds.utils.uuid(),
            cardanoRewardAddress: status.cardanoRewardAddress,
            dustAddress: status.dustAddress,
            registered: status.registered,
            nightBalance: status.nightBalance,
            generationRate: status.generationRate,
            maxCapacity: status.maxCapacity,
            currentCapacity: status.currentCapacity,
            utxoTxHash: status.utxoTxHash,
            utxoOutputIndex: status.utxoOutputIndex
        };
    }

    // ========================================================================
    // Data Synchronization — Atomic Block Sync
    // ========================================================================

    async syncBlock(blockData: Block): Promise<BlockEntity> {
        // Check if block already exists
        const existing = await this.db.run(
            SELECT.one.from('midnight.Blocks').where({ hash: blockData.hash })
        ) as BlockEntity | null;

        if (existing) return existing;

        // Transform block
        const block = this.transformBlock(blockData);

        // Atomic write — all or nothing
        await this.db.tx(async (tx: any) => {
            // 1. Insert block
            await tx.run(INSERT.into('midnight.Blocks').entries(block));

            // 2. Sync system parameters
            if (blockData.systemParameters) {
                const sysParams = this.transformSystemParameters(blockData.systemParameters);
                (sysParams as any).block_ID = block.ID;
                block.systemParameters_ID = sysParams.ID;
                await tx.run(INSERT.into('midnight.SystemParameters').entries(sysParams));
                await tx.run(
                    UPDATE.entity('midnight.Blocks')
                        .set({ systemParameters_ID: sysParams.ID })
                        .where({ ID: block.ID })
                );
            }

            // 3. Sync transactions
            if (blockData.transactions) {
                for (const txData of blockData.transactions) {
                    const txEntity = this.transformTransaction(txData);
                    txEntity.block_ID = block.ID;
                    await tx.run(INSERT.into('midnight.Transactions').entries(txEntity));

                    const regularTx = txData as RegularTransaction;
                    const isRegular = regularTx.merkleTreeRoot !== undefined;

                    // 3a. Transaction result + segments (regular txs only)
                    if (isRegular && regularTx.transactionResult) {
                        const { entity: resultEntity, segments } =
                            this.transformTransactionResult(regularTx.transactionResult);
                        (resultEntity as any).transaction_ID = txEntity.ID;
                        await tx.run(INSERT.into('midnight.TransactionResults').entries(resultEntity));

                        for (const seg of segments) {
                            await tx.run(INSERT.into('midnight.TransactionSegments').entries(seg));
                        }
                    }

                    // 3b. Transaction fees (regular txs only)
                    if (isRegular && regularTx.fees) {
                        const feesEntity = this.transformTransactionFees(regularTx.fees);
                        (feesEntity as any).transaction_ID = txEntity.ID;
                        await tx.run(INSERT.into('midnight.TransactionFees').entries(feesEntity));
                    }

                    // 3c. Contract actions
                    if (txData.contractActions) {
                        for (const actionData of txData.contractActions) {
                            const action = this.transformContractAction(actionData);
                            action.transaction_ID = txEntity.ID;
                            await tx.run(INSERT.into('midnight.ContractActions').entries(action));

                            // 3c-i. Contract balances
                            if (actionData.unshieldedBalances) {
                                for (const balance of actionData.unshieldedBalances) {
                                    const balanceEntity = this.transformContractBalance(balance);
                                    (balanceEntity as any).contractAction_ID = action.ID;
                                    await tx.run(INSERT.into('midnight.ContractBalances').entries(balanceEntity));
                                }
                            }
                        }
                    }

                    // 3d. Unshielded UTXOs (created)
                    if (txData.unshieldedCreatedOutputs) {
                        for (const utxoData of txData.unshieldedCreatedOutputs) {
                            const utxo: UnshieldedUtxoEntity = {
                                ID: cds.utils.uuid(),
                                owner: utxoData.owner,
                                tokenType: utxoData.tokenType,
                                value: utxoData.value,
                                intentHash: utxoData.intentHash,
                                outputIndex: utxoData.outputIndex,
                                ctime: utxoData.ctime,
                                initialNonce: utxoData.initialNonce,
                                registeredForDustGeneration: utxoData.registeredForDustGeneration,
                                createdAtTransaction_ID: txEntity.ID
                            };
                            await tx.run(INSERT.into('midnight.UnshieldedUtxos').entries(utxo));
                        }
                    }

                    // 3e. Mark spent UTXOs
                    if (txData.unshieldedSpentOutputs) {
                        for (const spentUtxo of txData.unshieldedSpentOutputs) {
                            await tx.run(
                                UPDATE.entity('midnight.UnshieldedUtxos')
                                    .set({ spentAtTransaction_ID: txEntity.ID })
                                    .where({
                                        owner: spentUtxo.owner,
                                        intentHash: spentUtxo.intentHash,
                                        outputIndex: spentUtxo.outputIndex
                                    })
                            );
                        }
                    }

                    // 3f. Zswap ledger events
                    if (txData.zswapLedgerEvents) {
                        for (const event of txData.zswapLedgerEvents) {
                            const eventEntity = this.transformZswapLedgerEvent(event);
                            (eventEntity as any).transaction_ID = txEntity.ID;
                            await tx.run(INSERT.into('midnight.ZswapLedgerEvents').entries(eventEntity));
                        }
                    }

                    // 3g. DUST ledger events
                    if (txData.dustLedgerEvents) {
                        for (const event of txData.dustLedgerEvents) {
                            const eventEntity = this.transformDustLedgerEvent(event);
                            (eventEntity as any).transaction_ID = txEntity.ID;
                            await tx.run(INSERT.into('midnight.DustLedgerEvents').entries(eventEntity));
                        }
                    }
                }
            }
        });

        return block;
    }

    // ========================================================================
    // Active Crawler — Direct Substrate RPC to Midnight Node
    // ========================================================================

    private async startCrawler(crawlerConfig: any): Promise<void> {
        const { MidnightNodeProvider } = require('../lib/providers/MidnightNodeProvider');
        const { MidnightCrawler } = require('./crawler/Crawler');

        const nodeProvider = new MidnightNodeProvider({
            nodeUrl: crawlerConfig.nodeUrl || 'ws://localhost:9944',
            requestTimeout: crawlerConfig.requestTimeout || 30000
        });

        const crawler = new MidnightCrawler(nodeProvider, crawlerConfig);

        await crawler.start();
        console.log('[MidnightService] Crawler started');

        // Store references for shutdown
        (this as any)._crawler = crawler;
        (this as any)._crawlerNodeProvider = nodeProvider;
    }

    async stopCrawler(): Promise<void> {
        if ((this as any)._crawler) {
            await (this as any)._crawler.stop();
            (this as any)._crawler = null;
        }
        if ((this as any)._crawlerNodeProvider) {
            try {
                await (this as any)._crawlerNodeProvider.disconnect();
            } catch { /* ignore disconnect errors */ }
            (this as any)._crawlerNodeProvider = null;
        }
        MidnightService._crawlerStarted = false;
        console.log('[MidnightService] Crawler stopped');
    }
}
