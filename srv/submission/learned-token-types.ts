/**
 * Shielded token types that sponsored calls on this platform minted. With the floor's
 * `shareMintedTokenTypes` they count as listed for every grant, not only the minting one.
 * SPDX-License-Identifier: Apache-2.0
 */
import cds from '@sap/cds';
import { LearnedTokenTypes } from '#cds-models/midnight';
import { withKeyedLock } from '../utils/keyed-lock';
import { runWithoutAmbientTx } from './background-jobs';
import { HEX64_RE } from '../utils/hex';

const log = cds.log('nightgate:learned-token-types');
const { SELECT, INSERT } = cds.ql;

// The policy resolves synchronously per request, so the table is read through
// a cache that refreshes in the background once it is this old.
const CACHE_TTL_MS = 30_000;
let cache: { types: string[]; at: number } | null = null;
let refreshing: Promise<void> | null = null;

type Runner = { run(q: unknown): Promise<any> };

export interface LearnedTokenTypeOrigin {
    grantId?: string | null;
    sponsorSessionId?: string | null;
    txHash?: string | null;
}

/** Raw 64-hex types, lower-cased, de-duplicated; anything else is dropped. */
export function normalizeTokenTypes(types: unknown[]): string[] {
    return [...new Set(types.map(t => String(t ?? '').trim().toLowerCase()).filter(t => HEX64_RE.test(t)))];
}

export async function refreshLearnedTokenTypes(db: Runner): Promise<string[]> {
    const rows: Array<{ tokenType?: string }> = await runWithoutAmbientTx(() => db.run(SELECT.from(LearnedTokenTypes).columns('tokenType')));
    const types = normalizeTokenTypes((rows ?? []).map(r => r.tokenType));
    cache = { types, at: Date.now() };
    return types;
}

/**
 * The learned types as of the last refresh. A stale cache refreshes in the background;
 * before the first refresh the answer is empty.
 */
export function sharedLearnedTokenTypes(): string[] {
    const age = cache ? Date.now() - cache.at : Infinity;
    if (age > CACHE_TTL_MS && !refreshing && cds.db) {
        refreshing = refreshLearnedTokenTypes(cds.db as Runner)
            .then(() => undefined, (e) => { log.warn(`learned token types not refreshed: ${(e as Error)?.message ?? e}`); })
            .finally(() => { refreshing = null; });
    }
    return cache?.types ?? [];
}

/** Record the types a landed sponsored mint created; returns the ones new to the platform. */
/** Ceiling of the platform-wide list: it is loaded into every policy resolution, and a mint per name is cheap. */
export const MAX_LEARNED_TOKEN_TYPES = 256;

export async function recordLearnedTokenTypes(db: Runner, types: unknown[], origin: LearnedTokenTypeOrigin = {}): Promise<string[]> {
    const fresh = normalizeTokenTypes(types);
    if (fresh.length === 0) return [];
    return withKeyedLock('learned-token-types', async () => {
        try {
            const known: Array<{ tokenType?: string }> = await runWithoutAmbientTx(() => db.run(
                SELECT.from(LearnedTokenTypes).columns('tokenType').where({ tokenType: fresh })
            ));
            const have = new Set((known ?? []).map(r => String(r.tokenType ?? '').toLowerCase()));
            const added = fresh.filter(t => !have.has(t));
            if (added.length === 0) return [];
            const counted: Array<{ count?: number | string }> = await runWithoutAmbientTx(() => db.run(
                SELECT.from(LearnedTokenTypes).columns('count(*) as count')
            ));
            const total = Number(counted?.[0]?.count ?? 0);
            if (total + added.length > MAX_LEARNED_TOKEN_TYPES) {
                log.warn(`learned token types hold ${total}; ${added.map(t => t.slice(0, 12)).join(', ')} not recorded (at most ${MAX_LEARNED_TOKEN_TYPES})`);
                return [];
            }
            await runWithoutAmbientTx(() => db.run(INSERT.into(LearnedTokenTypes).entries(added.map(tokenType => ({
                tokenType,
                grantId: origin.grantId ?? null,
                sponsorSessionId: origin.sponsorSessionId ?? null,
                txHash: origin.txHash ?? null
            })))));
            if (cache) cache = { types: [...cache.types, ...added.filter(t => !cache!.types.includes(t))], at: cache.at };
            log.info(`learned token type(s) ${added.map(t => t.slice(0, 12)).join(', ')}${origin.grantId ? ` from grant ${String(origin.grantId).slice(0, 8)}…` : ''}`);
            return added;
        } catch (err) {
            // The mint is on chain; a type that was not recorded is recorded by the next mint of it.
            log.error(`could not record learned token type(s) ${fresh.map(t => t.slice(0, 12)).join(', ')}: ${(err as Error)?.message ?? err}`);
            return [];
        }
    });
}

export function __resetLearnedTokenTypesForTests(types?: string[]): void {
    cache = types ? { types, at: Date.now() } : null;
    refreshing = null;
}
