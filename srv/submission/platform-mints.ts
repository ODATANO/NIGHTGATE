/**
 * Bookkeeping for a token mint that landed on chain, whatever path sent it.
 * The token types become known platform-wide. Under a grant they are also stored on the grant.
 * SPDX-License-Identifier: Apache-2.0
 */
import type { DbRunner } from '../utils/db-types';
import { recordLearnedTokenTypes } from './learned-token-types';
import { recordMintedTokenTypes } from '../sessions/agent-grants';

export interface PlatformMintOrigin {
    grantId?: string | null;
    sponsorSessionId?: string | null;
    txHash?: string | null;
}

export async function recordPlatformMint(db: DbRunner, types: string[], origin: PlatformMintOrigin): Promise<void> {
    if (!types.length) return;
    await recordLearnedTokenTypes(db, types, { grantId: origin.grantId ?? null, sponsorSessionId: origin.sponsorSessionId ?? null, txHash: origin.txHash ?? null });
    if (origin.grantId) await recordMintedTokenTypes(db, origin.grantId, types);
}
