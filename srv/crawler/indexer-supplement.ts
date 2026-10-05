/**
 * Fetches one block from the Midnight indexer and maps the data that the node's block does not contain.
 *
 * Examples are contract state after a call, the indexer's ledger event lists,
 * the result of each transaction segment, and the DUST registration flag of a UTXO.
 * The indexer is therefore a second data source, with its own cursor, separate from the node.
 */

const BLOCK_QUERY = `query($height: Int!) {
  block(offset: { height: $height }) {
    height
    ledgerParameters
    transactions {
      hash
      unshieldedCreatedOutputs { intentHash outputIndex registeredForDustGeneration }
      contractActions { __typename address state zswapState unshieldedBalances { tokenType amount } }
      zswapLedgerEvents { id raw maxId }
      dustLedgerEvents {
        __typename id raw maxId
        ... on DustInitialUtxo { output { nonce } }
      }
      ... on RegularTransaction {
        fee
        transactionResult { status segments { id success } }
      }
    }
  }
}`;

export interface SupplementSegment {
    segmentId: number;
    success: boolean;
}

export interface SupplementBalance {
    tokenType: string;
    amount: string;
}

export interface SupplementContractAction {
    actionType: 'DEPLOY' | 'CALL' | 'UPDATE';
    address: string;
    /** Base64, the format CAP uses for a LargeBinary. */
    state: string | null;
    zswapState: string | null;
    balances: SupplementBalance[];
}

export interface SupplementLedgerEvent {
    eventId: number;
    maxId: number;
    raw: string | null;
}

export interface SupplementDustEvent extends SupplementLedgerEvent {
    eventType: 'DTIME_UPDATE' | 'INITIAL_UTXO' | 'SPEND_PROCESSED' | 'PARAM_CHANGE';
    /** Nonce of the DUST output. Set only for INITIAL_UTXO. */
    dustOutputNonce: string | null;
}

export interface SupplementTransaction {
    ledgerTxHash: string;
    status: string | null;
    /** Computing the fee needs ledger parameters the node does not provide, so it comes from the indexer. */
    fee: string | null;
    segments: SupplementSegment[];
    contractActions: SupplementContractAction[];
    zswapEvents: SupplementLedgerEvent[];
    dustEvents: SupplementDustEvent[];
    dustRegisteredOutputs: Array<{ intentHash: string; outputIndex: number }>;
}

export interface SupplementBlock {
    height: number;
    /** Base64. The node does not provide these parameters. */
    ledgerParameters: string | null;
    transactions: SupplementTransaction[];
}

const hex = (value: unknown): string => String(value ?? '').replace(/^0x/i, '').toLowerCase();

function toInt(value: unknown): number {
    const n = Number(String(value ?? '').replace(/[,_\s]/g, ''));
    return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function toBinary(value: unknown): string | null {
    const clean = hex(value);
    if (!clean || clean.length % 2 !== 0) return null;
    return Buffer.from(clean, 'hex').toString('base64');
}

const ACTION_TYPE: Record<string, SupplementContractAction['actionType']> = {
    ContractDeploy: 'DEPLOY',
    ContractCall: 'CALL',
    ContractUpdate: 'UPDATE'
};

function readEvents(list: unknown): SupplementLedgerEvent[] {
    if (!Array.isArray(list)) return [];
    return list.map((e: any) => ({
        eventId: toInt(e?.id),
        maxId: toInt(e?.maxId),
        raw: toBinary(e?.raw)
    }));
}

const DUST_EVENT_TYPE: Record<string, SupplementDustEvent['eventType']> = {
    DustGenerationDtimeUpdate: 'DTIME_UPDATE',
    DustInitialUtxo: 'INITIAL_UTXO',
    DustSpendProcessed: 'SPEND_PROCESSED',
    ParamChange: 'PARAM_CHANGE'
};

function readDustEvents(list: unknown): SupplementDustEvent[] {
    if (!Array.isArray(list)) return [];
    const out: SupplementDustEvent[] = [];
    for (const e of list as any[]) {
        const eventType = DUST_EVENT_TYPE[String(e?.__typename)];
        // Unknown kinds are skipped, so they are never stored under a wrong kind.
        if (!eventType) continue;
        out.push({
            eventId: toInt(e?.id),
            maxId: toInt(e?.maxId),
            raw: toBinary(e?.raw),
            eventType,
            dustOutputNonce: eventType === 'INITIAL_UTXO' ? (hex(e?.output?.nonce) || null) : null
        });
    }
    return out;
}

export function readSupplementBlock(payload: any): SupplementBlock | null {
    const block = payload?.block;
    if (!block) return null;

    const transactions: SupplementTransaction[] = [];
    for (const tx of block.transactions ?? []) {
        const ledgerTxHash = hex(tx?.hash);
        if (!ledgerTxHash) continue;

        const contractActions: SupplementContractAction[] = [];
        for (const action of tx.contractActions ?? []) {
            const actionType = ACTION_TYPE[String(action?.__typename)];
            const address = hex(action?.address);
            if (!actionType || !address) continue;
            contractActions.push({
                actionType,
                address,
                state: toBinary(action?.state),
                zswapState: toBinary(action?.zswapState),
                balances: (action?.unshieldedBalances ?? [])
                    .map((b: any) => ({ tokenType: hex(b?.tokenType), amount: String(b?.amount ?? '0') }))
                    .filter((b: SupplementBalance) => b.tokenType)
            });
        }

        transactions.push({
            ledgerTxHash,
            status: tx?.transactionResult?.status ?? null,
            fee: tx?.fee == null ? null : String(tx.fee),
            segments: (tx?.transactionResult?.segments ?? [])
                .map((s: any) => ({ segmentId: toInt(s?.id), success: Boolean(s?.success) })),
            contractActions,
            zswapEvents: readEvents(tx?.zswapLedgerEvents),
            dustEvents: readDustEvents(tx?.dustLedgerEvents),
            dustRegisteredOutputs: (tx?.unshieldedCreatedOutputs ?? [])
                .filter((u: any) => u?.registeredForDustGeneration)
                .map((u: any) => ({ intentHash: hex(u?.intentHash), outputIndex: toInt(u?.outputIndex) }))
        });
    }

    return {
        height: toInt(block.height),
        ledgerParameters: toBinary(block.ledgerParameters),
        transactions
    };
}

export interface IndexerClient {
    fetchBlock(height: number): Promise<SupplementBlock | null>;
}

/** A non-2xx response from the indexer. The caller uses the status to decide how long to back off. */
export class IndexerHttpError extends Error {
    constructor(readonly status: number) {
        super(`indexer answered ${status}`);
        this.name = 'IndexerHttpError';
    }
}

/**
 * True for 403 and 429, which mean the indexer refuses this client.
 * The public indexer blocks the host's whole IP when it gets too many requests.
 * That block also cuts off the sponsor wallets on the same host.
 */
export function isIndexerRateLimit(err: unknown): boolean {
    return err instanceof IndexerHttpError && (err.status === 403 || err.status === 429);
}

async function postQuery(url: string, query: string, variables: Record<string, unknown>, timeoutMs: number, what: string): Promise<any> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ query, variables }),
            signal: controller.signal
        });
        if (!res.ok) throw new IndexerHttpError(res.status);
        const body: any = await res.json();
        if (body?.errors?.length) {
            throw new Error(`indexer rejected the ${what} query: ${JSON.stringify(body.errors).slice(0, 200)}`);
        }
        return body?.data;
    } finally {
        clearTimeout(timer);
    }
}

export function createIndexerClient(url: string, timeoutMs = 20000): IndexerClient {
    return {
        async fetchBlock(height: number): Promise<SupplementBlock | null> {
            return readSupplementBlock(await postQuery(url, BLOCK_QUERY, { height }, timeoutMs, 'block'));
        }
    };
}

const CONTRACT_STATE_QUERY = `query($address: HexEncoded!, $offset: ContractActionOffset) {
  contractAction(address: $address, offset: $offset) { state zswapState }
}`;

/**
 * A contract's state at `height`, or its latest state when no height is given. Values are base64.
 * Returns null when the indexer has no action of the contract up to that height.
 */
export async function fetchContractState(
    url: string,
    address: string,
    height: number | null,
    timeoutMs = 20000
): Promise<{ state: string | null; zswapState: string | null } | null> {
    const offset = height == null ? null : { blockOffset: { height } };
    const data = await postQuery(url, CONTRACT_STATE_QUERY, { address, offset }, timeoutMs, 'contract state');
    const action = data?.contractAction;
    if (!action) return null;
    return { state: toBinary(action.state), zswapState: toBinary(action.zswapState) };
}
