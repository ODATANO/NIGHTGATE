/**
 * The names actions had before are not answered: a booted server returns 404 for them.
 */
import { describe, it, expect } from 'vitest';
import cds from '@sap/cds';
import { RENAMED_ACTIONS } from '../../srv/submission/job-kinds';

const cap = cds.test(__dirname + '/../..') as any;
const MAIN = '/odata/v4/midnight';

const statusOf = async (p: Promise<any>): Promise<number> => (await p.catch((e: any) => e.response ?? e)).status;

describe('former action names', () => {
    it('an action under its former name answers 404, the current name is served', async () => {
        const body = { finalizedTxB64: Buffer.from('probe').toString('base64'), noSuchParameter: 1 };
        expect(await statusOf(cap.POST(`${MAIN}/sponsorFinalized`, body))).toBe(400);
        expect(await statusOf(cap.POST(`${MAIN}/sponsorFinalizedTransaction`, body))).toBe(404);
    });

    it('a function under its former name answers 404', async () => {
        expect(await statusOf(cap.GET(`${MAIN}/verifyAttestation(contractAddress='not-hex')`))).toBe(400);
        expect(await statusOf(cap.GET(`${MAIN}/verifyAttestationState(contractAddress='not-hex')`))).toBe(404);
    });

    it('no former name is an action of the service any more', () => {
        const service = cds.services['NightgateService'] as unknown as { operations?: Record<string, unknown>; actions?: Record<string, unknown> };
        const served = service.operations ?? service.actions ?? {};
        for (const former of Object.keys(RENAMED_ACTIONS)) expect(Object.hasOwn(served, former), former).toBe(false);
    });
});
