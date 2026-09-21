/**
 * Reads the serialized ledger transaction inside a `Midnight.send_mn_transaction`
 * extrinsic.
 *
 * What the block's events report is the OUTCOME; the payload is what the
 * transaction asked for, and it is the only place the circuit name of a call,
 * the zswap offers and the DUST actions appear. Deserializing costs tens of
 * milliseconds in wasm, which is why this runs in its own pass rather than in
 * the crawl loop.
 */

import { decodeCompact } from '../utils/scale';
import { loadLedgerV8 } from '../midnight/sdk-loader';
import { stripContractAddressPrefix } from './block-events';

/** One contract action as the transaction declared it, in intent order. */
export interface DeclaredContractAction {
    address: string;
    /** Circuit name for a call; absent on a deploy or a maintenance update. */
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
     * Sum of the DUST spends' `vFee`: the DUST this transaction's spends
     * declare. NOT the fee the indexer reports, which is a different figure
     * (measured: 3e14 here against 1 there on the same transaction).
     */
    dustSpendValue: bigint;
}

/**
 * The ledger transaction bytes of an extrinsic body, or null when the call
 * carries none. `send_mn_transaction(midnight_tx: Vec<u8>)` puts them behind a
 * compact length prefix at the start of the argument region.
 */
export function extractLedgerPayload(buf: Buffer, argsOffset: number): Uint8Array | null {
    const compact = decodeCompact(buf, argsOffset);
    if (!compact) return null;
    const [length, prefixSize] = compact;
    const start = argsOffset + prefixSize;
    if (length <= 0 || start + length > buf.length) return null;
    return new Uint8Array(buf.subarray(start, start + length));
}

/** On-chain transactions are signed, proven and bound; the rest are for a caller's own bytes. */
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
            errors.push(`(${s},${p},${b}) ${String((err as Error)?.message ?? err).slice(0, 80)}`);
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

/** Reading one accessor must not cost the whole transaction. */
function safe<T>(read: () => T, fallback: T): T {
    try {
        const value = read();
        return value === undefined ? fallback : value;
    } catch {
        return fallback;
    }
}

/** Everything the stored columns want out of one deserialized transaction. */
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

    // Segment order is the order the ledger applies them in, so the actions come
    // out in the same order the events report them.
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

/** Deserializes the payload and reads it; throws when no marker combination fits. */
export async function decodeLedgerPayload(bytes: Uint8Array): Promise<LedgerPayloadFacts> {
    const ledger = await loadLedgerV8();
    return readLedgerFacts(deserialize(ledger, bytes));
}
