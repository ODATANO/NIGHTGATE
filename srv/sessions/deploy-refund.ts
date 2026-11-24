// SPDX-License-Identifier: Apache-2.0
import cds from '@sap/cds';
import { AgentGrants } from '#cds-models/midnight';

const { UPDATE } = cds.ql;

/** Gives `count` reserved deploys back to a grant. The count never drops below zero. */
export function deployRefund(grantId: string, count: number) {
    return UPDATE.entity(AgentGrants).set({ deploysUsed: { '-=': count } }).where({ ID: grantId, deploysUsed: { '>=': count } });
}

/** Gives `count` reserved maintenance updates back to a grant. The count never drops below zero. */
export function maintenanceRefund(grantId: string, count: number) {
    return UPDATE.entity(AgentGrants).set({ maintenanceUpdatesUsed: { '-=': count } }).where({ ID: grantId, maintenanceUpdatesUsed: { '>=': count } });
}