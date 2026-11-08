/**
 * Tests for srv/midnight/batch-gas-preflight.ts on real ledger transactions:
 * two attests in one batch on a vault that holds one attestation.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkBatchGas } from '../../srv/midnight/batch-gas-preflight';

const VAULT = path.resolve(__dirname, '../../node_modules/@odatano/contract-attestation-vault/managed/attestation-vault/contract/index.js');

let rt: any;
let L: any;
let mod: any;

const b32 = (seed: number, tag = 0x5a) => { const b = new Uint8Array(32); new DataView(b.buffer).setUint32(0, seed); b[31] = tag; return b; };
const zero = () => new Uint8Array(32);
const slots = () => Array.from({ length: 16 }, () => ({ present: false, uint_value: 0n, value_digest: zero() }));
const witnesses = (secret: Uint8Array) => ({
    local_secret_key: (c: any) => [c.privateState, secret],
    field_value: (c: any) => [c.privateState, 0n],
    field_salt: (c: any) => [c.privateState, zero()],
    merkle_siblings: (c: any) => [c.privateState, [zero(), zero(), zero(), zero()]],
    merkle_dirs: (c: any) => [c.privateState, [true, true, true, true]],
    field_digest: (c: any) => [c.privateState, zero()],
    set_siblings: (c: any) => [c.privateState, Array.from({ length: 6 }, zero)],
    set_dirs: (c: any) => [c.privateState, Array(6).fill(true)],
    doc_schema: (c: any) => [c.privateState, Array.from({ length: 16 }, () => ({ field_key: zero(), kind: 2n, scale: 0n }))],
    doc_salt_a: (c: any) => [c.privateState, zero()],
    doc_salt_b: (c: any) => [c.privateState, zero()],
    doc_slots_a: (c: any) => [c.privateState, slots()],
    doc_slots_b: (c: any) => [c.privateState, slots()]
});

let vault: { address: string; deployed: any; coinPk: string; withOne: any };

const toCharged = (c: any) => new L.ChargedState(L.StateValue.decode(c.state.encode()));

async function attest(charged: any, secretSeed: number, payloadSeed: number) {
    const ctx = rt.createCircuitContext({
        circuitId: 'attest', contractAddress: vault.address, coinPublicKeyOrZswapState: vault.coinPk,
        contractState: charged, privateState: {}, time: Math.floor(Date.now() / 1000)
    });
    const out = await new mod.Contract(witnesses(b32(secretSeed, 0x02))).impureCircuits.attest(ctx, b32(payloadSeed, 0x03), b32(payloadSeed, 0x04));
    // The root call finishes last, so its proof data is the last entry of the trace.
    const pd = out.context.callProofDataTrace.at(-1);
    const before = pd.initialQueryContext;
    const qc = new L.QueryContext(toCharged(before.state), before.address);
    qc.block = before.block;
    qc.effects = before.effects;
    const [g, f] = L.partitionTranscripts([new L.PreTranscript(qc, pd.publicTranscript)], L.LedgerParameters.initialParameters())[0];
    const call = new L.ContractCallPrototype(vault.address, 'attest', vault.deployed.operation('attest'), g, f,
        pd.privateTranscriptOutputs, pd.input, pd.output, L.communicationCommitmentRandomness(), 'attest');
    const tx = L.Transaction.fromPartsRandomized('preprod', undefined, undefined, L.Intent.new(new Date(Date.now() + 3600e3)).addCall(call));
    return { tx, next: pd.finalQueryContext.state };
}

/** One transaction with `first` applied before `second`. */
function batch(first: any, second: any) {
    const tx = first.tx.merge(second.tx);
    const [a] = first.tx.intents.keys();
    const [b] = second.tx.intents.keys();
    tx.intents = new Map([[Math.min(a, b), first.tx.intents.get(a)], [Math.max(a, b), second.tx.intents.get(b)]]);
    return tx;
}

const NETWORK = 'preprod';

const provider = (charged: any, ledgerParameters: any = L.LedgerParameters.initialParameters()): any => ({
    async queryZSwapAndContractState() {
        const contractState = L.ContractState.deserialize(vault.deployed.serialize());
        contractState.data = toCharged(charged);
        // midnight-js hands over serialized states tagged with their era.
        const serialized = (value: { serialize(): Uint8Array }) => ({ era: 'v9', serialize: () => value.serialize() });
        return { zswapChainState: serialized(new L.ZswapChainState()), contractState: serialized(contractState), ledgerParameters: serialized(ledgerParameters) };
    }
});

beforeAll(async () => {
    rt = await import('@midnight-ntwrk/compact-runtime');
    L = await import('@midnightntwrk/ledger-v9');
    mod = await import(pathToFileURL(VAULT).href);
    const owner = b32(1, 0x01);
    const ctorCtx = rt.createConstructorContext({}, '00'.repeat(32));
    const init = await new mod.Contract(witnesses(owner)).initialState(ctorCtx, rt.persistentHash(new rt.CompactTypeBytes(32), owner), new Uint8Array(32));
    vault = {
        address: rt.dummyContractAddress(),
        deployed: L.ContractState.deserialize(init.currentContractState.serialize()),
        coinPk: ctorCtx.initialZswapLocalState.coinPublicKey,
        withOne: undefined
    };
    vault.withOne = (await attest(init.currentContractState.data, 10_000, 1)).next;
}, 60_000);

describe('checkBatchGas', () => {
    test('passes a batch whose second call is budgeted after the first', async () => {
        const a = await attest(vault.withOne, 1_000_001, 900_001);
        const b = await attest(a.next, 1_000_002, 900_002);
        await expect(checkBatchGas(batch(a, b), provider(vault.withOne), NETWORK, vault.address, ['attest', 'attest'])).resolves.toBeUndefined();
    });

    test('stops a batch whose calls run in another order than they were budgeted', async () => {
        const a = await attest(vault.withOne, 1_000_001, 900_001);
        const b = await attest(a.next, 1_000_002, 900_002);
        await expect(checkBatchGas(batch(b, a), provider(vault.withOne), NETWORK, vault.address, ['attest', 'attest']))
            .rejects.toMatchObject({ code: 'BatchGasBudgetExceeded', message: expect.stringMatching(/runs out of gas on the ledger/) });
    });

    test('applies the ledger parameters the provider returns', async () => {
        const a = await attest(vault.withOne, 1_000_001, 900_001);
        const b = await attest(a.next, 1_000_002, 900_002);
        const read = vi.fn(() => L.LedgerParameters.initialParameters().serialize());
        const withParams = provider(vault.withOne, { serialize: read });
        await expect(checkBatchGas(batch(a, b), withParams, NETWORK, vault.address, ['attest', 'attest'])).resolves.toBeUndefined();
        await expect(checkBatchGas(batch(b, a), withParams, NETWORK, vault.address, ['attest', 'attest'])).rejects.toMatchObject({ code: 'BatchGasBudgetExceeded' });
        expect(read).toHaveBeenCalledTimes(2);
    });

    test('lets the build go on when the state cannot be read', async () => {
        const failing = { queryZSwapAndContractState: async () => { throw new Error('indexer down'); } };
        await expect(checkBatchGas({} as any, failing, NETWORK, vault.address, ['attest', 'attest'])).resolves.toBeUndefined();
        await expect(checkBatchGas({} as any, { queryZSwapAndContractState: async () => null }, NETWORK, vault.address, ['attest'])).resolves.toBeUndefined();
        const v8: any = { queryZSwapAndContractState: async () => ({ zswapChainState: { era: 'v8' }, contractState: { era: 'v8' }, ledgerParameters: { era: 'v8' } }) };
        await expect(checkBatchGas({} as any, v8, NETWORK, vault.address, ['attest'])).resolves.toBeUndefined();
    });
});
