/**
 * MidnightNodeProvider — Substrate RPC WebSocket Client
 *
 * Connects directly to a Midnight Node via Substrate JSON-RPC 2.0 over WebSocket.
 * Primary data source for the active crawler. Independent of the hosted Midnight Indexer.
 *
 * Protocol: JSON-RPC 2.0 over WebSocket (ws://node:9944)
 * Reference: Polkadot/Substrate RPC specification
 */

import WebSocket from 'ws';

// ============================================================================
// Type Definitions
// ============================================================================

export interface NodeProviderConfig {
    nodeUrl: string;          // ws://localhost:9944
    requestTimeout?: number;  // ms, default 30000
    reconnectInterval?: number; // ms, default 5000
    maxReconnectAttempts?: number; // default 10
}

export interface BlockHeader {
    parentHash: string;
    number: string;      // hex-encoded block number
    stateRoot: string;
    extrinsicsRoot: string;
    digest: {
        logs: string[];
    };
}

export interface SignedBlock {
    block: {
        header: BlockHeader;
        extrinsics: string[];  // hex-encoded extrinsics
    };
    justifications: any;
}

export interface RuntimeVersion {
    specName: string;
    implName: string;
    specVersion: number;
    implVersion: number;
    transactionVersion: number;
}

interface JsonRpcRequest {
    jsonrpc: '2.0';
    id: number;
    method: string;
    params: unknown[];
}

interface JsonRpcResponse {
    jsonrpc: '2.0';
    id?: number;
    result?: any;
    error?: { code: number; message: string; data?: any };
    method?: string;     // for subscription notifications
    params?: {           // for subscription notifications
        subscription: string;
        result: any;
    };
}

interface PendingRequest {
    resolve: (value: any) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
}

type SubscriptionCallback = (result: any) => void;

// ============================================================================
// Midnight Node Provider
// ============================================================================

export class MidnightNodeProvider {
    private ws: WebSocket | null = null;
    private requestId: number = 0;
    private pendingRequests: Map<number, PendingRequest> = new Map();
    private subscriptions: Map<string, SubscriptionCallback> = new Map();
    private connected: boolean = false;
    private reconnecting: boolean = false;
    private reconnectAttempts: number = 0;
    private config: Required<NodeProviderConfig>;
    private onReconnectCallback: (() => Promise<void>) | null = null;

    constructor(config: NodeProviderConfig) {
        this.config = {
            nodeUrl: config.nodeUrl,
            requestTimeout: config.requestTimeout || 30000,
            reconnectInterval: config.reconnectInterval || 5000,
            maxReconnectAttempts: config.maxReconnectAttempts || 10
        };
    }

    // ========================================================================
    // Connection Management
    // ========================================================================

    async connect(): Promise<void> {
        return new Promise((resolve, reject) => {
            try {
                this.ws = new WebSocket(this.config.nodeUrl);

                this.ws.on('open', () => {
                    this.connected = true;
                    this.reconnecting = false;
                    this.reconnectAttempts = 0;
                    console.log(`[MidnightNode] Connected to ${this.config.nodeUrl}`);
                    resolve();
                });

                this.ws.on('message', (data: WebSocket.Data) => {
                    this.handleMessage(data.toString());
                });

                this.ws.on('error', (error: Error) => {
                    console.error('[MidnightNode] WebSocket error:', error.message);
                    if (!this.connected) {
                        reject(error);
                    }
                });

                this.ws.on('close', () => {
                    const wasConnected = this.connected;
                    this.connected = false;
                    this.rejectAllPending('Connection closed');

                    if (wasConnected && !this.reconnecting) {
                        console.warn('[MidnightNode] Connection lost, attempting reconnect...');
                        this.attemptReconnect();
                    }
                });
            } catch (error) {
                reject(error);
            }
        });
    }

    async disconnect(): Promise<void> {
        this.reconnecting = false;
        this.rejectAllPending('Disconnecting');

        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        this.connected = false;
        this.subscriptions.clear();
        console.log('[MidnightNode] Disconnected');
    }

    isConnected(): boolean {
        return this.connected;
    }

    /**
     * Register a callback to invoke after successful reconnect.
     * Used by the Crawler to re-establish subscriptions.
     */
    setOnReconnect(callback: () => Promise<void>): void {
        this.onReconnectCallback = callback;
    }

    private attemptReconnect(): void {
        if (this.reconnecting) return;
        if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
            console.error(`[MidnightNode] Max reconnect attempts (${this.config.maxReconnectAttempts}) reached`);
            return;
        }

        this.reconnecting = true;
        this.reconnectAttempts++;

        const delay = this.config.reconnectInterval * Math.min(this.reconnectAttempts, 5);
        console.log(`[MidnightNode] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

        setTimeout(async () => {
            try {
                await this.connect();
                console.log('[MidnightNode] Reconnected successfully');
                // Notify crawler to re-establish subscriptions
                if (this.onReconnectCallback) {
                    try {
                        await this.onReconnectCallback();
                    } catch (cbErr) {
                        console.error('[MidnightNode] Reconnect callback failed:', (cbErr as Error).message);
                    }
                }
            } catch (err) {
                console.error('[MidnightNode] Reconnect failed:', (err as Error).message);
                this.reconnecting = false;
                this.attemptReconnect();
            }
        }, delay);
    }

    // ========================================================================
    // JSON-RPC 2.0 Core
    // ========================================================================

    async rpc(method: string, params: unknown[] = []): Promise<any> {
        if (!this.ws || !this.connected) {
            throw new Error('Not connected to Midnight Node');
        }

        const id = ++this.requestId;

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pendingRequests.delete(id);
                reject(new Error(`RPC timeout: ${method} (${this.config.requestTimeout}ms)`));
            }, this.config.requestTimeout);

            this.pendingRequests.set(id, { resolve, reject, timeout });

            const request: JsonRpcRequest = {
                jsonrpc: '2.0',
                id,
                method,
                params
            };

            this.ws!.send(JSON.stringify(request));
        });
    }

    private handleMessage(raw: string): void {
        let message: JsonRpcResponse;
        try {
            message = JSON.parse(raw);
        } catch {
            console.warn('[MidnightNode] Invalid JSON message received');
            return;
        }

        // Subscription notification
        if (message.method && message.params?.subscription) {
            const callback = this.subscriptions.get(message.params.subscription);
            if (callback) {
                callback(message.params.result);
            }
            return;
        }

        // Regular RPC response
        if (message.id !== undefined) {
            const pending = this.pendingRequests.get(message.id);
            if (pending) {
                clearTimeout(pending.timeout);
                this.pendingRequests.delete(message.id);

                if (message.error) {
                    pending.reject(new Error(
                        `RPC error ${message.error.code}: ${message.error.message}`
                    ));
                } else {
                    pending.resolve(message.result);
                }
            }
        }
    }

    private rejectAllPending(reason: string): void {
        for (const [id, pending] of this.pendingRequests) {
            clearTimeout(pending.timeout);
            pending.reject(new Error(reason));
        }
        this.pendingRequests.clear();
    }

    // ========================================================================
    // Chain RPC Methods
    // ========================================================================

    /**
     * Get the latest block header
     */
    async getLatestHeader(): Promise<BlockHeader> {
        return this.rpc('chain_getHeader');
    }

    /**
     * Get a block header by hash
     */
    async getHeader(hash?: string): Promise<BlockHeader> {
        return this.rpc('chain_getHeader', hash ? [hash] : []);
    }

    /**
     * Get a full signed block by hash
     */
    async getBlock(hash: string): Promise<SignedBlock> {
        return this.rpc('chain_getBlock', [hash]);
    }

    /**
     * Get the block hash for a given height
     */
    async getBlockHash(height: number): Promise<string> {
        return this.rpc('chain_getBlockHash', [height]);
    }

    /**
     * Get the finalized block head hash
     */
    async getFinalizedHead(): Promise<string> {
        return this.rpc('chain_getFinalizedHead');
    }

    // ========================================================================
    // State RPC Methods
    // ========================================================================

    /**
     * Query runtime storage at a given key (optionally at a specific block)
     */
    async getStorage(key: string, blockHash?: string): Promise<string | null> {
        return this.rpc('state_getStorage', blockHash ? [key, blockHash] : [key]);
    }

    /**
     * Get the runtime version
     */
    async getRuntimeVersion(blockHash?: string): Promise<RuntimeVersion> {
        return this.rpc('state_getRuntimeVersion', blockHash ? [blockHash] : []);
    }

    /**
     * Get runtime metadata (SCALE-encoded)
     */
    async getMetadata(blockHash?: string): Promise<string> {
        return this.rpc('state_getMetadata', blockHash ? [blockHash] : []);
    }

    // ========================================================================
    // System RPC Methods
    // ========================================================================

    /**
     * Get node health status
     */
    async health(): Promise<{ peers: number; isSyncing: boolean; shouldHavePeers: boolean }> {
        return this.rpc('system_health');
    }

    /**
     * Get the chain name
     */
    async chain(): Promise<string> {
        return this.rpc('system_chain');
    }

    /**
     * Get the node name
     */
    async name(): Promise<string> {
        return this.rpc('system_name');
    }

    /**
     * Get the node version
     */
    async version(): Promise<string> {
        return this.rpc('system_version');
    }

    // ========================================================================
    // Subscriptions
    // ========================================================================

    /**
     * Subscribe to new block headers (finalized)
     */
    async subscribeNewHeads(callback: (header: BlockHeader) => void): Promise<string> {
        const subscriptionId = await this.rpc('chain_subscribeNewHeads', []);
        this.subscriptions.set(subscriptionId, callback);
        return subscriptionId;
    }

    /**
     * Subscribe to finalized block headers
     */
    async subscribeFinalizedHeads(callback: (header: BlockHeader) => void): Promise<string> {
        const subscriptionId = await this.rpc('chain_subscribeFinalizedHeads', []);
        this.subscriptions.set(subscriptionId, callback);
        return subscriptionId;
    }

    /**
     * Unsubscribe from new heads
     */
    async unsubscribeNewHeads(subscriptionId: string): Promise<boolean> {
        this.subscriptions.delete(subscriptionId);
        return this.rpc('chain_unsubscribeNewHeads', [subscriptionId]);
    }

    /**
     * Unsubscribe from finalized heads
     */
    async unsubscribeFinalizedHeads(subscriptionId: string): Promise<boolean> {
        this.subscriptions.delete(subscriptionId);
        return this.rpc('chain_unsubscribeFinalizedHeads', [subscriptionId]);
    }

    // ========================================================================
    // Utility
    // ========================================================================

    /**
     * Parse a hex-encoded block number to integer
     */
    static parseBlockNumber(hex: string): number {
        return parseInt(hex, 16);
    }

    /**
     * Get pending request count (for health monitoring)
     */
    getPendingRequestCount(): number {
        return this.pendingRequests.size;
    }

    /**
     * Get active subscription count
     */
    getSubscriptionCount(): number {
        return this.subscriptions.size;
    }
}
