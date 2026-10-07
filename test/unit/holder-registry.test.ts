/**
 * The holder-registry read side: the claim-key rule, the entry by the compiled
 * artifact's pure circuit, and a membership read against a fake public data
 * provider holding real ledger state of the contract.
 */
const providerState = vi.hoisted(() => ({ state: null as any, queried: [] as string[] }));
vi.mock('../../srv/midnight/public-data-provider', () => ({
    buildPublicDataProvider: vi.fn(async () => ({
        queryContractState: async (addr: string) => { providerState.queried.push(addr); return providerState.state; }
    }))
}));

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveContractPackage } from '@odatano/contract-kit/node';
import { holderClaimKey, holderEntry, readHolderRegistration } from '../../srv/submission/holder-registry';
import { holderClaimKey as shippedClaimKey } from '../../src/txbuilder/holder.mjs';
import { HEX64_RE } from '../../srv/utils/hex-patterns';

const ARTIFACT = resolveContractPackage('@odatano/contract-holder-registry', path.resolve(__dirname, '../..')).artifactPath;
const T = 'ab'.repeat(32);
const SECRET = '11'.repeat(32);

describe('holderClaimKey', () => {
    it('is the shipped rule: deterministic, 64 hex, different per secret', () => {
        const k = holderClaimKey(SECRET);
        expect(k).toMatch(HEX64_RE);
        expect(k).toBe(shippedClaimKey(SECRET));
        expect(holderClaimKey('22'.repeat(32))).not.toBe(k);
        expect(() => holderClaimKey('zz')).toThrow();
    });
});

describe('readHolderRegistration', () => {
    let artifact: any;
    beforeAll(async () => { artifact = await import(pathToFileURL(ARTIFACT).href); });
    beforeEach(() => { providerState.state = null; providerState.queried.length = 0; });

    it('computes the entry with the artifact and finds it in the contract state', async () => {
        const claimKey = holderClaimKey(SECRET);
        const entry = holderEntry(artifact, T, claimKey);
        expect(entry).toMatch(HEX64_RE);
        // Real ledger state of a fresh deployment (no holders), read back through `ledger()`.
        const rt: any = await import('@midnight-ntwrk/compact-runtime');
        const contract = new artifact.Contract({});
        const initial = contract.initialState(rt.createConstructorContext({}, '00'.repeat(32)));
        providerState.state = { data: initial.currentContractState.data };
        const miss = await readHolderRegistration({ contractAddress: 'cc'.repeat(32), tokenType: T, claimKey, artifactPath: ARTIFACT, contractProvidersConfig: {} as any });
        expect(miss).toEqual({ registered: false, entry });
        expect(providerState.queried).toEqual(['cc'.repeat(32)]);
    });

    it('answers null for a contract without state', async () => {
        providerState.state = null;
        expect(await readHolderRegistration({ contractAddress: 'cc'.repeat(32), tokenType: T, claimKey: holderClaimKey(SECRET), artifactPath: ARTIFACT, contractProvidersConfig: {} as any })).toBeNull();
    });
});
