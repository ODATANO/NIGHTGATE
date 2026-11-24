/**
 * The small parts of the worker's contract module (`srv/midnight/worker/contracts.ts`) that need no SDK:
 * constructor arguments, the witness stub of a foreign contract, the indexer query cache and the step timer.
 * The SDK-facing modules it imports are replaced at their seams.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../srv/midnight/worker/context', () => ({ facades: new Map(), log: () => undefined, loadContractsSdk: vi.fn(), loadLedger: vi.fn(), loadSdk: vi.fn(), resolveProvingMode: () => 'wasm' }));
vi.mock('../../srv/midnight/worker/artifacts', () => ({ artifactAssetPath: vi.fn(), generationCacheSize: () => 8, getContractScaffold: vi.fn(), onGenerationEvicted: () => undefined }));
vi.mock('../../srv/midnight/worker/submit', () => ({ buildSponsoredWalletProvider: vi.fn(), buildWorkerWalletProvider: vi.fn() }));
vi.mock('../../srv/midnight/worker/sponsor', () => ({ DEPLOY_ENTRY_POINT: 'deploy', resolveSponsorEntry: vi.fn() }));
vi.mock('../../srv/midnight/wasm-proof-provider', () => ({ buildWasmProofProvider: vi.fn() }));
vi.mock('../../srv/submission/contract-witnesses', () => ({
    getContractWitnessFactory: vi.fn(),
    isVaultLineage: (lineage: string | undefined) => lineage === 'attestation-vault' || lineage === 'attestation-vault-32'
}));
vi.mock('@odatano/contract-kit', () => ({
    computeAttesterId: async (secret: Uint8Array) => Buffer.from(secret).toString('hex').slice(0, 8).padEnd(64, '0'),
    hexToBytes32: (hex: string) => Uint8Array.from(Buffer.from(hex, 'hex'))
}));
vi.mock('../../src/shared/batch-call-scope.mjs', () => ({ runBatchInScope: vi.fn(), landedHeight: vi.fn() }));

import {
    deployConstructorArgs, unregisteredWitnessStub, withFindContractQueryCache, findContractQueryCache, PhaseTimer, wrapProvidersForTiming
} from '../../srv/midnight/worker/contracts';
import { runInRpcScope, RpcCancelledError } from '../../srv/midnight/worker/cancellation';

const entry = { attestationSecret: Uint8Array.from(Buffer.from('a1b2c3d4', 'hex')) } as never;

describe('deployConstructorArgs', () => {
    it('a vault gets the attester id of the session and an all-zero recovery id', async () => {
        const [attester, recovery] = await deployConstructorArgs('attestation-vault', entry) as Uint8Array[];
        expect(Buffer.from(attester).toString('hex')).toBe('a1b2c3d4'.padEnd(64, '0'));
        expect(recovery).toEqual(new Uint8Array(32));
    });

    it('a recovery id is passed as its bytes', async () => {
        const [, recovery] = await deployConstructorArgs('attestation-vault-32', entry, 'ee'.repeat(32)) as Uint8Array[];
        expect(Buffer.from(recovery).toString('hex')).toBe('ee'.repeat(32));
    });

    it('any other contract gets no constructor arguments', async () => {
        expect(await deployConstructorArgs('counter', entry)).toEqual([]);
        expect(await deployConstructorArgs(undefined, entry)).toEqual([]);
    });
});

describe('unregisteredWitnessStub', () => {
    it('answers every name, so a constructor check passes, and fails when a witness is called', () => {
        const stub = unregisteredWitnessStub('foreign') as Record<string, () => unknown>;
        expect('anyWitness' in stub).toBe(true);
        expect(() => stub.local_secret_key()).toThrow(/contract 'foreign' asked for the witness 'local_secret_key'/);
    });

    it('a symbol lookup is no witness', () => {
        const stub = unregisteredWitnessStub('foreign') as unknown as Record<symbol, unknown>;
        expect(stub[Symbol.iterator]).toBeUndefined();
    });
});

describe('withFindContractQueryCache', () => {
    beforeEach(() => { for (const key of findContractQueryCache.keys()) findContractQueryCache.delete(key); });

    const provider = () => {
        const calls: string[] = [];
        let fail = false;
        const target = {
            label: 'indexer',
            queryDeployContractState: vi.fn(async (address: string) => { calls.push(`deploy:${address}`); if (fail) throw new Error('indexer down'); return { address }; }),
            queryContractState: vi.fn(async (address: string) => { calls.push(`state:${address}`); return { address }; })
        };
        return { target, calls, failNext: () => { fail = true; }, recover: () => { fail = false; } };
    };

    it('asks the indexer once per address and indexer for the deploy lookups', async () => {
        const p = provider();
        const cached = withFindContractQueryCache(p.target as never, 'http://idx') as unknown as typeof p.target;
        await cached.queryDeployContractState('aa');
        await cached.queryDeployContractState('aa');
        await cached.queryDeployContractState('bb');
        await (withFindContractQueryCache(p.target as never, 'http://other') as unknown as typeof p.target).queryDeployContractState('aa');
        expect(p.calls).toEqual(['deploy:aa', 'deploy:bb', 'deploy:aa']);
    });

    it('other methods, extra arguments and plain fields pass through uncached', async () => {
        const p = provider();
        const cached = withFindContractQueryCache(p.target as never, 'http://idx') as unknown as typeof p.target & { queryDeployContractState: (a: string, b?: unknown) => Promise<unknown> };
        await cached.queryContractState('aa');
        await cached.queryContractState('aa');
        await cached.queryDeployContractState('aa', { blockHeight: 5 });
        await cached.queryDeployContractState('aa', { blockHeight: 5 });
        expect(p.calls).toEqual(['state:aa', 'state:aa', 'deploy:aa', 'deploy:aa']);
        expect(cached.label).toBe('indexer');
    });

    it('a failed lookup is not kept: the next call asks again', async () => {
        const p = provider();
        const cached = withFindContractQueryCache(p.target as never, 'http://idx') as unknown as typeof p.target;
        p.failNext();
        await expect(cached.queryDeployContractState('aa')).rejects.toThrow('indexer down');
        p.recover();
        expect(await cached.queryDeployContractState('aa')).toEqual({ address: 'aa' });
        expect(p.calls).toEqual(['deploy:aa', 'deploy:aa']);
    });
});

describe('wrapProvidersForTiming', () => {
    const providers = () => ({
        proofProvider: { proveTx: vi.fn(async () => 'proven'), supportedEras: ['v9'] },
        walletProvider: { balanceTx: vi.fn(async () => 'balanced') },
        midnightProvider: { submitTx: vi.fn(async () => 'sent') },
        other: 'kept'
    });

    it('times proving, balancing and sending under their names and keeps the other members', async () => {
        const raw = providers();
        const timer = new PhaseTimer();
        const wrapped = wrapProvidersForTiming(raw as never, timer, { start: Date.now() - 5 }) as unknown as ReturnType<typeof providers>;
        expect(await wrapped.proofProvider.proveTx()).toBe('proven');
        expect(await wrapped.proofProvider.proveTx()).toBe('proven');
        expect(await wrapped.walletProvider.balanceTx()).toBe('balanced');
        expect(await wrapped.midnightProvider.submitTx()).toBe('sent');
        expect(wrapped.proofProvider.supportedEras).toEqual(['v9']);
        expect(wrapped.other).toBe('kept');
        const summary = timer.summary();
        for (const step of ['circuitToProve=', 'prove=', 'prove#2=', 'balance=', 'submit=', 'total=']) expect(summary).toContain(step);
    });

    it('a cancelled call stops before proving and before balancing', async () => {
        const raw = providers();
        const wrapped = wrapProvidersForTiming(raw as never, new PhaseTimer(), { start: 0 }) as unknown as ReturnType<typeof providers>;
        const abort = new AbortController();
        abort.abort();
        await expect(runInRpcScope('submitContractCall', abort.signal, async () => wrapped.proofProvider.proveTx())).rejects.toBeInstanceOf(RpcCancelledError);
        await expect(runInRpcScope('submitContractCall', abort.signal, async () => wrapped.walletProvider.balanceTx())).rejects.toBeInstanceOf(RpcCancelledError);
        expect(raw.proofProvider.proveTx).not.toHaveBeenCalled();
        expect(raw.walletProvider.balanceTx).not.toHaveBeenCalled();
    });
});
