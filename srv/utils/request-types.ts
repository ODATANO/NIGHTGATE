// SPDX-License-Identifier: Apache-2.0
import type { DisclosureRoleValue } from '../middleware/disclosure-role';

/** The agent grant a request runs under. The agent token check sets it. */
export interface RequestAgentGrant {
    ID: string;
    sessionId: string;
    userId: string;
    allowedContracts: string[];
    allowedCircuits: string[];
    deployedContracts: string[];
    allowedTokenTypes: string[];
    mintedTokenTypes: string[];
    allowDeploy: boolean;
    allowSwaps: boolean;
}

// Fields the plugin's before-handlers set on every CAP request.
declare module '@sap/cds' {
    interface Request {
        agentGrant?: RequestAgentGrant;
        disclosureRole?: DisclosureRoleValue;
    }
}

