// SPDX-License-Identifier: Apache-2.0
import type { Request } from '@sap/cds';
import type { DisclosureRoleValue } from '../middleware/disclosure-role';

/** The agent grant a request runs under. The agent token check sets it. */
export interface RequestAgentGrant {
    ID: string;
    sessionId: string;
    userId: string;
    sponsorSessionId: string | null; // null = the platform pool; the wallet session that pays sponsored jobs
    allowedContracts: string[];
    allowedCircuits: string[];
    deployedContracts: string[];
    allowedTokenTypes: string[];
    mintedTokenTypes: string[];
    allowDeploy: boolean;
    allowSwaps: boolean;
    allowTransfers: boolean;
    allowUnshieldedOffers: boolean;
    allowedUnshieldedTokenTypes: string[];
}

// Fields the plugin's before-handlers set on every CAP request.
declare module '@sap/cds' {
    interface Request {
        agentGrant?: RequestAgentGrant;
        disclosureRole?: DisclosureRoleValue;
        /** Settles once the agent token check has set the user. */
        agentPrincipalReady?: Promise<void>;
    }
}

/** Adds a condition to a READ query. CAP types req.query as the plain CQN union, which has no where(). */
export function narrowRead(req: Request, condition: Record<string, unknown>): void {
    const query = req.query as unknown as { where?: (condition: Record<string, unknown>) => unknown } | undefined;
    if (typeof query?.where === 'function') query.where(condition);
}


/** The caller's user id. Rejects with 401 and returns undefined when the request has none.
 *  Session actions must stop on undefined, so a leaked sessionId alone gives no access. */
export function requireUserId(req: Request): string | undefined {
    const uid = req.user?.id;
    if (!uid) { req.reject?.(401, 'authentication required'); return undefined; }
    return String(uid);
}
