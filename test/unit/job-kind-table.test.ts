/**
 * The job-kind trait table (`srv/submission/job-kinds.ts`) is the ONE place a
 * kind's concurrency class, workflow-parent role and identifier keying are
 * declared; the runner derives its sets from the registrations. These tests
 * pin the table against the behaviour the runner used to hard-code, and the
 * guards that stop the table and the registrations from drifting apart.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
    JOB_KIND_TRAITS, LIGHT_KIND, HEAVY_KIND, WORKFLOW_PARENT_KIND, declaredJobKindTraits
} from '../../srv/submission/job-kinds';
import {
    registerBackgroundJobProcessor, declareJobKind, jobKindTraits, kindsWithTrait,
    undeclaredOrUnregisteredJobKinds, __workflowParentKindsForTests, __resetForTests
} from '../../srv/submission/background-jobs';

const noop = async () => ({});

beforeEach(() => __resetForTests());

describe('job kind traits', () => {
    it('every kind whose executor drives child commands is a workflow parent', () => {
        for (const kind of [
            'issueFieldPredicateAttestation', 'issueFieldPredicateAttestationBatch',
            'issueFieldEqualityAttestation', 'issueFieldMembershipAttestation',
            'issueDocumentIntegrityAttestation', 'issueDocumentDiffAttestation',
            'anchorDocumentGuarded'
        ]) {
            expect(JOB_KIND_TRAITS[kind]?.workflowParent, kind).toBe(true);
        }
        // and nothing else: a parent row carries no hash, the leaf sweep skips it
        const parents = Object.entries(JOB_KIND_TRAITS).filter(([, t]) => t.workflowParent).map(([k]) => k).sort();
        expect(parents).toEqual([
            'anchorDocumentGuarded',
            'issueDocumentDiffAttestation', 'issueDocumentIntegrityAttestation',
            'issueFieldEqualityAttestation', 'issueFieldMembershipAttestation',
            'issueFieldPredicateAttestation', 'issueFieldPredicateAttestationBatch'
        ]);
    });

    it('the two sponsor phases are the only identifier-keyed kinds', () => {
        const keyed = Object.entries(JOB_KIND_TRAITS).filter(([, t]) => t.identifierKeyed).map(([k]) => k).sort();
        expect(keyed).toEqual(['sponsorFinalizedTransaction', 'sponsorUnboundTransaction']);
    });

    it('proving kinds are heavy, sync-bound ones light, the prewarm serial and session-bound', () => {
        for (const kind of ['deployContract', 'submitContractCall', 'sendNight', 'registerForDustGeneration', 'anchorDocument', 'buildSponsorableTx', 'sponsorUnboundTransaction', 'fieldPredicateProof', 'mintShieldedTestToken']) {
            expect(JOB_KIND_TRAITS[kind]?.heavy, kind).toBe(true);
        }
        expect(JOB_KIND_TRAITS.sponsorFinalizedTransaction.heavy).toBe(false);
        expect(JOB_KIND_TRAITS.connectWalletForSigning).toEqual({ ...LIGHT_KIND, serial: true, sessionBound: true });
        expect(Object.values(JOB_KIND_TRAITS).filter(t => t.serial)).toHaveLength(1);
        expect(Object.values(JOB_KIND_TRAITS).filter(t => t.sessionBound)).toHaveLength(1);
    });

    it('declaredJobKindTraits refuses an undeclared kind, so a registration cannot skip the table', () => {
        expect(declaredJobKindTraits('deployContract')).toBe(HEAVY_KIND);
        expect(() => declaredJobKindTraits('predicateCommitValue')).toThrow(/not declared/);
        expect(() => declaredJobKindTraits('constructor')).toThrow(/not declared/);
    });
});

describe('derived sets', () => {
    it('registration declares the traits; the sets follow the registrations', () => {
        registerBackgroundJobProcessor('tableTestParent', 1, WORKFLOW_PARENT_KIND, noop);
        registerBackgroundJobProcessor('tableTestLeaf', 1, HEAVY_KIND, noop);
        declareJobKind('tableTestSerial', { ...LIGHT_KIND, serial: true });
        expect(__workflowParentKindsForTests().has('tableTestParent')).toBe(true);
        expect(__workflowParentKindsForTests().has('tableTestLeaf')).toBe(false);
        expect(kindsWithTrait('serial')).toContain('tableTestSerial');
        expect(jobKindTraits('tableTestLeaf').heavy).toBe(true);
        expect(jobKindTraits('neverRegistered')).toEqual(LIGHT_KIND);
    });

    it('a registration without traits is refused', () => {
        expect(() => (registerBackgroundJobProcessor as any)('noTraits', 1, noop)).toThrow(/traits/);
        expect(() => registerBackgroundJobProcessor('halfTraits', 1, { heavy: true } as any, noop)).toThrow(/booleans/);
    });

    it('a declared kind nobody registered is reported, so the runner can refuse to start', () => {
        // This process registers nothing from the table by itself.
        const missing = undeclaredOrUnregisteredJobKinds();
        expect(missing).toContain('deployContract');
        registerBackgroundJobProcessor('deployContract', 1, declaredJobKindTraits('deployContract'), noop);
        expect(undeclaredOrUnregisteredJobKinds()).not.toContain('deployContract');
    });
});
