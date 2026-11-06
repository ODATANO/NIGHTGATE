/**
 * Tests for srv/crawler/block-author.ts against three mainnet headers
 * (test/fixtures/aura-headers.json): a plain block, a block that changes the
 * authority list, and the first block signed under the new list.
 */

import cds from '@sap/cds';
import { TypeRegistry } from '@polkadot/types/create';
import fixture from '../fixtures/aura-headers.json';
import {
    AURA_AUTHORITIES_STORAGE_KEY, BlockAuthorResolver, decodeAuthorities, readAuraHeader
} from '../../srv/crawler/block-author';

const [plain, change, afterChange] = fixture.blocks;
const encodeAuthorities = (keys: string[]): string => new TypeRegistry().createType('Vec<H256>', keys).toHex();

/** A node that answers `Aura.Authorities` per parent hash, as recorded in the fixture. */
function nodeWith(blocks: typeof fixture.blocks) {
    const lists = new Map(blocks.map(b => [b.header.parentHash, encodeAuthorities(b.parentAuthorities)]));
    return { getStorage: vi.fn(async (_key: string, at?: string) => lists.get(at ?? '') ?? null) };
}

describe('readAuraHeader', () => {
    it('reads slot and seal of a plain block', () => {
        const facts = readAuraHeader(plain.header);
        expect(facts.slot).toBe(BigInt(plain.slot));
        expect(facts.seal).toHaveLength(64);
        expect(facts.sealedHash).toHaveLength(32);
        expect(facts.nextAuthorities).toBeNull();
    });

    it('reads the next authority list from the block that changes it', () => {
        const facts = readAuraHeader(change.header);
        expect(facts.nextAuthorities).toEqual(afterChange.parentAuthorities);
        expect(facts.nextAuthorities).not.toEqual(change.parentAuthorities);
    });

    it('finds nothing in a header without digest logs or with logs that do not decode', () => {
        const bare = { ...plain.header, digest: { logs: [] } };
        expect(readAuraHeader(bare).slot).toBeNull();
        const broken = { ...plain.header, digest: { logs: ['0x0642414245deadbeef'] } };
        expect(readAuraHeader(broken)).toEqual({ slot: null, nextAuthorities: null, seal: null, sealedHash: null });
    });

    it('ignores a seal that is not the last log', () => {
        const logs = plain.header.digest.logs;
        const reordered = { ...plain.header, digest: { logs: [logs[logs.length - 1], ...logs.slice(0, -1)] } };
        expect(readAuraHeader(reordered).seal).toBeNull();
    });
});

describe('decodeAuthorities', () => {
    it('round-trips the storage encoding', () => {
        expect(decodeAuthorities(encodeAuthorities(plain.parentAuthorities))).toEqual(plain.parentAuthorities);
    });
});

describe('BlockAuthorResolver', () => {
    it('names the validator of a block from the parent state and proves it by the seal', async () => {
        const node = nodeWith([plain]);
        const producer = await new BlockAuthorResolver(node).resolve(plain.hash, plain.header);
        expect(producer).toEqual({ author: plain.author, slot: plain.slot });
        expect(node.getStorage).toHaveBeenCalledExactlyOnceWith(AURA_AUTHORITIES_STORAGE_KEY, plain.header.parentHash);
    });

    it('follows a list change through the header, without a second storage read', async () => {
        const node = nodeWith([change]);
        const resolver = new BlockAuthorResolver(node);
        expect(await resolver.resolve(change.hash, change.header)).toEqual({ author: change.author, slot: change.slot });
        expect(await resolver.resolve(afterChange.hash, afterChange.header)).toEqual({ author: afterChange.author, slot: afterChange.slot });
        expect(node.getStorage).toHaveBeenCalledTimes(1);
    });

    it('reads the list again for a block that does not follow the last one', async () => {
        const node = nodeWith([plain, afterChange]);
        const resolver = new BlockAuthorResolver(node);
        await resolver.resolve(plain.hash, plain.header);
        expect((await resolver.resolve(afterChange.hash, afterChange.header)).author).toBe(afterChange.author);
        expect(node.getStorage).toHaveBeenCalledTimes(2);
    });

    it('leaves the author empty and keeps the slot when the seal does not match', async () => {
        const warn = vi.spyOn(cds.log('nightgate:crawler'), 'warn').mockImplementation(() => {});
        try {
            // The list of another session puts a different validator on this slot.
            const stale = { getStorage: vi.fn().mockResolvedValue(encodeAuthorities(change.parentAuthorities)) };
            expect(await new BlockAuthorResolver(stale).resolve(afterChange.hash, afterChange.header))
                .toEqual({ author: null, slot: afterChange.slot });

            const logs = plain.header.digest.logs;
            const forged = { ...plain.header, stateRoot: '0x' + '11'.repeat(32), digest: { logs } };
            expect(await new BlockAuthorResolver(nodeWith([plain])).resolve(plain.hash, forged))
                .toEqual({ author: null, slot: plain.slot });
            expect(warn).toHaveBeenCalledTimes(2);
        } finally {
            warn.mockRestore();
        }
    });

    it('names no author without a slot, and asks the node for nothing', async () => {
        const node = nodeWith([plain]);
        const genesis = { ...plain.header, digest: { logs: [] } };
        expect(await new BlockAuthorResolver(node).resolve('0xgenesis', genesis)).toEqual({ author: null, slot: null });
        expect(node.getStorage).not.toHaveBeenCalled();
    });

    it('names no author on a chain without an authority list', async () => {
        const node = { getStorage: vi.fn().mockResolvedValue(null) };
        expect(await new BlockAuthorResolver(node).resolve(plain.hash, plain.header)).toEqual({ author: null, slot: plain.slot });
    });

    it('passes a failed storage read on, so the block is retried and not stored with a guess', async () => {
        const node = { getStorage: vi.fn().mockRejectedValue(new Error('RPC timeout: state_getStorage (30000ms)')) };
        await expect(new BlockAuthorResolver(node).resolve(plain.hash, plain.header)).rejects.toThrow(/RPC timeout/);
    });
});
