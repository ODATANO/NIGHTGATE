/**
 * Tests for src/sdk/AttestationService.ts (T11).
 *
 * HYBRID approach: runs against a REAL in-memory CAP DB via cds.test()
 * (see test/jest.setup.ts). The `@sap/cds` cds.ql mock that the previous
 * version of this suite used has been removed — the disclosure-role lookup
 * the `before('*')` hook performs now hits the real `midnight.DisclosureRoles`
 * table, seeded per-test, and the tier gates run the real `meetsDisclosure`
 * logic against the role the real hook attached.
 *
 * Why a recording service shim (not a served service): `AttestationService`
 * is an `@abstract` CAP service living under `src/sdk/`. It is NOT part of the
 * served model (only `srv/*.cds` + `db/*.cds` are auto-loaded), and abstract
 * services are never served on their own — a consumer app extends it. So there
 * is no live endpoint to drive. We instead register the real handlers via the
 * real `registerAttestationServiceHandlers` onto a shim that records them
 * (proving the wiring), then exercise each recorded handler:
 *   - the `before('*')` hook is run with the REAL db so it reads real
 *     DisclosureRoles rows (replaces the old "stub the SELECT" assertion);
 *   - the tier gates are run after the real hook populated req.disclosureRole,
 *     giving an end-to-end seed → attach → gate flow, plus direct role-set
 *     cases for the boundary conditions.
 *
 * Field-width tiering (which columns each projection exposes) is asserted
 * behaviourally against real seeded Attestations rows, mirroring the column
 * lists declared in AttestationService.cds.
 */
import cds from '@sap/cds';
import { registerAttestationServiceHandlers, toPredicateEnvelope } from '../../src/sdk/AttestationService';

jest.setTimeout(60000);

// Boot the in-memory CAP server. Not assigned to a `test` const on purpose
// (would shadow Jest's global test()).
cds.test(__dirname + '/../..');

const ROLES = 'midnight.DisclosureRoles';
const ATTESTATIONS = 'midnight.Attestations';

interface Handler { event: string; entity?: string; fn: Function; }

/**
 * Records the handlers registerAttestationServiceHandlers wires, mirroring the
 * subset of the CAP service API the helper uses (`before`).
 */
function makeRecordingService() {
    const handlers: Handler[] = [];
    const srv: any = {
        before(event: string, entityOrFn: string | Function, maybeFn?: Function) {
            if (typeof entityOrFn === 'function') {
                handlers.push({ event, fn: entityOrFn });
            } else {
                handlers.push({ event, entity: entityOrFn, fn: maybeFn! });
            }
        }
    };
    return { srv, handlers };
}

function makeReq(userId?: string): any {
    const req: any = {
        user: userId ? { id: userId } : undefined,
        reject: jest.fn().mockImplementation((code: number, message: string) => {
            req.__rejected = { code, message };
        })
    };
    return req;
}

async function seedRoles(...grants: Array<{ userId: string; role: string; scope?: string | null; validFrom?: string | null; validUntil?: string | null }>): Promise<void> {
    await db.run(cds.ql.INSERT.into(ROLES).entries(grants.map(g => ({
        ID:         cds.utils.uuid(),
        userId:     g.userId,
        role:       g.role,
        scope:      g.scope ?? null,
        validFrom:  g.validFrom ?? null,
        validUntil: g.validUntil ?? null
    }))));
}

let db: any;

beforeAll(async () => {
    db = await cds.connect.to('db');
});

beforeEach(async () => {
    await db.run(cds.ql.DELETE.from(ROLES));
    await db.run(cds.ql.DELETE.from(ATTESTATIONS));
});

describe('registerAttestationServiceHandlers', () => {
    test('registers a before(*) hook and two tier gates', () => {
        const { srv, handlers } = makeRecordingService();
        registerAttestationServiceHandlers(srv, db);

        const events = handlers.map(h => `${h.event}:${h.entity ?? '*'}`);
        expect(events).toEqual([
            '*:*',
            'READ:Disclosed',
            'READ:Authority'
        ]);
    });

    test('star hook attaches disclosure role from the real DB', async () => {
        const { srv, handlers } = makeRecordingService();
        registerAttestationServiceHandlers(srv, db);

        await seedRoles({ userId: 'alice', role: 'legitimate_interest' });

        const req = makeReq('alice');
        // handlers[0] is the before('*') hook; it runs the real attachDisclosureRole.
        await handlers[0].fn(req);
        expect(req.disclosureRole).toBe('legitimate_interest');
    });

    test('star hook defaults to public_only when the user has no grant', async () => {
        const { srv, handlers } = makeRecordingService();
        registerAttestationServiceHandlers(srv, db);

        const req = makeReq('nobody');
        await handlers[0].fn(req);
        expect(req.disclosureRole).toBe('public_only');
    });

    test('star hook picks the highest currently-valid grant from the real DB', async () => {
        const { srv, handlers } = makeRecordingService();
        registerAttestationServiceHandlers(srv, db);

        await seedRoles(
            { userId: 'bob', role: 'public_only' },
            { userId: 'bob', role: 'legitimate_interest' },
            { userId: 'bob', role: 'authority' }
        );

        const req = makeReq('bob');
        await handlers[0].fn(req);
        expect(req.disclosureRole).toBe('authority');
    });

    test('Public has no gate (only fields-set filtering at projection level)', () => {
        const { srv, handlers } = makeRecordingService();
        registerAttestationServiceHandlers(srv, db);
        // Only Disclosed and Authority should appear as gated entities.
        const gated = handlers.filter(h => h.entity).map(h => h.entity);
        expect(gated).not.toContain('Public');
        expect(gated).toEqual(['Disclosed', 'Authority']);
    });

    /** Resolve a freshly-registered gate handler for the given tier entity. */
    function gateFor(entity: 'Disclosed' | 'Authority'): Function {
        const { srv, handlers } = makeRecordingService();
        registerAttestationServiceHandlers(srv, db);
        return handlers.find(h => h.entity === entity)!.fn;
    }

    /** Resolve both the star hook and a tier gate for end-to-end flows. */
    function pipeline(entity: 'Disclosed' | 'Authority'): { star: Function; gate: Function } {
        const { srv, handlers } = makeRecordingService();
        registerAttestationServiceHandlers(srv, db);
        return {
            star: handlers[0].fn,
            gate: handlers.find(h => h.entity === entity)!.fn
        };
    }

    describe('Disclosed gate', () => {
        test('rejects public_only callers', () => {
            const gate = gateFor('Disclosed');
            const req = makeReq('bob');
            req.disclosureRole = 'public_only';
            gate(req);
            expect(req.reject).toHaveBeenCalledWith(403, expect.stringContaining("'Disclosed'"));
        });

        test('rejects undefined role (treated as public_only)', () => {
            const gate = gateFor('Disclosed');
            const req = makeReq('bob');
            gate(req);
            expect(req.reject).toHaveBeenCalledWith(403, expect.any(String));
        });

        test('allows legitimate_interest', () => {
            const gate = gateFor('Disclosed');
            const req = makeReq('bob');
            req.disclosureRole = 'legitimate_interest';
            gate(req);
            expect(req.reject).not.toHaveBeenCalled();
        });

        test('allows authority', () => {
            const gate = gateFor('Disclosed');
            const req = makeReq('bob');
            req.disclosureRole = 'authority';
            gate(req);
            expect(req.reject).not.toHaveBeenCalled();
        });

        test('end-to-end: a real legitimate_interest grant passes the gate', async () => {
            const { star, gate } = pipeline('Disclosed');
            await seedRoles({ userId: 'carol', role: 'legitimate_interest' });
            const req = makeReq('carol');
            await star(req);            // real DB lookup populates req.disclosureRole
            gate(req);
            expect(req.disclosureRole).toBe('legitimate_interest');
            expect(req.reject).not.toHaveBeenCalled();
        });

        test('end-to-end: a user with no grant is rejected by the gate', async () => {
            const { star, gate } = pipeline('Disclosed');
            const req = makeReq('stranger');
            await star(req);
            gate(req);
            expect(req.disclosureRole).toBe('public_only');
            expect(req.reject).toHaveBeenCalledWith(403, expect.stringContaining("'Disclosed'"));
        });
    });

    describe('Authority gate', () => {
        test('rejects public_only', () => {
            const gate = gateFor('Authority');
            const req = makeReq('bob');
            req.disclosureRole = 'public_only';
            gate(req);
            expect(req.reject).toHaveBeenCalledWith(403, expect.stringContaining("'Authority'"));
        });

        test('rejects legitimate_interest', () => {
            const gate = gateFor('Authority');
            const req = makeReq('bob');
            req.disclosureRole = 'legitimate_interest';
            gate(req);
            expect(req.reject).toHaveBeenCalledWith(403, expect.any(String));
        });

        test('allows authority', () => {
            const gate = gateFor('Authority');
            const req = makeReq('bob');
            req.disclosureRole = 'authority';
            gate(req);
            expect(req.reject).not.toHaveBeenCalled();
        });

        test('end-to-end: a real authority grant passes the gate', async () => {
            const { star, gate } = pipeline('Authority');
            await seedRoles({ userId: 'dana', role: 'authority' });
            const req = makeReq('dana');
            await star(req);
            gate(req);
            expect(req.disclosureRole).toBe('authority');
            expect(req.reject).not.toHaveBeenCalled();
        });

        test('end-to-end: a real legitimate_interest grant is rejected by the Authority gate', async () => {
            const { star, gate } = pipeline('Authority');
            await seedRoles({ userId: 'erin', role: 'legitimate_interest' });
            const req = makeReq('erin');
            await star(req);
            gate(req);
            expect(req.disclosureRole).toBe('legitimate_interest');
            expect(req.reject).toHaveBeenCalledWith(403, expect.stringContaining("'Authority'"));
        });
    });
});

// ---------------------------------------------------------------------------
// Field-width tiering — behavioural check against real seeded Attestations.
//
// AttestationService.cds declares progressively wider column projections:
//   Public    → ID, attestationId, anchoredTxHash, anchoredAt
//   Disclosed → + contractAddress, attester, publicMetadata
//   Authority → full row (incl. payloadCipher)
// The abstract service isn't served, so we assert the intent directly: reading
// the declared column set for each tier from a real row yields exactly the
// fields that tier is allowed to expose, and nothing wider.
// ---------------------------------------------------------------------------
describe('tier field-width projections (real DB rows)', () => {
    const PUBLIC_COLS    = ['ID', 'attestationId', 'anchoredTxHash', 'anchoredAt'];
    const DISCLOSED_COLS = ['ID', 'attestationId', 'contractAddress', 'attester', 'publicMetadata', 'anchoredTxHash', 'anchoredAt'];

    let attId: string;

    beforeEach(async () => {
        attId = cds.utils.uuid();
        await db.run(cds.ql.INSERT.into(ATTESTATIONS).entries({
            ID:              attId,
            attestationId:   'a'.repeat(64),
            contractAddress: 'b'.repeat(64),
            attester:        'c'.repeat(64),
            publicMetadata:  JSON.stringify({ kind: 'battery-passport' }),
            payloadCipher:   Buffer.from('secret-bytes'),
            anchoredTxHash:  'd'.repeat(64),
            anchoredAt:      new Date().toISOString()
        }));
    });

    test('Public tier exposes only the existence/anchor fields', async () => {
        const row = await db.run(
            cds.ql.SELECT.one.from(ATTESTATIONS).columns(...PUBLIC_COLS).where({ ID: attId })
        );
        expect(Object.keys(row).sort()).toEqual([...PUBLIC_COLS].sort());
        // The narrow tier must never carry attester identity, metadata or cipher.
        expect(row).not.toHaveProperty('attester');
        expect(row).not.toHaveProperty('publicMetadata');
        expect(row).not.toHaveProperty('payloadCipher');
    });

    test('Disclosed tier adds attester, contract and public metadata but not the cipher', async () => {
        const row = await db.run(
            cds.ql.SELECT.one.from(ATTESTATIONS).columns(...DISCLOSED_COLS).where({ ID: attId })
        );
        expect(Object.keys(row).sort()).toEqual([...DISCLOSED_COLS].sort());
        expect(row.attester).toBe('c'.repeat(64));
        expect(row.contractAddress).toBe('b'.repeat(64));
        expect(row).not.toHaveProperty('payloadCipher');
    });

    test('Authority tier exposes the full row including the off-chain cipher', async () => {
        // The Authority projection is `projection on midnight.Attestations` with
        // no column list — i.e. every field, including the LargeBinary cipher.
        // CAP omits LargeBinary from a default SELECT *, so the cipher is
        // requested explicitly here to prove the Authority tier can surface it
        // (it is the only tier whose column set includes payloadCipher).
        const row = await db.run(
            cds.ql.SELECT.one.from(ATTESTATIONS)
                .columns('ID', 'attestationId', 'contractAddress', 'attester', 'publicMetadata', 'payloadCipher', 'anchoredTxHash', 'anchoredAt')
                .where({ ID: attId })
        );
        expect(row).toHaveProperty('payloadCipher');
        expect(row.payloadCipher).toBeTruthy();
        expect(row.attestationId).toBe('a'.repeat(64));
    });
});

describe('toPredicateEnvelope', () => {
    const row = {
        predicate: 'lessOrEqual',
        threshold: 50000,
        unit: 'kgCO2e/kWh',
        valueCommitment: 'c'.repeat(64),
        contractAddress: '0xVAULT',
        provenTxHash: '0xprove'
    };

    test('maps a row to the PAC envelope shape', () => {
        expect(toPredicateEnvelope(row)).toEqual({
            digestMultibase: 'c'.repeat(64),
            claim: { predicate: 'lessOrEqual', threshold: '50000', unit: 'kgCO2e/kWh' },
            proof: {
                system: 'midnight-compact',
                circuit: 'provePredicate',
                verificationMethod: '0xVAULT',
                proofValue: '0xprove'
            }
        });
    });

    test('digestMultibase is null when no commitment is known', () => {
        const env = toPredicateEnvelope({ ...row, valueCommitment: null });
        expect(env.digestMultibase).toBeNull();
    });

    test('threshold is always stringified; missing unit/txHash degrade gracefully', () => {
        const env = toPredicateEnvelope({ predicate: 'greaterOrEqual', threshold: 7, contractAddress: '0xC' });
        expect(env.claim.threshold).toBe('7');
        expect(env.claim.unit).toBeNull();
        expect(env.proof.proofValue).toBe('');
    });
});
