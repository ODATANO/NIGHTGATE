/**
 * Offer board actions: post a maker half, list open halves, retire one.
 * SPDX-License-Identifier: Apache-2.0
 */
import cds from '@sap/cds';
import { SwapOffers } from '#cds-models/midnight';
import type { NightgateRequest } from '../../utils/request-types';
import { NightgateError, isNightgateError } from '../../utils/errors';
import { transactionBytesOf } from '../../utils/offer-file';
import { walletDescribeSwapHalf } from '../../midnight/wallet-worker-client';
import { isSwapOfferOpen, loadSwapOffer, closeSwapOffer, parseJsonList, type SwapOfferRow } from '../swap-offers';
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

function publicView(row: SwapOfferRow) {
    return {
        offerId: row.ID, offer: row.offer, bound: row.bound === true,
        givesType: row.givesType, givesAmount: row.givesAmount, wantsType: row.wantsType, wantsAmount: row.wantsAmount,
        tags: JSON.stringify(parseJsonList(row.tags)), expiresAt: row.expiresAt ?? null, postedAt: row.createdAt ?? null
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
                posterUserId: String(req.user?.id ?? 'anonymous'), posterGrantId: req.agentGrant?.ID ?? null,
                sessionId: req.agentGrant?.sessionId ?? null, createdAt: now, modifiedAt: now
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
        const { givesType, wantsType, tag, limit } = req.data as { givesType?: string; wantsType?: string; tag?: string; limit?: number };
        const where: Record<string, unknown> = { status: 'open' };
        for (const [name, value] of [['givesType', givesType], ['wantsType', wantsType]] as const) {
            if (value === undefined || value === null || value === '') continue;
            const v = String(value).trim().toLowerCase();
            if (!HEX64_RE.test(v)) return req.reject(400, `${name} must be 64 hex characters`);
            where[name] = v;
        }
        const n = limit === undefined || limit === null ? DEFAULT_LIST_LIMIT : Number(limit);
        if (!Number.isInteger(n) || n < 1 || n > MAX_LIST_LIMIT) return req.reject(400, `limit must be an integer from 1 to ${MAX_LIST_LIMIT}`);
        const wantTag = tag ? String(tag).trim() : '';
        const now = new Date();
        // Expiry is filtered in the query and never stamped here (the fill and
        // retire paths do that): a listing is a pure read and the limit counts open offers only.
        const openOffers = () => SELECT.from(SwapOffers).where(where).and('expiresAt is null or expiresAt >', now.toISOString());
        if (!wantTag) {
            const rows: SwapOfferRow[] = await db.run(openOffers().orderBy('createdAt desc').limit(n)) ?? [];
            return rows.map(publicView);
        }
        // A tag filter pages through the small columns (tags live in a JSON
        // column) until the limit is met, then fetches only the picked offers with their halves.
        const ids: string[] = [];
        const page = MAX_LIST_LIMIT * 4;
        for (let offset = 0; ids.length < n; offset += page) {
            const heads: Array<Pick<SwapOfferRow, 'ID' | 'tags'>> = await db.run(
                openOffers().columns('ID', 'tags').orderBy('createdAt desc').limit(page, offset)
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
        return rows.sort((a, b) => (order.get(a.ID) ?? 0) - (order.get(b.ID) ?? 0)).map(publicView);
    });

    srv.on('retireSwapOffer', async (req: NightgateRequest) => {
        const { offerId } = req.data as { offerId?: string };
        if (!offerId) return req.reject(400, 'offerId is required');
        return runSubmission(req, async () => {
            const row = await loadSwapOffer(db, String(offerId));
            if (!row) throw new NightgateError('NOT_FOUND', 'swap offer not found');
            const mine = req.agentGrant
                ? row.posterGrantId === req.agentGrant.ID
                : row.posterUserId === String(req.user?.id ?? '') && !row.posterGrantId;
            if (!mine) throw new NightgateError('FORBIDDEN', 'only the poster retires an offer');
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
