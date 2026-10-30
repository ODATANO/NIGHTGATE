// Actions of the swap offer board: post, read and withdraw offers.
// An offer is the maker's half of a shielded swap. A taker adds the other half.
// SPDX-License-Identifier: Apache-2.0
import cds from '@sap/cds';
import { SwapOffers, type SwapOffer } from '#cds-models/midnight';
import { NightgateError, isNightgateError } from '../../utils/errors';
import { transactionBytesOf } from '../../utils/offer-file';
import { walletDescribeSwapHalf } from '../../midnight/wallet-worker-client';
import { isSwapOfferOpen, loadSwapOffer, closeSwapOffer, effectiveSwapOfferStatus, type SwapOfferStatus } from '../swap-offers';
import { parseJsonStringList } from '../../utils/json-list';
import { LONG_POLL_MAX_MS, holdUntil, waiterPool } from '../../utils/long-poll';
import { runWithoutAmbientTx } from '../background-jobs';
import { runSubmission } from './common';
import type { SubmissionContext } from './context';
import { HEX64_RE } from '../../utils/hex';
import { getSwapOffer, listSwapOffers, postSwapOffer, retireSwapOffer } from '#cds-models/NightgateService';
import type { Request } from '@sap/cds';
import { futureTimeProblem } from '../../utils/validation';
import { checkRateClass } from '../../utils/rate-classes';

const { SELECT, INSERT } = cds.ql;

// A half is a few KB. The limit keeps oversized input away from the worker.
const MAX_OFFER_CHARS = 262_144;
const MAX_TAGS = 8;
const MAX_TAG_CHARS = 40;
const MAX_EXPIRY_MS = 90 * 24 * 60 * 60 * 1000;
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
/** The listSwapOffers calls holding for an offer. */
export const boardWaiters = waiterPool(100);

type StatusFilter = SwapOfferStatus | 'all';
const STATUS_FILTERS: ReadonlySet<string> = new Set(['open', 'filled', 'retired', 'expired', 'all']);

function parseTags(v: readonly unknown[] | null | undefined): string[] | string {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) return 'tags must be an array of strings';
    if (v.length > MAX_TAGS) return `tags: at most ${MAX_TAGS}`;
    const tags = [...new Set(v.map(t => String(t ?? '').trim()).filter(t => t.length > 0))];
    if (tags.some(t => t.length > MAX_TAG_CHARS)) return `tags: each at most ${MAX_TAG_CHARS} characters`;
    return tags;
}

/** Who posted an offer: the user and, for an agent token, its grant. */
function posterOf(req: Request): { posterUserId: string; posterGrantId: string | null } {
    return { posterUserId: String(req.user?.id ?? ''), posterGrantId: req.agentGrant?.ID ?? null };
}

function isPoster(row: SwapOffer, req: Request): boolean {
    const poster = posterOf(req);
    return row.posterUserId === poster.posterUserId && (row.posterGrantId ?? null) === poster.posterGrantId;
}

/** When the offer last changed: the row update, or the moment it expired. */
function changedAtOf(row: SwapOffer, now: Date): string | null {
    const stamped = row.modifiedAt ?? row.createdAt ?? null;
    if (row.status !== 'open' || !row.expiresAt || Date.parse(row.expiresAt) > now.getTime()) return stamped;
    return stamped && Date.parse(stamped) > Date.parse(row.expiresAt) ? stamped : row.expiresAt;
}

function publicView(row: SwapOffer, now: Date) {
    return {
        offerId: row.ID, offer: row.offer, bound: row.bound === true,
        givesType: row.givesType, givesAmount: row.givesAmount, wantsType: row.wantsType, wantsAmount: row.wantsAmount,
        tags: parseJsonStringList(row.tags), expiresAt: row.expiresAt ?? null, postedAt: row.createdAt ?? null,
        status: effectiveSwapOfferStatus(row, now), filledTxHash: row.filledTxHash ?? null, closedAt: row.closedAt ?? null,
        changedAt: changedAtOf(row, now), directed: !!row.takerSecretHash
    };
}

export function registerSwapOfferActions(ctx: Pick<SubmissionContext, 'srv' | 'db'>): void {
    const { srv, db } = ctx;

    srv.on(postSwapOffer, async (req) => {
        const { offer, expiresAt, tags } = req.data;
        if (!offer || typeof offer !== 'string') return req.reject(400, 'offer is required');
        if (offer.length > MAX_OFFER_CHARS) return req.reject(400, `offer: at most ${MAX_OFFER_CHARS} characters`);
        let halfB64: string;
        try { halfB64 = Buffer.from(await transactionBytesOf(offer)).toString('base64'); }
        catch (e) { return req.reject(400, `offer: ${(e as Error).message}`); }
        let expiry: string | null = null;
        if (expiresAt !== undefined && expiresAt !== null && expiresAt !== '') {
            const problem = futureTimeProblem(expiresAt, 'expiresAt', MAX_EXPIRY_MS, '90 days');
            if (problem) return req.reject(400, problem);
            expiry = new Date(String(expiresAt)).toISOString();
        }
        const parsedTags = parseTags(tags);
        if (typeof parsedTags === 'string') return req.reject(400, parsedTags);
        let takerSecretHash: string | null = null;
        if (req.data.takerSecretHash !== undefined && req.data.takerSecretHash !== null && req.data.takerSecretHash !== '') {
            takerSecretHash = String(req.data.takerSecretHash).trim().toLowerCase();
            if (!HEX64_RE.test(takerSecretHash)) return req.reject(400, 'takerSecretHash must be 64 hex characters (sha256 of the taker secret)');
        }
        if (!checkRateClass('compute', 'compute', req)) return;

        return runSubmission(req, async () => {
            let half: Awaited<ReturnType<typeof walletDescribeSwapHalf>>;
            try {
                half = await walletDescribeSwapHalf({ halfB64 });
            } catch (e) {
                const msg = (e as Error)?.message ?? String(e);
                if (isNightgateError(e) && e.code === 'SPONSOR_REFUSED') throw new NightgateError('SWAP_OFFER_INVALID', msg);
                if (/not a swap half|is not a proven transaction/.test(msg)) throw new NightgateError('SWAP_OFFER_INVALID', msg);
                throw e;
            }
            const ID = cds.utils.uuid();
            const now = new Date().toISOString();
            await db.run(INSERT.into(SwapOffers).entries({
                ID, offer: offer.trim(), givesType: half.gives.tokenType, givesAmount: half.gives.amount,
                wantsType: half.wants.tokenType, wantsAmount: half.wants.amount, bound: half.bound, inputs: half.inputs,
                nullifiers: JSON.stringify(half.nullifiers), tags: JSON.stringify(parsedTags), status: 'open', expiresAt: expiry,
                takerSecretHash,
                ...posterOf(req), sessionId: req.agentGrant?.sessionId ?? null, createdAt: now, modifiedAt: now
            }));
            return {
                offerId: ID, status: 'open', bound: half.bound,
                givesType: half.gives.tokenType, givesAmount: half.gives.amount,
                wantsType: half.wants.tokenType, wantsAmount: half.wants.amount, expiresAt: expiry,
                directed: !!takerSecretHash
            };
        });
    });

    srv.on(listSwapOffers, async (req) => {
        if (!checkRateClass('read', 'read', req)) return;
        const { givesType, wantsType, tag, limit, status, since, mine, waitMs } = req.data;
        const where: Record<string, unknown> = {};
        for (const [name, value] of [['givesType', givesType], ['wantsType', wantsType]] as const) {
            if (value === undefined || value === null || value === '') continue;
            const v = String(value).trim().toLowerCase();
            if (!HEX64_RE.test(v)) return req.reject(400, `${name} must be 64 hex characters`);
            where[name] = v;
        }
        const n = limit === undefined || limit === null ? DEFAULT_LIST_LIMIT : Number(limit);
        if (!Number.isInteger(n) || n < 1 || n > MAX_LIST_LIMIT) return req.reject(400, `limit must be an integer from 1 to ${MAX_LIST_LIMIT}`);
        const statusFilter = (status === undefined || status === null || status === '' ? 'open' : String(status).trim().toLowerCase()) as StatusFilter;
        if (!STATUS_FILTERS.has(statusFilter)) return req.reject(400, `status must be one of ${[...STATUS_FILTERS].join(', ')}`);
        let sinceIso: string | null = null;
        if (since !== undefined && since !== null && since !== '') {
            const ms = Date.parse(String(since));
            if (!Number.isFinite(ms)) return req.reject(400, 'since must be an ISO timestamp');
            sinceIso = new Date(ms).toISOString();
        }
        if (waitMs != null && !(Number.isInteger(waitMs) && waitMs >= 0 && waitMs <= LONG_POLL_MAX_MS)) {
            return req.reject(400, `waitMs must be an integer from 0 to ${LONG_POLL_MAX_MS}`);
        }
        if (mine === true) Object.assign(where, posterOf(req));
        const wantTag = tag ? String(tag).trim() : '';

        // Expiry is checked in the query. Listing never writes the expired status,
        // so the limit counts only matching offers.
        const offers = (nowIso: string) => {
            const q = SELECT.from(SwapOffers).where(where);
            if (statusFilter === 'open') q.where({ status: 'open' }).and('expiresAt is null or expiresAt >', nowIso);
            else if (statusFilter === 'expired') q.where("status = 'expired' or (status = 'open' and expiresAt <=", nowIso, ')');
            else if (statusFilter !== 'all') q.where({ status: statusFilter });
            // An expired offer counts as changed at expiresAt, even if its row still says open.
            if (sinceIso) q.where('modifiedAt >', sinceIso, "or (status = 'open' and expiresAt <=", nowIso, 'and expiresAt >', sinceIso, ')');
            return q.orderBy(statusFilter === 'open' ? 'createdAt desc' : 'modifiedAt desc');
        };
        const load = async (now: Date): Promise<SwapOffer[]> => {
            const nowIso = now.toISOString();
            if (!wantTag) return (await db.run(offers(nowIso).limit(n)) as SwapOffer[] | undefined) ?? [];
            // Tags are stored as JSON, so the query cannot filter them.
            // Page through IDs and tags until enough offers match, then load only those offers.
            const ids: string[] = [];
            const page = MAX_LIST_LIMIT * 4;
            for (let offset = 0; ids.length < n; offset += page) {
                const heads = (await db.run(offers(nowIso).columns('ID', 'tags').limit(page, offset)) as Array<Pick<SwapOffer, 'ID' | 'tags'>> | undefined) ?? [];
                for (const h of heads) {
                    if (parseJsonStringList(h.tags).includes(wantTag)) ids.push(h.ID);
                    if (ids.length >= n) break;
                }
                if (heads.length < page) break;
            }
            if (ids.length === 0) return [];
            const rows = (await db.run(SELECT.from(SwapOffers).where({ ID: { in: ids } })) as SwapOffer[] | undefined) ?? [];
            const order = new Map(ids.map((id, i) => [id, i]));
            return rows.sort((a, b) => (order.get(a.ID) ?? 0) - (order.get(b.ID) ?? 0));
        };

        if (!waitMs) {
            const now = new Date();
            return (await load(now)).map(row => publicView(row, now));
        }
        // Each read runs outside the request's transaction, so a waiting call holds no database connection.
        const readOnce = async () => {
            const now = new Date();
            return { rows: await runWithoutAmbientTx(() => load(now)), now };
        };
        const result = await holdUntil(req, waitMs, boardWaiters, await readOnce(), readOnce, r => r.rows.length > 0);
        return result.rows.map(row => publicView(row, result.now));
    });

    srv.on(getSwapOffer, async (req) => {
        const { offerId } = req.data;
        if (!offerId) return req.reject(400, 'offerId is required');
        if (!checkRateClass('read', 'read', req)) return;
        const row = await loadSwapOffer(db, String(offerId));
        if (!row) return req.reject(404, 'swap offer not found');
        return publicView(row, new Date());
    });

    srv.on(retireSwapOffer, async (req) => {
        const { offerId } = req.data;
        if (!offerId) return req.reject(400, 'offerId is required');
        if (!checkRateClass('compute', 'compute', req)) return;
        return runSubmission(req, async () => {
            const row = await loadSwapOffer(db, String(offerId));
            if (!row) throw new NightgateError('NOT_FOUND', 'swap offer not found');
            if (!isPoster(row, req)) throw new NightgateError('FORBIDDEN', 'only the poster retires an offer');
            // Listing does not save the expired status; this write path does. A close that finds the row no
            // longer open lost a race with a fill or another close: the answer is what the row says now.
            const closed = await closeSwapOffer(db, row.ID, isSwapOfferOpen(row) ? 'retired' : 'expired');
            const now = closed ? row : (await loadSwapOffer(db, row.ID)) ?? row;
            return { offerId: row.ID, status: closed ? (isSwapOfferOpen(row) ? 'retired' : 'expired') : effectiveSwapOfferStatus(now) };
        });
    });
}
