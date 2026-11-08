// A failed node readiness check stays out of the log and still reaches the caller. Runs on the real polkadot packages.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { firstValueFrom } from 'rxjs';
import { muteNodeProbeLog } from '../../srv/midnight/worker/context';

async function probeOnClosedSocket(method: 'chain' | 'name'): Promise<{ message: string; logged: string[] }> {
    const [{ RpcCore }, { TypeRegistry }, { WsProvider }] = await Promise.all([
        import('@polkadot/rpc-core' as string),
        import('@polkadot/types' as string),
        import('@polkadot/rpc-provider' as string)
    ]);
    const provider = new WsProvider('ws://127.0.0.1:1', false);
    const rpc = new RpcCore('probe', new TypeRegistry(), { provider });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const err: Error = await firstValueFrom<never>(rpc.system[method]()).catch((e: Error) => e);
    return { message: err.message, logged: spy.mock.calls.map((c) => c.join(' ')) };
}

afterEach(() => vi.restoreAllMocks());

describe('muteNodeProbeLog', () => {
    it('polkadot logs the failed probe unless muted', async () => {
        const { rpcDefinitions } = await import('@polkadot/types');
        expect(rpcDefinitions.system.chain.noErrorLog).toBeUndefined();
        const { logged } = await probeOnClosedSocket('chain');
        expect(logged.join()).toMatch(/RPC-CORE: .*chain\(\).*WebSocket is not connected/);
    });

    it('drops only that line, and the caller still gets the error', async () => {
        await muteNodeProbeLog();
        const muted = await probeOnClosedSocket('chain');
        expect(muted.message).toMatch(/WebSocket is not connected/);
        expect(muted.logged).toEqual([]);
        vi.restoreAllMocks();
        const other = await probeOnClosedSocket('name');
        expect(other.logged.join()).toMatch(/name\(\).*WebSocket is not connected/);
    });
});
