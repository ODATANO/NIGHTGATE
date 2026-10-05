/**
 * Reads the result of each extrinsic from a block's decoded `System.Events`.
 *
 * The Midnight pallet reports what a ledger transaction actually did.
 * That covers the unshielded UTXOs it spent and created, the contracts it touched, and whether all of it succeeded.
 * The extrinsic itself only holds what the transaction asked for, not the result.
 */

export interface UtxoEvent {
    /** Raw 32-byte owner, lower-case hex without `0x`. */
    address: string;
    tokenType: string;
    intentHash: string;
    value: bigint;
    outputNo: number;
}

/**
 * A contract action that was applied. The pallet reports no event for a failed action,
 * so a partly successful transaction reports fewer actions than it contains.
 */
export interface ContractEvent {
    actionType: 'DEPLOY' | 'CALL' | 'UPDATE';
    /** Plain 32-byte address, as used by the Midnight indexer and the submission code. */
    address: string;
}

export interface ExtrinsicEvents {
    outcome?: 'SUCCESS' | 'FAILURE';
    /**
     * Hash of the ledger transaction inside the extrinsic.
     * This is not the extrinsic hash. The Midnight indexer identifies transactions by this hash.
     */
    ledgerTxHash?: string;
    applied: boolean;
    /** True on `TxPartialSuccess`: the transaction was applied, but not every part succeeded. */
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

/** `toHuman()` writes integers with thousands separators. */
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

/** Events carry `midnight:contract-address[vN]:` plus the 32 bytes. Everywhere else only the 32 bytes are used. */
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

/** A record that cannot be read is skipped, so the rest of the block is still processed. */
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
            // A failure always wins, because then the extrinsic did not apply at all.
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

/** Contract activity wins over a token transfer, so a contract call that also moves tokens counts as a call. */
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

/** The raw token type of unshielded NIGHT, which is all zeros. */
export const NIGHT_RAW_TOKEN_TYPE = '0'.repeat(64);

export interface TransferProjection {
    senderAddress: string | null;
    receiverAddress: string | null;
    nightAmount: bigint | null;
}

/**
 * Filled only for a transfer from one address to one other address.
 * With several senders or receivers the fields stay null, because no single one is "the" sender.
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
