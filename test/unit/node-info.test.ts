import { describe, it, expect } from 'vitest';
import { readNodeInfo } from '../../srv/monitoring/node-info';

describe('readNodeInfo', () => {
    it('keeps the parts that answer when one call fails', async () => {
        const info = await readNodeInfo({
            rpc: async (method: string) => {
                if (method === 'midnight_ledgerVersion') throw new Error('Method not found');
                return method === 'system_version' ? '2.1.101-913ec011' : { peers: 0, isSyncing: true };
            },
            getRuntimeVersion: async () => ({ specName: 'midnight', implName: 'midnight', specVersion: 2001100, implVersion: 0, transactionVersion: 4 })
        });
        expect(info.version).toBe('2.1.101-913ec011');
        expect(info.specVersion).toBe(2001100);
        expect(info.ledgerVersion).toBeNull();
        expect(info.isSyncing).toBe(true);
        expect(info.errors).toEqual(['midnight_ledgerVersion: Method not found']);
    });

    it('drops answers of the wrong shape', async () => {
        const info = await readNodeInfo({
            rpc: async () => 42,
            getRuntimeVersion: async () => { throw new Error('Not connected to Midnight Node'); }
        });
        expect(info).toMatchObject({ version: null, specVersion: null, ledgerVersion: null, peers: null, isSyncing: null });
        expect(info.errors).toEqual(['state_getRuntimeVersion: Not connected to Midnight Node']);
    });
});
