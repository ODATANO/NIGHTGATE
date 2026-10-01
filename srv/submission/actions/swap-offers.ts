/**
 * Offer board actions: post a maker half, read the board, retire one.
 * SPDX-License-Identifier: Apache-2.0
 */
import cds from '@sap/cds';
import { SwapOffers } from '#cds-models/midnight';
import type { NightgateRequest } from '../../utils/request-types';
import { NightgateError, isNightgateError } from '../../utils/errors';
import { transactionBytesOf } from '../../utils/offer-file';
import { walletDescribeSwapHalf } from '../../midnight/wallet-worker-client';
import { isSwapOfferOpen, loadSwapOffer, closeSwapOffer, effectiveSwapOfferStatus, parseJsonList, type SwapOfferRow, type SwapOfferStatus } from '../swap-offers';
import { swapOfferRateLimiter, swapListRateLimiter, checkRate, runSubmission } from './common';
import type { SubmissionContext } from './context';
import { HEX64_RE } from '../../utils/hex';

const { SELECT, INSERT } = cds.ql;

// Generous for a half (a few KB); keeps a pasted blob from reaching the worker.
const MAX_OFFER_CHARS = 262_144;
const MAX_TAGS = 8;
const MAX_TAG_CHARS = 40;
const MAX_EXPIRY_MS = 90 * 24 * 60 * 60 * 1000;
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

/** `listSwapOffers(status)`: one status, or every offer whatever its status. */
type StatusFilter = SwapOfferStatus | 'all';
const STATUS_FILTERS: ReadonlySet<string> = new Set(['open', 'filled', 'retired', 'expired', 'all']);

function parseTags(raw: unknown): string[] | string {
    if (raw === undefined || raw === null || raw === '') return [];
    let v: unknown = raw;
    if (typeof raw === 'string') {
        try { v = JSON.parse(raw); } catch { return 'tags must be a JSON array of strings'; }
    }
    if (!Array.isArray(v)) return 'tags must be a JSON array of strings';
    if (v.length > MAX_TAGS) return `tags: at most ${MAX_TAGS}`;
    const tags = [...new Set(v.map(t => String(t ?? '').trim()).filter(t => t.length > 0))];
    if (tags.some(t => t.length > MAX_TAG_CHARS)) return `tags: each at most ${MAX_TAG_CHARS} characters`;
    return tags;
}

/** The poster, as written, listed and matched: the principal and, under a token, its grant. */
function posterOf(req: NightgateRequest): { posterUserId: string; posterGrantId: string | null } {
    return { posterUserId: String(req.user?.id ?? ''), posterGrantId: req.agentGrant?.ID ?? null };
}

function isPoster(row: SwapOfferRow, req: NightgateRequest): boolean {
    const poster = posterOf(req);
    return row.posterUserId === poster.posterUserId && (row.posterGrantId ?? null) === poster.posterGrantId;
}

/** When a reader last saw the offer change: its row, or the clock that ran it out. */
function changedAtOf(row: SwapOfferRow, now: Date): string | null {
    const stamped = row.modifiedAt ?? row.createdAt ?? null;
    if (row.status !== 'open' || !row.expiresAt || Date.parse(row.expiresAt) > now.getTime()) return stamped;
    return stamped && Date.parse(stamped) > Date.parse(row.expiresAt) ? stamped : row.expiresAt;
}

function publicView(row: SwapOfferRow, now: Date) {
    return {
        offerId: row.ID, offer: row.offer, bound: row.bound === true,
        givesType: row.givesType, givesAmount: row.givesAmount, wantsType: row.wantsType, wantsAmount: row.wantsAmount,
        tags: JSON.stringify(parseJsonList(row.tags)), expiresAt: row.expiresAt ?? null, postedAt: row.createdAt ?? null,
        status: effectiveSwapOfferStatus(row, now), filledTxHash: row.filledTxHash ?? null, closedAt: row.closedAt ?? null,
        changedAt: changedAtOf(row, now)
    };
}

export function registerSwapOfferActions(ctx: Pick<SubmissionContext, 'srv' | 'db'>): void {
    const { srv, db } = ctx;

    srv.on('postSwapOffer', async (req: NightgateRequest) => {
        const { offer, expiresAt, tags } = req.data as { offer?: string; expiresAt?: string; tags?: unknown };
        if (!offer || typeof offer !== 'string') return req.reject(400, 'offer is required');
        if (offer.length > MAX_OFFER_CHARS) return req.reject(400, `offer: at most ${MAX_OFFER_CHARS} characters`);
        let halfB64: string;
        try { halfB64 = Buffer.from(await transactionBytesOf(offer)).toString('base64'); }
        catch (e) { return req.reject(400, `offer: ${(e as Error).message}`); }
        let expiry: string | null = null;
        if (expiresAt !== undefined && expiresAt !== null && expiresAt !== '') {
            const ms = Date.parse(String(expiresAt));
            if (!Number.isFinite(ms)) return req.reject(400, 'expiresAt must be an ISO timestamp');
            if (ms <= Date.now()) return req.reject(400, 'expiresAt must lie in the future');
            if (ms - Date.now() > MAX_EXPIRY_MS) return req.reject(400, 'expiresAt: at most 90 days ahead');
            expiry = new Date(ms).toISOString();
        }
        const parsedTags = parseTags(tags);
        if (typeof parsedTags === 'string') return req.reject(400, parsedTags);
        if (!checkRate(swapOfferRateLimiter, 'swap-offer', req)) return;

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
                ...posterOf(req), sessionId: req.agentGrant?.sessionId ?? null, createdAt: now, modifiedAt: now
            }));
            return {
                offerId: ID, status: 'open', bound: half.bound,
                givesType: half.gives.tokenType, givesAmount: half.gives.amount,
                wantsType: half.wants.tokenType, wantsAmount: half.wants.amount, expiresAt: expiry
            };
        });
    });

    srv.on('listSwapOffers', async (req: NightgateRequest) => {
        if (!checkRate(swapListRateLimiter, 'swap-list', req)) return;
        const { givesType, wantsType, tag, limit, status, since, mine } = req.data as {
            givesType?: string; wantsType?: string; tag?: string; limit?: number; status?: string; since?: string; mine?: boolean;
        };
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
        if (mine === true) Object.assign(where, posterOf(req));
        const wantTag = tag ? String(tag).trim() : '';
        const now = new Date();
        const nowIso = now.toISOString();
        // Expiry is filtered in the query and never stamped here (the fill and
        // retire paths do that): a listing is a pure read and the limit counts matching offers only.
        const offers = () => {
            const q = SELECT.from(SwapOffers).where(where);
            if (statusFilter === 'open') q.where({ status: 'open' }).and('expiresAt is null or expiresAt >', nowIso);
            else if (statusFilter === 'expired') q.where("status = 'expired' or (status = 'open' and expiresAt <=", nowIso, ')');
            else if (statusFilter !== 'all') q.where({ status: statusFilter });
            // An offer the clock ran out changed at expiresAt, stamped or not.
            if (sinceIso) q.where('modifiedAt >', sinceIso, "or (status = 'open' and expiresAt <=", nowIso, 'and expiresAt >', sinceIso, ')');
            // Open offers read as a board (newest post first); anything else as a change log.
            return q.orderBy(statusFilter === 'open' ? 'createdAt desc' : 'modifiedAt desc');
        };
        if (!wantTag) {
            const rows: SwapOfferRow[] = await db.run(offers().limit(n)) ?? [];
            return rows.map(row => publicView(row, now));
        }
        // A tag filter pages through the small columns (tags live in a JSON
        // column) until the limit is met, then fetches only the picked offers with their halves.
        const ids: string[] = [];
        const page = MAX_LIST_LIMIT * 4;
        for (let offset = 0; ids.length < n; offset += page) {
            const heads: Array<Pick<SwapOfferRow, 'ID' | 'tags'>> = await db.run(
                offers().columns('ID', 'tags').limit(page, offset)
            ) ?? [];
            for (const h of heads) {
                if (parseJsonList(h.tags).includes(wantTag)) ids.push(h.ID);
                if (ids.length >= n) break;
            }
            if (heads.length < page) break;
        }
        if (ids.length === 0) return [];
        const rows: SwapOfferRow[] = await db.run(SELECT.from(SwapOffers).where({ ID: { in: ids } })) ?? [];
        const order = new Map(ids.map((id, i) => [id, i]));
        return rows.sort((a, b) => (order.get(a.ID) ?? 0) - (order.get(b.ID) ?? 0)).map(row => publicView(row, now));
    });

    srv.on('getSwapOffer', async (req: NightgateRequest) => {
        const { offerId } = req.data as { offerId?: string };
        if (!offerId) return req.reject(400, 'offerId is required');
        if (!checkRate(swapListRateLimiter, 'swap-list', req)) return;
        const row = await loadSwapOffer(db, String(offerId));
        if (!row) return req.reject(404, 'swap offer not found');
        return publicView(row, new Date());
    });

    srv.on('retireSwapOffer', async (req: NightgateRequest) => {
        const { offerId } = req.data as { offerId?: string };
        if (!offerId) return req.reject(400, 'offerId is required');
        return runSubmission(req, async () => {
            const row = await loadSwapOffer(db, String(offerId));
            if (!row) throw new NightgateError('NOT_FOUND', 'swap offer not found');
            if (!isPoster(row, req)) throw new NightgateError('FORBIDDEN', 'only the poster retires an offer');
            if (!isSwapOfferOpen(row)) {
                // Listing never writes; an expiry is stamped on the write paths, this one included.
                if (row.status === 'open') await closeSwapOffer(db, row.ID, 'expired');
                throw new NightgateError('SWAP_OFFER_NOT_OPEN', `swap offer is ${row.status === 'open' ? 'expired' : row.status}`);
            }
            await closeSwapOffer(db, row.ID, 'retired');
            return { offerId: row.ID, status: 'retired' };
        });
    });
}
