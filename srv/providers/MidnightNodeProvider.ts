/**
 * Substrate JSON-RPC 2.0 WebSocket client for a Midnight node: the crawler's
 * data source, independent of the hosted Midnight Indexer.
 */

import WebSocket from 'ws';
import cds from '@sap/cds';
import { redactUrlCredentials } from '../utils/redact-url';
const log = cds.log('nightgate:node');

export interface NodeProviderConfig {
    nodeUrl: string;          // ws://localhost:9944
    requestTimeout?: number;  // ms, default 30000
    reconnectInterval?: number; // ms, default 5000
    maxReconnectAttempts?: number; // default 10
    pingInterval?: number; // ms, default 30000; 0 = off. No pong within one interval closes the socket.
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

/** Reconnect delay = reconnectInterval x min(attempt, this): 5 s x 12 = one attempt a minute in a long outage. */
const MAX_RECONNECT_DELAY_FACTOR = 12;

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
    private heartbeat: ReturnType<typeof setInterval> | null = null;
    private alive = true;

    constructor(config: NodeProviderConfig) {
        this.config = {
            nodeUrl: config.nodeUrl,
            requestTimeout: config.requestTimeout || 30000,
            reconnectInterval: config.reconnectInterval || 5000,
            maxReconnectAttempts: config.maxReconnectAttempts || 10,
            pingInterval: config.pingInterval ?? 30000
        };
    }

    async connect(): Promise<void> {
        return new Promise((resolve, reject) => {
            try {
                const ws = new WebSocket(this.config.nodeUrl);
                this.ws = ws;

                this.ws.on('open', () => {
                    this.connected = true;
                    this.reconnecting = false;
                    this.reconnectAttempts = 0;
                    this.reconnectAbandonSignalled = false;
                    log.info(`Connected to ${redactUrlCredentials(this.config.nodeUrl)}`);
                    this.startHeartbeat(ws);
                    resolve();
                });

                this.ws.on('message', (data: WebSocket.Data) => {
                    this.alive = true;
                    this.handleMessage(data.toString());
                });

                this.ws.on('pong', () => { this.alive = true; });

                this.ws.on('error', (error: Error) => {
                    log.error('WebSocket error:', error.message);
                    if (!this.connected) {
                        reject(error);
                    }
                });

                this.ws.on('close', () => {
                    this.stopHeartbeat();
                    const wasConnected = this.connected;
                    this.connected = false;
                    this.rejectAllPending('Connection closed');
                    this.subscriptions.clear();
                    this.orphanNotifications.clear();

                    if (!wasConnected) {
                        reject(new Error(`WebSocket closed before connection established to ${redactUrlCredentials(this.config.nodeUrl)}`));
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

    /**
     * A half-open socket (dropped by NAT or a proxy without a close) never errors
     * on its own; terminating it after one silent interval lets the reconnect run.
     */
    private startHeartbeat(socket: WebSocket): void {
        this.stopHeartbeat();
        this.alive = true;
        if (this.config.pingInterval <= 0) return;
        this.heartbeat = setInterval(() => {
            if (!this.alive) {
                log.warn(`No answer from ${redactUrlCredentials(this.config.nodeUrl)} within ${this.config.pingInterval}ms; closing the socket`);
                this.stopHeartbeat();
                socket.terminate();
                return;
            }
            this.alive = false;
            try { socket.ping(); } catch { /* the close handler takes over */ }
        }, this.config.pingInterval);
    }

    private stopHeartbeat(): void {
        if (this.heartbeat) {
            clearInterval(this.heartbeat);
            this.heartbeat = null;
        }
    }

    async disconnect(): Promise<void> {
        this.reconnecting = false;
        this.stopHeartbeat();

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

    setOnReconnect(callback: () => Promise<void>): void {
        this.onReconnectCallback = callback;
    }

    /** Called once per outage when maxReconnectAttempts is exceeded; reconnecting continues. */
    setOnReconnectFailed(callback: () => void): void {
        this.onReconnectFailedCallback = callback;
    }

    /** True once the abandonment signal fired for the current outage (reset on connect). */
    private reconnectAbandonSignalled = false;

    private attemptReconnect(): void {
        if (this.reconnecting) return;
        // Never give up on the node: past maxReconnectAttempts signal once (the
        // crawler marks the sync errored) and keep retrying at a capped delay.
        // Stopping would freeze the index while resumeCrawler says "running".
        if (this.reconnectAttempts >= this.config.maxReconnectAttempts && !this.reconnectAbandonSignalled) {
            log.error(`Max reconnect attempts (${this.config.maxReconnectAttempts}) reached`);
            log.error(`Node unreachable after ${this.config.maxReconnectAttempts} attempts; sync marked errored, reconnecting continues every ${this.config.reconnectInterval * MAX_RECONNECT_DELAY_FACTOR}ms`);
            this.reconnectAbandonSignalled = true;
            if (this.onReconnectFailedCallback) {
                try { this.onReconnectFailedCallback(); } catch { /* best-effort signal */ }
            }
        }

        this.reconnecting = true;
        this.reconnectAttempts++;

        const delay = this.config.reconnectInterval * Math.min(this.reconnectAttempts, MAX_RECONNECT_DELAY_FACTOR);
        log.info(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

        this.reconnectTimer = setTimeout(async () => {
            this.reconnectTimer = null;
            try {
                await this.connect();
                log.info('Reconnected successfully');
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

    /** Sends the calls as one JSON-RPC batch frame; results in input order, rejects if any call errors. */
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
                    reject(new Error(`RPC timeout: ${req.method} (${this.config.requestTimeout}ms) in a batch frame of ${requests.length} calls`));
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

        if (Array.isArray(parsed)) {
            for (const msg of parsed) {
                this.handleSingleMessage(msg as JsonRpcResponse);
            }
            return;
        }
        this.handleSingleMessage(parsed as JsonRpcResponse);
    }

    private handleSingleMessage(message: JsonRpcResponse): void {
        if (message.method && message.params?.subscription) {
            const callback = this.subscriptions.get(message.params.subscription);
            if (callback) {
                this.invokeSubscriptionCallback(callback, message.params.result);
            } else {
                // Substrate replays the current head before subscribe*() knows the
                // id; buffer it for registerSubscription so it is not dropped.
                const buf = this.orphanNotifications.get(message.params.subscription) ?? [];
                buf.push(message.params.result);
                this.orphanNotifications.set(message.params.subscription, buf);
            }
            return;
        }

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

    async getLatestHeader(): Promise<BlockHeader> {
        return this.rpc('chain_getHeader');
    }

    async getHeader(hash?: string): Promise<BlockHeader> {
        return this.rpc('chain_getHeader', hash ? [hash] : []);
    }

    async getBlock(hash: string): Promise<SignedBlock> {
        return this.rpc('chain_getBlock', [hash]);
    }

    async getBlockHash(height: number): Promise<string> {
        return this.rpc('chain_getBlockHash', [height]);
    }

    async getFinalizedHead(): Promise<string> {
        return this.rpc('chain_getFinalizedHead');
    }

    async getStorage(key: string, blockHash?: string): Promise<string | null> {
        return this.rpc('state_getStorage', blockHash ? [key, blockHash] : [key]);
    }

    async getRuntimeVersion(blockHash?: string): Promise<RuntimeVersion> {
        return this.rpc('state_getRuntimeVersion', blockHash ? [blockHash] : []);
    }

    /** SCALE-encoded runtime metadata. */
    async getMetadata(blockHash?: string): Promise<string> {
        return this.rpc('state_getMetadata', blockHash ? [blockHash] : []);
    }

    async health(): Promise<{ peers: number; isSyncing: boolean; shouldHavePeers: boolean }> {
        return this.rpc('system_health');
    }

    async chain(): Promise<string> {
        return this.rpc('system_chain');
    }

    async name(): Promise<string> {
        return this.rpc('system_name');
    }

    async version(): Promise<string> {
        return this.rpc('system_version');
    }

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

    /** Sets the callback, then drains notifications buffered before the id was known. */
    private registerSubscription(subscriptionId: string, callback: SubscriptionCallback): void {
        this.subscriptions.set(subscriptionId, callback);
        const buffered = this.orphanNotifications.get(subscriptionId);
        if (buffered) {
            this.orphanNotifications.delete(subscriptionId);
            for (const result of buffered) this.invokeSubscriptionCallback(callback, result);
        }
    }

    async subscribeNewHeads(callback: (header: BlockHeader) => void): Promise<string> {
        const subscriptionId = await this.rpc('chain_subscribeNewHeads', []);
        this.registerSubscription(subscriptionId, callback);
        return subscriptionId;
    }

    async subscribeFinalizedHeads(callback: (header: BlockHeader) => void): Promise<string> {
        const subscriptionId = await this.rpc('chain_subscribeFinalizedHeads', []);
        this.registerSubscription(subscriptionId, callback);
        return subscriptionId;
    }

    async unsubscribeNewHeads(subscriptionId: string): Promise<boolean> {
        this.subscriptions.delete(subscriptionId);
        return this.rpc('chain_unsubscribeNewHeads', [subscriptionId]);
    }

    async unsubscribeFinalizedHeads(subscriptionId: string): Promise<boolean> {
        this.subscriptions.delete(subscriptionId);
        return this.rpc('chain_unsubscribeFinalizedHeads', [subscriptionId]);
    }

    static parseBlockNumber(hex: string): number {
        const n = parseInt(hex, 16);
        if (isNaN(n)) {
            throw new Error(`Invalid block number hex: "${hex}"`);
        }
        return n;
    }

    getPendingRequestCount(): number {
        return this.pendingRequests.size;
    }

    getSubscriptionCount(): number {
        return this.subscriptions.size;
    }
}
