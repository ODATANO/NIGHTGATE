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

runTransportAuthContract({
    url: () => cap.url,
    kind: 'basic',
    anonymousPath: '/api/v1/indexer/getLiveness()',
    authenticatedPath: '/api/v1/indexer/SyncState',
    operatorPath: '/api/v1/admin/BackgroundJobs',
    operator: { user: 'nightgate', password: 'op-secret' },
    realm: 'nightgate',
    maxFailures: 4,
    lane: {
        header: 'x-agent-token',
        value: 'ngat_' + 'a'.repeat(64),
        insidePath: '/api/v1/nightgate/WalletSessions',
        outsidePath: '/api/v1/admin/BackgroundJobs',
        insideStatus: 401
    }
});
