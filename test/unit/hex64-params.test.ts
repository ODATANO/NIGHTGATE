/**
 * 32-byte hex parameters are typed `Hex64`, so CAP rejects a malformed value before any handler runs.
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

const HEX64_PARAMS: Record<string, string[]> = {
    'NightgateService.issueFieldPredicateAttestation': ['payloadHash', 'attesterId', 'fieldKey', 'fieldSalt', 'contentRoot', 'schemaId'],
    'NightgateService.issueFieldPredicateAttestationBatch': ['payloadHash', 'attesterId', 'contentRoot', 'schemaId'],
    'NightgateService.issueFieldEqualityAttestation': ['payloadHash', 'attesterId', 'fieldKey', 'expectedDigest', 'fieldSalt', 'contentRoot', 'schemaId'],
    'NightgateService.issueFieldMembershipAttestation': ['payloadHash', 'attesterId', 'fieldKey', 'valueDigest', 'setRoot', 'fieldSalt', 'contentRoot', 'schemaId'],
    'NightgateService.issueDocumentIntegrityAttestation': ['payloadHashA', 'payloadHashB', 'attesterIdA', 'attesterIdB', 'contentRootA', 'contentRootB', 'schemaId'],
    'NightgateService.issueDocumentDiffAttestation': ['payloadHashA', 'payloadHashB', 'attesterIdA', 'attesterIdB', 'contentRootA', 'contentRootB', 'schemaId'],
    'NightgateService.verifyAttestationState': ['attesterId', 'payloadHash', 'documentId', 'contentRoot', 'schemaId'],
    'NightgateService.verifyPredicateState': ['attesterId', 'payloadHash', 'fieldKey', 'expectedDigest', 'setRoot', 'payloadHashB', 'attesterIdB'],
    'NightgateService.anchorDocument': ['sha256'],
    'NightgateService.verifyDocument': ['providedSha256'],
    'NightgateService.grantDisclosure': ['payloadHash', 'grantee'],
    'NightgateService.revokeDisclosure': ['payloadHash', 'grantee'],
    'NightgateService.registerPassport': ['documentId', 'ownerId'],
    'NightgateService.retractAttestation': ['payloadHash'],
    'NightgateService.purgeExpired': ['key'],
    'NightgateService.deployContract': ['recoveryId'],
    'NightgateService.grantDisclosureToHolders': ['payloadHash', 'tokenType'],
    'NightgateService.claimDisclosure': ['payloadHash', 'tokenType', 'claimSecret'],
    'NightgateService.sendNight': ['tokenTypeHex'],
    'NightgateService.prepareDocumentProof': ['saltSeed'],
    'NightgateService.prepareMembershipSet': ['valueDigest'],
    'NightgateService.attestAgentOutput': ['inputHash', 'outputHash', 'policyHash'],
    'NightgateVerifyService.verifyAttestationState': ['attesterId', 'payloadHash', 'documentId', 'contentRoot', 'schemaId'],
    'NightgateVerifyService.verifyPredicateState': ['attesterId', 'payloadHash', 'fieldKey', 'expectedDigest', 'setRoot', 'payloadHashB', 'attesterIdB']
};

/** `cds.validate` exists at runtime but is missing from the CAP type declarations. */
const validate = (cds as unknown as { validate(data: object, target: unknown, opts: object): Array<{ code: string; target: string }> | undefined }).validate;

const cases = Object.entries(HEX64_PARAMS).flatMap(([op, params]) => params.map(p => [op, p] as const));

describe('Hex64 parameters', () => {
    let model: any;
    beforeAll(async () => {
        model = cds.linked(cds.compile.for.nodejs(await cds.load('srv')) as unknown as Parameters<typeof cds.linked>[0]);
    });

    function operation(name: string): any {
        const [service, op] = name.split('.');
        const found = model.definitions[name] ?? model.definitions[service]?.actions?.[op];
        if (!found) throw new Error(`no operation ${name}`);
        return found;
    }

    function formatErrors(op: any, param: string, value: string): unknown[] {
        return (validate({ [param]: value }, op, { mandatories: false }) ?? []).filter(e => e.code === 'ASSERT_FORMAT' && e.target === param);
    }

    it.each(cases)('%s(%s) rejects a malformed value and accepts 64 hex', (name, param) => {
        const op = operation(name);
        expect(op.params?.[param], `${name} has no parameter ${param}`).toBeDefined();
        expect(formatErrors(op, param, 'zz')).toHaveLength(1);
        expect(formatErrors(op, param, 'aB'.repeat(32))).toHaveLength(0);
    });
});
