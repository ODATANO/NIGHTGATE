/**
 * The vault state readers against real contract state of both vault widths: the disclosure level, and how the
 * three readers answer for a contract that is not a vault. The indexer is a fake public data provider.
 */
const providerState = vi.hoisted(() => ({ read: null as any, at: [] as unknown[] }));
vi.mock('../../srv/midnight/public-data-provider', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../srv/midnight/public-data-provider')>()),
    buildPublicDataProvider: vi.fn(async () => ({ queryContractState: async (_address: string, at?: unknown) => { providerState.at.push(at); return providerState.read; } }))
}));

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveContractPackage } from '@odatano/contract-kit/node';
import { grantOf, readDisclosureLevelForContract, type DisclosureLedger } from '../../srv/submission/disclosure-grants';
import { readAttestationStateForContract } from '../../srv/submission/attestation-state';
import { readPredicateStateForContract } from '../../srv/submission/predicate-state';

const RECORD = 'aa'.repeat(32);
const GRANTEE = 'bb'.repeat(32);
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

/** A ledger with the given grants, as { recordKey: { grantee: level } }. */
function ledger(grants: Record<string, Record<string, bigint>>): Pick<DisclosureLedger, 'disclosures'> {
    return {
        disclosures: {
            member: (key) => hex(key) in grants,
            lookup: (key) => {
                const row = grants[hex(key)];
                return {
                    member: (g) => hex(g) in row,
                    lookup: (g) => row[hex(g)],
                    [Symbol.iterator]: () => Object.entries(row).map(([g, level]) => [Buffer.from(g, 'hex'), level] as [Uint8Array, bigint])[Symbol.iterator]()
                };
            }
        }
    };
}

describe('grantOf', () => {
    test('a recorded grant answers its level, level 0 included', () => {
        expect(grantOf(ledger({ [RECORD]: { [GRANTEE]: 2n } }), RECORD, GRANTEE)).toBe(2);
        expect(grantOf(ledger({ [RECORD]: { [GRANTEE]: 0n } }), RECORD, GRANTEE)).toBe(0);
    });

    test('a record without disclosures has no grant', () => {
        expect(grantOf(ledger({}), RECORD, GRANTEE)).toBeNull();
    });

    test('another grantee on the same record has no grant', () => {
        expect(grantOf(ledger({ [RECORD]: { ['cc'.repeat(32)]: 1n } }), RECORD, GRANTEE)).toBeNull();
    });
});

describe.each(['@odatano/contract-attestation-vault', '@odatano/contract-attestation-vault-32'])('the state readers on %s', (pkgName) => {
    const ROOT = path.resolve(__dirname, '../..');
    const pkg = resolveContractPackage(pkgName, ROOT);
    const counter = resolveContractPackage('@odatano/contract-counter', ROOT);
    const bytes32 = (fill: number) => new Uint8Array(32).fill(fill);
    const SECRET = bytes32(0x11);
    const PAYLOAD = bytes32(0xaa);
    const HOLDER = bytes32(0xcc);
    const CONFIG = {} as any;
    const ADDRESS = 'cc'.repeat(32);
    let rt: any, contract: any, ctx: any, template: any, attesterId: string, counterState: Uint8Array;
    let serializedContractState: (bytes: Uint8Array) => unknown;

    /** What the indexer answers: the serialized state, as the SDK hands it to a reader. */
    const serve = (bytes: Uint8Array | null) => { providerState.read = bytes && { contractState: serializedContractState(bytes) }; };
    const vaultState = (): Uint8Array => {
        template.data = ctx.callContext.currentQueryContext.state;
        return template.serialize();
    };
    const run = async (circuit: string, ...args: unknown[]) => {
        ctx = (await contract.impureCircuits[circuit](ctx, ...args)).context;
        serve(vaultState());
    };

    const level = (over: Record<string, unknown> = {}) => readDisclosureLevelForContract({
        contractAddress: ADDRESS, attesterId, payloadHash: hex(PAYLOAD), grantee: hex(HOLDER),
        artifactPath: pkg.artifactPath, contractProvidersConfig: CONFIG, ...over
    });
    const attestation = (over: Record<string, unknown> = {}) => readAttestationStateForContract({
        contractAddress: ADDRESS, attesterId, payloadHash: hex(PAYLOAD), artifactPath: pkg.artifactPath, contractProvidersConfig: CONFIG, ...over
    });
    const claim = (over: Record<string, unknown> = {}) => readPredicateStateForContract({
        contractAddress: ADDRESS, attesterId, payloadHash: hex(PAYLOAD), fieldKey: 'ab'.repeat(32), threshold: 1n, op: 0,
        artifactPath: pkg.artifactPath, contractProvidersConfig: CONFIG, ...over
    });

    beforeAll(async () => {
        rt = await import('@midnight-ntwrk/compact-runtime');
        const kit: any = await import('@odatano/contract-kit');
        const { SerializedContractState } = await import('@midnightntwrk/midnight-js-types');
        serializedContractState = (bytes) => SerializedContractState.fromBytes('v9', bytes);
        const mod = await import(pathToFileURL(pkg.artifactPath).href);
        const id = rt.persistentHash(new rt.CompactTypeBytes(32), SECRET);
        attesterId = hex(id);
        contract = new mod.Contract(kit.buildAttestationVaultWitnesses({
            attestationSecret: SECRET, merkleProofHolder: {}, ...(pkg.manifest.slotWidth ? { slotWidth: pkg.manifest.slotWidth } : {})
        }));
        const ctor = rt.createConstructorContext({}, '00'.repeat(32));
        const init = await contract.initialState(ctor, id, new Uint8Array(32));
        template = init.currentContractState;
        ctx = rt.createCircuitContext({
            circuitId: 'test', contractAddress: rt.dummyContractAddress(), coinPublicKeyOrZswapState: ctor.initialZswapLocalState.coinPublicKey,
            contractState: init.currentContractState.data, privateState: init.currentPrivateState
        });
        const other = await import(pathToFileURL(counter.artifactPath).href);
        counterState = (await new other.Contract({}).initialState(rt.createConstructorContext({}, '00'.repeat(32)))).currentContractState.serialize();
        await run('attest', PAYLOAD, bytes32(0xbb));
    });

    test('the disclosure level follows a grant through grant, another attester, another grantee and revoke', async () => {
        expect(await level()).toBeNull();
        await run('grantDisclosure', PAYLOAD, HOLDER, 2n);
        expect(await level()).toBe(2);
        expect(await level({ grantee: 'dd'.repeat(32) })).toBeNull();
        expect(await level({ attesterId: 'ee'.repeat(32) })).toBeNull();
        await run('revokeDisclosure', PAYLOAD, HOLDER);
        expect(await level()).toBeNull();
    });

    test('on the vault the attestation is found and an unproven claim is not', async () => {
        expect(await attestation()).toMatchObject({ attested: true, attesterId, payloadHash: hex(PAYLOAD) });
        expect(await claim()).toBe(false);
    });

    test('with a tip height, all three read the state at that block', async () => {
        providerState.at = [];
        await attestation({ tipHeight: 41 });
        await claim({ tipHeight: 42 });
        await level({ tipHeight: 43 });
        expect(providerState.at).toEqual([41, 42, 43].map(blockHeight => ({ type: 'blockHeight', blockHeight })));
    });

    test('a contract without state answers null in all three', async () => {
        serve(null);
        try {
            expect(await level()).toBeNull();
            expect(await attestation()).toBeNull();
            expect(await claim()).toBeNull();
        } finally {
            serve(vaultState());
        }
    });

    test('the state of another contract answers null in all three', async () => {
        serve(counterState);
        try {
            expect(await level()).toBeNull();
            expect(await attestation()).toBeNull();
            expect(await claim()).toBeNull();
        } finally {
            serve(vaultState());
        }
    });

    test('an artifact that is not a vault answers null in all three', async () => {
        const notAVault = { artifactPath: counter.artifactPath };
        expect(await level(notAVault)).toBeNull();
        expect(await attestation(notAVault)).toBeNull();
        expect(await claim(notAVault)).toBeNull();
    });

    test('a decode failure other than the error of the runtime is raised', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-state-readers-'));
        const broken = path.join(dir, 'index.mjs');
        fs.writeFileSync(broken, 'export const ledger = () => { throw new Error("ledger broke"); };');
        try {
            await expect(level({ artifactPath: broken })).rejects.toThrow('ledger broke');
            await expect(attestation({ artifactPath: broken })).rejects.toThrow('ledger broke');
            await expect(claim({ artifactPath: broken })).rejects.toThrow('ledger broke');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
