/**
 * Tests for srv/crawler/block-events.ts: reading the Midnight pallet's events
 * out of a decoded System.Events vector.
 *
 * Records are hand-built in the shape polkadot-js hands back (phase with
 * isApplyExtrinsic, event.section/method, event.data.toHuman()), so the suite
 * needs no node and no metadata.
 */

import {
    readBlockEvents, txTypeFromEvents, projectTransfer, stripContractAddressPrefix,
    NIGHT_RAW_TOKEN_TYPE
} from '../../srv/crawler/block-events';

const ADDR_A = 'a'.repeat(64);
const ADDR_B = 'b'.repeat(64);
const INTENT_1 = '11'.repeat(32);
const INTENT_2 = '22'.repeat(32);
const CONTRACT = 'c'.repeat(64);
/** "midnight:contract-address[v2]:" as the event carries it. */
const CONTRACT_PREFIX = Buffer.from('midnight:contract-address[v2]:', 'latin1').toString('hex');

function record(index: number, section: string, method: string, payload?: unknown): any {
    return {
        phase: { isApplyExtrinsic: true, asApplyExtrinsic: { toNumber: () => index } },
        event: { section, method, data: { toHuman: () => [payload] } }
    };
}

function utxo(address: string, intentHash: string, outputNo: number, value: string, tokenType = NIGHT_RAW_TOKEN_TYPE) {
    return { address: `0x${address}`, tokenType: `0x${tokenType}`, intentHash: `0x${intentHash}`, value, outputNo: String(outputNo) };
}

describe('readBlockEvents', () => {
    test('reads spent and created UTXOs, stripping 0x and thousands separators', () => {
        const events = readBlockEvents([
            record(3, 'system', 'ExtrinsicSuccess'),
            record(3, 'midnight', 'UnshieldedTokens', {
                spent: [utxo(ADDR_A, INTENT_1, 1, '500,000,000,000')],
                created: [utxo(ADDR_B, INTENT_2, 0, '5,000,000,000')]
            }),
            record(3, 'midnight', 'TxApplied', { txHash: '0xdead' })
        ]);

        const entry = events.get(3)!;
        expect(entry.outcome).toBe('SUCCESS');
        expect(entry.applied).toBe(true);
        expect(entry.partialSuccess).toBe(false);
        expect(entry.spent).toEqual([{
            address: ADDR_A, tokenType: NIGHT_RAW_TOKEN_TYPE, intentHash: INTENT_1,
            value: 500_000_000_000n, outputNo: 1
        }]);
        expect(entry.created).toEqual([{
            address: ADDR_B, tokenType: NIGHT_RAW_TOKEN_TYPE, intentHash: INTENT_2,
            value: 5_000_000_000n, outputNo: 0
        }]);
    });

    test('TxPartialSuccess marks the extrinsic applied and partial', () => {
        const events = readBlockEvents([
            record(3, 'system', 'ExtrinsicSuccess'),
            record(3, 'midnight', 'TxPartialSuccess', { txHash: '0xdead' })
        ]);
        expect(events.get(3)).toEqual(expect.objectContaining({
            outcome: 'SUCCESS', applied: true, partialSuccess: true
        }));
    });

    test('contract events carry the action type and the bare address', () => {
        const events = readBlockEvents([
            record(3, 'midnight', 'ContractDeploy', { txHash: '0x1', contractAddress: `0x${CONTRACT_PREFIX}${CONTRACT}` }),
            record(4, 'midnight', 'ContractCall', { txHash: '0x2', contractAddress: `0x${CONTRACT_PREFIX}${CONTRACT}` }),
            record(5, 'midnight', 'ContractMaintain', { txHash: '0x3', contractAddress: `0x${CONTRACT_PREFIX}${CONTRACT}` })
        ]);
        expect(events.get(3)!.contracts).toEqual([{ actionType: 'DEPLOY', address: CONTRACT }]);
        expect(events.get(4)!.contracts).toEqual([{ actionType: 'CALL', address: CONTRACT }]);
        expect(events.get(5)!.contracts).toEqual([{ actionType: 'UPDATE', address: CONTRACT }]);
    });

    test('a failure wins over a success on the same extrinsic', () => {
        const events = readBlockEvents([
            record(2, 'system', 'ExtrinsicSuccess'),
            record(2, 'system', 'ExtrinsicFailed')
        ]);
        expect(events.get(2)!.outcome).toBe('FAILURE');
    });

    test('skips records outside an extrinsic phase and payloads that do not read', () => {
        const events = readBlockEvents([
            { phase: { isApplyExtrinsic: false }, event: { section: 'midnight', method: 'TxApplied' } },
            {
                phase: { isApplyExtrinsic: true, asApplyExtrinsic: { toNumber: () => 1 } },
                event: { section: 'midnight', method: 'UnshieldedTokens', data: { toHuman: () => { throw new Error('undecodable'); } } }
            },
            record(1, 'system', 'ExtrinsicSuccess')
        ]);
        expect(events.size).toBe(1);
        expect(events.get(1)).toEqual(expect.objectContaining({ outcome: 'SUCCESS', created: [], spent: [] }));
    });

    test('other pallets are ignored', () => {
        const events = readBlockEvents([
            record(1, 'balances', 'Transfer', { from: '0x1', to: '0x2' }),
            record(1, 'system', 'ExtrinsicSuccess')
        ]);
        expect(events.get(1)).toEqual(expect.objectContaining({ contracts: [], created: [] }));
    });
});

describe('stripContractAddressPrefix', () => {
    test('drops a printable ASCII prefix ending in a colon', () => {
        expect(stripContractAddressPrefix(`0x${CONTRACT_PREFIX}${CONTRACT}`)).toBe(CONTRACT);
    });

    test('leaves a bare address and a non-ASCII prefix alone', () => {
        expect(stripContractAddressPrefix(`0x${CONTRACT}`)).toBe(CONTRACT);
        expect(stripContractAddressPrefix(`0xffff${CONTRACT}`)).toBe(`ffff${CONTRACT}`);
    });
});

describe('txTypeFromEvents', () => {
    const base = { applied: true, partialSuccess: false, created: [], spent: [], contracts: [] };

    test('a deploy outranks a call in the same transaction', () => {
        expect(txTypeFromEvents({
            ...base,
            contracts: [{ actionType: 'CALL', address: CONTRACT }, { actionType: 'DEPLOY', address: CONTRACT }]
        })).toBe('contract_deploy');
    });

    test('contract activity outranks a token movement', () => {
        expect(txTypeFromEvents({
            ...base,
            contracts: [{ actionType: 'CALL', address: CONTRACT }],
            created: [{ address: ADDR_A, tokenType: NIGHT_RAW_TOKEN_TYPE, intentHash: INTENT_1, value: 1n, outputNo: 0 }]
        })).toBe('contract_call');
    });

    test('a maintenance update classifies as contract_update', () => {
        expect(txTypeFromEvents({ ...base, contracts: [{ actionType: 'UPDATE', address: CONTRACT }] })).toBe('contract_update');
    });

    test('token movement alone is a night transfer, silence classifies nothing', () => {
        expect(txTypeFromEvents({
            ...base,
            spent: [{ address: ADDR_A, tokenType: NIGHT_RAW_TOKEN_TYPE, intentHash: INTENT_1, value: 1n, outputNo: 0 }]
        })).toBe('night_transfer');
        expect(txTypeFromEvents({ ...base })).toBeNull();
        expect(txTypeFromEvents(undefined)).toBeNull();
    });
});

describe('projectTransfer', () => {
    const base = { applied: true, partialSuccess: false, contracts: [] as any[] };
    const u = (address: string, value: bigint, tokenType = NIGHT_RAW_TOKEN_TYPE) =>
        ({ address, tokenType, intentHash: INTENT_1, value, outputNo: 0 });

    test('projects sender, receiver and the NIGHT that reached the receiver', () => {
        expect(projectTransfer({
            ...base,
            spent: [u(ADDR_A, 100n)],
            created: [u(ADDR_B, 30n), u(ADDR_A, 70n)]
        } as any)).toEqual({ senderAddress: ADDR_A, receiverAddress: ADDR_B, nightAmount: 30n });
    });

    test('counts only NIGHT towards the amount', () => {
        expect(projectTransfer({
            ...base,
            spent: [u(ADDR_A, 100n)],
            created: [u(ADDR_B, 30n, 'ff'.repeat(32))]
        } as any)).toEqual({ senderAddress: ADDR_A, receiverAddress: ADDR_B, nightAmount: 0n });
    });

    test('a self-transfer names no receiver', () => {
        expect(projectTransfer({ ...base, spent: [u(ADDR_A, 100n)], created: [u(ADDR_A, 99n)] } as any))
            .toEqual({ senderAddress: ADDR_A, receiverAddress: null, nightAmount: null });
    });

    test('several funding or several receiving addresses project nothing', () => {
        expect(projectTransfer({ ...base, spent: [u(ADDR_A, 1n), u(ADDR_B, 1n)], created: [] } as any))
            .toEqual({ senderAddress: null, receiverAddress: null, nightAmount: null });
        expect(projectTransfer({
            ...base,
            spent: [u(ADDR_A, 100n)],
            created: [u(ADDR_B, 1n), u('d'.repeat(64), 1n)]
        } as any)).toEqual({ senderAddress: null, receiverAddress: null, nightAmount: null });
    });
});
