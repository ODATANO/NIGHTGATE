// Fetches one block from the Midnight indexer and maps the data the node's block does not contain.
// Examples are contract state, ledger event lists, segment results and the DUST registration flag of a UTXO.

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

import type { FetchedContractState } from './contract-state';
import { indexerQuery } from '../utils/indexer-graphql';
import { bareHex } from '../utils/hex-patterns';
import { toInt } from '../utils/numbers';
import { hexToBase64 } from './cap-binary';

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

// Answer to BLOCK_QUERY. Values are read defensively, so the leaves stay unknown.
interface LedgerEventAnswer {
    __typename?: unknown;
    id?: unknown;
    raw?: unknown;
    maxId?: unknown;
    output?: { nonce?: unknown } | null;
}

interface TransactionAnswer {
    hash?: unknown;
    unshieldedCreatedOutputs?: Array<{ intentHash?: unknown; outputIndex?: unknown; registeredForDustGeneration?: unknown } | null> | null;
    contractActions?: Array<{
        __typename?: unknown;
        address?: unknown;
        state?: unknown;
        zswapState?: unknown;
        unshieldedBalances?: Array<{ tokenType?: unknown; amount?: unknown } | null> | null;
    } | null> | null;
    zswapLedgerEvents?: unknown;
    dustLedgerEvents?: unknown;
    fee?: unknown;
    transactionResult?: { status?: string | null; segments?: Array<{ id?: unknown; success?: unknown } | null> | null } | null;
}

export interface BlockAnswer {
    block?: { height?: unknown; ledgerParameters?: unknown; transactions?: Array<TransactionAnswer | null> | null } | null;
}

const ACTION_TYPE: Record<string, SupplementContractAction['actionType']> = {
    ContractDeploy: 'DEPLOY',
    ContractCall: 'CALL',
    ContractUpdate: 'UPDATE'
};

function readEvents(list: unknown): SupplementLedgerEvent[] {
    if (!Array.isArray(list)) return [];
    return list.map((e: LedgerEventAnswer | null) => ({
        eventId: toInt(e?.id),
        maxId: toInt(e?.maxId),
        raw: hexToBase64(e?.raw)
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
    for (const e of list as Array<LedgerEventAnswer | null>) {
        const eventType = DUST_EVENT_TYPE[String(e?.__typename)];
        // Unknown kinds are skipped, so they are never stored under a wrong kind.
        if (!eventType) continue;
        out.push({
            eventId: toInt(e?.id),
            maxId: toInt(e?.maxId),
            raw: hexToBase64(e?.raw),
            eventType,
            dustOutputNonce: eventType === 'INITIAL_UTXO' ? (bareHex(e?.output?.nonce) || null) : null
        });
    }
    return out;
}

export function readSupplementBlock(payload: BlockAnswer | null | undefined): SupplementBlock | null {
    const block = payload?.block;
    if (!block) return null;

    const transactions: SupplementTransaction[] = [];
    for (const tx of block.transactions ?? []) {
        const ledgerTxHash = bareHex(tx?.hash);
        if (!ledgerTxHash) continue;

        const contractActions: SupplementContractAction[] = [];
        for (const action of tx?.contractActions ?? []) {
            const actionType = ACTION_TYPE[String(action?.__typename)];
            const address = bareHex(action?.address);
            if (!actionType || !address) continue;
            contractActions.push({
                actionType,
                address,
                state: hexToBase64(action?.state),
                zswapState: hexToBase64(action?.zswapState),
                balances: (action?.unshieldedBalances ?? [])
                    .map(b => ({ tokenType: bareHex(b?.tokenType), amount: String(b?.amount ?? '0') }))
                    .filter((b: SupplementBalance) => b.tokenType)
            });
        }

        transactions.push({
            ledgerTxHash,
            status: tx?.transactionResult?.status ?? null,
            fee: tx?.fee == null ? null : String(tx.fee),
            segments: (tx?.transactionResult?.segments ?? [])
                .map(s => ({ segmentId: toInt(s?.id), success: Boolean(s?.success) })),
            contractActions,
            zswapEvents: readEvents(tx?.zswapLedgerEvents),
            dustEvents: readDustEvents(tx?.dustLedgerEvents),
            dustRegisteredOutputs: (tx?.unshieldedCreatedOutputs ?? [])
                .filter(u => u?.registeredForDustGeneration)
                .map(u => ({ intentHash: bareHex(u?.intentHash), outputIndex: toInt(u?.outputIndex) }))
        });
    }

    return {
        height: toInt(block.height),
        ledgerParameters: hexToBase64(block.ledgerParameters),
        transactions
    };
}

export interface IndexerClient {
    fetchBlock(height: number): Promise<SupplementBlock | null>;
}

export function createIndexerClient(url: string, timeoutMs = 20000): IndexerClient {
    return {
        async fetchBlock(height: number): Promise<SupplementBlock | null> {
            return readSupplementBlock(await indexerQuery<BlockAnswer>(url, BLOCK_QUERY, { variables: { height }, timeoutMs }));
        }
    };
}

const LEDGER_PARAMETERS_QUERY = `query($offset: BlockOffset) {
  block(offset: $offset) { ledgerParameters }
}`;

// The ledger parameters of the block at `height`, or of the newest block without a height. Base64.
export async function fetchLedgerParameters(url: string, height: number | null, timeoutMs = 20000): Promise<string | null> {
    const offset = height == null ? null : { height };
    type Answer = { block?: { ledgerParameters?: unknown } | null };
    const data = await indexerQuery<Answer>(url, LEDGER_PARAMETERS_QUERY, { variables: { offset }, timeoutMs });
    return hexToBase64(data?.block?.ledgerParameters);
}

const CONTRACT_STATE_QUERY = `query($address: HexEncoded!, $offset: ContractActionOffset) {
  contractAction(address: $address, offset: $offset) {
    state zswapState
    transaction { block { hash height ledgerParameters } }
  }
}`;

// A contract's state at `height`, or its latest state without a height, with the hash and ledger parameters of the block.
// Binary values are base64. Null when the indexer has no action of the contract up to that height.
export async function fetchContractState(
    url: string,
    address: string,
    height: number | null,
    timeoutMs = 20000
): Promise<FetchedContractState | null> {
    const offset = height == null ? null : { blockOffset: { height } };
    type Answer = { contractAction?: { state?: unknown; zswapState?: unknown; transaction?: { block?: { hash?: unknown; height?: unknown; ledgerParameters?: unknown } } } | null };
    const data = await indexerQuery<Answer>(url, CONTRACT_STATE_QUERY, { variables: { address, offset }, timeoutMs });
    const action = data?.contractAction;
    if (!action) return null;
    const blockHash = bareHex(action.transaction?.block?.hash);
    const blockHeight = action.transaction?.block?.height;
    return {
        height: blockHeight == null ? null : Number(blockHeight),
        state: hexToBase64(action.state),
        zswapState: hexToBase64(action.zswapState),
        blockHash: blockHash ? `0x${blockHash}` : null,
        ledgerParameters: hexToBase64(action.transaction?.block?.ledgerParameters)
    };
}
