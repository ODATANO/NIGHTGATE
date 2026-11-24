/**
 * grantDisclosure on an EXISTING grant row: the confirmed `level` is the
 * off-chain read ACL, so a level request must not widen it before the chain
 * accepted the change, and nothing may be written for a caller who does not
 * hold the session.
 *
 * Runs the real handler, executor and reconciliation finalizer against the
 * in-memory CAP DB (cds.test()); only job admission, the contract resolver,
 * the wallet material and the transaction submitter are stand-ins.
 */
import cds from '@sap/cds';
import path from 'node:path';

const registeredProcessors = vi.hoisted(() => new Map<string, (command: unknown, row: any) => Promise<unknown>>());
const registeredFinalizers = vi.hoisted(() => new Map<string, (command: unknown, row: any, evidence: any) => Promise<unknown>>());
const admitted = vi.hoisted(() => [] as any[]);
const admissionFailure = vi.hoisted(() => ({ error: null as Error | null }));

vi.mock('../../srv/submission/background-jobs', async (importOriginal) => {
    const original = await importOriginal<typeof import('../../srv/submission/background-jobs')>();
    return {
        ...original,
        // Admission only: the job is recorded, never executed, so the row can
        // be inspected in the admitted state; the executor and the finalizer
        // are driven explicitly below.
        startJob: async (args: any) => {
            if (admissionFailure.error) throw admissionFailure.error;
            admitted.push(args);
            return { jobId: `job-${admitted.length}`, status: 'pending' as const };
        },
        registerBackgroundJobProcessor: (kind: string, version: number, _traits: unknown, processor: (command: unknown, row: any) => Promise<unknown>) => {
            registeredProcessors.set(`${kind}\0${version}`, processor);
        },
        registerBackgroundJobReconciliationFinalizer: (kind: string, version: number, finalizer: (command: unknown, row: any, evidence: any) => Promise<unknown>) => {
            registeredFinalizers.set(`${kind}\0${version}`, finalizer);
        }
    };
});

import { registerSubmissionHandlers } from '../../srv/submission/handlers';
import { SessionNotFoundError } from '../../srv/submission/wallet-material-factory';
import { registerContract, unregisterContract, getArtifactGenerationDigest } from '../../srv/submission/contract-registry';
import { runFinalizer } from '../fixtures/run-finalizer';

cds.test(__dirname + '/../..');

const GRANTS = 'midnight.DisclosureGrants';
const IDENTITIES = 'midnight.GranteeIdentities';
const OWNER = 'grant-owner';
const SESSION = 'grant-session';
const CONTRACT = 'c'.repeat(64);
const PAYLOAD = 'a'.repeat(64);
const GRANTEE = 'b'.repeat(64);
const ATTESTER = 'e'.repeat(64);
const VAULT = 'attestation-vault';

let db: any;
let handlers: Record<string, (req: any) => Promise<unknown>>;
let submitterBehaviour: { call: () => Promise<{ txHash: string }> };

function walletMaterial() {
    return { accountId: 'acct', privateStoragePasswordProvider: () => '0123456789ABCDEFG', walletAndMidnightProvider: { getCoinPublicKey: () => '', getEncryptionPublicKey: () => '' } };
}

function resolvedContract() {
    return {
        compiledContract: {},
        privateStateId: 'demo',
        zkConfigPath: path.resolve(__dirname, '../fixtures'),
        artifactPath: path.resolve(__dirname, '../fixtures/fake-vault-artifact.mjs'),
        artifactDigest: getArtifactGenerationDigest(VAULT)
    };
}

function makeReq(user: string, level: number) {
    const req = new cds.Request({
        event: 'grantDisclosure',
        data: { payloadHash: PAYLOAD, grantee: GRANTEE, level, sessionId: SESSION, contractAddress: CONTRACT }
    });
    req.user = new cds.User({ id: user } as any);
    return req;
}

function grantCommand(disclosureGrantId: string, level: number) {
    return {
        op: 'grantDisclosure', disclosureGrantId, payloadHash: PAYLOAD, attesterId: ATTESTER, grantee: GRANTEE, level,
        contractAddress: CONTRACT, contractName: VAULT, artifactDigest: getArtifactGenerationDigest(VAULT)
    };
}

async function seedActiveGrant(level: number): Promise<string> {
    const ID = cds.utils.uuid();
    const now = new Date().toISOString();
    await db.run(cds.ql.INSERT.into(GRANTS).entries({
        ID, contractAddress: CONTRACT, payloadHash: PAYLOAD, attesterId: ATTESTER, grantee: GRANTEE, level, pendingLevel: null,
        grantedTxHash: '0x01', revokedTxHash: null, isActive: true, createdAt: now, modifiedAt: now
    }));
    return ID;
}

async function grantRow(ID: string): Promise<any> {
    return db.run(cds.ql.SELECT.one.from(GRANTS).where({ ID }));
}

beforeAll(async () => {
    db = await cds.connect.to('db');
    registerContract(VAULT, {
        artifactPath: path.resolve(__dirname, '../fixtures/fake-vault-artifact.mjs'),
        privateStateId: 'test',
        zkConfigPath: path.resolve(__dirname, '../fixtures')
    });
    handlers = {};
    registerSubmissionHandlers({ on: (event: string, fn: any) => { handlers[event] = fn; } } as any, db, {
        resolveContractImpl: async () => resolvedContract(),
        attesterIdResolver: async () => ATTESTER,
        walletMaterialFactory: async ({ sessionId, expectedUserId }: any) => {
            if (expectedUserId !== OWNER) throw new SessionNotFoundError(sessionId);
            return walletMaterial();
        },
        submitterFactory: () => ({ call: () => submitterBehaviour.call() }) as any,
        disclosureReindexer: async () => ({ indexed: 0, deactivated: 0, snapshotHeight: null })
    });
});

afterAll(() => {
    unregisterContract(VAULT);
});

beforeEach(async () => {
    admitted.length = 0;
    admissionFailure.error = null;
    submitterBehaviour = { call: async () => ({ txHash: '0xincluded' }) };
    await db.run(cds.ql.DELETE.from(GRANTS));
    await db.run(cds.ql.DELETE.from(IDENTITIES));
});

describe('level request on an existing active grant', () => {
    test('keeps the confirmed level until the finalizer sees the inclusion', async () => {
        const ID = await seedActiveGrant(1);

        const result: any = await handlers.grantDisclosure(makeReq(OWNER, 2));
        expect(result).toMatchObject({ status: 'pending', disclosureGrantId: ID });
        expect(admitted).toHaveLength(1);

        const pending = await grantRow(ID);
        expect(pending).toMatchObject({ level: 1, pendingLevel: 2, isActive: true });

        const finalizer = registeredFinalizers.get('grantDisclosure\x001')!;
        await runFinalizer(finalizer, grantCommand(ID, 2), { ID: 'job-1', kind: 'grantDisclosure' }, {
            submissionId: null, txHash: '0xincluded', contractAddress: CONTRACT, finalizedAt: null, blockHeight: 0
        }, db);

        const confirmed = await grantRow(ID);
        expect(confirmed).toMatchObject({ level: 2, pendingLevel: null, grantedTxHash: '0xincluded', isActive: true });
    });

    test('a refused submission drops the request and leaves the confirmed level', async () => {
        const ID = await seedActiveGrant(1);
        await handlers.grantDisclosure(makeReq(OWNER, 2));
        expect(await grantRow(ID)).toMatchObject({ level: 1, pendingLevel: 2 });

        submitterBehaviour = { call: async () => { throw new Error('not attester'); } };
        const processor = registeredProcessors.get('grantDisclosure\x001')!;
        await expect(processor(grantCommand(ID, 2), {
            ID: 'job-1', kind: 'grantDisclosure', sessionId: SESSION, requestedBy: OWNER, commandVersion: 1
        })).rejects.toThrow(/not attester/);

        expect(await grantRow(ID)).toMatchObject({ level: 1, pendingLevel: null, isActive: true });
    });

    test('a caller who does not hold the session is refused and the row is untouched', async () => {
        const ID = await seedActiveGrant(1);
        const before = await grantRow(ID);

        await expect(handlers.grantDisclosure(makeReq('someone-else', 2))).rejects.toSatisfy((err: any) =>
            err.status === 404 && err.code === 'SESSION_NOT_FOUND');

        expect(admitted).toHaveLength(0);
        const after = await grantRow(ID);
        expect(after).toMatchObject({ level: 1, pendingLevel: null, isActive: true, modifiedAt: before.modifiedAt });
    });

    test('a failed admission leaves no request behind', async () => {
        const ID = await seedActiveGrant(1);
        admissionFailure.error = new Error('queue full');

        await expect(handlers.grantDisclosure(makeReq(OWNER, 2))).rejects.toThrow();

        expect(await grantRow(ID)).toMatchObject({ level: 1, pendingLevel: null });
    });

    test('a new grant starts inactive and a failed admission removes it again', async () => {
        admissionFailure.error = new Error('queue full');
        await expect(handlers.grantDisclosure(makeReq(OWNER, 2))).rejects.toThrow();
        const rows = await db.run(cds.ql.SELECT.from(GRANTS).where({ contractAddress: CONTRACT }));
        expect(rows).toHaveLength(0);

        admissionFailure.error = null;
        const result: any = await handlers.grantDisclosure(makeReq(OWNER, 2));
        expect(await grantRow(result.disclosureGrantId)).toMatchObject({ level: 2, pendingLevel: null, isActive: false, userId: OWNER, sessionId: SESSION });
    });

    test('a row read from the chain gets the caller as owner on the first request; a row with an owner keeps it', async () => {
        const fromChain = await seedActiveGrant(1);
        expect(await grantRow(fromChain)).toMatchObject({ userId: null, sessionId: null });
        await handlers.grantDisclosure(makeReq(OWNER, 2));
        expect(await grantRow(fromChain)).toMatchObject({ userId: OWNER, sessionId: SESSION, pendingLevel: 2 });

        await db.run(cds.ql.UPDATE.entity(GRANTS).set({ userId: 'first-owner', sessionId: null }).where({ ID: fromChain }));
        await handlers.grantDisclosure(makeReq(OWNER, 1));
        expect(await grantRow(fromChain)).toMatchObject({ userId: 'first-owner', sessionId: null });
    });
});

describe('retracting an attestation (mode 0) ends its disclosure grants', () => {
    const retractCommand = () => ({
        op: 'retract', mode: 0, key: PAYLOAD, attesterId: ATTESTER, contractAddress: CONTRACT,
        contractName: VAULT, artifactDigest: getArtifactGenerationDigest(VAULT)
    });

    test('the executor marks the grants inactive with the retract transaction', async () => {
        const ID = await seedActiveGrant(1);
        submitterBehaviour = { call: async () => ({ txHash: 'ab'.repeat(32) }) };
        const processor = registeredProcessors.get('retractAttestation\x001')!;
        await processor(retractCommand(), { ID: 'job-r', kind: 'retractAttestation', sessionId: SESSION, requestedBy: OWNER, commandVersion: 1 });
        expect(await grantRow(ID)).toMatchObject({ isActive: false, revokedTxHash: 'ab'.repeat(32) });
    });

    test('the reconciliation finalizer does the same for a landed retract', async () => {
        const ID = await seedActiveGrant(1);
        const finalizer = registeredFinalizers.get('retractAttestation\x001')!;
        await runFinalizer(finalizer, retractCommand(), { ID: 'job-r', kind: 'retractAttestation' }, {
            submissionId: null, txHash: 'cd'.repeat(32), contractAddress: CONTRACT, finalizedAt: null, blockHeight: 0
        }, db);
        expect(await grantRow(ID)).toMatchObject({ isActive: false, revokedTxHash: 'cd'.repeat(32) });
    });
});
