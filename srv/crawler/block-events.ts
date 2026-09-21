/**
 * Reads the per-extrinsic facts out of one block's decoded `System.Events`.
 *
 * The Midnight pallet reports the applied result of a ledger transaction:
 * which unshielded UTxOs it consumed and produced, which contracts it touched,
 * and whether every segment applied. That is the only place a block carries it;
 * the extrinsic itself holds the serialized ledger transaction, which states
 * intent, not outcome.
 */

/** One entry of a `Midnight.UnshieldedTokens` spent/created list. */
export interface UtxoEvent {
    /** Raw 32-byte owner, lower-case hex without `0x`. */
    address: string;
    tokenType: string;
    intentHash: string;
    value: bigint;
    outputNo: number;
}

/**
 * A contract action that APPLIED. The pallet stays silent about one whose
 * fallible segment failed, so a partial success reports fewer actions than the
 * transaction declared.
 */
export interface ContractEvent {
    actionType: 'DEPLOY' | 'CALL' | 'UPDATE';
    /** Bare 32-byte address, the form the indexer and the submission side use. */
    address: string;
}

export interface ExtrinsicEvents {
    outcome?: 'SUCCESS' | 'FAILURE';
    /**
     * Hash of the ledger transaction inside the extrinsic, as the pallet
     * reports it. Not the extrinsic hash: this is what the Midnight indexer
     * keys a transaction by.
     */
    ledgerTxHash?: string;
    /** `TxApplied` or `TxPartialSuccess`: the pallet reported on this extrinsic. */
    applied: boolean;
    /** `TxPartialSuccess`: applied, but not every segment succeeded. */
    partialSuccess: boolean;
    created: UtxoEvent[];
    spent: UtxoEvent[];
    contracts: ContractEvent[];
}

const CONTRACT_ACTION_BY_METHOD: Record<string, ContractEvent['actionType']> = {
    ContractDeploy: 'DEPLOY',
    ContractCall: 'CALL',
    ContractMaintain: 'UPDATE'
};

/** `toHuman()` renders integers with thousands separators. */
function toBigInt(value: unknown): bigint {
    if (typeof value === 'bigint') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.trunc(value));
    const text = String(value ?? '').replace(/[,_\s]/g, '');
    if (!/^\d+$/.test(text)) return 0n;
    return BigInt(text);
}

function toInt(value: unknown): number {
    const big = toBigInt(value);
    return big <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(big) : 0;
}

function hex(value: unknown): string {
    return String(value ?? '').replace(/^0x/i, '').toLowerCase();
}

/**
 * Contract addresses reach the event as `midnight:contract-address[vN]:` plus
 * the 32 bytes; every other surface (indexer, submission side) uses the bytes
 * alone.
 */
export function stripContractAddressPrefix(rawHex: string): string {
    const clean = hex(rawHex);
    if (clean.length <= 64 || clean.length % 2 !== 0) return clean;
    const prefixBytes = Buffer.from(clean.slice(0, clean.length - 64), 'hex');
    const prefix = prefixBytes.toString('latin1');
    if (!/^[\x20-\x7e]+:$/.test(prefix)) return clean;
    return clean.slice(-64);
}

function readUtxoList(list: unknown): UtxoEvent[] {
    if (!Array.isArray(list)) return [];
    const out: UtxoEvent[] = [];
    for (const entry of list) {
        if (!entry || typeof entry !== 'object') continue;
        const e = entry as Record<string, unknown>;
        const intentHash = hex(e.intentHash);
        const address = hex(e.address);
        if (!intentHash || !address) continue;
        out.push({
            address,
            tokenType: hex(e.tokenType),
            intentHash,
            value: toBigInt(e.value),
            outputNo: toInt(e.outputNo)
        });
    }
    return out;
}

function emptyEvents(): ExtrinsicEvents {
    return { applied: false, partialSuccess: false, created: [], spent: [], contracts: [] };
}

/**
 * Per-extrinsic events of one block, keyed by extrinsic index. `records` is a
 * decoded `Vec<EventRecord>`; a record whose payload does not read is skipped
 * rather than failing the block.
 */
export function readBlockEvents(records: Iterable<any>): Map<number, ExtrinsicEvents> {
    const byExtrinsic = new Map<number, ExtrinsicEvents>();

    const at = (index: number): ExtrinsicEvents => {
        let entry = byExtrinsic.get(index);
        if (!entry) { entry = emptyEvents(); byExtrinsic.set(index, entry); }
        return entry;
    };

    for (const record of records) {
        if (!record?.phase?.isApplyExtrinsic) continue;
        const index = record.phase.asApplyExtrinsic.toNumber();
        const section = String(record.event?.section ?? '').toLowerCase();
        const method = String(record.event?.method ?? '');

        if (section === 'system') {
            // A failure wins: the extrinsic did not apply at all.
            if (method === 'ExtrinsicFailed') at(index).outcome = 'FAILURE';
            else if (method === 'ExtrinsicSuccess' && at(index).outcome !== 'FAILURE') at(index).outcome = 'SUCCESS';
            continue;
        }
        if (section !== 'midnight') continue;

        let payload: any;
        try { payload = record.event.data.toHuman()?.[0]; } catch { continue; }
        if (payload == null) continue;

        const txHash = hex(payload.txHash);
        if (txHash) at(index).ledgerTxHash = txHash;

        if (method === 'UnshieldedTokens') {
            const entry = at(index);
            entry.created.push(...readUtxoList(payload.created));
            entry.spent.push(...readUtxoList(payload.spent));
            continue;
        }
        const actionType = CONTRACT_ACTION_BY_METHOD[method];
        if (actionType) {
            const address = stripContractAddressPrefix(payload.contractAddress);
            if (address) at(index).contracts.push({ actionType, address });
            continue;
        }
        if (method === 'TxApplied') at(index).applied = true;
        else if (method === 'TxPartialSuccess') {
            const entry = at(index);
            entry.applied = true;
            entry.partialSuccess = true;
        }
    }

    return byExtrinsic;
}

/**
 * The transaction type an event set implies. Contract activity outranks a token
 * movement: a contract call that also moves unshielded tokens is a call.
 */
export function txTypeFromEvents(events: ExtrinsicEvents | undefined): string | null {
    if (!events) return null;
    for (const { actionType } of events.contracts) {
        if (actionType === 'DEPLOY') return 'contract_deploy';
    }
    for (const { actionType } of events.contracts) {
        if (actionType === 'UPDATE') return 'contract_update';
    }
    if (events.contracts.length) return 'contract_call';
    if (events.created.length || events.spent.length) return 'night_transfer';
    return null;
}

/** All-zero raw token type: unshielded NIGHT. */
export const NIGHT_RAW_TOKEN_TYPE = '0'.repeat(64);

export interface TransferProjection {
    senderAddress: string | null;
    receiverAddress: string | null;
    nightAmount: bigint | null;
}

/**
 * Sender, receiver and moved NIGHT of a transfer, in the raw address form.
 * Only an unambiguous one-to-one movement projects: with several funding or
 * several receiving addresses the columns stay null rather than naming one
 * participant as "the" sender.
 */
export function projectTransfer(events: ExtrinsicEvents | undefined): TransferProjection {
    const none: TransferProjection = { senderAddress: null, receiverAddress: null, nightAmount: null };
    if (!events) return none;

    const senders = new Set(events.spent.map(u => u.address));
    if (senders.size !== 1) return none;
    const senderAddress = [...senders][0];

    const receivers = new Set(events.created.filter(u => u.address !== senderAddress).map(u => u.address));
    if (receivers.size > 1) return none;
    if (receivers.size === 0) return { senderAddress, receiverAddress: null, nightAmount: null };

    const receiverAddress = [...receivers][0];
    let nightAmount = 0n;
    for (const utxo of events.created) {
        if (utxo.address === receiverAddress && utxo.tokenType === NIGHT_RAW_TOKEN_TYPE) nightAmount += utxo.value;
    }
    return { senderAddress, receiverAddress, nightAmount };
}
