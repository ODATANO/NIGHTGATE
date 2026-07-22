/**
 * Crawler-free attestation state reader: reads the AttestationVault
 * attestation/content-root ledger Maps from LIVE on-chain state via the
 * contract's `ledger()` decoder, keyed by a known payload_hash. No crawler, no
 * locally-indexed txHash.
 *
 * All lookups are direct member/lookup on flat `Map<Bytes<32>, Bytes<32>>` (no
 * enumeration, unlike the disclosure indexer). Validated in
 * scripts/spike-state-verification.mjs.
 *
 * Decode/read logic is dependency-injected (`ledger`, `queryContractState`) to
 * unit-test without the ESM-only SDK; `readAttestationStateForContract` wires the
 * real provider bundle + artifact.
 */
import { pathToFileURL } from 'node:url';

function hex(b: Uint8Array): string {
    return Buffer.from(b).toString('hex');
}

function hexToBytes(h: string): Uint8Array {
    const out = new Uint8Array(h.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
    return out;
}

/** Minimal shape of the compiled artifact's `ledger(state)` return we rely on. */
export interface AttestationLedger {
    public_attestations: { member(key: Uint8Array): boolean; lookup(key: Uint8Array): Uint8Array };
    attestation_owners:  { member(key: Uint8Array): boolean; lookup(key: Uint8Array): Uint8Array };
    content_roots:       { member(key: Uint8Array): boolean; lookup(key: Uint8Array): Uint8Array };
}

export interface AttestationStateResult {
    /** payload_hash present in `public_attestations`. */
    attested: boolean;
    /** anchored content root equals the supplied `contentRoot` (false when none supplied). */
    contentRootOk: boolean;
    /** owner grantee/attester id (hex) if attested, else ''. */
    attesterId: string;
}

export interface ReadAttestationStateDeps {
    contractAddress: string;
    /** 64-hex attestation payload hash. */
    payloadHash: string;
    /** optional 64-hex content root to check against the anchored root. */
    contentRoot?: string;
    /** Decoder from the compiled artifact (`ledger`). */
    ledger: (state: any) => AttestationLedger;
    /** publicDataProvider.queryContractState; returns ContractState | null. */
    queryContractState: (contractAddress: string) => Promise<any | null>;
}

/**
 * Read attestation + content-root state for one payload hash from current
 * on-chain state. Returns `null` when no contract state is available (unknown
 * contract, or no live provider), so callers can surface a clean negative
 * rather than a 5xx.
 */
export async function readAttestationState(
    deps: ReadAttestationStateDeps
): Promise<AttestationStateResult | null> {
    const state = await deps.queryContractState(deps.contractAddress.toLowerCase());
    if (!state) return null;

    // ContractState carries the ledger in `.data` (a ChargedState); `ledger()`
    // also accepts a bare StateValue, so fall back to the state itself.
    const led = deps.ledger(state.data ?? state);
    const ph = hexToBytes(deps.payloadHash);

    const attested = led.public_attestations.member(ph);

    let contentRootOk = false;
    if (deps.contentRoot && led.content_roots.member(ph)) {
        contentRootOk = hex(led.content_roots.lookup(ph)).toLowerCase()
            === deps.contentRoot.toLowerCase();
    }

    const attesterId = attested && led.attestation_owners.member(ph)
        ? hex(led.attestation_owners.lookup(ph))
        : '';

    return { attested, contentRootOk, attesterId };
}

export interface ReadAttestationStateForContractArgs {
    contractAddress: string;
    payloadHash: string;
    contentRoot?: string;
    /** Path to the compiled contract artifact (`.../contract/index.js`). */
    artifactPath: string;
    /** Config for the contract-only provider bundle (no wallet needed to read). */
    contractProvidersConfig: import('../midnight/providers').ContractProvidersConfig;
}

/**
 * Production wrapper: build a contract-only provider bundle, load the artifact's
 * `ledger`, and read attestation state. Dynamic import keeps the ESM-only SDK out
 * of CJS load.
 */
export async function readAttestationStateForContract(
    args: ReadAttestationStateForContractArgs
): Promise<AttestationStateResult | null> {
    const { buildContractProviders } = await import('../midnight/providers.js');
    const bundle = await buildContractProviders(args.contractProvidersConfig);
    const artifact: any = await import(pathToFileURL(args.artifactPath).href);

    return readAttestationState({
        contractAddress: args.contractAddress,
        payloadHash: args.payloadHash,
        contentRoot: args.contentRoot,
        ledger: artifact.ledger,
        queryContractState: (addr: string) => bundle.publicDataProvider.queryContractState(addr)
    });
}
