/**
 * Server-side minting with the `token-factory` contract. The wallet session is the issuer.
 * Its issuer secret comes from the session's seed. So each token name belongs
 * to one session, and nobody else can mint more of it.
 * SPDX-License-Identifier: Apache-2.0
 */
import { issuerKeyOf, tokenTypeOf } from '@odatano/contract-kit';
import { importRegisteredArtifact, getContractRegistration } from './contract-registry';
import { deriveTokenFactoryIssuerSecret } from './contract-witnesses';
import { withSessionRoleSeeds, type SessionSeedOptions } from './wallet-material-factory';
import { NightgateError } from '../utils/errors';
import { HEX64_RE } from '../utils/hex';

export const TOKEN_FACTORY_REF = 'token-factory';
export const TOKEN_FACTORY_MINT_CIRCUIT = 'mint';
/** `mint(name, amount, recipient)` takes a `Uint<64>`. */
export const MAX_FACTORY_MINT_AMOUNT = (1n << 64n) - 1n;
const NAME_BYTES = 32;

export interface TokenFactoryPureCircuits {
    issuerKey(secret: Uint8Array): Uint8Array;
    domainOf(issuer: Uint8Array, name: Uint8Array): Uint8Array;
}

export class TokenFactoryUnavailableError extends NightgateError {
    constructor(message: string) { super('TOKEN_FACTORY_UNAVAILABLE', message); }
}

/** Helper functions of the registered factory contract. Throws if no factory contract is registered. */
export async function loadTokenFactoryPureCircuits(ref: string = TOKEN_FACTORY_REF): Promise<TokenFactoryPureCircuits> {
    if (!getContractRegistration(ref)) {
        throw new TokenFactoryUnavailableError(`contract '${ref}' is not registered; add the token-factory lineage to cds.requires.nightgate.contracts`);
    }
    const mod: any = await importRegisteredArtifact(ref);
    const pure = mod.pureCircuits ?? mod.default?.pureCircuits;
    if (typeof pure?.issuerKey !== 'function' || typeof pure?.domainOf !== 'function') {
        throw new TokenFactoryUnavailableError(`artifact '${ref}' exports no issuerKey/domainOf pure circuits; it is not a token factory`);
    }
    return pure as TokenFactoryPureCircuits;
}

/** A token name in the form the contract expects: 1 to 32 UTF-8 bytes, padded with zeros. */
export function parseFactoryTokenName(raw: unknown): { ok: true; name: string; nameHex: string } | { ok: false; message: string } {
    if (typeof raw !== 'string' || raw.length === 0) return { ok: false, message: 'name is required' };
    const utf8 = Buffer.from(raw, 'utf8');
    if (utf8.length > NAME_BYTES) return { ok: false, message: `name must be at most ${NAME_BYTES} bytes of UTF-8` };
    if (utf8.includes(0)) return { ok: false, message: 'name must not contain NUL' };
    const padded = Buffer.alloc(NAME_BYTES);
    utf8.copy(padded);
    return { ok: true, name: raw, nameHex: padded.toString('hex') };
}

/** A positive integer (number or decimal string) that fits `Uint<64>`. */
export function parseFactoryMintAmount(raw: unknown): { ok: true; amount: bigint } | { ok: false; message: string } {
    const text = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : '';
    if (!/^\d+$/.test(text)) return { ok: false, message: 'amount must be a positive integer (atoms, decimal)' };
    const amount = BigInt(text);
    if (amount <= 0n) return { ok: false, message: 'amount must be positive' };
    if (amount > MAX_FACTORY_MINT_AMOUNT) return { ok: false, message: `amount must be at most ${MAX_FACTORY_MINT_AMOUNT} (Uint<64>)` };
    return { ok: true, amount };
}

export interface FactoryTokenInput {
    /** The issuer's key, 64 hex. */
    issuerKey: string;
    name: string;
    /** The factory deployment, 64 hex. */
    contractAddress: string;
}

export interface FactoryToken {
    issuerKey: string;
    domain: string;
    tokenType: string;
}

/** The session's issuer key on the factory. Cached per session, because the seed never changes. */
const issuerKeyCache = new Map<string, string>();

export interface TokenFactoryOps {
    issuerKeyForSession(opts: SessionSeedOptions): Promise<string>;
    describeToken(input: FactoryTokenInput): Promise<FactoryToken>;
}

export async function factoryIssuerKeyForSession(opts: SessionSeedOptions): Promise<string> {
    const cached = issuerKeyCache.get(opts.sessionId);
    if (cached) return cached;
    const pure = await loadTokenFactoryPureCircuits();
    const issuerKey = await withSessionRoleSeeds(opts, (roleSeeds) => {
        const secret = deriveTokenFactoryIssuerSecret(roleSeeds.zswap);
        try {
            return issuerKeyOf(pure, Buffer.from(secret).toString('hex'));
        } finally {
            secret.fill(0);
        }
    });
    issuerKeyCache.set(opts.sessionId, issuerKey);
    return issuerKey;
}

/** The token type of `name` minted by `issuerKey` on the factory at `contractAddress`. */
export async function describeFactoryToken(input: FactoryTokenInput): Promise<FactoryToken> {
    if (!HEX64_RE.test(input.contractAddress)) throw new TokenFactoryUnavailableError('contractAddress must be 64 hex characters');
    const pure = await loadTokenFactoryPureCircuits();
    const { issuer, domain, type } = await tokenTypeOf(pure, { issuerKey: input.issuerKey, name: input.name, contractAddress: input.contractAddress });
    return { issuerKey: issuer, domain, tokenType: type };
}

export const tokenFactoryOps: TokenFactoryOps = {
    issuerKeyForSession: factoryIssuerKeyForSession,
    describeToken: describeFactoryToken
};

export function __resetFactoryIssuerCacheForTests(): void {
    issuerKeyCache.clear();
}
