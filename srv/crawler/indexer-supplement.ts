/**
 * The Midnight indexer's answer for one block, and how it maps onto the
 * entities a block alone cannot fill.
 *
 * Contract balances are the contract's state AFTER apply, the two ledger-event
 * streams are the indexer's own sequence, per-segment outcomes are not in any
 * event, and a UTXO's DUST registration flag changes after the UTXO exists.
 * None of that is derivable from the block the crawler already has, so this is
 * a SECOND source with its own cursor, kept clearly apart from the node pass.
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
    /** Base64, the form CAP stores a LargeBinary in. */
    state: string | null;
    zswapState: string | null;
    balances: SupplementBalance[];
}

export interface SupplementLedgerEvent {
    eventId: number;
    maxId: number;
    /** Base64. */
    raw: string | null;
}

export interface SupplementDustEvent extends SupplementLedgerEvent {
    eventType: 'DTIME_UPDATE' | 'INITIAL_UTXO' | 'SPEND_PROCESSED' | 'PARAM_CHANGE';
    /** The backing DUST output's nonce; INITIAL_UTXO only. */
    dustOutputNonce: string | null;
}

export interface SupplementTransaction {
    ledgerTxHash: string;
    status: string | null;
    /**
     * The fee this transaction paid. Reproduced exactly by
     * `Transaction.fees(block.ledgerParameters)` from the ledger, which needs
     * per-block parameters the node does not serve, so the indexer is the
     * practical source.
     */
    fee: string | null;
    segments: SupplementSegment[];
    contractActions: SupplementContractAction[];
    zswapEvents: SupplementLedgerEvent[];
    dustEvents: SupplementDustEvent[];
    /** `(intentHash, outputIndex)` of the created outputs registered for DUST. */
    dustRegisteredOutputs: Array<{ intentHash: string; outputIndex: number }>;
}

export interface SupplementBlock {
    height: number;
    /** Base64; the node serves only a storage key for the ledger state. */
    ledgerParameters: string | null;
    transactions: SupplementTransaction[];
}

const hex = (value: unknown): string => String(value ?? '').replace(/^0x/i, '').toLowerCase();

function toInt(value: unknown): number {
    const n = Number(String(value ?? '').replace(/[,_\s]/g, ''));
    return Number.isFinite(n) ? Math.trunc(n) : 0;
}

/** The indexer serves bytes as hex; CAP wants base64 for a LargeBinary. */
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

/** The DUST stream is an interface; the concrete type names the kind. */
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
        // An unknown kind is dropped rather than filed under a wrong one.
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

/** Maps one `block` payload; a transaction without a ledger hash is skipped. */
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

/** A non-2xx answer from the indexer, with the status for the caller's backoff. */
export class IndexerHttpError extends Error {
    constructor(readonly status: number) {
        super(`indexer answered ${status}`);
        this.name = 'IndexerHttpError';
    }
}

/**
 * 403 and 429: the indexer's edge refuses this client. The public indexers
 * sit behind an AWS load balancer that blocks the whole host IP once a client
 * sends too many requests (seen at ~15/s on 2026-09-24), and that block also
 * hits the sponsor facades' WebSocket on the same host.
 */
export function isIndexerRateLimit(err: unknown): boolean {
    return err instanceof IndexerHttpError && (err.status === 403 || err.status === 429);
}

/** Minimal GraphQL client; the indexer needs no credentials for these reads. */
export function createIndexerClient(url: string, timeoutMs = 20000): IndexerClient {
    return {
        async fetchBlock(height: number): Promise<SupplementBlock | null> {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs);
            try {
                const res = await fetch(url, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ query: BLOCK_QUERY, variables: { height } }),
                    signal: controller.signal
                });
                if (!res.ok) throw new IndexerHttpError(res.status);
                const body: any = await res.json();
                if (body?.errors?.length) {
                    throw new Error(`indexer rejected the block query: ${JSON.stringify(body.errors).slice(0, 200)}`);
                }
                return readSupplementBlock(body?.data);
            } finally {
                clearTimeout(timer);
            }
        }
    };
}
