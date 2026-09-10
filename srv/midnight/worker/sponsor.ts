/**
 * Fee sponsoring: finalized (bound) and unbound sponsoring, the sponsorable
 * shape check, offer token checks, dust backings and note leases.
 */

// First import on purpose: the worker modules import each other in cycles,
// and a value read at module level must come from an import that is
// resolved before the cycle re-enters this module.
import { configNumber, configMs } from '../../utils/config';
import { SUBMIT_METHODS } from '../wallet-worker-protocol';
import { SponsorRefusalError } from '../submit-error-classification';
import path from 'node:path';
import { formatErr } from '../../utils/format-error';
import { getSharedKeyMaterialProvider } from '../wasm-proof-provider';
import { type MerkleProofBundle } from '../../submission/contract-witnesses';
import { type MessagePort } from 'node:worker_threads';
import { FacadeEntry, ensureNetworkId, facades, loadContractsSdk, loadDustCoreWallet, loadProvingSdk, loadSdk, log, resolveProvingMode, loadLedger } from './context';
import { artifactAssetPath } from './artifacts';
import { buildWorkerContractProviders, getOrCompileContract, submitContractCall, withFindContractQueryCache } from './contracts';
import { createPrivateStateProxy } from './private-state';
import { BALANCE_SYNC_TIMEOUT_MS, evict, getIndexerTip, waitForGenuineSync, withSessionLocks } from './facades';
import { announceSubmitIntent, buildBuildOnlyWalletProvider, captureDustSnapshot, revertRecipeBestEffort, submitOnDedicatedClient, submitWithDustGuard, withDedicatedSubmitClient } from './submit';

export async function deserializeFinalizedTx(b64: string): Promise<{ tx: any; bytes: Uint8Array }> {
    const bytes = new Uint8Array(Buffer.from(b64, 'base64'));
    const ledger: any = await loadLedger();
    const attempts: Array<[string, string, string]> = [
        ['signature', 'proof', 'binding'],
        ['signature', 'proof', 'pre-binding']
    ];
    const errs: string[] = [];
    for (const [s, p, b] of attempts) {
        try { const tx = ledger.Transaction.deserialize(s, p, b, bytes); if (tx) return { tx, bytes }; }
        catch (e) { errs.push(`(${s},${p},${b}): ${formatErr(e).slice(0, 60)}`); }
    }
    throw new Error(`could not deserialize finalized tx (${bytes.length}B); tried ${errs.join(' | ')}`);
}

/**
 * The contract calls a deserialized tx carries: [{ address, entryPoint }].
 * Used to enforce sponsor-side policy (allowed vault + circuits) before paying.
 */
export function inspectTxCalls(tx: any): Array<{ address: string; entryPoint: string }> {
    const out: Array<{ address: string; entryPoint: string }> = [];
    try {
        const intents: Map<number, any> | undefined = tx?.intents;
        if (!intents || typeof intents.entries !== 'function') return out;
        for (const [, intent] of Array.from(intents.entries())) {
            for (const action of (intent?.actions ?? [])) {
                const ep = action?.entryPoint;
                const name = typeof ep === 'string' ? ep : (ep instanceof Uint8Array ? new TextDecoder().decode(ep) : '');
                if (name) out.push({ address: String(action?.address ?? ''), entryPoint: name });
            }
        }
    } catch { /* best-effort inspection */ }
    return out;
}

/** True when an offer/action container visibly carries anything. */
export function offerNonEmpty(offer: any): boolean {
    if (!offer) return false;
    let sawKnownKey = false;
    for (const key of ['inputs', 'outputs', 'transient', 'spends', 'registrations', 'deltas']) {
        const v = offer[key];
        if (v === undefined) continue;
        sawKnownKey = true;
        if (v === null) continue;
        if (Array.isArray(v)) { if (v.length > 0) return true; continue; }
        if (typeof v?.size === 'number') { if (v.size > 0) return true; continue; }
        if (typeof v?.length === 'number') { if (v.length > 0) return true; continue; }
        // a non-collection value under a content key counts as content
        return true;
    }
    // An offer object whose shape we cannot read at all still counts as
    // content: fail closed rather than sponsor the unknown.
    return !sawKnownKey;
}

export function normalizeTokenType(t: unknown): string {
    return String(t ?? '').trim().toLowerCase().replace(/^0x/, '');
}

/**
 * A zswap offer the sponsor may pay for: every net value change (`deltas`,
 * public per token type) is on an allow-listed type and never NIGHT, every
 * contract-owned coin belongs to a sponsorable contract, and there IS a net
 * change OR a contract-owned coin. Outputs to users are commitments (type
 * and recipient hidden), and the ledger drops zero deltas, so an offer that
 * nets to zero says nothing about what it moves and is refused, UNLESS a coin
 * in it is owned by a sponsorable contract: then the call itself moved the
 * value (`receiveShielded` + `sendImmediateShielded`, i.e. a burn, nets to
 * zero by construction: user input, contract transient, burn-address
 * output). A transfer of an allow-listed type between users riding along
 * with a net change is accepted by design (the sponsor pays dust, no sponsor
 * value moves). Unreadable structure refuses.
 */
export function checkOfferTokens(offer: any, key: string, tokenTypes: string[], nightType: string | undefined, contractSponsorable: (address: string) => boolean): void {
    const deltas = offer?.deltas;
    const entries: Array<[unknown, unknown]> | null = typeof deltas?.entries === 'function'
        ? Array.from(deltas.entries() as Iterable<[unknown, unknown]>)
        : (Array.isArray(deltas) ? deltas as Array<[unknown, unknown]> : null);
    if (!entries) throw new SponsorRefusalError(`refusing to sponsor: ${key} exposes no deltas (token types not inspectable)`);
    if (entries.length === 0) {
        const contractCoin = ['inputs', 'outputs', 'transients', 'transient'].some((coll) =>
            Array.isArray(offer?.[coll]) && offer[coll].some((coin: any) => coin?.contractAddress !== undefined && coin?.contractAddress !== null));
        if (!contractCoin) {
            throw new SponsorRefusalError(`refusing to sponsor: ${key} nets to zero and carries no contract-owned coin (a shielded transfer alongside the call, not value the call moves)`);
        }
        // else: the contract received/spent a coin in this offer; its owner is checked below.
    }
    for (const [rawType] of entries) {
        const type = normalizeTokenType(rawType);
        if (nightType && type === nightType) throw new SponsorRefusalError(`refusing to sponsor: ${key} moves NIGHT`);
        if (!tokenTypes.includes(type)) throw new SponsorRefusalError(`refusing to sponsor: ${key} moves token type ${type.slice(0, 16)}…, not in allowedTokenTypes`);
    }
    for (const coll of ['inputs', 'outputs', 'transients', 'transient']) {
        const list = offer?.[coll];
        if (!Array.isArray(list)) continue;
        for (const coin of list) {
            const owner = coin?.contractAddress;
            if (owner === undefined || owner === null) continue;
            const address = String(owner);
            if (!address || !contractSponsorable(address)) {
                throw new SponsorRefusalError(`refusing to sponsor: ${key} carries a coin owned by contract ${address.slice(0, 16)}…, which is not sponsorable here`);
            }
        }
    }
}

/** Default sponsor size budget; a single vault call is ~5.4 KB. */

/**
 * FAIL-CLOSED shape check for a transaction the sponsor is about to pay for.
 * The allow-list alone is not enough: a tx with one allowed call could carry
 * a contract DEPLOY, unshielded transfers, zswap offers or its own dust
 * actions in the same envelope, and the sponsor would pay for all of it.
 * Everything that is not an allow-listed contract call is a reason to refuse,
 * and so is structure this inspection cannot read.
 * Exported for the in-thread unit tests.
 */
/** Marker entry point for a sponsored deploy in the returned call list. */
export const DEPLOY_ENTRY_POINT = '<deploy>';

export function checkSponsorableShape(
    tx: any,
    byteLength: number,
    allowedContracts?: string[],
    allowedCircuits?: string[],
    // With `allowDeploy` (floor and grant, decided at admission) a ContractDeploy
    // action is sponsorable: never matched against `allowedContracts` (the address is
    // new), recorded onto the grant afterwards. `maxDeploys` caps deploys per tx (default 1).
    // `ownContracts`: addresses deployed under the requesting grant; calls on them
    // skip the circuit list (their circuits are the caller's, not the floor's).
    // `allowedTokenTypes`: raw shielded token types whose zswap offers pass
    // (checkOfferTokens); absent/empty = any non-empty offer refuses.
    // `nightTokenType`: the network's NIGHT raw type, never sponsorable in an offer.
    options: { allowDeploy?: boolean; maxDeploys?: number; ownContracts?: string[]; allowedTokenTypes?: string[]; nightTokenType?: string } = {}
): Array<{ address: string; entryPoint: string }> {
    const tokenTypes = (options.allowedTokenTypes ?? []).map(normalizeTokenType);
    const nightType = options.nightTokenType ? normalizeTokenType(options.nightTokenType) : undefined;
    const contractSponsorable = (address: string): boolean =>
        !allowedContracts?.length || allowedContracts.includes(address)
        || (Array.isArray(options.ownContracts) && options.ownContracts.includes(address));
    const maxDeploysPerTx = Number.isInteger(options.maxDeploys) && (options.maxDeploys as number) >= 0 ? (options.maxDeploys as number) : 1;
    let deployCount = 0;
    // A misconfigured budget must not DISABLE the budget: the config table
    // parses it (positive integer, default otherwise) and warns once.
    const maxBytes = configNumber('NIGHTGATE_SPONSOR_MAX_TX_BYTES');
    if (byteLength > maxBytes) {
        throw new SponsorRefusalError(`refusing to sponsor: transaction is ${byteLength}B, over the ${maxBytes}B budget (NIGHTGATE_SPONSOR_MAX_TX_BYTES)`);
    }

    const intents: Map<number, any> | undefined = tx?.intents;
    if (!intents || typeof intents.entries !== 'function') {
        throw new SponsorRefusalError('refusing to sponsor: transaction structure is not inspectable (no intents)');
    }
    // Value moves riding along at the transaction level (zswap): refused,
    // unless the policy names the token types the call itself moves.
    for (const key of ['guaranteedOffer', 'fallibleOffer', 'guaranteedCoins', 'fallibleCoins']) {
        const offer = (tx as any)[key];
        if (offer === undefined || offer === null) continue;
        const parts: unknown[] = typeof offer?.entries === 'function' && !('inputs' in offer)
            ? Array.from(offer.entries() as Iterable<[unknown, unknown]>).map(([, sub]) => sub)
            : [offer];
        for (const part of parts) {
            if (!offerNonEmpty(part)) continue;
            if (tokenTypes.length === 0) throw new SponsorRefusalError(`refusing to sponsor: transaction carries a ${key} (shielded value transfer)`);
            checkOfferTokens(part, key, tokenTypes, nightType, contractSponsorable);
        }
    }

    const calls: Array<{ address: string; entryPoint: string }> = [];
    for (const [, intent] of Array.from(intents.entries())) {
        // Value moves riding along inside the intent (unshielded / dust). A
        // sponsorable tx is fee-UNPAID by definition, so caller dust actions
        // are just as suspect as token transfers.
        for (const key of ['guaranteedUnshieldedOffer', 'fallibleUnshieldedOffer', 'dustActions']) {
            if (offerNonEmpty(intent?.[key])) {
                throw new SponsorRefusalError(`refusing to sponsor: transaction carries ${key} alongside its contract calls`);
            }
        }
        for (const action of (intent?.actions ?? [])) {
            const ep = action?.entryPoint;
            const name = typeof ep === 'string' ? ep : (ep instanceof Uint8Array ? new TextDecoder().decode(ep) : '');
            if (!name) {
                // deploys, maintenance updates, future action kinds
                const kind = action?.constructor?.name || typeof action;
                // A maintenance update changes a contract's authority and is never sponsored;
                // a deploy is refused only without the deploy right. Told apart by shape,
                // not by class name alone.
                const isMaintenance = kind === 'MaintenanceUpdate' || action?.updates !== undefined;
                if (isMaintenance) {
                    throw new SponsorRefusalError('refusing to sponsor: transaction carries a contract maintenance update (never sponsorable)');
                }
                const isDeploy = kind === 'ContractDeploy' || (action?.initialState !== undefined && action?.address !== undefined);
                if (isDeploy && options.allowDeploy === true) {
                    const address = String(action?.address ?? '');
                    if (!address) throw new SponsorRefusalError('refusing to sponsor: deploy action carries no contract address');
                    deployCount++;
                    if (deployCount > maxDeploysPerTx) {
                        throw new SponsorRefusalError(`refusing to sponsor: transaction carries ${deployCount}+ contract deploys; at most ${maxDeploysPerTx} per sponsored transaction`);
                    }
                    // A deploy writes verifier keys on chain and costs a multiple of a call: its own byte ceiling.
                    const maxDeployBytes = configNumber('NIGHTGATE_SPONSOR_MAX_DEPLOY_BYTES');
                    if (byteLength > maxDeployBytes) {
                        throw new SponsorRefusalError(`refusing to sponsor: deploy transaction is ${byteLength}B, over the ${maxDeployBytes}B deploy budget (NIGHTGATE_SPONSOR_MAX_DEPLOY_BYTES)`);
                    }
                    calls.push({ address, entryPoint: DEPLOY_ENTRY_POINT });
                    continue;
                }
                throw new SponsorRefusalError(`refusing to sponsor: transaction carries a non-call action (${kind})${isDeploy ? '; deploys need allowDeploy on the grant and NIGHTGATE_SPONSOR_ALLOW_DEPLOY on the server' : ''}`);
            }
            const address = String(action?.address ?? '');
            if (allowedContracts?.length && !allowedContracts.includes(address)) {
                throw new SponsorRefusalError(`refusing to sponsor: contract ${address.slice(0, 16)} is not in the allow-list`);
            }
            const own = Array.isArray(options.ownContracts) && options.ownContracts.includes(address);
            if (!own && allowedCircuits?.length && !allowedCircuits.includes(name)) {
                throw new SponsorRefusalError(`refusing to sponsor: circuit '${name}' is not sponsorable`);
            }
            calls.push({ address, entryPoint: name });
        }
    }
    if (calls.length === 0) throw new SponsorRefusalError('refusing to sponsor: the transaction carries no contract call');
    return calls;
}

/**
 * Phase 2 of sponsoring: balance dust onto a caller-finalized tx with the
 * SPONSOR facade and submit. The caller's identity is already baked into the
 * tx; the sponsor only pays. Shared by the probe and the standalone endpoint.
 */
/** Latest DustWalletState snapshot from the facade's dust state Observable. */
export async function firstDustState(dust: any): Promise<any> {
    return await new Promise((resolve, reject) => {
        let done = false;
        const sub = dust.state?.subscribe?.({
            next: (v: any) => { if (!done) { done = true; setImmediate(() => sub?.unsubscribe?.()); resolve(v); } },
            error: (e: any) => { if (!done) { done = true; reject(e); } }
        });
        if (!sub) reject(new Error('facade.dust.state not observable'));
        setTimeout(() => { if (!done) { done = true; try { sub?.unsubscribe?.(); } catch { /* */ } reject(new Error('no dust emission in 10s')); } }, 10_000);
    });
}

/**
 * 0.18 note-lock pool. One dust NOTE can back one in-flight spend, but a
 * wallet has many notes, so N notes -> N parallel sponsorings. Locks are
 * in-memory (this worker owns the wallet), keyed `sessionId|backingNight#idx`,
 * TTL-expired so a crashed sponsor path frees the note.
 */
// key -> { expiry ms, lease token }. The token makes release OWNERSHIP-CHECKED:
// a lease that outlived NIGHTGATE_NOTE_LEASE_MS (slow prove/submit) may have
// been taken over by another job; the late finisher must not delete THAT
// job's lock, or a third job would run on the same backing in parallel and
// recreate the very 1010/196 race the lock exists for.
export const noteLocks = new Map<string, { exp: number; token: number }>();
export let noteLeaseSeq = 0;

/**
 * Lock key is the BACKING NIGHT utxo, NOT the individual note. All dust notes
 * generated by one NIGHT utxo share one generation/nullifier state, so two
 * concurrent spends against the SAME backing conflict in the ledger (1010/196).
 * Parallelism therefore scales with the number of DISTINCT backing NIGHT utxos
 * (many registered utxos in one wallet, or delegation from many accounts to one
 * dust address), which is exactly the dust-note-pool feeder design. Locking per
 * backing serializes same-backing spends and parallelizes distinct-backing ones.
 */
export function backingKey(sessionId: string, note: any): string {
    return `${sessionId}|${note?.token?.backingNight ?? '?'}`;
}
/** Dust a note holds, as a bigint; 0 for an unreadable value. */
export function noteSpecks(note: any): bigint {
    try { return BigInt(note?.generatedNow ?? 0); } catch { return 0n; }
}

/**
 * Lock the free backing with the MOST dust headroom. The load spreads over
 * the backings by itself: the backing just spent holds the least until it
 * regenerates, so the next call lands elsewhere. Picking the least-charged
 * sufficient note instead concentrated every call on one backing and drained
 * it faster than it regenerated (one backing carried 80 % of a busy day's
 * calls on the hosted pool until its note fell a percent short of the fee).
 * `notes` must be valued at the SPEND time (block time), not the wall clock:
 * dust regenerates, so a note read "now" is larger than what the ledger sees
 * at the earlier block time the spend is dated with.
 */
export function tryLockBacking(sessionId: string, notes: any[], needSpecks: bigint, ttlMs: number, skipBackings: ReadonlySet<string> = new Set()): any | null {
    const now = Date.now();
    const eligible = notes
        .filter((n) => noteSpecks(n) >= needSpecks)
        .sort((a, b) => (noteSpecks(a) < noteSpecks(b) ? 1 : noteSpecks(a) > noteSpecks(b) ? -1 : 0));
    for (const n of eligible) {
        const key = backingKey(sessionId, n);
        if (skipBackings.has(key)) continue;   // came up short at build time in this run
        const held = noteLocks.get(key);
        if (held && held.exp > now) continue; // this backing is busy; try a note on another backing
        const token = ++noteLeaseSeq;
        noteLocks.set(key, { exp: now + ttlMs, token });
        return { note: n, key, token, backing: String(n?.token?.backingNight ?? '?').slice(0, 16) };
    }
    return null;
}

/** The note on the leased backing that still covers the fee at the spend time; null when none does. */
export function sufficientNoteOnBacking(sessionId: string, notes: any[], key: string, needSpecks: bigint): any | null {
    return notes.find((n) => backingKey(sessionId, n) === key && noteSpecks(n) >= needSpecks) ?? null;
}
/**
 * Lock a free BACKING, WAITING up to `waitMs` for one to free. On a single-
 * backing wallet this SERIALIZES concurrent spends deterministically (the
 * second waits out the first's submit) instead of failing; on a multi-backing
 * wallet the second locks a different backing immediately (parallel). `notes`
 * is refreshed by `refresh()` each poll so a freed backing is seen.
 */
export async function acquireBacking(
    sessionId: string, refresh: () => Promise<any[]>, needSpecks: bigint, ttlMs: number, waitMs: number,
    skipBackings: ReadonlySet<string> = new Set()
): Promise<any> {
    const deadline = Date.now() + waitMs;
    for (;;) {
        const notes = await refresh();
        const leased = tryLockBacking(sessionId, notes, needSpecks, ttlMs, skipBackings);
        if (leased) return leased;
        if (Date.now() >= deadline) {
            throw new Error(`no free dust backing with >= ${needSpecks} specks within ${waitMs}ms (all backings busy)`);
        }
        await new Promise((r) => setTimeout(r, 1000));
    }
}
/** Release a backing lease; a no-op when the lease was already taken over. */
export function releaseNote(key: string, token: number): void {
    const held = noteLocks.get(key);
    if (held && held.token === token) noteLocks.delete(key);
}
/**
 * Keep a lease alive while its job is still working (prove, submit, watch):
 * the TTL is a crash backstop, not a time budget. An ACTIVE lease in this
 * process must never be taken over by time; renewal every ttl/3 makes a
 * takeover possible only once the holder stopped renewing (it died or
 * finished). Returns a stop function.
 */
export function keepLeaseAlive(key: string, token: number, ttlMs: number): () => void {
    const every = Math.max(5, Math.floor(ttlMs / 3));
    const timer = setInterval(() => {
        const held = noteLocks.get(key);
        if (held && held.token === token) held.exp = Date.now() + ttlMs;
    }, every);
    timer.unref?.();
    return () => clearInterval(timer);
}
/** NIGHTGATE_NOTE_LEASE_MS, fail-safe: positive finite integer or the default. */
export function noteLeaseTtlMs(): number {
    return configMs('NIGHTGATE_NOTE_LEASE_MS');
}
// Exported for the unit tests (lease ownership + takeover semantics).
export const __noteLeaseForTests = { tryLockBacking, sufficientNoteOnBacking, releaseNote, keepLeaseAlive, noteLeaseTtlMs, held: (key: string) => noteLocks.get(key), reset: () => noteLocks.clear() };

export async function sponsorAndSubmitFinalized(sponsor: FacadeEntry, rehydrated: any, site: string, replyPort?: MessagePort, calls?: Array<{ address: string; entryPoint: string }>): Promise<string> {
    await waitForGenuineSync(sponsor, BALANCE_SYNC_TIMEOUT_MS, `${site} sponsor`);
    await captureDustSnapshot(sponsor, `${site} sponsor`);
    const sponsorTtl = new Date(Date.now() + 30 * 60 * 1000);
    const sponsorRecipe = await sponsor.facade.balanceFinalizedTransaction(
        rehydrated,
        { shieldedSecretKeys: sponsor.zswapKeys, dustSecretKey: sponsor.dustKey },
        { ttl: sponsorTtl, tokenKindsToBalance: ['dust'] }
    );
    const finalized = await sponsor.facade.finalizeRecipe(sponsorRecipe);
    // Same external-effect boundary as the unbound path: the identifier is
    // known before the broadcast; the main thread records it (and acks) first.
    try {
        await announceSubmitIntent(replyPort, {
            txHash: String(finalized.identifiers().at(-1)),
            contractAddress: calls?.[0]?.address, circuits: calls?.map(c => c.entryPoint), sponsorAccountId: sponsor.sessionId,
            deployed: calls?.filter(c => c.entryPoint === DEPLOY_ENTRY_POINT).map(c => c.address) ?? [],
            ttl: sponsorTtl.toISOString()
        });
    } catch (e) {
        await revertRecipeBestEffort(sponsor.facade, finalized, `${site} sponsor-intent`);
        throw e;
    }
    return String(await submitWithDustGuard(sponsor, finalized, `${site} sponsor-submit`));
}

/**
 * Resolves the optional fee-sponsor facade. Throws a clear error when a
 * sponsor was requested but its facade is not initialised in this worker;
 * the main thread ensures the sponsor facade exists before dispatching, so
 * hitting this means the ensure step was skipped or the facade was evicted.
 */
export function resolveSponsorEntry(sponsorSessionId?: string): FacadeEntry | undefined {
    if (!sponsorSessionId) return undefined;
    const sponsor = facades.get(sponsorSessionId);
    if (!sponsor) {
        throw new Error(
            `No facade for sponsorSessionId=${sponsorSessionId.slice(0, 16)} ` +
            `(the sponsor session must be connected for signing and its facade initialised)`
        );
    }
    return sponsor;
}


/**
 * PHASE 1 of cross-server sponsoring (0.17.0): build + sign + finalize a
 * contract call and return the fee-unpaid finalized tx as base64, WITHOUT
 * submitting. The caller's identity is baked in here. A remote sponsor (or
 * `sponsorFinalizedTx` below) balances dust onto it and submits. Same worker
 * shape as submitContractCall, but the build-only provider stops at finalize.
 */
export async function buildSponsorableTx(args: {
    sessionId: string; proxyId: string; contractName: string;
    registration: { artifactPath: string; artifactDigest?: string; privateStateId: string; zkConfigPath: string; slotWidth?: number };
    contractAddress: string; circuit: string; args?: unknown[];
    indexerHttpUrl: string; indexerWsUrl: string; proofServerUrl: string;
    networkId: string; merkleProof?: MerkleProofBundle; initialPrivateState?: unknown;
}) {
    const entry = facades.get(args.sessionId);
    if (!entry) throw new Error(`No facade for sessionId=${args.sessionId.slice(0, 16)}`);
    const sdk = await loadSdk();
    await ensureNetworkId(args.networkId, sdk);
    const compiledContract = await getOrCompileContract(args.contractName, args.registration, entry, args.merkleProof);
    const contractProviders = await buildWorkerContractProviders({
        indexerHttpUrl: args.indexerHttpUrl, indexerWsUrl: args.indexerWsUrl,
        proofServerUrl: args.proofServerUrl, zkConfigPath: artifactAssetPath(args.contractName, args.registration), generation: args.registration.artifactDigest
    });
    const privateStateProvider = createPrivateStateProxy(args.proxyId);
    const holder: { captured?: any } = {};
    const walletProvider = buildBuildOnlyWalletProvider(entry, holder);
    const providers = {
        ...contractProviders,
        publicDataProvider: withFindContractQueryCache(contractProviders.publicDataProvider, args.indexerHttpUrl),
        privateStateProvider, walletProvider, midnightProvider: walletProvider
    };
    const { contracts } = await loadContractsSdk();
    privateStateProvider.setContractAddress(args.contractAddress);
    const existing = await privateStateProvider.get(args.registration.privateStateId);
    const seed = existing === undefined || existing === null;
    const found = await contracts.findDeployedContract(providers, {
        contractAddress: args.contractAddress, compiledContract,
        privateStateId: args.registration.privateStateId,
        ...(seed ? { initialPrivateState: args.initialPrivateState ?? {} } : {})
    });
    const fn = found?.callTx?.[args.circuit];
    if (typeof fn !== 'function') throw new Error(`Circuit '${args.circuit}' not found on contract at ${args.contractAddress}`);
    try { await fn(...(args.args ?? [])); } catch (e) { if (!holder.captured) throw e; }
    const callerFinalized = holder.captured;
    if (!callerFinalized || typeof callerFinalized.serialize !== 'function') {
        throw new Error('phase 1 did not produce a serializable finalized transaction');
    }
    const bytes: Uint8Array = new Uint8Array(callerFinalized.serialize());
    log('info', `buildSponsorableTx: ${args.contractName}.${args.circuit} finalized (${bytes.length}B, fee-unpaid)`);
    return { finalizedTxB64: Buffer.from(bytes).toString('base64'), serializedBytes: bytes.length };
}

/**
 * PHASE 2 of cross-server sponsoring (0.17.0): take a caller-finalized,
 * fee-unpaid tx (base64), enforce sponsor-side policy (allowed vault +
 * circuits), balance dust with the SPONSOR facade and submit. The
 * attestation stays the caller's; the sponsor only pays. This is the half a
 * public / x402-metered endpoint exposes; the caller half runs on the
 * caller's own machine (the txbuilder SDK) so its key never leaves it.
 */
export async function sponsorFinalizedTx(args: {
    sponsorSessionId: string; finalizedTxB64: string; networkId: string;
    allowedContracts?: string[]; allowedCircuits?: string[]; allowDeploy?: boolean; ownContracts?: string[]; allowedTokenTypes?: string[];
    /** Set by the dispatcher: the RPC reply port, for the pre-broadcast submit-intent handshake. */
    __replyPort?: MessagePort;
}) {
    const sponsor = resolveSponsorEntry(args.sponsorSessionId);
    if (!sponsor) throw new Error('sponsorFinalizedTx requires a sponsorSessionId');
    const sdk = await loadSdk();
    await ensureNetworkId(args.networkId, sdk);
    const { tx, bytes } = await deserializeFinalizedTx(args.finalizedTxB64);

    // Policy: FAIL-CLOSED shape check. Allow-listed contract calls are the
    // only thing a sponsorable tx may contain; deploys, token transfers,
    // caller dust, oversized or uninspectable transactions all refuse.
    const calls = checkSponsorableShape(tx, bytes.length, args.allowedContracts, args.allowedCircuits, { allowDeploy: args.allowDeploy === true, ownContracts: args.ownContracts, allowedTokenTypes: args.allowedTokenTypes, nightTokenType: sdk.ledger.nativeToken().raw });
    log('info', `sponsorFinalizedTx: paying dust for ${calls.map(c => c.entryPoint).join('+')} (${bytes.length}B)`);
    const txId = await sponsorAndSubmitFinalized(sponsor, tx, 'sponsor-endpoint', args.__replyPort, calls);
    log('info', `sponsorFinalizedTx: LANDED txHash=${txId.slice(0, 16)}`);
    return {
        txHash: txId, circuits: calls.map(c => c.entryPoint), contractAddress: calls[0]?.address ?? '',
        deployed: calls.filter(c => c.entryPoint === DEPLOY_ENTRY_POINT).map(c => c.address)
    };
}

/**
 * 0.18 PARALLEL sponsoring (dust-note-pool FR). Takes an UNBOUND
 * (pre-binding) proven+signed caller tx, locks ONE free dust BACKING of
 * the sponsor wallet, builds a dust-only tx against a note on it, proves
 * it, merges it into the caller tx and binds, then submits. N backings
 * back N parallel sponsorings from ONE wallet.
 *
 * CONCURRENCY CONTRACT (why this handler is NOT in SUBMIT_METHODS): the
 * path never touches the sponsor facade's mutable state. spendCoins is
 * functional (the updated CoreWallet state is discarded) and the submit
 * goes out on a DEDICATED node client (see withDedicatedSubmitClient: the
 * facade's shared client cannot carry two submits at once), so the facade
 * never books, reverts or tracks anything for this tx. Proving + submit
 * overlap between jobs; only the fast, key-using build runs under the
 * per-session lock (evict can't zero the dust key mid-spend, and two
 * builds never read the same dust snapshot). The whole-wallet dust-wedge
 * snapshot/restore is deliberately NOT armed here: there is nothing to
 * roll back, and a restore would swap `facade.dust` under concurrent
 * jobs. A lost dust race (1010/170) is healed by the handler's
 * rebuild-retry, an unused backing lock expires.
 */
/** Re-selections of a backing whose fresh note came up short before giving up. */
export const MAX_BACKING_RESELECTS = 3;

export class DustBackingShortError extends Error {
    constructor(readonly backing: string, readonly held: bigint, readonly needed: bigint) {
        super(`dust backing ${backing} holds ${held} specks at the spend's block time, the fee needs ${needed}`);
        this.name = 'DustBackingShortError';
    }
}

/**
 * The dust-only spend on the leased backing, SERIALIZED per wallet under the
 * session lock (the same lock the whole-call SUBMIT_METHODS hold): fresh
 * snapshot valued at the spend time -> spendCoins on the leased backing ->
 * dust-only tx. Two builds never read the same dust snapshot, and a
 * bound-path job or an evict on this sponsor cannot interleave with the
 * key-using step. A backing whose fresh note no longer covers the fee is
 * refused HERE, before proving, instead of the ledger refusing it after.
 */
async function buildDustSpend(
    sponsor: FacadeEntry, networkId: string, sdk: any, leased: any, needSpecks: bigint, ctime: Date, ttl: Date
): Promise<{ dustUnproven: any }> {
    const CoreWalletApi = await loadDustCoreWallet();
    return withSessionLocks([sponsor.sessionId], async () => {
        if (facades.get(sponsor.sessionId) !== sponsor) {
            throw new Error('sponsor facade was evicted while waiting for the dust build lock');
        }
        const dws: any = await firstDustState(sponsor.facade.dust);
        const cab = dws.capabilities.coinsAndBalances;
        const fresh: any[] = Array.from(cab.getAvailableCoins(dws.state, ctime));
        const note = sufficientNoteOnBacking(sponsor.sessionId, fresh, leased.key, needSpecks);
        if (!note) {
            const onBacking = fresh.filter((n) => backingKey(sponsor.sessionId, n) === leased.key);
            const held = onBacking.reduce((m, n) => (noteSpecks(n) > m ? noteSpecks(n) : m), 0n);
            throw new DustBackingShortError(leased.backing, held, needSpecks);
        }
        const [spends] = CoreWalletApi.spendCoins(dws.state, sponsor.dustKey, [{ token: note.token, value: needSpecks }], ctime);
        const intent = sdk.ledger.Intent.new(ttl);
        intent.dustActions = new sdk.ledger.DustActions('signature', 'pre-proof', ctime, [spends[0]]);
        const dustUnproven = sdk.ledger.Transaction.fromPartsRandomized(networkId, undefined, undefined, intent);
        return { dustUnproven };
    });
}

export async function sponsorUnboundTx(args: {
    sponsorSessionId: string; unboundTxB64: string; networkId: string;
    allowedContracts?: string[]; allowedCircuits?: string[]; allowDeploy?: boolean; ownContracts?: string[]; allowedTokenTypes?: string[];
    /** Set by the dispatcher: the RPC reply port, for the pre-broadcast submit-intent handshake. */
    __replyPort?: MessagePort;
}) {
    const sponsor = resolveSponsorEntry(args.sponsorSessionId);
    if (!sponsor) throw new Error('sponsorUnboundTx requires a sponsorSessionId');
    const sdk = await loadSdk();
    await ensureNetworkId(args.networkId, sdk);
    const { tx: callerTx, bytes } = await deserializeFinalizedTx(args.unboundTxB64);

    // Same fail-closed shape policy as the bound path.
    const calls = checkSponsorableShape(callerTx, bytes.length, args.allowedContracts, args.allowedCircuits, { allowDeploy: args.allowDeploy === true, ownContracts: args.ownContracts, allowedTokenTypes: args.allowedTokenTypes, nightTokenType: sdk.ledger.nativeToken().raw });

    await waitForGenuineSync(sponsor, BALANCE_SYNC_TIMEOUT_MS, 'sponsor-unbound');

    // Fee estimate for the caller tx -> how much dust the note must hold.
    const params = sdk.ledger.LedgerParameters.initialParameters();
    let needSpecks: bigint;
    try { needSpecks = callerTx.feesWithMargin(params, 2); }
    catch { needSpecks = 100_000_000n; } // fallback floor if the estimate API shifts
    if (needSpecks <= 0n) needSpecks = 100_000_000n;

    // Read `facade.dust` at each use, never cache it: a bound-path dust
    // restore on this sponsor swaps the sub-wallet object.
    const leaseTtlMs = noteLeaseTtlMs();
    const backingWaitMs = configMs('NIGHTGATE_BACKING_WAIT_MS');

    // Block-time ctime (a wall-clock ctime ahead of the block is the
    // 1010/170 site). Fetched BEFORE any lock: a network call must not hold
    // the per-session lock, and an earlier ctime is safe (only a later one is
    // rejected). The notes are VALUED at this time too: the ledger credits
    // a note with the dust generated up to the spend's ctime, so a note
    // judged at the wall clock overstates what the spend can take.
    const tip = await getIndexerTip(sponsor.indexerHttpUrl);
    const ctime = (() => {
        const t = tip.timestampMs;
        if (t == null || !Number.isFinite(t)) return new Date();
        const ms = t > 1e12 ? t : t * 1000; // < 1e12 => seconds
        const d = new Date(ms);
        return Number.isNaN(d.getTime()) ? new Date() : d;
    })();
    const ttl = new Date(ctime.getTime() + 30 * 60 * 1000);

    // Lock a BACKING first, WAITING if all backings are busy. This makes a
    // single-backing wallet serialize deterministically (the 2nd request
    // waits out the 1st's submit) and a multi-backing wallet parallel.
    const snapshotNotes = async (at: Date): Promise<any[]> => {
        const dws: any = await firstDustState(sponsor.facade.dust);
        const cab = dws.capabilities.coinsAndBalances;
        return Array.from(cab.getAvailableCoins(dws.state, at));
    };
    // A backing whose fresh note comes up short under the session lock is
    // skipped for the rest of this call; the next pick has the most headroom.
    const shortBackings = new Set<string>();
    let leased: any;
    let built: { dustUnproven: any } | undefined;
    let stopRenewal: () => void = () => undefined;
    for (let attempt = 0; ; attempt++) {
        leased = await acquireBacking(sponsor.sessionId, () => snapshotNotes(ctime), needSpecks, leaseTtlMs, backingWaitMs, shortBackings);
        stopRenewal = keepLeaseAlive(leased.key, leased.token, leaseTtlMs);
        try {
            built = await buildDustSpend(sponsor, args.networkId, sdk, leased, needSpecks, ctime, ttl);
            break;
        } catch (e) {
            stopRenewal(); releaseNote(leased.key, leased.token);
            if (e instanceof DustBackingShortError && attempt < MAX_BACKING_RESELECTS) {
                log('warn', `sponsorUnboundTx: ${(e as Error).message}; selecting another backing`);
                shortBackings.add(leased.key);
                continue;
            }
            throw e;
        }
    }


    try {
        // Prove (parallel-safe) + merge into the caller tx (both pre-binding) + bind.
        // The sponsor's dust spend is proved with the FACADE's proving
        // service: the proof server in server mode (native, multi-threaded;
        // measured hosted: ~45 s in-process wasm vs single-digit seconds),
        // the shared wasm prover in wasm mode. Before, this path always
        // proved in wasm and that was the bulk of a sponsoring's latency.
        const tProve = Date.now();
        let provingService: any = sponsor.facade?.provingService;
        if (!provingService?.prove) {
            const provingSdk = await loadProvingSdk();
            const sharedKeys = await getSharedKeyMaterialProvider();
            provingService = provingSdk.makeWasmProvingService({ keyMaterialProvider: sharedKeys });
        }
        const dustProven = await provingService.prove(built!.dustUnproven);
        log('info', `sponsorUnboundTx: dust spend proven in ${Date.now() - tProve}ms (${sponsor.facade?.provingService?.prove ? resolveProvingMode() : 'wasm'})`);
        const bound = dustProven.merge(callerTx).bind();
        // EXTERNAL-EFFECT BOUNDARY: the transaction identifier is known
        // before anything leaves the process. Hand it to the main thread
        // and WAIT for its ack (the job row then carries the txHash and is
        // in external_execution/submitted) before broadcasting, so a failure
        // after the broadcast (socket drop, watch timeout) becomes
        // reconciliation_required with the hash, never a plain `failed`
        // for a call that may be on-chain.
        await announceSubmitIntent(args.__replyPort, {
            txHash: String(bound.identifiers().at(-1)),
            contractAddress: calls[0]?.address, circuits: calls.map(c => c.entryPoint), note: leased.backing, sponsorAccountId: sponsor.sessionId,
            deployed: calls.filter(c => c.entryPoint === DEPLOY_ENTRY_POINT).map(c => c.address),
            // The dust spend's ttl. The caller's own ttl may end earlier; the
            // later of the two is the conservative deadline for "never landed".
            ttl: ttl.toISOString()
        });
        const txId = await submitOnDedicatedClient(sponsor, bound, 'sponsor-unbound-submit');
        log('info', `sponsorUnboundTx: LANDED txHash=${String(txId).slice(0, 16)} on backing ${leased.backing}`);
        return {
            txHash: String(txId), circuits: calls.map(c => c.entryPoint), contractAddress: calls[0]?.address ?? '', note: leased.backing,
            deployed: calls.filter(c => c.entryPoint === DEPLOY_ENTRY_POINT).map(c => c.address)
        };
    } finally {
        stopRenewal();
        releaseNote(leased.key, leased.token);
    }
}

export const sponsorHandlers = { buildSponsorableTx, sponsorFinalizedTx, sponsorUnboundTx };
