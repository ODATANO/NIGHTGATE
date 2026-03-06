type MockWebSocketHandler = (...args: any[]) => void;

const mockWebSocketInstances: Array<{
    url: string;
    handlers: Map<string, MockWebSocketHandler[]>;
    send: jest.Mock;
    close: jest.Mock;
    on: jest.Mock;
    emit: (event: string, ...args: any[]) => void;
}> = [];

const mockWebSocket = class {
    public url: string;
    public handlers = new Map<string, MockWebSocketHandler[]>();
    public send = jest.fn();
    public close = jest.fn();
    public on = jest.fn((event: string, handler: MockWebSocketHandler) => {
        const existing = this.handlers.get(event) || [];
        existing.push(handler);
        this.handlers.set(event, existing);
        return this;
    });

    constructor(url: string) {
        this.url = url;
        mockWebSocketInstances.push(this as any);
    }

    emit(event: string, ...args: any[]) {
        for (const handler of this.handlers.get(event) || []) {
            handler(...args);
        }
    }
};

jest.mock('ws', () => ({
    __esModule: true,
    default: mockWebSocket
}));

import { MidnightNodeProvider } from '../../srv/providers/MidnightNodeProvider';

function getLatestMockWebSocket() {
    expect(mockWebSocketInstances.length).toBeGreaterThan(0);
    return mockWebSocketInstances[mockWebSocketInstances.length - 1];
}

describe('MidnightNodeProvider connection management', () => {
    beforeEach(() => {
        mockWebSocketInstances.length = 0;
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    it('connects and registers websocket lifecycle handlers', async () => {
        const provider = new MidnightNodeProvider({ nodeUrl: 'ws://localhost:9944' });
        const connectPromise = provider.connect();
        const socket = getLatestMockWebSocket();

        expect(socket.url).toBe('ws://localhost:9944');
        expect(socket.on).toHaveBeenCalledWith('open', expect.any(Function));
        expect(socket.on).toHaveBeenCalledWith('message', expect.any(Function));
        expect(socket.on).toHaveBeenCalledWith('error', expect.any(Function));
        expect(socket.on).toHaveBeenCalledWith('close', expect.any(Function));

        socket.emit('open');

        await expect(connectPromise).resolves.toBeUndefined();
        expect(provider.isConnected()).toBe(true);
    });

    it('rejects the initial connection when the websocket errors before opening', async () => {
        const provider = new MidnightNodeProvider({ nodeUrl: 'ws://localhost:9944' });
        const errorSpy = jest.spyOn(console, 'error').mockImplementation();

        try {
            const connectPromise = provider.connect();
            const socket = getLatestMockWebSocket();
            socket.emit('error', new Error('socket failed'));

            await expect(connectPromise).rejects.toThrow('socket failed');
            expect(provider.isConnected()).toBe(false);
            expect(errorSpy).toHaveBeenCalledWith('[MidnightNode] WebSocket error:', 'socket failed');
        } finally {
            errorSpy.mockRestore();
        }
    });

    it('throws when rpc is called while the provider is disconnected', async () => {
        const provider = new MidnightNodeProvider({ nodeUrl: 'ws://localhost:9944' });

        await expect(provider.rpc('system_health')).rejects.toThrow('Not connected to Midnight Node');
    });

    it('rejects all pending requests when disconnecting', async () => {
        const provider = new MidnightNodeProvider({ nodeUrl: 'ws://localhost:9944', requestTimeout: 1000 });
        const close = jest.fn();
        (provider as any).ws = { send: jest.fn(), close };
        (provider as any).connected = true;

        const promise = provider.rpc('chain_getBlock');
        const rejection = expect(promise).rejects.toThrow('Disconnecting');

        await provider.disconnect();
        await rejection;

        expect(close).toHaveBeenCalled();
        expect(provider.getPendingRequestCount()).toBe(0);
        expect(provider.isConnected()).toBe(false);
    });

    it('reconnects after a connection loss and invokes the reconnect callback', async () => {
        const provider = new MidnightNodeProvider({
            nodeUrl: 'ws://localhost:9944',
            reconnectInterval: 100,
            maxReconnectAttempts: 2
        });
        const callback = jest.fn().mockResolvedValue(undefined);

        provider.setOnReconnect(callback);

        const initialConnect = provider.connect();
        const firstSocket = getLatestMockWebSocket();
        firstSocket.emit('open');
        await initialConnect;

        firstSocket.emit('close');
        await jest.advanceTimersByTimeAsync(100);

        const secondSocket = getLatestMockWebSocket();
        secondSocket.emit('open');
        await Promise.resolve();
        await Promise.resolve();

        expect(mockWebSocketInstances).toHaveLength(2);
        expect(callback).toHaveBeenCalledTimes(1);
        expect(provider.isConnected()).toBe(true);
    });

    it('logs reconnect callback failures without breaking reconnect success', async () => {
        const provider = new MidnightNodeProvider({
            nodeUrl: 'ws://localhost:9944',
            reconnectInterval: 100,
            maxReconnectAttempts: 2
        });
        const errorSpy = jest.spyOn(console, 'error').mockImplementation();
        provider.setOnReconnect(jest.fn().mockRejectedValue(new Error('callback failed')));

        try {
            const initialConnect = provider.connect();
            const firstSocket = getLatestMockWebSocket();
            firstSocket.emit('open');
            await initialConnect;

            firstSocket.emit('close');
            await jest.advanceTimersByTimeAsync(100);

            const secondSocket = getLatestMockWebSocket();
            secondSocket.emit('open');
            await jest.advanceTimersByTimeAsync(0);
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();

            expect(errorSpy).toHaveBeenCalledWith('[MidnightNode] Reconnect callback failed:', 'callback failed');
            expect(provider.isConnected()).toBe(true);
        } finally {
            errorSpy.mockRestore();
        }
    });

    it('stops reconnect attempts once the configured limit has been reached', () => {
        const provider = new MidnightNodeProvider({
            nodeUrl: 'ws://localhost:9944',
            maxReconnectAttempts: 2
        });
        const errorSpy = jest.spyOn(console, 'error').mockImplementation();

        try {
            (provider as any).reconnectAttempts = 2;
            (provider as any).attemptReconnect();

            expect(errorSpy).toHaveBeenCalledWith('[MidnightNode] Max reconnect attempts (2) reached');
        } finally {
            errorSpy.mockRestore();
        }
    });

    it('schedules another reconnect attempt when a reconnect fails', async () => {
        const provider = new MidnightNodeProvider({
            nodeUrl: 'ws://localhost:9944',
            reconnectInterval: 100,
            maxReconnectAttempts: 2
        });
        const callback = jest.fn().mockResolvedValue(undefined);
        const connectSpy = jest.spyOn(provider, 'connect')
            .mockRejectedValueOnce(new Error('reconnect failed'))
            .mockResolvedValueOnce(undefined);
        const errorSpy = jest.spyOn(console, 'error').mockImplementation();

        provider.setOnReconnect(callback);
        (provider as any).attemptReconnect();

        await jest.advanceTimersByTimeAsync(100);
        await jest.advanceTimersByTimeAsync(200);
        await Promise.resolve();
        await Promise.resolve();

        expect(connectSpy).toHaveBeenCalledTimes(2);
        expect(callback).toHaveBeenCalledTimes(1);
        expect(errorSpy).toHaveBeenCalledWith('[MidnightNode] Reconnect failed:', 'reconnect failed');

        errorSpy.mockRestore();
        connectSpy.mockRestore();
    });
});

describe('MidnightNodeProvider RPC wrappers', () => {
    it('delegates chain, state, and system helpers to rpc with the expected methods', async () => {
        const provider = new MidnightNodeProvider({ nodeUrl: 'ws://localhost:9944' });
        const rpcSpy = jest.spyOn(provider, 'rpc').mockResolvedValue(undefined);

        await provider.getLatestHeader();
        await provider.getHeader('0xhash');
        await provider.getBlock('0xhash');
        await provider.getBlockHash(42);
        await provider.getFinalizedHead();
        await provider.getStorage('0xkey', '0xblock');
        await provider.getRuntimeVersion('0xblock');
        await provider.getMetadata('0xblock');
        await provider.health();
        await provider.chain();
        await provider.name();
        await provider.version();

        expect(rpcSpy).toHaveBeenNthCalledWith(1, 'chain_getHeader');
        expect(rpcSpy).toHaveBeenNthCalledWith(2, 'chain_getHeader', ['0xhash']);
        expect(rpcSpy).toHaveBeenNthCalledWith(3, 'chain_getBlock', ['0xhash']);
        expect(rpcSpy).toHaveBeenNthCalledWith(4, 'chain_getBlockHash', [42]);
        expect(rpcSpy).toHaveBeenNthCalledWith(5, 'chain_getFinalizedHead');
        expect(rpcSpy).toHaveBeenNthCalledWith(6, 'state_getStorage', ['0xkey', '0xblock']);
        expect(rpcSpy).toHaveBeenNthCalledWith(7, 'state_getRuntimeVersion', ['0xblock']);
        expect(rpcSpy).toHaveBeenNthCalledWith(8, 'state_getMetadata', ['0xblock']);
        expect(rpcSpy).toHaveBeenNthCalledWith(9, 'system_health');
        expect(rpcSpy).toHaveBeenNthCalledWith(10, 'system_chain');
        expect(rpcSpy).toHaveBeenNthCalledWith(11, 'system_name');
        expect(rpcSpy).toHaveBeenNthCalledWith(12, 'system_version');
    });
});

describe('MidnightNodeProvider core RPC flow', () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    it('sends JSON-RPC requests and resolves matching responses', async () => {
        const provider = new MidnightNodeProvider({ nodeUrl: 'ws://localhost:9944', requestTimeout: 1000 });
        const send = jest.fn();
        (provider as any).ws = { send, close: jest.fn() };
        (provider as any).connected = true;

        const promise = provider.rpc('system_health');
        expect(send).toHaveBeenCalledWith(expect.stringContaining('"method":"system_health"'));

        (provider as any).handleMessage(JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: { peers: 2, isSyncing: false, shouldHavePeers: true }
        }));

        await expect(promise).resolves.toEqual({ peers: 2, isSyncing: false, shouldHavePeers: true });
        expect(provider.getPendingRequestCount()).toBe(0);
    });

    it('rejects RPC errors returned by the node', async () => {
        const provider = new MidnightNodeProvider({ nodeUrl: 'ws://localhost:9944', requestTimeout: 1000 });
        (provider as any).ws = { send: jest.fn(), close: jest.fn() };
        (provider as any).connected = true;

        const promise = provider.rpc('state_getStorage');
        (provider as any).handleMessage(JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            error: { code: -32601, message: 'Method not found' }
        }));

        await expect(promise).rejects.toThrow('RPC error -32601: Method not found');
    });

    it('times out pending requests when no response arrives', async () => {
        const provider = new MidnightNodeProvider({ nodeUrl: 'ws://localhost:9944', requestTimeout: 1000 });
        (provider as any).ws = { send: jest.fn(), close: jest.fn() };
        (provider as any).connected = true;

        const promise = provider.rpc('chain_getBlock');
        const rejection = expect(promise).rejects.toThrow('RPC timeout: chain_getBlock (1000ms)');
        await jest.advanceTimersByTimeAsync(1000);

        await rejection;
    });

    it('dispatches subscription notifications and ignores invalid JSON', () => {
        const provider = new MidnightNodeProvider({ nodeUrl: 'ws://localhost:9944' });
        const callback = jest.fn();
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation();

        try {
            (provider as any).subscriptions.set('sub-1', callback);
            (provider as any).handleMessage('not-json');
            (provider as any).handleMessage(JSON.stringify({
                jsonrpc: '2.0',
                method: 'chain_finalizedHead',
                params: {
                    subscription: 'sub-1',
                    result: { number: '0x2a' }
                }
            }));

            expect(warnSpy).toHaveBeenCalledWith('[MidnightNode] Invalid JSON message received');
            expect(callback).toHaveBeenCalledWith({ number: '0x2a' });
        } finally {
            warnSpy.mockRestore();
        }
    });

    it('tracks subscriptions and clears connection state on disconnect', async () => {
        const provider = new MidnightNodeProvider({ nodeUrl: 'ws://localhost:9944' });
        const rpcSpy = jest.spyOn(provider, 'rpc')
            .mockResolvedValueOnce('sub-1')
            .mockResolvedValueOnce('sub-2')
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce(true);
        const close = jest.fn();

        (provider as any).ws = { close, send: jest.fn() };
        (provider as any).connected = true;

        await provider.subscribeNewHeads(jest.fn());
        await provider.subscribeFinalizedHeads(jest.fn());
        expect(provider.getSubscriptionCount()).toBe(2);

        await provider.unsubscribeNewHeads('sub-1');
        expect(provider.getSubscriptionCount()).toBe(1);

        await provider.unsubscribeFinalizedHeads('sub-2');
        expect(provider.getSubscriptionCount()).toBe(0);

        await provider.disconnect();
        expect(close).toHaveBeenCalled();
        expect(provider.isConnected()).toBe(false);
        expect(rpcSpy).toHaveBeenNthCalledWith(1, 'chain_subscribeNewHeads', []);
        expect(rpcSpy).toHaveBeenNthCalledWith(2, 'chain_subscribeFinalizedHeads', []);
    });

    it('parses hex block numbers for callers', () => {
        expect(MidnightNodeProvider.parseBlockNumber('0x2a')).toBe(42);
    });
});