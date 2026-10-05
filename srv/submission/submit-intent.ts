/**
 * Data stored in an attempt row's `submitIntentData` just before a transaction is sent.
 * SPDX-License-Identifier: Apache-2.0
 */

export interface SubmitIntentSegment { segment: number; calls: string[] }

/** Facts recorded before sending. A job result is rebuilt from them if the send outcome got lost. */
export interface SubmitIntentCoordinates {
    channel?: 'bound';
    feeSponsor?: string;
    sponsorAccountId?: string | null;
    circuits?: string[];
    contractAddress?: string | null;
    note?: string;
    ttl?: string;
    segments?: SubmitIntentSegment[];
    deployed?: string[];
    minted?: string[];
    nullifiers?: string[];
    offerId?: string;
    deployReservation?: { grantId: string; count: number };
}

/** Parse a row's `submitIntentData`; missing or malformed data reads as no coordinates. */
export function parseSubmitIntent(data: string | null | undefined): SubmitIntentCoordinates {
    if (!data) return {};
    try {
        const parsed: unknown = JSON.parse(data);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as SubmitIntentCoordinates : {};
    } catch {
        return {};
    }
}
