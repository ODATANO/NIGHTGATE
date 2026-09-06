/**
 * Contract path: deploy, call, batch. Provider construction, the deployed-
 * contract query cache, phase timing and the compile step.
 */

import path from 'node:path';
import { proofRequestTimeoutMs } from '../../utils/proof-timeout';
import { runBatchInScope } from '../batch-call-scope';
import { buildWasmProofProvider } from '../wasm-proof-provider';
import { getContractWitnessFactory, type MerkleProofBundle } from '../../submission/contract-witnesses';
import { type MessagePort } from 'node:worker_threads';
import { BoundedCache } from './bounded-cache';
import { FacadeEntry, ensureNetworkId, facades, loadContractsSdk, loadSdk, log, resolveProvingMode } from './context';
import { ContractRegistration, artifactAssetPath, generationCacheSize, getContractScaffold, onGenerationEvicted } from './artifacts';
import { createPrivateStateProxy } from './private-state';
import { evict } from './facades';
import { BoundSubmitIntent, buildSponsoredWalletProvider, buildWorkerWalletProvider } from './submit';
import { DEPLOY_ENTRY_POINT, resolveSponsorEntry } from './sponsor';

export async function deployConstructorArgs(contractName: string, entry: FacadeEntry): Promise<unknown[]> {
    // The whole vault family (attestation-vault, attestation-vault-32, future
    // width variants) shares the registrar-as-public-arg constructor; a
    // name-equality check here silently deployed variants with NO constructor
    // args, which the contract rejects.
    if (!contractName.startsWith('attestation-vault')) return [];
    const rt: any = await import('@midnight-ntwrk/compact-runtime');
    const attesterId: Uint8Array = rt.persistentHash(new rt.CompactTypeBytes(32), entry.attestationSecret);
    return [attesterId];
}

/**
 * Builds a CompiledContract for the given registered contract. If the
 * contract declares no witnesses, supplies vacant ones (counter). Otherwise
 * looks up the witness factory and feeds it the FacadeEntry's
 * attestationSecret (AttestationVault).
 *
 * Witnesses bind to a Compact Contract instance for the lifetime of its use,
 * so we must build them fresh per call; different sessions yield different
 * attester ids.
 */
/**
 * Witnesses for a registered contract NIGHTGATE has no witness factory for.
 *
 * Every name reads as a function, which is all a Compact constructor checks,
 * and calling one throws instead of feeding a circuit silent zeroes. A proxy
 * rather than a fixed set because the declared names live only in the emitted
 * constructor's checks, not in an exported list.
 */
export function unregisteredWitnessStub(contractName: string): Record<string, unknown> {
    return new Proxy({}, {
        has: () => true,
        get: (_target, prop: string | symbol) => {
            if (typeof prop === 'symbol') return undefined;
            return () => {
                throw new Error(
                    `contract '${contractName}' asked for the witness '${String(prop)}', which NIGHTGATE holds no material for. `
                    + 'Registered foreign contracts can be deployed (a constructor takes no witnesses); calls into them have to be '
                    + 'built by the caller, e.g. with @odatano/nightgate/txbuilder, and sponsored.'
                );
            };
        }
    });
}

export async function getOrCompileContract(
    name: string,
    registration: ContractRegistration,
    entry: FacadeEntry,
    merkleProof?: MerkleProofBundle,
    merkleProofHolder?: { current?: MerkleProofBundle }
): Promise<any> {
    const { contractClass } = await getContractScaffold(name, registration);

    const { compactJs } = await loadContractsSdk();
    const CompiledContract = compactJs.CompiledContract;
    if (!CompiledContract?.make) {
        throw new Error(
            `CompiledContract.make not found in @midnight-ntwrk/compact-js exports; got keys: ${Object.keys(compactJs).join(',')}`
        );
    }

    const witnessFactory = getContractWitnessFactory(name);
    const witnessStep = witnessFactory
        ? CompiledContract.withWitnesses(witnessFactory({
            attestationSecret: entry.attestationSecret, merkleProof, merkleProofHolder,
            // Width variants (attestation-vault-32) size the witness decode
            // checks from the registration; absent means the classic 16.
            ...(registration.slotWidth !== undefined ? { slotWidth: registration.slotWidth } : {})
        }))
        // No factory: a contract we hold no witness material for. Vacant
        // witnesses are an EMPTY object, and a Compact constructor checks each
        // declared witness name individually, so anything with witnesses died
        // in `new Contract({})` before it could be deployed. A deploy never
        // calls a witness (the constructor runs on public args), so a stub that
        // satisfies the name check and throws when a CIRCUIT reaches for it
        // makes foreign contracts deployable and still fails calls loudly.
        : CompiledContract.withWitnesses(unregisteredWitnessStub(name));

    return CompiledContract.make(name, contractClass).pipe(
        witnessStep,
        // Assets of the pinned generation, never the mutable directory.
        CompiledContract.withCompiledFileAssets(artifactAssetPath(name, registration))
    );
}

// ---- Worker-side provider construction (Phase 2b) -------------------------

// One indexerPublicDataProvider (graphql-ws connection) per indexer endpoint, shared by
// every contract and generation. Zk config + proving providers are per (proof server,
// asset path, generation) and bounded.
export const publicDataProviders = new Map<string, Promise<any>>();
export const zkProviderBundles = new BoundedCache<string, Promise<{ zkConfigProvider: any; proofProvider: any }>>(generationCacheSize(), (key) => onGenerationEvicted(key.split('|').pop() ?? ''));

export function getPublicDataProvider(indexerHttpUrl: string, indexerWsUrl: string): Promise<any> {
    const key = `${indexerHttpUrl}|${indexerWsUrl}`;
    let p = publicDataProviders.get(key);
    if (!p) {
        p = (async () => {
            // `ws` is CJS; Node 22 worker_threads can `require` it freely.
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const WebSocket = require('ws');
            const { indexer } = await loadContractsSdk();
            return indexer.indexerPublicDataProvider(indexerHttpUrl, indexerWsUrl, WebSocket);
        })();
        p.catch(() => { publicDataProviders.delete(key); });
        publicDataProviders.set(key, p);
    }
    return p;
}

export function buildWorkerContractProviders(args: {
    indexerHttpUrl: string;
    indexerWsUrl: string;
    proofServerUrl: string;
    /** Immutable asset path of the pinned generation (artifactAssetPath), or the registration dir for digest-less callers. */
    zkConfigPath: string;
    /** Artifact generation the assets belong to; part of the provider cache key. */
    generation?: string;
}): Promise<{ publicDataProvider: any; zkConfigProvider: any; proofProvider: any }> {
    const key = `${args.proofServerUrl}|${args.zkConfigPath}|${args.generation ?? ''}`;
    let bundleP = zkProviderBundles.get(key);
    if (!bundleP) {
        bundleP = (async () => {
            const { proof, zk } = await loadContractsSdk();
            const zkConfigProvider = new zk.NodeZkConfigProvider(args.zkConfigPath);
            let proofProvider;
            if (resolveProvingMode() === 'wasm') {
                proofProvider = await buildWasmProofProvider(zkConfigProvider);
                log('info', 'contract proving: in-process (wasm), proof server not used');
            } else {
                proofProvider = proof.httpClientProofProvider(args.proofServerUrl, zkConfigProvider, { timeout: proofRequestTimeoutMs() });
            }
            return { zkConfigProvider, proofProvider };
        })();
        // A failed build (e.g. transient import error) must not stick: evict
        // the rejected promise so the next deploy/call retries.
        bundleP.catch(() => { zkProviderBundles.delete(key); });
        zkProviderBundles.set(key, bundleP);
    }
    return Promise.all([getPublicDataProvider(args.indexerHttpUrl, args.indexerWsUrl), bundleP])
        .then(([publicDataProvider, bundle]) => ({ publicDataProvider, ...bundle }));
}

// ---- findDeployedContract query caching -----------------------------------
// (FR wallet-save-pipeline-cpu-efficiency, remaining item)

// findDeployedContract re-runs the same indexer queries on EVERY call. Two of
// them are immutable per address: the deploy tx data and the DEPLOY-TIME
// contract state. On a grown ledger state (the vault grows with every anchored
// passport) these cost seconds per call (part of findContract=8.4s observed
// live on the predicate call), so serve them from a per-worker cache after
// first contact. Deliberately NOT cached:
// - queryContractState (the CURRENT state): findDeployedContract verifies the
//   local verifier keys against it, and VKs can be rotated/removed by
//   circuit-maintenance transactions from OTHER clients at any time; caching
//   would bypass that SDK safety check with a stale state for the rest of the
//   worker's life.
// - queryZSwapAndContractState: the state the circuit call builds transcripts
//   against; calls must always execute on fresh state.
export const FIND_CONTRACT_CACHED_METHODS = new Set(['watchForDeployTxData', 'queryDeployContractState']);
export const findContractQueryCache = new Map<string, Promise<unknown>>();

export function withFindContractQueryCache(publicDataProvider: any, indexerHttpUrl: string): any {
    return new Proxy(publicDataProvider, {
        get(target, prop) {
            const v = target[prop];
            if (typeof v !== 'function') return v;
            if (typeof prop !== 'string' || !FIND_CONTRACT_CACHED_METHODS.has(prop)) return v.bind(target);
            return (contractAddress: string, ...rest: unknown[]) => {
                // Extra args (e.g. a block-offset config) select non-latest
                // variants; only the plain per-address form is cacheable.
                if (rest.length > 0) return v.call(target, contractAddress, ...rest);
                const cacheKey = `${prop}|${indexerHttpUrl}|${contractAddress}`;
                let p = findContractQueryCache.get(cacheKey);
                if (!p) {
                    p = v.call(target, contractAddress);
                    // Transient indexer failures must not stick.
                    p!.catch(() => { findContractQueryCache.delete(cacheKey); });
                    findContractQueryCache.set(cacheKey, p!);
                }
                return p;
            };
        }
    });
}

/**
 * Adapts a worker-side facade into the SDK's WalletProvider & MidnightProvider
 * shape. balanceTx routes through balanceUnboundTransaction → finalizeRecipe
 * (matches the main-thread wallet-material-factory adapter pre-Phase-2b).
 */
// Upper bound for the pre-balance sync wait. Long enough to absorb a normal
// tip catch-up between submissions, short enough that a stalled indexer
// subscription fails the job promptly instead of hanging. Env-overridable.
// ---- Contract-call phase timing -------------------------------------------
// (FR wallet-save-pipeline-cpu-efficiency, item 4)

/**
 * Wall-clock attribution for the contract-call phases (compile,
 * findDeployedContract's ledger-state fetch + deserialize, local circuit
 * execution, proving, balancing, submission). Logged as ONE debug line per
 * submission, also when a phase throws (the partial breakdown identifies the
 * phase that timed out). The hot pre-proof phase this was built to find
 * (findContract, 8.4 s live) is fixed by withFindContractQueryCache.
 */
export class PhaseTimer {
    private readonly t0 = Date.now();
    private tPhase = this.t0;
    private readonly phases: Array<[string, number]> = [];

    /** Close the phase that ran since the previous mark (or construction). */
    mark(name: string): void {
        const now = Date.now();
        this.phases.push([name, now - this.tPhase]);
        this.tPhase = now;
    }

    /** Record an externally measured duration (does not advance the cursor). */
    add(name: string, ms: number): void {
        this.phases.push([name, ms]);
    }

    summary(): string {
        return this.phases.map(([n, ms]) => `${n}=${ms}ms`).join(' ') +
            ` total=${Date.now() - this.t0}ms`;
    }
}

/**
 * Wraps the per-call provider bundle so proving/balancing/submission report
 * their spans into the timer. `callRegion.start` is stamped right before the
 * SDK's circuit call; the FIRST proveTx invocation then yields
 * `circuitToProve` (callTx start -> first proof request), i.e. the local
 * circuit-execution + transcript span, the FR's prime suspect besides
 * findDeployedContract. Wallet-side proving inside balanceTx goes through the
 * facade's own proving service, so `prove` counts contract proofs only.
 */
export function wrapProvidersForTiming(providers: any, timer: PhaseTimer, callRegion: { start: number }): any {
    const timed = async <T>(label: string, run: () => Promise<T>): Promise<T> => {
        const t = Date.now();
        try { return await run(); } finally { timer.add(label, Date.now() - t); }
    };

    let proveCalls = 0;
    const proofProvider = typeof providers.proofProvider?.proveTx === 'function'
        ? {
            ...providers.proofProvider,
            proveTx: (...pArgs: any[]) => {
                const n = ++proveCalls;
                if (n === 1 && callRegion.start > 0) {
                    timer.add('circuitToProve', Date.now() - callRegion.start);
                }
                return timed(n === 1 ? 'prove' : `prove#${n}`, () => providers.proofProvider.proveTx(...pArgs));
            }
        }
        : providers.proofProvider;

    const wp = providers.walletProvider;
    const walletProvider = {
        ...wp,
        ...(typeof wp?.balanceTx === 'function'
            ? { balanceTx: (...a: any[]) => timed('balance', () => wp.balanceTx(...a)) } : {}),
        ...(typeof wp?.submitTx === 'function'
            ? { submitTx: (...a: any[]) => timed('submit', () => wp.submitTx(...a)) } : {})
    };

    return { ...providers, proofProvider, walletProvider, midnightProvider: walletProvider };
}


/**
 * Deploy a Compact-emitted contract via the SDK, entirely in the worker.
 * Inputs are primitives + the registration meta; the contract artifact is
 * dynamic-imported and `CompiledContract.make`'d inside the worker, cached
 * by name. The private-state provider is a proxy that round-trips to main
 * (where the real CapDbPrivateStateProvider lives, keyed by proxyId).
 *
 * Returns primitives so nothing SDK-shaped crosses the thread boundary.
 */
export async function deployContract({
    sessionId, proxyId, contractName, registration,
    indexerHttpUrl, indexerWsUrl, proofServerUrl,
    networkId, initialPrivateState, sponsorSessionId, __replyPort
}: {
    sessionId: string;
    proxyId: string;
    contractName: string;
    registration: ContractRegistration;
    indexerHttpUrl: string;
    indexerWsUrl: string;
    proofServerUrl: string;
    networkId: string;
    initialPrivateState: unknown;
    /** Optional fee sponsor: this facade balances ['dust'] and submits. */
    sponsorSessionId?: string;
    /** Set by the dispatcher: the pre-broadcast submit-intent handshake. */
    __replyPort?: MessagePort;
}) {
    const entry = facades.get(sessionId);
    if (!entry) throw new Error(`No facade for sessionId=${sessionId.slice(0, 16)}`);
    const sponsorEntry = resolveSponsorEntry(sponsorSessionId);
    const sdk = await loadSdk();
    await ensureNetworkId(networkId, sdk);

    const compiledContract = await getOrCompileContract(contractName, registration, entry);
    const contractProviders = await buildWorkerContractProviders({
        indexerHttpUrl, indexerWsUrl, proofServerUrl,
        zkConfigPath: artifactAssetPath(contractName, registration), generation: registration.artifactDigest
    });
    const privateStateProvider = createPrivateStateProxy(proxyId);
    const intent: BoundSubmitIntent = { replyPort: __replyPort, note: 'deploy', circuits: [DEPLOY_ENTRY_POINT] };
    const walletProvider = sponsorEntry
        ? buildSponsoredWalletProvider(entry, sponsorEntry, intent)
        : buildWorkerWalletProvider(entry, intent);

    const providers = {
        ...contractProviders,
        privateStateProvider,
        walletProvider,
        midnightProvider: walletProvider
    };

    const { contracts } = await loadContractsSdk();
    log('info', `deployContract: starting ${contractName} sess=${sessionId.slice(0, 16)}` +
        (sponsorEntry ? ` (fee sponsored by ${String(sponsorSessionId).slice(0, 16)})` : ''));
    const constructorArgs = await deployConstructorArgs(contractName, entry);
    const result = await contracts.deployContract(providers, {
        compiledContract,
        privateStateId: registration.privateStateId,
        initialPrivateState,
        ...(constructorArgs.length > 0 ? { args: constructorArgs } : {})
    });
    const pub = result?.deployTxData?.public;
    const out = {
        txHash: String(pub?.txHash ?? ''),
        contractAddress: String(pub?.contractAddress ?? ''),
        onChainStatus: String(pub?.status ?? '')
    };
    log('info', `deployContract: done addr=${out.contractAddress.slice(0, 16)} status=${out.onChainStatus}`);
    return out;
}

/**
 * Submit a circuit call against an already-deployed contract. Same worker-
 * side provider assembly as deployContract; routes through
 * `findDeployedContract` and invokes the circuit by name.
 */
export async function submitContractCall({
    sessionId, proxyId, contractName, registration,
    contractAddress, circuit, args: callArgs,
    indexerHttpUrl, indexerWsUrl, proofServerUrl,
    networkId, merkleProof, initialPrivateState,
    sponsorSessionId, __replyPort
}: {
    sessionId: string;
    proxyId: string;
    contractName: string;
    registration: ContractRegistration;
    contractAddress: string;
    circuit: string;
    args: unknown[];
    /** Set by the dispatcher: the pre-broadcast submit-intent handshake. */
    __replyPort?: MessagePort;
    indexerHttpUrl: string;
    indexerWsUrl: string;
    proofServerUrl: string;
    networkId: string;
    merkleProof?: MerkleProofBundle;
    /** Seeded on this wallet's FIRST call to the contract (see below).
     *  Defaults to `{}`, which is what a stateless contract deploys with. */
    initialPrivateState?: unknown;
    /** Optional fee sponsor: this facade balances ['dust'] and submits. */
    sponsorSessionId?: string;
}) {
    const entry = facades.get(sessionId);
    if (!entry) throw new Error(`No facade for sessionId=${sessionId.slice(0, 16)}`);
    const sponsorEntry = resolveSponsorEntry(sponsorSessionId);
    const timer = new PhaseTimer();
    const callRegion = { start: 0 };
    try {
        const sdk = await loadSdk();
        await ensureNetworkId(networkId, sdk);
        timer.mark('init');

        const compiledContract = await getOrCompileContract(contractName, registration, entry, merkleProof);
        timer.mark('compile');
        const contractProviders = await buildWorkerContractProviders({
            indexerHttpUrl, indexerWsUrl, proofServerUrl,
            zkConfigPath: artifactAssetPath(contractName, registration), generation: registration.artifactDigest
        });
        timer.mark('providers');
        const privateStateProvider = createPrivateStateProxy(proxyId);
        const intent: BoundSubmitIntent = { replyPort: __replyPort, contractAddress, circuits: [circuit] };
        const walletProvider = sponsorEntry
            ? buildSponsoredWalletProvider(entry, sponsorEntry, intent)
            : buildWorkerWalletProvider(entry, intent);

        const providers = wrapProvidersForTiming({
            ...contractProviders,
            publicDataProvider: withFindContractQueryCache(contractProviders.publicDataProvider, indexerHttpUrl),
            privateStateProvider,
            walletProvider,
            midnightProvider: walletProvider
        }, timer, callRegion);

        const { contracts } = await loadContractsSdk();
        log('info', `submitContractCall: ${contractName}.${circuit}@${contractAddress.slice(0, 12)}` +
            (sponsorEntry ? ` (fee sponsored by ${String(sponsorSessionId).slice(0, 16)})` : ''));

        // A wallet that did not DEPLOY this contract has no entry at its
        // privateStateId, and `findDeployedContract` then throws "No private
        // state found at private state ID '<id>'". That blocks the entire
        // multi-caller case (several wallets acting on one shared contract,
        // e.g. N producers anchoring in the same attestation vault).
        //
        // Seed the private state on first contact for this wallet, and ONLY
        // then: the initialPrivateState variant of findDeployedContract
        // OVERWRITES whatever is stored, so an existing state (the deployer's,
        // or one a previous call evolved) must never be handed to it.
        // The store scopes reads by contract address (`findDeployedContract`
        // sets it internally); this probe runs BEFORE that, so set it here or
        // the provider rejects the read with "Contract address not set".
        privateStateProvider.setContractAddress(contractAddress);
        const existingPrivateState = await privateStateProvider.get(registration.privateStateId);
        const seed = existingPrivateState === undefined || existingPrivateState === null;
        if (seed) {
            log('info',
                `submitContractCall: no private state at '${registration.privateStateId}' for this wallet, ` +
                `seeding the contract's initial private state`);
        }
        timer.mark('stateProbe');
        const found = await contracts.findDeployedContract(providers, {
            contractAddress,
            compiledContract,
            privateStateId: registration.privateStateId,
            ...(seed ? { initialPrivateState: initialPrivateState ?? {} } : {})
        });
        timer.mark('findContract');
        const fn = found?.callTx?.[circuit];
        if (typeof fn !== 'function') {
            throw new Error(`Circuit '${circuit}' not found on contract at ${contractAddress}`);
        }
        callRegion.start = Date.now();
        const result = await fn(...(callArgs ?? []));
        timer.add('callTotal', Date.now() - callRegion.start);
        const pub = result?.public;
        const out = {
            txHash: String(pub?.txHash ?? ''),
            onChainStatus: String(pub?.status ?? '')
        };
        log('info', `submitContractCall: done txHash=${out.txHash.slice(0, 16)} status=${out.onChainStatus}`);
        return out;
    } finally {
        log('debug', `submitContractCall timing: ${contractName}.${circuit} ${timer.summary()}`);
    }
}

/**
 * Submit SEVERAL circuit calls against ONE deployed contract as a SINGLE
 * transaction, via the SDK's `withContractScopedTransaction`. Each call is
 * added to the shared TransactionContext (the circuit-call interface's
 * `(txCtx, ...args)` overload); the SDK threads the contract's running
 * state across the calls, then balances, signs and submits ONCE at scope
 * end. With a sponsor, the two-phase dust balancing therefore also runs
 * once for the whole batch instead of once per call.
 *
 * Failure semantics, two distinct phases:
 * - BEFORE submission (a bad circuit, a throwing call, proving/balancing
 *   errors): the scope discards all unsubmitted calls and nothing is
 *   submitted.
 * - AFTER submission the ledger's fallible phase still applies: the
 *   transaction can finalize as PARTIAL_SUCCESS, i.e. it IS on chain and a
 *   subset of the batched calls may have been applied. The submitter then
 *   marks the submission failed (OnChainStatus:...), so callers must check
 *   effect state (e.g. verifyAttestationState) rather than assume
 *   all-or-nothing.
 */
export async function submitContractCallBatch({
    sessionId, proxyId, contractName, registration,
    contractAddress, calls,
    indexerHttpUrl, indexerWsUrl, proofServerUrl,
    networkId, merkleProof, initialPrivateState,
    sponsorSessionId, independentCalls, orderedPrefix, __replyPort
}: {
    sessionId: string;
    proxyId: string;
    contractName: string;
    registration: ContractRegistration;
    contractAddress: string;
    /** Ordered circuit calls; all execute inside one transaction scope.
     *  A call may carry its OWN `merkleProof` (per-call witness binding
     *  for proveFieldPredicate); any per-call proof switches the whole
     *  batch to holder mode, where the loop swaps the current proof
     *  before each call. Mutually exclusive with the batch-level
     *  `merkleProof` below. */
    calls: Array<{ circuit: string; args: unknown[]; merkleProof?: MerkleProofBundle }>;
    indexerHttpUrl: string;
    indexerWsUrl: string;
    proofServerUrl: string;
    networkId: string;
    /** Batch-level proof bundle: bound once to the compiled contract
     *  instance shared by every call in the scope. */
    merkleProof?: MerkleProofBundle;
    initialPrivateState?: unknown;
    /** Optional fee sponsor: this facade balances ['dust'] and submits. */
    sponsorSessionId?: string;
    /** The calls past `orderedPrefix` share no state: group them by execution stage before proving. */
    independentCalls?: boolean;
    orderedPrefix?: number;
    /** Set by the dispatcher: the pre-broadcast submit-intent handshake. */
    __replyPort?: MessagePort;
}) {
    if (!Array.isArray(calls) || calls.length === 0) {
        throw new Error('submitContractCallBatch: calls must be a non-empty array');
    }
    const entry = facades.get(sessionId);
    if (!entry) throw new Error(`No facade for sessionId=${sessionId.slice(0, 16)}`);
    const sponsorEntry = resolveSponsorEntry(sponsorSessionId);
    const timer = new PhaseTimer();
    const callRegion = { start: 0 };
    const circuits = calls.map(c => c.circuit);
    try {
        const sdk = await loadSdk();
        await ensureNetworkId(networkId, sdk);
        timer.mark('init');

        // Per-call witness binding: any call-level merkleProof switches the
        // batch to holder mode. EVERY call then gets a hook, so a call
        // without its own proof clears the holder rather than inheriting
        // its predecessor's.
        const holderMode = calls.some(c => c.merkleProof);
        if (holderMode && merkleProof) {
            throw new Error('submitContractCallBatch: per-call merkleProof and batch-level merkleProof are mutually exclusive');
        }
        const holder: { current?: MerkleProofBundle } = {};
        const scopeCalls = holderMode
            ? calls.map(c => ({ circuit: c.circuit, args: c.args, before: () => { holder.current = c.merkleProof; } }))
            : calls;

        const compiledContract = await getOrCompileContract(
            contractName, registration, entry,
            holderMode ? undefined : merkleProof,
            holderMode ? holder : undefined
        );
        timer.mark('compile');
        const contractProviders = await buildWorkerContractProviders({
            indexerHttpUrl, indexerWsUrl, proofServerUrl,
            zkConfigPath: artifactAssetPath(contractName, registration), generation: registration.artifactDigest
        });
        timer.mark('providers');
        const privateStateProvider = createPrivateStateProxy(proxyId);
        const intent: BoundSubmitIntent = { replyPort: __replyPort, contractAddress, circuits: calls.map(c => c.circuit) };
        const walletProvider = sponsorEntry
            ? buildSponsoredWalletProvider(entry, sponsorEntry, intent)
            : buildWorkerWalletProvider(entry, intent);

        const providers = wrapProvidersForTiming({
            ...contractProviders,
            publicDataProvider: withFindContractQueryCache(contractProviders.publicDataProvider, indexerHttpUrl),
            privateStateProvider,
            walletProvider,
            midnightProvider: walletProvider
        }, timer, callRegion);

        const { contracts } = await loadContractsSdk();
        log('info', `submitContractCallBatch: ${contractName}.[${circuits.join('+')}]@${contractAddress.slice(0, 12)}` +
            (sponsorEntry ? ` (fee sponsored by ${String(sponsorSessionId).slice(0, 16)})` : ''));

        // Same first-contact private-state seeding as submitContractCall: a
        // wallet that did not deploy this contract has no entry at its
        // privateStateId, and findDeployedContract would throw. Never
        // overwrite an existing state.
        privateStateProvider.setContractAddress(contractAddress);
        const existingPrivateState = await privateStateProvider.get(registration.privateStateId);
        const seed = existingPrivateState === undefined || existingPrivateState === null;
        if (seed) {
            log('info',
                `submitContractCallBatch: no private state at '${registration.privateStateId}' for this wallet, ` +
                `seeding the contract's initial private state`);
        }
        timer.mark('stateProbe');
        const found = await contracts.findDeployedContract(providers, {
            contractAddress,
            compiledContract,
            privateStateId: registration.privateStateId,
            ...(seed ? { initialPrivateState: initialPrivateState ?? {} } : {})
        });
        timer.mark('findContract');
        // Scope mechanics (circuit validation, ordered (txCtx, ...args) calls,
        // result mapping) live in batch-call-scope.ts so they are unit-testable
        // outside the worker-thread guard.
        callRegion.start = Date.now();
        const out = await runBatchInScope(contracts, providers, found, scopeCalls, contractAddress, { independentCalls, orderedPrefix });
        timer.add('callTotal', Date.now() - callRegion.start);
        log('info', `submitContractCallBatch: done txHash=${out.txHash.slice(0, 16)} status=${out.onChainStatus} calls=${out.circuits.length}`);
        return out;
    } finally {
        log('debug', `submitContractCallBatch timing: ${contractName}.[${circuits.join('+')}] ${timer.summary()}`);
    }
}

export const contractHandlers = { deployContract, submitContractCall, submitContractCallBatch };
