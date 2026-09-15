/**
 * Contract path: deploy, call, batch. Provider construction, the deployed-
 * contract query cache, phase timing and the compile step.
 */

import path from 'node:path';
import { proofRequestTimeoutMs } from '../../utils/proof-timeout';
import { runBatchInScope, landedHeight } from '../batch-call-scope';
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

/**
 * Vault-family constructors take the registrar and the recovery identity as public
 * args (a witness-backed constructor exceeds the node's block cost limits): the
 * deploy session's attester id and the caller's `recoveryId` (zero = none).
 */
export async function deployConstructorArgs(contractName: string, entry: FacadeEntry, recoveryId?: string): Promise<unknown[]> {
    if (!contractName.startsWith('attestation-vault')) return [];
    const rt: any = await import('@midnight-ntwrk/compact-runtime');
    const attesterId: Uint8Array = rt.persistentHash(new rt.CompactTypeBytes(32), entry.attestationSecret);
    const recovery = recoveryId ? Uint8Array.from(Buffer.from(recoveryId, 'hex')) : new Uint8Array(32);
    return [attesterId, recovery];
}

/**
 * Witnesses for a contract without a factory: every name passes the Compact
 * constructor's check, calling one throws. A proxy, since the names are not exported.
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

/** Built fresh per call: witnesses bind to the instance and carry the session's secret. */
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
            ...(registration.slotWidth !== undefined ? { slotWidth: registration.slotWidth } : {})
        }))
        // Vacant witnesses would fail the constructor's name check and block deploys.
        : CompiledContract.withWitnesses(unregisteredWitnessStub(name));

    return CompiledContract.make(name, contractClass).pipe(
        witnessStep,
        // Assets of the pinned generation, never the mutable directory.
        CompiledContract.withCompiledFileAssets(artifactAssetPath(name, registration))
    );
}

// ---- Worker-side provider construction ------------------------------------

// One indexer connection per endpoint; zk/proving providers per (proof server, asset path, generation), bounded.
export const publicDataProviders = new Map<string, Promise<any>>();
export const zkProviderBundles = new BoundedCache<string, Promise<{ zkConfigProvider: any; proofProvider: any }>>(generationCacheSize(), (key) => onGenerationEvicted(key.split('|').pop() ?? ''));

export function getPublicDataProvider(indexerHttpUrl: string, indexerWsUrl: string): Promise<any> {
    const key = `${indexerHttpUrl}|${indexerWsUrl}`;
    let p = publicDataProviders.get(key);
    if (!p) {
        p = (async () => {
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
    /** Immutable asset path of the pinned generation, or the registration dir for digest-less callers. */
    zkConfigPath: string;
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
        // A failed build must not stick.
        bundleP.catch(() => { zkProviderBundles.delete(key); });
        zkProviderBundles.set(key, bundleP);
    }
    return Promise.all([getPublicDataProvider(args.indexerHttpUrl, args.indexerWsUrl), bundleP])
        .then(([publicDataProvider, bundle]) => ({ publicDataProvider, ...bundle }));
}

// ---- findDeployedContract query caching -----------------------------------

// Only the per-address immutable queries are cached. Current state is not:
// the SDK checks verifier keys against it (maintenance txs can rotate them)
// and calls must build transcripts on fresh state.
export const FIND_CONTRACT_CACHED_METHODS = new Set(['watchForDeployTxData', 'queryDeployContractState']);
export const findContractQueryCache = new Map<string, Promise<unknown>>();

export function withFindContractQueryCache(publicDataProvider: any, indexerHttpUrl: string): any {
    return new Proxy(publicDataProvider, {
        get(target, prop) {
            const v = target[prop];
            if (typeof v !== 'function') return v;
            if (typeof prop !== 'string' || !FIND_CONTRACT_CACHED_METHODS.has(prop)) return v.bind(target);
            return (contractAddress: string, ...rest: unknown[]) => {
                // Extra args select non-latest variants; not cacheable.
                if (rest.length > 0) return v.call(target, contractAddress, ...rest);
                const cacheKey = `${prop}|${indexerHttpUrl}|${contractAddress}`;
                let p = findContractQueryCache.get(cacheKey);
                if (!p) {
                    p = v.call(target, contractAddress);
                    p!.catch(() => { findContractQueryCache.delete(cacheKey); });
                    findContractQueryCache.set(cacheKey, p!);
                }
                return p;
            };
        }
    });
}

// ---- Contract-call phase timing -------------------------------------------

/** Per-phase wall-clock durations of one submission, logged also when a phase throws. */
export class PhaseTimer {
    private readonly t0 = Date.now();
    private tPhase = this.t0;
    private readonly phases: Array<[string, number]> = [];

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
 * Times proving, balancing and submit. The first proveTx after `callRegion.start`
 * yields `circuitToProve`; `prove` counts contract proofs only.
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


/** Deploy in the worker; private state round-trips to main via proxyId. Returns primitives. */
export async function deployContract({
    sessionId, proxyId, contractName, registration,
    indexerHttpUrl, indexerWsUrl, proofServerUrl,
    networkId, initialPrivateState, sponsorSessionId, recoveryId, __replyPort
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
    recoveryId?: string;
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
    const constructorArgs = await deployConstructorArgs(contractName, entry, recoveryId);
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

/** Call one circuit on a deployed contract. */
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
    /** Seeded on this wallet's first call to the contract; defaults to `{}`. */
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

        // A non-deployer wallet has no private state and findDeployedContract
        // throws. Seed only when none exists: the initialPrivateState variant
        // overwrites. The address must be set before this probe reads.
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
            onChainStatus: String(pub?.status ?? ''),
            blockHeight: landedHeight(pub)
        };
        log('info', `submitContractCall: done txHash=${out.txHash.slice(0, 16)} status=${out.onChainStatus}`);
        return out;
    } finally {
        log('debug', `submitContractCall timing: ${contractName}.${circuit} ${timer.summary()}`);
    }
}

/**
 * Several calls on one contract in one transaction. A failure before submit
 * sends nothing; after submit a PARTIAL_SUCCESS is on chain with a subset
 * applied, so callers check effect state rather than assume all-or-nothing.
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
    /** Any per-call `merkleProof` switches the batch to holder mode (exclusive with batch-level). */
    calls: Array<{ circuit: string; args: unknown[]; merkleProof?: MerkleProofBundle }>;
    indexerHttpUrl: string;
    indexerWsUrl: string;
    proofServerUrl: string;
    networkId: string;
    /** Bound once, shared by every call. */
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

        // In holder mode every call gets a hook, so a call without a proof
        // clears the holder instead of inheriting its predecessor's.
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

        // First-contact seeding as in submitContractCall; never overwrite.
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
