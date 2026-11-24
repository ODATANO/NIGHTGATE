/**
 * ensureSyncStateSingleton: network/database binding guard. A database indexed for one network must refuse to boot
 * under another (mixing chains corrupts indexed and verification data), and a stored node URL holds no credentials.
 */

const mockDbRun = vi.hoisted(() => (vi.fn()));

vi.mock('@sap/cds', () => {
    const cds: any = {
        env: {
            requires: {
                nightgate: { network: 'undeployed', nodeUrl: 'ws://localhost:9944' }
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
    // A local .env must not change the configured network.
    beforeEach(() => { vi.stubEnv('NIGHTGATE_NETWORK', ''); });
    afterEach(() => { vi.unstubAllEnvs(); });

    it('throws fail-closed when the stored network differs from the configured network', async () => {
        const db = fakeDb({ ID: 'SINGLETON', network: 'preview', nodeUrl: 'ws://x' });
        await expect(ensureSyncStateSingleton(db)).rejects.toThrow(SyncStateNetworkMismatchError);
        await expect(ensureSyncStateSingleton(fakeDb({ network: 'preview' })))
            .rejects.toThrow(/bound to network 'preview'.*configured network is 'undeployed'/s);
    });

    it('passes when the stored network matches, without touching the row', async () => {
        const db = fakeDb({ ID: 'SINGLETON', network: 'undeployed', nodeUrl: 'ws://localhost:9944' });
        await expect(ensureSyncStateSingleton(db)).resolves.toBeUndefined();
        expect(mockDbRun).toHaveBeenCalledTimes(1);
    });

    it('refuses a row without a network', async () => {
        await expect(ensureSyncStateSingleton(fakeDb({ ID: 'SINGLETON', network: null, nodeUrl: 'ws://x' }))).rejects.toThrow(/records no network/);
        expect(mockDbRun).toHaveBeenCalledTimes(1);
    });

    it('redacts credentials before the initial insert', async () => {
        const db = fakeDb(undefined);
        await ensureSyncStateSingleton(db, 'wss://u:p@host/x?apikey=zzz');
        const insert: any = mockDbRun.mock.calls[1][0];
        expect(insert.__kind).toBe('insert');
        expect(insert.entries.nodeUrl).toBe('wss://host/x');
        expect(insert.entries.network).toBe('undeployed');
    });
});
