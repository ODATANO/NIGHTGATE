/**
 * The standalone image's transport auth end to end: the package's contract
 * table against the booted NIGHTGATE services with `kind: basic`, the
 * operator user, and the agent-token lane on the Nightgate service (an
 * unknown token is refused by the grant hook, without a basic challenge).
 */

import cds from '@sap/cds';
import { runTransportAuthContract } from '@odatano/cap-auth/contract';

// vitest.setup makes every credential-free request privileged; this suite is
// about exactly those requests, so anonymous means anonymous here.
cds.User.default = (cds.User as unknown as { Anonymous: typeof cds.User.default }).Anonymous;

(cds as any).env.requires.auth = {
    kind: 'basic',
    impl: '@odatano/cap-auth',
    realm: 'nightgate',
    basicThrottle: { maxFailures: 4 },
    users: { nightgate: { password: 'op-secret', roles: ['admin'] } }
};

const cap = cds.test(__dirname + '/../..') as unknown as { url: string };

// Before the contract table, whose failed logins trip the throttle of this address.
describe('the metrics are for the operator', () => {
    const metrics = (headers: Record<string, string> = {}) => fetch(`${cap.url}/odata/v4/midnight-indexer/getMetrics()`, { headers });

    it('a caller without credentials is asked to sign in', async () => {
        expect((await metrics()).status).toBe(401);
    });

    it('the operator reads them', async () => {
        const res = await metrics({ authorization: 'Basic ' + Buffer.from('nightgate:op-secret').toString('base64') });
        expect(res.status).toBe(200);
        expect((await res.json()).value).toContain('odatano_nightgate_');
    });
});

runTransportAuthContract({
    url: () => cap.url,
    kind: 'basic',
    anonymousPath: '/odata/v4/midnight-indexer/getLiveness()',
    authenticatedPath: '/odata/v4/midnight-indexer/SyncState',
    operatorPath: '/odata/v4/midnight-admin/BackgroundJobs',
    operator: { user: 'nightgate', password: 'op-secret' },
    realm: 'nightgate',
    maxFailures: 4,
    lane: {
        header: 'x-agent-token',
        value: 'ngat_' + 'a'.repeat(64),
        insidePath: '/odata/v4/midnight/WalletSessions',
        outsidePath: '/odata/v4/midnight-admin/BackgroundJobs',
        insideStatus: 401
    }
});
