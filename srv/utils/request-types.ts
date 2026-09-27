/**
 * CAP request plus the fields NIGHTGATE's before-handlers attach.
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Request } from '@sap/cds';
import type { DisclosureRoleValue } from '../middleware/disclosure-role';

/** Scope of the agent grant a request runs under; lists parsed, set by the agent-token check. */
export interface RequestAgentGrant {
    ID: string;
    sessionId: string;
    userId: string;
    allowedContracts: string[];
    allowedCircuits: string[];
    deployedContracts: string[];
    allowedTokenTypes: string[];
    allowDeploy: boolean;
}

export type NightgateRequest<D = any> = Request<D> & {
    agentGrant?: RequestAgentGrant;
    disclosureRole?: DisclosureRoleValue;
    /** CAP's raw HTTP request, absent outside HTTP. */
    _?: { req?: { ip?: string; headers?: Record<string, string | string[] | undefined> } };
};
