/**
 * MidnightNodeProvider, Substrate RPC WebSocket Client
 *
 * Connects directly to a Midnight Node via Substrate JSON-RPC 2.0 over WebSocket.
 * Primary data source for the active crawler. Independent of the hosted Midnight Indexer.
 *
 * Protocol: JSON-RPC 2.0 over WebSocket (ws://node:9944)
 * Reference: Polkadot/Substrate RPC specification
 */

import WebSocket from 'ws';
import cds from '@sap/cds';
const log = cds.log('nightgate:node');

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

type SubscriptionCallback = (result: any) => void | Promise<void>;

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
    private onReconnectFailedCallback: (() => void) | null = null;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private orphanNotifications: Map<string, any[]> = new Map();

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
                    log.info(`Connected to ${this.config.nodeUrl}`);
                    resolve();
                });

                this.ws.on('message', (data: WebSocket.Data) => {
                    this.handleMessage(data.toString());
                });

                this.ws.on('error', (error: Error) => {
                    log.error('WebSocket error:', error.message);
                    if (!this.connected) {
                        reject(error);
                    }
                });

                this.ws.on('close', () => {
                    const wasConnected = this.connected;
                    this.connected = false;
                    this.rejectAllPending('Connection closed');
                    this.subscriptions.clear();
                    this.orphanNotifications.clear();

                    if (!wasConnected) {
                        // Socket closed before 'open', reject the connect() promise
                        reject(new Error(`WebSocket closed before connection established to ${this.config.nodeUrl}`));
                        return;
                    }

                    if (!this.reconnecting) {
                        log.warn('Connection lost, attempting reconnect...');
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

        // Clear any pending reconnect timer
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        this.rejectAllPending('Disconnecting');

        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        this.connected = false;
        this.subscriptions.clear();
        this.orphanNotifications.clear();
        log.info('Disconnected');
    }

    isConnected(): boolean {
        return this.connected;
    }

    /**
     * Register a callback to invoke after successful reconnect.
     */
    setOnReconnect(callback: () => Promise<void>): void {
        this.onReconnectCallback = callback;
    }

    /**
     * Register a callback invoked when reconnection is permanently abandoned
     */
    setOnReconnectFailed(callback: () => void): void {
        this.onReconnectFailedCallback = callback;
    }

    private attemptReconnect(): void {
        if (this.reconnecting) return;
        if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
            log.error(`Max reconnect attempts (${this.config.maxReconnectAttempts}) reached`);
            if (this.onReconnectFailedCallback) {
                try { this.onReconnectFailedCallback(); } catch { /* best-effort signal */ }
            }
            return;
        }

        this.reconnecting = true;
        this.reconnectAttempts++;

        const delay = this.config.reconnectInterval * Math.min(this.reconnectAttempts, 5);
        log.info(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

        this.reconnectTimer = setTimeout(async () => {
            this.reconnectTimer = null;
            try {
                await this.connect();
                log.info('Reconnected successfully');
                // Notify crawler to re-establish subscriptions
                if (this.onReconnectCallback) {
                    try {
                        await this.onReconnectCallback();
                    } catch (cbErr) {
                        log.error('Reconnect callback failed:', (cbErr as Error).message);
                    }
                }
            } catch (err) {
                log.error('Reconnect failed:', (err as Error).message);
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

    /**
     * Send multiple RPCs in a single JSON-RPC 2.0 batch request.
     *
     * One WSS frame out, one frame in. The server processes the calls in
     * parallel internally and returns a response array; we resolve each
     * caller's promise as the matching id arrives in `handleMessage`.
     *
     * Returns results in the SAME ORDER as the input requests. Throws if any
     * single sub-request errors out (matches the rpc() semantics).
     */
    async rpcBatch(requests: Array<{ method: string; params?: unknown[] }>): Promise<any[]> {
        if (!this.ws || !this.connected) {
            throw new Error('Not connected to Midnight Node');
        }
        if (requests.length === 0) return [];

        const ids: number[] = [];
        const promises: Promise<any>[] = [];

        for (const req of requests) {
            const id = ++this.requestId;
            ids.push(id);
            promises.push(new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    this.pendingRequests.delete(id);
                    reject(new Error(`RPC timeout: ${req.method} (${this.config.requestTimeout}ms)`));
                }, this.config.requestTimeout);
                this.pendingRequests.set(id, { resolve, reject, timeout });
            }));
        }

        const payload: JsonRpcRequest[] = requests.map((req, i) => ({
            jsonrpc: '2.0',
            id: ids[i],
            method: req.method,
            params: req.params ?? []
        }));

        this.ws.send(JSON.stringify(payload));
        return Promise.all(promises);
    }

    private handleMessage(raw: string): void {
        let parsed: unknown;
        try {
            parsed = JSON.parse(raw);
        } catch {
            log.warn('Invalid JSON message received');
            return;
        }

        // JSON-RPC 2.0 batch response: a top-level array of response objects.
        // Iterate and dispatch each as a normal message.
        if (Array.isArray(parsed)) {
            for (const msg of parsed) {
                this.handleSingleMessage(msg as JsonRpcResponse);
            }
            return;
        }
        this.handleSingleMessage(parsed as JsonRpcResponse);
    }

    private handleSingleMessage(message: JsonRpcResponse): void {
        // Subscription notification
        if (message.method && message.params?.subscription) {
            const callback = this.subscriptions.get(message.params.subscription);
            if (callback) {
                this.invokeSubscriptionCallback(callback, message.params.result);
            } else {
                // The notification arrived before subscribe*() registered its
                // callback (Substrate replays the current head immediately on
                // subscribe). Buffer it; registerSubscription drains it right
                // after the callback is set, so the first head is not dropped.
                const buf = this.orphanNotifications.get(message.params.subscription) ?? [];
                buf.push(message.params.result);
                this.orphanNotifications.set(message.params.subscription, buf);
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
        for (const [, pending] of this.pendingRequests) {
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

    private invokeSubscriptionCallback(callback: SubscriptionCallback, result: any): void {
        try {
            const r = callback(result);
            if (r && typeof (r as any).then === 'function') {
                void (r as Promise<any>).catch((err: unknown) => {
                    const errMsg = err instanceof Error ? err.message : String(err);
                    log.error('Subscription callback failed:', errMsg);
                });
            }
        } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            log.error('Subscription callback failed:', errMsg);
        }
    }

    /**
     * Register a subscription callback and immediately drain any notifications
     * that arrived before the id was known (see orphanNotifications), so the
     * head Substrate replays on subscribe is never lost to a timing race.
     */
    private registerSubscription(subscriptionId: string, callback: SubscriptionCallback): void {
        this.subscriptions.set(subscriptionId, callback);
        const buffered = this.orphanNotifications.get(subscriptionId);
        if (buffered) {
            this.orphanNotifications.delete(subscriptionId);
            for (const result of buffered) this.invokeSubscriptionCallback(callback, result);
        }
    }

    /**
     * Subscribe to new block headers (finalized)
     */
    async subscribeNewHeads(callback: (header: BlockHeader) => void): Promise<string> {
        const subscriptionId = await this.rpc('chain_subscribeNewHeads', []);
        this.registerSubscription(subscriptionId, callback);
        return subscriptionId;
    }

    /**
     * Subscribe to finalized block headers
     */
    async subscribeFinalizedHeads(callback: (header: BlockHeader) => void): Promise<string> {
        const subscriptionId = await this.rpc('chain_subscribeFinalizedHeads', []);
        this.registerSubscription(subscriptionId, callback);
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
        const n = parseInt(hex, 16);
        if (isNaN(n)) {
            throw new Error(`Invalid block number hex: "${hex}"`);
        }
        return n;
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
