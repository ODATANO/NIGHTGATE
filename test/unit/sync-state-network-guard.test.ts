/**
 * ensureSyncStateSingleton: network/database binding guard + credential
 * backfill (0.16.0). A database indexed for one network must refuse to boot
 * under another (mixing chains corrupts indexed and verification data), and
 * persisted node URLs must not retain embedded credentials.
 */

const mockDbRun = vi.hoisted(() => (vi.fn()));

vi.mock('@sap/cds', () => {
    const cds: any = {
        env: {
            requires: {
                nightgate: { network: 'testnet', nodeUrl: 'ws://localhost:9944' }
            }
        },
        ql: {
            SELECT: {
                one: {
                    from: vi.fn(() => ({
                        where: vi.fn((where: unknown) => ({ __kind: 'select', where }))
                    }))
                }
            },
            INSERT: {
                into: vi.fn(() => ({
                    entries: vi.fn((entries: unknown) => ({ __kind: 'insert', entries }))
                }))
            },
            UPDATE: {
                entity: vi.fn(() => ({
                    set: vi.fn((set: unknown) => ({
                        where: vi.fn((where: unknown) => ({ __kind: 'update', set, where }))
                    }))
                }))
            }
        },
        log: (() => {
            const channels: Record<string, any> = {};
            return (name: string) => (channels[name] ??= {
                info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn()
            });
        })()
    };
    cds.default = cds;
    return cds;
});

import { ensureSyncStateSingleton, SyncStateNetworkMismatchError } from '../../srv/utils/sync-state';

function fakeDb(existingRow: any): any {
    mockDbRun.mockReset();
    mockDbRun.mockImplementationOnce(async () => existingRow);
    mockDbRun.mockImplementation(async () => undefined);
    return { run: mockDbRun };
}

describe('ensureSyncStateSingleton network guard', () => {
    it('throws fail-closed when the stored networkId differs from the configured network', async () => {
        const db = fakeDb({ ID: 'SINGLETON', networkId: 'preview', nodeUrl: 'ws://x' });
        await expect(ensureSyncStateSingleton(db)).rejects.toThrow(SyncStateNetworkMismatchError);
        await expect(ensureSyncStateSingleton(fakeDb({ networkId: 'preview' })))
            .rejects.toThrow(/bound to network 'preview'.*configured network is 'testnet'/s);
    });

    it('passes when the stored networkId matches, without touching the row', async () => {
        const db = fakeDb({ ID: 'SINGLETON', networkId: 'testnet', nodeUrl: 'ws://localhost:9944' });
        await expect(ensureSyncStateSingleton(db)).resolves.toBeUndefined();
        expect(mockDbRun).toHaveBeenCalledTimes(1);
    });

    it('binds a legacy null-network row in place when the index is EMPTY', async () => {
        mockDbRun.mockReset();
        mockDbRun
            .mockImplementationOnce(async () => ({ ID: 'SINGLETON', networkId: null, nodeUrl: 'ws://localhost:9944' }))
            .mockImplementationOnce(async () => undefined) // no indexed Blocks
            .mockImplementation(async () => undefined);
        await expect(ensureSyncStateSingleton({ run: mockDbRun } as any)).resolves.toBeUndefined();
        const update: any = mockDbRun.mock.calls[2][0];
        expect(update.__kind).toBe('update');
        expect(update.set.networkId).toBe('testnet');
    });

    it('fails closed on a legacy null-network row with INDEXED data (no open bypass)', async () => {
        delete process.env.NIGHTGATE_ASSUME_DB_NETWORK;
        mockDbRun.mockReset();
        mockDbRun
            .mockImplementationOnce(async () => ({ ID: 'SINGLETON', networkId: null, nodeUrl: 'ws://x' }))
            .mockImplementationOnce(async () => ({ ID: 'some-block' }))
            .mockImplementation(async () => undefined);
        await expect(ensureSyncStateSingleton({ run: mockDbRun } as any))
            .rejects.toThrow(/no recorded network binding.*NIGHTGATE_ASSUME_DB_NETWORK/s);
    });

    it('binds a populated legacy row only on explicit operator confirmation', async () => {
        process.env.NIGHTGATE_ASSUME_DB_NETWORK = 'testnet';
        try {
            mockDbRun.mockReset();
            mockDbRun
                .mockImplementationOnce(async () => ({ ID: 'SINGLETON', networkId: null, nodeUrl: 'ws://x' }))
                .mockImplementationOnce(async () => ({ ID: 'some-block' }))
                .mockImplementation(async () => undefined);
            await expect(ensureSyncStateSingleton({ run: mockDbRun } as any)).resolves.toBeUndefined();
            const update: any = mockDbRun.mock.calls[2][0];
            expect(update.set.networkId).toBe('testnet');
        } finally {
            delete process.env.NIGHTGATE_ASSUME_DB_NETWORK;
        }
    });

    it('backfills credential-redacted node URLs on existing rows', async () => {
        const db = fakeDb({ ID: 'SINGLETON', networkId: 'testnet', nodeUrl: 'wss://user:pass@rpc.example.com/' });
        await ensureSyncStateSingleton(db);
        expect(mockDbRun).toHaveBeenCalledTimes(2);
        const update: any = mockDbRun.mock.calls[1][0];
        expect(update.__kind).toBe('update');
        expect(update.set.nodeUrl).toBe('wss://rpc.example.com/');
    });

    it('redacts credentials before the initial insert', async () => {
        const db = fakeDb(undefined);
        await ensureSyncStateSingleton(db, 'wss://u:p@host/x?apikey=zzz');
        const insert: any = mockDbRun.mock.calls[1][0];
        expect(insert.__kind).toBe('insert');
        expect(insert.entries.nodeUrl).toBe('wss://host/x');
        expect(insert.entries.networkId).toBe('testnet');
    });
});
