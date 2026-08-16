/**
 * Tests for the browser proving modality (src/browser/providers.mjs::buildProofProvider).
 *
 * The property that matters most here is a SECURITY one, not a plumbing one: asking for
 * wallet-delegated proving and silently getting a remote proof server would move the transaction
 * preimage off the user's machine without the caller ever knowing. So `proving:'wallet'` must
 * throw rather than degrade, and the assembled modality is reported back for logging.
 *
 * The ledger import is stubbed at the seam (same policy as wasm-proof-provider.test.ts); the real
 * ledger prove loop is exercised by the live acceptance test described in
 * docs/feature-requests/browser-wallet-delegated-proving.md.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

const initialCostModel = vi.hoisted(() => vi.fn(() => ({ marker: 'cost-model' })));
vi.mock('@midnight-ntwrk/ledger-v8', () => ({
    CostModel: { initialCostModel }
}));

// Loaded in beforeAll, not at module scope: this file compiles as CommonJS under the repo's
// tsconfig, where a top-level await is an error. Types come from providers.d.mts.
type ProvidersModule = typeof import('../../src/browser/providers.mjs');
let buildProofProvider: ProvidersModule['buildProofProvider'];
beforeAll(async () => {
    ({ buildProofProvider } = await import('../../src/browser/providers.mjs'));
});

/** Minimal stand-ins; buildProofProvider only ever passes these through. */
const zkConfigProvider = {
    asKeyMaterialProvider: () => ({ marker: 'key-material' })
} as any;
const proofMod = {
    httpClientProofProvider: vi.fn((uri: string) => ({ marker: 'http-provider', uri }))
} as any;

describe('buildProofProvider', () => {
    // The stand-ins above are module-level, so call history has to be cleared per test.
    beforeEach(() => vi.clearAllMocks());

    it("defaults to the proof server, unchanged from before the modality existed", async () => {
        const res = await buildProofProvider({
            connector: {}, zkConfigProvider, proverServerUri: 'http://localhost:6300', proofMod
        });
        expect(res.provingModality).toBe('server');
        expect((res.proofProvider as any).uri).toBe('http://localhost:6300');
    });

    it("delegates to the wallet when asked, wiring the contract's key material into it", async () => {
        const getProvingProvider = vi.fn(async () => ({ marker: 'wallet-prover' }));
        const res = await buildProofProvider({
            proving: 'wallet', connector: { getProvingProvider }, zkConfigProvider, proofMod
        });
        expect(res.provingModality).toBe('wallet');
        // The wallet receives OUR key material provider - i.e. only the contract's circuits.
        expect(getProvingProvider).toHaveBeenCalledWith({ marker: 'key-material' });
        expect(proofMod.httpClientProofProvider).not.toHaveBeenCalled(); // no server touched at all

        // proveTx runs the ledger's own prove loop against the wallet's prover.
        const prove = vi.fn(() => 'proven-tx');
        const out = (res.proofProvider as any).proveTx({ prove });
        expect(prove).toHaveBeenCalledWith({ marker: 'wallet-prover' }, { marker: 'cost-model' });
        expect(out).toBe('proven-tx');
    });

    it("THROWS for proving:'wallet' against a wallet that cannot prove - never a silent downgrade", async () => {
        await expect(
            buildProofProvider({
                proving: 'wallet',
                connector: {}, // no getProvingProvider
                zkConfigProvider,
                proverServerUri: 'http://localhost:6300',
                proofMod
            })
        ).rejects.toThrow(/does not implement getProvingProvider/);
    });

    it("'auto' prefers the wallet, and falls back to the server without it", async () => {
        const withWallet = await buildProofProvider({
            proving: 'auto',
            connector: { getProvingProvider: async () => ({ marker: 'wallet-prover' }) },
            zkConfigProvider,
            proverServerUri: 'http://localhost:6300',
            proofMod
        });
        expect(withWallet.provingModality).toBe('wallet');

        const withoutWallet = await buildProofProvider({
            proving: 'auto', connector: {}, zkConfigProvider, proverServerUri: 'http://localhost:6300', proofMod
        });
        expect(withoutWallet.provingModality).toBe('server');
    });

    it("reports 'none' when neither modality is available, instead of throwing at assembly time", async () => {
        const res = await buildProofProvider({ connector: {}, zkConfigProvider, proofMod });
        expect(res.provingModality).toBe('none');
        expect(res.proofProvider).toBeUndefined();
    });

    it('rejects an unknown modality by name', async () => {
        await expect(
            buildProofProvider({ proving: 'magic' as any, connector: {}, zkConfigProvider, proofMod })
        ).rejects.toThrow(/unknown proving modality 'magic'/);
    });
});
