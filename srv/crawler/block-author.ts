// SPDX-License-Identifier: Apache-2.0
/** Names the validator that produced a block: the AURA authority of the block's slot, proven by the header seal. */
import cds from '@sap/cds';
import { TypeRegistry } from '@polkadot/types/create';
import type { Header } from '@polkadot/types/interfaces';
import { waitReady, sr25519Verify } from '@polkadot/wasm-crypto';
import type { BlockHeader, MidnightNodeProvider } from '../providers/MidnightNodeProvider';
import { errorMessage } from '../utils/errors';

const log = cds.log('nightgate:crawler');
const registry = new TypeRegistry();

/** Aura::Authorities = twox128("Aura") + twox128("Authorities"). */
export const AURA_AUTHORITIES_STORAGE_KEY = '0x57f8dc2f5ab09467896f47300f0424385e0621c4869aa60c02be9adcc98a0d1d';

/** Index of `AuthoritiesChange` in the AURA consensus log enum. */
const AUTHORITIES_CHANGE = 1;

export interface AuraHeaderFacts {
    slot: bigint | null;
    /** The authority list for the blocks after this one. Null when this block keeps the list. */
    nextAuthorities: string[] | null;
    seal: Uint8Array | null;
    /** Hash of the header without its seal. The seal signs this hash. */
    sealedHash: Uint8Array | null;
}

const NO_AURA: AuraHeaderFacts = { slot: null, nextAuthorities: null, seal: null, sealedHash: null };

/** A SCALE `Vec<[u8; 32]>` as `0x` hex keys. */
export function decodeAuthorities(encoded: string | Uint8Array): string[] {
    return registry.createType('Vec<H256>', encoded).map(key => key.toHex());
}

/** Reads the AURA parts of a header. A header that does not decode has none. */
export function readAuraHeader(header: BlockHeader): AuraHeaderFacts {
    const logs = header.digest?.logs ?? [];
    if (logs.length === 0) return NO_AURA;
    try {
        const facts: AuraHeaderFacts = { ...NO_AURA };
        const items = registry.createType<Header>('Header', header).digest.logs;
        items.forEach((item, index) => {
            if (item.isPreRuntime) {
                const [engine, data] = item.asPreRuntime;
                if (engine.isAura) facts.slot = registry.createType('u64', data.toU8a(true)).toBigInt();
            } else if (item.isConsensus) {
                const [engine, data] = item.asConsensus;
                const payload = data.toU8a(true);
                if (engine.isAura && payload[0] === AUTHORITIES_CHANGE) facts.nextAuthorities = decodeAuthorities(payload.subarray(1));
            } else if (item.isSeal && index === items.length - 1) {
                const [engine, data] = item.asSeal;
                if (engine.isAura) facts.seal = data.toU8a(true);
            }
        });
        if (facts.seal) {
            const unsealed = { ...header, digest: { logs: logs.slice(0, -1) } };
            facts.sealedHash = registry.createType<Header>('Header', unsealed).hash.toU8a();
        }
        return facts;
    } catch (err) {
        log.debug(`header digest not readable: ${errorMessage(err)}`);
        return NO_AURA;
    }
}

export interface BlockProducer {
    /** AURA public key of the validator as `0x` hex. Null when the header names no slot or the seal does not match. */
    author: string | null;
    slot: number | null;
}

/** Warns about the first unproven block and then every this many, so a chain that left AURA does not flood the log. */
const UNPROVEN_WARN_EVERY = 1000;

export class BlockAuthorResolver {
    // The list that signs the child of `parentHash`. Blocks in chain order need no storage read.
    private next: { parentHash: string; authorities: string[] } | null = null;
    private unproven = 0;

    constructor(private readonly node: Pick<MidnightNodeProvider, 'getStorage'>) {}

    // The producer is `authorities[slot mod length]` of the parent's state. A failed storage read throws,
    // so a block is never stored with a guessed author.
    async resolve(blockHash: string, header: BlockHeader): Promise<BlockProducer> {
        const facts = readAuraHeader(header);
        if (facts.slot == null) return { author: null, slot: null };
        const slot = Number(facts.slot);

        const authorities = this.next?.parentHash === header.parentHash
            ? this.next.authorities
            : await this.readAuthorities(header.parentHash);
        this.next = { parentHash: blockHash, authorities: facts.nextAuthorities ?? authorities };
        if (authorities.length === 0) return { author: null, slot };

        const author = authorities[Number(facts.slot % BigInt(authorities.length))];
        await waitReady();
        const proven = !!facts.seal && !!facts.sealedHash
            && sr25519Verify(facts.seal, facts.sealedHash, registry.createType('H256', author).toU8a());
        if (!proven) {
            if (this.unproven++ % UNPROVEN_WARN_EVERY === 0) {
                log.warn(`block ${blockHash}: the seal does not match the AURA authority of slot ${slot}; author left empty (${this.unproven} block(s) so far)`);
            }
            return { author: null, slot };
        }
        return { author, slot };
    }

    private async readAuthorities(atBlockHash: string): Promise<string[]> {
        const encoded = await this.node.getStorage(AURA_AUTHORITIES_STORAGE_KEY, atBlockHash);
        return encoded ? decodeAuthorities(encoded) : [];
    }
}
