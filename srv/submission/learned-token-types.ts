/**
 * Shielded token types minted by sponsored calls on this server.
 * With `shareMintedTokenTypes` in the server policy, every grant may use them, not only the minting one.
 * SPDX-License-Identifier: Apache-2.0
 */
import cds from '@sap/cds';
import { LearnedTokenTypes } from '#cds-models/midnight';
import { withKeyedLock } from '../utils/keyed-lock';
import { runWithoutAmbientTx } from './background-jobs';
import { HEX64_RE } from '../utils/hex';
import { errorMessage } from '../utils/errors';
import type { DbRunner } from '../utils/db-types';

const log = cds.log('nightgate:learned-token-types');
const { SELECT, INSERT } = cds.ql;

// The policy is computed synchronously per request, so the table is read through a cache.
// Once the cache is this old, it refreshes in the background.
const CACHE_TTL_MS = 30_000;
let cache: { types: string[]; at: number } | null = null;
let refreshing: Promise<void> | null = null;


export interface LearnedTokenTypeOrigin {
    grantId?: string | null;
    sponsorSessionId?: string | null;
    txHash?: string | null;
}

/** Keeps valid 64-hex token types, lower-cased and without duplicates. Drops everything else. */
export function normalizeTokenTypes(types: unknown[]): string[] {
    return [...new Set(types.map(t => String(t ?? '').trim().toLowerCase()).filter(t => HEX64_RE.test(t)))];
}

export async function refreshLearnedTokenTypes(db: DbRunner): Promise<string[]> {
    const rows: Array<{ tokenType?: string }> = await runWithoutAmbientTx(() => db.run(SELECT.from(LearnedTokenTypes).columns('tokenType')));
    const types = normalizeTokenTypes((rows ?? []).map(r => r.tokenType));
    cache = { types, at: Date.now() };
    return types;
}

/**
 * The known types as of the last refresh. An old cache refreshes in the background.
 * Before the first refresh the list is empty.
 */
export function sharedLearnedTokenTypes(): string[] {
    const age = cache ? Date.now() - cache.at : Infinity;
    if (age > CACHE_TTL_MS && !refreshing && cds.db) {
        refreshing = refreshLearnedTokenTypes(cds.db as DbRunner)
            .then(() => undefined, (e) => { log.warn(`learned token types not refreshed: ${errorMessage(e)}`); })
            .finally(() => { refreshing = null; });
    }
    return cache?.types ?? [];
}

/** Upper limit of the list. It is loaded for every policy check, and minting a new type is cheap. */
export const MAX_LEARNED_TOKEN_TYPES = 256;

/** Save the types created by a confirmed sponsored mint. Returns the types not seen before. */
export async function recordLearnedTokenTypes(db: DbRunner, types: unknown[], origin: LearnedTokenTypeOrigin = {}): Promise<string[]> {
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
            // The mint is already on chain. A type missed here is saved by its next mint.
            log.error(`could not record learned token type(s) ${fresh.map(t => t.slice(0, 12)).join(', ')}: ${errorMessage(err)}`);
            return [];
        }
    });
}

export function __resetLearnedTokenTypesForTests(types?: string[]): void {
    cache = types ? { types, at: Date.now() } : null;
    refreshing = null;
}
