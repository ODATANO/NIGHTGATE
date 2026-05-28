/**
 * Tests for src/sdk/AttestationService.ts (T11).
 *
 * Verifies the registerAttestationServiceHandlers helper wires:
 *   - a `before('*')` hook that calls attachDisclosureRole
 *   - per-entity tier gates that reject if req.disclosureRole is too low
 *
 * The real attachDisclosureRole is hit through the actual middleware (no mock)
 * — we control its return by stubbing the DB SELECT it makes.
 */

const selectFromSpy = jest.fn();
const selectWhereSpy = jest.fn();
const dbRun = jest.fn();

jest.mock('@sap/cds', () => {
    const cds: any = {
        env: { requires: { nightgate: {} } },
        ql: {
            SELECT: {
                from: (entity: string) => {
                    selectFromSpy(entity);
                    return { where: selectWhereSpy };
                }
            }
        }
    };
    cds.default = cds;
    return cds;
});

import { registerAttestationServiceHandlers } from '../../src/sdk/AttestationService';

interface Handler { event: string; entity?: string; fn: Function; }

function makeFakeService() {
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

function makeReq(userId?: string) {
    const req: any = {
        user: userId ? { id: userId } : undefined,
        reject: jest.fn().mockImplementation((code: number, message: string) => {
            (req as any).__rejected = { code, message };
        })
    };
    return req;
}

beforeEach(() => {
    selectFromSpy.mockClear();
    selectWhereSpy.mockReset();
    dbRun.mockReset();
});

describe('registerAttestationServiceHandlers', () => {
    test('registers a before(*) hook and two tier gates', () => {
        const { srv, handlers } = makeFakeService();
        registerAttestationServiceHandlers(srv, { run: dbRun } as any);

        const events = handlers.map(h => `${h.event}:${h.entity ?? '*'}`);
        expect(events).toEqual([
            '*:*',
            'READ:Disclosed',
            'READ:Authority'
        ]);
    });

    test('star hook attaches disclosure role from the DB', async () => {
        const { srv, handlers } = makeFakeService();
        registerAttestationServiceHandlers(srv, { run: dbRun } as any);

        dbRun.mockResolvedValueOnce([
            { userId: 'alice', role: 'legitimate_interest', scope: null, validFrom: null, validUntil: null }
        ]);

        const req = makeReq('alice');
        await handlers[0].fn(req);
        expect(req.disclosureRole).toBe('legitimate_interest');
        expect(selectFromSpy).toHaveBeenCalledWith('midnight.DisclosureRoles');
    });

    test('Public has no gate (only fields-set filtering at projection level)', () => {
        const { srv, handlers } = makeFakeService();
        registerAttestationServiceHandlers(srv, { run: dbRun } as any);
        // Only Disclosed and Authority should appear as gated entities
        const gated = handlers.filter(h => h.entity).map(h => h.entity);
        expect(gated).not.toContain('Public');
    });

    describe('Disclosed gate', () => {
        function setup() {
            const { srv, handlers } = makeFakeService();
            registerAttestationServiceHandlers(srv, { run: dbRun } as any);
            const gate = handlers.find(h => h.entity === 'Disclosed')!.fn;
            return gate;
        }

        test('rejects public_only callers', () => {
            const gate = setup();
            const req = makeReq('bob');
            req.disclosureRole = 'public_only';
            gate(req);
            expect(req.reject).toHaveBeenCalledWith(403, expect.stringContaining("'Disclosed'"));
        });

        test('rejects undefined role (treated as public_only)', () => {
            const gate = setup();
            const req = makeReq('bob');
            gate(req);
            expect(req.reject).toHaveBeenCalledWith(403, expect.any(String));
        });

        test('allows legitimate_interest', () => {
            const gate = setup();
            const req = makeReq('bob');
            req.disclosureRole = 'legitimate_interest';
            gate(req);
            expect(req.reject).not.toHaveBeenCalled();
        });

        test('allows authority', () => {
            const gate = setup();
            const req = makeReq('bob');
            req.disclosureRole = 'authority';
            gate(req);
            expect(req.reject).not.toHaveBeenCalled();
        });
    });

    describe('Authority gate', () => {
        function setup() {
            const { srv, handlers } = makeFakeService();
            registerAttestationServiceHandlers(srv, { run: dbRun } as any);
            const gate = handlers.find(h => h.entity === 'Authority')!.fn;
            return gate;
        }

        test('rejects public_only', () => {
            const gate = setup();
            const req = makeReq('bob');
            req.disclosureRole = 'public_only';
            gate(req);
            expect(req.reject).toHaveBeenCalledWith(403, expect.stringContaining("'Authority'"));
        });

        test('rejects legitimate_interest', () => {
            const gate = setup();
            const req = makeReq('bob');
            req.disclosureRole = 'legitimate_interest';
            gate(req);
            expect(req.reject).toHaveBeenCalledWith(403, expect.any(String));
        });

        test('allows authority', () => {
            const gate = setup();
            const req = makeReq('bob');
            req.disclosureRole = 'authority';
            gate(req);
            expect(req.reject).not.toHaveBeenCalled();
        });
    });
});
