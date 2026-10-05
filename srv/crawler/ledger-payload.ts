/**
 * Reads the serialized ledger transaction inside a `Midnight.send_mn_transaction` extrinsic.
 *
 * The block's events say what happened. The transaction itself is the only place that names
 * the called circuit, the zswap offers and the DUST actions.
 * Decoding is slow, so it runs in a separate pass and not in the main crawl loop.
 */

import { decodeCompact } from '../utils/scale';
import { loadLedgerV8 } from '../midnight/sdk-loader';
import { stripContractAddressPrefix } from './block-events';
import { errorMessage } from '../utils/errors';

/** One contract action as the transaction declared it, in intent order. */
export interface DeclaredContractAction {
    address: string;
    /** Circuit name of a call. Null for a deploy or a maintenance update. */
    entryPoint: string | null;
}

export interface LedgerPayloadFacts {
    identifiers: string[];
    contractActions: DeclaredContractAction[];
    zswapInputCount: number;
    zswapOutputCount: number;
    zswapTransientCount: number;
    dustSpendCount: number;
    dustRegistrationCount: number;
    /**
     * Sum of `vFee` over the transaction's DUST spends.
     * This is not the fee the Midnight indexer reports, which is a different number.
     */
    dustSpendValue: bigint;
}

/** The ledger transaction bytes follow a SCALE compact length prefix at the start of the call arguments. */
export function extractLedgerPayload(buf: Buffer, argsOffset: number): Uint8Array | null {
    const compact = decodeCompact(buf, argsOffset);
    if (!compact) return null;
    const [length, prefixSize] = compact;
    const start = argsOffset + prefixSize;
    if (length <= 0 || start + length > buf.length) return null;
    return new Uint8Array(buf.subarray(start, start + length));
}

/**
 * Serialization variants to try, in order. On-chain transactions use the first one.
 * The others cover transactions that are not yet bound or have erased signatures.
 */
const MARKERS: ReadonlyArray<readonly [string, string, string]> = [
    ['signature', 'proof', 'binding'],
    ['signature', 'proof', 'pre-binding'],
    ['signature-erased', 'proof', 'binding']
];

function deserialize(ledger: any, bytes: Uint8Array): any {
    const errors: string[] = [];
    for (const [s, p, b] of MARKERS) {
        try {
            const tx = ledger.Transaction.deserialize(s, p, b, bytes);
            if (tx) return tx;
        } catch (err) {
            errors.push(`(${s},${p},${b}) ${errorMessage(err).slice(0, 80)}`);
        }
    }
    throw new Error(`no marker combination deserialized ${bytes.length} bytes: ${errors.join(' | ')}`);
}

function hex(value: unknown): string {
    if (value == null) return '';
    if (typeof value === 'string') return value.replace(/^0x/i, '').toLowerCase();
    if (value instanceof Uint8Array) return Buffer.from(value).toString('hex');
    return String(value).replace(/^0x/i, '').toLowerCase();
}

function entryPointOf(action: any): string | null {
    const ep = action?.entryPoint;
    if (typeof ep === 'string') return ep;
    if (ep instanceof Uint8Array) return new TextDecoder().decode(ep);
    return null;
}

/** Returns the fallback if a read throws, so one bad field does not lose the whole transaction. */
function safe<T>(read: () => T, fallback: T): T {
    try {
        const value = read();
        return value === undefined ? fallback : value;
    } catch {
        return fallback;
    }
}

export function readLedgerFacts(tx: any): LedgerPayloadFacts {
    const facts: LedgerPayloadFacts = {
        identifiers: safe(() => (tx.identifiers() ?? []).map(hex).filter(Boolean), []),
        contractActions: [],
        zswapInputCount: 0,
        zswapOutputCount: 0,
        zswapTransientCount: 0,
        dustSpendCount: 0,
        dustRegistrationCount: 0,
        dustSpendValue: 0n
    };

    const countOffer = (offer: any): void => {
        if (!offer) return;
        facts.zswapInputCount += safe(() => offer.inputs?.length ?? 0, 0);
        facts.zswapOutputCount += safe(() => offer.outputs?.length ?? 0, 0);
        facts.zswapTransientCount += safe(() => offer.transients?.length ?? 0, 0);
    };
    countOffer(safe(() => tx.guaranteedOffer, undefined));
    const fallible = safe(() => tx.fallibleOffer, undefined);
    if (fallible && typeof fallible.values === 'function') {
        for (const offer of Array.from(fallible.values() as Iterable<any>)) countOffer(offer);
    }

    const intents = safe(() => tx.intents, undefined);
    if (!intents || typeof intents.entries !== 'function') return facts;

    // Sorted by segment, the order in which the ledger applies them.
    // This gives the actions in the same order as the block events.
    const bySegment = Array.from(intents.entries() as Iterable<[number, any]>)
        .sort((a, b) => Number(a[0]) - Number(b[0]));

    for (const [, intent] of bySegment) {
        for (const action of safe(() => intent?.actions ?? [], [])) {
            const address = stripContractAddressPrefix(hex(safe(() => action?.address, '')));
            if (address) facts.contractActions.push({ address, entryPoint: entryPointOf(action) });
        }
        const dust = safe(() => intent?.dustActions, undefined);
        if (!dust) continue;
        const spends = safe(() => dust.spends ?? [], []);
        facts.dustSpendCount += spends.length;
        facts.dustRegistrationCount += safe(() => dust.registrations?.length ?? 0, 0);
        for (const spend of spends) {
            const fee = safe(() => spend?.vFee, undefined);
            if (typeof fee === 'bigint') facts.dustSpendValue += fee;
        }
    }

    return facts;
}

export function carriesShieldedCoins(facts: LedgerPayloadFacts): boolean {
    return facts.zswapInputCount + facts.zswapOutputCount + facts.zswapTransientCount > 0;
}

/** DUST spends are ignored here, because every transaction that pays a fee has one. */
export function carriesProof(facts: LedgerPayloadFacts): boolean {
    return carriesShieldedCoins(facts) || facts.contractActions.some(a => a.entryPoint !== null);
}

/**
 * The type of a transaction without contract actions, or null.
 * Block events only report contract actions and unshielded transfers.
 * Other transactions get their real type only from the decoded payload.
 */
export function callFreeTxType(facts: LedgerPayloadFacts): 'shielded_transfer' | 'dust_registration' | null {
    if (facts.contractActions.length > 0) return null;
    if (carriesShieldedCoins(facts)) return 'shielded_transfer';
    if (facts.dustRegistrationCount > 0) return 'dust_registration';
    return null;
}

export async function decodeLedgerPayload(bytes: Uint8Array): Promise<LedgerPayloadFacts> {
    const ledger = await loadLedgerV8();
    return readLedgerFacts(deserialize(ledger, bytes));
}
