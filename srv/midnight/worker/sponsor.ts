/**
 * Fee sponsoring: finalized (bound) and unbound sponsoring, the sponsorable
 * shape check, offer token checks, dust backings and note leases.
 */

// First import on purpose: worker modules import each other in cycles, and a
// module-level read must come from an import resolved before the cycle re-enters.
import { configNumber, configMs } from '../../utils/config';
import { throwIfRpcCancelled } from './cancellation';
import { callSegments } from '../batch-segment-order';
import { SponsorRefusalError } from '../submit-error-classification';
import { formatErr } from '../../utils/format-error';
import { getSharedKeyMaterialProvider } from '../wasm-proof-provider';
import { type MerkleProofBundle } from '../../submission/contract-witnesses';
import { type MessagePort } from 'node:worker_threads';
import { FacadeEntry, ensureNetworkId, facades, loadContractsSdk, loadDustCoreWallet, loadProvingSdk, loadSdk, log, resolveProvingMode, loadLedger } from './context';
import { artifactAssetPath } from './artifacts';
import { buildWorkerContractProviders, getOrCompileContract, withFindContractQueryCache } from './contracts';
import { createPrivateStateProxy } from './private-state';
import { BALANCE_SYNC_TIMEOUT_MS, getIndexerTip, waitForGenuineSync, withSessionLocks } from './facades';
import { announceSubmitIntent, buildBuildOnlyWalletProvider, captureDustSnapshot, revertRecipeBestEffort, submitOnDedicatedClient, submitWithDustGuard } from './submit';

/** Deserialize a caller tx from base64, as bound or pre-binding. */
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

/** The contract calls a deserialized tx carries (best effort). */
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
        return true;
    }
    // An unreadable shape counts as content: fail closed.
    return !sawKnownKey;
}

export function normalizeTokenType(t: unknown): string {
    return String(t ?? '').trim().toLowerCase().replace(/^0x/, '');
}

/** Token amounts the transaction's calls declare as minted, per raw type; consumed by the offers that carry them. */
export type MintBudget = Map<string, bigint>;

/**
 * What the calls on sponsorable contracts mint, read from their transcripts'
 * effects: the proof binds them, and the type follows from domain separator and
 * contract address.
 */
export function declaredMints(
    tx: any,
    contractSponsorable: (address: string) => boolean,
    deriveTokenType: (domainSeparatorHex: string, contractAddress: string) => string
): MintBudget {
    const budget: MintBudget = new Map();
    const intents: Map<number, any> | undefined = tx?.intents;
    if (!intents || typeof intents.values !== 'function') return budget;
    for (const intent of Array.from(intents.values())) {
        for (const action of (intent?.actions ?? [])) {
            const address = String(action?.address ?? '');
            if (!address || !contractSponsorable(address)) continue;
            for (const transcript of [action?.guaranteedTranscript, action?.fallibleTranscript]) {
                const mints = transcript?.effects?.shieldedMints;
                if (!mints || typeof mints.entries !== 'function') continue;
                for (const [domainSeparator, amount] of Array.from(mints.entries() as Iterable<[unknown, unknown]>)) {
                    if (typeof amount !== 'bigint' || amount <= 0n) continue;
                    const type = normalizeTokenType(deriveTokenType(normalizeTokenType(domainSeparator), address));
                    if (!/^[0-9a-f]{64}$/.test(type)) continue;
                    budget.set(type, (budget.get(type) ?? 0n) + amount);
                }
            }
        }
    }
    return budget;
}

/**
 * Throws unless every delta is an allowed non-NIGHT type, or minted by a call of
 * the transaction, and every contract coin is sponsorable. User outputs are
 * commitments and the ledger drops zero deltas, so a zero-net offer is refused
 * unless a contract coin shows the call moved it (a burn).
 */
export function checkOfferTokens(offer: any, key: string, tokenTypes: string[], nightType: string | undefined, contractSponsorable: (address: string) => boolean, mints: MintBudget = new Map()): void {
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
    }
    for (const [rawType, rawDelta] of entries) {
        const type = normalizeTokenType(rawType);
        if (nightType && type === nightType) throw new SponsorRefusalError(`refusing to sponsor: ${key} moves NIGHT`);
        if (tokenTypes.includes(type)) continue;
        const minted = mints.get(type);
        if (minted === undefined) throw new SponsorRefusalError(`refusing to sponsor: ${key} moves token type ${type.slice(0, 16)}…, not in allowedTokenTypes`);
        // Delta = inputs - outputs: a mint shows as a negative one, at most the declared amount.
        const taken = typeof rawDelta === 'bigint' ? -rawDelta : null;
        if (taken === null || taken <= 0n) {
            throw new SponsorRefusalError(`refusing to sponsor: ${key} pays in token type ${type.slice(0, 16)}…, not in allowedTokenTypes (a mint in the same transaction covers only what it creates)`);
        }
        if (taken > minted) {
            throw new SponsorRefusalError(`refusing to sponsor: ${key} creates ${taken} of token type ${type.slice(0, 16)}…, the transaction's calls mint ${minted}`);
        }
        mints.set(type, minted - taken);
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

/** Marker entry point for a sponsored swap in the returned call list. */
export const SWAP_ENTRY_POINT = '<swap>';

/** What a swap exchanges, from the maker's side; amounts in atoms. */
export interface SwapTerms {
    gives: { tokenType: string; amount: string };
    wants: { tokenType: string; amount: string };
}

const sizeOf = (v: any): number | null =>
    Array.isArray(v) ? v.length : typeof v?.size === 'number' ? v.size : typeof v?.length === 'number' ? v.length : null;

/**
 * One half of a swap: an offer and nothing else, giving one token type and
 * wanting another. Its terms are the offer's two deltas; coins show no type.
 */
function swapHalfTerms(half: any, label: string, tokenTypes: string[] | null, nightType: string | undefined, maxInputs: number, prefix = 'refusing to sponsor'): { give: [string, bigint]; want: [string, bigint] } {
    const refuse = (why: string): never => { throw new SponsorRefusalError(`${prefix}: the ${label} ${why}`); };
    const intents = half?.intents;
    if (intents !== undefined && intents !== null && sizeOf(intents) !== 0) refuse('carries an intent (a contract call, unshielded value or dust actions)');
    const fallible = half?.fallibleOffer;
    if (fallible !== undefined && fallible !== null && sizeOf(fallible) !== 0) refuse('carries a fallible offer');
    const offer = half?.guaranteedOffer;
    if (!offer || !Array.isArray(offer.inputs) || !Array.isArray(offer.outputs)) return refuse('carries no readable guaranteed offer');
    if (sizeOf(offer.transients ?? []) !== 0) refuse('carries a transient coin');
    if ([...offer.inputs, ...offer.outputs].some((coin: any) => coin?.contractAddress !== undefined && coin?.contractAddress !== null)) {
        refuse('carries a contract-owned coin');
    }
    if (offer.inputs.length < 1 || offer.inputs.length > maxInputs) refuse(`carries ${offer.inputs.length} inputs; 1 to ${maxInputs} are sponsored (NIGHTGATE_SPONSOR_SWAP_MAX_INPUTS)`);
    if (offer.outputs.length < 1 || offer.outputs.length > 2) refuse(`carries ${offer.outputs.length} outputs; a half has the coin it wants and at most its change`);
    const deltas = offer.deltas;
    const entries: Array<[unknown, unknown]> | null = typeof deltas?.entries === 'function' ? Array.from(deltas.entries() as Iterable<[unknown, unknown]>) : null;
    if (!entries) return refuse('exposes no deltas (terms not readable)');
    const typed = entries.map(([t, v]) => [normalizeTokenType(t), v] as [string, unknown]);
    if (typed.some(([, v]) => typeof v !== 'bigint' || v === 0n)) refuse('exposes a delta that is not a non-zero amount');
    const gives = typed.filter(([, v]) => (v as bigint) > 0n) as Array<[string, bigint]>;
    const wants = typed.filter(([, v]) => (v as bigint) < 0n) as Array<[string, bigint]>;
    if (gives.length !== 1 || wants.length !== 1) refuse(`gives ${gives.length} token type(s) and wants ${wants.length}; a half gives one and wants one`);
    const give = gives[0];
    const want: [string, bigint] = [wants[0][0], -wants[0][1]];
    if (give[0] === want[0]) refuse('gives and wants the same token type');
    for (const [type] of [give, want]) {
        if (nightType && type === nightType) refuse('moves NIGHT');
        if (tokenTypes && !tokenTypes.includes(type)) refuse(`moves token type ${type.slice(0, 16)}…, not in allowedTokenTypes`);
    }
    return { give, want };
}

/** Nullifiers of a half's inputs; the chain shows them spent once any transaction carrying them lands. */
export function swapHalfNullifiers(half: any): string[] {
    const inputs: any[] = Array.isArray(half?.guaranteedOffer?.inputs) ? half.guaranteedOffer.inputs : [];
    return [...new Set(inputs.map((i: any) => normalizeTokenType(i?.nullifier)).filter((n: string) => /^[0-9a-f]{64}$/.test(n)))];
}

export interface SwapHalfDescription extends SwapTerms {
    bound: boolean;
    inputs: number;
    nullifiers: string[];
}

/** Terms of one half as an offer board records them: the shape checks of a sponsored half, no token allow-list. */
export async function describeSwapHalf(args: { halfB64: string }): Promise<SwapHalfDescription> {
    const half = await deserializeSwapHalf(args.halfB64, 'half');
    const ledger: any = await loadLedger();
    const nightType = normalizeTokenType(ledger.nativeToken().raw);
    const t = swapHalfTerms(half.tx, 'half', null, nightType, configNumber('NIGHTGATE_SPONSOR_SWAP_MAX_INPUTS'), 'not a swap half');
    return {
        gives: { tokenType: t.give[0], amount: t.give[1].toString() },
        wants: { tokenType: t.want[0], amount: t.want[1].toString() },
        bound: half.bound,
        inputs: half.tx.guaranteedOffer.inputs.length,
        nullifiers: swapHalfNullifiers(half.tx)
    };
}

/** Throws unless the two halves are swap halves that mirror each other; returns the terms. */
export function checkSwapHalves(
    maker: any, taker: any,
    options: { allowedTokenTypes?: string[]; nightTokenType?: string; maxInputs?: number } = {}
): SwapTerms {
    const tokenTypes = (options.allowedTokenTypes ?? []).map(normalizeTokenType);
    if (tokenTypes.length === 0) throw new SponsorRefusalError('refusing to sponsor: a swap needs its token types in allowedTokenTypes, and none is listed');
    const nightType = options.nightTokenType ? normalizeTokenType(options.nightTokenType) : undefined;
    const maxInputs = Number.isInteger(options.maxInputs) && (options.maxInputs as number) >= 1 ? (options.maxInputs as number) : 4;
    const m = swapHalfTerms(maker, 'maker half', tokenTypes, nightType, maxInputs);
    const t = swapHalfTerms(taker, 'taker half', tokenTypes, nightType, maxInputs);
    if (m.give[0] !== t.want[0] || m.give[1] !== t.want[1] || m.want[0] !== t.give[0] || m.want[1] !== t.give[1]) {
        throw new SponsorRefusalError(
            `refusing to sponsor: the halves do not mirror each other (maker gives ${m.give[1]} of ${m.give[0].slice(0, 16)}… for ${m.want[1]} of ${m.want[0].slice(0, 16)}…, ` +
            `taker gives ${t.give[1]} of ${t.give[0].slice(0, 16)}… for ${t.want[1]} of ${t.want[0].slice(0, 16)}…)`);
    }
    return {
        gives: { tokenType: m.give[0], amount: m.give[1].toString() },
        wants: { tokenType: m.want[0], amount: m.want[1].toString() }
    };
}

/** Throws unless the merged halves are one balanced offer: the sponsor adds dust, never value. */
export function assertSwapBalanced(merged: any, byteLength: number): void {
    const maxBytes = configNumber('NIGHTGATE_SPONSOR_MAX_TX_BYTES');
    if (byteLength > maxBytes) {
        throw new SponsorRefusalError(`refusing to sponsor: the merged swap is ${byteLength}B, over the ${maxBytes}B budget (NIGHTGATE_SPONSOR_MAX_TX_BYTES)`);
    }
    if (merged?.intents !== undefined && merged?.intents !== null && sizeOf(merged.intents) !== 0) {
        throw new SponsorRefusalError('refusing to sponsor: the merged swap carries an intent');
    }
    const deltas = merged?.guaranteedOffer?.deltas;
    if (sizeOf(deltas) !== 0) throw new SponsorRefusalError('refusing to sponsor: the merged swap does not net to zero');
    let imbalances: Array<[unknown, unknown]>;
    try { imbalances = Array.from(merged.imbalances(0).entries() as Iterable<[unknown, unknown]>); }
    catch (e) { throw new SponsorRefusalError(`refusing to sponsor: the merged swap's balance is not readable (${formatErr(e).slice(0, 80)})`); }
    if (imbalances.some(([, v]) => v !== 0n)) throw new SponsorRefusalError('refusing to sponsor: the merged swap does not balance');
}

/** A swap half arrives proven, bound (what an offer file carries) or unbound. */
async function deserializeSwapHalf(b64: string, label: string): Promise<{ tx: any; bound: boolean }> {
    const bytes = new Uint8Array(Buffer.from(String(b64 ?? ''), 'base64'));
    if (bytes.length === 0) throw new SponsorRefusalError(`refusing to sponsor: the ${label} is empty`);
    const ledger: any = await loadLedger();
    const errors: string[] = [];
    for (const binding of ['binding', 'pre-binding']) {
        try {
            return { tx: ledger.Transaction.deserialize('signature', 'proof', binding, bytes), bound: binding === 'binding' };
        } catch (e) {
            errors.push(`${binding}: ${formatErr(e).slice(0, 60)}`);
        }
    }
    throw new SponsorRefusalError(`refusing to sponsor: the ${label} is not a proven transaction (${bytes.length}B; ${errors.join(' | ')})`);
}

/**
 * Two checked halves as one transaction. Bound and unbound transactions do not
 * merge, so a bound half binds the other one; two unbound halves stay unbound.
 */
export function mergeSwapHalves(maker: { tx: any; bound: boolean }, taker: { tx: any; bound: boolean }): { tx: any; bound: boolean } {
    const bound = maker.bound || taker.bound;
    try {
        const m = bound && !maker.bound ? maker.tx.bind() : maker.tx;
        const t = bound && !taker.bound ? taker.tx.bind() : taker.tx;
        return { tx: m.merge(t), bound };
    } catch (e) {
        throw new SponsorRefusalError(`refusing to sponsor: the halves do not merge: ${formatErr(e).slice(0, 120)}`);
    }
}

/** Raw token types the calls of a checked transaction mint. */
function mintedTypesOf(tx: any, allowContractMints: boolean | undefined, ledger: any): string[] {
    if (allowContractMints !== true) return [];
    return Array.from(declaredMints(tx, () => true, tokenTypeDeriver(ledger)).keys());
}

/** `rawTokenType` of the ledger, from a hex domain separator. */
export function tokenTypeDeriver(ledger: any): (domainSeparatorHex: string, contractAddress: string) => string {
    return (domainSeparatorHex, contractAddress) =>
        String(ledger.rawTokenType(new Uint8Array(Buffer.from(domainSeparatorHex, 'hex')), contractAddress));
}

/** Marker entry point for a sponsored deploy in the returned call list. */
export const DEPLOY_ENTRY_POINT = '<deploy>';

/**
 * Fail-closed shape check before paying: an allowed call could carry a deploy,
 * transfers, offers or dust actions in the same envelope. Unreadable structure refuses.
 */
export function checkSponsorableShape(
    tx: any,
    byteLength: number,
    allowedContracts?: string[],
    allowedCircuits?: string[],
    options: {
        allowDeploy?: boolean; maxDeploys?: number; ownContracts?: string[]; allowedTokenTypes?: string[]; nightTokenType?: string;
        /** Set together: the platform sponsors contract mints, and how a type follows from domain separator and contract. */
        allowContractMints?: boolean; deriveTokenType?: (domainSeparatorHex: string, contractAddress: string) => string;
    } = {}
): Array<{ address: string; entryPoint: string }> {
    const tokenTypes = (options.allowedTokenTypes ?? []).map(normalizeTokenType);
    const nightType = options.nightTokenType ? normalizeTokenType(options.nightTokenType) : undefined;
    const contractSponsorable = (address: string): boolean =>
        !allowedContracts?.length || allowedContracts.includes(address)
        || (Array.isArray(options.ownContracts) && options.ownContracts.includes(address));
    const maxDeploysPerTx = Number.isInteger(options.maxDeploys) && (options.maxDeploys as number) >= 0 ? (options.maxDeploys as number) : 1;
    let deployCount = 0;
    const maxBytes = configNumber('NIGHTGATE_SPONSOR_MAX_TX_BYTES');
    if (byteLength > maxBytes) {
        throw new SponsorRefusalError(`refusing to sponsor: transaction is ${byteLength}B, over the ${maxBytes}B budget (NIGHTGATE_SPONSOR_MAX_TX_BYTES)`);
    }

    const intents: Map<number, any> | undefined = tx?.intents;
    if (!intents || typeof intents.entries !== 'function') {
        throw new SponsorRefusalError('refusing to sponsor: transaction structure is not inspectable (no intents)');
    }
    const mints: MintBudget = options.allowContractMints === true && options.deriveTokenType
        ? declaredMints(tx, contractSponsorable, options.deriveTokenType)
        : new Map();
    for (const key of ['guaranteedOffer', 'fallibleOffer', 'guaranteedCoins', 'fallibleCoins']) {
        const offer = (tx as any)[key];
        if (offer === undefined || offer === null) continue;
        const parts: unknown[] = typeof offer?.entries === 'function' && !('inputs' in offer)
            ? Array.from(offer.entries() as Iterable<[unknown, unknown]>).map(([, sub]) => sub)
            : [offer];
        for (const part of parts) {
            if (!offerNonEmpty(part)) continue;
            if (tokenTypes.length === 0 && mints.size === 0) throw new SponsorRefusalError(`refusing to sponsor: transaction carries a ${key} (shielded value transfer)`);
            checkOfferTokens(part, key, tokenTypes, nightType, contractSponsorable, mints);
        }
    }

    const calls: Array<{ address: string; entryPoint: string }> = [];
    for (const [, intent] of Array.from(intents.entries())) {
        // A sponsorable tx is fee-unpaid, so caller dust actions are refused like transfers.
        for (const key of ['guaranteedUnshieldedOffer', 'fallibleUnshieldedOffer', 'dustActions']) {
            if (offerNonEmpty(intent?.[key])) {
                throw new SponsorRefusalError(`refusing to sponsor: transaction carries ${key} alongside its contract calls`);
            }
        }
        for (const action of (intent?.actions ?? [])) {
            const ep = action?.entryPoint;
            const name = typeof ep === 'string' ? ep : (ep instanceof Uint8Array ? new TextDecoder().decode(ep) : '');
            if (!name) {
                const kind = action?.constructor?.name || typeof action;
                // Maintenance updates change contract authority: never sponsored.
                // Told apart from deploys by shape, not class name alone.
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
                    // Deploys write verifier keys: their own byte ceiling.
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
 * In-memory backing leases, TTL-expired so a crashed path frees them. The token
 * makes release ownership-checked: a late finisher must not delete a takeover's lock.
 */
export const noteLocks = new Map<string, { exp: number; token: number }>();
export let noteLeaseSeq = 0;

/**
 * Lock key = the backing NIGHT utxo, not the note: notes of one backing share
 * nullifier state, so concurrent spends on it conflict (1010/196).
 */
export function backingKey(sessionId: string, note: any): string {
    return `${sessionId}|${note?.token?.backingNight ?? '?'}`;
}
/** Dust a note holds, as a bigint; 0 for an unreadable value. */
export function noteSpecks(note: any): bigint {
    try { return BigInt(note?.generatedNow ?? 0); } catch { return 0n; }
}

/**
 * Lock the free backing with the most headroom, which spreads load by itself.
 * Value `notes` at the spend's block time: dust regenerates, a wall-clock read overstates it.
 */
export function tryLockBacking(sessionId: string, notes: any[], needSpecks: bigint, ttlMs: number, skipBackings: ReadonlySet<string> = new Set()): any | null {
    const now = Date.now();
    const eligible = notes
        .filter((n) => noteSpecks(n) >= needSpecks)
        .sort((a, b) => (noteSpecks(a) < noteSpecks(b) ? 1 : noteSpecks(a) > noteSpecks(b) ? -1 : 0));
    for (const n of eligible) {
        const key = backingKey(sessionId, n);
        if (skipBackings.has(key)) continue;
        const held = noteLocks.get(key);
        if (held && held.exp > now) continue;
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
/** Lock a free backing, waiting up to `waitMs`; serializes spends on a single-backing wallet. */
export async function acquireBacking(
    sessionId: string, refresh: () => Promise<any[]>, needSpecks: bigint, ttlMs: number, waitMs: number,
    skipBackings: ReadonlySet<string> = new Set()
): Promise<any> {
    const deadline = Date.now() + waitMs;
    for (; ;) {
        throwIfRpcCancelled('dust backing wait');
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
 * Renew a lease every ttl/3 while its job runs: the TTL is a crash backstop, an
 * active lease must never be taken over by time. Returns a stop function.
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
export function noteLeaseTtlMs(): number {
    return configMs('NIGHTGATE_NOTE_LEASE_MS');
}
export const __noteLeaseForTests = { tryLockBacking, sufficientNoteOnBacking, releaseNote, keepLeaseAlive, noteLeaseTtlMs, held: (key: string) => noteLocks.get(key), reset: () => noteLocks.clear() };

/** Balance dust onto a caller-finalized tx with the sponsor facade and submit. */
export async function sponsorAndSubmitFinalized(sponsor: FacadeEntry, rehydrated: any, site: string, replyPort?: MessagePort, calls?: Array<{ address: string; entryPoint: string }>, minted: string[] = []): Promise<string> {
    await waitForGenuineSync(sponsor, BALANCE_SYNC_TIMEOUT_MS, `${site} sponsor`);
    await captureDustSnapshot(sponsor, `${site} sponsor`);
    const sponsorTtl = new Date(Date.now() + 30 * 60 * 1000);
    const sponsorRecipe = await sponsor.facade.balanceFinalizedTransaction(
        rehydrated,
        { shieldedSecretKeys: sponsor.zswapKeys, dustSecretKey: sponsor.dustKey },
        { ttl: sponsorTtl, tokenKindsToBalance: ['dust'] }
    );
    const finalized = await sponsor.facade.finalizeRecipe(sponsorRecipe);
    // External-effect boundary: the main thread records the identifier and acks before the broadcast.
    try {
        await announceSubmitIntent(replyPort, {
            txHash: String(finalized.identifiers().at(-1)),
            contractAddress: calls?.[0]?.address, circuits: calls?.map(c => c.entryPoint), sponsorAccountId: sponsor.sessionId,
            deployed: calls?.filter(c => c.entryPoint === DEPLOY_ENTRY_POINT).map(c => c.address) ?? [],
            ttl: sponsorTtl.toISOString(),
            segments: callSegments(finalized),
            ...(minted.length ? { minted } : {})
        });
    } catch (e) {
        await revertRecipeBestEffort(sponsor.facade, finalized, `${site} sponsor-intent`);
        throw e;
    }
    return String(await submitWithDustGuard(sponsor, finalized, `${site} sponsor-submit`));
}

/** The optional sponsor facade; a missing one means the ensure step was skipped or it was evicted. */
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


/** Build, sign and finalize a contract call; returns the fee-unpaid tx as base64 without submitting. */
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

/** Policy-check a caller-finalized, fee-unpaid tx, pay its dust and submit. */
export async function sponsorFinalizedTx(args: {
    sponsorSessionId: string; finalizedTxB64: string; networkId: string;
    allowedContracts?: string[]; allowedCircuits?: string[]; allowDeploy?: boolean; ownContracts?: string[]; allowedTokenTypes?: string[]; allowContractMints?: boolean;
    /** Set by the dispatcher: the RPC reply port, for the pre-broadcast submit-intent handshake. */
    __replyPort?: MessagePort;
}) {
    const sponsor = resolveSponsorEntry(args.sponsorSessionId);
    if (!sponsor) throw new Error('sponsorFinalizedTx requires a sponsorSessionId');
    const sdk = await loadSdk();
    await ensureNetworkId(args.networkId, sdk);
    const { tx, bytes } = await deserializeFinalizedTx(args.finalizedTxB64);

    const calls = checkSponsorableShape(tx, bytes.length, args.allowedContracts, args.allowedCircuits, { allowDeploy: args.allowDeploy === true, ownContracts: args.ownContracts, allowedTokenTypes: args.allowedTokenTypes, nightTokenType: sdk.ledger.nativeToken().raw, allowContractMints: args.allowContractMints === true, deriveTokenType: tokenTypeDeriver(sdk.ledger) });
    log('info', `sponsorFinalizedTx: paying dust for ${calls.map(c => c.entryPoint).join('+')} (${bytes.length}B)`);
    const minted = mintedTypesOf(tx, args.allowContractMints, sdk.ledger);
    const txId = await sponsorAndSubmitFinalized(sponsor, tx, 'sponsor-endpoint', args.__replyPort, calls, minted);
    log('info', `sponsorFinalizedTx: LANDED txHash=${txId.slice(0, 16)}`);
    return {
        txHash: txId, circuits: calls.map(c => c.entryPoint), contractAddress: calls[0]?.address ?? '',
        deployed: calls.filter(c => c.entryPoint === DEPLOY_ENTRY_POINT).map(c => c.address),
        ...(minted.length ? { minted } : {})
    };
}

/** Re-selections of a backing whose fresh note came up short before giving up. */
export const MAX_BACKING_RESELECTS = 3;

export class DustBackingShortError extends Error {
    constructor(readonly backing: string, readonly held: bigint, readonly needed: bigint) {
        super(`dust backing ${backing} holds ${held} specks at the spend's block time, the fee needs ${needed}`);
        this.name = 'DustBackingShortError';
    }
}

/** Lowest segment id the tx leaves free; a merged dust intent must not share a segment. */
export function freeSegmentId(tx: any): number {
    const used = new Set<number>();
    const intents = tx?.intents;
    if (intents && typeof intents.keys === 'function') {
        for (const key of intents.keys()) used.add(Number(key));
    }
    for (let id = 1; id <= 65535; id++) {
        if (!used.has(id)) return id;
    }
    throw new SponsorRefusalError('refusing to sponsor: the transaction uses every segment id, none is left for the dust spend');
}

/** Dust-only spend on the leased backing, serialized per wallet under the session lock. */
async function buildDustSpend(
    sponsor: FacadeEntry, networkId: string, sdk: any, leased: any, needSpecks: bigint, ctime: Date, ttl: Date, segment: number
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
        const dustUnproven = sdk.ledger.Transaction.fromParts(networkId).addIntent({ tag: 'specific', value: segment }, intent);
        return { dustUnproven };
    });
}

/**
 * Parallel sponsoring of a pre-binding caller tx on one leased dust backing.
 * Not in SUBMIT_METHODS: it never mutates facade state (functional spendCoins,
 * dedicated submit client), and only the build runs under the session lock.
 */
export async function sponsorUnboundTx(args: {
    sponsorSessionId: string; unboundTxB64?: string; networkId: string;
    /** The two halves of a shielded swap instead of one caller transaction. */
    swap?: { makerHalfB64: string; takerHalfB64: string }; allowSwaps?: boolean;
    allowedContracts?: string[]; allowedCircuits?: string[]; allowDeploy?: boolean; ownContracts?: string[]; allowedTokenTypes?: string[]; allowContractMints?: boolean;
    /** Set by the dispatcher: the RPC reply port, for the pre-broadcast submit-intent handshake. */
    __replyPort?: MessagePort;
}) {
    const sponsor = resolveSponsorEntry(args.sponsorSessionId);
    if (!sponsor) throw new Error('sponsorUnboundTx requires a sponsorSessionId');
    const sdk = await loadSdk();
    await ensureNetworkId(args.networkId, sdk);

    let callerTx: any;
    // A caller transaction is unbound; a swap is bound as soon as one half arrived bound.
    let callerBound = false;
    let calls: Array<{ address: string; entryPoint: string }>;
    let swap: SwapTerms | undefined;
    let nullifiers: string[] = [];
    if (args.swap) {
        if (args.allowSwaps !== true) throw new SponsorRefusalError('refusing to sponsor: swaps are not sponsored for this caller');
        const maker = await deserializeSwapHalf(args.swap.makerHalfB64, 'maker half');
        const taker = await deserializeSwapHalf(args.swap.takerHalfB64, 'taker half');
        swap = checkSwapHalves(maker.tx, taker.tx, {
            allowedTokenTypes: args.allowedTokenTypes, nightTokenType: sdk.ledger.nativeToken().raw,
            maxInputs: configNumber('NIGHTGATE_SPONSOR_SWAP_MAX_INPUTS')
        });
        nullifiers = [...new Set([...swapHalfNullifiers(maker.tx), ...swapHalfNullifiers(taker.tx)])];
        const merged = mergeSwapHalves(maker, taker);
        callerTx = merged.tx;
        callerBound = merged.bound;
        assertSwapBalanced(callerTx, callerTx.serialize().length);
        calls = [{ address: '', entryPoint: SWAP_ENTRY_POINT }];
        log('info', `sponsorUnboundTx: swap of ${swap.gives.amount} ${swap.gives.tokenType.slice(0, 12)} for ${swap.wants.amount} ${swap.wants.tokenType.slice(0, 12)} (${callerBound ? 'bound' : 'unbound'} halves)`);
    } else {
        const deserialized = await deserializeFinalizedTx(String(args.unboundTxB64 ?? ''));
        callerTx = deserialized.tx;
        calls = checkSponsorableShape(callerTx, deserialized.bytes.length, args.allowedContracts, args.allowedCircuits, { allowDeploy: args.allowDeploy === true, ownContracts: args.ownContracts, allowedTokenTypes: args.allowedTokenTypes, nightTokenType: sdk.ledger.nativeToken().raw, allowContractMints: args.allowContractMints === true, deriveTokenType: tokenTypeDeriver(sdk.ledger) });
    }
    const minted = swap ? [] : mintedTypesOf(callerTx, args.allowContractMints, sdk.ledger);
    const contractAddress = calls[0]?.address || undefined;

    // Fixed before proving, so the proof covers it.
    const dustSegment = freeSegmentId(callerTx);

    await waitForGenuineSync(sponsor, BALANCE_SYNC_TIMEOUT_MS, 'sponsor-unbound');

    const params = sdk.ledger.LedgerParameters.initialParameters();
    let needSpecks: bigint;
    try { needSpecks = callerTx.feesWithMargin(params, 2); }
    catch { needSpecks = 100_000_000n; } // fallback floor if the estimate API shifts
    if (needSpecks <= 0n) needSpecks = 100_000_000n;

    // Read `facade.dust` at each use, never cache it: a dust restore swaps the object.
    const leaseTtlMs = noteLeaseTtlMs();
    const backingWaitMs = configMs('NIGHTGATE_BACKING_WAIT_MS');

    const tip = await getIndexerTip(sponsor.indexerHttpUrl);
    const ctime = (() => {
        const t = tip.timestampMs;
        if (t == null || !Number.isFinite(t)) return new Date();
        const ms = t > 1e12 ? t : t * 1000; // < 1e12 => seconds
        const d = new Date(ms);
        return Number.isNaN(d.getTime()) ? new Date() : d;
    })();
    const ttl = new Date(ctime.getTime() + 30 * 60 * 1000);

    const snapshotNotes = async (at: Date): Promise<any[]> => {
        const dws: any = await firstDustState(sponsor.facade.dust);
        const cab = dws.capabilities.coinsAndBalances;
        return Array.from(cab.getAvailableCoins(dws.state, at));
    };
    // Backings that came up short under the lock are skipped for this call.
    const shortBackings = new Set<string>();
    let leased: any;
    let built: { dustUnproven: any } | undefined;
    let stopRenewal: () => void = () => undefined;
    for (let attempt = 0; ; attempt++) {
        leased = await acquireBacking(sponsor.sessionId, () => snapshotNotes(ctime), needSpecks, leaseTtlMs, backingWaitMs, shortBackings);
        stopRenewal = keepLeaseAlive(leased.key, leased.token, leaseTtlMs);
        try {
            built = await buildDustSpend(sponsor, args.networkId, sdk, leased, needSpecks, ctime, ttl, dustSegment);
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
        const tProve = Date.now();
        let provingService: any = sponsor.facade?.provingService;
        if (!provingService?.prove) {
            const provingSdk = await loadProvingSdk();
            const sharedKeys = await getSharedKeyMaterialProvider();
            provingService = provingSdk.makeWasmProvingService({ keyMaterialProvider: sharedKeys });
        }
        const dustProven = await provingService.prove(built!.dustUnproven);
        log('info', `sponsorUnboundTx: dust spend proven in ${Date.now() - tProve}ms (${sponsor.facade?.provingService?.prove ? resolveProvingMode() : 'wasm'})`);
        const bound = callerBound ? dustProven.bind().merge(callerTx) : dustProven.merge(callerTx).bind();
        // External-effect boundary: wait for the main thread's ack before anything leaves the process.
        await announceSubmitIntent(args.__replyPort, {
            txHash: String(bound.identifiers().at(-1)),
            contractAddress, circuits: calls.map(c => c.entryPoint), note: leased.backing, sponsorAccountId: sponsor.sessionId,
            deployed: calls.filter(c => c.entryPoint === DEPLOY_ENTRY_POINT).map(c => c.address),
            ttl: ttl.toISOString(),
            segments: callSegments(bound),
            ...(minted.length ? { minted } : {}),
            ...(nullifiers.length ? { nullifiers } : {})
        });
        const txId = await submitOnDedicatedClient(sponsor, bound, 'sponsor-unbound-submit');
        log('info', `sponsorUnboundTx: LANDED txHash=${String(txId).slice(0, 16)} on backing ${leased.backing}`);
        return {
            txHash: String(txId), circuits: calls.map(c => c.entryPoint), contractAddress: contractAddress ?? '', note: leased.backing,
            deployed: calls.filter(c => c.entryPoint === DEPLOY_ENTRY_POINT).map(c => c.address),
            ...(minted.length ? { minted } : {}),
            ...(swap ? { swap } : {}),
            ...(nullifiers.length ? { nullifiers } : {})
        };
    } finally {
        stopRenewal();
        releaseNote(leased.key, leased.token);
    }
}

export const sponsorHandlers = { buildSponsorableTx, sponsorFinalizedTx, sponsorUnboundTx, describeSwapHalf };
