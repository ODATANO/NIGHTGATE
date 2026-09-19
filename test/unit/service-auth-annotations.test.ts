/**
 * The auth layout of the services with an anonymous operation, checked on the
 * compiled model.
 *
 * CAP authorizes the SERVICE before it looks at the operation (`authorize` in
 * @sap/cds lib/srv/protocols/http.js): a service without a service-level
 * `@requires` is implicitly `authenticated-user` under NODE_ENV=production, so
 * an operation-level `@requires: 'any'` can never open a single operation on
 * such a service — anonymous callers get the 401 challenge first. Seen live on
 * 0.24.1 behind ODATANO ACCESS: the gateway's credential-free probe of
 * `/api/v1/indexer/getLiveness()` answered 401. The layout is therefore:
 * service `any`, every element restricted on its own, exactly the anonymous
 * operations `any`. The integration suite runs its unauthenticated requests as
 * a privileged user and cannot catch a regression here, so this test pins the
 * model shape.
 */

import cds from '@sap/cds';
import path from 'path';

type Def = Record<string, unknown> & { kind?: string };

async function definitionsOf(file: string): Promise<Record<string, Def>> {
    const csn = await cds.load(path.resolve(__dirname, '../../srv', file));
    return csn.definitions as unknown as Record<string, Def>;
}

/**
 * The service is `any`; every own entity / action / function (auto-exposed
 * entities excepted: CAP answers a direct request on them with 405 and
 * authorizes navigations on the right-most exposed entity) carries `@requires`
 * or `@restrict`; exactly `anonymous` may be 'any'.
 */
function expectServiceAnyElementAuth(defs: Record<string, Def>, svc: string, anonymous: string[]): void {
    const service = defs[svc]!;
    expect(service.kind).toBe('service');
    expect(service['@requires']).toBe('any');

    const own = Object.entries(defs).filter(
        ([n, d]) => n.startsWith(`${svc}.`) && ['entity', 'action', 'function'].includes(String(d.kind)) && !d['@cds.autoexposed']
    );
    expect(own.length).toBeGreaterThan(0);
    for (const [name, d] of own) {
        const requires = d['@requires'];
        const restrict = d['@restrict'];
        expect(requires !== undefined || restrict !== undefined, `${name} must carry @requires or @restrict`).toBe(true);
        const isAny = requires === 'any' || (Array.isArray(requires) && requires.includes('any'));
        expect(isAny, `${name}: 'any' is reserved for ${anonymous.join(', ')}`).toBe(anonymous.includes(name));
    }
    for (const a of anonymous) expect(defs[a]?.['@requires'], `${a} must be 'any'`).toBe('any');
}

describe('service auth annotations (anonymous liveness and verify lane)', () => {
    it('NightgateIndexerService: service any, every element annotated, only the read-only probes anonymous', async () => {
        const defs = await definitionsOf('nightgate-indexer-service.cds');
        const probes = ['getLiveness', 'getReadiness', 'getMetrics', 'getSyncStatus', 'getHealth'].map((f) => `NightgateIndexerService.${f}`);
        expectServiceAnyElementAuth(defs, 'NightgateIndexerService', probes);
        expect(defs['NightgateIndexerService.pauseCrawler']?.['@requires']).toBe('admin');
        expect(defs['NightgateIndexerService.resumeCrawler']?.['@requires']).toBe('admin');
        expect(defs['NightgateIndexerService.reindexFromHeight']?.['@requires']).toBe('admin');
        expect(defs['NightgateIndexerService.getReorgHistory']?.['@requires']).toBe('authenticated-user');
        expect(defs['NightgateIndexerService.SyncState']?.['@requires']).toBe('authenticated-user');
        expect(defs['NightgateIndexerService.getRuntimeInfo']?.['@requires']).toBe('authenticated-user');
    });

    it('NightgateVerifyService stays a fully public service', async () => {
        const defs = await definitionsOf('nightgate-verify-service.cds');
        expect(defs['NightgateVerifyService']?.['@requires']).toBe('any');
    });

    it('NightgateService keeps its service-level requirement (nothing anonymous there)', async () => {
        const defs = await definitionsOf('nightgate-service.cds');
        const svc = defs['NightgateService']!;
        expect(svc.kind).toBe('service');
        expect(svc['@requires']).not.toBe('any');
    });

    it('every served service carries a service-level @requires (no service relies on the production default)', async () => {
        const csn = await cds.load(path.resolve(__dirname, '../../srv'));
        const services = Object.entries(csn.definitions as unknown as Record<string, Def>).filter(([, d]) => d.kind === 'service');
        expect(services.length).toBeGreaterThanOrEqual(5);
        for (const [name, d] of services) {
            expect(typeof d['@requires'] === 'string' || Array.isArray(d['@requires']), `${name} needs a service-level @requires`).toBe(true);
        }
    });
});
